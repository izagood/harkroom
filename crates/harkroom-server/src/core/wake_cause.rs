//! 임대·사슬 판정 이전(EC) — 「이 글이 이 에이전트를 불렀나」를 `inbox` 대신 **깨움 행(`wake`, 181)** 에서 읽는다.
//!
//! - 스위치 `HARKROOM_WAKE_CAUSE`(`off`(기본) | `shadow` | `on`).
//!   - `off`: 이 모듈은 아무 문장도 돌지 않는다.
//!   - `shadow`: 답은 여전히 inbox 문장이 정한다. 깨움 행 문장을 나란히 돌려 **답이 다를 때만** 측정 한 줄을 남긴다
//!     ([`note`]). 같았던 횟수는 [`SAME_BATCH`] 번마다 한 줄로 모아 적는다(불일치 0 을 볼 때의 분모).
//!   - `on`: 깨움 행 문장이 답한다. inbox 문장은 돌지 않는다.
//! - 옮기는 문장은 다섯이다: 골든 `turn_lease_cause`(임대 원인)·`cause_verified_link`(사슬 고리)·`cause_reasons`(부른 사유),
//!   머지 사슬의 후속 보고 검사, 권한 위임의 원인 확인. 골든은 고치지 않는다 — [`swap`] 이 inbox 를 읽는 낱말만 바꾼다
//!   (표 이름, 그리고 임대 원인의 「안 읽음」 → 「열린 깨움」). 바꿀 낱말이 정확히 한 번 나오지 않으면 기동하지 않는다.
//! - 깨움 행은 계정·글·사유·만든 시각을 inbox 줄에서 그대로 베낀다. 그래서 판정에 쓰는 칸은 같다. `work_id`(근삿값)는 읽지 않는다.
//! - 깨움 행은 에이전트 계정에만 있다. 다섯 문장은 모두 에이전트가 주체일 때만 돈다.
//! - 깨움 행 같이 쓰기([`crate::core::wake_write`])가 켜져 있어야 켠다 — 꺼져 있으면 깨움 행이 거울 주기만큼 늦게 생겨 그 사이
//!   임대가 거절된다.
use serde_json::{Value, json};
use sqlx::PgConnection;
use std::sync::atomic::{AtomicU8, AtomicU64, Ordering};

/// 스위치 환경 변수.
pub const SWITCH_ENV: &str = "HARKROOM_WAKE_CAUSE";

/// 판정 문장이 읽는 칸(표.칸, 권한) — 읽기 풀·쓰기 풀 둘 다에 있어야 켠다.
pub const WAKE_CAUSE_PRIVILEGES: &[(&str, &str)] = &[
    ("wake.account_id", "SELECT"),
    ("wake.message_id", "SELECT"),
    ("wake.reason", "SELECT"),
    ("wake.state", "SELECT"),
    ("wake.created_at", "SELECT"),
];

/// 같았던 비교를 이만큼 모아 한 줄로 적는다.
pub const SAME_BATCH: u64 = 50;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Switch {
    Off,
    Shadow,
    On,
}

/// 스위치 글자를 읽는다 — `shadow`·`on` 만 뜻이 있다. 없거나 모르는 값이면 `Off`(기본). 앞뒤 공백·대소문자는 가리지 않는다.
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

static MODE: AtomicU8 = AtomicU8::new(0);

/// 켠다(프로세스에 한 번, `main.rs` 가 권한과 같이 쓰기 켬을 본 뒤).
pub fn enable(s: Switch) {
    MODE.store(
        match s {
            Switch::Off => 0,
            Switch::Shadow => 1,
            Switch::On => 2,
        },
        Ordering::Relaxed,
    );
}

/// 지금 값.
pub fn mode() -> Switch {
    match MODE.load(Ordering::Relaxed) {
        1 => Switch::Shadow,
        2 => Switch::On,
        _ => Switch::Off,
    }
}

