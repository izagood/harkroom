//! 실행 조합(J1·J2a) — 표 `exec_combo`·`agent_exec_combo`·`exec_key_link`(migration 185·202).
//!
//! 「실행 조합」 = 하네스 × 모델 × effort × 자격(구독 계정 풀 이름 **또는** API 키 연결) + 단가 + 「승격 허용」 + 짧은 이름.
//!
//! - **기록만 한다.** 러너·오퍼레이터는 여전히 `agent_config`·스레드별 모델 표를 읽는다. 이 표를 읽어 턴을 띄우는 경로는 없다.
//! - 누가 쓰나:
//!   - 조합·키 연결 = 소유자·관리자인 **사람**([`can_manage`]).
//!   - 에이전트 허용 목록·기본 조합 = **그 에이전트의 소유자인 사람**. 사람인지는 [`is_human`] 이, 소유자인지는 쓰는 SQL 이
//!     같은 문장에서 본다(`agent_config.owner_account_id`) — 검사와 쓰기 사이에 소유자가 바뀌어도 틈이 없다.
//!   - 에이전트 계정·오퍼레이터 토큰으로 선 요청은 전부 거절한다. MCP 도구로는 내놓지 않는다.
//! - 키 연결은 주소(https)와 **비밀 id**(`secret_id`, 202)만 담는다 — 키 값은 여기 없다. 연결을 만들거나 고치는 사람은
//!   **자기 소유 비밀**만 가리킬 수 있다(`secret.owner_account_id`, 같은 문장에서 본다). `secret_name` 은 그때 베낀 표시용
//!   이름이고 판정에는 쓰지 않는다 — 비밀이 지워지면 `secret_id` 가 null 이 되고, 같은 이름의 새 비밀로 다시 이어지지 않는다.
//! - 키 연결은 **그 비밀의 소유자 것**이다. 관리자라도 남의 비밀을 가리키는 연결은 고치지도, 지우지도, 조합에 꽂지도 못한다 —
//!   조합을 만들거나 고칠 때 `key_link_id` 가 있으면 쓰는 사람이 그 연결이 가리키는 비밀의 소유자여야 한다(같은 문장에서 본다).
//! - 켜는 곳은 [`enable`] 하나 — 쓰기 풀에 [`EXEC_COMBO_PRIVILEGES`]·[`EXEC_COMBO_LOOKUP_PRIVILEGES`] 가 다 있을 때만.
//!   HTTP 길은 [`super::exec_combo_routes`] 다(사람만).
use crate::auth::{Account, Auth, Via};
use serde_json::Value;
use sqlx::PgPool;
use std::sync::OnceLock;

/// 이 기능이 쓰는 권한 — homelab GRANT 와 같아야 한다. 없으면 켜지 않는다(나머지는 그대로 돈다).
pub const EXEC_COMBO_PRIVILEGES: &[(&str, &str)] = &[
    ("exec_key_link", "SELECT"),
    ("exec_key_link", "INSERT"),
    ("exec_key_link", "UPDATE"),
    ("exec_key_link", "DELETE"),
    ("exec_combo", "SELECT"),
    ("exec_combo", "INSERT"),
    ("exec_combo", "UPDATE"),
    ("exec_combo", "DELETE"),
    ("agent_exec_combo", "SELECT"),
    ("agent_exec_combo", "INSERT"),
    ("agent_exec_combo", "UPDATE"),
    ("agent_exec_combo", "DELETE"),
];

/// 소유자 판정·감사에 드는 권한 — 세 표 밖의 것. 비밀은 id·이름·소유자 칸만 읽는다(값·판은 읽지 않는다).
pub const EXEC_COMBO_LOOKUP_PRIVILEGES: &[(&str, &str)] = &[
    ("secret.id", "SELECT"),
    ("secret.name", "SELECT"),
    ("secret.owner_account_id", "SELECT"),
    ("agent_config.account_id", "SELECT"),
    ("agent_config.owner_account_id", "SELECT"),
    ("audit_log", "INSERT"),
    // J2b — 조합을 고치거나 허용 목록에서 빼면 그 조합으로 정한 스레드 지정을 같이 맞춘다.
    ("thread_agent_model", "SELECT"),
    ("thread_agent_model", "UPDATE"),
    ("thread_agent_model", "DELETE"),
];

static POOL: OnceLock<PgPool> = OnceLock::new();

/// 켠다(프로세스에 한 번). 두 번째 부름은 무시한다.
pub fn enable(pool: PgPool) {
    let _ = POOL.set(pool);
}

/// 켜졌을 때의 풀. 안 켜졌으면 `None`.
pub fn pool() -> Option<&'static PgPool> {
    POOL.get()
}

// ---------------------------------------------------------------------------------------------
// 권한
// ---------------------------------------------------------------------------------------------

/// 사람이 직접 선 요청인가 — 계정 종류가 `human` 이고 오퍼레이터 토큰으로 서지 않았다.
pub fn is_human(account: &Account, auth: &Auth) -> bool {
    account.kind == "human" && auth.operator.is_none() && auth.via != Some(Via::Operator)
}

/// 조합·키 연결을 만들고 고칠 수 있나 — 소유자·관리자인 사람만.
pub fn can_manage(account: &Account, auth: &Auth) -> bool {
    is_human(account, auth)
        && account.is_admin
        && matches!(account.role.as_str(), "owner" | "admin")
}

