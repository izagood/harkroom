//! 하네스 TUI 화면 판정 — `packages/agent/src/screenIdle.ts`·`screenLife.ts` 의 Rust 판(S3a, Rust 전환).
//!
//! 지금 러너(TS)는 PTY 바이트를 `@xterm/headless` 로 그려 그 **화면 글**로 「일하는 중·끝남·물음」을 읽는다.
//! 이 crate 는 같은 판정을 vt100 0.18 로 그린 화면 위에서 한다. 아직 어디에도 연결하지 않는다 —
//! 러너 전환(S3)의 그림자 모드가 이것을 TS 판정과 나란히 돌려 어긋남을 센다.
//!
//! ## 정본은 TS 다
//! 판정 패턴(어댑터 `screen.ready`·`busy`·`gate`)과 규칙은 TS 쪽이 정본이다. TS 시험
//! `packages/agent/test/screenGolden.test.ts` 가 정본의 답을 `golden/screen.json` 에 적고, 이 crate 의 시험이 같은
//! 파일을 읽어 답이 같은지 본다. TS 패턴 원문도 적혀 있어서, TS 가 패턴을 바꾸면 아래 번역표가 낡았다는 것이 잡힌다.
//!
//! ## JS 정규식 → Rust 번역에서 지킨 것
//! - Rust `regex` 는 앞보기(lookahead)가 없다 — 관문 패턴의 `[❯›](?!\u00a0)[^\n]*✔` 는 같은 뜻의
//!   `[❯›](?:[^\x{a0}\n][^\n]*)?✔` 로 옮겼다.
//! - JS `\d`·`\b` 는 ASCII 다. Rust 는 기본이 유니코드라 `[0-9]`·`(?-u:\b)` 로 좁혔다.
//! - JS 의 `String.length` 는 UTF-16 단위다 — 길이로 가르는 곳(`hasCwdFragment`·테두리 비율)은 UTF-16 으로 센다.
//!
//! ## 화면 폭 차이(알려진 것)
//! xterm.js 는 기본이 유니코드 6 폭이라 `✨`(U+2728) 같은 일부 그림 문자를 1칸으로, vt100 은 2칸으로 그린다(S0 측정:
//! 240 화면 중 이 한 가지로 2개가 갈렸다). 판정 패턴은 그 칸에 기대지 않는다 — `tests/screen.rs` 가 이 차이를 고정해 둔다.

use regex::Regex;
use std::sync::LazyLock;

/// 화면 판정을 하는 하네스. 이름은 TS `AgentHarness` 값과 같다.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub enum Harness {
    ClaudeCode,
    Codex,
    Opencode,
    Kilo,
    Pi,
    Omp,
}

impl Harness {
    pub const ALL: [Harness; 6] = [
        Harness::ClaudeCode,
        Harness::Codex,
        Harness::Opencode,
        Harness::Kilo,
        Harness::Pi,
        Harness::Omp,
    ];

    pub fn name(self) -> &'static str {
        match self {
            Harness::ClaudeCode => "claude-code",
            Harness::Codex => "codex",
            Harness::Opencode => "opencode",
            Harness::Kilo => "kilo",
            Harness::Pi => "pi",
            Harness::Omp => "omp",
        }
    }

    pub fn from_name(name: &str) -> Option<Harness> {
        Harness::ALL.into_iter().find(|h| h.name() == name)
    }
}

/// 어댑터 화면 계약 하나(`HarnessAdapter.screen`). `busy` 가 없으면 화면으로 끝을 읽지 않는 하네스다(claude).
#[derive(Debug)]
pub struct ScreenFacts {
    pub ready: Regex,
    pub busy: Option<Regex>,
    pub gate: Regex,
    /// 이 번역의 출처인 TS 패턴 원문(`/source/flags`). 골든의 `patterns` 와 같아야 한다.
    pub ts_source: TsSource,
}

#[derive(Debug, Clone, Copy)]
pub struct TsSource {
    pub ready: &'static str,
    pub busy: Option<&'static str>,
    pub gate: &'static str,
}

