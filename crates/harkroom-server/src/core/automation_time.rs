//! 자동화 일정 트리거의 시간 계산(S5.4 결정 2) — TS `services/automations.ts` 의 「시간 계산」·「템플릿」 절
//! (`wallClock`·`offsetMs`·`zonedToUtc`·`daysInMonth`·`nextOccurrence`·`timeVars`)을 **같은 산법 그대로** 옮긴다.
//! TS 는 `Intl.DateTimeFormat` 으로 tz 벽시계를 풀고, 여기는 `chrono-tz` 의 IANA 표로 푼다 — 산법(오프셋 두 번 구하기,
//! 분 단위 내림)은 한 줄씩 같으므로 DST 경계의 결과도 같다(시험이 TS 로 뽑은 값을 고정한다).
//!
//! `Intl` 이 받는 tz 이름은 [`parse_tz`] 가 다 푼다: IANA 이름·링크(대소문자 무시), 오프셋 꼴(`+09:00`·`-0530`·`+09` — [`Zone::Fixed`],
//! `UTC+9` 는 `Intl` 도 거절), 그리고 tz 표에는 없고 ICU 만 아는 옛 이름([`icu_legacy`] — `JST`·`PST` 같은 세 글자 약칭과 `SystemV/*`).
//! 그래서 [`Schedule::parse`] 가 tz 때문에 `None` 인 것은 `Intl` 도 거절하는 이름이다. 남는 차이는 tz 표의 판(ICU vs chrono-tz 내장)뿐이다 —
//! 판이 다르면 그 사이 새로 생긴 이름·바뀐 규칙에서 갈린다.
use chrono::{Datelike, FixedOffset, NaiveDate, TimeZone, Timelike};
use chrono_tz::Tz;
use serde_json::Value;

/// TS `WallClock` — 분까지(초는 버린다, `Intl` 의 `formatToParts` 와 같다).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct WallClock {
    pub y: i32,
    pub m: u32,
    pub d: u32,
    pub h: u32,
    pub mi: u32,
}

/// UTC 기준 ms(TS `Date.getTime()`).
fn utc_ms(y: i32, m: u32, d: u32, h: u32, mi: u32) -> Option<i64> {
    let date = NaiveDate::from_ymd_opt(y, m, d)?;
    Some(date.and_hms_opt(h, mi, 0)?.and_utc().timestamp_millis())
}

/// 일정의 시간대 — IANA 이름(`chrono-tz`) 또는 `Intl` 이 받는 고정 오프셋 꼴(`+09:00`·`-0530`·`+09`).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Zone {
    Iana(Tz),
    Fixed(FixedOffset),
    /// ICU `SystemV/*` 의 서머타임 꼴(`EST5EDT` 등) — 표준시 오프셋(초, 동쪽이 +). 규칙은 [`systemv_dst`].
    SystemV(i32),
}

impl From<Tz> for Zone {
    fn from(tz: Tz) -> Self {
        Zone::Iana(tz)
    }
}

impl Zone {
    #[cfg(test)]
    fn name(&self) -> String {
        match self {
            Zone::Iana(tz) => tz.name().to_owned(),
            Zone::Fixed(o) => o.to_string(),
            Zone::SystemV(std) => format!("SystemV{:+}", std / 3600),
        }
    }
}

/// TS `wallClock(at, tz)`.
pub fn wall_clock(at_ms: i64, tz: Zone) -> Option<WallClock> {
    let utc = chrono::DateTime::from_timestamp_millis(at_ms)?.naive_utc();
    fn wc<T: Datelike + Timelike>(l: T) -> WallClock {
        WallClock {
            y: l.year(),
            m: l.month(),
            d: l.day(),
            h: l.hour(),
            mi: l.minute(),
        }
    }
    Some(match tz {
        Zone::Iana(z) => wc(z.from_utc_datetime(&utc)),
        Zone::Fixed(o) => wc(o.from_utc_datetime(&utc)),
        Zone::SystemV(std) => {
            let dst = if systemv_dst(at_ms.div_euclid(1000), std)? {
                3600
            } else {
                0
            };
            wc(FixedOffset::east_opt(std + dst)?.from_utc_datetime(&utc))
        }
    })
}

