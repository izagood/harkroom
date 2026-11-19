//! S5.4 A4b2 — MCP `thread.plan` **쓰기**(`plan` 객체·null)와 `thread.plan.item`(자동 진행 `auto` 칸 없는 것)을 Rust 가 답한다.
//! TS `services/threadPlan.ts` 의 `writeThreadPlan`·`setThreadPlan` 과 `mcpPlugin.ts` 의 두 핸들러·`planWritten` 을 옮긴다.
//!
//! - 입력 꼴은 [`super::plan_input`](zod 이식)이 본다. 애매하면 `None` → TS.
//! - 판정 순서는 TS 와 같다: `agents_only` → 루트(`not_found`·`not_root`) → 가시성(`forbidden`) → 잠금(`for update`) →
//!   새 판 만들기(guard 비교 / [`apply_plan_item`]) → 번호표(`plan_seq`) → 관리자(기본값·`invalid_manager`) → [`validate_plan`] →
//!   연결 꼴(`invalid_linked_root`·`self_link`) → **새로 더한** 연결만 존재·가시성(`linked_thread_unavailable`) →
//!   쓰기 검사([`plan_texts`] → `scan_write`, 걸려도 저장하고 `flag_reason`) → 저장 → `thread_plan_link` 다시 쓰기 → 이벤트.
//!   새 판은 **반드시** `validate_plan` 과 쓰기 검사를 지난 뒤에만 저장한다(security, A4b1 조건).
//! - 관리자가 바뀌는데 자동 진행이 켜져 있으면 같은 tx 에서 끄고 커밋 뒤 끄기 알림(`noticePlanAutoOff`)을 올린다. 알림 글 경로
//!   (`McpWrites::plan_auto_off`, TP3 끄기 칸 권한)가 없을 때만 되감고 TS 로 넘긴다.
//! - `thread.plan.changed` 이벤트는 같은 트랜잭션에서 outbox 에 넣는다(커밋돼야 나간다). progress 는 **청중 맵**(public standard 이거나
//!   같은 채널인 자식만 연다), 도구 답의 progress·nowReady·nowWaiting 은 **부른 계정 맵**이다(TS R2).
//! - 트랜잭션 앞의 DB 오류는 `None`(TS 가 다시 돈다). 트랜잭션을 연 뒤의 오류는 `internal`(security W1).
//! - 백그라운드 회차의 읽기 전용 관문(`bg_plan_read_only`)은 TS `/mcp/admit` 이 이미 봤다([`super::route::serve`]).
use super::plan_input::{PlanSet, parse_item, parse_plan_set};
use super::respond::text_result;
use super::tools::err;
use crate::auth::Account;
use crate::core::msg_list::{Linked, Progress, derive_plan, linked_roots, plan_progress};
use crate::core::plan_graph::{
    ItemPatch, PlanError, apply_plan_item, diff_derived, plan_seq, plan_texts, validate_plan,
};
use serde_json::{Value, json};
use sqlx::{PgConnection, PgPool};
use std::collections::HashMap;
use std::sync::OnceLock;

/// 쓰기 풀에 있어야 하는 권한(표, 권한) — 읽기는 `pg_read_all_data`. 없으면 `main.rs` 가 쓰기를 TS 에 둔다.
/// homelab 의 앞단 쓰기 역할 GRANT 와 같아야 한다.
pub const PLAN_WRITE_PRIVILEGES: &[(&str, &str)] = &[
    ("thread_plan", "INSERT"),
    ("thread_plan", "UPDATE"),
    ("thread_plan", "DELETE"),
    ("thread_plan_link", "INSERT"),
    ("thread_plan_link", "DELETE"),
    ("event_outbox", "INSERT"),
];
/// 시퀀스 권한 — `event_outbox.id` 는 bigserial.
pub const PLAN_WRITE_SEQUENCE_PRIVILEGES: &[(&str, &str)] = &[("event_outbox_id_seq", "USAGE")];

