//! 앱이 **daemon 을 통해** 러너를 소유하게 만드는 자리 — `#431` 2단계-b 3/3.
//!
//! 2/3 까지 daemon 은 있었지만 앱은 그것을 쓰지 않았다(앱이 직접 `runner_spawn` 했다).
//! 이 모듈이 그 마지막 한 칸을 잇는다: 앱은 daemon 이 없으면 **띄우고**, 있으면 **붙어서**,
//! 러너를 daemon 에게 띄우라고 시킨다.
//!
//! ## 왜 이 클라이언트가 Rust 에 있나 — 선택이 아니라 필연이다
//!
//! 웹뷰는 unix 소켓을 열 수 없다. 브라우저 런타임에 그 표면 자체가 없다(있는 것은
//! `WebSocket`·`fetch` 뿐이고 둘 다 unix 소켓을 못 잡는다). 그래서 소켓을 쥐는 쪽은
//! Rust 일 수밖에 없고, 그 결과가 곧 이 이슈가 요구하는 보안 성질이 된다:
//!
//! > `main.rs::runner_spawn` 의 주석 — 실행할 프로그램 경로·인자는 `sidecar_path()` 가
//! > 고정하고, **웹뷰는 그 프로그램의 이름도 인자도 고르지 못한다.**
//!
//! daemon spawn 에도 **똑같이** 적용된다. 그리고 여기서는 한 겹이 더 있다:
//!
//! | 무엇 | 누가 정하나 |
//! |---|---|
//! | daemon 실행 파일 경로 | Rust — `sidecar_path(DAEMON_SIDECAR_NAME)` |
//! | daemon 에 넘길 인자 | Rust — 아래 `spawn_daemon` 이 리터럴로 조립한다 |
//! | **소켓·토큰·pid 경로** | Rust — `app.path().app_data_dir()` 에서 계산한다 |
//! | 토큰 값 | Rust — 토큰 **파일**에서 읽는다 |
//! | 러너 env(PAT·URL·PATH) | 웹뷰 — **값**이지 실행 표면이 아니다 |
//!
//! **경로를 웹뷰가 고르면 안 되는 이유**가 프로그램 경로와 조금 다르다: 소켓 경로를
//! 고를 수 있으면 웹뷰가 자기가 준비한 소켓을 가리켜 daemon 행세를 하는 프로세스에
//! 앱을 붙일 수 있고, 그러면 PAT 가 실린 `spawnRunner` 가 그쪽으로 간다. 토큰 경로도
//! 마찬가지다 — 자기가 아는 토큰이 든 파일을 가리키면 인증이 무의미해진다.
//! 그래서 **웹뷰가 넘기는 것은 값뿐이다.**
//!
//! ## 왜 폴백이 없나 — 조용한 이중 소유를 만들지 않는다
//!
//! daemon 기동에 실패했을 때 옛 경로(앱이 직접 spawn)로 물러나지 **않는다.** 물러나면
//! 사람은 "daemon 이 도는 줄 알았는데 아니었다"를 나중에, 그것도 다른 증상으로 알게
//! 된다 — 앱을 껐더니 러너가 같이 죽었다든가, daemon 목록에 러너가 없다든가.
//! **무엇이 러너를 소유하는지 모르는 상태**가 이 이슈가 없애려는 바로 그것이다.
//!
//! 그래서 실패는 실패로 올라가고, 사유는 지어내지 않고 원문 그대로 화면에 오른다
//! (`#368`) — `runnerLauncher` 의 `failed` + `message` 가 그 통로다.
//!
//! ## `sessions.json`·`SessionStore` 는 여기 없다 (`#431` D5)
//!
//! 이 모듈은 프로세스만 다룬다. 세션 상태를 읽지도 쓰지도 않는다 — 그 파일의 writer 는
//! 러너 하나여야 하고, 여기가 두 번째 writer 가 되면 lost update 가 조용히 난다.

use std::collections::HashMap;
use std::io::{BufRead, BufReader, Write};
use std::os::unix::net::UnixStream;
use std::path::{Path, PathBuf};
use std::sync::mpsc;
use std::sync::{Arc, Mutex};
use std::time::Duration;

use serde::{Deserialize, Serialize};
use serde_json::{json, Value};

/// daemon 사이드카의 이름. **`tauri.conf.json` 의 `bundle.externalBin` 항목과 같아야 한다**
/// — 러너 쪽 `RUNNER_SIDECAR_NAME` 과 같은 계약이다.
pub const DAEMON_SIDECAR_NAME: &str = "murmur-daemon";

/// 소켓·pid·토큰 파일명에 박히는 프로토콜 버전. **`@murmur/shared` 의
/// `DAEMON_PROTOCOL_VERSION` 과 같은 값이어야 한다** — 다르면 앱은 `daemon-v1.sock` 을
/// 보는데 daemon 은 `daemon-v2.sock` 에 열어 서로를 영영 못 만난다.
///
/// 두 곳에 같은 상수가 있는 것은 언어가 갈려서다(Rust ↔ TS). `daemonEndpointPaths.test`
/// 성격의 회귀선을 이 자리에도 둔다 — `test/daemonEndpointContract.test.ts` 가 두 값을
/// 대조한다.
pub const DAEMON_PROTOCOL_VERSION: u32 = 1;

/// unix 소켓 경로의 커널 상한(`sockaddr_un.sun_path`).
///
/// ## 왜 이 상수가 여기 있나 — 2/3 이 밟은 자리다
///
/// 넘으면 `bind` 가 **`EINVAL`** 로 실패하는데, 그 에러 이름만으로는 원인을 알 수 없다.
/// 2/3 실물 검증에서 115바이트짜리 워크트리 경로로 실제로 밟았고, `listen EINVAL:
/// invalid argument …` 앞에서 한참 헤맸다(`packages/daemon/src/server.ts::bindTemporary`
/// 주석에 그 원문이 남아 있다).
///
/// ## 여유가 얼마나 되나 — 실측 (2026-09-06)
///
/// ```text
/// /Users/jaebin/Library/Application Support/app.murmur.desktop/daemon/daemon-v1.sock
/// = 82바이트 (여유 22)
/// ```
///
/// 디렉터리 부분(`…/daemon/`)이 68바이트, 파일명 `daemon-v1.sock` 이 14바이트다.
/// `jaebin` 이 6자이므로 **사용자 이름이 28자까지는 통과하고 29자부터 넘는다.**
///
/// **그 22바이트를 갉는 것들** — 다음 사람이 "한 단계쯤 더 넣어도 되겠지"라고 생각할 때
/// 답이 여기 있어야 한다:
///
/// | 무엇 | 얼마나 |
/// |---|---|
/// | 긴 사용자 이름 | 1자당 1바이트 |
/// | 프로토콜 버전 자릿수(`daemon-v10`) | 1바이트 — 허용 이름이 27자로 준다 |
/// | 앱 식별자(`app.murmur.desktop`, 18자)가 길어지면 | 그만큼 |
/// | `<appDataDir>/daemon/` 밑에 단계를 더 넣으면 | 그만큼 |
///
/// **그래서 "운영 경로는 안전하다"고 단정하지 않는다.** 아래 `check_socket_path_length`
/// 가 실제 경로를 만들 때마다 재고, 넘으면 `EINVAL` 대신 **사실을 그대로** 말한다.
pub const SOCKET_PATH_MAX: usize = 104;

