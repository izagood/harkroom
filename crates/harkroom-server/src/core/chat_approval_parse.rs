//! 글 승인·선택 카드 글 답의 **순수 판정**(P3b·P3c 첫 층) — TS `services/chatApproval.ts` 의
//! `readChatBody`·`parseChatApproval`·`isExplicitApproval`·`parseAskPick`·`matchAskPick` 을 그대로 옮긴다.
//!
//! 이 파일은 DB 를 만지지 않는다. 어느 카드를 정할지·`decide` 를 부를지는 다음 층의 몫이고, 그 층이 붙기 전까지
//! `msg_post` 의 넓은 체(`CHAT_APPROVAL_GUARD_WORDS`)는 그대로 TS 로 넘긴다 — 이 파일만으로는 동작이 바뀌지 않는다.
//!
//! JS 정규식과 똑같이 읽히게 맞춘 곳(새 의존성 없이 `regex` 만 쓴다):
//! - `\s`·`\S`·`trim` 은 JS 의 공백 집합(`JS_WS`) — Rust `\s` 는 U+0085 를 넣고 U+FEFF 를 빼서 다르다.
//! - `\b` 는 JS(유니코드 플래그와 무관하게 ASCII 낱자 기준) — Rust `\b` 는 유니코드라 「승인approve」에서 갈린다.
//!   쓰이는 자리는 모두 `is_match` 이거나 앞 글자를 되살리는 치환이라, 경계 글자를 소비하는 꼴로 바꿔도 같다.
//! - 앞뒤 문맥 검사(lookbehind `(?<![미무불비])`·lookahead)는 `regex` 가 못 해서 손으로 본다.
//! - `.length` 는 UTF-16 길이, `^`·`$`·`.` 의 줄 끝은 JS 의 줄 끝 집합(\n \r U+2028 U+2029).
//! - `toLowerCase` 는 `str::to_lowercase`(둘 다 끝 시그마까지 유니코드 규칙).

use std::sync::LazyLock;

use regex::Regex;

pub const CHAT_APPROVAL_MAX_CARDS: usize = 5;

/// JS `\s` 집합(WhiteSpace + LineTerminator). 문자 클래스 **안**에 끼워 쓴다.
const WS: &str = r"\t\n\x0B\x0C\r \x{A0}\x{1680}\x{2000}-\x{200A}\x{2028}\x{2029}\x{202F}\x{205F}\x{3000}\x{FEFF}";
const UUID: &str = "[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}";

fn is_js_ws(c: char) -> bool {
    matches!(
        c,
        '\t' | '\n' | '\u{0B}' | '\u{0C}' | '\r' | ' ' | '\u{A0}' | '\u{1680}' | '\u{2000}'
            ..='\u{200A}'
                | '\u{2028}'
                | '\u{2029}'
                | '\u{202F}'
                | '\u{205F}'
                | '\u{3000}'
                | '\u{FEFF}'
    )
}
fn js_trim(s: &str) -> &str {
    s.trim_matches(is_js_ws)
}
fn utf16_len(s: &str) -> usize {
    s.encode_utf16().count()
}

/// `\s` → JS 공백 클래스, `\S` → 그 부정으로 바꿔 짓는다(패턴 안의 `\s`·`\S` 는 클래스 밖에서만 쓴다).
fn re(p: &str) -> Regex {
    let p = p
        .replace(r"\s", &format!("[{WS}]"))
        .replace(r"\S", &format!("[^{WS}]"));
    Regex::new(&p).expect("chat_approval_parse regex")
}

/// ASCII 낱자(JS `\w`) — `\b` 를 손으로 볼 때 쓴다.
const NW: &str = "[^A-Za-z0-9_]";

static MENTION_TOKEN: LazyLock<Regex> = LazyLock::new(|| re(&format!("(?i)<@{UUID}>")));
static MESSAGE_LINK: LazyLock<Regex> =
    LazyLock::new(|| re(&format!("(?i)harkroom://message/({UUID})")));
