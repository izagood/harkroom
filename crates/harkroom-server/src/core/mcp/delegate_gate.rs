//! S5.3 C3b-2c-4a — MCP `message.delegate` 의 **게이트·상한**(거절 갈래)만 Rust 가 답한다. TS `mcp/mcpPlugin.ts` 의 같은 도구를
//! 위에서부터 옮긴다: 채널 가시성 → 자기 위임 → 팀장 명단 → 에이전트만 → 호출 게이트(`openDelegationTargets`) → 라운드 상한(`roundsUsed`).
//!
//! - Rust 가 답하는 것: `forbidden` · `self_delegation` · `not_agent` · `not_invokable` · `round_limit` — 모두 **아무것도 쓰지 않는** 거절이다.
//! - **TS 로 넘기는 것**(`None` — fail-closed): 게이트·상한을 다 지난 요청(접속 확인·글·위임 행·이벤트는 다음 PR) · 팀장이 자기 팀에
//!   넘기는 요청(팀 명단 갈래) · `agentModels`·`planRootId`·`planGroupId`(모델 고르기·계획판) · zod 가 받지 않을 인자 · DB 오류.
//! - 접속 확인(presence)은 이 PR 에서 읽지 않는다 — 모두 거절 전에 끝나므로 TS 메모리와 DB(`agent_presence`) 사이의 지연이 닿지 않는다.
use super::tools::err;
use crate::auth::Account;
use crate::core::invoke_gate::{self, Ctx, Via};
use crate::core::msg_edit::MAX_MESSAGE_BODY_CHARS;
use crate::core::msg_read::{channel_visible, is_uuid};
use serde_json::Value;
use sqlx::PgPool;
use std::collections::HashMap;
use std::sync::OnceLock;

/// TS `TEAM_ROUND_LIMIT`(shared).
const TEAM_ROUND_LIMIT: i64 = 3;
/// TS `DELEGATION_DEADLINE_MIN_SEC`·`MAX_SEC`.
const DEADLINE_MIN: i64 = 60;
const DEADLINE_MAX: i64 = 6 * 60 * 60;

/// 문장(팀장 명단·대상·라운드)은 TS 상수를 골든으로 받는다(`golden/sql_fragments.json`).
struct Sql {
    lead_team: String,
    targets: String,
    rounds: String,
}

fn sql() -> &'static Sql {
    static S: OnceLock<Sql> = OnceLock::new();
    S.get_or_init(|| {
        let v: Value = serde_json::from_str(include_str!("../../../golden/sql_fragments.json"))
            .expect("golden/sql_fragments.json");
        let frag = |k: &str| {
            v[k].as_str()
                .unwrap_or_else(|| panic!("golden fragment {k}"))
                .to_string()
        };
        Sql {
            lead_team: frag("delegate_lead_team"),
            targets: frag("delegate_targets"),
            rounds: frag("delegate_rounds_used"),
        }
    })
}

#[derive(Debug, PartialEq, Eq)]
struct Args {
    channel: String,
    root: String,
    to: Vec<String>,
}

/// zod `message.delegate` 의 `inputSchema` 중 Rust 가 맡는 것. 틀린 꼴·`agentModels`·계획판 칸은 `None`.
fn parse(args: &Value) -> Option<Args> {
    let Value::Object(o) = args else { return None };
    for k in ["agentModels", "planRootId", "planGroupId"] {
        if o.contains_key(k) {
            return None;
        }
    }
    let uuid = |k: &str| o.get(k)?.as_str().filter(|s| is_uuid(s)).map(str::to_owned);
    let channel = uuid("channelId")?;
    let root = uuid("threadRootId")?;
    let n = o.get("body")?.as_str()?.encode_utf16().count();
    if n == 0 || n > MAX_MESSAGE_BODY_CHARS {
        return None;
    }
    let Value::Array(a) = o.get("to")? else {
        return None;
    };
    if a.is_empty() || a.len() > 8 {
        return None;
    }
    let mut to = Vec::with_capacity(a.len());
    for x in a {
        let h = x.as_str()?;
        let n = h.encode_utf16().count();
        if n == 0 || n > 64 {
            return None;
        }
        to.push(h.to_owned());
    }
    match o.get("deadlineSec") {
        None => {}
        Some(Value::Number(d))
            if d.as_i64()
                .is_some_and(|d| (DEADLINE_MIN..=DEADLINE_MAX).contains(&d)) => {}
        _ => return None,
    }
    match o.get("model") {
        None => {}
        Some(Value::String(m))
            if (1..=crate::core::cause_link::MODEL_ID_MAX).contains(&m.encode_utf16().count()) => {}
        _ => return None,
    }
    Some(Args { channel, root, to })
}

