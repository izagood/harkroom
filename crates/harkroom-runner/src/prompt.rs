//! 정본 `prompt.ts` 의 조각. 지금은 저장해 두고 다시 읽는 글(메모·기억·계획판)을 싣는 `escapeForPrompt` 만 옮겼다.

/// 정본 `escapeForPrompt` — `&` → `&amp;`, `<` → `&lt;`. 안의 글이 경계 표식(`</thread-note>` 등)을 위조하지 못하게 한다.
pub fn escape_for_prompt(text: &str) -> String {
    text.replace('&', "&amp;").replace('<', "&lt;")
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn escapes_amp_then_lt_like_the_ts_original() {
        assert_eq!(escape_for_prompt("a<b>&lt;"), "a&lt;b>&amp;lt;");
    }
}
