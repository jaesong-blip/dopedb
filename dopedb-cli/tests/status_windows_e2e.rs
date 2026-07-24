#![cfg(windows)]

use std::ffi::OsStr;
use std::fs;
use std::os::windows::ffi::OsStrExt;
use std::path::Path;
use std::process::{Command, Output, Stdio};
use std::ptr;
use std::thread;
use std::time::{Duration, Instant};

use chrono::Utc;
use dopedb_protocol::{
    decode_frame, encode_frame, parse_frame_length, CommandName, RequestEnvelope, ResponseEnvelope,
    RuntimeDiscovery, StatusResult, MAX_REQUEST_BYTES, MAX_RESPONSE_BYTES, PROTOCOL_MAX,
    PROTOCOL_MIN,
};
use tempfile::TempDir;
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::windows::named_pipe::ServerOptions;
use uuid::Uuid;
use windows_sys::Win32::Foundation::{LocalFree, HLOCAL};
use windows_sys::Win32::Security::Authorization::{
    ConvertSidToStringSidW, ConvertStringSecurityDescriptorToSecurityDescriptorW, SDDL_REVISION_1,
};
use windows_sys::Win32::Security::{
    GetTokenInformation, SetFileSecurityW, TokenUser, DACL_SECURITY_INFORMATION,
    OWNER_SECURITY_INFORMATION, PROTECTED_DACL_SECURITY_INFORMATION, PSECURITY_DESCRIPTOR,
    TOKEN_QUERY, TOKEN_USER,
};
use windows_sys::Win32::System::Threading::{GetCurrentProcess, OpenProcessToken};

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn status_json_uses_the_owner_local_windows_named_pipe() {
    let temp = TempDir::new().unwrap();
    let runtime_directory = temp.path().join("runtime");
    fs::create_dir(&runtime_directory).unwrap();
    let runtime_id = Uuid::from_u128(1);
    let endpoint = format!(r"\\.\pipe\dopedb-{runtime_id}");
    let mut server = ServerOptions::new()
        .first_pipe_instance(true)
        .create(&endpoint)
        .unwrap();
    let runtime_file = runtime_directory.join("runtime.json");
    let discovery = RuntimeDiscovery::new(
        runtime_id,
        std::process::id(),
        "0.3.3",
        PROTOCOL_MIN,
        PROTOCOL_MAX,
        &endpoint,
        Utc::now(),
    )
    .unwrap();
    fs::write(&runtime_file, serde_json::to_vec(&discovery).unwrap()).unwrap();
    restrict_owner_only(&runtime_file);

    let server_task = tokio::spawn(async move {
        server.connect().await.unwrap();
        let mut prefix = [0u8; 4];
        server.read_exact(&mut prefix).await.unwrap();
        let length = parse_frame_length(prefix, MAX_REQUEST_BYTES).unwrap();
        let mut frame = Vec::from(prefix);
        frame.resize(4 + length, 0);
        server.read_exact(&mut frame[4..]).await.unwrap();
        let request: RequestEnvelope = decode_frame(&frame, MAX_REQUEST_BYTES).unwrap();
        assert_eq!(request.command, CommandName::Status);
        let response = ResponseEnvelope::success(
            PROTOCOL_MAX,
            request.request_id,
            serde_json::to_value(StatusResult {
                app_version: "0.3.3".into(),
                protocol_min: PROTOCOL_MIN,
                protocol_max: PROTOCOL_MAX,
                runtime_id,
            })
            .unwrap(),
        );
        server
            .write_all(&encode_frame(&response, MAX_RESPONSE_BYTES).unwrap())
            .await
            .unwrap();
    });

    let output = command_output_with_timeout(
        Command::new(env!("CARGO_BIN_EXE_dopedb-cli"))
            .args(["status", "--json"])
            .env("DOPEDB_RUNTIME_FILE", &runtime_file),
        Duration::from_secs(15),
    );
    let server_finished = tokio::time::timeout(Duration::from_secs(5), server_task).await;
    assert!(
        server_finished.is_ok(),
        "the CLI exited without completing the named-pipe exchange: {}",
        String::from_utf8_lossy(&output.stderr)
    );
    server_finished.unwrap().unwrap();

    assert!(output.status.success());
    assert!(output.stderr.is_empty());
    let status: StatusResult = serde_json::from_slice(&output.stdout).unwrap();
    assert_eq!(status.runtime_id, runtime_id);
}

