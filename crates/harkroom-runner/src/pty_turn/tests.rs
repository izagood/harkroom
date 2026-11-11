//! 가짜 시계로 정본 `runPtyTurn` 주입 절의 시각 순서를 밟는다. 정본 시험(`pty.test.ts`·`pty.inject*.test.ts`)이 실제
//! 타이머로 재던 것을 ms 단위로 손으로 돌린다.

use super::*;

const READY: &[u8] = "❯\u{a0}".as_bytes();
const GATE: &[u8] = b"Do you want to proceed?\r\n";

#[derive(Default)]
struct Hooks {
    wait_ready: bool,
    settled: Option<(bool, u64)>,
    signals: u64,
    confirmed: bool,
}

impl PromptHooks for Hooks {
    fn wait_for_ready(&mut self) -> bool {
        self.wait_ready
    }
    fn wait_for_settled(&mut self, ready: bool, waited_ms: u64) {
        self.settled = Some((ready, waited_ms));
    }
    fn gate_signal(&mut self) -> u64 {
        self.signals
    }
    fn confirm_probe(&mut self) -> bool {
        self.confirmed
    }
}

fn opts(text: &str) -> InjectPrompt {
    InjectPrompt {
        text: text.into(),
        ..InjectPrompt::default()
    }
}

/// `from..=to` 를 1ms 씩 돌며 낸 할 일을 (시각, 할 일)로 모은다.
fn run(m: &mut PromptInjector, h: &mut Hooks, from: u64, to: u64) -> Vec<(u64, Action)> {
    let mut out = Vec::new();
    for t in from..=to {
        out.extend(m.on_tick(t, h).into_iter().map(|a| (t, a)));
    }
    out
}

fn writes(acts: &[(u64, Action)]) -> Vec<(u64, String)> {
    acts.iter()
        .filter_map(|(t, a)| match a {
            Action::Write(b) => Some((*t, String::from_utf8_lossy(b).into_owned())),
            _ => None,
        })
        .collect()
}

#[test]
fn injects_after_ready_quiet_then_submits_after_paste_settles() {
    let mut m = PromptInjector::new(opts("hi\nthere"));
    let mut h = Hooks::default();
    assert!(m.on_data(100, READY, &mut h).is_empty());
    // 정적 300ms 전에는 넣지 않는다.
    assert!(run(&mut m, &mut h, 101, 399).is_empty());
    let acts = run(&mut m, &mut h, 400, 400);
    assert_eq!(acts[0].1, Action::Injected);
    assert_eq!(
        writes(&acts),
        vec![(400, "\u{1b}[200~hi\nthere\u{1b}[201~".to_string())]
    );
    // submitMinMs 300 뒤, 화면이 조용하면 Enter. 25ms 주기라 첫 검사 시각은 700 이상.
    let acts = run(&mut m, &mut h, 401, 800);
    let w = writes(&acts);
    assert_eq!(w.len(), 1);
    assert_eq!(w[0].1, "\r");
    assert!((700..=725).contains(&w[0].0), "submitted at {}", w[0].0);
    assert!(m.submitted());
}

#[test]
fn redraw_resets_quiet_and_quiet_max_forces_inject() {
    let mut o = opts("x");
    o.ready_quiet_max_ms = 1_000;
    let mut m = PromptInjector::new(o);
    let mut h = Hooks::default();
    // 쉬지 않고 그린다 — 정적이 오지 않는다.
    let mut injected_at = None;
    for t in (100..=2_000).step_by(100) {
        let a = m.on_data(t, READY, &mut h);
        if a.contains(&Action::Injected) {
            injected_at = Some(t);
            break;
        }
        assert!(run(&mut m, &mut h, t + 1, t + 99).is_empty());
    }
    // 처음 본 100 + 상한 1,000.
    assert_eq!(injected_at, Some(1_100));
}

#[test]
fn ready_min_ms_holds_injection_until_floor() {
    let mut o = opts("x");
    o.ready_min_ms = 1_000;
    let mut m = PromptInjector::new(o);
    let mut h = Hooks::default();
    m.on_data(10, READY, &mut h);
    assert!(run(&mut m, &mut h, 11, 999).is_empty());
    assert_eq!(run(&mut m, &mut h, 1_000, 1_000)[0].1, Action::Injected);
}

