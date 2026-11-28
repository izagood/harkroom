//! 실행 자격 줄(CR1) — 표 `exec_credential`·`agent_exec_credential`·`agent_exec_credential_set`(migration 205).
//!
//! 「자격 줄」 = API 키 연결(`key`) · 구독 풀(`pool`) · 이 기기 로컬(`local`) 중 하나 + 그 자격을 쓸 하네스.
//! 에이전트마다 허용 목록과 기본 하나를 둔다. 조합([`super::exec_combo`])에서 자격을 떼어 내는 첫 단계다.
//!
//! - **기록만 한다.** 턴 길은 여전히 조합·스레드 지정을 읽는다. 이 표를 읽어 자격을 고르는 경로는 없다.
//! - 누가 쓰나(전부 **사람이 직접 선 요청**만 — 에이전트 계정·오퍼레이터 토큰은 읽기도 거절):
//!   - `key` 줄 = 소유자·관리자이면서 **그 키 연결이 가리키는 비밀의 소유자**. 같은 문장에서 본다.
//!   - `pool` 줄 = **그 오퍼레이터의 소유자**. 풀은 (오퍼레이터, 하네스, 이름)으로 묶는다 — 이름만으로 묶으면 같은 이름의
//!     다른 기기 풀로 풀린다. 폐기된 오퍼레이터에는 만들지 못한다.
//!   - `local` 줄 = 마이그레이션이 심은 한 줄뿐. 만들지도 지우지도 못한다.
//!   - 허용 목록·기본 = **그 에이전트의 소유자**(`agent_config.owner_account_id`, 같은 문장에서 본다).
//! - 「설정함」 표지([`ALLOW_MARK_SQL`]): 허용 목록에 처음 넣을 때 서고 다시 내려가지 않는다. 목록이 빈 까닭을 가른다 —
//!   한 번도 설정 안 했으면 로컬, 설정했는데 비었으면(줄이 지워져 cascade 로 빠짐 포함) 막는다([`empty_list`]).
//! - 못 쓰는 줄은 목록에 `usable: false` 로 남는다 — 가리키던 비밀이 지워진 키 줄(`secret_id` null), 폐기된 오퍼레이터의 풀 줄.
//!   목록에서 조용히 빠지지 않는다(빠지면 「비었음」이 로컬로 읽힌다).
//! - 풀 이름·오퍼레이터 id 는 그 오퍼레이터의 소유자와 관리자에게만 나간다. 그 밖의 사람에게는 줄 이름만 보인다.
//! - 켜는 곳은 `main.rs` — 쓰기 풀에 [`EXEC_CREDENTIAL_PRIVILEGES`]·[`EXEC_CREDENTIAL_LOOKUP_PRIVILEGES`] 가 다 있을 때만.
//!   HTTP 길은 [`super::exec_credential_routes`] 다.
use super::exec_combo::{ComboError, can_manage, human, label, uuid};
use crate::auth::{Account, Auth};
use serde_json::Value;
use sqlx::PgPool;

/// 이 기능이 쓰는 표 권한 — homelab GRANT 와 같아야 한다. 코드가 실제로 쓰는 것만 적는다.
pub const EXEC_CREDENTIAL_PRIVILEGES: &[(&str, &str)] = &[
    ("exec_credential", "SELECT"),
    ("exec_credential", "INSERT"),
    ("exec_credential", "DELETE"),
    ("agent_exec_credential", "SELECT"),
    ("agent_exec_credential", "INSERT"),
    ("agent_exec_credential", "UPDATE"),
    ("agent_exec_credential", "DELETE"),
    ("agent_exec_credential_set", "SELECT"),
    ("agent_exec_credential_set", "INSERT"),
];

/// 소유자 판정·감사에 드는 권한 — 세 표 밖의 것. 오퍼레이터는 id·소유자·폐기 칸만 읽는다(토큰 해시는 읽지 않는다).
pub const EXEC_CREDENTIAL_LOOKUP_PRIVILEGES: &[(&str, &str)] = &[
    ("exec_key_link", "SELECT"),
    ("secret.id", "SELECT"),
    ("secret.owner_account_id", "SELECT"),
    ("agent_config.account_id", "SELECT"),
    ("agent_config.owner_account_id", "SELECT"),
    ("operator.id", "SELECT"),
    ("operator.owner_account_id", "SELECT"),
    ("operator.revoked_at", "SELECT"),
    ("audit_log", "INSERT"),
];

