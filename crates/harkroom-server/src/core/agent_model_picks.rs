//! S5.4 — 에이전트가 다른 에이전트를 부르며 그 스레드의 모델을 고른다(`agentModels`). TS `services/agentModelPicks.ts` 의
//! `applyAgentPicks` 를 옮긴다 — 판정은 순수 함수, 쓰기는 [`apply`], 게시 tx 훅은 [`AgentPicks`](MCP `message.post` 가 쓴다).
//!
//! 판정 순서(TS 와 같다, 고른 것마다): `self_pick`(403) → `not_called`(403) → `bad_model_value`(400) → 허용 목록
//! `not_pickable`(403, 풀기는 건너뛴다) → 사람이 정한 행 `human_pinned`(409). 모두 지나면 실제로 바뀌는 것만 세어
//! 스레드 상한(`model_change_limit`, 429)을 본다.
//!
//! J2b — 고른 것에 `comboId`(실행 조합)가 있으면 허용 목록은 `agent_pickable_models` 가 아니라 그 에이전트의
//! `agent_exec_combo` 다([`combo_verdict`]): 기능이 꺼졌으면 `combo_off`(409) → 목록에 없으면 `combo_not_allowed`(403) →
//! 조합의 하네스가 그 에이전트의 지금 하네스와 다르면 `combo_harness_mismatch`(403). 지나면 조합의 model·effort 를 그 줄에
//! 베끼고 `combo_id` 를 같이 적는다. 사람이 정한 행·스레드 상한은 그대로 본다.
use super::msg_post::Rejection;
use super::pickable_models::Entry;
use super::thread_model_set::axis_valid;
use serde_json::Value;
use std::collections::HashSet;

/// [`apply`] 이 글 올리기 권한 위에 더 쓰는 권한 — 다 있을 때만 Rust 가 답해야 한다(없으면 TS 로 넘긴다).
pub const AGENT_MODEL_PICKS_PRIVILEGES: &[(&str, &str)] = &[
    ("agent_config.account_id", "SELECT"),
    ("agent_config.agent_pickable_models", "SELECT"),
    ("agent_config.harness", "SELECT"),
    ("account.id", "SELECT"),
    ("account.kind", "SELECT"),
    ("account.deleted_at", "SELECT"),
    ("account.handle", "SELECT"),
    ("thread_agent_model", "SELECT"),
    ("thread_agent_model", "INSERT"),
    ("thread_agent_model", "UPDATE"),
    ("thread_agent_model", "DELETE"),
    ("thread_agent_pick_count", "SELECT"),
    ("thread_agent_pick_count", "INSERT"),
    ("thread_agent_pick_count", "UPDATE"),
];

/// TS `AGENT_PICK_LIMIT_PER_THREAD`.
pub const AGENT_PICK_LIMIT_PER_THREAD: i32 = 3;

/// 다듬은 한 줄(TS `cleanPicks` 뒤). 두 축이 다 `None` 이면 풀기다.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Pick {
    pub agent_id: String,
    pub model: Option<String>,
    pub effort: Option<String>,
    /// 실행 조합(J2b). 있으면 model·effort 는 비어 온다 — [`apply`] 가 조합에서 채운다.
    pub combo_id: Option<String>,
}

impl Pick {
    pub fn clearing(&self) -> bool {
        self.model.is_none() && self.effort.is_none() && self.combo_id.is_none()
    }
}

/// 허용 목록에서 읽은 조합 한 줄 — (조합 하네스, model, effort, 그 에이전트의 지금 하네스).
pub type ComboRow = (String, String, Option<String>, String);

/// 조합 고르기 판정(DB 없이). `enabled` 는 조합 기능이 켜졌는가, `row` 는 그 에이전트 허용 목록에서 찾은 줄.
/// 지나면 그 줄에 적을 (model, effort).
pub fn combo_verdict(
    enabled: bool,
    row: Option<&ComboRow>,
) -> Result<(String, Option<String>), Rejection> {
    if !enabled {
        return Err(reject(
            409,
            "combo_off",
            "실행 조합 기능이 켜져 있지 않다 — 모델·effort 로 고르거나 사람에게 넘겨라",
        ));
    }
    let Some((harness, model, effort, agent_harness)) = row else {
        return Err(reject(
            403,
            "combo_not_allowed",
            "그 에이전트의 허용 목록에 없는 실행 조합이다 — 소유자가 허용한 조합만 고른다",
        ));
    };
    if harness != agent_harness {
        return Err(reject(
            403,
            "combo_harness_mismatch",
            format!(
                "그 조합의 하네스({harness})가 에이전트의 지금 하네스({agent_harness})와 다르다"
            ),
        ));
    }
    Ok((model.clone(), effort.clone()))
}

