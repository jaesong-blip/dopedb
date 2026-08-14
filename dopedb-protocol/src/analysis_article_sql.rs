//! Small lexical safety check shared by the Rust Analysis Article boundary.
//! Database execution still applies the engine-aware Desktop read-only gate.

pub(crate) fn read_only_sql(sql: &str) -> bool {
    let Some(tokens) = sql_tokens(sql) else {
        return false;
    };
    let Some(first) = tokens.first().map(String::as_str) else {
        return false;
    };
    let semicolons = tokens.iter().filter(|token| token.as_str() == ";").count();
    let prohibited = [
        "insert", "update", "delete", "merge", "replace", "upsert", "copy", "call", "do", "create",
        "alter", "drop", "truncate", "grant", "revoke", "attach", "detach", "vacuum", "analyze",
        "refresh", "reindex", "cluster", "lock", "set", "reset",
    ];
    matches!(
        first,
        "select" | "with" | "show" | "describe" | "desc" | "explain"
    ) && semicolons <= 1
        && (semicolons == 0 || tokens.last().is_some_and(|token| token == ";"))
        && !tokens
            .iter()
            .any(|token| prohibited.contains(&token.as_str()))
}

fn sql_tokens(sql: &str) -> Option<Vec<String>> {
    let bytes = sql.as_bytes();
    let mut tokens = Vec::new();
    let mut index = 0;
    while index < bytes.len() {
        let character = sql[index..].chars().next()?;
        if character.is_whitespace() {
            index += character.len_utf8();
            continue;
        }
        if bytes[index..].starts_with(b"--") {
            index = sql[index + 2..]
                .find('\n')
                .map_or(bytes.len(), |offset| index + offset + 3);
            continue;
        }
        if bytes[index..].starts_with(b"/*") {
            let end = sql[index + 2..].find("*/")?;
            index += end + 4;
            continue;
        }
        if matches!(bytes[index], b'\'' | b'"' | b'`') {
            let quote = bytes[index];
            index += 1;
            let mut closed = false;
            while index < bytes.len() {
                if bytes[index] == quote {
                    if bytes.get(index + 1) == Some(&quote) {
                        index += 2;
                        continue;
                    }
                    index += 1;
                    closed = true;
                    break;
                }
                if bytes[index] == b'\\' && quote != b'"' {
                    index += 1;
                }
                index += 1;
            }
            if !closed {
                return None;
            }
            continue;
        }
        if bytes[index] == b'$' {
            let tail = &sql[index..];
            let tag_end = if tail.starts_with("$$") {
                Some(2)
            } else {
                tail[1..].find('$').map(|offset| offset + 2).filter(|end| {
                    let tag = &tail[1..end - 1];
                    !tag.is_empty()
                        && (tag.as_bytes()[0].is_ascii_alphabetic() || tag.as_bytes()[0] == b'_')
                        && tag
                            .bytes()
                            .all(|byte| byte.is_ascii_alphanumeric() || byte == b'_')
                })
            };
            if let Some(tag_end) = tag_end {
                let tag = &tail[..tag_end];
                let content_end = tail[tag_end..].find(tag)?;
                index += tag_end + content_end + tag_end;
                continue;
            }
        }
        if bytes[index].is_ascii_alphabetic() || bytes[index] == b'_' {
            let start = index;
            index += 1;
            while index < bytes.len()
                && (bytes[index].is_ascii_alphanumeric() || matches!(bytes[index], b'_' | b'$'))
            {
                index += 1;
            }
            tokens.push(sql[start..index].to_ascii_lowercase());
            continue;
        }
        if bytes[index] == b';' {
            tokens.push(";".to_owned());
        }
        index += character.len_utf8();
    }
    Some(tokens)
}
