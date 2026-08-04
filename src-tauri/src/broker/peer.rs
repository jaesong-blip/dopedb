//! OS peer identity and owner-only endpoint permissions.

#[cfg(any(unix, all(test, windows)))]
use std::io;

const MAX_PROCESS_ANCESTORS: usize = 128;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) struct PeerProcessIdentity {
    pid: u32,
    started_at: u128,
}

impl PeerProcessIdentity {
    #[cfg(test)]
    pub(crate) fn pid(self) -> u32 {
        self.pid
    }

    #[cfg(test)]
    pub(crate) fn for_test(pid: u32, started_at: u128) -> Self {
        Self { pid, started_at }
    }
}

#[cfg(all(test, unix))]
pub(crate) fn current_process_identity_for_test() -> io::Result<PeerProcessIdentity> {
    unix_process_identity(std::process::id())
}

#[cfg(all(test, windows))]
pub(crate) fn current_process_identity_for_test() -> io::Result<PeerProcessIdentity> {
    windows::process_identity(std::process::id())
}

#[cfg(unix)]
pub(crate) fn verify_unix_peer(stream: &tokio::net::UnixStream) -> io::Result<PeerProcessIdentity> {
    let peer = stream.peer_cred()?;
    let current = unsafe { libc::geteuid() };
    if peer.uid() != current {
        return Err(io::Error::new(
            io::ErrorKind::PermissionDenied,
            "broker peer belongs to a different OS user",
        ));
    }
    let pid = peer
        .pid()
        .and_then(|pid| u32::try_from(pid).ok())
        .filter(|pid| *pid != 0)
        .ok_or_else(|| io::Error::other("broker peer process is unavailable"))?;
    unix_process_identity(pid)
}

#[cfg(unix)]
pub(crate) fn process_is_descendant_or_same(
    peer: PeerProcessIdentity,
    root: PeerProcessIdentity,
) -> bool {
    if unix_process_identity(peer.pid).ok() != Some(peer)
        || unix_process_identity(root.pid).ok() != Some(root)
    {
        return false;
    }
    let mut current = peer.pid;
    for _ in 0..MAX_PROCESS_ANCESTORS {
        if current == root.pid {
            return true;
        }
        let Ok(snapshot) = unix_process_snapshot(current) else {
            return false;
        };
        if snapshot.parent_pid == 0 || snapshot.parent_pid == current {
            return false;
        }
        current = snapshot.parent_pid;
    }
    false
}

#[cfg(unix)]
#[derive(Debug, Clone, Copy)]
struct UnixProcessSnapshot {
    parent_pid: u32,
    started_at: u128,
}

#[cfg(unix)]
fn unix_process_identity(pid: u32) -> io::Result<PeerProcessIdentity> {
    let snapshot = unix_process_snapshot(pid)?;
    Ok(PeerProcessIdentity {
        pid,
        started_at: snapshot.started_at,
    })
}

#[cfg(any(target_os = "macos", target_os = "ios"))]
fn unix_process_snapshot(pid: u32) -> io::Result<UnixProcessSnapshot> {
    use std::ffi::c_void;
    use std::mem::{size_of, MaybeUninit};

    let pid = i32::try_from(pid)
        .map_err(|_| io::Error::new(io::ErrorKind::InvalidInput, "process id is too large"))?;
    let mut info = MaybeUninit::<libc::proc_bsdinfo>::zeroed();
    let expected =
        i32::try_from(size_of::<libc::proc_bsdinfo>()).expect("proc_bsdinfo size fits in i32");
    let read = unsafe {
        libc::proc_pidinfo(
            pid,
            libc::PROC_PIDTBSDINFO,
            0,
            info.as_mut_ptr().cast::<c_void>(),
            expected,
        )
    };
    if read != expected {
        return Err(io::Error::last_os_error());
    }
    let info = unsafe { info.assume_init() };
    Ok(UnixProcessSnapshot {
        parent_pid: info.pbi_ppid,
        started_at: u128::from(info.pbi_start_tvsec) * 1_000_000
            + u128::from(info.pbi_start_tvusec),
    })
}

