//! 멘션 턴이 스레드에 남기는 실패·관문 통지 문구를 조립한다(정본 `prompt.ts` 의 `harnessTailNotice`·`quotedLine`·
//! `stallScreenErrorLine`·`gateNotice`·`retryReason`, `mentionTurn.ts` 의 실패 문장 3019~3110행).
//!
//! 화면 원문(PTY tail·관문 화면)은 이 모듈을 거쳐서만 사람이 보는 자리에 나간다.
//! - **실패 문구(`message.fail`·재시도 통지)에는 화면을 싣지 않는다.** 정본은 `harness 종료 N: <tail>` 로 실었다. 그런데
//!   TUI 는 주입한 프롬프트를 에코하므로 tail 에 사람 글이 섞이고, 그 문장은 자격증명 실패 판정의 재료이기도 했다(설계 §3-4).
//!   tail 은 [`TurnFailure::Exited`] 의 따로 둔 칸으로만 넘긴다. `Display` 와 [`TurnFailure::message`] 에는 넣지 않는다.
//! - **관문 통지([`gate_notice`])에는 화면이 없다.** 화면은 앱으로만 간다(`relay_session` 의 `attention.required`, 끝 2KB 상한).
//! - 정지 통지에 싣는 줄 하나는 [`stall_screen_line`] 이 만든다. 가린 화면에서 고르고, 한 줄로 접은 뒤 다시 가린다.
//!
//! 글자 수는 정본(UTF-16 단위)과 달리 `char` 단위로 센다 — 한글은 같고, 서로게이트 쌍만 하나로 센다.

use std::fmt;
use std::sync::LazyLock;

use regex::Regex;

/// 정본 `TAIL_NOTICE_MAX_CHARS` — 꼬리 통지에 남기는 뒤쪽 글자 수.
pub const TAIL_NOTICE_MAX_CHARS: usize = 1_000;
/// 정본 `NOTICE_LINE_MAX_CHARS` — 통지에 인용하는 한 줄의 상한.
pub const NOTICE_LINE_MAX_CHARS: usize = 200;
/// 정본 `RETRY_REASON_MAX_CHARS`.
pub const RETRY_REASON_MAX_CHARS: usize = 160;
/// 정본 `TAIL_FRAGMENT_CHARS` — 비밀 조각 판정 길이.
pub const TAIL_FRAGMENT_CHARS: usize = 12;

const MASK: &str = "(가림)";
/// 비밀 조각이 보여 출력을 통째로 뺄 때의 문장(정본과 같다).
pub const TAIL_WITHHELD: &str = "(마지막 출력에 비밀 값이 섞여 있어 싣지 않았다)";

static OSC: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"\x1B\][^\x07\x1B]*(?:\x07|\x1B\\)").expect("osc"));
// ECMA-48 CSI: 매개변수 0x30–0x3F, 중간 0x20–0x2F, 끝 0x40–0x7E(정본 10-01 고침과 같음 — kitty `ESC[<u` 도 지운다).
static CSI: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"\x1B\[[0-?]*[ -/]*[@-~]").expect("csi"));
static ESC2: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"\x1B[ -/]*[0-~]").expect("esc"));
static CRLF: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"\r\n?").expect("crlf"));
static CTRL: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"[\x00-\x08\x0B\x0C\x0E-\x1F\x7F]").expect("ctrl"));
static HARKROOM_TOKEN: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"(?:hrkp|murp)_[A-Za-z0-9_-]+").expect("hrkp"));
static BEARER: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"(?i)(Bearer\s+)\S+").expect("bearer"));
// 정본 `COMMON_TOKEN`. `\b` 는 정본(JS)처럼 ASCII 낱말 경계로 둔다 — 유니코드 경계면 `토큰sk-…` 처럼 한글에 붙은 값을 놓친다.
static COMMON_TOKEN: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(
        r"(?-u:\b)(?:sk-[A-Za-z0-9_-]{16,}|gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,}|xox[a-z]-[A-Za-z0-9-]{10,}|AKIA[0-9A-Z]{16})",
    )
    .expect("common token")
});
static WS: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"\s+").expect("ws"));
static TAIL_FLATTEN: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"[\s│⎿╭╮╰╯─]").expect("flatten"));
static ERROR_WORD: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(
        r"(?i)✘|✗|(?-u:\b)(?:error|failed|failure|unauthorized|forbidden|not found|bad request|too many requests|rate limit(?:ed)?|timed out)(?-u:\b)",
    )
    .expect("error word")
});
static HTTP_CODE: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"(?-u:\b)[45][0-9][0-9](?-u:\b)").expect("http code"));
static HTTP_CODE_CONTEXT: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(r#"(?i)\{|"|error|not found|unauthorized|forbidden"#).expect("http ctx")
});