#[test]
fn wait_for_polls_then_injects_and_reports_settled() {
    let mut o = opts("x");
    o.wait_for = Some(WaitFor {
        max_ms: 5_000,
        poll_ms: 100,
    });
    let mut m = PromptInjector::new(o);
    let mut h = Hooks::default();
    m.on_data(0, READY, &mut h);
    assert!(run(&mut m, &mut h, 1, 600).is_empty());
    h.wait_ready = true;
    let acts = run(&mut m, &mut h, 601, 700);
    assert_eq!(acts[0], (700, Action::Injected));
    assert_eq!(h.settled, Some((true, 700)));
}

#[test]
fn wait_for_gives_up_at_max_and_injects_anyway() {
    let mut o = opts("x");
    o.wait_for = Some(WaitFor {
        max_ms: 1_000,
        poll_ms: 300,
    });
    let mut m = PromptInjector::new(o);
    let mut h = Hooks::default();
    m.on_data(0, READY, &mut h);
    let acts = run(&mut m, &mut h, 1, 1_000);
    assert_eq!(acts[0], (1_000, Action::Injected));
    assert_eq!(h.settled, Some((false, 1_000)));
}

#[test]
fn gate_over_ready_defers_injection_and_calls_once() {
    let mut o = opts("x");
    o.attention = true;
    let mut m = PromptInjector::new(o);
    let mut h = Hooks::default();
    m.on_data(0, READY, &mut h);
    // 모달이 입력창을 덮었다(2026-09-11 실측).
    m.on_data(100, GATE, &mut h);
    let acts = run(&mut m, &mut h, 101, 2_000);
    // 넣지 않았고, 사람을 한 번만 불렀다.
    assert!(writes(&acts).is_empty());
    let calls: Vec<_> = acts
        .iter()
        .filter(|(_, a)| matches!(a, Action::Attention(_, AttentionKind::Startup)))
        .collect();
    assert_eq!(calls.len(), 1);
    // 사람이 지나 입력창이 다시 그려지면 넣는다.
    // 준비를 처음 본 것이 0 이라 정적 상한(2,000)을 이미 넘었다 — 이 바이트에서 곧바로 넣는다(정본과 같다).
    let acts = m.on_data(2_100, READY, &mut h);
    assert_eq!(acts[0], Action::Injected);
}

#[test]
fn ready_timeout_without_attention_fails_timeout() {
    let mut o = opts("x");
    o.ready_timeout_ms = 1_000;
    o.waiting_quiet_ms = 10_000; // 선택 대기 판정이 먼저 오지 않게
    let mut m = PromptInjector::new(o);
    let mut h = Hooks::default();
    let acts = run(&mut m, &mut h, 0, 1_000);
    match &acts[..] {
        [(1_000, Action::Fail(e))] => {
            assert_eq!(e.kind, NotDeliveredKind::Timeout);
            assert_eq!(e.waited_ms, 1_000);
        }
        other => panic!("{other:?}"),
    }
    // 접은 뒤엔 아무것도 내지 않는다.
    assert!(run(&mut m, &mut h, 1_001, 5_000).is_empty());
    assert_eq!(m.next_deadline(), None);
}

#[test]
fn ready_timeout_with_attention_calls_and_keeps_waiting() {
    let mut o = opts("x");
    o.attention = true;
    o.ready_timeout_ms = 1_000;
    let mut m = PromptInjector::new(o);
    let mut h = Hooks::default();
    let acts = run(&mut m, &mut h, 0, 3_000);
    assert_eq!(acts.len(), 1);
    assert!(matches!(
        acts[0],
        (1_000, Action::Attention(_, AttentionKind::Startup))
    ));
    // 사람이 지나면 이어진다.
    m.on_data(3_100, READY, &mut h);
    assert!(
        run(&mut m, &mut h, 3_101, 3_400)
            .iter()
            .any(|(_, a)| *a == Action::Injected)
    );
}

#[test]
fn ready_timeout_after_ready_seen_is_not_ours_unless_gate_blocked() {
    let mut o = opts("x");
    o.ready_timeout_ms = 200;
    o.ready_quiet_ms = 500;
    let mut m = PromptInjector::new(o);
    let mut h = Hooks::default();
    m.on_data(100, READY, &mut h);
    // 상한(200)이 지나도 정적 대기(600)가 주입으로 끝낸다.
    let acts = run(&mut m, &mut h, 101, 600);
    assert_eq!(acts[0], (600, Action::Injected));
}

