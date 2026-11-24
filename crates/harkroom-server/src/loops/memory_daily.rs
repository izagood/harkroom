//! 매일 기억 정리(기본 기능) — 에이전트마다 하루 한 번 정리 회차를 넣는다. 자동화·소유자 승인이 없고 채팅에 글을 쓰지 않는다.
//!
//! - 시각은 워크스페이스 설정(`workspace_profile.memory_cleanup_*`). 그 시각부터 [`SPREAD_SECS`] 안에서 에이전트마다 흩는다.
//! - 넣기는 설정 시각 뒤 [`PRODUCE_SECS`] 안에만 한다(서버가 잠깐 내려가 있어도 그날을 잃지 않는다). (에이전트, 종류, 날짜) 유일 키라 하루 한 번이다.
//! - 꺼져 있던 에이전트: 회차가 24시간 동안 대기한다. 그 사이 접속하면 한 번 집는다. 넘기면 닫히고 다음 날 것이 선다 — 쌓이지 않는다.
//! - 건너뛰기: 지난 정리 뒤 기억 쓰기가 없고 정리 신호도 없으면 넣지 않는다.
//! - 다른 백그라운드(증류·구조 정리)의 전역 스위치·하루 상한은 보지 않는다.
use sqlx::PgPool;
use std::collections::HashSet;

/// 이 시간 안에서 에이전트마다 흩는다.
pub const SPREAD_SECS: i32 = 2 * 60 * 60;
/// 설정 시각 뒤 이 시간 안에만 새로 넣는다.
pub const PRODUCE_SECS: i32 = 4 * 60 * 60;
pub const LARGE_CHARS: i32 = 5000;
pub const UNDESCRIBED: i32 = 5;
pub const SIMILAR_PAIRS: usize = 10;
const NAME_SIMILARITY: f64 = 0.6;

pub const MEMORY_DAILY_PRIVILEGES: &[(&str, &str)] = &[
    ("bg_job.account_id", "INSERT"),
    ("bg_job.kind", "INSERT"),
    ("bg_job.day", "INSERT"),
    ("bg_job.input", "INSERT"),
    ("bg_job.not_before", "INSERT"),
    ("workspace_profile.memory_cleanup_on", "SELECT"),
    ("workspace_profile.memory_cleanup_time", "SELECT"),
    ("workspace_profile.memory_cleanup_tz", "SELECT"),
];

/// 지금 열린 회차 — (현지 날짜, 시작 시각). 켜져 있지 않거나 넣을 시간이 아니면 없다.
/// 시각이 자정을 걸치면 어제 날짜의 회차를 이어 넣는다. 모르는 시간대면 오류라 설정에서 거른다.
const SLOT_SQL: &str = "with w as (select memory_cleanup_time as t, memory_cleanup_tz as tz from workspace_profile where id and memory_cleanup_on), \
     d as (select w.*, ((now() at time zone tz)::date - g) as day from w, generate_series(0, 1) g), \
     s as (select day, ((day + t) at time zone tz) as at from d) \
     select day::text, extract(epoch from at)::float8 from s \
      where now() >= at and now() < at + make_interval(secs => $1) order by at desc limit 1";

type Candidate = (String, i32, i32, i32, i32, i32, bool, Vec<String>);

const CANDIDATES_SQL: &str = "select a.id::text, \
       coalesce((select char_length(value) from agent_memory where account_id = a.id and slug = 'core'), 0)::int, \
       m.active, m.journals, m.large, m.undescribed, \
       exists (select 1 from agent_memory x where x.account_id = a.id and x.updated_at > l.at) \
         or exists (select 1 from agent_memory_revision r where r.account_id = a.id and r.replaced_at > l.at) as dirty, \
       m.slugs \
     from account a \
     join agent_config ac on ac.account_id = a.id and ac.harness = $1 and ac.memory_cleanup_on \
     cross join lateral (select coalesce((select max(j.finished_at) from bg_job j \
            where j.account_id = a.id and j.kind = 'cleanup' and j.status = 'done'), '-infinity'::timestamptz) as at) l \
     cross join lateral (select \
            count(*)::int as active, \
            (count(*) filter (where kind = 'journal'))::int as journals, \
            (count(*) filter (where slug <> 'core' and kind <> 'journal' and char_length(value) > $2))::int as large, \
            (count(*) filter (where slug <> 'core' and kind <> 'journal' and coalesce(description, '') = ''))::int as undescribed, \
            coalesce(array_agg(slug order by slug) filter (where slug <> 'core' and kind <> 'journal'), '{}') as slugs \
          from agent_memory where account_id = a.id and archived_at is null) m \
     where a.kind = 'agent' and a.deleted_at is null and a.disabled_at is null and m.active > 0";

const INSERT_SQL: &str = "insert into bg_job (account_id, kind, day, input, not_before) \
     values ($1::text::uuid, 'cleanup', $2::text::date, $3::jsonb, \
       to_timestamp($4) + make_interval(secs => ((hashtextextended($1::text || $2::text, 0) & 2147483647) % $5)::float8)) \
     on conflict (account_id, kind, day) do nothing";

