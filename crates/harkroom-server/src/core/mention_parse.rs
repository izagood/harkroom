//! S5.3 C3a-3a — 본문 멘션 파싱(DB 없음). 정본은 TS `packages/shared/src/index.ts` 의 `splitCode`·`mentionRegions`·`mentionScanText`·
//! `mentionedHandles`·`mentionedIds`·`mentionedTargets`·`headMentionRunEnd`·`splitMentionCalls`·`normalizeMentions`·`denormalizeMentions`
//! 이고, 여기는 그 포트다. 규칙을 새로 정하지 않는다 — 같은 본문에 같은 답을 내는지는 `golden/mention_parse.json`(TS 가 만든 결과,
//! `packages/server/test/rustMentionParseGolden.test.ts`)과 대조하는 시험이 본다.
//!
//! 포트에서 갈라지기 쉬운 자리:
//! - **위치 단위.** TS 는 UTF-16 칸, 여기는 UTF-8 바이트다. 위치는 밖으로 내보내지 않고 같은 본문 안의 앞뒤 비교·자르기에만 쓰므로
//!   답이 같다(시험은 위치 대신 그 위치로 자른 글자를 대조한다).
//! - **JS `\s`.** Rust 의 `\s`(유니코드 White_Space)와 집합이 다르다(U+FEFF·U+0085). JS 집합을 [`JS_WS`] 로 그대로 적는다.
//! - **JS `.`.** 줄 끝 문자(`\r`·U+2028·U+2029)를 넘지 않는다 — CRLF 본문의 `> 인용\r` 줄은 TS 에서 인용이 아니다. 그대로 따른다.
//! - **룩어라운드.** `regex` crate 에 없어서 인라인 코드(`` (?<!`)`…`(?!`) ``)는 손으로 훑는다.
//! - **링크 판정.** `new URL()` 은 WHATWG 파서라 같은 파서인 `url` crate 로 본다.
use regex::{Captures, Regex};
use std::collections::HashMap;
use std::sync::LazyLock;

/// JS 정규식 `\s` 의 집합(ECMAScript WhiteSpace + LineTerminator).
pub(crate) const JS_WS: &str = r"\t\n\x0B\x0C\r \x{A0}\x{1680}\x{2000}-\x{200A}\x{2028}\x{2029}\x{202F}\x{205F}\x{3000}\x{FEFF}";
/// TS `HANDLE_PATTERN`.
const HANDLE: &str = "[a-zA-Z0-9_-]{2,32}";
/// TS `MESSAGE_PERMALINK_PREFIX`.
pub const MESSAGE_PERMALINK_PREFIX: &str = "harkroom://message/";

fn re(src: &str) -> Regex {
    Regex::new(src).expect("mention_parse regex")
}

/// TS `MENTION_PATTERN`.
static MENTION: LazyLock<Regex> = LazyLock::new(|| re(&format!("(^|[^a-zA-Z0-9_-])@({HANDLE})")));
/// TS `MENTION_TOKEN_PATTERN`.
static ACCOUNT_TOKEN: LazyLock<Regex> = LazyLock::new(|| re("<@([0-9a-f-]{36})>"));
/// TS `MENTION_TARGET_TOKEN_PATTERN`.
static TARGET_TOKEN: LazyLock<Regex> = LazyLock::new(|| re("<@((?:group|team):[0-9a-f-]{36})>"));
/// TS `ANY_MENTION_TOKEN_PATTERN` — 접두가 붙은 쪽이 먼저다(TS 주석과 같은 이유).
static ANY_TOKEN: LazyLock<Regex> =
    LazyLock::new(|| re("<@((?:group|team):[0-9a-f-]{36})>|<@([0-9a-f-]{36})>"));
/// TS `headMentionRunEnd` 의 sticky 한 걸음 — `^` 를 남은 본문 머리에 건다.
static HEAD_STEP: LazyLock<Regex> = LazyLock::new(|| {
    re(&format!(
        "^[{JS_WS}]*(?:<@(?:group|team):[0-9a-f-]{{36}}>|<@[0-9a-f-]{{36}}>|@{HANDLE})"
    ))
});
/// TS `URL_CANDIDATE_SOURCE`.
static URL_CANDIDATE: LazyLock<Regex> =
    LazyLock::new(|| re(&format!("[a-zA-Z][a-zA-Z0-9+.-]*:[^{JS_WS}]+")));
