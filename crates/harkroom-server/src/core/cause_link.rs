//! S5.3 C1c-4c — 에이전트 글의 **원인 입력**. MCP 발화는 턴의 원인(`X-Harkroom-Cause`)·턴 id 를 싣고 오고, TS `postMessage` 는 그것으로
//! 사슬 고리를 적고(`verifiedCauseLink`), principal·위임을 잇는다(`principalForAgentPost`·
//! `causeReasonsFor`·`mandateForAgentPost`). 발화가 실어 온 모델은 설정과 견준다(`reportedModelMeta`). 여기는 그 포트다 —
//! 문장은 전부 TS 상수를 골든(`sql_fragments.json` 의 `cause_*`·`effective_model`)으로 받는다.
//!
//! 시각은 TS 가 `Date` 를 넘기는 것과 같게 밀리초 ISO 글자로 `::timestamptz` 에 넣는다([`super::msg_post`] 의 `iso_ms`).
use serde_json::{Map, Value, json};
use std::sync::OnceLock;

/// TS `CAUSE_LINK_FRESH_MS` — 사슬 고리로 저장할 수 있는 원인의 신선도.
pub const CAUSE_LINK_FRESH_MS: i64 = 60 * 60_000;

/// TS `MODEL_ID_MAX`.
pub const MODEL_ID_MAX: usize = 120;

/// TS `MODEL_FAMILIES` — 아는 계열(순서대로 처음 맞는 것).
const MODEL_FAMILIES: &[&str] = &["opus", "sonnet", "haiku", "fable", "gpt", "codex", "gemini"];

struct Sql {
    verified: String,
    principal: String,
    reasons: String,
    mandate: String,
    effective_model: String,
}

fn sql() -> &'static Sql {
    static S: OnceLock<Sql> = OnceLock::new();
    S.get_or_init(|| {
        let v: Value = serde_json::from_str(include_str!("../../golden/sql_fragments.json"))
            .expect("golden/sql_fragments.json");
        let frag = |k: &str| {
            v[k].as_str()
                .unwrap_or_else(|| panic!("golden fragment {k}"))
                .to_string()
        };
        Sql {
            verified: frag("cause_verified_link"),
            principal: frag("cause_principal"),
            reasons: frag("cause_reasons"),
            mandate: frag("cause_mandate"),
            effective_model: frag("effective_model"),
        }
    })
}

/// TS `verifiedCauseLink` — 그 원인이 이 작성자에게 최근(60분) inbox 를 만들었고 지워지지 않았을 때만 그 id.
pub async fn verified_cause_link(
    conn: &mut sqlx::PgConnection,
    author: &str,
    cause: &str,
    now_ms: i64,
    iso: fn(i64) -> String,
) -> Result<Option<String>, sqlx::Error> {
    sqlx::query_scalar(sql().verified.as_str())
        .bind(cause)
        .bind(author)
        .bind(iso(now_ms - CAUSE_LINK_FRESH_MS))
        .fetch_optional(&mut *conn)
        .await
}

/// TS `principalForAgentPost` — 그 원인으로 받은 **살아 있는 임대**의 principal(지금도 활성 사람일 때만).
pub async fn principal_for_agent_post(
    conn: &mut sqlx::PgConnection,
    agent: &str,
    cause: &str,
    now_ms: i64,
    iso: fn(i64) -> String,
) -> Result<Option<String>, sqlx::Error> {
    sqlx::query_scalar(sql().principal.as_str())
        .bind(agent)
        .bind(cause)
        .bind(iso(now_ms))
        .fetch_optional(&mut *conn)
        .await
}

/// TS `causeReasonsFor` — 그 원인 글로 이 에이전트에게 온 inbox 사유들(정렬·중복 없음).
pub async fn cause_reasons(
    conn: &mut sqlx::PgConnection,
    agent: &str,
    cause: &str,
) -> Result<Vec<String>, sqlx::Error> {
    sqlx::query_scalar(sql().reasons.as_str())
        .bind(agent)
        .bind(cause)
        .fetch_all(&mut *conn)
        .await
}

