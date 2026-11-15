//! 턴 임대(S5.3 C6b) — TS `services/secretAccess.ts` 의 `issueTurnLease`·`renewTurnLease`·`endTurnLease` 를 옮긴다.
//! 러너가 멘션의 턴을 시작하기 직전에 받는 임대로, reveal·머지·위임 키가 이 임대 행을 본다(비밀 보관소 PR 2·157 다시 주기).
//!
//! - 문장은 TS 가 정본이다 — `golden/sql_fragments.json` 의 `turn_lease_*` 를 그대로 쓰고(`rustSqlFragments.test.ts` 가 묶는다),
//!   시간 상수도 같은 골든의 `turn_lease_consts` 에서 읽는다.
//! - 이중 발급 막기: TS 와 **같은 열쇠**(`pg_advisory_xact_lock(hashtext('lease:<agent>:<cause>'))`)로 같은 (에이전트, 멘션)의 발급을
//!   줄 세운다. 그래서 TS 와 Rust 가 같은 DB 에서 동시에 발급해도 한 부름에 살아 있는 임대는 하나다(`rustFrontDb.test.ts` 동시 시험).
//! - 시각: TS 는 앱 시계(`now`)를 쓴다. 여기서는 트랜잭션의 DB `now()` 를 밀리초로 자른 값 하나를 판정·쓰기에 같이 쓴다
//!   (TS 가 쓴 행과 같은 정밀도 — 만료 시각 글자가 같은 꼴로 나온다).
//! - 자동화 위임장(⑤b, `automationMandateForCause`)은 옮기지 않는다: 원인 글이 자동화 회차 글이면 아무것도 쓰지 않고
//!   [`Issue::Handoff`] 를 돌려준다 — 부르는 쪽이 그 요청을 TS 로 넘긴다(C3b-1 의 권한·머지 카드와 같은 꼴).
//! - 배선은 C6b-2 — 이 PR 에서는 아무 경로도 이 함수를 부르지 않는다.
use base64::Engine as _;
use base64::engine::general_purpose::URL_SAFE_NO_PAD;
use serde_json::Value;
use sha2::{Digest, Sha256};
use sqlx::PgPool;
use std::sync::OnceLock;

/// 발급·다시 주기·늘리기·끝내기가 쓰는 권한 — homelab GRANT 와 같아야 한다. 하나라도 없으면 C6b-2 배선이 서지 않는다(TS 에 남는다).
/// 임대 행은 넣고, `ended_at`·`expires_at`·`last_renewed_at` 세 칸만 고친다.
pub const TURN_LEASE_PRIVILEGES: &[(&str, &str)] = &[
    ("secret_turn_lease", "INSERT"),
    ("secret_turn_lease.ended_at", "UPDATE"),
    ("secret_turn_lease.expires_at", "UPDATE"),
    ("secret_turn_lease.last_renewed_at", "UPDATE"),
    ("audit_log", "INSERT"),
];

struct Sql {
    cause: String,
    used: String,
    prior: String,
    claim_moved: String,
    end_prior: String,
    insert: String,
    end: String,
    renew: String,
    automation_cause: &'static str,
    ttl_ms: i64,
    max_ms: i64,
    renew_ms: i64,
    inbox_max_age_ms: i64,
    reissue_stale_ms: i64,
    max_reissues: i64,
}

