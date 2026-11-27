//! J2c — 오퍼레이터가 턴을 띄울 때 그 턴의 **실행 조합 자격**을 서버에 묻는 두 길.
//!
//! - `GET /agent/exec-combo?threadRootId=` (기동 답) → `{comboId, kind: "pool"|"key"|"none", accountPool}`.
//!   러너를 어떤 모드로 띄울지 고르는 **길잡이**다. 주소·비밀 id·값은 싣지 않는다. 허락이 아니다 — 값은 아래 길만 준다.
//! - `POST /agent/exec-combo/credential` `{leaseId, token}` (턴 답) → 풀 조합이면 이름만, 키 조합이면 주소와 값.
//!   인자는 임대뿐이다. 어느 스레드·조합·비밀인지는 **서버가 임대에서** 고른다 — 본문의 다른 칸(`secretId`·`comboId`·
//!   `threadRootId`·`baseUrl`·`name`)은 읽지 않는다.
//!
//! 약속:
//! - 조합 줄은 `thread_agent_model` 의 (스레드, **그 에이전트**, 지금 하네스)로만 찾는다. 줄이 없으면 「조합 없음」(`kind: none`)
//!   이고 오퍼레이터는 지금까지의 로컬 설정 길을 그대로 쓴다.
//! - 턴 답은 그 스레드 뿌리 글의 채널이 임대의 채널과 같을 때만 본다(남의 채널 스레드의 줄로 풀지 않는다) → `combo_thread_mismatch`.
//! - 허용 목록(`agent_exec_combo`)·하네스 일치·`secret_id is not null`·주소 꼴을 **한 문장으로 읽어 한 번에** 판정한다([`judge`]).
//!   그 뒤 값은 `agent_secret_reveal` 의 거절 사슬(만료 → 소유자 비활성 → `not_granted` → `not_own_agent` → `wrong_channel` →
//!   `wrong_operator` → `grant_suspended` → `no_value`)을 **그대로** 지나야 열린다. 허용 목록은 「고를 수 있음」, 부여는 「값을 씀」이다.
//!   속도 제한도 그 길과 같은 통이다(에이전트마다 10분 30회).
//! - 비밀은 `exec_key_link.secret_id` 로만 고른다. `secret_name` 은 읽지 않는다 — 비밀이 지워져 id 가 null 이면
//!   `combo_unusable` 이고 같은 이름의 새 비밀로 잇지 않는다.
//! - 값을 준 것·막은 것은 `secret_access_log` 한 줄로 남는다(그 길과 같다). 답은 전부 `cache-control: no-store`.
//! - 오퍼레이터를 거친 에이전트만(403 `forbidden`). 키링이 없으면 턴 답은 409(`secret_store_disabled`·`secret_key_mismatch`).
//! - 칸 권한은 [`AGENT_COMBO_CREDENTIAL_PRIVILEGES`] — 쓰기 풀에 하나라도 없거나 조합 기능이 꺼져 있으면 `main.rs` 가 두 길을 붙이지 않는다.
use super::agent_secret_reveal::{
    AgentSecretRevealState, Revealed, Sel, no_store, read_lease, reveal_body, reveal_with,
};
use super::grant_reads::{parse_query, through_operator};
use crate::auth::RequireAccount;
use crate::directory::{internal, json_err, json_ok};
use axum::extract::{FromRequestParts, RawQuery, Request, State};
use axum::http::StatusCode;
use axum::response::Response;
use serde_json::{Value, json};
use sqlx::PgPool;
use std::sync::Arc;

