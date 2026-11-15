//! 백그라운드 회차 닫기 sweep(S5.3 C5c-3a) — TS `services/bgJobs.ts::createBgJobSweeper` 의 `close` 몫을 옮긴다.
//!
//! - 집은 지 [`BG_STALE_RUNNING`] 넘게 `running` 인 회차 → `failed`(`timeout`). 러너의 하드 타임아웃(10분)보다 길다.
//! - 지난 KST 날의 집히지 않은(`queued`) 일감 → `skipped`(`expired`). 회차는 그날 창(03~07 KST)에서만 집힌다.
//! - 스위치 `HARKROOM_BACKGROUND_ENABLED=1` 이 아니면 아무것도 안 한다(TS 와 같다).
//! - 생산자(distill·cleanup·organize)는 아직 TS 다 — 문지기 이름을 `bg.produce` 로 따로 두어 이 루프(`bg`)의 주인과 상관없이 TS 가 돈다.
//! - 이중 실행: 평소에는 문지기(이름 `bg`)가 한쪽만 돌린다. 이 sweep 은 `skip locked` 가 아니라 조건부 `update … where status = …` 다 —
//!   두 쪽이 같은 줄을 동시에 고치면 늦은 쪽은 줄 잠금을 기다린 뒤 조건을 다시 보고(이미 `failed`·`skipped`) 건너뛴다. 한 줄은 한 번만 닫힌다.
use super::{GateResult, Side, run_gated};
use sqlx::PgPool;
use std::time::Duration;

/// TS `BG_SWEEP_INTERVAL_MS`.
pub const BG_SWEEP_INTERVAL: Duration = Duration::from_secs(60);
/// TS `BG_STALE_RUNNING_MS` — 문장 안의 `interval '15 minutes'` 와 같아야 한다(단위 시험이 본다).
pub const BG_STALE_RUNNING: Duration = Duration::from_secs(15 * 60);

const CLOSE_TIMEOUT_SQL: &str = "update bg_job set status = 'failed', error = 'timeout', finished_at = now() \
     where status = 'running' and claimed_at < now() - interval '15 minutes'";
/// TS `kstDay(now)` — UTC 시각에 9시간을 더한 날짜 = `Asia/Seoul` 의 날짜(KST 는 서머타임이 없다).
const CLOSE_EXPIRED_SQL: &str = "update bg_job set status = 'skipped', error = 'expired', finished_at = now() \
     where status = 'queued' and day < (now() at time zone 'Asia/Seoul')::date";

/// 이 루프가 쓰는 권한(표, 권한) — homelab GRANT 와 같아야 한다. 없으면 `main.rs` 가 루프를 띄우지 않는다(TS 에 남는다).
pub const BG_PRIVILEGES: &[(&str, &str)] = &[
    ("bg_job.status", "UPDATE"),
    ("bg_job.error", "UPDATE"),
    ("bg_job.finished_at", "UPDATE"),
];

/// TS `backgroundEnabled` — 정확히 `"1"` 일 때만.
pub fn background_enabled(v: Option<&str>) -> bool {
    v == Some("1")
}

/// TS `close` — (timeout 으로 닫은 수, expired 로 닫은 수).
pub async fn close(pool: &PgPool) -> Result<(u64, u64), sqlx::Error> {
    let timeout = sqlx::query(CLOSE_TIMEOUT_SQL)
        .execute(pool)
        .await?
        .rows_affected();
    let expired = sqlx::query(CLOSE_EXPIRED_SQL)
        .execute(pool)
        .await?
        .rows_affected();
    Ok((timeout, expired))
}

/// 1분마다 문지기 아래서 닫기. 스위치(`enabled`)가 꺼져 있으면 tick 마다 아무것도 안 한다(TS 와 같다 — 잠금·주인도 안 본다).
/// `gate` 는 문지기(잠금) 연결 전용 풀, `pool` 은 sweep 풀이다.
pub fn spawn(gate: PgPool, pool: PgPool, enabled: bool) -> tokio::task::JoinHandle<()> {
    tokio::spawn(async move {
        let mut every = tokio::time::interval(BG_SWEEP_INTERVAL);
        every.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Delay);
        loop {
            every.tick().await;
            if !enabled {
                continue;
            }
            match run_gated(&gate, "bg", Side::Rust, || async {
                close(&pool).await.map(|_| ())
            })
            .await
            {
                GateResult::Gate(e) => eprintln!("loop bg: gate failed: {e}"),
                GateResult::Sweep(e) => eprintln!("loop bg: sweep failed: {e}"),
                _ => {}
            }
        }
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn stale_interval_matches_sql() {
        assert_eq!(BG_STALE_RUNNING.as_secs(), 15 * 60);
        assert!(CLOSE_TIMEOUT_SQL.contains("interval '15 minutes'"));
    }

    #[test]
    fn switch_is_exactly_one() {
        assert!(background_enabled(Some("1")));
        for v in [None, Some(""), Some("true"), Some("0"), Some(" 1")] {
            assert!(!background_enabled(v), "{v:?}");
        }
    }
}
