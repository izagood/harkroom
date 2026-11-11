//! 앱(Tauri) ↔ 오퍼레이터 소켓 서버(경계 P3, S2 A2). 정본은 `packages/operator/src/server.ts`(`DaemonServer`)와
//! `packages/shared/src/daemonProtocol.ts`(`NdjsonDecoder`·`checkHello`·`tokensMatch`·`parseRequest`)다.
//!
//! A2 는 문지기(`hello`: 버전 → role → 토큰 순, 상수시간 비교)와 `ping`·`listRunners` 를, A3b 는 러너 표
//! (`spawnRunner`·`killRunner`, `runners.rs`)와 `runnerExit` 이벤트를 옮긴다. 프로토콜이 아는 나머지 요청에는
//! `unknown-request` 가 아니라 `internal`("이 오퍼레이터에는 아직 없다")로 답한다 — 모른다고 하면 앱이 프로토콜 판이
//! 갈렸다고 읽는다(TS 주석).
//!
//! 이벤트는 **인증된** 접속에만 흘린다(TS `broadcastEvent`). 접속마다 쓰는 쪽을 잠금 하나로 묶어, 응답 줄과
//! 이벤트 줄이 서로 끼어들어 한 줄이 깨지지 않게 한다.
//!
//! 접속마다 스레드 하나다. 앱 하나가 붙는 로컬 소켓이라 async 런타임을 들이지 않는다(의존이 늘지 않는다).
use crate::claude_accounts::{self, ClaudeAccounts};
use crate::claude_login::{self, ClaudeLogins};
use crate::codex_accounts::{self, CodexAccounts};
use crate::codex_login::{self, CodexLogins};
use crate::local_agents::{self, LocalAgents};
use crate::local_mcp::{self, LocalMcp};
use crate::local_merge::{self, LocalMerge};
use crate::local_terminal::LocalTerminalHub;
use crate::runner_link::RunnerLinkServer;
use crate::runners::{RunnerLaunch, RunnerTable, SpawnOutcome};
use harkroom_proto::p3::{
    DAEMON_PROTOCOL_VERSION, DaemonError, DaemonErrorCode, DaemonIdentity, EVENT_NAMES,
    MAX_LINE_BYTES, REQUEST_TYPES,
};
use serde_json::{Value, json};
use std::collections::HashMap;
use std::io::{Read, Write};
use std::net::Shutdown;
use std::os::unix::net::{UnixListener, UnixStream};
use std::sync::atomic::{AtomicU64, AtomicUsize, Ordering};
use std::sync::{Arc, Mutex, OnceLock, Weak};
use std::time::{Duration, SystemTime, UNIX_EPOCH};

/// 접속마다의 쓰기 시간 제한. 인증은 됐지만 읽지 않는 접속 하나가 이벤트 흘리기(`broadcast_event`, 러너 종료를
/// 기다리는 스레드에서 돈다)를 그 자리에 붙잡지 못하게 한다. 넘기면 그 접속은 끊는다 — 앱은 다시 붙는다.
pub const WRITE_TIMEOUT: Duration = Duration::from_secs(5);

/// 포트가 던진 문구를 `bad-payload` 로 싣는다(TS `catch → daemonError('bad-payload', …)`).
fn bad(message: String) -> DaemonError {
    err(DaemonErrorCode::BadPayload, message)
}

fn err(code: DaemonErrorCode, message: impl Into<String>) -> DaemonError {
    DaemonError {
        code,
        message: message.into(),
    }
}

/// 디코더가 내놓는 한 줄 — 성공·실패가 순서대로 섞여 온다(TS `DecodedLine`).
#[derive(Debug, PartialEq)]
pub enum Decoded {
    Ok(Value),
    Err(DaemonError),
}

/// TS `NdjsonDecoder` 와 같은 규칙: 개행까지 들고 있고, 상한을 넘기면 그 줄을 버리고 다음 개행까지 버린다.
pub struct NdjsonDecoder {
    buf: Vec<u8>,
    discarding: bool,
    limit: usize,
}

impl Default for NdjsonDecoder {
    fn default() -> Self {
        Self::new(MAX_LINE_BYTES)
    }
}

impl NdjsonDecoder {
    pub fn new(limit: usize) -> Self {
        Self {
            buf: Vec::new(),
            discarding: false,
            limit,
        }
    }

    pub fn pending_bytes(&self) -> usize {
        self.buf.len()
    }

    /// 아직 개행이 안 온 줄의 머리를 꺼낸다(TS `takeBuffered`). 접속을 러너 링크로 넘길 때 쓴다 —
    /// 버리면 hello 와 한 청크로 온 큰 요청이 잘린다. 버리는 중이던 줄이면 넘길 것이 없다.
    pub fn take_buffered(&mut self) -> Vec<u8> {
        let out = if self.discarding {
            Vec::new()
        } else {
            std::mem::take(&mut self.buf)
        };
        self.buf.clear();
        self.discarding = false;
        out
    }

    fn too_long(&self, n: usize) -> DaemonError {
        err(
            DaemonErrorCode::LineTooLong,
            format!("한 줄이 상한을 넘었다: {n} > {} 바이트", self.limit),
        )
    }

    pub fn push(&mut self, chunk: &[u8]) -> Vec<Decoded> {
        self.buf.extend_from_slice(chunk);
        let mut out = Vec::new();
        loop {
            let Some(nl) = self.buf.iter().position(|&b| b == b'\n') else {
                if self.discarding {
                    self.buf.clear();
                } else if self.buf.len() > self.limit {
                    out.push(Decoded::Err(self.too_long(self.buf.len())));
                    self.buf.clear();
                    self.discarding = true;
                }
                return out;
            };
            let line: Vec<u8> = self.buf.drain(..=nl).take(nl).collect();
            if self.discarding {
                self.discarding = false;
                continue;
            }
            if line.len() > self.limit {
                out.push(Decoded::Err(self.too_long(line.len())));
                continue;
            }
            let text = String::from_utf8_lossy(&line);
            let text = text.trim();
            if text.is_empty() {
                continue;
            }
            match serde_json::from_str::<Value>(text) {
                Ok(v) => out.push(Decoded::Ok(v)),
                Err(e) => out.push(Decoded::Err(err(
                    DaemonErrorCode::InvalidJson,
                    e.to_string(),
                ))),
            }
        }
    }
}

/// 한 메시지를 한 줄로. 보내는 쪽에서도 상한을 잰다(TS `encodeLine`).
pub fn encode_line(v: &Value) -> Result<Vec<u8>, DaemonError> {
    let mut s = serde_json::to_vec(v).map_err(|e| err(DaemonErrorCode::Internal, e.to_string()))?;
    if s.len() > MAX_LINE_BYTES {
        return Err(err(
            DaemonErrorCode::LineTooLong,
            format!(
                "한 줄이 상한을 넘었다: {} > {MAX_LINE_BYTES} 바이트",
                s.len()
            ),
        ));
    }
    s.push(b'\n');
    Ok(s)
}

/// 상수시간 비교. 길이가 다르면 바로 끝난다(TS 와 같은 "받아들이는 누출"). 빈 토큰은 언제나 거절.
pub fn tokens_match(expected: &str, received: &Value) -> bool {
    let Some(b) = received.as_str() else {
        return false;
    };
    let (a, b) = (expected.as_bytes(), b.as_bytes());
    if a.len() != b.len() || a.is_empty() {
        return false;
    }
    a.iter().zip(b).fold(0u8, |acc, (x, y)| acc | (x ^ y)) == 0
}

/// `hello` 검사 — 버전을 토큰보다 먼저 본다(TS `checkHello`).
pub fn check_hello(msg: &Value, token: &str) -> Result<(), DaemonError> {
    if msg.get("type").and_then(Value::as_str) != Some("hello") {
        return Err(err(
            DaemonErrorCode::NotAuthenticated,
            "첫 메시지는 hello 여야 한다",
        ));
    }
    let version = msg.get("version");
    if version.and_then(Value::as_f64) != Some(f64::from(DAEMON_PROTOCOL_VERSION)) {
        let got = match version {
            None => "undefined".to_string(),
            Some(Value::String(s)) => s.clone(),
            Some(v) => v.to_string(),
        };
        return Err(err(
            DaemonErrorCode::VersionMismatch,
            format!(
                "프로토콜 버전이 다르다: 이 daemon 은 v{DAEMON_PROTOCOL_VERSION}, 상대는 v{got}"
            ),
        ));
    }
    if msg.get("role").and_then(Value::as_str) != Some("app") {
        let got = match msg.get("role") {
            None => "undefined".to_string(),
            Some(Value::String(s)) => s.clone(),
            Some(v) => v.to_string(),
        };
        return Err(err(
            DaemonErrorCode::BadPayload,
            format!("모르는 role 이다: {got}"),
        ));
    }
    if !tokens_match(token, msg.get("token").unwrap_or(&Value::Null)) {
        return Err(err(DaemonErrorCode::Unauthorized, "토큰이 다르다"));
    }
    Ok(())
}

/// 파싱된 요청. 성공이면 (id, type, payload).
pub fn parse_request(v: &Value) -> Result<(String, String, Option<Value>), DaemonError> {
    let Some(obj) = v.as_object() else {
        return Err(err(DaemonErrorCode::InvalidJson, "객체가 아니다"));
    };
    let id = match obj.get("id").and_then(Value::as_str) {
        Some(s) if !s.is_empty() => s.to_string(),
        _ => return Err(err(DaemonErrorCode::BadPayload, "id 가 없다")),
    };
    let Some(ty) = obj.get("type").and_then(Value::as_str) else {
        return Err(err(DaemonErrorCode::BadPayload, "type 이 없다"));
    };
    if !REQUEST_TYPES.contains(&ty) {
        return Err(err(
            DaemonErrorCode::UnknownRequest,
            format!("모르는 요청이다: {ty}"),
        ));
    }
    Ok((id, ty.to_string(), obj.get("payload").cloned()))
}