/// 소켓 경로가 커널 상한 안인지 본다. 넘으면 `EINVAL` 이 아니라 **원인을** 돌려준다.
///
/// 이 검사가 없으면 실패는 daemon 쪽에서 `listen EINVAL: invalid argument` 로 나고, 그
/// 문자열에는 "길이"라는 말이 한 글자도 없다. 사유를 지어내는 것이 아니라 **잰 사실을
/// 그대로** 말하는 것이 요점이다(`#368`).
pub fn check_socket_path_length(socket_path: &Path) -> Result<(), String> {
    let bytes = socket_path.as_os_str().as_encoded_bytes().len();
    if bytes > SOCKET_PATH_MAX {
        return Err(format!(
            "소켓 경로가 {bytes}바이트로 커널 상한 {SOCKET_PATH_MAX}바이트를 넘는다: `{}` — \
             이 길이로는 daemon 이 bind 조차 못 한다(커널이 `EINVAL` 을 낸다)",
            socket_path.display()
        ));
    }
    Ok(())
}

/// `<appDataDir>/daemon/daemon-v<N>.{sock,pid,token}` 세 경로.
///
/// **조립 규칙이 `@murmur/shared/daemonEndpoint::daemonEndpointPaths` 와 같아야 한다** —
/// 앱이 만든 경로를 daemon 에 인자로 넘기고, daemon 은 그 경로에서 `appDataDir` 를
/// 되짚어(`run.ts::appDataDirFromSocket`) 같은 규칙으로 다시 조립한다. 두 규칙이 갈리면
/// daemon 이 앱이 보지 않는 자리에 소켓을 놓는다.
#[derive(Clone, Debug)]
pub struct EndpointPaths {
    pub dir: PathBuf,
    pub socket: PathBuf,
    pub pid: PathBuf,
    pub token: PathBuf,
    /// daemon 의 stdout·stderr 를 받는 파일. **`daemonEndpointPaths` 에는 없는, 앱 쪽 추가다.**
    ///
    /// ## 왜 필요한가 — `open` 으로 띄운 앱은 자식의 출력을 버린다
    ///
    /// 사람이 실제로 쓰는 실행 방식은 Finder/Dock 클릭(`open`)이고, 그렇게 뜬 앱의 자식
    /// 프로세스 stdout·stderr 는 아무 데도 안 남는다. `#450`(터미널로 띄우면 러너가 뜨는데
    /// `open` 으로 띄우면 안 뜬다)의 진단이 막힌 이유가 정확히 그것이다 — 실패 사유가
    /// 있어도 볼 자리가 없었다.
    ///
    /// daemon 은 기동 과정을 stdout 에 적는다(`main.ts`: 인자·소켓 경로·점유 판정, `run.ts`:
    /// 실패 사유). 그것을 파일로 돌리면 `open` 으로 띄워도 **daemon 이 왜 안 떴는지가 남는다.**
    ///
    /// ## 왜 daemon 에 `--log-file` 인자를 넣지 않았나
    ///
    /// daemon 은 그런 인자를 받지 않는다(2/3 의 `args.ts` 에 없다). 그리고 넣을 필요도
    /// 없다 — **리다이렉션이 더 많이 잡는다.** 인자로 받은 로거는 프로세스가 로거를 세우기
    /// 전에 죽거나(모듈 로드 실패), 로거를 거치지 않는 경로로 죽으면(Node 의 미처리 예외
    /// 스택, 네이티브 크래시) 아무것도 안 남긴다. 그 셋이 정확히 `#450` 류의 증상이다.
    /// 파일 디스크립터를 통째로 돌리면 그 전부가 파일에 떨어진다.
    ///
    /// **경로는 Rust 가 정한다** — 웹뷰가 고르면 임의 파일을 앱 권한으로 덮어쓸 수 있다
    /// (모듈 주석의 표와 같은 경계). 소켓 104바이트 상한과는 무관하지만(그 상한은 unix
    /// 소켓 주소에만 걸린다) 같은 디렉터리에 두어 사람이 한자리에서 본다.
    pub log: PathBuf,
}

pub fn endpoint_paths(app_data_dir: &Path) -> EndpointPaths {
    let dir = app_data_dir.join("daemon");
    let base = format!("daemon-v{DAEMON_PROTOCOL_VERSION}");
    EndpointPaths {
        socket: dir.join(format!("{base}.sock")),
        pid: dir.join(format!("{base}.pid")),
        token: dir.join(format!("{base}.token")),
        log: dir.join(format!("{base}.log")),
        dir,
    }
}

// ---------------------------------------------------------------------------
// NDJSON 프로토콜 — `@murmur/shared/daemonProtocol` 의 Rust 쪽 절반
// ---------------------------------------------------------------------------

/// 러너 하나의 세대 구분자. **문자열이다** — `#419` 가 앱 안에서 `Symbol` 로 막은 것과
/// 같은 성질을 소켓 너머로 옮긴 값이다(`daemonProtocol.ts::IncarnationId` 주석).
pub type IncarnationId = String;

#[derive(Debug, Deserialize)]
struct HelloResult {
    ok: bool,
    #[serde(default)]
    error: Option<DaemonErrorBody>,
}

#[derive(Debug, Deserialize)]
struct DaemonErrorBody {
    code: String,
    message: String,
}

#[derive(Debug, Deserialize)]
struct ResponseBody {
    id: String,
    ok: bool,
    #[serde(default)]
    payload: Option<Value>,
    #[serde(default)]
    error: Option<DaemonErrorBody>,
}

/// `runnerExit` 이벤트. **`incarnationId` 가 이 이벤트의 핵심 필드다** — 이것이 없으면
/// 옛 러너의 늦은 exit 이 새 러너를 죽은 것으로 표시한다(`daemonProtocol.ts` 주석).
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct RunnerExitEvent {
    #[serde(rename = "agentId")]
    pub agent_id: String,
    #[serde(rename = "incarnationId")]
    pub incarnation_id: IncarnationId,
    pub code: Option<i32>,
    pub signal: Option<String>,
}