/// 쓰기 풀이 더 읽는 칸(값 사슬의 칸은 `agent_secret_reveal::privileges`).
pub const AGENT_COMBO_CREDENTIAL_PRIVILEGES: &[(&str, &str)] = &[
    ("thread_agent_model.thread_root_id", "SELECT"),
    ("thread_agent_model.agent_id", "SELECT"),
    ("thread_agent_model.harness", "SELECT"),
    ("thread_agent_model.combo_id", "SELECT"),
    ("exec_combo.id", "SELECT"),
    ("exec_combo.harness", "SELECT"),
    ("exec_combo.account_pool", "SELECT"),
    ("exec_combo.key_link_id", "SELECT"),
    ("exec_key_link.id", "SELECT"),
    ("exec_key_link.base_url", "SELECT"),
    ("exec_key_link.secret_id", "SELECT"),
    ("agent_exec_combo.agent_id", "SELECT"),
    ("agent_exec_combo.combo_id", "SELECT"),
    ("agent_config.account_id", "SELECT"),
    ("agent_config.harness", "SELECT"),
    ("message.id", "SELECT"),
    ("message.channel_id", "SELECT"),
];

/// 그 스레드·그 에이전트의 조합 줄과 판정 재료를 한 문장으로 읽는다. 지금 하네스의 줄만 본다(`/agent/thread-model` 과 같은 기준).
pub const COMBO_ROW_SQL: &str = "select c.id::text, c.account_pool, c.key_link_id is not null as is_key, \
            k.base_url, k.secret_id::text, \
            c.harness = coalesce(g.harness, 'claude-code') as harness_ok, \
            exists (select 1 from agent_exec_combo a where a.agent_id = t.agent_id and a.combo_id = c.id) as allowed, \
            (select m.channel_id::text from message m where m.id = t.thread_root_id) as channel \
       from thread_agent_model t \
       join exec_combo c on c.id = t.combo_id \
       left join agent_config g on g.account_id = t.agent_id \
       left join exec_key_link k on k.id = c.key_link_id \
      where t.agent_id = $1::uuid and t.thread_root_id = $2::uuid \
        and t.harness = coalesce(g.harness, 'claude-code')";

/// [`COMBO_ROW_SQL`] 한 줄.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ComboRow {
    pub id: String,
    pub account_pool: Option<String>,
    pub is_key: bool,
    pub base_url: Option<String>,
    pub secret_id: Option<String>,
    pub harness_ok: bool,
    pub allowed: bool,
    pub channel: Option<String>,
}

/// 그 턴의 자격 종류.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Credential {
    /// 구독 계정 풀 — 이름만.
    Pool {
        combo_id: String,
        account_pool: String,
    },
    /// 키 연결 — 주소와 서버가 고른 비밀 id(답에는 싣지 않는다).
    Key {
        combo_id: String,
        base_url: String,
        secret_id: String,
    },
}

/// 조합 줄이 있는데 쓸 수 없다 — 그 턴을 세우지 않는다(구독 풀로 대신 돌리지 않는다).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ComboDenial {
    ThreadMismatch,
    NotAllowed,
    HarnessMismatch,
    Unusable,
}

impl ComboDenial {
    pub fn code(self) -> &'static str {
        match self {
            ComboDenial::ThreadMismatch => "combo_thread_mismatch",
            ComboDenial::NotAllowed => "combo_not_allowed",
            ComboDenial::HarnessMismatch => "combo_harness_mismatch",
            ComboDenial::Unusable => "combo_unusable",
        }
    }
}

/// 한 번의 판정. `lease_channel` 은 턴 답에서만 준다(기동 답에는 임대가 없다).
pub fn judge(row: ComboRow, lease_channel: Option<&str>) -> Result<Credential, ComboDenial> {
    if let Some(ch) = lease_channel
        && row.channel.as_deref() != Some(ch)
    {
        return Err(ComboDenial::ThreadMismatch);
    }
    if !row.allowed {
        return Err(ComboDenial::NotAllowed);
    }
    if !row.harness_ok {
        return Err(ComboDenial::HarnessMismatch);
    }
    if !row.is_key {
        return match row.account_pool {
            Some(p) => Ok(Credential::Pool {
                combo_id: row.id,
                account_pool: p,
            }),
            None => Err(ComboDenial::Unusable),
        };
    }
    // 주소는 저장할 때 본 규칙을 내줄 때 한 번 더 본다(DB 를 직접 고친 값이 나가지 않게).
    let url = row
        .base_url
        .as_deref()
        .and_then(super::exec_combo::base_url_ok);
    match (url, row.secret_id) {
        (Some(base_url), Some(secret_id)) => Ok(Credential::Key {
            combo_id: row.id,
            base_url,
            secret_id,
        }),
        _ => Err(ComboDenial::Unusable),
    }
}

