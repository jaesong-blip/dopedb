//! Single-writer, capability-bound pull/ACK backpressure for desktop SQL streams.

use std::collections::HashMap;
use std::sync::{Arc, Mutex};
use std::time::Duration;

use tokio::sync::watch;

use crate::executor::read::DESKTOP_STREAM_BATCH_MAX_BYTES;
use crate::kernel::identity::OperationId;
use crate::kernel::sync::lock_unpoisoned;

use super::super::domain::{
    DesktopSqlStreamBatch, DesktopSqlStreamReady, DesktopSqlStreamSinkError,
};

pub(super) const MAX_IN_FLIGHT_BATCHES: usize = 1;
pub(super) const STREAM_ACK_TIMEOUT: Duration = Duration::from_secs(15);

#[derive(Clone, Default)]
pub(crate) struct DesktopSqlStreamRegistry {
    streams: Arc<Mutex<HashMap<OperationId, StreamCredit>>>,
    pending: Arc<Mutex<HashMap<String, PendingStream>>>,
}

struct PendingStream {
    owner_webview: String,
    cancelled: bool,
}

struct StreamCredit {
    next_sequence: u64,
    in_flight: Option<u64>,
    pulled: bool,
    cancelled: bool,
    owner_webview: String,
    capability: String,
    batch: Option<DesktopSqlStreamBatch>,
    /// Versioned state change signal. A waiter subscribes before inspecting the
    /// credit, so an ACK between unlock and await is observed rather than lost.
    changed: watch::Sender<u64>,
}

/// The sole owning handle. It closes the retained page if the query/Tauri future
/// is aborted; per-page callbacks receive only [`StreamBorrow`].
pub(super) struct DesktopSqlStreamSession {
    operation_id: OperationId,
    registry: DesktopSqlStreamRegistry,
}

#[derive(Clone)]
pub(super) struct StreamBorrow {
    operation_id: OperationId,
    registry: DesktopSqlStreamRegistry,
}

impl DesktopSqlStreamRegistry {
    pub(crate) fn reserve_pending(
        &self,
        owner_webview: String,
        capability: String,
    ) -> Result<(), DesktopSqlStreamSinkError> {
        Self::validate_capability(&capability)?;
        let mut pending = lock_unpoisoned(&self.pending);
        if pending
            .insert(
                capability,
                PendingStream {
                    owner_webview,
                    cancelled: false,
                },
            )
            .is_some()
        {
            return Err(DesktopSqlStreamSinkError::StreamAlreadyActive);
        }
        Ok(())
    }

    pub(crate) fn bind_pending(
        &self,
        operation_id: OperationId,
        owner_webview: String,
        capability: String,
    ) -> Result<(), DesktopSqlStreamSinkError> {
        let pending = lock_unpoisoned(&self.pending).remove(&capability);
        let Some(pending) = pending else {
            return Err(DesktopSqlStreamSinkError::Cancelled);
        };
        if pending.owner_webview != owner_webview || pending.cancelled {
            return Err(DesktopSqlStreamSinkError::Cancelled);
        }
        self.reserve(operation_id, owner_webview, capability)
    }

    pub(crate) fn reserve(
        &self,
        operation_id: OperationId,
        owner_webview: String,
        capability: String,
    ) -> Result<(), DesktopSqlStreamSinkError> {
        Self::validate_capability(&capability)?;
        let mut streams = lock_unpoisoned(&self.streams);
        if streams.contains_key(&operation_id) {
            return Err(DesktopSqlStreamSinkError::StreamAlreadyActive);
        }
        let (changed, _) = watch::channel(0_u64);
        streams.insert(
            operation_id,
            StreamCredit {
                next_sequence: 0,
                in_flight: None,
                pulled: false,
                cancelled: false,
                owner_webview,
                capability,
                batch: None,
                changed,
            },
        );
        Ok(())
    }

