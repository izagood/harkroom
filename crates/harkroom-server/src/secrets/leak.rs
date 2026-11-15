//! 에이전트 글 속 비밀 값 찾기 — TS `secretLeakGuard.ts` 의 `needlesFor`·`collectStrings`·`findInTexts`·`findInBytes` 판정.
//! DB 읽기·거절 기록·훅은 붙이는 PR(MCP 본문 거절)에서 한다.
//!
//! 결과에는 걸린 비밀의 id·이름만 담는다 — 어느 바늘이 어디서 걸렸는지는 담지 않는다(거절 글이 그것을 되비추면 그대로 문맥에 실린다).
use std::fmt;

use base64::Engine as _;
use base64::engine::general_purpose::{STANDARD, URL_SAFE_NO_PAD};
use serde_json::Value;
use zeroize::Zeroizing;

use super::js;
use super::keyring::SecretBytes;

/// 이보다 짧은 값(바이트)·바늘·글(UTF-16 칸)은 보지 않는다 — 짧은 값은 정상 글에 우연히 나온다.
pub(crate) const LEAK_MIN_CHARS: usize = 8;
/// 여러 줄 값의 줄 단위 바늘 하한(UTF-16 칸).
pub(crate) const LINE_MIN_CHARS: usize = 16;

/// 거절은 고정 문장이다(TS `SECRET_IN_BODY`).
pub(crate) const SECRET_IN_BODY_CODE: &str = "secret_in_body";
pub(crate) const SECRET_IN_BODY_MESSAGE: &str = "refused: the content contains the value of a secret you were granted. Do not write secret values; refer to the secret by name.";

#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct LeakHit {
    pub id: String,
    pub name: String,
}

/// 검사할 비밀 하나 — 값과 거기서 만든 바늘. `Debug` 는 hit 만 보인다.
pub(crate) struct LeakSecret {
    hit: LeakHit,
    needles: Vec<Zeroizing<String>>,
    raw: SecretBytes,
}

impl fmt::Debug for LeakSecret {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.debug_struct("LeakSecret")
            .field("hit", &self.hit)
            .finish_non_exhaustive()
    }
}

impl LeakSecret {
    pub(crate) fn new(hit: LeakHit, value: SecretBytes) -> Self {
        let needles = needles_for(value.as_bytes());
        Self {
            hit,
            needles,
            raw: value,
        }
    }
}

/// TS `needlesFor` — 같은 순서(삽입 순서, 겹치면 앞의 것)로 만든다.
pub(crate) fn needles_for(value: &[u8]) -> Vec<Zeroizing<String>> {
    // 하한은 값 자체에 건다 — 짧은 값의 base64 는 8자를 넘겨도 우연히 나올 만큼 짧다.
    if value.len() < LEAK_MIN_CHARS {
        return Vec::new();
    }
    let mut out: Vec<Zeroizing<String>> = Vec::new();
    let push = |out: &mut Vec<Zeroizing<String>>, s: Zeroizing<String>, min: usize| {
        if js::len16(&s) >= min && !out.iter().any(|n| **n == *s) {
            out.push(s);
        }
    };
    let b64 = Zeroizing::new(STANDARD.encode(value));
    let unpadded = Zeroizing::new(b64.trim_end_matches('=').to_owned());
    push(&mut out, b64, LEAK_MIN_CHARS);
    push(&mut out, unpadded, LEAK_MIN_CHARS);
    push(
        &mut out,
        Zeroizing::new(URL_SAFE_NO_PAD.encode(value)),
        LEAK_MIN_CHARS,
    );
    // 잘못된 UTF-8 이면 평문 바늘을 만들지 않는다(TS: 대체 문자가 섞인 글자는 어디에도 그대로 나오지 않는다).
    if let Ok(text) = std::str::from_utf8(value) {
        push(&mut out, Zeroizing::new(text.to_owned()), LEAK_MIN_CHARS);
        let trimmed = js::trim(text);
        push(&mut out, Zeroizing::new(trimmed.to_owned()), LEAK_MIN_CHARS);
        push(
            &mut out,
            Zeroizing::new(js::encode_uri_component(trimmed)),
            LEAK_MIN_CHARS,
        );
        if trimmed.contains('\n') {
            // `/\r?\n/` 로 나눈다: `\n` 앞의 `\r` 하나만 떼고, 외톨이 `\r` 은 줄 안에 남는다.
            for line in trimmed.split('\n') {
                let line = line.strip_suffix('\r').unwrap_or(line);
                push(
                    &mut out,
                    Zeroizing::new(js::trim(line).to_owned()),
                    LINE_MIN_CHARS,
                );
            }
        }
    }
    out
}

/// TS `collectStrings` — 문자열을 전부 모은다(객체 키도). 깊이 32 를 넘으면 더 내려가지 않는다.
pub(crate) fn collect_strings(value: &Value) -> Vec<&str> {
    fn walk<'a>(v: &'a Value, out: &mut Vec<&'a str>, depth: usize) {
        if depth > 32 {
            return;
        }
        match v {
            Value::String(s) => out.push(s),
            Value::Array(a) => a.iter().for_each(|x| walk(x, out, depth + 1)),
            Value::Object(o) => {
                for (k, x) in o {
                    out.push(k);
                    walk(x, out, depth + 1);
                }
            }
            _ => {}
        }
    }
    let mut out = Vec::new();
    walk(value, &mut out, 0);
    out
}

/// TS `findInTexts` — 8칸 이상인 글 가운데 하나라도 어느 바늘을 품으면 그 비밀이 걸린다. 비밀 순서를 지킨다.
pub(crate) fn find_in_texts(secrets: &[LeakSecret], texts: &[&str]) -> Vec<LeakHit> {
    let hay: Vec<&str> = texts
        .iter()
        .copied()
        .filter(|t| js::len16(t) >= LEAK_MIN_CHARS)
        .collect();
    if hay.is_empty() {
        return Vec::new();
    }
    secrets
        .iter()
        .filter(|s| {
            s.needles
                .iter()
                .any(|n| hay.iter().any(|h| h.contains(n.as_str())))
        })
        .map(|s| s.hit.clone())
        .collect()
}

/// TS `findInBytes` — 값 바이트 그대로(8바이트 이상일 때) 또는 바늘의 UTF-8 바이트가 들어 있으면 걸린다.
pub(crate) fn find_in_bytes(secrets: &[LeakSecret], bytes: &[u8]) -> Vec<LeakHit> {
    if bytes.len() < LEAK_MIN_CHARS {
        return Vec::new();
    }
    secrets
        .iter()
        .filter(|s| {
            let raw = s.raw.as_bytes();
            (raw.len() >= LEAK_MIN_CHARS && contains(bytes, raw))
                || s.needles.iter().any(|n| contains(bytes, n.as_bytes()))
        })
        .map(|s| s.hit.clone())
        .collect()
}

fn contains(hay: &[u8], needle: &[u8]) -> bool {
    !needle.is_empty() && hay.windows(needle.len()).any(|w| w == needle)
}
