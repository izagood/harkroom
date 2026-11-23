//! 계획판 쓰기의 순수 함수 — TS `shared/planGraph.ts` `validatePlan`·`server/services/threadPlanItem.ts`
//! (`planSeq`·`applyPlanItem`)·`threadPlan.ts` `planTexts`·`diffDerived` 의 이식. I/O 가 없다.
//!
//! 지킬 계약:
//! - 문서는 [`Value`] 그대로 다룬다(`msg_list::derive_plan` 과 같은 꼴). 저장은 jsonb 라 객체 키 순서는 남지 않고, 배열 순서만 뜻이 있다.
//!   그래서 JS 의 `{...cur, title}` 는 「있으면 덮고 없으면 더함」으로 옮긴다.
//! - 입력 꼴(zod `planDocSchema`·`planItemShape`)은 이미 지났다고 본다 — 여기는 그 뒤의 판정만 한다. 꼴 검사는 부르는 쪽 몫이다.
//! - 거절의 JSON 은 TS 객체의 키 순서 그대로 글자를 짓는다([`PlanError::fields_json`]) — 도구 답이 TS 와 글자까지 같아야 한다.
use super::msg_list::DerivedNode;
use serde_json::{Map, Value};
use std::collections::{HashMap, HashSet};

/// TS `PLAN_LIMITS`. 그룹·단계 **수**의 상한은 넉넉하다 — 끝난 일을 합쳐 줄이지 않고 한 일마다 단계 하나로 남길 수 있게 하되,
/// 계획 한 장(통째로 다시 쓰고 통째로 읽는 문서)이 끝없이 커지지는 않게 묶는다.
pub mod limits {
    pub const GROUPS: usize = 200;
    pub const STEPS: usize = 1000;
    pub const DEPENDS_ON: usize = 8;
    pub const LINKS: usize = 10;
    pub const GOAL: usize = 200;
    pub const TITLE: usize = 120;
    pub const NEXT: usize = 300;
    pub const BLOCKED: usize = 300;
    pub const BLOCKED_REASON: usize = 300;
}

/// `validatePlan`·`applyPlanItem` 의 거절. 변형과 칸은 TS `PlanValidationError`·`PlanItemError` 와 같다.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum PlanError {
    InvalidId {
        id: String,
    },
    DuplicateId {
        id: String,
    },
    UnknownRef {
        id: String,
        from: String,
    },
    SelfRef {
        id: String,
    },
    DependencyCycle {
        path: Vec<String>,
    },
    LinkedGroupHasSteps {
        id: String,
        step_ids: Vec<String>,
    },
    LimitExceeded {
        what: &'static str,
        limit: usize,
        id: Option<String>,
    },
    NoPlan,
    UnknownItem {
        id: String,
    },
    FieldNotForType {
        field: &'static str,
        type_: &'static str,
    },
    TitleRequired,
    ManagerRequired,
    RevConflict {
        rev: i64,
    },
}

fn q(s: &str) -> String {
    serde_json::to_string(s).unwrap_or_else(|_| "\"\"".into())
}

fn q_list(v: &[String]) -> String {
    format!("[{}]", v.iter().map(|s| q(s)).collect::<Vec<_>>().join(","))
}

