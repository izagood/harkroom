//! `/ws`(TS `ws/wsPlugin.ts`) — 앱의 실시간 연결.
//!
//! 순서는 TS 와 같다: Origin 이 허용 목록 밖이면 4403 · 티켓이 없거나 소모·만료면 4401 → 자격증명 재검증 대상에 넣고 → 이벤트 구독 →
//! 접속 수를 올리고(처음이면 `presence.changed online`) → `presence.snapshot` 을 보낸다. 들어오는 것은 `typing`·`typing.stop` 뿐이다.
//!
//! 주기(기본값 TS 와 같음): ping 30초(직전 ping 에 pong 이 없으면 끊음) · 앱 `hb` 프레임 20초 · 자격증명 재검증 60초(세션 만료·
//! PAT 폐기·계정 삭제면 4401) · 입력 중 수명 6초. 시험은 env 로 줄인다(`HARKROOM_WS_*_MS`).
use super::events::{Hub, visible_to};
use super::tickets::{Claim, TicketStore};
use super::typing::Typing;
use crate::auth::RequireAccount;
use crate::directory::json_ok;
use axum::extract::ws::{CloseFrame, Message, Utf8Bytes, WebSocket, WebSocketUpgrade};
use axum::extract::{RawQuery, State};
use axum::http::HeaderMap;
use axum::response::Response;
use serde_json::{Value, json};
use sqlx::PgPool;
use std::collections::{HashMap, HashSet};
use std::sync::{Arc, Mutex, OnceLock};
use std::time::Duration;
use tokio::sync::{broadcast, mpsc};

/// C6-1: 소켓 하나에 쌓아 둘 수 있는 나가는 프레임 수. 넘으면(읽지 않는 클라이언트) 1013 으로 닫는다 — 다시 붙어 새로 읽게.
pub const SEND_QUEUE: usize = 256;
/// C6-2: 받는 프레임 크기 상한(바이트).
pub const MAX_INBOUND_BYTES: usize = 4 * 1024;
/// C6-2: 처리 기다리는 받은 프레임 수. 넘으면 버린다(입력 중 알림은 몇 초마다 다시 온다).
pub const INBOUND_QUEUE: usize = 16;

/// 코어가 쥐는 것 — 프로세스에 하나.
pub struct Core {
    pub pool: PgPool,
    pub hub: Hub,
    pub tickets: TicketStore,
    pub typing: Typing,
    /// 계정 → 살아 있는 소켓 수(TS `connections`).
    pub connections: Mutex<HashMap<String, usize>>,
    /// 자격증명 재검증 대상(소켓 id → (해시, 닫기 신호)).
    sockets: Mutex<HashMap<u64, (String, mpsc::UnboundedSender<Out>)>>,
    pub allowed_origins: Option<Vec<String>>,
    pub timing: Timing,
}

#[derive(Clone, Copy, Debug)]
pub struct Timing {
    pub heartbeat: Duration,
    pub app_heartbeat: Duration,
    pub revalidate: Duration,
}

impl Timing {
    /// TS 기본값. env 로 줄일 수 있다(시험용) — 0·모르는 값은 기본값.
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
            heartbeat: ms("HARKROOM_WS_HEARTBEAT_MS", 30_000),
            app_heartbeat: ms("HARKROOM_WS_APP_HEARTBEAT_MS", 20_000),
            revalidate: ms("HARKROOM_WS_REVALIDATE_MS", 60_000),
        }
    }
}

/// TS `parseOrigins(CORS_ORIGINS)` — 비면 검사하지 않는다.
pub fn parse_origins(raw: Option<&str>) -> Option<Vec<String>> {
    let v: Vec<String> = raw
        .unwrap_or("")
        .split(',')
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .map(str::to_owned)
        .collect();
    (!v.is_empty()).then_some(v)
}

/// TS `originAllowed` — 목록이 없거나 Origin 헤더가 없으면 허용(앱·러너는 Origin 을 싣지 않는다).
pub fn origin_allowed(allowed: Option<&[String]>, origin: Option<&str>) -> bool {
    match (allowed, origin) {
        (Some(list), Some(o)) => list.iter().any(|x| x == o),
        _ => true,
    }
}