#[derive(Debug)]
pub enum ComboError {
    /// 권한 없음 — 사람이 아니거나, 관리자가 아니거나, 그 에이전트·비밀의 소유자가 아니다. 대상이 없는 것과 구분하지 않는다.
    Forbidden,
    /// 입력이 틀렸다(칸 이름).
    Invalid(&'static str),
    NotFound,
    /// 이름 겹침, 또는 조합이 쓰는 키 연결을 지우려 함.
    Conflict,
    Db(sqlx::Error),
}

impl From<sqlx::Error> for ComboError {
    fn from(e: sqlx::Error) -> Self {
        match e.as_database_error().and_then(|d| d.code()).as_deref() {
            // unique_violation · foreign_key_violation
            Some("23505") | Some("23503") => Self::Conflict,
            _ => Self::Db(e),
        }
    }
}

fn manager<'a>(account: &'a Account, auth: &Auth) -> Result<&'a str, ComboError> {
    can_manage(account, auth)
        .then_some(account.id.as_str())
        .ok_or(ComboError::Forbidden)
}

pub(crate) fn human<'a>(account: &'a Account, auth: &Auth) -> Result<&'a str, ComboError> {
    is_human(account, auth)
        .then_some(account.id.as_str())
        .ok_or(ComboError::Forbidden)
}

pub(crate) fn uuid(s: &str, field: &'static str) -> Result<(), ComboError> {
    crate::lists::is_zod_uuid(s)
        .then_some(())
        .ok_or(ComboError::Invalid(field))
}

// ---------------------------------------------------------------------------------------------
// 입력
// ---------------------------------------------------------------------------------------------

/// 앞뒤 공백을 뗀 한 줄 글 — 비거나 `max` 자를 넘거나 제어 문자가 있으면 `None`.
pub(crate) fn label(s: &str, max: usize) -> Option<String> {
    let t = s.trim();
    (!t.is_empty() && t.chars().count() <= max && !t.chars().any(char::is_control))
        .then(|| t.to_owned())
}

/// 키 연결 주소 — https 만, 사용자 정보·질의·조각 없음, 경로는 받는다. api connector 의 주소 검증을 그대로 쓴다.
pub fn base_url_ok(s: &str) -> Option<String> {
    super::connectors_upsert::normalize_token_url(s)
}

/// 조합의 자격 — 둘 중 정확히 하나.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Credential {
    /// 구독 계정 풀 이름.
    Pool(String),
    /// API 키 연결 id.
    KeyLink(String),
}

#[derive(Debug, Clone, PartialEq)]
pub struct ComboInput {
    pub name: String,
    pub harness: String,
    pub model: String,
    pub effort: Option<String>,
    pub credential: Credential,
    /// 백만 토큰당 USD(어림 비용용).
    pub input_price: f64,
    pub output_price: f64,
    pub promote_allowed: bool,
}

fn price(v: Option<&Value>, field: &'static str) -> Result<f64, ComboError> {
    match v {
        None | Some(Value::Null) => Ok(0.0),
        Some(v) => v
            .as_f64()
            .filter(|p| p.is_finite() && (0.0..=1_000_000.0).contains(p))
            .ok_or(ComboError::Invalid(field)),
    }
}