impl PlanError {
    pub fn code(&self) -> &'static str {
        match self {
            Self::InvalidId { .. } => "invalid_id",
            Self::DuplicateId { .. } => "duplicate_id",
            Self::UnknownRef { .. } => "unknown_ref",
            Self::SelfRef { .. } => "self_ref",
            Self::DependencyCycle { .. } => "dependency_cycle",
            Self::LinkedGroupHasSteps { .. } => "linked_group_has_steps",
            Self::LimitExceeded { .. } => "limit_exceeded",
            Self::NoPlan => "no_plan",
            Self::UnknownItem { .. } => "unknown_item",
            Self::FieldNotForType { .. } => "field_not_for_type",
            Self::TitleRequired => "title_required",
            Self::ManagerRequired => "manager_required",
            Self::RevConflict { .. } => "rev_conflict",
        }
    }

    /// 중괄호 없는 칸 글자(`"code":"x","id":"y"`) — TS 객체의 키 순서 그대로다. 도구 답은 여기에 `,"message":…` 를 잇는다.
    pub fn fields_json(&self) -> String {
        let code = format!("\"code\":{}", q(self.code()));
        match self {
            Self::InvalidId { id }
            | Self::DuplicateId { id }
            | Self::SelfRef { id }
            | Self::UnknownItem { id } => {
                format!("{code},\"id\":{}", q(id))
            }
            Self::UnknownRef { id, from } => {
                format!("{code},\"id\":{},\"from\":{}", q(id), q(from))
            }
            Self::DependencyCycle { path } => format!("{code},\"path\":{}", q_list(path)),
            Self::LinkedGroupHasSteps { id, step_ids } => {
                format!("{code},\"id\":{},\"stepIds\":{}", q(id), q_list(step_ids))
            }
            Self::LimitExceeded { what, limit, id } => {
                let mut s = format!("{code},\"what\":{},\"limit\":{limit}", q(what));
                if let Some(id) = id {
                    s.push_str(&format!(",\"id\":{}", q(id)));
                }
                s
            }
            Self::FieldNotForType { field, type_ } => {
                format!("{code},\"field\":{},\"type\":{}", q(field), q(type_))
            }
            Self::RevConflict { rev } => format!("{code},\"rev\":{rev}"),
            Self::NoPlan | Self::TitleRequired | Self::ManagerRequired => code,
        }
    }
}

const EMPTY: &Vec<Value> = &Vec::new();

fn arr(v: &Value) -> &Vec<Value> {
    v.as_array().unwrap_or(EMPTY)
}

fn id_of(v: &Value) -> &str {
    v["id"].as_str().unwrap_or("")
}

/// JS 참값인 문자열(빈 문자열·null·없음은 거짓).
fn truthy(v: &Value) -> Option<&str> {
    v.as_str().filter(|s| !s.is_empty())
}

fn strs(v: &Value) -> Vec<String> {
    arr(v)
        .iter()
        .filter_map(|x| x.as_str().map(str::to_string))
        .collect()
}

/// TS `len` — 코드 포인트 수. 거짓 값은 0.
fn len(v: &Value) -> usize {
    truthy(v).map_or(0, |s| s.chars().count())
}

/// `^g[1-9][0-9]{0,3}$` / `^s[1-9][0-9]{0,3}$`.
fn valid_node_id(id: &str, prefix: u8) -> bool {
    let b = id.as_bytes();
    (2..=5).contains(&b.len())
        && b[0] == prefix
        && (b'1'..=b'9').contains(&b[1])
        && b[2..].iter().all(u8::is_ascii_digit)
}

/// TS `edges` — 노드 id → 앞 노드(삽입 순서 = 그룹 뒤 단계). id 는 자리표(`HashMap`)로 찾는다 — 노드 수에 선형이다.
fn edges(doc: &Value) -> Vec<(String, Vec<String>)> {
    let groups = arr(&doc["groups"]);
    let steps = arr(&doc["steps"]);
    let mut out: Vec<(String, Vec<String>)> = Vec::with_capacity(groups.len() + steps.len());
    let mut at: HashMap<&str, usize> = HashMap::with_capacity(groups.len() + steps.len());
    // 같은 id 가 둘이면 TS `find` 처럼 첫 그룹이 부모다.
    let mut group_at: HashMap<&str, usize> = HashMap::with_capacity(groups.len());
    for (i, g) in groups.iter().enumerate() {
        group_at.entry(id_of(g)).or_insert(i);
    }
    // 있던 id 면 그 자리의 변을 덮고(TS `Map.set`), 없으면 뒤에 더한다.
    fn set<'a>(
        out: &mut Vec<(String, Vec<String>)>,
        at: &mut HashMap<&'a str, usize>,
        k: &'a str,
        v: Vec<String>,
    ) {
        match at.get(k) {
            Some(&i) => out[i].1 = v,
            None => {
                at.insert(k, out.len());
                out.push((k.to_string(), v));
            }
        }
    }
    for g in groups {
        set(&mut out, &mut at, id_of(g), strs(&g["dependsOn"]));
    }
    for s in steps {
        let parent = truthy(&s["groupId"]);
        let mut deps = strs(&s["dependsOn"]);
        if let Some(p) = parent
            && let Some(&gi) = group_at.get(p)
        {
            deps.extend(strs(&groups[gi]["dependsOn"]));
        }
        set(&mut out, &mut at, id_of(s), deps);
        if let Some(p) = parent
            && let Some(&pi) = at.get(p)
        {
            out[pi].1.push(id_of(s).to_string());
        }
    }
    out
}

