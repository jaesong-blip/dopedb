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