/// 임대 원인 문장에서 바꾸는 낱말 — 표 이름 셋과 「안 읽음」.
pub const LEASE_CAUSE_SWAPS: &[(&str, &str)] = &[
    ("from inbox fu where", "from wake fu where"),
    ("from inbox iw where", "from wake iw where"),
    ("from inbox i join message m", "from wake i join message m"),
    ("i.read_at is null", "i.state in ('pending', 'delivered')"),
];
/// 사슬 고리 문장에서 바꾸는 낱말.
pub const VERIFIED_LINK_SWAPS: &[(&str, &str)] = &[("from inbox i where", "from wake i where")];
/// 부른 사유·후속 보고 검사 문장에서 바꾸는 낱말.
pub const BARE_SWAPS: &[(&str, &str)] = &[("from inbox where", "from wake where")];

/// `sql` 의 낱말을 바꾼다. 바꿀 낱말이 정확히 한 번 나오지 않으면 멈춘다 — 골든이 바뀌었는데 반만 옮겨진 문장을 돌리지 않으려는 것이다.
pub fn swap(sql: &str, swaps: &[(&str, &str)]) -> String {
    let mut out = sql.to_string();
    for (from, to) in swaps {
        let n = out.matches(from).count();
        assert!(n == 1, "wake_cause: `{from}` appears {n} times");
        out = out.replacen(from, to, 1);
    }
    assert!(
        !out.contains(" inbox "),
        "wake_cause: an inbox read is left"
    );
    out
}

/// shadow 비교를 감싸는 savepoint — 깨움 행 문장이 실패해도 부른 쪽 트랜잭션을 깨지 않는다.
/// 트랜잭션 밖이면 savepoint 가 거절된다(`false`) — 그때는 실패해도 깨질 트랜잭션이 없다.
pub async fn guard(conn: &mut PgConnection) -> bool {
    sqlx::query("savepoint wake_cause")
        .execute(&mut *conn)
        .await
        .is_ok()
}

/// [`guard`] 를 닫는다. 비교 문장이 실패했으면 그 savepoint 까지만 되돌린다.
pub async fn release(conn: &mut PgConnection, guarded: bool, ok: bool) {
    if !guarded {
        return;
    }
    if !ok
        && sqlx::query("rollback to savepoint wake_cause")
            .execute(&mut *conn)
            .await
            .is_err()
    {
        return;
    }
    let _ = sqlx::query("release savepoint wake_cause")
        .execute(&mut *conn)
        .await;
}

static SAME: AtomicU64 = AtomicU64::new(0);

/// shadow 비교 결과를 적는다. `same` 이 `None` 이면 깨움 행 문장이 실패한 것이다. 글 본문·토큰은 싣지 않는다 —
/// 어느 문장인지(`q`)와 갈린 칸 이름(`detail`)만이다.
pub fn note(q: &'static str, agent: &str, message: &str, same: Option<bool>, detail: Value) {
    use super::measure;
    let event = |kind, value, detail| measure::Event {
        kind,
        account_id: Some(agent.to_owned()),
        ref_id: Some(message.to_owned()),
        value,
        detail: Some(detail),
        ..Default::default()
    };
    match same {
        Some(true) => {
            if let Some(n) = batch(SAME.fetch_add(1, Ordering::Relaxed) + 1) {
                measure::record(measure::Event {
                    kind: measure::KIND_WAKE_CAUSE_SAME,
                    value: Some(n),
                    ..Default::default()
                });
            }
        }
        Some(false) => measure::record(event(
            measure::KIND_WAKE_CAUSE_MISMATCH,
            None,
            json!({ "q": q, "diff": detail }),
        )),
        None => measure::record(event(
            measure::KIND_WAKE_CAUSE_MISMATCH,
            None,
            json!({ "q": q, "error": true }),
        )),
    }
}

