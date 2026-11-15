//! 백그라운드 회차 생산(S5.3 C5c-3b) — TS `services/bgJobs.ts` 의 `enqueueBgJob`·`produceDistillJobs` 를 옮긴다.
//! C5c-3b-2 에서 `produceCleanupJobs`·`produceOrganizeJobs` 와 루프([`spawn`], 문지기 이름 `bg.produce`)를 더했다.
//!
//! - 문장은 TS 상수(`BG_*_SQL`·`DISTILL_CANDIDATES_SQL`)와 **같은 글자**다 — 골든 파일로 받는다(`rustSqlFragments.test.ts` 가 대조).
//! - 시각은 앱 시계가 아니라 **DB `now()`** 다(설계 A, 소유자 결정 · 2026-11-16). tick 마다 [`Tick::read`] 로 한 번 읽고, 「지금 − 24시간」·
//!   KST 날짜·KST 시를 모두 그 값에서 뽑는다. 1시간 간격은 메모리의 마지막 생산 시각([`Producer`])으로 센다 — TS 와 같다.
//! - **재기동·주인 교체 때 1시간 안에 한 번 더 돌 수 있다.** 결과는 같다: (에이전트, 종류, KST 날짜) 유일 키와 날짜별 advisory 잠금 안의
//!   하루 상한이 두 번째 넣기를 `exists` 로 돌려보낸다 — 질의만 는다(시험 「같은 날 두 번 → 줄 수 같음」).
use crate::core::channels::frag;
use serde_json::{Value, json};
use sqlx::PgPool;
use std::collections::BTreeMap;

/// TS `BG_PAUSE_AFTER_FAILURES`.
pub const BG_PAUSE_AFTER_FAILURES: i64 = 3;
/// TS `BG_WINDOW_KST[1]` — 이 KST 시부터는 넣지 않는다.
pub const BG_WINDOW_END_KST: i32 = 7;
/// TS `DISTILL_MAX_THREADS`.
pub const DISTILL_MAX_THREADS: i64 = 10;
/// TS `BG_HARNESS`.
pub const BG_HARNESS: &str = "claude-code";
/// TS `DISTILL_PRODUCE_INTERVAL_MS`(초).
pub const PRODUCE_INTERVAL_SECS: f64 = 60.0 * 60.0;
const DEFAULT_DAILY_MAX: i64 = 50;
/// TS `MEMORY_CORE_WARN_CHARS`(shared) — core 가 이 글자 수 이상이면 정리 신호.
pub const MEMORY_CORE_WARN_CHARS: i32 = 2600;
/// TS `MEMORY_ITEMS_WARN_COUNT`(shared) — 살아 있는 항목이 이 수 이상이면 정리 신호.
pub const MEMORY_ITEMS_WARN_COUNT: i32 = 180;
/// TS `MAX_JOURNAL_MEMORIES_PER_ACCOUNT`(shared).
pub const MAX_JOURNAL_MEMORIES_PER_ACCOUNT: i32 = 60;
/// TS `JOURNAL_EXPIRING_WINDOW`(shared) — journal 이 상한 − 이 수를 넘으면 곧 밀려난다.
pub const JOURNAL_EXPIRING_WINDOW: i32 = 5;
/// TS `CLEANUP_WEEKLY_MIN_ITEMS`.
pub const CLEANUP_WEEKLY_MIN_ITEMS: i32 = 60;
/// TS `CLEANUP_WEEKLY_MS`(초).
pub const CLEANUP_WEEKLY_SECS: i64 = 7 * 24 * 60 * 60;
/// TS `ORGANIZE_MIN_CHANGES`.
pub const ORGANIZE_MIN_CHANGES: i32 = 15;
/// TS `ORGANIZE_MAX_GAP_MS`(초).
pub const ORGANIZE_MAX_GAP_SECS: f64 = 14.0 * 24.0 * 60.0 * 60.0;

/// 이 몫이 쓰는 권한(표, 권한) — 넣기 칸만. 읽기는 읽기 권한으로 된다.
pub const BG_PRODUCE_PRIVILEGES: &[(&str, &str)] = &[
    ("bg_job.account_id", "INSERT"),
    ("bg_job.kind", "INSERT"),
    ("bg_job.day", "INSERT"),
    ("bg_job.input", "INSERT"),
];

