use super::*;

#[tokio::test]
async fn streamed_sqlite_batches_are_bounded_ordered_and_truncated_without_full_retention() {
    let pool = sqlx::sqlite::SqlitePoolOptions::new()
        .max_connections(1)
        .connect("sqlite::memory:")
        .await
        .unwrap();
    let mut batches = Vec::new();
    let (columns, row_count, truncated) = stream_batched(
        sqlx::query(AssertSqlSafe(
            "WITH RECURSIVE n(value) AS (SELECT 1 UNION ALL SELECT value + 1 FROM n WHERE value < 1001) SELECT value FROM n",
        ))
        .fetch(&pool),
        1_000,
        256,
        sqlite_value,
        &mut |batch: ReadBatch| {
            assert!(batch.rows.len() <= 256);
            batches.push(batch);
            std::future::ready(Ok(()))
        },
    )
    .await
    .unwrap();
    assert_eq!(columns, vec!["value"]);
    assert_eq!(row_count, 1_000);
    assert!(truncated);
    assert_eq!(
        batches.iter().map(|batch| batch.rows.len()).sum::<usize>(),
        1_000
    );
    let values = batches
        .into_iter()
        .flat_map(|batch| batch.rows)
        .map(|row| row[0].as_i64().unwrap())
        .collect::<Vec<_>>();
    assert_eq!(values.first(), Some(&1));
    assert_eq!(values.last(), Some(&1_000));
}

#[tokio::test]
async fn streamed_sqlite_splits_an_oversized_caller_batch_request_at_256_rows() {
    let pool = sqlx::sqlite::SqlitePoolOptions::new()
        .max_connections(1)
        .connect("sqlite::memory:")
        .await
        .unwrap();
    let live = LiveConnection {
        read_pool: Pool::Sqlite(pool.clone()),
        write_pool: Pool::Sqlite(pool.clone()),
        has_writable_pool: false,
        skip_fk_metadata: false,
    };
    let mut sizes = Vec::new();
    let result = run_read_streamed_registered(
        &live,
        Engine::Sqlite,
        "WITH RECURSIVE n(value) AS (SELECT 1 UNION ALL SELECT value + 1 FROM n WHERE value < 500) SELECT value FROM n",
        500,
        500,
        None,
        &mut |batch: ReadBatch| {
            sizes.push(batch.rows.len());
            std::future::ready(Ok(()))
        },
    )
    .await
    .expect("a 500-row request must split instead of reaching the registry oversized");
    assert_eq!(result.row_count, 500);
    assert!(!result.truncated);
    assert_eq!(sizes, [256, 244]);
}

#[tokio::test]
async fn streamed_receiver_drop_stops_the_cursor_after_the_current_batch() {
    let pool = sqlx::sqlite::SqlitePoolOptions::new()
        .max_connections(1)
        .connect("sqlite::memory:")
        .await
        .unwrap();
    let mut emitted = 0_usize;
    let error = stream_batched(
        sqlx::query(AssertSqlSafe(
            "WITH RECURSIVE n(value) AS (SELECT 1 UNION ALL SELECT value + 1 FROM n WHERE value < 1000) SELECT value FROM n",
        ))
        .fetch(&pool),
        999,
        200,
        sqlite_value,
        &mut |_| {
            emitted += 1;
            std::future::ready(Err(AppError::Safety(
                "desktop query result receiver disconnected".into(),
            )))
        },
    )
    .await
    .expect_err("a dropped receiver aborts the stream instead of accumulating later batches");
    assert!(matches!(error, AppError::Safety(_)));
    assert_eq!(emitted, 1);
}

// The parent test launches this exact test binary once per measured sample. The
// child writes one small, strict JSON record to stdout; it never serializes SQL,
// decoded rows, connection details, or credentials.
const BENCHMARK_CHILD_ENV: &str = "DOPEDB_DESKTOP_STREAM_BENCH_CHILD";
const BENCHMARK_MARKER: &str = "DOPEDB_DESKTOP_STREAM_BENCH_SAMPLE:";
const BENCHMARK_SAMPLES: usize = 20;
const BENCHMARK_ROWS: [usize; 3] = [1_000, 10_000, 50_000];

