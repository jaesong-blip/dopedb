// Windows CI runs this with the same portable-pty spawn path used by the desktop
// runtime. An encoded PowerShell parent starts one child PowerShell process after
// job assignment, avoiding libtest self-reentry while proving a real descendant
// inherited the production Job Object before it is closed.

use std::fs;
use std::io::Read;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use portable_pty::{native_pty_system, CommandBuilder, PtySize};
use uuid::Uuid;
use windows_sys::Win32::Foundation::{CloseHandle, FILETIME, STILL_ACTIVE};
use windows_sys::Win32::System::Threading::{
    GetExitCodeProcess, GetProcessTimes, OpenProcess, TerminateProcess,
    PROCESS_QUERY_LIMITED_INFORMATION, PROCESS_TERMINATE,
};

use super::*;

const HANDSHAKE_TIMEOUT: Duration = Duration::from_secs(20);
const CHILD_EXIT_TIMEOUT: Duration = Duration::from_secs(3);
const DESCENDANT_EXIT_TIMEOUT: Duration = Duration::from_secs(3);
const POLL_INTERVAL: Duration = Duration::from_millis(25);
const MAX_PTY_DIAGNOSTIC_BYTES: usize = 1024;

#[derive(Debug)]
struct DescendantIdentity {
    process_id: u32,
    creation_time: u64,
}

struct MarkerFiles {
    go: PathBuf,
    ready: PathBuf,
    ready_partial: PathBuf,
}

/// Retains only bounded PTY diagnostics. The test scripts carry no credentials
/// and the capture exists solely to distinguish a PowerShell launch failure
/// from a missing marker without turning failure output into an unbounded log.
#[derive(Clone)]
struct PtyOutputCapture {
    bytes: Arc<Mutex<Vec<u8>>>,
}

impl PtyOutputCapture {
    fn start(mut reader: Box<dyn Read + Send>) -> Self {
        let bytes = Arc::new(Mutex::new(Vec::with_capacity(MAX_PTY_DIAGNOSTIC_BYTES)));
        let captured = Arc::clone(&bytes);
        let _ = std::thread::spawn(move || {
            let mut chunk = [0_u8; 256];
            loop {
                let count = match reader.read(&mut chunk) {
                    Ok(0) | Err(_) => return,
                    Ok(count) => count,
                };
                let mut output = captured
                    .lock()
                    .unwrap_or_else(|poisoned| poisoned.into_inner());
                let remaining = MAX_PTY_DIAGNOSTIC_BYTES.saturating_sub(output.len());
                output.extend_from_slice(&chunk[..count.min(remaining)]);
            }
        });
        Self { bytes }
    }

    fn diagnostic(&self) -> String {
        let output = self
            .bytes
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        let printable = output
            .iter()
            .map(|byte| match byte {
                b'\n' | b'\r' | b'\t' | b' '..=b'~' => char::from(*byte),
                _ => '?',
            })
            .collect::<String>();
        format!(
            "pty_output_bytes={}; pty_output={printable:?}",
            output.len()
        )
    }
}

impl MarkerFiles {
    fn new() -> Self {
        let id = Uuid::new_v4().simple().to_string();
        let root = std::env::temp_dir();
        let ready = root.join(format!("dopedb_terminal_{id}_ready"));
        Self {
            go: root.join(format!("dopedb_terminal_{id}_go")),
            ready_partial: ready.with_extension("partial"),
            ready,
        }
    }
}

impl Drop for MarkerFiles {
    fn drop(&mut self) {
        for path in [&self.go, &self.ready, &self.ready_partial] {
            let _ = fs::remove_file(path);
        }
    }
}

fn wait_for_descendant_identity(path: &Path, timeout: Duration) -> Option<DescendantIdentity> {
    let deadline = Instant::now() + timeout;
    while Instant::now() < deadline {
        if let Ok(value) = fs::read_to_string(path) {
            if let Some(process_id) = parse_descendant_process_id(&value) {
                if let Some(descendant) = capture_running_descendant(process_id) {
                    return Some(descendant);
                }
            }
        }
        std::thread::sleep(POLL_INTERVAL);
    }
    None
}