static MD_MESSAGE_LINK: LazyLock<Regex> = LazyLock::new(|| {
    re(&format!(
        r"(?i)\[[^\]\n]{{0,200}}\]\(\s*harkroom://message/({UUID})\s*\)"
    ))
});
static CODE_BLOCK: LazyLock<Regex> = LazyLock::new(|| re(r"(?s)```.*?(?:```|$)"));
static CODE_INLINE: LazyLock<Regex> = LazyLock::new(|| re(r"`[^`\n]*`?"));
/// JS `/^[ \t]*>.*$/gm` — `^` 는 JS 줄 끝 뒤, `.` 는 JS 줄 끝 밖. 앞의 줄 끝 글자(\r 등)는 `$1` 로 되살린다.
static QUOTE_LINE: LazyLock<Regex> =
    LazyLock::new(|| re(r"(?m)(^|[\r\x{2028}\x{2029}])[ \t]*>[^\n\r\x{2028}\x{2029}]*"));
/// JS `/\bhttps?:\/\/\S+/gi` — 앞 경계 글자는 `$1` 로 되살린다.
static URL: LazyLock<Regex> = LazyLock::new(|| re(&format!(r"(?i)(^|{NW})https?://\S+")));

/// `APPROVE_KO` 두 번째 갈래 — 「머지」·「진행」 + 동사 활용.
static APPROVE_KO_VERB: LazyLock<Regex> =
    LazyLock::new(|| re(r"(?:머지|진행)\s*(?:해|했|하자|합|할게|하세요|시켜)"));
/// `APPROVE_KO` 첫 갈래의 lookahead 몸통(`(?!\s*(?:요청|…))`) — 낱말 바로 뒤에서 앞붙임으로 본다.
static APPROVE_KO_NOT_AFTER: LazyLock<Regex> = LazyLock::new(|| {
    re(r"^\s*(?:요청|대기|받|을|된|되|필요|버튼|기다|여부|권한|카드|건|전에|후에)")
});
static APPROVE_EN: LazyLock<Regex> = LazyLock::new(|| {
    re(&format!(
        r"(?:^|{NW})(?:approve|approved|approves)(?:$|{NW})"
    ))
});
static DENY: LazyLock<Regex> =
    LazyLock::new(|| re(&format!(r"거절|(?:^|{NW})(?:deny|denied|denies)(?:$|{NW})")));
static BYPASS: LazyLock<Regex> = LazyLock::new(|| re(&format!(r"바이패스|(?:^|{NW})bypass")));
/// `NEGATION` — `(?:^|\s)안(?=\s)` 는 뒤 공백을 소비하는 꼴로(`is_match` 만 쓴다).
static NEGATION: LazyLock<Regex> = LazyLock::new(|| {
    re(&format!(
        r"말고|없이|말아|하지\s*마|보류|취소|잠깐|기다려|아니|못|금지|불가|거부|중지|멈춰|멈춤|나중|이따|다음에|미뤄|미루|아직|ㄴㄴ|안\s*(?:해|함|돼|할|한|합)|(?:^|\s)안\s|않|(?:^|{NW})(?:don'?t|do not|not|no|wait|hold|cancel|stop|never|later)(?:$|{NW})"
    ))
});
static QUESTION: LazyLock<Regex> = LazyLock::new(|| re(r"[?？]"));
/// `QUESTION_KO`(m 플래그) — lookahead 를 소비하는 꼴로. JS `$`(m) 은 \r·U+2028·U+2029 앞에서도 맞아 클래스에 넣는다.
static QUESTION_KO: LazyLock<Regex> = LazyLock::new(|| {
    re(
        r"(?:까|나|니|냐|는지)\s*(?:\z|[.,;:!~…\n\r\x{2028}\x{2029}]|ㅋ|ㅎ|ㅠ|ㅜ)|해도\s*(?:돼|될|되)",
    )
});
static TAIL: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(&format!("[{WS}.!~…ㅎㅋ👍]+$")).expect("tail"));
const KO_END: &str = r"\s*(?:해|했어|했음|했다|했습니다|할게|합니다|한다|함|하자|하세요|해\s*(?:줘|주세요|줄게)|시켜(?:\s*줘)?|부탁(?:해|합니다|드립니다|드려)?)(?:요)?";
/// `(?:승인|허락)(?:KO_END)?$` 를 그 자리에서 앞붙임으로 본다(앞 글자 거르기는 손으로).
static FINAL_GRANT_AT: LazyLock<Regex> =
    LazyLock::new(|| re(&format!(r"^(?:승인|허락)(?:{KO_END})?$")));