/// 응답 id 를 값에서 최선으로 건진다(TS `readId`).
fn read_id(v: &Value) -> Option<String> {
    v.get("id").and_then(Value::as_str).map(str::to_string)
}

fn error_response(id: Option<String>, e: &DaemonError) -> Value {
    json!({ "id": id.unwrap_or_default(), "ok": false, "error": e })
}

fn now_ms() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0)
}

type Writer = Arc<Mutex<UnixStream>>;
/// 사용률 요청 열쇠 → 그 결과를 기다리는 (요청 id, 접속 writer)들.
type UsageWaiters = HashMap<String, Vec<(String, Writer)>>;

/// 서버가 들고 있는 것. 토큰은 엔드포인트를 이긴 뒤에 생기므로 나중에 채운다(빈 값이면 누구도 통과 못 한다).
/// 러너 종료를 서버 링크에 넘기는 자리(s21c-1b-2b).
pub type RunnerExitHook = Box<dyn Fn(&crate::runners::RunnerExit) + Send + Sync>;

pub struct ServerState {
    pub identity: DaemonIdentity,
    token: Mutex<String>,
    /// 러너 표(A3b). `listRunners` 의 원천이다.
    pub runners: Arc<RunnerTable>,
    /// 인증된 접속의 쓰는 쪽 — 이벤트가 여기로 흐른다.
    authed: Mutex<HashMap<u64, Writer>>,
    next_conn: AtomicU64,
    /// 로컬 설정의 에이전트 항목(A5a). 뿌리를 잡은 뒤 채운다 — 없으면 `operatorAgent*` 는 거절된다.
    local_agents: OnceLock<LocalAgents>,
    /// 머지 래퍼의 gh 계정(A5b). 없으면 `operatorMerge*` 는 거절된다.
    local_merge: OnceLock<LocalMerge>,
    /// 이 머신의 MCP 정의(A5c). 없으면 `operatorMcp*` 는 거절된다.
    local_mcp: OnceLock<LocalMcp>,
    /// claude 계정 풀(s21c3a). 없으면 `claude*` 요청은 거절된다.
    claude_accounts: OnceLock<ClaudeAccounts>,
    /// claude 계정 로그인(s21c3b). 계정 풀과 함께 배선된다.
    claude_logins: OnceLock<ClaudeLogins>,
    /// codex 계정(s21c3c). 없으면 `codex*` 요청은 거절된다.
    codex_accounts: OnceLock<CodexAccounts>,
    /// codex 로그인(s21c3c-2). 계정이 배선될 때 같이 선다.
    codex_logins: OnceLock<CodexLogins>,
    /// 공급자 사용률 측정기(s21c3d-3). 없으면 `*ProviderUsage` 요청은 거절된다. 폴러와 캐시를 함께 쓴다.
    usage_meters: OnceLock<crate::usage_meter::UsageMeters>,
    /// 지금 도는 사용률 요청(종류+payload) → 그 결과를 기다리는 (요청 id, 접속 writer)들. 같은 요청이 이미 돌면 스레드를 새로 띄우지 않고
    /// 그 결과를 함께 받는다 — force 연타로 기다리는 스레드가 쌓이지 않게(security #1916 낮음).
    usage_inflight: Arc<Mutex<UsageWaiters>>,
    /// 로컬 에이전트 설정이 바뀌었다(TS `localAgents.ts` 의 `onChanged`) — 서버 링크가 능력을 다시 낸다. 링크가 없으면 비어 있다.
    on_agents_changed: OnceLock<Box<dyn Fn() + Send + Sync>>,
    /// 러너 링크(s21b-1). 첫 줄이 `hello{role:'runner'}` 인 접속을 넘겨받는다. 없으면 그 hello 는 앱 hello 로 검사돼 거절된다.
    runner_link: OnceLock<Arc<RunnerLinkServer>>,
    /// 러너가 끝났다 — 서버 링크가 배정 조정기와 서버에 알린다(s21c-1b-2b). 링크가 없으면 비어 있다.
    on_runner_exit: OnceLock<RunnerExitHook>,
    /// 같은 머신의 터미널 직결(s21c-4). 없으면 `terminal*` 요청은 배선 안 됨으로 답한다. 구독은 **접속에 묶인다**.
    local_terminal: OnceLock<Arc<LocalTerminalHub>>,
}

impl ServerState {
    /// `launch` 가 없으면 `spawnRunner` 는 거절된다(러너 프로그램은 기동 인자로만 정한다).
    pub fn new(identity: DaemonIdentity, launch: Option<RunnerLaunch>) -> Arc<Self> {
        Arc::new_cyclic(|me: &Weak<Self>| {
            let me = me.clone();
            let runners = RunnerTable::new(
                launch,
                Arc::new(move |exit| {
                    if let Some(st) = me.upgrade() {
                        eprintln!(
                            "러너 종료: agent={} code={:?} signal={:?}",
                            exit.agent_id, exit.code, exit.signal
                        );
                        st.broadcast_event("runnerExit", exit.to_json());
                        // 서버 링크(배정 조정기·`runner.exited`)에도 알린다(TS run.ts onExit 의 communities 고리).
                        if let Some(hook) = st.on_runner_exit.get() {
                            hook(&exit);
                        }
                    }
                }),
            );
            Self {
                identity,
                token: Mutex::new(String::new()),
                runners,
                authed: Mutex::new(HashMap::new()),
                next_conn: AtomicU64::new(1),
                local_agents: OnceLock::new(),
                local_merge: OnceLock::new(),
                local_mcp: OnceLock::new(),
                claude_accounts: OnceLock::new(),
                claude_logins: OnceLock::new(),
                codex_accounts: OnceLock::new(),
                usage_meters: OnceLock::new(),
                usage_inflight: Arc::new(Mutex::new(HashMap::new())),
                codex_logins: OnceLock::new(),
                on_agents_changed: OnceLock::new(),
                runner_link: OnceLock::new(),
                on_runner_exit: OnceLock::new(),
                local_terminal: OnceLock::new(),
            }
        })
    }

    /// 로컬 설정을 배선한다(한 번만 — 두 번째는 무시된다).
    pub fn set_local_agents(&self, local: LocalAgents) {
        let _ = self.local_agents.set(local);
    }

    /// 러너 종료 알림을 배선한다(한 번만). 서버 링크(`serve::spawn_server_link`)가 건다.
    ///
    /// 한 번만이어도 되는 근거: `serve_main` 은 `--base-url` 하나로 `ServerState` 하나를 만들고
    /// `spawn_server_link` 를 한 번만 부른다 — 한 프로세스에 커뮤니티(서버 링크) 하나다. 다중 인스턴스는
    /// 프로세스를 따로 띄운다(A1). 이 전제가 깨져 두 번째 링크가 걸리면 그 종료 통지가 조용히 빠지지 않게
    /// stderr 에 남긴다.
    pub fn set_on_runner_exit(&self, hook: RunnerExitHook) {
        if self.on_runner_exit.set(hook).is_err() {
            eprintln!(
                "러너 종료 알림이 이미 배선돼 있다 — 두 번째 서버 링크의 종료 통지는 전달되지 않는다"
            );
        }
    }

    /// 이 머신의 MCP 정의(A5c) — 배정 조정기가 같은 OAuth 저장소를 쓴다.
    pub fn local_mcp(&self) -> Option<&LocalMcp> {
        self.local_mcp.get()
    }

    /// 설정 변경 알림을 배선한다(한 번만). 서버 링크(`serve::spawn_server_link`)가 건다.
    pub fn set_on_agents_changed(&self, hook: Box<dyn Fn() + Send + Sync>) {
        let _ = self.on_agents_changed.set(hook);
    }

    /// 러너 링크를 배선한다(한 번만 — 두 번째는 무시된다).
    pub fn set_local_terminal(&self, hub: Arc<LocalTerminalHub>) {
        let _ = self.local_terminal.set(hub);
    }

    pub fn set_runner_link(&self, link: Arc<RunnerLinkServer>) {
        let _ = self.runner_link.set(link);
    }

    fn agents_changed(&self) {
        if let Some(hook) = self.on_agents_changed.get() {
            hook();
        }
    }

    fn local(&self) -> Result<&LocalAgents, DaemonError> {
        // TS 와 같은 코드·문구(`no-such-runner` — 앱이 이미 아는 꼴).
        self.local_agents.get().ok_or_else(|| {
            err(
                DaemonErrorCode::NoSuchRunner,
                "이 daemon 에는 로컬 설정이 배선되지 않았다",
            )
        })
    }

    /// 머지 gh 계정 설정을 배선한다(한 번만).
    pub fn set_local_merge(&self, merge: LocalMerge) {
        let _ = self.local_merge.set(merge);
    }

    fn merge(&self) -> Result<&LocalMerge, DaemonError> {
        self.local_merge.get().ok_or_else(|| {
            err(
                DaemonErrorCode::NoSuchRunner,
                "이 daemon 에는 머지 설정이 배선되지 않았다",
            )
        })
    }

    /// claude 계정 풀을 배선한다(한 번만).
    pub fn set_claude_accounts(&self, accounts: ClaudeAccounts) {
        let _ = self.claude_accounts.set(accounts);
    }