#[derive(Clone, Copy, Debug, Eq, PartialEq, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "snake_case")]
enum BenchmarkMode {
    Materialized,
    Streaming,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "snake_case")]
enum BenchmarkTemperature {
    Cold,
    Warm,
}

/// This harness measures the executor batching loop only. It deliberately does
/// not claim Channel, registry pull/ACK, webview, or React interactive costs;
/// those belong to the frontend integration performance wave.
#[derive(Clone, Copy, Debug, Eq, PartialEq, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "snake_case")]
enum BenchmarkMeasurementScope {
    ExecutorOnly,
}

#[derive(Debug, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct BenchmarkChildRequest {
    mode: BenchmarkMode,
    temperature: BenchmarkTemperature,
    rows: usize,
}

#[derive(Clone, Debug, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct BenchmarkSample {
    mode: BenchmarkMode,
    temperature: BenchmarkTemperature,
    rows: usize,
    latency_ms: u64,
    peak_rss_bytes: u64,
    first_batch_ms: Option<u64>,
    max_retained_rows: usize,
    max_retained_bytes: usize,
    pages_in_flight: usize,
}

#[derive(serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct BenchmarkCase {
    mode: BenchmarkMode,
    temperature: BenchmarkTemperature,
    rows: usize,
    sample_count: usize,
    latency_p50_ms: u64,
    latency_p95_ms: u64,
    peak_rss_p50_bytes: u64,
    peak_rss_p95_bytes: u64,
    first_batch_p50_ms: Option<u64>,
    first_batch_p95_ms: Option<u64>,
    max_retained_rows: usize,
    max_retained_bytes: usize,
    max_pages_in_flight: usize,
}

#[derive(serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct BenchmarkArtifact {
    schema_version: u8,
    measurement_scope: BenchmarkMeasurementScope,
    environment: BenchmarkEnvironment,
    methodology: String,
    cases: Vec<BenchmarkCase>,
}

#[derive(serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct BenchmarkEnvironment {
    os: String,
    arch: String,
    cores: usize,
    rustc: String,
}

/// Regenerate the checked-in aggregate with:
/// `cargo test --manifest-path src-tauri/Cargo.toml executor::read::tests::regenerate_desktop_stream_benchmark -- --ignored --nocapture`
#[test]
#[ignore = "regenerates the aggregate isolated-process desktop streaming benchmark"]
fn regenerate_desktop_stream_benchmark() {
    let artifact = collect_benchmark_artifact().expect("the isolated benchmark matrix must pass");
    validate_artifact(&artifact).expect("the aggregate schema and structural bounds must hold");
    let path = std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
        .join("benchmarks/desktop-streaming-summary.json");
    std::fs::write(
        path,
        serde_json::to_string_pretty(&artifact).unwrap() + "\n",
    )
    .unwrap();
}

/// Child entry point used only by the parent benchmark. Its bounded result wire
/// is parsed by the parent and never checked in per sample.
#[test]
fn desktop_stream_benchmark_child() {
    let Ok(request) = std::env::var(BENCHMARK_CHILD_ENV) else {
        return;
    };
    let request: BenchmarkChildRequest =
        serde_json::from_str(&request).expect("benchmark child request must be strict JSON");
    let runtime = tokio::runtime::Runtime::new().unwrap();
    let sample = runtime
        .block_on(measure_benchmark_child(request))
        .expect("benchmark child measurement must succeed");
    let wire = serde_json::to_string(&sample).unwrap();
    assert!(
        wire.len() < 1024,
        "benchmark child wire must remain bounded"
    );
    println!("{BENCHMARK_MARKER}{wire}");
}

