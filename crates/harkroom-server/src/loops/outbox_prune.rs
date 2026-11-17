//! event_outbox 정리 sweep(S5.3 C5c-4) — TS `eventBus.ts` 의 `pruneEventOutbox`(1분마다, 5분 지난 줄 delete)를 옮긴다.
//! 보존을 1시간 → 5분, 주기를 10분 → 1분으로 줄였다(C6-α) — outbox 에는 비공개 채널 본문과 audience 계정 id 가 실리고, 리스너는 ms 안에
//! 읽으며 끊긴 동안의 줄은 어차피 다시 읽지 않는다. 오래 둘 이유가 없고 노출 창만 크다.
//!
//! - 지우는 것은 `event_outbox` 에서 `created_at` 이 [`EVENT_OUTBOX_RETAIN`] 보다 오래된 줄뿐이다(조건은 상수, 요청 값을 받지 않는다).
//!   그때쯤이면 모든 프로세스가 이미 읽었다 — 리스너는 NOTIFY 를 받는 즉시 id 로 다시 읽는다.
//! - 이중 실행: 평소에는 문지기(`run_gated`, 이름 `outbox.prune`)가 한쪽만 돌린다. 그 아래에서도 이 delete 는 멱등이다 — 두 쪽이
//!   같은 줄을 동시에 지우려 하면 뒤 쪽은 줄 잠금을 기다린 뒤 이미 지워진 줄을 건너뛴다(0건). 지운 수의 합이 정확하다(시험이 보인다).
use super::{GateResult, Side, run_gated};
use sqlx::PgPool;
use std::time::Duration;

/// TS `EVENT_OUTBOX_RETAIN_MS`(5분). 아래 SQL 의 `interval '5 minutes'` 와 같아야 한다(시험이 본다).
pub const EVENT_OUTBOX_RETAIN: Duration = Duration::from_secs(5 * 60);
/// TS `EVENT_OUTBOX_PRUNE_EVERY_MS`(1분).
pub const OUTBOX_PRUNE_INTERVAL: Duration = Duration::from_secs(60);
/// 지우는 문장 — TS 와 같은 조건.
pub const OUTBOX_PRUNE_SQL: &str =
    "delete from event_outbox where created_at < now() - interval '5 minutes'";

/// 이 루프가 쓰는 권한 — 운영 GRANT 와 같아야 한다. 없으면 `main.rs` 가 루프를 띄우지 않는다(TS 에 남는다).
/// 고르는 SELECT 는 읽기 권한으로 이미 있다.
pub const OUTBOX_PRUNE_PRIVILEGES: &[(&str, &str)] = &[("event_outbox", "DELETE")];

/// TS `pruneEventOutbox` — 지운 수.
pub async fn prune(pool: &PgPool) -> Result<u64, sqlx::Error> {
    Ok(sqlx::query(OUTBOX_PRUNE_SQL)
        .execute(pool)
        .await?
        .rows_affected())
}

/// 루프를 띄운다 — 1분마다. 주인이 `rust` 일 때만 실제로 돈다. `gate` 는 문지기(잠금) 연결 전용 풀, `pool` 은 sweep 풀이다.
pub fn spawn(gate: PgPool, pool: PgPool) -> tokio::task::JoinHandle<()> {
    tokio::spawn(async move {
        let mut every = tokio::time::interval(OUTBOX_PRUNE_INTERVAL);
        every.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Delay);
        // TS 는 setInterval 이라 첫 정리는 1분 뒤다 — 같게 맞춘다(interval 의 첫 tick 은 즉시라 하나 버린다).
        every.tick().await;
        loop {
            every.tick().await;
            let p = &pool;
            match run_gated(&gate, "outbox.prune", Side::Rust, || async move {
                prune(p).await.map(|_| ())
            })
            .await
            {
                // 실패는 다음 시각에 다시 한다 — 정리는 늦어도 해가 없다. 오류 문구만(행 내용 없음).
                GateResult::Gate(e) => eprintln!("loop outbox.prune: gate failed: {e}"),
                GateResult::Sweep(e) => eprintln!("loop outbox.prune: sweep failed: {e}"),
                _ => {}
            }
        }
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn sql_matches_retain() {
        assert_eq!(EVENT_OUTBOX_RETAIN.as_secs(), 300);
        assert_eq!(OUTBOX_PRUNE_INTERVAL.as_secs(), 60);
        assert!(OUTBOX_PRUNE_SQL.ends_with("interval '5 minutes'"));
    }
}
