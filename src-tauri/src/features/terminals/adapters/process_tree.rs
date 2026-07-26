//! Cross-platform descendant cleanup for one PTY session.

use std::io;

use portable_pty::Child;

use crate::error::{AppError, AppResult};

#[derive(Debug)]
pub(super) struct ProcessTree {
    #[cfg(unix)]
    process_id: u32,
    #[cfg(windows)]
    job: WindowsJob,
}

impl ProcessTree {
    pub(super) fn attach(child: &(dyn Child + Send + Sync)) -> AppResult<Self> {
        #[cfg(unix)]
        let process_id = child
            .process_id()
            .ok_or_else(|| AppError::Config("the PTY child has no process identifier".into()))?;
        #[cfg(unix)]
        require_isolated_process_group(process_id)?;
        #[cfg(windows)]
        let job = WindowsJob::attach(child)?;
        Ok(Self {
            #[cfg(unix)]
            process_id,
            #[cfg(windows)]
            job,
        })
    }

    pub(super) fn terminate(&self) -> io::Result<()> {
        #[cfg(unix)]
        {
            signal_group(self.process_id, libc::SIGTERM)
        }
        #[cfg(windows)]
        {
            self.job.terminate(143)
        }
    }

    pub(super) fn force_terminate(&self) -> io::Result<()> {
        #[cfg(unix)]
        {
            signal_group(self.process_id, libc::SIGKILL)
        }
        #[cfg(windows)]
        {
            self.job.terminate(137)
        }
    }
}

#[cfg(unix)]
fn require_isolated_process_group(process_id: u32) -> AppResult<()> {
    let process_id = i32::try_from(process_id)
        .map_err(|_| AppError::Config("the PTY process identifier is too large".into()))?;
    let process_group = unsafe { libc::getpgid(process_id) };
    if process_group < 0 {
        return Err(io::Error::last_os_error().into());
    }
    if process_group != process_id {
        return Err(AppError::Config(
            "the PTY child did not start in an isolated process group".into(),
        ));
    }
    Ok(())
}

#[cfg(unix)]
fn signal_group(process_id: u32, signal: libc::c_int) -> io::Result<()> {
    let process_id = i32::try_from(process_id)
        .map_err(|_| io::Error::new(io::ErrorKind::InvalidInput, "process id is too large"))?;
    let result = unsafe { libc::kill(-process_id, signal) };
    if result == 0 {
        return Ok(());
    }
    let error = io::Error::last_os_error();
    if error.raw_os_error() == Some(libc::ESRCH) {
        Ok(())
    } else {
        Err(error)
    }
}

#[cfg(windows)]
#[derive(Debug)]
struct WindowsJob {
    handle: windows_sys::Win32::Foundation::HANDLE,
}

#[cfg(windows)]
unsafe impl Send for WindowsJob {}
#[cfg(windows)]
unsafe impl Sync for WindowsJob {}

#[cfg(windows)]
impl WindowsJob {
    fn attach(child: &(dyn Child + Send + Sync)) -> AppResult<Self> {
        use std::mem::{size_of, zeroed};

        use windows_sys::Win32::Foundation::CloseHandle;
        use windows_sys::Win32::System::JobObjects::{
            AssignProcessToJobObject, CreateJobObjectW, JobObjectExtendedLimitInformation,
            SetInformationJobObject, JOBOBJECT_EXTENDED_LIMIT_INFORMATION,
            JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE,
        };

        let process = child
            .as_raw_handle()
            .ok_or_else(|| AppError::Config("the Windows PTY child has no process handle".into()))?
            as windows_sys::Win32::Foundation::HANDLE;
        let handle = unsafe { CreateJobObjectW(std::ptr::null(), std::ptr::null()) };
        if handle.is_null() {
            return Err(io::Error::last_os_error().into());
        }
        let mut limits: JOBOBJECT_EXTENDED_LIMIT_INFORMATION = unsafe { zeroed() };
        limits.BasicLimitInformation.LimitFlags = JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE;
        let configured = unsafe {
            SetInformationJobObject(
                handle,
                JobObjectExtendedLimitInformation,
                std::ptr::from_ref(&limits).cast(),
                u32::try_from(size_of::<JOBOBJECT_EXTENDED_LIMIT_INFORMATION>())
                    .expect("job limit structure fits in u32"),
            )
        };
        if configured == 0 || unsafe { AssignProcessToJobObject(handle, process) } == 0 {
            let error = io::Error::last_os_error();
            unsafe {
                CloseHandle(handle);
            }
            return Err(error.into());
        }
        Ok(Self { handle })
    }

    fn terminate(&self, code: u32) -> io::Result<()> {
        use windows_sys::Win32::System::JobObjects::TerminateJobObject;

        if unsafe { TerminateJobObject(self.handle, code) } == 0 {
            Err(io::Error::last_os_error())
        } else {
            Ok(())
        }
    }
}

#[cfg(windows)]
impl Drop for WindowsJob {
    fn drop(&mut self) {
        unsafe {
            windows_sys::Win32::Foundation::CloseHandle(self.handle);
        }
    }
}

#[cfg(all(test, unix))]
mod tests {
    use std::io::{BufRead, BufReader};
    use std::time::{Duration, Instant};

    use portable_pty::{native_pty_system, CommandBuilder, PtySize};

    use super::*;

    fn process_exists(process_id: i32) -> bool {
        let result = unsafe { libc::kill(process_id, 0) };
        result == 0 || io::Error::last_os_error().raw_os_error() != Some(libc::ESRCH)
    }