/// `spawnRunner` 의 답.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SpawnRunnerResult {
    #[serde(rename = "agentId")]
    pub agent_id: String,
    pub pid: u32,
    #[serde(rename = "incarnationId")]
    pub incarnation_id: IncarnationId,
}

// ---------------------------------------------------------------------------
// 접속
// ---------------------------------------------------------------------------

/// 요청 하나를 기다리는 자리. id 로 답을 짝짓는다 — NDJSON 은 순서를 보장하지만
/// 이벤트가 사이에 끼므로 "다음 줄이 내 답"이라고 가정할 수 없다.
type Pending = Arc<Mutex<HashMap<String, mpsc::Sender<ResponseBody>>>>;

/// 붙어 있는 daemon 연결 하나. **읽기 스레드 하나 + 쓰기 뮤텍스 하나**다.
pub struct DaemonConnection {
    write: Mutex<UnixStream>,
    pending: Pending,
    next_id: Mutex<u64>,
    /// 이 연결이 붙은 daemon 의 pid. 실물 검증이 "붙었나 새로 띄웠나"를 이 값으로 가른다.
    pub daemon_pid: u32,
}

impl DaemonConnection {
    /// 소켓에 붙고 `hello` 로 인증한다. **토큰은 파일에서 읽는다** — 웹뷰가 고르지 않는다.
    fn connect(paths: &EndpointPaths) -> Result<Self, String> {
        check_socket_path_length(&paths.socket)?;
        let token = std::fs::read_to_string(&paths.token)
            .map_err(|e| format!("토큰 파일을 읽지 못했다: `{}`: {e}", paths.token.display()))?;
        let token = token.trim().to_string();

        let stream = UnixStream::connect(&paths.socket).map_err(|e| {
            format!(
                "daemon 소켓에 붙지 못했다: `{}`: {e}",
                paths.socket.display()
            )
        })?;
        // 답이 영영 안 오면 앱이 멈춘다 — 읽기 스레드는 무한이지만 hello 왕복만은 잰다.
        stream
            .set_read_timeout(Some(Duration::from_secs(5)))
            .map_err(|e| format!("읽기 타임아웃을 걸지 못했다: {e}"))?;

        let mut reader = BufReader::new(
            stream
                .try_clone()
                .map_err(|e| format!("소켓을 복제하지 못했다: {e}"))?,
        );
        let mut write = stream;

        let hello = json!({
            "type": "hello",
            "version": DAEMON_PROTOCOL_VERSION,
            "token": token,
            "role": "app",
        });
        writeln!(write, "{hello}").map_err(|e| format!("hello 를 보내지 못했다: {e}"))?;

        let mut line = String::new();
        reader
            .read_line(&mut line)
            .map_err(|e| format!("hello 응답을 읽지 못했다: {e}"))?;
        if line.trim().is_empty() {
            return Err("daemon 이 hello 에 답하지 않고 연결을 끊었다".to_string());
        }
        let result: HelloResult = serde_json::from_str(line.trim())
            .map_err(|e| format!("hello 응답을 해석하지 못했다: {e}: {}", line.trim()))?;
        if !result.ok {
            let err = result
                .error
                .map(|e| format!("{}: {}", e.code, e.message))
                .unwrap_or_else(|| "사유 없음".to_string());
            return Err(format!("daemon 이 접속을 거절했다 — {err}"));
        }
        // pid 는 pid 파일에서 읽는다. hello 응답에도 실려 오지만, 실물 검증이 "같은
        // daemon 에 붙었나"를 재는 값은 파일에 남는 그 값이어야 사람이 `ps` 로 대조할 수 있다.
        let record = read_pid_record(&paths.pid);
        let daemon_pid = record.as_ref().map(|r| r.pid).unwrap_or(0);
        // **어느 빌드가 띄운 daemon 에 붙었는지 남긴다**(`#431` D3). 앱을 업데이트하면
        // 옛 daemon 이 그대로 살아 있을 수 있고(D4), 그때 이 줄이 "지금 내가 말하는 상대는
        // 옛 빌드다"를 사람에게 알리는 유일한 자리다 — 소켓 파일명은 프로토콜 버전만 갖는다.
        log_line(&format!(
            "daemon 에 붙었다: pid {daemon_pid} appVersion={} nonce={}",
            record
                .as_ref()
                .map(|r| r.app_version.as_str())
                .unwrap_or("?"),
            record
                .as_ref()
                .map(|r| r.launch_nonce.as_str())
                .unwrap_or("?"),
        ));

        // hello 를 통과했으니 이제 읽기는 무한 대기다 — 이벤트는 언제 올지 모른다.
        let _ = write.set_read_timeout(None);

        let pending: Pending = Arc::new(Mutex::new(HashMap::new()));
        Ok(DaemonConnection {
            write: Mutex::new(write),
            pending,
            next_id: Mutex::new(0),
            daemon_pid,
        })
    }

    /// 읽기 스레드를 띄운다. 응답은 `pending` 으로, 이벤트는 `on_event` 로 흐른다.
    fn start_reader(
        &self,
        mut reader: BufReader<UnixStream>,
        on_event: impl Fn(RunnerExitEvent) + Send + 'static,
    ) {
        let pending = self.pending.clone();
        std::thread::spawn(move || {
            let mut line = String::new();
            loop {
                line.clear();
                match reader.read_line(&mut line) {
                    Ok(0) => break, // daemon 이 끊었다.
                    Ok(_) => {}
                    Err(_) => break,
                }
                let text = line.trim();
                if text.is_empty() {
                    continue;
                }
                let Ok(value) = serde_json::from_str::<Value>(text) else {
                    // 해석 못 한 줄은 버린다 — 여기서 연결을 끊으면 멀쩡한 대화가 한 줄
                    // 때문에 죽는다. daemon 쪽 디코더가 상한·형식을 이미 지킨다.
                    continue;
                };
                if value.get("type").and_then(Value::as_str) == Some("event") {
                    if value.get("event").and_then(Value::as_str) == Some("runnerExit") {
                        if let Some(payload) = value.get("payload") {
                            if let Ok(ev) =
                                serde_json::from_value::<RunnerExitEvent>(payload.clone())
                            {
                                on_event(ev);
                            }
                        }
                    }
                    continue;
                }
                let Ok(resp) = serde_json::from_value::<ResponseBody>(value) else {
                    continue;
                };
                let tx = pending.lock().ok().and_then(|mut m| m.remove(&resp.id));
                if let Some(tx) = tx {
                    let _ = tx.send(resp);
                }
            }
            // 연결이 끊겼다 — 기다리던 요청들은 채널이 닫히면서 실패로 풀린다.
            if let Ok(mut m) = pending.lock() {
                m.clear();
            }
        });
    }