enum Out {
    Text(String),
    Close(u16, &'static str),
}

fn next_id() -> u64 {
    static N: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(1);
    N.fetch_add(1, std::sync::atomic::Ordering::Relaxed)
}

impl Core {
    pub fn new(
        pool: PgPool,
        hub: Hub,
        allowed_origins: Option<Vec<String>>,
        timing: Timing,
    ) -> Arc<Self> {
        let core = Arc::new(Self {
            pool,
            hub,
            tickets: TicketStore::new(Duration::from_secs(30)),
            typing: Typing::new(Duration::from_secs(6)),
            connections: Mutex::new(HashMap::new()),
            sockets: Mutex::new(HashMap::new()),
            allowed_origins,
            timing,
        });
        spawn_credential_sweep(core.clone());
        core
    }

    fn lock_conn(&self) -> std::sync::MutexGuard<'_, HashMap<String, usize>> {
        self.connections.lock().unwrap_or_else(|e| e.into_inner())
    }
    fn lock_sockets(
        &self,
    ) -> std::sync::MutexGuard<'_, HashMap<u64, (String, mpsc::UnboundedSender<Out>)>> {
        self.sockets.lock().unwrap_or_else(|e| e.into_inner())
    }

    /// TS `announceTyping` — 받는 사람마다 자기를 뺀 목록. 수신자는 `audienceFor`(public standard 면 지금 붙은 전원, 아니면 멤버).
    async fn announce_typing(&self, channel: &str) {
        let row: Option<(String, String)> =
            sqlx::query_as("select kind, visibility from channel where id = $1::uuid")
                .bind(channel)
                .fetch_optional(&self.pool)
                .await
                .ok()
                .flatten();
        let Some((kind, visibility)) = row else {
            return;
        };
        let recipients: Vec<String> = if kind == "standard" && visibility == "public" {
            self.lock_conn().keys().cloned().collect()
        } else {
            sqlx::query_scalar(
                "select account_id::text from channel_member where channel_id = $1::uuid",
            )
            .bind(channel)
            .fetch_all(&self.pool)
            .await
            .unwrap_or_default()
        };
        let who = self.typing.who(channel);
        for r in recipients {
            let ids: Vec<&String> = who.iter().filter(|a| **a != r).collect();
            self.hub.emit(json!({ "type": "typing.changed", "channelId": channel, "accountIds": ids, "audience": [r] }));
        }
    }

    async fn channel_visible(&self, channel: &str, account: &str) -> bool {
        // TS `assertChannelVisible` — 없는 채널은 막지 않는다(뒤 단계가 404). 가시성 술어는 TS 골든.
        static SQL: OnceLock<String> = OnceLock::new();
        let sql = SQL.get_or_init(|| {
            let v: Value = serde_json::from_str(include_str!("../../golden/sql_fragments.json"))
                .expect("golden");
            format!(
                "select {} as visible from channel c where c.id = $2::uuid",
                v["channel_visible_c_p1uuid"].as_str().expect("c_p1")
            )
        });
        match sqlx::query_scalar::<_, bool>(sql.as_str())
            .bind(account)
            .bind(channel)
            .fetch_optional(&self.pool)
            .await
        {
            Ok(Some(v)) => v,
            Ok(None) => true,
            Err(_) => false,
        }
    }
}

/// TS `createCredentialSweep` — 주기마다 붙은 소켓의 자격증명을 한 번에 다시 보고, 무효면 4401 로 닫는다. 조회가 실패하면 아무것도 닫지 않는다.
fn spawn_credential_sweep(core: Arc<Core>) {
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
            let valid: Result<Vec<String>, _> = sqlx::query_scalar(
                "select s.token_hash from session s join account a on a.id = s.account_id \
                  where s.token_hash = any($1) and s.expires_at > now() and a.deleted_at is null \
                 union all \
                 select p.token_hash from pat p join account a on a.id = p.account_id \
                  where p.token_hash = any($1) and p.revoked_at is null and a.deleted_at is null and a.kind = 'agent'",
            )
            .bind(&hashes)
            .fetch_all(&core.pool)
            .await;
            let Ok(valid) = valid else { continue };
            let valid: HashSet<String> = valid.into_iter().collect();
            let mut s = core.lock_sockets();
            s.retain(|_, (h, tx)| {
                if valid.contains(h) {
                    true
                } else {
                    let _ = tx.send(Out::Close(4401, "credential no longer valid"));
                    false
                }
            });
        }
    });
}

