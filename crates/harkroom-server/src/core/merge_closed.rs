//! S5.4 — `POST /agent/merge-closed`(TS `mergeRoutes.ts` → `reportMergeClosed` → `obsoleteMergeCards`). 래퍼가 `gh pr view` 에서 그
//! PR 이 이미 MERGED·CLOSED 인 것을 봤다 — 그 에이전트 **자신의** 기다리는 머지 카드만 닫는다. 200 `{ closed }`.
//!
//! - 순서는 TS 그대로: 오퍼레이터 아님 403 → zod 400 → 임대 아님 403 `lease_invalid` → 저장소 꼴 400 `bad_repo` → 닫을 카드 없음
//!   409 `no_card`. 거절 문구는 `merge cards not closed: <code>`. `cache-control` 은 없다(TS 도 안 단다).
//! - 거절 기록·권한 요청 줄·카드 meta·선택 카드 닫기와 카드 `message.updated`(outbox)는 **한 tx**. 감사 `repo.merge.obsoleted` 는
//!   TS 처럼 커밋 뒤에 따로 쓰고 실패를 삼킨다.
//! - fail-closed: 쓰기 풀에 [`MERGE_CLOSED_PRIVILEGES`] 가 다 있을 때만 붙는다(`main.rs`).
use super::audience::audience_on;
use super::grant_reads::through_operator;
use super::merge_approval_peek::{db_now, positive_int, repo_scope, sha256_hex, str_len_ok};
use super::msg_read::{is_uuid, message_by_id};
use crate::auth::RequireAccount;
use crate::directory::{internal, json_err};
use crate::write::{AuditEntry, emit_event, record_audit};
use axum::extract::{Request, State};
use axum::http::StatusCode;
use axum::response::{IntoResponse, Response};
use serde_json::{Map, Value, json};
use sqlx::PgPool;
use std::sync::Arc;

/// 쓰기 풀에 있어야 하는 권한.
pub const MERGE_CLOSED_PRIVILEGES: &[(&str, &str)] = &[
    ("secret_turn_lease", "SELECT"),
    ("merge_denial", "SELECT"),
    ("merge_denial.obsoleted_at", "UPDATE"),
    ("permission_request", "SELECT"),
    ("permission_request.status", "UPDATE"),
    ("permission_request.decided_at", "UPDATE"),
    ("message", "SELECT"),
    ("message.meta", "UPDATE"),
    ("channel", "SELECT"),
    ("audit_log", "INSERT"),
];

const FORBIDDEN: &str = "only an agent through its operator can do this";
const BAD: &str = "leaseId, token, repo, number and state (MERGED|CLOSED) are required";

/// TS `readLease` 중 이 라우트가 쓰는 칸만(임대 id·에이전트·오퍼레이터·만료·끝남).
const LEASE_SQL: &str = "select l.id::text, l.agent_id::text, l.operator_id::text, \
       l.expires_at <= $3::timestamptz, l.ended_at is not null \
     from secret_turn_lease l where l.id = $1::uuid and l.token_hash = $2::text";

const DENIALS_SQL: &str = "update merge_denial set obsoleted_at = $3::timestamptz \
     where scope = $1 and pr_number = $2 and used_at is null and obsoleted_at is null and ($4::uuid is null or agent_id = $4::uuid) \
     returning id::text, card_message_id::text";

const REQUESTS_SQL: &str = "update permission_request set status = 'obsolete', decided_at = $3::timestamptz \
     where kind = 'merge' and status = 'pending' and target = $1 and ($4::uuid is null or agent_id = $4::uuid) \
       and denial_id in (select id from merge_denial where scope = $1 and pr_number = $2) \
     returning id::text, card_message_id::text";

const REQUEST_CARD_SQL: &str = "update message set meta = jsonb_set(meta, '{permissionRequest}', (meta->'permissionRequest') || $2::jsonb) \
     where id = $1::uuid and meta ? 'permissionRequest'";

const DENIAL_CARD_SQL: &str = "update message set meta = jsonb_set(meta, '{mergeDenial,obsolete}', $2::jsonb) \
     where id = $1::uuid and meta ? 'mergeDenial'";

