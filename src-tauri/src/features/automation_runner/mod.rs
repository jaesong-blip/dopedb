//! Shared background execution settings for scheduled workspace automations.

pub(crate) mod transport;

pub(crate) const BACKGROUND_ARGUMENT: &str = "--automation-runner-background";

pub(crate) fn is_background_launch_argument(argument: &str) -> bool {
    argument == BACKGROUND_ARGUMENT
}