/// 그 달의 마지막 일요일.
fn last_sunday(y: i32, m: u32) -> Option<NaiveDate> {
    let last = NaiveDate::from_ymd_opt(y, m, days_in_month(y, m))?;
    last.checked_sub_days(chrono::Days::new(u64::from(
        last.weekday().num_days_from_sunday(),
    )))
}

/// ICU `SystemV/*` 서머타임 규칙(옛 미국 규칙이 해마다 그대로 간다): 4월 마지막 일요일 표준시 02:00 에 시작해 10월 마지막 일요일
/// 서머타임 02:00(= 표준시 01:00)에 끝난다. Node 22(ICU tzdata 2026a)의 전환 시각으로 확인했다(시험이 고정한다).
fn systemv_dst(utc_secs: i64, std: i32) -> Option<bool> {
    let local =
        chrono::DateTime::from_timestamp(utc_secs.checked_add(i64::from(std))?, 0)?.naive_utc();
    let y = local.year();
    let start = last_sunday(y, 4)?.and_hms_opt(2, 0, 0)?;
    let end = last_sunday(y, 10)?.and_hms_opt(1, 0, 0)?;
    Some(start <= local && local < end)
}

/// TS `offsetMs(at, tz)`.
fn offset_ms(at_ms: i64, tz: Zone) -> Option<i64> {
    let w = wall_clock(at_ms, tz)?;
    let as_utc = utc_ms(w.y, w.m, w.d, w.h, w.mi)?;
    Some(as_utc - at_ms.div_euclid(60_000) * 60_000)
}

/// TS `zonedToUtc(w, tz)` — 오프셋을 두 번 구한다(추정 시각과 실제 시각이 DST 경계 양쪽에 걸리면 첫 것이 틀린다).
pub fn zoned_to_utc(w: WallClock, tz: Zone) -> Option<i64> {
    let guess = utc_ms(w.y, w.m, w.d, w.h, w.mi)?;
    let o1 = offset_ms(guess, tz)?;
    let mut t = guess - o1;
    let o2 = offset_ms(t, tz)?;
    if o2 != o1 {
        t = guess - o2;
    }
    Some(t)
}

/// TS `daysInMonth(y, m)`(m 은 1~12).
fn days_in_month(y: i32, m: u32) -> u32 {
    let (ny, nm) = if m == 12 { (y + 1, 1) } else { (y, m + 1) };
    NaiveDate::from_ymd_opt(ny, nm, 1)
        .and_then(|d| d.pred_opt())
        .map_or(31, |d| d.day())
}

/// TS `AutomationSchedule` 의 `freq` 갈래.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Freq {
    Daily,
    /// 0 = 일요일(TS `getUTCDay`).
    Weekly(Vec<u32>),
    Monthly(u32),
}

/// TS `AutomationSchedule`(저장된 `automation.trigger`).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Schedule {
    pub freq: Freq,
    pub hh: u32,
    pub mm: u32,
    pub tz: Zone,
}

/// TS `isTimeZone` + `Intl` 해석 — IANA 이름은 `chrono-tz` 로(대소문자 무시, 별칭(backward 링크: `US/Eastern`·
/// `Asia/Calcutta` 등)도 받는다), 오프셋 꼴은 [`parse_offset`] 로, tz 표에 없는 ICU 옛 이름은 [`icu_legacy`] 로 푼다.
/// `None` 은 `Intl` 도 거절하는 이름이다(tz 표의 판 차이는 모듈 머리 참고).
pub fn parse_tz(s: &str) -> Option<Zone> {
    if let Some(o) = parse_offset(s) {
        return Some(Zone::Fixed(o));
    }
    if let Ok(tz) = s.parse::<Tz>() {
        return (tz.name() != "Factory").then_some(Zone::Iana(tz));
    }
    chrono_tz::TZ_VARIANTS
        .iter()
        .copied()
        .find(|tz| tz.name().eq_ignore_ascii_case(s) && tz.name() != "Factory")
        .map(Zone::Iana)
        .or_else(|| icu_legacy(s))
}

