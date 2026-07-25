//! Local bounded file format adapter for the Job Engine.
//!
//! CSV/TSV/NDJSON and SQL are streamed. JSON arrays and XLSX use their format
//! libraries' bounded/document models; callers surface that these formats cannot
//! resume after interruption. Gzip streams are finalized explicitly.

use std::collections::{BTreeMap, VecDeque};
use std::fs::{File, OpenOptions};
use std::io::{BufRead, BufReader, BufWriter, Cursor, Read, Seek, SeekFrom, Write};
use std::path::Path;

use calamine::{open_workbook_auto_from_rs, Data, Reader};
use flate2::read::GzDecoder;
use flate2::write::GzEncoder;
use flate2::Compression;
use rust_xlsxwriter::Workbook;
use serde_json::Value;
use sha2::{Digest, Sha256};

use crate::error::{AppError, AppResult};
use crate::features::jobs::{JobFormat, JobInputInspection};
use crate::model::QueryKind;
use dopedb_protocol::NormalizedTypeFamily;

use super::super::ports::{InputReview, SqlImportAudit};

const XLSX_MAX_ROWS: u32 = 1_048_576;
const MAX_DOCUMENT_INPUT_BYTES: u64 = 512 * 1024 * 1024;
const MAX_XLSX_ENTRIES: usize = 10_000;
const MAX_STREAM_RECORD_BYTES: usize = 8 * 1024 * 1024;
const MAX_ERROR_ROW_BYTES: usize = 64 * 1024;
const MAX_ERROR_MESSAGE_CHARS: usize = 1_000;
const MAX_ERROR_ROW_PREVIEW_CHARS: usize = 4_096;

enum TextWriterInner {
    Plain(BufWriter<File>),
    Gzip(Box<GzEncoder<BufWriter<File>>>),
}

pub(in crate::features::jobs) struct TextWriter {
    inner: TextWriterInner,
    hasher: Sha256,
}

impl Write for TextWriter {
    fn write(&mut self, buf: &[u8]) -> std::io::Result<usize> {
        let written = match &mut self.inner {
            TextWriterInner::Plain(writer) => writer.write(buf),
            TextWriterInner::Gzip(writer) => writer.write(buf),
        }?;
        self.hasher.update(&buf[..written]);
        Ok(written)
    }

    fn flush(&mut self) -> std::io::Result<()> {
        match &mut self.inner {
            TextWriterInner::Plain(writer) => writer.flush(),
            TextWriterInner::Gzip(writer) => writer.flush(),
        }
    }
}

impl TextWriter {
    fn fingerprint(&self) -> String {
        hex::encode(self.hasher.clone().finalize())
    }

    fn finish(self) -> AppResult<()> {
        match self.inner {
            TextWriterInner::Plain(mut writer) => {
                writer.flush()?;
                writer.get_ref().sync_all()?;
            }
            TextWriterInner::Gzip(writer) => {
                let mut writer = (*writer).finish()?;
                writer.flush()?;
                writer.get_ref().sync_all()?;
            }
        }
        Ok(())
    }
}

pub(in crate::features::jobs) enum ExportSink {
    Text {
        writer: TextWriter,
        format: JobFormat,
        columns: Vec<String>,
        type_families: Vec<NormalizedTypeFamily>,
        table_sql: String,
        engine: crate::model::Engine,
        rows_written: u64,
    },
    Xlsx {
        workbook: Box<Workbook>,
        file: File,
        columns: Vec<String>,
        sheet_index: usize,
        row: u32,
        rows_written: u64,
    },
}

impl ExportSink {
    pub(in crate::features::jobs) fn open(
        path: &Path,
        format: JobFormat,
        columns: Vec<String>,
        type_families: Vec<NormalizedTypeFamily>,
        table_sql: String,
        engine: crate::model::Engine,
        resume_rows: u64,
    ) -> AppResult<Self> {
        if resume_rows > 0 && !format.resumable() {
            return Err(AppError::Blocked {
                reason: "this export format cannot resume; start a new job".into(),
            });
        }
        if format == JobFormat::Xlsx {
            if resume_rows > 0 {
                return Err(AppError::Blocked {
                    reason: "XLSX export cannot resume; start a new job".into(),
                });
            }
            let mut workbook = Workbook::new();
            workbook.add_worksheet_with_constant_memory();
            let file = open_output_file(path, false, false)?;
            let mut sink = Self::Xlsx {
                workbook: Box::new(workbook),
                file,
                columns,
                sheet_index: 0,
                row: 0,
                rows_written: 0,
            };
            sink.ensure_xlsx_header()?;
            return Ok(sink);
        }

        let append = resume_rows > 0 && format.resumable();
        let mut hasher = Sha256::new();
        let mut file = open_output_file(path, append, false)?;
        if append {
            let mut buffer = [0_u8; 64 * 1024];
            loop {
                let read = file.read(&mut buffer)?;
                if read == 0 {
                    break;
                }
                hasher.update(&buffer[..read]);
            }
            file.seek(SeekFrom::End(0))?;
        }
        let buffered = BufWriter::new(file);
        let inner = if format.compressed() {
            if append {
                return Err(AppError::Blocked {
                    reason: "compressed exports cannot resume; start a new job".into(),
                });
            }
            TextWriterInner::Gzip(Box::new(GzEncoder::new(buffered, Compression::default())))
        } else {
            TextWriterInner::Plain(buffered)
        };
        let writer = TextWriter { inner, hasher };
        let mut sink = Self::Text {
            writer,
            format: format.base(),
            columns,
            type_families,
            table_sql,
            engine,
            rows_written: resume_rows,
        };
        sink.ensure_text_header()?;
        Ok(sink)
    }