static FINAL_VERB: LazyLock<Regex> = LazyLock::new(|| re(&format!(r"(?:머지|진행){KO_END}$")));
static FINAL_APPROVE_EN: LazyLock<Regex> = LazyLock::new(|| {
    re(&format!(
        r"(?:^|{NW})approved?(?:\s+(?:it|this|that|them))?$"
    ))
});
static DENY_FINAL: LazyLock<Regex> = LazyLock::new(|| {
    re(&format!(
        r"(?:거절(?:{KO_END})?|(?:^|{NW})(?:deny|denied)(?:\s+(?:it|this|that|them))?)$"
    ))
});
static CI_WORD: LazyLock<Regex> =
    LazyLock::new(|| re(&format!(r"ci\s*무시|ignore\s*(?:the\s*)?ci(?:$|{NW})")));

const PICK_END: &str = r"(?:\s*(?:으로|로))?(?:\s*(?:해|해\s*줘|해\s*주세요|가자|갈게|하자|할게|합니다|진행해|진행|부탁해|부탁합니다|부탁드립니다|ㄱㄱ|고고))?(?:요)?";
static PICK_NUMBER: LazyLock<Regex> = LazyLock::new(|| {
    re(&format!(
        r"^(?:\(\s*([1-9])\s*\)|([1-9])\s*번?(?:\s*안)?){PICK_END}$"
    ))
});
static PICK_LETTER: LazyLock<Regex> = LazyLock::new(|| {
    re(&format!(
        r"^(?:\(\s*([가나다라마바])\s*\)|([가나다라마바])\s*안){PICK_END}$"
    ))
});
static PICK_RECOMMENDED: LazyLock<Regex> = LazyLock::new(|| {
    re(&format!(
        r"^(?:추천(?:대로|안|한\s*(?:것|거|대로|안))|as\s+recommended|recommended|go\s+with\s+(?:the\s+)?recommend(?:ed|ation)){PICK_END}$"
    ))
});
static PICK_END_ONLY: LazyLock<Regex> = LazyLock::new(|| re(&format!("{PICK_END}$")));
static WS_RUN: LazyLock<Regex> = LazyLock::new(|| re(r"\s+"));
static QUOTES: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r#"^[「『"'“‘]+|[」』"'”’]+$"#).expect("quotes"));
const LETTERS: [char; 6] = ['가', '나', '다', '라', '마', '바'];

/// 글 승인 판정이 **볼 수도 있는** 글을 가르는 넓은 체 — TS `CHAT_APPROVAL_GUARD_WORDS` 와 같은 목록.
pub const CHAT_APPROVAL_GUARD_WORDS: [&str; 11] = [
    "승인",
    "허락",
    "머지",
    "진행",
    "approve",
    "거절",
    "deny",
    "deni",
    "바이패스",
    "bypass",
    "harkroom://message/",
];

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ChatBlock {
    Negated,
    Question,
    Bypass,
    Conflict,
    NotFinal,
    DenyNotFinal,
}
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ChatAction {
    Approve,
    Deny,
}
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ChatApprovalParse {
    pub card_ids: Vec<String>,
    pub action: Option<ChatAction>,
    pub block: Option<ChatBlock>,
    pub ci_word: bool,
}

struct ChatBody {
    ids: Vec<String>,
    rest: String,
}

/// TS `readChatBody` — 인용·코드를 지우고, 카드 링크를 뽑고(마크다운 링크 먼저), 멘션·주소를 지운 뒤 소문자로. 2,000자 넘으면 None.
fn read_chat_body(body: &str) -> Option<ChatBody> {
    if utf16_len(body) > 2000 {
        return None;
    }
    let s = CODE_BLOCK.replace_all(body, " ");
    let s = CODE_INLINE.replace_all(&s, " ");
    let s = QUOTE_LINE.replace_all(&s, "${1} ");
    let mut ids = Vec::new();
    let mut take = |caps: &regex::Captures<'_>| {
        ids.push(caps[1].to_lowercase());
        " ".to_string()
    };
    let s = MD_MESSAGE_LINK.replace_all(&s, &mut take).into_owned();
    let s = MESSAGE_LINK.replace_all(&s, &mut take).into_owned();
    let s = MENTION_TOKEN.replace_all(&s, " ");
    let s = URL.replace_all(&s, "${1} ");
    Some(ChatBody {
        ids,
        rest: s.to_lowercase(),
    })
}

