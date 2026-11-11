//! `harkroom-operator-rs serve --base-url <url> [--home <dir>] [--app-data <dir>] [--runner-command <절대 경로>]`
//! `[--app-version <x.y.z>] [--launch-nonce <값>]`
//! — 커뮤니티 하나의 오퍼레이터 소켓을 연다(S2 A2·A3b).
//!
//! 뿌리는 `harkroom-roots::resolve_community_root` 로 정한다. 커뮤니티가 다르면 뿌리·소켓이 달라 **여럿이 함께 뜬다**.
//! `--app-data` 를 주면 그 아래 `operators.json` 색인을 읽어 색인에 적힌 자리(옛 자리 포함)를 먼저 쓴다(A3b).
//! 색인이 깨져 있으면 뜨지 않는다 — 빈 색인으로 치면 같은 커뮤니티가 두 자리로 갈린다. 색인 쓰기는 이 판에 없다.
//! `--runner-command` 는 러너 프로그램이다. 클라이언트(앱)는 프로그램을 고르지 못하고 env 만 준다(`#250` 경계).
//! `--app-version`·`--launch-nonce` 는 앱이 띄울 때 준다(A4②). 앱은 pid 레코드의 appVersion 이 자기보다 낮으면 그 오퍼레이터를
//! 물리고 새로 띄우므로(`should_retire_daemon`), crate 판(0.1.0)을 그대로 적으면 앱이 띄울 때마다 물린다.
//! 이름을 잡으면 stdout 에 JSON 한 줄(`listening`·`root`·`pid`)을 찍고 듣는다. 점유 중이면 그 사실을 찍고 1 로 끝난다.
use crate::endpoint::{ClaimOutcome, claim, random_hex};
use crate::index::read_roots_index;
use crate::local_agents::LocalAgents;
use crate::local_mcp::{LocalMcp, claude_config_path};
use crate::local_merge::{LocalMerge, default_gh_path};
use crate::runners::RunnerLaunch;
use crate::socket::{ServerState, accept_loop};
use harkroom_proto::p3::DaemonIdentity;
use harkroom_roots::{CommunityRootResolution, OperatorRootsIndex, resolve_community_root};
use serde_json::json;
use std::time::{SystemTime, UNIX_EPOCH};

fn flag<'a>(args: &'a [String], name: &str) -> Option<&'a str> {
    args.iter()
        .position(|a| a == name)
        .and_then(|i| args.get(i + 1))
        .map(String::as_str)
}

/// 성공하면 돌아오지 않는다(듣기 고리). 돌아오면 (stdout 한 줄, 종료 코드).
pub fn serve_main(args: &[String], env_home: Option<String>) -> (String, i32) {
    let Some(base_url) = flag(args, "--base-url") else {
        return (
            json!({"ok": false, "error": "--base-url 이 없다"}).to_string(),
            2,
        );
    };
    let Some(home) = flag(args, "--home").map(str::to_string).or(env_home) else {
        return (
            json!({"ok": false, "error": "HOME 을 모른다"}).to_string(),
            2,
        );
    };
    let index = match flag(args, "--app-data") {
        Some(dir) => match read_roots_index(dir) {
            Ok(i) => i,
            Err(e) => return (json!({"ok": false, "error": e}).to_string(), 1),
        },
        None => OperatorRootsIndex::default(),
    };
    let launch = match flag(args, "--runner-command") {
        Some(c) if c.starts_with('/') => Some(RunnerLaunch {
            command: c.to_string(),
            args: Vec::new(),
        }),
        Some(_) => {
            return (
                json!({"ok": false, "error": "--runner-command 는 절대 경로여야 한다"}).to_string(),
                2,
            );
        }
        None => None,
    };
    let root = match resolve_community_root(&home, base_url, &index) {
        CommunityRootResolution::Ok { root, .. } => root,
        CommunityRootResolution::Refused(r) => {
            return (json!({"ok": false, "refused": r}).to_string(), 1);
        }
    };
    let identity = DaemonIdentity {
        pid: i64::from(std::process::id()),
        started_at_ms: SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .map(|d| d.as_millis() as i64)
            .unwrap_or(0),
        launch_nonce: flag(args, "--launch-nonce")
            .map(str::to_string)
            .unwrap_or_else(|| random_hex(8).unwrap_or_default()),
        entry_path: std::env::current_exe()
            .map(|p| p.to_string_lossy().into_owned())
            .unwrap_or_default(),
        app_version: flag(args, "--app-version")
            .unwrap_or(env!("CARGO_PKG_VERSION"))
            .to_string(),
    };
    let state = ServerState::new(identity.clone(), launch);
    match claim(&root, &identity) {
        Ok(ClaimOutcome::Claimed {
            listener,
            paths,
            token,
        }) => {
            state.set_token(token);
            state.set_local_agents(LocalAgents::new(&root, base_url));
            state.set_local_mcp(LocalMcp::new(
                &root,
                Some(claude_config_path(
                    std::env::var("CLAUDE_CONFIG_DIR").ok().as_deref(),
                    &home,
                )),
            ));
            state.set_local_merge(LocalMerge::new(
                LocalAgents::new(&root, base_url),
                default_gh_path(),
                home.clone(),
            ));
            let _link = spawn_server_link(
                state.clone(),
                LocalAgents::new(&root, base_url),
                base_url.to_string(),
                home.clone(),
                flag(args, "--app-version").map(str::to_string),
            );
            println!(
                "{}",
                json!({"ok": true, "listening": paths.socket_path, "root": root, "pid": identity.pid})
            );
            accept_loop(state, listener);
            (String::new(), 0)
        }
        Ok(ClaimOutcome::Occupied { paths }) => (
            json!({"ok": false, "occupied": paths.socket_path, "root": root}).to_string(),
            1,
        ),
        Err(e) => (json!({"ok": false, "error": e.to_string()}).to_string(), 1),
    }
}

