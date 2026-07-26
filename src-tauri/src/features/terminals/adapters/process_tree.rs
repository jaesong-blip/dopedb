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
// runtime. The PTY child re-enters this test binary, which then spawns a second
// test-binary process. That avoids cmd.exe quoting while still proving that a real
// descendant inherited the production Job Object before it is closed.
#[cfg(all(test, windows))]
mod windows_tests {
    use std::fs;
    use std::path::{Path, PathBuf};
    use std::process::Command;
    use std::time::{Duration, Instant};

    use portable_pty::{native_pty_system, CommandBuilder, PtySize};
    use uuid::Uuid;
    use windows_sys::Win32::Foundation::{CloseHandle, STILL_ACTIVE};
    use windows_sys::Win32::System::Threading::{
        GetExitCodeProcess, OpenProcess, PROCESS_QUERY_LIMITED_INFORMATION,
    };

    use super::*;

    const HANDSHAKE_TIMEOUT: Duration = Duration::from_secs(20);
    const SURVIVOR_DELAY: Duration = Duration::from_secs(8);
    const POLL_INTERVAL: Duration = Duration::from_millis(25);
    const PROCESS_TREE_MODE: &str = "DOPEDB_TERMINAL_PROCESS_TREE_MODE";
    const GO_MARKER: &str = "DOPEDB_TERMINAL_PROCESS_TREE_GO";
    const READY_MARKER: &str = "DOPEDB_TERMINAL_PROCESS_TREE_READY";
    const SURVIVOR_MARKER: &str = "DOPEDB_TERMINAL_PROCESS_TREE_SURVIVOR";
    const PARENT_MODE: &str = "parent";
    const DESCENDANT_MODE: &str = "descendant";
    // libtest test names omit the crate prefix that `module_path!()` includes.
    const PARENT_HELPER_TEST: &str =
        "features::terminals::adapters::process_tree::windows_tests::windows_job_cleanup_parent_helper";
    const DESCENDANT_HELPER_TEST: &str =
        "features::terminals::adapters::process_tree::windows_tests::windows_job_cleanup_descendant_helper";

    struct MarkerFiles {
        go: PathBuf,
        ready: PathBuf,
        survivor: PathBuf,
    }

    impl MarkerFiles {
        fn new() -> Self {
            let id = Uuid::new_v4().simple().to_string();
            let root = std::env::temp_dir();
            Self {
                go: root.join(format!("dopedb_terminal_{id}_go")),
                ready: root.join(format!("dopedb_terminal_{id}_ready")),
                survivor: root.join(format!("dopedb_terminal_{id}_survivor")),
            }
        }
    }

