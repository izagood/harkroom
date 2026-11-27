//! 턴 원천 교체(EB) — 에이전트의 `inbox.poll` 이 **깨움 행(`wake`, 181)이 열려 있는 줄만** 내준다.
//!
//! - 스위치 `HARKROOM_WAKE_SOURCE`(`inbox`(기본) | `wake`). `inbox` 면 이 모듈은 아무것도 바꾸지 않는다.
//! - 전선 모양은 그대로다. 내주는 id 는 깨움 행의 `inbox_id`(= 그 inbox 줄의 id)라 러너·오퍼레이터는 바뀌지 않고,
//!   `inbox.read` 도 같은 id 를 받는다. 읽음은 [`crate::core::wake_write::mark_read`] 가 inbox 줄과 깨움을 한 문장에서 닫는다.
//! - 거르기는 [`OPEN_WAKE_FILTER`] 하나다 — 안 읽은 inbox 줄 가운데 열린(`pending`·`delivered`) 깨움이 있는 것.
//!   inbox 의 안 읽음 조건은 그대로 남긴다: 깨움만 열려 있고 inbox 줄은 이미 읽힌 줄(같이 닫기가 실패해 옛 문장으로 읽은 줄 등)을
//!   다시 내주지 않으려는 것이다 — 그런 줄은 거울 루프가 곧 닫는다. `work_id` 는 읽지 않는다(근삿값이다).
//! - 사람 계정은 깨움 행이 없다 — 늘 inbox 로 읽는다([`for_kind`]).
//! - 깨움 행 같이 쓰기([`crate::core::wake_write`])가 켜져 있어야 켠다. 꺼져 있으면 깨움 행이 거울 주기만큼 늦게 생겨 턴이 그만큼
//!   늦어지고, 읽음이 깨움을 같이 닫지 않는다. 임대(`lease`)는 여전히 inbox 줄의 칸에 건다.
use std::sync::atomic::{AtomicBool, Ordering};

/// 스위치 환경 변수.
pub const SWITCH_ENV: &str = "HARKROOM_WAKE_SOURCE";

/// 읽기 풀이 가져야 하는 권한(표.칸, 권한) — 없으면 `main.rs` 가 켜지 않는다.
pub const WAKE_SOURCE_PRIVILEGES: &[(&str, &str)] =
    &[("wake.inbox_id", "SELECT"), ("wake.state", "SELECT")];

/// 안 읽은 줄 문장의 `order by i.id` 앞에 끼우는 조건.
pub const OPEN_WAKE_FILTER: &str = "and exists (select 1 from wake w where w.inbox_id = i.id and w.state in ('pending', 'delivered'))";

static ON: AtomicBool = AtomicBool::new(false);

/// 스위치 글자를 읽는다 — `wake` 만 켬이다. 없거나 모르는 값이면 `inbox`(기본). 앞뒤 공백·대소문자는 가리지 않는다.
pub fn parse_switch(raw: Option<&str>) -> bool {
    raw.map(|v| v.trim().to_ascii_lowercase()).as_deref() == Some("wake")
}

/// 환경 변수 [`SWITCH_ENV`] 에서 읽는다.
pub fn switch_from_env() -> bool {
    parse_switch(std::env::var(SWITCH_ENV).ok().as_deref())
}

/// 켠다(프로세스에 한 번, `main.rs` 가 권한과 같이 쓰기 켬을 본 뒤).
pub fn enable() {
    ON.store(true, Ordering::Relaxed);
}

/// 켜져 있나.
pub fn enabled() -> bool {
    ON.load(Ordering::Relaxed)
}

/// 이 계정 종류의 폴을 깨움 행에서 답하나 — 켜져 있고 에이전트일 때만.
pub fn for_kind(kind: &str) -> bool {
    pick(enabled(), kind)
}

/// [`for_kind`] 의 몸 — 스위치 값을 받는다(시험이 직접 부른다).
pub fn pick(on: bool, kind: &str) -> bool {
    on && kind == "agent"
}

/// 나머지 읽는 곳(ED)이 읽는 칸(표.칸, 권한) — 읽기 풀·쓰기 풀 둘 다에 있어야 켠다([`enable_readers`]).
pub const WAKE_READER_PRIVILEGES: &[(&str, &str)] = &[
    ("wake.account_id", "SELECT"),
    ("wake.message_id", "SELECT"),
    ("wake.reason", "SELECT"),
    ("wake.inbox_id", "SELECT"),
    ("wake.state", "SELECT"),
    ("inbox.id", "SELECT"),
];

