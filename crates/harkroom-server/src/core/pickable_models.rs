//! S5.4 — 다른 에이전트가 고를 수 있는 모델 목록 쓰기. TS `routes/threadAgentModelRoutes.ts` 의
//! `PUT /accounts/agents/:agentId/pickable-models` 를 옮긴다.
//!
//! - 순서는 TS 와 같다: `requireAccount`(401) → 경로(400) → 사람이 아니면 403 `human_only` → 본문(400 `bad_request`) →
//!   모양(400 `bad_model_value`) → 에이전트 없음 404 → 소유자가 아니면 403 `owner_only` → 트랜잭션(목록 저장 + 목록 밖
//!   에이전트 지정 세기, 행 잠금) → 감사 `agent.pickable_models.set {models, cleared}` → 200 `{models, outside, cleared}`.
//! - 본문에 `clearOutside: true` 가 있으면 **그대로 TS 로 넘긴다** — 풀린 스레드마다 시스템 줄(i18n 표지)·
//!   `thread.agent_model.changed` 를 내는 일은 TS `postMessage` 몫이다. 그래서 여기서는 `cleared` 가 늘 0 이다.
//! - 권한은 [`PICKABLE_MODELS_PRIVILEGES`] — 없으면 `main.rs` 가 이 줄을 붙이지 않아 TS 에 남는다.
use crate::auth::RequireAccount;
use crate::directory::{internal, json_err};
use crate::lists::is_zod_uuid;
use crate::proxy::Upstream;
use crate::trust_proxy::TrustProxy;
use crate::write::{AuditEntry, Body, record_audit};
use axum::body::to_bytes;
use axum::extract::{ConnectInfo, Path, Request, State};
use axum::http::StatusCode;
use axum::response::{IntoResponse, Response};
use serde_json::{Value, json};
use sqlx::PgPool;
use std::net::SocketAddr;
use std::sync::Arc;

/// 쓰기 풀에 있어야 하는 칸 권한 — homelab GRANT 와 같아야 한다. `for update of t` 는 그 표의 UPDATE 칸 하나를 요구한다.
/// 감사 줄(`audit_log` INSERT)은 이미 있는 쓰기 코어 권한이다.
pub const PICKABLE_MODELS_PRIVILEGES: &[(&str, &str)] = &[
    ("account.id", "SELECT"),
    ("account.kind", "SELECT"),
    ("account.deleted_at", "SELECT"),
    ("agent_config.account_id", "SELECT"),
    ("agent_config.owner_account_id", "SELECT"),
    ("agent_config.agent_pickable_models", "UPDATE"),
    ("thread_agent_model.thread_root_id", "SELECT"),
    ("thread_agent_model.agent_id", "SELECT"),
    ("thread_agent_model.set_by_kind", "SELECT"),
    ("thread_agent_model.model", "SELECT"),
    ("thread_agent_model.effort", "SELECT"),
    ("thread_agent_model.model", "UPDATE"),
    ("message.id", "SELECT"),
    ("message.channel_id", "SELECT"),
];

/// TS `@harkroom/shared` `MODEL_ID_MAX`·`EFFORT_MAX`.
const MODEL_ID_MAX: usize = 120;
const EFFORT_MAX: usize = 32;
const BODY_LIMIT: usize = 1024 * 1024;

#[derive(Clone)]
pub struct PickableModelsState {
    pub write: PgPool,
    pub trust: Arc<TrustProxy>,
    pub up: Upstream,
}

#[derive(Debug, PartialEq, Eq, Clone)]
pub struct Entry {
    pub model: String,
    pub efforts: Vec<String>,
}

#[derive(Debug, PartialEq, Eq)]
pub enum Parsed {
    /// `clearOutside: true` — TS 몫.
    Ts,
    Ok(Vec<Entry>),
    Bad,
}

fn js_len(s: &str) -> usize {
    s.encode_utf16().count()
}

/// TS `AXIS_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:/[\]-]*$/`.
pub fn axis_valid(v: &str) -> bool {
    let mut cs = v.chars();
    match cs.next() {
        Some(c) if c.is_ascii_alphanumeric() => {}
        _ => return false,
    }
    cs.all(|c| c.is_ascii_alphanumeric() || "._:/[]-".contains(c))
}