    fn validate_capability(capability: &str) -> Result<(), DesktopSqlStreamSinkError> {
        if capability.len() != 64 || !capability.bytes().all(|byte| byte.is_ascii_hexdigit()) {
            return Err(DesktopSqlStreamSinkError::InvalidAcknowledgement);
        }
        Ok(())
    }

    pub(super) fn begin_reserved(
        &self,
        operation_id: OperationId,
        owner_webview: &str,
        capability: &str,
    ) -> Result<DesktopSqlStreamSession, DesktopSqlStreamSinkError> {
        let streams = lock_unpoisoned(&self.streams);
        let Some(stream) = streams.get(&operation_id) else {
            return Err(DesktopSqlStreamSinkError::StreamNotActive);
        };
        if stream.owner_webview != owner_webview || stream.capability != capability {
            return Err(DesktopSqlStreamSinkError::InvalidAcknowledgement);
        }
        drop(streams);
        Ok(DesktopSqlStreamSession {
            operation_id,
            registry: self.clone(),
        })
    }

    pub(crate) fn is_cancelled(&self, operation_id: OperationId) -> bool {
        lock_unpoisoned(&self.streams)
            .get(&operation_id)
            .is_some_and(|stream| stream.cancelled)
    }

    /// An authenticated, but invalid, owner request stops its own operation.
    /// Capability or webview mismatches deliberately return no detail and must
    /// never let a different renderer cancel a stream it does not own.
    fn reject_owned(stream: &mut StreamCredit) {
        stream.cancelled = true;
        stream.batch = None;
        stream
            .changed
            .send_modify(|version| *version = version.saturating_add(1));
    }

    pub(crate) fn pull(
        &self,
        operation_id: OperationId,
        sequence: u64,
        capability: &str,
        owner_webview: &str,
    ) -> Option<DesktopSqlStreamBatch> {
        let mut streams = lock_unpoisoned(&self.streams);
        let stream = streams.get_mut(&operation_id)?;
        if stream.capability != capability || stream.owner_webview != owner_webview {
            return None;
        }
        if stream.cancelled || stream.in_flight != Some(sequence) || stream.pulled {
            Self::reject_owned(stream);
            return None;
        }
        stream.pulled = true;
        // Transfer rather than clone: the registry has at most one bounded page,
        // and a webview drop after pull cannot retain a second serialized copy.
        stream.batch.take()
    }

    pub(crate) fn acknowledge(
        &self,
        operation_id: OperationId,
        sequence: u64,
        capability: &str,
        owner_webview: &str,
    ) -> bool {
        let mut streams = lock_unpoisoned(&self.streams);
        let Some(stream) = streams.get_mut(&operation_id) else {
            return false;
        };
        if stream.capability != capability || stream.owner_webview != owner_webview {
            return false;
        }
        if stream.cancelled || stream.in_flight != Some(sequence) || !stream.pulled {
            Self::reject_owned(stream);
            return false;
        }
        stream.in_flight = None;
        stream.pulled = false;
        stream.next_sequence = stream.next_sequence.saturating_add(1);
        stream
            .changed
            .send_modify(|version| *version = version.saturating_add(1));
        true
    }

    pub(crate) fn cancel(
        &self,
        operation_id: OperationId,
        capability: &str,
        owner_webview: &str,
    ) -> bool {
        let mut streams = lock_unpoisoned(&self.streams);
        let Some(stream) = streams.get_mut(&operation_id) else {
            return false;
        };
        if stream.capability != capability || stream.owner_webview != owner_webview {
            return false;
        }
        Self::reject_owned(stream);
        true
    }

    pub(crate) fn cancel_pending(&self, capability: &str, owner_webview: &str) -> bool {
        let mut pending = lock_unpoisoned(&self.pending);
        let Some(stream) = pending.get_mut(capability) else {
            return false;
        };
        if stream.owner_webview != owner_webview {
            return false;
        }
        stream.cancelled = true;
        true
    }

    pub(crate) fn forget_pending(&self, capability: &str, owner_webview: &str) {
        let mut pending = lock_unpoisoned(&self.pending);
        if pending
            .get(capability)
            .is_some_and(|stream| stream.owner_webview == owner_webview)
        {
            pending.remove(capability);
        }
    }