/// TS `backgroundDailyMax` — JS `Number(v)` 가 0 이상 정수일 때 그 값, 아니면 50. 비어 있으면(빈 글자·공백) JS 처럼 0.
pub fn daily_max(v: Option<&str>) -> i64 {
    let Some(raw) = v else {
        return DEFAULT_DAILY_MAX;
    };
    let t = raw.trim();
    if t.is_empty() {
        return 0;
    }
    let lower = t.to_ascii_lowercase();
    let n: Option<f64> = if let Some(h) = lower.strip_prefix("0x") {
        i64::from_str_radix(h, 16).ok().map(|x| x as f64)
    } else if let Some(o) = lower.strip_prefix("0o") {
        i64::from_str_radix(o, 8).ok().map(|x| x as f64)
    } else if let Some(b) = lower.strip_prefix("0b") {
        i64::from_str_radix(b, 2).ok().map(|x| x as f64)
    } else if lower.contains("inf") || lower.contains("nan") {
        None // JS 는 `Infinity` 만 받지만 정수가 아니라 어차피 기본값이다
    } else {
        t.parse::<f64>().ok()
    };
    match n {
        Some(x) if x.is_finite() && x.fract() == 0.0 && x >= 0.0 => x.min(i64::MAX as f64) as i64,
        _ => DEFAULT_DAILY_MAX,
    }
}

/// tick 한 번의 DB 시각.
#[derive(Debug, Clone)]
pub struct Tick {
    /// `now()` 의 epoch 초 — 1시간 간격 셈.
    pub epoch: f64,
    /// KST 날짜(`YYYY-MM-DD`) — TS `kstDay(now)`.
    pub day: String,
    /// KST 시(0~23).
    pub kst_hour: i32,
    /// `now() − 24시간` — TS `now − DISTILL_DONE_AGE_MS`. UTC ISO 8601(`…Z`) 글자라 세션 DateStyle·TimeZone 과 상관없이 같은 시각으로 읽힌다.
    pub done_cutoff: String,
    /// `now()` 그 자체(같은 꼴) — organize 후보의 `$1`.
    pub now: String,
    /// `now() − 7일`(같은 꼴) — TS `now − CLEANUP_WEEKLY_MS`, 정리 후보의 `$1`.
    pub week_cutoff: String,
}

/// 시각을 DateStyle 과 상관없는 UTC ISO 8601 글자로(security 낮은 지적 — `::text` 는 세션 DateStyle 을 따른다).
const ISO_UTC: &str = "'YYYY-MM-DD\"T\"HH24:MI:SS.US\"Z\"'";

impl Tick {
    pub async fn read(pool: &PgPool) -> Result<Tick, sqlx::Error> {
        #[allow(clippy::type_complexity)]
        let (epoch, day, kst_hour, done_cutoff, now, week_cutoff): (f64, String, i32, String, String, String) =
            sqlx::query_as(sqlx::AssertSqlSafe(format!(
                "select extract(epoch from now())::float8, to_char(now() at time zone 'Asia/Seoul', 'YYYY-MM-DD'), \
                        extract(hour from now() at time zone 'Asia/Seoul')::int, \
                        to_char((now() - interval '24 hours') at time zone 'UTC', {ISO_UTC}), \
                        to_char(now() at time zone 'UTC', {ISO_UTC}), \
                        to_char((now() - make_interval(secs => {CLEANUP_WEEKLY_SECS})) at time zone 'UTC', {ISO_UTC})"
            )))
            .fetch_one(pool)
            .await?;
        Ok(Tick {
            epoch,
            day,
            kst_hour,
            done_cutoff,
            now,
            week_cutoff,
        })
    }
}