#[test]
fn quiet_non_ready_screen_fails_waiting() {
    let mut m = PromptInjector::new(opts("x"));
    let mut h = Hooks::default();
    // 입력창이 아닌 화면(선택 목록)을 그리고 조용해졌다.
    m.on_data(100, b"Select a theme\r\n 1. dark\r\n", &mut h);
    let acts = run(&mut m, &mut h, 101, 4_000);
    match &acts[..] {
        [(t, Action::Fail(e))] => {
            assert_eq!(e.kind, NotDeliveredKind::Waiting);
            assert!((3_100..=3_250).contains(t), "{t}");
        }
        other => panic!("{other:?}"),
    }
}

#[test]
fn pasting_indicator_holds_enter_until_pasting_cap() {
    let mut m = PromptInjector::new(opts("x"));
    let mut h = Hooks::default();
    m.on_data(0, READY, &mut h);
    run(&mut m, &mut h, 1, 300); // 300 에 주입
    m.on_data(320, b"\x1b[2KPasting\xe2\x80\xa6 ", &mut h);
    let acts = run(&mut m, &mut h, 301, 5_400);
    let w = writes(&acts);
    assert_eq!(w.len(), 1);
    // 받아 들이는 중 표시가 마지막이면 submitPastingMaxMs(5,000) 까지 미룬다.
    assert!((5_300..=5_325).contains(&w[0].0), "{}", w[0].0);
}

#[test]
fn chip_drawn_after_pasting_releases_enter() {
    let mut m = PromptInjector::new(opts("x"));
    let mut h = Hooks::default();
    m.on_data(0, READY, &mut h);
    run(&mut m, &mut h, 1, 300);
    m.on_data(320, "Pasting…".as_bytes(), &mut h);
    let mut w = writes(&run(&mut m, &mut h, 301, 899));
    assert!(w.is_empty());
    m.on_data(900, b"[Pasted text #1 +62 lines]", &mut h);
    w.extend(writes(&run(&mut m, &mut h, 900, 2_000)));
    assert_eq!(w.len(), 1);
    assert!((1_050..=1_075).contains(&w[0].0), "{}", w[0].0);
}

#[test]
fn unsent_hint_renudges_until_gone_and_never_repastes() {
    let mut o = opts("x");
    o.unsent_hint = Some(Regex::new("Press enter to send").unwrap());
    o.unsent_probe_ms = 1_000;
    o.unsent_retries = 3;
    let mut m = PromptInjector::new(o);
    let mut h = Hooks::default();
    m.on_data(0, READY, &mut h);
    run(&mut m, &mut h, 1, 300);
    m.on_data(310, b"Press enter to send", &mut h);
    let w = writes(&run(&mut m, &mut h, 301, 2_500));
    // 첫 Enter(~610) + 1,300 의 재시도 한 번 + 2,300 의 재시도 한 번.
    assert_eq!(w.iter().filter(|(_, s)| s == "\r").count(), 3);
    assert!(w.iter().all(|(_, s)| s == "\r"));
    m.on_data(2_400, b"\x1b[2J working", &mut h);
    // 힌트가 화면에서 사라지면(링 버퍼가 밀어낼 만큼 새 화면) 멈춘다.
    m.on_data(2_401, &[b' '; 2048], &mut h);
    assert!(writes(&run(&mut m, &mut h, 2_501, 6_000)).is_empty());
}

#[test]
fn turn_gate_calls_once_per_gate_after_two_probes() {
    let mut o = opts("x");
    o.attention = true;
    o.gate_probe_ms = 1_000;
    let mut m = PromptInjector::new(o);
    let mut h = Hooks {
        confirmed: true,
        ..Hooks::default()
    };
    m.on_data(0, READY, &mut h);
    run(&mut m, &mut h, 1, 700);
    m.on_data(800, GATE, &mut h);
    let acts = run(&mut m, &mut h, 701, 5_000);
    let gates: Vec<_> = acts
        .iter()
        .filter(|(_, a)| matches!(a, Action::Attention(_, AttentionKind::Gate)))
        .map(|(t, _)| *t)
        .collect();
    // 1,300 에 처음 보고, 2,300 에 부른다. 그 뒤로는 같은 관문을 다시 부르지 않는다.
    assert_eq!(gates, vec![2_300]);
}

