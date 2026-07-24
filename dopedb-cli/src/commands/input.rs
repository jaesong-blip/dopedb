//! Bounded stdin input shared by SQL and typed document commands.

use std::io::{self, Read};

use crate::client::ClientError;

pub(crate) fn read_stdin_utf8(file: &str, max_bytes: u64) -> Result<String, ClientError> {
    if file != "-" {
        return Err(ClientError::InvalidArguments);
    }
    let mut bytes = Vec::new();
    io::stdin()
        .take(max_bytes + 1)
        .read_to_end(&mut bytes)
        .map_err(|_| ClientError::Internal)?;
    if bytes.is_empty() || bytes.len() as u64 > max_bytes {
        return Err(ClientError::InvalidArguments);
    }
    String::from_utf8(bytes).map_err(|_| ClientError::InvalidArguments)
}
