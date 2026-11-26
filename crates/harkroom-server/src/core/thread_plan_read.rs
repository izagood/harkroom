//! S5.4 TP1 — 스레드 계획판 읽기 한 줄. TS `routes/threadPlanRoutes.ts` 의 `GET /threads/:rootId/plan` 을 옮긴다.
//!
//! - 판정 순서는 TS 와 같다: `requireAccount`(401) → rootId 가 uuid 아님(404) → 루트 글이 없거나 지웠거나 답글(404) →
//!   그 채널을 못 봄(404, `assertChannelVisible`) → 계획 없음(`{ plan: null }`). 거절은 모두 `{ "error": "not_found" }` 로 같다 —
//!   못 보는 스레드에 계획이 있는지 없는지를 가르지 않는다. admin 예외는 없다(내용 읽기 권한이다).
//! - 연결 그룹의 진행률은 **보는 사람 기준**(TS `linkedFor({ viewer })`): 자식 루트 글이 없거나 그 채널을 못 보면 `hidden` 이고
//!   `channelId`·`progress` 를 싣지 않는다. 파생 상태(`derived`)·진행률(`progress`)도 그 맵으로 센다 — 못 보는 자식이 끝났다는
//!   사실이 부모의 「시작 가능」으로 새지 않게.
//! - 자식 사실 문장은 TS 골든 `plan_progress_children`(청중 기준 `childFacts`)에 가시성 술어(`channel_visible_c_p1uuid`)를
//!   보는 사람 자리로 얹은 것이다. 판정은 `msg_list.rs` 의 [`derive_plan`]·[`plan_progress`](shared `planGraph.ts` 이식).
//! - **읽기만 한다.** 읽기 풀만 쓰고 새 GRANT 가 없다. 필요한 SELECT 는 [`THREAD_PLAN_READ_PRIVILEGES`] — 없으면 `main.rs` 가
//!   이 줄을 붙이지 않아 TS 에 남는다.
//! - 멈춘 단계(s65): 멈춤 판정 스위치가 `on` 일 때만 계획 진행 루프가 적어 둔 표시(`thread_plan.stall`)를 따로 읽어, 멈춘 단계가
//!   있으면 `stalled: { <단계 id>: { since, wokenAt } }` 를 덧붙인다([`stalled_json`]). 스위치가 꺼졌거나 멈춘 단계가 없으면 그
//!   읽기도 키도 없다(답이 전과 같다). 표시는 루프의 추정이다 — 문서에서 그 단계가 이미 `active` 가 아니면 싣지 않는다.
//! - 계획 쓰기(`POST …/plan/start`·`PUT …/plan/manager`·`DELETE …/plan/auto`)와 MCP `thread.plan` 쓰기·`thread.plan.item` 은 TS 에 남긴다.
//!   MCP `thread.plan` 읽기(`plan` 인자 없음)는 [`plan_view_json`] 을 같이 쓴다(`core/mcp/plan_read.rs`).
use super::msg_list::{Linked, Progress, derive_plan, linked_roots, plan_progress};
use super::msg_read::channel_visible;
use super::plan_progress::Clock;
use crate::auth::RequireAccount;
use crate::directory::{internal, json_ok};
use axum::extract::{Path, State};
use axum::http::{StatusCode, header};
use axum::response::{IntoResponse, Response};
use serde_json::Value;
use sqlx::PgPool;
use std::collections::HashMap;
use std::sync::{Arc, OnceLock};

/// 읽기 풀에 있어야 하는 권한. `channel_member` 는 가시성 술어(`channelVisibleSql`)가 읽는다.
pub const THREAD_PLAN_READ_PRIVILEGES: &[(&str, &str)] = &[
    ("message", "SELECT"),
    ("channel", "SELECT"),
    ("channel_member", "SELECT"),
    ("thread_plan", "SELECT"),
];

/// TS `threadRootChannel` — 지운 글은 없는 것.
pub(crate) const ROOT_SQL: &str = "select channel_id::text, thread_root_id is null from message where id = $1::uuid and deleted_at is null";

