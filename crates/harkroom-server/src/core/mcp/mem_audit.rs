//! S5.4 A2b — `memory.audit`(TS `mcpPlugin.ts` 의 같은 이름 도구 + `services/memory.ts::auditMemory`). 순수 읽기다.
//! 약속은 [`super::tools`] 와 같다 — zod 가 받는 인자만 받고, DB 오류·JS 와 판정이 갈릴 수 있는 꼴은 `None`(→ TS).
//!
//! JS 와 맞춘 것:
//! - 길이는 UTF-16 단위(`value.length`)다. 비교 시각은 ms 로 자른 값(JS `Date`), 글자 시각은 `toISOString` 꼴이다.
//! - `[[링크]]` 정규식은 u 플래그가 없다 — `{1,255}` 가 UTF-16 단위를 센다. 손으로 읽는다([`js_links`]).
//!   `\s` 는 JS 공백 집합(U+FEFF 포함·U+0085 제외)으로 적었다.
//! - `#123` 참조(`(?<![\w#])#(\d{3,6})\b`)는 Rust regex 에 뒤보기가 없어 손으로 읽는다(`\w`·`\d`·`\b` 는 ASCII).
//! - journal 동률(같은 ms)은 [`slug_locale_cmp`](ICU 뿌리 순서 근사, `memory.set` 경고와 같은 것)로 가른다.
//! - `similarity` 는 `Math.round(x*100)/100` 의 JS 수 표기(정수면 소수점 없이)다.
use super::mem_body::{MAX_CORE, MAX_ITEMS, slug_locale_cmp};
use super::respond::text_result;
use crate::auth::Account;
use serde_json::Value;
use sqlx::PgPool;
use std::collections::{HashMap, HashSet};

/// `memory.ts` 상수들.
const STALE_DAYS: i64 = 30;
const NEVER_READ_GRACE_DAYS: i64 = 7;
const OLD_DAYS: i64 = 90;
const BODY_SIMILARITY: f64 = 0.5;
const NAME_SIMILARITY: f64 = 0.6;
const LIST_CAP: usize = 30;
const LARGEST_CAP: usize = 10;
/// shared `MAX_JOURNAL_MEMORIES_PER_ACCOUNT - JOURNAL_EXPIRING_WINDOW`.
const JOURNAL_KEEP: usize = 60 - 5;
const DAY_MS: i64 = 86_400_000;

const ROWS_SQL: &str = "select slug, value, description, kind, read_count::bigint, recall_count::bigint, \
       (extract(epoch from date_trunc('milliseconds', last_read_at)) * 1000)::bigint, \
       to_char(last_read_at at time zone 'UTC', 'YYYY-MM-DD\"T\"HH24:MI:SS.MS\"Z\"'), \
       (extract(epoch from date_trunc('milliseconds', last_recalled_at)) * 1000)::bigint, \
       to_char(last_recalled_at at time zone 'UTC', 'YYYY-MM-DD\"T\"HH24:MI:SS.MS\"Z\"'), \
       (extract(epoch from date_trunc('milliseconds', created_at)) * 1000)::bigint, \
       (extract(epoch from date_trunc('milliseconds', updated_at)) * 1000)::bigint, \
       to_char(updated_at at time zone 'UTC', 'YYYY-MM-DD\"T\"HH24:MI:SS.MS\"Z\"'), \
       flagged_at is not null, flag_reason \
     from agent_memory where account_id = $1::uuid and archived_at is null order by slug";

const ARCHIVED_SQL: &str = "select count(*)::bigint from agent_memory where account_id = $1::uuid and archived_at is not null";

type RawRow = (
    String,
    String,
    Option<String>,
    String,
    i64,
    i64,
    Option<i64>,
    Option<String>,
    Option<i64>,
    Option<String>,
    i64,
    i64,
    String,
    bool,
    Option<String>,
);

/// 판정에 쓰는 한 행.
pub(crate) struct Row {
    pub slug: String,
    pub value: String,
    pub description: Option<String>,
    pub kind: String,
    pub used: i64,
    /// (ms, ISO) — 읽힘·recall 중 늦은 쪽(같으면 읽힘).
    pub last_used: Option<(i64, String)>,
    pub created_ms: i64,
    pub updated_ms: i64,
    pub updated_iso: String,
    pub flagged: bool,
    pub flag_reason: Option<String>,
}

