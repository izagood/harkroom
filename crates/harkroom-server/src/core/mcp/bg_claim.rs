//! C4b ④-a(2/2) — MCP `bg.claim` 의 순수 조각(시계·JS 문자열 규칙·증류 요약 조립). DB·라우트 연결은 다음 커밋.
//!
//! 약속(security 02:21 KST):
//! - 창(03~07 KST)·KST 날짜는 **시계를 인자로** 받는다 — 경계값 단위 시험 + TS 상수·식 `include_str` 대조.
//! - 켜짐 판단은 TS 와 같은 출처여야 한다 — Rust env 가 아니라 TS `/mcp/admit` 이 알려 준 값만 믿는다(연결 커밋).
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
    let end = out.iter().rposition(|&u| u != 0x20).map_or(start, |i| i + 1);
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

    #[test]
    fn window_and_day_follow_ts_source() {
        let ts = include_str!("../../../../../packages/server/src/services/bgJobs.ts");
        for want in [
            "export const BG_WINDOW_KST: readonly [number, number] = [3, 7];",
            "const KST_OFFSET_MS = 9 * 60 * 60 * 1000;",
            "return new Date(now.getTime() + KST_OFFSET_MS).toISOString().slice(0, 10);",
            "const h = new Date(now.getTime() + KST_OFFSET_MS).getUTCHours();\n  return h >= BG_WINDOW_KST[0] && h < BG_WINDOW_KST[1];",
            "export const DISTILL_DIGEST_MAX_CHARS = 3000;",
            "const DIGEST_PIECE = { report: 800, failure: 500, human: 600 } as const;",
            "const clip = (t: string, n: number) => (t.length <= n ? t : `${t.slice(0, n - 1)}…`);",
            "const label = { report: '마지막 보고', failure: '실패', human: '사람 글' } as const;",
            "const order = { report: 0, failure: 1, human: 2 } as const;",
            ".map((x) => `[${label[x.role]}] ${clip(x.body.replace(/\\s+/g, ' ').trim(), DIGEST_PIECE[x.role])}`);",
            "if (used + p.length + 1 > DISTILL_DIGEST_MAX_CHARS) break;",
            "return out.join('\\n');",
        ] {
            assert!(ts.contains(want), "{want}");
        }
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
        assert_eq!(s(&assemble(rows)), "[마지막 보고] r\n[실패] f\n[사람 글] h1\n[사람 글] h2");
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
}
