//! 작업 판(B1) — `work`(작업 행)·`work_event`(사건 이력) 표(마이그레이션 177)의 쓰기·읽기.
//!
//! - 상태의 정본은 `work` 행이다. `work_event` 는 이력일 뿐이고 추가만 한다.
//! - 뿌리 작업은 `parent_id` 가 비고 `root_id = id`. 하위 작업은 부모 행에서 채널·스레드·뿌리·원장 칸(위임장·원인 사람)을
//!   **같은 문장에서** 복사한다 — 부르는 쪽이 넘긴 값으로 뿌리를 바꿀 수 없다.
//! - 쓰기는 아직 어떤 운영 경로에서도 불리지 않는다. 뒤 단계(글→작업 라우팅·위임·깨움·원장)가 쓴다.
//!   읽기 줄 `GET /threads/{rootId}/work` 만 붙는다([`routes`] — 읽기 풀에 [`WORK_READ_PRIVILEGES`] 가 있을 때).
//! - 조회 [`tree`] 는 한 스레드의 작업 나무를 돌려준다. 채널 가시성은 다른 스레드 읽기와 같은 판정([`channel_visible`])이다.
use super::msg_read::channel_visible;
use crate::auth::RequireAccount;
use crate::directory::{internal, json_ok};
use axum::extract::{Path, RawQuery, State};
use axum::http::{StatusCode, header};
use axum::response::{IntoResponse, Response};
use serde_json::{Value, json};
use sqlx::PgPool;
use std::sync::Arc;

/// 쓰기 역할에 줄 권한 — 이 모듈의 문장이 닿는 표 전부. `work_event` 에는 update·delete 를 주지 않는다(추가만).
pub const WORK_PRIVILEGES: &[(&str, &str)] = &[
    ("work", "SELECT"),
    ("work", "INSERT"),
    ("work", "UPDATE"),
    ("work_event", "SELECT"),
    ("work_event", "INSERT"),
];
/// 읽기 줄(`GET /threads/{rootId}/work`)이 읽기 풀에서 필요한 권한. `channel_member` 는 가시성 술어가 읽는다.
/// 없으면 `main.rs` 가 그 줄을 붙이지 않는다.
pub const WORK_READ_PRIVILEGES: &[(&str, &str)] = &[
    ("message", "SELECT"),
    ("channel", "SELECT"),
    ("channel_member", "SELECT"),
    ("work", "SELECT"),
    ("work_event", "SELECT"),
];
pub const WORK_SEQUENCE_PRIVILEGES: &[(&str, &str)] = &[("work_event_id_seq", "USAGE")];

/// `work.state` 의 값(마이그레이션 177 의 check 와 같다).
pub const STATES: &[&str] = &["open", "running", "waiting", "done", "failed", "canceled"];

/// 끝난 상태인가 — 끝난 작업은 `closed_at` 이 찬다.
pub fn is_closed(state: &str) -> bool {
    matches!(state, "done" | "failed" | "canceled")
}

/// 한 스레드에서 한 번에 읽는 작업 행 상한.
pub const TREE_MAX: i64 = 500;

/// 새 작업 하나에 적을 값. 하위 작업(`parent_id` 있음)이면 채널·스레드·뿌리·위임장·원인 사람은 부모 행 값이 이긴다.
#[derive(Debug, Default, Clone)]
pub struct NewWork<'a> {
    pub channel_id: &'a str,
    pub thread_root_id: &'a str,
    pub parent_id: Option<&'a str>,
    pub created_by_work_id: Option<&'a str>,
    pub source_message_id: Option<&'a str>,
    pub assignee_account_id: Option<&'a str>,
    pub requester_account_id: Option<&'a str>,
    pub cause_account_id: Option<&'a str>,
    pub mandate_id: Option<&'a str>,
    pub pool: Option<&'a str>,
    pub title: &'a str,
    pub body: &'a str,
    pub paths: &'a [String],
    pub after_work_id: Option<&'a str>,
    pub due_at_iso: Option<&'a str>,
}

