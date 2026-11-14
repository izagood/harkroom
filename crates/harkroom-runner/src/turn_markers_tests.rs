use super::*;
use std::fs;
use std::sync::atomic::{AtomicU64, Ordering};

use crate::adapter::AgentHarness::{ClaudeCode, Codex};
use crate::adapter::MentionPermission::{Auto, Readonly};

fn tmp(tag: &str) -> PathBuf {
    static N: AtomicU64 = AtomicU64::new(0);
    let p = std::env::temp_dir().join(format!(
        "hk-markers-{tag}-{}-{}",
        std::process::id(),
        N.fetch_add(1, Ordering::Relaxed)
    ));
    let _ = fs::remove_dir_all(&p);
    fs::create_dir_all(&p).unwrap();
    fs::canonicalize(&p).unwrap()
}

fn ids() -> impl FnMut() -> String {
    let mut n = 0;
    move || {
        n += 1;
        format!("id{n}")
    }
}

#[test]
fn plan_follows_harness_tui_permission_and_lane() {
    let st = tmp("plan");
    let m = TurnMarkers::plan(&st, "k", ClaudeCode, true, Auto, false, &mut ids());
    assert_eq!(m.mcp_ready, Some(st.join("mcp-ready").join("id1")));
    assert_eq!(m.gate, Some(st.join("gate-signal").join("id2")));
    // 읽기 전용은 물음 hook 이 안 붙는다 — 준비 표식만.
    let m = TurnMarkers::plan(&st, "k", ClaudeCode, true, Readonly, false, &mut ids());
    assert!(m.mcp_ready.is_some() && m.gate.is_none());
    // API 키 연결 턴도 물음 hook 이 없다.
    let m = TurnMarkers::plan(&st, "k", ClaudeCode, true, Auto, true, &mut ids());
    assert!(m.gate.is_none());
    // TUI 가 아니면 둘 다 없다. codex 는 브릿지를 기다리지 않는다.
    let m = TurnMarkers::plan(&st, "k", ClaudeCode, false, Auto, false, &mut ids());
    assert!(m.mcp_ready.is_none() && m.gate.is_none());
    let m = TurnMarkers::plan(&st, "k", Codex, true, Auto, false, &mut ids());
    assert!(m.mcp_ready.is_none() && m.gate.is_none());
}

#[test]
fn plan_without_private_dir_runs_without_markers() {
    // 상태 폴더 자리가 파일이면 표식 폴더를 못 만든다 → 표식 없이(기다리지 않고 화면으로 잰다).
    let st = tmp("nodir");
    let file = st.join("state");
    fs::write(&file, "x").unwrap();
    let m = TurnMarkers::plan(&file, "k", ClaudeCode, true, Auto, false, &mut ids());
    assert!(m.mcp_ready.is_none() && m.gate.is_none());
}

#[test]
fn apply_sets_wait_for_and_gate_signal_only_when_planted() {
    let mut i = InjectPrompt::default();
    TurnMarkers::default().apply(Some(&mut i));
    assert!(i.wait_for.is_none() && !i.gate_signal);
    let m = TurnMarkers {
        mcp_ready: Some(PathBuf::from("/nonexistent/m")),
        gate: Some(PathBuf::from("/nonexistent/g")),
    };
    m.apply(Some(&mut i));
    let w = i.wait_for.clone().expect("기다릴 것");
    assert_eq!((w.max_ms, w.poll_ms), (MCP_READY_MAX_MS, MCP_READY_POLL_MS));
    assert!(i.gate_signal);
    m.apply(None); // 주입 없는 턴은 그대로.
}

#[derive(Default)]
struct Inner {
    settled: Option<(bool, u64)>,
}
impl PromptHooks for Inner {
    fn wait_for_ready(&mut self) -> bool {
        true
    }
    fn wait_for_settled(&mut self, ready: bool, waited_ms: u64) {
        self.settled = Some((ready, waited_ms));
    }
    fn gate_signal(&mut self) -> u64 {
        99
    }
}
impl PtyTurnSink for Inner {}

#[test]
fn sink_answers_from_files_and_files_go_away_on_drop() {
    let st = tmp("sink");
    let m = TurnMarkers::plan(&st, "k", ClaudeCode, true, Auto, false, &mut ids());
    let (ready, gate) = (m.mcp_ready.clone().unwrap(), m.gate.clone().unwrap());
    let mut inner = Inner::default();
    {
        let mut s = MarkerSink {
            inner: &mut inner,
            markers: &m,
            key: "k",
            confirm: None,
            human: None,
        };
        // 브릿지가 표식을 만들기 전에는 안 섰다.
        assert!(!s.wait_for_ready());
        fs::write(&ready, "").unwrap();
        assert!(s.wait_for_ready());
        // 신호 파일: 없으면 0, 유효한 줄만 센다.
        assert_eq!(s.gate_signal(), 0);
        fs::write(&gate, "1700000000000\nnope\n1700000000500\n").unwrap();
        assert_eq!(s.gate_signal(), 2);
        s.wait_for_settled(true, 42);
    }
    assert_eq!(inner.settled, Some((true, 42)), "안쪽 알림도 그대로 간다");
    assert_eq!(
        m.gate_snapshot(),
        Some(GateSignal {
            count: 2,
            last_at_ms: Some(1_700_000_000_500)
        })
    );
    drop(m);
    assert!(!ready.exists() && !gate.exists(), "시도가 끝나면 지운다");
}

#[test]
fn sink_without_markers_defers_to_inner() {
    let m = TurnMarkers::default();
    let mut inner = Inner::default();
    let mut s = MarkerSink {
        inner: &mut inner,
        markers: &m,
        key: "k",
        confirm: None,
        human: None,
    };
    assert!(s.wait_for_ready());
    assert_eq!(s.gate_signal(), 99);
    assert_eq!(m.gate_snapshot(), None);
}

/// T4d: 주입 확인 증거는 `confirm` 이 답한다(정본 `confirmDelivery.probe`) — 없으면 안쪽으로 넘긴다.
#[test]
fn sink_confirm_probe_uses_given_evidence() {
    let m = TurnMarkers::default();
    let mut inner = Inner::default();
    let no = || false;
    let mut s = MarkerSink {
        inner: &mut inner,
        markers: &m,
        key: "k",
        confirm: Some(&no),
        human: None,
    };
    assert!(!s.confirm_probe(), "증거가 없으면 거짓");
    let yes = || true;
    s.confirm = Some(&yes);
    assert!(s.confirm_probe());
}

/// T4e: 사람 부르기는 `human` 이 받는다(정본 `onAttention: callHuman`).
#[test]
fn sink_attention_calls_human() {
    let m = TurnMarkers::default();
    let mut inner = Inner::default();
    let seen = std::cell::RefCell::new(Vec::<(String, AttentionKind)>::new());
    let human = |s: &str, k: AttentionKind| seen.borrow_mut().push((s.to_owned(), k));
    let mut s = MarkerSink {
        inner: &mut inner,
        markers: &m,
        key: "k",
        confirm: None,
        human: Some(&human),
    };
    s.on_attention("SCREEN", AttentionKind::Gate);
    assert_eq!(
        seen.borrow().as_slice(),
        &[("SCREEN".to_string(), AttentionKind::Gate)]
    );
}