/// 키 자격을 쓸 수 있는 하네스 — 에이전트를 만들 때 받는 목록과 같다.
pub const KEY_HARNESSES: &[&str] = &["claude-code", "codex", "opencode", "kilo", "pi", "omp"];

/// 구독 풀이 있는 하네스(1차).
pub const POOL_HARNESSES: &[&str] = &["claude-code", "codex"];

/// 풀 이름 문법 — 기기의 계정 풀 이름과 같다(소문자·숫자·`-`, 32자까지). 이 값은 나중에 러너 env 에 실린다.
pub fn pool_name_ok(s: &str) -> bool {
    !s.is_empty()
        && s.len() <= 32
        && s.bytes()
            .all(|b| b.is_ascii_lowercase() || b.is_ascii_digit() || b == b'-')
}

/// 허용 목록이 비었을 때의 판정.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum EmptyList {
    /// 한 번도 설정하지 않았다 — 이 기기 로컬로 돈다(지금과 같다).
    Local,
    /// 설정한 적이 있는데 비었다 — 막는다. 로컬로 대신 돌지 않는다.
    Blocked,
}

/// 빈 허용 목록을 어떻게 읽나 — 「설정함」 표지가 있으면 막는다.
pub fn empty_list(configured: bool) -> EmptyList {
    if configured {
        EmptyList::Blocked
    } else {
        EmptyList::Local
    }
}

// ---------------------------------------------------------------------------------------------
// 입력
// ---------------------------------------------------------------------------------------------

/// 만들 자격 줄 — `key` 와 `pool` 만 만든다(`local` 은 심어 둔 한 줄뿐).
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum CredentialInput {
    Key {
        name: String,
        key_link_id: String,
        /// 겹침 없이 정렬해 둔다.
        harnesses: Vec<String>,
    },
    Pool {
        name: String,
        operator_id: String,
        harness: String,
        pool_name: String,
    },
}

impl CredentialInput {
    pub fn name(&self) -> &str {
        match self {
            Self::Key { name, .. } | Self::Pool { name, .. } => name,
        }
    }

    pub fn kind(&self) -> &'static str {
        match self {
            Self::Key { .. } => "key",
            Self::Pool { .. } => "pool",
        }
    }

    /// 본문 JSON → 입력. 종류에 안 맞는 칸이 있으면 거절한다(조용히 버리지 않는다).
    pub fn parse(body: &Value) -> Result<Self, ComboError> {
        let s = |k: &'static str| {
            body.get(k)
                .and_then(Value::as_str)
                .ok_or(ComboError::Invalid(k))
        };
        let absent = |keys: &[&'static str]| {
            keys.iter()
                .find(|k| !matches!(body.get(**k), None | Some(Value::Null)))
                .map_or(Ok(()), |k| Err(ComboError::Invalid(k)))
        };
        let name = label(s("name")?, 64).ok_or(ComboError::Invalid("name"))?;
        match s("kind")? {
            "key" => {
                absent(&["operatorId", "harness", "poolName"])?;
                let key_link_id = s("keyLinkId")?;
                uuid(key_link_id, "keyLinkId")?;
                let list = body
                    .get("harnesses")
                    .and_then(Value::as_array)
                    .ok_or(ComboError::Invalid("harnesses"))?;
                let mut harnesses = vec![];
                for h in list {
                    let h = h
                        .as_str()
                        .filter(|h| KEY_HARNESSES.contains(h))
                        .ok_or(ComboError::Invalid("harnesses"))?;
                    harnesses.push(h.to_owned());
                }
                harnesses.sort();
                harnesses.dedup();
                if harnesses.is_empty() {
                    return Err(ComboError::Invalid("harnesses"));
                }
                Ok(Self::Key {
                    name,
                    key_link_id: key_link_id.to_owned(),
                    harnesses,
                })
            }
            "pool" => {
                absent(&["keyLinkId", "harnesses"])?;
                let operator_id = s("operatorId")?;
                uuid(operator_id, "operatorId")?;
                let harness = s("harness")?;
                if !POOL_HARNESSES.contains(&harness) {
                    return Err(ComboError::Invalid("harness"));
                }
                let pool_name = s("poolName")?;
                if !pool_name_ok(pool_name) {
                    return Err(ComboError::Invalid("poolName"));
                }
                Ok(Self::Pool {
                    name,
                    operator_id: operator_id.to_owned(),
                    harness: harness.to_owned(),
                    pool_name: pool_name.to_owned(),
                })
            }
            // `local` 은 만들 수 없다 — 모르는 종류와 같은 답이다.
            _ => Err(ComboError::Invalid("kind")),
        }
    }
}

