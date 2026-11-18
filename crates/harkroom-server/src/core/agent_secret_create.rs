//! S5.4 SE4 — 에이전트가 비밀을 만드는 길(102). TS `services/secretCreate.ts`·`routes/secretRoutes.ts` 를 옮긴다.
//!
//! - **옮긴 줄**: `GET /agent/secret-create` → `{ granted }`(러너가 프롬프트에 만들기 절을 쓸지 고른다. 판정이 아니다).
//!   차례는 TS 와 같다: 인증(401) → 오퍼레이터를 거친 에이전트(403) → `cache-control: no-store` →
//!   `granted = 키링이 있음 && secret.create 부여가 살아 있음`.
//! - **TS 에 남는 줄**: `POST /agent/secrets`·`POST /agent/secrets/rotate`. 이유:
//!   1. 둘이 같은 인메모리 속도 제한(`createLimiter`, 에이전트마다 시간당 10회)을 나눠 쓴다. 한쪽만 옮기면 상한이 둘로 갈라진다
//!      ([`crate::rate_limit`] 머리말 규칙). 둘을 같이 옮겨야 한다.
//!   2. 성공 뒤 소유자 알림(`notifyOwner`)이 `postMessage` 전체(인박스·푸시·i18n 표지·`serverNotice`)를 탄다.
//!   3. `generate: ssh_ed25519` 는 OpenSSH 키 쌍을 만든다(ed25519 키 생성 크레이트가 아직 없다). import 의
//!      "마운트된 값" 판정(F4)은 살아 있는 임대의 봉투를 전부 풀어 견준다.
//!
//!   그 대신 판정 조각([`cause_by_owner`]·[`check_length`]·[`CreateDenial::status`]·[`CreateLimiter`])은 여기서 TS 와
//!   같게 옮겨 단위 시험으로 묶어 둔다 — 다음 회차가 두 줄을 옮길 때 그대로 쓴다.
//! - 두 겹 잠금: `HARKROOM_CORE=rust` 그리고 쓰기 풀에 [`privileges`] 가 다 있을 때만 선다(`main.rs`). 키 env 를 읽을 수 없으면
//!   TS 에 남는다(TS 와 같이 키가 없거나 틀리면 `granted: false`).
use crate::auth::{Account, RequireAccount};
use crate::directory::{internal, json_err, json_ok};
use crate::secrets::verify::{SECRET_KEY_CHECK_PRIVILEGES, load_verified_from_env};
use axum::extract::State;
use axum::http::{StatusCode, header};
use axum::response::Response;
use sqlx::PgPool;
use std::collections::HashMap;
use std::sync::{Arc, Mutex};

/// TS `hasCreateGrant` 가 읽는 칸.
pub const AGENT_SECRET_CREATE_PRIVILEGES: &[(&str, &str)] = &[
    ("account_grant.account_id", "SELECT"),
    ("account_grant.capability", "SELECT"),
    ("account_grant.scope", "SELECT"),
    ("account_grant.expires_at", "SELECT"),
    ("account_grant.suspended_at", "SELECT"),
];

/// 모든 권한(이 줄 + 기동 키 확인).
pub fn privileges() -> Vec<(&'static str, &'static str)> {
    AGENT_SECRET_CREATE_PRIVILEGES
        .iter()
        .chain(SECRET_KEY_CHECK_PRIVILEGES)
        .copied()
        .collect()
}

/// TS `hasCreateGrant`.
const HAS_CREATE_GRANT_SQL: &str = "select 1 from account_grant \
     where account_id = $1::uuid and capability = 'secret.create' and scope = '' \
       and (expires_at is null or expires_at > now()) and suspended_at is null limit 1";

/// TS `AGENT_SECRET_MAX`·`AGENT_SECRET_DEFAULT_DAYS`·`AGENT_SECRET_MAX_DAYS`·`SECRET_CREATE_MAX_BYTES`.
pub const AGENT_SECRET_MAX: i64 = 20;
pub const AGENT_SECRET_DEFAULT_DAYS: i64 = 90;
pub const AGENT_SECRET_MAX_DAYS: i64 = 365;
pub const SECRET_CREATE_MAX_BYTES: usize = 64 * 1024;