/// TS 의 zod 검사 + 같은 모델 합치기(차례 유지, effort 중복 제거).
pub fn parse(body: &Body) -> Parsed {
    let empty = serde_json::Map::new();
    let m = match body {
        Body::None | Body::Json(Value::Null) => &empty,
        Body::Json(Value::Object(m)) => m,
        _ => return Parsed::Bad,
    };
    let clear = match m.get("clearOutside") {
        None => false,
        Some(Value::Bool(b)) => *b,
        Some(_) => return Parsed::Bad,
    };
    let Some(Value::Array(models)) = m.get("models") else {
        return Parsed::Bad;
    };
    if models.len() > 20 {
        return Parsed::Bad;
    }
    let mut out: Vec<Entry> = Vec::new();
    for e in models {
        let Value::Object(e) = e else {
            return Parsed::Bad;
        };
        let model = match e.get("model") {
            Some(Value::String(s)) if (1..=MODEL_ID_MAX).contains(&js_len(s)) => s,
            _ => return Parsed::Bad,
        };
        let efforts: Vec<&String> = match e.get("efforts") {
            None => Vec::new(),
            Some(Value::Array(a)) if a.len() <= 8 => {
                let mut v = Vec::new();
                for x in a {
                    match x {
                        Value::String(s) if (1..=EFFORT_MAX).contains(&js_len(s)) => v.push(s),
                        _ => return Parsed::Bad,
                    }
                }
                v
            }
            _ => return Parsed::Bad,
        };
        let model = model.trim();
        if model.is_empty() {
            continue;
        }
        let idx = match out.iter().position(|x| x.model == model) {
            Some(i) => i,
            None => {
                out.push(Entry {
                    model: model.to_owned(),
                    efforts: Vec::new(),
                });
                out.len() - 1
            }
        };
        for x in efforts {
            let x = x.trim();
            if !x.is_empty() && !out[idx].efforts.iter().any(|y| y == x) {
                out[idx].efforts.push(x.to_owned());
            }
        }
    }
    if clear {
        return Parsed::Ts;
    }
    Parsed::Ok(out)
}

/// TS `pickAllowed`.
pub fn pick_allowed(list: &[Entry], model: Option<&str>, effort: Option<&str>) -> bool {
    let Some(model) = model else { return false };
    let Some(e) = list.iter().find(|e| e.model == model) else {
        return false;
    };
    effort.is_none_or(|x| e.efforts.iter().any(|y| y == x))
}

/// `[{model, efforts}]` — TS 키 차례 그대로.
pub fn models_json(list: &[Entry]) -> String {
    let items: Vec<String> = list
        .iter()
        .map(|e| {
            format!(
                "{{\"model\":{},\"efforts\":{}}}",
                Value::from(e.model.as_str()),
                Value::from(e.efforts.clone())
            )
        })
        .collect();
    format!("[{}]", items.join(","))
}

fn refuse(status: StatusCode, code: &str, msg: &str) -> Response {
    json_err(status, code, msg)
}

const OWNER: &str =
    "select c.owner_account_id::text from account a join agent_config c on c.account_id = a.id
 where a.id = $1::uuid and a.kind = 'agent' and a.deleted_at is null";
const SAVE: &str =
    "update agent_config set agent_pickable_models = $2::jsonb where account_id = $1::uuid";
const HELD: &str = "select t.model, t.effort
 from thread_agent_model t join message m on m.id = t.thread_root_id
 where t.agent_id = $1::uuid and t.set_by_kind = 'agent'
 for update of t";