/// POST `/ws-ticket` — 계정으로 선 요청만(401). `{ ticket }`.
pub async fn issue_ticket(
    State(core): State<Arc<Core>>,
    RequireAccount(me, auth): RequireAccount,
) -> Response {
    let Some(hash) = auth.credential_hash else {
        return crate::directory::json_err(
            axum::http::StatusCode::UNAUTHORIZED,
            "unauthorized",
            "authentication required",
        );
    };
    let ticket = core.tickets.issue(Claim {
        account_id: me.id,
        credential_hash: hash,
    });
    json_ok(json!({ "ticket": ticket }).to_string())
}

/// GET `/ws?ticket=…`.
pub async fn upgrade(
    State(core): State<Arc<Core>>,
    headers: HeaderMap,
    RawQuery(raw): RawQuery,
    ws: WebSocketUpgrade,
) -> Response {
    let origin = headers
        .get("origin")
        .and_then(|v| v.to_str().ok())
        .map(str::to_owned);
    // TS 는 `req.query.ticket` — 같은 키가 둘이면 배열이 되어 티켓으로 읽히지 않는다(4401).
    let pairs = crate::directory::form_pairs(raw.as_deref().unwrap_or(""));
    let mut tickets = pairs
        .into_iter()
        .filter(|(k, _)| k == "ticket")
        .map(|(_, v)| v);
    let ticket = match (tickets.next(), tickets.next()) {
        (Some(t), None) => Some(t),
        _ => None,
    };
    // C6-2: 들어오는 프레임은 입력 중 알림(`{ type, channelId }`, 수백 바이트)뿐이다 — 64MiB 기본 대신 작게 막는다.
    ws.max_message_size(MAX_INBOUND_BYTES)
        .max_frame_size(MAX_INBOUND_BYTES)
        .on_upgrade(move |socket| run(core, socket, origin, ticket))
}

async fn close(mut socket: WebSocket, code: u16, reason: &'static str) {
    let _ = socket
        .send(Message::Close(Some(CloseFrame {
            code,
            reason: Utf8Bytes::from_static(reason),
        })))
        .await;
}

