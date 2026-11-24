//! 작업 원장의 위임장(G1) — **그림자만**. 머지 판정은 한 글자도 바꾸지 않는다.
//!
//! - 지금 머지 판정은 턴 임대에 실린 위임장(`turn_lease.mandate_id`)으로 줄을 찾는다. 원장은 같은 줄을
//!   「이 턴의 작업 → 뿌리 작업(`work.root_id`) → 그 뿌리의 위임장(`work.mandate_id`)」으로도 찾을 수 있어야 한다.
//!   여기서는 두 길을 나란히 돌려 일치/불일치 갈래만 `measure_event`([`super::measure::KIND_LEDGER_MANDATE`])에 남긴다.
//! - **턴 ↔ 작업 연결은 아직 표에 없다.** 그래서 가장 좁은 근삿값을 쓴다: 임대의 스레드에서 이 에이전트가 맡은
//!   열린 작업 가운데 가장 새것([`ROOT_MANDATE_SQL`]). 못 찾으면 `no_work` 갈래다.
//! - 판정 밖에서 돈다 — [`merge_shadow`] 는 `tokio::spawn` 으로 다른 연결에서 읽기만 하고, 실패는 `error` 갈래 한 줄과
//!   로그(오류 종류만)로 삼킨다. 부른 쪽의 응답·트랜잭션·지연에 닿지 않는다.
//! - 기록에는 id(에이전트·채널·스레드)와 갈래만 싣는다 — 이름·저장소·글은 싣지 않는다.
//! - 스위치 `HARKROOM_LEDGER_MANDATE`(`off`(기본) | `shadow` | `on`) — [`switch_from_env`].
//!   **이 단계에서 `on` 은 `shadow` 와 똑같이 돈다** — 뿌리 위임장으로 실제 판정을 내리는 일은 다음 단계다.
use super::mandate_line_match::{self, MergeAction};
use serde_json::{Value, json};
use sqlx::PgPool;
use std::sync::OnceLock;

/// 그림자가 쓰는 권한 — 작업 표 읽기. 줄 찾기는 [`mandate_line_match::MERGE_CHECKS_MANDATE_PRIVILEGES`] 를 따로 본다(`main.rs`).
pub const LEDGER_MANDATE_PRIVILEGES: &[(&str, &str)] = &[("work", "SELECT")];

/// 스위치 환경 변수.
pub const SWITCH_ENV: &str = "HARKROOM_LEDGER_MANDATE";

static POOL: OnceLock<PgPool> = OnceLock::new();

/// 그림자를 켠다(프로세스에 한 번). 두 번째 부름은 무시한다.
pub fn enable(pool: PgPool) {
    let _ = POOL.set(pool);
}

/// 스위치 값. `On` 은 이 단계에서 `Shadow` 와 같은 동작이다(모듈 머리 참고).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Switch {
    Off,
    Shadow,
    On,
}

/// 스위치 글자를 읽는다 — 없거나 모르는 값이면 `Off`(기본). 앞뒤 공백·대소문자는 가리지 않는다.
pub fn parse_switch(raw: Option<&str>) -> Switch {
    match raw.map(|v| v.trim().to_ascii_lowercase()).as_deref() {
        Some("shadow") => Switch::Shadow,
        Some("on") => Switch::On,
        _ => Switch::Off,
    }
}

/// 환경 변수 [`SWITCH_ENV`] 에서 읽는다.
pub fn switch_from_env() -> Switch {
    parse_switch(std::env::var(SWITCH_ENV).ok().as_deref())
}

/// 이 턴의 작업(스레드 `$1` 에서 에이전트 `$2` 가 맡은 열린 작업 중 가장 새것)의 뿌리 작업에 이어진 위임장.
/// 줄이 없으면 작업을 못 찾은 것, 줄이 있고 값이 null 이면 뿌리에 위임장이 없는 것이다.
pub const ROOT_MANDATE_SQL: &str = "select r.mandate_id::text \
       from work w join work r on r.id = w.root_id \
      where w.thread_root_id = $1::uuid and w.assignee_account_id = $2::uuid and w.closed_at is null \
      order by w.created_at desc, w.id desc limit 1";

/// 뿌리 작업으로 찾은 것.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum RootMandate {
    /// 이 턴의 작업 행을 찾지 못했다.
    NoWork,
    /// 뿌리 작업에 위임장이 없다.
    NoMandate,
    Mandate(String),
}

