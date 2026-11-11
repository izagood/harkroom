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
            // 러너 장부(s21c-2b-2) — 자리는 `<appDataDir>/operator/runners-v1.json`. Rust 의 appDataDir 은 커뮤니티 뿌리다
            // (TS `appDataDirFromSocket` = 소켓 두 단계 위 = 같은 폴더). 소켓을 쥔 뒤에 건다 — writer 는 이 오퍼레이터 하나다.
            state.runners.set_ledger(crate::runners::LedgerBinding {
                writer: crate::runner_ledger::RunnerLedgerWriter::new(
                    std::path::PathBuf::from(&root),
                    Box::new(|line: &str| eprintln!("{line}")),
                ),
                nonce: identity.launch_nonce.clone(),
                app_version: flag(args, "--app-version").map(str::to_string),
            });
            // 러너 로그(s21c-2c-2a) — `<appDataDir>/operator/runner-<agentId>.log`. 장부와 같은 뿌리다.
            state.runners.set_log_dir(std::path::PathBuf::from(&root));
            state.set_local_agents(LocalAgents::new(&root, base_url));
            state.set_local_mcp(LocalMcp::new(
                &root,
                Some(claude_config_path(
                    std::env::var("CLAUDE_CONFIG_DIR").ok().as_deref(),
                    &home,
                )),
            ));
            // claude 계정 풀(s21c3a). `pools.json` 자리를 못 정하면(커뮤니티 모드인데 뿌리 env 가 틀림) 배선하지 않는다 —
            // 그때 `claude*` 요청은 TS 와 같은 `no-such-runner` 로 거절된다.
            let accounts_root =
                crate::claude_accounts::claude_accounts_root(|k| std::env::var(k).ok(), &home);
            match crate::claude_accounts::pools_file_path(&accounts_root, |k| std::env::var(k).ok())
            {
                Ok(pools_path) => {
                    let accounts =
                        crate::claude_accounts::ClaudeAccounts::new(accounts_root, pools_path);
                    // 기동 때 한 번 `order` 를 디스크와 맞춘다(TS run.ts). 실패해도 기동을 막지 않는다. 이름만 적는다.
                    if let Ok((added, removed)) = accounts.reconcile_order()
                        && (!added.is_empty() || !removed.is_empty())
                    {
                        let or_none = |v: &[String]| {
                            if v.is_empty() {
                                "없음".to_string()
                            } else {
                                v.join(", ")
                            }
                        };
                        eprintln!(
                            "claude 계정 순서 맞춤: 더함 {} · 뺌 {}",
                            or_none(&added),
                            or_none(&removed)
                        );
                    }
                    // 로그인(s21c3b) — 상태는 계정 풀과 같은 디스크 판정(정체 + 자격 존재)이다.
                    state.set_claude_logins(crate::claude_login::ClaudeLogins::new(
                        accounts.root().to_path_buf(),
                        accounts.pools_path().to_path_buf(),
                        Box::new(crate::claude_login::os_spawn_login),
                        std::sync::Arc::new(|dir: &std::path::Path| {
                            crate::claude_accounts::account_status_from_disk(
                                dir,
                                &crate::claude_accounts::os_has_keychain,
                            )
                        }),
                        crate::claude_login::LOGIN_KILL_GRACE,
                    ));
                    state.set_claude_accounts(accounts);
                }
                Err(e) => eprintln!("claude 계정 풀을 배선하지 않는다: {e}"),
            }
            // codex 계정(s21c3c). `active.json` 자리를 못 정하면(커뮤니티 모드인데 뿌리 env 가 틀림) 배선하지 않는다 —
            // 그때 `codex*` 요청은 TS 와 같은 `no-such-runner` 로 거절된다.
            let codex_root =
                crate::codex_accounts::codex_accounts_root(|k| std::env::var(k).ok(), &home);
            match crate::codex_accounts::active_file_path(&codex_root, |k| std::env::var(k).ok()) {
                Ok(active_path) => {
                    state.set_codex_logins(crate::codex_login::CodexLogins::new(
                        codex_root.clone(),
                        Box::new(crate::codex_login::os_spawn_login),
                        std::sync::Arc::new(crate::codex_accounts::status_from_disk),
                        crate::codex_login::LOGIN_KILL_GRACE,
                    ));
                    state.set_codex_accounts(crate::codex_accounts::CodexAccounts::new(
                        codex_root,
                        crate::codex_accounts::system_codex_home(|k| std::env::var(k).ok(), &home),
                        active_path,
                    ))
                }
                Err(e) => eprintln!("codex 계정을 배선하지 않는다: {e}"),
            }
            // 공급자 사용률(s21c3d-3) — 화면 요청과 폴러가 claude 캐시 하나를 함께 쓴다(TS `measureUsage`).
            let meters = crate::usage_meter::UsageMeters::system();
            let poller = start_usage_poller(&meters, &home);
            let signed_in_poller = poller.clone();
            state.set_usage_meters(
                meters,
                // TS `void usagePoller?.forget(dir)` — 한 회차(CLI 45초까지)를 로그인 스레드가 기다리지 않게 따로 돈다.
                Some(Box::new(move |dir: &std::path::Path| {
                    if let Some(p) = signed_in_poller.clone() {
                        let dir = dir.to_path_buf();
                        std::thread::spawn(move || p.forget(&dir));
                    }
                })),
            );
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
                std::path::Path::new(&root),
                paths.socket_path.clone(),
            );
            println!(
                "{}",
                json!({"ok": true, "listening": paths.socket_path, "root": root, "pid": identity.pid})
            );
            accept_loop(state, listener);
            if let Some(p) = &poller {
                p.stop();
            }
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
/// 사용량 폴러(TS run.ts `createClaudeUsagePoller` — 커뮤니티 서버에 붙은 오퍼레이터만). 이 오퍼레이터는 늘 커뮤니티에 붙는다.
/// 계정 뿌리·`pools.json` 자리를 못 정하면 띄우지 않는다. 커뮤니티마다 프로세스 모드면 `usage.json` 을 여럿이 함께 쓴다.
fn start_usage_poller(
    meters: &crate::usage_meter::UsageMeters,
    home: &str,
) -> Option<crate::claude_usage_poller::ClaudeUsagePoller> {
    use crate::claude_usage_poller::{ClaudeUsagePoller, PollerOpts, read_sign_in_key};
    let env = |k: &str| std::env::var(k).ok();
    let root = crate::claude_accounts::claude_accounts_root(env, home);
    let pools_path = match crate::claude_accounts::pools_file_path(&root, env) {
        Ok(p) => p,
        Err(e) => {
            eprintln!("사용량 폴러를 띄우지 않는다: {e}");
            return None;
        }
    };
    let m = meters.clone();
    let poller = ClaudeUsagePoller::new(PollerOpts {
        root,
        pools_path,
        measure: Box::new(move |dir| m.poller_measure(dir)),
        read_sign_in: Box::new(read_sign_in_key),
        now: Box::new(|| {
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .map(|d| d.as_millis() as f64)
                .unwrap_or(0.0)
        }),
        log: Some(Box::new(|line: &str| eprintln!("{line}"))),
        shared_file: env("HARKROOM_OPERATOR_PER_COMMUNITY").as_deref() == Some("1"),
    });
    match poller.start() {
        Ok(_) => Some(poller),
        Err(e) => {
            eprintln!("사용량 폴러 기동 실패: {e}");
            None
        }
    }
}

