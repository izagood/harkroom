//! 러너·오퍼레이터 로그 줄의 머리 — **시각(UTC, ms)** 과, 알면 **세션 표지**.
//!
//! 로그는 stderr 로 파일에 붙는다(러너는 `runner-<agentId>.log`). 줄에 시각이 없으면 「언제부터 늘었나」를 로그로 못 잰다
//! (2026-11-19 관문 오탐 분석이 여기서 막혔다). 두 crate 의 `eprintln!` 을 이 모듈로 돌려 모든 줄에 머리를 붙인다 —
//! 줄 본문은 그대로라, 본문을 `contains` 로 찾는 자리(러너 종료 까닭 판정)는 영향이 없다.
//!
//! 세션 표지는 스레드 로컬이다: 턴 시도가 [`scope`] 로 걸고 그 스레드에서 찍는 줄에만 붙는다. 다른 스레드의 줄에는
//! 시각만 붙는다. 표지에는 세션 id 처럼 **비밀이 아닌 식별자만** 넣는다(계정·경로 금지).

use std::cell::RefCell;
use std::time::{SystemTime, UNIX_EPOCH};

thread_local! {
    static CTX: RefCell<Option<String>> = const { RefCell::new(None) };
}

/// [`scope`] 가 돌려주는 손잡이 — 떨어지면 앞 표지로 되돌린다(겹쳐 걸 수 있다).
pub struct Scope(Option<String>);

impl Drop for Scope {
    fn drop(&mut self) {
        let prev = self.0.take();
        CTX.with(|c| *c.borrow_mut() = prev);
    }
}

/// 이 스레드의 로그 줄에 세션 표지를 건다. `None` 이면 표지를 내린다.
pub fn scope(session: Option<&str>) -> Scope {
    let next = session.map(clean);
    Scope(CTX.with(|c| c.replace(next)))
}

/// 표지는 한 낱말로 — 줄을 깨는 글자·공백은 뺀다, 64자까지.
fn clean(s: &str) -> String {
    s.chars()
        .filter(|c| c.is_ascii_alphanumeric() || "-_.:".contains(*c))
        .take(64)
        .collect()
}

/// 지금의 줄 머리 — `2026-11-19T14:23:34.123Z ` 또는 `… [s=<세션>] `.
pub fn head() -> String {
    let ms = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis())
        .unwrap_or(0);
    let stamp = stamp_utc(u64::try_from(ms).unwrap_or(u64::MAX));
    match CTX.with(|c| c.borrow().clone()) {
        Some(s) if !s.is_empty() => format!("{stamp} [s={s}] "),
        _ => format!("{stamp} "),
    }
}

/// 에포크 ms → `YYYY-MM-DDTHH:MM:SS.mmmZ`(UTC). 날짜 계산은 civil-from-days(그레고리력)다.
pub fn stamp_utc(epoch_ms: u64) -> String {
    let secs = epoch_ms / 1000;
    let (days, rem) = (secs / 86_400, secs % 86_400);
    let z = days as i64 + 719_468;
    let era = z.div_euclid(146_097);
    let doe = z.rem_euclid(146_097);
    let yoe = (doe - doe / 1_460 + doe / 36_524 - doe / 146_096) / 365;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let d = doy - (153 * mp + 2) / 5 + 1;
    let m = if mp < 10 { mp + 3 } else { mp - 9 };
    let y = yoe + era * 400 + i64::from(m <= 2);
    format!(
        "{y:04}-{m:02}-{d:02}T{:02}:{:02}:{:02}.{:03}Z",
        rem / 3600,
        rem % 3600 / 60,
        rem % 60,
        epoch_ms % 1000
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn stamp_matches_known_instants() {
        assert_eq!(stamp_utc(0), "1970-01-01T00:00:00.000Z");
        // 윤년 2월 29일과 해 넘김.
        assert_eq!(stamp_utc(1_709_210_096_789), "2024-02-29T12:34:56.789Z");
        assert_eq!(stamp_utc(1_767_225_599_999), "2025-12-31T23:59:59.999Z");
        assert_eq!(stamp_utc(1_767_225_600_000), "2026-01-01T00:00:00.000Z");
    }

    #[test]
    fn scope_tags_this_thread_and_restores() {
        assert!(!head().contains("[s="));
        {
            let _a = scope(Some("ses-1"));
            assert!(head().ends_with("Z [s=ses-1] "));
            {
                // 줄을 깨는 글자는 빠진다.
                let _b = scope(Some("x y\n[z]"));
                assert!(head().ends_with("Z [s=xyz] "));
            }
            assert!(head().ends_with("Z [s=ses-1] "));
            // 다른 스레드에는 안 붙는다.
            let other = std::thread::spawn(head).join().unwrap();
            assert!(!other.contains("[s="));
        }
        assert!(!head().contains("[s="));
    }
}