#[cfg(any(target_os = "linux", target_os = "android"))]
fn unix_process_snapshot(pid: u32) -> io::Result<UnixProcessSnapshot> {
    let stat = std::fs::read_to_string(format!("/proc/{pid}/stat"))?;
    if stat.len() > 16 * 1024 {
        return Err(io::Error::new(
            io::ErrorKind::InvalidData,
            "process metadata is too large",
        ));
    }
    let suffix = stat
        .get(
            stat.rfind(')')
                .ok_or_else(|| io::Error::other("process metadata is invalid"))?
                + 1..,
        )
        .ok_or_else(|| io::Error::other("process metadata is invalid"))?;
    let fields = suffix.split_whitespace().collect::<Vec<_>>();
    if fields.len() <= 19 {
        return Err(io::Error::other("process metadata is incomplete"));
    }
    Ok(UnixProcessSnapshot {
        parent_pid: fields[1]
            .parse()
            .map_err(|_| io::Error::other("process parent id is invalid"))?,
        started_at: fields[19]
            .parse()
            .map_err(|_| io::Error::other("process start time is invalid"))?,
    })
}

#[cfg(all(
    unix,
    not(any(
        target_os = "macos",
        target_os = "ios",
        target_os = "linux",
        target_os = "android"
    ))
))]
fn unix_process_snapshot(_pid: u32) -> io::Result<UnixProcessSnapshot> {
    Err(io::Error::new(
        io::ErrorKind::Unsupported,
        "process ancestry is unsupported on this platform",
    ))
}

#[cfg(windows)]
mod windows {
    use std::collections::HashMap;
    use std::ffi::{c_void, OsStr};
    use std::io;
    use std::mem::size_of;
    use std::os::windows::ffi::OsStrExt;
    use std::os::windows::io::AsRawHandle;
    use std::path::Path;
    use std::ptr;

    use tokio::net::windows::named_pipe::{NamedPipeServer, ServerOptions};
    use windows_sys::Win32::Foundation::{
        CloseHandle, LocalFree, FILETIME, HANDLE, HLOCAL, INVALID_HANDLE_VALUE,
    };
    use windows_sys::Win32::Security::Authorization::{
        ConvertSidToStringSidW, ConvertStringSecurityDescriptorToSecurityDescriptorW,
        SDDL_REVISION_1,
    };
    use windows_sys::Win32::Security::{
        EqualSid, GetTokenInformation, SetFileSecurityW, TokenUser, DACL_SECURITY_INFORMATION,
        OWNER_SECURITY_INFORMATION, PROTECTED_DACL_SECURITY_INFORMATION, PSECURITY_DESCRIPTOR,
        SECURITY_ATTRIBUTES, TOKEN_QUERY, TOKEN_USER,
    };
    use windows_sys::Win32::System::Diagnostics::ToolHelp::{
        CreateToolhelp32Snapshot, Process32FirstW, Process32NextW, PROCESSENTRY32W,
        TH32CS_SNAPPROCESS,
    };
    use windows_sys::Win32::System::Pipes::GetNamedPipeClientProcessId;
    use windows_sys::Win32::System::Threading::{
        GetCurrentProcess, GetProcessTimes, OpenProcess, OpenProcessToken,
        PROCESS_QUERY_LIMITED_INFORMATION,
    };

    use super::{PeerProcessIdentity, MAX_PROCESS_ANCESTORS};

    pub(crate) fn create_named_pipe(
        endpoint: &str,
        first_instance: bool,
    ) -> io::Result<NamedPipeServer> {
        let descriptor = SecurityDescriptor::owner_only()?;
        let mut attributes = SECURITY_ATTRIBUTES {
            nLength: size_of::<SECURITY_ATTRIBUTES>() as u32,
            lpSecurityDescriptor: descriptor.raw,
            bInheritHandle: 0,
        };
        let mut options = ServerOptions::new();
        options
            .access_inbound(true)
            .access_outbound(true)
            .first_pipe_instance(first_instance)
            .reject_remote_clients(true);
        unsafe {
            options.create_with_security_attributes_raw(
                endpoint,
                (&mut attributes as *mut SECURITY_ATTRIBUTES).cast::<c_void>(),
            )
        }
    }

