//! S5.4 통합 — 오퍼레이터가 가로채는 도구(`secret.mount`·`secret.generate`·`secret.import`·`secret.rotate`·`attachment.upload`·
//! `pr.status`). TS `mcpPlugin.ts` 는 이 도구들을 `tools/list` 에 보이게 하려고만 등록하고, 서버까지 온 호출에는 늘 같은
//! `operator_required` 오류를 돌려준다(오퍼레이터를 거치지 않은 PAT 러너이거나 옛 오퍼레이터). 서버는 비밀 값·gh 자격·턴
//! 워크스페이스 파일 어느 것에도 닿지 않는다 — Rust 도 DB 를 읽지 않고 같은 글자만 낸다.
//!
//! 인자 검증: SDK 는 zod 검증을 먼저 하고, 틀리면 핸들러에 오지 않고 `Input validation error: …` 를 낸다. 그 글자는 TS 가
//! 정본이므로 여기서는 **zod 가 받는 모양만** 받고 나머지(빠진 칸·`null`·범위 밖·소수)는 `None` 으로 TS 에 넘긴다. 길이는 JS
//! `String.length` 처럼 UTF-16 단위로 센다. `z.object` 는 모르는 키를 버리므로 더 붙은 키는 받는다.
use serde_json::{Map, Value};

pub const SERVED: &[&str] = &[
    "secret.mount",
    "secret.generate",
    "secret.import",
    "secret.rotate",
    "attachment.upload",
    "pr.status",
];

const GEN_TYPES: &[&str] = &["password", "token_hex", "token_base64url", "ssh_ed25519"];

/// `z.string().min(lo).max(hi)`.
fn str_len(o: &Map<String, Value>, key: &str, lo: usize, hi: usize) -> Option<()> {
    let n = o.get(key)?.as_str()?.encode_utf16().count();
    (lo..=hi).contains(&n).then_some(())
}

/// `.optional()` 를 붙인 칸 — 없으면 통과, 있으면 `check` 가 맞아야 한다(`null` 은 zod optional 이 받지 않는다).
fn opt(o: &Map<String, Value>, key: &str, check: impl Fn(&Value) -> bool) -> Option<()> {
    match o.get(key) {
        None => Some(()),
        Some(v) => check(v).then_some(()),
    }
}

fn opt_str_len(o: &Map<String, Value>, key: &str, lo: usize, hi: usize) -> Option<()> {
    opt(o, key, |v| {
        v.as_str()
            .is_some_and(|s| (lo..=hi).contains(&s.encode_utf16().count()))
    })
}

/// `z.number().int()`(범위 없음) — 정수 꼴 JSON 숫자만. 소수 꼴(`3.0`)은 TS 로 넘긴다(보수적으로).
fn is_int(v: &Value) -> bool {
    v.is_i64() || v.is_u64()
}

fn is_int_in(v: &Value, lo: i64, hi: i64) -> bool {
    super::tools::js_int(v).is_some_and(|n| (lo..=hi).contains(&n))
}

fn is_enum(v: &Value, set: &[&str]) -> bool {
    v.as_str().is_some_and(|s| set.contains(&s))
}

/// `genSpec` = `z.object({ type: enum, length: z.number().int().optional() })`.
fn gen_spec(v: &Value) -> bool {
    let Some(o) = v.as_object() else { return false };
    o.get("type").is_some_and(|t| is_enum(t, GEN_TYPES)) && opt(o, "length", is_int).is_some()
}

/// `^[A-Za-z0-9][A-Za-z0-9._-]{0,99}\/[A-Za-z0-9._-]{1,100}$`.
fn repo_ok(s: &str) -> bool {
    let tail = |c: u8| c.is_ascii_alphanumeric() || matches!(c, b'.' | b'_' | b'-');
    let Some((owner, name)) = s.split_once('/') else {
        return false;
    };
    let ob = owner.as_bytes();
    let nb = name.as_bytes();
    !ob.is_empty()
        && ob.len() <= 100
        && ob[0].is_ascii_alphanumeric()
        && ob[1..].iter().all(|&c| tail(c))
        && (1..=100).contains(&nb.len())
        && nb.iter().all(|&c| tail(c))
}

