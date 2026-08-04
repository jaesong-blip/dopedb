//! App-only ACP process launcher and typed MCP entrypoint.
//!
//! This binary is bundled with DopeDB but is never installed as the public CLI.
//! It registers the official ACP adapter process once, then serves typed MCP
//! tools that talk directly to the authenticated Local Broker.

mod acp_launch;
mod agent_mcp;
// The public CLI and app-only bridge compile the same Broker client module with
// different command surfaces, so a few public-CLI-only error paths are unused here.
#[allow(dead_code)]
mod client;
mod exit_code;

use std::process::ExitCode;

use client::ClientError;

#[tokio::main]
async fn main() -> ExitCode {
    let mut arguments = std::env::args().skip(1);
    let result = match arguments.next().as_deref() {
        Some("launch") => {
            let mut command = arguments.collect::<Vec<_>>();
            if command.first().is_some_and(|argument| argument == "--") {
                command.remove(0);
            }
            acp_launch::run(command).await
        }
        Some("mcp") if arguments.next().is_none() => agent_mcp::serve().await,
        _ => Err(ClientError::InvalidArguments),
    };
    match result {
        Ok(()) => ExitCode::from(exit_code::SUCCESS),
        Err(error) => {
            eprintln!("{error}");
            ExitCode::from(exit_code::for_client_error(&error))
        }
    }
}
