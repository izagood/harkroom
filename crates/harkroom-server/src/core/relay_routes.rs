//! 릴레이 라우트(TS `routes/agentRelayRoutes.ts` 의 세션 부분, S5.3 C6c-3). 아직 마운트하지 않는다 — 한 스위치(⑤)에서 붙인다.
//!
//!   GET  /agent-sessions                내가 볼 수 있는 진행 중 세션(`?scope=visible` 은 채널 가시성으로 넓힌다)
//!   POST /agent-sessions/{id}/attach     소유자·admin 판정 → 1회용 attach 티켓
//!   POST /agent-sessions/{id}/cancel     같은 판정 → 러너에 중단을 넘긴다(202)
//!   POST /agent-sessions/interactive     같은 판정 → 러너가 인터랙티브 PTY 를 연다 → 티켓
//!   GET  /agent-attach?ticket=…          뷰어 WS. Origin(4403)을 티켓 소모보다 먼저 본다
//!
//! 규칙은 TS 와 같다: 인가는 `check_owner_or_admin` 하나(TS `checkOwnerOrAdmin`), 감사에는 사건·세션 id 만 남기고 PTY 바이트·
//! 입력 바이트는 남기지 않는다(입력은 detach 행의 `inputBytes` 합 하나). 뷰어 소켓은 `/ws` 와 같은 자격증명 재검증(4401)과
//! ping/pong 을 받는다. `/agent-wakes` 는 `agent_wakes_read.rs`(S5.4), `/threads/{id}/report-wakes` 도 `agent_wakes_read.rs`.
use super::relay::{CancelOutcome, INTERACTIVE_OPEN_TIMEOUT, InteractiveOutcome, Session};
use super::relay_link::RelayLink;
use super::tickets::TicketStore;
use super::ws::{Timing, WorkerGuard, futures_split, origin_allowed, valid_credentials};
use crate::auth::{Account, Auth};
use crate::directory::{json_err, json_ok};
use crate::write::{AuditEntry, Body, read_body, record_audit};
use crate::writes_settings::ip_of;
use axum::extract::ws::{CloseFrame, Message, Utf8Bytes, WebSocket, WebSocketUpgrade};
use axum::extract::{Path, RawQuery, Request, State};
use axum::http::{HeaderMap, StatusCode};
use axum::response::Response;
use serde_json::{Map, Value, json};
use sqlx::PgPool;
use std::collections::{HashMap, HashSet};
use std::future::Future;
use std::pin::Pin;
use std::sync::atomic::AtomicUsize;
use std::sync::{Arc, Mutex, OnceLock};
use std::time::Duration;
use tokio::sync::mpsc;

/// 뷰어가 보내는 프레임(입력·resize·키 응답) 상한. TS 는 `ws` 기본(100MiB)이라 상한이 사실상 없다 — 붙여 넣기 한 번이 넘을 일이 없는 1MiB 로 막는다.
pub const MAX_VIEWER_FRAME: usize = 1024 * 1024;

/// 중단 뒤 그 스레드의 위임 의무·예약을 닫는 손잡이(TS `settleCanceledTurn`). 던지지 않는다.
pub type SettleCancel =
    Arc<dyn Fn(String, String) -> Pin<Box<dyn Future<Output = ()> + Send>> + Send + Sync>;

/// attach 티켓이 운반하는 것 — 인가 결정만(쓰기 차례는 허브가 산다).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct AttachClaim {
    pub account_id: String,
    pub credential_hash: String,
    pub session_id: String,
}

pub struct RelayCore {
    /// 읽기 풀(소유자·가시성 조회).
    pub pool: PgPool,
    /// 쓰기 풀(감사).
    pub write: PgPool,
    pub trust: Arc<crate::trust_proxy::TrustProxy>,
    pub link: RelayLink,
    pub tickets: TicketStore<AttachClaim>,
    pub allowed_origins: Option<Vec<String>>,
    pub timing: Timing,
    pub interactive_timeout: Duration,
    pub settle: SettleCancel,
    sockets: Mutex<HashMap<u64, (String, mpsc::UnboundedSender<()>)>>,
    workers: Arc<AtomicUsize>,
}

