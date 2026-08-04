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
use dopedb_protocol::OfficialAcpAdapter;

#[tokio::main(flavor = "current_thread")]
async fn main() -> ExitCode {
    let mut arguments = std::env::args().skip(1);
    let result = match arguments.next().as_deref() {
        Some("launch") => {
            let adapter = arguments
                .next()
                .as_deref()
                .and_then(OfficialAcpAdapter::parse);
            let launcher_executable = arguments.next();
            let launcher_resolved_executable = arguments.next();
            let launcher_sha256 = arguments.next();
            if let (
                Some(adapter),
                Some(launcher_executable),
                Some(launcher_resolved_executable),
                Some(launcher_sha256),
                None,
            ) = (
                adapter,
                launcher_executable,
                launcher_resolved_executable,
                launcher_sha256,
                arguments.next(),
            ) {
                acp_launch::run(
                    adapter,
                    launcher_executable,
                    launcher_resolved_executable,
                    launcher_sha256,
                )
                .await
            } else {
                Err(ClientError::InvalidArguments)
            }
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
