//! S5.4 — `POST /agent/pr-watches/{id}/status`(TS `mergeRoutes.ts` → `prWatch.ts::reportWatchStatus`). 오퍼레이터가 gh 로 읽은
//! PR 상태를 받아 감시를 넘기고, 바뀌었으면 구독자 스레드마다 시스템 줄 하나와 `wake` 하나를 남긴다. `{ changed, state }`.
//!
//! - 위임 v2 스위치가 꺼져 있으면 409 `disabled`. 값이 없는 채로 뜬 서버는 이 라우트를 붙이지 않는다(`main.rs`).
//! - 체크 정렬은 TS `localeCompare`(ICU 루트 콜레이션)를 [`collate`] 로 흉내 낸다: 공백 < 문장부호·기호(CLDR 루트 순) < 숫자 < 글자,
//!   글자는 대소문자를 먼저 무시해 비교하고 같으면 소문자가 앞이다. ASCII 밖 글자는 코드포인트 순(악센트 접기 없음)이다 —
//!   체크 이름은 사실상 ASCII 라 어긋나는 일은 비-ASCII 이름끼리의 순서뿐이다(본문에는 개수만, meta 에만 실린다).
//! - TS 의 `now`(JS `new Date()`)는 DB `now()` 로 본다.
//! - 시스템 줄이 TS 몫 스레드에 닿으면(`Outcome::ToTs`) 감시는 이미 넘어갔으므로 TS 로 넘기지 않고 그 구독자를 건너뛴다
//!   (TS `posted.failure` 와 같은 처리). 문서화된 어긋남이다.
//! - fail-closed: 글 경로와 [`PR_WATCH_STATUS_PRIVILEGES`] 가 다 있을 때만 붙는다.
use super::grant_reads::through_operator;
use super::msg_post::{Origin, Outcome, PostBody, PostState, channel_is_dm, post_in_tx};
use super::msg_read::is_uuid;
use crate::auth::RequireAccount;
use crate::directory::{internal, json_err};
use axum::extract::{Path, Request, State};
use axum::http::{StatusCode, header};
use axum::response::{IntoResponse, Response};
use serde_json::{Map, Value, json};
use std::cmp::Ordering;
use std::sync::{Arc, OnceLock};

/// 쓰기 풀에 있어야 하는 칸 권한(글 경로는 `msg_post::MESSAGE_POST_PRIVILEGES` 로 따로 본다).
/// 새 운영 GRANT: `grant update (last_status, last_polled_at) on pr_watch`(state·ended_at 은 due 묶음에서 받았다).
pub const PR_WATCH_STATUS_PRIVILEGES: &[(&str, &str)] = &[
    ("pr_watch", "SELECT"),
    ("pr_watch.last_status", "UPDATE"),
    ("pr_watch.last_polled_at", "UPDATE"),
    ("pr_watch.state", "UPDATE"),
    ("pr_watch.ended_at", "UPDATE"),
    ("pr_watch_subscriber", "SELECT"),
    ("account_grant", "SELECT"),
    ("agent_config", "SELECT"),
    ("agent_invoker", "SELECT"),
    ("account", "SELECT"),
    ("channel", "SELECT"),
    ("channel_member", "SELECT"),
    ("inbox", "INSERT"),
];

pub const PR_WATCH_STATES: &[&str] = &["OPEN", "CLOSED", "MERGED"];
pub const PR_WATCH_CONCLUSIONS: &[&str] = &[
    "",
    "SUCCESS",
    "FAILURE",
    "NEUTRAL",
    "CANCELLED",
    "SKIPPED",
    "TIMED_OUT",
    "ACTION_REQUIRED",
    "STALE",
    "ERROR",
    "STARTUP_FAILURE",
    "QUEUED",
    "IN_PROGRESS",
    "COMPLETED",
    "WAITING",
    "REQUESTED",
    "PENDING",
    "EXPECTED",
];
const CONCLUDED: &[&str] = &[
    "SUCCESS",
    "FAILURE",
    "NEUTRAL",
    "CANCELLED",
    "SKIPPED",
    "TIMED_OUT",
    "ACTION_REQUIRED",
    "STALE",
    "ERROR",
    "STARTUP_FAILURE",
];