fn collect_benchmark_artifact() -> Result<BenchmarkArtifact, String> {
    let mut cases = Vec::new();
    for mode in [BenchmarkMode::Materialized, BenchmarkMode::Streaming] {
        for temperature in [BenchmarkTemperature::Cold, BenchmarkTemperature::Warm] {
            for rows in BENCHMARK_ROWS {
                let mut samples = Vec::with_capacity(BENCHMARK_SAMPLES);
                for _ in 0..BENCHMARK_SAMPLES {
                    samples.push(run_benchmark_child(BenchmarkChildRequest {
                        mode,
                        temperature,
                        rows,
                    })?);
                }
                cases.push(aggregate_benchmark_case(mode, temperature, rows, &samples)?);
            }
        }
    }
    Ok(BenchmarkArtifact {
        schema_version: 2,
        measurement_scope: BenchmarkMeasurementScope::ExecutorOnly,
        environment: BenchmarkEnvironment {
            os: std::env::consts::OS.into(),
            arch: std::env::consts::ARCH.into(),
            cores: std::thread::available_parallelism().map_or(1, std::num::NonZeroUsize::get),
            rustc: rustc_version(),
        },
        methodology: "measurementScope=executor_only: each measured sample runs in a fresh test subprocess. Cold measures a new SQLite pool; warm performs one identical unmeasured warmup in that child before measuring. Materialized fetch_all and bounded streaming are separate executor scenarios. This artifact excludes DesktopSqlStreamRegistry pull/ACK, Tauri Channel/webview transport, and React rendering. Peak RSS is read inside the child after the measured operation, so it belongs to that scenario process. Percentiles use nearest rank ceil(p*N).".into(),
        cases,
    })
}

fn run_benchmark_child(request: BenchmarkChildRequest) -> Result<BenchmarkSample, String> {
    let wire = serde_json::to_string(&request).map_err(|error| error.to_string())?;
    let output =
        std::process::Command::new(std::env::current_exe().map_err(|error| error.to_string())?)
            .args([
                "--exact",
                "executor::read::tests::desktop_stream_benchmark_child",
                "--nocapture",
            ])
            .env(BENCHMARK_CHILD_ENV, wire)
            .output()
            .map_err(|error| format!("benchmark child could not start: {error}"))?;
    if !output.status.success() {
        return Err(format!("benchmark child exited with {}", output.status));
    }
    let stdout = String::from_utf8(output.stdout)
        .map_err(|_| "benchmark child emitted non-UTF8 output".to_string())?;
    parse_benchmark_child_output(&stdout)
}

fn parse_benchmark_child_output(output: &str) -> Result<BenchmarkSample, String> {
    let records = output
        .lines()
        .filter_map(|line| line.strip_prefix(BENCHMARK_MARKER))
        .collect::<Vec<_>>();
    let [record] = records.as_slice() else {
        return Err("benchmark child must emit exactly one JSON record".into());
    };
    if record.len() >= 1024 {
        return Err("benchmark child JSON record exceeded its bound".into());
    }
    serde_json::from_str(record).map_err(|error| format!("invalid benchmark child JSON: {error}"))
}

async fn measure_benchmark_child(
    request: BenchmarkChildRequest,
) -> Result<BenchmarkSample, String> {
    if !BENCHMARK_ROWS.contains(&request.rows) {
        return Err("unsupported benchmark row count".into());
    }
    let pool = sqlx::sqlite::SqlitePoolOptions::new()
        .max_connections(1)
        .connect("sqlite::memory:")
        .await
        .map_err(|error| error.to_string())?;
    if request.temperature == BenchmarkTemperature::Warm {
        execute_benchmark_workload(&pool, request.mode, request.rows, false).await?;
    }
    let sample = execute_benchmark_workload(&pool, request.mode, request.rows, true).await?;
    pool.close().await;
    Ok(BenchmarkSample {
        mode: request.mode,
        temperature: request.temperature,
        rows: request.rows,
        peak_rss_bytes: peak_rss_bytes()?,
        ..sample
    })
}

