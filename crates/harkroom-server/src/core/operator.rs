//! `/operator`(C2a, TS `routes/operatorRoutes.ts` 의 WS 배선) — 오퍼레이터가 outbound 로 거는 소켓.
//!
//! 순서는 TS 와 같다: 오퍼레이터 토큰으로 인증(앞단 인증 층 + `RequireOperator`) → 허브에 등록(같은 오퍼레이터의 앞 소켓은
//! 4409) → `operator.changed` → 프레임마다 허브로. 끊기면 등록을 지우고 다시 `operator.changed`.
//!
//! - ping 30초(직전 ping 에 pong 이 없으면 끊음) — 프록시가 조용히 걷어간 소켓은 close 를 주지 않는다.
//! - `last_seen_at` 은 30초에 한 번만 쓰고, 끊길 때 쓰지 않은 프레임이 있었으면 한 번 더 쓴다(TS `LAST_SEEN_WRITE_MS`).
//! - 토큰 재검증 60초: TS 는 같은 프로세스의 DELETE·계정 삭제가 허브를 직접 불러 끊는다. 코어가 이 프로세스로 오면 TS 쪽
//!   라우트가 이 허브에 닿지 못하므로, 여기서 주기적으로 `revoked_at`·토큰을 다시 보고 4401 로 끊는다(`/ws` 의 재검증과 같은 몫).
//! - 박동·업그레이드 단계·gh 보고는 `operator_frames` 가 적는다.
//! - hello 의 버전을 `operator.version` 에 적고, 바뀌었으면 `operator.changed`(TS 와 같음).
use super::events::Hub;
use super::operator_hub::{OpOut, OperatorHub};
use super::ws::{WorkerGuard, futures_split};
use crate::auth::RequireOperator;
use axum::extract::State;
use axum::extract::ws::{Message, WebSocket, WebSocketUpgrade};
use axum::response::Response;
use serde_json::{Value, json};
use sqlx::PgPool;
use std::sync::Arc;
use std::sync::atomic::{AtomicUsize, Ordering};
use std::time::{Duration, Instant};
use tokio::sync::{broadcast, mpsc};

#[derive(Clone, Copy, Debug)]
pub struct OpTiming {
    pub heartbeat: Duration,
    pub last_seen_write: Duration,
    pub revalidate: Duration,
    /// 소켓 쓰기 시한 — `/ws` 와 같은 env(`HARKROOM_WS_SEND_TIMEOUT_MS`)·기본값(C6-1).
    pub send_timeout: Duration,
    /// 박동을 DB·이벤트로 처리하는 최소 간격(TS `STATUS_MIN_INTERVAL_MS`).
    pub status_min: Duration,
}

impl OpTiming {
    /// TS 기본값. 시험은 env 로 줄인다 — 0·모르는 값은 기본값.
    pub fn from_env() -> Self {
        let ms = |k: &str, d: u64| {
            Duration::from_millis(
                std::env::var(k)
                    .ok()
                    .and_then(|v| v.parse::<u64>().ok())
                    .filter(|n| *n > 0)
                    .unwrap_or(d),
            )
        };
        Self {
            heartbeat: ms("HARKROOM_OPERATOR_HEARTBEAT_MS", 30_000),
            last_seen_write: ms("HARKROOM_OPERATOR_LAST_SEEN_MS", 30_000),
            revalidate: ms("HARKROOM_OPERATOR_REVALIDATE_MS", 60_000),
            send_timeout: ms("HARKROOM_WS_SEND_TIMEOUT_MS", 10_000),
            status_min: ms("HARKROOM_OPERATOR_STATUS_MIN_MS", 10_000),
        }
    }
}

pub struct OperatorCore {
    /// 읽기 풀(토큰 재검증·목록).
    pub pool: PgPool,
    /// 쓰기 풀(`DATABASE_WRITE_URL`) — operator 표·이력·gh 보고·배정 이동은 모두 이것으로 쓴다. 이 풀에
    /// [`crate::write::OPERATOR_PRIVILEGES`] 가 다 있을 때만 이 코어가 선다(`main.rs`).
    pub write: PgPool,
    /// 감사 `ip` 규칙(TS `req.ip`).
    pub trust: Arc<crate::trust_proxy::TrustProxy>,
    /// 등록 코드(5분, 1회용) — TS `createRegisterCodes`.
    pub codes: super::operator_rest::RegisterCodes,
    pub events: Hub,
    pub hub: OperatorHub,
    pub timing: OpTiming,
    workers: Arc<AtomicUsize>,
}