fn strip_tail(s: &str) -> std::borrow::Cow<'_, str> {
    TAIL.replace(s, "")
}

/// `(?<![미무불비])(?:승인|허락)` 자리마다 `at` 을 불러 하나라도 맞으면 true.
fn any_grant_word(s: &str, mut at: impl FnMut(usize) -> bool) -> bool {
    let mut prev: Option<char> = None;
    for (i, c) in s.char_indices() {
        let rest = &s[i..];
        if (rest.starts_with("승인") || rest.starts_with("허락"))
            && !matches!(prev, Some('미' | '무' | '불' | '비'))
            && at(i)
        {
            return true;
        }
        prev = Some(c);
    }
    false
}

fn approve_ko(s: &str) -> bool {
    APPROVE_KO_VERB.is_match(s)
        || any_grant_word(s, |i| {
            !APPROVE_KO_NOT_AFTER.is_match(&s[i + "승인".len()..])
        })
}
fn final_grant(s: &str) -> bool {
    any_grant_word(s, |i| FINAL_GRANT_AT.is_match(&s[i..]))
}
fn approve_final(s: &str) -> bool {
    final_grant(s) || FINAL_VERB.is_match(s) || FINAL_APPROVE_EN.is_match(s)
}
fn approve_explicit_final(s: &str) -> bool {
    final_grant(s) || FINAL_APPROVE_EN.is_match(s)
}

/// TS `isExplicitApproval` — 링크 없이도 승인으로 셀 꼴(n15).
pub fn is_explicit_approval(body: &str) -> bool {
    read_chat_body(body).is_some_and(|r| approve_explicit_final(&strip_tail(&r.rest)))
}

fn dedupe(ids: Vec<String>) -> Vec<String> {
    let mut out: Vec<String> = Vec::with_capacity(ids.len());
    for id in ids {
        if !out.contains(&id) {
            out.push(id);
        }
    }
    out
}