/// TS `findCycle` — 문서 순서의 DFS. 처음과 끝이 같은 id 열.
///
/// **재귀하지 않는다.** 방문 경로를 힙의 명시 스택(`path`)에 둔다 — 의존 사슬의 깊이가 호출 스택을 쓰지 않으므로
/// 노드가 아무리 많아도 스택이 넘치지 않는다. 방문 순서와 돌려주는 경로는 재귀 DFS 와 같다.
fn find_cycle(doc: &Value) -> Option<Vec<String>> {
    #[derive(Clone, Copy, PartialEq)]
    enum C {
        White,
        Grey,
        Black,
    }
    let g = edges(doc);
    let at: HashMap<&str, usize> = {
        let mut m = HashMap::with_capacity(g.len());
        for (i, (k, _)) in g.iter().enumerate() {
            m.entry(k.as_str()).or_insert(i);
        }
        m
    };
    // 모르는 id 로 가는 변은 뺀다 — 나가는 변이 없는 노드라 순환을 만들지 못한다.
    let adj: Vec<Vec<usize>> = g
        .iter()
        .map(|(_, nexts)| {
            nexts
                .iter()
                .filter_map(|n| at.get(n.as_str()).copied())
                .collect()
        })
        .collect();
    let mut color = vec![C::White; g.len()];
    // (노드, 다음에 볼 변의 자리) — 재귀 DFS 의 호출 프레임이다.
    let mut path: Vec<(usize, usize)> = Vec::new();
    for root in 0..g.len() {
        if color[root] != C::White {
            continue;
        }
        color[root] = C::Grey;
        path.push((root, 0));
        while let Some(top) = path.last_mut() {
            let (node, edge) = *top;
            let Some(&next) = adj[node].get(edge) else {
                color[node] = C::Black;
                path.pop();
                continue;
            };
            top.1 += 1;
            match color[next] {
                C::Grey => {
                    let from = path.iter().position(|(n, _)| *n == next).unwrap_or(0);
                    let mut found: Vec<String> =
                        path[from..].iter().map(|(n, _)| g[*n].0.clone()).collect();
                    found.push(g[next].0.clone());
                    return Some(found);
                }
                C::White => {
                    color[next] = C::Grey;
                    path.push((next, 0));
                }
                C::Black => {}
            }
        }
    }
    None
}

/// TS `validatePlan` — 첫 거절. 검사 순서: 상한 → id → 참조 → 연결 그룹 → 순환.
pub fn validate_plan(doc: &Value) -> Result<(), PlanError> {
    use limits as L;
    let lim = |what, limit, id: Option<&str>| {
        Err(PlanError::LimitExceeded {
            what,
            limit,
            id: id.map(str::to_string),
        })
    };
    let groups = arr(&doc["groups"]);
    let steps = arr(&doc["steps"]);
    if groups.len() > L::GROUPS {
        return lim("groups", L::GROUPS, None);
    }
    if steps.len() > L::STEPS {
        return lim("steps", L::STEPS, None);
    }
    validate_plan_uncounted(doc)
}

