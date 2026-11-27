//! 에이전트별 동시 턴 상한 — 스레드 임대(`POST /agent/thread-claims`)를 잡는 자리에서 센다.
//!
//! - 러너는 턴을 띄우기 직전에 그 스레드의 임대를 잡고, 도는 동안 하트비트로 늘리고, 끝나면 놓는다. 그래서 「그 에이전트의 살아 있는
//!   임대 수」가 곧 「그 에이전트가 지금 돌리는 턴 수」다. 한 (에이전트, 스레드)에는 임대가 하나뿐이라(표의 기본 키) 스레드 하나 —
//!   그 스레드의 뿌리 작업 하나 — 에 도는 턴은 원래 하나다. 여기서 더하는 것은 **에이전트 하나가 동시에 쥐는 스레드 수**의 상한이다.
//! - 넘치면 409 `agent_turn_cap` 을 준다. 러너는 409 를 「지금은 못 잡는다」로 읽어 그 멘션을 읽음 처리하지 않고 다음 폴에 다시
//!   묻는다 — 인박스가 곧 대기열이다(기기 상한 `turn_slots_full` 과 같은 길). 글·알림은 서지 않는다.
//! - **이미 쥔 임대의 하트비트는 세지 않는다.** 같은 holder 가 같은 스레드를 다시 잡는 것은 늘리기다 — 여기서 409 를 주면 러너가
//!   도는 턴을 임대 잃음으로 끊는다. 그래서 상한을 낮춰도 도는 턴은 그대로 끝까지 돈다.
//! - 세는 것과 적는 것 사이에 같은 에이전트의 다른 잡기가 끼지 못하게 에이전트마다 줄을 세운다(트랜잭션 advisory lock).
//!   상한이 꺼져 있으면 잠금도 세기도 없이 예전 문장 하나만 돈다.
//! - 기록: 막힌 잡기는 측정 한 줄(`turn.cap_wait`, (에이전트, 스레드)마다 [`NOTE_EVERY`] 에 한 번)과 로그 한 줄(같은 간격에 한 번)을
//!   남긴다. 기다린 시간은 이미 있는 `queue.wait`(멘션 → 턴 임대)로 잰다.
//! - 스위치 `HARKROOM_AGENT_TURN_CAP` — 없으면 [`DEFAULT_CAP`], `0`·`off` 면 상한 없음, 1..=[`CAP_MAX`] 면 그 값.
//!   잘못 적은 값은 기본값으로 읽는다(상한을 조용히 끄지 않는다).
use serde_json::json;
use sqlx::PgPool;
use std::collections::HashMap;
use std::sync::Mutex;
use std::time::{Duration, Instant};

/// 스위치 환경 변수.
pub const SWITCH_ENV: &str = "HARKROOM_AGENT_TURN_CAP";
/// 기본 상한 — 폭주만 막는 값이다(평소의 병렬 작업을 줄 세우려는 값이 아니다).
pub const DEFAULT_CAP: i64 = 16;
/// 받는 가장 큰 값.
pub const CAP_MAX: i64 = 256;
/// 같은 (에이전트, 스레드)의 막힘을 다시 적기까지의 간격 — 러너는 몇 초마다 다시 묻는다.
pub const NOTE_EVERY: Duration = Duration::from_secs(60);
/// 막힘 표에 두는 열쇠 수 상한. 넘으면 비운다(다시 적힐 뿐이다).
const NOTED_MAX: usize = 2048;

/// 잡기·하트비트 — 없으면 넣고, 같은 holder 거나 만료된 줄이면 덮는다. 남이 산 임대를 쥐었으면 0줄.
const UPSERT_SQL: &str = concat!(
    "insert into agent_thread_claim (agent_id, channel_id, thread_root_id, holder, expires_at) \
     values ($1::uuid, $2::uuid, $3::uuid, $4, now() + make_interval(secs => $5::int)) \
     on conflict (agent_id, channel_id, thread_root_id) do update \
       set holder = excluded.holder, expires_at = excluded.expires_at, \
           claimed_at = case when agent_thread_claim.holder = excluded.holder then agent_thread_claim.claimed_at else now() end \
       where agent_thread_claim.holder = excluded.holder or agent_thread_claim.expires_at <= now() \
     returning ",
    crate::iso!("expires_at")
);

/// 그 스레드를 쥔 쪽의 만료 시각(409 응답에 싣는다).
const HELD_SQL: &str = concat!(
    "select ",
    crate::iso!("expires_at"),
    " from agent_thread_claim where agent_id = $1::uuid and channel_id = $2::uuid and thread_root_id = $3::uuid"
);

