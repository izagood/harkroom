//! S5.4 A4b2 — 계획판 쓰기 도구(`thread.plan` 쓰기·`thread.plan.item`)의 **입력 꼴** 검사. TS `threadPlanSchema.ts`(zod) 이식.
//!
//! - zod 가 확실히 받고 JS 와 같은 값을 낸다고 장담할 수 있는 입력만 `Some` 이다. 그 밖(zod 거절이든 애매한 값이든)은 `None`
//!   → TS 가 답한다(같은 검증 오류든 같은 결과든 TS 가 정본이다). 넓게 받으면 TS 와 갈린다.
//! - 애매해서 넘기는 것: JS `trim` 과 Rust `trim` 이 다르게 지우는 글자(U+FEFF·U+0085), 정수가 아니거나 2^53 이상인 수,
//!   `ifUpdatedAt` 이 JS `Invalid Date` 로 읽히는 값.
//! - `auto` 칸(자동 진행 켜기·끄기)은 [`parse_auto`] 가 읽고 `plan_auto.rs` 가 답한다.
//! - 결과는 zod `parse` 의 출력과 같은 값이다: 모르는 키는 버리고(strip), `default([])` 칸을 채우고, `text()` 칸은 다듬는다.
//!   저장은 jsonb 라 객체 키 순서는 뜻이 없다.
use crate::core::plan_graph::ItemPatch;
use crate::lists::is_zod_uuid;
use serde_json::{Map, Value};

/// TS `PLAN_LIMITS` × 2 — zod 의 바깥 울타리(글자 수는 UTF-16 단위).
mod outer {
    pub const GOAL: usize = 400;
    pub const TITLE: usize = 240;
    pub const NEXT: usize = 600;
    pub const BLOCKED: usize = 600;
    pub const BLOCKED_REASON: usize = 600;
    pub const GROUPS: usize = 16;
    pub const STEPS: usize = 80;
    pub const DEPENDS_ON: usize = 16;
    pub const LINKS: usize = 20;
}

const STATES: &[&str] = &["pending", "active", "blocked", "done"];

/// JS `Number.MAX_SAFE_INTEGER`.
const MAX_SAFE: u64 = (1 << 53) - 1;

/// zod `z.string().trim().min(1).max(max)`. 다듬은 값.
fn text(v: &Value, max: usize) -> Option<String> {
    let raw = v.as_str()?;
    if raw.contains(['\u{feff}', '\u{85}']) {
        return None;
    }
    let t = raw.trim();
    (1..=max)
        .contains(&t.encode_utf16().count())
        .then(|| t.to_string())
}

/// zod `z.string().max(max).nullable().optional()` — 다듬지 않는다. 없음 `Some(None)`, 값(문자열·null) `Some(Some(_))`.
#[allow(clippy::option_option)]
fn opt_text(v: Option<&Value>, max: usize) -> Option<Option<Value>> {
    match v {
        None => Some(None),
        Some(Value::Null) => Some(Some(Value::Null)),
        Some(Value::String(s)) if s.encode_utf16().count() <= max => Some(Some(v?.clone())),
        _ => None,
    }
}

/// `z.string().uuid().nullable().optional()`.
#[allow(clippy::option_option)]
fn opt_uuid(v: Option<&Value>) -> Option<Option<Value>> {
    match v {
        None => Some(None),
        Some(Value::Null) => Some(Some(Value::Null)),
        Some(Value::String(s)) if is_zod_uuid(s) => Some(Some(v?.clone())),
        _ => None,
    }
}

/// `^[sg][1-9][0-9]{0,3}$`(prefix 를 주면 그 글자만).
fn node_id(s: &str, prefix: Option<u8>) -> bool {
    let b = s.as_bytes();
    (2..=5).contains(&b.len())
        && match prefix {
            Some(p) => b[0] == p,
            None => b[0] == b's' || b[0] == b'g',
        }
        && (b'1'..=b'9').contains(&b[1])
        && b[2..].iter().all(u8::is_ascii_digit)
}

fn id_value(v: &Value, prefix: Option<u8>) -> Option<String> {
    v.as_str()
        .filter(|s| node_id(s, prefix))
        .map(str::to_string)
}

/// `deps` = `z.array(nodeId).max(16)`.
fn deps(v: &Value) -> Option<Vec<String>> {
    let a = v.as_array()?;
    if a.len() > outer::DEPENDS_ON {
        return None;
    }
    a.iter().map(|x| id_value(x, None)).collect()
}