/// `adapters/gate.ts::GATE_PATTERN` 의 원문.
pub const TS_GATE: &str = r"/Do you want to (?:proceed|continue)\?|requires confirmation|Press enter to continue|Enter\s*to\s*(?:confirm|continue)|Connect a provider|[❯›](?!\u00a0)[^\n]*✔|^\s*[❯›]\s*\d+\.\s/m";
const RS_GATE: &str = r"(?m)Do you want to (?:proceed|continue)\?|requires confirmation|Press enter to continue|Enter\s*to\s*(?:confirm|continue)|Connect a provider|[❯›](?:[^\x{a0}\n][^\n]*)?✔|^\s*[❯›]\s*[0-9]+\.\s";

fn re(p: &str) -> Regex {
    Regex::new(p).expect("화면 패턴 컴파일")
}

static FACTS: LazyLock<Vec<(Harness, ScreenFacts)>> = LazyLock::new(|| {
    let gate = || re(RS_GATE);
    vec![
        (
            Harness::ClaudeCode,
            ScreenFacts {
                ready: re(r"[❯›]\x{a0}"),
                busy: None,
                gate: gate(),
                ts_source: TsSource {
                    ready: r"/[❯›]\u00a0/",
                    busy: None,
                    gate: TS_GATE,
                },
            },
        ),
        (
            Harness::Codex,
            ScreenFacts {
                ready: re(r"Ask\s+\S+\s+to\s+do\s+anything"),
                busy: Some(re(r"esc to interrupt")),
                gate: gate(),
                ts_source: TsSource {
                    ready: r"/Ask\s+\S+\s+to\s+do\s+anything/",
                    busy: Some("/esc to interrupt/"),
                    gate: TS_GATE,
                },
            },
        ),
        (
            Harness::Opencode,
            ScreenFacts {
                ready: re(r"Ask anything|ctrl\+p"),
                busy: Some(re(r"esc interrupt")),
                gate: gate(),
                ts_source: TsSource {
                    ready: r"/Ask anything|ctrl\+p/",
                    busy: Some("/esc interrupt/"),
                    gate: TS_GATE,
                },
            },
        ),
        (
            Harness::Kilo,
            ScreenFacts {
                ready: re(r"Ask anything|ctrl\+p"),
                busy: Some(re(r"esc interrupt")),
                gate: gate(),
                ts_source: TsSource {
                    ready: r"/Ask anything|ctrl\+p/",
                    busy: Some("/esc interrupt/"),
                    gate: TS_GATE,
                },
            },
        ),
        (
            Harness::Pi,
            ScreenFacts {
                ready: re(r"[0-9]+(?:\.[0-9]+)?%/[0-9]+(?:\.[0-9]+)?[kM](?-u:\b)"),
                busy: Some(re(r"─+ [\x{2800}-\x{28ff}] Working")),
                gate: gate(),
                ts_source: TsSource {
                    ready: r"/\d+(?:\.\d+)?%\/\d+(?:\.\d+)?[kM]\b/",
                    busy: Some(r"/─+ [\u2800-\u28ff] Working/"),
                    gate: TS_GATE,
                },
            },
        ),
        (
            Harness::Omp,
            ScreenFacts {
                ready: re(r"[0-9]+(?:\.[0-9]+)?%[^\n]*?(?-u:\b)[0-9]+(?:\.[0-9]+)?[KM](?-u:\b)"),
                busy: Some(re(r"Working…|[\x{2800}-\x{28ff}] [0-9]+s >")),
                gate: gate(),
                ts_source: TsSource {
                    ready: r"/\d+(?:\.\d+)?%[^\n]*?\b\d+(?:\.\d+)?[KM]\b/",
                    busy: Some(r"/Working…|[\u2800-\u28ff] \d+s >/"),
                    gate: TS_GATE,
                },
            },
        ),
    ]
});

/// 하네스의 화면 계약(`adapterFor(h).screen`).
pub fn facts_for(h: Harness) -> &'static ScreenFacts {
    &FACTS
        .iter()
        .find(|(k, _)| *k == h)
        .expect("모든 하네스가 표에 있다")
        .1
}

/// 지금 화면이 말하는 것(`ScreenState`). `Idle` = 입력창이 보이고 일하는 중 표지가 없다.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ScreenState {
    Gate,
    Busy,
    Idle,
    Unknown,
}

impl ScreenState {
    pub fn as_str(self) -> &'static str {
        match self {
            ScreenState::Gate => "gate",
            ScreenState::Busy => "busy",
            ScreenState::Idle => "idle",
            ScreenState::Unknown => "unknown",
        }
    }
}

