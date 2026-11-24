//! C4b ④-a(2/2) — MCP `bg.claim`(러너가 백그라운드 일감 하나를 집는다). 순수 조각(시계·JS 문자열 규칙·증류 요약 조립)과
//! DB 줄([`claim`]). 켜짐(`backgroundEnabled()`)은 TS `/mcp/admit` 이 알려 준 값으로 [`super::route::serve`] 가 먼저 거른다 —
//! 여기까지 오면 켜져 있다. 꺼졌거나 값을 못 받으면 TS 가 답한다(`disabled`).
//!
//! 약속(security 02:21 KST):
//! - 창(03~07 KST)·KST 날짜는 **시계를 인자로** 받는다 — 경계값 단위 시험 + TS 상수·식 `include_str` 대조.
//! - 켜짐 판단은 TS 와 같은 출처여야 한다 — Rust env 가 아니라 TS `/mcp/admit` 이 알려 준 값만 믿는다.
//! - 계정별 `bg_enabled` 는 TS `claimBgJob` 처럼 집을 때 보지 않는다(넣을 때 `BG_AGENT_ON_SQL` 이 거른다) — TS 와 결과를 같게.
//! - JS 문자열 규칙: `length`·`slice` 는 UTF-16 단위, `/\s+/`·`trim` 은 ECMAScript 공백, 잘린 짝 잃은 서러게이트는
//!   `JSON.stringify` 처럼 `\udxxx` 로 낸다.

/// TS `BG_WINDOW_KST` = [3, 7) — KST 시.
pub const WINDOW_KST: (u32, u32) = (3, 7);
const KST_OFFSET_MS: i64 = 9 * 60 * 60 * 1000;
const DAY_MS: i64 = 24 * 60 * 60 * 1000;

/// TS `inBgWindow(now)` — `now_ms` 는 유닉스 밀리초.
pub fn in_window(now_ms: i64) -> bool {
    let h = ((now_ms + KST_OFFSET_MS).rem_euclid(DAY_MS) / (60 * 60 * 1000)) as u32;
    h >= WINDOW_KST.0 && h < WINDOW_KST.1
}

/// TS `kstDay(now)` — `YYYY-MM-DD`(1970 이후만; 그 앞은 쓰지 않는다).
pub fn kst_day(now_ms: i64) -> String {
    let days = (now_ms + KST_OFFSET_MS).div_euclid(DAY_MS);
    let (y, m, d) = civil_from_days(days);
    format!("{y:04}-{m:02}-{d:02}")
}

/// Howard Hinnant 의 days → (y, m, d).
fn civil_from_days(z: i64) -> (i64, u32, u32) {
    let z = z + 719_468;
    let era = z.div_euclid(146_097);
    let doe = z.rem_euclid(146_097);
    let yoe = (doe - doe / 1460 + doe / 36_524 - doe / 146_096) / 365;
    let y = yoe + era * 400;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let d = (doy - (153 * mp + 2) / 5 + 1) as u32;
    let m = if mp < 10 { mp + 3 } else { mp - 9 } as u32;
    (if m <= 2 { y + 1 } else { y }, m, d)
}

/// ECMAScript WhiteSpace + LineTerminator — `/\s/` 와 `String.prototype.trim` 이 같이 쓰는 집합.
pub fn js_space(u: u16) -> bool {
    matches!(
        u,
        0x09..=0x0d
            | 0x20
            | 0xa0
            | 0x1680
            | 0x2000..=0x200a
            | 0x2028
            | 0x2029
            | 0x202f
            | 0x205f
            | 0x3000
            | 0xfeff
    )
}

/// `body.replace(/\s+/g, ' ').trim()` — UTF-16 단위.
pub fn squash(s: &str) -> Vec<u16> {
    let mut out: Vec<u16> = Vec::with_capacity(s.len());
    let mut in_space = false;
    for u in s.encode_utf16() {
        if js_space(u) {
            if !in_space {
                out.push(0x20);
            }
            in_space = true;
        } else {
            out.push(u);
            in_space = false;
        }
    }
    let start = out.iter().position(|&u| u != 0x20).unwrap_or(out.len());
    let end = out
        .iter()
        .rposition(|&u| u != 0x20)
        .map_or(start, |i| i + 1);
    out[start..end].to_vec()
}

/// TS `clip(t, n)` — `t.length <= n ? t : t.slice(0, n - 1) + '…'`.
pub fn clip(t: Vec<u16>, n: usize) -> Vec<u16> {
    if t.len() <= n {
        return t;
    }
    let mut v = t[..n - 1].to_vec();
    v.push(0x2026);
    v
}