fn reject(status: u16, code: &str, message: impl Into<String>) -> Rejection {
    Rejection {
        status,
        code: code.to_owned(),
        message: message.into(),
    }
}

pub fn human_pinned() -> Rejection {
    reject(
        409,
        "human_pinned",
        "사람이 정한 지정이다 — 에이전트는 덮지도 풀지도 못한다",
    )
}

/// TS `readPickable` — 저장된 jsonb. 모양이 틀린 줄은 버린다.
pub fn read_pickable(raw: Option<&Value>) -> Vec<Entry> {
    let Some(Value::Array(a)) = raw else {
        return Vec::new();
    };
    a.iter()
        .filter_map(|e| {
            let o = e.as_object()?;
            let model = o.get("model")?.as_str().filter(|m| !m.is_empty())?;
            let efforts = match o.get("efforts") {
                Some(Value::Array(es)) => es
                    .iter()
                    .filter_map(|x| x.as_str().map(str::to_owned))
                    .collect(),
                _ => Vec::new(),
            };
            Some(Entry {
                model: model.to_owned(),
                efforts,
            })
        })
        .collect()
}

/// 대상·값 모양 판정(DB 없이) — `self_pick` → `not_called` → `bad_model_value`.
pub fn target_verdict(actor: &str, notified: &HashSet<String>, p: &Pick) -> Option<Rejection> {
    if p.agent_id == actor {
        return Some(reject(
            403,
            "self_pick",
            "자기 자신의 모델은 고를 수 없다 — 사람만 바꾼다",
        ));
    }
    if !notified.contains(&p.agent_id) {
        return Some(reject(
            403,
            "not_called",
            "이 글이 실제로 깨우는 에이전트의 모델만 고른다(멘션·호출 범위를 확인하라)",
        ));
    }
    if !axis_valid(p.model.as_deref()) || !axis_valid(p.effort.as_deref()) {
        return Some(reject(
            400,
            "bad_model_value",
            "모델·effort 는 영숫자로 시작하고 영숫자·._:/[]- 만 쓴다",
        ));
    }
    None
}

/// 허용 목록 판정(결정 11). 풀기는 목록을 보지 않는다.
pub fn pickable_verdict(pickable: &[Entry], p: &Pick) -> Option<Rejection> {
    if p.clearing() {
        return None;
    }
    if pickable.is_empty() {
        return Some(reject(
            403,
            "not_pickable",
            "그 에이전트의 소유자가 다른 에이전트가 고를 수 있는 모델을 켜지 않았다",
        ));
    }
    let Some(model) = p.model.as_deref() else {
        return Some(reject(
            403,
            "not_pickable",
            "effort 만 고를 수는 없다 — 허용 목록의 모델을 함께 고른다",
        ));
    };
    let Some(entry) = pickable.iter().find(|e| e.model == model) else {
        let names: Vec<&str> = pickable.iter().map(|e| e.model.as_str()).collect();
        return Some(reject(
            403,
            "not_pickable",
            format!("허용 목록에 없는 모델이다({})", names.join("·")),
        ));
    };
    if let Some(e) = p.effort.as_deref()
        && !entry.efforts.iter().any(|x| x == e)
    {
        let msg = if entry.efforts.is_empty() {
            format!("{model} 은 effort 를 고를 수 없다(에이전트 설정 effort 그대로)")
        } else {
            format!(
                "{model} 에 허용된 effort 가 아니다({})",
                entry.efforts.join("·")
            )
        };
        return Some(reject(403, "not_pickable", msg));
    }
    None
}

/// 지금 행(`set_by_kind`, model, effort, combo_id). 사람이 정했으면 `human_pinned`.
pub type Existing = (String, Option<String>, Option<String>, Option<String>);

pub fn pinned_verdict(row: Option<&Existing>) -> Option<Rejection> {
    match row {
        Some((kind, _, _, _)) if kind == "human" => Some(human_pinned()),
        _ => None,
    }
}

/// 실제로 바뀌는가 — 없던 지정 풀기·같은 값 다시 정하기는 아니다.
pub fn is_effective(p: &Pick, row: Option<&Existing>) -> bool {
    match row {
        None => !p.clearing(),
        Some((_, m, e, c)) => {
            p.clearing() || !(m == &p.model && e == &p.effort && c == &p.combo_id)
        }
    }
}