async fn execute_benchmark_workload(
    pool: &sqlx::SqlitePool,
    mode: BenchmarkMode,
    rows: usize,
    collect_metrics: bool,
) -> Result<BenchmarkSample, String> {
    let sql = format!(
        "WITH RECURSIVE n(value) AS (SELECT 1 UNION ALL SELECT value + 1 FROM n WHERE value < {rows}) SELECT value FROM n"
    );
    let started = std::time::Instant::now();
    let mut first_batch_ms = None;
    let (max_retained_rows, max_retained_bytes, pages_in_flight) = match mode {
        BenchmarkMode::Materialized => {
            let materialized = sqlx::query(AssertSqlSafe(sql.as_str()))
                .fetch_all(pool)
                .await
                .map_err(|error| error.to_string())?;
            if materialized.len() != rows {
                return Err("materialized benchmark row count mismatch".into());
            }
            drop(materialized);
            (0, 0, 0)
        }
        BenchmarkMode::Streaming => {
            let mut seen = 0_usize;
            let mut retained_rows = 0_usize;
            let mut retained_bytes = 0_usize;
            let mut sequence = 0_u64;
            let (_, row_count, truncated) = stream_batched(
                sqlx::query(AssertSqlSafe(sql)).fetch(pool),
                rows,
                256,
                sqlite_value,
                &mut |batch| {
                    if first_batch_ms.is_none() {
                        first_batch_ms = Some(started.elapsed().as_millis() as u64);
                    }
                    let event = crate::features::queries::DesktopSqlStreamBatch {
                        operation_id: crate::kernel::identity::OperationId::from(uuid::Uuid::nil()),
                        sequence,
                        columns: batch.columns,
                        rows: batch.rows,
                    };
                    sequence = sequence.saturating_add(1);
                    let bytes = match serde_json::to_vec(&event) {
                        Ok(batch) => batch.len(),
                        Err(error) => return std::future::ready(Err(AppError::from(error))),
                    };
                    if event.rows.len() > 256 || bytes > DESKTOP_STREAM_BATCH_MAX_BYTES {
                        return std::future::ready(Err(AppError::Safety(
                            "benchmark bounded page invariant failed".into(),
                        )));
                    }
                    retained_rows = retained_rows.max(event.rows.len());
                    retained_bytes = retained_bytes.max(bytes);
                    seen += event.rows.len();
                    std::future::ready(Ok(()))
                },
            )
            .await
            .map_err(|error| error.to_string())?;
            if row_count != rows || seen != rows || truncated {
                return Err("streaming benchmark row count mismatch".into());
            }
            (retained_rows, retained_bytes, 1)
        }
    };
    if !collect_metrics {
        return Ok(BenchmarkSample {
            mode,
            temperature: BenchmarkTemperature::Warm,
            rows,
            latency_ms: 0,
            peak_rss_bytes: 0,
            first_batch_ms: None,
            max_retained_rows,
            max_retained_bytes,
            pages_in_flight,
        });
    }
    Ok(BenchmarkSample {
        mode,
        temperature: BenchmarkTemperature::Cold,
        rows,
        latency_ms: started.elapsed().as_millis() as u64,
        peak_rss_bytes: 0,
        first_batch_ms,
        max_retained_rows,
        max_retained_bytes,
        pages_in_flight,
    })
}

