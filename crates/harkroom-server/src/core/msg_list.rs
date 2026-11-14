//! S5.3 C1b-1b — 채널·스레드 메시지 목록 `GET /channels/{id}/messages`(TS `messageRoutes.ts` 의 같은 줄 + `listMessages`).
//!
//! - 문장은 TS 정본 `LIST_MESSAGES_SQL`·`HAS_OLDER_SQL`(`services/messages.ts`)과 `PLAN_PROGRESS_PLANS_SQL`·
//!   `CHILD_FACTS_AUDIENCE_SQL`(`services/threadPlan.ts`) 그대로 — `golden/sql_fragments.json` 에서 읽는다.
//! - 행 JSON 은 Postgres 가 만든다(`row_to_json`, 칸 순서 = 열 순서). 맨 겉 timestamptz 셋만 toISOString 꼴(`msg_read.rs` 와 같다).
//! - 머리 행(답글 아님·지우지 않음)에는 `planProgress` 를 맨 끝 키로 붙인다 — TS `attachPlanProgress` 가 객체에 키를 더하는 것과 같은 자리.
//!   진행률 계산은 `shared/planGraph.ts` 의 `derivePlan`·`planProgress` 를 옮긴 [`plan_progress`] 다(청중 기준, 자식은 1단).
//! - 순서가 규칙이다(TS 와 같다): 인증(401) → id 검사(400) → 쿼리 검사(400) → 채널을 볼 수 있는지(403, 없는 채널은 통과 → 빈 목록).
use crate::auth::RequireAccount;
use crate::directory::{internal, json_err, json_ok};
use axum::extract::{Path, RawQuery, State};
use axum::http::StatusCode;
use axum::response::Response;
use serde_json::{Map, Value};
use sqlx::PgPool;
use std::collections::{HashMap, HashSet};
use std::sync::{Arc, OnceLock};

struct Sql {
    thread_around: String,
    thread_before: String,
    thread_since: String,
    thread_latest: String,
    around: String,
    before: String,
    before_feed: String,
    since: String,
    latest: String,
    has_older_channel: String,
    has_older_feed: String,
    has_older_thread: String,
    plans: String,
    children: String,
    visible: String,
}

/// 갈래 문장을 감싼다 — 행마다 (본문 json, id, seq, 머리인가). 갈래는 모두 seq 오름차순으로 끝나므로 겉 `order by` 가 같은 순서다.
fn wrap(branch: &str) -> String {
    format!(
        "select (select json_object_agg(e.key, case e.key \
               when 'createdAt' then to_json({}) \
               when 'editedAt' then to_json({}) \
               when 'deletedAt' then to_json({}) \
               else e.value end order by e.ord) \
             from json_each(row_to_json(t)) with ordinality as e(key, value, ord))::text as body, \
           t.id::text as id, t.seq::int8 as seq, t.\"threadRootId\"::text as thread_root_id, \
           (t.\"threadRootId\" is null and t.\"deletedAt\" is null) as is_root \
         from ({branch}) t order by t.seq",
        crate::iso!("t.\"createdAt\""),
        crate::iso!("t.\"editedAt\""),
        crate::iso!("t.\"deletedAt\""),
    )
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
            thread_around: wrap(&frag("list_messages_threadAround")),
            thread_before: wrap(&frag("list_messages_threadBefore")),
            thread_since: wrap(&frag("list_messages_threadSince")),
            thread_latest: wrap(&frag("list_messages_threadLatest")),
            around: wrap(&frag("list_messages_around")),
            before: wrap(&frag("list_messages_before")),
            before_feed: wrap(&frag("list_messages_beforeFeed")),
            since: wrap(&frag("list_messages_since")),
            latest: wrap(&frag("list_messages_latest")),
            has_older_channel: frag("has_older_channel"),
            has_older_feed: frag("has_older_feed"),
            has_older_thread: frag("has_older_thread"),
            plans: format!(
                "select p.root_id::text, p.channel_id::text, p.doc::text, p.rev::int8, {} \
                 from ({}) p",
                crate::iso!("p.updated_at"),
                frag("plan_progress_plans")
            ),
            children: format!(
                "select f.id::text, f.channel_id::text, f.doc::text, f.public_channel from ({}) f",
                frag("plan_progress_children")
            ),
            visible: format!(
                "select {} as visible from channel c where c.id = $2::uuid",
                frag("channel_visible_c_p1uuid")
            ),
        }
    })
}