/// 스레드 상한(결정 5).
pub fn limit_verdict(used: i32, effective: usize) -> Option<Rejection> {
    let n = i32::try_from(effective).unwrap_or(i32::MAX);
    if used.saturating_add(n) > AGENT_PICK_LIMIT_PER_THREAD {
        return Some(reject(
            429,
            "model_change_limit",
            format!(
                "이 스레드에서 에이전트가 모델을 바꾼 것이 이미 {used}번이다(상한 {AGENT_PICK_LIMIT_PER_THREAD}) — 사람에게 넘겨라"
            ),
        ));
    }
    None
}

const PICKABLE_SQL: &str =
    "select agent_pickable_models from agent_config where account_id = $1::uuid";
const EXISTING_SQL: &str = "select set_by_kind, model, effort, combo_id::text from thread_agent_model \
     where thread_root_id = $1::uuid and agent_id = $2::uuid";
const COUNT_SQL: &str =
    "select n from thread_agent_pick_count where thread_root_id = $1::uuid for update";
const COUNT_UP_SQL: &str = "insert into thread_agent_pick_count (thread_root_id, n) values ($1::uuid, $2) \
     on conflict (thread_root_id) do update set n = thread_agent_pick_count.n + excluded.n";
const CLEAR_AGENT_SQL: &str = "delete from thread_agent_model where thread_root_id = $1::uuid \
     and agent_id = $2::uuid and set_by_kind = 'agent'";
const ROOT_SQL: &str = "select 1 from message where id = $1::uuid and channel_id = $2::uuid \
     and thread_root_id is null and deleted_at is null";
const AGENT_SQL: &str = "select a.kind, c.harness from account a left join agent_config c on c.account_id = a.id \
      where a.id = $1::uuid and a.deleted_at is null";
const UPSERT_AGENT_SQL: &str = "insert into thread_agent_model (thread_root_id, agent_id, harness, model, effort, set_by, set_by_kind, combo_id) \
     values ($1::uuid, $2::uuid, $3, $4, $5, $6::uuid, 'agent', $7::uuid) \
     on conflict (thread_root_id, agent_id) do update set \
       harness = excluded.harness, model = excluded.model, effort = excluded.effort, \
       set_by = excluded.set_by, set_by_kind = excluded.set_by_kind, combo_id = excluded.combo_id, set_at = now() \
     where thread_agent_model.set_by_kind = 'agent'";
/// 그 에이전트 허용 목록의 조합 한 줄 — 조합 하네스·model·effort 와 에이전트의 지금 하네스. 목록에 없으면 줄이 없다.
/// `for share` 로 허용 줄을 잡아, 같은 때 목록에서 빼는 쓰기와 엇갈리지 않게 한다.
pub const COMBO_ALLOWED_SQL: &str = "select c.harness, c.model, c.effort, coalesce(g.harness, 'claude-code') \
       from agent_exec_combo a join exec_combo c on c.id = a.combo_id \
       left join agent_config g on g.account_id = a.agent_id \
      where a.agent_id = $1::uuid and a.combo_id = $2::uuid for share of a";

/// 쓰기가 끝난 한 줄 — 바뀐 에이전트와 새 (model, effort)(풀기면 `None`). 시스템 줄·이벤트는 커밋 뒤 호출자 몫.
pub type Change = (String, Option<(Option<String>, Option<String>)>);

async fn existing(
    tx: &mut sqlx::PgConnection,
    root: &str,
    agent: &str,
) -> sqlx::Result<Option<Existing>> {
    sqlx::query_as(EXISTING_SQL)
        .bind(root)
        .bind(agent)
        .fetch_optional(tx)
        .await
}