impl OperatorCore {
    pub fn new(
        pool: PgPool,
        write: PgPool,
        trust: Arc<crate::trust_proxy::TrustProxy>,
        events: Hub,
        hub: OperatorHub,
        timing: OpTiming,
    ) -> Arc<Self> {
        let core = Arc::new(Self {
            pool,
            write,
            trust,
            codes: super::operator_rest::RegisterCodes::new(
                super::operator_rest::REGISTER_CODE_TTL,
            ),
            events,
            hub,
            timing,
            workers: Arc::new(AtomicUsize::new(0)),
        });
        spawn_version_writer(core.clone());
        super::operator_frames::spawn(
            core.clone(),
            super::operator_frames::machine_id_key_from_env(
                std::env::var("HARKROOM_MACHINE_ID_KEY").ok().as_deref(),
            ),
            timing.status_min,
        );
        core
    }

    /// 아직 살아 있는 소켓 쓰기 일꾼 수 — 시험이 끊긴 소켓이 남지 않는지 본다(`/ws` 의 `live_socket_workers` 와 같은 몫).
    pub fn live_socket_workers(&self) -> usize {
        self.workers.load(Ordering::SeqCst)
    }

    pub(super) fn changed_all(&self, operator_id: &str) {
        self.events.emit(
            json!({ "type": "operator.changed", "operatorId": operator_id, "audience": "all" }),
        );
    }

    fn touch_last_seen(&self, operator_id: &str) {
        let pool = self.write.clone();
        let id = operator_id.to_owned();
        // 실패해도 흐름을 막지 않는다(TS 와 같음) — 기다리지 않는다.
        tokio::spawn(async move {
            let _ = sqlx::query("update operator set last_seen_at = now() where id = $1::uuid")
                .bind(id)
                .execute(&pool)
                .await;
        });
    }

    /// 토큰이 아직 살아 있나. 조회 오류면 끊지 않는다(DB 가 잠깐 흔들려도 오퍼레이터 전체가 다시 붙지 않게) — 다음 주기에 다시 본다.
    async fn still_valid(&self, operator_id: &str, token_hash: &str) -> bool {
        sqlx::query_scalar::<_, i32>(
            "select 1 from operator where id = $1::uuid and token_hash = $2 and revoked_at is null",
        )
        .bind(operator_id)
        .bind(token_hash)
        .fetch_optional(&self.pool)
        .await
        .map(|r| r.is_some())
        .unwrap_or(true)
    }
}

/// hello 의 버전을 적는다. 없으면 null 로 덮는다(옛 오퍼레이터로 돌아갔을 때 예전 값이 거짓 기준이 되지 않게).
fn spawn_version_writer(core: Arc<OperatorCore>) {
    let mut frames = core.hub.subscribe_frames();
    tokio::spawn(async move {
        loop {
            let (operator_id, frame) = match frames.recv().await {
                Ok(f) => f,
                Err(broadcast::error::RecvError::Lagged(_)) => continue,
                Err(broadcast::error::RecvError::Closed) => break,
            };
            if frame.get("type").and_then(Value::as_str) != Some("hello") {
                continue;
            }
            let version = frame
                .get("version")
                .and_then(Value::as_str)
                .map(str::to_owned);
            let core = core.clone();
            tokio::spawn(async move {
                let res = sqlx::query(
                    "update operator set version = $2 where id = $1::uuid and version is distinct from $2 returning id",
                )
                .bind(&operator_id)
                .bind(version)
                .fetch_optional(&core.write)
                .await;
                match res {
                    Ok(Some(_)) => core.changed_all(&operator_id),
                    Ok(None) => {}
                    Err(_) => eprintln!("core: operator version write failed"),
                }
            });
        }
    });
}

/// GET `/operator`.
pub async fn upgrade(
    State(core): State<Arc<OperatorCore>>,
    RequireOperator(op, auth): RequireOperator,
    ws: WebSocketUpgrade,
) -> Response {
    let hash = auth.credential_hash.unwrap_or_default();
    ws.on_upgrade(move |socket| run(core, socket, op.id, hash))
}