    fn ensure_text_header(&mut self) -> AppResult<()> {
        let Self::Text {
            writer,
            format,
            columns,
            rows_written,
            ..
        } = self
        else {
            return Ok(());
        };
        if *rows_written > 0 {
            return Ok(());
        }
        match format {
            JobFormat::Csv => write_delimited_row(writer, columns, b',')?,
            JobFormat::Tsv => write_delimited_row(writer, columns, b'\t')?,
            JobFormat::Json => writer.write_all(b"[")?,
            JobFormat::Ndjson | JobFormat::Sql => {}
            _ => return Err(AppError::Config("unsupported text export format".into())),
        }
        Ok(())
    }

    fn ensure_xlsx_header(&mut self) -> AppResult<()> {
        let Self::Xlsx {
            workbook,
            columns,
            sheet_index,
            row,
            ..
        } = self
        else {
            return Ok(());
        };
        let worksheet = workbook
            .worksheet_from_index(*sheet_index)
            .map_err(xlsx_error)?;
        for (column, value) in columns.iter().enumerate() {
            worksheet
                .write_string(*row, column as u16, value)
                .map_err(xlsx_error)?;
        }
        *row += 1;
        Ok(())
    }

    pub(in crate::features::jobs) fn write_rows(&mut self, rows: &[Vec<Value>]) -> AppResult<()> {
        match self {
            Self::Text {
                writer,
                format,
                columns,
                type_families,
                table_sql,
                engine,
                rows_written,
            } => {
                for values in rows {
                    match format {
                        JobFormat::Csv => {
                            write_delimited_values(writer, values, b',')?;
                        }
                        JobFormat::Tsv => {
                            write_delimited_values(writer, values, b'\t')?;
                        }
                        JobFormat::Json => {
                            if *rows_written > 0 {
                                writer.write_all(b",")?;
                            }
                            serde_json::to_writer(&mut *writer, &row_object(columns, values))?;
                        }
                        JobFormat::Ndjson => {
                            serde_json::to_writer(&mut *writer, &row_object(columns, values))?;
                            writer.write_all(b"\n")?;
                        }
                        JobFormat::Sql => {
                            write_insert(
                                writer,
                                *engine,
                                table_sql,
                                columns,
                                type_families,
                                values,
                            )?;
                        }
                        _ => {
                            return Err(AppError::Config("unsupported export writer format".into()))
                        }
                    }
                    *rows_written += 1;
                }
                writer.flush()?;
            }
            Self::Xlsx {
                workbook,
                columns,
                sheet_index,
                row,
                rows_written,
                ..
            } => {
                for values in rows {
                    if *row >= XLSX_MAX_ROWS {
                        workbook.add_worksheet_with_constant_memory();
                        *sheet_index += 1;
                        *row = 0;
                        let worksheet = workbook
                            .worksheet_from_index(*sheet_index)
                            .map_err(xlsx_error)?;
                        for (column, value) in columns.iter().enumerate() {
                            worksheet
                                .write_string(*row, column as u16, value)
                                .map_err(xlsx_error)?;
                        }
                        *row += 1;
                    }
                    let worksheet = workbook
                        .worksheet_from_index(*sheet_index)
                        .map_err(xlsx_error)?;
                    for (column, value) in values.iter().enumerate() {
                        write_xlsx_value(worksheet, *row, column as u16, value)?;
                    }
                    *row += 1;
                    *rows_written += 1;
                }
            }
        }
        Ok(())
    }

    pub(in crate::features::jobs) fn rows_written(&self) -> u64 {
        match self {
            Self::Text { rows_written, .. } | Self::Xlsx { rows_written, .. } => *rows_written,
        }
    }

    pub(in crate::features::jobs) fn fingerprint(&self) -> Option<String> {
        match self {
            Self::Text { writer, .. } => Some(writer.fingerprint()),
            Self::Xlsx { .. } => None,
        }
    }