/// TS `applyAgentPicks` — 게시 tx 안에서 판정하고 쓴다. `Err(Rejection)` 이면 호출자가 롤백한다.
pub async fn apply(
    tx: &mut sqlx::PgConnection,
    channel: &str,
    root: &str,
    actor: &str,
    picks: &[Pick],
    notified: &HashSet<String>,
) -> sqlx::Result<Result<Vec<Change>, Rejection>> {
    // 조합을 고른 줄은 허용 목록에서 model·effort 를 채운 뒤 아래 판정을 그대로 지난다.
    let mut resolved = Vec::with_capacity(picks.len());
    for p in picks {
        if let Some(r) = target_verdict(actor, notified, p) {
            return Ok(Err(r));
        }
        let Some(combo) = p.combo_id.as_deref() else {
            resolved.push(p.clone());
            continue;
        };
        if p.model.is_some() || p.effort.is_some() {
            return Ok(Err(reject(
                400,
                "combo_with_model",
                "comboId 와 model·effort 를 함께 줄 수 없다 — 조합이 모델·effort 를 정한다",
            )));
        }
        let enabled = super::exec_combo::pool().is_some();
        let row: Option<ComboRow> = if enabled {
            sqlx::query_as(COMBO_ALLOWED_SQL)
                .bind(&p.agent_id)
                .bind(combo)
                .fetch_optional(&mut *tx)
                .await?
        } else {
            None
        };
        match combo_verdict(enabled, row.as_ref()) {
            Err(r) => return Ok(Err(r)),
            Ok((model, effort)) => resolved.push(Pick {
                agent_id: p.agent_id.clone(),
                model: Some(model),
                effort,
                combo_id: Some(combo.to_owned()),
            }),
        }
    }
    let picks = &resolved[..];
    for p in picks {
        if !p.clearing() && p.combo_id.is_none() {
            let raw: Option<Option<Value>> = sqlx::query_scalar(PICKABLE_SQL)
                .bind(&p.agent_id)
                .fetch_optional(&mut *tx)
                .await?;
            let list = read_pickable(raw.flatten().as_ref());
            if let Some(r) = pickable_verdict(&list, p) {
                return Ok(Err(r));
            }
        }
        let row = existing(&mut *tx, root, &p.agent_id).await?;
        if let Some(r) = pinned_verdict(row.as_ref()) {
            return Ok(Err(r));
        }
    }
    let mut effective = Vec::new();
    for p in picks {
        let row = existing(&mut *tx, root, &p.agent_id).await?;
        if is_effective(p, row.as_ref()) {
            effective.push(p);
        }
    }
    if effective.is_empty() {
        return Ok(Ok(Vec::new()));
    }
    let used: Option<i32> = sqlx::query_scalar(COUNT_SQL)
        .bind(root)
        .fetch_optional(&mut *tx)
        .await?;
    if let Some(r) = limit_verdict(used.unwrap_or(0), effective.len()) {
        return Ok(Err(r));
    }
    sqlx::query(COUNT_UP_SQL)
        .bind(root)
        .bind(i32::try_from(effective.len()).unwrap_or(i32::MAX))
        .execute(&mut *tx)
        .await?;
    let mut changes = Vec::new();
    for p in effective {
        if p.clearing() {
            let n = sqlx::query(CLEAR_AGENT_SQL)
                .bind(root)
                .bind(&p.agent_id)
                .execute(&mut *tx)
                .await?
                .rows_affected();
            if n == 0 {
                return Ok(Err(human_pinned()));
            }
            changes.push((p.agent_id.clone(), None));
            continue;
        }
        // TS `setThreadAgentModel(…, setByKind: 'agent')` — 루트·에이전트 판정 뒤 에이전트 행만 덮는다.
        let is_root: Option<i32> = sqlx::query_scalar(ROOT_SQL)
            .bind(root)
            .bind(channel)
            .fetch_optional(&mut *tx)
            .await?;
        let agent: Option<(String, Option<String>)> = sqlx::query_as(AGENT_SQL)
            .bind(&p.agent_id)
            .fetch_optional(&mut *tx)
            .await?;
        let harness = match (is_root, agent) {
            (Some(_), Some((kind, h))) if kind == "agent" => {
                h.unwrap_or_else(|| "claude-code".into())
            }
            _ => {
                return Ok(Err(reject(
                    403,
                    "not_called",
                    "그 대상에는 모델을 정할 수 없다",
                )));
            }
        };
        let n = sqlx::query(UPSERT_AGENT_SQL)
            .bind(root)
            .bind(&p.agent_id)
            .bind(&harness)
            .bind(&p.model)
            .bind(&p.effort)
            .bind(actor)
            .bind(&p.combo_id)
            .execute(&mut *tx)
            .await?
            .rows_affected();
        if n == 0 {
            return Ok(Err(human_pinned()));
        }
        changes.push((
            p.agent_id.clone(),
            Some((p.model.clone(), p.effort.clone())),
        ));
    }
    Ok(Ok(changes))
}

