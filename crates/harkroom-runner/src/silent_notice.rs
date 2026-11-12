//! 말없이 끝난 턴의 통지(정본 `prompt.ts` 의 `silentTurnNotice`·`proxyAnswerBody`·`proxyRecordAnswerBody`·`backgroundCutNotice`·
//! `silentWakeNotice`).
//!
//! 러너가 스레드에 대신 올리는 글은 전부 여기서 짓는다. 지키는 것:
//! - 인용한 글(화면 답·기록의 끝말)은 줄마다 `> ` 로 싼다 — 인용 안의 `@handle` 은 멘션이 되지 않는다.
//! - 가림은 `quoted_line` 과 같다(통째 가림 → PAT·토큰 가림, 12자 조각이 남으면 통째로 뺀다).
//! - 러너가 옮겼다는 꼬리는 잘리지 않게 그 몫을 먼저 뺀다. 길이는 서버와 같은 UTF-16 칸으로 잰다.

use crate::prompt_system::BODY_LIMIT;
use crate::turn_notice::{
    NudgeCaller, looks_like_answer, mask_tokens, mask_whole, one_line, quoted_line,
    tail_has_secret_fragment,
};

/// 정본 `SILENT_ACK_EMOJI` — 턴이 덧붙일 말 없이 끝났다는 표시.
pub const SILENT_ACK_EMOJI: &str = "✅";

/// 정본 `AGENT_CALL_NO_ANSWER` — 에이전트가 부른 턴이 화면으로 끝났는데 옮길 답이 없을 때의 줄.
pub const AGENT_CALL_NO_ANSWER: &str = "(답을 남기지 못하고 끝났습니다 — 화면에도 옮길 답이 없었습니다. 다시 부를지는 사람이 정합니다.)";

/// 정본 `PROXY_ANSWER_MAX_CHARS` — 대리 게시로 옮길 화면 답 한 줄의 상한(자).
pub const PROXY_ANSWER_MAX_CHARS: usize = 1_000;

const PROXY_SCREEN_TAIL: &str = "\n\n(에이전트가 이 답을 터미널에만 쓰고 스레드에 올리지 않아, 러너가 화면에서 옮겨 올렸습니다. 화면에 보이던 부분만이라 긴 답은 일부가 빠질 수 있습니다.)";
const PROXY_RECORD_TAIL: &str =
    "\n\n(에이전트가 이 답을 스레드에 올리지 않고 끝내, 러너가 하네스 기록에서 옮겨 올렸습니다.)";
const MASK: &str = "(가림)";

fn units(s: &str) -> i64 {
    s.encode_utf16().count() as i64
}

fn proxy_omitted(n: usize) -> String {
    if n > 0 {
        format!("> … {n}줄 생략 …")
    } else {
        "> … 일부 생략 …".to_owned()
    }
}

/// 정본 `keepHeadUnits` — 앞에서 `n` UTF-16 칸을 남긴다. 글자 가운데에서는 자르지 않는다(서러게이트 짝을 한 칸 물리는 것과 같다).
fn keep_head_units(s: &str, n: i64) -> &str {
    if n <= 0 {
        return "";
    }
    let mut used = 0i64;
    for (i, c) in s.char_indices() {
        used += c.len_utf16() as i64;
        if used > n {
            return &s[..i];
        }
    }
    s
}

/// 정본 `keepTailUnits` — 끝에서 `n` UTF-16 칸을 남긴다.
fn keep_tail_units(s: &str, n: i64) -> &str {
    if n <= 0 {
        return "";
    }
    let mut used = 0i64;
    for (i, c) in s.char_indices().rev() {
        used += c.len_utf16() as i64;
        if used > n {
            return &s[i + c.len_utf8()..];
        }
    }
    s
}

/// 정본 `fitQuotedLines` — 인용한 답을 `room` 칸 안에 담는다. 넘치면 앞뒤를 줄 단위로 남기고 가운데를 줄인다
/// (끝말을 먼저 잡되 뒤쪽이 칸의 60% 를 넘지 않게).
fn fit_quoted_lines(lines: &[String], room: i64) -> String {
    let whole = lines.join("\n");
    if units(&whole) <= room {
        return whole;
    }
    let budget = room - units(&proxy_omitted(lines.len())) - 2;
    let blank = lines.iter().rposition(|l| l == ">");
    let from = blank.map_or(0, |b| b + 1);
    let last_paragraph = units(&lines[from..].join("\n")) + 1;
    let tail_max = (budget as f64 * 0.6).floor() as i64;
    let tail_target = tail_max.min(last_paragraph.max(budget.div_euclid(4)));
    let mut tail: Vec<String> = Vec::new();
    let mut tail_used = 0i64;
    for i in (1..lines.len()).rev() {
        let cost = units(&lines[i]) + 1;
        if tail_used + cost > tail_target {
            break;
        }
        tail.insert(0, lines[i].clone());
        tail_used += cost;
    }
    if tail.is_empty() {
        let last = &lines[lines.len() - 1];
        let kept = format!("> …{}", keep_tail_units(last, tail_target - 4));
        tail_used = units(&kept) + 1;
        tail.push(kept);
    }
    let head_room = budget - tail_used;
    let stop = lines.len() - tail.len();
    let mut head: Vec<String> = Vec::new();
    let mut head_used = 0i64;
    for (i, line) in lines.iter().enumerate().take(stop) {
        let cost = units(line) + i64::from(i > 0);
        if head_used + cost > head_room {
            break;
        }
        head.push(line.clone());
        head_used += cost;
    }
    if head.is_empty() {
        let kept = keep_head_units(&lines[0], head_room - 1);
        if !kept.is_empty() {
            head.push(format!("{kept}…"));
        }
    }
    let omitted = stop.saturating_sub(head.len());
    let mut parts = head;
    parts.push(proxy_omitted(omitted));
    parts.extend(tail);
    let fitted = parts.join("\n");
    keep_head_units(&fitted, room).to_owned()
}