    pub(in crate::features::jobs) fn flush(&mut self) -> AppResult<()> {
        if let Self::Text { writer, .. } = self {
            writer.flush()?;
        }
        Ok(())
    }

    pub(in crate::features::jobs) fn finish(mut self) -> AppResult<()> {
        match &mut self {
            Self::Text {
                writer,
                format: JobFormat::Json,
                ..
            } => writer.write_all(b"]")?,
            Self::Text { .. } | Self::Xlsx { .. } => {}
        }
        match self {
            Self::Text { writer, .. } => writer.finish(),
            Self::Xlsx {
                mut workbook,
                mut file,
                ..
            } => {
                workbook.save_to_writer(&mut file).map_err(xlsx_error)?;
                file.flush()?;
                file.sync_all()?;
                Ok(())
            }
        }
    }
}

fn row_object(columns: &[String], values: &[Value]) -> Value {
    Value::Object(
        columns
            .iter()
            .enumerate()
            .map(|(index, column)| {
                (
                    column.clone(),
                    values.get(index).cloned().unwrap_or(Value::Null),
                )
            })
            .collect(),
    )
}

fn write_delimited_row(writer: &mut impl Write, values: &[String], delimiter: u8) -> AppResult<()> {
    let values = values
        .iter()
        .map(|value| Value::String(value.clone()))
        .collect::<Vec<_>>();
    write_delimited_values(writer, &values, delimiter)
}

fn write_delimited_values(
    writer: &mut impl Write,
    values: &[Value],
    delimiter: u8,
) -> AppResult<()> {
    for (index, value) in values.iter().enumerate() {
        if index > 0 {
            writer.write_all(&[delimiter])?;
        }
        let value = scalar_text(value);
        let needs_quote = value
            .bytes()
            .any(|byte| byte == delimiter || matches!(byte, b'"' | b'\r' | b'\n'));
        if needs_quote {
            writer.write_all(b"\"")?;
            writer.write_all(value.replace('"', "\"\"").as_bytes())?;
            writer.write_all(b"\"")?;
        } else {
            writer.write_all(value.as_bytes())?;
        }
    }
    writer.write_all(b"\n")?;
    Ok(())
}

fn write_insert(
    writer: &mut impl Write,
    engine: crate::model::Engine,
    table_sql: &str,
    columns: &[String],
    type_families: &[NormalizedTypeFamily],
    values: &[Value],
) -> AppResult<()> {
    let columns = columns
        .iter()
        .map(|column| quote_identifier(engine, column))
        .collect::<Vec<_>>()
        .join(", ");
    let values = values
        .iter()
        .enumerate()
        .map(|(index, value)| {
            typed_sql_literal(
                engine,
                type_families
                    .get(index)
                    .copied()
                    .unwrap_or(NormalizedTypeFamily::Other),
                value,
            )
            .map_err(AppError::Config)
        })
        .collect::<AppResult<Vec<_>>>()?
        .join(", ");
    writeln!(
        writer,
        "INSERT INTO {table_sql} ({columns}) VALUES ({values});"
    )?;
    Ok(())
}

fn quote_identifier(engine: crate::model::Engine, value: &str) -> String {
    if engine == crate::model::Engine::Mysql {
        format!("`{}`", value.replace('`', "``"))
    } else {
        format!("\"{}\"", value.replace('"', "\"\""))
    }
}

