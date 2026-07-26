//! Stable, low-cardinality phase names for desktop SQL stream observability.
//!
//! These identifiers deliberately describe operation boundaries without recording
//! SQL text, result values, capabilities, or connection credentials.

pub(super) const AUDIT_PERSIST: &str = "desktop_query_audit_persist";
pub(super) const HISTORY_PERSIST: &str = "desktop_query_history_persist";
pub(super) const OPERATION_CLAIM: &str = "desktop_query_stream_operation_claim";
pub(super) const POOL_CONNECT_START: &str = "desktop_query_stream_pool_connect_start";
pub(super) const POOL_CONNECT_READY: &str = "desktop_query_stream_pool_connect_ready";
pub(super) const BACKEND_EXECUTE_START: &str = "desktop_query_stream_backend_execute_start";
pub(super) const FIRST_BATCH: &str = "desktop_query_stream_first_batch";
pub(super) const SERIALIZE_CHANNEL_SEND: &str = "desktop_query_stream_serialize_channel_send";
pub(super) const CHANNEL_ACK_WAIT: &str = "desktop_query_stream_channel_ack_wait";
pub(super) const BACKEND_COMPLETE: &str = "desktop_query_stream_backend_complete";
pub(super) const OPERATION_FINALIZE_START: &str = "desktop_query_stream_operation_finalize_start";
pub(super) const OPERATION_FINALIZE_COMPLETE: &str =
    "desktop_query_stream_operation_finalize_complete";
pub(super) const PROVENANCE_COMPLETE: &str = "desktop_query_stream_provenance_complete";

#[cfg(test)]
const DESKTOP_SQL_STREAM_TRACE_PHASES: &[&str] = &[
    AUDIT_PERSIST,
    HISTORY_PERSIST,
    OPERATION_CLAIM,
    POOL_CONNECT_START,
    POOL_CONNECT_READY,
    BACKEND_EXECUTE_START,
    FIRST_BATCH,
    SERIALIZE_CHANNEL_SEND,
    CHANNEL_ACK_WAIT,
    BACKEND_COMPLETE,
    OPERATION_FINALIZE_START,
    OPERATION_FINALIZE_COMPLETE,
    PROVENANCE_COMPLETE,
];

#[cfg(test)]
mod tests {
    use super::DESKTOP_SQL_STREAM_TRACE_PHASES;

    #[test]
    fn desktop_sql_stream_trace_phase_inventory_is_stable() {
        assert_eq!(
            DESKTOP_SQL_STREAM_TRACE_PHASES,
            [
                "desktop_query_audit_persist",
                "desktop_query_history_persist",
                "desktop_query_stream_operation_claim",
                "desktop_query_stream_pool_connect_start",
                "desktop_query_stream_pool_connect_ready",
                "desktop_query_stream_backend_execute_start",
                "desktop_query_stream_first_batch",
                "desktop_query_stream_serialize_channel_send",
                "desktop_query_stream_channel_ack_wait",
                "desktop_query_stream_backend_complete",
                "desktop_query_stream_operation_finalize_start",
                "desktop_query_stream_operation_finalize_complete",
                "desktop_query_stream_provenance_complete",
            ],
        );
    }
}
