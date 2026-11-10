//! `harkroom-operator-rs serve --base-url <url> [--home <dir>]` — 커뮤니티 하나의 오퍼레이터 소켓을 연다(S2 A2).
//!
//! 뿌리는 `harkroom-roots::resolve_community_root` 로 정한다. 커뮤니티가 다르면 뿌리·소켓이 달라 **여럿이 함께 뜬다**.
//! `operators.json` 색인은 아직 읽지 않는다(색인 잠금·쓰기 규칙은 앱에 실을 때 옮긴다) — 계산한 자리만 쓴다.
//! 이름을 잡으면 stdout 에 JSON 한 줄(`listening`·`root`·`pid`)을 찍고 듣는다. 점유 중이면 그 사실을 찍고 1 로 끝난다.
use crate::endpoint::{ClaimOutcome, claim, random_hex};
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
    let root = match resolve_community_root(&home, base_url, &OperatorRootsIndex::default()) {
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
        launch_nonce: random_hex(8).unwrap_or_default(),
        entry_path: std::env::current_exe()
            .map(|p| p.to_string_lossy().into_owned())
            .unwrap_or_default(),
        app_version: env!("CARGO_PKG_VERSION").to_string(),
    };
    let state = ServerState::new(identity.clone());
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