impl ComboInput {
    /// 본문 JSON → 입력. 자격은 `accountPool` 과 `keyLinkId` 중 정확히 하나여야 한다.
    pub fn parse(body: &Value) -> Result<Self, ComboError> {
        let text = |k: &'static str, max| {
            body.get(k)
                .and_then(Value::as_str)
                .and_then(|s| label(s, max))
                .ok_or(ComboError::Invalid(k))
        };
        let opt = |k: &'static str, max| match body.get(k) {
            None | Some(Value::Null) => Ok(None),
            Some(v) => v
                .as_str()
                .and_then(|s| label(s, max))
                .map(Some)
                .ok_or(ComboError::Invalid(k)),
        };
        let credential = match (opt("accountPool", 64)?, opt("keyLinkId", 64)?) {
            (Some(p), None) => Credential::Pool(p),
            (None, Some(k)) => {
                uuid(&k, "keyLinkId")?;
                Credential::KeyLink(k)
            }
            _ => return Err(ComboError::Invalid("credential")),
        };
        let promote_allowed = match body.get("promoteAllowed") {
            None | Some(Value::Null) => false,
            Some(Value::Bool(b)) => *b,
            Some(_) => return Err(ComboError::Invalid("promoteAllowed")),
        };
        // model·effort 는 스레드 줄로 베껴져 러너가 하네스 인자로 넘긴다 — 스레드 모델과 같은 값 규칙을 만들 때부터 건다.
        let axis = |k: &'static str, v: Option<String>| {
            if super::thread_model_set::axis_valid(v.as_deref()) {
                Ok(v)
            } else {
                Err(ComboError::Invalid(k))
            }
        };
        let model =
            axis("model", Some(text("model", 128)?))?.ok_or(ComboError::Invalid("model"))?;
        let effort = axis("effort", opt("effort", 32)?)?;
        Ok(Self {
            name: text("name", 64)?,
            harness: text("harness", 64)?,
            model,
            effort,
            credential,
            input_price: price(body.get("inputPrice"), "inputPrice")?,
            output_price: price(body.get("outputPrice"), "outputPrice")?,
            promote_allowed,
        })
    }

    fn pool_and_link(&self) -> (Option<&str>, Option<&str>) {
        match &self.credential {
            Credential::Pool(p) => (Some(p), None),
            Credential::KeyLink(k) => (None, Some(k)),
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct KeyLinkInput {
    pub name: String,
    pub base_url: String,
    /// 가리킬 비밀의 id — 이름으로는 받지 않는다.
    pub secret_id: String,
}

impl KeyLinkInput {
    pub fn parse(body: &Value) -> Result<Self, ComboError> {
        let s = |k: &'static str| {
            body.get(k)
                .and_then(Value::as_str)
                .ok_or(ComboError::Invalid(k))
        };
        let secret_id = s("secretId")?;
        uuid(secret_id, "secretId")?;
        Ok(Self {
            name: label(s("name")?, 64).ok_or(ComboError::Invalid("name"))?,
            base_url: base_url_ok(s("baseUrl")?).ok_or(ComboError::Invalid("baseUrl"))?,
            secret_id: secret_id.to_owned(),
        })
    }
}

// ---------------------------------------------------------------------------------------------
// SQL
// ---------------------------------------------------------------------------------------------

/// 키 연결 목록. 비밀은 id 와 이름만 나간다 — 이름은 지금 이름이고, 비밀이 지워졌으면(`secretId` null) 베껴 둔 옛 이름이다.
pub const KEY_LINK_LIST_SQL: &str = concat!(
    "select coalesce(json_agg(json_build_object(\
       'id', k.id, 'name', k.name, 'baseUrl', k.base_url, 'secretId', k.secret_id, \
       'secretName', coalesce(s.name, k.secret_name), \
       'createdBy', k.created_by, 'createdAt', ",
    crate::iso!("k.created_at"),
    ") order by k.name), '[]'::json)::text \
       from exec_key_link k left join secret s on s.id = k.secret_id"
);

/// 쓰는 사람(`$1`)이 그 비밀(`$4`, id)의 소유자일 때만 들어간다 — 남의 비밀을 꽂지 못한다. 이름은 그 줄에서 베낀다.
pub const KEY_LINK_INSERT_SQL: &str = "insert into exec_key_link (name, base_url, secret_id, secret_name, created_by) \
     select $2, $3, s.id, s.name, $1::uuid \
       from secret s where s.id = $4::uuid and s.owner_account_id = $1::uuid \
     returning id::text";

/// 고칠 때는 소유자 검사가 둘이다 — 고치는 사람이 **지금 가리키는 비밀**(`cur`)과 **새로 가리킬 비밀**(`s`) 둘 다의 소유자여야 한다.
/// 앞의 것이 없으면 남의 연결을 자기 비밀·자기 주소로 돌려 꽂을 수 있다.
/// 가리키던 비밀이 지워진 연결(`secret_id` null)은 `cur` 가 없어 아무도 고치지 못한다 — 지우고 새로 만든다.
pub const KEY_LINK_UPDATE_SQL: &str = "update exec_key_link k \
        set name = $3, base_url = $4, secret_id = s.id, secret_name = s.name, updated_at = now() \
       from secret s \
      where k.id = $2::uuid \
        and s.id = $5::uuid and s.owner_account_id = $1::uuid \
        and exists (select 1 from secret cur where cur.id = k.secret_id and cur.owner_account_id = $1::uuid) \
     returning k.id::text";

pub const KEY_LINK_EXISTS_SQL: &str =
    "select exists (select 1 from exec_key_link where id = $1::uuid)";

/// 지우는 사람(`$1`)이 그 연결이 가리키는 비밀의 소유자일 때만 지운다. 가리키던 비밀이 이미 지워진 연결(주인 없는 줄)은
/// 관리자 누구나 치울 수 있다 — 남의 비밀이 **있는** 연결만 막는다.
pub const KEY_LINK_DELETE_SQL: &str = "delete from exec_key_link k \
      where k.id = $2::uuid \
        and not exists (select 1 from secret s where s.id = k.secret_id and s.owner_account_id <> $1::uuid)";

macro_rules! combo_json {
    () => {
        "json_build_object(\
       'id', c.id, 'name', c.name, 'harness', c.harness, 'model', c.model, 'effort', c.effort, \
       'accountPool', c.account_pool, 'keyLinkId', c.key_link_id, \
       'inputPrice', c.input_price, 'outputPrice', c.output_price, 'promoteAllowed', c.promote_allowed)"
    };
}

/// 쓰는 사람(`$1`)이 그 에이전트(`$2`)의 소유자인가 — 허용 목록을 쓰는 모든 문장이 이 조각을 같이 건다.
macro_rules! owns_agent {
    () => {
        "exists (select 1 from agent_config g \
       where g.account_id = $2::uuid and g.owner_account_id = $1::uuid)"
    };
}

/// 쓰는 사람이 그 키 연결이 가리키는 비밀의 소유자인가 — 조합에 키 연결을 꽂는 모든 문장이 이 조각을 같이 건다.
/// 연결이 없거나 비밀이 없어도 거짓이다.
macro_rules! owns_key_link {
    ($link:literal, $actor:literal) => {
        concat!(
            "exists (select 1 from exec_key_link k join secret s on s.id = k.secret_id \
       where k.id = ",
            $link,
            "::uuid and s.owner_account_id = ",
            $actor,
            "::uuid)"
        )
    };
}

/// 조합 목록(워크스페이스 표 하나).
pub const COMBO_LIST_SQL: &str = concat!(
    "select coalesce(json_agg(",
    combo_json!(),
    " order by c.name), '[]'::json)::text from exec_combo c"
);

/// 키 연결(`$6`)을 꽂으면 쓰는 사람(`$10`)이 그 연결의 비밀 소유자일 때만 들어간다 — 남의 API 키를 조합에 싣지 못한다.
pub const COMBO_INSERT_SQL: &str = concat!(
    "insert into exec_combo \
       (name, harness, model, effort, account_pool, key_link_id, input_price, output_price, promote_allowed, created_by) \
     select $1::text, $2::text, $3::text, $4::text, $5::text, $6::uuid, $7::float8, $8::float8, $9::boolean, $10::uuid \
      where $6::uuid is null or ",
    owns_key_link!("$6", "$10"),
    " returning id::text"
);

/// 고칠 때도 같다 — 고친 뒤의 조합이 키 연결(`$6`)을 가리키면 고치는 사람(`$11`)이 그 비밀의 소유자여야 한다.
/// 연결을 안 바꾸고 다른 칸만 고쳐도 본다(남의 키를 쓰는 조합의 모델·하네스를 바꾸지 못한다).
pub const COMBO_UPDATE_SQL: &str = concat!(
    "update exec_combo \
        set name = $1, harness = $2, model = $3, effort = $4, account_pool = $5, key_link_id = $6::uuid, \
            input_price = $7, output_price = $8, promote_allowed = $9, updated_at = now() \
      where id = $10::uuid and ($6::uuid is null or ",
    owns_key_link!("$6", "$11"),
    ")"
);

/// J2b — 고친 조합으로 정한 스레드 지정(`thread_agent_model.combo_id`)을 맞춘다: 하네스가 달라진 줄은 지우고(①),
/// 남은 줄은 model·effort 를 새 값으로(②). 낡은 모델이 스레드에 남지 않는다.
///
/// 조합을 고친 문장과 **같은 tx 의 뒤 문장**이어야 한다 — 한 문장(CTE)으로 묶으면 그 문장의 스냅숏이 조합 줄 잠금을
/// 기다리기 전에 잡혀, 기다리는 사이 커밋된 고르기([`super::agent_model_picks::COMBO_ALLOWED_SQL`] 가 조합 줄을
/// `for share` 로 잡는다)를 못 본다.
pub const COMBO_THREADS_DROP_SQL: &str = "delete from thread_agent_model t using exec_combo c \
      where c.id = $1::uuid and t.combo_id = c.id and t.harness is distinct from c.harness";
pub const COMBO_THREADS_SYNC_SQL: &str = "update thread_agent_model t set model = c.model, effort = c.effort \
       from exec_combo c \
      where c.id = $1::uuid and t.combo_id = c.id \
        and (t.model is distinct from c.model or t.effort is distinct from c.effort)";

pub const COMBO_EXISTS_SQL: &str = "select exists (select 1 from exec_combo where id = $1::uuid)";

pub const COMBO_DELETE_SQL: &str = "delete from exec_combo where id = $1::uuid";

/// 한 에이전트의 허용 목록 — 조합 내용과 `isDefault`.
pub const ALLOW_LIST_SQL: &str = concat!(
    "select coalesce(json_agg((",
    combo_json!(),
    ")::jsonb || jsonb_build_object('isDefault', a.is_default) \
                order by a.is_default desc, c.name), '[]'::json)::text \
           from agent_exec_combo a join exec_combo c on c.id = a.combo_id \
          where a.agent_id = $1::uuid"
);

pub const ALLOW_ADD_SQL: &str = concat!(
    "insert into agent_exec_combo (agent_id, combo_id, added_by) \
         select $2::uuid, c.id, $1::uuid from exec_combo c where c.id = $3::uuid and ",
    owns_agent!(),
    " on conflict (agent_id, combo_id) do update set added_at = agent_exec_combo.added_at \
         returning 1"
);

pub const ALLOW_REMOVE_SQL: &str = concat!(
    "delete from agent_exec_combo where agent_id = $2::uuid and combo_id = $3::uuid and ",
    owns_agent!()
);

/// J2b — 뺀 조합으로 그 에이전트에 정해 둔 스레드 지정을 지운다. 허용 줄을 지운 문장과 **같은 tx 의 뒤 문장**이다
/// (까닭은 [`COMBO_THREADS_DROP_SQL`] 과 같다 — 고르기가 허용 줄을 `for share` 로 잡는다).
pub const ALLOW_REMOVE_THREADS_SQL: &str =
    "delete from thread_agent_model where agent_id = $1::uuid and combo_id = $2::uuid";

/// 기본 조합 정하기 ① — 지금 기본을 내린다. 새 기본(`$3`)이 허용 목록에 있을 때만.
pub const DEFAULT_CLEAR_SQL: &str = concat!(
    "update agent_exec_combo set is_default = false \
          where agent_id = $2::uuid and is_default and combo_id <> $3::uuid and ",
    owns_agent!(),
    " and exists (select 1 from agent_exec_combo t where t.agent_id = $2::uuid and t.combo_id = $3::uuid)"
);

/// 기본 조합 정하기 ② — 허용 목록에 있는 줄만 기본이 된다.
pub const DEFAULT_SET_SQL: &str = concat!(
    "update agent_exec_combo set is_default = true \
          where agent_id = $2::uuid and combo_id = $3::uuid and ",
    owns_agent!()
);

// ---------------------------------------------------------------------------------------------
// 읽기·쓰기
// ---------------------------------------------------------------------------------------------

async fn json_rows(
    pool: &PgPool,
    sql: &'static str,
    arg: Option<&str>,
) -> Result<Vec<Value>, ComboError> {
    let q = sqlx::query_scalar::<_, String>(sql);
    let text = match arg {
        Some(a) => q.bind(a).fetch_one(pool).await?,
        None => q.fetch_one(pool).await?,
    };
    Ok(serde_json::from_str(&text).unwrap_or_default())
}

/// 조합 목록 — 사람이면 누구나 읽는다(허용 목록을 고르려면 봐야 한다).
pub async fn list_combos(
    pool: &PgPool,
    account: &Account,
    auth: &Auth,
) -> Result<Vec<Value>, ComboError> {
    human(account, auth)?;
    json_rows(pool, COMBO_LIST_SQL, None).await
}

/// 키 연결 목록 — 관리자만.
pub async fn list_key_links(
    pool: &PgPool,
    account: &Account,
    auth: &Auth,
) -> Result<Vec<Value>, ComboError> {
    manager(account, auth)?;
    json_rows(pool, KEY_LINK_LIST_SQL, None).await
}

/// 한 에이전트의 허용 목록 — 사람만.
pub async fn list_allowed(
    pool: &PgPool,
    account: &Account,
    auth: &Auth,
    agent_id: &str,
) -> Result<Vec<Value>, ComboError> {
    human(account, auth)?;
    uuid(agent_id, "agentId")?;
    json_rows(pool, ALLOW_LIST_SQL, Some(agent_id)).await
}

/// 키 연결 만들기. 가리키는 비밀이 쓰는 사람 소유가 아니면(또는 없으면) `Forbidden` — 둘을 구분해 알려 주지 않는다.
pub async fn create_key_link(
    pool: &PgPool,
    account: &Account,
    auth: &Auth,
    input: &KeyLinkInput,
) -> Result<String, ComboError> {
    let actor = manager(account, auth)?;
    sqlx::query_scalar::<_, String>(KEY_LINK_INSERT_SQL)
        .bind(actor)
        .bind(&input.name)
        .bind(&input.base_url)
        .bind(&input.secret_id)
        .fetch_optional(pool)
        .await?
        .ok_or(ComboError::Forbidden)
}

pub async fn update_key_link(
    pool: &PgPool,
    account: &Account,
    auth: &Auth,
    id: &str,
    input: &KeyLinkInput,
) -> Result<(), ComboError> {
    let actor = manager(account, auth)?;
    uuid(id, "id")?;
    let hit = sqlx::query_scalar::<_, String>(KEY_LINK_UPDATE_SQL)
        .bind(actor)
        .bind(id)
        .bind(&input.name)
        .bind(&input.base_url)
        .bind(&input.secret_id)
        .fetch_optional(pool)
        .await?;
    if hit.is_some() {
        return Ok(());
    }
    Err(missing_or_forbidden(pool, KEY_LINK_EXISTS_SQL, id).await?)
}

/// 키 연결 지우기. 조합이 쓰고 있으면 `Conflict`, 남의 비밀을 가리키는 연결이면 `Forbidden`.
pub async fn delete_key_link(
    pool: &PgPool,
    account: &Account,
    auth: &Auth,
    id: &str,
) -> Result<(), ComboError> {
    let actor = manager(account, auth)?;
    uuid(id, "id")?;
    let n = sqlx::query(KEY_LINK_DELETE_SQL)
        .bind(actor)
        .bind(id)
        .execute(pool)
        .await?
        .rows_affected();
    if n > 0 {
        return Ok(());
    }
    Err(missing_or_forbidden(pool, KEY_LINK_EXISTS_SQL, id).await?)
}

/// 쓰기가 한 줄도 못 건드렸을 때 — 줄이 있으면 소유자 조건에 걸린 것(`Forbidden`), 없으면 `NotFound`.
async fn missing_or_forbidden(
    pool: &PgPool,
    exists_sql: &'static str,
    id: &str,
) -> Result<ComboError, ComboError> {
    let exists: bool = sqlx::query_scalar(exists_sql)
        .bind(id)
        .fetch_one(pool)
        .await?;
    Ok(if exists {
        ComboError::Forbidden
    } else {
        ComboError::NotFound
    })
}

async fn affected<'q>(
    q: sqlx::query::Query<'q, sqlx::Postgres, sqlx::postgres::PgArguments>,
    pool: &PgPool,
) -> Result<(), ComboError> {
    match q.execute(pool).await?.rows_affected() {
        0 => Err(ComboError::NotFound),
        _ => Ok(()),
    }
}