fn command_output_with_timeout(command: &mut Command, timeout: Duration) -> Output {
    command.stdout(Stdio::piped()).stderr(Stdio::piped());
    let mut child = command.spawn().unwrap();
    let deadline = Instant::now() + timeout;
    loop {
        if child.try_wait().unwrap().is_some() {
            return child.wait_with_output().unwrap();
        }
        if Instant::now() >= deadline {
            let _ = child.kill();
            let output = child.wait_with_output().unwrap();
            panic!(
                "the DopeDB CLI did not exit within {timeout:?}: {}",
                String::from_utf8_lossy(&output.stderr)
            );
        }
        thread::sleep(Duration::from_millis(10));
    }
}

fn restrict_owner_only(path: &Path) {
    let sid = current_user_sid_string();
    let descriptor = format!("O:{sid}D:P(A;;GA;;;SY)(A;;GA;;;{sid})");
    let sddl = wide_null(OsStr::new(&descriptor));
    let mut descriptor: PSECURITY_DESCRIPTOR = ptr::null_mut();
    assert_ne!(
        unsafe {
            ConvertStringSecurityDescriptorToSecurityDescriptorW(
                sddl.as_ptr(),
                SDDL_REVISION_1,
                &mut descriptor,
                ptr::null_mut(),
            )
        },
        0
    );
    let path = wide_null(path.as_os_str());
    let flags = OWNER_SECURITY_INFORMATION
        | DACL_SECURITY_INFORMATION
        | PROTECTED_DACL_SECURITY_INFORMATION;
    assert_ne!(
        unsafe { SetFileSecurityW(path.as_ptr(), flags, descriptor) },
        0
    );
    unsafe {
        LocalFree(descriptor as HLOCAL);
    }
}

fn current_user_sid_string() -> String {
    let mut token = ptr::null_mut();
    assert_ne!(
        unsafe { OpenProcessToken(GetCurrentProcess(), TOKEN_QUERY, &mut token) },
        0
    );
    let token = LocalHandle(token);
    let mut required = 0u32;
    unsafe {
        GetTokenInformation(token.0, TokenUser, ptr::null_mut(), 0, &mut required);
    }
    let word_bytes = std::mem::size_of::<usize>();
    let word_count = usize::try_from(required)
        .unwrap()
        .checked_add(word_bytes - 1)
        .unwrap()
        / word_bytes;
    let mut buffer = vec![0usize; word_count];
    assert_ne!(
        unsafe {
            GetTokenInformation(
                token.0,
                TokenUser,
                buffer.as_mut_ptr().cast(),
                required,
                &mut required,
            )
        },
        0
    );
    let user = unsafe { &*buffer.as_ptr().cast::<TOKEN_USER>() };
    let mut raw = ptr::null_mut();
    assert_ne!(
        unsafe { ConvertSidToStringSidW(user.User.Sid, &mut raw) },
        0
    );
    let raw = LocalWideString(raw);
    let length = unsafe { (0..).find(|&index| *raw.0.add(index) == 0).unwrap() };
    String::from_utf16(unsafe { std::slice::from_raw_parts(raw.0, length) }).unwrap()
}

struct LocalHandle(windows_sys::Win32::Foundation::HANDLE);

impl Drop for LocalHandle {
    fn drop(&mut self) {
        unsafe {
            windows_sys::Win32::Foundation::CloseHandle(self.0);
        }
    }
}

struct LocalWideString(*mut u16);

impl Drop for LocalWideString {
    fn drop(&mut self) {
        unsafe {
            LocalFree(self.0 as HLOCAL);
        }
    }
}

fn wide_null(value: &OsStr) -> Vec<u16> {
    value.encode_wide().chain(std::iter::once(0)).collect()
}