/// `$15` 가 비면 뿌리 작업(`root_id = id`), 있으면 하위 작업 — 채널·스레드·뿌리·위임장·원인 사람을 부모 행에서 복사한다.
/// 부모를 적었는데 그 행이 없으면 0줄이다.
const INSERT_SQL: &str = "with n as (select gen_random_uuid() as id) \
     insert into work (id, parent_id, root_id, channel_id, thread_root_id, created_by_work_id, source_message_id, \
       assignee_account_id, requester_account_id, cause_account_id, mandate_id, pool, title, body, paths, after_work_id, due_at) \
     select n.id, p.id, coalesce(p.root_id, n.id), coalesce(p.channel_id, $1::uuid), coalesce(p.thread_root_id, $2::uuid), \
       $3::uuid, $4::uuid, $5::uuid, $6::uuid, \
       case when p.id is null then $7::uuid else p.cause_account_id end, \
       case when p.id is null then $8::uuid else p.mandate_id end, \
       $9, $10, $11, $12::text[], $13::uuid, $14::timestamptz \
       from n left join work p on p.id = $15::uuid \
      where $15::uuid is null or p.id is not null \
     returning id::text";

const INSERT_EVENT_SQL: &str = "insert into work_event (work_id, kind, actor_account_id, payload) \
     values ($1::uuid, $2, $3::uuid, $4::jsonb) returning id";

/// 작업 하나를 만들고 `created` 사건을 같은 트랜잭션에 남긴다. 하위 작업인데 부모 행이 없으면 `Ok(None)`.
pub async fn create(
    pool: &PgPool,
    w: &NewWork<'_>,
    actor: Option<&str>,
) -> sqlx::Result<Option<String>> {
    let mut tx = pool.begin().await?;
    let q = sqlx::query_scalar::<_, String>(INSERT_SQL)
        .bind(w.channel_id)
        .bind(w.thread_root_id)
        .bind(w.created_by_work_id)
        .bind(w.source_message_id)
        .bind(w.assignee_account_id)
        .bind(w.requester_account_id)
        .bind(w.cause_account_id)
        .bind(w.mandate_id)
        .bind(w.pool)
        .bind(w.title)
        .bind(w.body)
        .bind(w.paths)
        .bind(w.after_work_id)
        .bind(w.due_at_iso)
        .bind(w.parent_id);
    let Some(id) = q.fetch_optional(&mut *tx).await? else {
        return Ok(None);
    };
    let payload = json!({ "parentId": w.parent_id, "assigneeId": w.assignee_account_id });
    sqlx::query_scalar::<_, i64>(INSERT_EVENT_SQL)
        .bind(&id)
        .bind("created")
        .bind(actor)
        .bind(payload.to_string())
        .fetch_one(&mut *tx)
        .await?;
    tx.commit().await?;
    Ok(Some(id))
}

/// 사건 한 줄을 덧붙인다(추가만). 사건 id 를 돌려준다. 작업 행이 없으면 FK 오류다.
pub async fn append_event(
    pool: &PgPool,
    work_id: &str,
    kind: &str,
    actor: Option<&str>,
    payload: &Value,
) -> sqlx::Result<i64> {
    sqlx::query_scalar(INSERT_EVENT_SQL)
        .bind(work_id)
        .bind(kind)
        .bind(actor)
        .bind(payload.to_string())
        .fetch_one(pool)
        .await
}