/// 넣기 결과 — TS `EnqueueResult`(`disabled` 는 부르는 쪽이 먼저 거른다).
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Enqueue {
    Queued(String),
    Refused(&'static str),
}

/// TS `enqueueBgJob` — 멈춤(최근 결말 3개가 모두 실패) → 소유자 토글 → 날짜 잠금 안에서 하루 상한·유일 키로 넣기.
pub async fn enqueue(
    pool: &PgPool,
    account_id: &str,
    kind: &str,
    input: &Value,
    day: &str,
    daily_max: i64,
) -> Result<Enqueue, sqlx::Error> {
    let recent: Vec<String> = sqlx::query_scalar(frag("bg_paused"))
        .bind(account_id)
        .bind(kind)
        .bind(BG_PAUSE_AFTER_FAILURES)
        .fetch_all(pool)
        .await?;
    if recent.len() as i64 == BG_PAUSE_AFTER_FAILURES && recent.iter().all(|s| s == "failed") {
        return Ok(Enqueue::Refused("paused"));
    }
    let on: Option<bool> = sqlx::query_scalar(frag("bg_agent_on"))
        .bind(account_id)
        .fetch_optional(pool)
        .await?;
    if on != Some(true) {
        return Ok(Enqueue::Refused("agent_off"));
    }
    let mut tx = pool.begin().await?;
    sqlx::query(frag("bg_daily_lock"))
        .bind(day)
        .execute(&mut *tx)
        .await?;
    let id: Option<String> = sqlx::query_scalar(sqlx::AssertSqlSafe(format!(
        "with ins as ({}) select id::text from ins",
        frag("bg_enqueue")
    )))
    .bind(account_id)
    .bind(kind)
    .bind(day)
    .bind(input.to_string())
    .bind(daily_max)
    .fetch_optional(&mut *tx)
    .await?;
    tx.commit().await?;
    if let Some(id) = id {
        return Ok(Enqueue::Queued(id));
    }
    let exists: Option<i32> = sqlx::query_scalar(frag("bg_exists"))
        .bind(account_id)
        .bind(kind)
        .bind(day)
        .fetch_optional(pool)
        .await?;
    Ok(Enqueue::Refused(if exists.is_some() {
        "exists"
    } else {
        "daily_cap"
    }))
}

/// 생산자 하나의 결과 — TS `{ queued, refused }`.
#[derive(Debug, Default, Clone, PartialEq, Eq)]
pub struct Produced {
    pub queued: u64,
    pub refused: BTreeMap<&'static str, u64>,
}

impl Produced {
    fn add(&mut self, r: &Enqueue) {
        match r {
            Enqueue::Queued(_) => self.queued += 1,
            Enqueue::Refused(why) => *self.refused.entry(why).or_default() += 1,
        }
    }
}

/// TS `produceDistillJobs` — done 으로 24시간 넘게 머문 스레드를 에이전트마다 오래된 순 10개 묶어 하루 1회 넣는다. 창이 끝났으면 넣지 않는다.
pub async fn produce_distill(
    pool: &PgPool,
    tick: &Tick,
    enabled: bool,
    daily_max: i64,
) -> Result<Produced, sqlx::Error> {
    let mut out = Produced::default();
    if !enabled || tick.kst_hour >= BG_WINDOW_END_KST {
        return Ok(out);
    }
    let rows: Vec<(String, Vec<String>)> = sqlx::query_as(sqlx::AssertSqlSafe(format!(
        "select t.account_id::text, t.threads::text[] from ({}) t",
        frag("bg_distill_candidates")
    )))
    .bind(&tick.done_cutoff)
    .bind(DISTILL_MAX_THREADS)
    .bind(BG_HARNESS)
    .fetch_all(pool)
    .await?;
    for (account_id, threads) in rows {
        let r = enqueue(
            pool,
            &account_id,
            "distill",
            &json!({ "threadIds": threads }),
            &tick.day,
            daily_max,
        )
        .await?;
        out.add(&r);
    }
    Ok(out)
}

/// TS `produceCleanupJobs` 의 판정 — 정리 신호(core·항목·journal) 또는 주간(항목 60↑·지난 7일 정리 없음). 비면 넣지 않는다.
pub fn cleanup_reasons(
    core_len: i32,
    active: i32,
    journals: i32,
    recent: bool,
) -> Vec<&'static str> {
    let mut r = Vec::new();
    if core_len >= MEMORY_CORE_WARN_CHARS {
        r.push("core_near_limit");
    }
    if active >= MEMORY_ITEMS_WARN_COUNT {
        r.push("items_near_limit");
    }
    if journals > MAX_JOURNAL_MEMORIES_PER_ACCOUNT - JOURNAL_EXPIRING_WINDOW {
        r.push("journal_expiring");
    }
    if r.is_empty() && active >= CLEANUP_WEEKLY_MIN_ITEMS && !recent {
        r.push("weekly");
    }
    r
}

