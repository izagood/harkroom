//! 턴 임대(`secret_turn_lease`) 읽기 — 여러 라우트가 같이 쓴다.
//!
//! - [`read_lease`]: TS `mergeGrants.readLease`(정본 `READ_LEASE_SQL` 을 `golden/sql_fragments.json` 의 `grant_read_lease` 로 읽는다).
//!   머지 판정(`checkMerge`)의 성공 길이 쓸 [`LeaseRow`]·[`LeaseRow::cause_by_human`]·[`mandate_enforced`] 를 함께 둔다.
//! - [`read_create_lease`]: TS `readCreateLease`(에이전트 비밀 만들기·회전, `agent_secret_create.rs`).
use super::agent_secret_create::LeaseCause;
use super::merge_approval_peek::sha256_hex;
use sqlx::PgPool;

/// TS `mandateEnforced` — `HARKROOM_MANDATE_ENFORCE` 를 다듬고 소문자로 바꿔 `on` 일 때만 켠다. 부를 때마다 읽는다.
pub fn mandate_enforced(v: Option<&str>) -> bool {
    v.unwrap_or("").trim().to_lowercase() == "on"
}

/// 앞단이 아는 위임 스위치 — 값이 **없으면(비었으면) 모른다**(`None`). TS 는 없으면 꺼짐이지만, 앞단의 env 는 TS 서버의 env 와
/// 따로 실리므로 없다는 것만으로 TS 가 꺼져 있다고 볼 수 없다. 모르면 머지 판정을 통째로 TS 에 넘긴다(`HARKROOM_DELEGATION_V2`
/// 와 같은 꼴). 값이 있으면 [`mandate_enforced`] 그대로(`on` 만 켜짐, 그 밖의 값은 꺼짐).
pub fn mandate_switch(v: Option<&str>) -> Option<bool> {
    let v = v?;
    (!v.trim().is_empty()).then(|| mandate_enforced(Some(v)))
}

/// [`mandate_switch`] 를 지금 환경에서. env 는 프로세스에서 한 번 읽는다(`env_once`).
pub fn mandate_enforced_env() -> Option<bool> {
    mandate_switch(crate::env_once::get(&crate::env_once::MANDATE_ENFORCE))
}

/// TS `LeaseRow`.
#[derive(Debug, Clone, Default, PartialEq)]
pub struct LeaseRow {
    pub id: String,
    pub agent_id: String,
    pub operator_id: Option<String>,
    pub channel_id: Option<String>,
    pub thread_root_id: Option<String>,
    pub expired: bool,
    pub ended: bool,
    pub cause_message_id: Option<String>,
    pub mandate_id: Option<String>,
    pub cause_kind: Option<String>,
    pub cause_ask_author_id: Option<String>,
    pub ask_answered_by: Option<String>,
    pub ask_answerer_kind: Option<String>,
    pub ask_answerer_owns_agent: Option<bool>,
}

impl LeaseRow {
    /// TS `causeByHuman(lease)`.
    pub fn cause_by_human(&self) -> bool {
        cause_by_human(
            &self.agent_id,
            self.cause_kind.as_deref(),
            self.cause_ask_author_id.as_deref(),
            self.ask_answered_by.as_deref(),
            self.ask_answerer_kind.as_deref(),
            self.ask_answerer_owns_agent == Some(true),
        )
    }
}

/// TS `causeByHuman` — cause 작성자가 사람이거나, cause 가 이 에이전트 자신의 카드이고 정할 수 있는 사람이 답했다.
pub fn cause_by_human(
    agent: &str,
    cause_kind: Option<&str>,
    ask_author: Option<&str>,
    answered_by: Option<&str>,
    answerer_kind: Option<&str>,
    answerer_owns: bool,
) -> bool {
    if cause_kind == Some("human") {
        return true;
    }
    ask_author == Some(agent)
        && answered_by.is_some_and(|a| !a.is_empty())
        && answerer_kind == Some("human")
        && answerer_owns
}