fn is_uuid(s: &str) -> bool {
    let b = s.as_bytes();
    b.len() == 36
        && b.iter().enumerate().all(|(i, c)| match i {
            8 | 13 | 18 | 23 => *c == b'-',
            _ => c.is_ascii_hexdigit(),
        })
}

/// JS `Number(string)` — zod `z.coerce.number()` 가 부르는 것. 빈 문자열(공백만)은 0, `0x`·`0o`·`0b`, `Infinity`.
fn js_number(raw: &str) -> f64 {
    let s = raw.trim_matches(|c: char| c.is_whitespace() || c == '\u{feff}');
    if s.is_empty() {
        return 0.0;
    }
    let radix = |p: &str, r: u32| -> f64 {
        if p.is_empty() || !p.chars().all(|c| c.is_digit(r)) {
            return f64::NAN;
        }
        p.chars()
            .fold(0.0, |acc, c| acc * r as f64 + c.to_digit(r).unwrap() as f64)
    };
    let low = s.to_ascii_lowercase();
    if let Some(p) = low.strip_prefix("0x") {
        return radix(p, 16);
    }
    if let Some(p) = low.strip_prefix("0o") {
        return radix(p, 8);
    }
    if let Some(p) = low.strip_prefix("0b") {
        return radix(p, 2);
    }
    match s {
        "Infinity" | "+Infinity" => return f64::INFINITY,
        "-Infinity" => return f64::NEG_INFINITY,
        _ => {}
    }
    // JS 십진 리터럴: 부호? 숫자들 [. 숫자들] [e 부호? 숫자들] — Rust 의 "inf"·"nan" 은 받지 않는다.
    let ok = {
        let b = s.trim_start_matches(['+', '-']);
        let (mant, exp) = match b.find(['e', 'E']) {
            Some(i) => (&b[..i], Some(&b[i + 1..])),
            None => (b, None),
        };
        let digits = mant.chars().filter(|c| c.is_ascii_digit()).count();
        let mant_ok = digits > 0
            && mant.chars().all(|c| c.is_ascii_digit() || c == '.')
            && mant.matches('.').count() <= 1;
        let exp_ok = exp.is_none_or(|e| {
            let e = e.strip_prefix(['+', '-']).unwrap_or(e);
            !e.is_empty() && e.chars().all(|c| c.is_ascii_digit())
        });
        s.len() - b.len() <= 1 && mant_ok && exp_ok
    };
    if ok {
        s.parse::<f64>().unwrap_or(f64::NAN)
    } else {
        f64::NAN
    }
}

#[derive(Debug, Default, PartialEq)]
struct Query {
    since: Option<i64>,
    before: Option<i64>,
    around: Option<i64>,
    limit: Option<i64>,
    thread: Option<String>,
    feed: bool,
}

/// TS 의 zod 쿼리 검사와 같은 판정. 모르는 키는 버린다(zod strip). 같은 키가 둘 이상이면 배열이라 zod 가 거절한다.
fn parse_query(raw: Option<&str>) -> Result<Query, &'static str> {
    let mut seen: HashMap<String, Vec<String>> = HashMap::new();
    for (k, v) in crate::directory::form_pairs(raw.unwrap_or("")) {
        seen.entry(k).or_default().push(v);
    }
    let one = |k: &str| -> Result<Option<&str>, &'static str> {
        match seen.get(k).map(Vec::as_slice) {
            None => Ok(None),
            Some([v]) => Ok(Some(v.as_str())),
            Some(_) => Err("repeated query key"),
        }
    };
    let int = |k: &str, min: f64, max: Option<f64>| -> Result<Option<i64>, &'static str> {
        let Some(v) = one(k)? else { return Ok(None) };
        let n = js_number(v);
        if !n.is_finite() || n.fract() != 0.0 || n < min || max.is_some_and(|m| n > m) {
            return Err("bad number");
        }
        if n > i64::MAX as f64 {
            return Err("number out of range");
        }
        Ok(Some(n as i64))
    };
    let q = Query {
        since: int("since", 0.0, None)?,
        before: int("before", 0.0, None)?,
        around: int("around", 0.0, None)?,
        limit: int("limit", 1.0, Some(500.0))?,
        thread: match one("thread")? {
            None => None,
            Some(t) if is_uuid(t) => Some(t.to_string()),
            Some(_) => return Err("thread: invalid uuid"),
        },
        feed: match one("feed")? {
            None => false,
            Some("1") => true,
            Some(_) => return Err("feed: must be 1"),
        },
    };
    if [q.before, q.since, q.around].iter().flatten().count() > 1 {
        return Err("before, since and around are different directions — send one");
    }
    if q.feed && (q.before.is_none() || q.thread.is_some()) {
        return Err("feed=1 goes with before on a channel page (not with since, around or thread)");
    }
    Ok(q)
}