/// TS `parseChatApproval`.
pub fn parse_chat_approval(body: &str) -> Option<ChatApprovalParse> {
    let ChatBody { ids, rest } = read_chat_body(body)?;
    let approve = approve_ko(&rest) || APPROVE_EN.is_match(&rest);
    let deny = DENY.is_match(&rest);
    let bypass = BYPASS.is_match(&rest);
    let card_ids = dedupe(ids);
    if !approve && !deny && !bypass && card_ids.is_empty() {
        return None;
    }
    let mut block = None;
    if approve || deny || bypass {
        block = if bypass {
            Some(ChatBlock::Bypass)
        } else if QUESTION.is_match(&rest) {
            Some(ChatBlock::Question)
        } else if NEGATION.is_match(&rest) {
            Some(ChatBlock::Negated)
        } else if QUESTION_KO.is_match(&rest) {
            Some(ChatBlock::Question)
        } else if approve && deny {
            Some(ChatBlock::Conflict)
        } else {
            let tail = strip_tail(&rest);
            let fin = if approve {
                approve_final(&tail)
            } else {
                DENY_FINAL.is_match(&tail)
            };
            (!fin).then_some(if approve {
                ChatBlock::NotFinal
            } else {
                ChatBlock::DenyNotFinal
            })
        };
    }
    Some(ChatApprovalParse {
        card_ids,
        action: if approve {
            Some(ChatAction::Approve)
        } else if deny {
            Some(ChatAction::Deny)
        } else {
            None
        },
        block,
        ci_word: CI_WORD.is_match(&rest),
    })
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum AskPick {
    Index(usize),
    Recommended,
    Label { text: String, bare: String },
}
impl AskPick {
    /// 번호·추천은 명시적 고름(`explicit: true`), 이름은 아니다.
    pub fn explicit(&self) -> bool {
        !matches!(self, AskPick::Label { .. })
    }
}
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct AskPickParse {
    pub card_ids: Vec<String>,
    pub pick: AskPick,
}

/// TS `normLabel`.
pub fn norm_label(s: &str) -> String {
    let s = s.to_lowercase();
    let s = WS_RUN.replace_all(&s, " ");
    let s = strip_tail(&s);
    let s = QUOTES.replace_all(&s, "");
    js_trim(&s).to_string()
}

/// TS `parseAskPick`.
pub fn parse_ask_pick(body: &str) -> Option<AskPickParse> {
    let ChatBody { ids, rest } = read_chat_body(body)?;
    let collapsed = WS_RUN.replace_all(&rest, " ");
    let text = js_trim(&strip_tail(&collapsed)).to_string();
    if text.is_empty() || utf16_len(&text) > 200 {
        return None;
    }
    if QUESTION.is_match(&text)
        || NEGATION.is_match(&text)
        || QUESTION_KO.is_match(&text)
        || BYPASS.is_match(&text)
    {
        return None;
    }
    let card_ids = dedupe(ids);
    if let Some(c) = PICK_NUMBER.captures(&text) {
        let d = c.get(1).or_else(|| c.get(2))?.as_str();
        return Some(AskPickParse {
            card_ids,
            pick: AskPick::Index(d.parse().ok()?),
        });
    }
    if let Some(c) = PICK_LETTER.captures(&text) {
        let l = c.get(1).or_else(|| c.get(2))?.as_str().chars().next()?;
        let n = LETTERS.iter().position(|x| *x == l)? + 1;
        return Some(AskPickParse {
            card_ids,
            pick: AskPick::Index(n),
        });
    }
    if PICK_RECOMMENDED.is_match(&text) {
        return Some(AskPickParse {
            card_ids,
            pick: AskPick::Recommended,
        });
    }
    let bare = norm_label(&PICK_END_ONLY.replace(&text, ""));
    Some(AskPickParse {
        card_ids,
        pick: AskPick::Label {
            text: norm_label(&text),
            bare,
        },
    })
}

pub struct AskOptionRef<'a> {
    pub id: &'a str,
    pub label: &'a str,
    pub recommended: bool,
}
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum AskNoPick {
    NoMatch,
    NoRecommended,
}