/// TS `PLAN_ERROR_MESSAGES` — 쓰기 갈래에서 나올 수 있는 코드 전부.
const MESSAGES: &[(&str, &str)] = &[
    ("not_found", "그런 글이 없다"),
    (
        "not_root",
        "스레드 루트 글의 id 를 줘라(대화 프롬프트 맨 위의 threadRootId)",
    ),
    ("forbidden", "not a member of this channel"),
    (
        "guard_required",
        "계획이 이미 있다 — thread.plan 으로 읽고 그 updatedAt 을 ifUpdatedAt 으로 줘라(다른 에이전트가 세운 단계가 날아가지 않게). 단계 하나만 고칠 거면 thread.plan.item 을 써라",
    ),
    (
        "conflict",
        "그 사이 다른 턴이 계획을 고쳤다 — 다시 읽고 합쳐서 그 updatedAt 으로 써라",
    ),
    (
        "rev_conflict",
        "그 사이 계획이 바뀌었다(ifRev 불일치) — 다시 읽고 고쳐라",
    ),
    (
        "no_plan",
        "아직 계획이 없다 — thread.plan 으로 먼저 세워라(ifUpdatedAt: null)",
    ),
    (
        "invalid_manager",
        "managerId 는 이 채널을 볼 수 있는 에이전트 계정이어야 한다",
    ),
    (
        "manager_required",
        "type: 'plan' 에는 managerId 를 준다(null 이면 비운다)",
    ),
    ("unknown_item", "그런 단계·그룹이 없다"),
    (
        "field_not_for_type",
        "그 종류에 없는 칸이다(state·groupId·links·blockedReason 은 단계만, linkedRootId 는 그룹만)",
    ),
    ("title_required", "새 단계·그룹에는 title 이 필요하다"),
    (
        "linked_thread_unavailable",
        "연결할 스레드가 없거나 볼 수 없다(답글 id 도 이것이다)",
    ),
    ("self_link", "자기 스레드는 연결할 수 없다"),
    ("invalid_linked_root", "linkedRootId 가 uuid 꼴이 아니다"),
    (
        "dependency_cycle",
        "의존이 고리를 이룬다 — path 를 보고 하나를 끊어라",
    ),
    ("unknown_ref", "없는 단계·그룹을 가리켰다"),
    ("self_ref", "자기 자신을 의존으로 걸었다"),
    (
        "linked_group_has_steps",
        "다른 스레드에 연결한 그룹은 자기 단계를 가질 수 없다(그 스레드의 계획이 정본이다)",
    ),
    ("limit_exceeded", "상한을 넘었다"),
    ("duplicate_id", "같은 id 가 둘이다"),
    (
        "invalid_id",
        "id 꼴이 틀렸다(그룹 g1~g9999, 단계 s1~s9999). 번호가 9999 에 닿아 더 더할 수 없으면 thread.plan 으로 읽은 뒤 지우고(plan: null) 새 번호로 다시 세우면 풀린다",
    ),
];

const AGENTS_ONLY: &str = "계획판 쓰기 도구는 에이전트만 쓴다";

fn q(s: &str) -> String {
    Value::from(s).to_string()
}

/// 쓰기 거절 — 중괄호 없는 칸 글자(TS 객체 키 순서). 코드는 첫 칸에서 다시 읽는다.
#[derive(Debug, Clone, PartialEq, Eq)]
struct Refusal {
    code: &'static str,
    fields: String,
}

impl Refusal {
    fn id(code: &'static str, id: &str) -> Self {
        Self {
            code,
            fields: format!("\"code\":{},\"id\":{}", q(code), q(id)),
        }
    }
    fn plain(code: &'static str) -> Self {
        Self {
            code,
            fields: format!("\"code\":{}", q(code)),
        }
    }
    fn plan(e: &PlanError) -> Self {
        Self {
            code: e.code(),
            fields: e.fields_json(),
        }
    }
    /// TS `planError` — `{ error: { ...error, message } }`.
    fn text(&self) -> String {
        let msg = MESSAGES
            .iter()
            .find(|(c, _)| *c == self.code)
            .map_or(self.code, |(_, m)| m);
        text_result(&format!(
            "{{\"error\":{{{},\"message\":{}}}}}",
            self.fields,
            q(msg)
        ))
    }
}

fn internal() -> String {
    err("internal", "the write failed; it was not retried")
}

/// TS `UUID_RE`(대소문자 무시, 판 숫자 안 봄).
fn is_uuid_shape(s: &str) -> bool {
    let b = s.as_bytes();
    b.len() == 36
        && b.iter().enumerate().all(|(i, c)| match i {
            8 | 13 | 18 | 23 => *c == b'-',
            _ => c.is_ascii_hexdigit(),
        })
}

fn golden(k: &str) -> String {
    let v: Value = serde_json::from_str(include_str!("../../../golden/sql_fragments.json"))
        .expect("golden/sql_fragments.json");
    v[k].as_str()
        .unwrap_or_else(|| panic!("golden fragment {k}"))
        .to_string()
}

/// TS `childFacts(client, roots, viewer)` — 청중 판정 칸(`public_channel`)과 보는 사람 칸을 같이 읽는다. `$1` 자식들, `$2` 보는 사람.
fn children_sql() -> &'static str {
    static S: OnceLock<String> = OnceLock::new();
    S.get_or_init(|| {
        let visible = golden("channel_visible_c_p1uuid").replace("$1::uuid", "$2::uuid");
        format!(
            "select f.id::text, f.channel_id::text, f.doc::text, f.public_channel, ({visible}) as viewer_visible \
             from ({}) f join channel c on c.id = f.channel_id",
            golden("plan_progress_children")
        )
    })
}

/// TS 관리자 자격 — 지워지지 않은 에이전트이고 그 채널을 본다. `$1` 계정, `$2` 채널.
fn manager_sql() -> &'static str {
    static S: OnceLock<String> = OnceLock::new();
    S.get_or_init(|| {
        format!(
            "select 1 from account a join channel c on c.id = $2::uuid \
              where a.id = $1::uuid and a.kind = 'agent' and a.deleted_at is null and {}",
            golden("channel_visible_c_p1uuid")
        )
    })
}

const LOCK_SQL: &str = concat!(
    "select ",
    crate::iso!("updated_at"),
    ", rev::int8, doc::text, auto_until, auto_at is not null from thread_plan where root_id = $1::uuid for update"
);

const UPSERT_SQL: &str = concat!(
    "insert into thread_plan (root_id, channel_id, doc, flag_reason, updated_by) values ($1::uuid, $2::uuid, $3::jsonb, $4, $5::uuid) \
     on conflict (root_id) do update \
       set doc = excluded.doc, flag_reason = excluded.flag_reason, updated_by = excluded.updated_by, \
           rev = thread_plan.rev + 1, \
           updated_at = greatest(now(), thread_plan.updated_at + interval '1 millisecond') \
     returning rev::int8, ",
    crate::iso!("updated_at")
);

