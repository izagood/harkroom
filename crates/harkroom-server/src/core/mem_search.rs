//! S5.3 C4b B1c — `memory.search` 의 순수 판정(낱말 뽑기·recall 순위). TS 정본은 `services/memory.ts` 의
//! `searchTerms`·`normalizeTerm`·`focusTermsOf`·`excludedNamesFrom`·`rankRecall` 과 shared `isThreadStateSlug` 다.
//! 같은 입력에 같은 답을 내는지는 `golden/memory_search.json`(TS 가 만든 결과, `scripts/genRustMemorySearchGolden.ts`)이 고정한다.
//!
//! JS 와 갈리는 곳을 맞춘 것:
//! - JS `\s`(u 플래그)는 Unicode White_Space 와 다르다 — U+FEFF 를 넣고 U+0085 를 뺀다([`JS_WS`]).
//! - JS `\d` 는 ASCII 숫자뿐이다 → `[0-9]`.
//! - `length` 는 UTF-16 단위다 → [`js_len`].
//! - `(?<![a-z0-9])t(?![a-z0-9])` 는 regex 크레이트에 없는 lookaround 라 손으로 센다([`count_short_ascii`]).
use regex::Regex;
use std::collections::HashSet;
use std::sync::LazyLock;

/// JS `\s`(u 플래그) — WhiteSpace + LineTerminator.
const JS_WS: &str = r"\t\n\x0B\x0C\r \x{A0}\x{1680}\x{2000}-\x{200A}\x{2028}\x{2029}\x{202F}\x{205F}\x{3000}\x{FEFF}";

const PARTICLES: &[&str] = &[
    "에서", "으로", "에게", "까지", "부터", "처럼", "은", "는", "이", "가", "을", "를", "에", "의",
    "로", "도", "만", "와", "과",
];

const ENDINGS: &[&str] = &[
    "해야해",
    "해야지",
    "해야겠",
    "했습니다",
    "합니다",
    "해주세요",
    "해달라",
    "해줘",
    "해라",
    "해서",
    "해야",
    "해도",
    "했다",
    "했고",
    "했는",
    "했던",
    "하고",
    "하다",
    "한다",
    "하는",
    "하면",
    "하지",
    "하게",
    "하려",
    "된다",
    "됐다",
    "되는",
    "되어",
    "되면",
    "해",
    "했",
    "할",
    "한",
    "돼",
    "됨",
];

pub const RECALL_STOPWORDS: &[&str] = &[
    "지시",
    "경유",
    "요청",
    "부탁",
    "착수",
    "진행",
    "확인",
    "보고",
    "답변",
    "방식",
    "스레드",
    "채널",
    "메시지",
    "에이전트",
    "사람",
    "이번",
    "지금",
    "다음",
    "먼저",
    "그리고",
    "그러니",
    "그래서",
    "어떻게",
    "무엇",
    "여기",
    "거기",
    "이것",
    "그것",
    "해당",
    "관련",
    "내용",
    "부분",
    "경우",
    "정도",
    "이상",
    "이하",
    "달라",
    "주세요",
    "있다",
    "없다",
    "같다",
    "한다",
    "된다",
    "했다",
    "위해",
    "대해",
    "대한",
    "통해",
    "이거",
    "이걸",
    "너가",
    "내가",
    "말고",
    "아니",
    "있는",
    "하는",
    "하고",
    "하면",
    "않아",
    "같아",
    "때도",
    "보면",
    "원문",
    "첨부",
    "계획",
    "수정",
    "원인",
    "분석",
    "task",
    "the",
    "and",
    "for",
    "with",
    "this",
    "that",
    "from",
    "message",
    "thread",
    "channel",
    "please",
    "http",
    "https",
    "png",
    "jpg",
    "id",
    "v0",
];

pub const FOCUS_STOPWORDS: &[&str] = &[
    "다시",
    "한번",
    "계속",
    "마저",
    "이어서",
    "이대",
    "그대",
    "그걸",
    "그거",
    "그것",
    "그렇게",
    "똑같이",
    "아까",
    "방금",
    "좋아",
    "좋다",
    "괜찮",
    "고마워",
    "알겠",
    "그래",
    "해줘",
    "봐줘",
    "ok",
    "okay",
    "again",
    "continue",
];