/// 통째 가림 뒤에도 비밀·PAT 의 12자 조각이 남았는지 — 대리 글 두 갈래가 같은 바늘을 쓴다.
fn has_secret_fragment(text: &str, pat: &str, secrets: &[String]) -> bool {
    let mut needles: Vec<String> = secrets.to_vec();
    if !pat.is_empty() {
        needles.push(pat.to_owned());
    }
    !needles.is_empty() && tail_has_secret_fragment(&mask_whole(text, &needles), &needles)
}

/// 정본 `proxyAnswerBody` — 화면의 답을 대신 올리는 글. 없거나 가림에 걸리면 빈 문자열.
pub fn proxy_answer_body(
    screen_answer: Option<&str>,
    pat: &str,
    secrets: &[String],
    reserve: usize,
) -> String {
    let Some(screen) = screen_answer else {
        return String::new();
    };
    if has_secret_fragment(screen, pat, secrets) {
        return String::new();
    }
    let lines: Vec<String> = screen
        .split('\n')
        .map(|l| one_line(l, pat, PROXY_ANSWER_MAX_CHARS, secrets))
        .filter(|l| !l.is_empty())
        .map(|l| format!("> {l}"))
        .collect();
    if lines.is_empty() {
        return String::new();
    }
    let room = BODY_LIMIT as i64 - units(PROXY_SCREEN_TAIL) - reserve as i64;
    format!("{}{PROXY_SCREEN_TAIL}", fit_quoted_lines(&lines, room))
}

/// 정본 `proxyRecordAnswerBody` — 기록의 마지막 말을 대신 올리는 글. 줄을 살리고 줄마다 인용으로 싼다.
pub fn proxy_record_answer_body(
    text: &str,
    pat: &str,
    secrets: &[String],
    reserve: usize,
) -> String {
    // 정본은 마운트한 비밀만 조각 검사하지만, 화면 답과 같이 PAT 도 넣는다(security #2004 낮음 1).
    if has_secret_fragment(text, pat, secrets) {
        return String::new();
    }
    let mut t = mask_whole(text, secrets);
    if !pat.is_empty() {
        t = t.replace(pat, MASK);
    }
    let t = mask_tokens(&t);
    let t = t.trim();
    if t.is_empty() {
        return String::new();
    }
    let quoted: Vec<String> = t
        .split('\n')
        .map(|l| {
            if l.trim().is_empty() {
                ">".to_owned()
            } else {
                format!("> {l}")
            }
        })
        .collect();
    let room = BODY_LIMIT as i64 - units(PROXY_RECORD_TAIL) - reserve as i64;
    format!("{}{PROXY_RECORD_TAIL}", fit_quoted_lines(&quoted, room))
}

/// 정본 `silentTurnNotice` 의 결과.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum SilentTurnNotice {
    /// 글 없이 멘션(대기 줄)에 반응만 단다.
    React { emoji: &'static str },
    /// 보통 글. `proxied` 는 러너가 답을 옮겨 올린 글이다.
    Post { body: String, proxied: bool },
    /// 넘겨받은 일 — 실패로 닫는다(재시도 가능).
    Fail { body: String },
}

/// 정본 `silentTurnNotice` 의 입력. 비밀을 담으므로 `Debug` 를 달지 않는다.
#[derive(Clone, Copy)]
pub struct SilentTurnInput<'a> {
    pub caller: NudgeCaller,
    pub last_said: Option<&'a str>,
    /// `offAnchorNotice` 의 결과 — 이 턴이 다른 스레드에 답했으면 그 링크 문장.
    pub off_anchor: Option<&'a str>,
    pub pat: &'a str,
    pub secrets: &'a [String],
    pub screen_answer: Option<&'a str>,
    /// 대리 글 맨 앞 머리(부른 사람 멘션, API 키 연결 턴). 그 몫을 본문 상한에서 먼저 뺀다.
    pub proxy_head: &'a str,
    pub record_answer: Option<&'a str>,
    pub screen_ended: bool,
    pub record_proxy: bool,
}