/// TS `produceCleanupJobs`.
pub async fn produce_cleanup(
    pool: &PgPool,
    tick: &Tick,
    enabled: bool,
    daily_max: i64,
) -> Result<Produced, sqlx::Error> {
    let mut out = Produced::default();
    if !enabled || tick.kst_hour >= BG_WINDOW_END_KST {
        return Ok(out);
    }
    let rows: Vec<(String, i32, i32, i32, bool)> = sqlx::query_as(sqlx::AssertSqlSafe(format!(
        "select t.account_id::text, t.core_len, t.active, t.journals, t.recent from ({}\n) t",
        frag("bg_cleanup_candidates")
    )))
    .bind(&tick.week_cutoff)
    .bind(BG_HARNESS)
    .fetch_all(pool)
    .await?;
    for (account_id, core_len, active, journals, recent) in rows {
        let reasons = cleanup_reasons(core_len, active, journals, recent);
        if reasons.is_empty() {
            continue;
        }
        let r = enqueue(
            pool,
            &account_id,
            "cleanup",
            &json!({ "reasons": reasons }),
            &tick.day,
            daily_max,
        )
        .await?;
        out.add(&r);
    }
    Ok(out)
}

/// TS `produceOrganizeJobs` 의 판정 — 변경 15↑, 또는 마지막 organize 뒤 14일이 지났고(없었으면 지난 것으로) 변경이 1↑.
pub fn organize_due(changes: i32, since_last_secs: Option<f64>) -> bool {
    let gap_over = since_last_secs.is_none_or(|s| s >= ORGANIZE_MAX_GAP_SECS);
    changes >= ORGANIZE_MIN_CHANGES || (gap_over && changes > 0)
}

/// TS `produceOrganizeJobs`.
pub async fn produce_organize(
    pool: &PgPool,
    tick: &Tick,
    enabled: bool,
    daily_max: i64,
) -> Result<Produced, sqlx::Error> {
    let mut out = Produced::default();
    if !enabled || tick.kst_hour >= BG_WINDOW_END_KST {
        return Ok(out);
    }
    let rows: Vec<(String, Option<f64>, i32)> = sqlx::query_as(sqlx::AssertSqlSafe(format!(
        "select t.account_id::text, extract(epoch from t.last_at)::float8, t.changes from ({}\n) t",
        frag("bg_organize_candidates")
    )))
    .bind(&tick.now)
    .bind(BG_HARNESS)
    .fetch_all(pool)
    .await?;
    for (account_id, last_epoch, changes) in rows {
        if !organize_due(changes, last_epoch.map(|l| tick.epoch - l)) {
            continue;
        }
        let r = enqueue(
            pool,
            &account_id,
            "organize",
            &json!({ "changes": changes }),
            &tick.day,
            daily_max,
        )
        .await?;
        out.add(&r);
    }
    Ok(out)
}

/// 생산 한 번 — TS `produce` 와 같은 순서(distill → cleanup → organize). 하나가 실패하면 그 tick 은 거기서 끝난다(TS 의 try 하나와 같다).
pub async fn produce_all(
    pool: &PgPool,
    tick: &Tick,
    enabled: bool,
    daily_max: i64,
) -> Result<(), sqlx::Error> {
    let d = produce_distill(pool, tick, enabled, daily_max).await?;
    log_produced("distill", &d);
    let c = produce_cleanup(pool, tick, enabled, daily_max).await?;
    log_produced("cleanup", &c);
    let o = produce_organize(pool, tick, enabled, daily_max).await?;
    log_produced("organize", &o);
    Ok(())
}

fn log_produced(name: &str, p: &Produced) {
    if p.queued > 0 || !p.refused.is_empty() {
        eprintln!(
            "loop bg.produce: {name} queued={} refused={:?}",
            p.queued, p.refused
        );
    }
}