#[test]
fn own_turn_gate_and_signal_mode() {
    let mut o = opts("x");
    o.turn_gate = true;
    o.gate_signal = true;
    o.gate_probe_ms = 500;
    let mut m = PromptInjector::new(o);
    let mut h = Hooks::default();
    m.on_data(0, READY, &mut h);
    run(&mut m, &mut h, 1, 400);
    h.signals = 2;
    let acts = run(&mut m, &mut h, 401, 2_000);
    let gates: Vec<_> = acts
        .iter()
        .filter(|(_, a)| matches!(a, Action::TurnGate(_)))
        .collect();
    assert_eq!(gates.len(), 1);
}

#[test]
fn confirm_resends_newline_then_calls_after_grace() {
    let mut o = opts("x");
    o.attention = true;
    o.confirm = Some(ConfirmDelivery {
        within_ms: 3_000,
        resend_grace_ms: None,
    });
    let mut m = PromptInjector::new(o);
    let mut h = Hooks::default();
    m.on_data(0, READY, &mut h);
    run(&mut m, &mut h, 1, 300);
    let acts = run(&mut m, &mut h, 301, 5_000);
    let w = writes(&acts);
    // 제출 Enter + 3,300 의 재전송 Enter. 본문은 다시 보내지 않는다.
    assert_eq!(w.len(), 2);
    assert_eq!(w[1], (3_300, "\r".to_string()));
    let calls: Vec<_> = acts
        .iter()
        .filter(|(_, a)| matches!(a, Action::Attention(_, AttentionKind::Startup)))
        .map(|(t, _)| *t)
        .collect();
    // 유예 기본값 round(3000/3)=1,000.
    assert_eq!(calls, vec![4_300]);
}

#[test]
fn confirm_resend_runs_even_without_attention_but_does_not_call() {
    let mut o = opts("x");
    o.confirm = Some(ConfirmDelivery {
        within_ms: 1_000,
        resend_grace_ms: Some(100),
    });
    let mut m = PromptInjector::new(o);
    let mut h = Hooks::default();
    m.on_data(0, READY, &mut h);
    run(&mut m, &mut h, 1, 300);
    let acts = run(&mut m, &mut h, 301, 3_000);
    assert_eq!(writes(&acts).len(), 2);
    assert!(!acts.iter().any(|(_, a)| matches!(a, Action::Attention(..))));
}

#[test]
fn confirmed_delivery_is_silent() {
    let mut o = opts("x");
    o.attention = true;
    o.confirm = Some(ConfirmDelivery {
        within_ms: 1_000,
        resend_grace_ms: None,
    });
    let mut m = PromptInjector::new(o);
    let mut h = Hooks {
        confirmed: true,
        ..Hooks::default()
    };
    m.on_data(0, READY, &mut h);
    run(&mut m, &mut h, 1, 300);
    assert_eq!(writes(&run(&mut m, &mut h, 301, 5_000)).len(), 1);
}

#[test]
fn settle_stops_everything() {
    let mut m = PromptInjector::new(opts("x"));
    let mut h = Hooks::default();
    m.on_data(0, READY, &mut h);
    run(&mut m, &mut h, 1, 300);
    m.settle();
    assert!(run(&mut m, &mut h, 301, 5_000).is_empty());
    assert_eq!(m.next_deadline(), None);
}

#[test]
fn paste_is_sanitized() {
    let mut m = PromptInjector::new(opts("a\u{1b}[201~b"));
    let mut h = Hooks::default();
    m.on_data(0, READY, &mut h);
    let w = writes(&run(&mut m, &mut h, 1, 300));
    // 끝 표식이 본문 안에 남아 붙여넣기를 일찍 닫지 않는다.
    assert_eq!(w[0].1.matches("\u{1b}[201~").count(), 1);
}

#[test]
fn next_deadline_tracks_earliest_timer() {
    let mut m = PromptInjector::new(opts("x"));
    let mut h = Hooks::default();
    // 처음엔 선택 대기 주기(min(250, 3000/4)=250)가 가장 이르다.
    assert_eq!(m.next_deadline(), Some(250));
    m.on_data(10, READY, &mut h);
    assert_eq!(m.next_deadline(), Some(250));
    m.on_tick(250, &mut h);
    assert_eq!(m.next_deadline(), Some(310));
}