    impl Drop for MarkerFiles {
        fn drop(&mut self) {
            for path in [&self.go, &self.ready, &self.survivor] {
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

    fn marker_path(name: &str) -> PathBuf {
        std::env::var_os(name)
            .map(PathBuf::from)
            .unwrap_or_else(|| panic!("missing {name} for Windows process-tree helper"))
    }

    fn run_test_binary(test_name: &str, mode: &str, markers: &MarkerFiles) -> Command {
        let executable = std::env::current_exe().unwrap();
        let mut command = Command::new(executable);
        command
            .args(["--exact", test_name, "--nocapture"])
            .env(PROCESS_TREE_MODE, mode)
            .env(GO_MARKER, &markers.go)
            .env(READY_MARKER, &markers.ready)
            .env(SURVIVOR_MARKER, &markers.survivor);
        command
    }

    fn terminate_and_wait(tree: &ProcessTree, child: &mut Box<dyn Child + Send + Sync>) {
        let _ = tree.force_terminate();
        let _ = child.kill();
        let _ = child.wait();
    }

    fn descendant_is_running(process_id: u32) -> bool {
        // The READY marker carries the PID. Querying the process immediately before
        // job termination rules out a marker-only success if the descendant exited.
        unsafe {
            let process = OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, 0, process_id);
            if process.is_null() {
                return false;
            }
            let mut exit_code = 0;
            let queried = GetExitCodeProcess(process, &mut exit_code) != 0;
            let _ = CloseHandle(process);
            queried && exit_code == STILL_ACTIVE as u32
        }
    }

    #[test]
    fn windows_job_cleanup_parent_helper() {
        if std::env::var(PROCESS_TREE_MODE).ok().as_deref() != Some(PARENT_MODE) {
            return;
        }

        let markers = MarkerFiles {
            go: marker_path(GO_MARKER),
            ready: marker_path(READY_MARKER),
            survivor: marker_path(SURVIVOR_MARKER),
        };
        assert!(
            marker_appeared(&markers.go, HANDSHAKE_TIMEOUT),
            "the test did not release the Windows process-tree parent"
        );

        let mut descendant = run_test_binary(DESCENDANT_HELPER_TEST, DESCENDANT_MODE, &markers)
            .spawn()
            .expect("spawn the Windows process-tree descendant helper");
        if !marker_appeared(&markers.ready, HANDSHAKE_TIMEOUT) {
            let _ = descendant.kill();
            let _ = descendant.wait();
            panic!("the Windows process-tree descendant did not signal READY");
        }

        let _ = descendant.wait();
    }

    #[test]
    fn windows_job_cleanup_descendant_helper() {
        if std::env::var(PROCESS_TREE_MODE).ok().as_deref() != Some(DESCENDANT_MODE) {
            return;
        }

        let ready = marker_path(READY_MARKER);
        let survivor = marker_path(SURVIVOR_MARKER);
        fs::write(&ready, std::process::id().to_string())
            .expect("write the Windows process-tree READY marker");
        std::thread::sleep(SURVIVOR_DELAY);
        fs::write(survivor, "survived").expect("write the Windows process-tree survivor marker");
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
        let executable = std::env::current_exe().unwrap();
        let mut command = CommandBuilder::new(executable.to_string_lossy().into_owned());
        command.args(["--exact", PARENT_HELPER_TEST, "--nocapture"]);
        command.env(PROCESS_TREE_MODE, PARENT_MODE);
        command.env(GO_MARKER, &markers.go);
        command.env(READY_MARKER, &markers.ready);
        command.env(SURVIVOR_MARKER, &markers.survivor);
        let mut child = pair.slave.spawn_command(command).unwrap();
        // This is the production attach/force_terminate sequence. The GO marker
        // deliberately delays descendant launch until after job assignment.
        let tree = match ProcessTree::attach(child.as_ref()) {
            Ok(tree) => tree,
            Err(error) => {
                let _ = child.kill();
                let _ = child.wait();
                panic!("could not attach the Windows PTY process to its job: {error}");
            }
        };
        if let Err(error) = fs::write(&markers.go, "go") {
            terminate_and_wait(&tree, &mut child);
            panic!("could not release the Windows process-tree parent: {error}");
        }
        if !marker_appeared(&markers.ready, HANDSHAKE_TIMEOUT) {
            terminate_and_wait(&tree, &mut child);
            panic!("READY marker was not written before timeout");
        }

        let ready = match fs::read_to_string(&markers.ready) {
            Ok(ready) => ready,
            Err(error) => {
                terminate_and_wait(&tree, &mut child);
                panic!("could not read the Windows process-tree READY marker: {error}");
            }
        };
        let descendant_process_id = match ready.trim().parse::<u32>() {
            Ok(process_id) => process_id,
            Err(error) => {
                terminate_and_wait(&tree, &mut child);
                panic!("could not parse the Windows process-tree descendant PID: {error}");
            }
        };
        if !descendant_is_running(descendant_process_id) {
            terminate_and_wait(&tree, &mut child);
            panic!("the Windows process-tree descendant was not alive before job cleanup");
        }

        if let Err(error) = tree.force_terminate() {
            let _ = child.kill();
            let _ = child.wait();
            panic!("could not terminate the Windows PTY job tree: {error}");
        }
        child.wait().unwrap();
        assert!(
            !marker_appeared(&markers.survivor, SURVIVOR_DELAY + Duration::from_secs(3)),
            "the Terminal descendant survived Windows job cleanup"
        );
    }
}