    /// 요청 하나를 보내고 답을 기다린다.
    fn request(&self, req_type: &str, payload: Value) -> Result<Value, String> {
        let id = {
            let mut n = self
                .next_id
                .lock()
                .map_err(|_| "요청 id 락이 깨졌다".to_string())?;
            *n += 1;
            format!("app-{n}")
        };
        let (tx, rx) = mpsc::channel();
        self.pending
            .lock()
            .map_err(|_| "대기표 락이 깨졌다".to_string())?
            .insert(id.clone(), tx);

        let line = json!({ "id": id, "type": req_type, "payload": payload });
        {
            let mut w = self
                .write
                .lock()
                .map_err(|_| "쓰기 락이 깨졌다".to_string())?;
            writeln!(w, "{line}").map_err(|e| format!("요청을 보내지 못했다: {e}"))?;
        }

        // 무한히 기다리지 않는다 — daemon 이 멈추면 앱의 그 조작도 멈춘다.
        let resp = rx
            .recv_timeout(Duration::from_secs(30))
            .map_err(|_| format!("daemon 이 `{req_type}` 에 답하지 않는다(30초)"))?;
        if !resp.ok {
            let err = resp
                .error
                .map(|e| format!("{}: {}", e.code, e.message))
                .unwrap_or_else(|| "사유 없음".to_string());
            return Err(format!("daemon 이 `{req_type}` 를 거절했다 — {err}"));
        }
        Ok(resp.payload.unwrap_or(Value::Null))
    }
}

/// pid 파일의 내용. **`daemonEndpoint.ts::DaemonPidRecord` 와 같은 모양이어야 한다.**
///
/// `launch_nonce`·`app_version` 을 읽어 두는 이유: 붙은 daemon 이 **어느 앱 빌드가 띄운
/// 것인지**를 사람이 로그에서 대조할 수 있어야 한다(`#431` D3 — "파일 하나로 판정한다").
/// pid 만으로는 못 가린다 — OS 가 그 번호를 돌려 쓴다.
#[derive(Debug, Deserialize)]
pub struct PidRecord {
    pub pid: u32,
    #[serde(rename = "launchNonce", default)]
    pub launch_nonce: String,
    #[serde(rename = "appVersion", default)]
    pub app_version: String,
}

pub fn read_pid_record(path: &Path) -> Option<PidRecord> {
    let raw = std::fs::read_to_string(path).ok()?;
    serde_json::from_str(&raw).ok()
}

// ---------------------------------------------------------------------------
// 기동 — 없으면 띄우고, 있으면 붙는다
// ---------------------------------------------------------------------------

/// daemon 을 확보한 결과. **"띄웠다"와 "붙었다"를 구분한다** — 실물 검증이 재는 성질이고
/// (같은 pid 면 붙은 것), 회귀선도 이 값으로 "이미 있으면 새로 안 띄운다"를 잰다.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum EnsureKind {
    /// 이미 서비스 중인 daemon 에 붙었다. **새 프로세스를 띄우지 않았다.**
    Attached,
    /// 없어서 띄웠다.
    Spawned,
}

/// 앱이 들고 있는 daemon 연결. `tauri::State` 로 관리된다.
///
/// **`Option` 인 이유**: 앱이 뜨자마자 daemon 이 필요한 것은 아니다 — 러너를 처음
/// 띄우려 할 때 확보한다. 그때까지는 소켓도, 프로세스도 없다.
pub struct DaemonState {
    pub inner: Mutex<Option<Arc<DaemonConnection>>>,
}

impl DaemonState {
    pub fn new() -> Self {
        DaemonState {
            inner: Mutex::new(None),
        }
    }
}

/// **없으면 띄우고, 있으면 붙는다.**
///
/// ## 순서가 요점이다 — 붙기를 먼저 시도한다
///
/// 띄우기부터 하면 이미 도는 daemon 이 있을 때 두 번째 프로세스가 뜨고, 그것이
/// `EXIT_OCCUPIED`(10)로 물러날 때까지 창이 생긴다. 그 창 자체는 daemon 쪽이 원자적
/// 획득(`claimDaemonEndpoint`)으로 막지만, **앱이 굳이 그 경쟁을 유발할 이유가 없다.**
/// 그래서 먼저 붙어 보고, 안 되면 그때 띄운다(`#431` D1).
///
/// ## 실패는 폴백하지 않는다
///
/// 어느 단계에서 실패하든 `Err` 로 올라간다. 앱이 직접 러너를 띄우는 옛 경로로
/// 물러나지 않는다 — 모듈 주석의 "왜 폴백이 없나" 참조.
pub fn ensure_daemon(
    app: &tauri::AppHandle,
    state: &DaemonState,
    on_event: impl Fn(RunnerExitEvent) + Send + Clone + 'static,
) -> Result<(Arc<DaemonConnection>, EnsureKind), String> {
    let mut guard = state
        .inner
        .lock()
        .map_err(|_| "daemon 상태 락이 깨졌다".to_string())?;
    if let Some(conn) = guard.as_ref() {
        // 이미 붙어 있다. 살아 있는지는 `ping` 으로 확인한다 — 소켓이 조용히 끊겨 있으면
        // 다음 `spawnRunner` 가 실패하는데, 그 실패는 "daemon 이 죽었다"가 아니라
        // "요청이 안 갔다"로 보인다.
        if conn.request("ping", json!({})).is_ok() {
            return Ok((conn.clone(), EnsureKind::Attached));
        }
        *guard = None;
    }

    let paths = resolve_endpoint_paths(app)?;
    let launch_app = app.clone();
    let launch_paths = paths.clone();
    let (conn, kind) = ensure_at(&paths, on_event, move || {
        spawn_daemon(&launch_app, &launch_paths)
    })?;
    *guard = Some(conn.clone());
    Ok((conn, kind))
}