fn wait_for_child_exit(child: &mut Box<dyn Child + Send + Sync>, timeout: Duration) -> String {
    let deadline = Instant::now() + timeout;
    loop {
        match child.try_wait() {
            Ok(Some(status)) => return format!("exited {status:?}"),
            Ok(None) if Instant::now() < deadline => std::thread::sleep(POLL_INTERVAL),
            Ok(None) => return "timed out".to_owned(),
            Err(error) => return format!("poll error: {error}"),
        }
    }
}

fn descendant_exited(descendant: &DescendantIdentity, timeout: Duration) -> bool {
    let deadline = Instant::now() + timeout;
    while descendant_is_running(descendant) && Instant::now() < deadline {
        std::thread::sleep(POLL_INTERVAL);
    }
    !descendant_is_running(descendant)
}

fn terminate_and_collect(
    tree: &ProcessTree,
    child: &mut Box<dyn Child + Send + Sync>,
    descendant: Option<&DescendantIdentity>,
    output: &PtyOutputCapture,
) -> String {
    // `portable_pty::Child::wait` blocks until every inherited handle is
    // closed. An escaped descendant can retain the PTY, so all cleanup and
    // diagnostics use bounded try_wait polling instead.
    let job = format!("{:?}", tree.force_terminate());
    let child_kill = format!("{:?}", child.kill());
    if let Some(descendant) = descendant {
        terminate_descendant(descendant);
    }
    let child_exit = wait_for_child_exit(child, CHILD_EXIT_TIMEOUT);
    let descendant_exit =
        descendant.map(|descendant| descendant_exited(descendant, DESCENDANT_EXIT_TIMEOUT));
    format!(
        "job={job}; child_kill={child_kill}; child_exit={child_exit}; descendant_exited={descendant_exit:?}; {}",
        output.diagnostic(),
    )
}

fn powershell_encoded(script: &str) -> String {
    base64_encode(
        &script
            .encode_utf16()
            .flat_map(u16::to_le_bytes)
            .collect::<Vec<_>>(),
    )
}

fn powershell_path(path: &Path) -> String {
    base64_encode(path.as_os_str().to_string_lossy().as_bytes())
}

fn base64_encode(bytes: &[u8]) -> String {
    const TABLE: &[u8; 64] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
    let mut output = String::with_capacity(bytes.len().div_ceil(3) * 4);
    for chunk in bytes.chunks(3) {
        let value = (u32::from(chunk[0]) << 16)
            | (u32::from(*chunk.get(1).unwrap_or(&0)) << 8)
            | u32::from(*chunk.get(2).unwrap_or(&0));
        output.push(char::from(TABLE[((value >> 18) & 63) as usize]));
        output.push(char::from(TABLE[((value >> 12) & 63) as usize]));
        output.push(if chunk.len() > 1 {
            char::from(TABLE[((value >> 6) & 63) as usize])
        } else {
            '='
        });
        output.push(if chunk.len() > 2 {
            char::from(TABLE[(value & 63) as usize])
        } else {
            '='
        });
    }
    output
}

fn parent_script(markers: &MarkerFiles) -> String {
    let go = powershell_path(&markers.go);
    let ready = powershell_path(&markers.ready);
    let ready_partial = powershell_path(&markers.ready_partial);
    let descendant_script = format!(
        r#"$decode = {{ param([string]$s) [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String($s)) }}
$ErrorActionPreference = 'Stop'
$ready = & $decode '{ready}'
$partial = & $decode '{ready_partial}'
[IO.File]::WriteAllText($partial, [string]$PID, [Text.Encoding]::ASCII)
[IO.File]::Move($partial, $ready)
while ($true) {{ Start-Sleep -Seconds 60 }}"#,
    );
    let encoded_descendant = powershell_encoded(&descendant_script);
    format!(
        r#"$decode = {{ param([string]$s) [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String($s)) }}
$ErrorActionPreference = 'Stop'
$go = & $decode '{go}'
while (-not (Test-Path -LiteralPath $go)) {{ Start-Sleep -Milliseconds 25 }}
$process = [Diagnostics.Process]::Start('powershell.exe', '-NoProfile -NonInteractive -ExecutionPolicy Bypass -EncodedCommand {encoded_descendant}')
if ($null -eq $process -or $process.Id -le 0) {{ throw 'could not start descendant PowerShell' }}
$process.WaitForExit()"#,
    )
}