// ── 계획판 진행률(shared/planGraph.ts 이식) ───────────────────────────────────

#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
pub struct Progress {
    pub done: i64,
    pub total: i64,
    pub active: i64,
    pub blocked: i64,
    pub waiting: i64,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Linked {
    Hidden,
    Shown(Progress),
}

/// JS 참값인 문자열만(빈 문자열·null·없음은 거짓).
fn truthy_str(v: &Value) -> Option<&str> {
    v.as_str().filter(|s| !s.is_empty())
}

fn str_list(v: &Value) -> Vec<&str> {
    v.as_array()
        .map(|a| a.iter().filter_map(Value::as_str).collect())
        .unwrap_or_default()
}

/// 계획에 연결된 자식 스레드 id 들(그룹 순서, 중복 없음) — TS `linkedRoots`.
pub fn linked_roots(doc: &Value) -> Vec<String> {
    let mut out: Vec<String> = Vec::new();
    for g in doc["groups"].as_array().into_iter().flatten() {
        if let Some(id) = truthy_str(&g["linkedRootId"])
            && !out.iter().any(|o| o == id)
        {
            out.push(id.to_string());
        }
    }
    out
}

/// TS `planProgress(doc, linked)` — `derivePlan` 의 파생 상태로 단위를 센다.
pub fn plan_progress(doc: &Value, linked: &HashMap<String, Linked>) -> Progress {
    const ZERO: Progress = Progress {
        done: 0,
        total: 0,
        active: 0,
        blocked: 0,
        waiting: 0,
    };
    let empty = Vec::new();
    let groups_v = doc["groups"].as_array().unwrap_or(&empty);
    let steps_v = doc["steps"].as_array().unwrap_or(&empty);
    let gid = |g: &Value| g["id"].as_str().unwrap_or("").to_string();
    let groups: HashMap<String, &Value> = groups_v.iter().map(|g| (gid(g), g)).collect();
    let steps: HashMap<String, &Value> = steps_v.iter().map(|s| (gid(s), s)).collect();
    let mut steps_of: HashMap<&str, Vec<&Value>> = HashMap::new();
    for s in steps_v {
        if let Some(g) = truthy_str(&s["groupId"]) {
            steps_of.entry(g).or_default().push(s);
        }
    }
    let linked_of = |g: &Value| -> Linked {
        truthy_str(&g["linkedRootId"])
            .and_then(|id| linked.get(id).copied())
            .unwrap_or(Linked::Shown(ZERO))
    };

    struct Done<'a> {
        memo: HashMap<String, bool>,
        busy: HashSet<String>,
        groups: &'a HashMap<String, &'a Value>,
        steps: &'a HashMap<String, &'a Value>,
        steps_of: &'a HashMap<&'a str, Vec<&'a Value>>,
    }
    fn is_done(d: &mut Done, id: &str, linked_of: &dyn Fn(&Value) -> Linked) -> bool {
        if let Some(m) = d.memo.get(id) {
            return *m;
        }
        if d.busy.contains(id) {
            return false;
        }
        d.busy.insert(id.to_string());
        let mut done = false;
        if let Some(s) = d.steps.get(id) {
            done = s["state"].as_str() == Some("done");
        } else if let Some(g) = d.groups.get(id).copied() {
            if truthy_str(&g["linkedRootId"]).is_some() {
                done = matches!(linked_of(g), Linked::Shown(p) if p.total > 0 && p.done == p.total);
            } else {
                let members: Vec<String> = d
                    .steps_of
                    .get(id)
                    .map(|m| {
                        m.iter()
                            .map(|s| s["id"].as_str().unwrap_or("").to_string())
                            .collect()
                    })
                    .unwrap_or_default();
                done = !members.is_empty() && members.iter().all(|m| is_done(d, m, linked_of));
            }
        }
        d.busy.remove(id);
        d.memo.insert(id.to_string(), done);
        done
    }
    let mut d = Done {
        memo: HashMap::new(),
        busy: HashSet::new(),
        groups: &groups,
        steps: &steps,
        steps_of: &steps_of,
    };
    let pending_deps = |d: &mut Done, deps: Vec<&str>| -> usize {
        let mut out: Vec<&str> = Vec::new();
        for x in deps {
            if !out.contains(&x) && !is_done(d, x, &linked_of) {
                out.push(x);
            }
        }
        out.len()
    };

