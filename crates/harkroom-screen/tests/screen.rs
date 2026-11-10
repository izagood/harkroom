//! 정본(TS) 골든과 같은 답을 내는지 — `golden/screen.json` 은 `packages/agent/test/screenGolden.test.ts` 가 쓴다.
use harkroom_screen::*;
use serde_json::Value;
use std::path::PathBuf;

fn root() -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR"))
}

fn golden() -> Value {
    serde_json::from_str(&std::fs::read_to_string(root().join("golden/screen.json")).unwrap())
        .unwrap()
}

/// 하네스 fixture(이미 그려진 화면 글, 120×40) — 정본과 같은 파일을 읽는다.
fn fx(name: &str) -> String {
    std::fs::read_to_string(root().join("../../packages/agent/test/fixtures").join(name)).unwrap()
}

/// 화면을 통째로 지우고 그 글을 그리는 바이트 — TS 시험의 `paint` 와 같다.
fn paint(text: &str) -> Vec<u8> {
    format!("\x1b[2J\x1b[H{}", text.replace('\n', "\r\n")).into_bytes()
}

#[test]
fn ts_patterns_are_the_ones_this_table_was_translated_from() {
    let g = golden();
    for h in Harness::ALL {
        let p = &g["patterns"][h.name()];
        let s = facts_for(h).ts_source;
        assert_eq!(
            p["ready"].as_str(),
            Some(s.ready),
            "{} ready — TS 패턴이 바뀌었다: 번역표를 고쳐라",
            h.name()
        );
        assert_eq!(p["busy"].as_str(), s.busy, "{} busy", h.name());
        assert_eq!(p["gate"].as_str(), Some(s.gate), "{} gate", h.name());
    }
}

#[test]
fn classify_matches_ts_for_every_fixture_and_harness() {
    let g = golden();
    let rows = g["classify"].as_array().unwrap();
    assert_eq!(rows.len(), 30 * 6, "fixture 30개 × 하네스 6");
    for r in rows {
        let h = Harness::from_name(r["harness"].as_str().unwrap()).unwrap();
        let f = r["fixture"].as_str().unwrap();
        let got = classify_screen(&fx(f), facts_for(h)).as_str();
        assert_eq!(got, r["state"].as_str().unwrap(), "{f} × {}", h.name());
    }
}

#[test]
fn answer_lines_match_ts() {
    let g = golden();
    for a in g["answers"].as_array().unwrap() {
        let h = Harness::from_name(a["harness"].as_str().unwrap()).unwrap();
        let before = a["before"].as_str().map(fx);
        let got = screen_answer_lines(
            &fx(a["fixture"].as_str().unwrap()),
            facts_for(h),
            before.as_deref(),
            a["cwd"].as_str(),
            SCREEN_ANSWER_MAX_LINES,
        );
        let want: Vec<String> = a["lines"]
            .as_array()
            .unwrap()
            .iter()
            .map(|v| v.as_str().unwrap().to_string())
            .collect();
        assert_eq!(got, want, "{} {}", h.name(), a["fixture"]);
    }
}

#[test]
fn progress_matches_ts() {
    for p in golden()["progress"].as_array().unwrap() {
        let text = p["text"].as_str().unwrap();
        assert_eq!(
            screen_shows_progress(text),
            p["progress"].as_bool().unwrap(),
            "{text:?}"
        );
    }
}