/// 조합 만들기. 키 연결을 꽂는데 그 비밀의 소유자가 아니면(또는 그 연결이 없으면) `Forbidden` — 둘을 구분해 알려 주지 않는다.
pub async fn create_combo(
    pool: &PgPool,
    account: &Account,
    auth: &Auth,
    input: &ComboInput,
) -> Result<String, ComboError> {
    let actor = manager(account, auth)?;
    let (acct_pool, link) = input.pool_and_link();
    sqlx::query_scalar::<_, String>(COMBO_INSERT_SQL)
        .bind(&input.name)
        .bind(&input.harness)
        .bind(&input.model)
        .bind(input.effort.as_deref())
        .bind(acct_pool)
        .bind(link)
        .bind(input.input_price)
        .bind(input.output_price)
        .bind(input.promote_allowed)
        .bind(actor)
        .fetch_optional(pool)
        .await?
        .ok_or(ComboError::Forbidden)
}

/// 조합 고치기. 고친 뒤의 조합이 가리키는 키 연결의 비밀 소유자가 아니면 `Forbidden`.
pub async fn update_combo(
    pool: &PgPool,
    account: &Account,
    auth: &Auth,
    id: &str,
    input: &ComboInput,
) -> Result<(), ComboError> {
    let actor = manager(account, auth)?;
    uuid(id, "id")?;
    let (acct_pool, link) = input.pool_and_link();
    let mut tx = pool.begin().await?;
    let n = sqlx::query(COMBO_UPDATE_SQL)
        .bind(&input.name)
        .bind(&input.harness)
        .bind(&input.model)
        .bind(input.effort.as_deref())
        .bind(acct_pool)
        .bind(link)
        .bind(input.input_price)
        .bind(input.output_price)
        .bind(input.promote_allowed)
        .bind(id)
        .bind(actor)
        .execute(&mut *tx)
        .await?
        .rows_affected();
    if n > 0 {
        for sql in [COMBO_THREADS_DROP_SQL, COMBO_THREADS_SYNC_SQL] {
            sqlx::query(sql).bind(id).execute(&mut *tx).await?;
        }
        tx.commit().await?;
        return Ok(());
    }
    drop(tx);
    Err(missing_or_forbidden(pool, COMBO_EXISTS_SQL, id).await?)
}

