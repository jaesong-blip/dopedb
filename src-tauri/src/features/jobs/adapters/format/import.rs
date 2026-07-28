use std::collections::{BTreeMap, VecDeque};
use std::fs::File;
use std::io::{BufReader, Cursor, Read, Seek, SeekFrom};
use std::path::Path;

use calamine::{open_workbook_auto_from_rs, Reader};
use serde_json::Value;

use crate::error::{AppError, AppResult};
use crate::features::jobs::JobFormat;

use super::inspection::validate_xlsx_archive;
use super::io::{
    calamine_text, calamine_value, file_sha256_handle, object_item, open_reader,
    open_regular_input, read_bounded_document, read_line_bounded, BoundedCsvReader,
};
use super::MAX_STREAM_RECORD_BYTES;

pub(in crate::features::jobs) struct ImportDataRow {
    pub source_line: u64,
    pub values: BTreeMap<String, Value>,
    pub raw: Value,
}

pub(in crate::features::jobs) enum ImportItem {
    Data(ImportDataRow),
    Sql { source_line: u64, statement: String },
}

pub(in crate::features::jobs) enum ImportSource {
    Csv {
        reader: csv::Reader<Box<dyn Read + Send>>,
        headers: Vec<String>,
        source_line: u64,
    },
    Ndjson {
        reader: BufReader<Box<dyn Read + Send>>,
        buffer: Vec<u8>,
        source_line: u64,
        bytes_read: u64,
    },
    Json {
        rows: VecDeque<Value>,
        source_line: u64,
    },
    Sql {
        statements: VecDeque<String>,
        source_line: u64,
    },
    Xlsx {
        headers: Vec<String>,
        rows: VecDeque<Vec<Value>>,
        source_line: u64,
    },
}

impl ImportSource {
    fn open_file(
        file: File,
        format: JobFormat,
        resume_rows: u64,
        engine: crate::model::Engine,
    ) -> AppResult<Self> {
        let base = format.base();
        if base == JobFormat::Xlsx {
            if resume_rows > 0 {
                return Err(AppError::Blocked {
                    reason: "XLSX import cannot resume; start a new job".into(),
                });
            }
            return Self::open_xlsx(file);
        }
        let reader = open_reader(file, format);
        let mut source = match base {
            JobFormat::Csv | JobFormat::Tsv => {
                let mut reader = csv::ReaderBuilder::new()
                    .delimiter(if base == JobFormat::Tsv { b'\t' } else { b',' })
                    .flexible(true)
                    .from_reader(Box::new(BoundedCsvReader::new(reader)) as Box<dyn Read + Send>);
                let headers = reader
                    .headers()
                    .map_err(|error| AppError::Config(format!("CSV header is invalid: {error}")))?
                    .iter()
                    .map(str::to_owned)
                    .collect();
                Self::Csv {
                    reader,
                    headers,
                    source_line: 1,
                }
            }
            JobFormat::Ndjson => Self::Ndjson {
                reader: BufReader::new(reader),
                buffer: Vec::new(),
                source_line: 0,
                bytes_read: 0,
            },
            JobFormat::Json => {
                let bytes = read_bounded_document(reader)?;
                let value: Value = serde_json::from_slice(&bytes)?;
                let rows = value.as_array().ok_or_else(|| {
                    AppError::Config("JSON import expects one top-level array".into())
                })?;
                Self::Json {
                    rows: rows.clone().into(),
                    source_line: 0,
                }
            }
            JobFormat::Sql => {
                let bytes = read_bounded_document(reader)?;
                let sql = String::from_utf8(bytes)
                    .map_err(|_| AppError::Config("SQL import must be valid UTF-8".into()))?;
                Self::Sql {
                    statements: crate::sql_script::split_statements(&sql, engine).into(),
                    source_line: 0,
                }
            }
            _ => return Err(AppError::Config("unsupported import reader format".into())),
        };
        source.skip(resume_rows)?;
        Ok(source)
    }

    fn open_xlsx(file: File) -> AppResult<Self> {
        let bytes = read_bounded_document(Box::new(file))?;
        validate_xlsx_archive(&bytes)?;
        let mut workbook = open_workbook_auto_from_rs(Cursor::new(bytes))
            .map_err(|error| AppError::Config(format!("XLSX file is invalid: {error}")))?;
        let sheet_name = workbook
            .sheet_names()
            .first()
            .cloned()
            .ok_or_else(|| AppError::Config("XLSX workbook has no worksheets".into()))?;
        let range = workbook
            .worksheet_range(&sheet_name)
            .map_err(|error| AppError::Config(format!("XLSX worksheet is invalid: {error}")))?;
        let mut rows = range.rows();
        let headers = rows
            .next()
            .ok_or_else(|| AppError::Config("XLSX worksheet has no header row".into()))?
            .iter()
            .map(calamine_text)
            .collect::<Vec<_>>();
        let rows = rows
            .map(|row| row.iter().map(calamine_value).collect::<Vec<_>>())
            .collect::<VecDeque<_>>();
        Ok(Self::Xlsx {
            headers,
            rows,
            source_line: 1,
        })
    }