/// JS 안전 정수인 양수 — 그 밖의 수(소수·큰 수)는 애매하니 `None`.
fn safe_positive(v: &Value) -> Option<u64> {
    v.as_u64().filter(|n| (1..=MAX_SAFE).contains(n))
}

/// `^[A-Za-z0-9_.-]{1,100}/[A-Za-z0-9_.-]{1,100}$`.
fn repo_ok(s: &str) -> bool {
    let part = |p: &str| {
        (1..=100).contains(&p.len())
            && p.bytes()
                .all(|b| b.is_ascii_alphanumeric() || matches!(b, b'_' | b'.' | b'-'))
    };
    s.split_once('/').is_some_and(|(a, b)| part(a) && part(b))
}

/// `planLinkSchema`(discriminatedUnion) — 모르는 키를 버린 링크.
fn link(v: &Value) -> Option<Value> {
    let o = v.as_object()?;
    let mut m = Map::new();
    let kind = o.get("kind")?.as_str()?;
    m.insert("kind".into(), Value::String(kind.into()));
    let uuid_field = |m: &mut Map<String, Value>, k: &str| -> Option<()> {
        let s = o.get(k)?.as_str().filter(|s| is_zod_uuid(s))?;
        m.insert(k.into(), Value::String(s.into()));
        Some(())
    };
    match kind {
        "pr" => {
            let repo = o.get("repo")?.as_str().filter(|s| repo_ok(s))?;
            let n = safe_positive(o.get("number")?)?;
            m.insert("repo".into(), Value::String(repo.into()));
            m.insert("number".into(), Value::from(n));
        }
        "message" | "workitem" => uuid_field(&mut m, "id")?,
        "card" => uuid_field(&mut m, "messageId")?,
        _ => return None,
    }
    Some(Value::Object(m))
}

fn links(v: &Value) -> Option<Vec<Value>> {
    let a = v.as_array()?;
    if a.len() > outer::LINKS {
        return None;
    }
    a.iter().map(link).collect()
}

/// `put` 이 `Some(Some(v))` 일 때만 칸을 넣는다.
#[allow(clippy::option_option)]
fn put(m: &mut Map<String, Value>, k: &str, v: Option<Value>) {
    if let Some(v) = v {
        m.insert(k.into(), v);
    }
}

fn group(v: &Value) -> Option<Value> {
    let o = v.as_object()?;
    let mut m = Map::new();
    m.insert(
        "id".into(),
        Value::String(id_value(o.get("id")?, Some(b'g'))?),
    );
    m.insert(
        "title".into(),
        Value::String(text(o.get("title")?, outer::TITLE)?),
    );
    put(&mut m, "assigneeId", opt_uuid(o.get("assigneeId"))?);
    put(&mut m, "linkedRootId", opt_uuid(o.get("linkedRootId"))?);
    let d = match o.get("dependsOn") {
        None => vec![],
        Some(x) => deps(x)?,
    };
    m.insert("dependsOn".into(), d.into());
    Some(Value::Object(m))
}

fn step(v: &Value) -> Option<Value> {
    let o = v.as_object()?;
    let mut m = Map::new();
    m.insert(
        "id".into(),
        Value::String(id_value(o.get("id")?, Some(b's'))?),
    );
    match o.get("groupId") {
        None => {}
        Some(Value::Null) => {
            m.insert("groupId".into(), Value::Null);
        }
        Some(g) => {
            m.insert("groupId".into(), Value::String(id_value(g, Some(b'g'))?));
        }
    }
    m.insert(
        "title".into(),
        Value::String(text(o.get("title")?, outer::TITLE)?),
    );
    let state = o.get("state")?.as_str().filter(|s| STATES.contains(s))?;
    m.insert("state".into(), Value::String(state.into()));
    put(&mut m, "assigneeId", opt_uuid(o.get("assigneeId"))?);
    let l = match o.get("links") {
        None => vec![],
        Some(x) => links(x)?,
    };
    m.insert("links".into(), Value::Array(l));
    let d = match o.get("dependsOn") {
        None => vec![],
        Some(x) => deps(x)?,
    };
    m.insert("dependsOn".into(), d.into());
    put(
        &mut m,
        "blockedReason",
        opt_text(o.get("blockedReason"), outer::BLOCKED_REASON)?,
    );
    Some(Value::Object(m))
}

