//! S5.3 C1c-4c — 에이전트 글의 **원인 입력**. MCP 발화는 턴의 원인(`X-Harkroom-Cause`)·턴 id 를 싣고 오고, TS `postMessage` 는 그것으로
//! 깊이를 물려받고(`causeDepth`), 사슬 고리를 적고(`verifiedCauseLink`), principal·위임을 잇는다(`principalForAgentPost`·
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
    depth: String,
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
            // 시각은 TS `Date` 처럼 밀리초로 자른다(사슬 시작을 옮겨 적고 백스톱 나이를 재는 값이다).
            depth: format!(
                "select c.depth::int, c.stall::int, c.author_is_agent, \
                 (extract(epoch from date_trunc('milliseconds', c.created_at)) * 1000)::bigint, \
                 (extract(epoch from date_trunc('milliseconds', c.chain_started_at)) * 1000)::bigint, \
                 c.from_automation, c.human_card from ({}) c",
                frag("cause_depth")
            ),
            verified: frag("cause_verified_link"),
            principal: frag("cause_principal"),
            reasons: frag("cause_reasons"),
            mandate: frag("cause_mandate"),
            effective_model: frag("effective_model"),
        }
    })
}

/// TS `ChainLink` — 원인에서 물려받은 앞 고리. `started_ms` 가 없으면 이 글이 사슬의 시작이다.
#[derive(Debug, PartialEq, Eq)]
pub struct CauseLink {
    pub depth: i32,
    pub prev_stall: i32,
    pub started_ms: Option<i64>,
}

/// TS `causeDepth` — 그 원인이 나를 실제로 깨웠을 때만(부름·사람 글의 답·사람이 누른 카드) 깊이를 물려받는다. 아니면 `None`
/// (→ 스레드 스캔, TS 와 같다).
pub async fn cause_depth(
    conn: &mut sqlx::PgConnection,
    author: &str,
    cause: &str,
) -> Result<Option<CauseLink>, sqlx::Error> {
    type Row = (i32, i32, bool, i64, Option<i64>, bool, bool);
    let row: Option<Row> = sqlx::query_as(sql().depth.as_str())
        .bind(cause)
        .bind(author)
        .fetch_optional(&mut *conn)
        .await?;
    Ok(row.map(
        |(depth, stall, author_is_agent, created, chain_started, from_automation, human_card)| {
            if human_card {
                CauseLink {
                    depth: 1,
                    prev_stall: 0,
                    started_ms: None,
                }
            } else if author_is_agent || from_automation {
                CauseLink {
                    depth: depth + 1,
                    prev_stall: stall,
                    started_ms: Some(chain_started.unwrap_or(created)),
                }
            } else {
                CauseLink {
                    depth: 1,
                    prev_stall: 0,
                    started_ms: Some(created),
                }
            }
        },
    ))
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

/// 신고값을 TS 처럼 다듬는다(`trim().slice(0, MODEL_ID_MAX)`). JS 의 `trim`·UTF-16 자르기와 같게 다룰 수 있는 **ASCII 만** 받는다 —
/// 그 밖은 `None`(→ 부른 쪽이 TS 로 넘긴다). 빈 값이면 `Some(None)`(meta 없음).
pub fn trimmed_model(raw: &str) -> Option<Option<String>> {
    if !raw.is_ascii() {
        return None;
    }
    // ASCII 안에서 JS WhiteSpace·LineTerminator 는 \t \n \v \f \r 공백이다.
    let t = raw.trim_matches(|c: char| matches!(c, '\t' | '\n' | '\u{b}' | '\u{c}' | '\r' | ' '));
    let cut = &t[..t.len().min(MODEL_ID_MAX)];
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
        assert_eq!(trimmed_model("오푸스"), None);
        assert_eq!(trimmed_model("\u{a0}opus"), None);
    }
}