fn read_lease_sql() -> &'static str {
    static S: std::sync::OnceLock<String> = std::sync::OnceLock::new();
    S.get_or_init(|| {
        format!(
            "select t.id::text, t.\"agentId\"::text, t.\"operatorId\"::text, t.\"channelId\"::text, \
             t.\"threadRootId\"::text, t.expired, t.ended, t.\"causeMessageId\"::text, t.\"mandateId\"::text, \
             t.\"causeKind\", t.\"causeAskAuthorId\"::text, t.\"askAnsweredBy\", t.\"askAnswererKind\", \
             t.\"askAnswererOwnsAgent\" from ({}) t",
            crate::core::channels::frag("grant_read_lease")
        )
    })
}

/// TS `readLease` — `$3` 은 TS 의 `now`(밀리초 ISO). 끝남·만료·소속 판정은 부르는 쪽이 한다.
pub async fn read_lease(
    pool: &PgPool,
    lease_id: &str,
    token: &str,
    now_iso: &str,
) -> sqlx::Result<Option<LeaseRow>> {
    use sqlx::Row;
    let Some(r) = sqlx::query(read_lease_sql())
        .bind(lease_id)
        .bind(sha256_hex(token))
        .bind(now_iso)
        .fetch_optional(pool)
        .await?
    else {
        return Ok(None);
    };
    Ok(Some(LeaseRow {
        id: r.try_get(0)?,
        agent_id: r.try_get(1)?,
        operator_id: r.try_get(2)?,
        channel_id: r.try_get(3)?,
        thread_root_id: r.try_get(4)?,
        expired: r.try_get(5)?,
        ended: r.try_get(6)?,
        cause_message_id: r.try_get(7)?,
        mandate_id: r.try_get(8)?,
        cause_kind: r.try_get(9)?,
        cause_ask_author_id: r.try_get(10)?,
        ask_answered_by: r.try_get(11)?,
        ask_answerer_kind: r.try_get(12)?,
        ask_answerer_owns_agent: r.try_get(13)?,
    }))
}

/// TS `readCreateLease` — `$3` 은 TS 가 넘기는 `now`(밀리초 ISO).
const READ_CREATE_LEASE_SQL: &str = "select l.id::text, l.agent_id::text, l.operator_id::text, l.channel_id::text, \
            l.thread_root_id::text, l.cause_message_id::text, \
            l.expires_at <= $3::timestamptz as expired, l.ended_at is not null as ended, \
            c.owner_account_id::text as owner_id, \
            coalesce(o.deleted_at is not null or o.disabled_at is not null, true) as owner_inactive, \
            m.author_id::text as cause_author_id, a.kind as cause_kind, \
            case when m.meta ? 'ask' and m.meta->'ask'->>'mirrorOf' is null and m.meta->'ask'->>'answeredVia' is null \
                 then m.author_id::text end as cause_ask_author_id, \
            m.meta->'ask'->>'answeredBy' as ask_answered_by, ans.kind as ask_answerer_kind \
       from secret_turn_lease l \
       left join agent_config c on c.account_id = l.agent_id \
       left join account o on o.id = c.owner_account_id \
       left join message m on m.id = l.cause_message_id \
       left join account a on a.id = m.author_id \
       left join account ans on ans.id = nullif(m.meta->'ask'->>'answeredBy', '')::uuid \
      where l.id = $1::uuid and l.token_hash = $2";

/// TS `CreateLease`.
#[derive(Debug, Clone)]
pub struct CreateLease {
    pub id: String,
    pub agent_id: String,
    pub operator_id: String,
    pub channel_id: String,
    pub thread_root_id: String,
    pub cause_message_id: String,
    pub expired: bool,
    pub ended: bool,
    pub owner_id: Option<String>,
    pub owner_inactive: bool,
    pub cause_author_id: Option<String>,
    pub cause_kind: Option<String>,
    pub cause_ask_author_id: Option<String>,
    pub ask_answered_by: Option<String>,
    pub ask_answerer_kind: Option<String>,
}

impl CreateLease {
    pub fn cause(&self) -> LeaseCause<'_> {
        LeaseCause {
            agent_id: &self.agent_id,
            owner_id: self.owner_id.as_deref(),
            cause_author_id: self.cause_author_id.as_deref(),
            cause_kind: self.cause_kind.as_deref(),
            cause_ask_author_id: self.cause_ask_author_id.as_deref(),
            ask_answered_by: self.ask_answered_by.as_deref(),
            ask_answerer_kind: self.ask_answerer_kind.as_deref(),
        }
    }
}