/// TS `RECALL_FOCUS_TERM_CAP`.
pub const RECALL_FOCUS_TERM_CAP: usize = 16;
/// `searchTerms` 의 낱말 상한.
const TERM_CAP: usize = 12;
/// `countOccurrences`·짧은 ASCII 매처의 천장.
const OCC_CAP: usize = 50;

fn re(s: &str) -> Regex {
    Regex::new(s).expect("mem_search regex")
}

static URL_RE: LazyLock<Regex> =
    LazyLock::new(|| re(&format!(r"[a-z][a-z0-9+.\-]*://[^{JS_WS}]+")));
static MENTION_RE: LazyLock<Regex> = LazyLock::new(|| re(r"@[\p{L}\p{N}_.\-]+"));
static ATTACH_RE: LazyLock<Regex> = LazyLock::new(|| re(r"\[첨부:[^\]]*\]"));
static SPLIT_RE: LazyLock<Regex> =
    LazyLock::new(|| re(&format!(r#"[{JS_WS},.;:!?()\[\]{{}}"'`<>@#|/\\*~=+]+"#)));
static HEXID_RE: LazyLock<Regex> = LazyLock::new(|| re(r"^[0-9a-f\-]{8,}$"));
static SMALLNUM_RE: LazyLock<Regex> = LazyLock::new(|| re(r"^[0-9]{1,2}$"));
static SECRET_LIKE: LazyLock<Regex> = LazyLock::new(|| re(r"^[a-z0-9_\-]{20,}$"));
static HAS_LN: LazyLock<Regex> = LazyLock::new(|| re(r"[\p{L}\p{N}]"));
static SHORT_ASCII: LazyLock<Regex> = LazyLock::new(|| re(r"^[a-z0-9]{1,3}$"));
static WS_RUN: LazyLock<Regex> = LazyLock::new(|| re(&format!("[{JS_WS}]+")));
static TRAIL_PS: LazyLock<Regex> = LazyLock::new(|| re(r"[\p{P}\p{S}]+$"));
static THANKS_FORM: LazyLock<Regex> =
    LazyLock::new(|| re(r"^감사(?:해|해요|합니다|했어|했어요|드려요|드립니다|하다|요)$"));
static NAME_SPLIT: LazyLock<Regex> = LazyLock::new(|| re(&format!(r"[{JS_WS}_.\-]+")));
static THREAD_LAST: LazyLock<Regex> = LazyLock::new(|| re(r"^(delegations?|reviews?)([-_]|$)"));
static THREAD_SEG: LazyLock<Regex> =
    LazyLock::new(|| re(r"(^|[-_])(delegations?|reviews?)[-_]?#?[0-9]"));

/// JS `String.prototype.length`(UTF-16 단위).
fn js_len(s: &str) -> usize {
    s.encode_utf16().count()
}

/// JS `trim()` — 양끝의 JS `\s` 를 뗀다(Rust `trim` 은 U+0085 를 떼고 U+FEFF 를 남긴다).
fn js_trim(s: &str) -> &str {
    s.trim_matches(|c: char| WS_RUN.is_match(c.encode_utf8(&mut [0; 4])))
}

/// TS `normalizeTerm`.
fn normalize_term(raw: &str) -> Option<String> {
    let mut t = js_trim(raw).to_string();
    if js_len(&t) < 2 {
        return None;
    }
    if t.chars().last().is_some_and(|c| ('가'..='힣').contains(&c)) {
        if let Some(p) = PARTICLES
            .iter()
            .find(|p| t.ends_with(*p) && js_len(&t) - js_len(p) >= 2)
        {
            t.truncate(t.len() - p.len());
        }
        if let Some(e) = ENDINGS
            .iter()
            .find(|e| t.ends_with(*e) && js_len(&t) - js_len(e) >= 2)
        {
            t.truncate(t.len() - e.len());
        }
    }
    Some(t)
}

/// TS `searchTerms`. `exclude` 가 `Some` 이면 recall 모드(멘션·주소·첨부 지우기, 상투어·id·비밀 꼴 거르기).
pub fn search_terms(query: &str, exclude: Option<&HashSet<String>>) -> Vec<String> {
    let low = query.to_lowercase();
    let text = if exclude.is_some() {
        let a = URL_RE.replace_all(&low, " ");
        let b = MENTION_RE.replace_all(&a, " ");
        ATTACH_RE.replace_all(&b, " ").into_owned()
    } else {
        low
    };
    let mut out: Vec<String> = Vec::new();
    for raw in SPLIT_RE.split(&text) {
        let Some(t) = normalize_term(raw) else {
            continue;
        };
        if let Some(ex) = exclude {
            if ex.contains(&t) || RECALL_STOPWORDS.contains(&t.as_str()) {
                continue;
            }
            if HEXID_RE.is_match(&t) || SMALLNUM_RE.is_match(&t) {
                continue;
            }
            if SECRET_LIKE.is_match(&t) || !HAS_LN.is_match(&t) {
                continue;
            }
        }
        if !out.contains(&t) {
            out.push(t);
        }
        if out.len() >= TERM_CAP {
            break;
        }
    }
    out
}

/// TS `focusTermsOf` — 인사 꼴 `감사…` 낱말을 지우고, 이름·`FOCUS_STOPWORDS` 를 더 거른다.
pub fn focus_terms_of(focus: &str, excluded: &HashSet<String>) -> Vec<String> {
    let mut text = String::with_capacity(focus.len());
    let mut last = 0;
    let push_word = |w: &str, text: &mut String| {
        if THANKS_FORM.is_match(&TRAIL_PS.replace(w, "")) {
            text.push(' ');
        } else {
            text.push_str(w);
        }
    };
    for m in WS_RUN.find_iter(focus) {
        push_word(&focus[last..m.start()], &mut text);
        text.push_str(m.as_str());
        last = m.end();
    }
    push_word(&focus[last..], &mut text);
    let mut ex = excluded.clone();
    ex.extend(FOCUS_STOPWORDS.iter().map(|s| (*s).to_string()));
    search_terms(&text, Some(&ex))
}

/// TS `excludedNamesFrom` — 사람 계정의 handle·표시 이름 통째와 낱말 조각.
pub fn excluded_names_from<'a>(
    rows: impl IntoIterator<Item = (&'a str, Option<&'a str>, &'a str)>,
) -> HashSet<String> {
    let mut out = HashSet::new();
    for (handle, display, kind) in rows {
        if kind != "human" {
            continue;
        }
        for name in [handle, display.unwrap_or("")] {
            let lower = name.to_lowercase();
            let low = js_trim(&lower);
            if js_len(low) >= 2 {
                out.insert(low.to_string());
            }
            for part in NAME_SPLIT.split(low) {
                if js_len(part) >= 2 {
                    out.insert(part.to_string());
                }
            }
        }
    }
    out
}

/// shared `isThreadStateSlug`.
pub fn is_thread_state_slug(slug: &str) -> bool {
    let segs: Vec<&str> = slug.split('/').skip(1).collect();
    let last = segs.last().copied().unwrap_or("");
    THREAD_LAST.is_match(last) || segs.iter().any(|s| THREAD_SEG.is_match(s))
}

/// TS `countOccurrences` — 겹치지 않게, 50 에서 멈춘다.
fn count_occurrences(hay: &str, needle: &str) -> usize {
    let mut n = 0;
    let mut from = 0;
    while n < OCC_CAP {
        match hay[from..].find(needle) {
            Some(i) => {
                n += 1;
                from += i + needle.len();
            }
            None => break,
        }
    }
    n
}

fn is_an(c: Option<char>) -> bool {
    c.is_some_and(|c| c.is_ascii_lowercase() || c.is_ascii_digit())
}

/// `(?<![a-z0-9])t(?![a-z0-9])` 의 `g` 일치 수(천장 50). 실패한 자리는 한 글자만 넘긴다(JS 정규식 훑기와 같다).
fn count_short_ascii(hay: &str, t: &str) -> usize {
    let mut n = 0;
    let mut from = 0;
    while let Some(i) = hay[from..].find(t) {
        let at = from + i;
        let end = at + t.len();
        if !is_an(hay[..at].chars().last()) && !is_an(hay[end..].chars().next()) {
            n += 1;
            from = end;
        } else {
            from = at + 1; // t 는 ASCII 라 at+1 은 글자 경계다
        }
    }
    n.min(OCC_CAP)
}

fn term_count(t: &str, hay: &str) -> usize {
    if SHORT_ASCII.is_match(t) {
        count_short_ascii(hay, t)
    } else {
        count_occurrences(hay, t)
    }
}

/// TS `RecallCandidate`(updatedAt 은 ISO 글자로 받는다).
#[derive(Debug, Clone)]
pub struct Candidate {
    pub slug: String,
    pub description: Option<String>,
    pub kind: String,
    pub value: String,
    pub updated_at: String,
}

#[derive(Debug, Clone, PartialEq)]
pub struct RecallHit {
    pub slug: String,
    pub description: Option<String>,
    pub kind: String,
    pub score: usize,
    pub name_hits: usize,
    pub term_hits: Vec<String>,
    pub value: String,
    pub updated_at: String,
}

/// TS `rankRecall`.
pub fn rank_recall(
    terms: &[String],
    rows: &[Candidate],
    limit: usize,
    focus: Option<&HashSet<String>>,
) -> Vec<RecallHit> {
    let mut scored = Vec::new();
    for r in rows {
        if r.slug == "core" || r.kind == "journal" || r.slug.starts_with("mem/journal/") {
            continue;
        }
        let name = format!(
            "{}\n{}",
            r.slug.to_lowercase(),
            r.description.as_deref().unwrap_or("").to_lowercase()
        );
        let body = r.value.to_lowercase();
        let (mut body_hits, mut occ) = (0usize, 0usize);
        let mut term_hits = Vec::new();
        for t in terms {
            if term_count(t, &name) > 0 {
                term_hits.push(t.clone());
            }
            let c = term_count(t, &body);
            if c > 0 {
                body_hits += 1;
                occ += c;
            }
        }
        let name_hits = term_hits.len();
        if name_hits == 0 {
            continue;
        }
        if let Some(f) = focus
            && !term_hits.iter().any(|t| f.contains(t))
        {
            continue;
        }
        scored.push((r, name_hits, term_hits, name_hits * 3 + body_hits, occ));
    }
    scored.sort_by(|a, b| {
        b.3.cmp(&a.3)
            .then(b.1.cmp(&a.1))
            .then(b.4.cmp(&a.4))
            .then(a.0.slug.cmp(&b.0.slug))
    });
    scored
        .into_iter()
        .take(limit)
        .map(|(r, name_hits, term_hits, score, _)| RecallHit {
            slug: r.slug.clone(),
            description: r.description.clone(),
            kind: r.kind.clone(),
            score,
            name_hits,
            term_hits,
            value: r.value.clone(),
            updated_at: r.updated_at.clone(),
        })
        .collect()
}

/// recall 모드의 낱말 — TS `searchMemory` 앞머리. focus 가 있으면 그 낱말을 먼저 세우고 16개로 자른다.
/// 돌려주는 것: (terms, focusTerms).
pub fn recall_terms(
    query: &str,
    focus: Option<&str>,
    excluded: &HashSet<String>,
) -> (Vec<String>, Option<Vec<String>>) {
    let Some(f) = focus else {
        return (search_terms(query, Some(excluded)), None);
    };
    let ft = focus_terms_of(f, excluded);
    let mut terms = ft.clone();
    for t in search_terms(query, Some(excluded)) {
        if !terms.contains(&t) {
            terms.push(t);
        }
    }
    terms.truncate(RECALL_FOCUS_TERM_CAP);
    (terms, Some(ft))
}

/// LIKE 패턴 — TS `%${t.replace(/[\\%_]/g, '\\$&')}%`.
pub fn like_pattern(t: &str) -> String {
    let mut s = String::with_capacity(t.len() + 2);
    s.push('%');
    for c in t.chars() {
        if matches!(c, '\\' | '%' | '_') {
            s.push('\\');
        }
        s.push(c);
    }
    s.push('%');
    s
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::Value;

    fn golden() -> Value {
        serde_json::from_str(include_str!("../../golden/memory_search.json"))
            .expect("golden/memory_search.json")
    }

    fn strs(v: &Value) -> Vec<String> {
        v.as_array()
            .unwrap()
            .iter()
            .map(|x| x.as_str().unwrap().to_string())
            .collect()
    }

    fn set(v: &Value) -> HashSet<String> {
        strs(v).into_iter().collect()
    }

    #[test]
    fn word_lists_match_ts() {
        let g = golden();
        assert_eq!(strs(&g["lists"]["particles"]), PARTICLES);
        assert_eq!(strs(&g["lists"]["endings"]), ENDINGS);
        assert_eq!(strs(&g["lists"]["recallStopwords"]), RECALL_STOPWORDS);
        assert_eq!(strs(&g["lists"]["focusStopwords"]), FOCUS_STOPWORDS);
    }

    #[test]
    fn terms_match_ts_golden() {
        let g = golden();
        let names = set(&g["excluded"]);
        let mut n = 0;
        for c in g["terms"].as_array().unwrap() {
            let q = c["query"].as_str().unwrap();
            assert_eq!(search_terms(q, None), strs(&c["plain"]), "plain {q:?}");
            assert_eq!(
                search_terms(q, Some(&names)),
                strs(&c["recall"]),
                "recall {q:?}"
            );
            assert_eq!(focus_terms_of(q, &names), strs(&c["focus"]), "focus {q:?}");
            n += 1;
        }
        assert!(n > 50, "cases {n}");
    }

    #[test]
    fn excluded_names_match_ts_golden() {
        let g = golden();
        let rows: Vec<(String, Option<String>, String)> = g["nameRows"]
            .as_array()
            .unwrap()
            .iter()
            .map(|r| {
                (
                    r["handle"].as_str().unwrap().to_string(),
                    r["display_name"].as_str().map(str::to_string),
                    r["kind"].as_str().unwrap().to_string(),
                )
            })
            .collect();
        let got = excluded_names_from(
            rows.iter()
                .map(|(h, d, k)| (h.as_str(), d.as_deref(), k.as_str())),
        );
        assert_eq!(got, set(&g["excluded"]));
    }

    #[test]
    fn thread_state_slug_matches_ts_golden() {
        for c in golden()["threadState"].as_array().unwrap() {
            let s = c["slug"].as_str().unwrap();
            assert_eq!(is_thread_state_slug(s), c["want"].as_bool().unwrap(), "{s}");
        }
    }

    #[test]
    fn rank_matches_ts_golden() {
        let g = golden();
        let rows: Vec<Candidate> = g["rows"]
            .as_array()
            .unwrap()
            .iter()
            .map(|r| Candidate {
                slug: r["slug"].as_str().unwrap().into(),
                description: r["description"].as_str().map(Into::into),
                kind: r["kind"].as_str().unwrap().into(),
                value: r["value"].as_str().unwrap().into(),
                updated_at: r["updatedAt"].as_str().unwrap().into(),
            })
            .collect();
        let names = set(&g["excluded"]);
        for c in g["rank"].as_array().unwrap() {
            let q = c["query"].as_str().unwrap();
            let focus = c["focus"].as_str();
            let (terms, ft) = recall_terms(q, focus, &names);
            assert_eq!(terms, strs(&c["terms"]), "{q:?}");
            let fset: Option<HashSet<String>> = ft.map(|v| v.into_iter().collect());
            let got: Vec<Value> = rank_recall(&terms, &rows, 5, fset.as_ref())
                .into_iter()
                .map(|h| {
                    serde_json::json!({ "slug": h.slug, "score": h.score, "nameHits": h.name_hits, "termHits": h.term_hits })
                })
                .collect();
            assert_eq!(Value::Array(got), c["hits"], "{q:?} focus={focus:?}");
        }
    }

    #[test]
    fn like_pattern_escapes() {
        assert_eq!(like_pattern(r"a_b%c\d"), r"%a\_b\%c\\d%");
    }
}
