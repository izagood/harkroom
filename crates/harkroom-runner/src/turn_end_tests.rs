use super::*;

fn cfg() -> EndConfig {
    EndConfig::new(30 * 60_000)
}

fn live() -> EndState {
    EndState {
        has_controls: true,
        ..EndState::default()
    }
}

#[test]
fn reclaim_needs_controls_and_not_exited() {
    let mut e = EndState::default();
    assert!(!e.reclaim());
    assert!(!e.reclaimed);
    let mut e = live();
    e.exited = true;
    assert!(!e.reclaim());
    let mut e = live();
    assert!(e.reclaim());
    assert!(e.reclaimed);
}

#[test]
fn turn_is_done_when_finished_or_spoke_without_tail() {
    let mut e = live();
    assert!(!e.turn_is_done());
    e.spoke = true;
    assert!(e.turn_is_done());
    e.tail = Some(Tail::Working);
    assert!(!e.turn_is_done());
    e.finished = true;
    assert!(e.turn_is_done());
}

#[test]
fn not_done_or_viewed_disarms() {
    let mut e = live();
    e.reclaim_armed = true;
    assert_eq!(reconsider_end(&mut e, 1, &cfg()), EndAction::Disarm);
    assert!(!e.reclaim_armed);
    e.finished = true;
    e.viewers = 1;
    e.reclaim_armed = true;
    assert_eq!(reconsider_end(&mut e, 1, &cfg()), EndAction::Disarm);
    assert!(!e.reclaimed);
}

#[test]
fn exited_keeps() {
    let mut e = live();
    e.finished = true;
    e.exited = true;
    assert_eq!(reconsider_end(&mut e, 1, &cfg()), EndAction::Keep);
}

#[test]
fn finished_with_zero_children_reclaims_at_once() {
    let mut e = live();
    e.finished = true;
    e.pending = Some(0);
    assert_eq!(
        reconsider_end(&mut e, 1, &cfg()),
        EndAction::ReclaimNow { kill: true }
    );
    assert!(e.reclaimed);
}

#[test]
fn unknown_children_wait_orphan_grace_and_only_shorten() {
    let mut e = live();
    e.spoke = true; // 꼬리 판정 불가 → 끝
    assert_eq!(
        reconsider_end(&mut e, 1, &cfg()),
        EndAction::Arm { grace_ms: 60_000 }
    );
    assert!(e.reclaim_armed);
    // 같은 유예로 다시 오면 늘리지 않는다
    assert_eq!(reconsider_end(&mut e, 2, &cfg()), EndAction::Keep);
    // 더 짧아질 수 있으면 바꿔 세운다
    let c = EndConfig {
        finished_reclaim_ms: 5_000,
        ..cfg()
    };
    e.finished = true;
    e.pending = Some(0);
    assert_eq!(
        reconsider_end(&mut e, 3, &c),
        EndAction::Arm { grace_ms: 5_000 }
    );
    assert_eq!(e.reclaim_grace_ms, 5_000);
    assert!(e.on_reclaim_timer());
    assert!(!e.reclaim_armed);
    assert!(e.reclaimed);
}

#[test]
fn background_children_wait_then_cut() {
    let c = EndConfig {
        background_wait_ms: 1_000,
        ..cfg()
    };
    let mut e = live();
    e.finished = true;
    e.pending = Some(2);
    assert_eq!(reconsider_end(&mut e, 100, &c), EndAction::Disarm);
    assert_eq!(e.background_since_ms, Some(100));
    assert_eq!(reconsider_end(&mut e, 1_099, &c), EndAction::Disarm);
    assert_eq!(e.background_cut, None);
    assert_eq!(
        reconsider_end(&mut e, 1_100, &c),
        EndAction::ReclaimNow { kill: true }
    );
    assert_eq!(e.background_cut, Some(2));
}

fn probe(now_ms: i64) -> StallProbe {
    StallProbe {
        reads_transcript: true,
        transcript_mtime_ms: None,
        looks_unsent: false,
        now_ms,
    }
}

#[test]
fn stall_off_or_irrelevant_states_are_alive() {
    let off = EndConfig {
        stall_ms: 0,
        ..cfg()
    };
    let mut e = live();
    e.last_life_ms = 1;
    assert_eq!(
        probe_stall(&mut e, probe(i64::MAX / 2), &off),
        StallVerdict::Alive
    );
    let sets: [fn(&mut EndState); 4] = [
        |e| e.spoke = true,
        |e| e.finished = true,
        |e| e.exited = true,
        |e| e.awaiting_human = true,
    ];
    for set in sets {
        let mut e = live();
        e.last_life_ms = 1;
        set(&mut e);
        assert_eq!(
            probe_stall(&mut e, probe(1_000_000_000), &cfg()),
            StallVerdict::Alive
        );
        assert!(!e.stalled);
    }
}

