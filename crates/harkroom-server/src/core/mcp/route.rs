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
/// 본문 쓰기(set·merge·restore, C4b B1b)는 B1a 풀과 본문 풀이 둘 다 있을 때만 싣는다([`super::writes::McpWrites::memory_body`]).
pub fn served(mem_write: bool, mem_body: bool) -> &'static [&'static str] {
    static BASE: std::sync::OnceLock<Vec<&'static str>> = std::sync::OnceLock::new();
    static ALL: std::sync::OnceLock<Vec<&'static str>> = std::sync::OnceLock::new();
    static BODY: std::sync::OnceLock<Vec<&'static str>> = std::sync::OnceLock::new();
    if !mem_write {
        return BASE.get_or_init(|| {
            super::tools::SERVED
                .iter()
                .chain(super::writes::SERVED)
                .copied()
                .collect()
        });
    }
    if !mem_body {
        return ALL.get_or_init(|| {
            super::tools::SERVED
                .iter()
                .chain(super::writes::SERVED)
                .chain(super::grant_writes::SERVED)
                .chain(super::mem_writes::SERVED)
                .copied()
                .collect()
        });
    }
    BODY.get_or_init(|| {
        super::tools::SERVED
            .iter()
            .chain(super::writes::SERVED)
            .chain(super::grant_writes::SERVED)
            .chain(super::mem_writes::SERVED)
            .chain(super::mem_body::SERVED)
            .copied()
            .collect()
    })
}

/// 릴레이가 Rust 로 옮겨진 동안([`super::writes::McpWrites::relay_moved`]) Rust 가 답하는 도구([`super::turn_cancel`]).
pub const TURN_CANCEL: &[&str] = &["turn.cancel"];

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
    let turn = super::reads3::turn_from(&parts.headers);
    let runner = super::bg_claim::runner(has_operator, &parts.headers);
    let tools = |tool: &'static str, args: serde_json::Value| -> AnswerFut {
        let (pool, me, cause, turn, writes) = (
            pool.clone(),
            me.clone(),
            cause.clone(),
            turn.clone(),
            writes.clone(),
        );
        Box::pin(async move {
            if tool == "turn.cancel" {
                if !writes.relay_moved {
                    return None;
                }
                let Some(rc) = writes.relay.get() else {
                    return Some(
                        super::tool_error(
                            crate::core::operator_guard::CODE,
                            "this action is temporarily unavailable while the operator service is being moved",
                        )
                        .to_string(),
                    );
                };
                return super::turn_cancel::answer(&pool, rc, &me, &args).await;
            }
            if tool == "agent.modelOptions" {
                // 하네스 목록이 TS 허브(메모리)에 있는 동안은 TS 가 답한다.
                if !writes.relay_moved {
                    return None;
                }
                return super::model_options::answer(&pool, &me, &args).await;
            }
            if tool == "message.ask" {
                // 거절 앞머리는 읽기 풀로, 다 지난 평범한 카드는 글 올리기 풀로([`super::message_ask::answer_plain`]).
                if let Some(r) = super::message_ask::answer(&pool, &me, &args).await {
                    return Some(r);
                }
                let st = writes.post.as_ref()?;
                return super::message_ask::answer_plain(
                    st,
                    &me,
                    &args,
                    cause.as_deref(),
                    turn.as_deref(),
                    has_operator,
                )
                .await;
            }
            if matches!(
                tool,
                "message.post"
                    | "message.fail"
                    | "message.report"
                    | "message.progress"
                    | "message.notice"
            ) {
                let st = writes.post.as_ref()?;
                let (c, t) = (cause.as_deref(), turn.as_deref());
                return match tool {
                    "message.post" => {
                        // 비지 않은 모델 고르기는 거절 갈래만 Rust(하네스 목록이 스냅숏에 있을 때), 통과하면 TS.
                        if args
                            .get("agentModels")
                            .and_then(serde_json::Value::as_array)
                            .is_some_and(|a| !a.is_empty())
                        {
                            if !writes.relay_moved {
                                return None;
                            }
                            return super::msg_post::picks_refusal(st, &me, &args).await;
                        }
                        super::msg_post::answer(st, &me, &args, c, t, has_operator).await
                    }
                    "message.progress" => {
                        super::msg_post::answer_progress(st, &me, &args, c, t, has_operator).await
                    }
                    "message.notice" => {
                        super::msg_post::answer_notice(st, &me, &args, has_operator, runner).await
                    }
                    "message.fail" => {
                        super::msg_post::answer_fail(st, &me, &args, c, t, has_operator).await
                    }
                    _ => super::msg_post::answer_report(st, &me, &args, c, t, has_operator).await,
                };
            }
            if tool == "turn.wake" {
                // agent_wake 권한이 없으면 대기 줄을 세우기 전에 TS 로 넘긴다.
                let st = writes.wake.as_ref()?;
                let (c, t) = (cause.as_deref(), turn.as_deref());
                return super::turn_wake::answer(st, &me, &args, c, t, has_operator).await;
            }
            if tool == "message.delegate" {
                let st = writes.delegate.as_deref();
                return super::delegate_gate::answer(
                    &pool,
                    st,
                    &me,
                    &args,
                    cause.as_deref(),
                    turn.as_deref(),
                    has_operator,
                )
                .await;
            }
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
            if let Some(r) = super::mem_body::answer(
                &pool,
                writes.memory_body.as_ref(),
                &me,
                turn.as_deref(),
                tool,
                &args,
            )
            .await
            {
                return r;
            }
            super::tools::answer(&pool, &me, tool, &args, cause.as_deref()).await
        })
    };
    let relay_moved = writes.relay_moved;
    let served = if relay_moved
        && serde_json::from_slice::<serde_json::Value>(&bytes)
            .is_ok_and(|v| super::dispatch(&v, TURN_CANCEL) == super::Dispatch::Rust("turn.cancel"))
    {
        TURN_CANCEL
    } else {
        served(writes.memory.is_some(), writes.memory_body.is_some())
    };
    let pre = Pre {
        leak: writes.leak.as_deref(),
        agent_id: &me.id,
        operator_id: auth.operator.as_ref().map(|o| o.id.as_str()),
        bg_cause: has_operator && bg_cause(&parts.headers),
        bg_pool: writes.bg_complete.as_ref(),
        cause_header: parts
            .headers
            .get("x-harkroom-cause")
            .and_then(|v| v.to_str().ok()),
    };
    if let Some(r) = serve_pre(&up, ci, &parts.headers, &bytes, served, &tools, &pre).await {
        return r;
    }
    proxy::forward(State(up), ci, Request::from_parts(parts, Body::from(bytes))).await
}