/// 화면 글 fixture 를 다시 그려도 같은 글·같은 판정이 나온다(제어열이 든 원 바이트 fixture 는 아래 시험이 본다).
#[test]
fn painting_each_fixture_through_vt100_gives_the_same_text_and_judgment() {
    let g = golden();
    let mut checked = 0;
    for r in g["classify"].as_array().unwrap() {
        let h = Harness::from_name(r["harness"].as_str().unwrap()).unwrap();
        let f = r["fixture"].as_str().unwrap();
        // 화면 한 장(40줄)보다 긴 fixture 는 그린 화면이 아니라 이어 붙인 기록이다 — 그리면 넘쳐 올라가므로 이 비교에서 뺀다
        // (그 fixture 의 판정은 위 `classify_matches_ts…` 가 글 그대로 본다).
        if fx(f).contains('\x1b') {
            continue;
        }
        let mut w = ScreenIdleWatch::new(facts_for(h));
        w.feed(&paint(&fx(f)), 0);
        // 40줄을 넘으면 위로 밀려 올라간다(xterm 도 같다) — 화면에 남는 것은 마지막 40줄이다.
        let all: Vec<String> = fx(f)
            .split('\n')
            .map(|l| l.trim_end().to_string())
            .collect();
        let want = &all[all.len().saturating_sub(40)..];
        let got: Vec<String> = w
            .text()
            .split('\n')
            .map(|l| l.trim_end().to_string())
            .collect();
        assert_eq!(&got[..want.len()], want, "{f}: vt100 이 그린 글");
        // 넘쳐 올라간 fixture 는 화면이 글 전체와 다르므로, 판정 비교는 화면 한 장에 들어가는 것만 한다.
        if all.len() > 40 {
            continue;
        }
        assert_eq!(
            w.current().as_str(),
            r["state"].as_str().unwrap(),
            "{f} × {}",
            h.name()
        );
        checked += 1;
    }
    assert!(
        checked >= 11 * 6,
        "화면 글 fixture 대부분을 덮어야 한다: {checked}"
    );
}

const PAIRED: [Harness; 5] = [
    Harness::Codex,
    Harness::Opencode,
    Harness::Kilo,
    Harness::Pi,
    Harness::Omp,
];

#[test]
fn ended_only_after_busy_then_idle_for_the_hold() {
    for h in PAIRED {
        let n = h.name();
        let mut w = ScreenIdleWatch::new(facts_for(h));
        // 프롬프트 전 첫 화면도 idle 꼴이다 — 일하는 중을 한 번도 안 봤으면 끝이 아니다.
        w.feed(&paint(&fx(&format!("{n}-tui-ended.txt"))), 0);
        assert!(!w.ended(60_000, SCREEN_IDLE_END_MS), "{n}");
        w.feed(&paint(&fx(&format!("{n}-tui-busy.txt"))), 1_000);
        assert!(!w.ended(60_000, SCREEN_IDLE_END_MS), "{n}");
        w.feed(&paint(&fx(&format!("{n}-tui-ended.txt"))), 2_000);
        assert!(
            !w.ended(2_000 + SCREEN_IDLE_END_MS - 1, SCREEN_IDLE_END_MS),
            "{n}"
        );
        assert!(
            w.ended(2_000 + SCREEN_IDLE_END_MS, SCREEN_IDLE_END_MS),
            "{n}"
        );
        assert!(w.busy_text().unwrap().contains("interrupt") || n == "pi" || n == "omp");
    }
}

#[test]
fn rearm_needs_busy_again() {
    let mut w = ScreenIdleWatch::new(facts_for(Harness::Codex));
    w.feed(&paint(&fx("codex-tui-busy.txt")), 0);
    w.feed(&paint(&fx("codex-tui-ended.txt")), 10);
    assert!(w.ended(10 + SCREEN_IDLE_END_MS, SCREEN_IDLE_END_MS));
    w.rearm();
    assert!(!w.ended(10_000, SCREEN_IDLE_END_MS));
    w.feed(&paint(&fx("codex-tui-busy.txt")), 20_000);
    w.feed(&paint(&fx("codex-tui-ended.txt")), 20_010);
    assert!(w.ended(20_010 + SCREEN_IDLE_END_MS, SCREEN_IDLE_END_MS));
}

#[test]
fn one_idle_frame_between_busy_frames_is_not_the_end() {
    let mut w = ScreenIdleWatch::new(facts_for(Harness::Omp));
    w.feed(&paint(&fx("omp-tui-busy.txt")), 0);
    w.feed(&paint(&fx("omp-tui-ended.txt")), 1_000);
    w.feed(&paint(&fx("omp-tui-busy.txt")), 1_000);
    assert!(!w.ended(1_000 + SCREEN_IDLE_END_MS * 10, SCREEN_IDLE_END_MS));
}

