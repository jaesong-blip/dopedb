//! Packaged benchmark scenario, resource, and renderer-metric validation.

use super::*;

#[cfg(feature = "packaged-benchmark")]
pub(super) fn benchmark_scenario() -> AppResult<String> {
    let value = std::env::var("DOPEDB_PACKAGED_BENCHMARK_SCENARIO")
        .map_err(|_| AppError::Config("benchmark scenario is required".into()))?;
    let valid = !value.is_empty()
        && value.len() <= 96
        && value
            .bytes()
            .all(|byte| byte.is_ascii_lowercase() || byte.is_ascii_digit() || byte == b'-');
    if !valid {
        return Err(AppError::Config("benchmark scenario is invalid".into()));
    }
    Ok(value)
}

#[cfg(feature = "packaged-benchmark")]
pub(super) fn benchmark_phase(scenario: &str) -> AppResult<Option<String>> {
    let value = std::env::var("DOPEDB_PACKAGED_BENCHMARK_PHASE").ok();
    match (scenario, value.as_deref()) {
        ("agent-tools", Some("install" | "restart")) => Ok(value),
        ("agent-tools", None) => Ok(None),
        ("agent-tools", Some(_)) => Err(AppError::Config(
            "agent-tools benchmark phase is invalid".into(),
        )),
        (_, None) => Ok(None),
        (_, Some(_)) => Err(AppError::Config(
            "benchmark phase is only supported for agent-tools".into(),
        )),
    }
}

#[cfg(feature = "packaged-benchmark")]
static PACKAGED_PROCESS_TREE_RSS_MAX: AtomicU64 = AtomicU64::new(0);

#[cfg(feature = "packaged-benchmark")]
static PACKAGED_PROCESS_TREE_RSS_SAMPLER: Once = Once::new();

#[cfg(feature = "packaged-benchmark")]
pub(super) fn start_packaged_process_tree_rss_sampler() {
    observe_packaged_process_tree_rss();
    PACKAGED_PROCESS_TREE_RSS_SAMPLER.call_once(|| {
        thread::spawn(|| loop {
            thread::sleep(Duration::from_millis(50));
            observe_packaged_process_tree_rss();
        });
    });
}

#[cfg(feature = "packaged-benchmark")]
pub(super) fn observe_packaged_process_tree_rss() {
    if let Some(bytes) = packaged_process_tree_rss_bytes() {
        PACKAGED_PROCESS_TREE_RSS_MAX.fetch_max(bytes, Ordering::Relaxed);
    }
}

#[cfg(feature = "packaged-benchmark")]
pub(super) fn maximum_packaged_process_tree_rss_bytes() -> Option<u64> {
    observe_packaged_process_tree_rss();
    let bytes = PACKAGED_PROCESS_TREE_RSS_MAX.load(Ordering::Relaxed);
    (bytes > 0).then_some(bytes)
}

#[cfg(all(feature = "packaged-benchmark", windows))]
pub(super) fn packaged_process_tree_rss_bytes() -> Option<u64> {
    use std::collections::HashSet;
    use std::mem::size_of;

    use windows_sys::Win32::Foundation::{CloseHandle, HANDLE, INVALID_HANDLE_VALUE};
    use windows_sys::Win32::System::Diagnostics::ToolHelp::{
        CreateToolhelp32Snapshot, Process32FirstW, Process32NextW, PROCESSENTRY32W,
        TH32CS_SNAPPROCESS,
    };
    use windows_sys::Win32::System::ProcessStatus::{
        K32GetProcessMemoryInfo, PROCESS_MEMORY_COUNTERS,
    };
    use windows_sys::Win32::System::Threading::{
        OpenProcess, PROCESS_QUERY_INFORMATION, PROCESS_VM_READ,
    };

    struct OwnedHandle(HANDLE);
    impl Drop for OwnedHandle {
        fn drop(&mut self) {
            unsafe { CloseHandle(self.0) };
        }
    }

    let snapshot = unsafe { CreateToolhelp32Snapshot(TH32CS_SNAPPROCESS, 0) };
    if snapshot == INVALID_HANDLE_VALUE {
        return None;
    }
    let snapshot = OwnedHandle(snapshot);
    let mut entry = PROCESSENTRY32W {
        dwSize: u32::try_from(size_of::<PROCESSENTRY32W>()).ok()?,
        ..Default::default()
    };
    if unsafe { Process32FirstW(snapshot.0, &mut entry) } == 0 {
        return None;
    }
    let mut processes = Vec::new();
    loop {
        processes.push((entry.th32ProcessID, entry.th32ParentProcessID));
        if unsafe { Process32NextW(snapshot.0, &mut entry) } == 0 {
            break;
        }
    }

    let mut descendants = HashSet::from([std::process::id()]);
    loop {
        let before = descendants.len();
        for &(pid, parent_pid) in &processes {
            if descendants.contains(&parent_pid) {
                descendants.insert(pid);
            }
        }
        if descendants.len() == before {
            break;
        }
    }

    let mut total = 0u64;
    for pid in descendants {
        let process = unsafe { OpenProcess(PROCESS_QUERY_INFORMATION | PROCESS_VM_READ, 0, pid) };
        if process.is_null() {
            continue;
        }
        let process = OwnedHandle(process);
        let counter_size = u32::try_from(size_of::<PROCESS_MEMORY_COUNTERS>()).ok()?;
        let mut counters = PROCESS_MEMORY_COUNTERS {
            cb: counter_size,
            ..Default::default()
        };
        if unsafe { K32GetProcessMemoryInfo(process.0, &mut counters, counter_size) } != 0 {
            total =
                total.saturating_add(u64::try_from(counters.WorkingSetSize).unwrap_or(u64::MAX));
        }
    }
    (total > 0).then_some(total)
}

