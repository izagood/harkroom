//! PTY 턴의 **순수 절반**(S3 B3b-1). 정본은 `packages/agent/src/pty.ts` 의 앞부분이다 — 프로세스를 띄우지 않는
//! 결정들(명령 조립·붙여넣기 정리·준비/관문 판정·링 버퍼·출력 합치기·tail 디코드)만 옮긴다. PTY 를 실제로 여는
//! `runPtyTurn` 은 B3b-2 다. 판정 문구·이유는 정본 주석이 정본이다 — 여기엔 이식에서 달라진 것만 적는다.

use std::sync::LazyLock;

use regex::Regex;

/// 단일 인용부호로 감싼다 — 안의 `'` 는 `'\''` 로 바꾼다(셸 표준 규칙, 정본 `shellQuote`).
fn shell_quote(arg: &str) -> String {
    format!("'{}'", arg.replace('\'', "'\\''"))
}

/// PTY 에 넘길 명령·인자(정본 `composeSpawn`). `stdin_file` 이 있으면 `sh -c 'exec … < 파일'` 로 감싼다 —
/// `exec` 가 없으면 최종 프로세스가 `sh` 라 시그널이 하네스에 안 닿는다. 왜 이 래핑을 못 없애는지는 정본 주석(#380).
pub fn compose_spawn(
    command: &str,
    args: &[String],
    stdin_file: Option<&str>,
) -> (String, Vec<String>) {
    let Some(file) = stdin_file else {
        return (command.to_string(), args.to_vec());
    };
    let parts = std::iter::once(command)
        .chain(args.iter().map(String::as_str))
        .map(shell_quote)
        .collect::<Vec<_>>()
        .join(" ");
    (
        "sh".into(),
        vec!["-c".into(), format!("exec {parts} < {}", shell_quote(file))],
    )
}

/// 이 계획의 PTY 에 사람이 입력할 수 있는가(정본 `acceptsPtyInput`, #369) — stdin 이 파일이면 닿지 않는다.
pub fn accepts_pty_input(stdin_file: Option<&str>) -> bool {
    stdin_file.is_none()
}

/// TUI 가 준비 신호에 닿지 못해 프롬프트를 못 넣었다(정본 `PromptNotDeliveredError`).
/// `tail` 은 화면 원문이라 사람이 보는 자리에 싣지 않는다 — `Display` 에도 넣지 않는다(정본은 메시지에 넣었다).
#[derive(Clone, PartialEq, Eq)]
pub struct PromptNotDelivered {
    pub waited_ms: u64,
    pub tail: String,
    pub kind: NotDeliveredKind,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum NotDeliveredKind {
    /// 화면이 사람의 선택을 기다린다(입력창이 아닌 화면을 그린 뒤 조용해졌다).
    Waiting,
    /// 준비 상한에 닿았다.
    Timeout,
}

impl NotDeliveredKind {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Waiting => "waiting",
            Self::Timeout => "timeout",
        }
    }
}

impl std::fmt::Debug for PromptNotDelivered {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("PromptNotDelivered")
            .field("waited_ms", &self.waited_ms)
            .field("kind", &self.kind)
            .field("tail_len", &self.tail.len())
            .finish()
    }
}

impl std::fmt::Display for PromptNotDelivered {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(
            f,
            "TUI 준비 신호를 {}ms 안에 못 봤다 — 프롬프트를 넣지 못했다({})",
            self.waited_ms,
            self.kind.as_str()
        )
    }
}

impl std::error::Error for PromptNotDelivered {}

/// 채팅 입력창에만 있는 긍정 신호(정본 `DEFAULT_READY_PATTERN`) — claude `❯`+NBSP, codex 자리표시자.
pub static DEFAULT_READY_PATTERN: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(r"[❯›]\x{a0}|Ask\s+\S+\s+to\s+do\s+anything").expect("ready pattern")
});