    /// claude 계정 로그인을 배선한다(한 번만). 로그인 출력은 인증된 앱 접속에만 `claudeLoginOutput` 으로 흘린다.
    pub fn set_claude_logins(self: &Arc<Self>, logins: ClaudeLogins) {
        let me = Arc::downgrade(self);
        logins.on_event(Box::new(move |e| {
            if let Some(st) = me.upgrade() {
                st.broadcast_event("claudeLoginOutput", e);
            }
        }));
        let _ = self.claude_logins.set(logins);
    }

    /// 사용률 측정기를 배선한다(한 번만). 로그인이 성공하면 그 계정의 캐시를 잊는다(TS `onSignedIn`·codex `usageCache.forget`).
    /// `on_claude_signed_in` 은 그 뒤에 부른다 — 폴러가 그 계정을 다음 tick 에 바로 다시 재게 한다(TS run.ts).
    pub fn set_usage_meters(
        &self,
        meters: crate::usage_meter::UsageMeters,
        on_claude_signed_in: Option<crate::claude_login::SignedIn>,
    ) {
        if let Some(l) = self.claude_logins.get() {
            let c = meters.claude_cache.clone();
            l.set_on_signed_in(Box::new(move |dir| {
                c.forget(&dir.to_string_lossy());
                if let Some(f) = &on_claude_signed_in {
                    f(dir);
                }
            }));
        }
        if let Some(l) = self.codex_logins.get() {
            let c = meters.codex_cache.clone();
            l.set_on_signed_in(Box::new(move |home| c.forget(&home.to_string_lossy())));
        }
        let _ = self.usage_meters.set(meters);
    }

    /// 사용률 요청을 검사하고 잴 일을 돌려준다(TS `server.ts` 의 같은 칸). 잰 결과만 싣는다 — 토큰·URL 은 싣지 않는다.
    /// 검사(배선·payload)는 지금, 측정은 돌려준 함수가 한다 — 접속 스레드 밖에서 돌리려고 갈랐다.
    pub fn usage_job(
        &self,
        ty: &str,
        payload: Option<&Value>,
    ) -> Result<Box<dyn FnOnce() -> Value + Send>, DaemonError> {
        match ty {
            "claudeAccountsProviderUsage" => {
                let port = self.accounts()?;
                let meters = self.usage_meters()?.clone();
                let req = crate::usage_meter::read_usage_request(payload).map_err(bad)?;
                let (root, pools) = (port.root().to_path_buf(), port.pools_path().to_path_buf());
                Ok(Box::new(move || {
                    let layout = claude_accounts::read_layout(&root, &pools);
                    meters.claude_snapshot(&layout, &req)
                }))
            }
            "codexAccountsProviderUsage" => {
                let port = self.codex()?;
                let meters = self.usage_meters()?.clone();
                let req = crate::usage_meter::read_usage_request(payload).map_err(bad)?;
                let (sys, root) = (port.system_home().to_path_buf(), port.root().to_path_buf());
                Ok(Box::new(move || meters.codex_snapshot(&sys, &root, &req)))
            }
            other => Err(err(
                DaemonErrorCode::Internal,
                format!("사용률 요청이 아니다: {other}"),
            )),
        }
    }

    fn usage_meters(&self) -> Result<&crate::usage_meter::UsageMeters, DaemonError> {
        self.usage_meters.get().ok_or_else(|| {
            err(
                DaemonErrorCode::NoSuchRunner,
                "이 daemon 에는 사용률 측정기가 배선되지 않았다",
            )
        })
    }

    /// 진행 중인 로그인을 전부 회수한다(TS run.ts 종료 경로의 `shutdownLogins`).
    pub fn shutdown_logins(&self) {
        if let Some(l) = self.claude_logins.get() {
            l.shutdown();
        }
    }

    fn logins(&self) -> Result<&ClaudeLogins, DaemonError> {
        self.accounts()?;
        self.claude_logins.get().ok_or_else(|| {
            err(
                DaemonErrorCode::NoSuchRunner,
                "이 daemon 에는 계정 풀이 배선되지 않았다",
            )
        })
    }

    fn accounts(&self) -> Result<&ClaudeAccounts, DaemonError> {
        // TS `requireAccounts` 와 같은 꼴.
        self.claude_accounts.get().ok_or_else(|| {
            err(
                DaemonErrorCode::NoSuchRunner,
                "이 daemon 에는 계정 풀이 배선되지 않았다",
            )
        })
    }

    /// MCP 정의를 배선한다(한 번만).
    /// codex 계정을 배선한다(한 번만).
    pub fn set_codex_accounts(&self, accounts: CodexAccounts) {
        let _ = self.codex_accounts.set(accounts);
    }

    /// codex 로그인을 배선한다(한 번만). 로그인 출력은 인증된 앱 접속에만 `codexLoginOutput` 으로 흘린다.
    pub fn set_codex_logins(self: &Arc<Self>, logins: CodexLogins) {
        let me = Arc::downgrade(self);
        logins.on_event(Box::new(move |e| {
            if let Some(st) = me.upgrade() {
                st.broadcast_event("codexLoginOutput", e);
            }
        }));
        let _ = self.codex_logins.set(logins);
    }

    /// 진행 중인 codex 로그인을 전부 회수한다(TS run.ts 종료 경로의 `codexAccounts.shutdownLogins`).
    pub fn shutdown_codex_logins(&self) {
        if let Some(l) = self.codex_logins.get() {
            l.shutdown();
        }
    }

    fn codex_logins(&self) -> Result<&CodexLogins, DaemonError> {
        self.codex()?;
        self.codex_logins.get().ok_or_else(|| {
            err(
                DaemonErrorCode::NoSuchRunner,
                "이 daemon 에는 codex 계정이 배선되지 않았다",
            )
        })
    }

    fn codex(&self) -> Result<&CodexAccounts, DaemonError> {
        // TS `requireCodexAccounts` 와 같은 꼴.
        self.codex_accounts.get().ok_or_else(|| {
            err(
                DaemonErrorCode::NoSuchRunner,
                "이 daemon 에는 codex 계정이 배선되지 않았다",
            )
        })
    }

    pub fn set_local_mcp(&self, mcp: LocalMcp) {
        let _ = self.local_mcp.set(mcp);
    }

    fn mcp(&self) -> Result<&LocalMcp, DaemonError> {
        self.local_mcp.get().ok_or_else(|| {
            err(
                DaemonErrorCode::NoSuchRunner,
                "이 daemon 에는 MCP 정의가 배선되지 않았다",
            )
        })
    }

    pub fn set_token(&self, token: String) {
        *self.token.lock().unwrap_or_else(|p| p.into_inner()) = token;
    }

    fn token(&self) -> String {
        self.token.lock().unwrap_or_else(|p| p.into_inner()).clone()
    }