/// 알려진 폭 차이 고정(S0): xterm.js(유니코드 6 폭)는 `✨` 를 1칸, vt100 은 2칸으로 그린다. 하네스가 커서를 옮겨
/// 다음 글자를 놓으면 xterm 화면에는 그 사이에 빈칸이 하나 더 보인다. vt100 쪽 모양을 여기 고정해, 바뀌면 안다.
#[test]
fn sparkles_width_differs_from_xterm_by_one_cell() {
    let mut w = ScreenIdleWatch::new(facts_for(Harness::Codex));
    // codex 의 갱신 알림 줄 모양: 2칸 들여쓰기 → ✨ → 커서를 5열로 → 머리 공백(U+200A)과 글.
    w.feed(
        b"\x1b[2J\x1b[H\r\n  \xe2\x9c\xa8\x1b[2;5H\xe2\x80\x8aUpdate available!",
        0,
    );
    let row = w.text().split('\n').nth(1).unwrap().to_string();
    assert_eq!(
        row, "  ✨\u{200a}Update available!",
        "vt100: ✨ 가 2칸이라 바로 붙는다"
    );
    // xterm.js 는 같은 바이트를 "  ✨ \u{200a}Update available!" 로 그린다 — 판정 패턴은 이 칸에 기대지 않는다.
    assert_eq!(
        classify_screen(&row, facts_for(Harness::Codex)),
        ScreenState::Unknown
    );
}

#[test]
fn resize_keeps_working() {
    let mut w = ScreenIdleWatch::with_size(facts_for(Harness::Codex), 80, 24);
    w.resize(120, 40);
    w.feed(&paint(&fx("codex-tui-busy.txt")), 0);
    assert_eq!(w.current(), ScreenState::Busy);
}

/// **녹화 골든**: 원 PTY 바이트 fixture(실물 하네스 16개)를 vt100 으로 그린 화면이 정본 러너의 `@xterm/headless` 화면과
/// 한 칸도 다르지 않고, 그 화면의 판정도 하네스 6개 모두에서 같다.
#[test]
fn raw_pty_fixtures_render_the_same_as_xterm_headless() {
    let g = golden();
    let rendered = g["rendered"].as_array().unwrap();
    assert!(
        rendered.len() >= 16,
        "원 바이트 fixture 수: {}",
        rendered.len()
    );
    for r in rendered {
        let f = r["fixture"].as_str().unwrap();
        let mut w = ScreenIdleWatch::new(facts_for(Harness::Codex));
        w.feed(fx(f).as_bytes(), 0);
        let want = r["text"].as_str().unwrap();
        let got = w.text();
        let diff: Vec<usize> = want
            .split('\n')
            .zip(got.split('\n'))
            .enumerate()
            .filter(|(_, (a, b))| a != b)
            .map(|(i, _)| i)
            .collect();
        assert!(
            diff.is_empty(),
            "{f}: xterm 과 다른 줄 {diff:?}\n xterm: {:?}\n vt100: {:?}",
            want.split('\n').nth(diff[0]),
            got.split('\n').nth(diff[0])
        );
        for h in Harness::ALL {
            assert_eq!(
                classify_screen(&got, facts_for(h)).as_str(),
                r["states"][h.name()].as_str().unwrap(),
                "{f} × {}",
                h.name()
            );
        }
    }
}

/// 번역이 까다로운 갈래(앞보기·`\b`·`\d`·여러 줄 `^`)를 겨눈 한 줄 표본이 정본과 같은 판정을 낸다.
#[test]
fn line_probes_match_ts() {
    for p in golden()["probes"].as_array().unwrap() {
        let text = p["text"].as_str().unwrap();
        for h in Harness::ALL {
            assert_eq!(
                classify_screen(text, facts_for(h)).as_str(),
                p["states"][h.name()].as_str().unwrap(),
                "{text:?} × {}",
                h.name()
            );
        }
    }
}
