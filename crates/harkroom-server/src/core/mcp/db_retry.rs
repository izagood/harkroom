//! 읽기 풀이 잠깐 막혔을 때의 `message.read`·`inbox.poll` — 답하지 못했다고(`None`) 곧바로 TS 로 넘기지 않는다.
//!
//! 이 두 도구는 DB 오류를 `None`(→ TS)으로 돌려준다. 풀이 몇 초 막히면 그 동안의 부르기가 모두 TS 로 갔고, TS 를 끄면 그 자리는
//! 곧바로 실패가 된다. 그래서 `None` 이 오면 풀에서 연결을 하나 받아 본다([`probe`]):
//! - 기다리지 않고([`FREE`] 안) 받으면 DB 탓이 아니라 Rust 가 모르는 꼴이다 → 예전처럼 `None`(TS).
//! - 못 받거나 기다려서야 받으면(막혔다가 막 풀린 때) [`GAPS_MS`] 만큼 쉬며 다시 부른다(모두 [`ATTEMPTS`]번). 끝내 못 답하면
//!   TS 로 넘기지 않고 도구 오류 [`super::ts_down::CODE`](`temporarily_unavailable`)로 답한다 — TS 가 꺼졌을 때 앞단이 내는 답과 같은 꼴이다.
//!
//! 다시 부르는 것은 TS 로 넘기던 것보다 더 위험하지 않다 — TS 도 같은 부르기를 처음부터 다시 했다.
use super::route::AnswerFut;
use std::time::Duration;

/// 이 갈래를 타는 도구.
pub const COVERED: &[&str] = &["message.read", "inbox.poll"];
/// 다시 부르기 전 쉬는 시간(밀리초) — 길이 + 1 이 부르는 횟수다.
pub const GAPS_MS: [u64; 2] = [250, 750];
pub const ATTEMPTS: usize = GAPS_MS.len() + 1;
/// 풀을 볼 때 연결을 기다리는 한도.
pub const PROBE: Duration = Duration::from_secs(1);
/// 이 안에 연결을 받으면 풀이 막히지 않았다고 본다.
pub const FREE: Duration = Duration::from_millis(50);

/// 풀에서 연결 하나를 [`FREE`] 안에 받으면 참(막히지 않음). 못 받거나 그보다 오래 기다렸으면 거짓.
pub async fn probe(pool: &sqlx::PgPool) -> bool {
    let t = tokio::time::Instant::now();
    matches!(tokio::time::timeout(PROBE, pool.acquire()).await, Ok(Ok(_))) && t.elapsed() <= FREE
}

/// `attempt` 를 부르고, `None` 이면서 풀이 막혀 있으면 다시 부른다. 돌려주는 값은 [`super::route::Answer`] 와 같다.
pub async fn run<F>(pool: &sqlx::PgPool, tool: &str, mut attempt: F) -> Option<String>
where
    F: FnMut() -> AnswerFut,
{
    for n in 0..ATTEMPTS {
        if let Some(r) = attempt().await {
            return Some(r);
        }
        if probe(pool).await {
            return None;
        }
        if let Some(ms) = GAPS_MS.get(n) {
            tokio::time::sleep(Duration::from_millis(*ms)).await;
        }
    }
    eprintln!("front: mcp tool db unavailable tool={tool} attempts={ATTEMPTS}");
    Some(super::tool_error(super::ts_down::CODE, super::ts_down::MESSAGE).to_string())
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::Arc;
    use std::sync::atomic::{AtomicUsize, Ordering};

    fn dead_pool() -> sqlx::PgPool {
        sqlx::postgres::PgPoolOptions::new()
            .acquire_timeout(Duration::from_millis(200))
            .connect_lazy("postgres://nobody@127.0.0.1:1/none")
            .unwrap()
    }

    fn counting(
        hits: &Arc<AtomicUsize>,
        answer: Option<&'static str>,
    ) -> impl FnMut() -> AnswerFut {
        let hits = hits.clone();
        move || {
            hits.fetch_add(1, Ordering::SeqCst);
            Box::pin(async move { answer.map(str::to_owned) })
        }
    }

    #[tokio::test]
    async fn dead_pool_retries_then_answers_unavailable() {
        let hits = Arc::new(AtomicUsize::new(0));
        let r = run(&dead_pool(), "message.read", counting(&hits, None)).await;
        assert_eq!(hits.load(Ordering::SeqCst), ATTEMPTS);
        let r = r.expect("answered instead of handing to TS");
        assert!(r.contains("temporarily_unavailable"), "{r}");
    }

    #[tokio::test]
    async fn answer_on_first_try_is_returned_as_is() {
        let hits = Arc::new(AtomicUsize::new(0));
        let r = run(&dead_pool(), "inbox.poll", counting(&hits, Some("ok"))).await;
        assert_eq!(r.as_deref(), Some("ok"));
        assert_eq!(hits.load(Ordering::SeqCst), 1);
    }
}
