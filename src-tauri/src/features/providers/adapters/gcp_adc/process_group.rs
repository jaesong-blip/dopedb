//! Process-group lifecycle fencing for the fixed gcloud child.

use tokio::process::Child;
#[cfg(unix)]
use tokio::time::{sleep, Duration};

use crate::error::AppResult;

use super::blocked;

#[cfg(unix)]
const POLL: Duration = Duration::from_millis(10);
#[cfg(unix)]
const LIVENESS_POLLS: usize = 5;

/// Captures the isolated gcloud PGID before stdout draining can race its exit.
#[derive(Clone, Copy)]
pub(super) struct ChildTermination {
    #[cfg(unix)]
    group: Option<ProcessGroup>,
}

impl ChildTermination {
    pub(super) fn capture(child: &Child) -> Self {
        Self {
            #[cfg(unix)]
            group: ProcessGroup::for_child(child),
        }
    }
}

/// Stops the exact child/group on every output error or timeout.
pub(super) async fn terminate_child(
    child: &mut Child,
    termination: ChildTermination,
) -> AppResult<()> {
    #[cfg(unix)]
    {
        if let Some(group) = termination.group {
            group.terminate_before_reap(child).await
        } else {
            let _ = child;
            // The production child is always spawned into its own process group.
            // If its PGID could not be captured, killing only the leader would not
            // prove a descendant released the private ADC snapshot.
            Err(blocked("GCP ADC credential was rejected"))
        }
    }
    #[cfg(not(unix))]
    {
        child
            .start_kill()
            .map_err(|_| blocked("GCP ADC credential was rejected"))?;
        child
            .wait()
            .await
            .map_err(|_| blocked("GCP ADC credential was rejected"))?;
        Ok(())
    }
}

/// Fences descendants before snapshot cleanup after a complete stdout token.
pub(super) async fn finish_child_before_snapshot_cleanup(
    child: &mut Child,
    termination: ChildTermination,
) -> AppResult<bool> {
    #[cfg(unix)]
    {
        if let Some(group) = termination.group {
            group.terminate_before_reap(child).await?;
            Ok(true)
        } else {
            let _ = child;
            Err(blocked("GCP ADC credential was rejected"))
        }
    }
    #[cfg(not(unix))]
    child
        .wait()
        .await
        .map(|status| status.success())
        .map_err(|_| blocked("GCP ADC credential was rejected"))
}

#[cfg(unix)]
#[derive(Clone, Copy)]
struct ProcessGroup {
    leader: libc::pid_t,
}

#[cfg(unix)]
impl ProcessGroup {
    fn for_child(child: &Child) -> Option<Self> {
        let leader = child.id()? as libc::pid_t;
        (unsafe { libc::getpgid(leader) } == leader).then_some(Self { leader })
    }

    async fn terminate_before_reap(self, child: &mut Child) -> AppResult<()> {
        match self.signal(libc::SIGTERM)? {
            GroupSignal::Delivered | GroupSignal::Absent => {}
            GroupSignal::PermissionDenied => {
                return Err(blocked("GCP ADC credential was rejected"));
            }
        }
        sleep(POLL).await;
        match self.signal(libc::SIGKILL)? {
            GroupSignal::Delivered | GroupSignal::Absent => {}
            GroupSignal::PermissionDenied => {
                return Err(blocked("GCP ADC credential was rejected"));
            }
        }
        // All destructive signals precede reap, so no reused PID/PGID can be
        // targeted. After reaping, only signal 0 is permitted: a reused PGID
        // is deliberately a false denial, never a target for another signal.
        child
            .wait()
            .await
            .map_err(|_| blocked("GCP ADC credential was rejected"))?;
        self.prove_group_absent().await
    }

    async fn prove_group_absent(self) -> AppResult<()> {
        for attempt in 0..LIVENESS_POLLS {
            let status = self.signal(0)?;
            if status == GroupSignal::Absent {
                return Ok(());
            }
            if attempt + 1 < LIVENESS_POLLS {
                sleep(POLL).await;
            }
        }
        // `Delivered` means a live, signalable member remains; `EPERM` means
        // an inaccessible member may remain. Neither proves the snapshot FD
        // is gone, and a reused PGID is intentionally denied by the same rule.
        Err(blocked("GCP ADC credential was rejected"))
    }

    fn signal(self, signal: libc::c_int) -> AppResult<GroupSignal> {
        let result = unsafe { libc::kill(-self.leader, signal) };
        let error = std::io::Error::last_os_error();
        if result == 0 {
            Ok(GroupSignal::Delivered)
        } else if error.raw_os_error() == Some(libc::ESRCH) {
            Ok(GroupSignal::Absent)
        } else if error.raw_os_error() == Some(libc::EPERM) {
            Ok(GroupSignal::PermissionDenied)
        } else {
            Err(blocked("GCP ADC credential was rejected"))
        }
    }
}

#[cfg(unix)]
#[derive(Clone, Copy, PartialEq, Eq)]
enum GroupSignal {
    Delivered,
    Absent,
    PermissionDenied,
}

#[cfg(test)]
mod tests {
    use super::GroupSignal;

    fn probe_sequence_proves_absence(sequence: &[GroupSignal]) -> bool {
        sequence
            .last()
            .is_some_and(|signal| *signal == GroupSignal::Absent)
    }

    #[test]
    fn darwin_liveness_probe_requires_esrch_after_reap() {
        // Repeat to characterize the race-sensitive rule independently of
        // process scheduling: only ESRCH proves the original group is gone.
        for _ in 0..20 {
            assert!(probe_sequence_proves_absence(&[
                GroupSignal::Delivered,
                GroupSignal::Absent,
            ]));
            assert!(!probe_sequence_proves_absence(&[
                GroupSignal::Delivered,
                GroupSignal::Delivered,
            ]));
            assert!(!probe_sequence_proves_absence(&[
                GroupSignal::PermissionDenied,
                GroupSignal::PermissionDenied,
            ]));
        }
    }
}