/// TS `getThreadPlan`(`THREAD_PLAN_COLUMNS`) — 시각은 `toISOString` 꼴.
const PLAN_SQL: &str = concat!(
    "select root_id::text, channel_id::text, doc::text, rev::int8, ",
    crate::iso!("updated_at"),
    ", updated_by::text, flag_reason, auto_until, auto_source::text, auto_by::text, ",
    crate::iso!("auto_at"),
    " from thread_plan where root_id = $1::uuid"
);

/// 시계 칸과 DB 의 지금(epoch 초).
const STALL_SQL: &str =
    "select stall::text, extract(epoch from now())::int8 from thread_plan where root_id = $1::uuid";

/// epoch 초 → `toISOString` 꼴.
fn iso(secs: i64) -> Option<String> {
    chrono::DateTime::from_timestamp(secs, 0)
        .map(|t| t.format("%Y-%m-%dT%H:%M:%S.000Z").to_string())
}

/// 지금 멈춘 것으로 보일 단계들(시계의 단계 순서) — 루프가 최근에 본 시계([`Clock::live`])의 표시만 믿고, 문서에서 지금 `active` 인
/// 단계만 낸다(루프가 다음에 돌기 전에 끝났거나 막힌 단계는 멈춤이 아니다).
fn stalled_steps<'a>(
    doc: &'a Value,
    clock: &'a Clock,
    now: i64,
) -> impl Iterator<Item = (&'a String, &'a super::plan_progress::StepClock)> {
    let active = move |id: &str| {
        doc["steps"]
            .as_array()
            .into_iter()
            .flatten()
            .any(|s| s["id"].as_str() == Some(id) && s["state"].as_str() == Some("active"))
    };
    clock
        .steps
        .iter()
        .filter(move |(id, s)| clock.live(now) && s.marked_at.is_some() && active(id))
}

/// 멈춘 단계 수 — 목록 행의 `planProgress.stalled` 가 싣는다([`stalled_json`] 과 같은 규칙으로 센다).
pub(crate) fn stalled_count(doc: &Value, clock: &Clock, now: i64) -> usize {
    stalled_steps(doc, clock, now).count()
}

/// 멈춘 단계 보기 `{ "<id>": { "since": …, "wokenAt": …|null } }` — 없으면 `None`. 고르는 규칙은 [`stalled_steps`] 다.
pub(crate) fn stalled_json(doc: &Value, clock: &Clock, now: i64) -> Option<String> {
    let parts: Vec<String> = stalled_steps(doc, clock, now)
        .filter_map(|(id, s)| {
            Some(format!(
                r#"{}:{{"since":{},"wokenAt":{}}}"#,
                q(id),
                q(&iso(s.quiet_at)?),
                opt_q(&s.woken_at.and_then(iso))
            ))
        })
        .collect();
    (!parts.is_empty()).then(|| format!("{{{}}}", parts.join(",")))
}

/// 읽기 답이 멈춘 단계를 싣나 — 멈춤 판정 스위치가 `on` 일 때만.
pub(crate) fn stall_view_on() -> bool {
    use crate::loops::plan_progress::{StallMode, stall_mode};
    stall_mode(crate::env_once::get(&crate::env_once::PLAN_STALL)) == StallMode::On
}

/// TS `childFacts(db, roots, viewerId)` — `$1` 자식 루트들, `$2` 보는 사람.
fn children_sql() -> &'static str {
    static S: OnceLock<String> = OnceLock::new();
    S.get_or_init(|| {
        let v: Value = serde_json::from_str(include_str!("../../golden/sql_fragments.json"))
            .expect("golden/sql_fragments.json");
        let frag = |k: &str| {
            v[k].as_str()
                .unwrap_or_else(|| panic!("golden fragment {k}"))
                .to_string()
        };
        let visible = frag("channel_visible_c_p1uuid").replace("$1::uuid", "$2::uuid");
        format!(
            "select f.id::text, f.channel_id::text, f.doc::text, ({visible}) as viewer_visible \
             from ({}) f join channel c on c.id = f.channel_id",
            frag("plan_progress_children")
        )
    })
}