#[test]
fn transcript_growth_or_screen_data_keeps_alive() {
    let c = EndConfig {
        stall_ms: 1_000,
        ..cfg()
    };
    let mut e = live();
    e.last_life_ms = 100;
    // 기록이 자랐다
    let p = StallProbe {
        transcript_mtime_ms: Some(900),
        ..probe(1_500)
    };
    assert_eq!(probe_stall(&mut e, p, &c), StallVerdict::Alive);
    assert_eq!(e.last_life_ms, 900);
    // 기록은 그대로지만 화면이 흐른다(긴 셸 명령)
    e.last_data_at_ms = 2_500;
    assert_eq!(probe_stall(&mut e, probe(3_000), &c), StallVerdict::Alive);
    // 둘 다 멈췄다
    assert_eq!(
        probe_stall(&mut e, probe(3_500), &c),
        StallVerdict::Stalled {
            idle_ms: 1_000,
            kill: true
        }
    );
    assert!(e.stalled);
    assert_eq!(e.stalled_idle_ms, 1_000);
}

#[test]
fn unreadable_mtime_is_not_a_stall_signal() {
    let c = EndConfig {
        stall_ms: 1_000,
        ..cfg()
    };
    let mut e = live();
    // 기준점이 아직 없다(0) — 못 읽은 것을 정지로 읽지 않는다
    assert_eq!(probe_stall(&mut e, probe(10_000), &c), StallVerdict::Alive);
}

#[test]
fn viewers_block_stall() {
    let c = EndConfig {
        stall_ms: 1_000,
        ..cfg()
    };
    let mut e = live();
    e.last_life_ms = 1;
    e.viewers = 1;
    assert_eq!(probe_stall(&mut e, probe(10_000), &c), StallVerdict::Alive);
}

#[test]
fn transcriptless_harness_needs_screen_once() {
    let c = EndConfig {
        stall_ms: 1_000,
        ..cfg()
    };
    let mut e = live();
    e.last_life_ms = 1; // 턴 시작 시각 — 증거가 아니다
    let p = StallProbe {
        reads_transcript: false,
        ..probe(10_000)
    };
    assert_eq!(probe_stall(&mut e, p, &c), StallVerdict::Alive);
    e.last_data_at_ms = 2;
    assert_eq!(
        probe_stall(&mut e, p, &c),
        StallVerdict::Stalled {
            idle_ms: 9_998,
            kill: true
        }
    );
}

#[test]
fn unsent_prompt_gets_one_enter_then_stalls() {
    let c = EndConfig {
        stall_ms: 1_000,
        ..cfg()
    };
    let mut e = live();
    e.last_life_ms = 1;
    let p = StallProbe {
        looks_unsent: true,
        ..probe(5_000)
    };
    assert_eq!(probe_stall(&mut e, p, &c), StallVerdict::PressEnter);
    assert!(e.unsent_nudged);
    assert_eq!(e.last_life_ms, 5_000);
    assert!(!e.stalled);
    let p = StallProbe {
        looks_unsent: true,
        ..probe(6_000)
    };
    assert_eq!(
        probe_stall(&mut e, p, &c),
        StallVerdict::Stalled {
            idle_ms: 1_000,
            kill: true
        }
    );
}

#[test]
fn unsent_without_controls_stalls_without_kill() {
    let c = EndConfig {
        stall_ms: 1_000,
        ..cfg()
    };
    let mut e = EndState {
        last_life_ms: 1,
        ..EndState::default()
    };
    let p = StallProbe {
        looks_unsent: true,
        ..probe(5_000)
    };
    assert_eq!(
        probe_stall(&mut e, p, &c),
        StallVerdict::Stalled {
            idle_ms: 4_999,
            kill: false
        }
    );
    assert!(!e.reclaimed);
}

const PAT: &str = "hk_runner_secret_value_0123456789";

#[test]
fn recorded_api_error_is_quoted_and_masked() {
    let mut e = live();
    let raw = format!("API Error 401 token {PAT}\n  다음 줄");
    assert_eq!(e.on_recorded_api_error(&raw, PAT, &[]), Some(true));
    let got = e.recorded_api_error.clone().unwrap();
    assert!(!got.contains(PAT), "{got}");
    assert!(!got.contains('\n'));
    assert!(got.starts_with("API Error 401"));
    assert_eq!(e.api_error_notice(PAT, &[]), Some(got));
}

#[test]
fn recorded_api_error_with_secret_fragment_is_withheld() {
    let secret = vec!["s3cr3t-mounted-value-abcdefghijkl".to_string()];
    let mut e = live();
    e.on_recorded_api_error(&format!("Error: {}", &secret[0][..14]), PAT, &secret);
    assert_eq!(e.recorded_api_error.as_deref(), Some(MASKED_API_ERROR));
}

#[test]
fn api_error_after_speech_or_exit_is_ignored() {
    let mut e = live();
    e.spoke = true;
    assert_eq!(e.on_api_error("rate limit"), None);
    assert_eq!(e.on_recorded_api_error("x", PAT, &[]), None);
    assert!(e.api_error.is_none() && !e.reclaimed);
    let mut e = live();
    e.exited = true;
    assert_eq!(e.on_api_error("rate limit"), None);
}

#[test]
fn api_error_raw_kept_for_judging_but_notice_is_quoted() {
    let mut e = live();
    let raw = format!("429 rate limit `x` Bearer {PAT}");
    assert_eq!(e.on_api_error(&raw), Some(true));
    assert_eq!(e.api_error.as_deref(), Some(raw.as_str()));
    let n = e.api_error_notice(PAT, &[]).unwrap();
    assert!(!n.contains(PAT) && !n.contains('`'), "{n}");
    assert!(n.contains("rate limit"));
    assert_eq!(live().api_error_notice(PAT, &[]), None);
}