fn filetime_value(filetime: FILETIME) -> u64 {
    (u64::from(filetime.dwHighDateTime) << 32) | u64::from(filetime.dwLowDateTime)
}

/// Captures process identity from the authoritative Win32 handle after a
/// PID-only marker arrives. This intentionally does not trust .NET's textual
/// `Process.StartTime` conversion, while retaining PID-reuse protection for
/// cleanup checks below.
fn capture_running_descendant(process_id: u32) -> Option<DescendantIdentity> {
    unsafe {
        let process = OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, 0, process_id);
        if process.is_null() {
            return None;
        }
        let mut exit_code = 0;
        let mut created: FILETIME = std::mem::zeroed();
        let mut exited: FILETIME = std::mem::zeroed();
        let mut kernel: FILETIME = std::mem::zeroed();
        let mut user: FILETIME = std::mem::zeroed();
        let captured = GetExitCodeProcess(process, &mut exit_code) != 0
            && exit_code == STILL_ACTIVE as u32
            && GetProcessTimes(process, &mut created, &mut exited, &mut kernel, &mut user) != 0;
        let _ = CloseHandle(process);
        captured.then_some(DescendantIdentity {
            process_id,
            creation_time: filetime_value(created),
        })
    }
}

fn descendant_is_running(descendant: &DescendantIdentity) -> bool {
    // Rust captured this PID plus creation time from one live Win32 handle.
    // A recycled PID is considered an exited original descendant, never a
    // false success.
    unsafe {
        let process = OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, 0, descendant.process_id);
        if process.is_null() {
            return false;
        }
        let mut exit_code = 0;
        let queried = GetExitCodeProcess(process, &mut exit_code) != 0;
        let mut created: FILETIME = std::mem::zeroed();
        let mut exited: FILETIME = std::mem::zeroed();
        let mut kernel: FILETIME = std::mem::zeroed();
        let mut user: FILETIME = std::mem::zeroed();
        let timestamp_matches =
            GetProcessTimes(process, &mut created, &mut exited, &mut kernel, &mut user) != 0
                && filetime_value(created) == descendant.creation_time;
        let _ = CloseHandle(process);
        queried && timestamp_matches && exit_code == STILL_ACTIVE as u32
    }
}

fn terminate_descendant(descendant: &DescendantIdentity) {
    unsafe {
        let process = OpenProcess(
            PROCESS_QUERY_LIMITED_INFORMATION | PROCESS_TERMINATE,
            0,
            descendant.process_id,
        );
        if !process.is_null() {
            let mut created: FILETIME = std::mem::zeroed();
            let mut exited: FILETIME = std::mem::zeroed();
            let mut kernel: FILETIME = std::mem::zeroed();
            let mut user: FILETIME = std::mem::zeroed();
            if GetProcessTimes(process, &mut created, &mut exited, &mut kernel, &mut user) != 0
                && filetime_value(created) == descendant.creation_time
            {
                let _ = TerminateProcess(process, 1);
            }
            let _ = CloseHandle(process);
        }
    }
}

fn parse_descendant_process_id(value: &str) -> Option<u32> {
    let process_id = value.trim().parse::<u32>().ok()?;
    (process_id > 0).then_some(process_id)
}

fn marker_diagnostic(markers: &MarkerFiles) -> String {
    fn file_state(path: &Path) -> String {
        match fs::read_to_string(path) {
            Ok(content) => format!(
                "present(bytes={}, parsed_pid={:?})",
                content.len(),
                parse_descendant_process_id(&content)
            ),
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => "missing".to_owned(),
            Err(error) => format!("unreadable({})", error.kind()),
        }
    }
    format!(
        "marker_ready={}; marker_partial={}",
        file_state(&markers.ready),
        file_state(&markers.ready_partial)
    )
}