fn replace_all_literal(text: &str, needle: &str) -> String {
    if needle.is_empty() || !text.contains(needle) {
        return text.to_owned();
    }
    text.replace(needle, MASK)
}

/// 정본 `maskWhole` — 마운트한 비밀 값을 통째로 가린다(긴 것부터 온다).
fn mask_whole(text: &str, secrets: &[String]) -> String {
    let mut t = text.to_owned();
    for n in secrets {
        t = replace_all_literal(&t, n);
    }
    t
}

/// 정본 `maskTokens` — 값을 모르는 토큰을 꼴로 가린다.
fn mask_tokens(text: &str) -> String {
    let t = HARKROOM_TOKEN.replace_all(text, MASK);
    let t = BEARER.replace_all(&t, format!("${{1}}{MASK}").as_str());
    COMMON_TOKEN.replace_all(&t, MASK).into_owned()
}

fn char_tail(text: &str, max: usize) -> Option<&str> {
    let count = text.chars().count();
    if count <= max {
        return None;
    }
    let skip = count - max;
    let (idx, _) = text.char_indices().nth(skip).expect("skip < count");
    Some(&text[idx..])
}

fn char_head(text: &str, max: usize) -> Option<&str> {
    text.char_indices().nth(max).map(|(idx, _)| &text[..idx])
}

/// 정본 `tailHasSecretFragment` — 비밀의 12자 조각(끝 조각은 마지막 12자) 중 하나라도 공백·상자 문자를 걷은 글에 있는가.
pub fn tail_has_secret_fragment(text: &str, secrets: &[String]) -> bool {
    let flat = TAIL_FLATTEN.replace_all(text, "");
    for raw in secrets {
        let n: Vec<char> = TAIL_FLATTEN.replace_all(raw, "").chars().collect();
        if n.len() <= TAIL_FRAGMENT_CHARS {
            if !n.is_empty() && flat.contains(&n.iter().collect::<String>()) {
                return true;
            }
            continue;
        }
        let mut i = 0;
        while i < n.len() {
            let piece: String = if i + TAIL_FRAGMENT_CHARS <= n.len() {
                n[i..i + TAIL_FRAGMENT_CHARS].iter().collect()
            } else {
                n[n.len() - TAIL_FRAGMENT_CHARS..].iter().collect()
            };
            if flat.contains(&piece) {
                return true;
            }
            i += TAIL_FRAGMENT_CHARS;
        }
    }
    false
}

/// 정본 `harnessTailNotice` — 화면 꼬리를 사람이 읽을 글로 만든다. 이스케이프·제어문자를 걷고, 러너 비밀(`pat`)·마운트한
/// 비밀·토큰 꼴을 가린다. 비밀 조각이 보이면 출력을 통째로 빼고([`TAIL_WITHHELD`]), 남길 것이 없으면 `None`.
pub fn harness_tail_notice(tail: &str, pat: &str, secrets: &[String]) -> Option<String> {
    let t = OSC.replace_all(tail, "");
    let t = CSI.replace_all(&t, "");
    let t = ESC2.replace_all(&t, "");
    let t = CRLF.replace_all(&t, "\n");
    let mut text = CTRL.replace_all(&t, "").into_owned();

    // 정확한 러너 비밀을 먼저 — 아래 꼴 규칙이 못 잡는 모양이어도 이건 잡힌다.
    text = replace_all_literal(&text, pat);
    if !secrets.is_empty() {
        text = mask_whole(&text, secrets);
        if tail_has_secret_fragment(&text, secrets) {
            return Some(TAIL_WITHHELD.to_owned());
        }
    }
    let t = HARKROOM_TOKEN.replace_all(&text, MASK);
    let t = BEARER.replace_all(&t, format!("${{1}}{MASK}").as_str());
    let text = t.trim();
    if text.is_empty() {
        return None;
    }
    // 뒤를 남기고, 자른 사실을 밝힌다.
    Some(match char_tail(text, TAIL_NOTICE_MAX_CHARS) {
        Some(rest) => format!("…{rest}"),
        None => text.to_owned(),
    })
}