/// TS `QUOTE_LINE`(`.` 은 JS 의 줄 끝 문자를 넘지 않는다).
static QUOTE_LINE: LazyLock<Regex> =
    LazyLock::new(|| re(r"^ {0,3}>[ \t]?[^\n\r\x{2028}\x{2029}]*$"));
/// TS `FENCE_LINE`.
static FENCE_LINE: LazyLock<Regex> = LazyLock::new(|| re("^[ \t]*```([^\n`]*)$"));
/// TS `parseMessagePermalink` 의 uuid.
static UUID: LazyLock<Regex> = LazyLock::new(|| {
    re("^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$")
});

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

/// JS `String.prototype.trim`.
fn js_trim(s: &str) -> &str {
    s.trim_matches(is_js_ws)
}

/// TS `CodeSegment`. 위치는 원문의 바이트 위치다.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum CodeSegment<'a> {
    Plain {
        text: &'a str,
        start: usize,
    },
    InlineCode {
        code: &'a str,
        start: usize,
        end: usize,
    },
    CodeBlock {
        code: &'a str,
        lang: Option<&'a str>,
        start: usize,
        end: usize,
    },
}

/// TS `splitInline` — `` (?<!`)`([^`\n]+)`(?!`) `` 를 손으로 훑는다. 안쪽은 백틱·개행이 없는 최장 구간이라 되짚기가 답을 바꾸지 않는다.
fn split_inline<'a>(text: &'a str, out: &mut Vec<CodeSegment<'a>>, offset: usize) {
    let b = text.as_bytes();
    let (mut cursor, mut i) = (0usize, 0usize);
    while i < b.len() {
        if b[i] == b'`' && (i == 0 || b[i - 1] != b'`') {
            let mut j = i + 1;
            while j < b.len() && b[j] != b'`' && b[j] != b'\n' {
                j += 1;
            }
            if j > i + 1 && j < b.len() && b[j] == b'`' && b.get(j + 1) != Some(&b'`') {
                if i > cursor {
                    out.push(CodeSegment::Plain {
                        text: &text[cursor..i],
                        start: offset + cursor,
                    });
                }
                out.push(CodeSegment::InlineCode {
                    code: &text[i + 1..j],
                    start: offset + i,
                    end: offset + j + 1,
                });
                cursor = j + 1;
                i = j + 1;
                continue;
            }
        }
        i += 1;
    }
    if cursor < text.len() {
        out.push(CodeSegment::Plain {
            text: &text[cursor..],
            start: offset + cursor,
        });
    }
}

/// TS `splitCode` — 닫히지 않은 펜스는 코드가 아니다.
pub fn split_code<'a>(body: &'a str) -> Vec<CodeSegment<'a>> {
    let lines: Vec<&str> = body.split('\n').collect();
    let mut line_start = Vec::with_capacity(lines.len());
    let mut at = 0usize;
    for l in &lines {
        line_start.push(at);
        at += l.len() + 1;
    }
    let line_end = |k: usize| line_start[k] + lines[k].len();
    let mut out = vec![];
    let mut plain_from = 0usize;
    let mut i = 0usize;
    let flush = |until: usize, plain_from: usize, out: &mut Vec<CodeSegment<'a>>| {
        if until > plain_from {
            let s = line_start[plain_from];
            split_inline(&body[s..line_end(until - 1)], out, s);
        }
    };
    while i < lines.len() {
        let Some(open) = FENCE_LINE.captures(lines[i]) else {
            i += 1;
            continue;
        };
        let Some(close) = (i + 1..lines.len()).find(|&j| FENCE_LINE.is_match(lines[j])) else {
            i += 1;
            continue;
        };
        flush(i, plain_from, &mut out);
        let lang = js_trim(open.get(1).map_or("", |m| m.as_str()));
        let code = if close > i + 1 {
            &body[line_start[i + 1]..line_end(close - 1)]
        } else {
            ""
        };
        out.push(CodeSegment::CodeBlock {
            code,
            lang: (!lang.is_empty()).then_some(lang),
            start: line_start[i],
            end: line_end(close),
        });
        i = close + 1;
        plain_from = i;
    }
    flush(lines.len(), plain_from, &mut out);
    if out.is_empty() {
        out.push(CodeSegment::Plain {
            text: body,
            start: 0,
        });
    }
    out
}