static READERS: AtomicBool = AtomicBool::new(false);

/// 나머지 읽는 곳도 켠다(프로세스에 한 번, `main.rs` 가 [`enable`] 뒤에 두 풀의 권한을 보고).
pub fn enable_readers() {
    READERS.store(true, Ordering::Relaxed);
}

/// 나머지 읽는 곳이 깨움 행을 보나.
pub fn readers() -> bool {
    READERS.load(Ordering::Relaxed)
}

/// 「안 읽은 inbox 줄」 조건(`marker`) 뒤에 「그 줄의 깨움이 열려 있다」를 붙인다 — 폴([`OPEN_WAKE_FILTER`])과 같은 줄만 남는다.
/// `id` 는 그 문장에서 inbox 줄의 id 를 가리키는 글자(`i.id`·`inbox.id`), `tag` 는 문장마다 다른 별칭이다.
/// `marker` 가 정확히 한 번 나오지 않으면 멈춘다 — 문장이 바뀌었는데 반만 옮겨진 것을 돌리지 않으려는 것이다.
pub fn with_open(sql: &str, marker: &str, id: &str, tag: &str) -> String {
    put_after(
        sql,
        marker,
        &format!(
            " and exists (select 1 from wake {tag} where {tag}.inbox_id = {id} and {tag}.state in ('pending', 'delivered'))"
        ),
    )
}

/// [`with_open`] 의 계정 종류를 가리지 않는 판 — 사람 계정의 줄은 그대로 둔다(사람은 깨움 행이 없다).
/// `account` 는 그 문장에서 inbox 줄의 계정을 가리키는 글자다.
pub fn with_open_for_agents(sql: &str, marker: &str, id: &str, account: &str, tag: &str) -> String {
    put_after(
        sql,
        marker,
        &format!(
            " and (exists (select 1 from wake {tag} where {tag}.inbox_id = {id} and {tag}.state in ('pending', 'delivered')) \
               or not exists (select 1 from account {tag}_k where {tag}_k.id = {account} and {tag}_k.kind = 'agent'))"
        ),
    )
}

fn put_after(sql: &str, marker: &str, extra: &str) -> String {
    let n = sql.matches(marker).count();
    assert!(n == 1, "wake_source: `{marker}` appears {n} times");
    sql.replacen(marker, &format!("{marker}{extra}"), 1)
}

/// 「이 계정이 이 글로 불렸나」를 읽는 문장이 `inbox` 대신 읽는 것 — inbox 줄과 깨움 행을 합친 것이다.
/// 지금은 두 표에 같은 줄이 있어 답이 같고, 에이전트 inbox 쓰기를 걷은 뒤(E3)에도 그 문장이 그대로 답한다.
/// 지운 inbox 줄의 닫힌(`canceled`) 깨움은 세지 않는다 — 그 줄은 inbox 에도 없다.
pub const EITHER: &str = "(select account_id, message_id, reason from inbox \
     union all select account_id, message_id, reason from wake where state <> 'canceled')";

/// 골든 `gate_awaiting` 에서 바꾸는 낱말.
pub const GATE_AWAITING_FROM: &str = "from inbox i\n";
/// 별칭 없이 읽는 문장(골든 `edit_inbox_already`·`ask` 의 「이미 불렸나」)에서 바꾸는 낱말.
pub const BARE_FROM: &str = "from inbox where ";
/// 골든 `thread_status_facts` 에서 바꾸는 낱말(두 번 나온다).
pub const FACTS_FROM: &str = "from inbox i join t ";

/// `sql` 의 `from` 낱말(예: `from inbox i `)을 [`EITHER`] 를 읽게 바꾼다 — `tail` 은 표 이름 뒤에 올 글자(별칭 포함, 예: ` i `)다.
/// 정확히 `times` 번 나와야 한다.
pub fn either(sql: &str, from: &str, tail: &str, times: usize) -> String {
    let n = sql.matches(from).count();
    assert!(
        n == times,
        "wake_source: `{from}` appears {n} times, expected {times}"
    );
    sql.replace(from, &format!("from {EITHER}{tail}"))
}

/// 나머지 읽는 곳이 켜져 있으면 [`with_open`], 아니면 그대로.
pub fn open_if_on(sql: &str, marker: &str, id: &str, tag: &str) -> String {
    if readers() {
        with_open(sql, marker, id, tag)
    } else {
        sql.to_owned()
    }
}