/// tz 표(IANA)에는 없지만 ICU 가 받는 옛 이름(대소문자 무시) — Node 22 `Intl` 이 받는 이름과 chrono-tz 0.10.4 의 이름을 견줘 남은 38개다.
/// 세 글자 약칭 25개는 ICU 가 푸는 IANA 시간대로(`resolvedOptions().timeZone`), `SystemV/*` 13개는 고정 오프셋 7개와
/// 서머타임 꼴 6개([`Zone::SystemV`])로 푼다. 짝은 Node 의 벽시계와 2020~2031년을 한 시간 단위로 견줘 같음을 확인했다.
fn icu_legacy(s: &str) -> Option<Zone> {
    use chrono_tz::{Africa, America, Asia, Australia, Europe, Pacific};
    const SHORT: &[(&str, Tz)] = &[
        ("ACT", Australia::Darwin),
        ("AET", Australia::Sydney),
        ("AGT", America::Argentina::Buenos_Aires),
        ("ART", Africa::Cairo),
        ("AST", America::Anchorage),
        ("BET", America::Sao_Paulo),
        ("BST", Asia::Dhaka),
        ("CAT", Africa::Maputo),
        ("CNT", America::St_Johns),
        ("CST", America::Chicago),
        ("CTT", Asia::Shanghai),
        ("EAT", Africa::Nairobi),
        ("ECT", Europe::Paris),
        ("IET", America::Indiana::Indianapolis),
        ("IST", Asia::Kolkata),
        ("JST", Asia::Tokyo),
        ("MIT", Pacific::Apia),
        ("NET", Asia::Yerevan),
        ("NST", Pacific::Auckland),
        ("PLT", Asia::Karachi),
        ("PNT", America::Phoenix),
        ("PRT", America::Puerto_Rico),
        ("PST", America::Los_Angeles),
        ("SST", Pacific::Guadalcanal),
        ("VST", Asia::Ho_Chi_Minh),
    ];
    // (이름, 표준시 서쪽 시간, 서머타임 꼴인지).
    const SYSTEM_V: &[(&str, i32, bool)] = &[
        ("AST4", 4, false),
        ("AST4ADT", 4, true),
        ("EST5", 5, false),
        ("EST5EDT", 5, true),
        ("CST6", 6, false),
        ("CST6CDT", 6, true),
        ("MST7", 7, false),
        ("MST7MDT", 7, true),
        ("PST8", 8, false),
        ("PST8PDT", 8, true),
        ("YST9", 9, false),
        ("YST9YDT", 9, true),
        ("HST10", 10, false),
    ];
    if let Some((_, tz)) = SHORT.iter().find(|(n, _)| n.eq_ignore_ascii_case(s)) {
        return Some(Zone::Iana(*tz));
    }
    let (head, rest) = s.split_at_checked(8)?;
    if !head.eq_ignore_ascii_case("SystemV/") {
        return None;
    }
    let (_, west, dst) = SYSTEM_V
        .iter()
        .find(|(n, ..)| n.eq_ignore_ascii_case(rest))?;
    let std = -west * 3600;
    if *dst {
        Some(Zone::SystemV(std))
    } else {
        FixedOffset::east_opt(std).map(Zone::Fixed)
    }
}