fn aggregate_benchmark_case(
    mode: BenchmarkMode,
    temperature: BenchmarkTemperature,
    rows: usize,
    samples: &[BenchmarkSample],
) -> Result<BenchmarkCase, String> {
    if samples.len() != BENCHMARK_SAMPLES
        || samples.iter().any(|sample| {
            sample.mode != mode || sample.temperature != temperature || sample.rows != rows
        })
    {
        return Err("benchmark child returned the wrong scenario or sample count".into());
    }
    let mut latency = samples
        .iter()
        .map(|sample| sample.latency_ms)
        .collect::<Vec<_>>();
    let mut rss = samples
        .iter()
        .map(|sample| sample.peak_rss_bytes)
        .collect::<Vec<_>>();
    latency.sort_unstable();
    rss.sort_unstable();
    let mut first = samples
        .iter()
        .filter_map(|sample| sample.first_batch_ms)
        .collect::<Vec<_>>();
    first.sort_unstable();
    let case = BenchmarkCase {
        mode,
        temperature,
        rows,
        sample_count: samples.len(),
        latency_p50_ms: nearest_rank_percentile(&latency, 50),
        latency_p95_ms: nearest_rank_percentile(&latency, 95),
        peak_rss_p50_bytes: nearest_rank_percentile(&rss, 50),
        peak_rss_p95_bytes: nearest_rank_percentile(&rss, 95),
        first_batch_p50_ms: (!first.is_empty()).then(|| nearest_rank_percentile(&first, 50)),
        first_batch_p95_ms: (!first.is_empty()).then(|| nearest_rank_percentile(&first, 95)),
        max_retained_rows: samples
            .iter()
            .map(|sample| sample.max_retained_rows)
            .max()
            .unwrap_or_default(),
        max_retained_bytes: samples
            .iter()
            .map(|sample| sample.max_retained_bytes)
            .max()
            .unwrap_or_default(),
        max_pages_in_flight: samples
            .iter()
            .map(|sample| sample.pages_in_flight)
            .max()
            .unwrap_or_default(),
    };
    validate_case(&case)?;
    Ok(case)
}

fn validate_artifact(artifact: &BenchmarkArtifact) -> Result<(), String> {
    if artifact.schema_version != 2
        || artifact.measurement_scope != BenchmarkMeasurementScope::ExecutorOnly
        || !artifact
            .methodology
            .contains("measurementScope=executor_only")
        || !artifact
            .methodology
            .contains("excludes DesktopSqlStreamRegistry pull/ACK")
        || artifact.cases.len() != 12
    {
        return Err("benchmark aggregate schema or matrix size is invalid".into());
    }
    for mode in [BenchmarkMode::Materialized, BenchmarkMode::Streaming] {
        for temperature in [BenchmarkTemperature::Cold, BenchmarkTemperature::Warm] {
            for rows in BENCHMARK_ROWS {
                let matching = artifact
                    .cases
                    .iter()
                    .filter(|case| {
                        case.mode == mode && case.temperature == temperature && case.rows == rows
                    })
                    .count();
                if matching != 1 {
                    return Err("benchmark aggregate is missing or duplicates a scenario".into());
                }
            }
        }
    }
    artifact.cases.iter().try_for_each(validate_case)
}

fn validate_case(case: &BenchmarkCase) -> Result<(), String> {
    if case.sample_count != BENCHMARK_SAMPLES
        || case.latency_p50_ms > case.latency_p95_ms
        || case.peak_rss_p50_bytes > case.peak_rss_p95_bytes
    {
        return Err("benchmark aggregate metric ordering is invalid".into());
    }
    match case.mode {
        BenchmarkMode::Materialized
            if case.first_batch_p50_ms.is_some() || case.first_batch_p95_ms.is_some() =>
        {
            Err("materialized benchmark must not claim a first batch".into())
        }
        BenchmarkMode::Streaming
            if case.first_batch_p50_ms.is_none()
                || case.first_batch_p95_ms.is_none()
                || case.max_retained_rows > 256
                || case.max_retained_bytes > DESKTOP_STREAM_BATCH_MAX_BYTES
                || case.max_pages_in_flight != 1 =>
        {
            Err("streaming benchmark structural bounds are invalid".into())
        }
        _ => Ok(()),
    }
}

fn nearest_rank_percentile(sorted: &[u64], percentile: usize) -> u64 {
    assert!(!sorted.is_empty());
    assert!((1..=100).contains(&percentile));
    let index = (percentile * sorted.len()).div_ceil(100) - 1;
    sorted[index]
}