pub fn spawn_server_link(
    state: std::sync::Arc<ServerState>,
    local: LocalAgents,
    base_url: String,
    home: String,
    version: Option<String>,
    root: &std::path::Path,
    socket_path: String,
) -> Option<std::thread::JoinHandle<()>> {
    use crate::harnesses::detect_harnesses;
    use crate::hello::{announce_of, build_hello, capabilities, read_login_path};
    use crate::server_link::{ServerLink, ServerLinkOptions, SystemClock};
    use crate::ws_dialer::WsDialer;
    use harkroom_proto::p2::OperatorToServerFrame;
    use std::path::Path;
    use std::time::Duration;

    let secrets_root = root.join("turn-secrets");
    let operator_dir = root.join("operator");
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
    // 머지·`pr.status` 가 쓸 몫(caps 클로저가 local·home 을 가져가기 전에 떼어 둔다).
    let merge_cfg = local.clone();
    // 배정 조정기가 쓸 몫(s21c-1b-2b) — 같은 이유로 먼저 떼어 둔다.
    let assign_cfg = local.clone();
    let assign_cfg_adopt = local.clone();
    let assign_login_path = login_path.clone();
    let secrets_dir = secrets_root.to_string_lossy().into_owned();
    let merge_home = home.clone();
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
    let owner = std::sync::Arc::new(crate::community::OwnerCell::default());
    // TS `community.setAgents` — 붙어 있으면 `capabilities` 를 다시 낸다. 끊겨 있으면 다음 hello 가 새 표를 싣는다(send 의 false 는 실패가 아니다).
    // 배정된 에이전트의 로컬 설정을 조정기에 넘기는 자리 — 조정기는 아래에서 서므로 나중에 채운다.
    let on_locals: std::sync::Arc<std::sync::OnceLock<Box<dyn Fn() + Send + Sync>>> =
        std::sync::Arc::new(std::sync::OnceLock::new());
    {
        let link = link.clone();
        let caps = caps.clone();
        let on_locals = std::sync::Arc::clone(&on_locals);
        state.set_on_agents_changed(Box::new(move || {
            // 다음 spawn 이 새 env 를 쓰고, API 키 연결이 바뀌었으면 러너가 다시 뜬다(TS setAgents C1).
            if let Some(f) = on_locals.get() {
                f();
            }
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
        {
            // 기동 쓸기(TS `sweepAll`) — 앞 오퍼레이터가 남긴 마운트 폴더는 이 프로세스가 모르는 임대다.
            let r = crate::turn_secrets::SecretsRoot { root: secrets_root };
            let n = r.sweep_all();
            if n > 0 {
                eprintln!("turn-secrets: 기동 쓸기 {n}개");
            }
            Some(r)
        },
        {
            // 머지·`pr.status` 의 gh 계정은 이 커뮤니티 `operator.json` 의 `merge`(TS run.ts `ghUserFor`). 부를 때마다 다시 읽는다.
            let cfg = merge_cfg;
            Some(crate::bridge::MergeHandlers::system(
                crate::local_merge::default_gh_path(),
                merge_home,
                std::sync::Arc::new(move |repo: &str| {
                    let c = cfg.read_config().ok()?;
                    crate::local_merge::pick_merge_gh_user(c.get("merge"), repo)
                }),
            ))
        },
    );
    state.set_runner_link(std::sync::Arc::clone(&bridge.runner_link));
    // 앱의 `terminal*` 요청이 같은 허브를 쓴다(s21c-4).
    state.set_local_terminal(std::sync::Arc::clone(&bridge.hub));
    let bridge_link_adopt = std::sync::Arc::clone(&bridge.runner_link);
    // 회수 중 세대(s21c-2c-2b): 러너의 「인박스를 놓았다」는 러너 표로, 앞 세대가 다 물러나면 지금 세대에 보류 풀기를 알린다.
    {
        let runners = std::sync::Arc::clone(&state.runners);
        let _ = bridge
            .poll_stopped
            .set(Box::new(move |agent, runner, holding, done| {
                runners.note_poll_stopped(agent, runner, holding, done);
            }));
        let link = std::sync::Arc::clone(&bridge.runner_link);
        state
            .runners
            .set_release_handover(Box::new(move |agent, runner| {
                if link.send(runner, &serde_json::json!({ "type": "handover.released" })) {
                    eprintln!("이관 보류 풀기: agent={agent} runner={runner}");
                }
            }));
    }
    // 로컬 터미널 허브(s21c-4) — 서버의 `local.view`·`local.writer` 를 여기서 걸러 넣는다.
    let local_hub = std::sync::Arc::clone(&bridge.hub);
    let local_link = std::sync::Arc::clone(&bridge.runner_link);
    let mux = bridge.mux;
    // 배정 조정기(s21c-1b-2b, TS communities.ts runnerDeps·community.ts onFrame).
    let frames = {
        use crate::assignments::{AssignmentOptions, AssignmentReconciler};
        use crate::community::{AssignmentFrames, SystemDeps};
        let mcp = state.local_mcp();
        let started_link = link.clone();
        let deps = SystemDeps {
            runners: std::sync::Arc::clone(&state.runners),
            link: std::sync::Arc::clone(&bridge.runner_link),
            local: assign_cfg.clone(),
            mcp_registry: operator_dir.join("mcp-servers.json"),
            claude_config: mcp.and_then(|m| m.claude_config_path().map(Path::to_path_buf)),
            oauth: mcp.map_or_else(
                || {
                    std::sync::Arc::new(crate::mcp_oauth::McpOAuth::new(
                        operator_dir.join("secrets").join("mcp-oauth.json"),
                    ))
                },
                |m| m.oauth(),
            ),
            mcp_dir: operator_dir.join("mcp"),
            operator_bin: std::env::current_exe()
                .map(|p| p.to_string_lossy().into_owned())
                .unwrap_or_default(),
            owner: std::sync::Arc::clone(&owner),
            on_started: Box::new(move |agent_id: &str, runner_id: &str| {
                let _ = started_link.send(&OperatorToServerFrame::RunnerStarted {
                    agent_id: agent_id.to_string(),
                    runner_id: runner_id.to_string(),
                });
            }),
        };
        let mut opts = AssignmentOptions::new(socket_path, deps.operator_bin.clone());
        opts.login_path = assign_login_path;
        opts.app_version = version.clone();
        opts.turn_secrets_dir = Some(secrets_dir);
        let reconciler = AssignmentReconciler::new(std::sync::Arc::new(deps), opts);
        let send_link = link.clone();
        AssignmentFrames::start(
            reconciler,
            base_url.clone(),
            std::sync::Arc::new(move |f| send_link.send(&f)),
            Box::new(|| crate::runners::new_incarnation_id().unwrap_or_default()),
        )
    };
    let local_of = {
        let cfg = assign_cfg;
        std::sync::Arc::new(move |agent_id: &str| {
            cfg.agent_entry(agent_id)
                .map(|e| crate::community::local_agent_of(&e))
        })
    };
    {
        let frames = std::sync::Arc::clone(&frames);
        let local_of = std::sync::Arc::clone(&local_of);
        let _ = on_locals.set(Box::new(move || frames.set_locals(&*local_of)));
    }
    // 러너 종료 → 다중화기 잊기 · 서버에 `runner.exited` · 배정이면 조정기가 다시 띄울지 판단(TS run.ts onExit).
    {
        let frames = std::sync::Arc::clone(&frames);
        let exit_link = link.clone();
        let exit_mux = std::sync::Arc::clone(&mux);
        state.set_on_runner_exit(Box::new(move |exit: &crate::runners::RunnerExit| {
            exit_mux.forget(&exit.incarnation_id);
            let _ = exit_link.send(&OperatorToServerFrame::RunnerExited {
                runner_id: exit.incarnation_id.clone(),
                code: exit.code.map(i64::from),
                reason: None,
                agent_id: None,
            });
            // 78 의 사유(로그인 풀림·PAT 거절·하네스 부재)는 로그 꼬리로만 가린다 — 판정은 한 곳(TS run.ts onExit).
            let reason = crate::runner_log::runner_exit_reason(&exit.tail_lines);
            frames.on_runner_exit(&exit.agent_id, exit.code, reason);
        }));
    }
    // 고아 채택(s21c-2b-3, TS run.ts adoptOrphans) — 종료 통지를 건 뒤, 서버 hello 전에 한다(hello 가 채택한 러너를 알린다).
    // 채택한 러너는 내 자식이 아니라 종료를 `kill(pid, 0)` 2초 폴링으로 묻는다(TS ADOPTED_POLL_MS).
    {
        use crate::runner_ledger::{
            legacy_runner_ledger_path, read_runner_ledger, runner_ledger_path,
        };
        struct Ports<'a> {
            local: &'a LocalAgents,
            runners: &'a crate::runners::RunnerTable,
            link: &'a crate::runner_link::RunnerLinkServer,
        }
        impl crate::adopt::AdoptPorts for Ports<'_> {
            fn is_local(&self, agent_id: &str) -> bool {
                self.local.agent_entry(agent_id).is_some()
            }
            fn adopt(&self, e: &crate::runner_ledger::RunnerLedgerEntry) -> bool {
                self.runners.adopt_runner(e).is_some()
            }
            fn retire(&self, e: &crate::runner_ledger::RunnerLedgerEntry) {
                // 회수 중 표에 적고(장부·announce·이관 보류) 시작 시각이 같을 때만 SIGTERM(s21c-2c-2b retiring 2/2).
                self.runners.retire(e);
            }
            fn link_expect(&self, runner_id: &str, agent_id: &str, secret: &str) {
                self.link.expect(runner_id, agent_id, secret);
            }
        }
        let (adopted, rejected) = crate::adopt::adopt_orphans(
            read_runner_ledger(&runner_ledger_path(root)),
            read_runner_ledger(&legacy_runner_ledger_path(root)),
            &crate::adopt::PsProbe,
            version.as_deref(),
            &Ports {
                local: &assign_cfg_adopt,
                runners: &state.runners,
                link: &bridge_link_adopt,
            },
        );
        // 후보가 0건이어도 적는다 — 「장부를 봤는데 없었다」와 「안 봤다」를 가른다(TS #456 ②).
        eprintln!(
            "고아 채택: {}건 채택, {}건 거절",
            adopted.len(),
            rejected.len()
        );
        for line in &rejected {
            eprintln!("  {line}");
        }
        let poll_runners = std::sync::Arc::clone(&state.runners);
        std::thread::spawn(move || {
            loop {
                std::thread::sleep(Duration::from_secs(2));
                poll_runners.poll_adopted();
            }
        });
    }
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
    let open_frames = std::sync::Arc::clone(&frames);
    let close_frames = std::sync::Arc::clone(&frames);
    let reap_runners = std::sync::Arc::clone(&state.runners);
    let on_frame = Box::new(move |frame: harkroom_proto::p2::ServerToOperatorFrame| {
        // 배정 프레임은 조정기로(작업 스레드에서 차례로 처리한다).
        if frames.on_frame(&frame, &*local_of) {
            // 재전송 묶음 끝 — 배정에 없는 채택 러너 회수(①b). `ps` 를 부르므로 링크 스레드 밖에서 한다.
            if matches!(
                frame,
                harkroom_proto::p2::ServerToOperatorFrame::AssignSynced { .. }
            ) && frames.synced_keep().is_some()
            {
                let (f, t, l) = (
                    std::sync::Arc::clone(&frames),
                    std::sync::Arc::clone(&reap_runners),
                    std::sync::Arc::clone(&local_of),
                );
                let _ = std::thread::Builder::new()
                    .name("adopted-reap".into())
                    .spawn(move || {
                        crate::community::reap_unassigned_adopted(&|| f.synced_keep(), &t, &|a| {
                            l(a).is_some()
                        });
                    });
            }
            return;
        }
        // 로컬 직결 키 — 러너로 내리지 않고 허브에 넣는다(이 커뮤니티의 이 러너 세션일 때만).
        if crate::bridge::apply_local_frame(
            &local_hub,
            &|r| local_link.agent_of(r),
            &|a| local_of(a).is_some(),
            &frame,
        ) {
            return;
        }
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
    let self_url = base_url.clone();
    let self_token = token.clone();
    let mut opts = ServerLinkOptions::new(base_url.clone(), token, hello, on_frame);
    let url_open = base_url.clone();
    opts.on_open = Some(Box::new(move || {
        eprintln!("서버에 붙었다: {url_open}");
        open_frames.reset_synced();
        // 소유자는 붙을 때마다 새로 읽는다(TS selfOwner) — 그 사이 온 personal assign 은 답을 기다린다.
        owner.begin();
        let (owner, u, t) = (
            std::sync::Arc::clone(&owner),
            self_url.clone(),
            self_token.clone(),
        );
        let _ = std::thread::Builder::new()
            .name("operators-self".into())
            .spawn(move || {
                let tr = crate::forward::UreqTransport::default();
                owner.set(crate::community::read_self(&tr, &u, &t));
            });
        // 재접속 사이에 놓친 세션 목록을 다시 낸다(TS community.ts onOpen).
        mux.resync();
    }));
    opts.on_close = Some(Box::new(move |reason: &str| {
        close_frames.reset_synced();
        eprintln!("서버와 끊겼다: {base_url} — {reason}")
    }));
    std::thread::Builder::new()
        .name("server-link".into())
        .spawn(move || {
            link.run(&opts, &mut WsDialer::default(), &SystemClock);
        })
        .ok()
}
