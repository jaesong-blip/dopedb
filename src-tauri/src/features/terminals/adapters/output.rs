//! Bounded PTY output handling.
//!
//! The renderer receives terminal bytes, never HTML. OSC control strings are removed
//! entirely (including clipboard and hyperlink sequences) and CSI window operations
//! are discarded before xterm sees them. The parser is stateful so a control sequence
//! split across read boundaries cannot bypass the filter.

use tauri::ipc::Channel;

use crate::kernel::identity::TerminalSessionId;

use super::super::domain::TerminalOutputChunk;

const MAX_CONTROL_SEQUENCE_BYTES: usize = 256;

pub(super) struct TerminalOutputStream {
    subscriber: Option<Channel<TerminalOutputChunk>>,
}

impl TerminalOutputStream {
    pub(super) fn new(subscriber: Channel<TerminalOutputChunk>) -> Self {
        Self {
            subscriber: Some(subscriber),
        }
    }

    pub(super) fn publish(&mut self, session_id: TerminalSessionId, bytes: Vec<u8>) {
        let Some(subscriber) = self.subscriber.clone() else {
            return;
        };
        if subscriber
            .send(TerminalOutputChunk { session_id, bytes })
            .is_err()
        {
            self.subscriber = None;
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum ScanState {
    Ground,
    Escape,
    Csi,
    StringControl,
    StringEscape,
}

pub(super) struct OutputSanitizer {
    state: ScanState,
    control: Vec<u8>,
    string_bytes: usize,
}

impl Default for OutputSanitizer {
    fn default() -> Self {
        Self {
            state: ScanState::Ground,
            control: Vec::with_capacity(32),
            string_bytes: 0,
        }
    }
}

impl OutputSanitizer {
    pub(super) fn push(&mut self, input: &[u8]) -> Vec<u8> {
        let mut output = Vec::with_capacity(input.len());
        for &byte in input {
            match self.state {
                ScanState::Ground => match byte {
                    0x1b => {
                        self.control.clear();
                        self.control.push(byte);
                        self.state = ScanState::Escape;
                    }
                    0x9b => {
                        self.control.clear();
                        self.control.push(byte);
                        self.state = ScanState::Csi;
                    }
                    // DCS, SOS, OSC, PM, and APC are string controls. None are
                    // required for the database TUI contract; dropping the full
                    // string also blocks clipboard, hyperlink, title, and host-
                    // integration payloads before they reach the webview.
                    0x90 | 0x98 | 0x9d | 0x9e | 0x9f => {
                        self.control.clear();
                        self.string_bytes = 0;
                        self.state = ScanState::StringControl;
                    }
                    _ => output.push(byte),
                },
                ScanState::Escape => match byte {
                    b'[' => {
                        self.control.push(byte);
                        self.state = ScanState::Csi;
                    }
                    b'P' | b'X' | b']' | b'^' | b'_' => {
                        self.control.clear();
                        self.string_bytes = 0;
                        self.state = ScanState::StringControl;
                    }
                    _ => {
                        output.extend_from_slice(&self.control);
                        output.push(byte);
                        self.control.clear();
                        self.state = ScanState::Ground;
                    }
                },
                ScanState::Csi => {
                    self.control.push(byte);
                    if (0x40..=0x7e).contains(&byte) {
                        // CSI ... t is the terminal/window manipulation family.
                        if byte != b't' {
                            output.extend_from_slice(&self.control);
                        }
                        self.control.clear();
                        self.state = ScanState::Ground;
                    } else if self.control.len() > MAX_CONTROL_SEQUENCE_BYTES {
                        self.control.clear();
                        self.state = ScanState::Ground;
                    }
                }
                ScanState::StringControl => match byte {
                    0x07 | 0x9c => {
                        self.string_bytes = 0;
                        self.state = ScanState::Ground;
                    }
                    0x1b => self.state = ScanState::StringEscape,
                    _ => {
                        self.string_bytes = self.string_bytes.saturating_add(1);
                        if self.string_bytes > MAX_CONTROL_SEQUENCE_BYTES {
                            self.string_bytes = 0;
                            self.state = ScanState::Ground;
                        }
                    }
                },
                ScanState::StringEscape => {
                    if byte == b'\\' {
                        self.string_bytes = 0;
                        self.state = ScanState::Ground;
                    } else if byte != 0x1b {
                        self.string_bytes = self.string_bytes.saturating_add(2);
                        self.state = ScanState::StringControl;
                    }
                }
            }
        }
        output
    }
}