const WATCH_SQL: &str = "select w.id::text, w.repo, w.number, w.head, w.until, w.last_status::text, s.channel_id::text \
       from pr_watch w join pr_watch_subscriber s on s.watch_id = w.id and s.account_id = $2::uuid \
      where w.id = $1::uuid and w.state = 'open' limit 1";
const CHANGED_SQL: &str =
    "select ($1::jsonb is distinct from last_status) as c from pr_watch where id = $2::uuid";
const UPDATE_SQL: &str = "update pr_watch set last_status = $2::jsonb, last_polled_at = now(), \
            state = coalesce($3, state), ended_at = case when $3::text is null then null else now() end \
      where id = $1::uuid and state = 'open' and last_status is not distinct from $4::jsonb";
const SUBS_SQL: &str = "select account_id::text, channel_id::text, thread_root_id::text from pr_watch_subscriber where watch_id = $1::uuid";
const MEMBER_SQL: &str =
    "select 1 from channel_member where channel_id = $1::uuid and account_id = $2::uuid";
const WAKE_SQL: &str = "insert into inbox (account_id, message_id, reason) values ($1::uuid, $2::uuid, 'wake') on conflict do nothing";

fn grant_sql() -> &'static str {
    static S: OnceLock<String> = OnceLock::new();
    S.get_or_init(|| {
        let v: Value = serde_json::from_str(include_str!("../../golden/sql_fragments.json"))
            .expect("golden/sql_fragments.json");
        v["repo_grant_for"]
            .as_str()
            .expect("golden fragment repo_grant_for")
            .to_string()
    })
}

#[derive(Debug, PartialEq, Clone)]
pub struct Check {
    pub name: String,
    pub conclusion: String,
}

#[derive(Debug, PartialEq)]
pub struct Status {
    pub state: String,
    pub head: String,
    pub checks: Vec<Check>,
}

/// zod 모양 그대로(남는 키는 버린다). 틀리면 None → 400.
pub fn parse_body(body: Option<&Value>) -> Option<Status> {
    let o = body?.as_object()?;
    let state = o
        .get("state")?
        .as_str()
        .filter(|s| PR_WATCH_STATES.contains(s))?;
    let head = o
        .get("headRefOid")?
        .as_str()
        .filter(|h| h.len() == 40 && h.bytes().all(|c| matches!(c, b'0'..=b'9' | b'a'..=b'f')))?;
    let arr = o.get("checks")?.as_array()?;
    if arr.len() > 100 {
        return None;
    }
    let mut checks = Vec::with_capacity(arr.len());
    for c in arr {
        let c = c.as_object()?;
        let name = c.get("name")?.as_str()?;
        if name.encode_utf16().count() > 200 {
            return None;
        }
        let conclusion = c
            .get("conclusion")?
            .as_str()
            .filter(|s| PR_WATCH_CONCLUSIONS.contains(s))?;
        checks.push(Check {
            name: name.to_owned(),
            conclusion: conclusion.to_owned(),
        });
    }
    Some(Status {
        state: state.to_owned(),
        head: head.to_owned(),
        checks,
    })
}

/// CLDR 루트에서 ASCII 문장부호·기호의 순서(공백 다음, 숫자 앞).
const PUNCT_ORDER: &str = "_-,;:!?.'\"()[]{}@*/\\&#%`^+<=>|~$";

/// 한 글자의 (1차 갈래, 1차 값, 3차 값). 갈래: 0 공백 · 1 문장부호·기호 · 2 숫자 · 3 글자 · 4 그 밖.
fn weight(c: char) -> (u8, u32, u8) {
    if c.is_whitespace() {
        return (0, c as u32, 0);
    }
    if let Some(i) = PUNCT_ORDER.find(c) {
        return (1, i as u32, 0);
    }
    if c.is_ascii_digit() {
        return (2, c as u32, 0);
    }
    if c.is_alphabetic() {
        let lower = c.to_lowercase().next().unwrap_or(c);
        return (3, lower as u32, u8::from(c != lower));
    }
    (4, c as u32, 0)
}

