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