/// zod 가 받는 모양인가.
fn valid(tool: &str, args: &Value) -> Option<()> {
    let o = args.as_object()?;
    match tool {
        "secret.mount" => str_len(o, "name", 1, 64),
        "secret.generate" => {
            str_len(o, "name", 1, 64)?;
            opt_str_len(o, "description", 0, 500)?;
            o.get("type").filter(|t| is_enum(t, GEN_TYPES))?;
            opt(o, "length", is_int)?;
            opt(o, "expiresInDays", |v| is_int_in(v, 1, 365))?;
            opt(o, "mount", Value::is_boolean)
        }
        "secret.import" => {
            str_len(o, "name", 1, 64)?;
            str_len(o, "path", 1, 4096)?;
            opt(o, "kind", |v| is_enum(v, &["text", "file"]))?;
            opt_str_len(o, "description", 0, 500)?;
            opt(o, "expiresInDays", |v| is_int_in(v, 1, 365))?;
            opt(o, "keepSource", Value::is_boolean)
        }
        "secret.rotate" => {
            str_len(o, "name", 1, 64)?;
            opt(o, "generate", gen_spec)?;
            opt_str_len(o, "path", 1, 4096)
        }
        "attachment.upload" => {
            str_len(o, "path", 1, 4096)?;
            opt_str_len(o, "filename", 1, 255)
        }
        "pr.status" => {
            o.get("repo")?.as_str().filter(|s| repo_ok(s))?;
            // `z.number().int().positive()`
            o.get("number")?.as_u64().filter(|n| *n > 0).map(|_| ())
        }
        _ => None,
    }
}

/// 도구 하나의 답. 이 목록의 도구가 아니거나 모양이 zod 와 다르면 `None`(→ TS).
pub fn answer(tool: &str, args: &Value) -> Option<String> {
    if !SERVED.contains(&tool) {
        return None;
    }
    valid(tool, args)?;
    Some(super::tools::err(
        "operator_required",
        &format!(
            "{tool} is handled by the harkroom operator; this runner is not connected through one that supports it"
        ),
    ))
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn answers_operator_required_like_ts() {
        let r = answer("secret.mount", &json!({"name":"gh"})).unwrap();
        assert!(r.contains(r#"\"code\":\"operator_required\""#), "{r}");
        assert!(r.contains("secret.mount is handled by the harkroom operator; this runner is not connected through one that supports it"));
        assert!(
            answer(
                "pr.status",
                &json!({"repo":"izagood/harkroom","number":2352})
            )
            .is_some()
        );
        assert!(answer("attachment.upload", &json!({"path":"a.png","extra":1})).is_some());
        assert!(
            answer(
                "secret.rotate",
                &json!({"name":"x","generate":{"type":"password"}})
            )
            .is_some()
        );
        assert!(
            answer(
                "secret.generate",
                &json!({"name":"x","type":"token_hex","length":32,"mount":true})
            )
            .is_some()
        );
        assert!(
            answer(
                "secret.import",
                &json!({"name":"x","path":"/p","kind":"file","expiresInDays":30})
            )
            .is_some()
        );
    }

    #[test]
    fn hands_bad_shapes_to_ts() {
        for (t, a) in [
            ("secret.mount", json!({})),
            ("secret.mount", json!({"name":""})),
            ("secret.mount", json!({"name":"a".repeat(65)})),
            ("secret.mount", json!(null)),
            ("secret.generate", json!({"name":"x","type":"rsa"})),
            (
                "secret.generate",
                json!({"name":"x","type":"password","length":1.5}),
            ),
            (
                "secret.generate",
                json!({"name":"x","type":"password","mount":null}),
            ),
            (
                "secret.import",
                json!({"name":"x","path":"/p","expiresInDays":0}),
            ),
            (
                "secret.rotate",
                json!({"name":"x","generate":{"type":"nope"}}),
            ),
            ("attachment.upload", json!({"path":"a","filename":""})),
            ("pr.status", json!({"repo":"-bad/x","number":1})),
            ("pr.status", json!({"repo":"a/b","number":0})),
            ("pr.status", json!({"repo":"a/b","number":-1})),
            ("pr.status", json!({"repo":"a/b/c","number":1})),
            ("message.post", json!({})),
        ] {
            assert!(answer(t, &a).is_none(), "{t} {a}");
        }
    }

    #[test]
    fn counts_utf16_like_js() {
        // 이모지 하나 = UTF-16 2 단위. 32개면 64 → 통과, 33개면 66 → TS.
        assert!(answer("secret.mount", &json!({"name":"😀".repeat(32)})).is_some());
        assert!(answer("secret.mount", &json!({"name":"😀".repeat(33)})).is_none());
    }

    #[test]
    fn message_matches_ts_source() {
        let src = include_str!("../../../../../packages/server/src/mcp/mcpPlugin.ts");
        assert!(src.contains("error: { code: 'operator_required', message: `${tool} is handled by the harkroom operator; this runner is not connected through one that supports it` },"));
        for t in [
            "secret.generate",
            "secret.import",
            "secret.rotate",
            "pr.status",
        ] {
            assert!(src.contains(&format!("operatorOnly('{t}')")), "{t}");
        }
        for t in ["secret.mount", "attachment.upload"] {
            assert!(src.contains(&format!("message: '{t} is handled by the harkroom operator; this runner is not connected through one that supports it'")), "{t}");
        }
        assert!(src.contains("repo: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._-]{0,99}\\/[A-Za-z0-9._-]{1,100}$/).describe('owner/name'),"));
    }
}
