//! 서버 링크 hello 조립 — TS `community.ts` 의 `hello: () => ({...})`·`announceOf`(communities.ts)·`readLoginPath`(loginPath.ts).
//!
//! hello 는 연결·재연결마다 새로 만든다 — 그 사이 러너가 바뀌었거나 사람이 하네스를 설치·로그인했을 수 있고,
//! 그 사실이 다음 hello 에 실려야 서버의 배정이 통한다.
//!
//! **아직 옮기지 않은 것**: 회수 중 세대(retiring) 러너의 announce(러너 표에 그 개념이 아직 없다 — s21c adoptRunner 와 함께),
//! `sessions`(러너 링크 다중화기 — s21b 전까지 빈 배열). harness 별 `models` 는 G5 에서 옮겼다 — `harness_models.rs` 가 재고 serve.rs 가 싣는다.

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

/// 기기 표지(H1) — 이 오퍼레이터가 어떤 기기에 어떤 꼴로 깔려 있는지. 서버는 적어 두기만 한다(일 배정은 그대로).
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct DeviceLabels {
    /// `macos`·`linux` …(`std::env::consts::OS`).
    pub platform: Option<String>,
    /// `aarch64`·`x86_64` …(`std::env::consts::ARCH`).
    pub arch: Option<String>,
    /// `app`(데스크톱 앱 번들) · `bundle`(릴리스 묶음) · `dev`(그 밖).
    pub install_kind: Option<String>,
    /// 업데이트 채널 — 띄운 쪽이 `--update-channel` 로 알려 줄 때만 싣는다(모르면 비운다).
    pub update_channel: Option<String>,
}

/// 표지 값 하나의 모양 — 소문자·숫자·`_`·`.`·`-` 1~32자. 서버도 같은 모양만 받는다(아니면 그 칸만 버린다).
pub fn label_ok(s: &str) -> bool {
    (1..=32).contains(&s.len())
        && s.bytes().all(|b| {
            b.is_ascii_lowercase() || b.is_ascii_digit() || matches!(b, b'_' | b'.' | b'-')
        })
}

/// 설치 꼴 — 실행 파일이 앱 번들 안이면 `app`, 릴리스가 판을 구웠으면 `bundle`, 아니면 `dev`.
pub fn install_kind_of(exe: &str, app_launched: bool, release_build: bool) -> &'static str {
    if app_launched || exe.contains(".app/Contents/MacOS/") {
        "app"
    } else if release_build {
        "bundle"
    } else {
        "dev"
    }
}

/// 이 프로세스의 표지. `update_channel` 은 모양이 틀리면 싣지 않는다.
pub fn device_labels(app_launched: bool, update_channel: Option<&str>) -> DeviceLabels {
    let exe = std::env::current_exe()
        .map(|p| p.to_string_lossy().into_owned())
        .unwrap_or_default();
    DeviceLabels {
        platform: Some(std::env::consts::OS.to_string()),
        arch: Some(std::env::consts::ARCH.to_string()),
        install_kind: Some(
            install_kind_of(
                &exe,
                app_launched,
                option_env!("HARKROOM_BUILD_VERSION").is_some(),
            )
            .to_string(),
        ),
        update_channel: update_channel
            .map(str::to_ascii_lowercase)
            .filter(|c| label_ok(c)),
    }
}

pub fn build_hello(
    capabilities: Value,
    runners: Vec<RunnerAnnounce>,
    sessions: Vec<Value>,
    version: Option<&str>,
) -> OperatorToServerFrame {
    build_hello_labeled(
        capabilities,
        runners,
        sessions,
        version,
        &DeviceLabels::default(),
    )
}

/// [`build_hello`] + 기기 표지(H1).
pub fn build_hello_labeled(
    capabilities: Value,
    runners: Vec<RunnerAnnounce>,
    sessions: Vec<Value>,
    version: Option<&str>,
    labels: &DeviceLabels,
) -> OperatorToServerFrame {
    OperatorToServerFrame::Hello {
        protocol: ProtocolOne,
        capabilities,
        runners,
        sessions,
        version: version.filter(|v| !v.is_empty()).map(str::to_string),
        platform: labels.platform.clone(),
        arch: labels.arch.clone(),
        install_kind: labels.install_kind.clone(),
        update_channel: labels.update_channel.clone(),
        // E2a — `wake` 프레임을 받을 줄 안다(받아 적고 `wake.ack` 만 답한다).
        wake_frames: Some(true),
        // I2b — 잡기 프레임을 보낼 줄 안다(실제로 보내는지는 서버 스위치와 그 에이전트의 `runnerPool` 이 정한다).
        work_claim: Some(true),
        // 풀 에이전트 목록은 배정을 아는 쪽(serve)이 채운다 — 여기서는 비운다.
        pool_agents: None,
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
    fn pool_agents_are_absent_until_filled_and_parked_frame_shape() {
        let v = serde_json::to_value(build_hello(json!({}), vec![], vec![], None)).unwrap();
        assert!(v.get("poolAgents").is_none());
        let parked = serde_json::to_value(OperatorToServerFrame::RunnerParked {
            agent_id: "a1".into(),
        })
        .unwrap();
        assert_eq!(parked, json!({"type": "runner.parked", "agentId": "a1"}));
    }

    #[test]
    fn device_labels_ride_hello_and_absent_ones_are_omitted() {
        let labels = DeviceLabels {
            platform: Some("linux".into()),
            arch: Some("x86_64".into()),
            install_kind: Some("bundle".into()),
            update_channel: None,
        };
        let v = serde_json::to_value(build_hello_labeled(
            capabilities(&[], Map::new()),
            vec![],
            vec![],
            Some("0.5.38"),
            &labels,
        ))
        .unwrap();
        assert_eq!(v["platform"], "linux");
        assert_eq!(v["arch"], "x86_64");
        assert_eq!(v["installKind"], "bundle");
        assert!(v.get("updateChannel").is_none());
        // 표지 없는 hello 는 예전 모양 그대로다.
        let old = serde_json::to_value(build_hello(
            capabilities(&[], Map::new()),
            vec![],
            vec![],
            None,
        ))
        .unwrap();
        for k in ["platform", "arch", "installKind", "updateChannel"] {
            assert!(old.get(k).is_none(), "{k}");
        }
    }

    #[test]
    fn install_kind_and_label_shape() {
        assert_eq!(
            install_kind_of("/Applications/X.app/Contents/MacOS/op", false, true),
            "app"
        );
        assert_eq!(install_kind_of("/home/u/.local/bin/op", true, false), "app");
        assert_eq!(
            install_kind_of("/home/u/.local/bin/op", false, true),
            "bundle"
        );
        assert_eq!(install_kind_of("/src/target/debug/op", false, false), "dev");
        assert!(label_ok("stable") && label_ok("x86_64") && label_ok("a-b.c"));
        assert!(
            !label_ok("") && !label_ok("Stable") && !label_ok("a b") && !label_ok(&"a".repeat(33))
        );
        let l = device_labels(false, Some("Stable"));
        assert_eq!(l.update_channel.as_deref(), Some("stable"));
        assert_eq!(
            device_labels(false, Some("bad channel")).update_channel,
            None
        );
        assert!(
            l.platform.as_deref().is_some_and(label_ok) && l.arch.as_deref().is_some_and(label_ok)
        );
    }

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
                "sessions": [], "version": "0.4.473",
                // E2a — `wake` 프레임을 받을 줄 안다고 밝힌다.
                "wakeFrames": true,
                "workClaim": true
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