/// 에이전트마다 한 줄 — 트랜잭션이 끝나면 풀린다.
const LOCK_SQL: &str =
    "select pg_advisory_xact_lock(hashtextextended('agent_turn_cap:' || $1::text, 0))";

/// 이 holder 가 이 스레드의 줄을 이미 쥐고 있는가(하트비트). 만료됐어도 쥔 것으로 본다 — 늦은 하트비트로 도는 턴을 끊지 않는다.
const MINE_SQL: &str = "select exists(select 1 from agent_thread_claim \
       where agent_id = $1::uuid and channel_id = $2::uuid and thread_root_id = $3::uuid and holder = $4)";

/// 그 에이전트가 **다른 스레드에** 쥔 살아 있는 임대 수.
const LIVE_SQL: &str = "select count(*)::int8 from agent_thread_claim \
       where agent_id = $1::uuid and expires_at > now() \
         and not (channel_id = $2::uuid and thread_root_id = $3::uuid)";

/// 스위치 글자 → 상한(순수). `None` 이 「상한 없음」이다.
pub fn parse_cap(raw: Option<&str>) -> Option<i64> {
    let v = raw.map(|v| v.trim().to_ascii_lowercase());
    match v.as_deref() {
        None | Some("") => Some(DEFAULT_CAP),
        Some("0" | "off") => None,
        Some(s) if s.len() <= 3 && s.bytes().all(|b| b.is_ascii_digit()) => {
            match s.parse::<i64>() {
                Ok(n) if (1..=CAP_MAX).contains(&n) => Some(n),
                _ => Some(DEFAULT_CAP),
            }
        }
        Some(_) => Some(DEFAULT_CAP),
    }
}

/// 환경 변수 [`SWITCH_ENV`] 에서 읽는다(프로세스에 한 번).
pub fn cap_from_env() -> Option<i64> {
    parse_cap(crate::env_once::get(&crate::env_once::AGENT_TURN_CAP))
}

/// 잡기 한 번의 인자.
#[derive(Debug, Clone, Copy)]
pub struct Want<'a> {
    pub agent: &'a str,
    pub channel: &'a str,
    pub root: &'a str,
    pub holder: &'a str,
    pub ttl_secs: i32,
}

/// 잡기의 결과.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Outcome {
    /// 잡았다(또는 늘렸다) — 만료 시각.
    Held(String),
    /// 같은 에이전트의 다른 러너가 그 스레드를 쥐고 있다 — 그 줄의 만료 시각.
    Taken(Option<String>),
    /// 상한이 찼다 — 다른 스레드에 쥔 살아 있는 임대 수와 상한.
    Capped { live: i64, cap: i64 },
}

/// 스레드 임대를 잡는다. `cap` 이 `None` 이면 예전과 같은 문장 하나다.
pub async fn claim(pool: &PgPool, want: Want<'_>, cap: Option<i64>) -> sqlx::Result<Outcome> {
    let Want {
        agent,
        channel,
        root,
        holder,
        ttl_secs,
    } = want;
    let upsert = || {
        sqlx::query_scalar::<_, String>(UPSERT_SQL)
            .bind(agent)
            .bind(channel)
            .bind(root)
            .bind(holder)
            .bind(ttl_secs)
    };
    let held = || {
        sqlx::query_scalar::<_, String>(HELD_SQL)
            .bind(agent)
            .bind(channel)
            .bind(root)
    };
    let Some(cap) = cap else {
        return Ok(match upsert().fetch_optional(pool).await? {
            Some(at) => Outcome::Held(at),
            None => Outcome::Taken(held().fetch_optional(pool).await?),
        });
    };
    let mut tx = pool.begin().await?;
    sqlx::query(LOCK_SQL).bind(agent).execute(&mut *tx).await?;
    let mine: bool = sqlx::query_scalar(MINE_SQL)
        .bind(agent)
        .bind(channel)
        .bind(root)
        .bind(holder)
        .fetch_one(&mut *tx)
        .await?;
    if !mine {
        let live: i64 = sqlx::query_scalar(LIVE_SQL)
            .bind(agent)
            .bind(channel)
            .bind(root)
            .fetch_one(&mut *tx)
            .await?;
        if live >= cap {
            tx.commit().await?;
            return Ok(Outcome::Capped { live, cap });
        }
    }
    let out = match upsert().fetch_optional(&mut *tx).await? {
        Some(at) => Outcome::Held(at),
        None => Outcome::Taken(held().fetch_optional(&mut *tx).await?),
    };
    tx.commit().await?;
    Ok(out)
}

