//! Desktop adapters for the connection-pinned advanced Shell.

mod authority;
mod desktop;
mod environment;
mod output;
mod process_tree;
mod runtime;
mod session;

pub(super) use desktop::DesktopTerminalAdapter;