/// [`validate_plan`] 에서 그룹·단계 **수** 검사만 뺀 나머지. 수 상한과 따로, 노드가 아무리 많아도 호출 스택을 깊이만큼 쓰지 않고
/// 노드 수에 선형으로 끝나야 한다 — 시험이 상한을 한참 넘는 계획으로 이것을 직접 본다.
pub(crate) fn validate_plan_uncounted(doc: &Value) -> Result<(), PlanError> {
    use limits as L;
    let lim = |what, limit, id: Option<&str>| {
        Err(PlanError::LimitExceeded {
            what,
            limit,
            id: id.map(str::to_string),
        })
    };
    let groups = arr(&doc["groups"]);
    let steps = arr(&doc["steps"]);
    if len(&doc["goal"]) > L::GOAL {
        return lim("goal", L::GOAL, None);
    }
    if len(&doc["next"]) > L::NEXT {
        return lim("next", L::NEXT, None);
    }
    if len(&doc["blocked"]) > L::BLOCKED {
        return lim("blocked", L::BLOCKED, None);
    }
    for n in groups.iter().chain(steps) {
        if len(&n["title"]) > L::TITLE {
            return lim("title", L::TITLE, Some(id_of(n)));
        }
        if arr(&n["dependsOn"]).len() > L::DEPENDS_ON {
            return lim("dependsOn", L::DEPENDS_ON, Some(id_of(n)));
        }
    }
    for s in steps {
        if arr(&s["links"]).len() > L::LINKS {
            return lim("links", L::LINKS, Some(id_of(s)));
        }
        if len(&s["blockedReason"]) > L::BLOCKED_REASON {
            return lim("blockedReason", L::BLOCKED_REASON, Some(id_of(s)));
        }
    }

    // 아래 검사는 모두 집합·표로 찾는다 — 노드 수에 선형이다.
    let mut seen: HashSet<&str> = HashSet::with_capacity(groups.len() + steps.len());
    for (nodes, prefix) in [(groups, b'g'), (steps, b's')] {
        for n in nodes {
            let id = id_of(n);
            if !valid_node_id(id, prefix) {
                return Err(PlanError::InvalidId { id: id.into() });
            }
            if !seen.insert(id) {
                return Err(PlanError::DuplicateId { id: id.into() });
            }
        }
    }

    let group_ids: HashSet<&str> = groups.iter().map(id_of).collect();
    for s in steps {
        if let Some(g) = truthy(&s["groupId"])
            && !group_ids.contains(g)
        {
            return Err(PlanError::UnknownRef {
                id: g.into(),
                from: id_of(s).into(),
            });
        }
    }
    for n in groups.iter().chain(steps) {
        for d in strs(&n["dependsOn"]) {
            if d == id_of(n) {
                return Err(PlanError::SelfRef { id: d });
            }
            if !seen.contains(&d.as_str()) {
                return Err(PlanError::UnknownRef {
                    id: d,
                    from: id_of(n).into(),
                });
            }
        }
    }

    if groups.iter().any(|g| truthy(&g["linkedRootId"]).is_some()) {
        let mut steps_of: HashMap<&str, Vec<&str>> = HashMap::new();
        for s in steps {
            if let Some(g) = s["groupId"].as_str() {
                steps_of.entry(g).or_default().push(id_of(s));
            }
        }
        for g in groups {
            if truthy(&g["linkedRootId"]).is_none() {
                continue;
            }
            if let Some(ids) = steps_of.get(id_of(g)) {
                return Err(PlanError::LinkedGroupHasSteps {
                    id: id_of(g).into(),
                    step_ids: ids.iter().map(|s| s.to_string()).collect(),
                });
            }
        }
    }

    match find_cycle(doc) {
        Some(path) => Err(PlanError::DependencyCycle { path }),
        None => Ok(()),
    }
}

