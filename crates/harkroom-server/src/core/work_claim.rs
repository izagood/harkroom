//! I2a 잡은 기록 — 오퍼레이터가 작업 판(`work`)에서 「내가 돌릴 수 있는 가장 앞 작업」을 한 문장으로 잡고, 임대를 갱신하고, 놓는다.
//! 표는 `work_claim`(마이그레이션 194)이고 작업마다 한 줄이다.
//!
//! - **자격은 문장이 판정한다.** 그 작업의 담당 에이전트가 이 오퍼레이터의 허용 표(`agent_operator_allow`)에 있고, 오퍼레이터가
//!   회수되지 않았고, 개인 자격증명 에이전트면 기기 소유자가 에이전트 소유자와 같아야 한다(`device_allow` 의 읽기 판정과 같은 규칙).
//!   부르는 쪽이 넘긴 값으로 자격을 넓힐 수 없다 — `agents` 인자는 후보를 **좁히기만** 한다.
//! - **잡을 수 있는 작업**: 담당이 있고, 상태가 `open` 이고, 살아 있는 줄이 없고, 앞 작업(`after_work_id`)이 닫혔고, 같은 뿌리에서
//!   경로가 겹치는 작업을 누가 쥐고 있지 않다. 담당이 빈 작업(누가 돌릴지 정해지지 않은 과제)은 이 단계에서 잡지 않는다.
//! - **순서**: 사람이 시킨 작업 먼저, 그다음 만든 시각.
//! - **임대**: 잡을 때 만료 시각을 적고, 오퍼레이터가 자기가 아직 쥔 작업 목록으로 묶어서 갱신한다([`renew`]). 갱신이 끊기면 만료되고
//!   다음에 잡는 쪽이 같은 줄을 덮어쓴다(`attempts` 가 하나 오른다). 치우는 일꾼은 없다.
//! - 이 모듈은 `work.state` 를 바꾸지 않고 `work_event` 도 적지 않는다 — 상태를 옮기는 일은 잡는 쪽을 잇는 단계가 정한다.
//! - 스위치 `HARKROOM_WORK_CLAIM`(`on`·`1`·`true` 만 켬, 기본 꺼짐). **이 단계에서는 어떤 프레임·경로도 이 모듈을 부르지 않는다** —
//!   오퍼레이터 쪽 배선은 다음 단계다.
use super::wake_deliver::is_uuid_shaped;
use sqlx::PgPool;

/// 이 모듈의 문장이 닿는 권한(쓰기 역할). `work` 의 UPDATE 는 후보 행을 잠그는 데(`for update … skip locked`) 든다.
/// 하나라도 없으면 잇는 쪽이 이 길을 켜지 않는다(fail-closed).
pub const WORK_CLAIM_PRIVILEGES: &[(&str, &str)] = &[
    ("work_claim", "SELECT"),
    ("work_claim", "INSERT"),
    ("work_claim", "UPDATE"),
    ("work", "SELECT"),
    ("work", "UPDATE"),
    ("agent_operator_allow", "SELECT"),
    ("operator", "SELECT"),
    ("account", "SELECT"),
    ("agent_config", "SELECT"),
];

/// 임대 길이(초)의 기본값과 범위. 오퍼레이터가 넘긴 값은 이 범위로 자른다.
pub const LEASE_DEFAULT_SECS: i32 = 90;
pub const LEASE_MIN_SECS: i32 = 15;
pub const LEASE_MAX_SECS: i32 = 600;
/// 한 번의 갱신·한 번의 후보 좁히기에 받는 id 수 상한.
pub const IDS_MAX: usize = 256;
/// 겹쳐 잡다 진 경우(고른 행을 다른 쪽이 먼저 적음) 다시 고르는 횟수.
const RACE_RETRIES: usize = 3;

/// 켬 판정(순수) — `on`·`1`·`true`(대소문자·앞뒤 공백 무시)만 켠다.
pub fn switch_on(raw: Option<&str>) -> bool {
    matches!(
        raw.map(|v| v.trim().to_ascii_lowercase()).as_deref(),
        Some("on" | "1" | "true")
    )
}

fn switch_from_env() -> bool {
    switch_on(crate::env_once::get(&crate::env_once::WORK_CLAIM))
}

/// 넘어온 임대 길이를 범위로 자른다. 없으면 기본값.
pub fn lease_secs(requested: Option<i32>) -> i32 {
    requested
        .unwrap_or(LEASE_DEFAULT_SECS)
        .clamp(LEASE_MIN_SECS, LEASE_MAX_SECS)
}

/// 하지 않은 까닭. [`Refusal::code`] 가 응답에 실을 글자다.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Refusal {
    /// 스위치가 꺼져 있다.
    Disabled,
    /// id 모양이 아니거나 너무 많다.
    BadRequest,
}