async fn run(core: Arc<OperatorCore>, socket: WebSocket, operator_id: String, token_hash: String) {
    let (out_tx, mut out_rx) = mpsc::unbounded_channel::<OpOut>();
    let reg = core.hub.add_operator(&operator_id, out_tx);
    core.changed_all(&operator_id);

    let (mut sink, mut stream, worker) = futures_split(
        socket,
        core.timing.send_timeout,
        WorkerGuard::new(&core.workers),
    );
    let mut ping = tokio::time::interval(core.timing.heartbeat);
    ping.tick().await;
    let mut revalidate = tokio::time::interval(core.timing.revalidate);
    revalidate.tick().await;
    let mut answered = true;
    let mut last_seen_at: Option<Instant> = None;
    let mut unwritten = false;

    loop {
        tokio::select! {
            out = out_rx.recv() => match out {
                Some(OpOut::Text(t)) => { if !sink.push(Message::Text(t.into())) { break; } }
                Some(OpOut::Close(code, reason)) => { sink.close(code, reason); break; }
                None => break,
            },
            _ = ping.tick() => {
                if !answered { break; }
                answered = false;
                if !sink.push(Message::Ping(Default::default())) { break; }
            },
            _ = revalidate.tick() => {
                if !core.still_valid(&operator_id, &token_hash).await {
                    sink.close(4401, "operator revoked");
                    break;
                }
            },
            m = stream.recv() => match m {
                Some(Ok(Message::Text(t))) => {
                    let now = Instant::now();
                    if last_seen_at.is_none_or(|at| now.duration_since(at) >= core.timing.last_seen_write) {
                        last_seen_at = Some(now);
                        unwritten = false;
                        core.touch_last_seen(&operator_id);
                    } else {
                        unwritten = true;
                    }
                    core.hub.on_operator_message(&reg, t.as_str());
                }
                Some(Ok(Message::Pong(_))) => answered = true,
                Some(Ok(Message::Close(_))) | None | Some(Err(_)) => break,
                // TS 는 바이너리 프레임도 `String(raw)` 로 읽는다 — 오퍼레이터는 텍스트만 보내므로 그대로 버린다.
                Some(Ok(_)) => {}
            },
        }
    }
    if unwritten {
        core.touch_last_seen(&operator_id);
    }
    core.hub.detach(&reg);
    core.changed_all(&operator_id);
    // `/ws` 와 같이: 닫기 인사를 쓸 시간만 주고 넘으면 부순다.
    drop(sink);
    let mut worker = worker;
    if tokio::time::timeout(core.timing.send_timeout, &mut worker)
        .await
        .is_err()
    {
        worker.abort();
    }
}

/// 오퍼레이터 라우터 — `HARKROOM_CORE=rust` 일 때 앞단 라우터에 합친다. 인증은 앞단 인증 층(오퍼레이터 토큰 `hkop_`)이다.
///
/// `/operators*` REST 는 데스크톱이 교차 출처 `fetch`(Bearer)로 부른다(목록·등록 코드·능력·폐기). 그래서 CORS 층을 인증 층
/// **바깥**에 `layer`(메서드 밖)로 건다 — 401·403 에도 머리가 실리고 프리플라이트(OPTIONS)도 이 층이 답한다(#2120 `/ws-ticket` 과 같은 길,
/// 11-14 「Load failed」 장애를 되풀이하지 않게). `/operator` 소켓은 오퍼레이터 프로세스가 붙는 길이라 `/ws` 처럼 CORS 층이 없다.
pub fn router(
    core: Arc<OperatorCore>,
    auth: crate::auth::AuthPools,
    cors: Arc<crate::cors::Cors>,
) -> axum::Router {
    routes(core, auth, cors).router
}

/// [`router`] 와 같은 것에 줄 목록을 곁들인다(앞단 기동 기록 → CI CORS 대조, `route_table.rs`).
pub fn routes(
    core: Arc<OperatorCore>,
    auth: crate::auth::AuthPools,
    cors: Arc<crate::cors::Cors>,
) -> crate::route_table::Routes<()> {
    use super::operator_rest as rest;
    use crate::route_table::Table;
    let auth_layer = || axum::middleware::from_fn_with_state(auth.clone(), crate::auth::layer);
    let rest_routes = Table::<Arc<OperatorCore>>::new()
        .get("/operators", rest::list)
        .post("/operators/register-codes", rest::register_code)
        .post("/operators/claim", rest::claim)
        .get("/operators/self", rest::self_view)
        .get("/operators/{id}/capabilities", rest::capabilities)
        .get("/operators/{id}/upgrades", rest::upgrades)
        .patch("/operators/{id}", rest::rename)
        .delete("/operators/{id}", rest::revoke)
        .map(|r| {
            r.route_layer(auth_layer())
                .layer(axum::middleware::from_fn_with_state(
                    cors,
                    crate::cors::layer,
                ))
        });
    let t = Table::<Arc<OperatorCore>>::new()
        .socket("/operator", upgrade)
        .map(|r| r.route_layer(auth_layer()))
        .merge(rest_routes)
        .finish();
    crate::route_table::Routes {
        router: t.router.with_state(core),
        http: t.http,
        sockets: t.sockets,
    }
}