/// TS `maxNum` — `^[sg]([0-9]+)$` 이고 머리가 `prefix` 인 id 의 가장 큰 번호.
fn max_num(prefix: char, nodes: &Value) -> i64 {
    let mut max = 0;
    for n in arr(nodes) {
        let id = id_of(n);
        let mut cs = id.chars();
        let head = cs.next();
        let rest = cs.as_str();
        if matches!(head, Some('s' | 'g'))
            && !rest.is_empty()
            && rest.bytes().all(|b| b.is_ascii_digit())
            && head == Some(prefix)
        {
            max = max.max(rest.parse::<i64>().unwrap_or(i64::MAX));
        }
    }
    max
}

fn seq_of(doc: &Value, prefix: &str) -> i64 {
    doc["seq"][prefix].as_i64().unwrap_or(0)
}

/// TS `planSeq` — 앞 판의 seq, 앞 판·새 판의 가장 큰 번호, 새 판의 seq 중 가장 큰 것. `(s, g)`.
pub fn plan_seq(prev: Option<&Value>, next: &Value) -> (i64, i64) {
    let one = |p: &str, list: &str| {
        let c = p.chars().next().unwrap_or('s');
        let mut m = seq_of(next, p).max(max_num(c, &next[list]));
        if let Some(prev) = prev {
            m = m.max(seq_of(prev, p)).max(max_num(c, &prev[list]));
        }
        m
    };
    (one("s", "steps"), one("g", "groups"))
}

/// TS `planTexts` — 쓰기 검사(080)에 넣을 글.
pub fn plan_texts(doc: &Value) -> Vec<String> {
    let s = |v: &Value| v.as_str().unwrap_or("").to_string();
    let mut out = vec![s(&doc["goal"]), s(&doc["next"]), s(&doc["blocked"])];
    out.extend(arr(&doc["groups"]).iter().map(|g| s(&g["title"])));
    for st in arr(&doc["steps"]) {
        out.push(s(&st["title"]));
        out.push(s(&st["blockedReason"]));
    }
    out
}

/// TS `diffDerived` — 새로 ready·waiting 이 된 노드(after 의 순서).
pub fn diff_derived(
    before: &[(String, DerivedNode)],
    after: &[(String, DerivedNode)],
) -> (Vec<String>, Vec<String>) {
    let (mut ready, mut waiting) = (Vec::new(), Vec::new());
    // 같은 id 가 둘이면 첫 것(TS `find`).
    let mut was: HashMap<&str, &str> = HashMap::with_capacity(before.len());
    for (k, n) in before {
        was.entry(k.as_str()).or_insert(n.derived.as_str());
    }
    for (id, node) in after {
        let prev = was.get(id.as_str()).copied();
        if node.derived == "ready" && prev != Some("ready") {
            ready.push(id.clone());
        }
        if node.derived == "waiting" && prev != Some("waiting") {
            waiting.push(id.clone());
        }
    }
    (ready, waiting)
}

/// `thread.plan.item` 의 칸(TS `PlanItemPatch`, zod 를 지난 뒤). `None` = 주지 않음(undefined), `Some(Value::Null)` = null.
/// 칸 순서는 zod `planItemShape` 순서다 — `type: 'plan'` 거절이 첫 칸을 그 순서로 고른다.
#[derive(Debug, Clone, Default)]
pub struct ItemPatch {
    pub type_: Option<String>,
    pub id: Option<String>,
    pub remove: Option<bool>,
    pub after: Option<Option<String>>,
    pub title: Option<String>,
    pub group_id: Option<Option<String>>,
    pub state: Option<String>,
    pub assignee_id: Option<Option<String>>,
    pub linked_root_id: Option<Option<String>>,
    pub depends_on: Option<Vec<String>>,
    pub add_depends_on: Option<Vec<String>>,
    pub remove_depends_on: Option<Vec<String>>,
    pub add_links: Option<Vec<Value>>,
    pub remove_links: Option<Vec<Value>>,
    pub blocked_reason: Option<Option<String>>,
    pub manager_id: Option<Option<String>>,
    pub if_rev: Option<i64>,
}