/// TS `a.localeCompare(b)` 근사 — 1차(대소문자 무시)를 끝까지 본 뒤 3차(소문자 먼저).
pub fn collate(a: &str, b: &str) -> Ordering {
    let wa: Vec<_> = a.chars().map(weight).collect();
    let wb: Vec<_> = b.chars().map(weight).collect();
    let prim = |w: &[(u8, u32, u8)]| w.iter().map(|x| (x.0, x.1)).collect::<Vec<_>>();
    prim(&wa)
        .cmp(&prim(&wb))
        .then_with(|| {
            wa.iter()
                .map(|x| x.2)
                .collect::<Vec<_>>()
                .cmp(&wb.iter().map(|x| x.2).collect::<Vec<_>>())
        })
        .then_with(|| a.cmp(b))
}

/// TS `summarize` — 이름 200자·결론 대문자 40자로 자르고 이름순.
pub fn summarize(s: &Status) -> Status {
    let mut checks: Vec<Check> = s
        .checks
        .iter()
        .map(|c| Check {
            name: super::api_results::js_slice(&c.name, 200),
            conclusion: c.conclusion.to_uppercase().chars().take(40).collect(),
        })
        .collect();
    checks.sort_by(|a, b| collate(&a.name, &b.name));
    Status {
        state: s.state.to_uppercase(),
        head: s.head.clone(),
        checks,
    }
}

fn status_json(s: &Status) -> Value {
    json!({
        "state": s.state, "head": s.head,
        "checks": s.checks.iter().map(|c| json!({ "name": c.name, "conclusion": c.conclusion })).collect::<Vec<_>>(),
    })
}

/// TS `nextState`.
pub fn next_state(until: &str, head: &str, sum: &Status) -> Option<&'static str> {
    if until == "merged" {
        return (sum.state == "MERGED" || sum.state == "CLOSED").then_some("done");
    }
    if sum.state == "MERGED" {
        return Some("done");
    }
    if sum.state == "CLOSED" || sum.head != head {
        return Some("gone");
    }
    (!sum.checks.is_empty()
        && sum
            .checks
            .iter()
            .all(|c| CONCLUDED.contains(&c.conclusion.as_str())))
    .then_some("done")
}

/// 시스템 줄 본문(TS 와 글자 하나까지 같게).
pub fn line(repo: &str, number: i32, sum: &Status, end: Option<&str>, head: &str) -> String {
    let concluded = |c: &Check| CONCLUDED.contains(&c.conclusion.as_str());
    let done = sum.checks.iter().filter(|c| concluded(c)).count();
    let failing = sum
        .checks
        .iter()
        .filter(|c| {
            concluded(c) && !matches!(c.conclusion.as_str(), "SUCCESS" | "NEUTRAL" | "SKIPPED")
        })
        .count();
    let tail = match end {
        Some("done") => " · 감시 끝",
        Some("gone") if sum.head != head => " · head 가 바뀌어 감시 끝",
        Some("gone") => " · PR 이 닫혀 감시 끝",
        _ => "",
    };
    format!(
        "👀 {repo}#{number} {} · 체크 {done}/{} 끝 · 실패 {failing}{tail}",
        sum.state,
        sum.checks.len()
    )
}

fn scopes(repo: &str) -> (String, String) {
    let scope = format!("repo:{repo}");
    let owner = repo.split_once('/').map_or(repo, |(o, _)| o);
    (scope, format!("repo:{owner}/*"))
}

async fn holds_grant(
    pool: &sqlx::PgPool,
    account: &str,
    repo: &str,
    channel: &str,
) -> sqlx::Result<bool> {
    let (scope, org) = scopes(repo);
    Ok(sqlx::query(grant_sql())
        .bind(account)
        .bind(vec![scope.clone(), org])
        .bind(&scope)
        .bind(channel)
        .bind("repo.merge")
        .fetch_optional(pool)
        .await?
        .is_some())
}

