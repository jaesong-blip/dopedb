//! Cross-platform lifecycle boundary for a spawned CLI process and all descendants.

use std::io;
use std::process::ExitStatus;

use thiserror::Error;
use tokio::process::Child;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Error)]
pub(crate) enum ProcessTreeError {
    #[error("could not isolate the CLI process tree")]
    Isolation,
    #[error("could not prove the CLI process tree was stopped")]
    Cleanup,
}

pub(crate) struct ProcessTree {
    #[cfg(unix)]
    process_group: i32,
    #[cfg(unix)]
    armed: bool,
    #[cfg(windows)]
    job: WindowsJob,
}

impl ProcessTree {
    pub(crate) fn attach(child: &Child) -> Result<Self, ProcessTreeError> {
        #[cfg(unix)]
        let process_group = {
            let process_id = child
                .id()
                .and_then(|value| i32::try_from(value).ok())
                .ok_or(ProcessTreeError::Isolation)?;
            // SAFETY: `getpgid` only observes the freshly spawned child id.
            let observed = unsafe { libc::getpgid(process_id) };
            if observed != process_id {
                return Err(ProcessTreeError::Isolation);
            }
            process_id
        };
        #[cfg(windows)]
        let job = WindowsJob::attach(child)?;
        Ok(Self {
            #[cfg(unix)]
            process_group,
            #[cfg(unix)]
            armed: true,
            #[cfg(windows)]
            job,
        })
    }

    /// Stop every descendant, reap the root child, and prove the isolation scope is empty.
    pub(crate) async fn terminate_and_reap(
        &mut self,
        child: &mut Child,
    ) -> Result<ExitStatus, ProcessTreeError> {
        if let Some(status) = child.try_wait().map_err(|_| ProcessTreeError::Cleanup)? {
            #[cfg(unix)]
            {
                prove_group_absent(self.process_group).await?;
                self.armed = false;
            }
            #[cfg(windows)]
            self.job.prove_empty().await?;
            return Ok(status);
        }
        #[cfg(unix)]
        {
            match signal_group(self.process_group, libc::SIGTERM)? {
                GroupSignal::Delivered | GroupSignal::Absent => {}
                GroupSignal::PermissionDenied => {
                    if child
                        .try_wait()
                        .map_err(|_| ProcessTreeError::Cleanup)?
                        .is_some()
                    {
                        let status = child.wait().await.map_err(|_| ProcessTreeError::Cleanup)?;
                        prove_group_absent(self.process_group).await?;
                        self.armed = false;
                        return Ok(status);
                    }
                    return Err(ProcessTreeError::Cleanup);
                }
            }
            tokio::time::sleep(std::time::Duration::from_millis(25)).await;
            match signal_group(self.process_group, libc::SIGKILL)? {
                GroupSignal::Delivered | GroupSignal::Absent => {}
                GroupSignal::PermissionDenied => return Err(ProcessTreeError::Cleanup),
            }
        }
        #[cfg(windows)]
        self.job.terminate(137)?;

        let status = child.wait().await.map_err(|_| ProcessTreeError::Cleanup)?;

        #[cfg(unix)]
        {
            prove_group_absent(self.process_group).await?;
            self.armed = false;
        }
        #[cfg(windows)]
        self.job.prove_empty().await?;
        Ok(status)
    }
}

#[cfg(unix)]
impl Drop for ProcessTree {
    fn drop(&mut self) {
        if self.armed {
            // SAFETY: the negative id addresses only the isolated process group.
            let _ = unsafe { libc::kill(-self.process_group, libc::SIGKILL) };
        }
    }
}

#[cfg(unix)]
fn signal_group(process_group: i32, signal: libc::c_int) -> Result<GroupSignal, ProcessTreeError> {
    // SAFETY: the negative id addresses only the group proven in `attach`.
    let result = unsafe { libc::kill(-process_group, signal) };
    if result == 0 {
        return Ok(GroupSignal::Delivered);
    }
    let error = io::Error::last_os_error();
    if error.raw_os_error() == Some(libc::ESRCH) {
        Ok(GroupSignal::Absent)
    } else if error.raw_os_error() == Some(libc::EPERM) {
        Ok(GroupSignal::PermissionDenied)
    } else {
        Err(ProcessTreeError::Cleanup)
    }
}