/// 자식 루트 하나의 사실(행이 없으면 없는 자식).
#[derive(Debug, Clone)]
struct Child {
    channel_id: String,
    public_channel: bool,
    viewer_visible: bool,
    progress: Option<Progress>,
}

type Facts = Vec<(String, Child)>;

fn find<'a>(facts: &'a Facts, id: &str) -> Option<&'a Child> {
    facts.iter().find(|(k, _)| k == id).map(|(_, c)| c)
}

async fn child_facts(
    conn: &mut PgConnection,
    roots: &[String],
    viewer: &str,
) -> sqlx::Result<Facts> {
    if roots.is_empty() {
        return Ok(Vec::new());
    }
    let rows: Vec<(String, String, Option<String>, bool, bool)> = sqlx::query_as(children_sql())
        .bind(roots)
        .bind(viewer)
        .fetch_all(&mut *conn)
        .await?;
    let none = HashMap::new();
    Ok(rows
        .into_iter()
        .map(|(id, channel_id, doc, public_channel, viewer_visible)| {
            // 재귀하지 않는다(K5).
            let progress = doc
                .and_then(|d| serde_json::from_str::<Value>(&d).ok())
                .filter(|d| !d.is_null())
                .map(|d| plan_progress(&d, &none));
            (
                id,
                Child {
                    channel_id,
                    public_channel,
                    viewer_visible,
                    progress,
                },
            )
        })
        .collect())
}

/// 받는 쪽 맵 — 보는 사람(`audience: None`) 또는 부모 채널 청중(`Some(채널)`). 못 보거나 없는 자식은 hidden.
fn linked_map(doc: &Value, facts: &Facts, audience: Option<&str>) -> HashMap<String, Linked> {
    linked_roots(doc)
        .into_iter()
        .map(|id| {
            let shown = find(facts, &id).filter(|c| match audience {
                None => c.viewer_visible,
                Some(ch) => c.public_channel || c.channel_id == ch,
            });
            let l = match shown {
                Some(c) => Linked::Shown(c.progress.unwrap_or_default()),
                None => Linked::Hidden,
            };
            (id, l)
        })
        .collect()
}

fn progress_value(p: &Progress) -> Value {
    json!({ "done": p.done, "total": p.total, "active": p.active, "blocked": p.blocked, "waiting": p.waiting })
}

fn progress_text(p: &Progress) -> String {
    format!(
        r#"{{"done":{},"total":{},"active":{},"blocked":{},"waiting":{}}}"#,
        p.done, p.total, p.active, p.blocked, p.waiting
    )
}

/// 잠근 판.
struct Locked {
    updated_at: String,
    rev: i64,
    doc: Value,
    auto_on: bool,
}

/// 새 판을 만드는 법.
enum Build {
    /// `thread.plan` 전체 쓰기(`None` = 지우기).
    #[allow(clippy::option_option)]
    Set {
        doc: Option<Value>,
        guard: Option<Option<String>>,
    },
    /// `thread.plan.item`.
    Item(Box<ItemPatch>),
    /// 잠근 판 `(doc, rev)` 에서 새 판을 만드는 함수(HTTP `plan/start`, S5.4 TP5b). `Err` 는 거절 코드.
    Custom(StartBuild),
}

/// [`Build::Custom`] 의 함수.
pub(crate) type StartBuild =
    Box<dyn FnOnce(Option<(&Value, i64)>) -> Result<Value, &'static str> + Send>;

/// TS `setThreadPlan` 의 build — guard 비교. 시각은 둘 다 밀리초 ISO 글자라 글자 비교가 `getTime()` 비교와 같다.
#[allow(clippy::option_option)]
fn build_set(
    now: Option<&Locked>,
    doc: Option<Value>,
    guard: Option<Option<String>>,
) -> Result<Option<Value>, Refusal> {
    if let (Some(n), None) = (now, &guard) {
        return Err(Refusal {
            code: "guard_required",
            fields: format!(
                "\"code\":\"guard_required\",\"updatedAt\":{},\"rev\":{}",
                q(&n.updated_at),
                n.rev
            ),
        });
    }
    if let Some(want) = guard
        && want.as_deref() != now.map(|n| n.updated_at.as_str())
    {
        let (at, rev) = now.map_or(("null".into(), "null".into()), |n| {
            (q(&n.updated_at), n.rev.to_string())
        });
        return Err(Refusal {
            code: "conflict",
            fields: format!("\"code\":\"conflict\",\"updatedAt\":{at},\"rev\":{rev}"),
        });
    }
    Ok(doc)
}

/// 관리자 칸 정리(TS): 칸이 없으면 앞 판 값 유지, null 이면 비움. 처음 세울 때 비었으면 쓰는 에이전트. `(새 관리자, 앞 관리자)`.
fn settle_manager(
    doc: &mut Value,
    before: Option<&Value>,
    me: &str,
) -> (Option<String>, Option<String>) {
    let s = |v: &Value| v.as_str().filter(|s| !s.is_empty()).map(str::to_string);
    let prev = before.and_then(|b| s(&b["managerId"]));
    let Some(o) = doc.as_object_mut() else {
        return (None, prev);
    };
    let mut manager = match o.get("managerId") {
        None => prev.clone(),
        Some(v) => s(v),
    };
    if before.is_none() && manager.is_none() {
        manager = Some(me.to_string());
    }
    match &manager {
        Some(m) => {
            o.insert("managerId".into(), Value::from(m.as_str()));
        }
        None => {
            o.remove("managerId");
        }
    }
    (manager, prev)
}

