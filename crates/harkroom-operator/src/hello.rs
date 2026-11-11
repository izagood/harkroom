//! 서버 링크 hello 조립 — TS `community.ts` 의 `hello: () => ({...})`·`announceOf`(communities.ts)·`readLoginPath`(loginPath.ts).
//!
//! hello 는 연결·재연결마다 새로 만든다 — 그 사이 러너가 바뀌었거나 사람이 하네스를 설치·로그인했을 수 있고,
//! 그 사실이 다음 hello 에 실려야 서버의 배정이 통한다.
//!
//! **아직 옮기지 않은 것**: 회수 중 세대(retiring) 러너의 announce(러너 표에 그 개념이 아직 없다 — s21c adoptRunner 와 함께),
//! `sessions`(러너 링크 다중화기 — s21b 전까지 빈 배열), harness 별 `models`.

use std::io::Read;
use std::process::{Command, Stdio};
use std::time::{Duration, Instant};

use harkroom_proto::p2::{OperatorToServerFrame, ProtocolOne, RunnerAnnounce};
use serde_json::{Map, Value, json};

use crate::runners::{RunnerTable, signal_sent};

/// TS `announceOf` — 살아 있는 표의 러너(`kill(pid,0)`, 시작 순) 뒤에 회수 중이고 살아 있는 앞 세대(`retiringRunners`).
/// 회수 중 러너도 우리 러너로 알려야 서버가 그 러너의 프레임을 받아 진행 중 턴을 끝내게 한다(TS #838).
pub fn announce_of(table: &RunnerTable) -> Vec<RunnerAnnounce> {
    let mut out: Vec<RunnerAnnounce> = table
        .records()
        .into_iter()
        .filter(|r| signal_sent(r.pid, 0))
        .map(|r| RunnerAnnounce {
            agent_id: r.agent_id,
            runner_id: r.incarnation_id,
            pid: i64::from(r.pid),
        })
        .collect();
    out.extend(
        table
            .retiring_runners()
            .into_iter()
            .map(|(agent_id, pid, runner_id)| RunnerAnnounce {
                agent_id,
                runner_id,
                pid: i64::from(pid),
            }),
    );
    out
}

/// `capabilities` — `{ agentIds, harnesses }`. agentIds 는 **이 커뮤니티의** 로컬 에이전트 키다(다른 커뮤니티 것을 싣지 않는다).
pub fn capabilities(agent_ids: &[String], harnesses: Map<String, Value>) -> Value {
    json!({ "agentIds": agent_ids, "harnesses": Value::Object(harnesses) })
}

pub fn build_hello(
    capabilities: Value,
    runners: Vec<RunnerAnnounce>,
    sessions: Vec<Value>,
    version: Option<&str>,
) -> OperatorToServerFrame {
    OperatorToServerFrame::Hello {
        protocol: ProtocolOne,
        capabilities,
        runners,
        sessions,
        version: version.filter(|v| !v.is_empty()).map(str::to_string),
    }
}

/// `echo "$PATH"` 출력에서 PATH 를 고른다 — 로그인 셸이 앞에 무엇을 찍든 마지막 줄이고, `/` 가 없으면 PATH 가 아니다.
pub fn parse_login_path(stdout: &str) -> Option<String> {
    let line = stdout.trim().lines().last().unwrap_or("").trim();
    line.contains('/').then(|| line.to_string())
}

/// TS `readLoginPath` — `$SHELL -lc 'echo "$PATH"'`(없으면 /bin/sh), 시간 넘기면 죽이고 `None`.
/// launchd 아래서 뜬 오퍼레이터는 로그인 셸 PATH 를 물려받지 않는다 — 이것이 없으면 러너가 `claude` 를 못 찾는다.
pub fn read_login_path(shell: Option<&str>, timeout: Duration) -> Option<String> {
    let shell = shell.filter(|s| !s.is_empty()).unwrap_or("/bin/sh");
    let mut child = Command::new(shell)
        .args(["-lc", "echo \"$PATH\""])
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        .spawn()
        .ok()?;
    let started = Instant::now();
    loop {
        match child.try_wait() {
            Ok(Some(status)) => {
                if !status.success() {
                    return None;
                }
                let mut out = String::new();
                child.stdout.take()?.read_to_string(&mut out).ok()?;
                return parse_login_path(&out);
            }
            Ok(None) if started.elapsed() < timeout => {
                std::thread::sleep(Duration::from_millis(20))
            }
            _ => {
                let _ = child.kill();
                let _ = child.wait();
                return None;
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::Arc;

    #[test]
    fn login_path_takes_last_line_with_slash() {
        assert_eq!(
            parse_login_path("welcome banner\n/opt/homebrew/bin:/usr/bin\n").as_deref(),
            Some("/opt/homebrew/bin:/usr/bin")
        );
        assert_eq!(parse_login_path("no path here\n"), None);
        assert_eq!(parse_login_path(""), None);
    }

    #[test]
    fn login_path_reads_real_shell_and_times_out() {
        let p = read_login_path(Some("/bin/sh"), Duration::from_secs(5)).expect("sh 의 PATH");
        assert!(p.contains('/'));
        assert_eq!(
            read_login_path(Some("/nonexistent/shell"), Duration::from_secs(1)),
            None
        );
    }

    #[test]
    fn hello_matches_ts_shape() {
        let mut h = Map::new();
        h.insert(
            "claude".into(),
            json!({"installed": true, "loggedIn": false}),
        );
        let frame = build_hello(
            capabilities(&["a1".into()], h),
            vec![RunnerAnnounce {
                agent_id: "a1".into(),
                runner_id: "r1".into(),
                pid: 42,
            }],
            vec![],
            Some("0.4.473"),
        );
        let v = serde_json::to_value(&frame).unwrap();
        assert_eq!(
            v,
            json!({
                "type": "hello", "protocol": 1,
                "capabilities": {"agentIds": ["a1"], "harnesses": {"claude": {"installed": true, "loggedIn": false}}},
                "runners": [{"agentId": "a1", "runnerId": "r1", "pid": 42}],
                "sessions": [], "version": "0.4.473"
            })
        );
        let no_ver =
            serde_json::to_value(build_hello(json!({}), vec![], vec![], Some(""))).unwrap();
        assert!(
            no_ver.get("version").is_none(),
            "빈 version 은 싣지 않는다(TS `...(deps.version ? …)`)"
        );
    }

    #[test]
    fn announce_skips_dead_runners() {
        let table = RunnerTable::new(None, Arc::new(|_| {}));
        assert!(announce_of(&table).is_empty());
    }
}