/// 서버 링크 스레드(s21a-2) — 이 커뮤니티의 토큰이 있으면 `wss://…/operator` 로 붙어 hello 를 올리고, 끊기면 backoff 로 다시 붙는다.
/// 토큰이 없으면(등록 전) 띄우지 않는다 — 등록은 아직 TS 오퍼레이터 몫이다.
/// 러너로 가는 프레임은 릴레이 다중화기로 넘기고(s21b-2), 나머지는 종류만 stderr 에 적는다(assign·unassign 처리는 s21c).
/// 러너 링크도 여기서 배선한다 — 토큰이 없으면 러너 요청을 넘길 곳이 없으므로 러너 hello 는 앱 hello 로 검사돼 거절된다.
/// 하네스 능력은 hello 마다 새로 잰다 — 사람이 그 사이 claude 를 설치·로그인했을 수 있다(TS community.ts).
pub fn spawn_server_link(
    state: std::sync::Arc<ServerState>,
    local: LocalAgents,
    base_url: String,
    home: String,
    version: Option<String>,
) -> Option<std::thread::JoinHandle<()>> {
    use crate::harnesses::detect_harnesses;
    use crate::hello::{announce_of, build_hello, capabilities, read_login_path};
    use crate::server_link::{ServerLink, ServerLinkOptions, SystemClock};
    use crate::ws_dialer::WsDialer;
    use harkroom_proto::p2::OperatorToServerFrame;
    use std::path::Path;
    use std::time::Duration;

    let Some(token) = local.operator_token() else {
        eprintln!(
            "서버 링크를 띄우지 않는다 — 이 커뮤니티의 오퍼레이터 토큰이 없다(등록 전): {base_url}"
        );
        return None;
    };
    let shell = std::env::var("SHELL").ok();
    let login_path = read_login_path(shell.as_deref(), Duration::from_secs(5));
    if login_path.is_none() {
        eprintln!("로그인 셸 PATH 를 못 읽었다 — 러너가 하네스를 못 찾을 수 있다");
    }
    // 능력(`{agentIds, harnesses}`)은 hello 와 설정 변경 알림이 같이 쓴다 — 매번 새로 잰다.
    let caps: std::sync::Arc<dyn Fn() -> serde_json::Value + Send + Sync> =
        std::sync::Arc::new(move || {
            let harnesses = detect_harnesses(
                login_path.as_deref(),
                &|k| std::env::var(k).ok(),
                Path::new(&home),
                &|p| p.exists(),
            );
            capabilities(&local.agent_ids(), harnesses)
        });
    let link = ServerLink::new();
    // TS `community.setAgents` — 붙어 있으면 `capabilities` 를 다시 낸다. 끊겨 있으면 다음 hello 가 새 표를 싣는다(send 의 false 는 실패가 아니다).
    {
        let link = link.clone();
        let caps = caps.clone();
        state.set_on_agents_changed(Box::new(move || {
            let _ = link.send(&OperatorToServerFrame::Capabilities {
                capabilities: caps(),
            });
        }));
    }
    // 러너 링크·다중화기·서버 전달(s21b-2). 러너 요청은 이 커뮤니티의 오퍼레이터 토큰으로 서버에 넘긴다.
    let bridge = crate::bridge::build_bridge(
        std::sync::Arc::new(link.clone()),
        std::sync::Arc::new(crate::forward::UreqTransport::default()),
        base_url.clone(),
        token.clone(),
        crate::turn_keys::TurnKeyLedger::process(),
        crate::turn_slots::TurnSlots::process(),
    );
    state.set_runner_link(std::sync::Arc::clone(&bridge.runner_link));
    let mux = bridge.mux;
    let runners_state = state.clone();
    let hello_mux = std::sync::Arc::clone(&mux);
    let hello = Box::new(move || {
        build_hello(
            caps(),
            announce_of(&runners_state.runners),
            hello_mux.sessions(),
            version.as_deref(),
        )
    });
    let frame_mux = std::sync::Arc::clone(&mux);
    let on_frame = Box::new(move |frame: harkroom_proto::p2::ServerToOperatorFrame| {
        // 러너로 가는 말은 다중화기가 runnerId 로 보낸다(러너가 없으면 거기서 로그를 남기고 버린다).
        if crate::relay_mux::unwrap_server_frame(&frame).is_some() {
            frame_mux.on_server_frame(&frame);
            return;
        }
        let ty = serde_json::to_value(&frame)
            .ok()
            .and_then(|v| v.get("type").and_then(|t| t.as_str()).map(str::to_string))
            .unwrap_or_default();
        eprintln!("서버 프레임(아직 처리 안 함): {ty}");
    });
    let mut opts = ServerLinkOptions::new(base_url.clone(), token, hello, on_frame);
    let url_open = base_url.clone();
    opts.on_open = Some(Box::new(move || {
        eprintln!("서버에 붙었다: {url_open}");
        // 재접속 사이에 놓친 세션 목록을 다시 낸다(TS community.ts onOpen).
        mux.resync();
    }));
    opts.on_close = Some(Box::new(move |reason: &str| {
        eprintln!("서버와 끊겼다: {base_url} — {reason}")
    }));
    std::thread::Builder::new()
        .name("server-link".into())
        .spawn(move || {
            link.run(&opts, &mut WsDialer::default(), &SystemClock);
        })
        .ok()
}