    // 파생 상태 — 그룹 먼저, 같은 id 의 단계가 덮는다(TS `result` 에 그룹 뒤 단계를 넣는 순서). 단계·그룹 id 가 겹치면 마지막 것이 이긴다.
    let mut derived: HashMap<String, String> = HashMap::new();
    let mut step_nodes: Vec<(String, String)> = Vec::new();
    for s in steps_v {
        let parent = truthy_str(&s["groupId"]).and_then(|g| groups.get(g).copied());
        let mut deps = str_list(&s["dependsOn"]);
        if let Some(p) = parent {
            deps.extend(str_list(&p["dependsOn"]));
        }
        let waiting = pending_deps(&mut d, deps);
        let state = s["state"].as_str().unwrap_or("").to_string();
        let node = if state == "pending" {
            if waiting > 0 {
                "waiting".into()
            } else {
                "ready".into()
            }
        } else {
            state
        };
        step_nodes.push((gid(s), node));
    }
    for g in groups_v {
        let id = gid(g);
        let waiting = pending_deps(&mut d, str_list(&g["dependsOn"]));
        let node = if truthy_str(&g["linkedRootId"]).is_some() {
            match linked_of(g) {
                Linked::Hidden => "hidden",
                Linked::Shown(p) => {
                    if is_done(&mut d, &id, &linked_of) {
                        "done"
                    } else if p.blocked > 0 {
                        "blocked"
                    } else if p.active > 0 || p.done > 0 {
                        "active"
                    } else if waiting > 0 {
                        "waiting"
                    } else {
                        "ready"
                    }
                }
            }
        } else {
            let members: Vec<&str> = steps_of
                .get(id.as_str())
                .map(|m| {
                    m.iter()
                        .map(|s| s["state"].as_str().unwrap_or(""))
                        .collect()
                })
                .unwrap_or_default();
            if is_done(&mut d, &id, &linked_of) {
                "done"
            } else if members.contains(&"blocked") {
                "blocked"
            } else if members.contains(&"active") || members.contains(&"done") {
                "active"
            } else if waiting > 0 {
                "waiting"
            } else {
                "ready"
            }
        };
        derived.insert(id, node.to_string());
    }
    for (id, node) in step_nodes {
        derived.insert(id, node);
    }

    let mut units: Vec<String> = steps_v.iter().map(gid).collect();
    units.extend(
        groups_v
            .iter()
            .filter(|g| truthy_str(&g["linkedRootId"]).is_some())
            .map(gid),
    );
    let mut p = Progress {
        total: units.len() as i64,
        ..ZERO
    };
    for id in &units {
        match derived.get(id).map(String::as_str) {
            Some("done") => p.done += 1,
            Some("active") => p.active += 1,
            Some("blocked") => p.blocked += 1,
            Some("waiting") => p.waiting += 1,
            _ => {}
        }
    }
    p
}

struct Row {
    body: String,
    id: String,
    seq: i64,
    thread_root_id: Option<String>,
    is_root: bool,
}