/// zod `planDocSchema` 의 출력. `seq` 같은 모르는 키는 버린다(번호표는 서버가 다시 센다).
pub fn parse_doc(v: &Value) -> Option<Value> {
    let o = v.as_object()?;
    let mut m = Map::new();
    m.insert(
        "goal".into(),
        Value::String(text(o.get("goal")?, outer::GOAL)?),
    );
    let list = |k: &str, max: usize, f: fn(&Value) -> Option<Value>| -> Option<Vec<Value>> {
        match o.get(k) {
            None => Some(vec![]),
            Some(x) => {
                let a = x.as_array()?;
                if a.len() > max {
                    return None;
                }
                a.iter().map(f).collect()
            }
        }
    };
    m.insert(
        "groups".into(),
        Value::Array(list("groups", outer::GROUPS, group)?),
    );
    m.insert(
        "steps".into(),
        Value::Array(list("steps", outer::STEPS, step)?),
    );
    put(&mut m, "next", opt_text(o.get("next"), outer::NEXT)?);
    put(
        &mut m,
        "blocked",
        opt_text(o.get("blocked"), outer::BLOCKED)?,
    );
    put(&mut m, "managerId", opt_uuid(o.get("managerId"))?);
    Some(Value::Object(m))
}

/// `ifUpdatedAt`: 없음 = 검사 없음(`None`), `null` = 아직 없어야 함(`Some(None)`), 날짜 = 그 판(밀리초 ISO)이어야 함.
/// zod 는 통과하나 JS 가 `Invalid Date` 로 읽는 값은 TS 로 넘긴다(바깥 `None`).
#[allow(clippy::option_option)]
fn guard_arg(o: &Map<String, Value>) -> Option<Option<Option<String>>> {
    match o.get("ifUpdatedAt") {
        None => Some(None),
        Some(Value::Null) => Some(Some(None)),
        Some(Value::String(s)) => match crate::write::zod_datetime_offset(s) {
            Ok(Some(iso)) => Some(Some(Some(iso))),
            _ => None,
        },
        Some(_) => None,
    }
}

/// `thread.plan` 쓰기 인자.
#[derive(Debug, PartialEq)]
pub struct PlanSet {
    pub root: String,
    /// `None` = 지우기(`plan: null`).
    pub doc: Option<Value>,
    /// `None` = guard 없음, `Some(None)` = 없던 계획이어야 함, `Some(Some(iso))` = 그 판이어야 함.
    #[allow(clippy::option_option)]
    pub guard: Option<Option<String>>,
}

/// `thread.plan` 인자 중 **쓰기**(`plan` 키가 있음)만 `Some`. 읽기는 A4a(`plan_read`) 몫이라 `None`.
pub fn parse_plan_set(args: &Value) -> Option<PlanSet> {
    let o = args.as_object()?;
    let root = o.get("threadRootId")?.as_str().filter(|s| is_zod_uuid(s))?;
    let doc = match o.get("plan")? {
        Value::Null => None,
        v => Some(parse_doc(v)?),
    };
    Some(PlanSet {
        root: root.into(),
        doc,
        guard: guard_arg(o)?,
    })
}

#[allow(clippy::option_option)]
fn opt_node(v: Option<&Value>, prefix: Option<u8>) -> Option<Option<Option<String>>> {
    match v {
        None => Some(None),
        Some(Value::Null) => Some(Some(None)),
        Some(x) => Some(Some(Some(id_value(x, prefix)?))),
    }
}

#[allow(clippy::option_option)]
fn opt_uuid_s(v: Option<&Value>) -> Option<Option<Option<String>>> {
    match v {
        None => Some(None),
        Some(Value::Null) => Some(Some(None)),
        Some(Value::String(s)) if is_zod_uuid(s) => Some(Some(Some(s.clone()))),
        _ => None,
    }
}

/// `thread.plan.item` 의 `auto` 칸(zod `z.object({ until, sourceMessageId }).nullable()`).
#[derive(Debug, PartialEq, Eq)]
pub enum AutoArg {
    /// `auto: null` — 끄기.
    Off,
    /// 켜기. `source` 는 근거가 되는 사람 글 id.
    On { until: String, source: String },
}