enum Done {
    Refused(StatusCode, &'static str),
    Ok(bool, &'static str),
}

type WatchRow = (String, String, i32, String, String, Option<String>, String);

async fn report(st: &PostState, agent: &str, watch: &str, status: &Status) -> sqlx::Result<Done> {
    let w = &st.write;
    let row: Option<WatchRow> = sqlx::query_as(WATCH_SQL)
        .bind(watch)
        .bind(agent)
        .fetch_optional(w)
        .await?;
    let Some((id, repo, number, head, until, last, channel)) = row else {
        return Ok(Done::Refused(StatusCode::NOT_FOUND, "not_found"));
    };
    if !holds_grant(w, agent, &repo, &channel).await? {
        return Ok(Done::Refused(StatusCode::FORBIDDEN, "not_granted"));
    }
    let sum = summarize(status);
    let sum_json = status_json(&sum);
    let sum_text = sum_json.to_string();
    let changed: bool = sqlx::query_scalar::<_, Option<bool>>(CHANGED_SQL)
        .bind(&sum_text)
        .bind(&id)
        .fetch_optional(w)
        .await?
        .flatten()
        .unwrap_or(true);
    let end = next_state(&until, &head, &sum);
    let upd = sqlx::query(UPDATE_SQL)
        .bind(&id)
        .bind(&sum_text)
        .bind(end)
        .bind(last.as_deref())
        .execute(w)
        .await?;
    if upd.rows_affected() == 0 || (!changed && end.is_none()) {
        return Ok(Done::Ok(false, "open"));
    }
    let subs: Vec<(String, String, String)> =
        sqlx::query_as(SUBS_SQL).bind(&id).fetch_all(w).await?;
    let body = line(&repo, number, &sum, end, &head);
    for (account, ch, thread) in subs {
        let member = sqlx::query(MEMBER_SQL)
            .bind(&ch)
            .bind(&account)
            .fetch_optional(w)
            .await?;
        if member.is_none() || !holds_grant(w, &account, &repo, &ch).await? {
            continue;
        }
        let mut meta = Map::new();
        meta.insert(
            "prWatch".into(),
            json!({
                "watchId": id, "repo": repo, "number": number, "head": head, "until": until,
                "state": end.unwrap_or("open"), "status": sum_json,
            }),
        );
        let audience = super::audience::audience_for(w, &ch).await?.to_json();
        let is_dm = channel_is_dm(w, &ch).await?;
        let input = PostBody {
            body: body.clone(),
            attachment_ids: Vec::new(),
            thread_root: Some(thread),
            also_in_channel: false,
        };
        let origin = Origin {
            meta,
            system: true,
            ..Origin::default()
        };
        let out = post_in_tx(
            st, &ch, &account, true, &input, None, &audience, is_dm, &origin,
        )
        .await?;
        let Outcome::Posted { row, .. } = out else {
            continue;
        };
        let message: Value =
            serde_json::from_str(&row).map_err(|e| sqlx::Error::Decode(e.into()))?;
        if let Some(mid) = message.get("id").and_then(Value::as_str) {
            sqlx::query(WAKE_SQL)
                .bind(&account)
                .bind(mid)
                .execute(w)
                .await?;
        }
    }
    Ok(Done::Ok(changed, end.unwrap_or("open")))
}

fn v2_on() -> bool {
    crate::core::msg_post::delegation_v2(crate::env_once::get(&crate::env_once::DELEGATION_V2))
        .unwrap_or(false)
}

pub async fn status_route(
    State(st): State<Arc<PostState>>,
    RequireAccount(me, auth): RequireAccount,
    Path(id): Path<String>,
    req: Request,
) -> Response {
    let (parts, body) = req.into_parts();
    let (_bytes, parsed) = match super::ask::read_bytes(&parts.headers, body).await {
        Ok(v) => v,
        Err(r) => return r,
    };
    if !through_operator(&me, &auth) {
        return json_err(
            StatusCode::FORBIDDEN,
            "forbidden",
            "only an agent through its operator can do this",
        );
    }
    let body = parse_body(Some(parsed.as_ref().unwrap_or(&json!({}))));
    let (true, Some(body)) = (is_uuid(&id), body) else {
        return json_err(
            StatusCode::BAD_REQUEST,
            "bad_request",
            "state, headRefOid and checks are required",
        );
    };
    let res = if v2_on() {
        report(&st, &me.id, &id, &body).await
    } else {
        Ok(Done::Refused(StatusCode::CONFLICT, "disabled"))
    };
    match res {
        Err(e) => internal(e),
        Ok(Done::Refused(s, code)) => {
            json_err(s, code, &format!("pr watch status not recorded: {code}"))
        }
        Ok(Done::Ok(changed, state)) => (
            StatusCode::OK,
            [(header::CONTENT_TYPE, "application/json; charset=utf-8")],
            json!({ "changed": changed, "state": state }).to_string(),
        )
            .into_response(),
    }
}

pub fn routes(
    st: PostState,
    auth: crate::auth::AuthPools,
    cors: Arc<crate::cors::Cors>,
) -> crate::route_table::Routes<()> {
    use crate::route_table::Table;
    let t = Table::<Arc<PostState>>::new()
        .post("/agent/pr-watches/{id}/status", status_route)
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
        router: t.router.with_state(Arc::new(st)),
        http: t.http,
        sockets: t.sockets,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn sha() -> String {
        "a".repeat(40)
    }

    #[test]
    fn body_like_zod() {
        let ok = json!({ "state": "OPEN", "headRefOid": sha(), "checks": [{ "name": "ci", "conclusion": "" }], "x": 1 });
        assert!(parse_body(Some(&ok)).is_some());
        for bad in [
            json!({ "state": "open", "headRefOid": sha(), "checks": [] }),
            json!({ "state": "OPEN", "headRefOid": "A".repeat(40), "checks": [] }),
            json!({ "state": "OPEN", "headRefOid": sha() }),
            json!({ "state": "OPEN", "headRefOid": sha(), "checks": [{ "name": "ci", "conclusion": "success" }] }),
            json!({ "state": "OPEN", "headRefOid": sha(), "checks": [{ "name": "x".repeat(201), "conclusion": "" }] }),
        ] {
            assert!(parse_body(Some(&bad)).is_none(), "{bad}");
        }
    }

    #[test]
    fn collate_like_locale_compare() {
        let mut v = vec!["b", "B", "a", "_x", "10", "9", "A", "-y", "ab"];
        v.sort_by(|a, b| collate(a, b));
        assert_eq!(v, ["_x", "-y", "10", "9", "a", "A", "ab", "b", "B"]);
        // 1차가 다르면 대소문자보다 앞선다: "a" < "B" < "c".
        let mut w = vec!["c", "B", "a"];
        w.sort_by(|a, b| collate(a, b));
        assert_eq!(w, ["a", "B", "c"]);
    }

    #[test]
    fn next_state_and_line_like_ts() {
        let c = |n: &str, k: &str| Check {
            name: n.into(),
            conclusion: k.into(),
        };
        let s = Status {
            state: "OPEN".into(),
            head: sha(),
            checks: vec![c("a", "SUCCESS"), c("b", "FAILURE")],
        };
        assert_eq!(next_state("checks", &sha(), &s), Some("done"));
        assert_eq!(next_state("merged", &sha(), &s), None);
        assert_eq!(next_state("checks", &"b".repeat(40), &s), Some("gone"));
        let p = Status {
            checks: vec![c("a", "PENDING")],
            ..Status {
                state: "OPEN".into(),
                head: sha(),
                checks: vec![],
            }
        };
        assert_eq!(next_state("checks", &sha(), &p), None);
        assert_eq!(
            line("o/r", 3, &s, Some("done"), &sha()),
            "👀 o/r#3 OPEN · 체크 2/2 끝 · 실패 1 · 감시 끝"
        );
        assert_eq!(
            line("o/r", 3, &s, Some("gone"), &"b".repeat(40)),
            "👀 o/r#3 OPEN · 체크 2/2 끝 · 실패 1 · head 가 바뀌어 감시 끝"
        );
    }
}
