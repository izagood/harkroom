use super::*;

#[derive(Default)]
struct Fake {
    calls: Vec<String>,
    register_err: Option<String>,
    reaction_err: Option<String>,
}

impl Fake {
    fn hit(&mut self, name: &str) {
        self.calls.push(name.to_owned());
    }
    fn count(&self, name: &str) -> usize {
        self.calls.iter().filter(|c| *c == name).count()
    }
    fn pos(&self, name: &str) -> usize {
        self.calls
            .iter()
            .position(|c| c == name)
            .unwrap_or_else(|| panic!("{name} 를 부르지 않았다: {:?}", self.calls))
    }
}

impl LifeIo for Fake {
    fn registry_register(&mut self) -> Result<(), String> {
        self.hit("register");
        match self.register_err.clone() {
            Some(e) => Err(e),
            None => Ok(()),
        }
    }
    fn registry_release(&mut self) {
        self.hit("registry_release");
    }
    fn listen_fence(&mut self) {
        self.hit("listen_fence");
    }
    fn unlisten_fence(&mut self) {
        self.hit("unlisten_fence");
    }
    fn reclaim(&mut self, end: &mut EndState) {
        self.hit("reclaim");
        end.reclaimed = true;
    }
    fn cancel_probe(&mut self) {
        self.hit("cancel_probe");
    }
    fn cancel_reclaim(&mut self) {
        self.hit("cancel_reclaim");
    }
    fn cancel_silence(&mut self) {
        self.hit("cancel_silence");
    }
    fn cancel_gate_watch(&mut self) {
        self.hit("cancel_gate_watch");
    }
    fn ledger_release(&mut self, account_label: &str) {
        self.hit(&format!("ledger_release:{account_label}"));
    }
    fn provider_env_done(&mut self) {
        self.hit("provider_env_done");
    }
    fn close_session(&mut self) {
        self.hit("close_session");
    }
    fn await_working(&mut self) {
        self.hit("await_working");
    }
    fn remove_working_reaction(&mut self) -> Result<(), String> {
        self.hit("remove_reaction");
        match self.reaction_err.clone() {
            Some(e) => Err(e),
            None => Ok(()),
        }
    }
    fn log(&mut self, line: &str) {
        self.hit(&format!("log:{line}"));
    }
}

fn parts() -> (TurnLife, EndState, GateState, Fake) {
    (
        TurnLife::default(),
        EndState::default(),
        GateState::default(),
        Fake::default(),
    )
}

#[test]
fn settle_turns_timers_off_first_then_releases_then_reaction_last() {
    let (mut life, mut end, mut gate, mut io) = parts();
    register_turn(&mut life, &mut end, &mut gate, &mut io).unwrap();
    watch_fence(&mut life, false, &mut io);
    gate.watch_armed = true;
    gate.held = Some("acct-a".into());
    end.reclaim_armed = true;

    settle_turn(&mut life, &mut end, &mut gate, &mut io);

    assert!(end.exited);
    assert!(!end.reclaim_armed);
    assert!(!gate.watch_armed);
    assert_eq!(gate.held, None);
    assert!(!life.registered && !life.fence_listening && life.settled);
    // 타이머 → 원장 → 등록 → 세션 → 💬(추가가 끝난 뒤).
    let order = [
        "unlisten_fence",
        "cancel_probe",
        "cancel_reclaim",
        "cancel_silence",
        "cancel_gate_watch",
        "ledger_release:acct-a",
        "registry_release",
        "provider_env_done",
        "close_session",
        "await_working",
        "remove_reaction",
    ];
    let pos: Vec<usize> = order.iter().map(|n| io.pos(n)).collect();
    assert!(pos.windows(2).all(|w| w[0] < w[1]), "{:?}", io.calls);
}

#[test]
fn settle_twice_is_noop() {
    let (mut life, mut end, mut gate, mut io) = parts();
    register_turn(&mut life, &mut end, &mut gate, &mut io).unwrap();
    settle_turn(&mut life, &mut end, &mut gate, &mut io);
    settle_turn(&mut life, &mut end, &mut gate, &mut io);
    assert_eq!(io.count("registry_release"), 1);
    assert_eq!(io.count("close_session"), 1);
    assert_eq!(io.count("remove_reaction"), 1);
}

#[test]
fn register_rejected_settles_without_releasing_others_registration() {
    let (mut life, mut end, mut gate, mut io) = parts();
    io.register_err = Some("이미 인터랙티브 턴".into());
    let err = register_turn(&mut life, &mut end, &mut gate, &mut io).unwrap_err();
    assert_eq!(err, "이미 인터랙티브 턴");
    assert!(life.settled && end.exited);
    // 그 자리는 먼저 온 턴의 것이다 — 지우지 않는다. 세션·💬 는 정리한다(유령 「running」 줄 방지).
    assert_eq!(io.count("registry_release"), 0);
    assert_eq!(io.count("close_session"), 1);
    assert_eq!(io.count("remove_reaction"), 1);
}

#[test]
fn settle_without_gate_hold_or_watch_skips_those() {
    let (mut life, mut end, mut gate, mut io) = parts();
    settle_turn(&mut life, &mut end, &mut gate, &mut io);
    assert_eq!(io.count("cancel_gate_watch"), 0);
    assert!(!io.calls.iter().any(|c| c.starts_with("ledger_release")));
    assert_eq!(io.count("unlisten_fence"), 0);
    assert_eq!(io.count("registry_release"), 0);
}

#[test]
fn reaction_failure_is_logged_not_raised() {
    let (mut life, mut end, mut gate, mut io) = parts();
    io.reaction_err = Some("503".into());
    settle_turn(&mut life, &mut end, &mut gate, &mut io);
    assert_eq!(io.count("log:리액션(진행 중) 제거 실패 — 503"), 1);
}

#[test]
fn fence_already_lost_marks_without_listening() {
    let (mut life, _end, _gate, mut io) = parts();
    watch_fence(&mut life, true, &mut io);
    assert!(life.fenced_out);
    assert!(!life.fence_listening);
    assert_eq!(io.count("listen_fence"), 0);
}

#[test]
fn fence_lost_reclaims_like_cancel_until_settled() {
    let (mut life, mut end, mut gate, mut io) = parts();
    watch_fence(&mut life, false, &mut io);
    on_fence_lost(&mut life, &mut end, &mut io);
    assert!(life.fenced_out && end.reclaimed);
    assert_eq!(io.count("reclaim"), 1);

    settle_turn(&mut life, &mut end, &mut gate, &mut io);
    on_fence_lost(&mut life, &mut end, &mut io);
    assert_eq!(
        io.count("reclaim"),
        1,
        "끝난 턴의 펜스는 다음 턴을 접지 않는다"
    );
}