fn utf16_len(s: &str) -> usize {
    s.encode_utf16().count()
}

/// JS `String.prototype.trim` 이 지우는 글자.
fn js_ws(c: char) -> bool {
    matches!(
        c,
        '\t' | '\u{b}'
            | '\u{c}'
            | ' '
            | '\u{a0}'
            | '\u{feff}'
            | '\n'
            | '\r'
            | '\u{2028}'
            | '\u{2029}'
            | '\u{1680}'
            | '\u{2000}'..='\u{200a}' | '\u{202f}' | '\u{205f}' | '\u{3000}'
    )
}

/// JS `value.matchAll(/\[\[([^\]\s]{1,255})\]\]/g)`(u 플래그 없음)의 잡힌 글자들 — 길이는 UTF-16 단위로 센다.
/// 칸 밖 글자(`]`·공백)에서 멈춘 최대 길이가 1..=255 이고 바로 `]]` 가 오면 잡힌다. 255 에서 끊기면 다음 글자도 칸 안이라
/// 되돌아가도 `]]` 를 못 만나니 실패다. 실패하면 한 단위 뒤에서 다시 본다(시작은 언제나 ASCII `[`).
fn js_links(s: &str) -> Vec<&str> {
    let b = s.as_bytes();
    let mut out = Vec::new();
    let mut i = 0;
    while i + 1 < b.len() {
        if b[i] == b'[' && b[i + 1] == b'[' {
            let start = i + 2;
            let mut units = 0usize;
            let mut end = start;
            for c in s[start..].chars() {
                if c == ']' || js_ws(c) {
                    break;
                }
                units += c.len_utf16();
                end += c.len_utf8();
                if units > 255 {
                    break;
                }
            }
            if (1..=255).contains(&units) && s[end..].starts_with("]]") {
                out.push(&s[start..end]);
                i = end + 2;
                continue;
            }
        }
        i += 1;
    }
    out
}

fn body_split_re() -> &'static regex::Regex {
    static R: std::sync::OnceLock<regex::Regex> = std::sync::OnceLock::new();
    R.get_or_init(|| regex::Regex::new(r"[^\p{L}\p{N}]+").expect("body re"))
}

/// TS `nameTokens`.
fn name_tokens(slug: &str) -> HashSet<String> {
    let s = slug.strip_prefix("mem/").unwrap_or(slug);
    s.split(['/', '_', '-'])
        .filter(|t| utf16_len(t) > 1 && !t.bytes().all(|b| b.is_ascii_digit()))
        .map(str::to_owned)
        .collect()
}

/// TS `bodyTokens`.
fn body_tokens(value: &str) -> HashSet<String> {
    body_split_re()
        .split(&value.to_lowercase())
        .filter(|t| utf16_len(t) > 1)
        .map(str::to_owned)
        .collect()
}

/// TS `refTokens` — `(?<![\w#])#(\d{3,6})\b`(ASCII). 숫자 줄이 3~6자이고 바로 뒤가 단어 글자가 아닐 때만 걸린다.
fn ref_tokens(value: &str) -> Vec<String> {
    let word = |b: u8| b.is_ascii_alphanumeric() || b == b'_';
    let bytes = value.as_bytes();
    let mut out: Vec<String> = vec![];
    for (i, &b) in bytes.iter().enumerate() {
        if b != b'#' {
            continue;
        }
        if i > 0 && (word(bytes[i - 1]) || bytes[i - 1] == b'#') {
            continue;
        }
        let n = bytes[i + 1..]
            .iter()
            .take_while(|c| c.is_ascii_digit())
            .count();
        if !(3..=6).contains(&n) {
            continue;
        }
        if bytes.get(i + 1 + n).is_some_and(|&c| word(c)) {
            continue;
        }
        let r = value[i..=i + n].to_owned();
        if !out.contains(&r) {
            out.push(r);
        }
    }
    out
}

fn jaccard(a: &HashSet<String>, b: &HashSet<String>) -> f64 {
    if a.is_empty() || b.is_empty() {
        return 0.0;
    }
    let inter = a.iter().filter(|x| b.contains(*x)).count();
    #[allow(clippy::cast_precision_loss)]
    {
        inter as f64 / (a.len() + b.len() - inter) as f64
    }
}