/// TS `matchAskPick` — 선택지 **하나**에 맞을 때만 고른다.
pub fn match_ask_pick<'a>(
    options: &[AskOptionRef<'a>],
    pick: &AskPick,
) -> Result<&'a str, AskNoPick> {
    match pick {
        AskPick::Index(n) => n
            .checked_sub(1)
            .and_then(|i| options.get(i))
            .map(|o| o.id)
            .ok_or(AskNoPick::NoMatch),
        AskPick::Recommended => {
            let recs: Vec<_> = options.iter().filter(|o| o.recommended).collect();
            if recs.len() == 1 {
                Ok(recs[0].id)
            } else {
                Err(AskNoPick::NoRecommended)
            }
        }
        AskPick::Label { text, bare } => {
            let hits: Vec<_> = options
                .iter()
                .filter(|o| {
                    let l = norm_label(o.label);
                    !l.is_empty() && (&l == text || &l == bare)
                })
                .collect();
            if hits.len() == 1 {
                Ok(hits[0].id)
            } else {
                Err(AskNoPick::NoMatch)
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn act(s: &str) -> Option<(Option<ChatAction>, Option<ChatBlock>)> {
        parse_chat_approval(s).map(|p| (p.action, p.block))
    }
    const A: Option<ChatAction> = Some(ChatAction::Approve);

    #[test]
    fn approve_basic() {
        assert_eq!(act("승인"), Some((A, None)));
        assert_eq!(act("승인해"), Some((A, None)));
        assert_eq!(act("ok 승인합니다!"), Some((A, None)));
        assert_eq!(act("approve"), Some((A, None)));
        assert_eq!(act("머지해"), Some((A, None)));
        assert_eq!(act("hello"), None);
    }
    #[test]
    fn approve_lookarounds() {
        // 「미승인」은 승인 낱말이 아니다 — 다른 낱말도 없으니 null.
        assert_eq!(act("미승인"), None);
        // 「승인 요청」은 승인 낱말이 아니다.
        assert_eq!(act("승인 요청 왔네"), None);
        // 앞의 「미승인」은 거르고 뒤의 「승인」은 센다.
        assert_eq!(act("미승인 건 승인"), Some((A, None)));
    }
    #[test]
    fn blocks() {
        assert_eq!(act("승인할까?"), Some((A, Some(ChatBlock::Question))));
        assert_eq!(act("승인할까"), Some((A, Some(ChatBlock::Question))));
        assert_eq!(act("승인하지 마"), Some((A, Some(ChatBlock::Negated))));
        assert_eq!(act("승인 안 해"), Some((A, Some(ChatBlock::Negated))));
        assert_eq!(act("바이패스 승인"), Some((A, Some(ChatBlock::Bypass))));
        assert_eq!(act("승인 거절"), Some((A, Some(ChatBlock::Conflict))));
        assert_eq!(act("승인 노"), Some((A, Some(ChatBlock::NotFinal))));
        assert_eq!(
            act("거절 이유는"),
            Some((Some(ChatAction::Deny), Some(ChatBlock::DenyNotFinal)))
        );
        assert_eq!(act("deny"), Some((Some(ChatAction::Deny), None)));
    }
    #[test]
    fn ascii_word_boundary() {
        // JS `\b` 는 ASCII 기준 — 한글 바로 뒤의 approve 도 낱말이다.
        assert_eq!(act("승인approve").map(|x| x.0), Some(A));
        assert_eq!(act("disapproves"), None);
        assert_eq!(act("not approve"), Some((A, Some(ChatBlock::Negated))));
    }
    #[test]
    fn quotes_code_links() {
        let id = "0b9d1c3e-1111-4222-8333-944455556666";
        assert_eq!(act("> 승인\n좋아"), None);
        assert_eq!(act("`승인`"), None);
        let p = parse_chat_approval(&format!(
            "[카드](harkroom://message/{id}) harkroom://message/{} 승인",
            id.to_uppercase()
        ))
        .unwrap();
        assert_eq!(p.card_ids, vec![id.to_string()]);
        assert_eq!(p.block, None);
        assert!(
            parse_chat_approval(&format!("CI 무시하고 승인 harkroom://message/{id}"))
                .unwrap()
                .ci_word
        );
        assert_eq!(parse_chat_approval(&"가".repeat(2001)), None);
    }
    #[test]
    fn explicit() {
        assert!(is_explicit_approval("승인"));
        assert!(is_explicit_approval("approve it"));
        assert!(!is_explicit_approval("진행해"));
        assert!(!is_explicit_approval("머지해"));
    }
    #[test]
    fn ask_pick() {
        let p = |s: &str| parse_ask_pick(s).map(|x| x.pick);
        assert_eq!(p("1"), Some(AskPick::Index(1)));
        assert_eq!(p("2번으로 해"), Some(AskPick::Index(2)));
        assert_eq!(p("(3)"), Some(AskPick::Index(3)));
        assert_eq!(p("나안"), Some(AskPick::Index(2)));
        assert_eq!(p("추천대로 가자"), Some(AskPick::Recommended));
        assert_eq!(p("1번 말고"), None);
        assert_eq!(p("1번?"), None);
        // 「보류」는 NEGATION 낱말이라 TS 처럼 답으로 읽지 않는다.
        assert_eq!(p("「보류」로 해"), None);
        assert_eq!(
            p("「a안」으로 해"),
            Some(AskPick::Label {
                text: "a안」으로 해".into(),
                bare: "a안".into()
            })
        );
        let opts = [
            AskOptionRef {
                id: "a",
                label: "A안",
                recommended: false,
            },
            AskOptionRef {
                id: "b",
                label: "보류",
                recommended: true,
            },
        ];
        assert_eq!(match_ask_pick(&opts, &AskPick::Index(2)), Ok("b"));
        assert_eq!(
            match_ask_pick(&opts, &AskPick::Index(3)),
            Err(AskNoPick::NoMatch)
        );
        assert_eq!(match_ask_pick(&opts, &AskPick::Recommended), Ok("b"));
        assert_eq!(
            match_ask_pick(&opts, &p("「A안」으로 해").unwrap()),
            Ok("a")
        );
        assert_eq!(match_ask_pick(&opts, &p("a안").unwrap()), Ok("a"));
    }

    /// P3b-1b 골든 대조 — TS 가 낸 출력(`packages/server/test/fixtures/chat-parse-golden.json`)과 같은지 본다.
    /// TS 쪽 `chatParseGolden.test.ts` 가 같은 파일이 지금 TS 와 같은지 지키므로, 둘이 함께 초록이면 두 구현이 같다.
    fn golden() -> serde_json::Value {
        let p = std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
            .join("../../packages/server/test/fixtures/chat-parse-golden.json");
        serde_json::from_str(&std::fs::read_to_string(&p).expect("golden fixture")).expect("json")
    }

    fn approval_json(p: &ChatApprovalParse) -> serde_json::Value {
        let block = p.block.map(|b| match b {
            ChatBlock::Negated => "negated",
            ChatBlock::Question => "question",
            ChatBlock::Bypass => "bypass",
            ChatBlock::Conflict => "conflict",
            ChatBlock::NotFinal => "notFinal",
            ChatBlock::DenyNotFinal => "denyNotFinal",
        });
        let action = p.action.map(|a| match a {
            ChatAction::Approve => "approve",
            ChatAction::Deny => "deny",
        });
        serde_json::json!({ "cardIds": p.card_ids, "action": action, "block": block, "ciWord": p.ci_word })
    }

    fn pick_json(p: &AskPickParse) -> serde_json::Value {
        let pick = match &p.pick {
            AskPick::Index(n) => serde_json::json!({ "kind": "index", "n": n, "explicit": true }),
            AskPick::Recommended => serde_json::json!({ "kind": "recommended", "explicit": true }),
            AskPick::Label { text, bare } => {
                serde_json::json!({ "kind": "label", "text": text, "bare": bare, "explicit": false })
            }
        };
        serde_json::json!({ "cardIds": p.card_ids, "pick": pick })
    }

    #[test]
    fn golden_matches_ts() {
        let g = golden();
        let mut bad = Vec::new();
        for c in g["chatApproval"].as_array().unwrap() {
            let body = c["body"].as_str().unwrap();
            let got = parse_chat_approval(body)
                .as_ref()
                .map_or(serde_json::Value::Null, approval_json);
            if got != c["want"] {
                bad.push(format!("approval {body:?}: rust={got} ts={}", c["want"]));
            }
            if is_explicit_approval(body) != c["explicit"].as_bool().unwrap() {
                bad.push(format!("explicit {body:?}"));
            }
        }
        let opts_v = g["askOptions"].as_array().unwrap();
        let opts: Vec<AskOptionRef> = opts_v
            .iter()
            .map(|o| AskOptionRef {
                id: o["id"].as_str().unwrap(),
                label: o["label"].as_str().unwrap(),
                recommended: o["recommended"].as_bool().unwrap_or(false),
            })
            .collect();
        for c in g["askPick"].as_array().unwrap() {
            let body = c["body"].as_str().unwrap();
            let p = parse_ask_pick(body);
            let got = p.as_ref().map_or(serde_json::Value::Null, pick_json);
            if got != c["want"] {
                bad.push(format!("pick {body:?}: rust={got} ts={}", c["want"]));
            }
            let m = p.map(|p| match match_ask_pick(&opts, &p.pick) {
                Ok(id) => id.to_string(),
                Err(AskNoPick::NoMatch) => "askNoMatch".into(),
                Err(AskNoPick::NoRecommended) => "askNoRecommended".into(),
            });
            if serde_json::json!(m) != c["match"] {
                bad.push(format!("match {body:?}: rust={m:?} ts={}", c["match"]));
            }
        }
        assert!(
            bad.is_empty(),
            "{} mismatches:\n{}",
            bad.len(),
            bad.join("\n")
        );
    }
}
