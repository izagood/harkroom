//! 자동화 일정 트리거의 시간 계산(S5.4 결정 2) — TS `services/automations.ts` 의 「시간 계산」·「템플릿」 절
//! (`wallClock`·`offsetMs`·`zonedToUtc`·`daysInMonth`·`nextOccurrence`·`timeVars`)을 **같은 산법 그대로** 옮긴다.
//! TS 는 `Intl.DateTimeFormat` 으로 tz 벽시계를 풀고, 여기는 `chrono-tz` 의 IANA 표로 푼다 — 산법(오프셋 두 번 구하기,
//! 분 단위 내림)은 한 줄씩 같으므로 DST 경계의 결과도 같다(시험이 TS 로 뽑은 값을 고정한다).
//!
//! 남는 차이(그래서 [`Schedule::parse`] 가 `None` = TS 로 넘긴다): `Intl` 은 tz 이름을 대소문자 무시·별칭 정규화로 받는다 —
//! [`parse_tz`] 가 대소문자 무시·링크 이름까지 푼다. 그래도 chrono-tz 표에 없는 꼴(오프셋 `+09:00` 등)은 TS 몫이다. tz 표의 판(ICU vs chrono-tz 내장)이 다르면 그 사이 바뀐 규칙에서 갈린다.
use chrono::{Datelike, NaiveDate, TimeZone, Timelike};
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

/// TS `wallClock(at, tz)`.
pub fn wall_clock(at_ms: i64, tz: Tz) -> Option<WallClock> {
    let utc = chrono::DateTime::from_timestamp_millis(at_ms)?;
    let l = tz.from_utc_datetime(&utc.naive_utc());
    Some(WallClock {
        y: l.year(),
        m: l.month(),
        d: l.day(),
        h: l.hour(),
        mi: l.minute(),
    })
}

/// TS `offsetMs(at, tz)`.
fn offset_ms(at_ms: i64, tz: Tz) -> Option<i64> {
    let w = wall_clock(at_ms, tz)?;
    let as_utc = utc_ms(w.y, w.m, w.d, w.h, w.mi)?;
    Some(as_utc - at_ms.div_euclid(60_000) * 60_000)
}

/// TS `zonedToUtc(w, tz)` — 오프셋을 두 번 구한다(추정 시각과 실제 시각이 DST 경계 양쪽에 걸리면 첫 것이 틀린다).
pub fn zoned_to_utc(w: WallClock, tz: Tz) -> Option<i64> {
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
    pub tz: Tz,
}

/// `chrono-tz` 가 아는 tz — `Intl` 처럼 대소문자를 무시하고, 별칭(backward 링크: `US/Eastern`·`Asia/Calcutta` 등)도
/// 받는다(chrono-tz 표에 링크가 변형으로 들어 있어 같은 규칙으로 푼다). 모르면 `None`(오프셋 꼴 등 — 부른 쪽이 TS 로 넘긴다).
pub fn parse_tz(s: &str) -> Option<Tz> {
    if let Ok(tz) = s.parse::<Tz>() {
        return (tz.name() != "Factory").then_some(tz);
    }
    chrono_tz::TZ_VARIANTS
        .iter()
        .copied()
        .find(|tz| tz.name().eq_ignore_ascii_case(s) && tz.name() != "Factory")
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
pub fn time_vars(fired_for_ms: i64, tz: Tz) -> Option<serde_json::Map<String, Value>> {
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
            Schedule::parse(
                &json!({"kind":"schedule","freq":"daily","time":"09:00","tz":"+09:00"})
            )
            .is_none()
        );
        // Intl 처럼 대소문자 무시·링크 이름도 받는다.
        assert_eq!(parse_tz("asia/seoul"), Some(chrono_tz::Asia::Seoul));
        assert_eq!(
            parse_tz("ASIA/CALCUTTA").map(|t| t.name()),
            Some("Asia/Calcutta")
        );
        assert_eq!(parse_tz("us/eastern").map(|t| t.name()), Some("US/Eastern"));
        assert_eq!(parse_tz("Factory"), None);
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