/// JS 수 표기(정수면 소수점 없이).
fn js_num(x: f64) -> String {
    if x.fract() == 0.0 && x.abs() < 1e15 {
        #[allow(clippy::cast_possible_truncation)]
        return format!("{}", x as i64);
    }
    Value::from(x).to_string()
}

fn s(v: &str) -> String {
    Value::from(v).to_string()
}

fn arr<T>(items: &[T], f: impl Fn(&T) -> String) -> String {
    format!("[{}]", items.iter().map(f).collect::<Vec<_>>().join(","))
}

/// `patterns: z.array(z.string().min(3).max(100)).max(20).optional()` — 모양 밖이면 `None`.
fn parse_patterns(args: &Value) -> Option<Vec<String>> {
    let o = args.as_object()?;
    match o.get("patterns") {
        None => Some(vec![]),
        Some(v) => {
            let a = v.as_array()?;
            if a.len() > 20 {
                return None;
            }
            a.iter()
                .map(|x| {
                    let p = x.as_str()?;
                    (3..=100).contains(&utf16_len(p)).then(|| p.to_owned())
                })
                .collect()
        }
    }
}

/// TS `auditMemory`(cap 30) 의 답 글자(시험용 — 늘 `Some`).
#[cfg(test)]
pub(crate) fn audit_text(
    rows: &[Row],
    archived: i64,
    patterns: &[String],
    now_ms: i64,
) -> Option<String> {
    Some(audit_text_capped(
        rows, archived, patterns, now_ms, LIST_CAP,
    ))
}