/// 조합 지우기 — 그 조합을 가리키던 허용 줄도 같이 지워진다(cascade).
pub async fn delete_combo(
    pool: &PgPool,
    account: &Account,
    auth: &Auth,
    id: &str,
) -> Result<(), ComboError> {
    manager(account, auth)?;
    uuid(id, "id")?;
    affected(sqlx::query(COMBO_DELETE_SQL).bind(id), pool).await
}

fn allow_ids(agent_id: &str, combo_id: &str) -> Result<(), ComboError> {
    uuid(agent_id, "agentId")?;
    uuid(combo_id, "comboId")
}

/// 허용 목록에 넣기(있으면 그대로). 에이전트 소유자가 아니거나 조합이 없으면 `Forbidden`.
pub async fn allow_add(
    pool: &PgPool,
    account: &Account,
    auth: &Auth,
    agent_id: &str,
    combo_id: &str,
) -> Result<(), ComboError> {
    let actor = human(account, auth)?;
    allow_ids(agent_id, combo_id)?;
    sqlx::query_scalar::<_, i32>(ALLOW_ADD_SQL)
        .bind(actor)
        .bind(agent_id)
        .bind(combo_id)
        .fetch_optional(pool)
        .await?
        .map(|_| ())
        .ok_or(ComboError::Forbidden)
}

