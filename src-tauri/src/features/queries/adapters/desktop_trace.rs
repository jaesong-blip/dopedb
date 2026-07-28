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