/// TS `leadTeamFor` 가 팀을 찾는가 — 한 팀이 `to` 전원을 담으면 팀 명단 갈래(TS 몫)다.
fn lead_team_covers(rows: &[(String, String)], wanted: &[String]) -> bool {
    let mut by_team: HashMap<&str, Vec<&str>> = HashMap::new();
    for (t, h) in rows {
        by_team.entry(t.as_str()).or_default().push(h.as_str());
    }
    by_team
        .values()
        .any(|hs| wanted.iter().all(|w| hs.contains(&w.as_str())))
}

/// `message.delegate` — 거절이면 그 글자, 그 밖은 `None`(TS 가 같은 요청을 돈다).
pub async fn answer(pool: &PgPool, me: &Account, args: &Value) -> Option<String> {
    let a = parse(args)?;
    match channel_visible(pool, &me.id, &a.channel).await {
        Ok(true) => {}
        Ok(false) => return Some(err("forbidden", "not a member of this dm channel")),
        Err(_) => return None,
    }
    // TS `h.toLowerCase() === account.handle.toLowerCase()` — ASCII 밖 handle 은 JS 소문자 규칙을 맞추지 않고 넘긴다.
    if !me.handle.is_ascii() || a.to.iter().any(|h| !h.is_ascii()) {
        return None;
    }
    let mine = me.handle.to_ascii_lowercase();
    let wanted: Vec<String> = a.to.iter().map(|h| h.to_ascii_lowercase()).collect();
    if wanted.contains(&mine) {
        return Some(err("self_delegation", "you cannot delegate to yourself"));
    }
    // TS `leadTeamFor` — (팀, handle, 계정, 꺼짐). handle 은 TS 처럼 읽은 뒤 소문자로.
    let rows: Vec<(String, String, String, bool)> = sqlx::query_as(&*sql().lead_team)
        .bind(&me.id)
        .fetch_all(pool)
        .await
        .ok()?;
    let team: Vec<(String, String)> = rows
        .into_iter()
        .map(|(t, h, _, _)| (t, h.to_lowercase()))
        .collect();
    if lead_team_covers(&team, &wanted) {
        return None;
    }
    if me.kind != "agent" {
        return Some(err("not_agent", "only agents delegate"));
    }
    let mut conn = pool.acquire().await.ok()?;
    let rows: Vec<(String, String, bool)> = sqlx::query_as(&*sql().targets)
        .bind(&wanted)
        .fetch_all(&mut *conn)
        .await
        .ok()?;
    let by_handle: HashMap<&str, &str> = rows
        .iter()
        .map(|(id, h, _)| (h.as_str(), id.as_str()))
        .collect();
    let ids: Vec<String> = rows.iter().map(|(id, _, _)| id.clone()).collect();
    let facts = invoke_gate::invoke_facts(&mut conn, &ids).await.ok()?;
    let ctx = Ctx {
        caller_id: &me.id,
        channel_id: &a.channel,
        via: Via::Mention,
        reply_grant_thread_id: None,
    };
    let mut refused: Vec<String> = Vec::new();
    for (i, h) in wanted.iter().enumerate() {
        let fact = by_handle.get(h.as_str()).and_then(|id| facts.get(*id));
        let ok = match fact {
            Some(f) => invoke_gate::may_invoke(&mut conn, f, &ctx).await.ok()?,
            None => false,
        };
        if !ok {
            refused.push(a.to[i].clone());
        }
    }
    drop(conn);
    if !refused.is_empty() {
        let msg = format!(
            "cannot delegate to: {} — not an agent you may invoke",
            refused.join(", ")
        );
        // TS `jsonResult({ error: { code, message, handles } })` — 키 순서 그대로.
        let body = format!(
            "{{\"error\":{{\"code\":\"not_invokable\",\"message\":{},\"handles\":{}}}}}",
            Value::from(msg),
            Value::from(refused)
        );
        return Some(super::respond::text_result(&body));
    }
    // TS `roundsUsed` = `roundsUsedMany` 에 한 쌍 — (순번, 수) 한 줄.
    let (_, used): (i32, i32) = sqlx::query_as(&*sql().rounds)
        .bind(vec![a.root.clone()])
        .bind(vec![me.id.clone()])
        .fetch_one(pool)
        .await
        .ok()?;
    let used = i64::from(used);
    if used >= TEAM_ROUND_LIMIT {
        return Some(err(
            "round_limit",
            &format!(
                "이 스레드에서 이미 {used}번 넘겼다(상한 {TEAM_ROUND_LIMIT}) — 직접 하거나 사람에게 넘겨라"
            ),
        ));
    }
    // 게이트·상한을 다 지났다 — 접속 확인·글·위임 행은 아직 TS 몫이다.
    None
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn golden_sql_loads() {
        let s = sql();
        assert!(s.lead_team.contains("agent_team_member"));
        assert!(s.targets.contains("lower(handle) = any($1::text[])"));
        assert!(s.rounds.contains("with ordinality"));
    }

    const C: &str = "11111111-1111-1111-1111-111111111111";
    const R: &str = "22222222-2222-2222-2222-222222222222";

    #[test]
    fn parse_like_zod() {
        let ok = json!({ "channelId": C, "threadRootId": R, "body": "해 줘", "to": ["Bot"], "deadlineSec": 600, "model": "m" });
        assert_eq!(parse(&ok).unwrap().to, vec!["Bot".to_owned()]);
        for bad in [
            json!({ "channelId": C, "body": "x", "to": ["a"] }),
            json!({ "channelId": C, "threadRootId": R, "body": "", "to": ["a"] }),
            json!({ "channelId": C, "threadRootId": R, "body": "x", "to": [] }),
            json!({ "channelId": C, "threadRootId": R, "body": "x", "to": ["a"], "deadlineSec": 59 }),
            json!({ "channelId": C, "threadRootId": R, "body": "x", "to": ["a"], "deadlineSec": 1.5 }),
            json!({ "channelId": C, "threadRootId": R, "body": "x", "to": ["a"], "agentModels": [] }),
            json!({ "channelId": C, "threadRootId": R, "body": "x", "to": ["a"], "planRootId": R }),
            json!({ "channelId": C, "threadRootId": R, "body": "x", "to": ["a"], "planGroupId": "g1" }),
            json!({ "channelId": C, "threadRootId": R, "body": "x", "to": ["a","a","a","a","a","a","a","a","a"] }),
        ] {
            assert_eq!(parse(&bad), None, "{bad}");
        }
    }

    #[test]
    fn lead_team_needs_one_team_with_all() {
        let rows = vec![
            ("t1".to_owned(), "a".to_owned()),
            ("t1".to_owned(), "b".to_owned()),
            ("t2".to_owned(), "c".to_owned()),
        ];
        assert!(lead_team_covers(&rows, &["a".into(), "b".into()]));
        assert!(!lead_team_covers(&rows, &["a".into(), "c".into()]));
        assert!(!lead_team_covers(&[], &["a".into()]));
    }
}