impl RelayCore {
    #[allow(clippy::too_many_arguments)]
    pub fn new(
        pool: PgPool,
        write: PgPool,
        trust: Arc<crate::trust_proxy::TrustProxy>,
        link: RelayLink,
        allowed_origins: Option<Vec<String>>,
        timing: Timing,
        settle: SettleCancel,
    ) -> Arc<Self> {
        let core = Arc::new(Self {
            pool,
            write,
            trust,
            link,
            tickets: TicketStore::new(Duration::from_secs(30)),
            allowed_origins,
            timing,
            interactive_timeout: INTERACTIVE_OPEN_TIMEOUT,
            settle,
            sockets: Mutex::new(HashMap::new()),
            workers: Arc::new(AtomicUsize::new(0)),
        });
        spawn_sweep(core.clone());
        core
    }

    fn lock_sockets(
        &self,
    ) -> std::sync::MutexGuard<'_, HashMap<u64, (String, mpsc::UnboundedSender<()>)>> {
        self.sockets.lock().unwrap_or_else(|e| e.into_inner())
    }
}

/// `/ws` 와 같은 재검증 — 무효가 된 자격증명의 뷰어는 4401 로 닫는다. 조회가 실패하면 아무것도 닫지 않는다.
fn spawn_sweep(core: Arc<RelayCore>) {
    tokio::spawn(async move {
        let mut tick = tokio::time::interval(core.timing.revalidate);
        tick.tick().await;
        loop {
            tick.tick().await;
            let hashes: Vec<String> = {
                let s = core.lock_sockets();
                s.values()
                    .map(|(h, _)| h.clone())
                    .collect::<HashSet<_>>()
                    .into_iter()
                    .collect()
            };
            if hashes.is_empty() {
                continue;
            }
            let Ok(valid) = valid_credentials(&core.pool, &hashes).await else {
                continue;
            };
            let valid: HashSet<String> = valid.into_iter().collect();
            core.lock_sockets().retain(|_, (h, tx)| {
                valid.contains(h) || {
                    let _ = tx.send(());
                    false
                }
            });
        }
    });
}

/// TS `checkOwnerOrAdmin` 의 판정 결과.
#[derive(Debug, PartialEq, Eq)]
pub enum Verdict {
    Owner,
    Admin,
    Refused(StatusCode, &'static str, &'static str),
}

/// 순수 판정 — `row` 는 `account left join agent_config` 의 결과(없음 = 계정 없음, Some(None) = 소유자 없음).
pub fn owner_verdict(me: &Account, row: Option<Option<String>>) -> Verdict {
    match row {
        None if me.is_admin => Verdict::Admin,
        None => Verdict::Refused(StatusCode::NOT_FOUND, "not_found", "no such agent"),
        Some(Some(o)) if o == me.id => Verdict::Owner,
        Some(_) if me.is_admin => Verdict::Admin,
        Some(None) => Verdict::Refused(
            StatusCode::FORBIDDEN,
            "forbidden",
            "owner required — this agent has no owner",
        ),
        Some(Some(_)) => Verdict::Refused(
            StatusCode::FORBIDDEN,
            "forbidden",
            "owner or admin required",
        ),
    }
}

/// TS `checkOwnerOrAdmin` — admin 이어도 조회를 건너뛰지 않는다(소유자 판정이 먼저).
pub async fn check_owner_or_admin(
    pool: &PgPool,
    me: &Account,
    agent: &str,
) -> Result<Verdict, sqlx::Error> {
    if !crate::lists::is_zod_uuid(agent) {
        return Ok(owner_verdict(me, None));
    }
    let row: Option<Option<String>> = sqlx::query_scalar(
        "select c.owner_account_id::text from account a left join agent_config c on c.account_id = a.id where a.id = $1::uuid",
    )
    .bind(agent)
    .fetch_optional(pool)
    .await?;
    Ok(owner_verdict(me, row))
}

pub(crate) async fn owned_agent_ids(pool: &PgPool, me: &str) -> Result<Vec<String>, sqlx::Error> {
    sqlx::query_scalar(
        "select account_id::text from agent_config where owner_account_id = $1::uuid",
    )
    .bind(me)
    .fetch_all(pool)
    .await
}