fn s(v: &str) -> String {
    Value::String(v.to_owned()).to_string()
}

/// 조합 없음 — 오퍼레이터는 로컬 설정 길을 그대로 쓴다.
pub const NONE_BODY: &str = r#"{"comboId":null,"kind":"none","accountPool":null}"#;

/// 기동 답·풀 조합의 턴 답. 키 조합이어도 주소·비밀 id 는 싣지 않는다.
pub fn kind_body(c: &Credential) -> String {
    match c {
        Credential::Pool {
            combo_id,
            account_pool,
        } => format!(
            "{{\"comboId\":{},\"kind\":\"pool\",\"accountPool\":{}}}",
            s(combo_id),
            s(account_pool)
        ),
        Credential::Key { combo_id, .. } => {
            format!(
                "{{\"comboId\":{},\"kind\":\"key\",\"accountPool\":null}}",
                s(combo_id)
            )
        }
    }
}

fn denied(d: ComboDenial) -> Response {
    no_store(json_err(
        StatusCode::FORBIDDEN,
        d.code(),
        &format!("exec combo not usable: {}", d.code()),
    ))
}

type RawRow = (
    String,
    Option<String>,
    bool,
    Option<String>,
    Option<String>,
    bool,
    bool,
    Option<String>,
);

async fn combo_row(pool: &PgPool, agent_id: &str, root: &str) -> sqlx::Result<Option<ComboRow>> {
    let r: Option<RawRow> = sqlx::query_as(COMBO_ROW_SQL)
        .bind(agent_id)
        .bind(root)
        .fetch_optional(pool)
        .await?;
    Ok(r.map(
        |(id, account_pool, is_key, base_url, secret_id, harness_ok, allowed, channel)| ComboRow {
            id,
            account_pool,
            is_key,
            base_url,
            secret_id,
            harness_ok,
            allowed,
            channel,
        },
    ))
}

/// 기동 답의 몸 — `Ok(None)` 은 조합 없음.
pub async fn startup_kind(
    pool: &PgPool,
    agent_id: &str,
    thread_root_id: Option<&str>,
) -> sqlx::Result<Result<Option<Credential>, ComboDenial>> {
    let Some(root) = thread_root_id else {
        return Ok(Ok(None));
    };
    Ok(match combo_row(pool, agent_id, root).await? {
        None => Ok(None),
        Some(r) => judge(r, None).map(Some),
    })
}

const FORBIDDEN: &str = "only an agent through its operator can do this";

/// `GET /agent/exec-combo?threadRootId=`.
pub async fn startup(
    State(st): State<Arc<AgentSecretRevealState>>,
    RequireAccount(me, auth): RequireAccount,
    RawQuery(raw): RawQuery,
) -> Response {
    if !through_operator(&me, &auth) {
        return json_err(StatusCode::FORBIDDEN, "forbidden", FORBIDDEN);
    }
    let Some(q) = parse_query(raw.as_deref(), &[], &["threadRootId"]) else {
        return json_err(
            StatusCode::BAD_REQUEST,
            "bad_request",
            "threadRootId: Invalid uuid",
        );
    };
    match startup_kind(&st.write, &me.id, q[0].as_deref()).await {
        Err(e) => internal(e),
        Ok(Err(d)) => denied(d),
        Ok(Ok(None)) => no_store(json_ok(NONE_BODY.to_owned())),
        Ok(Ok(Some(c))) => no_store(json_ok(kind_body(&c))),
    }
}