/// 연결 꼴 — TS 순서(그룹 순서, 중복 없음)로 첫 거절.
fn link_shape(doc: &Value, root: &str) -> Option<Refusal> {
    for id in linked_roots(doc) {
        if !is_uuid_shape(&id) {
            return Some(Refusal::id("invalid_linked_root", &id));
        }
        if id.eq_ignore_ascii_case(root) {
            return Some(Refusal::id("self_link", &id));
        }
    }
    None
}

/// 잠근 판과 견줘 새로 더한 연결(R1).
fn added_links(doc: &Value, before: Option<&Value>) -> Vec<String> {
    let had: Vec<String> = before
        .map(|b| {
            linked_roots(b)
                .iter()
                .map(|s| s.to_ascii_lowercase())
                .collect()
        })
        .unwrap_or_default();
    linked_roots(doc)
        .into_iter()
        .filter(|id| !had.contains(&id.to_ascii_lowercase()))
        .collect()
}

/// TS `childFacts` 맵 순서(찾은 행 → 못 찾은 것)로 첫 거절.
fn unavailable(added: &[String], facts: &Facts) -> Option<Refusal> {
    if let Some((id, _)) = facts
        .iter()
        .find(|(id, c)| added.contains(id) && !c.viewer_visible)
    {
        return Some(Refusal::id("linked_thread_unavailable", id));
    }
    added
        .iter()
        .find(|id| find(facts, id).is_none())
        .map(|id| Refusal::id("linked_thread_unavailable", id))
}

/// 쓴 결과.
enum Outcome {
    Refused(Refusal),
    Deleted,
    Written {
        id: String,
        rev: i64,
        updated_at: String,
        doc: Value,
        before: Option<Value>,
        facts: Facts,
        flag: Option<crate::core::content_scan::ScanHit>,
        /// 관리자가 바뀌어 자동 진행을 같은 tx 에서 껐다 — (새 관리자, 앞 관리자). 끄기 알림은 부른 쪽 몫이다.
        auto_off: Option<(Option<String>, Option<String>)>,
    },
    /// 관리자가 바뀌는데 자동 진행이 켜져 있다 — 되감았다. TS 가 답한다.
    ToTs,
}