/// TS `attachPlanProgress` — 머리 행마다 `planProgress`(계획 없으면 null). 쿼리는 최대 둘(계획들, 연결 자식들).
async fn attach_plan_progress(pool: &PgPool, rows: &mut [Row]) -> Result<(), sqlx::Error> {
    let roots: Vec<String> = rows
        .iter()
        .filter(|r| r.is_root)
        .map(|r| r.id.clone())
        .collect();
    if roots.is_empty() {
        return Ok(());
    }
    let s = sql();
    let plan_rows: Vec<(String, String, String, i64, String)> = sqlx::query_as(s.plans.as_str())
        .bind(&roots)
        .fetch_all(pool)
        .await?;
    let mut plans: HashMap<String, (String, Value, i64, String)> = HashMap::new();
    let mut children: Vec<String> = Vec::new();
    for (root, channel, doc, rev, updated) in plan_rows {
        let doc: Value = serde_json::from_str(&doc).unwrap_or(Value::Null);
        for c in linked_roots(&doc) {
            if !children.contains(&c) {
                children.push(c);
            }
        }
        plans.insert(root, (channel, doc, rev, updated));
    }
    // 자식: (채널, 공개인가, 진행률 — 계획이 없으면 None). 자식의 연결 그룹은 다시 풀지 않는다(1단).
    let mut facts: HashMap<String, (String, bool, Option<Progress>)> = HashMap::new();
    if !children.is_empty() {
        let child_rows: Vec<(String, String, Option<String>, bool)> =
            sqlx::query_as(s.children.as_str())
                .bind(&children)
                .fetch_all(pool)
                .await?;
        let none = HashMap::new();
        for (id, channel, doc, public) in child_rows {
            let progress = doc
                .and_then(|d| serde_json::from_str::<Value>(&d).ok())
                .filter(|d| !d.is_null())
                .map(|d| plan_progress(&d, &none));
            facts.insert(id, (channel, public, progress));
        }
    }
    for r in rows.iter_mut().filter(|r| r.is_root) {
        let pp = match plans.get(&r.id) {
            None => Value::Null,
            Some((channel, doc, rev, updated)) => {
                let mut map = HashMap::new();
                for id in linked_roots(doc) {
                    let l = match facts.get(&id) {
                        Some((c, public, progress)) if *public || c == channel => {
                            Linked::Shown(progress.unwrap_or_default())
                        }
                        _ => Linked::Hidden,
                    };
                    map.insert(id, l);
                }
                let p = plan_progress(doc, &map);
                let mut o = Map::new();
                o.insert("done".into(), p.done.into());
                o.insert("total".into(), p.total.into());
                o.insert("active".into(), p.active.into());
                o.insert("blocked".into(), p.blocked.into());
                o.insert("waiting".into(), p.waiting.into());
                o.insert("rev".into(), (*rev).into());
                o.insert("updatedAt".into(), updated.clone().into());
                Value::Object(o)
            }
        };
        // 행 JSON 의 맨 끝 `}` 앞에 끼운다 — 칸 순서를 지키려고 다시 파싱하지 않는다.
        if r.body.ends_with('}') {
            r.body.pop();
            r.body.push_str(",\"planProgress\":");
            r.body.push_str(&pp.to_string());
            r.body.push('}');
        }
    }
    Ok(())
}

async fn exists(
    pool: &PgPool,
    q: &'static str,
    binds: (&str, Option<&str>, i64),
) -> Result<bool, sqlx::Error> {
    let mut query = sqlx::query_scalar::<_, i32>(q).bind(binds.0);
    if let Some(t) = binds.1 {
        query = query.bind(t);
    }
    Ok(query.bind(binds.2).fetch_optional(pool).await?.is_some())
}