fn sql() -> &'static Sql {
    static S: OnceLock<Sql> = OnceLock::new();
    S.get_or_init(|| {
        let v: Value = serde_json::from_str(include_str!("../../golden/sql_fragments.json"))
            .expect("golden/sql_fragments.json");
        let frag = |k: &str| {
            v[k].as_str()
                .unwrap_or_else(|| panic!("golden fragment {k}"))
                .to_string()
        };
        let consts: Vec<i64> = frag("turn_lease_consts")
            .split(',')
            .map(|n| n.parse().expect("turn_lease_consts"))
            .collect();
        let [ttl_ms, max_ms, renew_ms, inbox_max_age_ms, reissue_stale_ms, max_reissues] =
            consts[..]
        else {
            panic!("turn_lease_consts: six numbers");
        };
        Sql {
            cause: format!(
                "select c.\"channelId\"::text, c.\"threadRootId\"::text, c.\"mandateId\"::text, c.\"principalId\"::text, \
                   (extract(epoch from c.\"inboxAt\") * 1000)::int8 from ({}) c",
                frag("turn_lease_cause")
            ),
            used: frag("turn_lease_used"),
            prior: format!(
                "select p.id::text, p.\"operatorId\"::text, p.ended, p.\"lastBeat\"::text, \
                   (extract(epoch from p.\"lastBeat\") * 1000)::int8, p.total::int8 from ({}) p",
                frag("turn_lease_prior")
            ),
            claim_moved: frag("turn_lease_claim_moved"),
            end_prior: frag("turn_lease_end_prior"),
            insert: format!(
                "with x as ({}) select id::text from x",
                frag("turn_lease_insert")
            ),
            end: frag("turn_lease_end"),
            renew: format!(
                "with x as ({}) select to_char(x.\"expiresAt\" at time zone 'UTC', 'YYYY-MM-DD\"T\"HH24:MI:SS.MS\"Z\"') from x",
                frag("turn_lease_renew")
            ),
            // `automationMandateForCause` 의 첫 질의가 행을 찾을 수 있는 글인가 — 찾을 수 있으면 TS 로 넘긴다. 일부러 넓게 본다
            // (자동화가 꺼졌거나 승인 전이어도 넘긴다): 판정은 TS 한 곳에 두고, Rust 는 「자동화와 무관한 부름」만 맡는다.
            automation_cause: "select exists (select 1 from automation_run r where r.message_id = $1::uuid)",
            ttl_ms,
            max_ms,
            renew_ms,
            inbox_max_age_ms,
            reissue_stale_ms,
            max_reissues,
        }
    })
}

/// TS `sha256` — 토큰은 해시만 저장한다.
fn sha256_hex(s: &str) -> String {
    hex::encode(Sha256::digest(s.as_bytes()))
}

/// TS `randomBytes(32).toString('base64url')`.
fn new_token() -> String {
    let mut b = [0u8; 32];
    getrandom::fill(&mut b).expect("os random");
    URL_SAFE_NO_PAD.encode(b)
}

/// TS `LeaseIssue.reissue`.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Reissue {
    pub old_lease_id: String,
    pub since_last_beat_sec: i64,
    /// `"thread_claim"` | `"stale_beat"`.
    pub via: &'static str,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Issued {
    pub lease_id: String,
    pub token: String,
    pub channel_id: String,
    pub thread_root_id: String,
    /// TS `toISOString()` 꼴.
    pub expires_at: String,
    pub waited_sec: i64,
    pub reissue: Option<Reissue>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Issue {
    Ok(Issued),
    /// TS `not_invoked` — 이 에이전트가 최근에 그 글로 불리지 않았다(읽지 않은 6시간 안 인박스 항목 없음).
    NotInvoked,
    /// TS `lease_used` — 그 부름에 이미 임대를 줬고 다시 주기 조건이 아니다.
    LeaseUsed,
    /// 자동화 회차 글 — 위임장을 만들 수 있어 TS 가 맡는다. 아무것도 쓰지 않았다.
    Handoff,
}

/// 원인 글 한 줄: 채널·스레드·위임장·principal·인박스 시각(epoch ms).
type CauseRow = (String, String, Option<String>, Option<String>, i64);
/// 앞 임대: id·오퍼레이터·끝남·마지막 박동(글자·epoch ms)·이 부름의 행 수.
type PriorRow = (String, String, bool, String, i64, i64);

/// 트랜잭션 시각 — 밀리초로 자른 `now()` 의 글자와 epoch ms.
async fn tx_now(tx: &mut sqlx::PgConnection) -> Result<(String, i64), sqlx::Error> {
    sqlx::query_as(
        "select date_trunc('milliseconds', now())::text, (extract(epoch from date_trunc('milliseconds', now())) * 1000)::int8",
    )
    .fetch_one(tx)
    .await
}

