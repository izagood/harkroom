//! IANA 시간대의 UTC 오프셋 — TS `cliUsage.ts` 의 `zonedToEpoch` 가 `Intl.DateTimeFormat` 으로 재던 값.
//!
//! 새 의존(chrono-tz 등)을 들이지 않고 OS 의 zoneinfo(TZif, RFC 8536)를 직접 읽는다. 명시 전이 뒤의
//! 시각은 파일 끝 POSIX TZ 규칙(`PST8PDT,M3.2.0,M11.1.0` 꼴, `M` 규칙만)으로 잰다. 못 읽으면 `None`
//! — TS 가 모르는 시간대에서 `null` 을 내는 것과 같다.

use std::path::PathBuf;

/// 그레고리력 날짜 → 1970-01-01 부터의 일 수(Howard Hinnant days_from_civil). `d` 가 달을 넘쳐도
/// 선형으로 이어진다(`Date.UTC` 의 넘침과 같다).
pub(super) fn days_from_civil(y: i64, m: i64, d: i64) -> i64 {
    let yy = if m <= 2 { y - 1 } else { y };
    let era = yy.div_euclid(400);
    let yoe = yy - era * 400;
    let mp = (m + 9) % 12;
    let doy = (153 * mp + 2) / 5 + d - 1;
    let doe = yoe * 365 + yoe / 4 - yoe / 100 + doy;
    era * 146_097 + doe - 719_468
}

/// 일 수 → (연, 월 1~12, 일).
pub(super) fn civil_from_days(z: i64) -> (i64, i64, i64) {
    let z = z + 719_468;
    let era = z.div_euclid(146_097);
    let doe = z - era * 146_097;
    let yoe = (doe - doe / 1460 + doe / 36_524 - doe / 146_096) / 365;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let d = doy - (153 * mp + 2) / 5 + 1;
    let m = if mp < 10 { mp + 3 } else { mp - 9 };
    (yoe + era * 400 + i64::from(m <= 2), m, d)
}

/// 시간대 이름이 zoneinfo 안의 파일 이름으로만 읽히게 한다 — `..`·절대 경로·이상한 글자는 거절.
/// 이름은 CLI 출력에서 오므로 경로를 지어낼 수 있는 입력으로 다룬다.
fn zone_path(name: &str) -> Option<PathBuf> {
    if name.is_empty()
        || name.len() > 64
        || name.starts_with('/')
        || !name
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || matches!(c, '/' | '_' | '-' | '+'))
        || name
            .split('/')
            .any(|p| p.is_empty() || p == "." || p == "..")
    {
        return None;
    }
    let dir = std::env::var_os("TZDIR")
        .map(PathBuf::from)
        .unwrap_or_else(|| PathBuf::from("/usr/share/zoneinfo"));
    Some(dir.join(name))
}

#[derive(Debug, Clone, PartialEq)]
pub(super) struct Zone {
    trans: Vec<i64>,
    idx: Vec<u8>,
    offs: Vec<i64>,
    rule: Option<Rule>,
}

#[derive(Debug, Clone, PartialEq)]
struct Rule {
    std_off: i64,
    dst: Option<(i64, RuleDate, i64, RuleDate, i64)>, // dst_off, start, start_time, end, end_time
}

#[derive(Debug, Clone, Copy, PartialEq)]
struct RuleDate {
    month: i64,
    week: i64,
    wday: i64,
}

fn be(b: &[u8], at: usize, n: usize) -> Option<i64> {
    let s = b.get(at..at + n)?;
    Some(match n {
        4 => i64::from(i32::from_be_bytes(s.try_into().ok()?)),
        8 => i64::from_be_bytes(s.try_into().ok()?),
        _ => return None,
    })
}

pub(super) fn load(name: &str) -> Option<Zone> {
    let bytes = std::fs::read(zone_path(name)?).ok()?;
    parse_tzif(&bytes)
}

pub(super) fn parse_tzif(b: &[u8]) -> Option<Zone> {
    if b.get(0..4)? != b"TZif" {
        return None;
    }
    let counts = |at: usize| -> Option<[usize; 6]> {
        let mut c = [0usize; 6];
        for (i, v) in c.iter_mut().enumerate() {
            *v = usize::try_from(be(b, at + 20 + i * 4, 4)?).ok()?;
        }
        Some(c)
    };
    let [isut, isstd, leap, timecnt, typecnt, charcnt] = counts(0)?;
    let v1_len = timecnt * 5 + typecnt * 6 + charcnt + leap * 8 + isstd + isut;
    let (base, tsz, [isut, isstd, leap, timecnt, typecnt, charcnt]) = if *b.get(4)? >= b'2' {
        let h2 = 44 + v1_len;
        if b.get(h2..h2 + 4)? != b"TZif" {
            return None;
        }
        (h2 + 44, 8, counts(h2)?)
    } else {
        (44, 4, [isut, isstd, leap, timecnt, typecnt, charcnt])
    };
    if typecnt == 0 {
        return None;
    }
    let mut trans = Vec::with_capacity(timecnt);
    for i in 0..timecnt {
        trans.push(be(b, base + i * tsz, tsz)?);
    }
    let idx_at = base + timecnt * tsz;
    let idx = b.get(idx_at..idx_at + timecnt)?.to_vec();
    let ti_at = idx_at + timecnt;
    let mut offs = Vec::with_capacity(typecnt);
    for i in 0..typecnt {
        offs.push(be(b, ti_at + i * 6, 4)?);
    }
    if idx.iter().any(|&i| usize::from(i) >= typecnt) {
        return None;
    }
    let rule = if tsz == 8 {
        let footer_at = ti_at + typecnt * 6 + charcnt + leap * 12 + isstd + isut;
        b.get(footer_at..)
            .and_then(|f| f.strip_prefix(b"\n"))
            .and_then(|f| f.split(|&c| c == b'\n').next())
            .and_then(|f| std::str::from_utf8(f).ok())
            .and_then(parse_posix)
    } else {
        None
    };
    Some(Zone {
        trans,
        idx,
        offs,
        rule,
    })
}