/// `classifyScreen` — 관문이 먼저, 그다음 일하는 중, 그다음 입력창.
pub fn classify_screen(text: &str, facts: &ScreenFacts) -> ScreenState {
    if facts.gate.is_match(text) {
        return ScreenState::Gate;
    }
    if facts.busy.as_ref().is_some_and(|b| b.is_match(text)) {
        return ScreenState::Busy;
    }
    if facts.ready.is_match(text) {
        return ScreenState::Idle;
    }
    ScreenState::Unknown
}

/// 끝났다고 보려면 idle 이 이만큼 이어져야 한다(ms) — `SCREEN_IDLE_END_MS`.
pub const SCREEN_IDLE_END_MS: u64 = 1_500;

/// `ScreenIdleWatch` — PTY 바이트를 vt100 으로 그리고 「일하는 중을 한 번 본 뒤 idle 이 이어진 시각」을 잰다.
/// 일하는 중을 한 번은 봐야 끝을 말한다(프롬프트를 넣기 전의 첫 화면도 idle 꼴이다).
pub struct ScreenIdleWatch {
    parser: vt100::Parser,
    facts: &'static ScreenFacts,
    saw_busy: bool,
    idle_since_ms: Option<u64>,
    state: ScreenState,
    last_busy_text: Option<String>,
}

impl ScreenIdleWatch {
    /// 기본 크기는 TS 와 같은 120×40 이다.
    pub fn new(facts: &'static ScreenFacts) -> Self {
        Self::with_size(facts, 120, 40)
    }

    pub fn with_size(facts: &'static ScreenFacts, cols: u16, rows: u16) -> Self {
        let nz = |n: u16| core::num::NonZeroU16::new(n.max(1)).expect("0 이 아니다");
        Self {
            parser: vt100::Parser::new(nz(rows), nz(cols), 0),
            facts,
            saw_busy: false,
            idle_since_ms: None,
            state: ScreenState::Unknown,
            last_busy_text: None,
        }
    }

    /// 조각을 그리고 상태를 다시 잰다. TS 와 달리 그리기가 동기라 콜백이 없다.
    pub fn feed(&mut self, chunk: &[u8], now_ms: u64) {
        self.parser.process(chunk);
        self.observe(now_ms);
    }

    pub fn resize(&mut self, cols: u16, rows: u16) {
        let nz = |n: u16| core::num::NonZeroU16::new(n.max(1)).expect("0 이 아니다");
        self.parser.screen_mut().set_size(nz(rows), nz(cols));
    }

    /// 다음 차례를 넣었다 — 일하는 중을 다시 본 뒤에야 끝을 말한다.
    pub fn rearm(&mut self) {
        self.saw_busy = false;
        self.idle_since_ms = None;
    }

    /// 보이는 화면 글(줄은 `\n` 으로 잇는다). xterm `translateToString(true)` 처럼 **한 번도 쓰지 않은** 줄 끝 칸만 빠지고,
    /// 하네스가 공백을 직접 써 넣은 칸은 남는다 — 원 바이트 fixture 16개에서 xterm 과 한 칸도 다르지 않은 것이 `tests/screen.rs` 에 있다.
    pub fn text(&self) -> String {
        let screen = self.parser.screen();
        let (_, cols) = screen.size();
        screen.rows(0, cols.get()).collect::<Vec<_>>().join("\n")
    }

    pub fn busy_text(&self) -> Option<&str> {
        self.last_busy_text.as_deref()
    }

    pub fn current(&self) -> ScreenState {
        self.state
    }

    /// 일하는 중을 본 뒤 idle 이 `hold_ms` 넘게 이어졌는가.
    pub fn ended(&self, now_ms: u64, hold_ms: u64) -> bool {
        self.saw_busy
            && self.state == ScreenState::Idle
            && self
                .idle_since_ms
                .is_some_and(|since| now_ms.saturating_sub(since) >= hold_ms)
    }

    fn observe(&mut self, now_ms: u64) {
        let text = self.text();
        let next = classify_screen(&text, self.facts);
        if next == ScreenState::Busy {
            self.saw_busy = true;
            self.last_busy_text = Some(text);
        }
        if next == ScreenState::Idle {
            if self.state != ScreenState::Idle {
                self.idle_since_ms = Some(now_ms);
            }
        } else {
            self.idle_since_ms = None;
        }
        self.state = next;
    }
}