    pub(in crate::features::jobs) fn open_verified(
        path: &Path,
        format: JobFormat,
        resume_rows: u64,
        engine: crate::model::Engine,
        expected_sha256: &str,
    ) -> AppResult<(Self, String)> {
        let mut file = open_regular_input(path)?;
        let actual_sha256 = file_sha256_handle(&mut file)?;
        if actual_sha256 != expected_sha256 {
            return Err(AppError::Blocked {
                reason: "the selected input file changed after the job was reviewed".into(),
            });
        }
        file.seek(SeekFrom::Start(0))?;
        let source = Self::open_file(file, format, resume_rows, engine)?;
        Ok((source, actual_sha256))
    }

    fn skip(&mut self, rows: u64) -> AppResult<()> {
        for _ in 0..rows {
            if self.next_item()?.is_none() {
                break;
            }
        }
        Ok(())
    }

    pub(in crate::features::jobs) fn next_batch(
        &mut self,
        batch_size: usize,
    ) -> AppResult<Vec<ImportItem>> {
        let mut items = Vec::with_capacity(batch_size);
        while items.len() < batch_size {
            let Some(item) = self.next_item()? else {
                break;
            };
            items.push(item);
        }
        Ok(items)
    }

    fn next_item(&mut self) -> AppResult<Option<ImportItem>> {
        match self {
            Self::Csv {
                reader,
                headers,
                source_line,
            } => {
                let mut record = csv::StringRecord::new();
                if !reader
                    .read_record(&mut record)
                    .map_err(|error| AppError::Config(format!("CSV row is invalid: {error}")))?
                {
                    return Ok(None);
                }
                *source_line += 1;
                let values = headers
                    .iter()
                    .enumerate()
                    .map(|(index, header)| {
                        (
                            header.clone(),
                            record
                                .get(index)
                                .map(|value| Value::String(value.to_owned()))
                                .unwrap_or(Value::Null),
                        )
                    })
                    .collect::<BTreeMap<_, _>>();
                Ok(Some(ImportItem::Data(ImportDataRow {
                    source_line: *source_line,
                    raw: Value::Object(values.clone().into_iter().collect()),
                    values,
                })))
            }
            Self::Ndjson {
                reader,
                buffer,
                source_line,
                bytes_read,
            } => loop {
                buffer.clear();
                let read = read_line_bounded(reader, buffer, MAX_STREAM_RECORD_BYTES)?;
                if read == 0 {
                    return Ok(None);
                }
                *bytes_read = bytes_read.saturating_add(read as u64);
                *source_line += 1;
                if buffer.iter().all(u8::is_ascii_whitespace) {
                    continue;
                }
                let raw: Value = serde_json::from_slice(buffer).map_err(|error| {
                    AppError::Config(format!("NDJSON line {source_line} is invalid: {error}"))
                })?;
                return object_item(*source_line, raw).map(Some);
            },
            Self::Json { rows, source_line } => {
                let Some(raw) = rows.pop_front() else {
                    return Ok(None);
                };
                *source_line += 1;
                object_item(*source_line, raw).map(Some)
            }
            Self::Sql {
                statements,
                source_line,
            } => {
                let Some(statement) = statements.pop_front() else {
                    return Ok(None);
                };
                *source_line += 1;
                Ok(Some(ImportItem::Sql {
                    source_line: *source_line,
                    statement,
                }))
            }
            Self::Xlsx {
                headers,
                rows,
                source_line,
            } => {
                let Some(row) = rows.pop_front() else {
                    return Ok(None);
                };
                *source_line += 1;
                let values = headers
                    .iter()
                    .enumerate()
                    .map(|(index, header)| {
                        (
                            header.clone(),
                            row.get(index).cloned().unwrap_or(Value::Null),
                        )
                    })
                    .collect::<BTreeMap<_, _>>();
                Ok(Some(ImportItem::Data(ImportDataRow {
                    source_line: *source_line,
                    raw: Value::Object(values.clone().into_iter().collect()),
                    values,
                })))
            }
        }
    }

    pub(in crate::features::jobs) fn bytes_consumed(&self) -> Option<u64> {
        match self {
            Self::Csv { reader, .. } => Some(reader.position().byte()),
            Self::Ndjson { bytes_read, .. } => Some(*bytes_read),
            Self::Json { .. } | Self::Sql { .. } | Self::Xlsx { .. } => None,
        }
    }

    pub(super) fn declared_fields(&self) -> Vec<String> {
        match self {
            Self::Csv { headers, .. } | Self::Xlsx { headers, .. } => headers.clone(),
            Self::Json { rows, .. } => rows
                .front()
                .and_then(Value::as_object)
                .map(|row| row.keys().cloned().collect())
                .unwrap_or_default(),
            Self::Ndjson { .. } | Self::Sql { .. } => Vec::new(),
        }
    }

    pub(super) fn item_count(&self) -> Option<u64> {
        match self {
            Self::Json { rows, .. } => u64::try_from(rows.len()).ok(),
            Self::Sql { statements, .. } => u64::try_from(statements.len()).ok(),
            Self::Xlsx { rows, .. } => u64::try_from(rows.len()).ok(),
            Self::Csv { .. } | Self::Ndjson { .. } => None,
        }
    }
}