/// `message.post`·`agent.call` 의 TS `beforeCommit: applyAgentPicks(…)` — 글과 같은 tx 에서 고르기를 판정·쓴다.
/// 루트는 `threadRootId ?? 새 글 id`. 바뀐 줄은 [`AgentPicks::changes`] 로 꺼내 커밋 뒤 시스템 줄·이벤트를 낸다.
#[derive(Debug)]
pub(crate) struct AgentPicks {
    pub(crate) channel: String,
    pub(crate) root: Option<String>,
    pub(crate) actor: String,
    pub(crate) picks: Vec<Pick>,
    /// `notified` 에 더할 계정 — 자기 조각은 넘겨받는 담당(TS `[...ctx.notified, ...delegates]`).
    pub(crate) also_notified: Vec<String>,
    done: std::sync::Mutex<Option<(String, Vec<Change>)>>,
}

impl AgentPicks {
    pub(crate) fn new(channel: &str, root: Option<&str>, actor: &str, picks: Vec<Pick>) -> Self {
        Self {
            channel: channel.to_owned(),
            root: root.map(str::to_owned),
            actor: actor.to_owned(),
            picks,
            also_notified: Vec::new(),
            done: std::sync::Mutex::new(None),
        }
    }

    /// 자기 조각 — 넘겨받는 담당도 부른 것으로 센다.
    pub(crate) fn also_notify(mut self, ids: &[String]) -> Self {
        self.also_notified = ids.to_vec();
        self
    }

    /// 쓴 스레드 루트와 바뀐 줄(훅이 지났을 때만).
    pub(crate) fn changes(&self) -> Option<(String, Vec<Change>)> {
        self.done.lock().ok()?.clone()
    }
}

