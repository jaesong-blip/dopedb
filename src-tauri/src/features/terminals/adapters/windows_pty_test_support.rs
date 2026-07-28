//! Stateful ConPTY handshake support shared by Windows PTY tests.

pub(super) const CURSOR_POSITION_RESPONSE: &[u8] = b"\x1b[1;1R";

const CURSOR_POSITION_REQUEST: &[u8] = b"\x1b[6n";

/// PowerShell can ask its ConPTY client for the cursor position before it
/// processes input. The four-byte request may be split across PTY reads.
#[derive(Default)]
pub(super) struct CursorPositionResponder {
    matched: usize,
}

impl CursorPositionResponder {
    pub(super) fn observe(&mut self, bytes: &[u8]) -> usize {
        let mut responses = 0;
        for &byte in bytes {
            if byte == CURSOR_POSITION_REQUEST[self.matched] {
                self.matched += 1;
                if self.matched == CURSOR_POSITION_REQUEST.len() {
                    responses += 1;
                    self.matched = 0;
                }
            } else {
                self.matched = usize::from(byte == CURSOR_POSITION_REQUEST[0]);
            }
        }
        responses
    }
}