/// 같았던 횟수가 묶음을 채웠으면 그 묶음 크기.
fn batch(count: u64) -> Option<i64> {
    count
        .is_multiple_of(SAME_BATCH)
        .then_some(SAME_BATCH as i64)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn golden(k: &str) -> String {
        let v: Value =
            serde_json::from_str(include_str!("../../golden/sql_fragments.json")).unwrap();
        v[k].as_str().unwrap().to_string()
    }

    #[test]
    fn switch_is_off_unless_shadow_or_on() {
        assert_eq!(parse_switch(None), Switch::Off);
        assert_eq!(parse_switch(Some("")), Switch::Off);
        assert_eq!(parse_switch(Some("off")), Switch::Off);
        assert_eq!(parse_switch(Some("1")), Switch::Off);
        assert_eq!(parse_switch(Some("wake")), Switch::Off);
        assert_eq!(parse_switch(Some(" Shadow ")), Switch::Shadow);
        assert_eq!(parse_switch(Some("ON")), Switch::On);
        // 프로세스 기본은 꺼짐이다(`enable` 을 부르는 곳은 `main.rs` 하나).
        assert_eq!(mode(), Switch::Off);
    }

    /// 옮긴 문장에서 바꾼 낱말을 되돌리면 골든과 글자 하나 다르지 않다 — 조건을 더하거나 빼지 않았다.
    #[test]
    fn swapped_statements_differ_only_in_the_swapped_words() {
        for (key, swaps) in [
            ("turn_lease_cause", LEASE_CAUSE_SWAPS),
            ("cause_verified_link", VERIFIED_LINK_SWAPS),
            ("cause_reasons", BARE_SWAPS),
        ] {
            let old = golden(key);
            let new = swap(&old, swaps);
            assert_ne!(old, new, "{key}");
            let mut back = new.clone();
            for (from, to) in swaps {
                assert_eq!(back.matches(to).count(), 1, "{key}: {to}");
                back = back.replacen(to, from, 1);
            }
            assert_eq!(back, old, "{key}");
            // 계정·글·시각 조건은 그대로 남는다.
            assert!(
                new.contains("$1::uuid") && new.contains("$2::uuid"),
                "{key}"
            );
            assert!(!new.contains("work_id"), "{key}");
        }
    }

    #[test]
    fn lease_cause_reads_open_wakes_of_that_account_and_message() {
        let new = swap(&golden("turn_lease_cause"), LEASE_CAUSE_SWAPS);
        assert!(new.contains(
            "where i.account_id = $1::uuid and i.message_id = $2::uuid and i.state in ('pending', 'delivered') and i.created_at > $3::timestamptz and m.deleted_at is null"
        ));
        // 위임 키의 옛 깨움 표(`agent_wake`) 읽기는 건드리지 않는다.
        assert!(new.contains("from agent_wake w where"));
        // 후속 보고로 깬 턴은 위임·principal 을 잇지 않는다 — 그 사유 검사가 깨움 행으로 옮겨져 남아 있다.
        assert!(new.contains("from wake fu where fu.account_id = i.account_id and fu.message_id = m.id and fu.reason = 'delegation_followup'"));
        assert!(new.contains("from wake iw where iw.account_id = i.account_id and iw.message_id = m.id and iw.reason in ('wake', 'delegation_followup')"));
    }

    #[test]
    fn verified_link_keeps_freshness_and_followup_guard() {
        let new = swap(&golden("cause_verified_link"), VERIFIED_LINK_SWAPS);
        assert!(new.contains(
            "from wake i where i.message_id = m.id and i.account_id = $2::uuid and i.created_at > $3::timestamptz and i.reason <> 'delegation_followup'"
        ));
    }

    #[test]
    #[should_panic(expected = "appears 0 times")]
    fn swap_refuses_a_statement_it_does_not_know() {
        swap("select 1 from message", BARE_SWAPS);
    }

    #[test]
    #[should_panic(expected = "an inbox read is left")]
    fn swap_refuses_a_half_moved_statement() {
        swap(
            "select 1 from inbox where exists (select 1 from inbox x)",
            BARE_SWAPS,
        );
    }

    #[test]
    fn same_checks_are_noted_once_per_batch() {
        assert_eq!(batch(1), None);
        assert_eq!(batch(SAME_BATCH - 1), None);
        assert_eq!(batch(SAME_BATCH), Some(SAME_BATCH as i64));
        assert_eq!(batch(SAME_BATCH * 3), Some(SAME_BATCH as i64));
    }

    #[test]
    fn privileges_only_read_wake_columns() {
        assert!(
            WAKE_CAUSE_PRIVILEGES
                .iter()
                .all(|(t, p)| t.starts_with("wake.") && *p == "SELECT")
        );
    }
}