    pub(crate) fn verify_named_pipe_peer(
        stream: &NamedPipeServer,
    ) -> io::Result<PeerProcessIdentity> {
        let pipe = stream.as_raw_handle() as HANDLE;
        let mut client_pid = 0u32;
        if unsafe { GetNamedPipeClientProcessId(pipe, &mut client_pid) } == 0 || client_pid == 0 {
            return Err(io::Error::last_os_error());
        }
        let client_process = OwnedHandle::new(unsafe {
            OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, 0, client_pid)
        })?;
        let client_token = open_process_token(client_process.raw())?;
        let current_token = open_process_token(unsafe { GetCurrentProcess() })?;
        let client_user = TokenUserBuffer::read(client_token.raw())?;
        let current_user = TokenUserBuffer::read(current_token.raw())?;
        if unsafe { EqualSid(client_user.sid(), current_user.sid()) } == 0 {
            return Err(io::Error::new(
                io::ErrorKind::PermissionDenied,
                "broker peer belongs to a different OS user",
            ));
        }
        process_identity(client_pid)
    }

    pub(crate) fn process_is_descendant_or_same(
        peer: PeerProcessIdentity,
        root: PeerProcessIdentity,
    ) -> bool {
        if process_identity(peer.pid).ok() != Some(peer)
            || process_identity(root.pid).ok() != Some(root)
        {
            return false;
        }
        let Ok(parents) = process_parents() else {
            return false;
        };
        let mut current = peer.pid;
        for _ in 0..MAX_PROCESS_ANCESTORS {
            if current == root.pid {
                return true;
            }
            let Some(parent) = parents.get(&current).copied() else {
                return false;
            };
            if parent == 0 || parent == current {
                return false;
            }
            current = parent;
        }
        false
    }

    pub(super) fn process_identity(pid: u32) -> io::Result<PeerProcessIdentity> {
        let process =
            OwnedHandle::new(unsafe { OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, 0, pid) })?;
        let mut creation = FILETIME::default();
        let mut exit = FILETIME::default();
        let mut kernel = FILETIME::default();
        let mut user = FILETIME::default();
        if unsafe {
            GetProcessTimes(
                process.raw(),
                &mut creation,
                &mut exit,
                &mut kernel,
                &mut user,
            )
        } == 0
        {
            return Err(io::Error::last_os_error());
        }
        let started_at =
            (u128::from(creation.dwHighDateTime) << 32) | u128::from(creation.dwLowDateTime);
        Ok(PeerProcessIdentity { pid, started_at })
    }

    fn process_parents() -> io::Result<HashMap<u32, u32>> {
        let snapshot = unsafe { CreateToolhelp32Snapshot(TH32CS_SNAPPROCESS, 0) };
        if snapshot == INVALID_HANDLE_VALUE {
            return Err(io::Error::last_os_error());
        }
        let snapshot = OwnedHandle::new(snapshot)?;
        let mut entry = PROCESSENTRY32W {
            dwSize: u32::try_from(size_of::<PROCESSENTRY32W>())
                .expect("PROCESSENTRY32W size fits in u32"),
            ..unsafe { std::mem::zeroed() }
        };
        let mut parents = HashMap::new();
        if unsafe { Process32FirstW(snapshot.raw(), &mut entry) } == 0 {
            return Err(io::Error::last_os_error());
        }
        loop {
            parents.insert(entry.th32ProcessID, entry.th32ParentProcessID);
            if unsafe { Process32NextW(snapshot.raw(), &mut entry) } == 0 {
                break;
            }
        }
        Ok(parents)
    }

    pub(crate) fn restrict_path_to_current_user(path: &Path) -> crate::error::AppResult<()> {
        let descriptor = SecurityDescriptor::owner_only()?;
        let wide = path
            .as_os_str()
            .encode_wide()
            .chain(std::iter::once(0))
            .collect::<Vec<_>>();
        let flags = OWNER_SECURITY_INFORMATION
            | DACL_SECURITY_INFORMATION
            | PROTECTED_DACL_SECURITY_INFORMATION;
        if unsafe { SetFileSecurityW(wide.as_ptr(), flags, descriptor.raw) } == 0 {
            return Err(io::Error::last_os_error().into());
        }
        Ok(())
    }

    struct SecurityDescriptor {
        raw: PSECURITY_DESCRIPTOR,
    }

    impl SecurityDescriptor {
        fn owner_only() -> io::Result<Self> {
            let user_sid = current_user_sid_string()?;
            let sddl = format!("O:{user_sid}D:P(A;;GA;;;SY)(A;;GA;;;{user_sid})");
            let sddl = OsStr::new(&sddl)
                .encode_wide()
                .chain(std::iter::once(0))
                .collect::<Vec<_>>();
            let mut raw = ptr::null_mut();
            if unsafe {
                ConvertStringSecurityDescriptorToSecurityDescriptorW(
                    sddl.as_ptr(),
                    SDDL_REVISION_1,
                    &mut raw,
                    ptr::null_mut(),
                )
            } == 0
            {
                return Err(io::Error::last_os_error());
            }
            Ok(Self { raw })
        }
    }

    fn current_user_sid_string() -> io::Result<String> {
        let token = open_process_token(unsafe { GetCurrentProcess() })?;
        let user = TokenUserBuffer::read(token.raw())?;
        let mut raw = ptr::null_mut();
        if unsafe { ConvertSidToStringSidW(user.sid(), &mut raw) } == 0 || raw.is_null() {
            return Err(io::Error::last_os_error());
        }
        let raw = LocalWideString(raw);
        let length = unsafe {
            (0..)
                .find(|&index| *raw.0.add(index) == 0)
                .ok_or_else(|| io::Error::other("current user SID is not terminated"))?
        };
        String::from_utf16(unsafe { std::slice::from_raw_parts(raw.0, length) })
            .map_err(|_| io::Error::other("current user SID is not valid UTF-16"))
    }

    struct LocalWideString(*mut u16);

    impl Drop for LocalWideString {
        fn drop(&mut self) {
            if !self.0.is_null() {
                unsafe {
                    LocalFree(self.0 as HLOCAL);
                }
            }
        }
    }

    impl Drop for SecurityDescriptor {
        fn drop(&mut self) {
            if !self.raw.is_null() {
                unsafe {
                    LocalFree(self.raw as HLOCAL);
                }
            }
        }
    }

    struct OwnedHandle(HANDLE);

    impl OwnedHandle {
        fn new(raw: HANDLE) -> io::Result<Self> {
            if raw.is_null() {
                Err(io::Error::last_os_error())
            } else {
                Ok(Self(raw))
            }
        }

        fn raw(&self) -> HANDLE {
            self.0
        }
    }

    impl Drop for OwnedHandle {
        fn drop(&mut self) {
            unsafe {
                CloseHandle(self.0);
            }
        }
    }

    fn open_process_token(process: HANDLE) -> io::Result<OwnedHandle> {
        let mut token = ptr::null_mut();
        if unsafe { OpenProcessToken(process, TOKEN_QUERY, &mut token) } == 0 {
            return Err(io::Error::last_os_error());
        }
        OwnedHandle::new(token)
    }

    struct TokenUserBuffer {
        words: Vec<usize>,
    }

    impl TokenUserBuffer {
        fn read(token: HANDLE) -> io::Result<Self> {
            let mut required = 0u32;
            unsafe {
                GetTokenInformation(token, TokenUser, ptr::null_mut(), 0, &mut required);
            }
            if required < size_of::<TOKEN_USER>() as u32 {
                return Err(io::Error::last_os_error());
            }
            let word_bytes = size_of::<usize>();
            let words = usize::try_from(required)
                .ok()
                .and_then(|bytes| bytes.checked_add(word_bytes - 1))
                .map(|bytes| bytes / word_bytes)
                .ok_or_else(|| io::Error::other("token user buffer is too large"))?;
            let mut buffer = Self {
                words: vec![0usize; words],
            };
            if unsafe {
                GetTokenInformation(
                    token,
                    TokenUser,
                    buffer.words.as_mut_ptr().cast::<c_void>(),
                    required,
                    &mut required,
                )
            } == 0
            {
                return Err(io::Error::last_os_error());
            }
            Ok(buffer)
        }

        fn sid(&self) -> windows_sys::Win32::Security::PSID {
            let user = unsafe { &*(self.words.as_ptr().cast::<TOKEN_USER>()) };
            user.User.Sid
        }
    }
}

#[cfg(windows)]
pub(crate) use windows::{
    create_named_pipe, process_is_descendant_or_same, restrict_path_to_current_user,
    verify_named_pipe_peer,
};