/// 이 채널들 가운데 이 사람이 볼 수 있는 것. 메시지와 같은 술어(TS 골든 `channelVisibleSql`). uuid 가 아닌 값은 보이지 않는 것으로 친다.
async fn visible_channel_ids(
    pool: &PgPool,
    me: &str,
    ids: &[String],
) -> Result<HashSet<String>, sqlx::Error> {
    let ids: Vec<String> = ids
        .iter()
        .filter(|i| crate::lists::is_zod_uuid(i))
        .cloned()
        .collect::<HashSet<_>>()
        .into_iter()
        .collect();
    if ids.is_empty() {
        return Ok(HashSet::new());
    }
    static SQL: OnceLock<String> = OnceLock::new();
    let sql = SQL.get_or_init(|| {
        let v: Value =
            serde_json::from_str(include_str!("../../golden/sql_fragments.json")).expect("golden");
        format!(
            "select c.id::text from channel c where c.id = any($2::uuid[]) and {}",
            v["channel_visible_c_p1uuid"].as_str().expect("c_p1")
        )
    });
    let rows: Vec<String> = sqlx::query_scalar(sql.as_str())
        .bind(me)
        .bind(&ids)
        .fetch_all(pool)
        .await?;
    Ok(rows.into_iter().collect())
}

pub(crate) fn wants_visible(raw: Option<&str>) -> bool {
    // TS `query.scope === 'visible'` — 같은 키가 둘이면 배열이라 아니다.
    let v: Vec<String> = crate::directory::form_pairs(raw.unwrap_or(""))
        .into_iter()
        .filter(|(k, _)| k == "scope")
        .map(|(_, v)| v)
        .collect();
    v.len() == 1 && v[0] == "visible"
}

/// `?scope=visible` 의 한 줄(TS `AgentActivityView`). 남의 에이전트 세션 id 는 싣지 않는다(attach·cancel 손잡이).
pub fn activity_view(s: &Session, owned: bool) -> Value {
    let mut o = Map::new();
    for k in [
        "agentAccountId",
        "channelId",
        "threadRootId",
        "harness",
        "startedAt",
    ] {
        o.insert(k.into(), s.get(k).cloned().unwrap_or(Value::Null));
    }
    if let Some(m) = s
        .get("mode")
        .filter(|m| !m.is_null() && m.as_str() != Some(""))
    {
        o.insert("mode".into(), m.clone());
    }
    o.insert("owned".into(), Value::Bool(owned));
    if owned {
        o.insert(
            "sessionId".into(),
            s.get("sessionId").cloned().unwrap_or(Value::Null),
        );
    }
    Value::Object(o)
}

fn internal() -> Response {
    json_err(
        StatusCode::INTERNAL_SERVER_ERROR,
        "internal",
        "internal error",
    )
}

fn str_of<'a>(s: &'a Session, k: &str) -> Option<&'a str> {
    s.get(k).and_then(Value::as_str)
}

/// GET `/agent-sessions`.
pub async fn list(State(core): State<Arc<RelayCore>>, req: Request) -> Response {
    let (parts, _) = req.into_parts();
    let Some(me) = parts
        .extensions
        .get::<Auth>()
        .and_then(|a| a.account.clone())
    else {
        return json_err(
            StatusCode::UNAUTHORIZED,
            "unauthorized",
            "authentication required",
        );
    };
    let hub = core.link.relay();
    if wants_visible(parts.uri.query()) {
        let all = hub.list_sessions(None);
        let (owned, visible) = if me.is_admin {
            (None, None)
        } else {
            let chans: Vec<String> = all
                .iter()
                .filter_map(|s| str_of(s, "channelId").map(str::to_owned))
                .collect();
            match (
                owned_agent_ids(&core.pool, &me.id).await,
                visible_channel_ids(&core.pool, &me.id, &chans).await,
            ) {
                (Ok(o), Ok(v)) => (Some(o.into_iter().collect::<HashSet<_>>()), Some(v)),
                _ => return internal(),
            }
        };
        let sessions: Vec<Value> = all
            .iter()
            .filter(|s| {
                visible
                    .as_ref()
                    .is_none_or(|v| str_of(s, "channelId").is_some_and(|c| v.contains(c)))
            })
            .map(|s| {
                let mine = owned
                    .as_ref()
                    .is_none_or(|o| str_of(s, "agentAccountId").is_some_and(|a| o.contains(a)));
                activity_view(s, mine)
            })
            .collect();
        return json_ok(json!({ "sessions": sessions }).to_string());
    }
    let sessions = if me.is_admin {
        hub.list_sessions(None)
    } else {
        match owned_agent_ids(&core.pool, &me.id).await {
            Ok(ids) => hub.list_sessions(Some(&ids)),
            Err(_) => return internal(),
        }
    };
    json_ok(json!({ "sessions": sessions }).to_string())
}