/// TS `CreateDenial`.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum CreateDenial {
    LeaseInvalid,
    NotGranted,
    CauseNotOwner,
    RateLimited,
    TooMany,
    BadValue,
    BadLength,
    ValueIsMounted,
    SecretInDescription,
    NameTaken,
    NotFound,
    AdoptedByOwner,
    GrantSuspended,
    SecretExpired,
    KindMismatch,
    OwnerInactive,
}

impl CreateDenial {
    pub fn code(self) -> &'static str {
        use CreateDenial::*;
        match self {
            LeaseInvalid => "lease_invalid",
            NotGranted => "not_granted",
            CauseNotOwner => "cause_not_owner",
            RateLimited => "rate_limited",
            TooMany => "too_many",
            BadValue => "bad_value",
            BadLength => "bad_length",
            ValueIsMounted => "value_is_mounted",
            SecretInDescription => "secret_in_description",
            NameTaken => "name_taken",
            NotFound => "not_found",
            AdoptedByOwner => "adopted_by_owner",
            GrantSuspended => "grant_suspended",
            SecretExpired => "secret_expired",
            KindMismatch => "kind_mismatch",
            OwnerInactive => "owner_inactive",
        }
    }

    /// TS `createStatus`.
    pub fn status(self) -> StatusCode {
        use CreateDenial::*;
        match self {
            LeaseInvalid | NotGranted | CauseNotOwner | OwnerInactive | GrantSuspended => {
                StatusCode::FORBIDDEN
            }
            RateLimited => StatusCode::TOO_MANY_REQUESTS,
            NotFound => StatusCode::NOT_FOUND,
            BadValue | BadLength | SecretInDescription | KindMismatch => StatusCode::BAD_REQUEST,
            TooMany | NameTaken | ValueIsMounted | AdoptedByOwner | SecretExpired => {
                StatusCode::CONFLICT
            }
        }
    }
}

/// TS `causeByOwner` 가 보는 임대 칸.
#[derive(Debug, Clone, Default)]
pub struct LeaseCause<'a> {
    pub agent_id: &'a str,
    pub owner_id: Option<&'a str>,
    pub cause_author_id: Option<&'a str>,
    pub cause_kind: Option<&'a str>,
    pub cause_ask_author_id: Option<&'a str>,
    pub ask_answered_by: Option<&'a str>,
    pub ask_answerer_kind: Option<&'a str>,
}

/// TS `causeByOwner`(F2) — 턴을 띄운 글이 이 에이전트 소유자의 사람 글이거나, 소유자가 이 에이전트 자신의 선택 카드에 답한 턴.
pub fn cause_by_owner(l: &LeaseCause<'_>) -> bool {
    let Some(owner) = l.owner_id else {
        return false;
    };
    if l.cause_kind == Some("human") && l.cause_author_id == Some(owner) {
        return true;
    }
    l.cause_ask_author_id == Some(l.agent_id)
        && l.ask_answered_by == Some(owner)
        && l.ask_answerer_kind == Some("human")
}

/// TS `GENERATE_TYPES`.
pub const GENERATE_TYPES: &[&str] = &["password", "token_hex", "token_base64url", "ssh_ed25519"];

/// TS `generateValue` 의 길이 판정. `Ok(Some(n))` = 그 길이로 만든다, `Ok(None)` = ssh(길이 없음).
/// password 는 글자 수, token_* 는 바이트 수. 모르는 종류는 `None`(라우트의 zod 가 먼저 400 으로 거른다).
pub fn check_length(kind: &str, length: Option<i64>) -> Option<Result<Option<i64>, CreateDenial>> {
    let (min, max, def) = match kind {
        "ssh_ed25519" => {
            return Some(match length {
                Some(_) => Err(CreateDenial::BadLength),
                None => Ok(None),
            });
        }
        "password" => (16, 128, 32),
        "token_hex" | "token_base64url" => (16, 64, 32),
        _ => return None,
    };
    let n = length.unwrap_or(def);
    Some(if (min..=max).contains(&n) {
        Ok(Some(n))
    } else {
        Err(CreateDenial::BadLength)
    })
}

