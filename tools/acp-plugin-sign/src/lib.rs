//! Non-interactive Minisign support for protected ACP adapter releases.

use std::fs::{File, OpenOptions};
use std::io::{BufReader, Write};
#[cfg(unix)]
use std::os::unix::fs::OpenOptionsExt;
use std::path::PathBuf;

use minisign::SecretKey;

pub fn sign_file(
    secret_key_path: PathBuf,
    message_path: PathBuf,
    signature_path: PathBuf,
    password: String,
) -> Result<(), String> {
    let secret_key = SecretKey::from_file(secret_key_path, Some(password))
        .map_err(|_| "the protected Minisign key could not be opened".to_string())?;
    let message = File::open(message_path)
        .map_err(|_| "the message to sign could not be opened".to_string())?;
    let signature = minisign::sign(None, &secret_key, BufReader::new(message), None, None)
        .map_err(|_| "the message could not be signed".to_string())?
        .into_string();
    let mut options = OpenOptions::new();
    options.write(true).create_new(true);
    #[cfg(unix)]
    options.mode(0o600);
    let mut output = options
        .open(signature_path)
        .map_err(|_| "the signature destination could not be created".to_string())?;
    output
        .write_all(signature.as_bytes())
        .map_err(|_| "the signature could not be written".to_string())?;
    Ok(())
}