pub(in crate::features::jobs) fn typed_sql_literal(
    engine: crate::model::Engine,
    family: NormalizedTypeFamily,
    value: &Value,
) -> Result<String, String> {
    if value.is_null() {
        return Ok("NULL".into());
    }
    match family {
        NormalizedTypeFamily::Boolean => match value {
            Value::Bool(value) => Ok(if *value { "TRUE" } else { "FALSE" }.into()),
            Value::Number(value) if value.as_i64() == Some(1) => Ok("TRUE".into()),
            Value::Number(value) if value.as_i64() == Some(0) => Ok("FALSE".into()),
            Value::String(value) => match value.trim().to_ascii_lowercase().as_str() {
                "true" | "t" | "1" | "yes" | "y" => Ok("TRUE".into()),
                "false" | "f" | "0" | "no" | "n" => Ok("FALSE".into()),
                _ => Err("boolean value must be true/false or 1/0".into()),
            },
            _ => Err("boolean value has an unsupported shape".into()),
        },
        NormalizedTypeFamily::Integer
        | NormalizedTypeFamily::Decimal
        | NormalizedTypeFamily::Float => match value {
            Value::Number(value) => Ok(value.to_string()),
            Value::String(value) => Ok(quoted_text(engine, value)),
            _ => Err("numeric value must be a number or numeric string".into()),
        },
        NormalizedTypeFamily::Binary => {
            let Value::String(value) = value else {
                return Err("binary value must be a hexadecimal string".into());
            };
            let hex = value
                .strip_prefix("\\x")
                .or_else(|| value.strip_prefix("0x"))
                .ok_or_else(|| "binary value must use a \\\\x hexadecimal prefix".to_owned())?;
            if hex.len() % 2 != 0 || hex::decode(hex).is_err() {
                return Err("binary value contains invalid hexadecimal data".into());
            }
            Ok(if engine == crate::model::Engine::Postgres {
                format!("decode('{hex}', 'hex')")
            } else {
                format!("X'{hex}'")
            })
        }
        NormalizedTypeFamily::Array if engine == crate::model::Engine::Postgres => {
            let Value::Array(values) = value else {
                return Ok(quoted_value(engine, value));
            };
            let values = values
                .iter()
                .map(|value| {
                    if let Value::Array(_) = value {
                        typed_sql_literal(engine, NormalizedTypeFamily::Array, value)
                    } else {
                        typed_sql_literal(engine, NormalizedTypeFamily::Other, value)
                    }
                })
                .collect::<Result<Vec<_>, _>>()?;
            Ok(format!("ARRAY[{}]", values.join(", ")))
        }
        NormalizedTypeFamily::Json
        | NormalizedTypeFamily::Array
        | NormalizedTypeFamily::Document => Ok(quoted_value(engine, value)),
        NormalizedTypeFamily::Text
        | NormalizedTypeFamily::Date
        | NormalizedTypeFamily::Time
        | NormalizedTypeFamily::Timestamp
        | NormalizedTypeFamily::Uuid => Ok(quoted_value(engine, value)),
        NormalizedTypeFamily::Other => match value {
            Value::Bool(value) => Ok(if *value { "TRUE" } else { "FALSE" }.into()),
            Value::Number(value) => Ok(value.to_string()),
            Value::String(value) => Ok(quoted_text(engine, value)),
            Value::Array(_) | Value::Object(_) => Ok(quoted_text(engine, &value.to_string())),
            Value::Null => unreachable!(),
        },
    }
}

fn quoted_value(engine: crate::model::Engine, value: &Value) -> String {
    match value {
        Value::String(value) => quoted_text(engine, value),
        value => quoted_text(engine, &value.to_string()),
    }
}

fn quoted_text(engine: crate::model::Engine, value: &str) -> String {
    let escaped = if engine == crate::model::Engine::Mysql {
        value.replace('\\', "\\\\").replace('\'', "''")
    } else {
        value.replace('\'', "''")
    };
    format!("'{escaped}'")
}

fn scalar_text(value: &Value) -> String {
    match value {
        Value::Null => String::new(),
        Value::String(value) => value.clone(),
        Value::Bool(_) | Value::Number(_) => value.to_string(),
        Value::Array(_) | Value::Object(_) => value.to_string(),
    }
}

fn write_xlsx_value(
    worksheet: &mut rust_xlsxwriter::Worksheet,
    row: u32,
    column: u16,
    value: &Value,
) -> AppResult<()> {
    match value {
        Value::Null => {}
        Value::Bool(value) => {
            worksheet
                .write_boolean(row, column, *value)
                .map_err(xlsx_error)?;
        }
        Value::Number(value) => {
            if let Some(value) = value.as_f64() {
                worksheet
                    .write_number(row, column, value)
                    .map_err(xlsx_error)?;
            } else {
                worksheet
                    .write_string(row, column, value.to_string())
                    .map_err(xlsx_error)?;
            }
        }
        Value::String(value) => {
            worksheet
                .write_string(row, column, value)
                .map_err(xlsx_error)?;
        }
        Value::Array(_) | Value::Object(_) => {
            worksheet
                .write_string(row, column, value.to_string())
                .map_err(xlsx_error)?;
        }
    }
    Ok(())
}

fn xlsx_error(error: rust_xlsxwriter::XlsxError) -> AppError {
    AppError::Config(format!("XLSX writer failed: {error}"))
}

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
    #[cfg(test)]
    pub(in crate::features::jobs) fn open(
        path: &Path,
        format: JobFormat,
        resume_rows: u64,
        engine: crate::model::Engine,
    ) -> AppResult<Self> {
        if resume_rows > 0 && !format.resumable() {
            return Err(AppError::Blocked {
                reason: "this import format cannot resume; start a new job".into(),
            });
        }
        let file = open_regular_input(path)?;
        Self::open_file(file, format, resume_rows, engine)
    }

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

    fn declared_fields(&self) -> Vec<String> {
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

    fn item_count(&self) -> Option<u64> {
        match self {
            Self::Json { rows, .. } => u64::try_from(rows.len()).ok(),
            Self::Sql { statements, .. } => u64::try_from(statements.len()).ok(),
            Self::Xlsx { rows, .. } => u64::try_from(rows.len()).ok(),
            Self::Csv { .. } | Self::Ndjson { .. } => None,
        }
    }
}

