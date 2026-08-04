//! Cross-platform cleanup for one fixed-argv provisioner process.

use std::io;
use std::process::ExitStatus;

use tokio::process::Child;

use super::ProvisioningProcessFailure;

pub(super) struct ProvisioningProcessTree {
    #[cfg(unix)]
    process_group: i32,
    #[cfg(unix)]
    armed: bool,
    #[cfg(windows)]
    job: WindowsJob,
}

impl ProvisioningProcessTree {
    pub(super) fn attach(child: &Child) -> Result<Self, ProvisioningProcessFailure> {
        #[cfg(unix)]
        let process_group = {
            let process_id = child
                .id()
                .and_then(|value| i32::try_from(value).ok())
                .ok_or(ProvisioningProcessFailure::ProcessIsolationFailed)?;
            let observed = unsafe { libc::getpgid(process_id) };
            if observed != process_id {
                return Err(ProvisioningProcessFailure::ProcessIsolationFailed);
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

    pub(super) async fn terminate_and_reap(
        &mut self,
        child: &mut Child,
    ) -> Result<ExitStatus, ProvisioningProcessFailure> {
        if let Some(status) = child
            .try_wait()
            .map_err(|_| ProvisioningProcessFailure::CleanupFailed)?
        {
            #[cfg(unix)]
            {
                prove_group_absent(self.process_group).await?;
                self.armed = false;
            }
            return Ok(status);
        }
        #[cfg(unix)]
        {
            match signal_group(self.process_group, libc::SIGTERM)? {
                GroupSignal::Delivered | GroupSignal::Absent => {}
                GroupSignal::PermissionDenied => {
                    if child
                        .try_wait()
                        .map_err(|_| ProvisioningProcessFailure::CleanupFailed)?
                        .is_some()
                    {
                        let status = child
                            .wait()
                            .await
                            .map_err(|_| ProvisioningProcessFailure::CleanupFailed)?;
                        prove_group_absent(self.process_group).await?;
                        self.armed = false;
                        return Ok(status);
                    }
                    return Err(ProvisioningProcessFailure::CleanupFailed);
                }
            }
            tokio::time::sleep(std::time::Duration::from_millis(25)).await;
            match signal_group(self.process_group, libc::SIGKILL)? {
                GroupSignal::Delivered | GroupSignal::Absent => {}
                GroupSignal::PermissionDenied => {
                    return Err(ProvisioningProcessFailure::CleanupFailed)
                }
            }
        }
        #[cfg(windows)]
        self.job.terminate(137)?;

        let status = child
            .wait()
            .await
            .map_err(|_| ProvisioningProcessFailure::CleanupFailed)?;

        #[cfg(unix)]
        {
            prove_group_absent(self.process_group).await?;
            self.armed = false;
        }
        Ok(status)
    }
}

#[cfg(unix)]
impl Drop for ProvisioningProcessTree {
    fn drop(&mut self) {
        if self.armed {
            let _ = unsafe { libc::kill(-self.process_group, libc::SIGKILL) };
        }
    }
}

#[cfg(unix)]
fn signal_group(
    process_group: i32,
    signal: libc::c_int,
) -> Result<GroupSignal, ProvisioningProcessFailure> {
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
        Err(ProvisioningProcessFailure::CleanupFailed)
    }
}

#[cfg(unix)]
fn group_is_absent(process_group: i32) -> Result<bool, ProvisioningProcessFailure> {
    let result = unsafe { libc::kill(-process_group, 0) };
    if result == 0 {
        return Ok(false);
    }
    let error = io::Error::last_os_error();
    if error.raw_os_error() == Some(libc::ESRCH) {
        Ok(true)
    } else {
        Err(ProvisioningProcessFailure::CleanupFailed)
    }
}

#[cfg(unix)]
async fn prove_group_absent(process_group: i32) -> Result<(), ProvisioningProcessFailure> {
    for attempt in 0..5 {
        if group_is_absent(process_group)? {
            return Ok(());
        }
        if attempt < 4 {
            tokio::time::sleep(std::time::Duration::from_millis(10)).await;
        }
    }
    Err(ProvisioningProcessFailure::CleanupFailed)
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
    fn attach(child: &Child) -> Result<Self, ProvisioningProcessFailure> {
        use std::mem::{size_of, zeroed};

        use windows_sys::Win32::Foundation::CloseHandle;
        use windows_sys::Win32::System::JobObjects::{
            AssignProcessToJobObject, CreateJobObjectW, JobObjectExtendedLimitInformation,
            SetInformationJobObject, JOBOBJECT_EXTENDED_LIMIT_INFORMATION,
            JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE,
        };

        let process = child
            .raw_handle()
            .ok_or(ProvisioningProcessFailure::ProcessIsolationFailed)?
            as windows_sys::Win32::Foundation::HANDLE;
        let handle = unsafe { CreateJobObjectW(std::ptr::null(), std::ptr::null()) };
        if handle.is_null() {
            return Err(ProvisioningProcessFailure::ProcessIsolationFailed);
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
            return Err(ProvisioningProcessFailure::ProcessIsolationFailed);
        }
        Ok(Self { handle })
    }

    fn terminate(&self, code: u32) -> Result<(), ProvisioningProcessFailure> {
        use windows_sys::Win32::System::JobObjects::TerminateJobObject;

        if unsafe { TerminateJobObject(self.handle, code) } == 0 {
            Err(ProvisioningProcessFailure::CleanupFailed)
        } else {
            Ok(())
        }
    }
}

#[cfg(windows)]
impl Drop for WindowsJob {
    fn drop(&mut self) {
        unsafe { windows_sys::Win32::Foundation::CloseHandle(self.handle) };
    }
}
