use std::fs::{File, OpenOptions};
use std::io::{BufRead, BufWriter, Read, Seek, SeekFrom, Write};
use std::path::Path;

use calamine::Data;
use flate2::read::GzDecoder;
use serde_json::Value;
use sha2::{Digest, Sha256};

use crate::error::{AppError, AppResult};
use crate::features::jobs::JobFormat;

use super::import::{ImportDataRow, ImportItem};
use super::{
    MAX_DOCUMENT_INPUT_BYTES, MAX_ERROR_MESSAGE_CHARS, MAX_ERROR_ROW_BYTES,
    MAX_ERROR_ROW_PREVIEW_CHARS, MAX_STREAM_RECORD_BYTES,
};

pub(super) struct BoundedCsvReader<R> {
    inner: R,
    record_bytes: usize,
    in_quotes: bool,
}

impl<R> BoundedCsvReader<R> {
    pub(super) fn new(inner: R) -> Self {
        Self {
            inner,
            record_bytes: 0,
            in_quotes: false,
        }
    }
}

impl<R: Read> Read for BoundedCsvReader<R> {
    fn read(&mut self, buffer: &mut [u8]) -> std::io::Result<usize> {
        let read = self.inner.read(buffer)?;
        for byte in &buffer[..read] {
            self.record_bytes = self.record_bytes.saturating_add(1);
            if self.record_bytes > MAX_STREAM_RECORD_BYTES {
                return Err(std::io::Error::new(
                    std::io::ErrorKind::InvalidData,
                    "CSV record exceeds the 8 MiB safety limit",
                ));
            }
            if *byte == b'"' {
                self.in_quotes = !self.in_quotes;
            } else if *byte == b'\n' && !self.in_quotes {
                self.record_bytes = 0;
            }
        }
        Ok(read)
    }
}

pub(super) fn read_line_bounded<R: BufRead>(
    reader: &mut R,
    output: &mut Vec<u8>,
    limit: usize,
) -> std::io::Result<usize> {
    let mut total = 0;
    loop {
        let available = reader.fill_buf()?;
        if available.is_empty() {
            return Ok(total);
        }
        let take = available
            .iter()
            .position(|byte| *byte == b'\n')
            .map_or(available.len(), |position| position + 1);
        if output.len().saturating_add(take) > limit {
            return Err(std::io::Error::new(
                std::io::ErrorKind::InvalidData,
                "NDJSON line exceeds the 8 MiB safety limit",
            ));
        }
        output.extend_from_slice(&available[..take]);
        reader.consume(take);
        total += take;
        if output.last() == Some(&b'\n') {
            return Ok(total);
        }
    }
}

pub(super) fn open_reader(file: File, format: JobFormat) -> Box<dyn Read + Send> {
    if format.compressed() {
        Box::new(GzDecoder::new(file))
    } else {
        Box::new(file)
    }
}

pub(super) fn open_regular_input(path: &Path) -> AppResult<File> {
    let mut options = OpenOptions::new();
    options.read(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.custom_flags(libc::O_NOFOLLOW);
    }
    #[cfg(windows)]
    {
        use std::os::windows::fs::OpenOptionsExt;
        options.custom_flags(windows_sys::Win32::Storage::FileSystem::FILE_FLAG_OPEN_REPARSE_POINT);
    }
    let file = options.open(path)?;
    if !file.metadata()?.is_file() {
        return Err(AppError::Blocked {
            reason: "input capability no longer points to a regular file".into(),
        });
    }
    Ok(file)
}

pub(super) fn open_output_file(path: &Path, append: bool, private: bool) -> AppResult<File> {
    #[cfg(not(unix))]
    let _ = private;
    let mut options = OpenOptions::new();
    options
        .create(true)
        .read(append)
        .write(true)
        .append(append)
        .truncate(!append);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options
            .mode(if private { 0o600 } else { 0o666 })
            .custom_flags(libc::O_NOFOLLOW);
    }
    #[cfg(windows)]
    {
        use std::os::windows::fs::OpenOptionsExt;
        options.custom_flags(windows_sys::Win32::Storage::FileSystem::FILE_FLAG_OPEN_REPARSE_POINT);
    }
    let file = options.open(path)?;
    if !file.metadata()?.is_file() {
        return Err(AppError::Blocked {
            reason: "partial output no longer points to a regular file".into(),
        });
    }
    #[cfg(unix)]
    if private {
        use std::os::unix::fs::PermissionsExt;
        file.set_permissions(std::fs::Permissions::from_mode(0o600))?;
    }
    Ok(file)
}

