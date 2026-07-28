//! Desktop adapters for Terminal Dock use cases.

mod authority;
mod desktop;
mod environment;
mod output;
mod process_tree;
mod replay;
mod runtime;
mod session;
mod setup_desktop;
mod setup_runtime;
mod setup_session;

pub(super) use desktop::DesktopTerminalAdapter;
pub(super) use setup_desktop::DesktopSkillSetupTerminalAdapter;