/// 막힘 표 — (에이전트, 스레드) → 마지막으로 적은 때. 빈 열쇠는 로그 줄의 간격이다.
static NOTED: Mutex<Option<HashMap<(String, String), Instant>>> = Mutex::new(None);

/// 이 열쇠를 지금 적을 차례인가(간격 안이면 `false`). 표가 차면 비운다.
fn due(key: (String, String), now: Instant) -> bool {
    let Ok(mut g) = NOTED.lock() else {
        return false;
    };
    let map = g.get_or_insert_with(HashMap::new);
    if map
        .get(&key)
        .is_some_and(|at| now.duration_since(*at) < NOTE_EVERY)
    {
        return false;
    }
    if map.len() >= NOTED_MAX {
        map.clear();
    }
    map.insert(key, now);
    true
}

/// 막힌 잡기를 적는다 — 측정 한 줄((에이전트, 스레드)마다 간격에 한 번)과 로그 한 줄(간격에 한 번). 응답을 기다리게 하지 않는다.
pub fn note_wait(agent: &str, channel: &str, root: &str, live: i64, cap: i64) {
    let now = Instant::now();
    if due((String::new(), String::new()), now) {
        eprintln!("front: agent turn cap {cap} reached — new turns wait in the inbox");
    }
    if !due((agent.to_owned(), root.to_owned()), now) {
        return;
    }
    super::measure::record(super::measure::Event {
        kind: super::measure::KIND_TURN_CAP_WAIT,
        account_id: Some(agent.to_owned()),
        channel_id: Some(channel.to_owned()),
        thread_root_id: Some(root.to_owned()),
        ref_id: None,
        value: Some(live),
        detail: Some(json!({ "cap": cap })),
    });
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn cap_parses_with_a_default_and_an_off() {
        for (raw, want) in [
            (None, Some(DEFAULT_CAP)),
            (Some(""), Some(DEFAULT_CAP)),
            (Some("  "), Some(DEFAULT_CAP)),
            (Some("0"), None),
            (Some(" OFF "), None),
            (Some("1"), Some(1)),
            (Some(" 4 "), Some(4)),
            (Some("256"), Some(256)),
            // 잘못 적은 값은 상한을 끄지 않는다.
            (Some("257"), Some(DEFAULT_CAP)),
            (Some("9999"), Some(DEFAULT_CAP)),
            (Some("-1"), Some(DEFAULT_CAP)),
            (Some("3.5"), Some(DEFAULT_CAP)),
            (Some("on"), Some(DEFAULT_CAP)),
            (Some("00"), Some(DEFAULT_CAP)),
        ] {
            assert_eq!(parse_cap(raw), want, "{raw:?}");
        }
    }

    #[test]
    fn sql_counts_only_live_claims_on_other_threads() {
        assert!(LIVE_SQL.contains("expires_at > now()"));
        assert!(LIVE_SQL.contains("not (channel_id = $2::uuid and thread_root_id = $3::uuid)"));
        // 하트비트 판정은 holder 까지 본다 — 남의 줄을 내 것으로 읽지 않는다.
        assert!(MINE_SQL.contains("holder = $4"));
        for sql in [HELD_SQL, LOCK_SQL, MINE_SQL, LIVE_SQL] {
            let low = sql.to_ascii_lowercase();
            assert!(low.starts_with("select "), "{sql}");
            for w in ["insert ", "update ", "delete "] {
                assert!(!low.contains(w), "{sql}");
            }
        }
        // 넣는 줄은 부른 에이전트의 것뿐이다.
        assert!(UPSERT_SQL.starts_with("insert into agent_thread_claim (agent_id,"));
    }

    #[test]
    fn a_blocked_key_is_noted_once_per_interval() {
        let key = || ("a-note-test".to_owned(), "t-note-test".to_owned());
        let t0 = Instant::now();
        assert!(due(key(), t0));
        assert!(!due(key(), t0 + Duration::from_secs(1)));
        assert!(!due(key(), t0 + NOTE_EVERY - Duration::from_millis(1)));
        assert!(due(key(), t0 + NOTE_EVERY));
        // 다른 스레드는 따로 센다.
        assert!(due(("a-note-test".to_owned(), "t-other".to_owned()), t0));
    }

    #[test]
    fn note_is_a_noop_outside_a_runtime() {
        // 측정이 꺼져 있거나 런타임 밖이면 그냥 돌아온다.
        note_wait("a", "c", "t", 16, 16);
    }
}