/// 상태를 바꾸고 `state` 사건을 같은 트랜잭션에 남긴다. 모르는 상태·없는 작업·같은 상태면 `Ok(false)`(사건도 남기지 않는다).
pub async fn set_state(
    pool: &PgPool,
    work_id: &str,
    state: &str,
    actor: Option<&str>,
) -> sqlx::Result<bool> {
    if !STATES.contains(&state) {
        return Ok(false);
    }
    let mut tx = pool.begin().await?;
    // 앞 상태는 잠근 행에서 읽는다 — 두 쓰기가 겹쳐도 사건의 `from` 이 실제 앞 상태다.
    let from: Option<String> =
        sqlx::query_scalar("select state from work where id = $1::uuid for update")
            .bind(work_id)
            .fetch_optional(&mut *tx)
            .await?;
    let Some(from) = from.filter(|f| f != state) else {
        return Ok(false);
    };
    sqlx::query(
        "update work set state = $2, updated_at = now(), \
           closed_at = case when $3 then now() else null end where id = $1::uuid",
    )
    .bind(work_id)
    .bind(state)
    .bind(is_closed(state))
    .execute(&mut *tx)
    .await?;
    sqlx::query_scalar::<_, i64>(INSERT_EVENT_SQL)
        .bind(work_id)
        .bind("state")
        .bind(actor)
        .bind(json!({ "from": from, "to": state }).to_string())
        .fetch_one(&mut *tx)
        .await?;
    tx.commit().await?;
    Ok(true)
}

/// 한 스레드의 작업 행 전부(만든 순) + 행마다 마지막 사건·사건 수. JSON 배열 글자로 받는다.
const TREE_SQL: &str = "select coalesce(json_agg(t order by t.\"createdAt\", t.id), '[]'::json)::text from ( \
     select w.id::text as id, w.parent_id::text as \"parentId\", w.root_id::text as \"rootId\", \
       w.channel_id::text as \"channelId\", w.thread_root_id::text as \"threadRootId\", \
       w.created_by_work_id::text as \"createdByWorkId\", w.source_message_id::text as \"sourceMessageId\", \
       w.assignee_account_id::text as \"assigneeId\", w.requester_account_id::text as \"requesterId\", \
       w.pool, w.title, w.paths, w.after_work_id::text as \"afterWorkId\", w.state, \
       to_char(w.due_at at time zone 'UTC', 'YYYY-MM-DD\"T\"HH24:MI:SS.MS\"Z\"') as \"dueAt\", \
       to_char(w.created_at at time zone 'UTC', 'YYYY-MM-DD\"T\"HH24:MI:SS.US\"Z\"') as \"createdAt\", \
       to_char(w.updated_at at time zone 'UTC', 'YYYY-MM-DD\"T\"HH24:MI:SS.MS\"Z\"') as \"updatedAt\", \
       to_char(w.closed_at at time zone 'UTC', 'YYYY-MM-DD\"T\"HH24:MI:SS.MS\"Z\"') as \"closedAt\", \
       (select count(*) from work_event e where e.work_id = w.id) as \"eventCount\", \
       (select json_build_object('kind', e.kind, 'actorId', e.actor_account_id::text, 'payload', e.payload, \
          'at', to_char(e.created_at at time zone 'UTC', 'YYYY-MM-DD\"T\"HH24:MI:SS.MS\"Z\"')) \
          from work_event e where e.work_id = w.id order by e.id desc limit 1) as \"lastEvent\" \
       from work w where w.thread_root_id = $1::uuid \
      order by w.created_at, w.id limit $2) t";

/// 납작한 행 목록을 나무로 엮는다 — 뿌리(부모가 없거나 부모가 목록에 없는 행)마다 `children` 을 달고, 행마다
/// `openChildren`(안 끝난 바로 아래 작업 수 — 「기다리는 까닭」의 재료)을 붙인다. 순서는 받은 순서(만든 순) 그대로다.
/// 부모 고리가 있어도(표의 check 는 자기 자신만 막는다) 끝난다 — 한 행은 한 번만 놓인다.
pub fn build_tree(rows: Vec<Value>) -> Vec<Value> {
    build_tree_filtered(rows, None)
}