impl Refusal {
    pub fn code(self) -> &'static str {
        match self {
            Refusal::Disabled => "work_claim_disabled",
            Refusal::BadRequest => "invalid_request",
        }
    }
}

/// 놓는 까닭(`work_claim.release_reason` 의 check 와 같다).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ReleaseReason {
    Done,
    Failed,
    Released,
}

impl ReleaseReason {
    pub fn as_str(self) -> &'static str {
        match self {
            ReleaseReason::Done => "done",
            ReleaseReason::Failed => "failed",
            ReleaseReason::Released => "released",
        }
    }

    pub fn parse(raw: &str) -> Option<ReleaseReason> {
        match raw {
            "done" => Some(ReleaseReason::Done),
            "failed" => Some(ReleaseReason::Failed),
            "released" => Some(ReleaseReason::Released),
            _ => None,
        }
    }
}

/// 잡은 작업 하나.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Claimed {
    pub work_id: String,
    pub agent_id: String,
    pub channel_id: String,
    pub thread_root_id: String,
    pub root_id: String,
    /// 이 작업이 잡힌 횟수(처음이면 1).
    pub attempts: i32,
    /// 임대 만료 시각(ISO, UTC).
    pub lease_expires_at: String,
}

/// 살아 있는 줄의 술어 — `c` 는 `work_claim` 별칭.
macro_rules! live {
    ($c:literal) => {
        concat!(
            $c,
            ".released_at is null and ",
            $c,
            ".lease_expires_at > now()"
        )
    };
}

/// 잡는 문장. `$1` 오퍼레이터, `$2` 러너 칸 세대, `$3` 임대 길이(초), `$4` 후보를 좁힐 에이전트 목록(null 이면 안 좁힘).
/// `pick` 이 후보 하나를 고르며 그 작업 행을 잠근다(다른 쪽이 잠근 행은 건너뛴다). `ins` 는 살아 있는 줄이 없을 때만 적는다.
/// 돌려주는 줄: 고른 작업 + 적혔으면 횟수·만료(안 적혔으면 null — 겹쳐 잡다 진 것).
pub const CLAIM_SQL: &str = concat!(
    "with pick as ( \
       select w.id, w.assignee_account_id as agent_id, w.channel_id, w.thread_root_id, w.root_id \
         from work w \
         join agent_operator_allow al on al.agent_id = w.assignee_account_id and al.operator_id = $1::uuid \
         join operator o on o.id = al.operator_id and o.revoked_at is null \
         join account a on a.id = w.assignee_account_id and a.kind = 'agent' and a.deleted_at is null \
         left join agent_config cfg on cfg.account_id = w.assignee_account_id \
         left join account rq on rq.id = w.requester_account_id \
        where w.state = 'open' and w.closed_at is null \
          and (coalesce(cfg.credential_scope, 'none') <> 'personal' or cfg.owner_account_id = o.owner_account_id) \
          and ($4::uuid[] is null or w.assignee_account_id = any($4::uuid[])) \
          and not exists (select 1 from work_claim c where c.work_id = w.id and ",
    live!("c"),
    ") \
          and (w.after_work_id is null or exists ( \
                 select 1 from work p where p.id = w.after_work_id and p.closed_at is not null)) \
          and not exists ( \
                 select 1 from work_claim c2 join work w2 on w2.id = c2.work_id \
                  where w2.root_id = w.root_id and w2.id <> w.id and w2.paths && w.paths and ",
    live!("c2"),
    ") \
        order by (rq.kind is not distinct from 'human') desc, w.created_at, w.id \
        limit 1 for update of w skip locked \
     ), ins as ( \
       insert into work_claim (work_id, agent_id, operator_id, slot_generation, mode, lease_expires_at) \
       select p.id, p.agent_id, $1::uuid, $2::bigint, 'pull', now() + make_interval(secs => $3::int) from pick p \
       on conflict (work_id) do update \
          set agent_id = excluded.agent_id, operator_id = excluded.operator_id, \
              slot_generation = excluded.slot_generation, mode = excluded.mode, turn_id = null, \
              claimed_at = now(), renewed_at = now(), lease_expires_at = excluded.lease_expires_at, \
              released_at = null, release_reason = null, attempts = work_claim.attempts + 1 \
        where work_claim.released_at is not null or work_claim.lease_expires_at <= now() \
       returning work_id, attempts, lease_expires_at \
     ) \
     select p.id::text, p.agent_id::text, p.channel_id::text, p.thread_root_id::text, p.root_id::text, i.attempts, ",
    crate::iso!("i.lease_expires_at"),
    " from pick p left join ins i on i.work_id = p.id"
);