async fn write_plan(
    write: &PgPool,
    me: &str,
    root: &str,
    channel: &str,
    build: Build,
    clear_auto: bool,
) -> sqlx::Result<Outcome> {
    let mut tx = write.begin().await?;
    let cur: Option<(String, i64, String, Option<String>, bool)> = sqlx::query_as(LOCK_SQL)
        .bind(root)
        .fetch_optional(&mut *tx)
        .await?;
    let now = cur.map(|(updated_at, rev, doc, auto_until, auto_at)| Locked {
        updated_at,
        rev,
        doc: serde_json::from_str(&doc).unwrap_or(Value::Null),
        auto_on: auto_until.is_some_and(|u| !u.is_empty()) && auto_at,
    });
    let refuse = |r: Refusal| Ok(Outcome::Refused(r));
    let built = match build {
        Build::Set { doc, guard } => {
            build_set(now.as_ref(), doc, guard).map(|d| (d, String::new()))
        }
        Build::Item(p) => apply_plan_item(now.as_ref().map(|n| (&n.doc, n.rev)), &p)
            .map(|(d, id)| (Some(d), id))
            .map_err(|e| Refusal::plan(&e)),
        Build::Custom(f) => f(now.as_ref().map(|n| (&n.doc, n.rev)))
            .map(|d| (Some(d), String::new()))
            .map_err(Refusal::plain),
    };
    let before = now.as_ref().map(|n| &n.doc);
    let doc = match built {
        Err(r) => {
            tx.rollback().await?;
            return refuse(r);
        }
        Ok((None, _)) => {
            sqlx::query("delete from thread_plan where root_id = $1::uuid")
                .bind(root)
                .execute(&mut *tx)
                .await?;
            emit(&mut tx, channel, root, None).await?;
            tx.commit().await?;
            return Ok(Outcome::Deleted);
        }
        Ok((Some(d), id)) => (d, id),
    };
    let (mut doc, id) = doc;
    // 번호표는 서버가 정한다(입력 seq 는 zod 가 버렸다).
    let (s, g) = plan_seq(before, &doc);
    if let Some(o) = doc.as_object_mut() {
        o.insert("seq".into(), json!({ "s": s, "g": g }));
    }
    let (manager, prev_manager) = settle_manager(&mut doc, before, me);
    let auto_off =
        if now.is_some() && manager != prev_manager && now.as_ref().is_some_and(|n| n.auto_on) {
            if !clear_auto {
                tx.rollback().await?;
                return Ok(Outcome::ToTs);
            }
            Some((manager.clone(), prev_manager.clone()))
        } else {
            None
        };
    if let Some(m) = manager
        .as_deref()
        .filter(|m| Some(*m) != prev_manager.as_deref())
    {
        // zod 를 지난 uuid 지만, 앞 판에서 온 값이 아니면 언제나 새 값이다 — 형식이 이상하면 거절로 둔다.
        let ok = crate::lists::is_zod_uuid(m)
            && sqlx::query(manager_sql())
                .bind(m)
                .bind(channel)
                .fetch_optional(&mut *tx)
                .await?
                .is_some();
        if !ok {
            tx.rollback().await?;
            return refuse(Refusal::id("invalid_manager", m));
        }
    }
    if let Err(e) = validate_plan(&doc) {
        tx.rollback().await?;
        return refuse(Refusal::plan(&e));
    }
    if let Some(r) = link_shape(&doc, root) {
        tx.rollback().await?;
        return refuse(r);
    }
    let added = added_links(&doc, before);
    let added_facts = child_facts(&mut tx, &added, me).await?;
    if let Some(r) = unavailable(&added, &added_facts) {
        tx.rollback().await?;
        return refuse(r);
    }
    // 쓰기 검사(080) — validate_plan 을 지난 판에만. 걸려도 저장하고 flag_reason 에 남긴다.
    let texts = plan_texts(&doc);
    let parts: Vec<Option<&str>> = texts.iter().map(|t| Some(t.as_str())).collect();
    let flag = crate::core::content_scan::scan_write(&parts);
    let (rev, updated_at): (i64, String) = sqlx::query_as(UPSERT_SQL)
        .bind(root)
        .bind(channel)
        .bind(doc.to_string())
        .bind(flag.as_ref().map(|f| f.reason.as_str()))
        .bind(me)
        .fetch_one(&mut *tx)
        .await?;
    // 역참조는 doc 에서 다시 만든다 — 정본은 doc 하나다.
    sqlx::query("delete from thread_plan_link where parent_root = $1::uuid")
        .bind(root)
        .execute(&mut *tx)
        .await?;
    let roots = linked_roots(&doc);
    if !roots.is_empty() {
        sqlx::query(
            "insert into thread_plan_link (parent_root, child_root) select $1::uuid, unnest($2::uuid[]) on conflict do nothing",
        )
        .bind(root)
        .bind(&roots)
        .execute(&mut *tx)
        .await?;
    }
    // TS `managerChanged && written.auto` — 같은 tx 에서 끈다(rev 는 올리지 않는다).
    if auto_off.is_some() {
        sqlx::query(AUTO_CLEAR_SQL)
            .bind(root)
            .execute(&mut *tx)
            .await?;
    }
    // 답(보는 사람 맵)과 이벤트(청중 맵)에 쓸 사실 — 앞 판·새 판의 연결 전부.
    let mut all = roots;
    for id in before.map(linked_roots).unwrap_or_default() {
        if !all.contains(&id) {
            all.push(id);
        }
    }
    let facts = child_facts(&mut tx, &all, me).await?;
    let audience_progress = plan_progress(&doc, &linked_map(&doc, &facts, Some(channel)));
    emit(&mut tx, channel, root, Some((rev, &audience_progress))).await?;
    tx.commit().await?;
    Ok(Outcome::Written {
        id,
        rev,
        updated_at,
        doc,
        before: now.map(|n| n.doc),
        facts,
        flag,
        auto_off,
    })
}

/// TS `writeThreadPlan` 의 관리자 바뀜 자동 진행 끄기.
const AUTO_CLEAR_SQL: &str = "update thread_plan \
     set auto_until = null, auto_source = null, auto_by = null, auto_mandate = null, auto_at = null, \
         auto_woken = '{}'::jsonb, auto_range = '{}'::jsonb \
     where root_id = $1::uuid";

/// TS `emitPlanChanged(pool, channel, root, row)` — 판이 있을 때, 같은 tx 의 outbox 로(S5.4 TP3 자동 진행 끄기가 쓴다).
/// 진행률은 청중 맵(public standard 이거나 같은 채널)으로 센다. `viewer` 는 자식 사실 문장의 자리를 채울 뿐 맵에 쓰지 않는다.
pub(crate) async fn emit_changed(
    conn: &mut PgConnection,
    channel: &str,
    root: &str,
    rev: i64,
    doc: &Value,
    viewer: &str,
) -> sqlx::Result<()> {
    let facts = child_facts(&mut *conn, &linked_roots(doc), viewer).await?;
    let progress = plan_progress(doc, &linked_map(doc, &facts, Some(channel)));
    emit(conn, channel, root, Some((rev, &progress))).await
}

/// TS `emitPlanChanged` — 지웠으면 rev·progress 가 null.
async fn emit(
    conn: &mut PgConnection,
    channel: &str,
    root: &str,
    row: Option<(i64, &Progress)>,
) -> sqlx::Result<()> {
    let audience = crate::core::audience::audience_on(&mut *conn, channel).await?;
    let event = json!({
        "type": "thread.plan.changed",
        "channelId": channel,
        "rootId": root,
        "rev": row.map(|(r, _)| r),
        "progress": row.map(|(_, p)| progress_value(p)),
        "audience": audience.to_json(),
    });
    crate::write::emit_event(conn, &event).await?;
    Ok(())
}

