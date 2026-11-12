use super::*;
use crate::turn_notice::GateAccountRank;

#[derive(Default)]
struct FakeIo {
    marks: u32,
    fails: Vec<GateFail>,
    /// `None` = 원장 없음(마지막 계정이 아님).
    ledger: Option<AttentionLedger>,
    reclaims: u32,
    can_watch: bool,
    arms: u32,
    attention: Vec<(String, GateRanks)>,
    logs: Vec<String>,
}

impl GateIo for FakeIo {
    fn mark_account_gate(&mut self) {
        self.marks += 1;
    }
    fn post_gate_fail(&mut self, fail: GateFail) {
        self.fails.push(fail);
    }
    fn ledger_claim(&mut self, account_label: &str, session_key: &str) -> Option<bool> {
        self.ledger
            .as_mut()
            .map(|l| l.claim(account_label, session_key))
    }
    fn reclaim(&mut self, end: &mut EndState) {
        if end.reclaim() {
            self.reclaims += 1;
        }
    }
    fn can_watch_gate(&self) -> bool {
        self.can_watch
    }
    fn arm_gate_watch(&mut self) {
        self.arms += 1;
    }
    fn needs_attention(&mut self, screen: &str, ranks: GateRanks) {
        self.attention.push((screen.to_owned(), ranks));
    }
    fn log(&mut self, line: &str) {
        self.logs.push(line.to_owned());
    }
}

fn ctx() -> CallHumanCtx {
    CallHumanCtx {
        account_label: "pool-a-acct1".into(),
        ranks: GateRanks {
            pool: Some(2),
            account: GateAccountRank::Rank(1),
        },
        mention_id: "m1".into(),
        session_key: "s1".into(),
    }
}

fn live() -> EndState {
    EndState {
        has_controls: true,
        ..EndState::default()
    }
}

#[test]
fn ledger_claims_once_per_account_and_releases() {
    let mut l = AttentionLedger::default();
    assert!(l.claim("a", "s1"));
    assert!(!l.claim("a", "s2"));
    assert_eq!(l.holder("a"), Some("s1"));
    assert!(l.claim("b", "s3"));
    l.release("a");
    assert!(l.claim("a", "s4"));
}

#[test]
fn gate_kind_notices_once_and_never_touches_ledger() {
    let mut io = FakeIo {
        ledger: Some(AttentionLedger::default()),
        can_watch: true,
        ..FakeIo::default()
    };
    let (mut end, mut gate) = (live(), GateState::default());
    call_human(
        &mut end,
        &mut gate,
        &ctx(),
        "확인?",
        AttentionKind::Gate,
        &mut io,
    );
    call_human(
        &mut end,
        &mut gate,
        &ctx(),
        "또 확인?",
        AttentionKind::Gate,
        &mut io,
    );
    assert!(end.awaiting_human);
    assert_eq!(io.marks, 0);
    assert_eq!(io.fails.len(), 1, "통지는 턴마다 한 번");
    let f = &io.fails[0];
    assert_eq!(f.code, None);
    assert_eq!(f.mention_id, None);
    assert_eq!(f.claude_account_rank, None);
    assert_eq!(gate.held, None);
    assert_eq!(io.arms, 0);
    assert_eq!(io.attention.len(), 2, "화면은 부를 때마다 앱으로");
    assert_eq!(io.ledger.as_ref().unwrap().holder("pool-a-acct1"), None);
}

#[test]
fn startup_claims_ledger_marks_and_arms_watch() {
    let mut io = FakeIo {
        ledger: Some(AttentionLedger::default()),
        can_watch: true,
        ..FakeIo::default()
    };
    let (mut end, mut gate) = (live(), GateState::default());
    call_human(
        &mut end,
        &mut gate,
        &ctx(),
        "온보딩",
        AttentionKind::Startup,
        &mut io,
    );
    assert_eq!(io.marks, 1);
    let f = &io.fails[0];
    assert_eq!(f.code, Some("account_gate"));
    assert_eq!(f.mention_id.as_deref(), Some("m1"));
    assert_eq!(
        (f.claude_pool_rank, f.claude_account_rank),
        (Some(2), Some(1))
    );
    assert_eq!(gate.held.as_deref(), Some("pool-a-acct1"));
    assert_eq!(io.arms, 1);
    assert_eq!(gate.requeue, None);
    assert_eq!(io.reclaims, 0);
    // 앱으로는 화면과 **순번**만 간다 — 원장 열쇠(계정 이름)는 싣지 않는다(칩 ③).
    assert_eq!(io.attention, vec![("온보딩".to_owned(), ctx().ranks)]);

    // 같은 턴이 다시 불러도 원장을 다시 잡지 않고 감시도 두 번 걸지 않는다.
    call_human(
        &mut end,
        &mut gate,
        &ctx(),
        "온보딩",
        AttentionKind::Startup,
        &mut io,
    );
    assert_eq!(io.arms, 1);
    assert_eq!(io.fails.len(), 1);
    assert_eq!(gate.requeue, None);
}