/// TS GET 의 거절 — 몸통은 `{ "error": "not_found" }`(코드 객체가 아니라 문자열이다).
fn not_found() -> Response {
    (
        StatusCode::NOT_FOUND,
        [(header::CONTENT_TYPE, "application/json; charset=utf-8")],
        r#"{"error":"not_found"}"#,
    )
        .into_response()
}

fn q(s: &str) -> String {
    serde_json::to_string(s).unwrap_or_else(|_| "\"\"".into())
}

fn opt_q(s: &Option<String>) -> String {
    s.as_deref().map_or_else(|| "null".into(), q)
}

/// JS 참값인 문자열(빈 문자열·null 은 거짓).
fn truthy(s: &Option<String>) -> bool {
    s.as_deref().is_some_and(|s| !s.is_empty())
}

fn progress_json(p: &Progress) -> String {
    format!(
        r#"{{"done":{},"total":{},"active":{},"blocked":{},"waiting":{}}}"#,
        p.done, p.total, p.active, p.blocked, p.waiting
    )
}

/// 자식 루트 하나의 사실. 행이 없으면(없거나 지웠거나 답글) 맵에 없다 = 없는 자식.
struct Child {
    channel_id: String,
    viewer_visible: bool,
    progress: Option<Progress>,
}

/// TS `linkedFor(doc, { viewer })` 의 맵과 `linked` 보기. 맵은 순수 판정이다(DB 결과를 받아 만든다).
fn linked_view(doc: &Value, facts: &HashMap<String, Child>) -> (HashMap<String, Linked>, String) {
    let mut map = HashMap::new();
    for id in linked_roots(doc) {
        let l = match facts.get(&id) {
            Some(c) if c.viewer_visible => Linked::Shown(c.progress.unwrap_or_default()),
            _ => Linked::Hidden,
        };
        map.insert(id, l);
    }
    let mut views: Vec<String> = Vec::new();
    for g in doc["groups"].as_array().into_iter().flatten() {
        let Some(root) = g["linkedRootId"].as_str().filter(|s| !s.is_empty()) else {
            continue;
        };
        let group = q(g["id"].as_str().unwrap_or(""));
        views.push(match (map.get(root), facts.get(root)) {
            (Some(Linked::Shown(p)), Some(c)) => format!(
                r#"{{"groupId":{group},"rootId":{},"hidden":false,"channelId":{},"progress":{}}}"#,
                q(root),
                q(&c.channel_id),
                progress_json(p)
            ),
            _ => format!(
                r#"{{"groupId":{group},"rootId":{},"hidden":true,"channelId":null,"progress":null}}"#,
                q(root)
            ),
        });
    }
    (map, format!("[{}]", views.join(",")))
}

fn derived_json(doc: &Value, map: &HashMap<String, Linked>) -> String {
    let parts: Vec<String> = derive_plan(doc, map)
        .into_iter()
        .map(|(id, n)| {
            let waiting: Vec<String> = n.waiting_on.iter().map(|w| q(w)).collect();
            format!(
                r#"{}:{{"derived":{},"waitingOn":[{}],"startedEarly":{}}}"#,
                q(&id),
                q(&n.derived),
                waiting.join(","),
                n.started_early
            )
        })
        .collect();
    format!("{{{}}}", parts.join(","))
}

type PlanRow = (
    String,         // root_id
    String,         // channel_id
    String,         // doc
    i64,            // rev
    String,         // updated_at
    Option<String>, // updated_by
    Option<String>, // flag_reason
    Option<String>, // auto_until
    Option<String>, // auto_source
    Option<String>, // auto_by
    Option<String>, // auto_at
);

