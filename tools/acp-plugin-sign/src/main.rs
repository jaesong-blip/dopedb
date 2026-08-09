//! Non-interactive Minisign helper for the protected ACP adapter release job.

use std::env;
use std::path::PathBuf;

use acp_plugin_sign::sign_file;

fn main() {
    if let Err(error) = run() {
        eprintln!("acp-plugin-sign: {error}");
        std::process::exit(1);
    }
}

fn run() -> Result<(), String> {
    let secret_key_path = required_path("--secret-key")?;
    let message_path = required_path("--message")?;
    let signature_path = required_path("--signature")?;
    let password = env::var("MINISIGN_PASSWORD").unwrap_or_default();
    sign_file(secret_key_path, message_path, signature_path, password)
}

fn required_path(name: &str) -> Result<PathBuf, String> {
    let mut arguments = env::args_os().skip(1);
    while let Some(argument) = arguments.next() {
        let value = arguments
            .next()
            .ok_or_else(|| format!("missing value for {name}"))?;
        if argument == name {
            return Ok(PathBuf::from(value));
        }
    }
    Err(format!("missing required argument {name}"))
}