async fn run(core: Arc<Core>, socket: WebSocket, origin: Option<String>, ticket: Option<String>) {
    if !origin_allowed(core.allowed_origins.as_deref(), origin.as_deref()) {
        return close(socket, 4403, "origin not allowed").await;
    }
    let Some(claim) = ticket.as_deref().and_then(|t| core.tickets.consume(t)) else {
        return close(socket, 4401, "unauthorized").await;
    };
    let account = claim.account_id.clone();
    let id = next_id();
    let (out_tx, mut out_rx) = mpsc::unbounded_channel::<Out>();
    core.lock_sockets()
        .insert(id, (claim.credential_hash.clone(), out_tx.clone()));
    // 구독은 접속 수를 올리기 전에 — 이 사이에 난 이벤트를 놓치지 않게(TS 는 같은 틱 안이라 창이 없다).
    let mut events = core.hub.subscribe();

    let first = {
        let mut c = core.lock_conn();
        let n = c.entry(account.clone()).or_insert(0);
        *n += 1;
        *n == 1
    };
    if first {
        core.hub
            .emit(json!({ "type": "presence.changed", "accountId": account, "online": true }));
    }
    // 에이전트 presence(MCP)는 C3 몫 — 지금은 사람 소켓만.
    let online: Vec<String> = core.lock_conn().keys().cloned().collect();
    let _ = out_tx.send(Out::Text(
        json!({ "type": "presence.snapshot", "online": online }).to_string(),
    ));

    let (mut sink, mut stream) = futures_split(socket);
    let (inbound_tx, mut inbound_rx) = mpsc::channel::<String>(INBOUND_QUEUE);
    {
        let core = core.clone();
        let account = account.clone();
        tokio::spawn(async move {
            while let Some(raw) = inbound_rx.recv().await {
                inbound(&core, &account, &raw).await;
            }
        });
    }
    let mut ping = tokio::time::interval(core.timing.heartbeat);
    ping.tick().await;
    let mut hb = tokio::time::interval(core.timing.app_heartbeat);
    hb.tick().await;
    let hb_frame =
        json!({ "type": "hb", "intervalMs": core.timing.app_heartbeat.as_millis() as u64 })
            .to_string();
    let mut answered = true;

    loop {
        tokio::select! {
            out = out_rx.recv() => match out {
                Some(Out::Text(t)) => { if !sink.push(Message::Text(t.into())) { break; } }
                Some(Out::Close(code, reason)) => { sink.close(code, reason); break; }
                None => break,
            },
            ev = events.recv() => match ev {
                Ok(e) => if visible_to(&e, &account) && !sink.push(Message::Text(e.to_string().into())) { break; },
                // 허브에서 밀려 놓쳤다 — 조용히 빠진 채 남기지 않고 닫아 다시 붙게 한다.
                Err(broadcast::error::RecvError::Lagged(_)) => { sink.close(1013, "lagged"); break; }
                Err(broadcast::error::RecvError::Closed) => break,
            },
            _ = ping.tick() => {
                // TS `heartbeat.tick` — 직전 ping 에 답이 없으면 끊는다.
                if !answered { break; }
                answered = false;
                if !sink.push(Message::Ping(Default::default())) { break; }
            },
            _ = hb.tick() => { if !sink.push(Message::Text(hb_frame.clone().into())) { break; } },
            msg = stream.recv() => match msg {
                Some(Ok(Message::Pong(_))) => answered = true,
                // C6-2: 받은 프레임은 소켓마다 하나의 일꾼이 **순서대로** 처리한다(프레임마다 spawn 하지 않는다). 줄이 차면 버린다.
                Some(Ok(Message::Text(t))) => { let _ = inbound_tx.try_send(t.to_string()); }
                Some(Ok(Message::Close(_))) | None | Some(Err(_)) => break,
                Some(Ok(_)) => {}
            },
        }
    }

    // TS `socket.on('close')` — 정리. 입력 중이 남지 않게 지우고 남아 있던 채널에만 다시 알린다.
    core.lock_sockets().remove(&id);
    let stale = core.typing.forget(&account);
    for ch in stale {
        let core = core.clone();
        tokio::spawn(async move { core.announce_typing(&ch).await });
    }
    let gone = {
        let mut c = core.lock_conn();
        let left = c.get(&account).copied().unwrap_or(1).saturating_sub(1);
        if left == 0 {
            c.remove(&account);
            true
        } else {
            c.insert(account.clone(), left);
            false
        }
    };
    if gone {
        core.hub
            .emit(json!({ "type": "presence.changed", "accountId": account, "online": false }));
    }
    drop(out_tx);
}

/// 들어오는 프레임 — `{ type: 'typing' | 'typing.stop', channelId }` 만. 파싱 실패·모르는 꼴은 버린다(소켓은 산다).
async fn inbound(core: &Core, account: &str, raw: &str) {
    let Ok(Value::Object(o)) = serde_json::from_str::<Value>(raw) else {
        return;
    };
    let Some(channel) = o.get("channelId").and_then(Value::as_str) else {
        return;
    };
    let ty = o.get("type").and_then(Value::as_str);
    if ty != Some("typing") && ty != Some("typing.stop") {
        return;
    }
    if !crate::lists::is_zod_uuid(channel) || !core.channel_visible(channel, account).await {
        return;
    }
    if ty == Some("typing") {
        core.typing.mark(channel, account);
    } else {
        core.typing.clear(channel, account);
    }
    core.announce_typing(channel).await;
}