/// TS `trimTrailingPunctuation`.
pub fn trim_trailing_punctuation(token: &str) -> &str {
    let b = token.as_bytes();
    let mut end = b.len();
    while end > 0 {
        let ch = b[end - 1];
        if b".,;:!?'\"".contains(&ch) {
            end -= 1;
            continue;
        }
        if ch == b')' || ch == b']' {
            let open = if ch == b')' { b'(' } else { b'[' };
            let slice = &b[..end];
            let count = |c: u8| slice.iter().filter(|&&x| x == c).count();
            if count(open) <= count(ch) {
                end -= 1;
                continue;
            }
        }
        break;
    }
    &token[..end]
}

/// TS `parseMessagePermalink`.
pub fn parse_message_permalink(text: &str) -> Option<&str> {
    let id = js_trim(text).strip_prefix(MESSAGE_PERMALINK_PREFIX)?;
    UUID.is_match(id).then_some(id)
}

/// TS `isDrawnLink` — 화면이 링크로 칠하는 글자인가(`LINK_SCHEMES` = http·https).
pub fn is_drawn_link(token: &str) -> bool {
    if parse_message_permalink(token).is_some() {
        return true;
    }
    url::Url::parse(js_trim(token)).is_ok_and(|u| matches!(u.scheme(), "http" | "https"))
}

/// TS `linkSpans` — 링크로 그려지는 구간(멘션을 찾지 않는다).
fn link_spans(body: &str) -> Vec<(usize, usize)> {
    URL_CANDIDATE
        .find_iter(body)
        .filter_map(|m| {
            let token = trim_trailing_punctuation(m.as_str());
            (!token.is_empty() && is_drawn_link(token))
                .then(|| (m.start(), m.start() + token.len()))
        })
        .collect()
}

/// TS `mentionRegions` — 코드·인용 줄·링크를 뺀, 멘션을 찾을 구간과 원문 위치.
pub fn mention_regions(body: &str) -> Vec<(&str, usize)> {
    let mut cut = vec![];
    let mut at = 0usize;
    for line in body.split('\n') {
        if QUOTE_LINE.is_match(line) {
            cut.push((at, at + line.len()));
        }
        at += line.len() + 1;
    }
    cut.extend(link_spans(body));
    cut.sort_by_key(|c| c.0);
    let mut skip: Vec<(usize, usize)> = vec![];
    for (s, e) in cut {
        match skip.last_mut() {
            Some(last) if s <= last.1 => last.1 = last.1.max(e),
            _ => skip.push((s, e)),
        }
    }
    let mut out = vec![];
    for seg in split_code(body) {
        let CodeSegment::Plain { text, start } = seg else {
            continue;
        };
        let end = start + text.len();
        let mut cursor = start;
        for &(qs, qe) in &skip {
            if qe <= cursor || qs >= end {
                continue;
            }
            if qs > cursor {
                out.push((&body[cursor..qs], cursor));
            }
            cursor = cursor.max(end.min(qe));
        }
        if cursor < end {
            out.push((&body[cursor..end], cursor));
        }
    }
    out
}

/// TS `mentionScanText`.
pub fn mention_scan_text(body: &str) -> String {
    mention_regions(body)
        .iter()
        .map(|r| r.0)
        .collect::<Vec<_>>()
        .join("\n")
}

fn push_unique(v: &mut Vec<String>, s: &str) {
    if !v.iter().any(|x| x == s) {
        v.push(s.to_string());
    }
}

/// TS `mentionedHandles` — 소문자·중복 없음·처음 나온 순서.
pub fn mentioned_handles(body: &str) -> Vec<String> {
    let mut out = vec![];
    for c in MENTION.captures_iter(&mention_scan_text(body)) {
        push_unique(&mut out, &c[2].to_ascii_lowercase());
    }
    out
}

/// TS `mentionedIds` — 저장된 `<@id>`(계정만), 본문 전체에서.
pub fn mentioned_ids(body: &str) -> Vec<String> {
    let mut out = vec![];
    for c in ACCOUNT_TOKEN.captures_iter(body) {
        push_unique(&mut out, &c[1]);
    }
    out
}

/// TS `MentionTargetKind`.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum TargetKind {
    Group,
    Team,
}

