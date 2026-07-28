//! Local bounded file format adapter for the Job Engine.
//!
//! CSV/TSV/NDJSON and SQL are streamed. JSON arrays and XLSX use bounded document
//! models. Writer state, value encoding, import readers, inspection, and file
//! hardening remain separate internal responsibilities.

mod export;
mod import;
mod inspection;
mod io;
mod values;

pub(in crate::features::jobs) use export::ExportSink;
pub(in crate::features::jobs) use import::{ImportDataRow, ImportItem, ImportSource};
pub(in crate::features::jobs) use inspection::{inspect_input_verified, review_input_verified};
pub(in crate::features::jobs) use io::{
    create_error_writer, file_sha256, finalize_error_writer, write_error_row,
};
pub(in crate::features::jobs) use values::typed_sql_literal;

const XLSX_MAX_ROWS: u32 = 1_048_576;
const MAX_DOCUMENT_INPUT_BYTES: u64 = 512 * 1024 * 1024;
const MAX_XLSX_ENTRIES: usize = 10_000;
const MAX_STREAM_RECORD_BYTES: usize = 8 * 1024 * 1024;
const MAX_ERROR_ROW_BYTES: usize = 64 * 1024;
const MAX_ERROR_MESSAGE_CHARS: usize = 1_000;
const MAX_ERROR_ROW_PREVIEW_CHARS: usize = 4_096;