impl crate::core::msg_post::BeforeCommit for AgentPicks {
    fn run<'a>(
        &'a self,
        tx: &'a mut sqlx::Transaction<'static, sqlx::Postgres>,
        message_id: &'a str,
        notified: &'a HashSet<String>,
    ) -> crate::core::msg_post::BeforeCommitFuture<'a> {
        Box::pin(async move {
            let root = self.root.clone().unwrap_or_else(|| message_id.to_owned());
            let merged: HashSet<String>;
            let notified = if self.also_notified.is_empty() {
                notified
            } else {
                merged = notified
                    .iter()
                    .chain(self.also_notified.iter())
                    .cloned()
                    .collect();
                &merged
            };
            match apply(tx, &self.channel, &root, &self.actor, &self.picks, notified).await? {
                Err(r) => Ok(Some(r)),
                Ok(changes) => {
                    if let Ok(mut g) = self.done.lock() {
                        *g = Some((root, changes));
                    }
                    Ok(None)
                }
            }
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    const A: &str = "11111111-1111-4111-8111-111111111111";
    const B: &str = "22222222-2222-4222-8222-222222222222";

    fn pick(m: Option<&str>, e: Option<&str>) -> Pick {
        Pick {
            agent_id: B.into(),
            model: m.map(Into::into),
            effort: e.map(Into::into),
            combo_id: None,
        }
    }
    fn code(r: Option<Rejection>) -> Option<(u16, String)> {
        r.map(|r| (r.status, r.code))
    }

    #[test]
    fn hook_has_no_changes_until_run() {
        let h = AgentPicks::new(A, None, A, vec![pick(Some("opus"), None)]);
        assert!(h.changes().is_none());
        assert!(h.root.is_none());
        assert!(AGENT_MODEL_PICKS_PRIVILEGES.contains(&("account.handle", "SELECT")));
        let _: &dyn crate::core::msg_post::BeforeCommit = &h;
    }

    #[test]
    fn read_pickable_drops_bad_rows() {
        let v = json!([{ "model": "opus", "efforts": ["high", 1] }, { "model": "" }, 3, { "model": "s" }]);
        let got = read_pickable(Some(&v));
        assert_eq!(got.len(), 2);
        assert_eq!(got[0].efforts, vec!["high".to_owned()]);
        assert!(got[1].efforts.is_empty());
        assert!(read_pickable(Some(&json!({}))).is_empty());
        assert!(read_pickable(None).is_empty());
    }

    #[test]
    fn target_order() {
        let mut n = HashSet::new();
        assert_eq!(
            code(target_verdict(B, &n, &pick(Some("x"), None))),
            Some((403, "self_pick".into()))
        );
        assert_eq!(
            code(target_verdict(A, &n, &pick(Some("x"), None))),
            Some((403, "not_called".into()))
        );
        n.insert(B.into());
        assert_eq!(
            code(target_verdict(A, &n, &pick(Some("-x"), None))),
            Some((400, "bad_model_value".into()))
        );
        assert!(target_verdict(A, &n, &pick(Some("x"), Some("high"))).is_none());
        assert!(target_verdict(A, &n, &pick(None, None)).is_none());
    }

    #[test]
    fn pickable_combos() {
        let list = read_pickable(Some(
            &json!([{ "model": "opus", "efforts": ["high"] }, { "model": "s" }]),
        ));
        let np = |m, e| code(pickable_verdict(&list, &pick(m, e)));
        assert!(np(None, None).is_none());
        assert!(np(Some("opus"), None).is_none());
        assert!(np(Some("opus"), Some("high")).is_none());
        assert_eq!(
            np(Some("opus"), Some("low")),
            Some((403, "not_pickable".into()))
        );
        assert_eq!(
            np(Some("s"), Some("low")),
            Some((403, "not_pickable".into()))
        );
        assert_eq!(np(None, Some("high")), Some((403, "not_pickable".into())));
        assert_eq!(np(Some("x"), None), Some((403, "not_pickable".into())));
        assert_eq!(
            code(pickable_verdict(&[], &pick(Some("opus"), None))),
            Some((403, "not_pickable".into()))
        );
        let r = pickable_verdict(&list, &pick(Some("x"), None)).unwrap();
        assert_eq!(r.message, "허용 목록에 없는 모델이다(opus·s)");
    }

    #[test]
    fn pinned_effective_limit() {
        let human: Existing = ("human".into(), Some("opus".into()), None, None);
        let agent: Existing = ("agent".into(), Some("opus".into()), None, None);
        assert_eq!(
            code(pinned_verdict(Some(&human))),
            Some((409, "human_pinned".into()))
        );
        assert!(pinned_verdict(Some(&agent)).is_none());
        assert!(pinned_verdict(None).is_none());
        assert!(!is_effective(&pick(None, None), None));
        assert!(is_effective(&pick(None, None), Some(&agent)));
        assert!(!is_effective(&pick(Some("opus"), None), Some(&agent)));
        assert!(is_effective(
            &pick(Some("opus"), Some("high")),
            Some(&agent)
        ));
        assert!(is_effective(&pick(Some("opus"), None), None));
        // 같은 모델이라도 조합이 달라지면 바뀐 것이다.
        let mut combo = pick(Some("opus"), None);
        combo.combo_id = Some(A.into());
        assert!(is_effective(&combo, Some(&agent)));
        assert!(is_effective(&combo, None));
        let held: Existing = ("agent".into(), Some("opus".into()), None, Some(A.into()));
        assert!(!is_effective(&combo, Some(&held)));
        assert!(is_effective(&pick(Some("opus"), None), Some(&held)));
        assert!(limit_verdict(0, 3).is_none());
        assert!(limit_verdict(2, 1).is_none());
        assert_eq!(
            code(limit_verdict(2, 2)),
            Some((429, "model_change_limit".into()))
        );
    }

    #[test]
    fn combo_verdicts() {
        let row: ComboRow = (
            "claude-code".into(),
            "opus".into(),
            Some("high".into()),
            "claude-code".into(),
        );
        assert_eq!(
            combo_verdict(true, Some(&row)).unwrap(),
            ("opus".to_owned(), Some("high".to_owned()))
        );
        let c =
            |r: Result<(String, Option<String>), Rejection>| r.err().map(|r| (r.status, r.code));
        assert_eq!(
            c(combo_verdict(false, Some(&row))),
            Some((409, "combo_off".into()))
        );
        assert_eq!(
            c(combo_verdict(true, None)),
            Some((403, "combo_not_allowed".into()))
        );
        let other: ComboRow = ("codex".into(), "m".into(), None, "claude-code".into());
        assert_eq!(
            c(combo_verdict(true, Some(&other))),
            Some((403, "combo_harness_mismatch".into()))
        );
        // 조합만 고른 줄은 풀기가 아니다.
        let mut p = pick(None, None);
        assert!(p.clearing());
        p.combo_id = Some(A.into());
        assert!(!p.clearing());
        // 허용 목록은 그 에이전트의 줄로만 읽는다 — 조합 표만 보고 통과시키지 않는다.
        assert!(COMBO_ALLOWED_SQL.contains("from agent_exec_combo a"));
        assert!(COMBO_ALLOWED_SQL.contains("a.agent_id = $1::uuid and a.combo_id = $2::uuid"));
        assert!(UPSERT_AGENT_SQL.contains("combo_id = excluded.combo_id"));
    }
}