/// 러너 `similar_pairs` 와 같은 이름 판정.
fn similar_pairs(slugs: &[String]) -> usize {
    let toks: Vec<HashSet<&str>> = slugs
        .iter()
        .map(|s| {
            s.strip_prefix("mem/")
                .unwrap_or(s)
                .split(['/', '_', '-'])
                .filter(|t| t.encode_utf16().count() > 1 && !t.bytes().all(|b| b.is_ascii_digit()))
                .collect()
        })
        .collect();
    let mut n = 0;
    for (i, a) in toks.iter().enumerate() {
        for b in &toks[i + 1..] {
            let inter = a.intersection(b).count();
            let union = a.len() + b.len() - inter;
            #[allow(clippy::cast_precision_loss)]
            if inter > 0 && inter as f64 / union as f64 >= NAME_SIMILARITY {
                n += 1;
            }
        }
    }
    n
}

/// 정리를 띄울 까닭 — 비면 그날은 띄우지 않는다.
fn reasons(c: &Candidate) -> Vec<&'static str> {
    let (_, core, active, journals, large, undescribed, dirty, slugs) = c;
    // 앞 세 신호는 옛 정리 생산자와 같은 판정.
    let mut r = super::bg_produce::cleanup_reasons(*core, *active, *journals, true);
    if *large > 0 {
        r.push("large_items");
    }
    if *undescribed >= UNDESCRIBED {
        r.push("undescribed_items");
    }
    if similar_pairs(slugs) >= SIMILAR_PAIRS {
        r.push("similar_pairs");
    }
    if *dirty {
        r.push("daily");
    }
    r
}

/// 한 번 — 넣은 회차 수.
pub async fn produce(pool: &PgPool) -> Result<u64, sqlx::Error> {
    let Some((day, at)): Option<(String, f64)> = sqlx::query_as(SLOT_SQL)
        .bind(f64::from(PRODUCE_SECS))
        .fetch_optional(pool)
        .await?
    else {
        return Ok(0);
    };
    produce_for(pool, &day, at).await
}

/// [`produce`] 의 뒤 절반 — 정해진 날짜·시각으로 넣는다(시험이 시각을 고정한다).
pub async fn produce_for(pool: &PgPool, day: &str, at_epoch: f64) -> Result<u64, sqlx::Error> {
    let rows: Vec<Candidate> = sqlx::query_as(CANDIDATES_SQL)
        .bind(super::bg_produce::BG_HARNESS)
        .bind(LARGE_CHARS)
        .fetch_all(pool)
        .await?;
    let mut n = 0;
    for c in &rows {
        let r = reasons(c);
        if r.is_empty() {
            continue;
        }
        n += sqlx::query(INSERT_SQL)
            .bind(&c.0)
            .bind(day)
            .bind(serde_json::json!({ "reasons": r }).to_string())
            .bind(at_epoch)
            .bind(i64::from(SPREAD_SECS))
            .execute(pool)
            .await?
            .rows_affected();
    }
    Ok(n)
}

/// 10분마다 문지기(`memory.daily`) 아래서.
pub fn spawn(gate: PgPool, pool: PgPool) -> tokio::task::JoinHandle<()> {
    use super::{GateResult, Side, run_gated};
    tokio::spawn(async move {
        let mut every = tokio::time::interval(std::time::Duration::from_secs(600));
        every.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Delay);
        loop {
            every.tick().await;
            match run_gated(&gate, "memory.daily", Side::Rust, || async {
                let n = produce(&pool).await?;
                if n > 0 {
                    eprintln!("loop memory.daily: queued={n}");
                }
                Ok::<(), sqlx::Error>(())
            })
            .await
            {
                GateResult::Gate(e) => eprintln!("loop memory.daily: gate failed: {e}"),
                GateResult::Sweep(e) => eprintln!("loop memory.daily: produce failed: {e}"),
                _ => {}
            }
        }
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn c(dirty: bool) -> Candidate {
        ("a".into(), 0, 1, 0, 0, 0, dirty, vec![])
    }

    #[test]
    fn nothing_to_do_means_no_run() {
        assert!(reasons(&c(false)).is_empty());
        assert_eq!(reasons(&c(true)), ["daily"]);
    }

    #[test]
    fn signals_run_without_writes() {
        let mut x = c(false);
        x.4 = 1;
        x.5 = 5;
        assert_eq!(reasons(&x), ["large_items", "undescribed_items"]);
        x.5 = 4;
        assert_eq!(reasons(&x), ["large_items"]);
        let mut y = c(false);
        y.7 = (0..5).map(|i| format!("mem/area/topic-name-{i}")).collect();
        assert_eq!(reasons(&y), ["similar_pairs"]); // 5개 = 10짝
    }
}