/// 1분마다 문지기(이름 `bg.produce`) 아래서 — DB 시각을 읽고 1시간이 지났으면 생산한다. 스위치가 꺼져 있으면 아무것도 안 한다.
/// `gate` 는 문지기(잠금) 연결 전용 풀, `pool` 은 생산 풀이다.
pub fn spawn(
    gate: PgPool,
    pool: PgPool,
    enabled: bool,
    daily_max: i64,
) -> tokio::task::JoinHandle<()> {
    use super::{GateResult, Side, run_gated};
    tokio::spawn(async move {
        let mut producer = Producer::default();
        let mut every = tokio::time::interval(super::bg::BG_SWEEP_INTERVAL);
        every.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Delay);
        loop {
            every.tick().await;
            if !enabled {
                continue;
            }
            match run_gated(&gate, "bg.produce", Side::Rust, || async {
                let tick = Tick::read(&pool).await?;
                if !producer.due(&tick) {
                    return Ok(());
                }
                produce_all(&pool, &tick, enabled, daily_max).await
            })
            .await
            {
                GateResult::Gate(e) => eprintln!("loop bg.produce: gate failed: {e}"),
                GateResult::Sweep(e) => eprintln!("loop bg.produce: produce failed: {e}"),
                _ => {}
            }
        }
    })
}

/// 1시간 간격 — 마지막 생산의 DB 시각을 메모리에 둔다(TS `lastProducedAt`). 기동 직후 첫 tick 은 바로 돈다.
#[derive(Debug, Default)]
pub struct Producer {
    last_epoch: Option<f64>,
}

impl Producer {
    /// 이번 tick 에 생산할 차례면 true 를 돌려주고 마지막 시각을 이 tick 으로 옮긴다.
    pub fn due(&mut self, tick: &Tick) -> bool {
        match self.last_epoch {
            Some(last) if tick.epoch - last < PRODUCE_INTERVAL_SECS => false,
            _ => {
                self.last_epoch = Some(tick.epoch);
                true
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn daily_max_like_js_number() {
        assert_eq!(daily_max(None), 50);
        for (v, want) in [
            ("", 0),
            ("  ", 0),
            ("0", 0),
            ("-0", 0),
            ("7", 7),
            (" 7 ", 7),
            ("+7", 7),
            ("7.", 7),
            ("1e2", 100),
            ("0x10", 16),
            ("7.5", 50),
            ("-1", 50),
            ("abc", 50),
            ("Infinity", 50),
            ("NaN", 50),
        ] {
            assert_eq!(daily_max(Some(v)), want, "{v:?}");
        }
    }

    #[test]
    fn producer_runs_first_tick_then_hourly() {
        let t = |e: f64| Tick {
            epoch: e,
            day: String::new(),
            kst_hour: 4,
            done_cutoff: String::new(),
            now: String::new(),
            week_cutoff: String::new(),
        };
        let mut p = Producer::default();
        assert!(p.due(&t(1000.0)));
        assert!(!p.due(&t(1000.0 + 3599.0)));
        assert!(p.due(&t(1000.0 + 3600.0)));
        assert!(!p.due(&t(1000.0 + 3600.0 + 60.0)));
    }

    #[test]
    fn cleanup_reasons_like_ts() {
        assert!(cleanup_reasons(0, 0, 0, false).is_empty());
        assert_eq!(cleanup_reasons(2600, 0, 0, true), ["core_near_limit"]);
        assert!(cleanup_reasons(2599, 179, 55, true).is_empty());
        assert_eq!(
            cleanup_reasons(0, 180, 56, true),
            ["items_near_limit", "journal_expiring"]
        );
        // 주간은 신호가 없을 때만, 60↑·지난 7일 정리 없음.
        assert_eq!(cleanup_reasons(0, 60, 0, false), ["weekly"]);
        assert!(cleanup_reasons(0, 60, 0, true).is_empty());
        assert!(cleanup_reasons(0, 59, 0, false).is_empty());
    }

    #[test]
    fn organize_due_like_ts() {
        let day = 24.0 * 60.0 * 60.0;
        assert!(organize_due(15, Some(day)));
        assert!(!organize_due(14, Some(13.9 * day)));
        assert!(organize_due(1, Some(14.0 * day)));
        assert!(!organize_due(0, Some(30.0 * day)));
        assert!(organize_due(1, None));
        assert!(!organize_due(0, None));
    }

    #[test]
    fn privileges_are_insert_columns_only() {
        assert!(
            BG_PRODUCE_PRIVILEGES
                .iter()
                .all(|(t, p)| t.starts_with("bg_job.") && *p == "INSERT")
        );
    }
}