/// 묻는 화면에만 있는 것(정본 `DEFAULT_GATE_PATTERN`).
/// Rust `regex` 는 앞보기(`(?!…)`)가 없어 `[❯›](?! )[^\n]*✔` 를 `[❯›](?:[^\x{a0}\n][^\n]*)?✔` 로 바꿨다 —
/// 커서 바로 뒤가 NBSP 가 아니고 같은 줄에 `✔` 가 있다는 같은 뜻이고, 맞는 시작 위치도 같다(커서 자리).
/// `\d` 는 JS 처럼 ASCII 만 보도록 `[0-9]` 로 썼다.
pub static DEFAULT_GATE_PATTERN: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(concat!(
        r"(?m)Do you want to (?:proceed|continue)\?|requires confirmation|Press enter to continue",
        r"|Enter\s*to\s*(?:confirm|continue)|Connect a provider",
        r"|[❯›](?:[^\x{a0}\n][^\n]*)?✔|^\s*[❯›]\s*[0-9]+\.\s",
    ))
    .expect("gate pattern")
});

static ANSI_OSC: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"\x1b\][0-9]*;[^\x07]*\x07").expect("osc"));
static ANSI_CSI: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"\x1b\[[0-9;?]*[A-Za-z]").expect("csi"));
static ANSI_CHARSET: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"\x1b[()][AB012]").expect("charset"));

/// 판정 전에 화면 제어 시퀀스를 걷는다(정본 `stripAnsi` — 순서도 같다: OSC → CSI → 문자셋).
pub fn strip_ansi(text: &str) -> String {
    let a = ANSI_OSC.replace_all(text, "");
    let b = ANSI_CSI.replace_all(&a, "");
    ANSI_CHARSET.replace_all(&b, "").into_owned()
}

/// 이 출력이 "입력을 받을 준비"로 보이는가(정본 `looksReadyForPrompt`).
pub fn looks_ready_for_prompt(raw: &str, pattern: Option<&Regex>) -> bool {
    pattern
        .unwrap_or(&DEFAULT_READY_PATTERN)
        .is_match(&strip_ansi(raw))
}

/// 패턴이 마지막으로 맞은 위치(바이트). 없으면 None. 같은 문자열 안의 비교에만 쓰므로 바이트 위치로 충분하다.
fn last_match_index(text: &str, pattern: &Regex) -> Option<usize> {
    pattern.find_iter(text).last().map(|m| m.start())
}

/// 이 출력의 **마지막 화면이 관문인가**(정본 `looksLikeGate`) — 있다/없다가 아니라 관문과 입력창 중 뒤에 그려진 쪽을 믿는다.
pub fn looks_like_gate(raw: &str, gate: Option<&Regex>, ready: Option<&Regex>) -> bool {
    let screen = strip_ansi(raw);
    let Some(gate_at) = last_match_index(&screen, gate.unwrap_or(&DEFAULT_GATE_PATTERN)) else {
        return false;
    };
    match last_match_index(&screen, ready.unwrap_or(&DEFAULT_READY_PATTERN)) {
        Some(ready_at) => gate_at > ready_at,
        None => true,
    }
}

/// 사람을 부른 자리(정본 `AttentionKind`) — startup 은 계정으로 묶고, gate 는 명령 하나라 묶지 않는다.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum AttentionKind {
    Startup,
    Gate,
}

/// SIGTERM → SIGKILL 유예(정본 `SIGKILL_GRACE_MS`).
pub const SIGKILL_GRACE_MS: u64 = 5_000;
/// tail 상한 — `isCredentialFailure` 의 유일한 증거(정본 `TAIL_CAP_BYTES`).
pub const TAIL_CAP_BYTES: usize = 2 * 1024;
/// 출력 합치기 창(정본 `OUTPUT_COALESCE_MS`).
pub const OUTPUT_COALESCE_MS: u64 = 12;

/// 붙여넣기 본문에서 제어 문자를 걷는다(정본 `sanitizePasteText`) — `ESC[201~` 로 붙여넣기를 끝내고 키를 치는 길을 막는다.
/// 남기는 것: `\n`·탭. `\r`(단독·`\r\n`)은 `\n` 으로. 걷는 것: 나머지 C0·DEL·C1.
pub fn sanitize_paste_text(text: &str) -> String {
    let normalized = text.replace("\r\n", "\n").replace('\r', "\n");
    let cleaned: String = normalized
        .chars()
        .filter(|&c| {
            let u = c as u32;
            !((u <= 0x08) || (0x0b..=0x1f).contains(&u) || (0x7f..=0x9f).contains(&u))
        })
        .collect();
    strip_invisible_chars(&cleaned)
}

static PICTO: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"^\p{Extended_Pictographic}$").expect("picto"));

fn is_picto(c: Option<char>) -> bool {
    c.is_some_and(|c| {
        let mut b = [0u8; 4];
        PICTO.is_match(c.encode_utf8(&mut b))
    })
}