impl TargetKind {
    pub fn as_str(self) -> &'static str {
        match self {
            TargetKind::Group => "group",
            TargetKind::Team => "team",
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Target {
    pub kind: TargetKind,
    pub id: String,
}

/// `group:<uuid>`·`team:<uuid>` 를 가른다(정규식이 이미 모양을 보장한다).
fn parse_target(key: &str) -> Option<Target> {
    let (kind, id) = key.split_once(':')?;
    let kind = match kind {
        "group" => TargetKind::Group,
        "team" => TargetKind::Team,
        _ => return None,
    };
    Some(Target {
        kind,
        id: id.to_string(),
    })
}

fn push_target(v: &mut Vec<Target>, t: Target) {
    if !v.contains(&t) {
        v.push(t);
    }
}

/// TS `mentionedTargets` — 저장된 집합·팀 토큰, 본문 전체에서.
pub fn mentioned_targets(body: &str) -> Vec<Target> {
    let mut out = vec![];
    for c in TARGET_TOKEN.captures_iter(body) {
        if let Some(t) = parse_target(&c[1]) {
            push_target(&mut out, t);
        }
    }
    out
}

/// TS `headMentionRunEnd` — 머리 멘션 런의 끝(바이트 위치).
pub fn head_mention_run_end(body: &str) -> usize {
    let mut end = 0usize;
    while let Some(m) = HEAD_STEP.find(&body[end..]) {
        end += m.end();
    }
    end
}

/// TS `splitMentionCalls` 의 결과.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct MentionSplit {
    pub call: Vec<String>,
    pub reference: Vec<String>,
    pub target_call: Vec<Target>,
    pub target_ref: Vec<Target>,
}

/// TS `splitMentionCalls` — 작성자가 에이전트이고 대상도 에이전트(팀 포함)면 머리 런 안의 멘션만 부름이다. 집합은 사람이라 언제나 부름.
/// `is_agent` 는 모르면 `false`(사람으로 보고 막지 않는다).
pub fn split_mention_calls(
    body: &str,
    author_is_agent: bool,
    is_agent: impl Fn(&str) -> bool,
) -> MentionSplit {
    let head_end = head_mention_run_end(body);
    let mut s = MentionSplit::default();
    for (text, start) in mention_regions(body) {
        for c in ACCOUNT_TOKEN.captures_iter(text) {
            let id = &c[1];
            let at = start + c.get(0).map_or(0, |m| m.start());
            if !author_is_agent || !is_agent(id) || at < head_end {
                push_unique(&mut s.call, id);
            } else {
                push_unique(&mut s.reference, id);
            }
        }
        for c in TARGET_TOKEN.captures_iter(text) {
            let Some(t) = parse_target(&c[1]) else {
                continue;
            };
            let at = start + c.get(0).map_or(0, |m| m.start());
            if !author_is_agent || t.kind == TargetKind::Group || at < head_end {
                push_target(&mut s.target_call, t);
            } else {
                push_target(&mut s.target_ref, t);
            }
        }
    }
    // 한 번이라도 부르면 부름이다.
    let call = s.call.clone();
    s.reference.retain(|id| !call.contains(id));
    let target_call = s.target_call.clone();
    s.target_ref.retain(|t| !target_call.contains(t));
    s
}

/// TS `normalizeMentions` — 있는 handle 만 `<@값>` 으로(값은 계정 id 또는 `group:<id>`·`team:<id>`). 코드·인용·링크 안은 그대로.
/// `accounts` 키는 소문자 handle.
pub fn normalize_mentions(body: &str, accounts: &HashMap<String, String>) -> String {
    if accounts.is_empty() {
        return body.to_string();
    }
    let mut out = body.to_string();
    // 뒤에서부터 고친다 — 앞에서 고치면 뒤 조각의 원문 위치가 밀린다.
    for (text, start) in mention_regions(body).into_iter().rev() {
        let replaced = MENTION.replace_all(text, |c: &Captures| {
            match accounts.get(&c[2].to_ascii_lowercase()) {
                Some(id) => format!("{}<@{id}>", &c[1]),
                None => c[0].to_string(),
            }
        });
        if replaced != text {
            out.replace_range(start..start + text.len(), &replaced);
        }
    }
    out
}

/// shared `UNKNOWN_ACCOUNT_LABEL` — 지금 이름으로 못 바꾼 토큰 자리.
pub const UNKNOWN_ACCOUNT_LABEL: &str = "알 수 없음";

/// 본문의 저장 토큰 키(계정 id·`group:<id>`·`team:<id>`)를 나온 순서대로 — TS `handlesFor` 의 `ANY_MENTION_TOKEN_PATTERN` 훑기.
pub fn mention_token_keys(body: &str) -> Vec<String> {
    ANY_TOKEN
        .captures_iter(body)
        .filter_map(|c| {
            c.get(1)
                .or_else(|| c.get(2))
                .map(|m| m.as_str().to_string())
        })
        .filter(|k| !k.is_empty())
        .collect()
}

/// TS `normalizeSearchQuery` — 질의의 `@handle` 을 본문 저장과 같은 토큰으로(계정 > 집합 > 팀). 손잡이가 없으면 그대로.
/// 권한: `account.{id,handle}`·`handle_group.{id,handle}`·`agent_team.{id,name}` SELECT.
pub async fn normalize_search_query(db: &sqlx::PgPool, query: &str) -> sqlx::Result<String> {
    let handles = mentioned_handles(query);
    if handles.is_empty() {
        return Ok(query.to_string());
    }
    let mut map: HashMap<String, String> = HashMap::new();
    let rows: Vec<(String, String)> =
        sqlx::query_as("select id::text, lower(handle) from account where lower(handle) = any($1)")
            .bind(&handles)
            .fetch_all(db)
            .await?;
    map.extend(rows.into_iter().map(|(id, h)| (h, id)));
    let rest: Vec<String> = handles
        .into_iter()
        .filter(|h| !map.contains_key(h))
        .collect();
    if !rest.is_empty() {
        let groups: Vec<(String, String)> = sqlx::query_as(
            "select id::text, lower(handle) from handle_group where lower(handle) = any($1)",
        )
        .bind(&rest)
        .fetch_all(db)
        .await?;
        for (id, h) in groups {
            map.insert(h, format!("group:{id}"));
        }
        let teams: Vec<(String, String)> = sqlx::query_as(
            "select id::text, lower(name) from agent_team where lower(name) = any($1)",
        )
        .bind(&rest)
        .fetch_all(db)
        .await?;
        for (id, n) in teams {
            map.entry(n).or_insert_with(|| format!("team:{id}"));
        }
    }
    Ok(normalize_mentions(query, &map))
}

/// TS `renderMentions` — 저장된 토큰을 지금 handle 로, 모르는 것은 `@알 수 없음`([`UNKNOWN_ACCOUNT_LABEL`]).
pub fn render_mentions(body: &str, id_to_handle: &HashMap<String, String>) -> String {
    ANY_TOKEN
        .replace_all(body, |c: &Captures| {
            let key = c.get(1).or_else(|| c.get(2)).map_or("", |m| m.as_str());
            match id_to_handle.get(key) {
                Some(h) if !h.is_empty() => format!("@{h}"),
                _ => format!("@{UNKNOWN_ACCOUNT_LABEL}"),
            }
        })
        .into_owned()
}

/// TS `denormalizeMentions` — 저장된 토큰을 지금 handle 로(모르는 id 는 그대로). 키는 계정 id 또는 `team:<id>`·`group:<id>`.
pub fn denormalize_mentions(body: &str, id_to_handle: &HashMap<String, String>) -> String {
    ANY_TOKEN
        .replace_all(body, |c: &Captures| {
            let key = c.get(1).or_else(|| c.get(2)).map_or("", |m| m.as_str());
            match id_to_handle.get(key) {
                Some(h) => format!("@{h}"),
                None => c[0].to_string(),
            }
        })
        .into_owned()
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::Value;

    fn strs(v: &Value) -> Vec<String> {
        v.as_array()
            .unwrap()
            .iter()
            .map(|x| x.as_str().unwrap().to_string())
            .collect()
    }

    fn targets(v: &Value) -> Vec<(String, String)> {
        v.as_array()
            .unwrap()
            .iter()
            .map(|t| {
                (
                    t["kind"].as_str().unwrap().to_string(),
                    t["id"].as_str().unwrap().to_string(),
                )
            })
            .collect()
    }

    fn mine(ts: &[Target]) -> Vec<(String, String)> {
        ts.iter()
            .map(|t| (t.kind.as_str().to_string(), t.id.clone()))
            .collect()
    }

    fn segment_json<'a>(
        body: &'a str,
        s: &CodeSegment<'a>,
    ) -> (String, String, Option<String>, String) {
        match *s {
            CodeSegment::Plain { text, start } => (
                "plain".into(),
                text.into(),
                None,
                body[start..start + text.len()].into(),
            ),
            CodeSegment::InlineCode { code, start, end } => (
                "inlineCode".into(),
                code.into(),
                None,
                body[start..end].into(),
            ),
            CodeSegment::CodeBlock {
                code,
                lang,
                start,
                end,
            } => (
                "codeBlock".into(),
                code.into(),
                lang.map(str::to_string),
                body[start..end].into(),
            ),
        }
    }