/// TS `DIGEST_PIECE` · `DISTILL_DIGEST_MAX_CHARS`.
pub const PIECE_REPORT: usize = 800;
pub const PIECE_FAILURE: usize = 500;
pub const PIECE_HUMAN: usize = 600;
pub const DIGEST_MAX: usize = 3000;

#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub enum Role {
    Report,
    Failure,
    Human,
}

impl Role {
    pub fn parse(s: &str) -> Option<Role> {
        match s {
            "report" => Some(Role::Report),
            "failure" => Some(Role::Failure),
            "human" => Some(Role::Human),
            _ => None,
        }
    }
    fn label(self) -> &'static str {
        match self {
            Role::Report => "마지막 보고",
            Role::Failure => "실패",
            Role::Human => "사람 글",
        }
    }
    fn cap(self) -> usize {
        match self {
            Role::Report => PIECE_REPORT,
            Role::Failure => PIECE_FAILURE,
            Role::Human => PIECE_HUMAN,
        }
    }
    fn order(self) -> u8 {
        self as u8
    }
}

/// TS `buildDistillDigest` 의 조립부 — 행(질의 순서 그대로)을 안정 정렬해 조각을 잇는다. 결과는 UTF-16 단위.
pub fn assemble(mut rows: Vec<(Role, String)>) -> Vec<u16> {
    rows.sort_by_key(|(r, _)| r.order()); // Vec::sort_by_key 는 안정 정렬 — JS Array.prototype.sort 와 같다
    let mut out: Vec<u16> = Vec::new();
    let mut used = 0usize;
    for (role, body) in rows {
        let mut p: Vec<u16> = format!("[{}] ", role.label()).encode_utf16().collect();
        p.extend(clip(squash(&body), role.cap()));
        if used + p.len() + 1 > DIGEST_MAX {
            break;
        }
        if !out.is_empty() {
            out.push(0x0a);
        }
        used += p.len() + 1;
        out.extend(p);
    }
    out
}

/// `JSON.stringify(s)` — UTF-16 단위 그대로. 짝 잃은 서러게이트는 `\udxxx`(소문자), 제어 문자는 짧은 꼴 또는 `\u00xx`.
pub fn js_json_string(units: &[u16]) -> String {
    let mut out = String::with_capacity(units.len() + 2);
    out.push('"');
    let mut i = 0;
    while i < units.len() {
        let u = units[i];
        match u {
            0x22 => out.push_str("\\\""),
            0x5c => out.push_str("\\\\"),
            0x08 => out.push_str("\\b"),
            0x0c => out.push_str("\\f"),
            0x0a => out.push_str("\\n"),
            0x0d => out.push_str("\\r"),
            0x09 => out.push_str("\\t"),
            0x00..=0x1f => out.push_str(&format!("\\u{u:04x}")),
            0xd800..=0xdbff if i + 1 < units.len() && (0xdc00..=0xdfff).contains(&units[i + 1]) => {
                let c = 0x10000 + (((u as u32) - 0xd800) << 10) + ((units[i + 1] as u32) - 0xdc00);
                out.push(char::from_u32(c).expect("valid pair"));
                i += 1;
            }
            0xd800..=0xdfff => out.push_str(&format!("\\u{u:04x}")),
            _ => out.push(char::from_u32(u as u32).expect("bmp")),
        }
        i += 1;
    }
    out.push('"');
    out
}

/// 러너 판정(security 02:21 KST #2) — 오퍼레이터를 거쳤고 턴 표지 헤더(원인·턴 id)가 **원시값으로도** 없다. TS 는 꼴이 맞는 값만
/// 표지로 치지만(꼴이 틀린 원인은 「없음」), Rust 는 헤더가 있기만 해도 러너가 아니라고 보고 TS 로 넘긴다 — 좁히는 쪽으로만 틀린다.
/// `bg.claim`·`bg.complete` 가 같이 쓴다.
pub fn runner(has_operator: bool, h: &axum::http::HeaderMap) -> bool {
    has_operator && !h.contains_key("x-harkroom-cause") && !h.contains_key("x-harkroom-turn-id")
}

/// `bg.claim` 쓰기 역할의 권한 — 고르는 데 `SELECT`, 집는 데 두 칸 `UPDATE`. 없으면 `main.rs` 가 풀을 비워 TS 가 답한다.
pub const BG_CLAIM_PRIVILEGES: &[(&str, &str)] = &[
    ("bg_job", "SELECT"),
    ("bg_job.status", "UPDATE"),
    ("bg_job.claimed_at", "UPDATE"),
];