// ── PTY 루프: 진짜 PTY 에 /bin/sh 로 만든 가짜 TUI 를 띄운다. ──

#[derive(Default)]
struct Sink {
    out: Vec<u8>,
    injected: bool,
    spawned: Option<super::PtyControls>,
}

impl PromptHooks for Sink {}

impl PtyTurnSink for Sink {
    fn on_spawn(&mut self, controls: super::PtyControls) {
        self.spawned = Some(controls);
    }
    fn on_output(&mut self, frame: &[u8]) {
        self.out.extend_from_slice(frame);
    }
    fn on_injected(&mut self) {
        self.injected = true;
    }
}

fn sh(script: &str) -> PtyPlan {
    PtyPlan {
        command: "sh".into(),
        args: vec!["-c".into(), script.into()],
        env: vec![
            ("PATH".into(), "/usr/bin:/bin".into()),
            ("TERM".into(), "xterm-256color".into()),
        ],
        stdin_file: None,
    }
}

#[test]
fn loop_injects_into_fake_tui_and_returns_last_frame() {
    // 입력창을 그리고 한 줄을 받아 되돌려 쓴 뒤 끝나는 TUI.
    let plan =
        sh(r#"printf '\342\235\257\302\240'; IFS= read -r line; printf 'GOT[%s]DONE' "$line""#);
    let mut o = opts("hello world");
    o.ready_quiet_ms = 50;
    o.submit_min_ms = 50;
    let mut sink = Sink::default();
    let r = run_pty_turn(
        &plan,
        PtyTurnOptions {
            timeout_ms: 10_000,
            inject: Some(o),
            ..PtyTurnOptions::default()
        },
        &mut sink,
    )
    .expect("turn");
    assert!(sink.injected);
    assert!(sink.spawned.is_some());
    assert_eq!(r.exit_code, 0);
    assert!(!r.timed_out);
    assert!(r.tail.contains("hello world"), "{:?}", r.tail);
    assert!(r.tail.contains("DONE"), "{:?}", r.tail);
    // 합친 출력도 마지막 프레임까지 받았다.
    assert!(String::from_utf8_lossy(&sink.out).contains("DONE"));
}

#[test]
fn loop_timeout_terminates_and_reports_timed_out() {
    let plan = sh("trap '' TERM; printf up; sleep 30");
    let mut sink = Sink::default();
    let t = std::time::Instant::now();
    let r = run_pty_turn(
        &plan,
        PtyTurnOptions {
            timeout_ms: 300,
            kill_grace_ms: 300,
            ..PtyTurnOptions::default()
        },
        &mut sink,
    )
    .expect("turn");
    assert!(r.timed_out);
    assert!(t.elapsed() < std::time::Duration::from_secs(5));
    assert!(r.tail.contains("up"));
}

#[test]
fn loop_fails_undelivered_when_ready_never_shows() {
    let plan = sh("printf 'booting'; sleep 30");
    let mut o = opts("x");
    o.ready_timeout_ms = 300;
    o.waiting_quiet_ms = 10_000;
    let mut sink = Sink::default();
    let t = std::time::Instant::now();
    match run_pty_turn(
        &plan,
        PtyTurnOptions {
            inject: Some(o),
            ..PtyTurnOptions::default()
        },
        &mut sink,
    ) {
        Err(super::PtyTurnError::NotDelivered(e)) => {
            assert_eq!(e.kind, NotDeliveredKind::Timeout);
            assert!(e.tail.contains("booting"));
        }
        other => panic!("{other:?}"),
    }
    assert!(!sink.injected);
    assert!(t.elapsed() < std::time::Duration::from_secs(5));
}

#[test]
fn loop_missing_harness_is_not_found() {
    let mut plan = sh("true");
    plan.command = "harkroom-no-such-harness".into();
    let mut sink = Sink::default();
    assert!(matches!(
        run_pty_turn(&plan, PtyTurnOptions::default(), &mut sink),
        Err(super::PtyTurnError::NotFound(_))
    ));
    assert!(sink.spawned.is_none());
}