    fn authed(&self) -> std::sync::MutexGuard<'_, HashMap<u64, Writer>> {
        self.authed.lock().unwrap_or_else(|p| p.into_inner())
    }

    /// 이벤트를 인증된 접속 전부에 흘린다. 인증 못 한 접속에는 아무것도 흘리지 않는다 — 이벤트도 정보다.
    pub fn broadcast_event(&self, name: &str, payload: Value) {
        debug_assert!(EVENT_NAMES.contains(&name));
        let Ok(line) = encode_line(&json!({ "type": "event", "event": name, "payload": payload }))
        else {
            return;
        };
        let writers: Vec<(u64, Writer)> = self
            .authed()
            .iter()
            .map(|(id, w)| (*id, Arc::clone(w)))
            .collect();
        for (id, w) in writers {
            let mut stream = w.lock().unwrap_or_else(|p| p.into_inner());
            if stream.write_all(&line).is_err() {
                // 시간 제한(`WRITE_TIMEOUT`)을 넘겼거나 끊긴 접속이다. 명단에서 빼고 양쪽을 닫는다 — 줄이 반쯤
                // 나갔을 수 있어 그 접속으로는 더 쓸 수 없고, 읽는 스레드도 0 을 읽고 끝난다.
                let _ = stream.shutdown(Shutdown::Both);
                drop(stream);
                self.authed().remove(&id);
                eprintln!("이벤트 쓰기 실패 — 접속을 끊는다: conn={id}");
            }
        }
    }

    /// `terminal*` 요청(TS `server.ts::handleTerminal`). 거절은 오류가 아니라 `{ok:false, reason}` 이다 —
    /// 앱은 `not-viewer`·`not-writer` 면 서버 경유로, `no-such-session` 이면 이 머신 것이 아니라고 읽는다.
    fn handle_terminal(
        &self,
        conn_id: u64,
        writer: &Writer,
        ty: &str,
        payload: Option<&Value>,
    ) -> Result<Value, DaemonError> {
        let Some(hub) = self.local_terminal.get() else {
            return Err(err(
                DaemonErrorCode::Internal,
                "이 오퍼레이터에는 터미널 직결이 배선되지 않았다",
            ));
        };
        let p = payload.cloned().unwrap_or(Value::Null);
        let str_of = |k: &str| p.get(k).and_then(Value::as_str);
        let session_id = match str_of("sessionId") {
            Some(s) if !s.is_empty() => s,
            _ => return Err(bad("sessionId 가 필요하다".into())),
        };
        let answer = |r: Result<(), crate::local_terminal::Refusal>| match r {
            Ok(()) => json!({ "ok": true }),
            Err(r) => json!({ "ok": false, "reason": r.as_str() }),
        };
        match ty {
            "terminalIsLocal" => Ok(json!({ "local": hub.is_local(session_id) })),
            "terminalSubscribe" => {
                let Some(view_key) = str_of("viewKey") else {
                    return Err(bad("viewKey 가 필요하다".into()));
                };
                let sub = Arc::new(ConnSub {
                    id: conn_id,
                    writer: Arc::clone(writer),
                });
                Ok(answer(hub.subscribe(sub, session_id, view_key)))
            }
            "terminalUnsubscribe" => {
                hub.unsubscribe(
                    &ConnSub {
                        id: conn_id,
                        writer: Arc::clone(writer),
                    },
                    session_id,
                );
                Ok(json!({ "ok": true }))
            }
            "terminalInput" => match (str_of("writerKey"), str_of("data")) {
                (Some(k), Some(d)) => Ok(answer(hub.input(session_id, k, d))),
                _ => Err(bad("writerKey·data 가 필요하다".into())),
            },
            "terminalResize" => {
                let (Some(k), Some(c), Some(r)) = (
                    str_of("writerKey"),
                    p.get("cols").filter(|v| v.is_number()),
                    p.get("rows").filter(|v| v.is_number()),
                ) else {
                    return Err(bad("writerKey·cols·rows 가 필요하다".into()));
                };
                Ok(answer(hub.resize(session_id, k, c, r)))
            }
            _ => Err(err(DaemonErrorCode::UnknownRequest, ty)),
        }
    }

    /// 인증된 요청 하나에 대한 답(`DaemonServer.dispatch`).
    pub fn dispatch(&self, ty: &str, payload: Option<&Value>) -> Result<Value, DaemonError> {
        match ty {
            "ping" => Ok(json!({ "nowMs": now_ms() })),
            "listRunners" => Ok(json!({ "runners": self.runners.list_runners() })),
            "spawnRunner" => {
                let (agent_id, env) = read_spawn_params(payload)?;
                let outcome = self
                    .runners
                    .spawn_runner(&agent_id, &env, None)
                    .map_err(|m| err(DaemonErrorCode::Internal, m))?;
                let r = outcome.record();
                // env 를 로그에 적지 않는다 — PAT 가 실린다. 띄웠는지·이미 있었는지를 가른다(TS `#456` ②).
                match &outcome {
                    SpawnOutcome::Started(_) => {
                        eprintln!("러너 spawn: agent={} pid={}", r.agent_id, r.pid)
                    }
                    SpawnOutcome::Existing(_) => eprintln!(
                        "러너가 이미 있다 — 새로 안 띄운다: agent={} pid={}",
                        r.agent_id, r.pid
                    ),
                }
                Ok(
                    json!({ "agentId": r.agent_id, "pid": r.pid, "incarnationId": r.incarnation_id }),
                )
            }
            "killRunner" => {
                let (agent_id, incarnation_id) = read_kill_params(payload)?;
                let Some(r) = self
                    .runners
                    .kill_runner(&agent_id, incarnation_id.as_deref())
                else {
                    return Err(err(
                        DaemonErrorCode::NoSuchRunner,
                        format!("이 daemon 이 아는 러너가 아니다: {agent_id}"),
                    ));
                };
                eprintln!("SIGTERM 보냄: agent={} pid={}", r.agent_id, r.pid);
                Ok(
                    json!({ "agentId": r.agent_id, "pid": r.pid, "termSentAtMs": r.term_sent_at_ms }),
                )
            }
            // ── 오퍼레이터 로컬 설정(A5a, TS `server.ts` 의 같은 칸) ──────────────────────────
            "operatorAgentsList" => self.local()?.list(),
            "operatorAgentSet" => {
                let local = self.local()?;
                let (base_url, agent_id, config) = local_agents::read_set_payload(payload)?;
                local.set(&base_url, &agent_id, &config)?;
                eprintln!("로컬 설정: agent={agent_id} @ {base_url} 넣음");
                self.agents_changed();
                Ok(json!({}))
            }
            "operatorAgentProviderLaneSet" => {
                let local = self.local()?;
                let (base_url, agent_id, lane) = local_agents::read_lane_payload(payload)?;
                local.set_provider_lane(&base_url, &agent_id, lane.as_ref())?;
                // 주소·비밀 이름은 찍지 않는다 — 켜졌는지만.
                eprintln!(
                    "로컬 설정: agent={agent_id} @ {base_url} 전용 제공사 경로 {}",
                    if lane.is_some() { "켬" } else { "끔" }
                );
                self.agents_changed();
                Ok(json!({}))
            }
            "operatorAgentRemove" => {
                let local = self.local()?;
                let (base_url, agent_id) = local_agents::read_remove_payload(payload)?;
                local.remove(&base_url, &agent_id)?;
                eprintln!("로컬 설정: agent={agent_id} @ {base_url} 뺌");
                self.agents_changed();
                Ok(json!({}))
            }
            // ── 머지 gh 계정(A5b, TS `server.ts` 의 같은 칸) ──────────────────────────────────
            "operatorMergeGet" => self.merge()?.get(),
            "operatorMergeSet" => {
                let merge = self.merge()?;
                let p = local_merge::read_set_payload(payload)?;
                let (state, changes) = merge.set(&p)?;
                // 바꾼 사실을 남긴다(security C8) — 이름뿐이다, 토큰은 이 경로에 없다.
                for c in changes {
                    eprintln!(
                        "머지 gh 계정{}: {} → {} @ {}",
                        c.scope.map(|s| format!(" [{s}]")).unwrap_or_default(),
                        c.from.as_deref().unwrap_or("(없음)"),
                        c.to.as_deref().unwrap_or("(없음)"),
                        merge.host()
                    );
                }
                Ok(state)
            }
            "operatorMergeCheck" => {
                let merge = self.merge()?;
                let scopes = local_merge::read_check_payload(payload)?;
                Ok(merge.check(&scopes))
            }
            // ── 이 머신의 MCP 정의(A5c, TS `server.ts` 의 같은 칸) ─────────────────────────────────
            // 로그에는 이름만 — 정의 본문·env·headers 에 토큰이 실린다.
            "operatorMcpList" => self.mcp()?.list(),
            "operatorMcpSet" => {
                let mcp = self.mcp()?;
                let (name, def) = local_mcp::read_set_payload(payload)?;
                mcp.set(&name, &def)?;
                eprintln!("MCP 정의: {name} 넣음");
                Ok(json!({}))
            }
            "operatorMcpSetStdio" => {
                let mcp = self.mcp()?;
                let (name, def) = local_mcp::read_set_stdio_payload(payload)?;
                mcp.set_stdio(&name, &def)?;
                eprintln!("MCP 정의: {name} 넣음(stdio)");
                Ok(json!({}))
            }
            "operatorMcpRemove" => {
                let mcp = self.mcp()?;
                let name = local_mcp::read_remove_payload(payload)?;
                mcp.remove(&name)?;
                eprintln!("MCP 정의: {name} 뺌");
                Ok(json!({}))
            }
            // ── OAuth(A5d, TS `server.ts` 의 같은 칸). 인가 url·토큰은 로그에 적지 않는다 ──────────────────────
            "operatorMcpAuthStart" => {
                let mcp = self.mcp()?;
                let name = local_mcp::read_auth_payload(payload, "operatorMcpAuthStart")?;
                let r = mcp.auth_start(&name)?;
                eprintln!("MCP OAuth: {name} 흐름 시작");
                Ok(r)
            }
            "operatorMcpAuthStatus" => {
                let mcp = self.mcp()?;
                let name = local_mcp::read_auth_payload(payload, "operatorMcpAuthStatus")?;
                mcp.auth_status(&name)
            }
            "operatorMcpAuthForget" => {
                let mcp = self.mcp()?;
                let name = local_mcp::read_auth_payload(payload, "operatorMcpAuthForget")?;
                mcp.auth_forget(&name)?;
                eprintln!("MCP OAuth: {name} 토큰 지움");
                Ok(json!({}))
            }
            // ── claude 계정 풀(s21c3a) — 로그에는 계정 이름만 적는다(TS 와 같은 규율).
            "claudeAccountsList" => Ok(self.accounts()?.list()),
            "claudeAccountsConfigure" => {
                let port = self.accounts()?;
                let cfg = claude_accounts::read_configure_payload(payload).map_err(bad)?;
                port.configure(&cfg).map_err(bad)?;
                eprintln!(
                    "계정 설정 갱신: 기본 풀={}",
                    cfg["defaultPool"].as_str().unwrap_or("(없음)")
                );
                Ok(json!({}))
            }
            "claudeAccountLoginStart" => {
                let port = self.logins()?;
                let (pool, account) = claude_accounts::read_account_ref(payload).map_err(bad)?;
                // 옛 앱은 `reauth` 를 싣지 않는다 — 그때는 지금까지와 같은 로그인이다.
                let reauth = payload.and_then(|p| p.get("reauth")) == Some(&Value::Bool(true));
                let login_id = port.start(&pool, &account, reauth).map_err(bad)?;
                eprintln!(
                    "계정 {}로그인 시작: {pool}/{account}",
                    if reauth { "다시 " } else { "" }
                );
                Ok(json!({ "loginId": login_id }))
            }
            "claudeAccountLoginSubmit" => {
                let port = self.logins()?;
                let (login_id, code) = claude_login::read_login_submit(payload).map_err(bad)?;
                // 코드를 로그에 적지 않는다 — 그것으로 자격증명을 교환할 수 있다.
                port.submit(&login_id, &code).map_err(bad)?;
                Ok(json!({}))
            }
            "claudeAccountLoginCancel" => {
                let port = self.logins()?;
                let login_id = claude_login::read_login_ref(payload).map_err(bad)?;
                port.cancel(&login_id);
                Ok(json!({}))
            }
            "claudeAccountRemove" => {
                let port = self.accounts()?;
                let (pool, account) = claude_accounts::read_account_ref(payload).map_err(bad)?;
                port.remove_account(&pool, &account).map_err(bad)?;
                // TS `usageCache.forget(dir)` — 같은 이름으로 다시 만든 계정이 지난 값을 물려받지 않게.
                if let (Some(m), Ok(dir)) = (
                    self.usage_meters.get(),
                    claude_accounts::under(port.root(), &[&pool, &account]),
                ) {
                    m.claude_cache.forget(&dir.to_string_lossy());
                }
                eprintln!("계정 삭제: {pool}/{account}");
                Ok(json!({}))
            }
            "claudePoolRemove" => {
                let port = self.accounts()?;
                let pool = claude_accounts::read_pool_ref(payload).map_err(bad)?;
                port.remove_pool(&pool).map_err(bad)?;
                // TS `usageCache.forgetUnder(dir)`.
                if let (Some(m), Ok(dir)) = (
                    self.usage_meters.get(),
                    claude_accounts::under(port.root(), &[&pool]),
                ) {
                    m.claude_cache.forget_under(&dir);
                }
                eprintln!("풀 삭제: {pool}");
                Ok(json!({}))
            }
            "claudeAccountMove" => {
                let port = self.accounts()?;
                let (account, to_pool) =
                    claude_accounts::read_account_move(payload).map_err(bad)?;
                let result = port.move_account(&account, &to_pool).map_err(bad)?;
                eprintln!(
                    "계정 이전: {account} → {to_pool}/{account} (로그인 유지={})",
                    result["loggedIn"]
                );
                Ok(result)
            }
            // ── 공급자 사용률(s21c3d-3, TS `server.ts` 의 같은 칸). 잰 결과만 돌려준다 — 토큰·URL 은 싣지 않는다.
            // ── 공급자 사용률(s21c3d-3) — 소켓에서는 `usage_job` 으로 따로 돈다. 여기는 같은 결과를 곧바로 낸다.
            "claudeAccountsProviderUsage" | "codexAccountsProviderUsage" => {
                Ok(self.usage_job(ty, payload)?())
            }
            // ── codex 계정(s21c3c) — 로그에는 계정 이름만 적는다(이메일은 사람의 로컬 사실이다).
            "codexAccountsList" => Ok(self.codex()?.list()),
            "codexAccountLoginStart" => {
                let port = self.codex_logins()?;
                let account = codex_accounts::read_account_ref(payload).map_err(bad)?;
                let login_id = port.start(&account).map_err(bad)?;
                // URL 은 로그에 적지 않는다 — 계정 이름만.
                eprintln!("codex 계정 로그인 시작: {account}");
                Ok(json!({ "loginId": login_id }))
            }
            "codexAccountLoginCancel" => {
                let port = self.codex_logins()?;
                let login_id = codex_login::read_login_ref(payload).map_err(bad)?;
                port.cancel(&login_id);
                Ok(json!({}))
            }
            "codexAccountRemove" => {
                let port = self.codex()?;
                let account = codex_accounts::read_account_ref(payload).map_err(bad)?;
                port.remove_account(&account).map_err(bad)?;
                if let (Some(m), Ok(dir)) = (
                    self.usage_meters.get(),
                    codex_accounts::under(port.root(), &account),
                ) {
                    m.codex_cache.forget(&dir.to_string_lossy());
                }
                eprintln!("codex 계정 삭제: {account}");
                Ok(json!({}))
            }
            "codexAccountActivate" => {
                let port = self.codex()?;
                let account = codex_accounts::read_activate(payload).map_err(bad)?;
                port.activate(account.as_deref()).map_err(bad)?;
                eprintln!(
                    "codex 활성 계정: {}",
                    account.as_deref().unwrap_or("(시스템 기본)")
                );
                Ok(json!({}))
            }
            other => Err(err(
                DaemonErrorCode::Internal,
                format!("이 오퍼레이터(Rust)에는 아직 없는 요청이다: {other}"),
            )),
        }
    }
}