/// 정본 `oneLine` — 통째 가림을 **자르기 전에** 하고, 한 줄로 접어 앞을 남긴다.
fn one_line(text: &str, pat: &str, max: usize, secrets: &[String]) -> String {
    let t = mask_whole(text, secrets);
    let t = replace_all_literal(&t, pat);
    let t = mask_tokens(&t).replace('`', "'");
    let t = WS.replace_all(&t, " ");
    let t = t.trim();
    match char_head(t, max) {
        Some(head) => format!("{head}…"),
        None => t.to_owned(),
    }
}

/// 정본 `quotedLine` — 통지에 인용할 한 줄. 통째로 가린 뒤에도 비밀 조각이 보이면 인용을 통째로 뺀다(빈 문자열).
pub fn quoted_line(last_said: Option<&str>, pat: &str, secrets: &[String]) -> String {
    let Some(said) = last_said else {
        return String::new();
    };
    if !secrets.is_empty() && tail_has_secret_fragment(&mask_whole(said, secrets), secrets) {
        return String::new();
    }
    one_line(said, pat, NOTICE_LINE_MAX_CHARS, secrets)
}

/// 정본 `stallScreenErrorLine` — 가린 화면에서 오류처럼 보이는 마지막 줄. 판정에는 쓰지 않는다(보이는 글로만).
pub fn stall_screen_error_line(screen: Option<&str>) -> Option<String> {
    let screen = screen?;
    screen
        .split('\n')
        .map(str::trim)
        .filter(|l| !l.is_empty())
        .rev()
        .find(|l| looks_like_error(l))
        .map(str::to_owned)
}

fn looks_like_error(line: &str) -> bool {
    if ERROR_WORD.is_match(line) {
        return true;
    }
    // 정본의 `\b[45]\d\d\b(?=[^\n]*(?:\{|"|error|…))` — regex 에 앞보기가 없어 숫자 뒤 나머지 줄을 따로 본다.
    HTTP_CODE
        .find_iter(line)
        .any(|m| HTTP_CODE_CONTEXT.is_match(&line[m.end()..]))
}

/// 정지 통지에 싣는 화면 줄(정본 `mentionTurn.ts` 3104~3108행): 가린 화면 → 오류 줄 → 한 줄 인용(다시 가림). 없으면 `None`.
pub fn stall_screen_line(tail: &str, pat: &str, secrets: &[String]) -> Option<String> {
    let screen = harness_tail_notice(tail, pat, secrets);
    let line = stall_screen_error_line(screen.as_deref())?;
    let quoted = quoted_line(Some(&line), pat, secrets);
    (!quoted.is_empty()).then_some(quoted)
}

/// 정본 `retryReason` — 실패 사유를 통지에 실을 한 줄로 줄인다(앞을 남긴다). 토큰 꼴은 여기서도 가린다.
pub fn retry_reason(message: &str) -> Option<String> {
    let t = HARKROOM_TOKEN.replace_all(message, MASK);
    let t = BEARER.replace_all(&t, format!("${{1}}{MASK}").as_str());
    let t = WS.replace_all(&t, " ");
    let t = t.trim();
    if t.is_empty() {
        return None;
    }
    Some(match char_head(t, RETRY_REASON_MAX_CHARS) {
        Some(head) => format!("{head}…"),
        None => t.to_owned(),
    })
}

/// 정본 `gateNotice` — 관문 통지 본문. **화면을 싣지 않는다**(화면은 앱의 `attention.required` 로만 간다).
pub fn gate_notice(account_label: &str) -> String {
    format!(
        "(하네스가 확인을 기다려 진행이 멈췄습니다 — 이 스레드의 터미널을 열어 화면의 물음에 답해 주세요. 답하면 이 턴이 그 자리에서 이어집니다. 계정: {account_label})"
    )
}

/// 관문 통지의 `message.fail` 칸(정본 `callHuman` 의 `what`·`reason`·`gateFailExtras`).
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct GateFail {
    pub body: String,
    pub what: &'static str,
    pub reason: &'static str,
    pub retryable: bool,
    /// 턴 시작 관문이면 `account_gate`(정본 `gateFailExtras`). 턴 도중 관문은 없음.
    pub code: Option<&'static str>,
    pub mention_id: Option<String>,
    pub account: Option<String>,
}