    pub(crate) fn close(&self, operation_id: OperationId) -> bool {
        let removed = lock_unpoisoned(&self.streams).remove(&operation_id);
        if let Some(stream) = removed {
            stream
                .changed
                .send_modify(|version| *version = version.saturating_add(1));
            true
        } else {
            false
        }
    }
}

impl Drop for DesktopSqlStreamSession {
    fn drop(&mut self) {
        self.registry.close(self.operation_id);
    }
}

impl DesktopSqlStreamSession {
    pub(super) fn borrow(&self) -> StreamBorrow {
        StreamBorrow {
            operation_id: self.operation_id,
            registry: self.registry.clone(),
        }
    }

    pub(super) fn close(&mut self) {
        self.registry.close(self.operation_id);
    }
}

impl StreamBorrow {
    pub(super) fn dispatch<E>(
        &self,
        sequence: u64,
        batch: DesktopSqlStreamBatch,
        emit: impl FnOnce(DesktopSqlStreamReady) -> Result<(), E>,
    ) -> Result<(), DesktopSqlStreamSinkError> {
        let encoded =
            serde_json::to_vec(&batch).map_err(|_| DesktopSqlStreamSinkError::BatchTooLarge)?;
        if batch.rows.len() > 256 || encoded.len() > DESKTOP_STREAM_BATCH_MAX_BYTES {
            return Err(DesktopSqlStreamSinkError::BatchTooLarge);
        }
        let ready = {
            let mut streams = lock_unpoisoned(&self.registry.streams);
            let stream = streams
                .get_mut(&self.operation_id)
                .ok_or(DesktopSqlStreamSinkError::StreamNotActive)?;
            if stream.cancelled {
                return Err(DesktopSqlStreamSinkError::Cancelled);
            }
            if usize::from(stream.in_flight.is_some()) >= MAX_IN_FLIGHT_BATCHES
                || stream.next_sequence != sequence
            {
                return Err(DesktopSqlStreamSinkError::InvalidAcknowledgement);
            }
            stream.in_flight = Some(sequence);
            stream.pulled = false;
            stream.batch = Some(batch);
            DesktopSqlStreamReady {
                operation_id: self.operation_id,
                sequence,
                capability: stream.capability.clone(),
            }
        };
        emit(ready).map_err(|_| DesktopSqlStreamSinkError::ReceiverDropped)
    }

    pub(super) async fn wait_for_ack(
        &self,
        sequence: u64,
    ) -> Result<(), DesktopSqlStreamSinkError> {
        self.wait_for_ack_with_hook(sequence, || {}).await
    }

    async fn wait_for_ack_with_hook(
        &self,
        sequence: u64,
        mut after_subscribe: impl FnMut(),
    ) -> Result<(), DesktopSqlStreamSinkError> {
        let timeout = tokio::time::sleep(STREAM_ACK_TIMEOUT);
        tokio::pin!(timeout);
        loop {
            let mut changed = {
                let streams = lock_unpoisoned(&self.registry.streams);
                let stream = streams
                    .get(&self.operation_id)
                    .ok_or(DesktopSqlStreamSinkError::StreamNotActive)?;
                // Subscribe while the mutex protects the state. `watch` retains
                // the version, so the subsequent `changed()` cannot miss an ACK.
                let changed = stream.changed.subscribe();
                if stream.cancelled {
                    return Err(DesktopSqlStreamSinkError::Cancelled);
                }
                if stream.in_flight.is_none() && stream.next_sequence == sequence.saturating_add(1)
                {
                    return Ok(());
                }
                if stream.in_flight != Some(sequence) {
                    return Err(DesktopSqlStreamSinkError::InvalidAcknowledgement);
                }
                changed
            };
            after_subscribe();
            tokio::select! {
                _ = changed.changed() => {},
                _ = &mut timeout => return Err(DesktopSqlStreamSinkError::AcknowledgementTimedOut),
            }
        }
    }
}
