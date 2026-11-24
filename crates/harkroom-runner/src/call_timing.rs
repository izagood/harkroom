//! 턴 시작 길의 호출 시간 줄 — 폴이 돌아온 뒤 턴 임대를 받기까지 서버로 가는 호출마다 걸린 시간을 한 줄로 남긴다.
//!
//! 모든 줄은 `[시간] ` 로 시작한다(로그에서 이 머리로 걸러 읽는다). 줄 앞의 시각은 crate 의 `eprintln!` 이 붙인다.
//! 값은 호출 이름과 ms 뿐이다 — 응답 본문·토큰은 싣지 않는다.

use std::time::Instant;

/// 줄 머리.
pub const HEAD: &str = "[시간]";

/// 호출 하나의 줄.
pub fn line(what: &str, ms: u128) -> String {
    format!("{HEAD} {what} {ms}ms")
}

/// 여러 호출을 한 줄에 — `머리 전체ms — 이름 ms · 이름 ms`.
pub fn joined_line(what: &str, total_ms: u128, parts: &[(&str, u128)]) -> String {
    let parts: Vec<String> = parts.iter().map(|(n, ms)| format!("{n} {ms}")).collect();
    format!("{HEAD} {what} {total_ms}ms — {}", parts.join(" · "))
}

/// 한꺼번에 부른 같은 호출 여럿의 줄 — `머리 N건 전체ms`. 호출 하나하나의 줄은 그 호출이 따로 남긴다.
pub fn counted_line(what: &str, count: usize, total_ms: u128) -> String {
    format!("{HEAD} {what} {count}건 {total_ms}ms")
}

/// `f` 를 돌리고 걸린 시간(ms)을 같이 돌려준다. 줄은 남기지 않는다.
pub fn measured<T>(f: impl FnOnce() -> T) -> (T, u128) {
    let t = Instant::now();
    let v = f();
    (v, t.elapsed().as_millis())
}

/// `f` 를 돌리고 걸린 시간을 한 줄로 남긴다.
pub fn timed<T>(what: &str, f: impl FnOnce() -> T) -> T {
    let (v, ms) = measured(f);
    eprintln!("{}", line(what, ms));
    v
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn lines_carry_only_names_and_ms() {
        assert_eq!(
            line("POST /agent/turn-leases", 431),
            "[시간] POST /agent/turn-leases 431ms"
        );
        assert_eq!(
            joined_line("멘션 읽기(동시)", 520, &[("config", 410), ("guide", 430)]),
            "[시간] 멘션 읽기(동시) 520ms — config 410 · guide 430"
        );
    }

    #[test]
    fn counted_line_carries_count_and_total() {
        assert_eq!(
            counted_line("스레드 선점(동시)", 4, 561),
            "[시간] 스레드 선점(동시) 4건 561ms"
        );
    }

    #[test]
    fn measured_and_timed_return_the_value() {
        let (v, _ms) = measured(|| 7);
        assert_eq!(v, 7);
        assert_eq!(timed("x", || "y"), "y");
    }
}