/// [`ROOT_MANDATE_SQL`] 을 돈다. 읽기만 한다.
pub async fn root_mandate(pool: &PgPool, thread: &str, agent: &str) -> sqlx::Result<RootMandate> {
    let row: Option<(Option<String>,)> = sqlx::query_as(ROOT_MANDATE_SQL)
        .bind(thread)
        .bind(agent)
        .fetch_optional(pool)
        .await?;
    Ok(match row {
        None => RootMandate::NoWork,
        Some((None,)) => RootMandate::NoMandate,
        Some((Some(m),)) => RootMandate::Mandate(m),
    })
}

/// 두 길의 결과 → 갈래. `current` 는 임대의 위임장으로 줄을 찾았나, `ledger` 는 뿌리 작업의 위임장으로 찾았나
/// (`None` = 뿌리 위임장이 없어 찾을 것이 없었다).
///
/// | 갈래 | 뜻 | 일치 |
/// |---|---|---|
/// | `no_work` | 턴의 작업 행이 없다(대조 못 함) | — |
/// | `both_none` | 임대에도 뿌리에도 위임장이 없다 | 일치 |
/// | `same_mandate` | 두 길이 같은 위임장에 닿았다 | 일치 |
/// | `match_line` · `match_no_line` | 위임장은 다르지만 줄 찾기 결과가 같다 | 일치 |
/// | `ledger_only` | 뿌리 길만 줄을 찾았다(원장이 더 넓다) | 불일치 |
/// | `current_only` | 지금 길만 줄을 찾았다(원장이 더 좁다) | 불일치 |
pub fn branch(
    root: &RootMandate,
    lease_mandate: Option<&str>,
    current: bool,
    ledger: Option<bool>,
) -> (&'static str, Option<bool>) {
    match (root, lease_mandate) {
        (RootMandate::NoWork, _) => ("no_work", None),
        (RootMandate::NoMandate, None) => ("both_none", Some(true)),
        (RootMandate::Mandate(m), Some(l)) if m == l => ("same_mandate", Some(true)),
        _ => match (current, ledger.unwrap_or(false)) {
            (true, true) => ("match_line", Some(true)),
            (false, false) => ("match_no_line", Some(true)),
            (false, true) => ("ledger_only", Some(false)),
            (true, false) => ("current_only", Some(false)),
        },
    }
}

/// 기록 한 줄의 `detail` — 갈래·일치 여부·지금 판정이 허락이었나. 이름·저장소·글은 없다.
pub fn detail(branch: &str, agree: Option<bool>, allowed: bool) -> Value {
    json!({ "branch": branch, "agree": agree, "allowed": allowed })
}

/// 머지 판정 하나의 그림자 대조에 드는 사실(소유 값 — 요청 밖으로 들고 나간다).
#[derive(Debug, Clone)]
pub struct MergeFacts {
    pub agent: String,
    pub channel: Option<String>,
    pub thread: Option<String>,
    pub lease_mandate: Option<String>,
    /// 지금 판정이 허락이었나.
    pub allowed: bool,
    /// 지금 판정이 이미 쓴 줄이 있나(있으면 지금 길은 다시 찾지 않는다 — 방금 쓴 한 번짜리 줄을 놓치지 않게).
    pub used_line: bool,
    pub repo: String,
    pub pr: Option<i64>,
    pub head: Option<String>,
    pub gh_user: Option<String>,
}

async fn compare(pool: &PgPool, f: &MergeFacts) -> sqlx::Result<(&'static str, Option<bool>)> {
    let Some(thread) = f.thread.as_deref() else {
        return Ok(("no_work", None));
    };
    let root = root_mandate(pool, thread, &f.agent).await?;
    let early = branch(&root, f.lease_mandate.as_deref(), false, None);
    if matches!(early.0, "no_work" | "both_none" | "same_mandate") {
        return Ok(early);
    }
    let now_ms = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map_or(0, |d| d.as_millis() as i64);
    let action = MergeAction {
        repo: &f.repo,
        pr: f.pr,
        head: f.head.as_deref(),
        gh_user: f.gh_user.as_deref(),
        ci_override: false,
    };
    let current = f.used_line
        || (f.lease_mandate.is_some()
            && mandate_line_match::find_line(
                pool,
                f.lease_mandate.as_deref(),
                &f.agent,
                &action,
                now_ms,
            )
            .await?
            .is_some());
    let ledger = match &root {
        RootMandate::Mandate(m) => Some(
            mandate_line_match::find_line(pool, Some(m), &f.agent, &action, now_ms)
                .await?
                .is_some(),
        ),
        _ => None,
    };
    Ok(branch(&root, f.lease_mandate.as_deref(), current, ledger))
}