#[cfg(test)]
pub(in crate::features::jobs) fn inspect_input(
    path: &Path,
    format: JobFormat,
    engine: crate::model::Engine,
) -> AppResult<JobInputInspection> {
    let mut source = ImportSource::open(path, format, 0, engine)?;
    inspect_source(&mut source, format)
}

pub(in crate::features::jobs) fn inspect_input_verified(
    path: &Path,
    format: JobFormat,
    engine: crate::model::Engine,
    expected_sha256: &str,
) -> AppResult<JobInputInspection> {
    let (mut source, _) = ImportSource::open_verified(path, format, 0, engine, expected_sha256)?;
    inspect_source(&mut source, format)
}

fn inspect_source(source: &mut ImportSource, format: JobFormat) -> AppResult<JobInputInspection> {
    let item_count = source.item_count();
    let mut fields = source.declared_fields();
    // SQL has no row preview. Keeping its statement stream untouched lets the
    // exact inspection and safety audit share one verified file handle.
    let sample_items = if format.base() == JobFormat::Sql {
        Vec::new()
    } else {
        source.next_batch(5)?
    };
    if fields.is_empty() && format.base() != JobFormat::Sql {
        for item in &sample_items {
            if let ImportItem::Data(row) = item {
                fields.extend(row.values.keys().cloned());
            }
        }
    }
    fields.sort();
    fields.dedup();
    let mut warnings = Vec::new();
    let resumable = format.resumable() && format.base() != JobFormat::Sql;
    if !resumable {
        warnings.push(
            "This format cannot resume after interruption; cancellation keeps no restart point."
                .into(),
        );
    }
    if format.base() == JobFormat::Sql {
        warnings.push(
            "SQL import executes an exact hash-pinned script and always requires critical approval."
                .into(),
        );
    }
    Ok(JobInputInspection {
        fields,
        item_count,
        sample_rows: sample_items
            .into_iter()
            .filter_map(|item| match item {
                ImportItem::Data(row) => Some(bounded_preview(row.raw, 0)),
                ImportItem::Sql { .. } => None,
            })
            .collect(),
        resumable,
        warnings,
    })
}

fn bounded_preview(value: Value, depth: usize) -> Value {
    if depth >= 4 {
        return Value::String("<nested value>".into());
    }
    match value {
        Value::String(value) => Value::String(value.chars().take(512).collect()),
        Value::Array(values) => Value::Array(
            values
                .into_iter()
                .take(16)
                .map(|value| bounded_preview(value, depth + 1))
                .collect(),
        ),
        Value::Object(values) => Value::Object(
            values
                .into_iter()
                .take(64)
                .map(|(key, value)| (key, bounded_preview(value, depth + 1)))
                .collect(),
        ),
        value => value,
    }
}

pub(in crate::features::jobs) fn review_input_verified(
    path: &Path,
    format: JobFormat,
    engine: crate::model::Engine,
    expected_sha256: &str,
) -> AppResult<InputReview> {
    let (mut source, _) = ImportSource::open_verified(path, format, 0, engine, expected_sha256)?;
    let inspection = inspect_source(&mut source, format)?;
    let sql_audit = if format.base() == JobFormat::Sql {
        Some(audit_sql_source(source, engine)?)
    } else {
        None
    };
    Ok(InputReview {
        inspection,
        sql_audit,
    })
}

#[cfg(test)]
pub(in crate::features::jobs) fn audit_sql_import(
    path: &Path,
    format: JobFormat,
    engine: crate::model::Engine,
) -> AppResult<SqlImportAudit> {
    let source = ImportSource::open(path, format, 0, engine)?;
    audit_sql_source(source, engine)
}

fn audit_sql_source(
    source: ImportSource,
    engine: crate::model::Engine,
) -> AppResult<SqlImportAudit> {
    let ImportSource::Sql { statements, .. } = source else {
        return Err(AppError::Config(
            "SQL import audit requires a SQL file format".into(),
        ));
    };
    if statements.is_empty() {
        return Err(AppError::Config(
            "SQL import contains no executable statements".into(),
        ));
    }
    let mut audit = SqlImportAudit {
        statement_count: statements.len() as u64,
        read_count: 0,
        write_count: 0,
        ddl_count: 0,
    };
    for statement in statements {
        match crate::safety::classify(&statement, engine)?.kind {
            QueryKind::Read => audit.read_count += 1,
            QueryKind::Write => audit.write_count += 1,
            QueryKind::Ddl => audit.ddl_count += 1,
            QueryKind::Privilege => {
                return Err(AppError::Blocked {
                    reason:
                        "SQL imports cannot contain arbitrary privilege statements; use a supported administrative action"
                            .into(),
                })
            }
        }
    }
    Ok(audit)
}

