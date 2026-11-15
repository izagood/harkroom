//! C4a-1 — `POST /mcp` 를 코어가 받는 자리. 게이트·본문 한도를 TS 와 같게 세운 뒤, Rust 가 답하는 도구([`served`], C4a-3 부터)가 아니면
//! 원래 바이트와 헤더를 그대로 TS 로 넘기고 답(SSE 포함)을 버퍼 없이 흘려 돌려준다([`crate::proxy::forward`]).
//!
//! 이 줄이 없을 때도 앞단은 `/mcp` 를 `fallback(forward)` 로 TS 에 넘겼다 — 그러니 이 단계의 값은 셋뿐이다:
//! 1. 에이전트가 아닌 요청을 **본문을 읽기 전에** 앞단에서 끊는다(TS `onRequest` 와 같은 401/403 `agent_only`).
//! 2. 본문을 TS 와 같은 한도로 모은다(넘으면 413, TS fastify 와 같은 꼴) — 다음 단계에서 [`super::dispatch`] 가 읽을 바이트.
//! 3. 갈라 보내는 자리([`served`] · [`super::dispatch`] · [`serve`]).
//!
//! 긴 폴(`inbox.poll` 이 서버에서 머무는 것)은 끊기지 않는다 — 상류 클라이언트(`proxy::Upstream`)와 앞단 서버 어디에도 요청 시간
//! 제한이 없다(TS 쪽 제한이 그대로 정본).
use crate::proxy::{self, Upstream};
use axum::body::{Body, to_bytes};
use axum::extract::{ConnectInfo, State};
use axum::http::{HeaderValue, Request, Response, StatusCode, header};
use std::net::SocketAddr;

/// TS `MCP_BODY_LIMIT_BYTES` = `2 * ARTIFACT_PUBLISH_ARG_MAX_BYTES(2MiB) + 512KiB` (mcpPlugin.ts · services/artifacts.ts).
pub const BODY_LIMIT: usize = 2 * 2 * 1024 * 1024 + 512 * 1024;

/// Rust 가 답하는 도구 — 읽기([`super::tools::SERVED`]) + 리액션 쓰기([`super::writes::SERVED`], C4b) + 기억 쓰기([`super::mem_writes::SERVED`], C4b B1a).
/// 기억 쓰기는 쓰기 풀이 있을 때만 갈림에 싣는다([`super::writes::McpWrites::memory`]).
pub fn served(mem_write: bool) -> &'static [&'static str] {
    static BASE: std::sync::OnceLock<Vec<&'static str>> = std::sync::OnceLock::new();
    static ALL: std::sync::OnceLock<Vec<&'static str>> = std::sync::OnceLock::new();
    if !mem_write {
        return BASE.get_or_init(|| {
            super::tools::SERVED
                .iter()
                .chain(super::writes::SERVED)
                .copied()
                .collect()
        });
    }
    ALL.get_or_init(|| {
        super::tools::SERVED
            .iter()
            .chain(super::writes::SERVED)
            .chain(super::grant_writes::SERVED)
            .chain(super::mem_writes::SERVED)
            .copied()
            .collect()
    })
}

/// 라우트 상태 — 상류(TS)와 읽기 풀.
#[derive(Clone)]
pub struct McpState {
    pub up: Upstream,
    pub pool: sqlx::PgPool,
    /// 쓰기 풀(C4b) — 도구 묶음마다 그 권한이 다 있을 때만. 없으면 그 묶음은 TS 가 답한다.
    pub writes: super::writes::McpWrites,
}

const AGENT_ONLY: &str = r#"{"error":{"code":"agent_only","message":"MCP surface requires an agent PAT or an operator assignment"}}"#;
/// fastify `FST_ERR_CTP_BODY_TOO_LARGE` 를 TS 오류 처리기(buildServer.ts)가 소문자 code 로 내보낸 꼴.
const TOO_LARGE: &str =
    r#"{"error":{"code":"fst_err_ctp_body_too_large","message":"Request body is too large"}}"#;