/// 묶어서 갱신 — 이 오퍼레이터(`$1`)가 쥔 살아 있는 줄 가운데 `$3` 에 든 작업만 만료를 민다. 돌려주는 것은 갱신된 작업 id.
/// 이미 만료됐거나 남이 다시 잡은 줄은 갱신되지 않는다(돌아온 목록에 없으면 잃은 것이다).
pub const RENEW_SQL: &str = concat!(
    "update work_claim c set renewed_at = now(), lease_expires_at = now() + make_interval(secs => $2::int) \
      where c.operator_id = $1::uuid and c.work_id = any($3::uuid[]) and ",
    live!("c"),
    " returning c.work_id::text"
);

/// 놓기 — 이 오퍼레이터(`$1`)가 쥔 살아 있는 줄일 때만. `$3` 까닭.
pub const RELEASE_SQL: &str = concat!(
    "update work_claim c set released_at = now(), release_reason = $3::text \
      where c.work_id = $2::uuid and c.operator_id = $1::uuid and ",
    live!("c")
);

/// 턴 적기(기록용) — 이 오퍼레이터(`$1`)가 쥔 살아 있는 줄일 때만.
pub const NOTE_TURN_SQL: &str = concat!(
    "update work_claim c set turn_id = $3::uuid \
      where c.work_id = $2::uuid and c.operator_id = $1::uuid and ",
    live!("c")
);

type ClaimRow = (
    String,
    String,
    String,
    String,
    String,
    Option<i32>,
    Option<String>,
);

fn ids_ok(ids: &[String]) -> bool {
    ids.len() <= IDS_MAX && ids.iter().all(|s| is_uuid_shaped(s))
}

/// 오퍼레이터 `operator_id` 가 판에서 작업 하나를 잡는다. 잡을 것이 없으면 `None`. 스위치는 env 에서 읽는다.
/// `operator_id` 는 인증된 연결의 것이어야 한다 — 이 함수는 그 값이 누구 것인지 다시 묻지 않는다.
pub async fn claim_next(
    pool: &PgPool,
    operator_id: &str,
    slot_generation: i64,
    lease: Option<i32>,
    agents: Option<&[String]>,
) -> sqlx::Result<Result<Option<Claimed>, Refusal>> {
    claim_next_with(
        pool,
        switch_from_env(),
        operator_id,
        slot_generation,
        lease,
        agents,
    )
    .await
}

/// [`claim_next`] 의 몸통 — 스위치를 인자로 받는다(시험).
pub async fn claim_next_with(
    pool: &PgPool,
    on: bool,
    operator_id: &str,
    slot_generation: i64,
    lease: Option<i32>,
    agents: Option<&[String]>,
) -> sqlx::Result<Result<Option<Claimed>, Refusal>> {
    if !on {
        return Ok(Err(Refusal::Disabled));
    }
    if !is_uuid_shaped(operator_id) || slot_generation < 0 || !agents.is_none_or(ids_ok) {
        return Ok(Err(Refusal::BadRequest));
    }
    for _ in 0..RACE_RETRIES {
        let row: Option<ClaimRow> = sqlx::query_as(CLAIM_SQL)
            .bind(operator_id)
            .bind(slot_generation)
            .bind(lease_secs(lease))
            .bind(agents)
            .fetch_optional(pool)
            .await?;
        match row {
            None => return Ok(Ok(None)),
            Some((
                work_id,
                agent_id,
                channel_id,
                thread_root_id,
                root_id,
                Some(attempts),
                Some(lease_expires_at),
            )) => {
                return Ok(Ok(Some(Claimed {
                    work_id,
                    agent_id,
                    channel_id,
                    thread_root_id,
                    root_id,
                    attempts,
                    lease_expires_at,
                })));
            }
            // 고른 행을 다른 쪽이 먼저 적었다 — 다시 고른다.
            Some(_) => {}
        }
    }
    Ok(Ok(None))
}

/// 오퍼레이터가 아직 쥐고 있다고 말한 작업들의 임대를 민다. 돌려주는 것은 실제로 갱신된 작업 id — 빠진 것은 잃은 줄이다.
pub async fn renew(
    pool: &PgPool,
    operator_id: &str,
    lease: Option<i32>,
    work_ids: &[String],
) -> sqlx::Result<Result<Vec<String>, Refusal>> {
    renew_with(pool, switch_from_env(), operator_id, lease, work_ids).await
}

pub async fn renew_with(
    pool: &PgPool,
    on: bool,
    operator_id: &str,
    lease: Option<i32>,
    work_ids: &[String],
) -> sqlx::Result<Result<Vec<String>, Refusal>> {
    if !on {
        return Ok(Err(Refusal::Disabled));
    }
    if !is_uuid_shaped(operator_id) || !ids_ok(work_ids) {
        return Ok(Err(Refusal::BadRequest));
    }
    if work_ids.is_empty() {
        return Ok(Ok(Vec::new()));
    }
    let rows: Vec<String> = sqlx::query_scalar(RENEW_SQL)
        .bind(operator_id)
        .bind(lease_secs(lease))
        .bind(work_ids)
        .fetch_all(pool)
        .await?;
    Ok(Ok(rows))
}