fn not_found_session() -> Response {
    json_err(StatusCode::NOT_FOUND, "not_found", "no such session")
}

/// 세션 id 로 오는 문(attach·cancel)의 앞부분 — 등록이 끝나기를 기다리고, 세션을 찾고, 인가한다.
#[allow(clippy::result_large_err)]
async fn gate(core: &RelayCore, me: &Account, sid: &str) -> Result<Session, Response> {
    core.link.all_settled().await;
    let Some(session) = core.link.relay().get_session(sid) else {
        return Err(not_found_session());
    };
    let agent = str_of(&session, "agentAccountId").unwrap_or("").to_owned();
    match check_owner_or_admin(&core.pool, me, &agent).await {
        Ok(Verdict::Refused(st, code, msg)) => Err(json_err(st, code, msg)),
        Ok(_) => Ok(session),
        Err(_) => Err(internal()),
    }
}

#[allow(clippy::result_large_err)] // 거절이 곧 axum 응답이다(write.rs 와 같은 수용).
fn me_and_hash(parts: &axum::http::request::Parts) -> Result<(Account, String), Response> {
    let auth = parts.extensions.get::<Auth>().cloned().unwrap_or_default();
    match (auth.account, auth.credential_hash) {
        (Some(a), Some(h)) => Ok((a, h)),
        _ => Err(json_err(
            StatusCode::UNAUTHORIZED,
            "unauthorized",
            "authentication required",
        )),
    }
}

async fn audit(
    core: &RelayCore,
    parts: &axum::http::request::Parts,
    me: &Account,
    action: &str,
    target: &str,
    detail: Value,
) {
    let ip = ip_of(parts, &core.trust);
    record_audit(
        &core.write,
        AuditEntry {
            action,
            actor_id: Some(&me.id),
            actor_handle: Some(&me.handle),
            target: Some(target),
            ip: ip.as_deref(),
            detail,
        },
    )
    .await;
}

/// POST `/agent-sessions/{id}/attach`.
pub async fn attach(
    State(core): State<Arc<RelayCore>>,
    Path(id): Path<String>,
    req: Request,
) -> Response {
    let (parts, _) = req.into_parts();
    let (me, hash) = match me_and_hash(&parts) {
        Ok(v) => v,
        Err(r) => return r,
    };
    let session = match gate(&core, &me, &id).await {
        Ok(s) => s,
        Err(r) => return r,
    };
    let sid = str_of(&session, "sessionId").unwrap_or("").to_owned();
    let agent = str_of(&session, "agentAccountId").unwrap_or("").to_owned();
    let channel = session.get("channelId").cloned().unwrap_or(Value::Null);
    audit(
        &core,
        &parts,
        &me,
        "agent.attached",
        &agent,
        json!({ "sessionId": sid, "channelId": channel }),
    )
    .await;
    let ticket = core.tickets.issue(AttachClaim {
        account_id: me.id,
        credential_hash: hash,
        session_id: sid,
    });
    json_ok(json!({ "ticket": ticket, "session": session }).to_string())
}