/// TS `readSpawnParams` 와 같은 검사·문구.
pub fn read_spawn_params(
    payload: Option<&Value>,
) -> Result<(String, Vec<(String, String)>), DaemonError> {
    let Some(obj) = payload.and_then(Value::as_object) else {
        return Err(err(DaemonErrorCode::BadPayload, "payload 가 객체가 아니다"));
    };
    let agent_id = match obj.get("agentId").and_then(Value::as_str) {
        Some(s) if !s.is_empty() => s.to_string(),
        _ => return Err(err(DaemonErrorCode::BadPayload, "agentId 가 없다")),
    };
    let Some(env) = obj.get("env").and_then(Value::as_object) else {
        return Err(err(DaemonErrorCode::BadPayload, "env 가 객체가 아니다"));
    };
    let mut out = Vec::with_capacity(env.len());
    for (k, v) in env {
        let Some(v) = v.as_str() else {
            return Err(err(
                DaemonErrorCode::BadPayload,
                format!("env.{k} 가 문자열이 아니다"),
            ));
        };
        out.push((k.clone(), v.to_string()));
    }
    Ok((agent_id, out))
}

/// TS `readKillParams` 와 같은 검사·문구.
pub fn read_kill_params(payload: Option<&Value>) -> Result<(String, Option<String>), DaemonError> {
    let Some(obj) = payload.and_then(Value::as_object) else {
        return Err(err(DaemonErrorCode::BadPayload, "payload 가 객체가 아니다"));
    };
    let agent_id = match obj.get("agentId").and_then(Value::as_str) {
        Some(s) if !s.is_empty() => s.to_string(),
        _ => return Err(err(DaemonErrorCode::BadPayload, "agentId 가 없다")),
    };
    let incarnation_id = match obj.get("incarnationId") {
        None => None,
        Some(Value::String(s)) => Some(s.clone()),
        Some(_) => {
            return Err(err(
                DaemonErrorCode::BadPayload,
                "incarnationId 가 문자열이 아니다",
            ));
        }
    };
    Ok((agent_id, incarnation_id))
}

/// 접속 하나를 끝까지 서비스한다. `hello` 전에는 아무 요청도 받지 않고, 거절이면 사유 한 줄을 보내고 끊는다.
pub fn serve_connection(state: &ServerState, stream: UnixStream) {
    serve_connection_in(state, stream, None);
}

/// `slot` 은 인증 전 자리다. 러너로 인증되면 링크가 러너 몫 자리를 잡은 뒤 놓는다(10:56 A안).
fn serve_connection_in(state: &ServerState, mut stream: UnixStream, slot: Option<Slot>) {
    // 쓰기 시간 제한은 소켓 옵션(SO_SNDTIMEO)이라 복제한 fd 에도 같이 걸린다. 못 걸면 받지 않는다.
    if stream.set_write_timeout(Some(WRITE_TIMEOUT)).is_err() {
        return;
    }
    let writer: Writer = match stream.try_clone() {
        Ok(w) => Arc::new(Mutex::new(w)),
        Err(_) => return,
    };
    let conn_id = state.next_conn.fetch_add(1, Ordering::Relaxed);
    // 끝날 때 이벤트 명단에서 뺀다(패닉이어도 빠진다).
    struct Leave<'a>(&'a ServerState, u64);
    impl Drop for Leave<'_> {
        fn drop(&mut self) {
            self.0.authed().remove(&self.1);
            // 이 접속의 터미널 구독을 놓는다(TS `close` 의 `localTerminal.drop`).
            if let Some(hub) = self.0.local_terminal.get() {
                hub.drop_subscriber(self.1);
            }
        }
    }
    let _leave = Leave(state, conn_id);
    let mut decoder = NdjsonDecoder::default();
    let mut authenticated = false;
    let mut buf = vec![0u8; 64 * 1024];
    loop {
        let n = match stream.read(&mut buf) {
            Ok(0) | Err(_) => return,
            Ok(n) => n,
        };
        let mut lines = decoder.push(&buf[..n]).into_iter();
        while let Some(line) = lines.next() {
            // 러너의 hello 면 접속을 링크에 넘긴다 — 같은 청크에 이미 풀린 뒷줄과 덜 끝난 줄의 머리도 함께
            // (TS `server.ts::onData`). 넘기지 않으면 hello 바로 뒤의 첫 announce 가 앱 요청으로 새어 거절된다.
            if !authenticated
                && let Decoded::Ok(v) = &line
                && v.get("role").and_then(Value::as_str) == Some("runner")
                && let Some(link) = state.runner_link.get()
            {
                let rest: Vec<Value> = lines
                    .filter_map(|l| match l {
                        Decoded::Ok(v) => Some(v),
                        Decoded::Err(_) => None,
                    })
                    .collect();
                let buffered = decoder.take_buffered();
                drop(writer);
                link.serve(stream, v, rest, buffered, move || drop(slot));
                return;
            }
            let reply = match line {
                Decoded::Err(e) => {
                    let drop = e.code == DaemonErrorCode::LineTooLong;
                    let _ = write_value(&writer, &error_response(None, &e));
                    if drop {
                        return;
                    }
                    continue;
                }
                Decoded::Ok(v) if !authenticated => match check_hello(&v, &state.token()) {
                    Ok(()) => {
                        authenticated = true;
                        let ok = json!({ "type": "hello", "ok": true, "daemon": state.identity });
                        // hello 응답을 먼저 쓰고 나서 명단에 올린다 — 이벤트가 hello 응답보다 앞서 가지 않게.
                        if write_value(&writer, &ok).is_err() {
                            return;
                        }
                        state.authed().insert(conn_id, Arc::clone(&writer));
                        continue;
                    }
                    Err(e) => {
                        let _ = write_value(
                            &writer,
                            &json!({ "type": "hello", "ok": false, "error": e }),
                        );
                        eprintln!("hello 거절: {}", e.message);
                        return;
                    }
                },
                Decoded::Ok(v) => match parse_request(&v) {
                    Err(e) => error_response(read_id(&v), &e),
                    // 사용률 요청은 처음 재거나 `force` 면 CLI 를 기다린다(45초까지) — 이 접속의 다른 요청을 막지 않게 따로 돈다
                    // (TS 는 await 사이에 다른 요청을 받는다). 답은 같은 writer 로 id 를 달아 쓴다.
                    Ok((id, ty, payload)) if is_slow_request(&ty) => {
                        match state.usage_job(&ty, payload.as_ref()) {
                            Err(e) => error_response(Some(id), &e),
                            Ok(job) => {
                                let key = usage_key(&ty, payload.as_ref());
                                state.run_usage(key, id, Arc::clone(&writer), job);
                                continue;
                            }
                        }
                    }
                    // 터미널 직결은 접속을 알아야 한다(구독이 접속에 묶인다) — `dispatch` 가 아니라 여기서 받는다.
                    Ok((id, ty, payload)) if ty.starts_with("terminal") => {
                        match state.handle_terminal(conn_id, &writer, &ty, payload.as_ref()) {
                            Ok(p) => json!({ "id": id, "ok": true, "payload": p }),
                            Err(e) => error_response(Some(id), &e),
                        }
                    }
                    Ok((id, ty, payload)) => match state.dispatch(&ty, payload.as_ref()) {
                        Ok(p) => json!({ "id": id, "ok": true, "payload": p }),
                        Err(e) => error_response(Some(id), &e),
                    },
                },
            };
            if write_value(&writer, &reply).is_err() {
                return;
            }
        }
    }
}