/// [`audit_text`] 에 목록 상한을 따로 준다 — 사람 화면(REST)은 TS `AUDIT_HUMAN_LIST_CAP`.
pub(crate) fn audit_text_capped(
    rows: &[Row],
    archived: i64,
    patterns: &[String],
    now_ms: i64,
    cap: usize,
) -> String {
    let slugs: HashSet<&str> = rows.iter().map(|r| r.slug.as_str()).collect();
    let core = rows.iter().find(|r| r.slug == "core");
    let lowered: Vec<(String, String)> = patterns
        .iter()
        .map(|p| p.trim_matches(js_ws))
        .filter(|p| utf16_len(p) >= 3)
        .map(|p| (p.to_owned(), p.to_lowercase()))
        .collect();

    let mut never_read: Vec<String> = vec![];
    let mut stale: Vec<(String, String)> = vec![];
    let mut broken: Vec<(String, String)> = vec![];
    let mut outdated: Vec<(String, String)> = vec![];
    let mut undescribed: Vec<String> = vec![];
    let mut flagged: Vec<(String, Option<String>)> = vec![];
    let mut old: Vec<(String, String)> = vec![];
    for r in rows {
        let judged = r.slug != "core" && r.kind != "journal";
        if r.flagged {
            flagged.push((r.slug.clone(), r.flag_reason.clone()));
        }
        if judged && r.used == 0 && now_ms - r.created_ms > NEVER_READ_GRACE_DAYS * DAY_MS {
            never_read.push(r.slug.clone());
        }
        if judged
            && r.description
                .as_deref()
                .is_none_or(|d| d.trim_matches(js_ws).is_empty())
        {
            undescribed.push(r.slug.clone());
        }
        if let Some((ms, iso)) = &r.last_used
            && judged
            && now_ms - ms > STALE_DAYS * DAY_MS
        {
            stale.push((r.slug.clone(), iso.clone()));
        }
        if judged && now_ms - r.updated_ms > OLD_DAYS * DAY_MS {
            old.push((r.slug.clone(), r.updated_iso.clone()));
        }
        let mut seen: HashSet<&str> = HashSet::new();
        for target in js_links(&r.value) {
            let exists = slugs.contains(target) || slugs.contains(format!("mem/{target}").as_str());
            if !exists && seen.insert(target) {
                broken.push((r.slug.clone(), target.to_owned()));
            }
        }
        let body = r.value.to_lowercase();
        for (raw, low) in &lowered {
            if body.contains(low.as_str()) {
                outdated.push((r.slug.clone(), raw.clone()));
            }
        }
    }

    let judged: Vec<&Row> = rows
        .iter()
        .filter(|r| r.slug != "core" && r.kind != "journal")
        .collect();
    let named: Vec<HashSet<String>> = judged.iter().map(|r| name_tokens(&r.slug)).collect();
    let bodies: Vec<HashSet<String>> = judged.iter().map(|r| body_tokens(&r.value)).collect();
    let mut similar: Vec<(String, String)> = vec![];
    let mut similar_body: Vec<(String, String, f64)> = vec![];
    for i in 0..judged.len() {
        for j in i + 1..judged.len() {
            if jaccard(&named[i], &named[j]) >= NAME_SIMILARITY {
                similar.push((judged[i].slug.clone(), judged[j].slug.clone()));
            }
            let sim = jaccard(&bodies[i], &bodies[j]);
            if sim >= BODY_SIMILARITY {
                similar_body.push((
                    judged[i].slug.clone(),
                    judged[j].slug.clone(),
                    (sim * 100.0).round() / 100.0,
                ));
            }
        }
    }
    // JS sort 는 안정 정렬이다 — Rust sort_by 도.
    similar_body.sort_by(|a, b| b.2.total_cmp(&a.2));

    let mut by_ref: Vec<(String, Vec<String>)> = vec![];
    let mut idx: HashMap<String, usize> = HashMap::new();
    for r in &judged {
        for t in ref_tokens(&r.value) {
            if let Some(&k) = idx.get(&t) {
                by_ref[k].1.push(r.slug.clone());
            } else {
                idx.insert(t.clone(), by_ref.len());
                by_ref.push((t, vec![r.slug.clone()]));
            }
        }
    }
    let mut shared: Vec<(String, Vec<String>)> =
        by_ref.into_iter().filter(|(_, s)| s.len() >= 3).collect();
    // `#숫자` 만 나오므로 localeCompare 는 바이트 순서와 같다.
    shared.sort_by(|a, b| b.1.len().cmp(&a.1.len()).then_with(|| a.0.cmp(&b.0)));

    let mut largest: Vec<(String, usize)> = judged
        .iter()
        .map(|r| (r.slug.clone(), utf16_len(&r.value)))
        .collect();
    largest.sort_by_key(|x| std::cmp::Reverse(x.1));
    largest.truncate(LARGEST_CAP);

    let mut journals: Vec<(&str, i64)> = rows
        .iter()
        .filter(|r| r.kind == "journal")
        .map(|r| (r.slug.as_str(), r.updated_ms))
        .collect();
    let expiring: Vec<&str> = if journals.len() <= JOURNAL_KEEP {
        vec![]
    } else {
        journals.sort_by(|a, b| b.1.cmp(&a.1).then_with(|| slug_locale_cmp(a.0, b.0)));
        journals
            .into_iter()
            .skip(JOURNAL_KEEP)
            .map(|j| j.0)
            .rev()
            .collect()
    };

    let truncated = [
        never_read.len(),
        stale.len(),
        broken.len(),
        similar.len(),
        outdated.len(),
        undescribed.len(),
        flagged.len(),
        similar_body.len(),
        shared.len(),
        old.len(),
    ]
    .iter()
    .any(|&n| n > cap);
    never_read.truncate(cap);
    stale.truncate(cap);
    broken.truncate(cap);
    similar.truncate(cap);
    outdated.truncate(cap);
    undescribed.truncate(cap);
    flagged.truncate(cap);
    similar_body.truncate(cap);
    shared.truncate(cap);
    old.truncate(cap);

    let core_text = core.map_or_else(
        || "null".to_owned(),
        |c| {
            format!(
                "{{\"length\":{},\"limit\":{MAX_CORE}}}",
                utf16_len(&c.value)
            )
        },
    );
    let mut out = String::with_capacity(4096);
    out.push_str(&format!("{{\"total\":{},\"core\":{core_text}", rows.len()));
    out.push_str(&format!(",\"neverRead\":{}", arr(&never_read, |x| s(x))));
    out.push_str(&format!(
        ",\"stale\":{}",
        arr(&stale, |(a, b)| format!(
            "{{\"slug\":{},\"lastReadAt\":{}}}",
            s(a),
            s(b)
        ))
    ));
    out.push_str(&format!(
        ",\"brokenLinks\":{}",
        arr(&broken, |(a, b)| format!(
            "{{\"slug\":{},\"target\":{}}}",
            s(a),
            s(b)
        ))
    ));
    out.push_str(&format!(
        ",\"similar\":{}",
        arr(&similar, |(a, b)| format!("[{},{}]", s(a), s(b)))
    ));
    out.push_str(&format!(
        ",\"outdated\":{}",
        arr(&outdated, |(a, b)| format!(
            "{{\"slug\":{},\"pattern\":{}}}",
            s(a),
            s(b)
        ))
    ));
    out.push_str(&format!(",\"undescribed\":{}", arr(&undescribed, |x| s(x))));
    out.push_str(&format!(
        ",\"flagged\":{}",
        arr(&flagged, |(a, b)| format!(
            "{{\"slug\":{},\"reason\":{}}}",
            s(a),
            b.as_deref().map_or_else(|| "null".to_owned(), s)
        ))
    ));
    out.push_str(&format!(",\"truncated\":{truncated}"));
    out.push_str(&format!(
        ",\"items\":{{\"active\":{},\"limit\":{MAX_ITEMS},\"archived\":{archived}}}",
        rows.len()
    ));
    out.push_str(&format!(
        ",\"expiringJournal\":{}",
        arr(&expiring, |x| s(x))
    ));
    out.push_str(&format!(
        ",\"similarBody\":{}",
        arr(&similar_body, |(a, b, x)| format!(
            "{{\"pair\":[{},{}],\"similarity\":{}}}",
            s(a),
            s(b),
            js_num(*x)
        ))
    ));
    out.push_str(&format!(
        ",\"sharedRefs\":{}",
        arr(&shared, |(r, sl)| format!(
            "{{\"ref\":{},\"slugs\":{}}}",
            s(r),
            arr(sl, |x| s(x))
        ))
    ));
    out.push_str(&format!(
        ",\"old\":{}",
        arr(&old, |(a, b)| format!(
            "{{\"slug\":{},\"updatedAt\":{}}}",
            s(a),
            s(b)
        ))
    ));
    out.push_str(&format!(
        ",\"largest\":{}}}",
        arr(&largest, |(a, n)| format!(
            "{{\"slug\":{},\"chars\":{n}}}",
            s(a)
        ))
    ));
    out
}

