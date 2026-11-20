//! 새 MCP OAuth 토큰을 **이미 쓴 러너 설정**에 넣는다 — 옛 Node 오퍼레이터(P3 에서 지움) `run.ts` 의 `pushTokens`·1분 `refreshDue` 이식.
//!
//! 러너 설정(`<operator>/mcp/<agentId>.json`)의 `Authorization` 은 배정 때 한 번 구워진다. 이 배선이 없으면 데스크톱에서
//! 다시 인증하거나 토큰이 refresh 돼도 러너가 다시 뜰 때까지 옛 토큰이 남아 턴마다 401(`AUTH_HEADER_REJECTED`)이 난다.
//! - 인증 완료: `McpOAuth::set_on_token` 으로 그 자리에서 넣는다.
//! - 1분마다 만료가 가까운 것을 refresh 하고 새 토큰을 넣는다(턴이 없어도 돈다 — 긴 턴 도중 만료되지 않게).
use crate::mcp_config::rewrite_mcp_config_tokens;
use crate::mcp_oauth::McpOAuth;
use std::collections::BTreeMap;
use std::path::PathBuf;
use std::sync::Arc;
use std::time::Duration;

const REFRESH_EVERY: Duration = Duration::from_secs(60);

/// 토큰 값은 찍지 않는다 — 이름과 고친 파일 수만.
fn push(dir: &std::path::Path, updates: &BTreeMap<String, (String, String)>) {
    if updates.is_empty() {
        return;
    }
    let n = rewrite_mcp_config_tokens(dir, updates);
    if n > 0 {
        let names: Vec<&str> = updates.keys().map(String::as_str).collect();
        eprintln!("MCP OAuth: 러너 설정 {n}개에 새 토큰({})", names.join(", "));
    }
}

/// 인증 완료 통지를 걸고 1분 refresh 스레드를 띄운다. 프로세스가 끝날 때까지 돈다.
pub fn start(oauth: Arc<McpOAuth>, mcp_dir: PathBuf) {
    let dir = mcp_dir.clone();
    oauth.set_on_token(Box::new(move |name, url, token| {
        let mut u = BTreeMap::new();
        u.insert(name.to_string(), (url.to_string(), token.to_string()));
        push(&dir, &u);
    }));
    let _ = std::thread::Builder::new()
        .name("mcp-oauth-refresh".into())
        .spawn(move || {
            loop {
                std::thread::sleep(REFRESH_EVERY);
                match oauth.refresh_due() {
                    Ok(u) => push(&mcp_dir, &u),
                    Err(e) => eprintln!("MCP OAuth: refresh 주기 실패: {}", e.message),
                }
            }
        });
}