/// 같은 사용률 요청을 하나로 묶는 열쇠 — 종류와 payload 글자(같은 앱의 같은 버튼은 같은 글자를 낸다).
fn usage_key(ty: &str, payload: Option<&Value>) -> String {
    format!("{ty}\u{0}{}", payload.unwrap_or(&Value::Null))
}

impl ServerState {
    /// 사용률 요청을 접속 스레드 밖에서 돌린다. 같은 열쇠가 이미 돌고 있으면 그 결과를 함께 받는다(스레드를 새로 띄우지 않는다).
    /// 결과가 나오면 기다리던 모든 (id, writer) 에 같은 payload 를 쓴다. 쓰기 실패는 그 접속만의 일이다.
    pub(crate) fn run_usage(
        &self,
        key: String,
        id: String,
        writer: Writer,
        job: Box<dyn FnOnce() -> Value + Send>,
    ) {
        {
            let mut inflight = self
                .usage_inflight
                .lock()
                .unwrap_or_else(|p| p.into_inner());
            if let Some(waiters) = inflight.get_mut(&key) {
                waiters.push((id, writer));
                return;
            }
            inflight.insert(key.clone(), vec![(id, writer)]);
        }
        let inflight = Arc::clone(&self.usage_inflight);
        std::thread::spawn(move || {
            // 측정이 패닉해도 열쇠를 지우고 기다리던 쪽 모두에 답한다 — 남겨 두면 그 열쇠의 요청이 영영 답을 못 받는다.
            let result = std::panic::catch_unwind(std::panic::AssertUnwindSafe(job));
            let waiters = inflight
                .lock()
                .unwrap_or_else(|p| p.into_inner())
                .remove(&key)
                .unwrap_or_default();
            for (id, w) in waiters {
                let reply = match &result {
                    Ok(payload) => json!({ "id": id, "ok": true, "payload": payload }),
                    Err(_) => error_response(
                        Some(id),
                        &err(DaemonErrorCode::Internal, "사용률을 재다 멈췄다"),
                    ),
                };
                let _ = write_value(&w, &reply);
            }
        });
    }
}

/// 접속 스레드 밖에서 처리할 요청 — 공급자 사용률(s21c3d-3).
fn is_slow_request(ty: &str) -> bool {
    matches!(
        ty,
        "claudeAccountsProviderUsage" | "codexAccountsProviderUsage"
    )
}

fn write_value(writer: &Writer, v: &Value) -> std::io::Result<()> {
    let bytes = encode_line(v).map_err(|e| std::io::Error::other(e.message))?;
    writer
        .lock()
        .unwrap_or_else(|p| p.into_inner())
        .write_all(&bytes)
}

/// 터미널 구독자 하나 = 앱 소켓 접속 하나(TS `conn.terminal`). 같은 접속은 같은 id 라 구독을 다시 열면 키만 바뀐다.
struct ConnSub {
    id: u64,
    writer: Writer,
}

impl crate::local_terminal::LocalTerminalSubscriber for ConnSub {
    fn id(&self) -> u64 {
        self.id
    }
    fn send(&self, event: &str, payload: Value) {
        debug_assert!(EVENT_NAMES.contains(&event));
        // 끊긴 접속은 읽는 쪽이 0 을 읽고 끝나며 `Leave` 가 구독을 놓는다. 쓰기 실패면 양쪽을 닫아 그 길을 앞당긴다.
        let line = json!({ "type": "event", "event": event, "payload": payload });
        if write_value(&self.writer, &line).is_err() {
            let _ = self
                .writer
                .lock()
                .unwrap_or_else(|p| p.into_inner())
                .shutdown(Shutdown::Both);
        }
    }
}

/// 듣기 고리. 접속마다 스레드 하나.
/// 동시 연결 상한(security C3). 연결마다 스레드가 하나라, 상주 프로세스가 되면 스레드 수를 묶어 둔다.
pub const MAX_CONNECTIONS: usize = 64;

/// 연결 하나가 끝나면 자리를 돌려준다(스레드가 패닉해도 drop 으로 돌려준다).
struct Slot(Arc<AtomicUsize>);

impl Drop for Slot {
    fn drop(&mut self) {
        self.0.fetch_sub(1, Ordering::AcqRel);
    }
}

fn take_slot(active: &Arc<AtomicUsize>, limit: usize) -> Option<Slot> {
    // `fetch_update` 는 새 Rust 에서 `try_update` 로 이름이 바뀌어(옛 이름은 deprecated) 판마다 갈린다 —
    // 어느 판에서나 같은 compare_exchange 반복으로 쓴다.
    let mut n = active.load(Ordering::Acquire);
    loop {
        if n >= limit {
            return None;
        }
        match active.compare_exchange_weak(n, n + 1, Ordering::AcqRel, Ordering::Acquire) {
            Ok(_) => return Some(Slot(Arc::clone(active))),
            Err(now) => n = now,
        }
    }
}

pub fn accept_loop(state: Arc<ServerState>, listener: UnixListener) {
    accept_loop_with_limit(state, listener, MAX_CONNECTIONS);
}