fn rustc_version() -> String {
    std::process::Command::new("rustc")
        .arg("--version")
        .output()
        .ok()
        .filter(|output| output.status.success())
        .and_then(|output| String::from_utf8(output.stdout).ok())
        .map(|version| version.trim().to_string())
        .unwrap_or_else(|| "unavailable".into())
}

#[cfg(unix)]
fn peak_rss_bytes() -> Result<u64, String> {
    unsafe {
        let mut usage = std::mem::zeroed::<libc::rusage>();
        if libc::getrusage(libc::RUSAGE_SELF, &mut usage) != 0 {
            return Err("getrusage failed".into());
        }
        let raw = u64::try_from(usage.ru_maxrss).map_err(|_| "negative peak RSS")?;
        #[cfg(target_os = "macos")]
        return Ok(raw);
        #[cfg(not(target_os = "macos"))]
        return Ok(raw.saturating_mul(1024));
    }
}

#[cfg(windows)]
fn peak_rss_bytes() -> Result<u64, String> {
    let script = format!("(Get-Process -Id {}).PeakWorkingSet64", std::process::id());
    let output = std::process::Command::new("powershell")
        .args(["-NoProfile", "-NonInteractive", "-Command", &script])
        .output()
        .map_err(|error| format!("PowerShell peak RSS lookup failed: {error}"))?;
    if !output.status.success() {
        return Err("PowerShell peak RSS lookup failed".into());
    }
    String::from_utf8(output.stdout)
        .map_err(|_| "PowerShell peak RSS output was not UTF-8".to_string())?
        .trim()
        .parse::<u64>()
        .map_err(|_| "PowerShell peak RSS output was not an integer".into())
}

#[cfg(not(any(unix, windows)))]
fn peak_rss_bytes() -> Result<u64, String> {
    Err("this platform has no checked peak RSS implementation".into())
}

#[test]
fn benchmark_percentiles_use_nearest_rank_and_edge_cases() {
    let samples = (1..=20).collect::<Vec<_>>();
    assert_eq!(nearest_rank_percentile(&samples, 50), 10);
    assert_eq!(nearest_rank_percentile(&samples, 95), 19);
    assert_eq!(nearest_rank_percentile(&samples, 1), 1);
    assert_eq!(nearest_rank_percentile(&samples, 100), 20);
    assert_eq!(nearest_rank_percentile(&[42], 50), 42);
}

#[test]
fn benchmark_child_parser_rejects_missing_multiple_and_trailing_json() {
    let sample = BenchmarkSample {
        mode: BenchmarkMode::Streaming,
        temperature: BenchmarkTemperature::Cold,
        rows: 1_000,
        latency_ms: 1,
        peak_rss_bytes: 2,
        first_batch_ms: Some(1),
        max_retained_rows: 1,
        max_retained_bytes: 2,
        pages_in_flight: 1,
    };
    let wire = serde_json::to_string(&sample).unwrap();
    assert!(
        parse_benchmark_child_output(&format!("test output\n{BENCHMARK_MARKER}{wire}\n")).is_ok()
    );
    assert!(parse_benchmark_child_output("").is_err());
    assert!(parse_benchmark_child_output(&format!(
        "{BENCHMARK_MARKER}{wire}\n{BENCHMARK_MARKER}{wire}"
    ))
    .is_err());
    assert!(parse_benchmark_child_output(&format!("{BENCHMARK_MARKER}{wire} trailing")).is_err());
}

#[test]
fn checked_in_benchmark_artifact_is_strict_executor_only_scope() {
    let artifact: BenchmarkArtifact = serde_json::from_str(include_str!(concat!(
        env!("CARGO_MANIFEST_DIR"),
        "/benchmarks/desktop-streaming-summary.json"
    )))
    .expect("checked-in benchmark aggregate must be strict JSON");
    validate_artifact(&artifact)
        .expect("checked-in aggregate must declare its executor-only scope");
}