/// axum `WebSocket` 을 보내는 쪽·받는 쪽으로 — 쓰는 일꾼 하나가 소켓을 쥔다.
///
/// - 나가는 줄은 **상한이 있다**(`SEND_QUEUE`, C6-1). [`Sink::push`] 는 기다리지 않고 넣으며, 차 있으면 거짓 — 부른 쪽이 1013 으로 닫는다.
///   상한이 없으면 읽지 않는 클라이언트 몫이 끝없이 쌓인다(허브의 `Lagged` 도 생기지 않는다 — 허브에서는 곧바로 이 줄로 옮겨지므로).
/// - 닫기는 따로 오는 신호로, 쌓인 줄보다 **먼저** 보낸다(줄이 차서 닫는 경우에도 닫는 프레임이 나가게).
/// - 받는 줄도 상한이 있다 — 차면 소켓 읽기를 멈춰 TCP 흐름 제어에 맡긴다.
fn futures_split(socket: WebSocket) -> (Sink, Stream) {
    let (in_tx, in_rx) = mpsc::channel(INBOUND_QUEUE);
    let (out_tx, mut out_rx) = mpsc::channel::<Message>(SEND_QUEUE);
    let (close_tx, mut close_rx) = tokio::sync::oneshot::channel::<(u16, &'static str)>();
    tokio::spawn(async move {
        let mut socket = socket;
        loop {
            tokio::select! {
                biased;
                c = &mut close_rx => {
                    if let Ok((code, reason)) = c {
                        let _ = socket
                            .send(Message::Close(Some(CloseFrame { code, reason: Utf8Bytes::from_static(reason) })))
                            .await;
                    }
                    break;
                }
                m = out_rx.recv() => match m {
                    Some(m) => { if socket.send(m).await.is_err() { break; } }
                    None => break,
                },
                r = socket.recv() => {
                    let end = r.is_none();
                    if in_tx.send(r).await.is_err() || end { break; }
                }
            }
        }
    });
    (
        Sink {
            tx: out_tx,
            close: Some(close_tx),
        },
        Stream(in_rx),
    )
}

struct Sink {
    tx: mpsc::Sender<Message>,
    close: Option<tokio::sync::oneshot::Sender<(u16, &'static str)>>,
}
impl Sink {
    /// 넣었으면 참. 줄이 찼으면(C6-1) 1013 으로 닫고 거짓, 쓰는 쪽이 끝났으면 거짓.
    fn push(&mut self, m: Message) -> bool {
        match self.tx.try_send(m) {
            Ok(()) => true,
            Err(mpsc::error::TrySendError::Full(_)) => {
                self.close(1013, "send queue full");
                false
            }
            Err(mpsc::error::TrySendError::Closed(_)) => false,
        }
    }
    fn close(&mut self, code: u16, reason: &'static str) {
        if let Some(tx) = self.close.take() {
            let _ = tx.send((code, reason));
        }
    }
}
struct Stream(mpsc::Receiver<Option<Result<Message, axum::Error>>>);
impl Stream {
    async fn recv(&mut self) -> Option<Result<Message, axum::Error>> {
        self.0.recv().await.flatten()
    }
}

/// 코어 라우터 — `HARKROOM_CORE=rust` 일 때 앞단 라우터에 합친다. `/ws-ticket` 은 앞단 인증 층을 거친다(옮긴 줄과 같은 판정).
pub fn router(
    core: Arc<Core>,
    auth: crate::auth::AuthPools,
    cors: Arc<crate::cors::Cors>,
) -> axum::Router {
    axum::Router::new()
        .route(
            "/ws-ticket",
            axum::routing::post(issue_ticket)
                .route_layer(axum::middleware::from_fn_with_state(
                    auth,
                    crate::auth::layer,
                ))
                // 데스크톱은 이 주소를 교차 출처 `fetch`(Bearer)로 부른다 — 프리플라이트(OPTIONS)까지 이 층이 답하도록
                // `layer`(메서드 밖)로 건다. 11-14 「Load failed」 장애와 같은 길.
                .layer(axum::middleware::from_fn_with_state(
                    cors,
                    crate::cors::layer,
                )),
        )
        .route("/ws", axum::routing::get(upgrade))
        .with_state(core)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn origins() {
        assert_eq!(parse_origins(None), None);
        assert_eq!(
            parse_origins(Some(" a , ,b")),
            Some(vec!["a".into(), "b".into()])
        );
        let list = vec!["https://x".to_string()];
        assert!(origin_allowed(Some(&list), Some("https://x")));
        assert!(!origin_allowed(Some(&list), Some("https://y")));
        assert!(
            origin_allowed(Some(&list), None),
            "Origin 이 없으면 허용(앱·러너)"
        );
        assert!(origin_allowed(None, Some("https://y")));
    }
}