/// 상한을 넘은 연결은 사유 한 줄을 보내고 곧바로 닫는다 — 스레드를 띄우지 않는다.
pub fn accept_loop_with_limit(state: Arc<ServerState>, listener: UnixListener, limit: usize) {
    let active = Arc::new(AtomicUsize::new(0));
    for conn in listener.incoming() {
        let Ok(mut stream) = conn else { continue };
        let Some(slot) = take_slot(&active, limit) else {
            // 앱은 첫 줄로 hello 응답을 기다리므로 hello 거절 꼴로 답한다.
            let e = err(
                DaemonErrorCode::Internal,
                format!("동시 연결 상한({limit})을 넘었다"),
            );
            let msg = json!({ "type": "hello", "ok": false, "error": e });
            if let Ok(line) = encode_line(&msg) {
                let _ = stream.write_all(&line);
            }
            continue;
        };
        let st = Arc::clone(&state);
        std::thread::spawn(move || {
            serve_connection_in(&st, stream, Some(slot));
        });
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    mod runner_hello {
        use super::*;
        use crate::runner_link::RunnerLinkHandler;
        use std::sync::mpsc;

        struct Rec(Mutex<mpsc::Sender<(String, String, Value)>>);
        impl RunnerLinkHandler for Rec {
            fn on_frame(&self, runner_id: &str, agent_id: &str, frame: Value) {
                let _ = self.0.lock().unwrap().send((
                    runner_id.to_string(),
                    agent_id.to_string(),
                    frame,
                ));
            }
            fn log(&self, _line: &str) {}
        }

        fn state() -> Arc<ServerState> {
            let st = ServerState::new(
                DaemonIdentity {
                    pid: 1,
                    started_at_ms: 0,
                    launch_nonce: String::new(),
                    entry_path: String::new(),
                    app_version: String::new(),
                },
                None,
            );
            st.set_token("app-token".into());
            st
        }

        fn serve(st: &Arc<ServerState>) -> UnixStream {
            let (ours, theirs) = UnixStream::pair().unwrap();
            let st = Arc::clone(st);
            std::thread::spawn(move || serve_connection(&st, theirs));
            ours.set_read_timeout(Some(Duration::from_secs(5))).unwrap();
            ours
        }

        const HELLO: &str =
            r#"{"type":"hello","version":1,"role":"runner","runnerId":"r1","secret":"s3cret"}"#;

        #[test]
        fn runner_hello_hands_socket_to_link_with_same_chunk_lines_and_partial_tail() {
            let st = state();
            let (tx, rx) = mpsc::channel();
            let link = RunnerLinkServer::new(Arc::new(Rec(Mutex::new(tx))), None);
            link.expect("r1", "agent-1", "s3cret");
            st.set_runner_link(Arc::clone(&link));
            let mut c = serve(&st);
            // hello·첫 프레임·덜 끝난 둘째 프레임의 머리가 한 청크로 간다.
            let chunk =
                format!("{HELLO}\n{{\"type\":\"announce\",\"n\":1}}\n{{\"type\":\"announce\",");
            c.write_all(chunk.as_bytes()).unwrap();
            let first = rx.recv_timeout(Duration::from_secs(5)).unwrap();
            assert_eq!(
                first,
                (
                    "r1".into(),
                    "agent-1".into(),
                    json!({"type":"announce","n":1})
                )
            );
            c.write_all(b"\"n\":2}\n").unwrap();
            let second = rx.recv_timeout(Duration::from_secs(5)).unwrap();
            assert_eq!(second.2, json!({"type":"announce","n":2}));
            assert!(link.is_linked("r1"));
            // 앱 명단에는 오르지 않는다 — 앱 이벤트가 러너 소켓으로 새지 않는다.
            assert!(st.authed().is_empty());
        }

        #[test]
        fn runner_hello_without_link_is_refused_as_app_hello() {
            let st = state();
            let mut c = serve(&st);
            c.write_all(format!("{HELLO}\n").as_bytes()).unwrap();
            let mut line = String::new();
            std::io::BufRead::read_line(&mut std::io::BufReader::new(&mut c), &mut line).unwrap();
            let v: Value = serde_json::from_str(&line).unwrap();
            assert_eq!(v["ok"], json!(false));
            assert!(v["error"]["message"].as_str().unwrap().contains("role"));
        }

        #[test]
        fn unknown_runner_secret_is_not_admitted_and_app_hello_still_works() {
            let st = state();
            let (tx, rx) = mpsc::channel();
            let link = RunnerLinkServer::new(Arc::new(Rec(Mutex::new(tx))), None);
            link.expect("r1", "agent-1", "other");
            st.set_runner_link(Arc::clone(&link));
            let mut c = serve(&st);
            c.write_all(format!("{HELLO}\n{{\"type\":\"announce\"}}\n").as_bytes())
                .unwrap();
            assert!(rx.recv_timeout(Duration::from_millis(300)).is_err());
            assert!(!link.is_linked("r1"));
            let mut app = serve(&st);
            app.write_all(
                b"{\"type\":\"hello\",\"version\":1,\"role\":\"app\",\"token\":\"app-token\"}\n",
            )
            .unwrap();
            let mut line = String::new();
            std::io::BufRead::read_line(&mut std::io::BufReader::new(&mut app), &mut line).unwrap();
            assert_eq!(
                serde_json::from_str::<Value>(&line).unwrap()["ok"],
                json!(true)
            );
        }
    }

    mod terminal {
        use super::*;
        use crate::local_terminal::{LocalTerminalDeps, LocalTerminalHub};
        use std::io::{BufRead, BufReader};

        #[derive(Default)]
        struct ToRunner(Mutex<Vec<(String, Value)>>);
        struct Deps(Arc<ToRunner>);
        impl LocalTerminalDeps for Deps {
            fn send_to_runner(&self, runner_id: &str, frame: &Value) -> bool {
                self.0
                    .0
                    .lock()
                    .unwrap()
                    .push((runner_id.into(), frame.clone()));
                true
            }
            fn report_input(&self, _r: &str, _s: &str, _g: i64, _b: i64) {}
            fn log(&self, _line: &str) {}
        }

        const VK: &str = "view-key-0123456789abcdef";
        const WK: &str = "writer-key-0123456789abcdef";

        fn setup() -> (Arc<ServerState>, Arc<LocalTerminalHub>, Arc<ToRunner>) {
            let st = ServerState::new(
                DaemonIdentity {
                    pid: 1,
                    started_at_ms: 0,
                    launch_nonce: String::new(),
                    entry_path: String::new(),
                    app_version: String::new(),
                },
                None,
            );
            st.set_token("app-token".into());
            let rec = Arc::new(ToRunner::default());
            let hub = LocalTerminalHub::new(Box::new(Deps(Arc::clone(&rec))));
            hub.on_runner_frame(
                "r1",
                &json!({"type":"announce","sessions":[{"sessionId":"s1"}]}),
            );
            st.set_local_terminal(Arc::clone(&hub));
            (st, hub, rec)
        }

        struct App {
            w: UnixStream,
            r: BufReader<UnixStream>,
        }
        impl App {
            fn open(st: &Arc<ServerState>) -> Self {
                let (ours, theirs) = UnixStream::pair().unwrap();
                let st = Arc::clone(st);
                std::thread::spawn(move || serve_connection(&st, theirs));
                ours.set_read_timeout(Some(Duration::from_secs(5))).unwrap();
                let mut app = App {
                    r: BufReader::new(ours.try_clone().unwrap()),
                    w: ours,
                };
                app.send(json!({"type":"hello","version":1,"token":"app-token","role":"app"}));
                assert_eq!(app.line()["ok"], json!(true));
                app
            }
            fn send(&mut self, v: Value) {
                self.w.write_all(&encode_line(&v).unwrap()).unwrap();
            }
            fn line(&mut self) -> Value {
                let mut l = String::new();
                self.r.read_line(&mut l).unwrap();
                serde_json::from_str(&l).unwrap()
            }
            fn req(&mut self, ty: &str, payload: Value) -> Value {
                self.send(json!({"id":"q","type":ty,"payload":payload}));
                self.line()
            }
        }

        #[test]
        fn subscribe_input_resize_ride_the_connection_and_events_come_back() {
            let (st, hub, rec) = setup();
            let mut app = App::open(&st);
            assert_eq!(
                app.req("terminalIsLocal", json!({"sessionId":"s1"}))["payload"],
                json!({"local": true})
            );
            assert_eq!(
                app.req("terminalIsLocal", json!({"sessionId":"nope"}))["payload"],
                json!({"local": false})
            );
            // 키가 없으면 열람 거절 — 오류가 아니라 이유가 붙은 답이다.
            assert_eq!(
                app.req("terminalSubscribe", json!({"sessionId":"s1","viewKey":VK}))["payload"],
                json!({"ok": false, "reason": "not-viewer"})
            );
            hub.grant_view("s1", VK);
            assert_eq!(
                app.req("terminalSubscribe", json!({"sessionId":"s1","viewKey":VK}))["payload"],
                json!({"ok": true})
            );
            assert_eq!(
                rec.0.lock().unwrap().last().unwrap().1["type"],
                json!("replay.request")
            );
            hub.on_runner_frame("r1", &json!({"type":"replay","sessionId":"s1","data":"hi"}));
            let ev = app.line();
            assert_eq!(ev["type"], json!("event"));
            assert_eq!(ev["event"], json!("terminalOutput"));
            assert_eq!(
                ev["payload"],
                json!({"sessionId":"s1","data":"hi","replay":true})
            );
            // writer 키가 없으면 입력 거절, 받으면 러너로.
            assert_eq!(
                app.req(
                    "terminalInput",
                    json!({"sessionId":"s1","writerKey":WK,"data":"ls"})
                )["payload"],
                json!({"ok": false, "reason": "not-writer"})
            );
            hub.grant_writer("s1", Some(WK), Some(1));
            assert_eq!(
                app.req(
                    "terminalInput",
                    json!({"sessionId":"s1","writerKey":WK,"data":"ls"})
                )["payload"],
                json!({"ok": true})
            );
            assert_eq!(
                app.req(
                    "terminalResize",
                    json!({"sessionId":"s1","writerKey":WK,"cols":0,"rows":10})
                )["payload"],
                json!({"ok": false, "reason": "bad-size"})
            );
            assert_eq!(
                app.req(
                    "terminalResize",
                    json!({"sessionId":"s1","writerKey":WK,"cols":80,"rows":24})
                )["payload"],
                json!({"ok": true})
            );
            // 틀린 꼴은 bad-payload 오류.
            assert_eq!(
                app.req("terminalInput", json!({"sessionId":"s1"}))["ok"],
                json!(false)
            );
            assert_eq!(
                app.req("terminalSubscribe", json!({"viewKey":VK}))["ok"],
                json!(false)
            );
            assert_eq!(
                app.req("terminalWhatever", json!({"sessionId":"s1"}))["error"]["code"],
                json!("unknown-request")
            );
            assert_eq!(
                app.req("terminalUnsubscribe", json!({"sessionId":"s1"}))["payload"],
                json!({"ok": true})
            );
        }

        #[test]
        fn closing_the_connection_drops_its_subscription() {
            let (st, hub, _rec) = setup();
            hub.grant_view("s1", VK);
            let mut app = App::open(&st);
            assert_eq!(
                app.req("terminalSubscribe", json!({"sessionId":"s1","viewKey":VK}))["payload"],
                json!({"ok": true})
            );
            // 앱이 쓰기를 닫으면 접속 스레드가 끝나고 `Leave` 가 구독을 놓는다. 구독이 남아 있으면 그 구독이 든
            // 쓰기 끝이 살아 있어 아래 재생이 이벤트로 오고, 놓였으면 마지막 쓰기 끝이 닫혀 EOF 가 온다.
            app.w.shutdown(Shutdown::Write).unwrap();
            std::thread::sleep(Duration::from_millis(300));
            hub.on_runner_frame(
                "r1",
                &json!({"type":"replay","sessionId":"s1","data":"late"}),
            );
            let mut l = String::new();
            assert_eq!(
                app.r.read_line(&mut l).unwrap(),
                0,
                "닫힌 접속에 이벤트가 갔다: {l}"
            );
        }

        #[test]
        fn without_hub_terminal_requests_are_internal_errors() {
            let st = ServerState::new(
                DaemonIdentity {
                    pid: 1,
                    started_at_ms: 0,
                    launch_nonce: String::new(),
                    entry_path: String::new(),
                    app_version: String::new(),
                },
                None,
            );
            st.set_token("app-token".into());
            let mut app = App::open(&st);
            assert_eq!(
                app.req("terminalIsLocal", json!({"sessionId":"s1"}))["error"]["code"],
                json!("internal")
            );
        }
    }

    /// security #1916 낮음 — 같은 사용률 요청이 돌고 있으면 측정을 한 번만 돌리고, 기다리던 요청 모두에 같은 답을 쓴다.
    /// 측정이 패닉해도 열쇠를 지우고 기다리던 쪽 모두에 오류로 답한다.
    #[test]
    fn same_usage_request_is_coalesced_and_panic_still_answers_all() {
        use std::io::{BufRead, BufReader};
        use std::os::unix::net::UnixStream;
        use std::sync::atomic::{AtomicUsize, Ordering};
        let state = ServerState::new(
            DaemonIdentity {
                pid: 1,
                started_at_ms: 0,
                launch_nonce: String::new(),
                entry_path: String::new(),
                app_version: String::new(),
            },
            None,
        );
        let pair = || {
            let (a, b) = UnixStream::pair().unwrap();
            (Arc::new(Mutex::new(a)) as Writer, BufReader::new(b))
        };
        let (w1, mut r1) = pair();
        let (w2, mut r2) = pair();
        let runs = Arc::new(AtomicUsize::new(0));
        let (go_tx, go_rx) = std::sync::mpsc::channel::<()>();
        let key = usage_key("claudeAccountsProviderUsage", Some(&json!({"force": true})));
        {
            let runs = Arc::clone(&runs);
            state.run_usage(
                key.clone(),
                "a".into(),
                w1,
                Box::new(move || {
                    runs.fetch_add(1, Ordering::SeqCst);
                    go_rx.recv().unwrap();
                    json!({"measuredAtMs": 1})
                }),
            );
        }
        // 같은 열쇠 — 새 측정 없이 기다림에 붙는다.
        state.run_usage(
            key.clone(),
            "b".into(),
            w2,
            Box::new(|| panic!("두 번째 측정은 돌지 않아야 한다")),
        );
        go_tx.send(()).unwrap();
        let read = |r: &mut BufReader<UnixStream>| {
            let mut l = String::new();
            r.read_line(&mut l).unwrap();
            serde_json::from_str::<Value>(&l).unwrap()
        };
        assert_eq!(
            read(&mut r1),
            json!({"id":"a","ok":true,"payload":{"measuredAtMs":1}})
        );
        assert_eq!(
            read(&mut r2),
            json!({"id":"b","ok":true,"payload":{"measuredAtMs":1}})
        );
        assert_eq!(runs.load(Ordering::SeqCst), 1);
        assert!(state.usage_inflight.lock().unwrap().is_empty());

        // 패닉: 열쇠가 지워지고 기다리던 쪽은 오류 답을 받는다. 그 뒤 같은 열쇠는 다시 돈다.
        let (w3, mut r3) = pair();
        state.run_usage(
            key.clone(),
            "c".into(),
            w3,
            Box::new(|| panic!("측정 실패")),
        );
        let v = read(&mut r3);
        assert_eq!(v["id"], "c");
        assert_eq!(v["ok"], false);
        let (w4, mut r4) = pair();
        state.run_usage(key, "d".into(), w4, Box::new(|| json!({"x": 2})));
        assert_eq!(read(&mut r4)["payload"], json!({"x": 2}));
    }

    #[test]
    fn usage_key_separates_type_and_payload() {
        let k = |t: &str, p: Option<Value>| usage_key(t, p.as_ref());
        assert_ne!(
            k("claudeAccountsProviderUsage", Some(json!({"force": true}))),
            k("claudeAccountsProviderUsage", None)
        );
        assert_ne!(
            k("claudeAccountsProviderUsage", None),
            k("codexAccountsProviderUsage", None)
        );
    }

    #[test]
    fn broadcast_drops_authed_peer_that_never_reads() {
        let state = ServerState::new(
            DaemonIdentity {
                pid: 1,
                started_at_ms: 0,
                launch_nonce: String::new(),
                entry_path: String::new(),
                app_version: String::new(),
            },
            None,
        );
        // 읽지 않는 상대. 시험은 짧은 제한으로 본다(실제 값은 `WRITE_TIMEOUT`).
        let (ours, _theirs) = UnixStream::pair().unwrap();
        ours.set_write_timeout(Some(Duration::from_millis(200)))
            .unwrap();
        state.authed().insert(7, Arc::new(Mutex::new(ours)));
        let big = "x".repeat(256 * 1024);
        let started = std::time::Instant::now();
        // 소켓 버퍼가 찰 때까지 흘린다 — 막히지 않고 끝나야 하고, 그 접속은 명단에서 빠져야 한다.
        for _ in 0..64 {
            state.broadcast_event("runnerExit", json!({ "pad": big }));
            if state.authed().is_empty() {
                break;
            }
        }
        assert!(state.authed().is_empty(), "읽지 않는 접속이 명단에 남았다");
        assert!(started.elapsed() < Duration::from_secs(5));
    }

    #[test]
    fn agent_config_writes_fire_changed_hook_only_on_success() {
        let state = ServerState::new(
            DaemonIdentity {
                pid: 1,
                started_at_ms: 0,
                launch_nonce: String::new(),
                entry_path: String::new(),
                app_version: String::new(),
            },
            None,
        );
        let root = std::env::temp_dir().join(format!("hk-sock-chg-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&root);
        std::fs::create_dir_all(&root).unwrap();
        let url = "https://a.example.com";
        state.set_local_agents(LocalAgents::new(&root.to_string_lossy(), url));
        let fired = Arc::new(AtomicUsize::new(0));
        let f = fired.clone();
        state.set_on_agents_changed(Box::new(move || {
            f.fetch_add(1, Ordering::SeqCst);
        }));
        let agent = "11111111-2222-4333-8444-555555555555";
        state
            .dispatch(
                "operatorAgentSet",
                Some(&json!({"baseUrl": url, "agentId": agent, "config": {}})),
            )
            .unwrap();
        assert_eq!(fired.load(Ordering::SeqCst), 1);
        // 실패한 쓰기(다른 커뮤니티)는 알리지 않는다.
        assert!(state
            .dispatch("operatorAgentSet", Some(&json!({"baseUrl": "https://other.example.com", "agentId": agent, "config": {}})))
            .is_err());
        assert_eq!(fired.load(Ordering::SeqCst), 1);
        state
            .dispatch(
                "operatorAgentRemove",
                Some(&json!({"baseUrl": url, "agentId": agent})),
            )
            .unwrap();
        assert_eq!(fired.load(Ordering::SeqCst), 2);
        // 읽기는 알리지 않는다.
        state.dispatch("operatorAgentsList", None).unwrap();
        assert_eq!(fired.load(Ordering::SeqCst), 2);
        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn connection_slots_cap_and_return() {
        let active = Arc::new(AtomicUsize::new(0));
        let a = take_slot(&active, 2).unwrap();
        let _b = take_slot(&active, 2).unwrap();
        assert!(take_slot(&active, 2).is_none());
        drop(a);
        assert!(take_slot(&active, 2).is_some());
    }

    #[test]
    fn decoder_split_and_joined_chunks() {
        let mut d = NdjsonDecoder::new(64);
        assert!(d.push(b"{\"a\":").is_empty());
        let out = d.push(b"1}\n{\"b\":2}\n\n{\"c\"");
        assert_eq!(
            out,
            vec![Decoded::Ok(json!({"a":1})), Decoded::Ok(json!({"b":2}))]
        );
        assert_eq!(d.pending_bytes(), 4);
    }

    #[test]
    fn decoder_drops_overlong_line_and_its_tail() {
        let mut d = NdjsonDecoder::new(8);
        let out = d.push(b"0123456789abc");
        assert!(matches!(&out[..], [Decoded::Err(e)] if e.code == DaemonErrorCode::LineTooLong));
        assert_eq!(d.pending_bytes(), 0);
        // 꼬리는 다음 줄로 읽히지 않는다.
        let out = d.push(b"tail\n{}\n");
        assert_eq!(out, vec![Decoded::Ok(json!({}))]);
    }

    #[test]
    fn hello_checks_version_before_token() {
        let e = check_hello(
            &json!({"type":"hello","version":2,"token":"x","role":"app"}),
            "t",
        )
        .unwrap_err();
        assert_eq!(e.code, DaemonErrorCode::VersionMismatch);
        assert_eq!(
            e.message,
            "프로토콜 버전이 다르다: 이 daemon 은 v1, 상대는 v2"
        );
        let e = check_hello(
            &json!({"type":"hello","version":1,"token":"x","role":"runner"}),
            "x",
        )
        .unwrap_err();
        assert_eq!(e.code, DaemonErrorCode::BadPayload);
        let e = check_hello(
            &json!({"type":"hello","version":1,"token":"y","role":"app"}),
            "x",
        )
        .unwrap_err();
        assert_eq!(e.code, DaemonErrorCode::Unauthorized);
        let e = check_hello(&json!({"type":"ping"}), "x").unwrap_err();
        assert_eq!(e.code, DaemonErrorCode::NotAuthenticated);
        assert!(
            check_hello(
                &json!({"type":"hello","version":1,"token":"x","role":"app"}),
                "x"
            )
            .is_ok()
        );
    }

    #[test]
    fn empty_token_never_matches() {
        assert!(!tokens_match("", &json!("")));
        assert!(!tokens_match("ab", &json!("abc")));
        assert!(!tokens_match("ab", &json!(1)));
    }

    #[test]
    fn parse_request_codes() {
        assert_eq!(
            parse_request(&json!([])).unwrap_err().code,
            DaemonErrorCode::InvalidJson
        );
        assert_eq!(
            parse_request(&json!({"type":"ping"})).unwrap_err().code,
            DaemonErrorCode::BadPayload
        );
        assert_eq!(
            parse_request(&json!({"id":"1","type":"nope"}))
                .unwrap_err()
                .code,
            DaemonErrorCode::UnknownRequest
        );
        assert_eq!(
            parse_request(&json!({"id":"1","type":"ping"})).unwrap().1,
            "ping"
        );
    }
}