/// 나머지 읽는 곳이 켜져 있으면 [`either`], 아니면 그대로.
pub fn either_if_on(sql: &str, from: &str, tail: &str, times: usize) -> String {
    if readers() {
        either(sql, from, tail, times)
    } else {
        sql.to_owned()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn golden_fragments_move_to_both_tables() {
        let v: serde_json::Value =
            serde_json::from_str(include_str!("../../golden/sql_fragments.json")).unwrap();
        let g = |k: &str| v[k].as_str().unwrap().to_owned();
        let gate = either(&g("gate_awaiting"), GATE_AWAITING_FROM, " i\n", 1);
        assert!(gate.contains("where i.account_id = $1::uuid and i.message_id = $2::uuid"));
        let already = either(&g("edit_inbox_already"), BARE_FROM, " ei where ", 1);
        assert!(already.ends_with(") ei where message_id = $1::uuid"));
        let facts = either(&g("thread_status_facts"), FACTS_FROM, " i join t ", 2);
        // 사실 문장에 inbox 를 읽는 자리가 남지 않는다 — 합친 것 안의 한 번씩만이다.
        assert_eq!(facts.matches("from inbox").count(), 2);
        assert_eq!(
            facts.matches("from wake where state <> 'canceled'").count(),
            2
        );
    }

    #[test]
    fn switch_is_inbox_unless_wake() {
        assert!(!parse_switch(None));
        assert!(!parse_switch(Some("")));
        assert!(!parse_switch(Some("inbox")));
        assert!(!parse_switch(Some("on")));
        assert!(!parse_switch(Some("1")));
        assert!(parse_switch(Some("wake")));
        assert!(parse_switch(Some(" WAKE ")));
        // 프로세스 기본은 꺼짐이다(`enable` 을 부르는 곳은 `main.rs` 하나).
        assert!(!enabled());
    }

    #[test]
    fn only_agents_read_from_wake_rows() {
        assert!(pick(true, "agent"));
        assert!(!pick(true, "human"));
        assert!(!pick(false, "agent"));
        assert!(!for_kind("agent"));
    }

    #[test]
    fn filter_reads_open_rows_by_inbox_id_only() {
        assert!(OPEN_WAKE_FILTER.contains("w.inbox_id = i.id"));
        assert!(OPEN_WAKE_FILTER.contains("w.state in ('pending', 'delivered')"));
        // 근삿값인 작업 칸은 읽지 않는다.
        assert!(!OPEN_WAKE_FILTER.contains("work_id"));
        assert!(
            WAKE_SOURCE_PRIVILEGES
                .iter()
                .all(|(t, p)| t.starts_with("wake.") && *p == "SELECT")
        );
    }
    #[test]
    fn open_condition_goes_right_after_the_unread_marker() {
        let sql = "select 1 from inbox i where i.read_at is null order by i.id";
        let out = with_open(sql, "i.read_at is null", "i.id", "ow");
        assert!(out.contains(
            "i.read_at is null and exists (select 1 from wake ow where ow.inbox_id = i.id and ow.state in ('pending', 'delivered')) order by"
        ));
        let any = with_open_for_agents(sql, "i.read_at is null", "i.id", "i.account_id", "ow");
        assert!(any.contains("or not exists (select 1 from account ow_k where ow_k.id = i.account_id and ow_k.kind = 'agent'))"));
        assert!(!readers());
    }

    #[test]
    #[should_panic(expected = "appears 0 times")]
    fn open_condition_stops_when_the_marker_is_gone() {
        with_open("select 1", "i.read_at is null", "i.id", "ow");
    }

    #[test]
    fn either_reads_both_tables_and_skips_canceled_wakes() {
        let out = either(
            "select 1 from inbox i where i.account_id = $1",
            "from inbox i ",
            " i ",
            1,
        );
        assert!(
            out.starts_with("select 1 from (select account_id, message_id, reason from inbox ")
        );
        assert!(out.contains("from wake where state <> 'canceled') i where i.account_id = $1"));
        assert!(!EITHER.contains("work_id"));
    }

    #[test]
    #[should_panic(expected = "expected 2")]
    fn either_stops_when_the_count_is_off() {
        either(
            "select 1 from inbox i where true",
            "from inbox i ",
            " i ",
            2,
        );
    }
}