/// POST `/agent-sessions/{id}/cancel` — 202 는 「넘겼다」이지 「끝났다」가 아니다.
pub async fn cancel(
    State(core): State<Arc<RelayCore>>,
    Path(id): Path<String>,
    req: Request,
) -> Response {
    let (parts, _) = req.into_parts();
    let Some(me) = parts
        .extensions
        .get::<Auth>()
        .and_then(|a| a.account.clone())
    else {
        return json_err(
            StatusCode::UNAUTHORIZED,
            "unauthorized",
            "authentication required",
        );
    };
    let session = match gate(&core, &me, &id).await {
        Ok(s) => s,
        Err(r) => return r,
    };
    let sid = str_of(&session, "sessionId").unwrap_or("").to_owned();
    let agent = str_of(&session, "agentAccountId").unwrap_or("").to_owned();
    match core.link.relay().cancel_session(&sid, &me.handle) {
        CancelOutcome::Ok => {}
        CancelOutcome::NotFound => return not_found_session(),
        CancelOutcome::NoRunner => {
            return json_err(
                StatusCode::CONFLICT,
                "no_runner",
                "that agent has no runner attached — nothing can be signalled",
            );
        }
        CancelOutcome::RunnerOutdated => {
            return json_err(
                StatusCode::CONFLICT,
                "runner_outdated",
                "that runner is too old to stop a turn — update it",
            );
        }
    }
    if let Some(thread) = str_of(&session, "threadRootId") {
        (core.settle)(thread.to_owned(), agent.clone()).await;
    }
    let channel = session.get("channelId").cloned().unwrap_or(Value::Null);
    audit(
        &core,
        &parts,
        &me,
        "agent.turn.canceled",
        &agent,
        // 스레드까지 적는다 — 턴 끝 판정이 같은 채널의 다른 스레드 턴과 가른다.
        json!({
            "sessionId": sid, "channelId": channel,
            "threadRootId": session.get("threadRootId").cloned().unwrap_or(Value::Null),
        }),
    )
    .await;
    let mut r = json_ok(json!({ "ok": true }).to_string());
    *r.status_mut() = StatusCode::ACCEPTED;
    r
}

/// POST `/agent-sessions/interactive`.
pub async fn interactive(State(core): State<Arc<RelayCore>>, req: Request) -> Response {
    let (parts, body) = req.into_parts();
    let (me, hash) = match me_and_hash(&parts) {
        Ok(v) => v,
        Err(r) => return r,
    };
    let body = match read_body(&parts.headers, body).await {
        Ok(b) => b,
        Err(r) => return r,
    };
    let field = |k: &str| match &body {
        Body::Json(Value::Object(o)) => o.get(k).and_then(Value::as_str).map(str::to_owned),
        _ => None,
    };
    let (Some(agent), Some(channel), Some(thread)) = (
        field("agentAccountId"),
        field("channelId"),
        field("threadRootId"),
    ) else {
        return json_err(
            StatusCode::BAD_REQUEST,
            "bad_request",
            "agentAccountId, channelId, threadRootId 가 모두 필요하다",
        );
    };
    match check_owner_or_admin(&core.pool, &me, &agent).await {
        Ok(Verdict::Refused(st, code, msg)) => return json_err(st, code, msg),
        Ok(_) => {}
        Err(_) => return internal(),
    }
    core.link.settled(&agent).await;
    let out = core
        .link
        .relay()
        .open_interactive(
            &agent,
            &channel,
            &thread,
            &me.handle,
            None,
            core.interactive_timeout,
        )
        .await;
    let (sid, created) = match out {
        InteractiveOutcome::Opened {
            session_id,
            created,
        } => (session_id, created),
        InteractiveOutcome::NoRunner => {
            return json_err(
                StatusCode::NOT_FOUND,
                "no_runner",
                "러너가 접속해 있지 않다 — 이 에이전트의 러너를 먼저 띄워라",
            );
        }
        InteractiveOutcome::RunnerOutdated => {
            return json_err(
                StatusCode::CONFLICT,
                "runner_outdated",
                "러너가 인터랙티브 열기를 지원하지 않는 버전이다 — 러너를 업데이트해라",
            );
        }
        InteractiveOutcome::RunnerRejected(m) => {
            let m = m.unwrap_or_else(|| "러너가 인터랙티브 열기를 거절했다".into());
            return json_err(StatusCode::CONFLICT, "interactive_rejected", &m);
        }
        InteractiveOutcome::RunnerTimeout => {
            return json_err(
                StatusCode::GATEWAY_TIMEOUT,
                "runner_timeout",
                "러너가 제때 응답하지 않았다 — 러너 로그를 확인해라",
            );
        }
    };
    let Some(session) = core.link.relay().get_session(&sid) else {
        return json_err(
            StatusCode::GATEWAY_TIMEOUT,
            "runner_timeout",
            "러너가 세션을 등록하지 않았다 — 러너 로그를 확인해라",
        );
    };
    audit(
        &core,
        &parts,
        &me,
        "agent.interactive.opened",
        &agent,
        json!({ "sessionId": sid, "channelId": channel, "threadRootId": thread, "created": created }),
    )
    .await;
    let ticket = core.tickets.issue(AttachClaim {
        account_id: me.id,
        credential_hash: hash,
        session_id: sid,
    });
    json_ok(json!({ "ticket": ticket, "session": session }).to_string())
}

