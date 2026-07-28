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