/// 백그라운드 회차가 쓸 수 있는 도구 — TS `BG_ALLOWED_TOOLS`(설계 5절). 이 밖은 회차 상태를 보기 전에 거절한다.
pub const BG_ALLOWED_TOOLS: &[&str] = &[
    "memory.get",
    "memory.list",
    "memory.search",
    "memory.audit",
    "memory.set",
    "memory.archive",
    "memory.merge",
    "thread.note",
    "thread.plan",
    "message.read",
    "bg.complete",
];

/// cause 헤더가 백그라운드 꼴(`bg:<uuid>`, TS `BG_CAUSE_RE`)인가. 값이 여럿이면 node 가 `, ` 로 이어 붙여 꼴이 깨진다 → 거짓.
pub fn bg_cause(headers: &axum::http::HeaderMap) -> bool {
    let mut it = headers.get_all("x-harkroom-cause").iter();
    let (Some(v), None) = (it.next(), it.next()) else {
        return false;
    };
    let Ok(v) = v.to_str() else {
        return false;
    };
    v.get(..3).is_some_and(|p| p == "bg:") && is_uuid(&v[3..])
}

fn is_uuid(s: &str) -> bool {
    let b = s.as_bytes();
    b.len() == 36
        && b.iter().enumerate().all(|(i, c)| match i {
            8 | 13 | 18 | 23 => *c == b'-',
            _ => c.is_ascii_hexdigit(),
        })
}

/// 입장 확인 가운데 Rust 가 스스로 하는 앞부분(TS `/mcp/admit` 과 같은 순서 — leakGuard → 회차 허용 목록).
pub struct Pre<'a> {
    pub leak: Option<&'a crate::core::leak_guard::LeakGuard>,
    pub agent_id: &'a str,
    pub operator_id: Option<&'a str>,
    /// 오퍼레이터를 거쳤고 cause 가 `bg:<uuid>` 꼴이다(TS `bgMatch`).
    pub bg_cause: bool,
    /// 회차 상태를 읽을 풀 — `bg.complete` 쓰기 풀(`bg_job` SELECT 가 이미 있다). 없으면 회차 상태 확인은 TS `/mcp/admit`.
    pub bg_pool: Option<&'a sqlx::PgPool>,
    /// cause 헤더 글자(`bg_cause` 가 참일 때 `bg:<uuid>`).
    pub cause_header: Option<&'a str>,
}