    /// TS 가 만든 `golden/mention_parse.json` 과 한 줄씩 대조한다.
    #[test]
    fn matches_ts_golden() {
        let g: Value = serde_json::from_str(include_str!("../../golden/mention_parse.json"))
            .expect("golden/mention_parse.json");
        let map: HashMap<String, String> = g["accounts"]
            .as_object()
            .unwrap()
            .iter()
            .map(|(k, v)| (k.clone(), v.as_str().unwrap().to_string()))
            .collect();
        let id_to_handle: HashMap<String, String> =
            map.iter().map(|(k, v)| (v.clone(), k.clone())).collect();
        let agents = strs(&g["agents"]);
        let cases = g["cases"].as_array().unwrap();
        assert!(cases.len() >= 40, "golden too small");
        for c in cases {
            let body = c["body"].as_str().unwrap();
            let ctx = format!("body={body:?}");
            let segs: Vec<_> = split_code(body)
                .iter()
                .map(|s| segment_json(body, s))
                .collect();
            let want: Vec<_> = c["segments"]
                .as_array()
                .unwrap()
                .iter()
                .map(|s| {
                    (
                        s["kind"].as_str().unwrap().to_string(),
                        s["text"].as_str().unwrap().to_string(),
                        s["lang"].as_str().map(str::to_string),
                        s["raw"].as_str().unwrap().to_string(),
                    )
                })
                .collect();
            assert_eq!(segs, want, "segments {ctx}");
            assert_eq!(
                mention_scan_text(body),
                c["scanText"].as_str().unwrap(),
                "scanText {ctx}"
            );
            assert_eq!(
                mentioned_handles(body),
                strs(&c["handles"]),
                "handles {ctx}"
            );
            assert_eq!(mentioned_ids(body), strs(&c["ids"]), "ids {ctx}");
            assert_eq!(
                mine(&mentioned_targets(body)),
                targets(&c["targets"]),
                "targets {ctx}"
            );
            assert_eq!(
                &body[..head_mention_run_end(body)],
                c["head"].as_str().unwrap(),
                "head {ctx}"
            );
            let normalized = normalize_mentions(body, &map);
            assert_eq!(
                normalized,
                c["normalized"].as_str().unwrap(),
                "normalized {ctx}"
            );
            assert_eq!(
                denormalize_mentions(&normalized, &id_to_handle),
                c["denormalized"].as_str().unwrap(),
                "denormalized {ctx}"
            );
            for (key, author_is_agent) in [("splitHuman", false), ("splitAgent", true)] {
                let s = split_mention_calls(&normalized, author_is_agent, |id| {
                    agents.iter().any(|a| a == id)
                });
                let w = &c[key];
                assert_eq!(s.call, strs(&w["call"]), "{key}.call {ctx}");
                assert_eq!(s.reference, strs(&w["ref"]), "{key}.ref {ctx}");
                assert_eq!(
                    mine(&s.target_call),
                    targets(&w["targetCall"]),
                    "{key}.targetCall {ctx}"
                );
                assert_eq!(
                    mine(&s.target_ref),
                    targets(&w["targetRef"]),
                    "{key}.targetRef {ctx}"
                );
            }
        }
    }

    #[test]
    fn empty_accounts_returns_body_unchanged() {
        assert_eq!(
            normalize_mentions("@forge hi", &HashMap::new()),
            "@forge hi"
        );
    }

    /// TS 가 내는 값 그대로다(같은 세 입력을 TS 로 돌려 얻음). 짝이 맞는 `)` 도 떼는 것은 TS 의 지금 동작이고, 포트는 따른다.
    #[test]
    fn trailing_punctuation_follows_ts() {
        assert_eq!(
            trim_trailing_punctuation("https://a.io/b)."),
            "https://a.io/b"
        );
        assert_eq!(
            trim_trailing_punctuation("https://w.org/A_(b)"),
            "https://w.org/A_(b"
        );
        assert_eq!(
            trim_trailing_punctuation("https://w.org/A_((b)"),
            "https://w.org/A_((b)"
        );
    }
}