/// `GET /channels/{id}/messages`.
pub async fn list_messages(
    State(pool): State<Arc<PgPool>>,
    RequireAccount(me, _): RequireAccount,
    Path(id): Path<String>,
    RawQuery(raw): RawQuery,
) -> Response {
    if !is_uuid(&id) {
        return json_err(
            StatusCode::BAD_REQUEST,
            "invalid_request",
            "id: invalid uuid",
        );
    }
    let q = match parse_query(raw.as_deref()) {
        Ok(q) => q,
        Err(m) => return json_err(StatusCode::BAD_REQUEST, "invalid_request", m),
    };
    let s = sql();
    let pool = pool.as_ref();
    let visible: Option<bool> = match sqlx::query_scalar(s.visible.as_str())
        .bind(&me.id)
        .bind(&id)
        .fetch_optional(pool)
        .await
    {
        Ok(v) => v,
        Err(e) => return internal(e),
    };
    if visible == Some(false) {
        return json_err(
            StatusCode::FORBIDDEN,
            "forbidden",
            "not a member of this dm channel",
        );
    }

    let limit = q.limit.unwrap_or(200).min(500);
    let half = ((limit + 1) / 2).max(1);
    let base = |text: &'static str| {
        sqlx::query_as::<_, (String, String, i64, Option<String>, bool)>(text).bind(id.as_str())
    };
    let fetched = if let Some(t) = q.thread.as_deref() {
        if let Some(a) = q.around {
            base(&s.thread_around)
                .bind(t)
                .bind(a)
                .bind(half)
                .fetch_all(pool)
                .await
        } else if let Some(b) = q.before {
            base(&s.thread_before)
                .bind(t)
                .bind(b)
                .bind(limit)
                .fetch_all(pool)
                .await
        } else if let Some(n) = q.since.filter(|n| *n > 0) {
            base(&s.thread_since)
                .bind(t)
                .bind(n)
                .bind(limit)
                .fetch_all(pool)
                .await
        } else {
            base(&s.thread_latest)
                .bind(t)
                .bind(limit)
                .fetch_all(pool)
                .await
        }
    } else if let Some(a) = q.around {
        base(&s.around).bind(a).bind(half).fetch_all(pool).await
    } else if let Some(b) = q.before {
        base(if q.feed { &s.before_feed } else { &s.before })
            .bind(b)
            .bind(limit)
            .fetch_all(pool)
            .await
    } else if let Some(n) = q.since.filter(|n| *n > 0) {
        base(&s.since).bind(n).bind(limit).fetch_all(pool).await
    } else {
        base(&s.latest).bind(limit).fetch_all(pool).await
    };
    let mut rows: Vec<Row> = match fetched {
        Ok(r) => r
            .into_iter()
            .map(|(body, id, seq, thread_root_id, is_root)| Row {
                body,
                id,
                seq,
                thread_root_id,
                is_root,
            })
            .collect(),
        Err(e) => return internal(e),
    };
    if let Err(e) = attach_plan_progress(pool, &mut rows).await {
        return internal(e);
    }

    // hasMore — 스레드는 그 스레드 답글로만(since·around 면 false), 채널은 첫 행 seq 로(피드면 본문에 설 줄로).
    let has_more = if let Some(t) = q.thread.as_deref() {
        // TS `m.threadRootId === q.thread` — 글자 그대로 비교한다(대문자 uuid 면 맞는 답글이 없다).
        let oldest = rows.iter().find(|r| r.thread_root_id.as_deref() == Some(t));
        match oldest {
            Some(r) if q.since.is_none() && q.around.is_none() => {
                exists(pool, &s.has_older_thread, (id.as_str(), Some(t), r.seq)).await
            }
            _ => Ok(false),
        }
    } else if let Some(first) = rows.first() {
        let text = if q.feed {
            &s.has_older_feed
        } else {
            &s.has_older_channel
        };
        exists(pool, text, (id.as_str(), None, first.seq)).await
    } else {
        Ok(false)
    };
    let has_more = match has_more {
        Ok(b) => b,
        Err(e) => return internal(e),
    };

    let mut out = String::with_capacity(rows.iter().map(|r| r.body.len() + 1).sum::<usize>() + 32);
    out.push_str("{\"messages\":[");
    for (i, r) in rows.iter().enumerate() {
        if i > 0 {
            out.push(',');
        }
        out.push_str(&r.body);
    }
    out.push_str("],\"hasMore\":");
    out.push_str(if has_more { "true" } else { "false" });
    out.push('}');
    json_ok(out)
}