/// TS `claimBgJob` 의 update — 자리표에 형만 붙였다(Rust 는 값을 글자로 넘긴다).
///
/// `$3` = 옛 회차(증류·구조 정리)를 줄 수 있는가(전역 스위치 + 밤 창). 매일 정리 회차(`not_before`)는 그때부터 24시간 집힌다.
const CLAIM_SQL: &str = "update bg_job set status = 'running', claimed_at = now()
     where id = (
       select id from bg_job where account_id = $1::uuid and status = 'queued'
         and (($3 and not_before is null and day = $2::date)
           or (not_before <= now() and not_before > now() - interval '24 hours'))
       order by created_at limit 1 for update skip locked)
     returning id::text, kind, to_char(day, 'YYYY-MM-DD'), input::text";

fn digest_sql() -> &'static str {
    static S: std::sync::OnceLock<String> = std::sync::OnceLock::new();
    S.get_or_init(|| {
        format!(
            "select role, body from (with root as (
       select rm.id from message rm join channel c on c.id = rm.channel_id
        where rm.id = $2::uuid and rm.thread_root_id is null and rm.deleted_at is null and {}
     ), t as (
       select m.* from message m join root on (m.id = root.id or m.thread_root_id = root.id) where m.deleted_at is null
     )
     (select 'report' as role, t.body, t.created_at from t
       where t.author_id = $1::uuid and t.kind = 'user' and coalesce(t.meta->>'kind', '') not in ('failure', 'ask', 'wake')
       order by t.seq desc limit 1)
     union all
     (select 'failure', t.body, t.created_at from t where t.author_id = $1::uuid and t.meta->>'kind' = 'failure' order by t.seq desc limit 3)
     union all
     (select 'human', t.body, t.created_at from t join account a on a.id = t.author_id and a.kind = 'human'
       where t.kind = 'user' order by t.seq desc limit 10)) x",
            crate::core::channels::frag("channel_visible_c_p1uuid")
        )
    })
}

/// 일감 입력 중 Rust 가 TS 와 같은 글자로 낼 수 있는 꼴 — 키가 `threadIds`·`digests` 뿐이고 `threadIds` 는 uuid 글자의 배열.
/// TS 는 `{ ...job.input }` 에서 `digests` 를 지우고(distill 이면 끝에 다시 단다) 나머지 키를 jsonb 순서로 낸다 — 남는 키가
/// `threadIds` 하나뿐이면 순서가 갈릴 일이 없다. 그 밖은 `None`(→ 트랜잭션을 되돌리고 TS 가 집는다).
pub fn input_threads(input: &serde_json::Value) -> Option<Option<Vec<String>>> {
    let o = input.as_object()?;
    if o.keys().any(|k| k != "threadIds" && k != "digests") {
        return None;
    }
    match o.get("threadIds") {
        None => Some(None),
        Some(v) => {
            let a = v.as_array()?;
            a.iter()
                .map(|t| {
                    t.as_str()
                        .filter(|s| crate::core::msg_read::is_uuid(s))
                        .map(str::to_owned)
                })
                .collect::<Option<Vec<_>>>()
                .map(Some)
        }
    }
}

/// TS `bgClaimPayload` 의 `input` 글자 — `threadIds`(있으면) 다음 `digests`(distill 만). 같은 스레드가 두 번이면 JS 객체처럼 첫
/// 자리에 한 번. 빈 요약은 싣지 않는다(`if (d)`).
pub fn input_text(threads: &Option<Vec<String>>, digests: Option<&[(String, Vec<u16>)]>) -> String {
    let mut parts: Vec<String> = vec![];
    if let Some(t) = threads {
        parts.push(format!(
            "\"threadIds\":{}",
            serde_json::Value::from(t.clone())
        ));
    }
    if let Some(d) = digests {
        let mut seen: Vec<&str> = vec![];
        let mut kv: Vec<String> = vec![];
        for (k, v) in d {
            if v.is_empty() || seen.contains(&k.as_str()) {
                continue;
            }
            seen.push(k);
            kv.push(format!(
                "{}:{}",
                serde_json::Value::from(k.as_str()),
                js_json_string(v)
            ));
        }
        parts.push(format!("\"digests\":{{{}}}", kv.join(",")));
    }
    format!("{{{}}}", parts.join(","))
}

/// 정리·구조 정리의 입력 — 서버 생산자가 넣은 고정 칸(`reasons`·`changes`)만 싣는다.
fn plain_input(input: &serde_json::Value) -> String {
    let mut o = serde_json::Map::new();
    for k in ["reasons", "changes"] {
        if let Some(v) = input.get(k) {
            o.insert(k.to_owned(), v.clone());
        }
    }
    serde_json::Value::Object(o).to_string()
}