    #[test]
    fn unix_process_group_cleanup_reaches_a_grandchild() {
        let pair = native_pty_system()
            .openpty(PtySize {
                rows: 24,
                cols: 80,
                pixel_width: 0,
                pixel_height: 0,
            })
            .unwrap();
        let reader = pair.master.try_clone_reader().unwrap();
        let mut command = CommandBuilder::new("/bin/sh");
        command.args([
            "-c",
            "sleep 30 & descendant=$!; printf '%s %s\\n' $$ \"$descendant\"; wait",
        ]);
        let mut child = pair.slave.spawn_command(command).unwrap();
        let tree = ProcessTree::attach(child.as_ref()).unwrap();
        let leader = i32::try_from(tree.process_id).unwrap();
        assert_eq!(unsafe { libc::getpgid(leader) }, leader);

        let mut line = String::new();
        BufReader::new(reader).read_line(&mut line).unwrap();
        let process_ids = line
            .split_whitespace()
            .map(|value| value.parse::<i32>().unwrap())
            .collect::<Vec<_>>();
        assert_eq!(process_ids.first().copied(), Some(leader));
        let descendant = process_ids[1];
        assert!(process_exists(descendant));

        tree.force_terminate().unwrap();
        child.wait().unwrap();
        let deadline = Instant::now() + Duration::from_secs(2);
        while process_exists(descendant) && Instant::now() < deadline {
            std::thread::sleep(Duration::from_millis(20));
        }
        assert!(
            !process_exists(descendant),
            "the Terminal descendant survived process-group cleanup"
        );
    }
}

// Windows CI runs this with the same portable-pty spawn path used by the desktop
// runtime. The child is only launched after ProcessTree::attach puts its parent in
// the job, then writes READY before it can attempt the delayed SURVIVOR marker.
#[cfg(all(test, windows))]
mod windows_tests {
    use std::fs;
    use std::path::{Path, PathBuf};
    use std::time::{Duration, Instant};

    use portable_pty::{native_pty_system, CommandBuilder, PtySize};
    use uuid::Uuid;

    use super::*;

    const MARKER_TIMEOUT: Duration = Duration::from_secs(5);
    const POLL_INTERVAL: Duration = Duration::from_millis(25);

    struct MarkerFiles {
        go: PathBuf,
        ready: PathBuf,
        survivor: PathBuf,
        script: PathBuf,
        child_script: PathBuf,
    }

    impl MarkerFiles {
        fn new() -> Self {
            let id = Uuid::new_v4().simple().to_string();
            let root = std::env::temp_dir();
            Self {
                go: root.join(format!("dopedb_terminal_{id}_go")),
                ready: root.join(format!("dopedb_terminal_{id}_ready")),
                survivor: root.join(format!("dopedb_terminal_{id}_survivor")),
                script: root.join(format!("dopedb_terminal_{id}_script.cmd")),
                child_script: root.join(format!("dopedb_terminal_{id}_child.cmd")),
            }
        }

        fn write_script(&self) {
            let script = format!(
                "@echo off\r\n:wait\r\nif exist \"{}\" goto launch\r\nping -n 2 127.0.0.1 >nul\r\ngoto wait\r\n:launch\r\nstart \"\" /B cmd.exe /D /C call \"{}\"\r\nping -n 30 127.0.0.1 >nul\r\n",
                self.go.display(),
                self.child_script.display(),
            );
            fs::write(&self.script, script).unwrap();
            let child_script = format!(
                "@echo off\r\necho READY>\"{}\"\r\nping -n 4 127.0.0.1 >nul\r\necho SURVIVOR>\"{}\"\r\n",
                self.ready.display(),
                self.survivor.display(),
            );
            fs::write(&self.child_script, child_script).unwrap();
        }
    }

    impl Drop for MarkerFiles {
        fn drop(&mut self) {
            for path in [
                &self.go,
                &self.ready,
                &self.survivor,
                &self.script,
                &self.child_script,
            ] {
                let _ = fs::remove_file(path);
            }
        }
    }

    fn marker_appeared(path: &Path) -> bool {
        let deadline = Instant::now() + MARKER_TIMEOUT;
        while !path.exists() && Instant::now() < deadline {
            std::thread::sleep(POLL_INTERVAL);
        }
        path.exists()
    }

    #[test]
    fn windows_job_cleanup_prevents_a_descendant_from_outliving_the_pty() {
        let markers = MarkerFiles::new();
        markers.write_script();
        let pair = native_pty_system()
            .openpty(PtySize {
                rows: 24,
                cols: 80,
                pixel_width: 0,
                pixel_height: 0,
            })
            .unwrap();
        let mut command = CommandBuilder::new("cmd.exe");
        let script = markers.script.to_string_lossy().into_owned();
        command.args(["/D", "/C", &script]);
        let mut child = pair.slave.spawn_command(command).unwrap();
        // This is the production attach/force_terminate sequence: the GO marker
        // deliberately delays descendant launch until after the job assignment.
        let tree = ProcessTree::attach(child.as_ref()).unwrap();
        fs::write(&markers.go, "go").unwrap();
        if !marker_appeared(&markers.ready) {
            let _ = tree.force_terminate();
            let _ = child.wait();
            panic!("READY marker was not written before timeout");
        }

        if let Err(error) = tree.force_terminate() {
            let _ = child.kill();
            let _ = child.wait();
            panic!("could not terminate the Windows PTY job tree: {error}");
        }
        child.wait().unwrap();
        assert!(
            !marker_appeared(&markers.survivor),
            "the Terminal descendant survived Windows job cleanup"
        );
    }
}