/// TS `issueTurnLease`. `claim_holder` 는 묻는 러너의 스레드 임대 holder(옛 러너는 없다).
pub async fn issue(
    pool: &PgPool,
    agent_id: &str,
    operator_id: &str,
    cause_message_id: &str,
    claim_holder: Option<&str>,
) -> Result<Issue, sqlx::Error> {
    let s = sql();
    let mut tx = pool.begin().await?;
    let (now, now_ms) = tx_now(&mut tx).await?;
    // 같은 (에이전트, 멘션) 의 동시 발급을 줄 세운다 — TS 와 같은 열쇠라 TS·Rust 사이에서도 줄이 선다.
    sqlx::query("select pg_advisory_xact_lock(hashtext($1))")
        .bind(format!("lease:{agent_id}:{cause_message_id}"))
        .execute(&mut *tx)
        .await?;
    let min_inbox: String =
        sqlx::query_scalar("select ($1::timestamptz - make_interval(secs => $2::float8))::text")
            .bind(&now)
            .bind(s.inbox_max_age_ms as f64 / 1000.0)
            .fetch_one(&mut *tx)
            .await?;
    let row: Option<CauseRow> = sqlx::query_as(s.cause.as_str())
        .bind(agent_id)
        .bind(cause_message_id)
        .bind(&min_inbox)
        .fetch_optional(&mut *tx)
        .await?;
    let Some((channel_id, thread_root_id, mandate_id, principal_id, inbox_ms)) = row else {
        tx.rollback().await?;
        return Ok(Issue::NotInvoked);
    };
    let used = sqlx::query(s.used.as_str())
        .bind(agent_id)
        .bind(cause_message_id)
        .fetch_optional(&mut *tx)
        .await?
        .is_some();
    let mut reissue: Option<Reissue> = None;
    if used {
        let prior: Option<PriorRow> = sqlx::query_as(s.prior.as_str())
            .bind(agent_id)
            .bind(cause_message_id)
            .fetch_optional(&mut *tx)
            .await?;
        let Some((prior_id, prior_op, prior_ended, last_beat, last_beat_ms, total)) = prior else {
            tx.rollback().await?;
            return Ok(Issue::LeaseUsed);
        };
        let stale = now_ms - last_beat_ms >= s.reissue_stale_ms;
        let claim_moved = match claim_holder {
            Some(h) if !prior_ended => sqlx::query(s.claim_moved.as_str())
                .bind(agent_id)
                .bind(&channel_id)
                .bind(&thread_root_id)
                .bind(h)
                .bind(&last_beat)
                .fetch_optional(&mut *tx)
                .await?
                .is_some(),
            _ => false,
        };
        if prior_ended
            || prior_op != operator_id
            || !(stale || claim_moved)
            || total > s.max_reissues
        {
            tx.rollback().await?;
            return Ok(Issue::LeaseUsed);
        }
        // TS 와 같은 차례: 위임장 판정은 다시 주기 판정 뒤다 — 자동화 글이면 여기서 넘기고 옛 임대도 건드리지 않는다.
        if mandate_id.is_none() && automation_cause(&mut tx, cause_message_id).await? {
            tx.rollback().await?;
            return Ok(Issue::Handoff);
        }
        sqlx::query(s.end_prior.as_str())
            .bind(&prior_id)
            .bind(&now)
            .execute(&mut *tx)
            .await?;
        reissue = Some(Reissue {
            old_lease_id: prior_id,
            since_last_beat_sec: round_div(now_ms - last_beat_ms, 1000),
            via: if stale { "stale_beat" } else { "thread_claim" },
        });
    } else if mandate_id.is_none() && automation_cause(&mut tx, cause_message_id).await? {
        tx.rollback().await?;
        return Ok(Issue::Handoff);
    }
    let token = new_token();
    let (expires_at, expires_iso): (String, String) = sqlx::query_as(
        "select ($1::timestamptz + make_interval(secs => $2::float8))::text, \
           to_char(($1::timestamptz + make_interval(secs => $2::float8)) at time zone 'UTC', 'YYYY-MM-DD\"T\"HH24:MI:SS.MS\"Z\"')",
    )
    .bind(&now)
    .bind(s.ttl_ms as f64 / 1000.0)
    .fetch_one(&mut *tx)
    .await?;
    let lease_id: String = sqlx::query_scalar(s.insert.as_str())
        .bind(sha256_hex(&token))
        .bind(agent_id)
        .bind(operator_id)
        .bind(cause_message_id)
        .bind(&channel_id)
        .bind(&thread_root_id)
        .bind(&now)
        .bind(&expires_at)
        .bind(mandate_id.as_deref())
        .bind(principal_id.as_deref())
        .bind(reissue.as_ref().map(|r| r.old_lease_id.as_str()))
        .fetch_one(&mut *tx)
        .await?;
    tx.commit().await?;
    Ok(Issue::Ok(Issued {
        lease_id,
        token,
        channel_id,
        thread_root_id,
        expires_at: expires_iso,
        waited_sec: round_div(now_ms - inbox_ms, 1000).max(0),
        reissue,
    }))
}