/// `{leaseId: uuid, token: 1–200}` — 다른 칸은 읽지 않는다.
pub fn parse_body(v: &Value) -> Option<(String, String)> {
    let o = v.as_object()?;
    let lease_id = o.get("leaseId")?.as_str()?;
    if !crate::lists::is_zod_uuid(lease_id) {
        return None;
    }
    let token = o.get("token")?.as_str()?;
    if !(1..=200).contains(&super::secret_writes::len16(token)) {
        return None;
    }
    Some((lease_id.to_owned(), token.to_owned()))
}

/// 턴 답의 결과. 값은 `Key` 에만 있다.
pub enum Answer {
    /// 임대가 없거나 이 에이전트·오퍼레이터의 것이 아니거나 끝났다.
    LeaseInvalid,
    /// 조합 줄 없음 — 로컬 길.
    None,
    Pool(Credential),
    Denied(ComboDenial),
    /// 조합은 지났지만 값 사슬에서 막혔다(코드·상태는 `/agent/secrets/reveal` 과 같다).
    Secret(super::agent_secret_reveal::RevealDenial),
    Key {
        combo_id: String,
        base_url: String,
        /// `/agent/secrets/reveal` 과 같은 꼴(`{"secret":{…},"valueBase64":…}`).
        reveal: zeroize::Zeroizing<String>,
    },
}

/// 턴 답 — 임대에서 스레드를 찾고, 조합을 한 번에 판정하고, 키 조합이면 값 사슬을 지난다.
pub async fn turn_credential(
    st: &AgentSecretRevealState,
    agent_id: &str,
    operator_id: &str,
    lease_id: &str,
    token: &str,
) -> sqlx::Result<Answer> {
    use super::agent_secret_reveal::RevealDenial;
    let now_ms = super::msg_post::now_ms();
    let now = super::msg_post::iso_ms(now_ms);
    let Some(lease) = read_lease(st, agent_id, operator_id, lease_id, token, &now).await? else {
        return Ok(Answer::LeaseInvalid);
    };
    let Some(row) = combo_row(&st.write, agent_id, &lease.thread_root_id).await? else {
        return Ok(Answer::None);
    };
    let (combo_id, base_url, secret_id) = match judge(row, Some(&lease.channel_id)) {
        Err(d) => return Ok(Answer::Denied(d)),
        Ok(c @ Credential::Pool { .. }) => return Ok(Answer::Pool(c)),
        Ok(Credential::Key {
            combo_id,
            base_url,
            secret_id,
        }) => (combo_id, base_url, secret_id),
    };
    let revealed = reveal_with(
        st,
        st.keyring.as_ref(),
        agent_id,
        operator_id,
        Some(lease),
        Sel::Id(&secret_id),
        now_ms,
        &now,
    )
    .await?;
    Ok(match revealed {
        // 판정과 읽기 사이에 비밀이 지워졌다 — 이름으로 다시 찾지 않는다.
        Revealed::Denied(RevealDenial::NotFound) => Answer::Denied(ComboDenial::Unusable),
        Revealed::Denied(d) => Answer::Secret(d),
        Revealed::Ok {
            secret,
            version,
            value,
        } => Answer::Key {
            combo_id,
            base_url,
            reveal: zeroize::Zeroizing::new(reveal_body(
                &secret.id,
                &secret.name,
                &secret.kind,
                secret.filename.as_deref(),
                version,
                value.as_bytes(),
            )),
        },
    })
}

/// 키 조합의 턴 답 — `{"comboId","kind":"key","baseUrl","secret":{…},"valueBase64"}`.
fn key_body(combo_id: &str, base_url: &str, reveal: &str) -> zeroize::Zeroizing<String> {
    // `reveal` 은 `{` 로 시작하는 객체다 — 앞 칸을 붙여 한 객체로 만든다.
    zeroize::Zeroizing::new(format!(
        "{{\"comboId\":{},\"kind\":\"key\",\"baseUrl\":{},{}",
        s(combo_id),
        s(base_url),
        &reveal[1..]
    ))
}