#[test]
fn mysql_time_preserves_duration_range_sign_and_fraction() {
    let negative = MySqlTime::new(MySqlTimeSign::Negative, 25, 1, 2, 123_400).unwrap();
    let long = MySqlTime::new(MySqlTimeSign::Positive, 838, 59, 59, 0).unwrap();
    let short = MySqlTime::new(MySqlTimeSign::Positive, 1, 2, 3, 0).unwrap();

    assert_eq!(fmt_mysql_time(&negative), "-25:01:02.1234");
    assert_eq!(fmt_mysql_time(&long), "838:59:59");
    assert_eq!(fmt_mysql_time(&short), "01:02:03");
}

#[test]
fn mysql_year_and_set_use_their_required_decoder_routes() {
    assert_eq!(
        mysql_decode_route("YEAR"),
        MySqlDecodeRoute::UnsignedInteger
    );
    assert_eq!(
        mysql_decode_route("BIGINT UNSIGNED"),
        MySqlDecodeRoute::UnsignedInteger
    );
    assert_eq!(
        mysql_decode_route("BIGINT"),
        MySqlDecodeRoute::SignedInteger
    );
    assert_eq!(mysql_decode_route("SET"), MySqlDecodeRoute::Set);
}

#[test]
fn big_ints_become_strings() {
    assert_eq!(int_json(2), Value::from(2));
    assert_eq!(int_json(1 << 53), Value::from(9_007_199_254_740_992_i64));
    assert_eq!(
        int_json(9_007_199_254_740_993),
        Value::String("9007199254740993".into())
    );
    assert_eq!(
        int_json(-9_007_199_254_740_993),
        Value::String("-9007199254740993".into())
    );
    assert_eq!(uint_json(u64::MAX), Value::String(u64::MAX.to_string()));
    assert_eq!(uint_json(10), Value::from(10u64));
}

#[test]
fn interval_formats_psql_style() {
    let iv = |months, days, microseconds| PgInterval {
        months,
        days,
        microseconds,
    };
    assert_eq!(fmt_interval(&iv(0, 0, 0)), "00:00:00");
    assert_eq!(fmt_interval(&iv(0, 1, 7_380_000_000)), "1 day 02:03:00");
    assert_eq!(fmt_interval(&iv(14, 5, 0)), "1 year 2 mons 5 days");
    assert_eq!(fmt_interval(&iv(1, 0, 0)), "1 mon");
    assert_eq!(fmt_interval(&iv(0, 2, 0)), "2 days");
    assert_eq!(fmt_interval(&iv(0, 0, 4_500_000)), "00:00:04.5");
    assert_eq!(fmt_interval(&iv(0, 0, -3_600_000_000)), "-01:00:00");
}

#[test]
fn range_display_is_canonical() {
    use std::ops::Bound;
    let r = PgRange {
        start: Bound::Included(1_i32),
        end: Bound::Excluded(5_i32),
    };
    assert_eq!(r.to_string(), "[1,5)");
}

#[test]
fn enum_bytes_decode_to_label_utf8_only() {
    assert_eq!(bytes_as_label(b"active"), Some("active".to_string()));
    assert_eq!(bytes_as_label(&[0xff, 0xfe, 0x00]), None);
}

#[test]
fn array_element_name_is_base_minus_suffix() {
    assert_eq!("INT4[]".strip_suffix("[]"), Some("INT4"));
    assert_eq!(
        "CALLS_STATUS_ENUM[]".strip_suffix("[]"),
        Some("CALLS_STATUS_ENUM")
    );
    let elems: Vec<Value> = vec![1_i64, 9_007_199_254_740_993]
        .into_iter()
        .map(int_json)
        .collect();
    assert_eq!(
        Value::Array(elems),
        serde_json::json!([1, "9007199254740993"])
    );
}

#[test]
fn array_null_elements_become_json_null() {
    let ok: Result<Vec<Option<i32>>, sqlx::Error> = Ok(vec![Some(1), None, Some(3)]);
    assert_eq!(
        Value::Array(arr(ok, |x: i32| Value::from(x as i64)).unwrap()),
        serde_json::json!([1, null, 3])
    );
}