// ---------------------------------------------------------------------------------------------
// SQL
// ---------------------------------------------------------------------------------------------

/// 자격 줄 JSON. `$1` = 보는 사람, `$2` = 관리자인가. 풀 이름·오퍼레이터 id 는 그 오퍼레이터의 소유자·관리자에게만 싣는다.
/// `usable` — 키 줄은 연결의 비밀이 살아 있을 때, 풀 줄은 오퍼레이터가 폐기되지 않았을 때, 로컬은 언제나.
macro_rules! credential_json {
    () => {
        "json_build_object(\
       'id', c.id, 'name', c.name, 'kind', c.kind, 'harnesses', c.harnesses, \
       'keyLinkId', c.key_link_id, \
       'operatorId', case when $2::boolean or o.owner_account_id = $1::uuid then c.operator_id end, \
       'poolName', case when $2::boolean or o.owner_account_id = $1::uuid then c.pool_name end, \
       'usable', case c.kind \
           when 'key' then k.secret_id is not null \
           when 'pool' then o.id is not null and o.revoked_at is null \
           else true end)"
    };
}

macro_rules! credential_from {
    () => {
        " exec_credential c \
       left join exec_key_link k on k.id = c.key_link_id \
       left join operator o on o.id = c.operator_id "
    };
}

/// 자격 줄 목록(워크스페이스 표 하나).
pub const CREDENTIAL_LIST_SQL: &str = concat!(
    "select coalesce(json_agg(",
    credential_json!(),
    " order by c.kind, c.name), '[]'::json)::text from",
    credential_from!()
);

/// 키 줄 만들기 — 쓰는 사람(`$1`)이 그 키 연결(`$3`)이 가리키는 비밀의 소유자일 때만 들어간다.
/// 연결이 없거나 비밀이 지워진 연결이면 한 줄도 안 들어간다.
pub const KEY_INSERT_SQL: &str = "insert into exec_credential (name, kind, harnesses, key_link_id, created_by) \
     select $2::text, 'key', $4::text[], k.id, $1::uuid \
       from exec_key_link k join secret s on s.id = k.secret_id \
      where k.id = $3::uuid and s.owner_account_id = $1::uuid \
     returning id::text";

/// 풀 줄 만들기 — 쓰는 사람(`$1`)이 그 오퍼레이터(`$3`)의 소유자이고 오퍼레이터가 폐기되지 않았을 때만 들어간다.
pub const POOL_INSERT_SQL: &str = "insert into exec_credential (name, kind, harnesses, operator_id, pool_harness, pool_name, created_by) \
     select $2::text, 'pool', array[$4::text], o.id, $4::text, $5::text, $1::uuid \
       from operator o \
      where o.id = $3::uuid and o.owner_account_id = $1::uuid and o.revoked_at is null \
     returning id::text";

pub const CREDENTIAL_EXISTS_SQL: &str =
    "select exists (select 1 from exec_credential where id = $1::uuid)";

/// 지우기 — `local` 은 못 지운다. 키 줄은 그 비밀의 소유자(비밀이 지워진 줄은 관리자 누구나), 풀 줄은 그 오퍼레이터의
/// 소유자나 관리자(`$3`)가 지운다. 지우면 허용 줄도 같이 빠진다(cascade) — 「설정함」 표지는 남는다.
pub const CREDENTIAL_DELETE_SQL: &str = "delete from exec_credential c \
      where c.id = $2::uuid and ( \
        (c.kind = 'key' and $3::boolean and not exists ( \
           select 1 from exec_key_link k join secret s on s.id = k.secret_id \
            where k.id = c.key_link_id and s.owner_account_id <> $1::uuid)) \
        or (c.kind = 'pool' and ($3::boolean or exists ( \
           select 1 from operator o where o.id = c.operator_id and o.owner_account_id = $1::uuid))))";