/// ECMA-402 오프셋 시간대(Node 22 `Intl` 이 받는 꼴): 부호(`+`·`-`·U+2212) + `HH`, 뒤에 `MM` 또는 `:MM` 이 붙을 수 있다.
/// `HH` 00~23, `MM` 00~59. 초·한 자리 시·`UTC+9` 같은 꼴은 `Intl` 도 거절한다.
fn parse_offset(s: &str) -> Option<FixedOffset> {
    let (neg, rest) = if let Some(r) = s.strip_prefix('+') {
        (false, r)
    } else if let Some(r) = s.strip_prefix('-') {
        (true, r)
    } else {
        (true, s.strip_prefix('\u{2212}')?)
    };
    let b = rest.as_bytes();
    if !b.iter().all(|c| c.is_ascii_digit() || *c == b':') {
        return None;
    }
    let (hh, mm) = match b.len() {
        2 => (&rest[..2], "00"),
        4 if b[..4].iter().all(u8::is_ascii_digit) => (&rest[..2], &rest[2..]),
        5 if b[2] == b':' => (&rest[..2], &rest[3..]),
        _ => return None,
    };
    if !hh.bytes().chain(mm.bytes()).all(|c| c.is_ascii_digit()) {
        return None;
    }
    let (h, m) = (hh.parse::<i32>().ok()?, mm.parse::<i32>().ok()?);
    if h > 23 || m > 59 {
        return None;
    }
    let secs = (h * 3600 + m * 60) * if neg { -1 } else { 1 };
    FixedOffset::east_opt(secs)
}

impl Schedule {
    /// 저장된 trigger(jsonb) → 일정. `kind != 'schedule'` 이거나 zod 가 받지 않았을 꼴·모르는 tz 면 `None`.
    pub fn parse(t: &Value) -> Option<Schedule> {
        if t.get("kind")?.as_str()? != "schedule" {
            return None;
        }
        let time = t.get("time")?.as_str()?;
        let b = time.as_bytes();
        // TS `HHMM = /^([01]\d|2[0-3]):[0-5]\d$/`.
        if b.len() != 5
            || b[2] != b':'
            || !b
                .iter()
                .enumerate()
                .all(|(i, c)| i == 2 || c.is_ascii_digit())
        {
            return None;
        }
        let hh = time[..2].parse::<u32>().ok()?;
        let mm = time[3..].parse::<u32>().ok()?;
        if hh > 23 || mm > 59 {
            return None;
        }
        let tz = parse_tz(t.get("tz")?.as_str()?)?;
        let freq = match t.get("freq")?.as_str()? {
            "daily" => Freq::Daily,
            "weekly" => {
                let mut days = Vec::new();
                for v in t.get("weekdays")?.as_array()? {
                    let n = u32::try_from(v.as_u64()?).ok()?;
                    if n > 6 {
                        return None;
                    }
                    days.push(n);
                }
                if days.is_empty() {
                    return None;
                }
                Freq::Weekly(days)
            }
            "monthly" => {
                let n = u32::try_from(t.get("monthDay")?.as_u64()?).ok()?;
                if !(1..=31).contains(&n) {
                    return None;
                }
                Freq::Monthly(n)
            }
            _ => return None,
        };
        Some(Schedule { freq, hh, mm, tz })
    }
}

/// TS `nextOccurrence(trigger, after)` — `after` 보다 **뒤의** 첫 회차(ms). 400일 안에 없으면 `None`.
pub fn next_occurrence(s: &Schedule, after_ms: i64) -> Option<i64> {
    let start = wall_clock(after_ms, s.tz)?;
    let base = NaiveDate::from_ymd_opt(start.y, start.m, start.d)?;
    for i in 0..=400u64 {
        let day = base.checked_add_days(chrono::Days::new(i))?;
        let (y, m, d) = (day.year(), day.month(), day.day());
        let matched = match &s.freq {
            Freq::Daily => true,
            Freq::Weekly(w) => w.contains(&day.weekday().num_days_from_sunday()),
            Freq::Monthly(md) => d == (*md).min(days_in_month(y, m)),
        };
        if !matched {
            continue;
        }
        let at = zoned_to_utc(
            WallClock {
                y,
                m,
                d,
                h: s.hh,
                mi: s.mm,
            },
            s.tz,
        )?;
        if at > after_ms {
            return Some(at);
        }
    }
    None
}