/// GET `/agent-attach?ticket=…[&mode=control]`.
pub async fn upgrade(
    State(core): State<Arc<RelayCore>>,
    headers: HeaderMap,
    RawQuery(raw): RawQuery,
    ws: WebSocketUpgrade,
) -> Response {
    let origin = headers
        .get("origin")
        .and_then(|v| v.to_str().ok())
        .map(str::to_owned);
    let pairs = crate::directory::form_pairs(raw.as_deref().unwrap_or(""));
    let one = |key: &str| {
        let v: Vec<&String> = pairs
            .iter()
            .filter(|(k, _)| k == key)
            .map(|(_, v)| v)
            .collect();
        (v.len() == 1).then(|| v[0].clone())
    };
    let ticket = one("ticket");
    let control = one("mode").as_deref() == Some("control");
    ws.max_message_size(MAX_VIEWER_FRAME)
        .max_frame_size(MAX_VIEWER_FRAME)
        .on_upgrade(move |socket| run(core, socket, origin, ticket, control))
}

async fn close(mut socket: WebSocket, code: u16, reason: &'static str) {
    let _ = socket
        .send(Message::Close(Some(CloseFrame {
            code,
            reason: Utf8Bytes::from_static(reason),
        })))
        .await;
}

fn next_id() -> u64 {
    static N: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(1);
    N.fetch_add(1, std::sync::atomic::Ordering::Relaxed)
}

async fn run(
    core: Arc<RelayCore>,
    socket: WebSocket,
    origin: Option<String>,
    ticket: Option<String>,
    control: bool,
) {
    // Origin 을 티켓 소모보다 먼저 — 거절할 연결이 1회용 티켓을 태우지 않게.
    if !origin_allowed(core.allowed_origins.as_deref(), origin.as_deref()) {
        return close(socket, 4403, "origin not allowed").await;
    }
    let Some(claim) = ticket.as_deref().and_then(|t| core.tickets.consume(t)) else {
        return close(socket, 4401, "unauthorized").await;
    };
    let id = next_id();
    let (kill_tx, mut kill_rx) = mpsc::unbounded_channel::<()>();
    core.lock_sockets()
        .insert(id, (claim.credential_hash.clone(), kill_tx));
    let (vtx, mut vrx) = mpsc::unbounded_channel::<String>();
    let viewer = core
        .link
        .relay()
        .add_viewer(&claim.session_id, vtx, control);
    let (mut sink, mut stream, worker) = futures_split(
        socket,
        core.timing.send_timeout,
        WorkerGuard::new(&core.workers),
    );
    let mut ping = tokio::time::interval(core.timing.heartbeat);
    ping.tick().await;
    let mut answered = true;
    loop {
        tokio::select! {
            _ = kill_rx.recv() => { sink.close(4401, "credential no longer valid"); break; }
            f = vrx.recv() => match f {
                Some(t) => { if !sink.push(Message::Text(t.into())) { sink.close(1013, "lagged"); break; } }
                None => break,
            },
            _ = ping.tick() => {
                if !answered { break; }
                answered = false;
                if !sink.push(Message::Ping(Default::default())) { break; }
            },
            m = stream.recv() => match m {
                Some(Ok(Message::Pong(_))) => answered = true,
                Some(Ok(Message::Text(t))) => { viewer.handle_message(t.as_str()); }
                Some(Ok(Message::Close(_))) | None | Some(Err(_)) => break,
                Some(Ok(_)) => {}
            },
        }
    }
    let input_bytes = viewer.input_bytes();
    viewer.close();
    core.lock_sockets().remove(&id);
    // detach 도 남긴다 — 개입 사실은 입력 바이트 합 하나로만(내용 없음, base64 길이 산술).
    record_audit(
        &core.write,
        AuditEntry {
            action: "agent.detached",
            actor_id: Some(&claim.account_id),
            actor_handle: None,
            target: None,
            ip: None,
            detail: json!({ "sessionId": claim.session_id, "inputBytes": input_bytes }),
        },
    )
    .await;
    drop(sink);
    let mut worker = worker;
    if tokio::time::timeout(core.timing.send_timeout, &mut worker)
        .await
        .is_err()
    {
        worker.abort();
    }
}