fn validate_xlsx_archive(bytes: &[u8]) -> AppResult<()> {
    let mut archive = zip::ZipArchive::new(Cursor::new(bytes))
        .map_err(|error| AppError::Config(format!("XLSX archive is invalid: {error}")))?;
    if archive.len() > MAX_XLSX_ENTRIES {
        return Err(AppError::Blocked {
            reason: "XLSX archive contains too many entries".into(),
        });
    }
    let mut expanded = 0_u64;
    for index in 0..archive.len() {
        let entry = archive
            .by_index(index)
            .map_err(|error| AppError::Config(format!("XLSX archive is invalid: {error}")))?;
        if entry.enclosed_name().is_none() {
            return Err(AppError::Blocked {
                reason: "XLSX archive contains an unsafe path".into(),
            });
        }
        expanded = expanded
            .checked_add(entry.size())
            .ok_or_else(|| AppError::Blocked {
                reason: "XLSX expanded size is invalid".into(),
            })?;
        if expanded > MAX_DOCUMENT_INPUT_BYTES {
            return Err(AppError::Blocked {
                reason: "XLSX expanded content exceeds the 512 MiB safety limit".into(),
            });
        }
    }
    Ok(())
}

struct BoundedCsvReader<R> {
    inner: R,
    record_bytes: usize,
    in_quotes: bool,
}

