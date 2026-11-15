//! 보존 기간 정리 sweep(S5.3 C5c) — TS `services/retention.ts::createRetentionSweeper` 를 옮긴다.
//!
//! - 지우는 것은 [`RETENTION_RULES`] 둘뿐이다(표·조건은 상수, 요청 값을 받지 않는다). 지우지 않는 표의 목록과 까닭은 TS 주석 그대로다.
//! - 지우기는 `HARKROOM_RETENTION_DELETE=1` 일 때만. 꺼져 있으면 sweep 마다 표마다 대상 수만 센다(dry-run). 켜져 있으면 첫 sweep 에서
//!   지우기 전에 한 번 세고, 그 뒤 sweep 마다 표마다 [`RETENTION_BATCH`] 줄까지만 지운다. 로그에는 표 이름과 수만 남긴다.
//! - 첫 sweep 은 기동 [`RETENTION_FIRST_DELAY`] 뒤, 그 뒤 [`RETENTION_SWEEP_INTERVAL`] 마다(TS 와 같다).
//! - 이중 실행: 평소에는 문지기(`run_gated`, 이름 `retention`)가 한쪽만 돌린다. 이 sweep 은 `skip locked` 가 아니라
//!   `delete … where ctid in (… limit)` 이다 — 두 쪽이 같은 줄을 동시에 지우려 해도 뒤 쪽은 줄 잠금을 기다린 뒤 이미 지워진 줄을
//!   건너뛴다(0건). 지우기는 멱등이라 겹쳐도 더 지워지거나 두 번 세어지는 것이 없다(시험이 보인다).
use super::{GateResult, Side, run_gated};
use sqlx::PgPool;
use std::time::Duration;

/// 정리 규칙 하나 — 표 이름과, 그 표에 쓸 SQL(세기·지우기). sqlx 는 정적 SQL 만 받으므로 문장째 상수로 둔다.
#[derive(Debug, Clone, Copy)]
pub struct Rule {
    pub table: &'static str,
    count_sql: &'static str,
    delete_sql: &'static str,
}

macro_rules! rule {
    ($table:literal, $cond:literal) => {
        Rule {
            table: $table,
            count_sql: concat!("select count(*) from ", $table, " where ", $cond),
            // 1000 = RETENTION_BATCH(시험이 같은지 본다).
            delete_sql: concat!(
                "delete from ",
                $table,
                " where ctid in (select ctid from ",
                $table,
                " where ",
                $cond,
                " limit 1000)"
            ),
        }
    };
}

/// TS `RETENTION_RULES` — 표·조건은 상수로만 둔다(요청 값을 받지 않는다).
pub const RETENTION_RULES: [Rule; 2] = [
    rule!("idempotency_key", "created_at < now() - interval '7 days'"),
    rule!("session", "expires_at < now() - interval '30 days'"),
];
/// TS `RETENTION_BATCH`.
pub const RETENTION_BATCH: i64 = 1000;
/// TS `RETENTION_SWEEP_INTERVAL_MS`.
pub const RETENTION_SWEEP_INTERVAL: Duration = Duration::from_secs(60 * 60);
/// TS `RETENTION_FIRST_DELAY_MS`.
pub const RETENTION_FIRST_DELAY: Duration = Duration::from_secs(5 * 60);

/// 이 루프가 쓰는 권한(표, 권한) — homelab GRANT 와 같아야 한다. 없으면 `main.rs` 가 루프를 띄우지 않는다(TS 에 남는다).
/// 세기·고르기의 SELECT 는 읽기 권한(`pg_read_all_data`)으로 이미 있다.
pub const RETENTION_PRIVILEGES: &[(&str, &str)] =
    &[("idempotency_key", "DELETE"), ("session", "DELETE")];

/// TS `retentionDeleteEnabled` — 정확히 `"1"` 일 때만 켜진다.
pub fn delete_enabled(v: Option<&str>) -> bool {
    v == Some("1")
}

/// sweep 사이에 이어지는 상태 — 켜져 있을 때 「지우기 전에 한 번 세기」를 했는지.
#[derive(Debug, Default)]
pub struct Retention {
    pub delete_enabled: bool,
    counted: bool,
}

impl Retention {
    pub fn new(delete_enabled: bool) -> Self {
        Self {
            delete_enabled,
            counted: false,
        }
    }

    /// TS `sweep` — 표마다 지운 수(꺼져 있으면 0). `log` 에 표 이름과 수만 넘긴다.
    pub async fn sweep(
        &mut self,
        pool: &PgPool,
        mut log: impl FnMut(String),
    ) -> Result<Vec<(&'static str, u64)>, sqlx::Error> {
        if !self.delete_enabled || !self.counted {
            let mode = if self.delete_enabled {
                "before deleting"
            } else {
                "dry-run"
            };
            for r in RETENTION_RULES {
                let n: i64 = sqlx::query_scalar(r.count_sql).fetch_one(pool).await?;
                log(format!("retention: {} eligible={n} ({mode})", r.table));
            }
            self.counted = true;
        }
        if !self.delete_enabled {
            return Ok(RETENTION_RULES.iter().map(|r| (r.table, 0)).collect());
        }
        let mut out = Vec::with_capacity(RETENTION_RULES.len());
        for r in RETENTION_RULES {
            let deleted = sqlx::query(r.delete_sql)
                .execute(pool)
                .await?
                .rows_affected();
            if deleted > 0 {
                log(format!("retention: {} deleted={deleted}", r.table));
            }
            out.push((r.table, deleted));
        }
        Ok(out)
    }
}

/// 루프를 띄운다 — 첫 sweep 은 [`RETENTION_FIRST_DELAY`] 뒤, 그 뒤 한 시간마다. 주인이 `rust` 일 때만 실제로 돈다.
/// `gate` 는 문지기(잠금) 연결 전용 풀, `pool` 은 sweep 이 쓰는 풀이다(wake 와 같은 까닭).
pub fn spawn(gate: PgPool, pool: PgPool, delete_enabled: bool) -> tokio::task::JoinHandle<()> {
    tokio::spawn(async move {
        tokio::time::sleep(RETENTION_FIRST_DELAY).await;
        let mut every = tokio::time::interval(RETENTION_SWEEP_INTERVAL);
        every.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Delay);
        let mut state = Retention::new(delete_enabled);
        loop {
            every.tick().await;
            let st = &mut state;
            let p = &pool;
            match run_gated(&gate, "retention", Side::Rust, || async move {
                st.sweep(p, |m| eprintln!("{m}")).await.map(|_| ())
            })
            .await
            {
                // 실패는 다음 시각에 다시 한다 — 정리는 늦어도 해가 없다. 오류 문구만(행 내용 없음).
                GateResult::Gate(e) => eprintln!("loop retention: gate failed: {e}"),
                GateResult::Sweep(e) => eprintln!("loop retention: sweep failed: {e}"),
                _ => {}
            }
        }
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn delete_sql_uses_batch() {
        for r in RETENTION_RULES {
            assert!(
                r.delete_sql
                    .ends_with(&format!(" limit {RETENTION_BATCH})")),
                "{}",
                r.delete_sql
            );
            assert!(
                r.count_sql
                    .starts_with(&format!("select count(*) from {} where ", r.table))
            );
        }
    }
}