fn into_row(r: RawRow) -> Row {
    let (
        slug,
        value,
        description,
        kind,
        reads,
        recalls,
        rd_ms,
        rd_iso,
        rc_ms,
        rc_iso,
        created_ms,
        updated_ms,
        updated_iso,
        flagged,
        flag_reason,
    ) = r;
    let read = rd_ms.zip(rd_iso);
    let recall = rc_ms.zip(rc_iso);
    // TS: [last_read_at, last_recalled_at] 를 줄여 늦은 쪽 — 같으면 앞(읽힘)이 남는다.
    let last_used = match (read, recall) {
        (Some(a), Some(b)) => Some(if b.0 > a.0 { b } else { a }),
        (a, b) => a.or(b),
    };
    Row {
        slug,
        value,
        description,
        kind,
        used: reads + recalls,
        last_used,
        created_ms,
        updated_ms,
        updated_iso,
        flagged,
        flag_reason,
    }
}

pub(super) async fn answer(pool: &PgPool, me: &Account, args: &Value) -> Option<String> {
    let patterns = parse_patterns(args)?;
    audit_for(pool, &me.id, &patterns, LIST_CAP)
        .await
        .ok()
        .map(|t| text_result(&t))
}

/// 한 계정의 정리 후보(TS `auditMemory(pool, id, patterns, { cap })`) 의 JSON 글자. 판정은 늘 Rust 가 한다(`[[링크]]` 도 UTF-16 단위로 센다).
pub(crate) async fn audit_for(
    pool: &PgPool,
    account_id: &str,
    patterns: &[String],
    cap: usize,
) -> Result<String, sqlx::Error> {
    let raw: Vec<RawRow> = sqlx::query_as(ROWS_SQL)
        .bind(account_id)
        .fetch_all(pool)
        .await?;
    let archived: i64 = sqlx::query_scalar(ARCHIVED_SQL)
        .bind(account_id)
        .fetch_one(pool)
        .await?;
    let rows: Vec<Row> = raw.into_iter().map(into_row).collect();
    #[allow(clippy::cast_possible_truncation)]
    let now_ms = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map_or(0, |d| d.as_millis() as i64);
    Ok(audit_text_capped(&rows, archived, patterns, now_ms, cap))
}

#[cfg(test)]
mod tests {
    use super::*;

    const NOW: i64 = 1_800_000_000_000;