/// [`build_tree`] 에 상태 거르개를 얹은 것. `keep` 이 있으면 그 상태의 행만 남긴다 — 걸러진 부모의 자식은 뿌리 자리로 올라온다.
/// `openChildren` 은 **거르기 전** 목록으로 센다(거르개가 「기다리는 까닭」의 수를 바꾸지 않는다).
pub fn build_tree_filtered(rows: Vec<Value>, keep: Option<&[&str]>) -> Vec<Value> {
    let mut open_of: std::collections::HashMap<String, usize> = std::collections::HashMap::new();
    for r in &rows {
        if let Some(p) = r["parentId"].as_str()
            && !is_closed(r["state"].as_str().unwrap_or(""))
        {
            *open_of.entry(p.to_owned()).or_default() += 1;
        }
    }
    let rows: Vec<Value> = match keep {
        Some(k) => rows
            .into_iter()
            .filter(|r| k.contains(&r["state"].as_str().unwrap_or("")))
            .collect(),
        None => rows,
    };
    let ids: std::collections::HashSet<String> = rows
        .iter()
        .filter_map(|r| r["id"].as_str().map(str::to_owned))
        .collect();
    let mut kids: std::collections::HashMap<String, Vec<Value>> = std::collections::HashMap::new();
    let mut roots = Vec::new();
    for r in rows {
        match r["parentId"].as_str().filter(|p| ids.contains(*p)) {
            Some(p) => kids.entry(p.to_owned()).or_default().push(r),
            None => roots.push(r),
        }
    }
    fn attach(
        mut node: Value,
        kids: &mut std::collections::HashMap<String, Vec<Value>>,
        open_of: &std::collections::HashMap<String, usize>,
        depth: usize,
    ) -> Value {
        let mine = node["id"]
            .as_str()
            .and_then(|id| kids.remove(id))
            .unwrap_or_default();
        let open = node["id"]
            .as_str()
            .and_then(|id| open_of.get(id).copied())
            .unwrap_or(0);
        // 깊이 상한 — 재귀가 스택을 넘지 않게. 넘는 가지는 잘라 낸다(행 수 상한이 TREE_MAX 라 실제로는 닿지 않는다).
        let children: Vec<Value> = if depth >= 64 {
            Vec::new()
        } else {
            mine.into_iter()
                .map(|c| attach(c, kids, open_of, depth + 1))
                .collect()
        };
        if let Some(o) = node.as_object_mut() {
            o.insert("openChildren".into(), json!(open));
            o.insert("children".into(), Value::Array(children));
        }
        node
    }
    roots
        .into_iter()
        .map(|r| attach(r, &mut kids, &open_of, 0))
        .collect()
}

/// [`tree`] 의 답.
#[derive(Debug)]
pub enum Tree {
    /// 스레드 뿌리 글이 없다(지워졌거나 뿌리가 아닌 글).
    NotFound,
    /// 보는 계정이 그 채널을 볼 수 없다.
    Forbidden,
    /// `{ threadRootId, channelId, works: [...] }`.
    Ok(Value),
}

/// `work.tree` — 한 스레드의 작업 나무. 다른 스레드 읽기와 같은 채널 가시성 판정을 거친다.
pub async fn tree(pool: &PgPool, me: &str, thread_root_id: &str) -> sqlx::Result<Tree> {
    tree_filtered(pool, me, thread_root_id, None).await
}

