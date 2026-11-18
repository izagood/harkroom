//! S5.4 통합 — MCP `grant.delegate`(외부 API 권한 위임 P5). TS `mcpPlugin.ts` 의 같은 도구와
//! `services/apiDelegation.ts::delegateApiGrant` 의 **앞머리**만 옮긴다(WIP):
//! 인자(zod) → `not_agent` → 연결 이름 조회(`no_connector`) → 준 쪽의 `api.call` 줄(`not_granted`).
//! 거절은 TS 처럼 `audit_log` 에 `grant.delegate.denied` 한 줄을 남기고 `{error:{code,message:code}}` 로 답한다.
//!
//! - **TS 로 넘기는 것**(`None`): zod 가 받지 않을 인자 · 준 쪽 줄이 있고 범위가 있는 경우 전부(사슬 판정 `apiGrantFor`·
//!   범위·만료·대상·L1·하루 상한·원인·INSERT·시스템 줄은 아직 TS 몫) · DB 오류 · 감사 줄 INSERT 실패.
//!   넘기기 전에 Rust 가 쓴 것은 없다(감사 줄은 거절 답과 함께만 쓴다).
//! - 쓰기 칸은 `audit_log` INSERT 네 칸뿐이다.
use super::tools::err;
use crate::auth::Account;
use serde_json::Value;
use sqlx::PgPool;

/// 쓰기 풀에 이 권한이 다 있을 때만 Rust 가 답한다(`main.rs`). 연결·준 쪽 줄 판정은 읽기 풀로 한다.
pub const GRANT_DELEGATE_PRIVILEGES: &[(&str, &str)] = &[
    ("audit_log.action", "INSERT"),
    ("audit_log.actor_id", "INSERT"),
    ("audit_log.target", "INSERT"),
    ("audit_log.detail", "INSERT"),
];

const CONNECTOR_SQL: &str = "select id::text from api_connector where name = $1";
/// TS `parent` 조회 중 `!parent || !parent.limits` 판정에 쓰는 것만.
const PARENT_SQL: &str = "select (limits is not null) from account_grant \
     where account_id = $1::uuid and capability = 'api.call' and scope = $2";
const AUDIT_SQL: &str = "insert into audit_log (action, actor_id, target, detail) \
     values ('grant.delegate.denied', $1::uuid, $2, $3::jsonb)";

const METHODS: [&str; 5] = ["GET", "POST", "PUT", "PATCH", "DELETE"];

/// zod 가 받는 인자 중 여기서 쓰는 칸 — 나머지 칸도 모양은 다 본다(받지 않을 인자는 TS 가 답한다).
#[derive(Debug, PartialEq)]
struct Args {
    to: String,
    connector: String,
}

fn utf16_len(s: &str) -> usize {
    s.encode_utf16().count()
}

/// `/^[a-z0-9][a-z0-9_-]{0,63}$/`
fn connector_ok(s: &str) -> bool {
    let b = s.as_bytes();
    !b.is_empty()
        && b.len() <= 64
        && (b[0].is_ascii_lowercase() || b[0].is_ascii_digit())
        && b[1..]
            .iter()
            .all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || *c == b'_' || *c == b'-')
}

fn parse(args: &Value) -> Option<Args> {
    let o = args.as_object()?;
    let to = o.get("to")?.as_str()?;
    if !(1..=64).contains(&utf16_len(to)) {
        return None;
    }
    let connector = o.get("connector")?.as_str()?;
    if !connector_ok(connector) {
        return None;
    }
    let methods = o.get("methods")?.as_array()?;
    if !(1..=5).contains(&methods.len())
        || !methods
            .iter()
            .all(|m| m.as_str().is_some_and(|m| METHODS.contains(&m)))
    {
        return None;
    }
    let path = o.get("pathPrefix")?.as_str()?;
    if !(1..=300).contains(&utf16_len(path)) {
        return None;
    }
    // 정수 칸 — `2.0` 같은 소수 꼴은 TS 에 맡긴다.
    let days = o.get("days")?.as_i64()?;
    if !(1..=30).contains(&days) {
        return None;
    }
    match o.get("delegateDepth") {
        None => {}
        Some(v) => {
            let d = v.as_i64()?;
            if !(0..=1).contains(&d) {
                return None;
            }
        }
    }
    match o.get("writeNeedsHumanCause") {
        None | Some(Value::Bool(_)) => {}
        Some(_) => return None,
    }
    Some(Args {
        to: to.to_owned(),
        connector: connector.to_owned(),
    })
}

pub async fn answer(read: &PgPool, write: &PgPool, me: &Account, args: &Value) -> Option<String> {
    let a = parse(args)?;
    if me.kind != "agent" {
        return Some(err("not_agent", "only agents delegate"));
    }
    let conn: Option<String> = sqlx::query_scalar(CONNECTOR_SQL)
        .bind(&a.connector)
        .fetch_optional(read)
        .await
        .ok()?;
    let Some(conn) = conn else {
        return deny(write, me, &a, "no_connector").await;
    };
    let scope = format!("connector:{conn}");
    let parent: Option<bool> = sqlx::query_scalar(PARENT_SQL)
        .bind(&me.id)
        .bind(&scope)
        .fetch_optional(read)
        .await
        .ok()?;
    if parent != Some(true) {
        return deny(write, me, &a, "not_granted").await;
    }
    // 사슬 판정부터는 아직 TS 몫이다.
    None
}

/// TS `deny` — 감사 줄(target = 연결 이름, detail = {code, to}) 뒤 `{error:{code, message: code}}`.
async fn deny(write: &PgPool, me: &Account, a: &Args, code: &'static str) -> Option<String> {
    let detail = serde_json::json!({ "code": code, "to": a.to });
    sqlx::query(AUDIT_SQL)
        .bind(&me.id)
        .bind(&a.connector)
        .bind(detail.to_string())
        .execute(write)
        .await
        .ok()?;
    Some(err(code, code))
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn ok() -> Value {
        json!({ "to": "@bot", "connector": "gh-api", "methods": ["GET"], "pathPrefix": "/repos", "days": 7 })
    }

    #[test]
    fn parse_matches_zod() {
        assert_eq!(
            parse(&ok()),
            Some(Args {
                to: "@bot".into(),
                connector: "gh-api".into()
            })
        );
        let bad = |k: &str, v: Value| {
            let mut o = ok();
            o[k] = v;
            assert!(parse(&o).is_none(), "{k}");
        };
        bad("to", json!(""));
        bad("connector", json!("Gh"));
        bad("connector", json!("-x"));
        bad("methods", json!([]));
        bad("methods", json!(["HEAD"]));
        bad("pathPrefix", json!(""));
        bad("days", json!(0));
        bad("days", json!(31));
        bad("days", json!(1.5));
        bad("delegateDepth", json!(2));
        bad("writeNeedsHumanCause", json!("yes"));
        assert!(parse(&json!([])).is_none());
        let mut o = ok();
        o["delegateDepth"] = json!(1);
        o["writeNeedsHumanCause"] = json!(true);
        o["extra"] = json!(1);
        assert!(parse(&o).is_some());
    }

    #[test]
    fn writes_only_audit_log() {
        assert!(
            GRANT_DELEGATE_PRIVILEGES
                .iter()
                .all(|(c, p)| c.starts_with("audit_log.") && *p == "INSERT")
        );
        assert!(!AUDIT_SQL.to_lowercase().contains("returning"));
    }
}