    fn row(slug: &str, value: &str) -> Row {
        Row {
            slug: slug.into(),
            value: value.into(),
            description: Some("d".into()),
            kind: "topic".into(),
            used: 1,
            last_used: Some((NOW, "x".into())),
            created_ms: NOW,
            updated_ms: NOW,
            updated_iso: "u".into(),
            flagged: false,
            flag_reason: None,
        }
    }

    fn audit(rows: &[Row], patterns: &[&str]) -> Value {
        let p: Vec<String> = patterns.iter().map(|s| (*s).to_owned()).collect();
        serde_json::from_str(&audit_text(rows, 0, &p, NOW).unwrap()).unwrap()
    }

    #[test]
    fn refs_follow_js_regex() {
        assert_eq!(ref_tokens("PR #123 and #4567."), vec!["#123", "#4567"]);
        // 앞이 단어 글자·#, 숫자 2자·7자, 뒤가 단어 글자면 안 걸린다.
        assert!(ref_tokens("a#123 ##123 #12 #1234567 #123a #123_").is_empty());
        // 한글은 \w 가 아니다.
        assert_eq!(ref_tokens("가#123가"), vec!["#123"]);
        assert_eq!(ref_tokens("#123 #123"), vec!["#123"]);
        assert_eq!(ref_tokens("#123456"), vec!["#123456"]);
    }

    #[test]
    fn tokens_follow_js() {
        let n = name_tokens("mem/pr/2347-a2a_x");
        assert!(n.contains("pr") && n.contains("a2a") && !n.contains("2347") && !n.contains("x"));
        let b = body_tokens("Hello, 세계! a ä1 x_y");
        for t in ["hello", "세계", "ä1"] {
            assert!(b.contains(t), "{t}");
        }
        assert!(!b.contains("a") && !b.contains("x"));
        assert_eq!(js_num(1.0), "1");
        assert_eq!(js_num(0.67), "0.67");
        assert_eq!(js_num(0.5), "0.5");
    }

    #[test]
    fn key_order_and_lists() {
        let mut core = row("core", "abc");
        core.kind = "topic".into();
        let mut a = row(
            "mem/x/alpha-beta",
            "see [[mem/nope]] and [[x/alpha-beta]] [[mem/nope]] #123",
        );
        a.description = Some(" \u{feff}".into());
        a.used = 0;
        a.created_ms = NOW - 8 * DAY_MS;
        a.last_used = None;
        let mut b = row("mem/y/alpha-beta", "#123 OldName here");
        b.last_used = Some((NOW - 31 * DAY_MS, "2026-01-01T00:00:00.000Z".into()));
        b.updated_ms = NOW - 91 * DAY_MS;
        b.updated_iso = "2025-01-01T00:00:00.000Z".into();
        b.flagged = true;
        let c = row("mem/z", "#123 tail");
        let v = audit(&[core, a, b, c], &["  oldname "]);
        let keys: Vec<&str> = v.as_object().unwrap().keys().map(String::as_str).collect();
        // serde_json 은 키를 정렬할 수 있으니 글자로도 본다.
        let text = audit_text(&[row("core", "x")], 0, &[], NOW).unwrap();
        assert!(text.starts_with("{\"total\":1,\"core\":{\"length\":1,\"limit\":3000},\"neverRead\":[],\"stale\":[],\"brokenLinks\":[],\"similar\":[],\"outdated\":[],\"undescribed\":[],\"flagged\":[],\"truncated\":false,\"items\":{\"active\":1,\"limit\":200,\"archived\":0},\"expiringJournal\":[],\"similarBody\":[],\"sharedRefs\":[],\"old\":[],\"largest\":[]}"));
        assert_eq!(keys.len(), 16);
        assert_eq!(v["neverRead"], serde_json::json!(["mem/x/alpha-beta"]));
        assert_eq!(v["undescribed"], serde_json::json!(["mem/x/alpha-beta"]));
        assert_eq!(
            v["brokenLinks"],
            serde_json::json!([{ "slug": "mem/x/alpha-beta", "target": "mem/nope" }])
        );
        assert_eq!(v["stale"][0]["slug"], "mem/y/alpha-beta");
        assert_eq!(v["old"][0]["updatedAt"], "2025-01-01T00:00:00.000Z");
        assert_eq!(
            v["flagged"],
            serde_json::json!([{ "slug": "mem/y/alpha-beta", "reason": null }])
        );
        assert_eq!(
            v["outdated"],
            serde_json::json!([{ "slug": "mem/y/alpha-beta", "pattern": "oldname" }])
        );
        assert_eq!(
            v["similar"],
            serde_json::json!([["mem/x/alpha-beta", "mem/y/alpha-beta"]])
        );
        assert_eq!(
            v["sharedRefs"],
            serde_json::json!([{ "ref": "#123", "slugs": ["mem/x/alpha-beta", "mem/y/alpha-beta", "mem/z"] }])
        );
        assert_eq!(v["largest"][0]["slug"], "mem/x/alpha-beta");
    }