/// [`tree`] 에 상태 거르개를 얹은 것 — `states` 가 있으면 그 상태의 작업만 싣는다([`build_tree_filtered`]).
pub async fn tree_filtered(
    pool: &PgPool,
    me: &str,
    thread_root_id: &str,
    states: Option<&[&str]>,
) -> sqlx::Result<Tree> {
    let ch: Option<String> = sqlx::query_scalar(
        "select channel_id::text from message \
          where id = $1::uuid and thread_root_id is null and deleted_at is null",
    )
    .bind(thread_root_id)
    .fetch_optional(pool)
    .await?;
    let Some(ch) = ch else {
        return Ok(Tree::NotFound);
    };
    if !channel_visible(pool, me, &ch).await? {
        return Ok(Tree::Forbidden);
    }
    let text: String = sqlx::query_scalar(TREE_SQL)
        .bind(thread_root_id)
        .bind(TREE_MAX)
        .fetch_one(pool)
        .await?;
    let rows = match serde_json::from_str::<Value>(&text) {
        Ok(Value::Array(a)) => a,
        _ => Vec::new(),
    };
    Ok(Tree::Ok(json!({
        "threadRootId": thread_root_id,
        "channelId": ch,
        "works": build_tree_filtered(rows, states),
    })))
}

/// `?state=open,running` 을 읽는다 — 쉼표로 여러 개. 없거나 비면 `Ok(None)`(거르지 않음), 모르는 상태가 있으면 `Err`.
pub fn parse_state_filter(raw: Option<&str>) -> Result<Option<Vec<&'static str>>, &'static str> {
    let Some(v) = raw.unwrap_or("").split('&').find_map(|kv| {
        let (k, v) = kv.split_once('=')?;
        (k == "state").then_some(v)
    }) else {
        return Ok(None);
    };
    let v = v.replace("%2C", ",").replace("%2c", ",");
    let mut out: Vec<&'static str> = Vec::new();
    for part in v.split(',').filter(|p| !p.is_empty()) {
        let s = STATES.iter().find(|s| **s == part).ok_or("invalid_state")?;
        if !out.contains(s) {
            out.push(s);
        }
    }
    Ok((!out.is_empty()).then_some(out))
}

fn json_code(status: StatusCode, body: &'static str) -> Response {
    (
        status,
        [(header::CONTENT_TYPE, "application/json; charset=utf-8")],
        body,
    )
        .into_response()
}