#[test]
fn startup_on_held_account_notices_then_folds_queued() {
    let mut ledger = AttentionLedger::default();
    assert!(ledger.claim("pool-a-acct1", "other"));
    let mut io = FakeIo {
        ledger: Some(ledger),
        can_watch: true,
        ..FakeIo::default()
    };
    let (mut end, mut gate) = (live(), GateState::default());
    call_human(
        &mut end,
        &mut gate,
        &ctx(),
        "온보딩",
        AttentionKind::Startup,
        &mut io,
    );
    // 스레드에 남기는 것은 원장보다 앞이다 — 접히는 턴도 통지는 남긴다.
    assert_eq!(io.fails.len(), 1);
    assert_eq!(gate.requeue, Some(GateRequeueKind::Queued));
    assert_eq!(io.reclaims, 1);
    assert!(end.reclaimed);
    assert_eq!(gate.held, None);
    assert_eq!(io.arms, 0);
    assert!(io.attention.is_empty(), "접는 PTY 는 앱에 열지 않는다");
}

#[test]
fn startup_without_ledger_skips_ledger_and_watch() {
    let mut io = FakeIo {
        can_watch: true,
        ..FakeIo::default()
    };
    let (mut end, mut gate) = (live(), GateState::default());
    call_human(
        &mut end,
        &mut gate,
        &ctx(),
        "x",
        AttentionKind::Startup,
        &mut io,
    );
    assert_eq!(io.marks, 1);
    assert_eq!(io.fails.len(), 1);
    assert_eq!(gate.held, None);
    assert_eq!(io.arms, 0);
    assert_eq!(io.attention.len(), 1);
}

#[test]
fn startup_without_gate_query_holds_but_no_watch() {
    let mut io = FakeIo {
        ledger: Some(AttentionLedger::default()),
        ..FakeIo::default()
    };
    let (mut end, mut gate) = (live(), GateState::default());
    call_human(
        &mut end,
        &mut gate,
        &ctx(),
        "x",
        AttentionKind::Startup,
        &mut io,
    );
    assert_eq!(gate.held.as_deref(), Some("pool-a-acct1"));
    assert!(!gate.watch_armed);
    assert_eq!(io.arms, 0);
}

#[test]
fn notice_has_ranks_not_label_or_screen() {
    let mut io = FakeIo::default();
    let (mut end, mut gate) = (live(), GateState::default());
    call_human(
        &mut end,
        &mut gate,
        &ctx(),
        "SECRET-SCREEN hrkp_abc",
        AttentionKind::Startup,
        &mut io,
    );
    let body = &io.fails[0].body;
    assert!(body.contains("풀 2 · 계정 1"));
    assert!(!body.contains("pool-a-acct1"));
    assert!(!body.contains("SECRET-SCREEN"));
}

#[test]
fn watch_tick_folds_passed_only_when_cleared_and_live() {
    let mut io = FakeIo::default();
    let mut gate = GateState {
        held: Some("pool-a-acct1".into()),
        watch_armed: true,
        ..GateState::default()
    };
    let mut end = live();
    assert!(!gate_watch_tick(&mut end, &mut gate, false, &mut io));
    assert_eq!(gate.requeue, None);
    assert!(gate_watch_tick(&mut end, &mut gate, true, &mut io));
    assert_eq!(gate.requeue, Some(GateRequeueKind::Passed));
    assert_eq!(io.reclaims, 1);
    // 이미 접기로 했으면 다시 접지 않는다.
    assert!(!gate_watch_tick(&mut end, &mut gate, true, &mut io));
    assert_eq!(io.reclaims, 1);
}

#[test]
fn watch_tick_ignores_spoken_or_exited_turn() {
    let mut io = FakeIo::default();
    let mut gate = GateState::default();
    let mut end = EndState {
        spoke: true,
        ..live()
    };
    assert!(!gate_due_and_tick(&mut end, &mut gate, &mut io));
    let mut end = EndState {
        exited: true,
        ..live()
    };
    assert!(!gate_due_and_tick(&mut end, &mut gate, &mut io));
    assert_eq!(gate.requeue, None);
    assert_eq!(io.reclaims, 0);
}

fn gate_due_and_tick(end: &mut EndState, gate: &mut GateState, io: &mut FakeIo) -> bool {
    assert!(!gate_watch_due(end, gate));
    gate_watch_tick(end, gate, true, io)
}

#[test]
fn settle_releases_once_and_disarms() {
    let mut gate = GateState {
        held: Some("a".into()),
        watch_armed: true,
        ..GateState::default()
    };
    assert_eq!(settle_gate(&mut gate).as_deref(), Some("a"));
    assert!(!gate.watch_armed);
    assert_eq!(settle_gate(&mut gate), None);
}

#[test]
fn debug_hides_account_label() {
    let mut l = AttentionLedger::default();
    l.claim("pool-a-acct1", "s");
    let gate = GateState {
        held: Some("pool-a-acct1".into()),
        ..GateState::default()
    };
    for s in [
        format!("{l:?}"),
        format!("{gate:?}"),
        format!("{:?}", ctx()),
    ] {
        assert!(!s.contains("pool-a-acct1"), "{s}");
    }
}