/// TS `timeVars(firedFor, tz)` — 키 순서도 TS 와 같다.
pub fn time_vars(fired_for_ms: i64, tz: Zone) -> Option<serde_json::Map<String, Value>> {
    let w = wall_clock(fired_for_ms, tz)?;
    let base = NaiveDate::from_ymd_opt(w.y, w.m, w.d)?;
    let dow = i64::from(base.weekday().num_days_from_sunday());
    let day = |offset: i64| base.checked_add_signed(chrono::TimeDelta::days(offset));
    let ymd = |x: NaiveDate| format!("{:04}-{:02}-{:02}", x.year(), x.month(), x.day());
    // 주는 월요일에 시작한다. 지난주 = 이번 주 월요일 7일 전 ~ 그 일요일.
    let since_monday = (dow + 6) % 7;
    let last_mon = ymd(day(-since_monday - 7)?);
    let last_sun = ymd(day(-since_monday - 1)?);
    let mut m = serde_json::Map::new();
    m.insert("date".into(), ymd(day(0)?).into());
    m.insert("yesterday".into(), ymd(day(-1)?).into());
    m.insert("lastWeek.start".into(), last_mon.clone().into());
    m.insert("lastWeek.end".into(), last_sun.clone().into());
    m.insert("lastWeek".into(), format!("{last_mon} ~ {last_sun}").into());
    Some(m)
}