/// 놓는다 — 놓았으면 `true`(내 살아 있는 줄이 아니면 `false`).
pub async fn release(
    pool: &PgPool,
    operator_id: &str,
    work_id: &str,
    reason: ReleaseReason,
) -> sqlx::Result<Result<bool, Refusal>> {
    release_with(pool, switch_from_env(), operator_id, work_id, reason).await
}

pub async fn release_with(
    pool: &PgPool,
    on: bool,
    operator_id: &str,
    work_id: &str,
    reason: ReleaseReason,
) -> sqlx::Result<Result<bool, Refusal>> {
    if !on {
        return Ok(Err(Refusal::Disabled));
    }
    if !is_uuid_shaped(operator_id) || !is_uuid_shaped(work_id) {
        return Ok(Err(Refusal::BadRequest));
    }
    let n = sqlx::query(RELEASE_SQL)
        .bind(operator_id)
        .bind(work_id)
        .bind(reason.as_str())
        .execute(pool)
        .await?
        .rows_affected();
    Ok(Ok(n == 1))
}

/// 그 작업을 도는 턴을 적는다(기록용) — 적었으면 `true`.
pub async fn note_turn_with(
    pool: &PgPool,
    on: bool,
    operator_id: &str,
    work_id: &str,
    turn_id: &str,
) -> sqlx::Result<Result<bool, Refusal>> {
    if !on {
        return Ok(Err(Refusal::Disabled));
    }
    if !is_uuid_shaped(operator_id) || !is_uuid_shaped(work_id) || !is_uuid_shaped(turn_id) {
        return Ok(Err(Refusal::BadRequest));
    }
    let n = sqlx::query(NOTE_TURN_SQL)
        .bind(operator_id)
        .bind(work_id)
        .bind(turn_id)
        .execute(pool)
        .await?
        .rows_affected();
    Ok(Ok(n == 1))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn switch_default_off() {
        assert!(!switch_on(None));
        assert!(!switch_on(Some("")));
        assert!(!switch_on(Some("shadow")));
        assert!(!switch_on(Some("0")));
        assert!(switch_on(Some("on")));
        assert!(switch_on(Some(" TRUE ")));
        assert!(switch_on(Some("1")));
    }

    #[test]
    fn lease_is_clamped() {
        assert_eq!(lease_secs(None), LEASE_DEFAULT_SECS);
        assert_eq!(lease_secs(Some(0)), LEASE_MIN_SECS);
        assert_eq!(lease_secs(Some(-5)), LEASE_MIN_SECS);
        assert_eq!(lease_secs(Some(86_400)), LEASE_MAX_SECS);
        assert_eq!(lease_secs(Some(120)), 120);
    }

    #[test]
    fn privileges_never_delete_and_stay_out_of_the_operator_core_gate() {
        assert!(WORK_CLAIM_PRIVILEGES.iter().all(|(_, p)| *p != "DELETE"));
        // 이 표의 GRANT 가 늦어도 오퍼레이터 코어는 떠야 한다.
        for (t, _) in crate::write::OPERATOR_PRIVILEGES {
            assert_ne!(*t, "work_claim");
        }
    }

    #[test]
    fn every_write_is_bound_to_the_operator_and_a_live_row() {
        for sql in [RENEW_SQL, RELEASE_SQL, NOTE_TURN_SQL] {
            assert!(sql.contains("c.operator_id = $1::uuid"), "{sql}");
            assert!(
                sql.contains("c.released_at is null and c.lease_expires_at > now()"),
                "{sql}"
            );
        }
        // 잡는 문장은 허용 표·회수·개인 자격증명 규칙을 스스로 본다.
        assert!(CLAIM_SQL.contains("al.operator_id = $1::uuid"));
        assert!(CLAIM_SQL.contains("o.revoked_at is null"));
        assert!(CLAIM_SQL.contains("cfg.owner_account_id = o.owner_account_id"));
        assert!(CLAIM_SQL.contains("skip locked"));
    }

    #[test]
    fn reasons_round_trip() {
        for r in [
            ReleaseReason::Done,
            ReleaseReason::Failed,
            ReleaseReason::Released,
        ] {
            assert_eq!(ReleaseReason::parse(r.as_str()), Some(r));
        }
        assert_eq!(ReleaseReason::parse("expired"), None);
    }

    #[test]
    fn bad_ids_are_refused_before_the_database() {
        assert!(ids_ok(&[]));
        assert!(!ids_ok(&["nope".to_string()]));
        assert!(!ids_ok(&vec![
            "00000000-0000-4000-8000-000000000001"
                .to_string();
            IDS_MAX + 1
        ]));
    }
}