/// `ensure_daemon` 의 **판단 부분**. `AppHandle` 을 모른다.
///
/// ## 왜 갈라놓았나 — 회귀선이 실물을 재게 하려고
///
/// "이미 있으면 새로 안 띄운다"는 이 단계의 핵심 성질인데, `AppHandle` 을 요구하면 회귀선이
/// 이 함수를 부를 방법이 없다. 그러면 테스트는 `DaemonConnection::connect` 를 직접 부르는
/// 식으로 **분기를 우회해서** 재게 되고, 그 상태에서 "1. 붙어 본다" 블록을 통째로 지워도
/// 테스트는 초록이다(실제로 그렇게 됐고, 되돌려 RED 절차가 그 사실을 드러냈다).
///
/// `launch` 를 클로저로 받는 것도 같은 이유다 — 회귀선이 "띄우는 자리가 **불리지 않았다**"를
/// 직접 셀 수 있어야 한다. 프로덕션에서 그 클로저 안에 들어가는 것은 `spawn_daemon` 하나뿐이다.
fn ensure_at(
    paths: &EndpointPaths,
    on_event: impl Fn(RunnerExitEvent) + Send + Clone + 'static,
    launch: impl FnOnce() -> Result<(), String>,
) -> Result<(Arc<DaemonConnection>, EnsureKind), String> {
    // ── 1. 붙어 본다 ────────────────────────────────────────────────────────
    if paths.socket.exists() && paths.token.exists() {
        match open_connection(paths, on_event.clone()) {
            Ok(conn) => return Ok((conn, EnsureKind::Attached)),
            Err(err) => {
                // 붙지 못했다 — 잔해일 수 있다. daemon 을 띄우면 그쪽이 3중 증거로
                // 판정해 회수하거나 물러난다(`claimDaemonEndpoint`). 여기서 소켓 파일을
                // 지우지 않는 것이 요점이다: 살아 있는 daemon 의 소켓을 앱이 날릴 수 있다.
                log_line(&format!("daemon 에 붙지 못했다(띄워 본다): {err}"));
            }
        }
    }

    // ── 2. 띄운다 ───────────────────────────────────────────────────────────
    launch()?;

    // daemon 이 소켓·토큰을 올릴 때까지 기다린다. **폴링이지 고정 대기가 아니다** —
    // 고정 `sleep` 은 느린 기기에서 모자라고 빠른 기기에서 낭비다.
    let deadline = std::time::Instant::now() + Duration::from_secs(10);
    let mut last_err = "daemon 이 소켓을 올리지 않았다".to_string();
    while std::time::Instant::now() < deadline {
        if paths.socket.exists() && paths.token.exists() {
            match open_connection(paths, on_event.clone()) {
                Ok(conn) => return Ok((conn, EnsureKind::Spawned)),
                Err(err) => last_err = err,
            }
        }
        std::thread::sleep(Duration::from_millis(100));
    }
    Err(format!(
        "daemon 을 띄웠지만 10초 안에 붙지 못했다: {last_err} — 소켓 `{}`",
        paths.socket.display()
    ))
}

fn open_connection(
    paths: &EndpointPaths,
    on_event: impl Fn(RunnerExitEvent) + Send + 'static,
) -> Result<Arc<DaemonConnection>, String> {
    let conn = DaemonConnection::connect(paths)?;
    let reader = BufReader::new(
        conn.write
            .lock()
            .map_err(|_| "쓰기 락이 깨졌다".to_string())?
            .try_clone()
            .map_err(|e| format!("소켓을 복제하지 못했다: {e}"))?,
    );
    conn.start_reader(reader, on_event);
    Ok(Arc::new(conn))
}

/// **소켓·토큰·pid 경로를 Rust 가 계산한다** — 웹뷰는 이 값을 못 고른다(모듈 주석 표 참조).
///
/// `app_data_dir()` 는 macOS 에서 `$HOME/Library/Application Support/<identifier>` 다
/// (`dirs::data_dir()` + `tauri.conf.json` 의 `identifier`). 이 디렉터리는 앱이 처음
/// 쓰는 것이므로 여기서 만든다 — 없으면 daemon 이 소켓을 열 자리가 없다.
pub fn resolve_endpoint_paths(app: &tauri::AppHandle) -> Result<EndpointPaths, String> {
    use tauri::Manager;
    let app_data_dir = app
        .path()
        .app_data_dir()
        .map_err(|e| format!("앱 데이터 디렉터리를 찾지 못했다: {e}"))?;
    let paths = endpoint_paths(&app_data_dir);
    // **길이를 여기서 잰다.** 넘으면 daemon 쪽에서 `EINVAL` 로 나는데 그 이름에는
    // "길이"라는 말이 없다(위 `SOCKET_PATH_MAX` 주석의 실측 참조).
    check_socket_path_length(&paths.socket)?;
    std::fs::create_dir_all(&paths.dir).map_err(|e| {
        format!(
            "daemon 디렉터리를 만들지 못했다: `{}`: {e}",
            paths.dir.display()
        )
    })?;
    Ok(paths)
}

/// daemon 을 띄운다. **`detached_command()` 로 띄운다 — 앱이 죽어도 daemon 이 살아야 한다.**
///
/// `#431` D2 가 이 이슈의 핵심 메커니즘이라고 못박은 자리다. 실측(2026-09-05)이 근거다:
/// 앱을 SIGKILL 해도 자식은 살아남았지만 PGID 가 앱 그룹 그대로였고,
/// `kill -TERM -<앱 PGID>` 한 번에 전부 죽었다. orca 는 daemon 을 자기 PGID 로 분리해
/// (실측: `Orca Helper(1096) pgid=1096`) 그 경로를 원천 차단한다.
///
/// **인자는 전부 Rust 가 조립한다.** 웹뷰는 이 함수에 아무것도 못 넘긴다 —
/// 프로그램 경로도, 소켓·토큰·pid 경로도, nonce 도 여기서 만든다.
fn spawn_daemon(app: &tauri::AppHandle, paths: &EndpointPaths) -> Result<(), String> {
    let program = crate::sidecar_path(DAEMON_SIDECAR_NAME)?;
    if !program.is_file() {
        return Err(format!(
            "daemon 사이드카를 찾지 못했다: `{}` — 빌드가 externalBin 을 이 이름으로 넣었는지 확인하라",
            program.display()
        ));
    }

    let nonce = new_nonce();
    let app_version = app.package_info().version.to_string();

    let mut cmd = daemon_command(&program, paths, &nonce, &app_version);

    // **자식을 기다리지 않는다** — daemon 은 상주 프로세스다. 다만 핸들을 떨어뜨리면
    // 좀비가 남으므로, 종료를 거두는 스레드 하나만 붙여 둔다. 그 스레드가 하는 일은
    // `wait()` 뿐이고 러너에는 아무 영향도 주지 않는다.
    let mut child = cmd
        .spawn()
        .map_err(|e| format!("daemon 을 띄우지 못했다: {e}"))?;
    let pid = child.id();
    log_line(&format!("daemon 을 띄웠다: pid {pid}"));
    std::thread::spawn(move || {
        let _ = child.wait();
    });
    Ok(())
}