const ASK_CLOSE_SQL: &str = "update message set meta = jsonb_set(meta, '{ask}', (meta->'ask') || $2::jsonb) \
     where id = any($1::uuid[]) and meta ? 'ask' and meta->'ask'->>'closedAt' is null and meta->'ask'->'answeredWith' is null";

/// zod 를 통과한 본문.
#[derive(Debug, Clone, PartialEq)]
pub struct ClosedBody {
    pub lease_id: String,
    pub token: String,
    pub repo: String,
    pub number: i64,
    /// `MERGED` 이면 `merged`, `CLOSED` 이면 `closed`(TS `reason`).
    pub state: &'static str,
}

/// zod `{ leaseId, token, repo, number, state: enum(MERGED|CLOSED) }` — 모르는 키는 버린다.
pub fn parse_body(body: Option<&Value>) -> Option<ClosedBody> {
    let empty = Map::new();
    let o = match body {
        None => &empty,
        Some(v) => v.as_object()?,
    };
    let lease_id = o.get("leaseId")?.as_str()?;
    if !is_uuid(lease_id) {
        return None;
    }
    let token = str_len_ok(o.get("token")?, 1, 200)?;
    let repo = str_len_ok(o.get("repo")?, 3, 201)?;
    let number = positive_int(o.get("number")?)?;
    let state = match o.get("state")?.as_str()? {
        "MERGED" => "MERGED",
        "CLOSED" => "CLOSED",
        _ => return None,
    };
    Some(ClosedBody {
        lease_id: lease_id.to_owned(),
        token: token.to_owned(),
        repo: repo.to_owned(),
        number,
        state,
    })
}

/// 처음 본 순서를 지킨 카드 id 모음(TS `new Set([...requests, ...denials].map(cardMessageId))`).
pub fn card_ids(rows: &[(String, Option<String>)]) -> Vec<String> {
    let mut out: Vec<String> = Vec::new();
    for c in rows.iter().filter_map(|(_, c)| c.as_ref()) {
        if !out.contains(c) {
            out.push(c.clone());
        }
    }
    out
}