/// TS `bg.claim` 의 러너 뒤 본체(`claimBgJob` + `bgClaimPayload`). `None` 이면 TS 가 답한다 — 집기(update)와 입력 확인·요약
/// 만들기를 한 트랜잭션에 묶어, 그 사이 어디서 막혀도 되돌린 뒤 넘긴다(TS 가 같은 일감을 다시 집는다). 되돌릴 수 없는 것은
/// commit 실패뿐이다 — 그때는 집혔는지 모르니 넘기지 않고 `internal` 로 답한다(security W1).
pub async fn claim(
    read: &sqlx::PgPool,
    write: &sqlx::PgPool,
    me: &str,
    now_ms: i64,
    background: bool,
) -> Option<String> {
    use super::respond::text_result;
    let windowed = background && in_window(now_ms);
    let mut tx = write.begin().await.ok()?;
    let row: Option<(String, String, String, String)> = sqlx::query_as(CLAIM_SQL)
        .bind(me)
        .bind(kst_day(now_ms))
        .bind(windowed)
        .fetch_optional(&mut *tx)
        .await
        .ok()?;
    let Some((id, kind, day, input)) = row else {
        tx.rollback().await.ok()?;
        return Some(text_result("{\"job\":null,\"reason\":\"none\"}"));
    };
    let input: serde_json::Value = serde_json::from_str(&input).ok()?;
    let input_json = if kind == "distill" {
        let threads = input_threads(&input)?; // None 이면 tx 가 떨어지며 되돌려진다
        let mut d = vec![];
        for t in threads.iter().flatten() {
            // 글자는 골든 조각과 상수뿐이다(사용자 값은 자리표로만).
            let rows: Vec<(String, String)> = sqlx::query_as(sqlx::AssertSqlSafe(digest_sql()))
                .bind(me)
                .bind(t)
                .fetch_all(read)
                .await
                .ok()?;
            let rows = rows
                .into_iter()
                .map(|(r, b)| Role::parse(&r).map(|r| (r, b)))
                .collect::<Option<Vec<_>>>()?;
            d.push((t.clone(), assemble(rows)));
        }
        input_text(&threads, Some(&d))
    } else {
        plain_input(&input)
    };
    let job = format!(
        "{{\"job\":{{\"id\":{},\"kind\":{},\"day\":{},\"input\":{}}}}}",
        serde_json::Value::from(id),
        serde_json::Value::from(kind),
        serde_json::Value::from(day),
        input_json,
    );
    if tx.commit().await.is_err() {
        return Some(super::tools::err(
            "internal",
            "the write failed; it was not retried",
        ));
    }
    Some(text_result(&job))
}

#[cfg(test)]
mod tests {
    use super::*;

    const H: i64 = 60 * 60 * 1000;
    /// 2026-11-16T00:00:00 KST = 2026-11-15T15:00:00Z.
    const KST_MIDNIGHT: i64 = 1_794_754_800_000;

    #[test]
    fn kst_midnight_constant_is_right() {
        assert_eq!(kst_day(KST_MIDNIGHT), "2026-11-16");
        assert_eq!(kst_day(KST_MIDNIGHT - 1), "2026-11-15");
    }

    #[test]
    fn window_boundaries() {
        let m = 60 * 1000;
        assert!(!in_window(KST_MIDNIGHT + 3 * H - m)); // 02:59
        assert!(in_window(KST_MIDNIGHT + 3 * H)); // 03:00
        assert!(in_window(KST_MIDNIGHT + 7 * H - m)); // 06:59
        assert!(!in_window(KST_MIDNIGHT + 7 * H)); // 07:00
        assert!(!in_window(KST_MIDNIGHT + 7 * H - 1 + 1)); // 07:00:00.000
        assert!(in_window(KST_MIDNIGHT + 7 * H - 1)); // 06:59:59.999
    }

    #[test]
    fn kst_day_leap_and_year_edges() {
        // 2028-02-29T15:00:00Z = 2028-03-01 00:00 KST
        assert_eq!(kst_day(1_835_449_200_000), "2028-03-01");
        assert_eq!(kst_day(1_835_449_200_000 - 1), "2028-02-29");
        assert_eq!(kst_day(0), "1970-01-01");
    }

    fn s(u: &[u16]) -> String {
        String::from_utf16_lossy(u)
    }