impl ItemPatch {
    /// 준 칸의 이름(zod 키 순서). `type`·`managerId`·`ifRev` 도 들어 있다.
    fn given(&self) -> Vec<&'static str> {
        let mut out = Vec::new();
        let mut on = |b: bool, name| {
            if b {
                out.push(name);
            }
        };
        on(self.type_.is_some(), "type");
        on(self.id.is_some(), "id");
        on(self.remove.is_some(), "remove");
        on(self.after.is_some(), "after");
        on(self.title.is_some(), "title");
        on(self.group_id.is_some(), "groupId");
        on(self.state.is_some(), "state");
        on(self.assignee_id.is_some(), "assigneeId");
        on(self.linked_root_id.is_some(), "linkedRootId");
        on(self.depends_on.is_some(), "dependsOn");
        on(self.add_depends_on.is_some(), "addDependsOn");
        on(self.remove_depends_on.is_some(), "removeDependsOn");
        on(self.add_links.is_some(), "addLinks");
        on(self.remove_links.is_some(), "removeLinks");
        on(self.blocked_reason.is_some(), "blockedReason");
        on(self.manager_id.is_some(), "managerId");
        on(self.if_rev.is_some(), "ifRev");
        out
    }
}

fn opt_str(v: &Option<String>) -> Value {
    v.as_ref().map_or(Value::Null, |s| Value::String(s.clone()))
}

/// TS `linkKey`.
fn link_key(l: &Value) -> String {
    let s = |k: &str| l[k].as_str().unwrap_or("").to_lowercase();
    match l["kind"].as_str() {
        Some("pr") => format!("pr:{}#{}", s("repo"), l["number"]),
        Some("message") => format!("message:{}", s("id")),
        Some("card") => format!("card:{}", s("messageId")),
        Some("workitem") => format!("workitem:{}", s("id")),
        _ => "undefined".into(),
    }
}

/// TS `nextId` — 번호표 다음 번호.
fn next_id(prefix: char, doc: &Value) -> String {
    let (key, list) = if prefix == 's' {
        ("s", "steps")
    } else {
        ("g", "groups")
    };
    let used = seq_of(doc, key).max(max_num(prefix, &doc[list]));
    format!("{prefix}{}", used.saturating_add(1))
}

/// TS `place`.
fn place(
    list: &[Value],
    node: Value,
    after: &Option<Option<String>>,
    is_new: bool,
) -> Result<Vec<Value>, PlanError> {
    let nid = id_of(&node).to_string();
    let mut rest: Vec<Value> = list.iter().filter(|n| id_of(n) != nid).cloned().collect();
    match after {
        None => {
            if is_new {
                rest.push(node);
            } else {
                // findIndex 가 -1 이면 JS slice(0,-1)·slice(-1) — 있던 노드라 여기 오지 않는다.
                let at = list
                    .iter()
                    .position(|n| id_of(n) == nid)
                    .unwrap_or(rest.len());
                rest.insert(at.min(rest.len()), node);
            }
        }
        Some(None) => rest.insert(0, node),
        Some(Some(a)) => {
            let at = rest
                .iter()
                .position(|n| id_of(n) == a)
                .ok_or_else(|| PlanError::UnknownItem { id: a.clone() })?;
            rest.insert(at + 1, node);
        }
    }
    Ok(rest)
}

/// TS `applyDeps`.
fn apply_deps(cur: Vec<String>, p: &ItemPatch) -> Vec<String> {
    let mut deps = p.depends_on.clone().unwrap_or(cur);
    for d in p.add_depends_on.iter().flatten() {
        if !deps.contains(d) {
            deps.push(d.clone());
        }
    }
    if let Some(rm) = &p.remove_depends_on
        && !rm.is_empty()
    {
        deps.retain(|d| !rm.contains(d));
    }
    deps
}