/// TS `mandateForAgentPost` — 그 원인으로 받은 살아 있는 임대의 위임(글쓴 에이전트의 지금 소유자가 위임 소유자와 같을 때만).
pub async fn mandate_for_agent_post(
    conn: &mut sqlx::PgConnection,
    agent: &str,
    cause: &str,
    now_ms: i64,
    iso: fn(i64) -> String,
) -> Result<Option<String>, sqlx::Error> {
    sqlx::query_scalar(sql().mandate.as_str())
        .bind(agent)
        .bind(cause)
        .bind(iso(now_ms))
        .fetch_optional(&mut *conn)
        .await
}

/// TS `modelFamily`.
fn model_family(id: Option<&str>) -> Option<&'static str> {
    let lower = id.filter(|s| !s.is_empty())?.to_lowercase();
    MODEL_FAMILIES.iter().copied().find(|f| lower.contains(f))
}

/// TS `modelsDisagree` — 둘 다 계열을 알아볼 수 있고 다를 때만.
pub fn models_disagree(configured: Option<&str>, reported: Option<&str>) -> bool {
    match (model_family(configured), model_family(reported)) {
        (Some(a), Some(b)) => a != b,
        _ => false,
    }
}

/// JS `String.prototype.trim` 이 벗기는 글자(WhiteSpace · LineTerminator). Rust `char::is_whitespace` 와 다르다
/// (JS 는 U+FEFF 를 벗기고 U+0085 는 남긴다).
pub(crate) fn js_trim_char(c: char) -> bool {
    matches!(
        c,
        '\t' | '\n' | '\u{b}' | '\u{c}' | '\r' | ' ' | '\u{a0}' | '\u{1680}' | '\u{2000}'
            ..='\u{200a}'
                | '\u{2028}'
                | '\u{2029}'
                | '\u{202f}'
                | '\u{205f}'
                | '\u{3000}'
                | '\u{feff}'
    )
}

/// 신고값을 TS 처럼 다듬는다(`trim().slice(0, MODEL_ID_MAX)` — JS `trim` 의 글자 집합, UTF-16 단위로 자른다).
/// 자른 자리가 서로게이트 쌍 한가운데면(JS 는 짝 잃은 서로게이트를 남겨 jsonb 가 거절한다) `None`(→ 부른 쪽이 TS 로
/// 넘긴다). 빈 값이면 `Some(None)`(meta 없음).
pub fn trimmed_model(raw: &str) -> Option<Option<String>> {
    let t = raw.trim_matches(js_trim_char);
    let mut units = 0;
    let mut end = t.len();
    for (i, c) in t.char_indices() {
        let w = c.len_utf16();
        if units + w > MODEL_ID_MAX {
            if units < MODEL_ID_MAX {
                return None;
            }
            end = i;
            break;
        }
        units += w;
    }
    let cut = &t[..end];
    Some((!cut.is_empty()).then(|| cut.to_owned()))
}

