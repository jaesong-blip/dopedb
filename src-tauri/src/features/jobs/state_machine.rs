//! Pure durable Job Engine transition policy.

use super::domain::JobState;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum JobTransition {
    PauseCompleted,
    InitialStartRolledBack,
    RunningCancellationRequested,
    WaitingCancelled,
    ExecutionSucceeded,
    ExecutionCancelled,
    ExecutionFailed,
    QueuedCancelled,
    QueuedFailed,
    PausedFailed,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) struct JobTransitionRule {
    pub(crate) from: &'static [JobState],
    pub(crate) to: JobState,
    pub(crate) event: &'static str,
}

const RUNNING: &[JobState] = &[JobState::Running];
const WAITING: &[JobState] = &[JobState::Queued, JobState::Paused];
const EXECUTING: &[JobState] = &[JobState::Running, JobState::CancelRequested];
const QUEUED: &[JobState] = &[JobState::Queued];
const PAUSED: &[JobState] = &[JobState::Paused];

impl JobTransition {
    pub(crate) const fn rule(self) -> JobTransitionRule {
        match self {
            Self::PauseCompleted => JobTransitionRule {
                from: RUNNING,
                to: JobState::Paused,
                event: "paused",
            },
            Self::InitialStartRolledBack => JobTransitionRule {
                from: RUNNING,
                to: JobState::Queued,
                event: "warning",
            },
            Self::RunningCancellationRequested => JobTransitionRule {
                from: RUNNING,
                to: JobState::CancelRequested,
                event: "warning",
            },
            Self::WaitingCancelled => JobTransitionRule {
                from: WAITING,
                to: JobState::Cancelled,
                event: "cancelled",
            },
            Self::ExecutionSucceeded => JobTransitionRule {
                from: EXECUTING,
                to: JobState::Succeeded,
                event: "succeeded",
            },
            Self::ExecutionCancelled => JobTransitionRule {
                from: EXECUTING,
                to: JobState::Cancelled,
                event: "cancelled",
            },
            Self::ExecutionFailed => JobTransitionRule {
                from: EXECUTING,
                to: JobState::Failed,
                event: "failed",
            },
            Self::QueuedCancelled => JobTransitionRule {
                from: QUEUED,
                to: JobState::Cancelled,
                event: "cancelled",
            },
            Self::QueuedFailed => JobTransitionRule {
                from: QUEUED,
                to: JobState::Failed,
                event: "failed",
            },
            Self::PausedFailed => JobTransitionRule {
                from: PAUSED,
                to: JobState::Failed,
                event: "failed",
            },
        }
    }
}

#[cfg(test)]
mod tests {
    use super::{JobState, JobTransition};

    #[test]
    fn every_terminal_transition_has_an_explicit_source_set() {
        for transition in [
            JobTransition::ExecutionSucceeded,
            JobTransition::ExecutionCancelled,
            JobTransition::ExecutionFailed,
            JobTransition::QueuedCancelled,
            JobTransition::QueuedFailed,
            JobTransition::PausedFailed,
        ] {
            let rule = transition.rule();
            assert!(rule.to.terminal());
            assert!(!rule.from.is_empty());
            assert!(rule.from.iter().all(|state| !state.terminal()));
        }
    }

    #[test]
    fn a_waiting_cancel_never_accepts_a_running_job() {
        let rule = JobTransition::WaitingCancelled.rule();

        assert_eq!(rule.from, &[JobState::Queued, JobState::Paused]);
        assert!(!rule.from.contains(&JobState::Running));
        assert_eq!(rule.to, JobState::Cancelled);
    }
}