/// `GET /threads/{rootId}/plan`.
pub async fn get_thread_plan(
    State(read): State<Arc<PgPool>>,
    RequireAccount(me, _): RequireAccount,
    Path(root_id): Path<String>,
) -> Response {
    if !crate::lists::is_zod_uuid(&root_id) {
        return not_found();
    }
    let pool = read.as_ref();
    let channel = match sqlx::query_as::<_, (String, bool)>(ROOT_SQL)
        .bind(&root_id)
        .fetch_optional(pool)
        .await
    {
        Ok(Some((c, true))) => c,
        Ok(_) => return not_found(),
        Err(e) => return internal(e),
    };
    match channel_visible(pool, &me.id, &channel).await {
        Ok(true) => {}
        Ok(false) => return not_found(),
        Err(e) => return internal(e),
    }
    match plan_view_json(pool, &me.id, &root_id).await {
        Ok(body) => json_ok(body),
        Err(e) => internal(e),
    }
}

/// 연결 그룹 자식들의 사실(보는 사람 기준) — TS `childFacts(db, roots, viewer)`.
async fn child_facts(
    pool: &PgPool,
    viewer: &str,
    doc: &Value,
) -> Result<HashMap<String, Child>, sqlx::Error> {
    let roots = linked_roots(doc);
    let mut facts: HashMap<String, Child> = HashMap::new();
    if !roots.is_empty() {
        let rows: Vec<(String, String, Option<String>, bool)> = sqlx::query_as(children_sql())
            .bind(&roots)
            .bind(viewer)
            .fetch_all(pool)
            .await?;
        let none = HashMap::new();
        for (id, channel_id, child_doc, viewer_visible) in rows {
            // 재귀하지 않는다(K5): 자식의 연결 그룹은 맵 없이 센다.
            let progress = child_doc
                .and_then(|d| serde_json::from_str::<Value>(&d).ok())
                .filter(|d| !d.is_null())
                .map(|d| plan_progress(&d, &none));
            facts.insert(
                id,
                Child {
                    channel_id,
                    viewer_visible,
                    progress,
                },
            );
        }
    }
    Ok(facts)
}

/// TS `linkedFor(pool, doc, { viewer }).map` — 파생 상태를 보는 사람 기준으로 셀 맵(`POST …/plan/start` 미리보기가 쓴다).
pub(crate) async fn linked_map(
    pool: &PgPool,
    viewer: &str,
    doc: &Value,
) -> Result<HashMap<String, Linked>, sqlx::Error> {
    let facts = child_facts(pool, viewer, doc).await?;
    Ok(linked_view(doc, &facts).0)
}

/// 루트·가시성 판정을 **지난 뒤**의 답 몸통 `{"plan":view|null}` — REST GET 과 MCP `thread.plan` 읽기(S5.4 A4a)가 같이 쓴다.
/// TS `getThreadPlan` → `threadPlanView(pool, row, viewer)`. DB 오류는 그대로 돌려준다(REST 는 500, MCP 는 TS 로 넘긴다).
pub async fn plan_view_json(
    pool: &PgPool,
    viewer: &str,
    root_id: &str,
) -> Result<String, sqlx::Error> {
    plan_view_json_with(pool, viewer, root_id, stall_view_on()).await
}