enum Outcome {
    Refused(StatusCode, &'static str),
    Closed(usize),
}

async fn close(
    write: &PgPool,
    agent: &str,
    operator: &str,
    b: &ClosedBody,
) -> sqlx::Result<Outcome> {
    let now = db_now(write).await?;
    let lease: Option<(String, String, Option<String>, bool, bool)> = sqlx::query_as(LEASE_SQL)
        .bind(&b.lease_id)
        .bind(sha256_hex(&b.token))
        .bind(&now)
        .fetch_optional(write)
        .await?;
    let lease_id = match lease {
        Some((id, a, o, expired, ended))
            if a == agent && o.as_deref() == Some(operator) && !expired && !ended =>
        {
            id
        }
        _ => return Ok(Outcome::Refused(StatusCode::FORBIDDEN, "lease_invalid")),
    };
    let Some(scope) = repo_scope(&b.repo) else {
        return Ok(Outcome::Refused(StatusCode::BAD_REQUEST, "bad_repo"));
    };
    let reason = if b.state == "MERGED" {
        "merged"
    } else {
        "closed"
    };
    let extra = json!({ "operatorId": operator, "leaseId": lease_id, "reportedState": b.state });
    let total = obsolete_merge_cards(
        write,
        &scope,
        b.number,
        reason,
        agent,
        &now,
        Some(agent),
        extra,
    )
    .await?;
    if total == 0 {
        return Ok(Outcome::Refused(StatusCode::CONFLICT, "no_card"));
    }
    Ok(Outcome::Closed(total))
}

/// TS `obsoleteMergeCards` — 그 (저장소, PR)의 기다리는 머지 카드를 닫는다. `only_agent` 가 있으면 그 에이전트의 것만(래퍼의
/// `closed` 보고), 없으면 모든 에이전트(통과한 판정 뒤의 `merged` 보고). 닫은 줄 수를 돌려준다. 감사는 커밋 뒤에 따로 쓴다.
#[allow(clippy::too_many_arguments)]
pub async fn obsolete_merge_cards(
    write: &PgPool,
    scope: &str,
    number: i64,
    reason: &str,
    actor: &str,
    now: &str,
    only_agent: Option<&str>,
    extra_audit: Value,
) -> sqlx::Result<usize> {
    let mut tx = write.begin().await?;
    let denials: Vec<(String, Option<String>)> = sqlx::query_as(DENIALS_SQL)
        .bind(scope)
        .bind(number)
        .bind(now)
        .bind(only_agent)
        .fetch_all(&mut *tx)
        .await?;
    let requests: Vec<(String, Option<String>)> = sqlx::query_as(REQUESTS_SQL)
        .bind(scope)
        .bind(number)
        .bind(now)
        .bind(only_agent)
        .fetch_all(&mut *tx)
        .await?;
    let patch =
        json!({ "status": "obsolete", "obsoleteReason": reason, "decidedAt": now }).to_string();
    for (_, card) in &requests {
        if let Some(card) = card {
            sqlx::query(REQUEST_CARD_SQL)
                .bind(card)
                .bind(&patch)
                .execute(&mut *tx)
                .await?;
        }
    }
    let obsolete = json!({ "reason": reason, "at": now }).to_string();
    for (_, card) in &denials {
        if let Some(card) = card {
            sqlx::query(DENIAL_CARD_SQL)
                .bind(card)
                .bind(&obsolete)
                .execute(&mut *tx)
                .await?;
        }
    }
    let all: Vec<(String, Option<String>)> =
        requests.iter().chain(denials.iter()).cloned().collect();
    let cards = card_ids(&all);
    if !cards.is_empty() {
        sqlx::query(ASK_CLOSE_SQL)
            .bind(&cards)
            .bind(json!({ "closedAt": now, "closedBy": actor }).to_string())
            .execute(&mut *tx)
            .await?;
    }
    let total = denials.len() + requests.len();
    if total == 0 {
        // 쓴 것이 없다 — TS 도 커밋만 하고 0 을 돌려준다.
        tx.commit().await?;
        return Ok(0);
    }
    for card in &cards {
        if let Some(row) = message_by_id(&mut *tx, card).await? {
            let message: Value =
                serde_json::from_str(&row).map_err(|e| sqlx::Error::Decode(e.into()))?;
            if let Some(channel) = message.get("channelId").and_then(Value::as_str) {
                let audience = audience_on(&mut tx, channel).await?.to_json();
                emit_event(
                    &mut tx,
                    &json!({ "type": "message.updated", "message": message, "audience": audience }),
                )
                .await?;
            }
        }
    }
    tx.commit().await?;
    record_audit(
        write,
        AuditEntry {
            action: "repo.merge.obsoleted",
            actor_id: Some(actor),
            actor_handle: None,
            target: Some(scope),
            ip: None,
            detail: obsoleted_detail(number, reason, only_agent, &denials, &requests, extra_audit),
        },
    )
    .await;
    Ok(total)
}

/// TS `obsoleteMergeCards` 의 감사 detail — `source` 는 `onlyAgentId` 가 있으면 래퍼 보고, 없으면 머지 결과.
pub fn obsoleted_detail(
    number: i64,
    reason: &str,
    only_agent: Option<&str>,
    denials: &[(String, Option<String>)],
    requests: &[(String, Option<String>)],
    extra: Value,
) -> Value {
    let mut d = json!({
        "number": number, "reason": reason, "onlyAgentId": only_agent,
        "source": if only_agent.is_some() { "wrapper_report" } else { "merge_result" },
        "denialIds": denials.iter().map(|d| d.0.clone()).collect::<Vec<_>>(),
        "requestIds": requests.iter().map(|r| r.0.clone()).collect::<Vec<_>>(),
    });
    if let (Value::Object(m), Value::Object(e)) = (&mut d, extra) {
        m.extend(e);
    }
    d
}

/// `POST /agent/merge-closed`.
pub async fn closed_route(
    State(write): State<Arc<PgPool>>,
    RequireAccount(me, auth): RequireAccount,
    req: Request,
) -> Response {
    let (parts, body) = req.into_parts();
    let parsed = match super::ask::read_bytes(&parts.headers, body).await {
        Ok((_, v)) => v,
        Err(r) => return r,
    };
    if !through_operator(&me, &auth) {
        return json_err(StatusCode::FORBIDDEN, "forbidden", FORBIDDEN);
    }
    let Some(b) = parse_body(parsed.as_ref()) else {
        return json_err(StatusCode::BAD_REQUEST, "bad_request", BAD);
    };
    let operator = auth
        .operator
        .as_ref()
        .map(|o| o.id.as_str())
        .unwrap_or_default();
    match close(&write, &me.id, operator, &b).await {
        Err(e) => internal(e),
        Ok(Outcome::Refused(s, code)) => {
            json_err(s, code, &format!("merge cards not closed: {code}"))
        }
        Ok(Outcome::Closed(n)) => (
            StatusCode::OK,
            [(
                axum::http::header::CONTENT_TYPE,
                "application/json; charset=utf-8",
            )],
            json!({ "closed": n }).to_string(),
        )
            .into_response(),
    }
}

/// 코어 라우터에 합칠 줄 — `pr_watch_due.rs` 와 같은 길.
pub fn routes(
    write: PgPool,
    auth: crate::auth::AuthPools,
    cors: Arc<crate::cors::Cors>,
) -> crate::route_table::Routes<()> {
    use crate::route_table::Table;
    let t = Table::<Arc<PgPool>>::new()
        .post("/agent/merge-closed", closed_route)
        .map(|r| {
            r.route_layer(axum::middleware::from_fn_with_state(
                auth,
                crate::auth::layer,
            ))
            .layer(axum::middleware::from_fn_with_state(
                cors,
                crate::cors::layer,
            ))
        })
        .finish();
    crate::route_table::Routes {
        router: t.router.with_state(Arc::new(write)),
        http: t.http,
        sockets: t.sockets,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const L: &str = "00000000-0000-4000-8000-000000000001";

    #[test]
    fn body_like_zod() {
        let b = parse_body(Some(&json!({ "leaseId": L, "token": "t", "repo": "o/r", "number": 3, "state": "MERGED", "x": 1 })))
            .unwrap();
        assert_eq!((b.number, b.state), (3, "MERGED"));
        for bad in [
            json!({ "leaseId": L, "token": "t", "repo": "o/r", "number": 3, "state": "merged" }),
            json!({ "leaseId": L, "token": "t", "repo": "o/r", "number": 3 }),
            json!({ "leaseId": L, "token": "t", "repo": "o/r", "number": -1, "state": "CLOSED" }),
        ] {
            assert!(parse_body(Some(&bad)).is_none(), "{bad}");
        }
    }

    #[test]
    fn card_ids_keep_first_order_and_dedupe() {
        let rows = vec![
            ("r1".to_owned(), Some("c2".to_owned())),
            ("r2".to_owned(), None),
            ("d1".to_owned(), Some("c1".to_owned())),
            ("d2".to_owned(), Some("c2".to_owned())),
        ];
        assert_eq!(card_ids(&rows), vec!["c2".to_owned(), "c1".to_owned()]);
    }

    #[test]
    fn obsoleted_detail_like_ts() {
        let d = vec![("d1".to_owned(), None)];
        let r = vec![("r1".to_owned(), Some("c".to_owned()))];
        let v = obsoleted_detail(5, "merged", None, &d, &r, json!({}));
        assert_eq!(
            v,
            json!({ "number": 5, "reason": "merged", "onlyAgentId": null, "source": "merge_result",
                "denialIds": ["d1"], "requestIds": ["r1"] })
        );
        let v = obsoleted_detail(5, "closed", Some("a"), &d, &[], json!({ "leaseId": "l" }));
        assert_eq!(v["source"], json!("wrapper_report"));
        assert_eq!(v["onlyAgentId"], json!("a"));
        assert_eq!(v["leaseId"], json!("l"));
    }
}