/// POSIX TZ 문자열 — `std offset [dst [offset] [,Mm.w.d[/time],Mm.w.d[/time]]]`. 오프셋 부호는 POSIX 식
/// (서쪽이 +)이라 뒤집어 UTC 오프셋으로 둔다. `J`·n 줄의 날 규칙은 쓰지 않는다(`None`).
fn parse_posix(s: &str) -> Option<Rule> {
    let mut p = s;
    let name = |p: &mut &str| -> Option<()> {
        if let Some(r) = p.strip_prefix('<') {
            let end = r.find('>')?;
            *p = &r[end + 1..];
        } else {
            let n = p.chars().take_while(char::is_ascii_alphabetic).count();
            if n < 3 {
                return None;
            }
            *p = &p[n..];
        }
        Some(())
    };
    let hms = |p: &mut &str| -> Option<i64> {
        let neg = p.starts_with('-');
        if p.starts_with(['-', '+']) {
            *p = &p[1..];
        }
        let mut total = 0;
        for (i, mul) in [3600, 60, 1].into_iter().enumerate() {
            if i > 0 {
                match p.strip_prefix(':') {
                    Some(r) => *p = r,
                    None => break,
                }
            }
            let n = p.chars().take_while(char::is_ascii_digit).count();
            if n == 0 {
                return None;
            }
            total += p[..n].parse::<i64>().ok()? * mul;
            *p = &p[n..];
        }
        Some(if neg { -total } else { total })
    };
    let date = |p: &mut &str| -> Option<(RuleDate, i64)> {
        let r = p.strip_prefix('M')?;
        let mut it = r.splitn(3, '.');
        let month = it.next()?.parse::<i64>().ok()?;
        let week = it.next()?.parse::<i64>().ok()?;
        let rest = it.next()?;
        let n = rest.chars().take_while(char::is_ascii_digit).count();
        let wday = rest[..n].parse::<i64>().ok()?;
        *p = &rest[n..];
        let time = match p.strip_prefix('/') {
            Some(r) => {
                *p = r;
                hms(p)?
            }
            None => 7200,
        };
        ((1..=12).contains(&month) && (1..=5).contains(&week) && (0..=6).contains(&wday))
            .then_some((RuleDate { month, week, wday }, time))
    };
    name(&mut p)?;
    let std_off = -hms(&mut p)?;
    if p.is_empty() {
        return Some(Rule { std_off, dst: None });
    }
    name(&mut p)?;
    let dst_off = if p.starts_with(',') {
        std_off + 3600
    } else {
        -hms(&mut p)?
    };
    p = p.strip_prefix(',')?;
    let (start, st) = date(&mut p)?;
    p = p.strip_prefix(',')?;
    let (end, et) = date(&mut p)?;
    p.is_empty().then_some(Rule {
        std_off,
        dst: Some((dst_off, start, st, end, et)),
    })
}

/// 그 해의 `Mm.w.d` 날짜(일 수). 5주째는 그 달의 마지막 그 요일.
fn rule_day(y: i64, r: RuleDate) -> i64 {
    let first = days_from_civil(y, r.month, 1);
    let wd1 = (first + 4).rem_euclid(7); // 1970-01-01 은 목요일(4)
    let mut day = first + (r.wday - wd1).rem_euclid(7) + (r.week - 1) * 7;
    let next_month = if r.month == 12 {
        days_from_civil(y + 1, 1, 1)
    } else {
        days_from_civil(y, r.month + 1, 1)
    };
    while day >= next_month {
        day -= 7;
    }
    day
}

impl Rule {
    fn offset_at(&self, t: i64) -> i64 {
        let Some((dst_off, s, st, e, et)) = self.dst else {
            return self.std_off;
        };
        let (y, _, _) = civil_from_days((t + self.std_off).div_euclid(86_400));
        let start = rule_day(y, s) * 86_400 + st - self.std_off;
        let end = rule_day(y, e) * 86_400 + et - dst_off;
        let in_dst = if start < end {
            start <= t && t < end
        } else {
            !(end <= t && t < start)
        };
        if in_dst { dst_off } else { self.std_off }
    }
}

impl Zone {
    /// UTC 시각 `t`(초)에서의 UTC 오프셋(초).
    pub(super) fn offset_at(&self, t: i64) -> i64 {
        match self.trans.iter().rposition(|&x| x <= t) {
            None => match &self.rule {
                // 전이가 하나도 없으면(slim 파일) 꼬리 규칙이 모든 시각을 맡는다.
                Some(r) if self.trans.is_empty() => r.offset_at(t),
                _ => self.offs[0],
            },
            Some(i) if i + 1 == self.trans.len() => match &self.rule {
                Some(r) => r.offset_at(t),
                None => self.offs[usize::from(self.idx[i])],
            },
            Some(i) => self.offs[usize::from(self.idx[i])],
        }
    }
}