/// `GET /threads/{rootId}/work[?state=open,running]` — 한 스레드의 작업 나무. 판정 순서는 계획판 읽기(`thread_plan_read`)와 같다:
/// 로그인(401) → rootId 가 uuid 아님·뿌리 글 없음·그 채널을 못 봄(모두 404 `{ "error": "not_found" }` — 있는지 없는지를 가르지 않는다).
/// 모르는 상태 값은 400 `{ "error": "invalid_state" }`.
pub async fn get_thread_work(
    State(read): State<Arc<PgPool>>,
    RequireAccount(me, _): RequireAccount,
    Path(root_id): Path<String>,
    RawQuery(raw): RawQuery,
) -> Response {
    const NOT_FOUND: &str = r#"{"error":"not_found"}"#;
    if !crate::lists::is_zod_uuid(&root_id) {
        return json_code(StatusCode::NOT_FOUND, NOT_FOUND);
    }
    let Ok(states) = parse_state_filter(raw.as_deref()) else {
        return json_code(StatusCode::BAD_REQUEST, r#"{"error":"invalid_state"}"#);
    };
    match tree_filtered(read.as_ref(), &me.id, &root_id, states.as_deref()).await {
        Ok(Tree::Ok(v)) => json_ok(v.to_string()),
        Ok(Tree::NotFound | Tree::Forbidden) => json_code(StatusCode::NOT_FOUND, NOT_FOUND),
        Err(e) => internal(e),
    }
}

/// 읽기 줄 1개. 읽기 풀만 쓴다.
pub fn routes(
    pool: PgPool,
    auth: crate::auth::AuthPools,
    cors: Arc<crate::cors::Cors>,
) -> crate::route_table::Routes<()> {
    use crate::route_table::Table;
    let t = Table::<Arc<PgPool>>::new()
        .get("/threads/{rootId}/work", get_thread_work)
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

    fn row(id: &str, parent: Option<&str>, state: &str) -> Value {
        json!({ "id": id, "parentId": parent, "state": state })
    }

    #[test]
    fn closed_states_match_the_list() {
        for s in STATES {
            assert_eq!(is_closed(s), matches!(*s, "done" | "failed" | "canceled"));
        }
        assert!(!is_closed("nope"));
    }

    #[test]
    fn tree_nests_children_and_counts_open_ones() {
        let t = build_tree(vec![
            row("a", None, "running"),
            row("b", Some("a"), "done"),
            row("c", Some("a"), "open"),
            row("d", Some("c"), "waiting"),
            row("e", None, "open"),
        ]);
        assert_eq!(t.len(), 2);
        assert_eq!(t[0]["id"], "a");
        assert_eq!(t[0]["openChildren"], 1);
        let kids = t[0]["children"].as_array().unwrap();
        assert_eq!(kids.len(), 2);
        assert_eq!(kids[0]["id"], "b");
        assert_eq!(kids[1]["children"][0]["id"], "d");
        assert_eq!(kids[1]["openChildren"], 1);
        assert_eq!(t[1]["children"], json!([]));
        assert_eq!(t[1]["openChildren"], 0);
    }

    #[test]
    fn orphan_becomes_a_root_and_cycles_end() {
        // 부모가 목록에 없으면(상한에 잘림) 뿌리로 놓는다.
        let t = build_tree(vec![row("x", Some("gone"), "open")]);
        assert_eq!(t.len(), 1);
        assert_eq!(t[0]["id"], "x");
        // 서로를 부모로 가리키는 고리는 뿌리가 없어 빈 나무다 — 멈추지 않고 끝난다.
        let t = build_tree(vec![
            row("p", Some("q"), "open"),
            row("q", Some("p"), "open"),
        ]);
        assert!(t.is_empty());
    }

    #[test]
    fn state_filter_keeps_matching_rows_and_full_open_counts() {
        let rows = || {
            vec![
                row("a", None, "done"),
                row("b", Some("a"), "open"),
                row("c", Some("b"), "running"),
                row("d", Some("b"), "done"),
            ]
        };
        // 걸러진 부모(a)의 자식은 뿌리 자리로 올라오고, openChildren 은 거르기 전 수다.
        let t = build_tree_filtered(rows(), Some(&["open", "running"]));
        assert_eq!(t.len(), 1);
        assert_eq!(t[0]["id"], "b");
        assert_eq!(t[0]["openChildren"], 1);
        assert_eq!(t[0]["children"].as_array().unwrap().len(), 1);
        assert_eq!(t[0]["children"][0]["id"], "c");
        let t = build_tree_filtered(rows(), Some(&["done"]));
        assert_eq!(t.len(), 2);
        assert_eq!(t[0]["id"], "a");
        assert_eq!(t[0]["openChildren"], 1);
        assert_eq!(t[1]["id"], "d");
    }

    #[test]
    fn state_filter_query_parses() {
        assert_eq!(parse_state_filter(None), Ok(None));
        assert_eq!(parse_state_filter(Some("x=1")), Ok(None));
        assert_eq!(parse_state_filter(Some("state=")), Ok(None));
        assert_eq!(
            parse_state_filter(Some("a=b&state=open%2Crunning,open")),
            Ok(Some(vec!["open", "running"]))
        );
        assert_eq!(parse_state_filter(Some("state=nope")), Err("invalid_state"));
    }

    #[test]
    fn read_privileges_are_select_only() {
        assert!(WORK_READ_PRIVILEGES.iter().all(|(_, p)| *p == "SELECT"));
    }

    #[test]
    fn event_table_is_append_only_in_privileges() {
        assert!(
            WORK_PRIVILEGES
                .iter()
                .all(|(t, p)| *t != "work_event" || matches!(*p, "SELECT" | "INSERT"))
        );
        assert!(WORK_PRIVILEGES.iter().all(|(_, p)| *p != "DELETE"));
    }
}