/// `auto` 칸이 있는 `thread.plan.item` 인자.
#[derive(Debug, PartialEq, Eq)]
pub struct AutoItem {
    pub root: String,
    pub auto: AutoArg,
    /// TS `patch.type === 'plan' && Object.keys(patch).length === 1` — `type: "plan"` 말고 다른 칸이 없다.
    pub alone: bool,
}

/// `auto` 밖의 `planItemShape` 칸 — zod 가 남기는 키(모르는 키는 벗긴다).
const ITEM_KEYS: &[&str] = &[
    "type",
    "id",
    "remove",
    "after",
    "title",
    "groupId",
    "state",
    "assigneeId",
    "linkedRootId",
    "dependsOn",
    "addDependsOn",
    "removeDependsOn",
    "addLinks",
    "removeLinks",
    "blockedReason",
    "managerId",
    "ifRev",
];

/// `auto` 칸이 있는 `thread.plan.item` 인자. 칸이 없거나 zod 가 거절할 꼴이면 `None`(거절 글은 TS 가 쓴다).
pub fn parse_auto(args: &Value) -> Option<AutoItem> {
    let o = args.as_object()?;
    let auto = match o.get("auto")? {
        Value::Null => AutoArg::Off,
        Value::Object(a) => AutoArg::On {
            until: id_value(a.get("until")?, None)?,
            source: a
                .get("sourceMessageId")?
                .as_str()
                .filter(|s| is_zod_uuid(s))?
                .to_owned(),
        },
        _ => return None,
    };
    let (root, patch) = parse_patch(o)?;
    let alone = patch.type_.as_deref() == Some("plan")
        && o.keys().filter(|k| ITEM_KEYS.contains(&k.as_str())).count() == 1;
    Some(AutoItem { root, auto, alone })
}

/// `thread.plan.item` 인자(zod `planItemShape`). `auto` 칸이 있으면 `None` — 그 꼴은 [`parse_auto`] 몫이다.
pub fn parse_item(args: &Value) -> Option<(String, ItemPatch)> {
    let o = args.as_object()?;
    if o.contains_key("auto") {
        return None;
    }
    parse_patch(o)
}

/// `auto` 밖의 칸.
fn parse_patch(o: &Map<String, Value>) -> Option<(String, ItemPatch)> {
    let root = o.get("threadRootId")?.as_str().filter(|s| is_zod_uuid(s))?;
    let mut p = ItemPatch::default();
    if let Some(t) = o.get("type") {
        let t = t
            .as_str()
            .filter(|t| ["step", "group", "plan"].contains(t))?;
        p.type_ = Some(t.into());
    }
    if let Some(v) = o.get("id") {
        p.id = Some(id_value(v, None)?);
    }
    if let Some(v) = o.get("remove") {
        p.remove = Some(v.as_bool()?);
    }
    p.after = opt_node(o.get("after"), None)?;
    if let Some(v) = o.get("title") {
        p.title = Some(text(v, outer::TITLE)?);
    }
    p.group_id = opt_node(o.get("groupId"), Some(b'g'))?;
    if let Some(v) = o.get("state") {
        p.state = Some(v.as_str().filter(|s| STATES.contains(s))?.into());
    }
    p.assignee_id = opt_uuid_s(o.get("assigneeId"))?;
    p.linked_root_id = opt_uuid_s(o.get("linkedRootId"))?;
    if let Some(v) = o.get("dependsOn") {
        p.depends_on = Some(deps(v)?);
    }
    if let Some(v) = o.get("addDependsOn") {
        p.add_depends_on = Some(deps(v)?);
    }
    if let Some(v) = o.get("removeDependsOn") {
        p.remove_depends_on = Some(deps(v)?);
    }
    if let Some(v) = o.get("addLinks") {
        p.add_links = Some(links(v)?);
    }
    if let Some(v) = o.get("removeLinks") {
        p.remove_links = Some(links(v)?);
    }
    p.blocked_reason = match opt_text(o.get("blockedReason"), outer::BLOCKED_REASON)? {
        None => None,
        Some(Value::String(s)) => Some(Some(s)),
        Some(_) => Some(None),
    };
    p.manager_id = opt_uuid_s(o.get("managerId"))?;
    if let Some(v) = o.get("ifRev") {
        p.if_rev = Some(i64::try_from(safe_positive(v)?).ok()?);
    }
    Some((root.into(), p))
}

#[cfg(test)]
#[path = "plan_input_tests.rs"]
mod tests;