/// 화면 답으로 집을 줄의 상한 — `SCREEN_ANSWER_MAX_LINES`.
pub const SCREEN_ANSWER_MAX_LINES: usize = 40;
/// 작업 폴더 조각으로 볼 낱말의 최소 길이(UTF-16 단위) — `CWD_FRAGMENT_MIN`.
const CWD_FRAGMENT_MIN: usize = 12;

static CHROME: LazyLock<Regex> = LazyLock::new(|| re(r"[─━│┃╭╮╰╯┌┐└┘├┤┬┴┼═║╔╗╚╝▔▁▀▄█╹╻▶◀⬝]"));
static PATHLIKE: LazyLock<Regex> = LazyLock::new(|| re(r"(~?/|…/|\.\.?/|[a-z]+://)\S"));
static REASONING_SUMMARY: LazyLock<Regex> = LazyLock::new(|| {
    re(
        r"^(?:[+\-▸▾]\s*)?(?:Thought|Thinking)(?::\s*[0-9]+(?:\.[0-9]+)?(?:ms|s|m|h)(?:\s+[0-9]+(?:\.[0-9]+)?(?:ms|s|m|h))*|\s*(?:…|\.\.\.))$",
    )
});
static TURN_SUMMARY: LazyLock<Regex> = LazyLock::new(|| {
    re(r"^\S+ · \S+ · [0-9]+(?:\.[0-9]+)?(?:ms|s|m|h)(?: [0-9]+(?:\.[0-9]+)?(?:ms|s|m|h))*$")
});
static BULLET: LazyLock<Regex> = LazyLock::new(|| re(r"^[•●⏺◦▣]\s*"));

fn utf16_len(s: &str) -> usize {
    s.encode_utf16().count()
}

fn has_cwd_fragment(line: &str, cwd: Option<&str>) -> bool {
    let Some(cwd) = cwd else { return false };
    line.split_whitespace().any(|raw| {
        let w = raw.trim_matches(|c| c == '…' || c == '.');
        utf16_len(w) >= CWD_FRAGMENT_MIN && cwd.contains(w)
    })
}

/// `screenAnswerLines` — 끝난 화면에서 모델이 쓴 답으로 보이는 줄. 마지막 일하는 중 화면(`before`)에 없던 줄만 집고,
/// 입력창·일하는 중 표지·테두리·경로·작업 폴더 조각·생각 요약·차례 요약 줄은 뺀다.
pub fn screen_answer_lines(
    text: &str,
    facts: &ScreenFacts,
    before: Option<&str>,
    cwd: Option<&str>,
    max: usize,
) -> Vec<String> {
    let seen: std::collections::HashSet<&str> =
        before.unwrap_or("").split('\n').map(str::trim).collect();
    let mut picked = Vec::new();
    for raw in text.split('\n') {
        let l = raw.trim();
        if l.is_empty()
            || seen.contains(l)
            || facts.ready.is_match(l)
            || facts.busy.as_ref().is_some_and(|b| b.is_match(l))
            || PATHLIKE.is_match(l)
            || has_cwd_fragment(l, cwd)
        {
            continue;
        }
        let chrome = CHROME.find_iter(l).count();
        let visible: String = l.chars().filter(|c| !c.is_whitespace()).collect();
        if chrome * 2 > utf16_len(&visible) {
            continue;
        }
        let said = BULLET.replace(l, "").into_owned();
        if REASONING_SUMMARY.is_match(&said) || TURN_SUMMARY.is_match(&said) {
            continue;
        }
        picked.push(said);
        if picked.len() >= max {
            break;
        }
    }
    picked
}

static CONTROL: LazyLock<Regex> = LazyLock::new(|| {
    re(r"\x1b\[[0-9;?<>=]*[ -/]*[@-~]|\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)|\x1b[@-_]|[\x00-\x1f\x7f]")
});
static BLINK_GLYPHS: LazyLock<Regex> = LazyLock::new(|| re(r"[⏺●\s]"));

/// `screenShowsProgress` — 이 조각이 화면에 글자를 그렸는가(제어열·공백·대기 깜빡이만이면 진행이 아니다).
pub fn screen_shows_progress(text: &str) -> bool {
    let no_ctrl = CONTROL.replace_all(text, "");
    !BLINK_GLYPHS.replace_all(&no_ctrl, "").is_empty()
}