#[test]
fn descendant_marker_accepts_only_one_positive_pid() {
    assert_eq!(parse_descendant_process_id("42\n"), Some(42));
    assert_eq!(parse_descendant_process_id("0"), None);
    assert_eq!(parse_descendant_process_id("42:123"), None);
    assert_eq!(parse_descendant_process_id("not-a-pid"), None);
}

#[test]
fn descendant_identity_is_captured_from_the_win32_process_handle() {
    let identity = capture_running_descendant(std::process::id())
        .expect("the current Windows test process must have a live process handle");
    assert_eq!(identity.process_id, std::process::id());
    assert!(identity.creation_time > 0);
    assert!(descendant_is_running(&identity));
}

#[test]
fn marker_wait_captures_the_process_handle_identity_not_textual_timestamp() {
    let markers = MarkerFiles::new();
    fs::write(&markers.ready, std::process::id().to_string()).unwrap();
    let identity = wait_for_descendant_identity(&markers.ready, Duration::from_millis(100))
        .expect("a PID-only marker for this live process must capture Win32 identity");
    assert_eq!(identity.process_id, std::process::id());
    assert!(identity.creation_time > 0);
}

#[test]
fn windows_job_cleanup_prevents_a_descendant_from_outliving_the_pty() {
    let markers = MarkerFiles::new();
    let pair = native_pty_system()
        .openpty(PtySize {
            rows: 24,
            cols: 80,
            pixel_width: 0,
            pixel_height: 0,
        })
        .unwrap();
    let output = PtyOutputCapture::start(pair.master.try_clone_reader().unwrap());
    let encoded_script = powershell_encoded(&parent_script(&markers));
    let mut command = CommandBuilder::new("powershell.exe");
    command.args([
        "-NoProfile",
        "-NonInteractive",
        "-ExecutionPolicy",
        "Bypass",
        "-EncodedCommand",
        &encoded_script,
    ]);
    let mut child = pair.slave.spawn_command(command).unwrap();
    // Keep only the child-side handle owned by the spawned process.
    drop(pair.slave);
    // This is the production attach/force_terminate sequence. The GO marker
    // deliberately delays descendant launch until after job assignment.
    let tree = match ProcessTree::attach(child.as_ref()) {
        Ok(tree) => tree,
        Err(error) => {
            let _ = child.kill();
            let child_exit = wait_for_child_exit(&mut child, CHILD_EXIT_TIMEOUT);
            panic!(
                "could not attach the Windows PTY process to its job: {error}; child_exit={child_exit}; {}; {}",
                marker_diagnostic(&markers),
                output.diagnostic(),
            );
        }
    };
    if let Err(error) = fs::write(&markers.go, "go") {
        let status = terminate_and_collect(&tree, &mut child, None, &output);
        panic!(
            "could not release the Windows process-tree parent: {error}; {}; cleanup={status}",
            marker_diagnostic(&markers)
        );
    }
    let descendant = match wait_for_descendant_identity(&markers.ready, HANDSHAKE_TIMEOUT) {
        Some(descendant) => descendant,
        None => {
            let status = terminate_and_collect(&tree, &mut child, None, &output);
            panic!(
                "READY marker timeout or invalid descendant identity; {}; cleanup={status}",
                marker_diagnostic(&markers)
            );
        }
    };

    if let Err(error) = tree.force_terminate() {
        let status = terminate_and_collect(&tree, &mut child, Some(&descendant), &output);
        panic!("could not terminate the Windows PTY job tree: {error}; cleanup={status}");
    }
    let child_exit = wait_for_child_exit(&mut child, CHILD_EXIT_TIMEOUT);
    if child_exit == "timed out" || child_exit.starts_with("poll error:") {
        let status = terminate_and_collect(&tree, &mut child, Some(&descendant), &output);
        panic!(
            "the terminated Windows PTY parent did not exit cleanly: {child_exit}; cleanup={status}"
        );
    }
    if !descendant_exited(&descendant, DESCENDANT_EXIT_TIMEOUT) {
        let status = terminate_and_collect(&tree, &mut child, Some(&descendant), &output);
        panic!(
            "the exact Windows descendant PID survived Job Object termination; cleanup={status}"
        );
    }
}