fn json(status: StatusCode, body: &'static str) -> Response<Body> {
    let mut r = Response::new(Body::from(body));
    *r.status_mut() = status;
    r.headers_mut().insert(
        header::CONTENT_TYPE,
        HeaderValue::from_static("application/json; charset=utf-8"),
    );
    r
}

pub async fn handle(
    State(McpState { up, pool, writes }): State<McpState>,
    ci: ConnectInfo<SocketAddr>,
    req: Request<Body>,
) -> Response<Body> {
    // 판정은 `auth::layer` 가 넣는다. 없으면 익명 — 열리는 쪽이 아니라 닫히는 쪽으로 틀린다.
    let auth = req
        .extensions()
        .get::<crate::auth::Auth>()
        .cloned()
        .unwrap_or_default();
    let has_operator = auth.operator.is_some();
    let me = match auth.account {
        Some(a) if a.kind == "agent" => a,
        Some(_) => return json(StatusCode::FORBIDDEN, AGENT_ONLY),
        None => return json(StatusCode::UNAUTHORIZED, AGENT_ONLY),
    };
    let (parts, body) = req.into_parts();
    // fastify 처럼 Content-Length 가 한도를 넘으면 읽지 않고 413. 길이가 없으면(chunked) 읽으며 센다.
    let declared = parts
        .headers
        .get(header::CONTENT_LENGTH)
        .and_then(|v| v.to_str().ok())
        .and_then(|v| v.parse::<u64>().ok());
    if declared.is_some_and(|n| n > BODY_LIMIT as u64) {
        return json(StatusCode::PAYLOAD_TOO_LARGE, TOO_LARGE);
    }
    let Ok(bytes) = to_bytes(body, BODY_LIMIT).await else {
        return json(StatusCode::PAYLOAD_TOO_LARGE, TOO_LARGE);
    };
    let cause = super::reads3::cause_from(&parts.headers);
    let runner = super::bg_claim::runner(has_operator, &parts.headers);
    let tools = |tool: &'static str, args: serde_json::Value| -> AnswerFut {
        let (pool, me, cause, writes) = (pool.clone(), me.clone(), cause.clone(), writes.clone());
        Box::pin(async move {
            if let Some(r) =
                super::grant_writes::answer(&pool, writes.grant.as_ref(), &me, tool, &args).await
            {
                return r;
            }
            if let Some(r) =
                super::writes::answer(&pool, &writes, &me, tool, &args, runner, cause.as_deref())
                    .await
            {
                return r;
            }
            if let Some(r) =
                super::mem_writes::answer(&pool, writes.memory.as_ref(), &me, tool, &args).await
            {
                return r;
            }
            super::tools::answer(&pool, &me, tool, &args, cause.as_deref()).await
        })
    };
    let served = served(writes.memory.is_some());
    if let Some(r) = serve(&up, ci, &parts.headers, &bytes, served, &tools).await {
        return r;
    }
    proxy::forward(State(up), ci, Request::from_parts(parts, Body::from(bytes))).await
}

pub type AnswerFut = std::pin::Pin<Box<dyn std::future::Future<Output = Option<String>> + Send>>;
/// Rust 가 도구를 답하는 함수의 꼴(도구 이름·인자) — 답은 `result` 의 JSON 글자. `None` 이면 답하지 않는다(TS 로).
pub type Answer<'f> = dyn Fn(&'static str, serde_json::Value) -> AnswerFut + Sync + 'f;