/// [`plan_view_json`] 의 몸통 — `with_stalled` 면 멈춘 단계도 읽어 싣는다(스위치와 떼어 시험한다).
pub async fn plan_view_json_with(
    pool: &PgPool,
    viewer: &str,
    root_id: &str,
    with_stalled: bool,
) -> Result<String, sqlx::Error> {
    let row: PlanRow = match sqlx::query_as(PLAN_SQL)
        .bind(root_id)
        .fetch_optional(pool)
        .await?
    {
        Some(r) => r,
        None => return Ok(r#"{"plan":null}"#.into()),
    };
    let (
        root,
        chan,
        doc_text,
        rev,
        updated_at,
        updated_by,
        flag,
        auto_until,
        auto_src,
        auto_by,
        auto_at,
    ) = row;
    let doc: Value = serde_json::from_str(&doc_text).unwrap_or(Value::Null);
    let facts = child_facts(pool, viewer, &doc).await?;
    let (map, linked) = linked_view(&doc, &facts);
    let flagged = if truthy(&flag) {
        format!(r#"{{"reason":{}}}"#, opt_q(&flag))
    } else {
        "null".into()
    };
    let auto = match (&auto_until, &auto_at) {
        (Some(u), Some(at)) if !u.is_empty() => format!(
            r#"{{"until":{},"sourceMessageId":{},"by":{},"at":{}}}"#,
            q(u),
            opt_q(&auto_src),
            opt_q(&auto_by),
            q(at)
        ),
        _ => "null".into(),
    };
    // 멈춘 단계 — 이 읽기가 실패해도(쓰기 풀에 그 칸 권한이 없는 답 등) 계획 답은 그대로 낸다. 표시가 빠질 뿐이다.
    let stalled = if with_stalled {
        sqlx::query_as::<_, (String, i64)>(STALL_SQL)
            .bind(root_id)
            .fetch_optional(pool)
            .await
            .ok()
            .flatten()
            .and_then(|(raw, now)| {
                let v: Value = serde_json::from_str(&raw).ok()?;
                stalled_json(&doc, &Clock::parse(&v), now)
            })
            .map(|j| format!(r#","stalled":{j}"#))
            .unwrap_or_default()
    } else {
        String::new()
    };
    Ok(format!(
        r#"{{"plan":{{"rootId":{},"channelId":{},"doc":{doc_text},"rev":{rev},"updatedAt":{},"updatedBy":{},"flagged":{flagged},"derived":{},"progress":{},"linked":{linked},"auto":{auto}{stalled}}}}}"#,
        q(&root),
        q(&chan),
        q(&updated_at),
        opt_q(&updated_by),
        derived_json(&doc, &map),
        progress_json(&plan_progress(&doc, &map)),
    ))
}

pub fn routes(
    pool: PgPool,
    auth: crate::auth::AuthPools,
    cors: Arc<crate::cors::Cors>,
) -> crate::route_table::Routes<()> {
    use crate::route_table::Table;
    let t = Table::<Arc<PgPool>>::new()
        .get("/threads/{rootId}/plan", get_thread_plan)
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
        router: t.router.with_state(Arc::new(pool)),
        http: t.http,
        sockets: t.sockets,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn children_sql_binds_viewer() {
        let s = children_sql();
        assert!(s.contains("cm_vis.account_id = $2::uuid"), "{s}");
        assert!(!s.contains("$1::uuid)"), "{s}");
        assert!(s.contains("any($1::uuid[])"), "{s}");
    }

    fn doc() -> Value {
        json!({"goal": "g", "groups": [
            {"id": "g1", "title": "seen", "linkedRootId": "c1", "dependsOn": []},
            {"id": "g2", "title": "hidden", "linkedRootId": "c2", "dependsOn": []},
            {"id": "g3", "title": "gone", "linkedRootId": "c3", "dependsOn": []}
        ], "steps": [
            {"id": "s1", "groupId": null, "title": "a", "state": "pending", "links": [], "dependsOn": ["g2"]},
            {"id": "s2", "groupId": null, "title": "b", "state": "active", "links": [], "dependsOn": ["g1", "g1"]}
        ]})
    }

    fn done() -> Progress {
        Progress {
            done: 1,
            total: 1,
            ..Default::default()
        }
    }

    #[test]
    fn invisible_child_is_hidden_and_does_not_count() {
        let mut facts = HashMap::new();
        for (id, visible) in [("c1", true), ("c2", false)] {
            facts.insert(
                id.to_string(),
                Child {
                    channel_id: format!("ch-{id}"),
                    viewer_visible: visible,
                    progress: Some(done()),
                },
            );
        }
        let (map, linked) = linked_view(&doc(), &facts);
        assert_eq!(map["c1"], Linked::Shown(done()));
        assert_eq!(map["c2"], Linked::Hidden);
        assert_eq!(map["c3"], Linked::Hidden);
        let v: Value = serde_json::from_str(&linked).unwrap();
        assert_eq!(
            v,
            json!([
                {"groupId": "g1", "rootId": "c1", "hidden": false, "channelId": "ch-c1", "progress": {"done": 1, "total": 1, "active": 0, "blocked": 0, "waiting": 0}},
                {"groupId": "g2", "rootId": "c2", "hidden": true, "channelId": null, "progress": null},
                {"groupId": "g3", "rootId": "c3", "hidden": true, "channelId": null, "progress": null}
            ])
        );
        assert!(!linked.contains("ch-c2"));
        // 못 보는 g2 가 끝났어도 s1 은 그것을 기다린다.
        let d: Value = serde_json::from_str(&derived_json(&doc(), &map)).unwrap();
        assert_eq!(
            d,
            json!({
                "g1": {"derived": "done", "waitingOn": [], "startedEarly": false},
                "g2": {"derived": "hidden", "waitingOn": [], "startedEarly": false},
                "g3": {"derived": "hidden", "waitingOn": [], "startedEarly": false},
                "s1": {"derived": "waiting", "waitingOn": ["g2"], "startedEarly": false},
                "s2": {"derived": "active", "waitingOn": [], "startedEarly": false}
            })
        );
        let keys: Vec<String> = derive_plan(&doc(), &map)
            .into_iter()
            .map(|(k, _)| k)
            .collect();
        assert_eq!(keys, ["g1", "g2", "g3", "s1", "s2"]);
    }

    #[test]
    fn stalled_view_shows_only_marked_active_steps_of_a_live_clock() {
        let now = 1_764_061_200; // 2025-11-25T09:00:00Z
        let clock = Clock::parse(
            &json!({"seenAt": now - 60, "lastWokenAt": now - 600, "steps": {
                "s1": {"quietAt": now - 7 * 3600, "markedAt": now - 3600, "wokenAt": now - 600},
                "s2": {"quietAt": now - 7 * 3600, "markedAt": now - 3600},
                "s3": {"quietAt": now - 60},
                "s4": {"quietAt": now - 7 * 3600, "markedAt": now - 3600}
            }}),
        );
        let doc = json!({"steps": [
            {"id": "s1", "state": "active"}, {"id": "s2", "state": "active"},
            {"id": "s3", "state": "active"}, {"id": "s4", "state": "done"}
        ]});
        let v: Value = serde_json::from_str(&stalled_json(&doc, &clock, now).unwrap()).unwrap();
        assert_eq!(
            v,
            json!({
                "s1": {"since": "2025-11-25T02:00:00.000Z", "wokenAt": "2025-11-25T08:50:00.000Z"},
                "s2": {"since": "2025-11-25T02:00:00.000Z", "wokenAt": null}
            })
        );
        // 루프가 한 시간 넘게 안 본 시계(스위치를 껐다)는 믿지 않는다. 표시가 없으면 키도 없다.
        assert_eq!(stalled_json(&doc, &clock, now + 2 * 3600), None);
        assert_eq!(stalled_json(&doc, &Clock::default(), now), None);
        assert_eq!(stalled_json(&json!({"steps": []}), &clock, now), None);
        // 목록 행의 수는 같은 규칙으로 센다.
        assert_eq!(
            stalled_count(&doc, &clock, now),
            v.as_object().unwrap().len()
        );
        assert_eq!(stalled_count(&doc, &clock, now + 2 * 3600), 0);
        assert_eq!(stalled_count(&doc, &Clock::default(), now), 0);
    }

    #[test]
    fn started_early_and_js_key_order() {
        let doc = json!({"goal": "", "groups": [{"id": "g1", "title": "", "dependsOn": []}], "steps": [
            {"id": "s1", "groupId": "g1", "title": "", "state": "pending", "links": [], "dependsOn": []},
            {"id": "10", "groupId": null, "title": "", "state": "done", "links": [], "dependsOn": ["s1"]},
            {"id": "2", "groupId": null, "title": "", "state": "blocked", "links": [], "dependsOn": []}
        ]});
        let d = derive_plan(&doc, &HashMap::new());
        let keys: Vec<&str> = d.iter().map(|(k, _)| k.as_str()).collect();
        assert_eq!(keys, ["2", "10", "g1", "s1"]);
        let ten = &d[1].1;
        assert_eq!(ten.waiting_on, ["s1"]);
        assert!(ten.started_early);
        assert_eq!(d[2].1.derived, "ready");
    }
}