#[cfg(unix)]
fn group_is_absent(process_group: i32) -> Result<bool, ProcessTreeError> {
    // SAFETY: signal 0 only checks the isolated group established by `attach`.
    let result = unsafe { libc::kill(-process_group, 0) };
    if result == 0 {
        return Ok(false);
    }
    let error = io::Error::last_os_error();
    if error.raw_os_error() == Some(libc::ESRCH) {
        Ok(true)
    } else {
        Err(ProcessTreeError::Cleanup)
    }
}

#[cfg(unix)]
async fn prove_group_absent(process_group: i32) -> Result<(), ProcessTreeError> {
    for attempt in 0..5 {
        if group_is_absent(process_group)? {
            return Ok(());
        }
        if attempt < 4 {
            tokio::time::sleep(std::time::Duration::from_millis(10)).await;
        }
    }
    Err(ProcessTreeError::Cleanup)
}

#[cfg(unix)]
enum GroupSignal {
    Delivered,
    Absent,
    PermissionDenied,
}

#[cfg(windows)]
struct WindowsJob {
    handle: windows_sys::Win32::Foundation::HANDLE,
}

#[cfg(windows)]
unsafe impl Send for WindowsJob {}
#[cfg(windows)]
unsafe impl Sync for WindowsJob {}

#[cfg(windows)]
impl WindowsJob {
    fn attach(child: &Child) -> Result<Self, ProcessTreeError> {
        use std::mem::{size_of, zeroed};

        use windows_sys::Win32::Foundation::CloseHandle;
        use windows_sys::Win32::System::JobObjects::{
            AssignProcessToJobObject, CreateJobObjectW, JobObjectExtendedLimitInformation,
            SetInformationJobObject, JOBOBJECT_EXTENDED_LIMIT_INFORMATION,
            JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE,
        };

        let process = child.raw_handle().ok_or(ProcessTreeError::Isolation)?
            as windows_sys::Win32::Foundation::HANDLE;
        let handle = unsafe { CreateJobObjectW(std::ptr::null(), std::ptr::null()) };
        if handle.is_null() {
            return Err(ProcessTreeError::Isolation);
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
            unsafe { CloseHandle(handle) };
            return Err(ProcessTreeError::Isolation);
        }
        Ok(Self { handle })
    }

    fn terminate(&self, code: u32) -> Result<(), ProcessTreeError> {
        use windows_sys::Win32::System::JobObjects::TerminateJobObject;

        if unsafe { TerminateJobObject(self.handle, code) } == 0 {
            Err(ProcessTreeError::Cleanup)
        } else {
            Ok(())
        }
    }

    async fn prove_empty(&self) -> Result<(), ProcessTreeError> {
        for attempt in 0..40 {
            if self.active_processes()? == 0 {
                return Ok(());
            }
            if attempt < 39 {
                tokio::time::sleep(std::time::Duration::from_millis(50)).await;
            }
        }
        Err(ProcessTreeError::Cleanup)
    }

    fn active_processes(&self) -> Result<u32, ProcessTreeError> {
        use std::mem::size_of;

        use windows_sys::Win32::System::JobObjects::{
            JobObjectBasicAccountingInformation, QueryInformationJobObject,
            JOBOBJECT_BASIC_ACCOUNTING_INFORMATION,
        };

        let mut accounting = JOBOBJECT_BASIC_ACCOUNTING_INFORMATION::default();
        let queried = unsafe {
            QueryInformationJobObject(
                self.handle,
                JobObjectBasicAccountingInformation,
                std::ptr::from_mut(&mut accounting).cast(),
                u32::try_from(size_of::<JOBOBJECT_BASIC_ACCOUNTING_INFORMATION>())
                    .expect("job accounting structure fits in u32"),
                std::ptr::null_mut(),
            )
        };
        if queried == 0 {
            Err(ProcessTreeError::Cleanup)
        } else {
            Ok(accounting.ActiveProcesses)
        }
    }
}

#[cfg(windows)]
impl Drop for WindowsJob {
    fn drop(&mut self) {
        unsafe { windows_sys::Win32::Foundation::CloseHandle(self.handle) };
    }
}