/// 한 요청을 Rust 가 답할 수 있으면 답을, 아니면 `None`(→ 원래 바이트를 TS 로). 순서: 갈림(`served`) → 전송 조건 → 입장 확인(TS) → 도구.
/// 입장 확인이 거절하면 그 거절을 도구 답으로 싣는다(TS 의 감싸기와 같은 결과). 확인을 못 하면 TS 로 넘긴다.
pub async fn serve(
    up: &Upstream,
    ci: ConnectInfo<SocketAddr>,
    headers: &axum::http::HeaderMap,
    bytes: &[u8],
    served: &[&str],
    answer: &Answer<'_>,
) -> Option<Response<Body>> {
    if served.is_empty() || !super::respond::transport_ok(headers) {
        return None;
    }
    let v = serde_json::from_slice::<serde_json::Value>(bytes).ok()?;
    let super::Dispatch::Rust(name) = super::dispatch(&v, served) else {
        return None;
    };
    // 알림(id 없음)은 SDK 가 202 로 받는다 — tools/call 은 요청이어야 하니 모양이 다르면 TS 로.
    let id = super::respond::id_text(v.get("id")?)?;
    // 없으면 `null` — 입력 스키마가 있는 도구는 SDK 가 검증 오류를 내므로(TS 로), 없는 도구만 받는다(`tools::no_input`).
    let args = v
        .pointer("/params/arguments")
        .cloned()
        .unwrap_or(serde_json::Value::Null);
    match super::respond::admit(up, ci, headers, name, &args).await {
        // `bg.claim` 은 TS 의 스위치가 켜졌다고 들었을 때만 — 아니면 TS 가 답한다(`disabled` 는 TS 가 정본).
        // 조건부로 싣는 도구(`delegation.close` — TS env 스위치)는 TS 가 「지금 싣는다」고 답했을 때만 Rust 가 답한다. 그 밖이면
        // TS 로 넘겨 TS 의 「도구 없음」 답을 그대로 낸다. 어떤 도구든 TS 가 거짓이라고 답하면 넘긴다.
        super::respond::Admit::Yes {
            bg_enabled,
            registered,
        } => {
            if (name == "bg.claim" && !bg_enabled)
                || registered == Some(false)
                || (super::writes::NEEDS_REGISTERED.contains(&name) && registered != Some(true))
            {
                return None;
            }
        }
        super::respond::Admit::No(text) => {
            return Some(super::respond::sse(
                &id,
                &super::respond::text_result(&text),
            ));
        }
        super::respond::Admit::Unknown => return None,
    }
    let result = answer(name, args).await?;
    Some(super::respond::sse(&id, &result))
}

/// 코어 라우터 줄 — 표(`route_table`)로 붙여 CORS 대조 목록에 실린다. 같은 경로의 다른 메서드는 `ts_fallback` 으로 TS.
pub fn routes(
    up: Upstream,
    pool: sqlx::PgPool,
    writes: super::writes::McpWrites,
    auth: crate::auth::AuthPools,
    cors: std::sync::Arc<crate::cors::Cors>,
) -> crate::route_table::Routes<()> {
    use crate::route_table::Table;
    let t = Table::<McpState>::new()
        .post("/mcp", handle)
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
        router: t.router.with_state(McpState { up, pool, writes }),
        http: t.http,
        sockets: t.sockets,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn body_limit_matches_ts_source() {
        let src = include_str!("../../../../../packages/server/src/mcp/mcpPlugin.ts");
        assert!(src.contains(
            "const MCP_BODY_LIMIT_BYTES = 2 * ARTIFACT_PUBLISH_ARG_MAX_BYTES + 512 * 1024;"
        ));
        let art = include_str!("../../../../../packages/server/src/services/artifacts.ts");
        assert!(art.contains("export const ARTIFACT_PUBLISH_ARG_MAX_BYTES = 2 * 1024 * 1024;"));
        assert_eq!(BODY_LIMIT, 4_718_592);
    }

    #[test]
    fn gate_message_matches_ts_source() {
        let src = include_str!("../../../../../packages/server/src/mcp/mcpPlugin.ts");
        assert!(src.contains(
            "{ error: { code: 'agent_only', message: 'MCP surface requires an agent PAT or an operator assignment' } }"
        ));
    }
}