/// TS `RevealLimiter` (`createLimiter` = 시간당 10회) — 미끄럼 창. 키는 에이전트 id.
pub struct CreateLimiter {
    max: usize,
    window_ms: u64,
    hits: Mutex<HashMap<String, Vec<u64>>>,
}

impl CreateLimiter {
    pub fn new(max: usize, window_ms: u64) -> Self {
        Self {
            max,
            window_ms,
            hits: Mutex::new(HashMap::new()),
        }
    }

    /// TS `createLimiter()`.
    pub fn create() -> Self {
        Self::new(10, 3_600_000)
    }

    pub fn take(&self, key: &str, now_ms: u64) -> bool {
        let mut m = self.hits.lock().unwrap_or_else(|e| e.into_inner());
        let recent = m.entry(key.to_owned()).or_default();
        recent.retain(|t| now_ms.saturating_sub(*t) < self.window_ms);
        if recent.len() >= self.max {
            return false;
        }
        recent.push(now_ms);
        true
    }
}

pub struct AgentSecretCreateState {
    write: PgPool,
    keyring_on: bool,
}

/// 기동 한 번: 키를 읽어 확인값과 맞춘다(TS `verifySecretKeys`). env 가 잘못됐으면 `Err`(이 줄은 TS 에 남는다).
pub async fn load_state(write: PgPool) -> Result<AgentSecretCreateState, String> {
    let v = load_verified_from_env(&write).await?;
    let keyring_on = v.is_some_and(|v| v.keyring.is_some());
    Ok(AgentSecretCreateState { write, keyring_on })
}

/// TS `viaOperator`.
fn via_operator(me: &Account, auth: &crate::auth::Auth) -> Option<String> {
    match (&me.kind[..], &auth.operator) {
        ("agent", Some(_)) => Some(me.id.clone()),
        _ => None,
    }
}