fn screen_proxy(i: &SilentTurnInput<'_>, reserve: usize) -> String {
    match i.record_answer.filter(|r| !r.is_empty()) {
        Some(r) => proxy_record_answer_body(r, i.pat, i.secrets, reserve),
        None => proxy_answer_body(i.screen_answer, i.pat, i.secrets, reserve),
    }
}

fn proxied(head: &str, body: String) -> SilentTurnNotice {
    SilentTurnNotice::Post {
        body: format!("{head}{body}"),
        proxied: true,
    }
}

/// 정본 `silentTurnNotice` — 발화 없이 끝난 턴에 무엇을 남길지.
pub fn silent_turn_notice(i: &SilentTurnInput<'_>) -> SilentTurnNotice {
    if let Some(off) = i.off_anchor {
        return SilentTurnNotice::Post {
            body: off.to_owned(),
            proxied: false,
        };
    }
    let head = i.proxy_head;
    let reserve = head.encode_utf16().count();
    match i.caller {
        NudgeCaller::Wake => {
            return SilentTurnNotice::React {
                emoji: SILENT_ACK_EMOJI,
            };
        }
        NudgeCaller::DelegationOutcome => {
            let said = quoted_line(i.last_said, i.pat, i.secrets);
            let body = if said.is_empty() {
                "넘긴 일의 결말을 확인한 턴이 글 없이 끝났습니다.".to_owned()
            } else {
                format!("넘긴 일의 결말을 확인한 턴이 글 없이 끝났습니다 — 마지막 말:\n> {said}")
            };
            return SilentTurnNotice::Post {
                body,
                proxied: false,
            };
        }
        NudgeCaller::Agent => {
            if !i.screen_ended {
                let body = match i.last_said {
                    Some(said) if i.record_proxy && looks_like_answer(Some(said)) => {
                        proxy_record_answer_body(said, i.pat, i.secrets, reserve)
                    }
                    _ => String::new(),
                };
                return if body.is_empty() {
                    SilentTurnNotice::React {
                        emoji: SILENT_ACK_EMOJI,
                    }
                } else {
                    proxied(head, body)
                };
            }
            let body = screen_proxy(i, reserve);
            if !body.is_empty() {
                return proxied(head, body);
            }
            return SilentTurnNotice::Post {
                body: AGENT_CALL_NO_ANSWER.to_owned(),
                proxied: false,
            };
        }
        NudgeCaller::Human => {
            let body = screen_proxy(i, reserve);
            if !body.is_empty() {
                return proxied(head, body);
            }
            if let Some(said) = i.last_said.filter(|s| i.record_proxy && !s.is_empty()) {
                let body = proxy_record_answer_body(said, i.pat, i.secrets, reserve);
                if !body.is_empty() {
                    return proxied(head, body);
                }
            }
        }
        NudgeCaller::Delegated => {}
    }
    let said = quoted_line(i.last_said, i.pat, i.secrets);
    if i.caller == NudgeCaller::Delegated {
        let body = if said.is_empty() {
            "넘겨받은 일에 답을 남기지 못하고 끝났습니다 — 다시 넘기면 이어서 합니다.".to_owned()
        } else {
            format!(
                "넘겨받은 일에 답을 남기지 못하고 끝났습니다. 마지막 말: \"{said}\" — 다시 넘기면 이어서 합니다."
            )
        };
        return SilentTurnNotice::Fail { body };
    }
    let body = if said.is_empty() {
        "답을 남기지 못하고 끝났습니다 — 다시 부르면 이어서 합니다.".to_owned()
    } else {
        format!("답을 남기지 못하고 끝났습니다. 마지막 말: \"{said}\" — 다시 부르면 이어서 합니다.")
    };
    SilentTurnNotice::Post {
        body,
        proxied: false,
    }
}

/// 정본 `backgroundCutNotice` — 하위 에이전트를 기다리다 턴을 거뒀다는 글.
pub fn background_cut_notice(
    count: usize,
    waited_ms: u64,
    last_said: Option<&str>,
    pat: &str,
    secrets: &[String],
) -> String {
    let minutes = ((waited_ms as f64 / 60_000.0).round() as u64).max(1);
    let said = quoted_line(last_said, pat, secrets);
    let mut out = format!(
        "하위 에이전트 {count}개가 {minutes}분 안에 끝나지 않아 턴을 거뒀습니다 — 그 작업은 끊겼습니다."
    );
    if !said.is_empty() {
        out.push_str(&format!(" 마지막 말: \"{said}\""));
    }
    out.push_str(" 다시 부르면 이어서 합니다.");
    out
}

/// 정본 `silentWakeNotice` — 사람이 카드에 답해 깬 턴이 말없이 끝났다는 progress 한 줄.
pub fn silent_wake_notice(last_said: Option<&str>, pat: &str, secrets: &[String]) -> String {
    let said = quoted_line(last_said, pat, secrets);
    if said.is_empty() {
        "(예약된 확인 턴이 발화 없이 끝났습니다)".to_owned()
    } else {
        format!("(예약된 확인 턴이 발화 없이 끝났습니다 — 하네스의 마지막 말: \"{said}\")")
    }
}

#[cfg(test)]
#[path = "silent_notice_tests.rs"]
mod tests;