fn str_values(v: Vec<String>) -> Value {
    Value::Array(v.into_iter().map(Value::String).collect())
}

fn obj(v: &Value) -> Map<String, Value> {
    v.as_object().cloned().unwrap_or_default()
}

/// TS `applyPlanItem` — 잠근 판(`doc`, `rev`)에 노드 하나의 변경을 얹은 새 판과 쓴(지운) id. `type: 'plan'` 이면 id 는 `"plan"`.
pub fn apply_plan_item(
    prev: Option<(&Value, i64)>,
    p: &ItemPatch,
) -> Result<(Value, String), PlanError> {
    let Some((prev_doc, rev)) = prev else {
        return Err(PlanError::NoPlan);
    };
    if let Some(want) = p.if_rev
        && want != rev
    {
        return Err(PlanError::RevConflict { rev });
    }
    let mut doc = obj(prev_doc);
    let mut groups: Vec<Value> = arr(&prev_doc["groups"]).clone();
    let mut steps: Vec<Value> = arr(&prev_doc["steps"]).clone();
    let type_: &'static str = match p.type_.as_deref() {
        Some("plan") => "plan",
        Some("group") => "group",
        Some("step") => "step",
        _ if p.id.as_deref().is_some_and(|id| id.starts_with('g')) => "group",
        _ => "step",
    };
    let finish = |mut doc: Map<String, Value>, groups: Vec<Value>, steps: Vec<Value>| {
        doc.insert("groups".into(), Value::Array(groups));
        doc.insert("steps".into(), Value::Array(steps));
        Value::Object(doc)
    };

    if type_ == "plan" {
        if let Some(field) = p
            .given()
            .into_iter()
            .find(|f| !["type", "managerId", "ifRev"].contains(f))
        {
            return Err(PlanError::FieldNotForType { field, type_ });
        }
        let Some(m) = &p.manager_id else {
            return Err(PlanError::ManagerRequired);
        };
        doc.insert("managerId".into(), opt_str(m));
        return Ok((finish(doc, groups, steps), "plan".into()));
    }
    if p.manager_id.is_some() {
        return Err(PlanError::FieldNotForType {
            field: "managerId",
            type_,
        });
    }
    let given = p.given();
    let only: &[&'static str] = if type_ == "group" {
        &[
            "groupId",
            "state",
            "addLinks",
            "removeLinks",
            "blockedReason",
        ]
    } else {
        &["linkedRootId"]
    };
    if let Some(field) = only.iter().find(|f| given.contains(f)) {
        return Err(PlanError::FieldNotForType { field, type_ });
    }

    if p.remove == Some(true) {
        let Some(id) = p.id.as_deref().filter(|s| !s.is_empty()) else {
            return Err(PlanError::UnknownItem { id: String::new() });
        };
        let list = if type_ == "group" { &groups } else { &steps };
        if !list.iter().any(|n| id_of(n) == id) {
            return Err(PlanError::UnknownItem { id: id.into() });
        }
        let drop = |n: &Value| -> Map<String, Value> {
            let mut m = obj(n);
            let deps: Vec<String> = strs(&n["dependsOn"])
                .into_iter()
                .filter(|d| d != id)
                .collect();
            m.insert("dependsOn".into(), str_values(deps));
            m
        };
        groups = groups
            .iter()
            .filter(|g| id_of(g) != id)
            .map(|g| Value::Object(drop(g)))
            .collect();
        steps = steps
            .iter()
            .filter(|s| id_of(s) != id)
            .map(|s| {
                let mut m = drop(s);
                if s["groupId"].as_str() == Some(id) {
                    m.insert("groupId".into(), Value::Null);
                }
                Value::Object(m)
            })
            .collect();
        return Ok((finish(doc, groups, steps), id.into()));
    }

    let title_missing = p.title.as_deref().is_none_or(str::is_empty);
    if type_ == "group" {
        let cur =
            p.id.as_deref()
                .map(|id| groups.iter().find(|g| id_of(g) == id));
        if let (Some(id), Some(None)) = (&p.id, &cur) {
            return Err(PlanError::UnknownItem { id: id.clone() });
        }
        let cur = cur.flatten().cloned();
        if cur.is_none() && title_missing {
            return Err(PlanError::TitleRequired);
        }
        let id = cur
            .as_ref()
            .map_or_else(|| next_id('g', prev_doc), |c| id_of(c).to_string());
        let mut node = cur.as_ref().map(obj).unwrap_or_else(|| {
            let mut m = Map::new();
            m.insert("id".into(), Value::String(id.clone()));
            m.insert("title".into(), Value::String(String::new()));
            m.insert("dependsOn".into(), Value::Array(vec![]));
            m
        });
        if let Some(t) = &p.title {
            node.insert("title".into(), Value::String(t.clone()));
        }
        if let Some(a) = &p.assignee_id {
            node.insert("assigneeId".into(), opt_str(a));
        }
        if let Some(l) = &p.linked_root_id {
            node.insert("linkedRootId".into(), opt_str(l));
        }
        let deps = apply_deps(
            cur.as_ref()
                .map(|c| strs(&c["dependsOn"]))
                .unwrap_or_default(),
            p,
        );
        node.insert("dependsOn".into(), str_values(deps));
        groups = place(&groups, Value::Object(node), &p.after, cur.is_none())?;
        return Ok((finish(doc, groups, steps), id));
    }

    let cur =
        p.id.as_deref()
            .map(|id| steps.iter().find(|s| id_of(s) == id));
    if let (Some(id), Some(None)) = (&p.id, &cur) {
        return Err(PlanError::UnknownItem { id: id.clone() });
    }
    let cur = cur.flatten().cloned();
    if cur.is_none() && title_missing {
        return Err(PlanError::TitleRequired);
    }
    let id = cur
        .as_ref()
        .map_or_else(|| next_id('s', prev_doc), |c| id_of(c).to_string());
    let mut links: Vec<Value> = cur
        .as_ref()
        .map(|c| arr(&c["links"]).clone())
        .unwrap_or_default();
    for l in p.add_links.iter().flatten() {
        let k = link_key(l);
        if !links.iter().any(|x| link_key(x) == k) {
            links.push(l.clone());
        }
    }
    if let Some(rm) = &p.remove_links
        && !rm.is_empty()
    {
        let gone: Vec<String> = rm.iter().map(link_key).collect();
        links.retain(|l| !gone.contains(&link_key(l)));
    }
    let mut node = cur.as_ref().map(obj).unwrap_or_else(|| {
        let mut m = Map::new();
        m.insert("id".into(), Value::String(id.clone()));
        m.insert("title".into(), Value::String(String::new()));
        m.insert("state".into(), Value::String("pending".into()));
        m.insert("links".into(), Value::Array(vec![]));
        m.insert("dependsOn".into(), Value::Array(vec![]));
        m
    });
    if let Some(t) = &p.title {
        node.insert("title".into(), Value::String(t.clone()));
    }
    if let Some(g) = &p.group_id {
        node.insert("groupId".into(), opt_str(g));
    }
    if let Some(s) = &p.state {
        node.insert("state".into(), Value::String(s.clone()));
    }
    if let Some(a) = &p.assignee_id {
        node.insert("assigneeId".into(), opt_str(a));
    }
    if let Some(b) = &p.blocked_reason {
        node.insert("blockedReason".into(), opt_str(b));
    }
    node.insert("links".into(), Value::Array(links));
    let deps = apply_deps(
        cur.as_ref()
            .map(|c| strs(&c["dependsOn"]))
            .unwrap_or_default(),
        p,
    );
    node.insert("dependsOn".into(), str_values(deps));
    steps = place(&steps, Value::Object(node), &p.after, cur.is_none())?;
    Ok((finish(doc, groups, steps), id))
}

#[cfg(test)]
#[path = "plan_graph_tests.rs"]
mod tests;