impl<R> BoundedCsvReader<R> {
    fn new(inner: R) -> Self {
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

fn read_line_bounded<R: BufRead>(
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

fn open_reader(file: File, format: JobFormat) -> Box<dyn Read + Send> {
    if format.compressed() {
        Box::new(GzDecoder::new(file))
    } else {
        Box::new(file)
    }
}

fn open_regular_input(path: &Path) -> AppResult<File> {
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

fn open_output_file(path: &Path, append: bool, private: bool) -> AppResult<File> {
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

fn file_sha256_handle(file: &mut File) -> AppResult<String> {
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

fn read_bounded_document(mut reader: Box<dyn Read + Send>) -> AppResult<Vec<u8>> {
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

fn object_item(source_line: u64, raw: Value) -> AppResult<ImportItem> {
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

fn calamine_text(value: &Data) -> String {
    match value {
        Data::String(value) => value.clone(),
        _ => value.to_string(),
    }
}

fn calamine_value(value: &Data) -> Value {
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

#[cfg(test)]
mod tests {
    use super::*;
    use crate::model::Engine;
    use flate2::read::GzDecoder;

    fn families() -> Vec<NormalizedTypeFamily> {
        vec![NormalizedTypeFamily::Integer, NormalizedTypeFamily::Text]
    }

    #[test]
    fn json_export_resume_preserves_exact_partial_fingerprint() {
        let directory = tempfile::tempdir().unwrap();
        let path = directory.path().join("rows.json.part");
        let mut sink = ExportSink::open(
            &path,
            JobFormat::Json,
            vec!["id".into(), "name".into()],
            families(),
            "\"rows\"".into(),
            Engine::Sqlite,
            0,
        )
        .unwrap();
        sink.write_rows(&[
            vec![Value::from(1), Value::from("alpha")],
            vec![Value::from(2), Value::from("beta")],
        ])
        .unwrap();
        sink.flush().unwrap();
        let checkpoint = sink.fingerprint().unwrap();
        drop(sink);

        let mut resumed = ExportSink::open(
            &path,
            JobFormat::Json,
            vec!["id".into(), "name".into()],
            families(),
            "\"rows\"".into(),
            Engine::Sqlite,
            2,
        )
        .unwrap();
        assert_eq!(resumed.fingerprint().as_deref(), Some(checkpoint.as_str()));
        resumed
            .write_rows(&[vec![Value::from(3), Value::from("gamma")]])
            .unwrap();
        resumed.finish().unwrap();

        let rows: Value = serde_json::from_slice(&std::fs::read(path).unwrap()).unwrap();
        assert_eq!(rows.as_array().unwrap().len(), 3);
        assert_eq!(rows[2]["name"], "gamma");
    }

    #[test]
    fn csv_and_gzip_exports_quote_and_finalize_cleanly() {
        let directory = tempfile::tempdir().unwrap();
        let csv_path = directory.path().join("rows.csv");
        let rows = [vec![Value::from(7), Value::from("comma,\nquote\"")]];
        let mut csv = ExportSink::open(
            &csv_path,
            JobFormat::Csv,
            vec!["id".into(), "value".into()],
            families(),
            "\"rows\"".into(),
            Engine::Sqlite,
            0,
        )
        .unwrap();
        csv.write_rows(&rows).unwrap();
        csv.finish().unwrap();
        let mut parsed = csv::Reader::from_path(csv_path).unwrap();
        assert_eq!(
            parsed.records().next().unwrap().unwrap().get(1),
            Some("comma,\nquote\"")
        );

        let gzip_path = directory.path().join("rows.csv.gz");
        let mut gzip = ExportSink::open(
            &gzip_path,
            JobFormat::CsvGzip,
            vec!["id".into(), "value".into()],
            families(),
            "\"rows\"".into(),
            Engine::Sqlite,
            0,
        )
        .unwrap();
        gzip.write_rows(&rows).unwrap();
        gzip.finish().unwrap();
        let mut decoded = String::new();
        GzDecoder::new(File::open(gzip_path).unwrap())
            .read_to_string(&mut decoded)
            .unwrap();
        assert!(decoded.contains("\"comma,"));

        assert!(ExportSink::open(
            &directory.path().join("resume.csv.gz"),
            JobFormat::CsvGzip,
            vec!["id".into()],
            vec![NormalizedTypeFamily::Integer],
            "\"rows\"".into(),
            Engine::Sqlite,
            1,
        )
        .is_err());
    }

    #[test]
    fn ndjson_and_sql_streams_round_trip_without_loading_the_export() {
        let directory = tempfile::tempdir().unwrap();
        let rows = [
            vec![Value::from(1), Value::from("alpha")],
            vec![Value::from(2), Value::from("beta")],
        ];

        let ndjson_path = directory.path().join("rows.ndjson");
        let mut ndjson = ExportSink::open(
            &ndjson_path,
            JobFormat::Ndjson,
            vec!["id".into(), "name".into()],
            families(),
            "\"rows\"".into(),
            Engine::Sqlite,
            0,
        )
        .unwrap();
        ndjson.write_rows(&rows).unwrap();
        ndjson.finish().unwrap();
        let mut source =
            ImportSource::open(&ndjson_path, JobFormat::Ndjson, 0, Engine::Sqlite).unwrap();
        let imported = source.next_batch(10).unwrap();
        assert_eq!(imported.len(), 2);
        let ImportItem::Data(first) = &imported[0] else {
            panic!("NDJSON row must remain structured data");
        };
        assert_eq!(first.values["name"], "alpha");

        let sql_path = directory.path().join("rows.sql");
        let mut sql = ExportSink::open(
            &sql_path,
            JobFormat::Sql,
            vec!["id".into(), "name".into()],
            families(),
            "\"rows\"".into(),
            Engine::Sqlite,
            0,
        )
        .unwrap();
        sql.write_rows(&rows).unwrap();
        sql.finish().unwrap();
        let audit = audit_sql_import(&sql_path, JobFormat::Sql, Engine::Sqlite).unwrap();
        assert_eq!(audit.statement_count, 2);
        assert_eq!(audit.write_count, 2);
    }

    #[test]
    fn xlsx_export_import_round_trip_is_explicitly_non_resumable() {
        let directory = tempfile::tempdir().unwrap();
        let path = directory.path().join("rows.xlsx");
        let mut sink = ExportSink::open(
            &path,
            JobFormat::Xlsx,
            vec!["id".into(), "name".into()],
            families(),
            "\"rows\"".into(),
            Engine::Sqlite,
            0,
        )
        .unwrap();
        sink.write_rows(&[
            vec![Value::from(7), Value::from("xlsx")],
            vec![Value::from(8), Value::Null],
        ])
        .unwrap();
        sink.finish().unwrap();

        let inspection = inspect_input(&path, JobFormat::Xlsx, Engine::Sqlite).unwrap();
        assert_eq!(inspection.fields, vec!["id", "name"]);
        assert_eq!(inspection.item_count, Some(2));
        assert!(!inspection.resumable);
        assert!(ImportSource::open(&path, JobFormat::Xlsx, 1, Engine::Sqlite).is_err());

        let mut source = ImportSource::open(&path, JobFormat::Xlsx, 0, Engine::Sqlite).unwrap();
        let imported = source.next_batch(10).unwrap();
        let ImportItem::Data(first) = &imported[0] else {
            panic!("XLSX row must remain structured data");
        };
        assert_eq!(first.values["id"], 7.0);
        assert_eq!(first.values["name"], "xlsx");
    }

    #[test]
    fn typed_literals_preserve_decimal_date_boolean_and_binary_values() {
        assert_eq!(
            typed_sql_literal(
                Engine::Postgres,
                NormalizedTypeFamily::Decimal,
                &Value::from("12345678901234567890.123400"),
            )
            .unwrap(),
            "'12345678901234567890.123400'"
        );
        assert_eq!(
            typed_sql_literal(
                Engine::Sqlite,
                NormalizedTypeFamily::Date,
                &Value::from("2026-07-25"),
            )
            .unwrap(),
            "'2026-07-25'"
        );
        assert_eq!(
            typed_sql_literal(
                Engine::Mysql,
                NormalizedTypeFamily::Boolean,
                &Value::from("1"),
            )
            .unwrap(),
            "TRUE"
        );
        assert_eq!(
            typed_sql_literal(
                Engine::Postgres,
                NormalizedTypeFamily::Binary,
                &Value::from("\\x00ff10"),
            )
            .unwrap(),
            "decode('00ff10', 'hex')"
        );
        assert_eq!(
            typed_sql_literal(
                Engine::Mysql,
                NormalizedTypeFamily::Binary,
                &Value::from("\\x00ff10"),
            )
            .unwrap(),
            "X'00ff10'"
        );
    }

    #[test]
    fn input_inspection_returns_bounded_samples_without_paths() {
        let directory = tempfile::tempdir().unwrap();
        let path = directory.path().join("rows.ndjson");
        std::fs::write(
            &path,
            "{\"id\":1,\"name\":\"alpha\"}\n{\"id\":2,\"name\":\"beta\"}\n",
        )
        .unwrap();
        let inspection = inspect_input(&path, JobFormat::Ndjson, Engine::Sqlite).unwrap();
        assert_eq!(inspection.fields, vec!["id", "name"]);
        assert_eq!(inspection.sample_rows.len(), 2);
        assert!(inspection.resumable);
    }

    #[test]
    fn sql_import_audit_blocks_privilege_statements() {
        let directory = tempfile::tempdir().unwrap();
        let safe = directory.path().join("safe.sql");
        std::fs::write(&safe, "INSERT INTO items(id) VALUES (1);").unwrap();
        let audit = audit_sql_import(&safe, JobFormat::Sql, Engine::Postgres).unwrap();
        assert_eq!(audit.statement_count, 1);
        assert_eq!(audit.write_count, 1);

        let privilege = directory.path().join("privilege.sql");
        std::fs::write(&privilege, "GRANT SELECT ON items TO reader;").unwrap();
        assert!(matches!(
            audit_sql_import(&privilege, JobFormat::Sql, Engine::Postgres),
            Err(AppError::Blocked { .. })
        ));
    }

    #[test]
    fn verified_review_binds_preview_and_sql_audit_to_the_registered_hash() {
        let directory = tempfile::tempdir().unwrap();
        let path = directory.path().join("review.sql");
        std::fs::write(&path, "INSERT INTO items(id) VALUES (1);").unwrap();
        let expected = file_sha256(&path).unwrap();

        let review =
            review_input_verified(&path, JobFormat::Sql, Engine::Postgres, &expected).unwrap();
        assert_eq!(review.inspection.item_count, Some(1));
        assert_eq!(review.sql_audit.unwrap().write_count, 1);

        std::fs::write(&path, "DELETE FROM items;").unwrap();
        assert!(matches!(
            review_input_verified(&path, JobFormat::Sql, Engine::Postgres, &expected),
            Err(AppError::Blocked { .. })
        ));
    }

    #[test]
    fn error_artifact_rows_and_messages_are_bounded() {
        let directory = tempfile::tempdir().unwrap();
        let path = directory.path().join("errors.ndjson");
        let mut writer = create_error_writer(&path, false).unwrap();
        write_error_row(
            &mut writer,
            7,
            &Value::String("x".repeat(MAX_ERROR_ROW_BYTES + 1)),
            &"e".repeat(MAX_ERROR_MESSAGE_CHARS + 100),
        )
        .unwrap();
        finalize_error_writer(writer).unwrap();

        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            assert_eq!(
                std::fs::metadata(&path).unwrap().permissions().mode() & 0o777,
                0o600
            );
        }
        let artifact: Value = serde_json::from_slice(&std::fs::read(&path).unwrap()).unwrap();
        assert_eq!(artifact["row"]["truncated"], true);
        assert_eq!(
            artifact["error"].as_str().unwrap().chars().count(),
            MAX_ERROR_MESSAGE_CHARS
        );
        assert!(artifact["row"]["sha256"].as_str().unwrap().len() == 64);
    }

    #[cfg(unix)]
    #[test]
    fn input_reader_does_not_follow_symlinks() {
        use std::os::unix::fs::symlink;

        let directory = tempfile::tempdir().unwrap();
        let target = directory.path().join("target.csv");
        let link = directory.path().join("link.csv");
        std::fs::write(&target, "id\n1\n").unwrap();
        symlink(&target, &link).unwrap();
        assert!(file_sha256(&link).is_err());
    }
}
