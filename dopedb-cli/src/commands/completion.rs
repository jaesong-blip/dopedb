//! Runtime-independent shell completion generation.

use std::io;

use clap::CommandFactory;
use clap_complete::{generate, Shell};

use crate::args::Cli;
use crate::client::ClientError;

pub(crate) fn write(shell: Shell) -> Result<(), ClientError> {
    let mut command = Cli::command();
    generate(shell, &mut command, "dopedb", &mut io::stdout());
    Ok(())
}