/// 쓰는 사람(`$1`)이 그 에이전트(`$2`)의 소유자인가 — 허용 목록을 쓰는 모든 문장이 이 조각을 같이 건다.
macro_rules! owns_agent {
    () => {
        "exists (select 1 from agent_config g \
       where g.account_id = $2::uuid and g.owner_account_id = $1::uuid)"
    };
}

/// 한 에이전트의 허용 목록 — 자격 줄 내용과 `isDefault`. `$3` = 에이전트.
pub const ALLOW_LIST_SQL: &str = concat!(
    "select coalesce(json_agg((",
    credential_json!(),
    ")::jsonb || jsonb_build_object('isDefault', a.is_default) \
                order by a.is_default desc, c.name), '[]'::json)::text \
           from agent_exec_credential a join",
    credential_from!(),
    "on c.id = a.credential_id where a.agent_id = $3::uuid"
);

/// 「설정함」 표지가 있나.
pub const ALLOW_MARKED_SQL: &str =
    "select exists (select 1 from agent_exec_credential_set where agent_id = $1::uuid)";

/// 「설정함」 표지를 세운다(있으면 그대로). 허용 줄을 넣는 문장과 **같은 tx** 다 — 줄만 들어가고 표지가 빠지는 틈이 없다.
pub const ALLOW_MARK_SQL: &str = concat!(
    "insert into agent_exec_credential_set (agent_id, set_by) \
         select $2::uuid, $1::uuid where ",
    owns_agent!(),
    " on conflict (agent_id) do nothing"
);

pub const ALLOW_ADD_SQL: &str = concat!(
    "insert into agent_exec_credential (agent_id, credential_id, added_by) \
         select $2::uuid, c.id, $1::uuid from exec_credential c where c.id = $3::uuid and ",
    owns_agent!(),
    " on conflict (agent_id, credential_id) do update set added_at = agent_exec_credential.added_at \
         returning 1"
);

pub const ALLOW_REMOVE_SQL: &str = concat!(
    "delete from agent_exec_credential where agent_id = $2::uuid and credential_id = $3::uuid and ",
    owns_agent!()
);

/// 기본 정하기 ① — 지금 기본을 내린다. 새 기본(`$3`)이 허용 목록에 있을 때만.
pub const DEFAULT_CLEAR_SQL: &str = concat!(
    "update agent_exec_credential set is_default = false \
          where agent_id = $2::uuid and is_default and credential_id <> $3::uuid and ",
    owns_agent!(),
    " and exists (select 1 from agent_exec_credential t \
                   where t.agent_id = $2::uuid and t.credential_id = $3::uuid)"
);

/// 기본 정하기 ② — 허용 목록에 있는 줄만 기본이 된다.
pub const DEFAULT_SET_SQL: &str = concat!(
    "update agent_exec_credential set is_default = true \
          where agent_id = $2::uuid and credential_id = $3::uuid and ",
    owns_agent!()
);

// ---------------------------------------------------------------------------------------------
// 읽기·쓰기
// ---------------------------------------------------------------------------------------------

fn rows(text: &str) -> Vec<Value> {
    serde_json::from_str(text).unwrap_or_default()
}

/// 자격 줄 목록 — 사람이면 누구나 읽는다(허용 목록을 고르려면 봐야 한다). 풀 이름은 볼 수 있는 사람에게만 실린다.
pub async fn list_credentials(
    pool: &PgPool,
    account: &Account,
    auth: &Auth,
) -> Result<Vec<Value>, ComboError> {
    let viewer = human(account, auth)?;
    let text: String = sqlx::query_scalar(CREDENTIAL_LIST_SQL)
        .bind(viewer)
        .bind(can_manage(account, auth))
        .fetch_one(pool)
        .await?;
    Ok(rows(&text))
}

