//! C4a-1 — `POST /mcp` 를 코어가 받는 자리. **아직 어떤 도구도 Rust 가 답하지 않는다**: 게이트·본문 한도를 TS 와 같게 세운 뒤
//! 원래 바이트와 헤더를 그대로 TS 로 넘기고 답(SSE 포함)을 버퍼 없이 흘려 돌려준다([`crate::proxy::forward`]).
//!
//! 이 줄이 없을 때도 앞단은 `/mcp` 를 `fallback(forward)` 로 TS 에 넘겼다 — 그러니 이 단계의 값은 셋뿐이다:
//! 1. 에이전트가 아닌 요청을 **본문을 읽기 전에** 앞단에서 끊는다(TS `onRequest` 와 같은 401/403 `agent_only`).
//! 2. 본문을 TS 와 같은 한도로 모은다(넘으면 413, TS fastify 와 같은 꼴) — 다음 단계에서 [`super::dispatch`] 가 읽을 바이트.
//! 3. 갈라 보내는 자리([`SERVED`] · [`super::dispatch`]). 지금 `SERVED` 는 비어 있어 모두 TS 다.
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

/// Rust 가 답하는 도구. 비어 있으면 본문을 해석하지도 않는다(모두 TS).
pub const SERVED: &[&str] = &[];

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
    State(up): State<Upstream>,
    ci: ConnectInfo<SocketAddr>,
    req: Request<Body>,
) -> Response<Body> {
    // 판정은 `auth::layer` 가 넣는다. 없으면 익명 — 열리는 쪽이 아니라 닫히는 쪽으로 틀린다.
    let auth = req
        .extensions()
        .get::<crate::auth::Auth>()
        .cloned()
        .unwrap_or_default();
    match &auth.account {
        Some(a) if a.kind == "agent" => {}
        Some(_) => return json(StatusCode::FORBIDDEN, AGENT_ONLY),
        None => return json(StatusCode::UNAUTHORIZED, AGENT_ONLY),
    }
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
    if let Some(r) = serve(&up, ci, &parts.headers, &bytes, SERVED, &answer).await {
        return r;
    }
    proxy::forward(State(up), ci, Request::from_parts(parts, Body::from(bytes))).await
}

/// Rust 가 도구를 답하는 함수의 꼴 — `None` 이면 답하지 않는다(TS 로).
pub type Answer = dyn Fn(&'static str, &serde_json::Value) -> Option<serde_json::Value> + Sync;

/// C4a-2: 아직 아무 도구도 답하지 않는다(C4a-3 에서 읽기 도구가 들어온다).
fn answer(_tool: &'static str, _args: &serde_json::Value) -> Option<serde_json::Value> {
    None
}

/// 한 요청을 Rust 가 답할 수 있으면 답을, 아니면 `None`(→ 원래 바이트를 TS 로). 순서: 갈림(`served`) → 전송 조건 → 입장 확인(TS) → 도구.
/// 입장 확인이 거절하면 그 거절을 도구 답으로 싣는다(TS 의 감싸기와 같은 결과). 확인을 못 하면 TS 로 넘긴다.
pub async fn serve(
    up: &Upstream,
    ci: ConnectInfo<SocketAddr>,
    headers: &axum::http::HeaderMap,
    bytes: &[u8],
    served: &[&str],
    answer: &Answer,
) -> Option<Response<Body>> {
    if served.is_empty() || !super::respond::transport_ok(headers) {
        return None;
    }
    let v = serde_json::from_slice::<serde_json::Value>(bytes).ok()?;
    let super::Dispatch::Rust(name) = super::dispatch(&v, served) else {
        return None;
    };
    // 알림(id 없음)은 SDK 가 202 로 받는다 — tools/call 은 요청이어야 하니 모양이 다르면 TS 로.
    let id = v.get("id").filter(|i| i.is_string() || i.is_number())?.clone();
    let args = v
        .pointer("/params/arguments")
        .cloned()
        .unwrap_or_else(|| serde_json::json!({}));
    match super::respond::admit(up, ci, headers, name, &args).await {
        super::respond::Admit::Yes => {}
        super::respond::Admit::No(result) => return Some(super::respond::sse(&id, &result)),
        super::respond::Admit::Unknown => return None,
    }
    let result = answer(name, &args)?;
    Some(super::respond::sse(&id, &result))
}

/// 코어 라우터 줄 — 표(`route_table`)로 붙여 CORS 대조 목록에 실린다. 같은 경로의 다른 메서드는 `ts_fallback` 으로 TS.
pub fn routes(
    up: Upstream,
    auth: crate::auth::AuthPools,
    cors: std::sync::Arc<crate::cors::Cors>,
) -> crate::route_table::Routes<()> {
    use crate::route_table::Table;
    let t = Table::<Upstream>::new()
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
        router: t.router.with_state(up),
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
