//! Non-interactive Minisign helper for the protected ACP adapter release job.

use std::env;
use std::fs::{File, OpenOptions};
use std::io::{BufReader, Write};
#[cfg(unix)]
use std::os::unix::fs::OpenOptionsExt;
use std::path::PathBuf;

use minisign::SecretKey;

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

fn sign_file(
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

#[cfg(test)]
mod tests {
    use std::fs;
    use std::io::Cursor;

    use minisign::{KeyPair, SignatureBox};

    use super::sign_file;

    #[test]
    fn signs_an_empty_password_key_without_a_terminal() {
        let temporary = tempfile::tempdir().expect("temporary directory");
        let secret_key_path = temporary.path().join("test.key");
        let message_path = temporary.path().join("message.txt");
        let signature_path = temporary.path().join("message.txt.minisig");
        let pair = KeyPair::generate_encrypted_keypair(Some(String::new())).expect("key pair");
        fs::write(
            &secret_key_path,
            pair.sk.to_box(None).expect("secret key box").to_string(),
        )
        .expect("secret key file");
        let message = b"signed adapter manifest";
        fs::write(&message_path, message).expect("message file");

        sign_file(
            secret_key_path,
            message_path,
            signature_path.clone(),
            String::new(),
        )
        .expect("non-interactive signature");

        let signature = SignatureBox::from_file(signature_path).expect("signature file");
        minisign::verify(
            &pair.pk,
            &signature,
            Cursor::new(message),
            true,
            false,
            false,
        )
        .expect("valid signature");
    }
}