/// 라우트 묶음. 아직 `main.rs` 에 붙이지 않는다(⑤ 한 스위치).
pub fn routes(
    core: Arc<RelayCore>,
    auth: crate::auth::AuthPools,
    cors: Arc<crate::cors::Cors>,
) -> crate::route_table::Routes<()> {
    use crate::route_table::Table;
    let auth_layer = || axum::middleware::from_fn_with_state(auth.clone(), crate::auth::layer);
    let rest = Table::<Arc<RelayCore>>::new()
        .get("/agent-sessions", list)
        .post("/agent-sessions/interactive", interactive)
        .post("/agent-sessions/{id}/attach", attach)
        .post("/agent-sessions/{id}/cancel", cancel)
        .map(|r| {
            r.route_layer(auth_layer())
                .layer(axum::middleware::from_fn_with_state(
                    cors,
                    crate::cors::layer,
                ))
        });
    let t = Table::<Arc<RelayCore>>::new()
        .socket("/agent-attach", upgrade)
        .merge(rest)
        .finish();
    crate::route_table::Routes {
        router: t.router.with_state(core),
        http: t.http,
        sockets: t.sockets,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn acct(id: &str, admin: bool) -> Account {
        Account {
            id: id.into(),
            handle: "h".into(),
            display_name: String::new(),
            kind: "human".into(),
            is_admin: admin,
            role: "member".into(),
            status: "active".into(),
            status_text: None,
            avatar_attachment_id: None,
        }
    }

    #[test]
    fn owner_verdict_matches_ts() {
        let me = acct("me", false);
        let adm = acct("me", true);
        assert_eq!(owner_verdict(&me, Some(Some("me".into()))), Verdict::Owner);
        assert_eq!(
            owner_verdict(&adm, Some(Some("me".into()))),
            Verdict::Owner,
            "소유자 판정이 admin 보다 먼저"
        );
        assert_eq!(owner_verdict(&adm, Some(Some("x".into()))), Verdict::Admin);
        assert_eq!(
            owner_verdict(&adm, None),
            Verdict::Admin,
            "없는 대상: admin 은 통과(라우트가 404)"
        );
        assert!(matches!(
            owner_verdict(&me, None),
            Verdict::Refused(StatusCode::NOT_FOUND, "not_found", _)
        ));
        assert!(
            matches!(owner_verdict(&me, Some(None)), Verdict::Refused(StatusCode::FORBIDDEN, _, m) if m.contains("no owner"))
        );
        assert!(matches!(
            owner_verdict(&me, Some(Some("x".into()))),
            Verdict::Refused(StatusCode::FORBIDDEN, "forbidden", _)
        ));
    }

    #[test]
    fn visible_scope_hides_foreign_session_id() {
        let mut s = Session::new();
        for (k, v) in [
            ("sessionId", "s1"),
            ("agentAccountId", "a"),
            ("channelId", "c"),
            ("harness", "claude"),
            ("startedAt", "t"),
        ] {
            s.insert(k.into(), json!(v));
        }
        s.insert("threadRootId".into(), Value::Null);
        let theirs = activity_view(&s, false);
        assert!(
            theirs.get("sessionId").is_none(),
            "남의 세션 id 는 attach·cancel 손잡이라 싣지 않는다"
        );
        assert_eq!(theirs["owned"], json!(false));
        let mine = activity_view(&s, true);
        assert_eq!(mine["sessionId"], json!("s1"));
        assert!(mine.get("mode").is_none());
    }

    #[test]
    fn scope_param_is_exact() {
        assert!(wants_visible(Some("scope=visible")));
        assert!(
            !wants_visible(Some("scope=visible&scope=visible")),
            "배열이면 아니다(TS 와 같음)"
        );
        assert!(!wants_visible(Some("scope=all")));
        assert!(!wants_visible(None));
    }
}