#[cfg(all(feature = "packaged-benchmark", target_os = "macos"))]
pub(super) fn packaged_process_tree_rss_bytes() -> Option<u64> {
    use std::collections::HashSet;
    use std::ffi::c_void;
    use std::mem::{size_of, MaybeUninit};

    let pid_count = unsafe { libc::proc_listallpids(std::ptr::null_mut(), 0) };
    let capacity = usize::try_from(pid_count).ok()?.saturating_add(64);
    let mut pids = vec![0i32; capacity];
    let byte_size = i32::try_from(pids.len().checked_mul(size_of::<i32>())?).ok()?;
    let listed = unsafe { libc::proc_listallpids(pids.as_mut_ptr().cast::<c_void>(), byte_size) };
    let listed = usize::try_from(listed).ok()?.min(pids.len());
    pids.truncate(listed);

    let bsd_info_size = i32::try_from(size_of::<libc::proc_bsdinfo>()).ok()?;
    let mut processes = Vec::with_capacity(pids.len());
    for pid in pids.into_iter().filter(|pid| *pid > 0) {
        let mut info = MaybeUninit::<libc::proc_bsdinfo>::zeroed();
        let read = unsafe {
            libc::proc_pidinfo(
                pid,
                libc::PROC_PIDTBSDINFO,
                0,
                info.as_mut_ptr().cast::<c_void>(),
                bsd_info_size,
            )
        };
        if read == bsd_info_size {
            let parent_pid = i32::try_from(unsafe { info.assume_init() }.pbi_ppid).ok()?;
            processes.push((pid, parent_pid));
        }
    }

    let root = i32::try_from(std::process::id()).ok()?;
    let mut descendants = HashSet::from([root]);
    loop {
        let before = descendants.len();
        for &(pid, parent_pid) in &processes {
            if descendants.contains(&parent_pid) {
                descendants.insert(pid);
            }
        }
        if descendants.len() == before {
            break;
        }
    }

    let task_info_size = i32::try_from(size_of::<libc::proc_taskinfo>()).ok()?;
    let mut total = 0u64;
    for pid in descendants {
        let mut info = MaybeUninit::<libc::proc_taskinfo>::zeroed();
        let read = unsafe {
            libc::proc_pidinfo(
                pid,
                libc::PROC_PIDTASKINFO,
                0,
                info.as_mut_ptr().cast::<c_void>(),
                task_info_size,
            )
        };
        if read == task_info_size {
            total = total.saturating_add(unsafe { info.assume_init() }.pti_resident_size);
        }
    }
    (total > 0).then_some(total)
}

#[cfg(all(feature = "packaged-benchmark", not(any(windows, target_os = "macos"))))]
pub(super) fn packaged_process_tree_rss_bytes() -> Option<u64> {
    None
}

#[cfg(feature = "packaged-benchmark")]
pub(super) fn benchmark_connection_count() -> AppResult<u32> {
    let value = std::env::var("DOPEDB_PACKAGED_BENCHMARK_CONNECTIONS")
        .map_err(|_| AppError::Config("benchmark connection count is required".into()))?;
    u32::try_from(parse_connection_count(&value)?)
        .map_err(|_| AppError::Config("benchmark connection count is invalid".into()))
}

#[cfg(feature = "packaged-benchmark")]
pub(super) fn parse_connection_count(value: &str) -> AppResult<usize> {
    match value {
        "0" => Ok(0),
        "5" => Ok(5),
        "20" => Ok(20),
        _ => Err(AppError::Config(
            "benchmark connection count must be 0, 5, or 20".into(),
        )),
    }
}

#[cfg(feature = "packaged-benchmark")]
pub(super) fn validate_metrics(metrics: &RendererMetrics) -> AppResult<()> {
    let durations = [
        metrics.renderer_elapsed_ms,
        metrics.react_commit_duration_ms,
        metrics.max_react_commit_duration_ms,
        metrics.max_long_task_ms,
        metrics.max_frame_gap_ms,
        metrics.ipc_total_duration_ms,
        metrics.idle_observation_ms,
    ];
    let counts = [
        metrics.react_commit_count,
        metrics.long_task_count,
        metrics.frame_sample_count,
        metrics.frame_over_50_ms_count,
        metrics.ipc_call_count,
        metrics.idle_ipc_call_count,
    ];
    if durations
        .iter()
        .any(|value| !value.is_finite() || *value < 0.0 || *value > 600_000.0)
        || counts.iter().any(|value| *value > 10_000_000)
        || !(1..=16_384).contains(&metrics.viewport_width)
        || !(1..=16_384).contains(&metrics.viewport_height)
        || !metrics.device_pixel_ratio.is_finite()
        || !(0.25..=16.0).contains(&metrics.device_pixel_ratio)
        || !matches!(
            metrics.webview_engine.as_str(),
            "webkit" | "webview2" | "unknown"
        )
        || !safe_version(&metrics.webview_version)
        || metrics.actions.len() > 64
        || metrics
            .actions
            .iter()
            .any(|measurement| !valid_action_metrics(measurement))
        || metrics
            .webview_heap_bytes
            .is_some_and(|bytes| bytes > 64 * 1024 * 1024 * 1024)
    {
        return Err(AppError::Config(
            "packaged benchmark renderer metrics are invalid".into(),
        ));
    }
    Ok(())
}