/// `GET /agent/secret-create` → `{ granted }`.
pub async fn secret_create(
    State(st): State<Arc<AgentSecretCreateState>>,
    RequireAccount(me, auth): RequireAccount,
) -> Response {
    let Some(agent_id) = via_operator(&me, &auth) else {
        return json_err(
            StatusCode::FORBIDDEN,
            "forbidden",
            "only an agent through its operator can do this",
        );
    };
    // TS: `!!keyring && (await hasCreateGrant(...))` — 키링이 없으면 묻지 않는다.
    let granted = if st.keyring_on {
        match sqlx::query_scalar::<_, i32>(HAS_CREATE_GRANT_SQL)
            .bind(&agent_id)
            .fetch_optional(&st.write)
            .await
        {
            Ok(r) => r.is_some(),
            Err(e) => return internal(e),
        }
    } else {
        false
    };
    let mut r = json_ok(format!(r#"{{"granted":{granted}}}"#));
    r.headers_mut().insert(
        header::CACHE_CONTROL,
        header::HeaderValue::from_static("no-store"),
    );
    r
}

pub fn routes(
    st: AgentSecretCreateState,
    auth: crate::auth::AuthPools,
    cors: Arc<crate::cors::Cors>,
) -> crate::route_table::Routes<()> {
    use crate::route_table::Table;
    let t = Table::<Arc<AgentSecretCreateState>>::new()
        .get("/agent/secret-create", secret_create)
        .map(|r| {
            r.route_layer(axum::middleware::from_fn_with_state(
                auth,
                crate::auth::layer,
            ))
            .layer(axum::middleware::from_fn_with_state(
                cors,
                crate::cors::layer,
            ))
        })
        .finish();
    crate::route_table::Routes {
        router: t.router.with_state(Arc::new(st)),
        http: t.http,
        sockets: t.sockets,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const AGENT: &str = "a";
    const OWNER: &str = "o";

    fn lease<'a>() -> LeaseCause<'a> {
        LeaseCause {
            agent_id: AGENT,
            owner_id: Some(OWNER),
            ..Default::default()
        }
    }

    #[test]
    fn cause_owner_human_post() {
        let l = LeaseCause {
            cause_kind: Some("human"),
            cause_author_id: Some(OWNER),
            ..lease()
        };
        assert!(cause_by_owner(&l));
    }

    #[test]
    fn cause_other_human_or_agent_refused() {
        let other = LeaseCause {
            cause_kind: Some("human"),
            cause_author_id: Some("x"),
            ..lease()
        };
        assert!(!cause_by_owner(&other));
        let agent_post = LeaseCause {
            cause_kind: Some("agent"),
            cause_author_id: Some(OWNER),
            ..lease()
        };
        assert!(!cause_by_owner(&agent_post));
    }

    #[test]
    fn cause_no_owner_refused() {
        let l = LeaseCause {
            owner_id: None,
            cause_kind: Some("human"),
            cause_author_id: None,
            ..lease()
        };
        assert!(!cause_by_owner(&l));
    }

    #[test]
    fn cause_owner_answered_own_ask() {
        let l = LeaseCause {
            cause_kind: Some("agent"),
            cause_author_id: Some(AGENT),
            cause_ask_author_id: Some(AGENT),
            ask_answered_by: Some(OWNER),
            ask_answerer_kind: Some("human"),
            ..lease()
        };
        assert!(cause_by_owner(&l));
        // 다른 에이전트의 카드, 사람이 아닌 답, 소유자 아닌 답은 아니다.
        assert!(!cause_by_owner(&LeaseCause {
            cause_ask_author_id: Some("b"),
            ..l.clone()
        }));
        assert!(!cause_by_owner(&LeaseCause {
            ask_answerer_kind: Some("agent"),
            ..l.clone()
        }));
        assert!(!cause_by_owner(&LeaseCause {
            ask_answered_by: Some("x"),
            ..l
        }));
    }

    #[test]
    fn length_rules() {
        assert_eq!(check_length("password", None), Some(Ok(Some(32))));
        assert_eq!(check_length("password", Some(16)), Some(Ok(Some(16))));
        assert_eq!(check_length("password", Some(128)), Some(Ok(Some(128))));
        assert_eq!(
            check_length("password", Some(15)),
            Some(Err(CreateDenial::BadLength))
        );
        assert_eq!(
            check_length("password", Some(129)),
            Some(Err(CreateDenial::BadLength))
        );
        for t in ["token_hex", "token_base64url"] {
            assert_eq!(check_length(t, None), Some(Ok(Some(32))));
            assert_eq!(check_length(t, Some(64)), Some(Ok(Some(64))));
            assert_eq!(
                check_length(t, Some(65)),
                Some(Err(CreateDenial::BadLength))
            );
        }
        assert_eq!(check_length("ssh_ed25519", None), Some(Ok(None)));
        assert_eq!(
            check_length("ssh_ed25519", Some(32)),
            Some(Err(CreateDenial::BadLength))
        );
        assert_eq!(check_length("rsa", None), None);
    }

    #[test]
    fn denial_status_matches_ts_create_status() {
        use CreateDenial::*;
        for (d, s) in [
            (LeaseInvalid, 403),
            (NotGranted, 403),
            (CauseNotOwner, 403),
            (OwnerInactive, 403),
            (GrantSuspended, 403),
            (RateLimited, 429),
            (NotFound, 404),
            (BadValue, 400),
            (BadLength, 400),
            (SecretInDescription, 400),
            (KindMismatch, 400),
            (TooMany, 409),
            (NameTaken, 409),
            (ValueIsMounted, 409),
            (AdoptedByOwner, 409),
            (SecretExpired, 409),
        ] {
            assert_eq!(d.status().as_u16(), s, "{}", d.code());
        }
    }

    #[test]
    fn limiter_ten_per_hour_per_agent() {
        let l = CreateLimiter::create();
        for i in 0..10 {
            assert!(l.take("a", 1_000 + i));
        }
        assert!(!l.take("a", 2_000), "11번째는 막힌다");
        assert!(l.take("b", 2_000), "에이전트마다 따로");
        assert!(!l.take("a", 1_000 + 3_600_000 - 1), "창 안");
        assert!(
            l.take("a", 1_000 + 3_600_000),
            "첫 기록이 창을 벗어나면 풀린다"
        );
    }

    #[test]
    fn privileges_include_key_check() {
        let p = privileges();
        assert!(p.contains(&("account_grant.suspended_at", "SELECT")));
        assert!(p.contains(&("secret_key_check.kcv", "SELECT")));
    }
}
