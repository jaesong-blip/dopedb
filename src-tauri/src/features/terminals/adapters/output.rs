//! Bounded PTY output handling.
//!
//! The renderer receives terminal bytes, never HTML. OSC control strings are removed
//! entirely (including clipboard and hyperlink sequences) and CSI window operations
//! are discarded before xterm sees them. The parser is stateful so a control sequence
//! split across read boundaries cannot bypass the filter.

const MAX_CONTROL_SEQUENCE_BYTES: usize = 256;

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

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn preserves_text_color_and_utf8_bytes() {
        let mut sanitizer = OutputSanitizer::default();
        let input = b"\x1b[32mDopeDB \xed\x95\x9c\xea\xb8\x80\x1b[0m\r\n";
        assert_eq!(sanitizer.push(input), input);
    }

    #[test]
    fn strips_clipboard_hyperlink_and_title_osc_sequences() {
        let mut sanitizer = OutputSanitizer::default();
        let first = sanitizer.push(b"a\x1b]52;c;secret\x07b\x1b]8;;https://bad.invalid");
        let second = sanitizer.push(b"\x1b\\link\x1b]8;;\x1b\\c\x1b]0;title\x07d");
        assert_eq!(first, b"ab");
        assert_eq!(second, b"linkcd");
    }

    #[test]
    fn strips_other_string_controls_and_accepts_c1_string_terminator() {
        let mut sanitizer = OutputSanitizer::default();
        let first = sanitizer.push(b"a\x1bP1;2|device-command\x1b\\b");
        let second = sanitizer.push(b"c\x9d8;;https://bad.invalid\x9cd");
        let third = sanitizer.push(b"e\x1b_hidden-apc\x07f");
        assert_eq!(first, b"ab");
        assert_eq!(second, b"cd");
        assert_eq!(third, b"ef");
    }

    #[test]
    fn strips_window_operations_split_between_chunks() {
        let mut sanitizer = OutputSanitizer::default();
        assert_eq!(sanitizer.push(b"left\x1b[8;40;"), b"left");
        assert_eq!(sanitizer.push(b"120tright"), b"right");
    }

    #[test]
    fn preserves_incomplete_escape_until_the_next_chunk() {
        let mut sanitizer = OutputSanitizer::default();
        assert!(sanitizer.push(b"\x1b").is_empty());
        assert_eq!(sanitizer.push(b"[31mred"), b"\x1b[31mred");
    }

    #[test]
    fn bounds_malformed_control_sequences() {
        let mut sanitizer = OutputSanitizer::default();
        let mut input = b"\x1b[".to_vec();
        input.extend(std::iter::repeat_n(b'1', MAX_CONTROL_SEQUENCE_BYTES + 5));
        input.extend_from_slice(b"visible");
        let output = sanitizer.push(&input);
        assert!(output.ends_with(b"visible"));
        assert!(output.len() < input.len());
    }

    #[test]
    fn recovers_after_an_unterminated_string_control() {
        let mut sanitizer = OutputSanitizer::default();
        let mut input = b"\x1b]".to_vec();
        input.extend(std::iter::repeat_n(b'x', MAX_CONTROL_SEQUENCE_BYTES + 5));
        input.extend_from_slice(b"visible");
        let output = sanitizer.push(&input);
        assert!(output.ends_with(b"visible"));
        assert!(output.len() < input.len());
    }
}
