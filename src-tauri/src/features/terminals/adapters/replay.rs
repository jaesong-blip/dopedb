//! Bounded Terminal output replay owned by the desktop runtime.

use std::collections::VecDeque;

use tauri::ipc::Channel;

use crate::error::{AppError, AppResult};
use crate::kernel::identity::TerminalSessionId;

use super::super::domain::TerminalOutputChunk;

const REPLAY_BYTES: usize = 512 * 1024;

struct ReplayEntry {
    sequence: u64,
    bytes: Vec<u8>,
}

pub(super) struct OutputReplay {
    next_sequence: u64,
    dropped_through: u64,
    replay_bytes: usize,
    replay: VecDeque<ReplayEntry>,
    subscriber: Option<Channel<TerminalOutputChunk>>,
}

impl OutputReplay {
    pub(super) fn new(subscriber: Channel<TerminalOutputChunk>) -> Self {
        Self {
            next_sequence: 1,
            dropped_through: 0,
            replay_bytes: 0,
            replay: VecDeque::new(),
            subscriber: Some(subscriber),
        }
    }

    pub(super) fn publish(&mut self, session_id: TerminalSessionId, bytes: Vec<u8>) {
        let sequence = self.next_sequence;
        self.next_sequence = self.next_sequence.saturating_add(1);
        self.replay_bytes = self.replay_bytes.saturating_add(bytes.len());
        self.replay.push_back(ReplayEntry {
            sequence,
            bytes: bytes.clone(),
        });
        while self.replay_bytes > REPLAY_BYTES {
            let Some(entry) = self.replay.pop_front() else {
                break;
            };
            self.replay_bytes = self.replay_bytes.saturating_sub(entry.bytes.len());
            self.dropped_through = entry.sequence;
        }
        let Some(subscriber) = self.subscriber.clone() else {
            return;
        };
        if subscriber
            .send(TerminalOutputChunk {
                session_id,
                sequence,
                bytes,
                replay: false,
            })
            .is_err()
        {
            self.subscriber = None;
        }
    }

    pub(super) fn attach(
        &mut self,
        session_id: TerminalSessionId,
        after_sequence: Option<u64>,
        subscriber: Channel<TerminalOutputChunk>,
    ) -> AppResult<ReplayReceipt> {
        let after = after_sequence.unwrap_or(0);
        let replay = self
            .replay
            .iter()
            .filter(|entry| entry.sequence > after)
            .collect::<Vec<_>>();
        let replay_from = replay.first().map(|entry| entry.sequence);
        for entry in replay {
            subscriber
                .send(TerminalOutputChunk {
                    session_id,
                    sequence: entry.sequence,
                    bytes: entry.bytes.clone(),
                    replay: true,
                })
                .map_err(|_| {
                    AppError::Config("the Terminal output channel is unavailable".into())
                })?;
        }
        self.subscriber = Some(subscriber);
        Ok(ReplayReceipt {
            replay_from,
            replay_through: self.next_sequence.saturating_sub(1),
            truncated: after < self.dropped_through,
        })
    }
}

pub(super) struct ReplayReceipt {
    pub(super) replay_from: Option<u64>,
    pub(super) replay_through: u64,
    pub(super) truncated: bool,
}