impl Pre<'static> {
    /// 앞부분을 하지 않는다(모두 TS `/mcp/admit`).
    pub const NONE: Pre<'static> = Pre {
        leak: None,
        agent_id: "",
        operator_id: None,
        bg_cause: false,
        bg_pool: None,
        cause_header: None,
    };
}

/// TS `ADMIT_REFUSED`(회차 쓰기·회차 닫기) — 이 요청은 admit 이 400 으로 받지 않아 TS `/mcp` 가 답한다. 그 경우 Rust 도 앞부분을 하지 않는다.
fn admit_refused(tool: &str, pre: &Pre<'_>, headers: &axum::http::HeaderMap) -> bool {
    let bg_write = matches!(tool, "memory.set" | "memory.archive" | "memory.merge");
    if !bg_write && tool != "bg.complete" {
        return false;
    }
    let runner_complete = tool == "bg.complete"
        && pre.operator_id.is_some()
        && headers.get("x-harkroom-cause").is_none()
        && headers.get("x-harkroom-turn-id").is_none();
    !runner_complete && (pre.bg_cause || !bg_write)
}

/// 앞부분 판정 — `Some(답)` 이면 그 거절을 도구 답으로 싣는다. `Err(())` 은 확인을 못 했다(→ TS).
async fn pre_admit(
    pre: &Pre<'_>,
    headers: &axum::http::HeaderMap,
    tool: &str,
    args: &serde_json::Value,
) -> Result<Option<String>, ()> {
    if admit_refused(tool, pre, headers) {
        return Ok(None);
    }
    if let Some(g) = pre.leak.filter(|g| g.is_on()) {
        // TS 는 `arguments ?? {}` 를 본다 — null 이면 글이 없다.
        let texts = crate::secrets::leak::collect_strings(args);
        let hits = g
            .find_in_texts(pre.agent_id, &texts)
            .await
            .map_err(|_| ())?;
        if !hits.is_empty() {
            let who = crate::core::leak_guard::LeakActor {
                agent_id: pre.agent_id,
                agent_handle: None,
                operator_id: pre.operator_id,
                ip: None,
            };
            g.record(&who, &hits, &format!("mcp:{tool}"))
                .await
                .map_err(|_| ())?;
            let err = serde_json::json!({ "error": {
                "code": crate::core::leak_guard::SECRET_IN_BODY_CODE,
                "message": crate::core::leak_guard::SECRET_IN_BODY_MESSAGE,
            }});
            return Ok(Some(err.to_string()));
        }
    }
    if pre.bg_cause && !BG_ALLOWED_TOOLS.contains(&tool) {
        let err = serde_json::json!({ "error": {
            "code": "bg_tool_not_allowed",
            "message": format!("백그라운드 회차에서는 {tool} 을 쓸 수 없다"),
        }});
        return Ok(Some(err.to_string()));
    }
    if pre.bg_cause
        && let (Some(pool), Some(cause)) = (pre.bg_pool, pre.cause_header)
    {
        let job_id = cause[3..].to_ascii_lowercase();
        let row: Option<(String, String, Option<serde_json::Value>)> = sqlx::query_as(BG_JOB_SQL)
            .bind(&job_id)
            .fetch_optional(pool)
            .await
            .map_err(|_| ())?;
        return Ok(bg_gate_rest(pre.agent_id, row, tool, args).map(|e| e.to_string()));
    }
    Ok(None)
}

/// TS `getBgJob` 가운데 `bgGate` 가 보는 칸만.
const BG_JOB_SQL: &str =
    "select account_id::text, status, input->'threadIds' from bg_job where id = $1::uuid";

/// TS `bgGate` 의 허용 목록 뒤(회차 상태·입력 스레드·읽기 전용). 쓰기 도구의 상한 예약은 여기 오지 않는다(`ADMIT_REFUSED`).
fn bg_gate_rest(
    me: &str,
    row: Option<(String, String, Option<serde_json::Value>)>,
    tool: &str,
    args: &serde_json::Value,
) -> Option<serde_json::Value> {
    let refused = |code: &str, message: &str| {
        Some(serde_json::json!({ "error": { "code": code, "message": message } }))
    };
    let Some((_, _, threads)) = row.filter(|(a, s, _)| a == me && s == "running") else {
        return refused(
            "bg_job_not_running",
            "이 백그라운드 회차는 이미 닫혔거나 이 계정의 것이 아니다",
        );
    };
    if matches!(tool, "message.read" | "thread.note" | "thread.plan") {
        let root = args.get("threadRootId").and_then(serde_json::Value::as_str);
        let listed = threads
            .as_ref()
            .and_then(serde_json::Value::as_array)
            .is_some_and(|a| a.iter().any(|t| t.as_str().is_some() && t.as_str() == root));
        if root.is_none() || !listed {
            return refused(
                "bg_thread_not_in_input",
                "이 회차의 입력 스레드만 읽을 수 있다",
            );
        }
        if tool == "thread.note" && args.get("body").is_some() {
            return refused(
                "bg_note_read_only",
                "백그라운드 회차에서 스레드 메모는 읽기만 한다",
            );
        }
        if tool == "thread.plan" && args.get("plan").is_some() {
            return refused(
                "bg_plan_read_only",
                "백그라운드 회차에서 계획판은 읽기만 한다",
            );
        }
    }
    None
}

