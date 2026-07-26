// Windows CI runs this with the same portable-pty spawn path used by the desktop
// runtime. An encoded PowerShell parent starts one child PowerShell process after
// job assignment, avoiding libtest self-reentry while proving a real descendant
// inherited the production Job Object before it is closed.

use std::fs;
use std::path::{Path, PathBuf};
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

#[derive(Debug)]
struct DescendantIdentity {
    process_id: u32,
    creation_time: u64,
}

struct MarkerFiles {
    go: PathBuf,
    ready: PathBuf,
}

impl MarkerFiles {
    fn new() -> Self {
        let id = Uuid::new_v4().simple().to_string();
        let root = std::env::temp_dir();
        Self {
            go: root.join(format!("dopedb_terminal_{id}_go")),
            ready: root.join(format!("dopedb_terminal_{id}_ready")),
        }
    }
}

impl Drop for MarkerFiles {
    fn drop(&mut self) {
        for path in [&self.go, &self.ready] {
            let _ = fs::remove_file(path);
        }
    }
}

fn marker_appeared(path: &Path, timeout: Duration) -> bool {
    let deadline = Instant::now() + timeout;
    while !path.exists() && Instant::now() < deadline {
        std::thread::sleep(POLL_INTERVAL);
    }
    path.exists()
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
        "job={job}; child_kill={child_kill}; child_exit={child_exit}; descendant_exited={descendant_exit:?}"
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
    format!(
        r#"$decode = {{ param([string]$s) [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String($s)) }}
$ErrorActionPreference = 'Stop'
$go = & $decode '{go}'; $ready = & $decode '{ready}'
while (-not (Test-Path -LiteralPath $go)) {{ Start-Sleep -Milliseconds 25 }}
$process = Start-Process -FilePath powershell.exe -ArgumentList @('-NoProfile','-NonInteractive','-Command','Start-Sleep -Seconds 600') -PassThru
if ($null -eq $process -or $process.Id -le 0) {{ throw 'could not start descendant PowerShell' }}
[IO.File]::WriteAllText($ready, "$($process.Id):$($process.StartTime.ToUniversalTime().ToFileTimeUtc())")
$process.WaitForExit()"#,
    )
}

fn filetime_value(filetime: FILETIME) -> u64 {
    (u64::from(filetime.dwHighDateTime) << 32) | u64::from(filetime.dwLowDateTime)
}

fn descendant_is_running(descendant: &DescendantIdentity) -> bool {
    // READY carries the parent-observed PID plus creation time. A recycled PID
    // is considered an exited original descendant, never a false success.
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

fn parse_descendant_identity(value: &str) -> Option<DescendantIdentity> {
    let (process_id, creation_time) = value.trim().split_once(':')?;
    let process_id = process_id.parse::<u32>().ok()?;
    let creation_time = creation_time.parse::<u64>().ok()?;
    (process_id > 0 && creation_time > 0).then_some(DescendantIdentity {
        process_id,
        creation_time,
    })
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
                "could not attach the Windows PTY process to its job: {error}; child_exit={child_exit}"
            );
        }
    };
    if let Err(error) = fs::write(&markers.go, "go") {
        let status = terminate_and_collect(&tree, &mut child, None);
        panic!("could not release the Windows process-tree parent: {error}; cleanup={status}");
    }
    if !marker_appeared(&markers.ready, HANDSHAKE_TIMEOUT) {
        let status = terminate_and_collect(&tree, &mut child, None);
        panic!("READY marker timeout; cleanup={status}");
    }

    let ready = match fs::read_to_string(&markers.ready) {
        Ok(ready) => ready,
        Err(error) => {
            let status = terminate_and_collect(&tree, &mut child, None);
            panic!(
                "could not read the Windows process-tree READY marker: {error}; cleanup={status}"
            );
        }
    };
    let descendant = match parse_descendant_identity(&ready) {
        Some(descendant) => descendant,
        None => {
            let status = terminate_and_collect(&tree, &mut child, None);
            panic!(
                "could not parse the Windows process-tree descendant identity; cleanup={status}"
            );
        }
    };
    if !descendant_is_running(&descendant) {
        let status = terminate_and_collect(&tree, &mut child, Some(&descendant));
        panic!("the Windows process-tree descendant was not alive before job cleanup; cleanup={status}");
    }

    if let Err(error) = tree.force_terminate() {
        let status = terminate_and_collect(&tree, &mut child, Some(&descendant));
        panic!("could not terminate the Windows PTY job tree: {error}; cleanup={status}");
    }
    let child_exit = wait_for_child_exit(&mut child, CHILD_EXIT_TIMEOUT);
    if child_exit == "timed out" || child_exit.starts_with("poll error:") {
        let status = terminate_and_collect(&tree, &mut child, Some(&descendant));
        panic!("the terminated Windows PTY parent did not exit cleanly: {child_exit}; cleanup={status}");
    }
    if !descendant_exited(&descendant, DESCENDANT_EXIT_TIMEOUT) {
        let status = terminate_and_collect(&tree, &mut child, Some(&descendant));
        panic!(
            "the exact Windows descendant PID survived Job Object termination; cleanup={status}"
        );
    }
}