/// 코어 라우터에 합칠 줄 — `msg_read.rs` 와 같은 길(인증은 `route_layer`, CORS 는 `layer`).
pub fn routes(
    pool: PgPool,
    auth: crate::auth::AuthPools,
    cors: Arc<crate::cors::Cors>,
) -> crate::route_table::Routes<()> {
    use crate::route_table::Table;
    let t = Table::<Arc<PgPool>>::new()
        .get("/channels/{id}/messages", list_messages)
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
    fn golden_sql_loads() {
        let s = sql();
        assert!(s.latest.contains("order by m.seq desc limit $2"));
        assert!(s.thread_around.contains("m.thread_root_id = $2::uuid"));
        assert!(s.has_older_feed.contains("m.seq < $2"));
        assert!(s.plans.contains("thread_plan"));
        assert!(s.children.contains("false as viewer_visible"));
    }

    #[test]
    fn number_like_js() {
        assert_eq!(js_number(""), 0.0);
        assert_eq!(js_number(" 5 "), 5.0);
        assert_eq!(js_number("0x10"), 16.0);
        assert_eq!(js_number("1e2"), 100.0);
        assert_eq!(js_number("5.0"), 5.0);
        assert!(js_number("5a").is_nan());
        assert!(js_number("inf").is_nan());
        assert!(js_number("--1").is_nan());
        assert!(js_number(".").is_nan());
        assert_eq!(js_number(".5"), 0.5);
        assert_eq!(js_number("Infinity"), f64::INFINITY);
    }

    #[test]
    fn query_rules() {
        assert_eq!(parse_query(None), Ok(Query::default()));
        assert_eq!(parse_query(Some("since=")).unwrap().since, Some(0));
        assert_eq!(parse_query(Some("limit=500")).unwrap().limit, Some(500));
        assert!(parse_query(Some("limit=0")).is_err());
        assert!(parse_query(Some("limit=501")).is_err());
        assert!(parse_query(Some("since=-1")).is_err());
        assert!(parse_query(Some("since=1.5")).is_err());
        assert!(parse_query(Some("since=1&before=2")).is_err());
        assert!(parse_query(Some("since=1&since=2")).is_err());
        assert!(parse_query(Some("feed=1")).is_err());
        assert!(
            parse_query(Some(
                "feed=1&before=3&thread=0f8fad5b-d9cb-469f-a165-70867728950e"
            ))
            .is_err()
        );
        assert!(parse_query(Some("feed=true&before=3")).is_err());
        assert!(parse_query(Some("feed=1&before=3")).unwrap().feed);
        assert!(parse_query(Some("thread=nope")).is_err());
        assert_eq!(parse_query(Some("x=1&limit=3")).unwrap().limit, Some(3));
    }

    fn step(id: &str, group: Option<&str>, state: &str, deps: &[&str]) -> Value {
        json!({"id": id, "groupId": group, "title": id, "state": state, "links": [], "dependsOn": deps})
    }

    #[test]
    fn progress_counts_like_ts() {
        let doc = json!({
            "goal": "g",
            "groups": [
                {"id": "g1", "title": "a", "dependsOn": []},
                {"id": "g2", "title": "b", "dependsOn": ["g1"]},
                {"id": "g3", "title": "linked", "linkedRootId": "c1", "dependsOn": []},
                {"id": "g4", "title": "hidden", "linkedRootId": "c2", "dependsOn": []},
                {"id": "g5", "title": "empty", "dependsOn": []}
            ],
            "steps": [
                step("s1", Some("g1"), "done", &[]),
                step("s2", Some("g1"), "active", &[]),
                step("s3", Some("g2"), "pending", &[]),
                step("s4", None, "pending", &["g5"]),
                step("s5", None, "blocked", &[]),
                step("s6", None, "pending", &[])
            ]
        });
        let mut m = HashMap::new();
        m.insert(
            "c1".to_string(),
            Linked::Shown(Progress {
                done: 2,
                total: 2,
                ..Default::default()
            }),
        );
        m.insert("c2".to_string(), Linked::Hidden);
        // s1 done · s2 active · s3 waiting(g1 덜 끝남) · s4 waiting(빈 그룹은 끝난 게 아님) · s5 blocked · s6 ready · g3 done · g4 hidden
        assert_eq!(
            plan_progress(&doc, &m),
            Progress {
                done: 2,
                total: 8,
                active: 1,
                blocked: 1,
                waiting: 2
            }
        );
        // 맵에 없는 연결 그룹은 total 0 으로 읽힌다 → ready.
        assert_eq!(
            plan_progress(&doc, &HashMap::new()),
            Progress {
                done: 1,
                total: 8,
                active: 1,
                blocked: 1,
                waiting: 2
            }
        );
        assert_eq!(linked_roots(&doc), vec!["c1".to_string(), "c2".to_string()]);
    }

    #[test]
    fn progress_survives_cycles() {
        let doc = json!({"goal": "", "groups": [], "steps": [
            step("s1", None, "pending", &["s2"]),
            step("s2", None, "pending", &["s1"])
        ]});
        assert_eq!(
            plan_progress(&doc, &HashMap::new()),
            Progress {
                done: 0,
                total: 2,
                active: 0,
                blocked: 0,
                waiting: 2
            }
        );
    }
}