/// 관문 통지 한 장. `startup` 이면 계정 표식 칸을 채운다.
pub fn gate_fail(
    account_label: &str,
    startup: bool,
    mention_id: &str,
    account: Option<&str>,
) -> GateFail {
    GateFail {
        body: gate_notice(account_label),
        what: "하네스가 사람의 확인을 기다린다",
        reason: "그 터미널에서 화면의 물음에 답하면 이 턴이 그 자리에서 이어진다",
        retryable: false,
        code: startup.then_some("account_gate"),
        mention_id: startup.then(|| mention_id.to_owned()),
        account: if startup {
            account.map(str::to_owned)
        } else {
            None
        },
    }
}

/// 실패한 턴의 원인(정본 `mentionTurn.ts` 실패 문장의 갈래, 우선순위 순).
#[derive(Clone, PartialEq, Eq)]
pub enum TurnFailure {
    /// 사람이 중단했다(handle).
    Canceled(String),
    /// 다른 러너가 스레드 임대를 가져갔다.
    FencedOut,
    /// 턴 도중 관측한 API 오류(이미 한 줄로 가린 값).
    ApiError(String),
    /// 하네스 기록의 API 오류([`quoted_line`] 을 거친 값, 비면 가렸다는 문장).
    RecordedApiError(String),
    /// 기록이 자라지 않아 접었다.
    Stalled { idle_ms: u64, limit_ms: u64 },
    /// 러너가 스레드를 못 읽어 발화를 확인하지 못했다.
    SilenceUnknown { ms: u64 },
    /// 답 없이 시간 한도를 넘겼다.
    Silenced { ms: u64 },
    /// 하네스가 끝났다. `tail` 은 판정 재료(자격증명 실패 등)로만 따로 두고 **문장에는 싣지 않는다**.
    Exited {
        code: i32,
        timed_out: bool,
        tail: String,
    },
}

impl TurnFailure {
    /// `message.fail`·재시도 통지에 쓰는 문장. 화면 원문은 들어가지 않는다.
    pub fn message(&self) -> String {
        match self {
            Self::Canceled(by) => format!("@{by} 가 이 턴을 중단했다"),
            Self::FencedOut => {
                "다른 러너가 이 스레드를 넘겨받아 이 턴을 접었다(스레드 임대를 잃었다)".to_owned()
            }
            Self::ApiError(e) => format!("harness API 에러: {e}"),
            Self::RecordedApiError(e) => format!("harness API 오류(하네스 기록): {e}"),
            Self::Stalled { idle_ms, limit_ms } => format!(
                "harness 정지 {idle_ms}ms(한도 {limit_ms}ms) — 기록이 자라지 않았다(답 없음)"
            ),
            Self::SilenceUnknown { ms } => format!(
                "harness 발화 확인 불가 {ms}ms — 러너가 서버에서 이 스레드를 읽지 못해 답했는지 모른다(서버 링크 확인)"
            ),
            Self::Silenced { ms } => format!("harness 무발화 {ms}ms — 답 없이 시간 한도를 넘겼다"),
            Self::Exited {
                code, timed_out, ..
            } => format!(
                "harness 종료 {code}{}",
                if *timed_out { " (timeout)" } else { "" }
            ),
        }
    }

    /// 판정 재료로만 쓰는 화면 꼬리(`Exited` 만). 사람이 보는 자리에 싣지 않는다.
    pub fn exit_tail(&self) -> Option<&str> {
        match self {
            Self::Exited { tail, .. } => Some(tail),
            _ => None,
        }
    }
}

impl fmt::Display for TurnFailure {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(&self.message())
    }
}

impl fmt::Debug for TurnFailure {
    // tail 원문이 로그·패닉 메시지로 새지 않게 길이만 적는다(`PromptNotDelivered` 와 같은 규율).
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::Exited {
                code,
                timed_out,
                tail,
            } => f
                .debug_struct("Exited")
                .field("code", code)
                .field("timed_out", timed_out)
                .field("tail_len", &tail.len())
                .finish(),
            other => write!(f, "TurnFailure({})", other.message()),
        }
    }
}

impl std::error::Error for TurnFailure {}

#[cfg(test)]
#[path = "turn_notice_tests.rs"]
mod tests;