/// daemon 을 띄울 `Command` 를 조립한다 — **프로그램·인자·리다이렉션이 전부 여기서 정해진다.**
///
/// ## 왜 `spawn_daemon` 에서 떼어냈나 — 회귀선이 실물을 재게 하려고
///
/// 이 함수가 `spawn_daemon` 안에 인라인돼 있으면 `AppHandle` 없이는 부를 수 없고, 그러면
/// 회귀선이 daemon 을 띄우기 위해 **자기 손으로 커맨드를 다시 조립**하게 된다. 그 사본은
/// 프로덕션 코드가 아니므로, `detached_command` 를 `Command::new` 로 바꿔도 사본은 그대로
/// 초록이다 — 즉 `setsid` 회귀선이 아무것도 안 지킨다(이 구조를 만들기 전에 실제로 그렇게
/// 됐고, 되돌려 RED 가 통과하는 것으로 그 사실이 드러났다).
///
/// `detached_command()` 가 `main.rs` 에서 `runner_spawn` 과 테스트에 공유되던 것과 같은
/// 이유다 — **재는 대상과 도는 대상이 같아야 한다.**
fn daemon_command(
    program: &Path,
    paths: &EndpointPaths,
    nonce: &str,
    app_version: &str,
) -> std::process::Command {
    use std::process::Stdio;

    let mut cmd = crate::detached_command(program);
    cmd.arg("--socket")
        .arg(&paths.socket)
        .arg("--token")
        .arg(&paths.token)
        .arg("--pid-record")
        .arg(&paths.pid)
        .arg("--launch-nonce")
        .arg(nonce)
        .arg("--entry-path")
        .arg(program)
        .arg("--app-version")
        .arg(app_version)
        .stdin(Stdio::null());

    // **stdout·stderr 를 파일로 돌린다** — `EndpointPaths::log` 주석의 이유다.
    // `open` 으로 띄운 앱의 자식 출력은 그러지 않으면 어디에도 안 남는다(`#450`).
    //
    // **여기서 실패해도 daemon 기동 자체는 막지 않는다.** 로그는 진단 수단이지 기동 조건이
    // 아니고, 로그 파일을 못 열었다고 daemon 을 안 띄우면 이 진단 장치가 오히려 사고를
    // 만든다. 못 열면 출력을 버리되 그 사실을 남긴다(사유를 지어내지 않는다, `#368`).
    match std::fs::OpenOptions::new()
        .create(true)
        .append(true)
        .open(&paths.log)
    {
        Ok(file) => match file.try_clone() {
            Ok(err_file) => {
                cmd.stdout(Stdio::from(file)).stderr(Stdio::from(err_file));
            }
            Err(e) => {
                log_line(&format!("로그 파일을 복제하지 못해 stderr 를 버린다: {e}"));
                cmd.stdout(Stdio::from(file)).stderr(Stdio::null());
            }
        },
        Err(e) => {
            log_line(&format!(
                "daemon 로그 파일을 열지 못해 출력을 버린다: `{}`: {e}",
                paths.log.display()
            ));
            cmd.stdout(Stdio::null()).stderr(Stdio::null());
        }
    }
    cmd
}

/// 기동 난스. daemon 이 pid 레코드에 그대로 적고, 앱이 "내가 방금 띄운 그 daemon 인가"를
/// 이 값으로 가린다(pid 는 OS 가 돌려 쓰므로 그것만으로는 못 가린다).
fn new_nonce() -> String {
    use std::time::{SystemTime, UNIX_EPOCH};
    let now = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_nanos())
        .unwrap_or(0);
    format!("{now:x}-{:x}", std::process::id())
}

fn log_line(line: &str) {
    eprintln!("[daemon-client] {line}");
}

// ---------------------------------------------------------------------------
// 요청 — `spawnRunner`·`killRunner`·`listRunners`
// ---------------------------------------------------------------------------

impl DaemonConnection {
    pub fn spawn_runner(
        &self,
        agent_id: &str,
        env: HashMap<String, String>,
    ) -> Result<SpawnRunnerResult, String> {
        let payload = self.request("spawnRunner", json!({ "agentId": agent_id, "env": env }))?;
        serde_json::from_value(payload)
            .map_err(|e| format!("spawnRunner 응답을 해석하지 못했다: {e}"))
    }

    /// **세대를 실어 보낸다.** 실지 않으면 daemon 은 "지금 것"을 죽이는데, 앱이 옛 세대를
    /// 죽이라고 보낸 명령이 그 사이 새로 뜬 러너를 데려갈 수 있다
    /// (`daemonProtocol.ts::KillRunnerParams.incarnationId` 주석).
    pub fn kill_runner(&self, agent_id: &str, incarnation_id: Option<&str>) -> Result<(), String> {
        let mut payload = json!({ "agentId": agent_id });
        if let Some(id) = incarnation_id {
            payload["incarnationId"] = json!(id);
        }
        match self.request("killRunner", payload) {
            Ok(_) => Ok(()),
            // 이미 없는 러너를 죽이라는 것은 결과 상태가 같다 — 재시도가 안전해야 한다
            // (`main.rs::runner_kill` 의 "표에 없으면 성공" 과 같은 논리).
            Err(err) if err.contains("no-such-runner") => Ok(()),
            Err(err) => Err(err),
        }
    }

    pub fn list_runners(&self) -> Result<Value, String> {
        self.request("listRunners", json!({}))
    }
}

// `libc::getpgid` 를 쓰는 회귀선이 있어 unix 로 좁힌다 — `main.rs` 의 테스트 모듈과 같다.
#[cfg(all(test, unix))]
mod tests {
    use super::*;

    /// **회귀선 — 소켓 경로 길이 상한**(`#431` 2/3 이 밟은 자리).
    ///
    /// `bind` 를 실제로 부르지 않고 잰다. 부르면 재는 것이 "커널이 EINVAL 을 낸다"가 되고,
    /// 그것은 이미 아는 사실이다 — 여기서 재야 할 것은 **우리가 그 원인을 말하는가**다.
    #[test]
    fn 소켓_경로가_상한을_넘으면_길이를_사유로_말한다() {
        let long = PathBuf::from(format!("/tmp/{}/daemon-v1.sock", "a".repeat(120)));
        let err = check_socket_path_length(&long).expect_err("상한을 넘었는데 통과했다");
        assert!(
            err.contains("104"),
            "상한 값이 사유에 없다 — 사람이 무엇을 줄여야 하는지 모른다: {err}"
        );
        assert!(
            err.contains(&long.as_os_str().as_encoded_bytes().len().to_string()),
            "실제 길이가 사유에 없다: {err}"
        );
    }

    #[test]
    fn 상한_안의_경로는_통과한다() {
        let ok = PathBuf::from(
            "/Users/jaebin/Library/Application Support/app.murmur.desktop/daemon/daemon-v1.sock",
        );
        assert_eq!(
            ok.as_os_str().as_encoded_bytes().len(),
            82,
            "실측 값이 바뀌었다"
        );
        check_socket_path_length(&ok).expect("82바이트가 막혔다");
    }