fn is_invisible_drop(c: char) -> bool {
    matches!(
        c,
        '\u{ad}' | '\u{200b}' | '\u{200c}' | '\u{200e}' | '\u{200f}' | '\u{2060}'
            ..='\u{2069}' | '\u{feff}'
    )
}

fn is_tag(c: char) -> bool {
    ('\u{e0000}'..='\u{e007f}').contains(&c)
}

fn is_skin_tone(c: char) -> bool {
    ('\u{1f3fb}'..='\u{1f3ff}').contains(&c)
}

/// 보이지 않는 글자를 걷는다(정본 `stripInvisibleChars`) — 이모지 시퀀스의 접착제(FE0F·ZWJ·깃발 태그)는 남긴다.
pub fn strip_invisible_chars(text: &str) -> String {
    let needs = text.chars().any(|c| {
        matches!(c, '\u{ad}' | '\u{200b}'..='\u{200f}' | '\u{2028}' | '\u{2029}' | '\u{2060}'..='\u{2069}' | '\u{fe0f}' | '\u{feff}')
            || is_tag(c)
    });
    if !needs {
        return text.to_string();
    }
    let cps: Vec<char> = text.chars().collect();
    let mut out: Vec<char> = Vec::with_capacity(cps.len());
    let mut i = 0;
    while i < cps.len() {
        let c = cps[i];
        if c == '\u{1f3f4}' {
            // 🏴 + 태그(E0020–E007E)들 + 끝 태그(E007F) — 지역 깃발은 통째로 남긴다.
            let mut j = i + 1;
            while j < cps.len() && ('\u{e0020}'..='\u{e007e}').contains(&cps[j]) {
                j += 1;
            }
            if j > i + 1 && cps.get(j) == Some(&'\u{e007f}') {
                out.extend_from_slice(&cps[i..=j]);
                i = j + 1;
                continue;
            }
            out.push(c);
            i += 1;
            continue;
        }
        if c == '\u{2028}' || c == '\u{2029}' {
            out.push('\n');
        } else if is_invisible_drop(c) || is_tag(c) {
            // 버린다
        } else if c == '\u{fe0f}' {
            let p = out.last().copied();
            if is_picto(p) || p.is_some_and(|p| matches!(p, '#' | '*' | '0'..='9')) {
                out.push(c);
            }
        } else if c == '\u{200d}' {
            let p = out.last().copied();
            let before = if p == Some('\u{fe0f}') || p.is_some_and(is_skin_tone) {
                out.len().checked_sub(2).map(|k| out[k])
            } else {
                p
            };
            if is_picto(before) && is_picto(cps.get(i + 1).copied()) {
                out.push(c);
            }
        } else {
            out.push(c);
        }
        i += 1;
    }
    out.into_iter().collect()
}

/// 고정 용량 링 버퍼(정본 `RingBuffer`). 넘치면 오래된 쪽을 자른다. 절단은 일부러 바이트 단위다 —
/// ring 은 xterm 으로 갈 raw 바이트라 문자 경계로 정렬하면 ANSI 시퀀스가 깨진다. tail 의 잘린 문자는 `decode_tail_text` 가 처리한다.
pub struct RingBuffer {
    buf: Vec<u8>,
    start: usize,
    len: usize,
}

impl RingBuffer {
    pub fn new(cap_bytes: usize) -> Self {
        Self {
            buf: vec![0; cap_bytes.max(1)],
            start: 0,
            len: 0,
        }
    }

    fn cap(&self) -> usize {
        self.buf.len()
    }

    pub fn len(&self) -> usize {
        self.len
    }

    pub fn is_empty(&self) -> bool {
        self.len == 0
    }

    /// 청크 길이만큼만 복사한다(O(chunk)).
    pub fn push(&mut self, data: &[u8]) {
        let cap = self.cap();
        if data.is_empty() {
            return;
        }
        if data.len() >= cap {
            self.buf.copy_from_slice(&data[data.len() - cap..]);
            self.start = 0;
            self.len = cap;
            return;
        }
        let end = (self.start + self.len) % cap;
        let first = data.len().min(cap - end);
        self.buf[end..end + first].copy_from_slice(&data[..first]);
        if first < data.len() {
            self.buf[..data.len() - first].copy_from_slice(&data[first..]);
        }
        if self.len + data.len() > cap {
            self.start = (end + data.len()) % cap;
            self.len = cap;
        } else {
            self.len += data.len();
        }
    }