/// TS `planWritten` — `{ ok, rev, updatedAt, progress, ...extra, nowReady, nowWaiting, ...flagged }` 그 키 순서.
fn written_text(
    rev: i64,
    updated_at: &str,
    doc: &Value,
    before: Option<&Value>,
    facts: &Facts,
    flag: Option<&crate::core::content_scan::ScanHit>,
    extra: Option<(&str, bool)>,
) -> String {
    let after_map = linked_map(doc, facts, None);
    let after = derive_plan(doc, &after_map);
    let prev = before
        .map(|b| derive_plan(b, &linked_map(b, facts, None)))
        .unwrap_or_default();
    let (ready, waiting) = diff_derived(&prev, &after);
    let mut s = format!(
        "{{\"ok\":true,\"rev\":{rev},\"updatedAt\":{},\"progress\":{}",
        q(updated_at),
        progress_text(&plan_progress(doc, &after_map))
    );
    if let Some((id, removed)) = extra {
        s.push_str(&format!(",\"id\":{},\"removed\":{removed}", q(id)));
    }
    s.push_str(&format!(
        ",\"nowReady\":{},\"nowWaiting\":{}",
        json!(ready),
        json!(waiting)
    ));
    if let Some(f) = flag {
        s.push_str(&format!(
            ",\"flagged\":{{\"reason\":{},\"rules\":{}}},\"notice\":{}",
            q(&f.reason),
            json!(f.rules),
            q(&format!(
                "저장했지만 쓰기 검사에 걸렸다({}) — 사람에게는 보이지만 다음 턴 프롬프트에는 싣지 않는다. 남의 글을 옮겼거나 비밀 값을 넣었다면 빼고 다시 써라.",
                f.reason
            ))
        ));
    }
    s.push('}');
    text_result(&s)
}

/// 루트·가시성(트랜잭션 앞, 읽기 풀). `Err` 는 거절 글자. DB 오류는 `None` → TS.
async fn gate(read: &PgPool, me: &Account, root: &str) -> Option<Result<String, String>> {
    let row: Option<(String, bool)> = sqlx::query_as(crate::core::thread_plan_read::ROOT_SQL)
        .bind(root)
        .fetch_optional(read)
        .await
        .ok()?;
    let channel = match row {
        None => return Some(Err(Refusal::plain("not_found").text())),
        Some((_, false)) => return Some(Err(Refusal::plain("not_root").text())),
        Some((c, true)) => c,
    };
    if !crate::core::msg_read::channel_visible(read, &me.id, &channel)
        .await
        .ok()?
    {
        return Some(Err(Refusal::plain("forbidden").text()));
    }
    Some(Ok(channel))
}