/// 허용 목록에서 빼기. 없던 줄이거나 소유자가 아니면 `Forbidden`.
pub async fn allow_remove(
    pool: &PgPool,
    account: &Account,
    auth: &Auth,
    agent_id: &str,
    combo_id: &str,
) -> Result<(), ComboError> {
    let actor = human(account, auth)?;
    allow_ids(agent_id, combo_id)?;
    let mut tx = pool.begin().await?;
    let n = sqlx::query(ALLOW_REMOVE_SQL)
        .bind(actor)
        .bind(agent_id)
        .bind(combo_id)
        .execute(&mut *tx)
        .await?
        .rows_affected();
    if n == 0 {
        return Err(ComboError::Forbidden);
    }
    sqlx::query(ALLOW_REMOVE_THREADS_SQL)
        .bind(agent_id)
        .bind(combo_id)
        .execute(&mut *tx)
        .await?;
    tx.commit().await?;
    Ok(())
}

/// 기본 조합 정하기 — 허용 목록에 있는 조합만. 두 문장은 한 트랜잭션이다(에이전트당 기본은 많아야 하나).
pub async fn set_default(
    pool: &PgPool,
    account: &Account,
    auth: &Auth,
    agent_id: &str,
    combo_id: &str,
) -> Result<(), ComboError> {
    let actor = human(account, auth)?;
    allow_ids(agent_id, combo_id)?;
    let mut tx = pool.begin().await?;
    sqlx::query(DEFAULT_CLEAR_SQL)
        .bind(actor)
        .bind(agent_id)
        .bind(combo_id)
        .execute(&mut *tx)
        .await?;
    let n = sqlx::query(DEFAULT_SET_SQL)
        .bind(actor)
        .bind(agent_id)
        .bind(combo_id)
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

    fn account(kind: &str, role: &str) -> Account {
        Account {
            id: "00000000-0000-4000-8000-000000000001".into(),
            handle: "h".into(),
            display_name: "H".into(),
            kind: kind.into(),
            is_admin: matches!(role, "owner" | "admin"),
            role: role.into(),
            status: "active".into(),
            status_text: None,
            avatar_attachment_id: None,
        }
    }

    fn via(v: Via) -> Auth {
        Auth {
            via: Some(v),
            ..Auth::default()
        }
    }

    fn lazy_pool() -> PgPool {
        sqlx::postgres::PgPoolOptions::new()
            .connect_lazy("postgres://u@127.0.0.1:1/none")
            .expect("lazy pool")
    }

    #[test]
    fn only_human_owner_or_admin_manages() {
        for v in [Via::Session, Via::Pat] {
            assert!(can_manage(&account("human", "owner"), &via(v)));
            assert!(can_manage(&account("human", "admin"), &via(v)));
            assert!(!can_manage(&account("human", "member"), &via(v)));
            assert!(!can_manage(&account("human", "guest"), &via(v)));
            // 에이전트 계정은 역할이 무엇이든 못 쓴다.
            assert!(!can_manage(&account("agent", "admin"), &via(v)));
            assert!(!is_human(&account("agent", "member"), &via(v)));
        }
        // 오퍼레이터 토큰으로 선 요청은 계정이 사람이어도 거절한다.
        assert!(!can_manage(&account("human", "owner"), &via(Via::Operator)));
        let with_operator = Auth {
            operator: Some(crate::auth::Operator {
                id: "o".into(),
                owner_account_id: "a".into(),
                name: "n".into(),
            }),
            via: Some(Via::Pat),
            ..Auth::default()
        };
        assert!(!is_human(&account("human", "owner"), &with_operator));
        // is_admin 과 role 이 어긋난 줄은 관리자로 치지 않는다.
        let mut odd = account("human", "member");
        odd.is_admin = true;
        assert!(!can_manage(&odd, &via(Via::Session)));
    }

    /// 권한 거절은 DB 에 닿기 전에 난다 — 닿았다면 연결 실패(`Db`)가 났을 것이다.
    #[tokio::test]
    async fn writes_refuse_before_touching_the_db() {
        let pool = lazy_pool();
        let id = "00000000-0000-4000-8000-000000000002";
        let combo = ComboInput::parse(
            &json!({"name": "a", "harness": "claude-code", "model": "m", "accountPool": "main"}),
        )
        .unwrap();
        let link = KeyLinkInput::parse(
            &json!({"name": "k", "baseUrl": "https://api.example.com/v1", "secretId": id}),
        )
        .unwrap();
        let forbidden = |r: Result<(), ComboError>| matches!(r, Err(ComboError::Forbidden));
        // 에이전트 계정(관리자 역할이어도)·일반 사람 → 조합·키 연결 전부 거절.
        for (acct, auth) in [
            (account("agent", "admin"), via(Via::Pat)),
            (account("human", "member"), via(Via::Session)),
            (account("human", "owner"), via(Via::Operator)),
        ] {
            assert!(forbidden(
                create_combo(&pool, &acct, &auth, &combo).await.map(drop)
            ));
            assert!(forbidden(
                update_combo(&pool, &acct, &auth, id, &combo).await
            ));
            assert!(forbidden(delete_combo(&pool, &acct, &auth, id).await));
            assert!(forbidden(
                create_key_link(&pool, &acct, &auth, &link).await.map(drop)
            ));
            assert!(forbidden(
                update_key_link(&pool, &acct, &auth, id, &link).await
            ));
            assert!(forbidden(delete_key_link(&pool, &acct, &auth, id).await));
            assert!(forbidden(
                list_key_links(&pool, &acct, &auth).await.map(drop)
            ));
        }
        // 에이전트 계정·오퍼레이터 토큰 → 허용 목록·기본·읽기도 거절.
        for (acct, auth) in [
            (account("agent", "member"), via(Via::Pat)),
            (account("human", "admin"), via(Via::Operator)),
        ] {
            assert!(forbidden(allow_add(&pool, &acct, &auth, id, id).await));
            assert!(forbidden(allow_remove(&pool, &acct, &auth, id, id).await));
            assert!(forbidden(set_default(&pool, &acct, &auth, id, id).await));
            assert!(forbidden(list_combos(&pool, &acct, &auth).await.map(drop)));
            assert!(forbidden(
                list_allowed(&pool, &acct, &auth, id).await.map(drop)
            ));
        }
        // 사람이어도 id 꼴이 틀리면 DB 전에 400.
        let human = account("human", "member");
        assert!(matches!(
            allow_add(&pool, &human, &via(Via::Session), "x", id).await,
            Err(ComboError::Invalid("agentId"))
        ));
    }

    #[test]
    fn allow_writes_all_carry_the_owner_check() {
        // 허용 목록을 쓰는 문장은 전부 「쓰는 사람이 그 에이전트의 소유자」 조각을 건다 — 관리자라도 남의 에이전트는 못 고친다.
        for sql in [
            ALLOW_ADD_SQL,
            ALLOW_REMOVE_SQL,
            DEFAULT_CLEAR_SQL,
            DEFAULT_SET_SQL,
        ] {
            assert!(sql.contains("g.owner_account_id = $1::uuid"), "{sql}");
            assert!(sql.contains("g.account_id = $2::uuid"), "{sql}");
        }
        // 기본은 허용 목록에 이미 있는 줄만 — 넣는 문장이 아니다.
        assert!(DEFAULT_SET_SQL.starts_with("update agent_exec_combo"));
    }

    #[test]
    fn key_link_writes_require_owning_the_secret() {
        for sql in [KEY_LINK_INSERT_SQL, KEY_LINK_UPDATE_SQL] {
            assert!(sql.contains("s.owner_account_id = $1::uuid"), "{sql}");
        }
        // 고치기·지우기는 **지금 가리키는 비밀**의 소유자도 본다 — 남의 연결을 돌려 꽂거나 지우지 못한다.
        assert!(
            KEY_LINK_UPDATE_SQL
                .contains("cur.id = k.secret_id and cur.owner_account_id = $1::uuid")
        );
        assert!(
            KEY_LINK_DELETE_SQL.contains("s.id = k.secret_id and s.owner_account_id <> $1::uuid")
        );
    }

    #[test]
    fn combo_writes_require_owning_the_linked_secret() {
        // 조합에 키 연결을 꽂는 두 문장은 「쓰는 사람이 그 연결의 비밀 소유자」 조각을 같은 문장에 건다.
        for (sql, actor) in [(COMBO_INSERT_SQL, "$10"), (COMBO_UPDATE_SQL, "$11")] {
            assert!(sql.contains("$6::uuid is null or exists"), "{sql}");
            assert!(sql.contains("join secret s on s.id = k.secret_id"), "{sql}");
            assert!(sql.contains("k.id = $6::uuid"), "{sql}");
            assert!(
                sql.contains(&format!("s.owner_account_id = {actor}::uuid")),
                "{sql}"
            );
        }
        // 키 연결 표에는 값 칸이 없다 — 목록도 이름만 내보낸다.
        for sql in [KEY_LINK_LIST_SQL, KEY_LINK_INSERT_SQL, KEY_LINK_UPDATE_SQL] {
            assert!(!sql.contains("sealed") && !sql.contains("secret_version"));
        }
        // 비밀은 **id 로만** 찾는다 — 이름으로 비밀을 고르는 문장이 없다(이름은 베끼기만 한다).
        for sql in [
            KEY_LINK_INSERT_SQL,
            KEY_LINK_UPDATE_SQL,
            KEY_LINK_DELETE_SQL,
            COMBO_INSERT_SQL,
            COMBO_UPDATE_SQL,
        ] {
            assert!(!sql.contains(".name = "), "{sql}");
        }
    }

    #[test]
    fn key_link_input_checks_url_and_secret_id() {
        let sid = "00000000-0000-4000-8000-000000000009";
        let ok = |url: &str, secret: &str| {
            KeyLinkInput::parse(&json!({"name": " k ", "baseUrl": url, "secretId": secret}))
        };
        let v = ok("https://api.example.com/v1", sid).unwrap();
        assert_eq!(v.name, "k");
        assert_eq!(v.base_url, "https://api.example.com/v1");
        assert_eq!(v.secret_id, sid);
        for bad in [
            "http://api.example.com/v1",
            "https://user:pw@api.example.com",
            "https://api.example.com/v1?key=1",
            "https://api.example.com/a/../b",
            "ftp://api.example.com",
            "api.example.com",
            "",
        ] {
            assert!(
                matches!(ok(bad, sid), Err(ComboError::Invalid("baseUrl"))),
                "{bad}"
            );
        }
        // 비밀은 id 로만 받는다 — 이름을 넣으면 거절한다.
        for bad in ["", "openai-key", "not-a-uuid"] {
            assert!(
                matches!(
                    ok("https://api.example.com", bad),
                    Err(ComboError::Invalid("secretId"))
                ),
                "{bad}"
            );
        }
        assert!(matches!(
            KeyLinkInput::parse(
                &json!({"name": "k", "baseUrl": "https://api.example.com", "secretName": "key"})
            ),
            Err(ComboError::Invalid("secretId"))
        ));
    }

    #[test]
    fn combo_input_takes_exactly_one_credential() {
        let base =
            json!({"name": "빠른 조합", "harness": "claude-code", "model": "m", "effort": "high"});
        let with = |extra: Value| {
            let mut b = base.clone();
            b.as_object_mut()
                .unwrap()
                .extend(extra.as_object().unwrap().clone());
            ComboInput::parse(&b)
        };
        let link = "00000000-0000-4000-8000-000000000003";
        let p = with(json!({"accountPool": "main", "inputPrice": 3, "outputPrice": 15.5, "promoteAllowed": true}))
            .unwrap();
        assert_eq!(p.credential, Credential::Pool("main".into()));
        assert_eq!((p.input_price, p.output_price), (3.0, 15.5));
        assert!(p.promote_allowed);
        let k = with(json!({"keyLinkId": link})).unwrap();
        assert_eq!(k.credential, Credential::KeyLink(link.into()));
        assert_eq!(k.pool_and_link(), (None, Some(link)));
        assert!(!k.promote_allowed);
        assert!(matches!(
            with(json!({})),
            Err(ComboError::Invalid("credential"))
        ));
        assert!(matches!(
            with(json!({"accountPool": "main", "keyLinkId": link})),
            Err(ComboError::Invalid("credential"))
        ));
        assert!(matches!(
            with(json!({"keyLinkId": "nope"})),
            Err(ComboError::Invalid("keyLinkId"))
        ));
        assert!(matches!(
            with(json!({"accountPool": "main", "inputPrice": -1})),
            Err(ComboError::Invalid("inputPrice"))
        ));
        assert!(matches!(
            with(json!({"accountPool": "main", "promoteAllowed": "yes"})),
            Err(ComboError::Invalid("promoteAllowed"))
        ));
        assert!(matches!(
            ComboInput::parse(
                &json!({"name": " ", "harness": "h", "model": "m", "accountPool": "p"})
            ),
            Err(ComboError::Invalid("name"))
        ));
        // model·effort 는 스레드 모델과 같은 값 규칙 — `-` 로 시작하거나 공백·`=` 이 든 값은 만들 때부터 막는다.
        for bad in ["-x", "a b", "a=b", "--flag"] {
            assert!(matches!(
                with(json!({"accountPool": "main", "model": bad})),
                Err(ComboError::Invalid("model"))
            ));
            assert!(matches!(
                with(json!({"accountPool": "main", "effort": bad})),
                Err(ComboError::Invalid("effort"))
            ));
        }
        assert!(
            with(
                json!({"accountPool": "main", "model": "rro/openai/gpt-oss-120b", "effort": null})
            )
            .is_ok()
        );
    }

    #[test]
    fn privileges_cover_the_three_tables_only() {
        for (t, _) in EXEC_COMBO_PRIVILEGES {
            assert!(matches!(
                *t,
                "exec_combo" | "agent_exec_combo" | "exec_key_link"
            ));
        }
        // 오퍼레이터 코어 권한 묶음에 넣지 않는다 — GRANT 가 늦어도 나머지는 떠야 한다.
        for (t, _) in crate::write::OPERATOR_PRIVILEGES {
            assert!(!t.contains("exec_"));
        }
    }
}
