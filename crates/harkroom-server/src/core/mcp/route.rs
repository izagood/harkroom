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
    // P6-2c: 오퍼레이터가 잰 「정확한 명령」 파일 해시(TS `req.operator ? parseCommandFilesHeader(...) : null`).
    let command_files = command_files_header(has_operator, &parts.headers);
    let bg_job = (has_operator && bg_cause(&parts.headers))
        .then(|| bg_job_id(&parts.headers))
        .flatten();
    let tools = |tool: &'static str, args: serde_json::Value| -> AnswerFut {
        let bg_job = bg_job.clone();
        let (pool, me, cause, turn, writes, command_files) = (
            pool.clone(),
            me.clone(),
            cause.clone(),
            turn.clone(),
            writes.clone(),
            command_files.clone(),
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
            if tool == "permission.request" {
                // 거절 앞머리는 읽기 풀로, 받아들여지는 tool·merge 요청(P6-2a)은 글 올리기 풀로 카드까지.
                if let Some(r) = super::permission_request::answer(&pool, &me, &args).await {
                    return Some(r);
                }
                return super::permission_request::accept(
                    &pool,
                    writes.post.as_deref(),
                    &me,
                    &args,
                    (cause.as_deref(), turn.as_deref(), has_operator),
                    &command_files,
                )
                .await;
            }
            if tool == "message.ask" {
                // 거절 앞머리·스레드의 열린 카드 검사는 읽기 풀로, 다 지난 평범한 카드는 글 올리기 풀로([`super::message_ask::answer_plain`]).
                if let Some(r) = super::message_ask::answer(&pool, &me, &args).await {
                    return Some(r);
                }
                let r = super::message_ask::answer_plain(
                    &pool,
                    writes.post.as_deref(),
                    &me,
                    &args,
                    cause.as_deref(),
                    turn.as_deref(),
                    has_operator,
                )
                .await?;
                // Q1 그림자 — 카드가 선 뒤에 「이미 받은 것으로 할 수 있는 일인가」를 대조해 기록한다. 카드는 막지 않는다.
                return Some(
                    crate::core::self_serve::after_ask(
                        &pool,
                        &me.id,
                        me.kind == "agent",
                        &args,
                        r,
                        crate::core::self_serve::hint_on(crate::env_once::get(
                            &crate::env_once::ASK_SELF_SERVE,
                        )),
                    )
                    .await,
                );
            }
            if matches!(
                tool,
                "message.post"
                    | "message.fail"
                    | "message.report"
                    | "message.progress"
                    | "message.notice"
                    | "agent.call"
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
                            // 고르기 쓰기 권한(`AGENT_MODEL_PICKS_PRIVILEGES`)이 있으면 글과 같은 tx 에서 Rust 가 다 맡는다.
                            if let Some(ps) = writes.agent_picks.as_ref() {
                                return super::msg_post::answer_picks(
                                    ps,
                                    &me,
                                    &args,
                                    c,
                                    t,
                                    has_operator,
                                )
                                .await;
                            }
                            return super::msg_post::picks_refusal(st, &me, &args).await;
                        }
                        super::msg_post::answer(st, &me, &args, c, t, has_operator).await
                    }
                    // C1 — 대상을 `to` 인자로 받는 부름. 글 쓰기 풀(`message.post` 와 같은 권한)로 답한다.
                    "agent.call" => {
                        // U1 — 의무 있는 부름(`expect`)은 의무 쓰기 권한이 있을 때만, 모델 고르기는 하네스 목록·고르기 권한이 있을 때만.
                        let obligations = writes.delegate.is_some();
                        let picks_ok = writes.relay_moved && writes.agent_picks.is_some();
                        super::msg_post::answer_call(
                            st,
                            &me,
                            &args,
                            c,
                            t,
                            has_operator,
                            obligations,
                            picks_ok,
                        )
                        .await
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
            if tool == "message.askBundle"
                && args.get("bundleId").is_none()
                && let (Some(st), Some(bw)) = (writes.post.as_ref(), writes.bundle.as_ref())
            {
                // P6-4e — 새 묶음: 판정은 읽기 풀, 글은 글 올리기 풀, 커밋 뒤 알림·푸시는 묶음 권한 풀.
                let (c, t) = (cause.as_deref(), turn.as_deref());
                return super::msg_post::answer_bundle_new(st, bw, &me, &args, c, t, has_operator)
                    .await;
            }
            if tool == "artifact.publish"
                && let Some(aw) = writes.artifact.as_ref()
            {
                let (c, t) = (cause.as_deref(), turn.as_deref());
                return super::artifact_publish::publish(aw, &me, &args, c, t, has_operator).await;
            }
            if tool == "turn.wake" {
                // agent_wake 권한이 없으면 대기 줄을 세우기 전에 TS 로 넘긴다.
                let st = writes.wake.as_ref()?;
                let (c, t) = (cause.as_deref(), turn.as_deref());
                return super::turn_wake::answer(st, &me, &args, c, t, has_operator).await;
            }
            if tool == "message.delegate" {
                let st = writes.delegate.as_deref();
                // 비지 않은 `agentModels` 는 하네스 목록(스냅숏)과 고르기 쓰기 권한이 다 있을 때만 Rust 가 고른다.
                let picks_ok = writes.relay_moved && writes.agent_picks.is_some();
                return super::delegate_gate::answer(
                    &pool,
                    st,
                    picks_ok,
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
            // 백그라운드 회차의 기억 쓰기 — 상한 예약·변경 기록을 감싼다. 권한이 없으면 답하지 않는다(감싸기 없이 쓰지 않는다).
            if let Some(job) = bg_job
                .as_deref()
                .filter(|_| super::bg_write::is_write(tool))
            {
                let (mem, body, bg) = (
                    writes.memory.as_ref()?,
                    writes.memory_body.as_ref()?,
                    writes.bg_write.as_ref()?,
                );
                return super::bg_write::answer(
                    &pool,
                    mem,
                    body,
                    bg,
                    &me,
                    job,
                    turn.as_deref(),
                    tool,
                    &args,
                )
                .await;
            }
            // 회차의 정리 임대는 회차 시한까지만.
            let args = if bg_job.is_some() && tool == "memory.lease" {
                super::bg_write::lease_args(args)
            } else {
                args
            };
            if let Some(r) =
                super::mem_writes::answer(&pool, writes.memory.as_ref(), &me, tool, &args).await
            {
                return r;
            }
            if let Some(r) = super::mem_body::answer(
                &pool,
                writes.memory_body.as_ref(),
                &me,
                turn.as_deref().into(),
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
        bg_write: writes.bg_write.is_some(),
        cause_header: parts
            .headers
            .get("x-harkroom-cause")
            .and_then(|v| v.to_str().ok()),
        presence: writes.presence.get(),
        switches: writes.switches,
        read_pool: Some(&pool),
    };
    if let Some(r) = lifecycle_reply(&parts.headers, &bytes, &pre) {
        return r;
    }
    if let Some(r) = serve_pre(&up, ci, &parts.headers, &bytes, served, &tools, &pre).await {
        return r;
    }
    // Rust 가 답하지 않은 도구 호출 — 도구 이름과 인자 **키 이름**만 한 줄 남긴다(값·본문은 싣지 않는다). 예전에는 TS 로 넘겼다.
    // 이제 고정 코드로 닫는다([`super::ts_down::unsupported`]) — 운영 로그로 셀 수 있게, 어떤 인자 꼴이 빗나갔는지 바로 보이게.
    if let Some(name) = ts_tool_name(&bytes) {
        let keys = ts_arg_keys(&bytes);
        eprintln!(
            "front: mcp tool unsupported tool={name} agent={} keys={keys}",
            me.id
        );
    }
    let _ = (up, ci, parts);
    super::ts_down::unsupported(&bytes).unwrap_or_else(proxy::closed)
}

/// P2b — 도구 부르기가 아닌 본문(`initialize`·`ping`·`tools/list`·알림·그것들만 든 배치)을 Rust 가 답한다([`super::lifecycle`]).
/// TS 는 `/mcp` 요청마다 presence 를 mark 한다 — 그 표가 없으면 생존 신호를 잃으므로 답하지 않고 TS 로 넘긴다.
/// 전송 조건(Accept·Content-Type·판 헤더)이 SDK 와 다르면 그 거절 글자도 TS 가 낸다.
/// 본문이 `tools/call` 하나면 그 도구 이름(로그용, 128자까지·영숫자와 `._-` 만). 배치·그 밖의 메서드는 `None`.
fn ts_tool_name(bytes: &[u8]) -> Option<String> {
    let v: serde_json::Value = serde_json::from_slice(bytes).ok()?;
    if v.get("method").and_then(serde_json::Value::as_str) != Some("tools/call") {
        return None;
    }
    let name = v.pointer("/params/name")?.as_str()?;
    let ok = name.len() <= 128
        && name
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || matches!(c, '.' | '_' | '-'));
    Some(if ok { name.to_owned() } else { "?".to_owned() })
}

/// `tools/call` 본문의 `params.arguments` 키 이름들(값 없이) — 로그용. 키는 [`ts_tool_name`] 과 같은 글자(64자까지·영숫자와 `._-`)만,
/// 아니면 `?`. 16개까지 쉼표로 잇고 넘으면 `,…`. 인자가 없으면 `-`, 객체가 아니면 그 형(`null`·`array`·`string`·`number`·`boolean`).
fn ts_arg_keys(bytes: &[u8]) -> String {
    let Ok(v) = serde_json::from_slice::<serde_json::Value>(bytes) else {
        return "-".to_owned();
    };
    let o = match v.pointer("/params/arguments") {
        None => return "-".to_owned(),
        Some(serde_json::Value::Object(o)) => o,
        Some(serde_json::Value::Null) => return "null".to_owned(),
        Some(serde_json::Value::Array(_)) => return "array".to_owned(),
        Some(serde_json::Value::String(_)) => return "string".to_owned(),
        Some(serde_json::Value::Number(_)) => return "number".to_owned(),
        Some(serde_json::Value::Bool(_)) => return "boolean".to_owned(),
    };
    if o.is_empty() {
        return "{}".to_owned();
    }
    let clean = |k: &String| {
        let ok = !k.is_empty()
            && k.len() <= 64
            && k.chars()
                .all(|c| c.is_ascii_alphanumeric() || matches!(c, '.' | '_' | '-'));
        if ok { k.clone() } else { "?".to_owned() }
    };
    let mut out: Vec<String> = o.keys().take(16).map(clean).collect();
    if o.len() > 16 {
        out.push("…".to_owned());
    }
    out.join(",")
}

fn lifecycle_reply(
    headers: &axum::http::HeaderMap,
    bytes: &[u8],
    pre: &Pre<'_>,
) -> Option<Response<Body>> {
    let presence = pre.presence?;
    if !super::respond::transport_ok(headers) {
        return None;
    }
    let v = serde_json::from_slice::<serde_json::Value>(bytes).ok()?;
    // 도구 목록은 TS 가 지은 스냅숏 — 앞단에 `HARKROOM_DELEGATION_V2` 가 없으면 TS 기본값(꺼짐)의 목록을 싣는다.
    let tools_list = super::lifecycle::tools_list(pre.switches.delegation_v2);
    let reply = super::lifecycle::answer(&v, tools_list)?;
    presence.mark(pre.agent_id);
    Some(match reply {
        super::lifecycle::Reply::Accepted => super::respond::accepted(),
        super::lifecycle::Reply::Sse(body) => super::respond::sse_body(body),
    })
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
    "memory.lease",
    "thread.note",
    "thread.plan",
    "message.read",
    "bg.complete",
];

/// cause 헤더가 백그라운드 꼴(`bg:<uuid>`, TS `BG_CAUSE_RE` — `/i` 라 접두·hex 모두 대소문자를 가리지 않는다)인가. 값이 여럿이면 node 가 `, ` 로 이어 붙여 꼴이 깨진다 → 거짓.
pub fn bg_cause(headers: &axum::http::HeaderMap) -> bool {
    let mut it = headers.get_all("x-harkroom-cause").iter();
    let (Some(v), None) = (it.next(), it.next()) else {
        return false;
    };
    let Ok(v) = v.to_str() else {
        return false;
    };
    v.get(..3).is_some_and(|p| p.eq_ignore_ascii_case("bg:")) && is_uuid(&v[3..])
}

/// [`bg_cause`] 가 참인 헤더의 회차 id(소문자).
fn bg_job_id(headers: &axum::http::HeaderMap) -> Option<String> {
    let v = headers.get("x-harkroom-cause")?.to_str().ok()?;
    Some(v.get(3..)?.to_ascii_lowercase())
}

fn is_uuid(s: &str) -> bool {
    let b = s.as_bytes();
    b.len() == 36
        && b.iter().enumerate().all(|(i, c)| match i {
            8 | 13 | 18 | 23 => *c == b'-',
            _ => c.is_ascii_hexdigit(),
        })
}

/// TS `parseCommandFilesHeader` 에 넘기는 헤더 — 오퍼레이터를 거치지 않았으면 없음. 같은 이름이 둘 이상이면(fastify 는 배열 →
/// TS 판정 `null`) Rust 가 맞추지 않고 TS 에 맡긴다.
fn command_files_header(
    has_operator: bool,
    headers: &axum::http::HeaderMap,
) -> crate::core::permission_command::Header {
    use crate::core::permission_command::{COMMAND_FILES_HEADER, Header, parse_header};
    if !has_operator {
        return Header::Absent;
    }
    let mut all = headers.get_all(COMMAND_FILES_HEADER).iter();
    match (all.next(), all.next()) {
        (None, _) => Header::Absent,
        (Some(v), None) => parse_header(Some(v.as_bytes())),
        (Some(_), Some(_)) => Header::ToTs,
    }
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
    /// 회차의 기억 쓰기를 Rust 가 답하는가([`super::bg_write`]).
    pub bg_write: bool,
    /// cause 헤더 글자(`bg_cause` 가 참일 때 `bg:<uuid>`).
    pub cause_header: Option<&'a str>,
    /// P2 — 있으면 입장 확인을 Rust 가 끝까지 한다([`local_admit`]). 없으면 TS `/mcp/admit`.
    pub presence: Option<&'a std::sync::Arc<crate::core::relay_live::PresenceMark>>,
    pub switches: AdmitSwitches,
    /// 있으면 [`super::db_retry::COVERED`] 도구가 답하지 못했을 때 풀을 보고 다시 부른다([`super::db_retry`]). 없으면 곧바로 TS.
    pub read_pool: Option<&'a sqlx::PgPool>,
}

/// TS `/mcp/admit` 답의 조건부 칸을 정하는 env 두 개 — 값이 있을 때만 `Some`(TS 와 같은 판정). 없으면 그 도구는 TS 에 묻는다.
#[derive(Clone, Copy, Debug, Default, PartialEq)]
pub struct AdmitSwitches {
    /// TS `delegationV2Enabled` — `HARKROOM_DELEGATION_V2` 를 다듬어 소문자로 `1`·`on`·`true`.
    pub delegation_v2: Option<bool>,
    /// TS `backgroundEnabled` — `HARKROOM_BACKGROUND_ENABLED === '1'`.
    pub background: Option<bool>,
}

impl AdmitSwitches {
    /// env 값(없거나 비었으면 `None`)에서. TS 와 같은 글자 판정.
    pub fn from_values(delegation_v2: Option<&str>, background: Option<&str>) -> Self {
        fn set(v: Option<&str>) -> Option<&str> {
            v.filter(|v| !v.trim().is_empty())
        }
        Self {
            delegation_v2: set(delegation_v2)
                .map(|v| matches!(v.trim().to_ascii_lowercase().as_str(), "1" | "on" | "true")),
            background: set(background).map(|v| v == "1"),
        }
    }

    pub fn from_env() -> Self {
        Self::from_values(
            crate::env_once::get(&crate::env_once::DELEGATION_V2),
            crate::env_once::get(&crate::env_once::BACKGROUND_ENABLED),
        )
    }
}

/// P2 — TS `/mcp/admit` 의 끝부분(`bgEnabled`·`registered`)을 Rust 가 답한다. 앞부분(leakGuard·회차)은 [`pre_admit`] 이 이미 했다.
/// 다 할 수 없으면 `None`(→ TS 에 묻는다): presence 가 없다 · 비밀 값 검사를 Rust 가 못 했다(키링 없음 — TS 에 있을 수 있다) ·
/// 회차 요청인데 회차 상태를 못 읽었다 · TS 가 받지 않는 도구(`admit_refused`) · 그 도구의 스위치 env 가 없다.
fn local_admit(
    pre: &Pre<'_>,
    headers: &axum::http::HeaderMap,
    tool: &str,
) -> Option<super::respond::Admit> {
    pre.presence?;
    pre.leak?;
    if pre.bg_cause && (pre.bg_pool.is_none() || pre.cause_header.is_none()) {
        return None;
    }
    if admit_refused(tool, pre, headers) {
        return None;
    }
    switch_answer(pre.switches, tool)
}

/// TS `/mcp/admit` 의 마지막 두 줄과 같은 답 — `bg.claim` 은 `bgEnabled` 만, 나머지는 `registered`(`toolRegisteredNow`).
fn switch_answer(sw: AdmitSwitches, tool: &str) -> Option<super::respond::Admit> {
    let (bg_enabled, registered) = match tool {
        // 매일 기억 정리는 전역 스위치와 상관없이 집힌다 — 스위치는 `bg_claim::claim` 이 회차마다 본다.
        "bg.claim" => (true, None),
        "delegation.close" => (false, Some(sw.delegation_v2?)),
        _ => (false, Some(true)),
    };
    Some(super::respond::Admit::Yes {
        bg_enabled,
        registered,
    })
}

impl Pre<'static> {
    /// 앞부분을 하지 않는다(모두 TS `/mcp/admit`).
    pub const NONE: Pre<'static> = Pre {
        leak: None,
        agent_id: "",
        operator_id: None,
        bg_cause: false,
        bg_pool: None,
        bg_write: false,
        cause_header: None,
        presence: None,
        switches: AdmitSwitches {
            delegation_v2: None,
            background: None,
        },
        read_pool: None,
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
    if bg_write {
        // 회차 상태를 읽을 풀이 없으면 상태를 못 보니 받지 않는다.
        return pre.bg_cause && !(pre.bg_write && pre.bg_pool.is_some());
    }
    !runner_complete
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
    // 키링이 없는 가드: 이 에이전트에게 걸린 비밀이 없으면 검사할 것이 없다(TS 가드도 찾지 못한다). 있으면 키링이 있는 쪽(TS)에 묻는다.
    if let Some(g) = pre.leak.filter(|g| !g.is_on())
        && g.has_needles(pre.agent_id).await.map_err(|_| ())?
    {
        return Err(());
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
    if !super::respond::transport_ok(headers) {
        return None;
    }
    let v = serde_json::from_slice::<serde_json::Value>(bytes).ok()?;
    // SDK 는 어떤 처리기(입장 확인·leakGuard·회차 관문 포함)보다 먼저 zod 로 인자를 본다 — 같은 자리에서 같은 글자로 답한다.
    if let Some(r) = zod_reply(&v, pre) {
        return Some(r);
    }
    if served.is_empty() {
        return None;
    }
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
    let admitted = match local_admit(pre, headers, name) {
        Some(a) => {
            // TS 는 `/mcp`·`/mcp/admit` 에 온 요청마다 mark 한다 — Rust 가 답하는 요청도 같은 생존 신호다(묶어 쓴다).
            if let Some(p) = pre.presence {
                p.mark(pre.agent_id);
            }
            a
        }
        None => super::respond::admit(up, ci, headers, name, &args).await,
    };
    match admitted {
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
    let result = match pre
        .read_pool
        .filter(|_| super::db_retry::COVERED.contains(&name))
    {
        Some(pool) => super::db_retry::run(pool, name, || answer(name, args.clone())).await,
        None => answer(name, args).await,
    }?;
    log_invalid_params(Answerer::Handler, name, pre.agent_id, &result);
    Some(super::respond::sse(&id, &result))
}

/// `-32602` 인자 오류를 누가 냈나 — 공통 zod 갈래([`zod_reply`]) 또는 도구 처리기(예: `thread.note`·`message.read` 의 자체 검사).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum Answerer {
    Gate,
    Handler,
}

/// 도구 결과가 SDK 꼴 인자 오류(`MCP error -32602: …`, `isError: true`)인가. 본문 안 어딘가에 그 글자가 든 정상 결과(메시지 읽기 등)는
/// 아니다 — 결과의 첫 text 가 그 글자로 **시작**하고 `isError` 로 끝날 때만.
fn is_invalid_params(result: &str) -> bool {
    result.starts_with(r#"{"content":[{"type":"text","text":"MCP error -32602: "#)
        && result.ends_with(r#""isError":true}"#)
}

/// Rust 앞단이 `-32602` 로 답한 호출 한 줄 — 도구 이름·code·누가 답했나(gate/handler)·에이전트 id 만. 인자 값·이슈 글자는 싣지 않는다.
/// TS 로 넘긴 호출 줄(`front: mcp tool to TS …`)과 짝 — 운영 로그로 인자 오류 건수를 센다.
fn log_invalid_params(by: Answerer, tool: &str, agent: &str, result: &str) {
    if !is_invalid_params(result) {
        return;
    }
    let by = match by {
        Answerer::Gate => "gate",
        Answerer::Handler => "handler",
    };
    eprintln!("front: mcp invalid params tool={tool} code=-32602 by={by} agent={agent}");
}

/// 공통 인자 검증([`super::zod_gate`]) — 단일 `tools/call` 의 인자가 zod 가 거절할 꼴이면 SDK 와 같은 도구 오류로 답한다.
/// presence 가 있으면 TS 처럼 mark 한다. 없어도 답한다 — 거절될 호출 하나의 생존 신호보다, TS 를 끈 뒤에도 같은 답이 나가는 쪽이
/// 정본이다(그 에이전트의 다른 호출이 신호를 남긴다). 시험 줄([`serve`], `Pre::NONE`)도 같은 길을 탄다.
/// 조건부 등록 도구(`delegation.close`)는 앞단 스위치가 「싣는다」일 때만 — 아니면 TS 의 「도구 없음」 답을 그대로 둔다.
fn zod_reply(v: &serde_json::Value, pre: &Pre<'_>) -> Option<Response<Body>> {
    if v.get("method")?.as_str()? != "tools/call" {
        return None;
    }
    let id = super::respond::id_text(v.get("id")?)?;
    let name = v.pointer("/params/name")?.as_str()?;
    if name == "delegation.close" && pre.switches.delegation_v2 != Some(true) {
        return None;
    }
    let super::zod_gate::Verdict::Reject(text) =
        super::zod_gate::check(name, v.pointer("/params/arguments")?)
    else {
        return None;
    };
    if let Some(p) = pre.presence {
        p.mark(pre.agent_id);
    }
    log_invalid_params(Answerer::Gate, name, pre.agent_id, &text);
    Some(super::respond::sse(&id, &text))
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

    /// `-32602` 로그 줄은 SDK 인자 오류 꼴(머리로 시작·`isError:true` 로 끝)만 센다 — 본문에 같은 글자가 든 결과는 아니다.
    #[test]
    fn invalid_params_only_sdk_error_shape() {
        // zod 갈래·처리기가 내는 글자 그대로.
        let gate = match crate::core::mcp::zod_gate::check("memory.set", &serde_json::json!({})) {
            crate::core::mcp::zod_gate::Verdict::Reject(t) => t,
            other => panic!("{other:?}"),
        };
        assert!(is_invalid_params(&gate));
        // 위임 V2 스위치를 켠 앞단에서 `delegation.close` 인자 검사도 같은 zod 갈래 → 같은 줄로 센다.
        match crate::core::mcp::zod_gate::check("delegation.close", &serde_json::json!({})) {
            crate::core::mcp::zod_gate::Verdict::Reject(t) => assert!(is_invalid_params(&t)),
            other => panic!("{other:?}"),
        }
        assert!(is_invalid_params(&crate::core::mcp::note::sdk_invalid(
            "thread.note",
            &[("threadRootId", "Required".into())]
        )));
        // 정상 결과 본문 안에 같은 글자가 들어 있어도 세지 않는다.
        let inner = super::super::respond::text_result(
            "{\"body\":\"MCP error -32602: Input validation error\",\"isError\":true}",
        );
        assert!(!is_invalid_params(&inner));
        // 다른 도구 오류(isError)·정상 결과는 아니다.
        assert!(!is_invalid_params(
            r#"{"content":[{"type":"text","text":"forbidden"}],"isError":true}"#
        ));
        assert!(!is_invalid_params(&super::super::respond::text_result(
            "MCP error -32602: x"
        )));
    }

    /// 넘김 로그는 인자 키 이름만 — 값은 싣지 않는다.
    #[test]
    fn ts_arg_keys_names_only() {
        let call = br#"{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":"message.read","arguments":{"channelId":"secret-a","since":"59958","threadRootId":"secret-b"}}}"#;
        let got = ts_arg_keys(call);
        assert_eq!(got, "channelId,since,threadRootId");
        assert!(!got.contains("secret") && !got.contains("59958"));
        let k = |a: &str| {
            ts_arg_keys(
                format!(r#"{{"method":"tools/call","params":{{"name":"x"{a}}}}}"#).as_bytes(),
            )
        };
        assert_eq!(k(""), "-");
        assert_eq!(k(r#","arguments":null"#), "null");
        assert_eq!(k(r#","arguments":[1]"#), "array");
        assert_eq!(k(r#","arguments":{}"#), "{}");
        assert_eq!(k(r#","arguments":{"a b":1,"ok":2}"#), "?,ok");
        let many: Vec<String> = (0..20).map(|i| format!(r#""k{i:02}":0"#)).collect();
        let got = k(&format!(r#","arguments":{{{}}}"#, many.join(",")));
        assert_eq!(got.split(',').count(), 17);
        assert!(got.ends_with(",…"));
    }

    /// AC5 안전판 — `turn.cancel` 만 고르고, 다른 도구는 이 목록으로 Rust 에 오지 않는다.
    #[test]
    fn ts_tool_name_only_tools_call() {
        let call = br#"{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":"message.delegate","arguments":{"body":"secret"}}}"#;
        assert_eq!(ts_tool_name(call).as_deref(), Some("message.delegate"));
        let list = br#"{"jsonrpc":"2.0","id":1,"method":"tools/list"}"#;
        assert_eq!(ts_tool_name(list), None);
        let odd = br#"{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":"a b\nc"}}"#;
        assert_eq!(ts_tool_name(odd).as_deref(), Some("?"));
    }

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
        assert_eq!(BODY_LIMIT, 4_718_592);
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
        // TS `/i` — 접두도 대소문자를 가리지 않는다(security 메모 1).
        h.insert(
            "x-harkroom-cause",
            HeaderValue::from_static("BG:0123abcd-0123-4567-89ab-0123456789ab"),
        );
        assert!(bg_cause(&h));
        h.insert(
            "x-harkroom-cause",
            HeaderValue::from_static("Bg:0123abcd-0123-4567-89ab-0123456789ab"),
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
            bg_write: false,
            cause_header: None,
            presence: None,
            switches: AdmitSwitches::default(),
            read_pool: None,
        };
        let none = axum::http::HeaderMap::new();
        assert!(admit_refused("memory.set", &pre(true, true), &none));
        assert!(!admit_refused("memory.set", &pre(true, false), &none));
        assert!(!admit_refused("bg.complete", &pre(true, false), &none));
        assert!(admit_refused("bg.complete", &pre(false, false), &none));
        assert!(!admit_refused("message.read", &pre(true, true), &none));
    }

    #[test]
    fn admit_switches_mirror_ts() {
        // TS delegationV2Enabled: trim·소문자 → 1·on·true. backgroundEnabled: 정확히 '1'.
        let s = AdmitSwitches::from_values(Some(" ON "), Some("1"));
        assert_eq!((s.delegation_v2, s.background), (Some(true), Some(true)));
        let s = AdmitSwitches::from_values(Some("0"), Some("true"));
        assert_eq!((s.delegation_v2, s.background), (Some(false), Some(false)));
        let s = AdmitSwitches::from_values(None, Some("  "));
        assert_eq!((s.delegation_v2, s.background), (None, None));
    }

    #[test]
    fn switch_answer_mirrors_ts_admit_tail() {
        use super::super::respond::Admit;
        let on = AdmitSwitches {
            delegation_v2: Some(true),
            background: Some(false),
        };
        assert_eq!(
            switch_answer(on, "bg.claim"),
            Some(Admit::Yes {
                bg_enabled: true,
                registered: None
            })
        );
        assert_eq!(
            switch_answer(on, "delegation.close"),
            Some(Admit::Yes {
                bg_enabled: false,
                registered: Some(true)
            })
        );
        assert_eq!(
            switch_answer(on, "message.read"),
            Some(Admit::Yes {
                bg_enabled: false,
                registered: Some(true)
            })
        );
        // env 가 없으면 그 도구는 TS 에 묻는다.
        let unset = AdmitSwitches::default();
        assert!(switch_answer(unset, "bg.claim").is_some());
        assert_eq!(switch_answer(unset, "delegation.close"), None);
        assert!(switch_answer(unset, "memory.get").is_some());
    }

    #[test]
    fn local_admit_needs_presence_and_leak_guard() {
        let pre = Pre {
            switches: AdmitSwitches::from_values(Some("1"), Some("1")),
            ..Pre::NONE
        };
        // presence·비밀 값 검사가 없으면 TS 에 묻는다(TS 가 mark 하고 TS 키링으로 검사한다).
        assert!(local_admit(&pre, &axum::http::HeaderMap::new(), "message.read").is_none());
    }
}