async fn automation_cause(
    tx: &mut sqlx::PgConnection,
    cause_message_id: &str,
) -> Result<bool, sqlx::Error> {
    sqlx::query_scalar(sql().automation_cause)
        .bind(cause_message_id)
        .fetch_one(tx)
        .await
}

/// JS `Math.round(a / b)`(b > 0) — 절반은 +∞ 쪽으로.
fn round_div(a: i64, b: i64) -> i64 {
    (a as f64 / b as f64 + 0.5).floor() as i64
}

/// TS `endTurnLease` — 토큰이 맞는 살아 있는(끝나지 않은) 자기 임대만 끝낸다. 끝냈으면 true.
pub async fn end(
    pool: &PgPool,
    lease_id: &str,
    token: &str,
    agent_id: &str,
) -> Result<bool, sqlx::Error> {
    let r = sqlx::query(sql().end.as_str())
        .bind(lease_id)
        .bind(sha256_hex(token))
        .bind(agent_id)
        .execute(pool)
        .await?;
    Ok(r.rows_affected() > 0)
}

/// TS `renewTurnLease` — 늘린 뒤의 만료 시각(TS `toISOString()` 꼴). 끝났거나 만료됐거나 남의 것이면 None.
pub async fn renew(
    pool: &PgPool,
    lease_id: &str,
    token: &str,
    agent_id: &str,
    operator_id: &str,
) -> Result<Option<String>, sqlx::Error> {
    let s = sql();
    let mut tx = pool.begin().await?;
    let (now, _) = tx_now(&mut tx).await?;
    let out: Option<String> = sqlx::query_scalar(s.renew.as_str())
        .bind(lease_id)
        .bind(sha256_hex(token))
        .bind(agent_id)
        .bind(&now)
        .bind(s.renew_ms as f64 / 1000.0)
        .bind(s.max_ms as f64 / 1000.0)
        .bind(operator_id)
        .fetch_optional(&mut *tx)
        .await?;
    tx.commit().await?;
    Ok(out)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn golden_consts_match_ts_values() {
        let s = sql();
        assert_eq!(s.ttl_ms, 35 * 60_000);
        assert_eq!(s.max_ms, 70 * 60_000);
        assert_eq!(s.renew_ms, 10 * 60_000);
        assert_eq!(s.inbox_max_age_ms, 6 * 60 * 60_000);
        // 러너 박동 4분의 1.5배.
        assert_eq!(s.reissue_stale_ms, 6 * 60_000);
        assert_eq!(s.max_reissues, 2);
    }

    #[test]
    fn token_shape_matches_base64url_32_bytes() {
        let t = new_token();
        assert_eq!(t.len(), 43);
        assert!(
            t.bytes()
                .all(|c| c.is_ascii_alphanumeric() || c == b'-' || c == b'_')
        );
        assert_ne!(t, new_token());
    }

    #[test]
    fn sha256_is_hex_of_utf8() {
        assert_eq!(
            sha256_hex("abc"),
            "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad"
        );
    }

    #[test]
    fn round_div_matches_math_round() {
        assert_eq!(round_div(1499, 1000), 1);
        assert_eq!(round_div(1500, 1000), 2);
        assert_eq!(round_div(0, 1000), 0);
        assert_eq!(round_div(-1500, 1000), -1);
    }
}