async fn run(
    read: &PgPool,
    write: &PgPool,
    post: Option<&crate::core::msg_post::PostState>,
    me: &Account,
    root: &str,
    build: Build,
    item_removed: Option<bool>,
) -> Option<String> {
    if me.kind != "agent" {
        return Some(err("agents_only", AGENTS_ONLY));
    }
    let channel = match gate(read, me, root).await? {
        Ok(c) => c,
        Err(t) => return Some(t),
    };
    Some(
        match write_plan(write, &me.id, root, &channel, build, post.is_some()).await {
            Err(_) => internal(),
            Ok(Outcome::ToTs) => return None,
            Ok(Outcome::Written {
                id,
                rev,
                updated_at,
                doc,
                before,
                facts,
                flag,
                auto_off: Some((next, prev)),
            }) => {
                // TS `writeThreadPlan` — 커밋 뒤 `noticePlanAutoOff(…, [나, 새 관리자, 앞 관리자], 'manager_changed')`.
                if let Some(post) = post {
                    let authors = [Some(me.id.as_str()), next.as_deref(), prev.as_deref()];
                    if crate::core::thread_plan_auto_off::notice_manager_changed(
                        post, &channel, root, &authors,
                    )
                    .await
                    .is_err()
                    {
                        return Some(internal());
                    }
                }
                written_text(
                    rev,
                    &updated_at,
                    &doc,
                    before.as_ref(),
                    &facts,
                    flag.as_ref(),
                    item_removed.map(|r| (id.as_str(), r)),
                )
            }
            Ok(Outcome::Refused(r)) => r.text(),
            Ok(Outcome::Deleted) => text_result(r#"{"ok":true,"deleted":true}"#),
            Ok(Outcome::Written {
                id,
                rev,
                updated_at,
                doc,
                before,
                facts,
                flag,
                ..
            }) => written_text(
                rev,
                &updated_at,
                &doc,
                before.as_ref(),
                &facts,
                flag.as_ref(),
                // TS 는 applyPlanItem 이 고른 id 를 답에 싣는다 — 새 노드면 판을 잠근 뒤에야 안다.
                item_removed.map(|r| (id.as_str(), r)),
            ),
        },
    )
}

/// `thread.plan` 쓰기(`plan` 키가 있음). 읽기·애매한 꼴은 `None`.
pub async fn answer_set(
    read: &PgPool,
    write: &PgPool,
    post: Option<&crate::core::msg_post::PostState>,
    me: &Account,
    args: &Value,
) -> Option<String> {
    let PlanSet { root, doc, guard } = parse_plan_set(args)?;
    run(
        read,
        write,
        post,
        me,
        &root,
        Build::Set { doc, guard },
        None,
    )
    .await
}

/// `thread.plan.item`(`auto` 칸 없는 것).
pub async fn answer_item(
    read: &PgPool,
    write: &PgPool,
    post: Option<&crate::core::msg_post::PostState>,
    me: &Account,
    args: &Value,
) -> Option<String> {
    let (root, patch) = parse_item(args)?;
    let removed = patch.remove == Some(true);
    run(
        read,
        write,
        post,
        me,
        &root,
        Build::Item(Box::new(patch)),
        Some(removed),
    )
    .await
}

/// HTTP `PUT /threads/:rootId/plan/manager`(S5.4 TP4)의 쓰기 결과.
pub(crate) enum ManagerWrite {
    /// 거절 — 코드와 TS 오류 객체의 칸 글자(중괄호 없이, TS 키 순서).
    Refused { code: &'static str, fields: String },
    /// 썼다. `auto_off` 는 관리자가 바뀌어 자동 진행을 껐을 때 (새 관리자, 앞 관리자) — 끄기 알림은 부른 쪽 몫.
    Written {
        auto_off: Option<(Option<String>, Option<String>)>,
    },
    /// TS `deleted` 갈래(type plan 은 판을 지우지 않지만 같은 꼴로 둔다).
    Deleted,
    /// 관리자가 바뀌는데 자동 진행이 켜져 있다 — 되감았다. TS 가 답한다(끄기 알림).
    ToTs,
}

/// TS `writeThreadPlan(…, (prev) => applyPlanItem(prev, { type: 'plan', managerId }))` — 사람 세션 갈래. 루트·가시성은 부른 쪽이 봤다.
pub(crate) async fn write_manager(
    write: &PgPool,
    me: &str,
    root: &str,
    channel: &str,
    manager: Option<String>,
    clear_auto: bool,
) -> sqlx::Result<ManagerWrite> {
    let patch = ItemPatch {
        type_: Some("plan".to_owned()),
        manager_id: Some(manager),
        ..ItemPatch::default()
    };
    Ok(
        match write_plan(
            write,
            me,
            root,
            channel,
            Build::Item(Box::new(patch)),
            clear_auto,
        )
        .await?
        {
            Outcome::Refused(r) => ManagerWrite::Refused {
                code: r.code,
                fields: r.fields,
            },
            Outcome::Written { auto_off, .. } => ManagerWrite::Written { auto_off },
            Outcome::Deleted => ManagerWrite::Deleted,
            Outcome::ToTs => ManagerWrite::ToTs,
        },
    )
}

/// HTTP `POST …/plan/start` 의 잠금 안 쓰기(TS `writeThreadPlan(…, (prev) => …)`). 루트·가시성은 부른 쪽이 봤다.
/// 관리자는 바꾸지 않는 판이라 자동 진행 끄기 갈래는 없다 — 생기면 `ToTs`.
pub(crate) async fn write_custom(
    write: &PgPool,
    me: &str,
    root: &str,
    channel: &str,
    f: StartBuild,
) -> sqlx::Result<(ManagerWrite, Option<i64>)> {
    Ok(
        match write_plan(write, me, root, channel, Build::Custom(f), false).await? {
            Outcome::Refused(r) => (
                ManagerWrite::Refused {
                    code: r.code,
                    fields: r.fields,
                },
                None,
            ),
            Outcome::Written { auto_off, rev, .. } => {
                (ManagerWrite::Written { auto_off }, Some(rev))
            }
            Outcome::Deleted => (ManagerWrite::Deleted, None),
            Outcome::ToTs => (ManagerWrite::ToTs, None),
        },
    )
}

/// TS `linkPlanCard` + `planHookOut` — `message.ask` 의 `planStepId`. 카드가 선 **뒤** 그 단계에 `{kind:'card', messageId}` 를 잇고,
/// 도구 답의 `plan` 칸(JSON 글자)을 돌려준다. 루트·가시성은 부른 쪽이 봤다(그 스레드에 방금 카드를 세웠다).
pub(crate) async fn link_plan_card(
    write: &PgPool,
    me: &str,
    root: &str,
    channel: &str,
    step: &str,
    message_id: &str,
) -> sqlx::Result<String> {
    let patch = ItemPatch {
        type_: Some("step".to_owned()),
        id: Some(step.to_owned()),
        add_links: Some(vec![
            serde_json::json!({ "kind": "card", "messageId": message_id }),
        ]),
        ..ItemPatch::default()
    };
    let out = write_plan(
        write,
        me,
        root,
        channel,
        Build::Item(Box::new(patch)),
        false,
    )
    .await?;
    Ok(plan_hook_out(match out {
        Outcome::Refused(r) => Err(r),
        Outcome::Written { rev, .. } => Ok(rev),
        Outcome::Deleted => Err(Refusal::plain("unexpected_delete")),
        // 관리자를 바꾸지 않는 판이라 오지 않는다.
        Outcome::ToTs => Err(Refusal::plain("internal")),
    }))
}

/// TS `planHookOut(toHookResult(res))` — `unchanged` 는 성공으로 접는다.
fn plan_hook_out(r: Result<i64, Refusal>) -> String {
    match r {
        Ok(rev) => format!("{{\"ok\":true,\"rev\":{rev}}}"),
        Err(r) if r.code == "unchanged" => "{\"ok\":true,\"unchanged\":true}".to_owned(),
        Err(r) => {
            let msg = MESSAGES
                .iter()
                .find(|(c, _)| *c == r.code)
                .map_or(r.code, |(_, m)| m);
            format!(
                "{{\"ok\":false,\"error\":{{{},\"message\":{}}}}}",
                r.fields,
                q(msg)
            )
        }
    }
}

/// `planStepId` 미리 보기(읽기 풀) — 그 스레드에 계획이 있고 그 단계가 있는가. 없으면 부른 쪽이 TS 로 넘긴다(`no_plan`·`unknown_item`).
pub(crate) const PLAN_DOC_SQL: &str = "select doc from thread_plan where root_id = $1::uuid";

/// [`PLAN_DOC_SQL`] 의 판에 그 단계가 있는가.
pub(crate) fn has_step(doc: &Value, step: &str) -> bool {
    doc.get("steps").and_then(Value::as_array).is_some_and(|a| {
        a.iter()
            .any(|s| s.get("id").and_then(Value::as_str) == Some(step))
    })
}

/// [`write_system`] 이 쓴 판.
pub(crate) struct SystemWritten {
    pub channel: String,
    pub rev: i64,
    pub doc: Value,
    pub before: Value,
}

const SYSTEM_LOCK_SQL: &str =
    "select channel_id::text, doc::text from thread_plan where root_id = $1::uuid for update";

/// TS `writeThreadPlan(pool, root, { system: true }, build)` — 계획판 감시(P5)의 자동 갱신 한 경로.
///
/// `build` 가 `None` 이면 바꿀 것이 없다(TS `unchanged`) — rev 를 올리지 않고 `None`. 계획이 없어도 `None`.
/// system 은 계정이 아니라서 스레드 권한을 보지 않고 `updated_by` 는 null 이다. 관리자 칸은 앞 판 값을 그대로 둔다
/// (처음 세우는 판이 아니므로 기본 관리자도 없다). 감시의 build 는 단계 상태만 바꾸므로 연결이 늘지 않는다 —
/// 늘었으면 쓰지 않는다(그런 build 는 없다).
pub(crate) async fn write_system(
    write: &PgPool,
    root: &str,
    build: impl FnOnce(&Value) -> Option<Value>,
) -> sqlx::Result<Option<SystemWritten>> {
    let mut tx = write.begin().await?;
    let cur: Option<(String, String)> = sqlx::query_as(SYSTEM_LOCK_SQL)
        .bind(root)
        .fetch_optional(&mut *tx)
        .await?;
    let Some((channel, before)) = cur else {
        tx.rollback().await?;
        return Ok(None);
    };
    let before: Value = serde_json::from_str(&before).unwrap_or(Value::Null);
    let Some(mut doc) = build(&before) else {
        tx.rollback().await?;
        return Ok(None);
    };
    let (s, g) = plan_seq(Some(&before), &doc);
    if let Some(o) = doc.as_object_mut() {
        o.insert("seq".into(), json!({ "s": s, "g": g }));
    }
    if validate_plan(&doc).is_err()
        || link_shape(&doc, root).is_some()
        || !added_links(&doc, Some(&before)).is_empty()
    {
        tx.rollback().await?;
        return Ok(None);
    }
    let texts = plan_texts(&doc);
    let parts: Vec<Option<&str>> = texts.iter().map(|t| Some(t.as_str())).collect();
    let flag = crate::core::content_scan::scan_write(&parts);
    let (rev, _): (i64, String) = sqlx::query_as(UPSERT_SQL)
        .bind(root)
        .bind(&channel)
        .bind(doc.to_string())
        .bind(flag.as_ref().map(|f| f.reason.as_str()))
        .bind(None::<&str>)
        .fetch_one(&mut *tx)
        .await?;
    // 연결이 그대로라 thread_plan_link 는 다시 쓰지 않는다(TS 는 같은 줄로 다시 쓴다 — 결과가 같다).
    let map = audience_map(&mut tx, &doc, &channel).await?;
    emit(
        &mut tx,
        &channel,
        root,
        Some((rev, &plan_progress(&doc, &map))),
    )
    .await?;
    tx.commit().await?;
    Ok(Some(SystemWritten {
        channel,
        rev,
        doc,
        before,
    }))
}

/// 보는 사람이 없는 자리(청중 맵만 쓸 때) — 자식 사실 문장의 `$2` 를 채울 뿐이다.
pub(crate) const NO_VIEWER: &str = "00000000-0000-0000-0000-000000000000";

/// TS `linkedFor(pool, doc, { audience: channel }).map` — 부모 채널 청중 전원에게 한 값으로 갈 맵.
pub(crate) async fn audience_map(
    conn: &mut PgConnection,
    doc: &Value,
    channel: &str,
) -> sqlx::Result<HashMap<String, Linked>> {
    let facts = child_facts(&mut *conn, &linked_roots(doc), NO_VIEWER).await?;
    Ok(linked_map(doc, &facts, Some(channel)))
}

/// 부모 전파의 이벤트(TS `emitEvent({..., via: 'linked'})`) — 같은 tx 의 outbox 로. 진행률은 청중 맵으로 센다.
pub(crate) async fn emit_linked(
    conn: &mut PgConnection,
    channel: &str,
    root: &str,
    rev: i64,
    progress: &Progress,
) -> sqlx::Result<()> {
    let audience = crate::core::audience::audience_on(&mut *conn, channel).await?;
    let event = json!({
        "type": "thread.plan.changed",
        "channelId": channel,
        "rootId": root,
        "rev": rev,
        "progress": progress_value(progress),
        "audience": audience.to_json(),
        "via": "linked",
    });
    crate::write::emit_event(conn, &event).await?;
    Ok(())
}

#[cfg(test)]
#[path = "plan_write_tests.rs"]
mod tests;
