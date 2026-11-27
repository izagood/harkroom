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

#[cfg(test)]
mod tests {
    use super::*;

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
}
