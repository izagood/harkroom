//! 턴을 시작한 때의 시계(정본 `mentionTurn.ts` 의 `now: new Date()` + `turnClockLine` 의 시스템 시간대) — 턴 프롬프트의
//! 「지금 시각」 줄 재료. TS 는 `Intl` 로 시간대 이름과 오프셋을 얻는다. 이 crate 에는 tz 데이터가 없어 이름은 `TZ` →
//! `/etc/localtime` 링크 대상에서, 그 순간의 오프셋은 libc `localtime_r` 의 `tm_gmtoff` 에서 얻는다.

use crate::prompt_turn::TurnClock;

/// 지금 이 기계의 시계.
pub fn turn_clock_now() -> TurnClock {
    let now_ms = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| i64::try_from(d.as_millis()).unwrap_or(i64::MAX))
        .unwrap_or(0);
    TurnClock {
        now_ms,
        time_zone: zone_name(
            std::env::var("TZ").ok().as_deref(),
            std::fs::read_link("/etc/localtime")
                .ok()
                .as_deref()
                .and_then(std::path::Path::to_str),
        ),
        utc_offset_minutes: utc_offset_minutes(now_ms.div_euclid(1000)),
    }
}

/// 시간대 이름 — `TZ`(IANA 이름이면) → `/etc/localtime` 링크의 `zoneinfo/` 뒤 → 없으면 `UTC`.
pub fn zone_name(tz_env: Option<&str>, localtime_link: Option<&str>) -> String {
    if let Some(tz) = tz_env.map(|t| t.trim_start_matches(':'))
        && looks_iana(tz)
    {
        return tz.to_string();
    }
    if let Some(link) = localtime_link
        && let Some((_, name)) = link.split_once("zoneinfo/")
        && looks_iana(name)
    {
        return name.to_string();
    }
    "UTC".to_string()
}

fn looks_iana(s: &str) -> bool {
    !s.is_empty()
        && !s.starts_with('/')
        && !s.contains("..")
        && s.chars()
            .all(|c| c.is_ascii_alphanumeric() || "/_+-".contains(c))
}

/// 그 순간의 UTC 오프셋(분) — `localtime_r` 의 `tm_gmtoff`. 실패하면 0.
pub fn utc_offset_minutes(unix_secs: i64) -> i32 {
    let t: libc::time_t = unix_secs as libc::time_t;
    // SAFETY: `tm` 은 0 으로 채운 지역 값이고 `localtime_r` 은 그 자리에만 쓴다(스레드 안전 판).
    let mut tm: libc::tm = unsafe { std::mem::zeroed() };
    let r = unsafe { libc::localtime_r(&t, &mut tm) };
    if r.is_null() {
        return 0;
    }
    i32::try_from(tm.tm_gmtoff / 60).unwrap_or(0)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn zone_name_prefers_tz_then_localtime_link() {
        assert_eq!(zone_name(Some("Asia/Seoul"), None), "Asia/Seoul");
        assert_eq!(zone_name(Some(":Europe/Paris"), None), "Europe/Paris");
        assert_eq!(
            zone_name(None, Some("/var/db/timezone/zoneinfo/Asia/Seoul")),
            "Asia/Seoul"
        );
        assert_eq!(
            zone_name(Some(""), Some("/usr/share/zoneinfo/America/New_York")),
            "America/New_York"
        );
        assert_eq!(zone_name(None, None), "UTC");
        assert_eq!(zone_name(Some("/etc/x"), Some("/nowhere")), "UTC");
        assert_eq!(zone_name(Some("../../x"), None), "UTC");
    }

    #[test]
    fn clock_now_has_a_recent_time_and_sane_offset() {
        let c = turn_clock_now();
        assert!(c.now_ms > 1_700_000_000_000);
        assert!(c.utc_offset_minutes.abs() <= 14 * 60);
        assert!(!c.time_zone.is_empty());
    }
}