/// `POST /agent/exec-combo/credential`.
pub async fn credential(State(st): State<Arc<AgentSecretRevealState>>, req: Request) -> Response {
    let (mut parts, body) = req.into_parts();
    let bytes = match axum::body::to_bytes(body, crate::write::BODY_LIMIT).await {
        Ok(b) => b,
        Err(_) => {
            return json_err(
                StatusCode::PAYLOAD_TOO_LARGE,
                "fst_err_ctp_body_too_large",
                "Request body is too large",
            );
        }
    };
    let parsed = match crate::write::fastify_body(&parts.headers, &bytes) {
        Ok(p) => p,
        Err(r) => return r,
    };
    let (me, auth) = match RequireAccount::from_request_parts(&mut parts, &()).await {
        Ok(RequireAccount(me, auth)) => (me, auth),
        Err(r) => return r,
    };
    let op = match (&me.kind[..], auth.operator.as_ref()) {
        ("agent", Some(op)) => op,
        _ => return json_err(StatusCode::FORBIDDEN, "forbidden", FORBIDDEN),
    };
    if st.keyring.is_none() {
        return super::secret_writes::disabled(st.mismatch);
    }
    let json = match &parsed {
        crate::write::Body::Json(v) => v.clone(),
        crate::write::Body::None => json!({}),
        crate::write::Body::Text(t) => Value::String(t.clone()),
    };
    let Some((lease_id, token)) = parse_body(&json) else {
        return json_err(
            StatusCode::BAD_REQUEST,
            "bad_request",
            "leaseId and token are required",
        );
    };
    match turn_credential(&st, &me.id, &op.id, &lease_id, &token).await {
        Err(e) => internal(e),
        Ok(Answer::LeaseInvalid) => no_store(json_err(
            StatusCode::FORBIDDEN,
            "lease_invalid",
            "exec combo not usable: lease_invalid",
        )),
        Ok(Answer::None) => no_store(json_ok(NONE_BODY.to_owned())),
        Ok(Answer::Pool(c)) => no_store(json_ok(kind_body(&c))),
        Ok(Answer::Denied(d)) => denied(d),
        Ok(Answer::Secret(d)) => no_store(json_err(
            d.status(),
            d.code(),
            &format!("secret not revealed: {}", d.code()),
        )),
        Ok(Answer::Key {
            combo_id,
            base_url,
            reveal,
        }) => no_store(json_ok(
            key_body(&combo_id, &base_url, &reveal).as_str().to_owned(),
        )),
    }
}

