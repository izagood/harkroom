//! JS 문자열 규칙을 그대로 옮긴 것 — TS 판정과 글자 하나까지 같아야 하는 곳에서만 쓴다.

/// `String.prototype.trim()` 이 지우는 글자(WhiteSpace + LineTerminator). Rust `char::is_whitespace` 와 다르다:
/// JS 는 BOM(U+FEFF)을 지우고 NEL(U+0085)은 남긴다.
fn js_ws(c: char) -> bool {
    matches!(
        c,
        '\u{0009}'
            | '\u{000A}'
            | '\u{000B}'
            | '\u{000C}'
            | '\u{000D}'
            | '\u{0020}'
            | '\u{00A0}'
            | '\u{1680}'
            | '\u{2000}'
            ..='\u{200A}'
                | '\u{2028}'
                | '\u{2029}'
                | '\u{202F}'
                | '\u{205F}'
                | '\u{3000}'
                | '\u{FEFF}'
    )
}

pub(super) fn trim(s: &str) -> &str {
    s.trim_matches(js_ws)
}

/// JS `.length` — UTF-16 칸 수.
pub(super) fn len16(s: &str) -> usize {
    s.chars().map(char::len_utf16).sum()
}

/// `encodeURIComponent` — 그대로 두는 글자: `A-Z a-z 0-9 - _ . ! ~ * ' ( )`. 나머지는 UTF-8 바이트마다 `%XX`(대문자).
/// Rust `str` 에는 짝 없는 서로게이트가 없으므로 JS 가 던지는 경우는 생기지 않는다.
pub(super) fn encode_uri_component(s: &str) -> String {
    const HEX: &[u8; 16] = b"0123456789ABCDEF";
    // 가장 긴 결과(바이트마다 3자)만큼 미리 잡는다 — 자라면서 옮겨 간 옛 버퍼에 값 조각이 남지 않게(부르는 쪽이 Zeroizing 에 담는다).
    let mut out = String::with_capacity(s.len() * 3);
    for &b in s.as_bytes() {
        if b.is_ascii_alphanumeric() || b"-_.!~*'()".contains(&b) {
            out.push(b as char);
        } else {
            out.push('%');
            out.push(HEX[(b >> 4) as usize] as char);
            out.push(HEX[(b & 0xf) as usize] as char);
        }
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn trim_matches_js() {
        assert_eq!(trim("\u{FEFF} a \u{2028}"), "a");
        assert_eq!(trim("a\u{0085}"), "a\u{0085}");
        assert_eq!(len16("🔑a"), 3);
        assert_eq!(encode_uri_component("a b/가~"), "a%20b%2F%EA%B0%80~");
    }
}