pub type AnswerFut = std::pin::Pin<Box<dyn std::future::Future<Output = Option<String>> + Send>>;
/// Rust 가 도구를 답하는 함수의 꼴(도구 이름·인자) — 답은 `result` 의 JSON 글자. `None` 이면 답하지 않는다(TS 로).
pub type Answer<'f> = dyn Fn(&'static str, serde_json::Value) -> AnswerFut + Sync + 'f;

/// 앞부분 없이([`Pre::NONE`]) [`serve_pre`] — 시험 줄이 쓴다.
pub async fn serve(
    up: &Upstream,
    ci: ConnectInfo<SocketAddr>,
    headers: &axum::http::HeaderMap,
    bytes: &[u8],
    served: &[&str],
    answer: &Answer<'_>,
) -> Option<Response<Body>> {
    serve_pre(up, ci, headers, bytes, served, answer, &Pre::NONE).await
}

/// 한 요청을 Rust 가 답할 수 있으면 답을, 아니면 `None`(→ 원래 바이트를 TS 로). 순서: 갈림(`served`) → 전송 조건 → 입장 확인(TS) → 도구.
/// 입장 확인이 거절하면 그 거절을 도구 답으로 싣는다(TS 의 감싸기와 같은 결과). 확인을 못 하면 TS 로 넘긴다.
pub async fn serve_pre(
    up: &Upstream,
    ci: ConnectInfo<SocketAddr>,
    headers: &axum::http::HeaderMap,
    bytes: &[u8],
    served: &[&str],
    answer: &Answer<'_>,
    pre: &Pre<'_>,
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
    // 앞부분(leakGuard·회차 허용 목록)은 Rust 가 한다. 거절이면 TS 에 묻지 않고 답한다(TS 가 다시 기록하지 않게).
    match pre_admit(pre, headers, name, &args).await {
        Ok(Some(text)) => {
            return Some(super::respond::sse(
                &id,
                &super::respond::text_result(&text),
            ));
        }
        Ok(None) => {}
        Err(()) => return None,
    }
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

    /// AC5 안전판 — `turn.cancel` 만 고르고, 다른 도구는 이 목록으로 Rust 에 오지 않는다.
    #[test]
    fn turn_cancel_list_picks_only_turn_cancel() {
        let call = |n: &str| serde_json::json!({"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":n,"arguments":{}}});
        assert_eq!(
            super::super::dispatch(&call("turn.cancel"), TURN_CANCEL),
            super::super::Dispatch::Rust("turn.cancel")
        );
        assert_eq!(
            super::super::dispatch(&call("turn.wake"), TURN_CANCEL),
            super::super::Dispatch::Ts
        );
    }

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
    fn bg_gate_head_matches_ts_source() {
        let src = include_str!("../../../../../packages/server/src/mcp/mcpPlugin.ts");
        let list = BG_ALLOWED_TOOLS
            .iter()
            .map(|t| format!("'{t}'"))
            .collect::<Vec<_>>()
            .join(", ");
        let norm = |s: &str| s.split_whitespace().collect::<Vec<_>>().join(" ");
        assert!(norm(src).contains(&format!("const BG_ALLOWED_TOOLS = new Set([ {list}, ]);")));
        assert!(src.contains(
            "refused('bg_tool_not_allowed', `백그라운드 회차에서는 ${toolName} 을 쓸 수 없다`)"
        ));
        assert!(src.contains("await leakGuard.record(null, req.account.id, req.operator?.id ?? null, hits, `mcp:${tool}`);"));
        assert!(src.contains("const ADMIT_REFUSED = new Set([...BG_WRITE_TOOLS, 'bg.complete']);"));
    }

    #[test]
    fn bg_gate_rest_mirrors_ts() {
        use serde_json::json;
        let row = |a: &str, s: &str| Some((a.to_owned(), s.to_owned(), Some(json!(["t1"]))));
        let code = |v: Option<serde_json::Value>| {
            v.map(|v| v["error"]["code"].as_str().unwrap().to_owned())
        };
        assert_eq!(
            code(bg_gate_rest("me", None, "memory.get", &json!({}))).as_deref(),
            Some("bg_job_not_running")
        );
        assert_eq!(
            code(bg_gate_rest(
                "me",
                row("x", "running"),
                "memory.get",
                &json!({})
            ))
            .as_deref(),
            Some("bg_job_not_running")
        );
        assert_eq!(
            code(bg_gate_rest(
                "me",
                row("me", "done"),
                "memory.get",
                &json!({})
            ))
            .as_deref(),
            Some("bg_job_not_running")
        );
        assert_eq!(
            code(bg_gate_rest(
                "me",
                row("me", "running"),
                "memory.get",
                &json!({})
            )),
            None
        );
        assert_eq!(
            code(bg_gate_rest(
                "me",
                row("me", "running"),
                "message.read",
                &json!({"threadRootId":"t2"})
            ))
            .as_deref(),
            Some("bg_thread_not_in_input")
        );
        assert_eq!(
            code(bg_gate_rest(
                "me",
                row("me", "running"),
                "message.read",
                &json!({"threadRootId":"t1"})
            )),
            None
        );
        assert_eq!(
            code(bg_gate_rest(
                "me",
                row("me", "running"),
                "thread.note",
                &json!({"threadRootId":"t1","body":null})
            ))
            .as_deref(),
            Some("bg_note_read_only")
        );
        assert_eq!(
            code(bg_gate_rest(
                "me",
                row("me", "running"),
                "thread.plan",
                &json!({"threadRootId":"t1","plan":"x"})
            ))
            .as_deref(),
            Some("bg_plan_read_only")
        );
        let src = include_str!("../../../../../packages/server/src/mcp/mcpPlugin.ts");
        for m in [
            "'bg_job_not_running', '이 백그라운드 회차는 이미 닫혔거나 이 계정의 것이 아니다'",
            "'bg_thread_not_in_input', '이 회차의 입력 스레드만 읽을 수 있다'",
            "'bg_note_read_only', '백그라운드 회차에서 스레드 메모는 읽기만 한다'",
            "'bg_plan_read_only', '백그라운드 회차에서 계획판은 읽기만 한다'",
        ] {
            assert!(src.contains(m), "{m}");
        }
    }

    #[test]
    fn bg_cause_shape() {
        let mut h = axum::http::HeaderMap::new();
        assert!(!bg_cause(&h));
        h.insert(
            "x-harkroom-cause",
            HeaderValue::from_static("bg:0123ABCD-0123-4567-89ab-0123456789ab"),
        );
        assert!(bg_cause(&h));
        h.append(
            "x-harkroom-cause",
            HeaderValue::from_static("bg:0123abcd-0123-4567-89ab-0123456789ab"),
        );
        assert!(!bg_cause(&h));
        h.insert(
            "x-harkroom-cause",
            HeaderValue::from_static("0123abcd-0123-4567-89ab-0123456789ab"),
        );
        assert!(!bg_cause(&h));
        h.insert(
            "x-harkroom-cause",
            HeaderValue::from_static("bg:0123abcd-0123-4567-89ab-0123456789abc"),
        );
        assert!(!bg_cause(&h));
    }

    #[test]
    fn admit_refused_mirrors_ts() {
        let pre = |op: bool, bg: bool| Pre {
            leak: None,
            agent_id: "a",
            operator_id: op.then_some("o"),
            bg_cause: bg,
            bg_pool: None,
            cause_header: None,
        };
        let none = axum::http::HeaderMap::new();
        assert!(admit_refused("memory.set", &pre(true, true), &none));
        assert!(!admit_refused("memory.set", &pre(true, false), &none));
        assert!(!admit_refused("bg.complete", &pre(true, false), &none));
        assert!(admit_refused("bg.complete", &pre(false, false), &none));
        assert!(!admit_refused("message.read", &pre(true, true), &none));
    }

    #[test]
    fn gate_message_matches_ts_source() {
        let src = include_str!("../../../../../packages/server/src/mcp/mcpPlugin.ts");
        assert!(src.contains(
            "{ error: { code: 'agent_only', message: 'MCP surface requires an agent PAT or an operator assignment' } }"
        ));
    }
}
