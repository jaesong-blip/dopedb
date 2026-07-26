//! Desktop adapters for Terminal Dock use cases.

mod authority;
mod desktop;
mod environment;
mod output;
mod process_tree;
mod replay;
mod runtime;
mod session;

pub(super) use desktop::DesktopTerminalAdapter;