    /// 조립 규칙이 `@murmur/shared/daemonEndpoint::daemonEndpointPaths` 와 같아야 한다.
    #[test]
    fn 엔드포인트_경로_조립이_shared_와_같은_규칙이다() {
        let paths = endpoint_paths(Path::new("/tmp/appdata"));
        assert_eq!(paths.dir, PathBuf::from("/tmp/appdata/daemon"));
        assert_eq!(
            paths.socket,
            PathBuf::from("/tmp/appdata/daemon/daemon-v1.sock")
        );
        assert_eq!(
            paths.pid,
            PathBuf::from("/tmp/appdata/daemon/daemon-v1.pid")
        );
        assert_eq!(
            paths.token,
            PathBuf::from("/tmp/appdata/daemon/daemon-v1.token")
        );
        // 로그는 `daemonEndpointPaths` 에 없는 앱 쪽 추가다 — 같은 디렉터리에 둔다.
        assert_eq!(
            paths.log,
            PathBuf::from("/tmp/appdata/daemon/daemon-v1.log")
        );
    }

    // -----------------------------------------------------------------------
    // 실물 daemon 회귀선 — **진짜 사이드카를 띄운다**
    //
    // 여기 있는 성질들은 목으로는 못 잰다. "이미 있으면 새로 안 띄운다"를 목으로 재면
    // 재는 것이 "내가 짠 분기가 내가 짠 대로 돈다"가 되고, 정작 daemon 이 소켓을 언제
    // 올리는지·토큰이 언제 쓰이는지는 하나도 안 걸린다.
    //
    // 사이드카가 없으면(=`build:sidecar` 전) **실패 대신 건너뛴다** — `main.rs` 의
    // `사이드카_실행_위치에서_node_pty_가_해석된다` 와 같은 방식이다.
    // -----------------------------------------------------------------------

    fn daemon_sidecar() -> Option<PathBuf> {
        let dir = Path::new(env!("CARGO_MANIFEST_DIR"))
            .join("target")
            .join("debug");
        let p = dir.join(DAEMON_SIDECAR_NAME);
        if p.is_file() {
            Some(p)
        } else {
            None
        }
    }