pub(in crate::features::jobs) fn file_sha256(path: &Path) -> AppResult<String> {
    let mut file = open_regular_input(path)?;
    file_sha256_handle(&mut file)
}

pub(super) fn file_sha256_handle(file: &mut File) -> AppResult<String> {
    file.seek(SeekFrom::Start(0))?;
    let mut hasher = Sha256::new();
    let mut buffer = [0_u8; 64 * 1024];
    loop {
        let read = file.read(&mut buffer)?;
        if read == 0 {
            break;
        }
        hasher.update(&buffer[..read]);
    }
    Ok(hex::encode(hasher.finalize()))
}

pub(super) fn read_bounded_document(mut reader: Box<dyn Read + Send>) -> AppResult<Vec<u8>> {
    let mut bytes = Vec::new();
    reader
        .by_ref()
        .take(MAX_DOCUMENT_INPUT_BYTES + 1)
        .read_to_end(&mut bytes)?;
    if bytes.len() as u64 > MAX_DOCUMENT_INPUT_BYTES {
        return Err(AppError::Blocked {
            reason:
                "document-style inputs are limited to 512 MiB after decompression; use a streaming format"
                    .into(),
        });
    }
    Ok(bytes)
}

pub(super) fn object_item(source_line: u64, raw: Value) -> AppResult<ImportItem> {
    let object = raw.as_object().ok_or_else(|| {
        AppError::Config(format!("input row {source_line} must be a JSON object"))
    })?;
    Ok(ImportItem::Data(ImportDataRow {
        source_line,
        values: object
            .iter()
            .map(|(key, value)| (key.clone(), value.clone()))
            .collect(),
        raw,
    }))
}

pub(super) fn calamine_text(value: &Data) -> String {
    match value {
        Data::String(value) => value.clone(),
        _ => value.to_string(),
    }
}

pub(super) fn calamine_value(value: &Data) -> Value {
    match value {
        Data::Empty => Value::Null,
        Data::String(value) => Value::String(value.clone()),
        Data::Float(value) => serde_json::Number::from_f64(*value)
            .map(Value::Number)
            .unwrap_or(Value::Null),
        Data::Int(value) => Value::from(*value),
        Data::Bool(value) => Value::from(*value),
        Data::DateTime(value) => Value::String(value.to_string()),
        Data::DateTimeIso(value) | Data::DurationIso(value) => Value::String(value.clone()),
        Data::Error(value) => Value::String(format!("<xlsx-error:{value:?}>")),
    }
}

pub(in crate::features::jobs) fn write_error_row(
    writer: &mut BufWriter<File>,
    source_line: u64,
    row: &Value,
    error: &str,
) -> AppResult<()> {
    let serialized_row = serde_json::to_vec(row)?;
    let bounded_row = if serialized_row.len() <= MAX_ERROR_ROW_BYTES {
        row.clone()
    } else {
        serde_json::json!({
            "preview": String::from_utf8_lossy(
                &serialized_row[..serialized_row.len().min(MAX_ERROR_ROW_PREVIEW_CHARS)]
            ),
            "sha256": hex::encode(Sha256::digest(&serialized_row)),
            "truncated": true,
            "originalBytes": serialized_row.len(),
        })
    };
    let bounded_error = error
        .chars()
        .take(MAX_ERROR_MESSAGE_CHARS)
        .collect::<String>();
    serde_json::to_writer(
        &mut *writer,
        &serde_json::json!({
            "error": bounded_error,
            "row": bounded_row,
            "sourceLine": source_line,
        }),
    )?;
    writer.write_all(b"\n")?;
    Ok(())
}

pub(in crate::features::jobs) fn finalize_error_writer(
    mut writer: BufWriter<File>,
) -> AppResult<()> {
    writer.flush()?;
    writer.get_ref().sync_all()?;
    Ok(())
}

pub(in crate::features::jobs) fn create_error_writer(
    path: &Path,
    append: bool,
) -> AppResult<BufWriter<File>> {
    Ok(BufWriter::new(open_output_file(path, append, true)?))
}