    /// 도착 순서(오래된 것부터)로 편 복사본.
    pub fn snapshot(&self) -> Vec<u8> {
        let cap = self.cap();
        let end = self.start + self.len;
        if end <= cap {
            self.buf[self.start..end].to_vec()
        } else {
            let mut out = Vec::with_capacity(self.len);
            out.extend_from_slice(&self.buf[self.start..]);
            out.extend_from_slice(&self.buf[..end - cap]);
            out
        }
    }
}

/// `OutputCoalescer::push` 의 결과.
#[derive(Debug, PartialEq, Eq)]
pub enum Push {
    /// 조용한 상태였다 — 이 청크를 **곧바로** 내보내고, 호출자는 `window_ms` 뒤 `window_end` 를 부를 타이머를 건다.
    EmitAndArm(Vec<u8>),
    /// 창 안이다 — 모아 뒀다.
    Buffered,
    /// 빈 청크.
    Ignored,
}

/// 출력 프레임 합치기(정본 `createOutputCoalescer`). 선행 청크는 즉시, 창 안의 것은 창 끝에 한 번.
/// 정본은 타이머를 안에 쥐지만 이 crate 는 std::thread 구조라 **타이머는 호출자가 쥔다** — 이 타입은 상태만 든다
/// (정본 테스트가 `setTimer` 이음새로 하던 것을 그대로 손으로 돌릴 수 있다).
#[derive(Default)]
pub struct OutputCoalescer {
    pending: Vec<u8>,
    /// false 면 조용한 상태 — 다음 청크는 기다리지 않고 나간다.
    armed: bool,
}

impl OutputCoalescer {
    pub fn new() -> Self {
        Self::default()
    }

    pub fn push(&mut self, chunk: &[u8]) -> Push {
        if chunk.is_empty() {
            return Push::Ignored;
        }
        if !self.armed {
            self.armed = true;
            return Push::EmitAndArm(chunk.to_vec());
        }
        self.pending.extend_from_slice(chunk);
        Push::Buffered
    }

    /// 창이 끝났다. 모인 게 있으면 그것을 돌려주고 **창을 다시 연다**(`true` — 호출자가 타이머를 다시 건다).
    /// 없으면 조용한 상태로 돌아간다(`false`).
    pub fn window_end(&mut self) -> (Option<Vec<u8>>, bool) {
        if self.pending.is_empty() {
            self.armed = false;
            return (None, false);
        }
        (Some(std::mem::take(&mut self.pending)), true)
    }

    /// 끝났다 — 남은 것을 반드시 내보낸다(턴의 마지막 화면이 여기 있다). 호출자는 타이머를 끈다.
    pub fn stop(&mut self) -> Option<Vec<u8>> {
        self.armed = false;
        (!self.pending.is_empty()).then(|| std::mem::take(&mut self.pending))
    }
}