    /// 짧은 임시 앱 데이터 디렉터리. **`/tmp` 밑에 짧게 만든다** — 워크트리 경로에
    /// 만들면 소켓 경로가 104바이트를 넘어 `bind` 가 `EINVAL` 로 죽는다(2/3 이 그것을
    /// 실제로 밟았다, 위 `SOCKET_PATH_MAX` 주석).
    fn temp_app_data_dir(tag: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!("mmr-{tag}-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).expect("임시 디렉터리를 못 만들었다");
        dir
    }

    /// 테스트가 띄운 daemon 과 임시 디렉터리를 **반드시** 거둔다.
    ///
    /// ## 왜 `Drop` 인가 — 실측으로 배웠다 (2026-09-06)
    ///
    /// 처음에는 테스트 끝에 `child.kill()` 을 적어 뒀다. 그런데 **되돌려 RED 절차에서
    /// 테스트가 패닉하면 그 줄에 닿지 못한다** — 실제로 그렇게 daemon 둘이 `ppid=1` 로
    /// 남았고, 다른 세션이 그것을 발견했다. daemon 은 `setsid` 로 떠 있으니(그것이 이
    /// 기능의 핵이다) 테스트 프로세스가 죽어도 함께 죽지 않는다.
    ///
    /// **즉 이 기능을 재는 테스트는 구조적으로 고아를 남긴다.** `Drop` 은 패닉 언와인딩
    /// 중에도 불리므로 그 경로를 막는 유일한 자리다.
    struct DaemonGuard {
        child: std::process::Child,
        dir: PathBuf,
    }

    impl Drop for DaemonGuard {
        fn drop(&mut self) {
            let _ = self.child.kill();
            let _ = self.child.wait();
            let _ = std::fs::remove_dir_all(&self.dir);
        }
    }

    /// daemon 을 띄운다. **`spawn_daemon` 과 같은 `daemon_command()` 를 쓴다** —
    /// 여기서 커맨드를 다시 조립하면 재는 대상과 도는 대상이 갈리고, 그러면
    /// `detached_command` 를 빼도 이 테스트가 초록으로 통과한다(그 함수 주석 참고).
    /// `AppHandle` 이 필요한 것은 프로그램 경로와 앱 버전뿐이라 그 둘만 여기서 준다.
    fn launch_daemon(program: &Path, paths: &EndpointPaths, nonce: &str) -> std::process::Child {
        daemon_command(program, paths, nonce, "test")
            .spawn()
            .expect("daemon 을 못 띄웠다")
    }

    fn wait_for_endpoint(paths: &EndpointPaths) -> bool {
        let deadline = std::time::Instant::now() + Duration::from_secs(10);
        while std::time::Instant::now() < deadline {
            if paths.socket.exists() && paths.token.exists() && paths.pid.exists() {
                return true;
            }
            std::thread::sleep(Duration::from_millis(50));
        }
        false
    }

    /// **회귀선 2 — daemon 이 이미 있으면 새로 안 띄운다.**
    ///
    /// 붙기를 먼저 시도하는 것이 `ensure_daemon` 의 첫 단계이고, 이 테스트는 그 단계가
    /// 실제로 **선다**는 것을 진짜 소켓으로 잰다: 이미 도는 daemon 에 붙어 `ping` 이
    /// 오가고, 그 pid 가 처음 띄운 그 pid 다.
    ///
    /// 되돌려 RED: `ensure_daemon` 의 "1. 붙어 본다" 블록을 지우면 두 번째 daemon 이 뜨고
    /// 그것은 `EXIT_OCCUPIED`(10)로 물러난다 — 즉 붙는 데 실패하거나(소켓은 첫 daemon 것)
    /// 아무 daemon 에도 못 붙는다.
    #[test]
    fn 이미_있는_daemon_에는_붙고_새로_띄우지_않는다() {
        let Some(program) = daemon_sidecar() else {
            eprintln!("건너뜀: daemon 사이드카가 없다 — `pnpm --filter @murmur/desktop build:sidecar` 먼저");
            return;
        };
        let dir = temp_app_data_dir("attach");
        let paths = endpoint_paths(&dir);
        std::fs::create_dir_all(&paths.dir).unwrap();
        // 이 경로 자체가 상한 안이어야 테스트가 성립한다 — 아니면 아래 실패가 길이 탓인지
        // 로직 탓인지 못 가린다.
        check_socket_path_length(&paths.socket).expect("임시 소켓 경로가 이미 상한을 넘는다");

        // **가드가 먼저다** — 아래 어느 단언이 패닉해도 이 daemon 은 거둬진다.
        let _guard = DaemonGuard {
            child: launch_daemon(&program, &paths, "nonce-1"),
            dir: dir.clone(),
        };
        assert!(
            wait_for_endpoint(&paths),
            "daemon 이 엔드포인트를 올리지 않았다"
        );

        let record = read_pid_record(&paths.pid).expect("pid 레코드를 못 읽었다");
        let first_pid = record.pid;

        // **`ensure_at` 을 부른다** — 프로덕션이 도는 그 판단이다. 여기서
        // `DaemonConnection::connect` 를 직접 부르면 "붙어 본다" 분기를 우회하게 되고,
        // 그 분기를 통째로 지워도 테스트가 초록이다(그 함수 주석의 근거).
        let launched = std::sync::atomic::AtomicBool::new(false);
        let (conn, kind) = ensure_at(
            &paths,
            |_| {},
            || {
                launched.store(true, std::sync::atomic::Ordering::SeqCst);
                Ok(())
            },
        )
        .expect("붙지 못했다");

        assert_eq!(
            kind,
            EnsureKind::Attached,
            "이미 서비스 중인 daemon 이 있는데 `Attached` 가 아니다"
        );
        assert!(
            !launched.load(std::sync::atomic::Ordering::SeqCst),
            "이미 daemon 이 도는데 띄우는 자리가 불렸다 — 두 번째 daemon 이 뜬다"
        );
        assert_eq!(
            conn.daemon_pid, first_pid,
            "붙은 daemon 의 pid 가 처음 띄운 것과 다르다 — 새로 띄운 것이다"
        );
        // 실제로 말이 오가는지도 본다. 붙기만 하고 인증이 안 됐으면 여기서 걸린다.
        conn.request("ping", json!({})).expect("ping 이 안 돌았다");

        // 두 번째 daemon 을 같은 엔드포인트로 띄우면 **점유로 물러난다**(코드 10).
        let second = launch_daemon(&program, &paths, "nonce-2")
            .wait()
            .expect("두 번째 daemon 을 기다리지 못했다");
        assert_eq!(
            second.code(),
            Some(10),
            "이미 서비스 중인데 두 번째 daemon 이 물러나지 않았다 — 소유권이 갈린다"
        );
        // 그리고 첫 daemon 은 그대로 살아 있다.
        assert!(read_pid_record(&paths.pid).map(|r| r.pid) == Some(first_pid));
        // 정리는 `_guard` 의 `Drop` 이 한다 — 패닉해도 불린다.
    }

    /// **회귀선 2 의 반대편 — 없으면 띄운다.**
    ///
    /// "붙기를 먼저 시도한다"가 "없을 때도 안 띄운다"로 잘못 굳는 것을 막는다. 앞 테스트만
    /// 있으면 `ensure_at` 이 항상 `Attached` 를 돌려주게 만들어도 초록이다.
    #[test]
    fn daemon_이_없으면_띄우고_그_daemon_에_붙는다() {
        let Some(program) = daemon_sidecar() else {
            eprintln!("건너뜀: daemon 사이드카가 없다 — `pnpm --filter @murmur/desktop build:sidecar` 먼저");
            return;
        };
        let dir = temp_app_data_dir("spawn");
        let paths = endpoint_paths(&dir);
        std::fs::create_dir_all(&paths.dir).unwrap();
        assert!(!paths.socket.exists(), "빈 디렉터리에 소켓이 이미 있다");

        // 띄우는 자리는 프로덕션과 같은 `daemon_command()` 를 쓴다.
        let child = std::sync::Mutex::new(None::<std::process::Child>);
        let outcome = ensure_at(
            &paths,
            |_| {},
            || {
                *child.lock().unwrap() = Some(launch_daemon(&program, &paths, "nonce-spawn"));
                Ok(())
            },
        );
        // **단언보다 먼저 가드로 감싼다** — `ensure_at` 이 성공했든 아니든 띄운 daemon 은
        // 이미 있고, 아래 단언이 패닉하면 그것을 거둘 자리가 여기밖에 없다.
        let _guard = child.lock().unwrap().take().map(|c| DaemonGuard {
            child: c,
            dir: dir.clone(),
        });

        let (conn, kind) = outcome.expect("daemon 을 띄우고도 못 붙었다");
        assert_eq!(kind, EnsureKind::Spawned, "없는데 붙었다고 한다");
        assert!(conn.daemon_pid > 0, "붙은 daemon 의 pid 를 못 읽었다");
        conn.request("ping", json!({})).expect("ping 이 안 돌았다");
    }

    /// **회귀선 5 — 앱이 죽어도 daemon 이 산다: `setsid` 가 걸렸는가.**
    ///
    /// `detached_command()` 로 띄우므로 daemon 은 자기 세션/프로세스 그룹의 리더가 된다.
    /// 그러면 앱 프로세스 그룹에 오는 시그널이 daemon 에 닿지 않는다 — `#431` D2 가 이
    /// 설계의 핵심 메커니즘이라고 못박은 자리이고, 실측(2026-09-05)이 그 근거다.
    ///
    /// 되돌려 RED: `daemon_command` 의 `crate::detached_command(program)` 를
    /// `std::process::Command::new(program)` 로 바꾸면 PGID 가 이 테스트 프로세스의 것과
    /// 같아져 빨개진다.
    #[test]
    fn daemon_의_pgid_는_자기_자신이다() {
        let Some(program) = daemon_sidecar() else {
            eprintln!("건너뜀: daemon 사이드카가 없다 — `pnpm --filter @murmur/desktop build:sidecar` 먼저");
            return;
        };
        let dir = temp_app_data_dir("pgid");
        let paths = endpoint_paths(&dir);
        std::fs::create_dir_all(&paths.dir).unwrap();

        // **가드가 먼저다** — 이 테스트가 바로 되돌려 RED 로 패닉시키는 자리이고,
        // 실제로 그때 daemon 이 `ppid=1` 로 남았다(`DaemonGuard` 주석의 실측).
        let guard = DaemonGuard {
            child: launch_daemon(&program, &paths, "nonce-pgid"),
            dir: dir.clone(),
        };
        let pid = guard.child.id();
        assert!(
            wait_for_endpoint(&paths),
            "daemon 이 엔드포인트를 올리지 않았다"
        );

        let pgid = unsafe { libc::getpgid(pid as libc::pid_t) };
        let own = unsafe { libc::getpgid(0) };
        assert_ne!(
            pgid, own,
            "daemon 의 PGID({pgid})가 이 프로세스의 PGID({own})와 같다 — setsid 가 빠졌다. \
             그러면 앱 그룹에 오는 시그널 한 번에 daemon 이 함께 죽는다(`#431` D2)."
        );
        assert_eq!(
            pgid, pid as libc::pid_t,
            "PGID 가 자기 pid 와도 다르다 — 분리는 됐지만 세션 리더가 아니다"
        );
        // 정리는 `guard` 의 `Drop` 이 한다 — 패닉해도 불린다.
        drop(guard);
    }
}