/// ms → TS `Date.toISOString()`(`YYYY-MM-DDTHH:MM:SS.mmmZ`).
pub fn iso(ms: i64) -> Option<String> {
    let t = chrono::DateTime::from_timestamp_millis(ms)?;
    Some(t.format("%Y-%m-%dT%H:%M:%S%.3fZ").to_string())
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn ms(iso_s: &str) -> i64 {
        chrono::DateTime::parse_from_rfc3339(iso_s)
            .unwrap()
            .timestamp_millis()
    }
    fn next(t: Value, after: &str) -> String {
        iso(next_occurrence(&Schedule::parse(&t).unwrap(), ms(after)).unwrap()).unwrap()
    }
    fn zoned(y: i32, m: u32, d: u32, h: u32, mi: u32, tz: &str) -> String {
        iso(zoned_to_utc(WallClock { y, m, d, h, mi }, parse_tz(tz).unwrap()).unwrap()).unwrap()
    }

    // 기대값은 TS `automations.ts` 의 함수를 그대로 node(v8 Intl, ICU 78.2 / tzdata 2026a)로 돌려 뽑았다.
    // 봄에 건너뛰는 02:30(America/New_York)은 TS 산법상 **앞**(01:30 EST = 06:30Z)으로 간다 — TS 주석과 달라도 산법이 기준이다.
    #[test]
    fn zoned_to_utc_matches_ts() {
        assert_eq!(
            zoned(2026, 3, 8, 2, 30, "America/New_York"),
            "2026-03-08T06:30:00.000Z"
        );
        assert_eq!(
            zoned(2026, 3, 8, 1, 59, "America/New_York"),
            "2026-03-08T06:59:00.000Z"
        );
        assert_eq!(
            zoned(2026, 3, 8, 3, 0, "America/New_York"),
            "2026-03-08T07:00:00.000Z"
        );
        assert_eq!(
            zoned(2026, 11, 1, 1, 30, "America/New_York"),
            "2026-11-01T05:30:00.000Z"
        );
        assert_eq!(
            zoned(2026, 11, 1, 2, 30, "America/New_York"),
            "2026-11-01T07:30:00.000Z"
        );
        assert_eq!(
            zoned(2026, 3, 29, 1, 30, "Europe/London"),
            "2026-03-29T01:30:00.000Z"
        );
        assert_eq!(
            zoned(2026, 10, 25, 1, 30, "Europe/London"),
            "2026-10-25T01:30:00.000Z"
        );
        assert_eq!(
            zoned(2026, 6, 1, 9, 0, "Asia/Seoul"),
            "2026-06-01T00:00:00.000Z"
        );
        assert_eq!(
            zoned(2026, 10, 4, 2, 30, "Australia/Sydney"),
            "2026-10-03T16:30:00.000Z"
        );
        assert_eq!(
            zoned(2026, 4, 5, 2, 30, "Australia/Sydney"),
            "2026-04-04T16:30:00.000Z"
        );
        assert_eq!(
            zoned(2026, 3, 8, 2, 30, "America/St_Johns"),
            "2026-03-08T05:00:00.000Z"
        );
    }

    #[test]
    fn next_occurrence_matches_ts() {
        assert_eq!(
            next(
                json!({"freq": "daily", "time": "02:30", "tz": "America/New_York", "kind": "schedule"}),
                "2026-03-07T12:00:00Z"
            ),
            "2026-03-08T06:30:00.000Z"
        );
        assert_eq!(
            next(
                json!({"freq": "daily", "time": "02:30", "tz": "America/New_York", "kind": "schedule"}),
                "2026-03-08T06:30:00Z"
            ),
            "2026-03-09T06:30:00.000Z"
        );
        assert_eq!(
            next(
                json!({"freq": "daily", "time": "01:30", "tz": "America/New_York", "kind": "schedule"}),
                "2026-10-31T12:00:00Z"
            ),
            "2026-11-01T05:30:00.000Z"
        );
        assert_eq!(
            next(
                json!({"freq": "daily", "time": "09:00", "tz": "Asia/Seoul", "kind": "schedule"}),
                "2026-11-18T00:00:00Z"
            ),
            "2026-11-19T00:00:00.000Z"
        );
        assert_eq!(
            next(
                json!({"freq": "daily", "time": "09:00", "tz": "Asia/Seoul", "kind": "schedule"}),
                "2026-11-18T00:00:00.001Z"
            ),
            "2026-11-19T00:00:00.000Z"
        );
        assert_eq!(
            next(
                json!({"freq": "weekly", "weekdays": [1], "time": "09:00", "tz": "Asia/Seoul", "kind": "schedule"}),
                "2026-11-18T00:00:00Z"
            ),
            "2026-11-23T00:00:00.000Z"
        );
        assert_eq!(
            next(
                json!({"freq": "weekly", "weekdays": [0, 6], "time": "23:59", "tz": "Asia/Seoul", "kind": "schedule"}),
                "2026-11-20T15:00:00Z"
            ),
            "2026-11-21T14:59:00.000Z"
        );
        assert_eq!(
            next(
                json!({"freq": "monthly", "monthDay": 31, "time": "08:00", "tz": "Asia/Seoul", "kind": "schedule"}),
                "2026-01-31T00:00:00Z"
            ),
            "2026-02-27T23:00:00.000Z"
        );
        assert_eq!(
            next(
                json!({"freq": "monthly", "monthDay": 29, "time": "08:00", "tz": "Asia/Seoul", "kind": "schedule"}),
                "2027-02-01T00:00:00Z"
            ),
            "2027-02-27T23:00:00.000Z"
        );
        assert_eq!(
            next(
                json!({"freq": "weekly", "weekdays": [0], "time": "02:00", "tz": "America/New_York", "kind": "schedule"}),
                "2026-03-01T12:00:00Z"
            ),
            "2026-03-08T06:00:00.000Z"
        );
        assert_eq!(
            next(
                json!({"freq": "daily", "time": "00:00", "tz": "UTC", "kind": "schedule"}),
                "2026-12-31T23:59:59Z"
            ),
            "2027-01-01T00:00:00.000Z"
        );
    }

    #[test]
    fn time_vars_match_ts() {
        assert_eq!(
            Value::Object(
                time_vars(ms("2026-11-18T00:00:00Z"), parse_tz("Asia/Seoul").unwrap()).unwrap()
            ),
            json!({"date":"2026-11-18","yesterday":"2026-11-17","lastWeek.start":"2026-11-09","lastWeek.end":"2026-11-15","lastWeek":"2026-11-09 ~ 2026-11-15"})
        );
        assert_eq!(
            Value::Object(
                time_vars(ms("2026-11-15T15:00:00Z"), parse_tz("Asia/Seoul").unwrap()).unwrap()
            ),
            json!({"date":"2026-11-16","yesterday":"2026-11-15","lastWeek.start":"2026-11-09","lastWeek.end":"2026-11-15","lastWeek":"2026-11-09 ~ 2026-11-15"})
        );
        assert_eq!(
            Value::Object(
                time_vars(ms("2026-11-16T14:59:00Z"), parse_tz("Asia/Seoul").unwrap()).unwrap()
            ),
            json!({"date":"2026-11-16","yesterday":"2026-11-15","lastWeek.start":"2026-11-09","lastWeek.end":"2026-11-15","lastWeek":"2026-11-09 ~ 2026-11-15"})
        );
        assert_eq!(
            Value::Object(
                time_vars(
                    ms("2026-03-08T07:30:00Z"),
                    parse_tz("America/New_York").unwrap()
                )
                .unwrap()
            ),
            json!({"date":"2026-03-08","yesterday":"2026-03-07","lastWeek.start":"2026-02-23","lastWeek.end":"2026-03-01","lastWeek":"2026-02-23 ~ 2026-03-01"})
        );
        assert_eq!(
            Value::Object(
                time_vars(
                    ms("2026-03-02T04:59:00Z"),
                    parse_tz("America/New_York").unwrap()
                )
                .unwrap()
            ),
            json!({"date":"2026-03-01","yesterday":"2026-02-28","lastWeek.start":"2026-02-16","lastWeek.end":"2026-02-22","lastWeek":"2026-02-16 ~ 2026-02-22"})
        );
        assert_eq!(
            Value::Object(
                time_vars(
                    ms("2027-01-01T00:00:00Z"),
                    parse_tz("America/Los_Angeles").unwrap()
                )
                .unwrap()
            ),
            json!({"date":"2026-12-31","yesterday":"2026-12-30","lastWeek.start":"2026-12-21","lastWeek.end":"2026-12-27","lastWeek":"2026-12-21 ~ 2026-12-27"})
        );
    }

    // 전환 시각은 Node 22(ICU tzdata 2026a)의 `SystemV/EST5EDT`·`SystemV/YST9YDT` 에서 뽑았다.
    #[test]
    fn systemv_dst_matches_icu() {
        let est = parse_tz("SystemV/EST5EDT").unwrap();
        let hour = |at: &str, tz| wall_clock(ms(at), tz).map(|w| (w.d, w.h, w.mi));
        assert_eq!(hour("2026-04-26T06:59:00Z", est), Some((26, 1, 59)));
        assert_eq!(hour("2026-04-26T07:00:00Z", est), Some((26, 3, 0)));
        assert_eq!(hour("2026-10-25T05:59:00Z", est), Some((25, 1, 59)));
        assert_eq!(hour("2026-10-25T06:00:00Z", est), Some((25, 1, 0)));
        assert_eq!(hour("2027-10-31T05:59:00Z", est), Some((31, 1, 59)));
        assert_eq!(hour("2027-10-31T06:00:00Z", est), Some((31, 1, 0)));
        assert_eq!(hour("2028-04-30T07:00:00Z", est), Some((30, 3, 0)));
        let yst = parse_tz("SystemV/YST9YDT").unwrap();
        assert_eq!(hour("2026-04-26T10:59:00Z", yst), Some((26, 1, 59)));
        assert_eq!(hour("2026-04-26T11:00:00Z", yst), Some((26, 3, 0)));
        assert_eq!(hour("2026-10-25T10:00:00Z", yst), Some((25, 1, 0)));
        // 매일 09:00 — 서머타임 안(13:00Z)과 밖(14:00Z), 그리고 약칭(JST = 00:00Z).
        let daily = |tz: &str| json!({"kind":"schedule","freq":"daily","time":"09:00","tz":tz});
        assert_eq!(
            next(daily("SystemV/EST5EDT"), "2026-07-01T00:00:00Z"),
            "2026-07-01T13:00:00.000Z"
        );
        assert_eq!(
            next(daily("SystemV/EST5EDT"), "2026-12-01T00:00:00Z"),
            "2026-12-01T14:00:00.000Z"
        );
        assert_eq!(
            next(daily("SystemV/EST5"), "2026-07-01T00:00:00Z"),
            "2026-07-01T14:00:00.000Z"
        );
        assert_eq!(
            next(daily("JST"), "2026-07-01T00:30:00Z"),
            "2026-07-02T00:00:00.000Z"
        );
    }

    #[test]
    fn parse_rejects_what_zod_or_chrono_tz_would() {
        assert!(
            Schedule::parse(&json!({"kind":"schedule","freq":"daily","time":"9:00","tz":"UTC"}))
                .is_none()
        );
        assert!(
            Schedule::parse(&json!({"kind":"schedule","freq":"daily","time":"24:00","tz":"UTC"}))
                .is_none()
        );
        assert!(
            Schedule::parse(&json!({"kind":"schedule","freq":"daily","time":"09:00","tz":"UTC+9"}))
                .is_none()
        );
        // Intl 처럼 대소문자 무시·링크 이름도 받는다.
        assert_eq!(
            parse_tz("asia/seoul"),
            Some(Zone::Iana(chrono_tz::Asia::Seoul))
        );
        // Node 22 `Intl.DateTimeFormat` 으로 뽑은 받음/거절.
        for (z, want) in [
            ("+09:00", Some("+09:00")),
            ("-05:30", Some("-05:30")),
            ("+0900", Some("+09:00")),
            ("+09", Some("+09:00")),
            ("\u{2212}09:00", Some("-09:00")),
            ("-00:00", Some("+00:00")),
            ("+23:59", Some("+23:59")),
            ("UTC+9", None),
            ("GMT+9", None),
            ("+24:00", None),
            ("+9:00", None),
            ("+09:60", None),
            ("+0960", None),
            ("+09:00:00", None),
            ("+1", None),
            ("+123", None),
            ("+09:0", None),
            ("Z", None),
        ] {
            assert_eq!(parse_tz(z).map(|t| t.name()).as_deref(), want, "{z}");
        }
        let seoul_fixed = json!({"kind":"schedule","freq":"daily","time":"09:00","tz":"+09:00"});
        assert_eq!(
            iso(next_occurrence(
                &Schedule::parse(&seoul_fixed).unwrap(),
                ms("2026-11-18T00:30:00Z")
            )
            .unwrap())
            .unwrap(),
            "2026-11-19T00:00:00.000Z"
        );
        assert_eq!(
            parse_tz("ASIA/CALCUTTA").map(|t| t.name()).as_deref(),
            Some("Asia/Calcutta")
        );
        assert_eq!(
            parse_tz("us/eastern").map(|t| t.name()).as_deref(),
            Some("US/Eastern")
        );
        assert_eq!(parse_tz("Factory"), None);
        // ICU 만 아는 옛 이름 — Node 22 `Intl` 이 받는 것(대소문자 무시)과 거절하는 것.
        assert_eq!(parse_tz("JST"), Some(Zone::Iana(chrono_tz::Asia::Tokyo)));
        assert_eq!(parse_tz("jst"), Some(Zone::Iana(chrono_tz::Asia::Tokyo)));
        assert_eq!(
            parse_tz("PST"),
            Some(Zone::Iana(chrono_tz::America::Los_Angeles))
        );
        assert_eq!(
            parse_tz("SystemV/HST10").map(|t| t.name()).as_deref(),
            Some("-10:00")
        );
        assert_eq!(parse_tz("systemv/est5edt"), Some(Zone::SystemV(-5 * 3600)));
        for z in [
            "KST",
            "EDT",
            "PDT",
            "UT",
            "SystemV/",
            "SystemV/EST",
            "SystemV/한국",
            "Etc/Unknown",
        ] {
            assert_eq!(parse_tz(z), None, "{z}");
        }
        assert_eq!(parse_tz("Nope/X"), None);
        assert!(
            Schedule::parse(
                &json!({"kind":"schedule","freq":"weekly","weekdays":[],"time":"09:00","tz":"UTC"})
            )
            .is_none()
        );
        assert!(
            Schedule::parse(
                &json!({"kind":"schedule","freq":"monthly","monthDay":32,"time":"09:00","tz":"UTC"})
            )
            .is_none()
        );
        assert!(Schedule::parse(&json!({"kind":"webhook"})).is_none());
        assert!(
            Schedule::parse(
                &json!({"kind":"schedule","freq":"daily","time":"09:00","tz":"America/St_Johns"})
            )
            .is_some()
        );
    }
}