/// 두 길 — `agent_secret_reveal::routes` 가 같은 상태·같은 층(auth·cors)으로 붙인다.
pub fn table() -> crate::route_table::Table<Arc<AgentSecretRevealState>> {
    crate::route_table::Table::new()
        .get("/agent/exec-combo", startup)
        .post("/agent/exec-combo/credential", credential)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn row() -> ComboRow {
        ComboRow {
            id: "c".into(),
            account_pool: None,
            is_key: true,
            base_url: Some("https://llm.example.com/v1".into()),
            secret_id: Some("s".into()),
            harness_ok: true,
            allowed: true,
            channel: Some("ch".into()),
        }
    }

    #[test]
    fn judge_order_and_kinds() {
        assert!(matches!(
            judge(row(), Some("ch")),
            Ok(Credential::Key { ref secret_id, .. }) if secret_id == "s"
        ));
        // 기동 답에는 임대가 없다 — 채널을 보지 않는다.
        assert!(judge(row(), None).is_ok());
        assert_eq!(
            judge(row(), Some("other")),
            Err(ComboDenial::ThreadMismatch)
        );
        let gone_root = ComboRow {
            channel: None,
            ..row()
        };
        assert_eq!(
            judge(gone_root, Some("ch")),
            Err(ComboDenial::ThreadMismatch)
        );
        // 채널이 먼저, 그다음 허용 목록, 그다음 하네스.
        let both = ComboRow {
            allowed: false,
            harness_ok: false,
            ..row()
        };
        assert_eq!(judge(both, Some("ch")), Err(ComboDenial::NotAllowed));
        let harness = ComboRow {
            harness_ok: false,
            ..row()
        };
        assert_eq!(
            judge(harness, Some("ch")),
            Err(ComboDenial::HarnessMismatch)
        );
        // 비밀이 지워졌다 — 뜨지 않는다.
        let no_secret = ComboRow {
            secret_id: None,
            ..row()
        };
        assert_eq!(judge(no_secret, Some("ch")), Err(ComboDenial::Unusable));
        for bad in ["http://llm.example.com", "https://u:p@llm.example.com", ""] {
            let r = ComboRow {
                base_url: Some(bad.into()),
                ..row()
            };
            assert_eq!(judge(r, Some("ch")), Err(ComboDenial::Unusable), "{bad}");
        }
        let pool = ComboRow {
            is_key: false,
            account_pool: Some("main".into()),
            base_url: None,
            secret_id: None,
            ..row()
        };
        assert_eq!(
            judge(pool, Some("ch")),
            Ok(Credential::Pool {
                combo_id: "c".into(),
                account_pool: "main".into()
            })
        );
    }

    #[test]
    fn bodies_never_carry_address_or_secret_id_unless_key_answer() {
        let key = Credential::Key {
            combo_id: "c\"1".into(),
            base_url: "https://llm.example.com".into(),
            secret_id: "sid".into(),
        };
        let b = kind_body(&key);
        assert_eq!(b, r#"{"comboId":"c\"1","kind":"key","accountPool":null}"#);
        assert!(!b.contains("llm.example.com") && !b.contains("sid"));
        let pool = Credential::Pool {
            combo_id: "c".into(),
            account_pool: "main".into(),
        };
        assert_eq!(
            kind_body(&pool),
            r#"{"comboId":"c","kind":"pool","accountPool":"main"}"#
        );
        let reveal = reveal_body("i", "k", "text", None, 3, b"hi");
        assert_eq!(
            key_body("c", "https://llm.example.com", &reveal).as_str(),
            r#"{"comboId":"c","kind":"key","baseUrl":"https://llm.example.com","secret":{"id":"i","name":"k","kind":"text","filename":null,"version":3},"valueBase64":"aGk="}"#
        );
    }

    #[test]
    fn body_takes_only_the_lease() {
        const LEASE: &str = "11111111-1111-4111-8111-111111111111";
        let extra = json!({
            "leaseId": LEASE, "token": "t", "secretId": "x", "comboId": "y",
            "threadRootId": "z", "baseUrl": "https://evil.example.com", "name": "gh-token"
        });
        assert_eq!(parse_body(&extra), Some((LEASE.to_owned(), "t".to_owned())));
        assert!(parse_body(&json!({"leaseId": "nope", "token": "t"})).is_none());
        assert!(parse_body(&json!({"leaseId": LEASE, "token": ""})).is_none());
        assert!(parse_body(&json!({"leaseId": LEASE})).is_none());
        assert!(parse_body(&json!([])).is_none());
    }

    #[test]
    fn sql_picks_the_secret_by_id_only() {
        assert!(!COMBO_ROW_SQL.contains("secret_name"));
        assert!(COMBO_ROW_SQL.contains("k.secret_id"));
        assert!(COMBO_ROW_SQL.contains("t.agent_id = $1::uuid"));
        assert!(
            AGENT_COMBO_CREDENTIAL_PRIVILEGES
                .iter()
                .all(|(c, p)| *p == "SELECT" && !c.contains("secret_name"))
        );
    }
}