    #[test]
    fn astral_link_counts_utf16_and_caps_truncate() {
        assert!(audit_text(&[row("mem/a", "[[😀]]")], 0, &[], NOW).is_some());
        // UTF-16 단위로 센다 — 😀 128개(256 단위)는 잡히지 않고 127개(254 단위)는 잡힌다.
        assert!(js_links(&format!("[[{}]]", "😀".repeat(128))).is_empty());
        assert_eq!(js_links(&format!("[[{}]]", "😀".repeat(127))).len(), 1);
        assert_eq!(js_links(&format!("[[{}]]", "a".repeat(255))).len(), 1);
        assert!(js_links(&format!("[[{}]]", "a".repeat(256))).is_empty());
        assert_eq!(js_links("[[[a]] [[b c]] [[]] [[d]]"), vec!["[a", "d"]);
        assert!(audit_text(&[row("mem/a", "😀 no links")], 0, &[], NOW).is_some());
        let many: Vec<Row> = (0..31)
            .map(|i| {
                let mut r = row(&format!("mem/n{i:02}"), "v");
                r.description = None;
                r
            })
            .collect();
        let v = audit(&many, &[]);
        assert_eq!(v["truncated"], true);
        assert_eq!(v["undescribed"].as_array().unwrap().len(), 30);
        assert_eq!(v["largest"].as_array().unwrap().len(), 10);
    }

    #[test]
    fn expiring_journals_oldest_first() {
        let rows: Vec<Row> = (0..57)
            .map(|i| {
                let mut r = row(&format!("mem/j{i:02}"), "v");
                r.kind = "journal".into();
                r.updated_ms = NOW - i64::from(i) * 1000;
                r
            })
            .collect();
        let v = audit(&rows, &[]);
        assert_eq!(
            v["expiringJournal"],
            serde_json::json!(["mem/j56", "mem/j55"])
        );
    }

    #[test]
    fn patterns_follow_zod() {
        assert_eq!(parse_patterns(&serde_json::json!({})), Some(vec![]));
        assert!(parse_patterns(&Value::Null).is_none());
        assert!(parse_patterns(&serde_json::json!({ "patterns": ["ab"] })).is_none());
        assert!(parse_patterns(&serde_json::json!({ "patterns": null })).is_none());
        assert!(parse_patterns(&serde_json::json!({ "patterns": vec!["abc"; 21] })).is_none());
        assert_eq!(
            parse_patterns(&serde_json::json!({ "patterns": ["abc"], "x": 1 })),
            Some(vec!["abc".into()])
        );
    }

    /// 상수·문장·답 모양을 TS 원본과 맞춘다 — TS 가 바꾸면 여기서 깨진다.
    #[test]
    fn follows_ts_source() {
        let shared = include_str!("../../../../../packages/shared/src/index.ts");
        assert!(shared.contains("export const MAX_JOURNAL_MEMORIES_PER_ACCOUNT = 60;"));
        assert!(shared.contains("export const JOURNAL_EXPIRING_WINDOW = 5;"));
    }

    #[test]
    fn human_cap_keeps_more_than_agent_cap() {
        let rows: Vec<Row> = (0..31)
            .map(|i| Row {
                description: None,
                ..row(&format!("mem/n{i:02}"), "x")
            })
            .collect();
        let agent: Value =
            serde_json::from_str(&audit_text_capped(&rows, 0, &[], NOW, LIST_CAP)).unwrap();
        assert_eq!(agent["undescribed"].as_array().unwrap().len(), 30);
        assert_eq!(agent["truncated"], true);
        let human: Value =
            serde_json::from_str(&audit_text_capped(&rows, 0, &[], NOW, 200)).unwrap();
        assert_eq!(human["undescribed"].as_array().unwrap().len(), 31);
        assert_eq!(human["truncated"], false);
    }
}