    #[test]
    fn squash_uses_js_space_set() {
        assert_eq!(s(&squash("  a\t\n b\u{3000}c\u{feff} ")), "a b c");
        // U+0085(NEL)은 JS \s 가 아니다 — Rust char::is_whitespace 와 다른 점
        assert_eq!(s(&squash("a\u{85}b")), "a\u{85}b");
        assert_eq!(squash(" \u{a0} "), Vec::<u16>::new());
    }

    #[test]
    fn clip_counts_utf16_and_can_split_pairs() {
        let t: Vec<u16> = "ab😀".encode_utf16().collect(); // len 4
        assert_eq!(clip(t.clone(), 4), t);
        let c = clip(t, 3); // slice(0,2)='ab' + …
        assert_eq!(s(&c), "ab…");
        let t2: Vec<u16> = "a😀b".encode_utf16().collect(); // len 4
        let c2 = clip(t2, 3); // 'a' + 고위 서러게이트 + …
        assert_eq!(js_json_string(&c2), "\"a\\ud83d…\"");
    }

    #[test]
    fn assemble_orders_and_caps() {
        let rows = vec![
            (Role::Human, "h1".to_owned()),
            (Role::Report, "r".to_owned()),
            (Role::Failure, "f".to_owned()),
            (Role::Human, "h2".to_owned()),
        ];
        assert_eq!(
            s(&assemble(rows)),
            "[마지막 보고] r\n[실패] f\n[사람 글] h1\n[사람 글] h2"
        );
        let long = "x".repeat(700);
        let rows: Vec<_> = (0..10).map(|_| (Role::Human, long.clone())).collect();
        // 조각 = "[사람 글] "(7) + 600 = 607, +1 → 608. 4개 = 2432, 5개 = 3040 > 3000.
        let out = assemble(rows);
        assert_eq!(out.len(), 607 * 4 + 3);
    }

    #[test]
    fn json_string_matches_js() {
        let u: Vec<u16> = "a\"\\\u{1}\u{7f}😀\n".encode_utf16().collect();
        assert_eq!(js_json_string(&u), "\"a\\\"\\\\\\u0001\u{7f}😀\\n\"");
        assert_eq!(js_json_string(&[0xdc00, 0x41]), "\"\\udc00A\"");
    }
    #[test]
    fn runner_needs_operator_and_no_turn_headers() {
        use axum::http::{HeaderMap, HeaderValue};
        let mut h = HeaderMap::new();
        assert!(runner(true, &h));
        assert!(!runner(false, &h));
        h.insert("x-harkroom-cause", HeaderValue::from_static("not-a-uuid"));
        assert!(!runner(true, &h)); // 꼴이 틀린 값도 「있음」
        let mut h = HeaderMap::new();
        h.insert("x-harkroom-turn-id", HeaderValue::from_static(""));
        assert!(!runner(true, &h));
    }

    #[test]
    fn plain_input_keeps_known_keys() {
        use serde_json::json;
        assert_eq!(
            plain_input(&json!({"reasons":["weekly"],"digests":{"x":1}})),
            r#"{"reasons":["weekly"]}"#
        );
        assert_eq!(plain_input(&json!({"changes":60})), r#"{"changes":60}"#);
    }

    #[test]
    fn input_shapes() {
        use serde_json::json;
        let u = "4c230504-9b95-41ff-96a4-f83858cc7899";
        assert_eq!(input_threads(&json!({})), Some(None));
        assert_eq!(
            input_threads(&json!({"threadIds": [u], "digests": {"x": 1}})),
            Some(Some(vec![u.to_owned()]))
        );
        assert_eq!(input_threads(&json!({"threadIds": [u], "other": 1})), None);
        assert_eq!(input_threads(&json!({"threadIds": ["x"]})), None);
        assert_eq!(input_threads(&json!({"threadIds": u})), None);
        assert_eq!(input_threads(&json!([])), None);
    }

    #[test]
    fn input_text_matches_ts_payload() {
        let u = "4c230504-9b95-41ff-96a4-f83858cc7899".to_owned();
        let v = "5c230504-9b95-41ff-96a4-f83858cc7899".to_owned();
        assert_eq!(input_text(&None, None), "{}");
        assert_eq!(input_text(&None, Some(&[])), "{\"digests\":{}}");
        let d = vec![
            (u.clone(), "a".encode_utf16().collect()),
            (v.clone(), vec![]),
            (u.clone(), "a".encode_utf16().collect()),
        ];
        assert_eq!(
            input_text(&Some(vec![u.clone(), v.clone(), u.clone()]), Some(&d)),
            format!("{{\"threadIds\":[\"{u}\",\"{v}\",\"{u}\"],\"digests\":{{\"{u}\":\"a\"}}}}")
        );
    }
}