/// 자격 줄 만들기. 가리키는 키 연결·오퍼레이터가 쓰는 사람 것이 아니면(또는 없으면) `Forbidden` — 둘을 구분해 알려 주지 않는다.
pub async fn create_credential(
    pool: &PgPool,
    account: &Account,
    auth: &Auth,
    input: &CredentialInput,
) -> Result<String, ComboError> {
    let actor = human(account, auth)?;
    let q = match input {
        CredentialInput::Key {
            name,
            key_link_id,
            harnesses,
        } => {
            if !can_manage(account, auth) {
                return Err(ComboError::Forbidden);
            }
            sqlx::query_scalar::<_, String>(KEY_INSERT_SQL)
                .bind(actor)
                .bind(name)
                .bind(key_link_id)
                .bind(harnesses)
        }
        CredentialInput::Pool {
            name,
            operator_id,
            harness,
            pool_name,
        } => sqlx::query_scalar::<_, String>(POOL_INSERT_SQL)
            .bind(actor)
            .bind(name)
            .bind(operator_id)
            .bind(harness)
            .bind(pool_name),
    };
    q.fetch_optional(pool).await?.ok_or(ComboError::Forbidden)
}

/// 자격 줄 지우기. 줄이 없으면 `NotFound`, 있는데 못 지우면(남의 것·`local`) `Forbidden`.
pub async fn delete_credential(
    pool: &PgPool,
    account: &Account,
    auth: &Auth,
    id: &str,
) -> Result<(), ComboError> {
    let actor = human(account, auth)?;
    uuid(id, "id")?;
    let n = sqlx::query(CREDENTIAL_DELETE_SQL)
        .bind(actor)
        .bind(id)
        .bind(can_manage(account, auth))
        .execute(pool)
        .await?
        .rows_affected();
    if n > 0 {
        return Ok(());
    }
    let exists: bool = sqlx::query_scalar(CREDENTIAL_EXISTS_SQL)
        .bind(id)
        .fetch_one(pool)
        .await?;
    Err(if exists {
        ComboError::Forbidden
    } else {
        ComboError::NotFound
    })
}

/// 한 에이전트의 허용 목록과 「설정함」 표지 — 사람만.
pub async fn list_allowed(
    pool: &PgPool,
    account: &Account,
    auth: &Auth,
    agent_id: &str,
) -> Result<(bool, Vec<Value>), ComboError> {
    let viewer = human(account, auth)?;
    uuid(agent_id, "agentId")?;
    let configured: bool = sqlx::query_scalar(ALLOW_MARKED_SQL)
        .bind(agent_id)
        .fetch_one(pool)
        .await?;
    let text: String = sqlx::query_scalar(ALLOW_LIST_SQL)
        .bind(viewer)
        .bind(can_manage(account, auth))
        .bind(agent_id)
        .fetch_one(pool)
        .await?;
    Ok((configured, rows(&text)))
}

fn allow_ids(agent_id: &str, credential_id: &str) -> Result<(), ComboError> {
    uuid(agent_id, "agentId")?;
    uuid(credential_id, "credentialId")
}

/// 허용 목록에 넣기(있으면 그대로) + 「설정함」 표지. 에이전트 소유자가 아니거나 자격 줄이 없으면 `Forbidden`.
pub async fn allow_add(
    pool: &PgPool,
    account: &Account,
    auth: &Auth,
    agent_id: &str,
    credential_id: &str,
) -> Result<(), ComboError> {
    let actor = human(account, auth)?;
    allow_ids(agent_id, credential_id)?;
    let mut tx = pool.begin().await?;
    let hit = sqlx::query_scalar::<_, i32>(ALLOW_ADD_SQL)
        .bind(actor)
        .bind(agent_id)
        .bind(credential_id)
        .fetch_optional(&mut *tx)
        .await?;
    if hit.is_none() {
        return Err(ComboError::Forbidden);
    }
    sqlx::query(ALLOW_MARK_SQL)
        .bind(actor)
        .bind(agent_id)
        .execute(&mut *tx)
        .await?;
    tx.commit().await?;
    Ok(())
}