/// TS `reportedModelMeta` — `{ model: { id, mismatch? } }` 를 meta 에 얹는다. 신고값이 없으면 그대로.
pub async fn reported_model_meta(
    pool: &sqlx::PgPool,
    author: &str,
    id: Option<&str>,
    thread_root: Option<&str>,
    meta: &mut Map<String, Value>,
) -> Result<(), sqlx::Error> {
    let Some(id) = id else { return Ok(()) };
    let configured: Option<Option<String>> = sqlx::query_scalar(sql().effective_model.as_str())
        .bind(author)
        .bind(thread_root)
        .fetch_optional(pool)
        .await?;
    let model = if models_disagree(configured.flatten().as_deref(), Some(id)) {
        json!({ "id": id, "mismatch": true })
    } else {
        json!({ "id": id })
    };
    meta.insert("model".into(), model);
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn golden_loads() {
        let _ = sql();
    }

    /// O2 — 깊이를 물려받던 문장(`cause_depth`)을 걷어도 사슬 고리·principal·사유·위임 판정 문장은 한 글자도 바뀌지 않는다.
    /// 이 넷을 고치려면 여기 지문도 같이 고쳐야 한다(판정이 바뀐다는 뜻이다).
    #[test]
    fn cause_judgement_sql_is_pinned() {
        use sha2::{Digest, Sha256};
        let s = sql();
        for (name, text, want) in [
            (
                "cause_verified_link",
                &s.verified,
                "40523fddc443592038e8a1f811dff2cd955e2bd427fddcb5116b7549955739a6",
            ),
            (
                "cause_principal",
                &s.principal,
                "d3dd79991ece71ef2d2925745ab3c6b428469c7543c10b743f39b215ec9a44a7",
            ),
            (
                "cause_reasons",
                &s.reasons,
                "43f6248574b8d1c148fcbcaf313fdaf33c26bfb4faed4ddbc6404ca5eb55bb62",
            ),
            (
                "cause_mandate",
                &s.mandate,
                "c0297037fba69dcf4ec58aebe22ed1daaf0617955c39e56cfccc768b96f51fe3",
            ),
        ] {
            assert_eq!(hex::encode(Sha256::digest(text.as_bytes())), want, "{name}");
        }
    }

    /// O2 — 서버가 쓰는 문장 어디에도 지울 칸·표가 남아 있지 않다(다음 릴리스에서 칸을 지워도 옛 pod 가 깨지지 않게).
    #[test]
    fn golden_does_not_touch_retired_columns() {
        let raw = include_str!("../../golden/sql_fragments.json");
        for gone in [
            "mention_depth",
            "stall_depth",
            "chain_started_at",
            "mention_policy",
            "chain_depth",
        ] {
            assert!(!raw.contains(gone), "golden sql still mentions {gone}");
        }
    }

    #[test]
    fn families_like_ts() {
        assert!(!models_disagree(None, Some("claude-opus-5")));
        assert!(!models_disagree(Some("opus"), Some("claude-opus-5[1m]")));
        assert!(models_disagree(Some("sonnet"), Some("claude-opus-5")));
        assert!(!models_disagree(Some("mystery"), Some("claude-opus-5")));
        assert!(!models_disagree(Some(""), Some("opus")));
        // TS 는 목록 순서대로 처음 맞는 계열을 고른다 — `gpt-codex` 는 gpt.
        assert!(!models_disagree(Some("gpt-5"), Some("gpt-codex")));
        assert!(models_disagree(Some("codex"), Some("gpt-codex")));
    }

    #[test]
    fn trim_like_ts() {
        assert_eq!(trimmed_model("  opus \n"), Some(Some("opus".into())));
        assert_eq!(trimmed_model(" \t "), Some(None));
        assert_eq!(trimmed_model(&"a".repeat(130)), Some(Some("a".repeat(120))));
        assert_eq!(trimmed_model("오푸스"), Some(Some("오푸스".into())));
        assert_eq!(
            trimmed_model("\u{a0}\u{feff}opus\u{3000}"),
            Some(Some("opus".into()))
        );
        // NEL(U+0085)은 JS `trim` 이 남긴다.
        assert_eq!(trimmed_model("\u{85}opus"), Some(Some("\u{85}opus".into())));
        assert_eq!(
            trimmed_model(&"가".repeat(130)),
            Some(Some("가".repeat(120)))
        );
        // 120 번째 UTF-16 단위가 서로게이트 쌍을 가르면 TS 로 넘긴다.
        assert_eq!(trimmed_model(&format!("{}😀", "a".repeat(119))), None);
        assert_eq!(
            trimmed_model(&format!("{}😀b", "a".repeat(118))),
            Some(Some(format!("{}😀", "a".repeat(118))))
        );
    }
}
