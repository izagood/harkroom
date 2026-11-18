//! S5.4 TM3 — `GET /agents/:agentId/model-options`. TS `routes/threadAgentModelRoutes.ts` 의 그 줄과 `agentModelOptions`
//! (`offeredModels` 스냅숏 갈래 · `readPickable`)를 옮긴다.
//!
//! - 순서(TS 와 같다): 인증(401) → 경로 zod uuid(400 `invalid_request`) → 사람만(403 `human_only`) → 없는 에이전트(404 `not_found`)
//!   → 200 `{ harness, model, effort, pickable, models? }`(그 키 순서).
//! - 하네스 목록은 **오퍼레이터 코어가 Rust 일 때만** 같은 답이다 — 그때 TS 허브는 비어 능력 스냅숏(`operator_capability`)만 읽는다.
//!   `main.rs` 는 오퍼레이터 코어가 켜졌을 때만 이 줄을 붙인다(MCP `agent.modelOptions` 와 같은 잠금).
//! - 읽기 풀만 쓴다([`AGENT_MODEL_OPTIONS_PRIVILEGES`]).
use super::mcp::model_options::{
    ASSIGNMENT_SQL, HarnessModel, OPTS_SQL, SNAPSHOT_FRESH_SEC, SNAPSHOT_SQL, models_in,
    read_pickable,
};
use crate::auth::RequireAccount;
use crate::directory::{internal, json_err, json_ok};
use axum::extract::{Path, State};
use axum::http::StatusCode;
use axum::response::Response;
use serde_json::{Value, json};
use sqlx::PgPool;
use std::sync::Arc;

/// 읽기 풀 권한 — 칸 단위.
pub const AGENT_MODEL_OPTIONS_PRIVILEGES: &[(&str, &str)] = &[
    ("account.id", "SELECT"),
    ("account.kind", "SELECT"),
    ("account.deleted_at", "SELECT"),
    ("agent_config.account_id", "SELECT"),
    ("agent_config.harness", "SELECT"),
    ("agent_config.model", "SELECT"),
    ("agent_config.effort", "SELECT"),
    ("agent_config.agent_pickable_models", "SELECT"),
    ("agent_assignment.agent_id", "SELECT"),
    ("agent_assignment.operator_id", "SELECT"),
    ("operator_capability.operator_id", "SELECT"),
    ("operator_capability.body", "SELECT"),
    ("operator_capability.seen_at", "SELECT"),
];

fn q(s: &str) -> String {
    Value::from(s).to_string()
}

fn opt(s: Option<&str>) -> String {
    s.map_or_else(|| "null".to_owned(), q)
}

/// TS `{ id, ...label, ...efforts }` 그 키 순서.
fn models_text(ms: &[HarnessModel]) -> String {
    let items: Vec<String> = ms
        .iter()
        .map(|m| {
            let mut s = format!("{{\"id\":{}", q(&m.id));
            if let Some(l) = &m.label {
                s.push_str(&format!(",\"label\":{}", q(l)));
            }
            if let Some(e) = &m.efforts {
                s.push_str(&format!(",\"efforts\":{}", json!(e)));
            }
            s.push('}');
            s
        })
        .collect();
    format!("[{}]", items.join(","))
}

/// TS `agentModelOptions` 의 몸통.
fn body_text(
    harness: &str,
    model: Option<&str>,
    effort: Option<&str>,
    pickable: &[(String, Vec<String>)],
    models: Option<&[HarnessModel]>,
) -> String {
    let picks: Vec<String> = pickable
        .iter()
        .map(|(m, e)| format!("{{\"model\":{},\"efforts\":{}}}", q(m), json!(e)))
        .collect();
    let mut s = format!(
        "{{\"harness\":{},\"model\":{},\"effort\":{},\"pickable\":[{}]",
        q(harness),
        opt(model),
        opt(effort),
        picks.join(",")
    );
    if let Some(ms) = models {
        s.push_str(&format!(",\"models\":{}", models_text(ms)));
    }
    s.push('}');
    s
}

pub async fn model_options(
    State(read): State<Arc<PgPool>>,
    RequireAccount(me, _): RequireAccount,
    Path(agent): Path<String>,
) -> Response {
    if !crate::lists::is_zod_uuid(&agent) {
        return json_err(
            StatusCode::BAD_REQUEST,
            "invalid_request",
            "params: invalid uuid",
        );
    }
    if me.kind != "human" {
        return json_err(
            StatusCode::FORBIDDEN,
            "human_only",
            "모델 지정은 사람만 바꾼다",
        );
    }
    let pool = read.as_ref();
    #[allow(clippy::type_complexity)]
    let row: Option<(
        Option<String>,
        Option<String>,
        Option<String>,
        Option<Value>,
    )> = match sqlx::query_as(OPTS_SQL)
        .bind(&agent)
        .fetch_optional(pool)
        .await
    {
        Ok(r) => r,
        Err(e) => return internal(e),
    };
    let Some((harness, model, effort, pickable)) = row else {
        return json_err(StatusCode::NOT_FOUND, "not_found", "no such agent");
    };
    let harness = harness.unwrap_or_else(|| "claude-code".into());
    let operator: Option<String> = match sqlx::query_scalar(ASSIGNMENT_SQL)
        .bind(&agent)
        .fetch_optional(pool)
        .await
    {
        Ok(o) => o,
        Err(e) => return internal(e),
    };
    let models = match operator {
        Some(op) => match sqlx::query_scalar::<_, Value>(SNAPSHOT_SQL)
            .bind(&op)
            .bind(SNAPSHOT_FRESH_SEC)
            .fetch_optional(pool)
            .await
        {
            Ok(b) => b.as_ref().and_then(|b| models_in(b, &harness)),
            Err(e) => return internal(e),
        },
        None => None,
    };
    json_ok(body_text(
        &harness,
        model.as_deref(),
        effort.as_deref(),
        &read_pickable(pickable.as_ref()),
        models.as_deref(),
    ))
}

pub fn routes(
    pool: PgPool,
    auth: crate::auth::AuthPools,
    cors: Arc<crate::cors::Cors>,
) -> crate::route_table::Routes<()> {
    use crate::route_table::Table;
    let t = Table::<Arc<PgPool>>::new()
        .get("/agents/{agentId}/model-options", model_options)
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
        router: t.router.with_state(Arc::new(pool)),
        http: t.http,
        sockets: t.sockets,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn body_key_order_like_ts() {
        let picks = vec![("opus".to_owned(), vec!["high".to_owned()])];
        assert_eq!(
            body_text("claude-code", None, Some("low"), &picks, None),
            r#"{"harness":"claude-code","model":null,"effort":"low","pickable":[{"model":"opus","efforts":["high"]}]}"#
        );
        let ms = vec![
            HarnessModel {
                id: "a".into(),
                label: Some("A".into()),
                efforts: None,
            },
            HarnessModel {
                id: "b".into(),
                label: None,
                efforts: Some(vec!["x".into()]),
            },
        ];
        assert_eq!(
            body_text("codex", Some("m"), None, &[], Some(&ms)),
            r#"{"harness":"codex","model":"m","effort":null,"pickable":[],"models":[{"id":"a","label":"A"},{"id":"b","efforts":["x"]}]}"#
        );
        assert!(body_text("h", None, None, &[], Some(&[])).ends_with(r#""models":[]}"#));
    }
}