/// tail 을 문자열로 뜬다(정본 `decodeTailText`) — 링이 잘라 맨 앞에 남은 continuation 바이트(최대 3개)는 잡음이라 버린다.
pub fn decode_tail_text(buf: &[u8]) -> String {
    let mut start = 0;
    while start < buf.len() && start < 3 && (buf[start] & 0xc0) == 0x80 {
        start += 1;
    }
    String::from_utf8_lossy(&buf[start..]).into_owned()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn fixture(name: &str) -> String {
        let path = format!(
            "{}/../../packages/agent/test/fixtures/{name}",
            env!("CARGO_MANIFEST_DIR")
        );
        std::fs::read_to_string(&path).unwrap_or_else(|e| panic!("{path}: {e}"))
    }

    #[test]
    fn compose_spawn_wraps_with_exec_and_quotes() {
        let (c, a) = compose_spawn("claude", &["-p".into()], None);
        assert_eq!(
            (c.as_str(), a.as_slice()),
            ("claude", &["-p".to_string()][..])
        );
        let (c, a) = compose_spawn("/a b/claude", &["it's".into()], Some("/tmp/p q.txt"));
        assert_eq!(c, "sh");
        assert_eq!(a[0], "-c");
        assert_eq!(a[1], r#"exec '/a b/claude' 'it'\''s' < '/tmp/p q.txt'"#);
        assert!(accepts_pty_input(None));
        assert!(!accepts_pty_input(Some("/f")));
    }

    #[test]
    fn ready_screens_table() {
        for (file, ready) in [
            ("claude-tui-ready.txt", true),
            ("codex-tui-ready.txt", true),
            ("claude-tui-ready-real.txt", true),
            ("claude-tui-trust-modal.txt", false),
            ("claude-tui-login-menu.txt", false),
            ("claude-tui-settings-approval.txt", false),
            ("claude-tui-onboarding-theme.txt", false),
            ("claude-tui-onboarding-theme-2.1.286.txt", false),
            ("claude-tui-bypass-warning.txt", false),
        ] {
            assert_eq!(
                looks_ready_for_prompt(&fixture(file), None),
                ready,
                "{file}"
            );
        }
    }

    #[test]
    fn gate_screens_table() {
        for file in [
            "claude-tui-onboarding-theme.txt",
            "claude-tui-onboarding-theme-2.1.286.txt",
            "claude-tui-trust-modal.txt",
            "claude-tui-bypass-warning.txt",
            "claude-auto-mode-billing-notice.txt",
            "codex-tui-update-prompt.txt",
        ] {
            assert!(looks_like_gate(&fixture(file), None, None), "{file}");
        }
        for file in ["codex-tui-ready.txt", "claude-tui-ready-real.txt"] {
            assert!(!looks_like_gate(&fixture(file), None, None), "{file}");
        }
        // 업데이트 화면: 준비 표시가 앞서 있어도 관문이 이긴다.
        assert!(looks_ready_for_prompt(
            &fixture("codex-tui-update-prompt.txt"),
            None
        ));
        // opencode 창: 배경의 준비 표시보다 창이 뒤다.
        let oc = Regex::new(r"Ask anything|ctrl\+p").unwrap();
        let modal = fixture("opencode-connect-provider-modal.txt");
        assert!(looks_ready_for_prompt(&modal, Some(&oc)));
        assert!(looks_like_gate(&modal, None, Some(&oc)));
    }

    #[test]
    fn gate_order_decides() {
        let gate = [
            "Auto mode classifier requires confirmation for this command.",
            "Do you want to proceed?",
            "\u{276f} 1. Yes",
            "  2. Yes, and don't ask again for: ls *",
            "  3. No",
            "",
            "Esc to cancel \u{b7} Tab to amend",
        ]
        .join("\n");
        assert!(looks_like_gate(&gate, None, None));
        assert!(!looks_ready_for_prompt(&gate, None));
        assert!(looks_like_gate(
            &format!("\u{276f}\u{a0}\n{gate}"),
            None,
            None
        ));
        assert!(!looks_like_gate(
            &format!("{gate}\n\u{276f}\u{a0}"),
            None,
            None
        ));
        assert!(!looks_like_gate(
            "빌드 중입니다\n41 files changed\n",
            None,
            None
        ));
    }

    #[test]
    fn check_mark_gate_excludes_input_line() {
        // 앞보기 없는 바꿈이 같은 뜻인지: 커서 바로 뒤 ✔ / 글자 뒤 ✔ 는 관문, 커서+NBSP 뒤 ✔ 는 아니다.
        assert!(looks_like_gate("\u{276f}\u{2714} Dark mode", None, None));
        assert!(looks_like_gate(
            "\u{276f} 2. Dark mode \u{2714}",
            None,
            None
        ));
        assert!(looks_like_gate("\u{276f}2.Darkmode\u{2714}", None, None));
        assert!(!DEFAULT_GATE_PATTERN.is_match("\u{276f}\u{a0}done \u{2714}"));
        assert!(!DEFAULT_GATE_PATTERN.is_match("\u{276f}\nfoo \u{2714}"));
    }

    #[test]
    fn strip_ansi_removes_osc_csi_charset() {
        assert_eq!(
            strip_ansi("\x1b]0;title\x07\x1b[1;32mhi\x1b[0m\x1b(Bok\x1b[?25l"),
            "hiok"
        );
    }

    #[test]
    fn sanitize_paste_drops_controls_and_end_marker() {
        let s = sanitize_paste_text("a\r\nb\rc\x1b[201~\r!rm\u{9b}\x7fd\te");
        assert_eq!(s, "a\nb\nc[201~\n!rmd\te");
        assert!(!s.contains('\x1b'));
    }

    #[test]
    fn invisible_chars_keep_emoji_glue() {
        assert_eq!(strip_invisible_chars("plain"), "plain");
        assert_eq!(
            strip_invisible_chars("a\u{200b}b\u{ad}c\u{feff}d\u{2066}e"),
            "abcde"
        );
        assert_eq!(strip_invisible_chars("x\u{2028}y\u{2029}z"), "x\ny\nz");
        // 단독 FE0F 는 버리고, 그림 글자·키캡 뒤 FE0F 는 남긴다.
        assert_eq!(strip_invisible_chars("a\u{fe0f}"), "a");
        assert_eq!(
            strip_invisible_chars("\u{26a0}\u{fe0f}"),
            "\u{26a0}\u{fe0f}"
        );
        assert_eq!(
            strip_invisible_chars("1\u{fe0f}\u{20e3}"),
            "1\u{fe0f}\u{20e3}"
        );
        // 👨‍💻 ZWJ 는 남기고, 글자 사이 ZWJ 는 버린다.
        assert_eq!(
            strip_invisible_chars("\u{1f468}\u{200d}\u{1f4bb}"),
            "\u{1f468}\u{200d}\u{1f4bb}"
        );
        assert_eq!(
            strip_invisible_chars("\u{1f468}\u{1f3fd}\u{200d}\u{1f4bb}"),
            "\u{1f468}\u{1f3fd}\u{200d}\u{1f4bb}"
        );
        assert_eq!(strip_invisible_chars("a\u{200d}b"), "ab");
        // 🏴 깃발 시퀀스는 통째로, 떠도는 태그는 버린다.
        let flag = "\u{1f3f4}\u{e0067}\u{e0062}\u{e0065}\u{e006e}\u{e0067}\u{e007f}";
        assert_eq!(strip_invisible_chars(flag), flag);
        assert_eq!(strip_invisible_chars("a\u{e0041}b"), "ab");
    }

    #[test]
    fn ring_buffer_keeps_tail_in_order() {
        let mut r = RingBuffer::new(8);
        assert!(r.is_empty());
        r.push(b"abc");
        r.push(b"defgh");
        assert_eq!(r.snapshot(), b"abcdefgh");
        r.push(b"ij");
        assert_eq!(r.snapshot(), b"cdefghij");
        r.push(b"0123456789");
        assert_eq!(r.snapshot(), b"23456789");
        r.push(b"");
        r.push(b"xyz");
        assert_eq!(r.snapshot(), b"56789xyz");
        assert_eq!(r.len(), 8);
        assert_eq!(RingBuffer::new(0).cap(), 1);
    }

    #[test]
    fn coalescer_leading_edge_then_window() {
        let mut c = OutputCoalescer::new();
        assert_eq!(c.push(b""), Push::Ignored);
        assert_eq!(c.push(b"a"), Push::EmitAndArm(b"a".to_vec()));
        assert_eq!(c.push(b"b"), Push::Buffered);
        assert_eq!(c.push(b"c"), Push::Buffered);
        assert_eq!(c.window_end(), (Some(b"bc".to_vec()), true));
        assert_eq!(c.window_end(), (None, false));
        // 조용해졌으니 다음 청크는 다시 즉시.
        assert_eq!(c.push(b"d"), Push::EmitAndArm(b"d".to_vec()));
        assert_eq!(c.push(b"e"), Push::Buffered);
        assert_eq!(c.stop(), Some(b"e".to_vec()));
        assert_eq!(c.stop(), None);
        assert_eq!(c.push(b"f"), Push::EmitAndArm(b"f".to_vec()));
    }

    #[test]
    fn decode_tail_drops_leading_continuation() {
        let mut r = RingBuffer::new(8);
        r.push("가나다라마".as_bytes()); // 15바이트 → 끝 8바이트: 잘린 조각 2 + 다라 일부
        let text = decode_tail_text(&r.snapshot());
        assert!(!text.starts_with('\u{fffd}'), "{text:?}");
        assert!(text.ends_with("라마"));
        assert_eq!(decode_tail_text(b"ok"), "ok");
    }

    #[test]
    fn prompt_not_delivered_hides_tail() {
        let e = PromptNotDelivered {
            waited_ms: 60_000,
            tail: "org-secret-setting".into(),
            kind: NotDeliveredKind::Waiting,
        };
        assert!(!format!("{e}").contains("org-secret"));
        assert!(!format!("{e:?}").contains("org-secret"));
        assert!(format!("{e}").contains("waiting"));
    }
}