/// `PUT /accounts/agents/{agentId}/pickable-models`.
pub async fn put(
    State(st): State<Arc<PickableModelsState>>,
    RequireAccount(me, _): RequireAccount,
    Path(agent_id): Path<String>,
    ConnectInfo(peer): ConnectInfo<SocketAddr>,
    req: Request,
) -> Response {
    let (parts, raw) = req.into_parts();
    let bytes = match to_bytes(raw, BODY_LIMIT).await {
        Ok(b) => b,
        Err(_) => {
            return json_err(
                StatusCode::PAYLOAD_TOO_LARGE,
                "fst_err_ctp_body_too_large",
                "Request body is too large",
            );
        }
    };
    let body = match crate::write::fastify_body(&parts.headers, &bytes) {
        Ok(b) => b,
        Err(r) => return r,
    };
    if !is_zod_uuid(&agent_id) {
        return json_err(
            StatusCode::BAD_REQUEST,
            "invalid_request",
            "params: invalid",
        );
    }
    if me.kind != "human" {
        return refuse(
            StatusCode::FORBIDDEN,
            "human_only",
            "허용 목록은 사람이 켠다",
        );
    }
    let models = match parse(&body) {
        Parsed::Ok(m) => m,
        Parsed::Bad => {
            return refuse(StatusCode::BAD_REQUEST, "bad_request", "invalid body");
        }
        Parsed::Ts => {
            return crate::proxy::forward(
                State(st.up.clone()),
                ConnectInfo(peer),
                Request::from_parts(parts, axum::body::Body::from(bytes)),
            )
            .await;
        }
    };
    if models
        .iter()
        .any(|e| !axis_valid(&e.model) || e.efforts.iter().any(|x| !axis_valid(x)))
    {
        return refuse(
            StatusCode::BAD_REQUEST,
            "bad_model_value",
            "모델·effort 는 영숫자로 시작하고 영숫자·._:/[]- 만 쓴다",
        );
    }
    let owner: Option<(Option<String>,)> = match sqlx::query_as(OWNER)
        .bind(&agent_id)
        .fetch_optional(&st.write)
        .await
    {
        Ok(r) => r,
        Err(e) => return internal(e),
    };
    let Some((owner,)) = owner else {
        return refuse(StatusCode::NOT_FOUND, "not_found", "no such agent");
    };
    if owner.as_deref() != Some(me.id.as_str()) {
        return refuse(
            StatusCode::FORBIDDEN,
            "owner_only",
            "이 에이전트의 소유자만 정한다",
        );
    }
    let list = models_json(&models);
    let outside = {
        let mut tx = match st.write.begin().await {
            Ok(t) => t,
            Err(e) => return internal(e),
        };
        if let Err(e) = sqlx::query(SAVE)
            .bind(&agent_id)
            .bind(&list)
            .execute(&mut *tx)
            .await
        {
            return internal(e);
        }
        let rows: Vec<(Option<String>, Option<String>)> = match sqlx::query_as(HELD)
            .bind(&agent_id)
            .fetch_all(&mut *tx)
            .await
        {
            Ok(r) => r,
            Err(e) => return internal(e),
        };
        if let Err(e) = tx.commit().await {
            return internal(e);
        }
        rows.iter()
            .filter(|(m, e)| !pick_allowed(&models, m.as_deref(), e.as_deref()))
            .count()
    };
    let ip = crate::writes_settings::ip_of(&parts, &st.trust);
    let detail_models: Value = serde_json::from_str(&list).unwrap_or(Value::Null);
    record_audit(
        &st.write,
        AuditEntry {
            action: "agent.pickable_models.set",
            actor_id: Some(&me.id),
            actor_handle: Some(&me.handle),
            target: Some(&agent_id),
            ip: ip.as_deref(),
            detail: json!({ "models": detail_models, "cleared": 0 }),
        },
    )
    .await;
    (
        StatusCode::OK,
        [(
            axum::http::header::CONTENT_TYPE,
            "application/json; charset=utf-8",
        )],
        format!("{{\"models\":{list},\"outside\":{outside},\"cleared\":0}}"),
    )
        .into_response()
}

pub fn routes(
    st: PickableModelsState,
    auth: crate::auth::AuthPools,
    cors: Arc<crate::cors::Cors>,
) -> crate::route_table::Routes<()> {
    use crate::route_table::Table;
    let t = Table::<Arc<PickableModelsState>>::new()
        .put("/accounts/agents/{agentId}/pickable-models", put)
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

    #[test]
    fn parse_merges_like_ts() {
        let b = Body::Json(json!({ "models": [
            { "model": " a ", "efforts": ["hi", " hi "] },
            { "model": "a", "efforts": ["lo"] },
            { "model": "  " },
            { "model": "b" }
        ]}));
        assert_eq!(
            parse(&b),
            Parsed::Ok(vec![
                Entry {
                    model: "a".into(),
                    efforts: vec!["hi".into(), "lo".into()]
                },
                Entry {
                    model: "b".into(),
                    efforts: vec![]
                },
            ])
        );
        assert_eq!(parse(&Body::None), Parsed::Bad);
        assert_eq!(
            parse(&Body::Json(json!({ "models": [], "clearOutside": true }))),
            Parsed::Ts
        );
        assert_eq!(
            parse(&Body::Json(json!({ "models": [{ "model": "" }] }))),
            Parsed::Bad
        );
    }

    #[test]
    fn axis_and_pick() {
        assert!(axis_valid("claude-opus-4[1m]"));
        assert!(!axis_valid("-x"));
        assert!(!axis_valid("a b"));
        let l = vec![Entry {
            model: "a".into(),
            efforts: vec!["hi".into()],
        }];
        assert!(pick_allowed(&l, Some("a"), None));
        assert!(pick_allowed(&l, Some("a"), Some("hi")));
        assert!(!pick_allowed(&l, Some("a"), Some("lo")));
        assert!(!pick_allowed(&l, None, None));
        assert_eq!(models_json(&l), r#"[{"model":"a","efforts":["hi"]}]"#);
    }
}