/// [`merge_shadow`] 의 몸통 — 대조하고 한 줄을 남긴다. 실패는 `error` 갈래와 로그(오류 종류만)다.
pub async fn merge_shadow_with(pool: &PgPool, f: MergeFacts) {
    let (b, agree) = match compare(pool, &f).await {
        Ok(v) => v,
        Err(e) => {
            eprintln!(
                "ledger mandate: shadow skipped ({})",
                e.as_database_error().map_or("io", |_| "db")
            );
            ("error", None)
        }
    };
    super::measure::record(super::measure::Event {
        kind: super::measure::KIND_LEDGER_MANDATE,
        account_id: Some(f.agent),
        channel_id: f.channel,
        thread_root_id: f.thread,
        value: agree.map(i64::from),
        detail: Some(detail(b, agree, f.allowed)),
        ..super::measure::Event::default()
    });
}

/// 머지 판정이 난 자리에서 부른다 — 기다리지 않는다. 꺼져 있거나 런타임 밖이면 아무것도 하지 않는다.
pub fn merge_shadow(f: impl FnOnce() -> MergeFacts) {
    let Some(pool) = POOL.get() else { return };
    let Ok(rt) = tokio::runtime::Handle::try_current() else {
        return;
    };
    let f = f();
    rt.spawn(merge_shadow_with(pool, f));
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn switch_is_off_unless_named() {
        assert_eq!(parse_switch(None), Switch::Off);
        assert_eq!(parse_switch(Some("")), Switch::Off);
        assert_eq!(parse_switch(Some("yes")), Switch::Off);
        assert_eq!(parse_switch(Some(" Shadow ")), Switch::Shadow);
        assert_eq!(parse_switch(Some("ON")), Switch::On);
    }

    #[test]
    fn branches_cover_agree_and_disagree() {
        let m = |s: &str| RootMandate::Mandate(s.to_string());
        assert_eq!(
            branch(&RootMandate::NoWork, Some("A"), true, None),
            ("no_work", None)
        );
        assert_eq!(
            branch(&RootMandate::NoMandate, None, false, None),
            ("both_none", Some(true))
        );
        assert_eq!(
            branch(&m("A"), Some("A"), false, None),
            ("same_mandate", Some(true))
        );
        assert_eq!(
            branch(&m("B"), Some("A"), true, Some(true)),
            ("match_line", Some(true))
        );
        assert_eq!(
            branch(&m("B"), Some("A"), false, Some(false)),
            ("match_no_line", Some(true))
        );
        // 임대엔 위임장이 없는데 뿌리 작업엔 있고 줄도 맞는다 — 원장이 더 넓다.
        assert_eq!(
            branch(&m("B"), None, false, Some(true)),
            ("ledger_only", Some(false))
        );
        // 뿌리에 위임장이 없는데 지금 길은 줄을 찾았다 — 원장이 더 좁다.
        assert_eq!(
            branch(&RootMandate::NoMandate, Some("A"), true, None),
            ("current_only", Some(false))
        );
        assert_eq!(
            branch(&RootMandate::NoMandate, Some("A"), false, None),
            ("match_no_line", Some(true))
        );
    }

    #[test]
    fn detail_carries_only_branch_and_flags() {
        let d = detail("ledger_only", Some(false), true);
        assert_eq!(
            d,
            json!({ "branch": "ledger_only", "agree": false, "allowed": true })
        );
        assert_eq!(detail("no_work", None, false)["agree"], Value::Null);
    }

    #[test]
    fn shadow_is_a_no_op_until_enabled() {
        // 켜지지 않았다 — 사실을 모으는 닫힘도 부르지 않는다.
        merge_shadow(|| unreachable!("facts must not be gathered while off"));
    }

    #[test]
    fn root_sql_reads_work_only() {
        assert!(ROOT_MANDATE_SQL.contains("from work w join work r on r.id = w.root_id"));
        assert!(ROOT_MANDATE_SQL.contains("w.closed_at is null"));
        assert!(LEDGER_MANDATE_PRIVILEGES.contains(&("work", "SELECT")));
    }
}