/// 허용 목록에서 빼기. 없던 줄이거나 소유자가 아니면 `Forbidden`. 표지는 건드리지 않는다 — 다 빼면 막힌 상태가 된다.
pub async fn allow_remove(
    pool: &PgPool,
    account: &Account,
    auth: &Auth,
    agent_id: &str,
    credential_id: &str,
) -> Result<(), ComboError> {
    let actor = human(account, auth)?;
    allow_ids(agent_id, credential_id)?;
    let n = sqlx::query(ALLOW_REMOVE_SQL)
        .bind(actor)
        .bind(agent_id)
        .bind(credential_id)
        .execute(pool)
        .await?
        .rows_affected();
    if n == 0 {
        return Err(ComboError::Forbidden);
    }
    Ok(())
}

/// 기본 자격 정하기 — 허용 목록에 있는 줄만. 두 문장은 한 트랜잭션이다(에이전트당 기본은 많아야 하나).
pub async fn set_default(
    pool: &PgPool,
    account: &Account,
    auth: &Auth,
    agent_id: &str,
    credential_id: &str,
) -> Result<(), ComboError> {
    let actor = human(account, auth)?;
    allow_ids(agent_id, credential_id)?;
    let mut tx = pool.begin().await?;
    sqlx::query(DEFAULT_CLEAR_SQL)
        .bind(actor)
        .bind(agent_id)
        .bind(credential_id)
        .execute(&mut *tx)
        .await?;
    let n = sqlx::query(DEFAULT_SET_SQL)
        .bind(actor)
        .bind(agent_id)
        .bind(credential_id)
        .execute(&mut *tx)
        .await?
        .rows_affected();
    if n == 0 {
        return Err(ComboError::Forbidden);
    }
    tx.commit().await?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    const ID: &str = "00000000-0000-4000-8000-000000000001";

    #[test]
    fn empty_list_is_local_only_when_never_configured() {
        assert_eq!(empty_list(false), EmptyList::Local);
        assert_eq!(empty_list(true), EmptyList::Blocked);
    }

    #[test]
    fn key_input_needs_link_and_known_harnesses() {
        let ok = CredentialInput::parse(&json!({
            "name": " team key ", "kind": "key", "keyLinkId": ID,
            "harnesses": ["codex", "claude-code", "codex"]
        }))
        .unwrap();
        assert_eq!(
            ok,
            CredentialInput::Key {
                name: "team key".into(),
                key_link_id: ID.into(),
                harnesses: vec!["claude-code".into(), "codex".into()],
            }
        );
        for (bad, field) in [
            (
                json!({ "name": "k", "kind": "key", "keyLinkId": "x", "harnesses": ["codex"] }),
                "keyLinkId",
            ),
            (
                json!({ "name": "k", "kind": "key", "keyLinkId": ID }),
                "harnesses",
            ),
            (
                json!({ "name": "k", "kind": "key", "keyLinkId": ID, "harnesses": [] }),
                "harnesses",
            ),
            (
                json!({ "name": "k", "kind": "key", "keyLinkId": ID, "harnesses": ["gemini"] }),
                "harnesses",
            ),
            (
                json!({ "name": "k", "kind": "key", "keyLinkId": ID, "harnesses": [1] }),
                "harnesses",
            ),
            // 종류에 안 맞는 칸은 거절한다.
            (
                json!({ "name": "k", "kind": "key", "keyLinkId": ID, "harnesses": ["codex"], "poolName": "main" }),
                "poolName",
            ),
            (
                json!({ "name": "k", "kind": "key", "keyLinkId": ID, "harnesses": ["codex"], "operatorId": ID }),
                "operatorId",
            ),
            (
                json!({ "name": "", "kind": "key", "keyLinkId": ID, "harnesses": ["codex"] }),
                "name",
            ),
        ] {
            match CredentialInput::parse(&bad) {
                Err(ComboError::Invalid(f)) => assert_eq!(f, field, "{bad}"),
                other => panic!("{bad}: {other:?}"),
            }
        }
    }

    #[test]
    fn pool_input_is_operator_harness_name() {
        let ok = CredentialInput::parse(&json!({
            "name": "mac main", "kind": "pool", "operatorId": ID, "harness": "codex", "poolName": "main-2"
        }))
        .unwrap();
        assert_eq!(
            ok,
            CredentialInput::Pool {
                name: "mac main".into(),
                operator_id: ID.into(),
                harness: "codex".into(),
                pool_name: "main-2".into(),
            }
        );
        for (bad, field) in [
            // 오퍼레이터 없이 이름만으로는 못 만든다.
            (
                json!({ "name": "p", "kind": "pool", "harness": "codex", "poolName": "main" }),
                "operatorId",
            ),
            (
                json!({ "name": "p", "kind": "pool", "operatorId": ID, "poolName": "main" }),
                "harness",
            ),
            // 풀이 없는 하네스.
            (
                json!({ "name": "p", "kind": "pool", "operatorId": ID, "harness": "opencode", "poolName": "main" }),
                "harness",
            ),
            (
                json!({ "name": "p", "kind": "pool", "operatorId": ID, "harness": "../codex", "poolName": "main" }),
                "harness",
            ),
            (
                json!({ "name": "p", "kind": "pool", "operatorId": ID, "harness": "codex", "poolName": "Main" }),
                "poolName",
            ),
            (
                json!({ "name": "p", "kind": "pool", "operatorId": ID, "harness": "codex", "poolName": "a/b" }),
                "poolName",
            ),
            (
                json!({ "name": "p", "kind": "pool", "operatorId": ID, "harness": "codex", "poolName": "" }),
                "poolName",
            ),
            (
                json!({ "name": "p", "kind": "pool", "operatorId": ID, "harness": "codex", "poolName": "main", "keyLinkId": ID }),
                "keyLinkId",
            ),
        ] {
            match CredentialInput::parse(&bad) {
                Err(ComboError::Invalid(f)) => assert_eq!(f, field, "{bad}"),
                other => panic!("{bad}: {other:?}"),
            }
        }
    }

    #[test]
    fn local_and_unknown_kinds_cannot_be_created() {
        for kind in ["local", "none", "", "KEY"] {
            assert!(matches!(
                CredentialInput::parse(&json!({ "name": "x", "kind": kind })),
                Err(ComboError::Invalid("kind"))
            ));
        }
    }

    #[test]
    fn pool_name_grammar() {
        for ok in ["main", "team-2", "a", &"a".repeat(32)] {
            assert!(pool_name_ok(ok), "{ok}");
        }
        for bad in ["", "Main", "a_b", "a b", "a/b", "..", &"a".repeat(33)] {
            assert!(!pool_name_ok(bad), "{bad}");
        }
    }

    /// 쓰는 문장마다 소유자 조건이 같은 문장에 있다 — 검사와 쓰기 사이에 틈이 없다.
    #[test]
    fn writes_carry_their_owner_checks() {
        assert!(KEY_INSERT_SQL.contains("s.owner_account_id = $1::uuid"));
        assert!(POOL_INSERT_SQL.contains("o.owner_account_id = $1::uuid"));
        assert!(POOL_INSERT_SQL.contains("o.revoked_at is null"));
        for sql in [
            ALLOW_ADD_SQL,
            ALLOW_REMOVE_SQL,
            ALLOW_MARK_SQL,
            DEFAULT_CLEAR_SQL,
            DEFAULT_SET_SQL,
        ] {
            assert!(sql.contains("g.owner_account_id = $1::uuid"), "{sql}");
        }
        // `local` 은 지우는 문장의 어느 갈래에도 없다.
        assert!(!CREDENTIAL_DELETE_SQL.contains("'local'"));
    }

    /// 표 권한 목록은 코드가 쓰는 문장과 맞는다 — 안 쓰는 권한(자격 줄 UPDATE·표지 DELETE)을 요구하지 않는다.
    #[test]
    fn privilege_list_matches_statements() {
        let has = |t: &str, p: &str| EXEC_CREDENTIAL_PRIVILEGES.contains(&(t, p));
        assert!(!has("exec_credential", "UPDATE"));
        assert!(!has("agent_exec_credential_set", "DELETE"));
        assert!(!has("agent_exec_credential_set", "UPDATE"));
        assert!(has("agent_exec_credential", "UPDATE"));
        assert!(
            !EXEC_CREDENTIAL_LOOKUP_PRIVILEGES
                .iter()
                .any(|(t, _)| t.starts_with("operator.token") || *t == "operator")
        );
    }
}