pub async fn read_create_lease(
    pool: &PgPool,
    lease_id: &str,
    token: &str,
    now_iso: &str,
) -> sqlx::Result<Option<CreateLease>> {
    use sqlx::Row;
    let Some(r) = sqlx::query(READ_CREATE_LEASE_SQL)
        .bind(lease_id)
        .bind(sha256_hex(token))
        .bind(now_iso)
        .fetch_optional(pool)
        .await?
    else {
        return Ok(None);
    };
    Ok(Some(CreateLease {
        id: r.try_get(0)?,
        agent_id: r.try_get(1)?,
        operator_id: r.try_get(2)?,
        channel_id: r.try_get(3)?,
        thread_root_id: r.try_get(4)?,
        cause_message_id: r.try_get(5)?,
        expired: r.try_get(6)?,
        ended: r.try_get(7)?,
        owner_id: r.try_get(8)?,
        owner_inactive: r.try_get(9)?,
        cause_author_id: r.try_get(10)?,
        cause_kind: r.try_get(11)?,
        cause_ask_author_id: r.try_get(12)?,
        ask_answered_by: r.try_get(13)?,
        ask_answerer_kind: r.try_get(14)?,
    }))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn mandate_enforced_like_ts() {
        assert!(mandate_enforced(Some("on")));
        assert!(mandate_enforced(Some(" ON \n")));
        assert!(!mandate_enforced(Some("1")));
        assert!(!mandate_enforced(Some("true")));
        assert!(!mandate_enforced(Some("")));
        assert!(!mandate_enforced(None));
    }

    #[test]
    fn mandate_switch_unset_is_unknown() {
        // 없거나 빈 값은 모름 — 꺼짐이 아니다. 값이 있으면 TS 와 같은 낱말 판정.
        assert_eq!(mandate_switch(None), None);
        assert_eq!(mandate_switch(Some("")), None);
        assert_eq!(mandate_switch(Some("  \n")), None);
        assert_eq!(mandate_switch(Some("on")), Some(true));
        assert_eq!(mandate_switch(Some(" ON ")), Some(true));
        assert_eq!(mandate_switch(Some("off")), Some(false));
        assert_eq!(mandate_switch(Some("1")), Some(false));
    }

    #[test]
    fn cause_by_human_on_lease_like_ts() {
        let card = LeaseRow {
            agent_id: "a".into(),
            cause_kind: Some("agent".into()),
            cause_ask_author_id: Some("a".into()),
            ask_answered_by: Some("h".into()),
            ask_answerer_kind: Some("human".into()),
            ask_answerer_owns_agent: Some(true),
            ..LeaseRow::default()
        };
        assert!(card.cause_by_human());
        assert!(
            LeaseRow {
                cause_kind: Some("human".into()),
                ..LeaseRow::default()
            }
            .cause_by_human()
        );
        assert!(
            !LeaseRow {
                ask_answerer_owns_agent: Some(false),
                ..card.clone()
            }
            .cause_by_human()
        );
        assert!(
            !LeaseRow {
                ask_answerer_owns_agent: None,
                ..card.clone()
            }
            .cause_by_human()
        );
        assert!(
            !LeaseRow {
                ask_answered_by: Some(String::new()),
                ..card.clone()
            }
            .cause_by_human()
        );
        assert!(
            !LeaseRow {
                cause_ask_author_id: Some("b".into()),
                ..card.clone()
            }
            .cause_by_human()
        );
        assert!(
            !LeaseRow {
                ask_answerer_kind: Some("agent".into()),
                ..card.clone()
            }
            .cause_by_human()
        );
        assert!(!LeaseRow::default().cause_by_human());
        for k in [
            "\"causeMessageId\"",
            "\"mandateId\"",
            "\"askAnswererOwnsAgent\"",
        ] {
            assert!(
                crate::core::channels::frag("grant_read_lease").contains(k),
                "{k}"
            );
        }
    }
}
