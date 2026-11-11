//! 러너 표(S2 A3b) — 오퍼레이터가 띄운 러너를 에이전트당 하나씩 들고, `spawnRunner`·`killRunner`·`listRunners` 에
//! 답하고, 러너가 끝나면 `runnerExit` 이벤트를 낸다. 정본은 `packages/operator/src/runners.ts`(`RunnerRegistry`)다.
//!
//! **옮긴 성질**(TS 와 같다):
//! - 에이전트당 하나 — 표에 살아 있는 세대가 있으면 새로 띄우지 않고 그 레코드를 돌려준다.
//! - 프로그램·인자는 클라이언트가 고르지 못한다 — 기동 때 받은 고정값(`RunnerLaunch`)만 쓴다(`#250` 경계).
//!   클라이언트가 주는 것은 `env` 뿐이고, 오퍼레이터 자신의 env 위에 덮는다(`withUserEnv`).
//! - 러너는 자기 프로세스 그룹을 갖는다(pgid = pid) — 오퍼레이터 그룹에 보낸 시그널에 딸려 가지 않는다.
//!   TS 는 `setsid`(새 세션)이고 여기는 `process_group(0)`(새 그룹, `unsafe` 없음)이다 — 그룹 시그널 경로는 같이 막는다.
//! - `killRunner` 는 SIGTERM 하나뿐이다. **SIGKILL 승격 타이머를 넣지 마라**(TS `killRunner` 주석: 러너는 SIGTERM 을
//!   드레인으로 받고, 언제 끝낼지는 러너만 안다). 세대(`incarnationId`)가 어긋난 kill 은 없는 러너와 같다.
//! - `alive` 는 `kill(pid, 0)` 으로 커널에 직접 묻는다.
//! - 늦게 온 종료가 그 사이 새로 뜬 세대의 자리를 비우지 않는다(표에서 지금 세대일 때만 뺀다).
//!
//! **아직 옮기지 않은 것**(A4 전 또는 B 줄): 장부(`runners.json`)·고아 채택(`adoptRunner`)·회수 중 세대(retiring·이관 보류)·
//! 러너 로그 파일과 종료 통지의 `tailLines`(지금은 빈 배열, 출력은 버린다)·커널 시작 시각.
use serde_json::{Value, json};
use std::collections::HashMap;
use std::os::unix::process::{CommandExt, ExitStatusExt};
use std::process::{Command, Stdio};
use std::sync::{Arc, Mutex};
use std::time::{SystemTime, UNIX_EPOCH};

/// 러너를 띄울 고정값. 기동 인자에서만 온다.
#[derive(Debug, Clone)]
pub struct RunnerLaunch {
    pub command: String,
    pub args: Vec<String>,
}

#[derive(Debug, Clone, PartialEq)]
pub struct RunnerRecord {
    pub agent_id: String,
    pub pid: i32,
    pub incarnation_id: String,
    pub started_at_ms: i64,
    pub term_sent_at_ms: Option<i64>,
}

/// 러너 종료 통지(`RunnerExitEvent`).
#[derive(Debug, Clone, PartialEq)]
pub struct RunnerExit {
    pub agent_id: String,
    pub incarnation_id: String,
    pub code: Option<i32>,
    pub signal: Option<String>,
}

impl RunnerExit {
    pub fn to_json(&self) -> Value {
        json!({
            "agentId": self.agent_id,
            "incarnationId": self.incarnation_id,
            "code": self.code,
            "signal": self.signal,
            "tailLines": [],
        })
    }
}

#[derive(Debug, PartialEq)]
pub enum SpawnOutcome {
    Started(RunnerRecord),
    /// 살아 있는 세대가 이미 있다 — 새로 안 띄웠다.
    Existing(RunnerRecord),
}

impl SpawnOutcome {
    pub fn record(&self) -> &RunnerRecord {
        match self {
            Self::Started(r) | Self::Existing(r) => r,
        }
    }
}

type ExitSink = Arc<dyn Fn(RunnerExit) + Send + Sync>;

pub struct RunnerTable {
    launch: Option<RunnerLaunch>,
    by_agent: Mutex<HashMap<String, RunnerRecord>>,
    on_exit: ExitSink,
}

pub fn now_ms() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0)
}

/// `kill(pid, sig)` 가 보내졌는가. ESRCH·EPERM 모두 "못 보냈다"다(TS `nodeRunnerHost.kill` 과 같은 판정 —
/// 표에 있는 pid 에 EPERM 이 나면 그 pid 는 이미 남의 것으로 재사용된 것이다). pid ≤ 0 은 그룹·전체 대상이라 막는다.
pub fn signal_sent(pid: i32, sig: i32) -> bool {
    if pid <= 0 {
        return false;
    }
    // SAFETY: kill(2) 는 메모리를 건드리지 않는다. pid > 0 이라 한 프로세스만 대상이다.
    unsafe { libc::kill(pid, sig) == 0 }
}

/// RFC 4122 v4 UUID(TS `randomUUID`). `/dev/urandom` 에서 16바이트.
pub fn new_incarnation_id() -> std::io::Result<String> {
    let h = crate::endpoint::random_hex(16)?;
    let mut b: Vec<u8> = (0..16)
        .map(|i| u8::from_str_radix(&h[i * 2..i * 2 + 2], 16).unwrap_or(0))
        .collect();
    b[6] = (b[6] & 0x0f) | 0x40;
    b[8] = (b[8] & 0x3f) | 0x80;
    let s: String = b.iter().map(|x| format!("{x:02x}")).collect();
    Ok(format!(
        "{}-{}-{}-{}-{}",
        &s[0..8],
        &s[8..12],
        &s[12..16],
        &s[16..20],
        &s[20..32]
    ))
}

fn signal_name(sig: i32) -> String {
    match sig {
        libc::SIGTERM => "SIGTERM",
        libc::SIGKILL => "SIGKILL",
        libc::SIGINT => "SIGINT",
        libc::SIGHUP => "SIGHUP",
        libc::SIGABRT => "SIGABRT",
        libc::SIGSEGV => "SIGSEGV",
        libc::SIGQUIT => "SIGQUIT",
        libc::SIGPIPE => "SIGPIPE",
        libc::SIGBUS => "SIGBUS",
        libc::SIGILL => "SIGILL",
        _ => return format!("SIG{sig}"),
    }
    .to_string()
}

impl RunnerTable {
    pub fn new(launch: Option<RunnerLaunch>, on_exit: ExitSink) -> Arc<Self> {
        Arc::new(Self {
            launch,
            by_agent: Mutex::new(HashMap::new()),
            on_exit,
        })
    }

    fn table(&self) -> std::sync::MutexGuard<'_, HashMap<String, RunnerRecord>> {
        self.by_agent.lock().unwrap_or_else(|p| p.into_inner())
    }

    /// 러너 하나를 띄운다. 표의 잠금을 쥔 채 띄워 같은 에이전트의 동시 spawn 이 둘을 만들지 않게 한다.
    pub fn spawn_runner(
        self: &Arc<Self>,
        agent_id: &str,
        env: &[(String, String)],
    ) -> Result<SpawnOutcome, String> {
        let mut table = self.table();
        if let Some(existing) = table.get(agent_id)
            && signal_sent(existing.pid, 0)
        {
            return Ok(SpawnOutcome::Existing(existing.clone()));
        }
        let Some(launch) = &self.launch else {
            return Err(
                "이 오퍼레이터(Rust)에는 러너 프로그램이 정해지지 않았다(--runner-command)".into(),
            );
        };
        let incarnation_id = new_incarnation_id().map_err(|e| e.to_string())?;
        let mut cmd = Command::new(&launch.command);
        cmd.args(&launch.args)
            .envs(env.iter().map(|(k, v)| (k.as_str(), v.as_str())))
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .process_group(0);
        let mut child = cmd.spawn().map_err(|e| format!("러너를 못 띄웠다: {e}"))?;
        let pid = i32::try_from(child.id()).map_err(|_| "러너 pid 가 범위를 넘었다".to_string())?;
        let record = RunnerRecord {
            agent_id: agent_id.to_string(),
            pid,
            incarnation_id: incarnation_id.clone(),
            started_at_ms: now_ms(),
            term_sent_at_ms: None,
        };
        table.insert(agent_id.to_string(), record.clone());
        drop(table);

        // 종료를 지켜보는 스레드. wait 가 자식을 거두므로 좀비가 남지 않는다.
        let me = Arc::clone(self);
        let agent = agent_id.to_string();
        std::thread::spawn(move || {
            let status = child.wait();
            {
                let mut t = me.table();
                // 지금 세대일 때만 뺀다 — 늦은 종료가 새 세대의 자리를 비우면 앱이 러너를 하나 더 띄운다.
                if t.get(&agent).map(|r| r.incarnation_id.as_str()) == Some(incarnation_id.as_str())
                {
                    t.remove(&agent);
                }
            }
            let (code, signal) = match status {
                Ok(s) => (s.code(), s.signal().map(signal_name)),
                Err(_) => (None, None),
            };
            (me.on_exit)(RunnerExit {
                agent_id: agent,
                incarnation_id,
                code,
                signal,
            });
        });
        Ok(SpawnOutcome::Started(record))
    }

    /// SIGTERM 하나. 여기서 끝이다 — 승격 타이머를 걸지 마라.
    pub fn kill_runner(
        &self,
        agent_id: &str,
        incarnation_id: Option<&str>,
    ) -> Option<RunnerRecord> {
        let mut table = self.table();
        let record = table.get_mut(agent_id)?;
        if let Some(id) = incarnation_id
            && record.incarnation_id != id
        {
            return None;
        }
        if record.term_sent_at_ms.is_none() {
            record.term_sent_at_ms = Some(now_ms());
        }
        signal_sent(record.pid, libc::SIGTERM);
        Some(record.clone())
    }

    /// `RunnerInfo[]`. 채택은 아직 없으므로 `adopted` 는 늘 false 다.
    pub fn list_runners(&self) -> Vec<Value> {
        let table = self.table();
        let mut rows: Vec<&RunnerRecord> = table.values().collect();
        rows.sort_by_key(|r| r.started_at_ms);
        rows.into_iter()
            .map(|r| {
                json!({
                    "agentId": r.agent_id,
                    "pid": r.pid,
                    "incarnationId": r.incarnation_id,
                    "startedAtMs": r.started_at_ms,
                    "alive": signal_sent(r.pid, 0),
                    "termSentAtMs": r.term_sent_at_ms,
                    "adopted": false,
                })
            })
            .collect()
    }

    /// 표의 기록 사본, 시작 순 — hello announce 가 쓴다.
    pub fn records(&self) -> Vec<RunnerRecord> {
        let mut rows: Vec<RunnerRecord> = self.table().values().cloned().collect();
        rows.sort_by_key(|r| r.started_at_ms);
        rows
    }

    pub fn current_incarnation(&self, agent_id: &str) -> Option<String> {
        self.table().get(agent_id).map(|r| r.incarnation_id.clone())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::mpsc;
    use std::time::Duration;

    fn table(script: &str) -> (Arc<RunnerTable>, mpsc::Receiver<RunnerExit>) {
        let (tx, rx) = mpsc::channel();
        let tx = Mutex::new(tx);
        let t = RunnerTable::new(
            Some(RunnerLaunch {
                command: "/bin/sh".into(),
                args: vec!["-c".into(), script.into()],
            }),
            Arc::new(move |e| {
                let _ = tx.lock().unwrap().send(e);
            }),
        );
        (t, rx)
    }

    /// spawn 하는 동안만 잡는다(`crate::FORK_GUARD` 주석).
    fn spawn(t: &Arc<RunnerTable>, env: &[(String, String)]) -> SpawnOutcome {
        let _g = crate::fork_guard();
        t.spawn_runner("a1", env).unwrap()
    }

    #[test]
    fn incarnation_id_is_uuid_v4() {
        let id = new_incarnation_id().unwrap();
        assert_eq!(id.len(), 36);
        assert_eq!(&id[14..15], "4");
        assert!(matches!(&id[19..20], "8" | "9" | "a" | "b"));
        assert_ne!(id, new_incarnation_id().unwrap());
    }

    #[test]
    fn spawn_is_one_per_agent_and_own_process_group() {
        let (t, _rx) = table("sleep 30");
        let a = spawn(&t, &[]);
        assert!(matches!(a, SpawnOutcome::Started(_)));
        let b = spawn(&t, &[]);
        assert_eq!(b, SpawnOutcome::Existing(a.record().clone()));
        let pid = a.record().pid;
        // SAFETY: getpgid 는 메모리를 건드리지 않는다.
        assert_eq!(unsafe { libc::getpgid(pid) }, pid);
        let rows = t.list_runners();
        assert_eq!(rows.len(), 1);
        assert_eq!(rows[0]["alive"], json!(true));
        assert_eq!(rows[0]["termSentAtMs"], Value::Null);
        signal_sent(pid, libc::SIGKILL);
    }

    #[test]
    fn env_reaches_runner_and_exit_carries_code() {
        let (t, rx) = table("exit \"$HK_CODE\"");
        let r = spawn(&t, &[("HK_CODE".into(), "7".into())]);
        let e = rx.recv_timeout(Duration::from_secs(10)).unwrap();
        assert_eq!(e.code, Some(7));
        assert_eq!(e.signal, None);
        assert_eq!(e.incarnation_id, r.record().incarnation_id);
        assert_eq!(e.to_json()["tailLines"], json!([]));
        assert!(t.list_runners().is_empty());
    }

    #[test]
    fn kill_sends_sigterm_once_and_checks_incarnation() {
        let (t, rx) = table("sleep 30");
        let r = spawn(&t, &[]).record().clone();
        assert!(t.kill_runner("a1", Some("other")).is_none());
        assert!(t.kill_runner("nobody", None).is_none());
        let k = t.kill_runner("a1", Some(&r.incarnation_id)).unwrap();
        assert!(k.term_sent_at_ms.is_some());
        let e = rx.recv_timeout(Duration::from_secs(10)).unwrap();
        assert_eq!(e.signal.as_deref(), Some("SIGTERM"));
        assert_eq!(e.code, None);
    }

    #[test]
    fn kill_never_escalates_to_sigkill() {
        // SIGTERM 을 무시하는 러너는 아무리 기다려도 살아 있어야 한다.
        let (t, _rx) = table("trap '' TERM; sleep 30");
        let r = spawn(&t, &[]).record().clone();
        std::thread::sleep(Duration::from_millis(200));
        t.kill_runner("a1", None).unwrap();
        std::thread::sleep(Duration::from_millis(800));
        assert!(signal_sent(r.pid, 0));
        assert_eq!(t.list_runners()[0]["alive"], json!(true));
        signal_sent(r.pid, libc::SIGKILL);
    }

    #[test]
    fn late_exit_does_not_clear_new_incarnation() {
        let (t, rx) = table("sleep 30");
        let old = spawn(&t, &[]).record().clone();
        // 옛 세대를 표에서 밀어내고 새 세대가 선 것처럼 만든다.
        t.table().get_mut("a1").unwrap().incarnation_id = "new".into();
        signal_sent(old.pid, libc::SIGKILL);
        let e = rx.recv_timeout(Duration::from_secs(10)).unwrap();
        assert_eq!(e.incarnation_id, old.incarnation_id);
        assert_eq!(t.current_incarnation("a1").as_deref(), Some("new"));
    }

    #[test]
    fn no_launch_means_refusal() {
        let t = RunnerTable::new(None, Arc::new(|_| {}));
        assert!(
            t.spawn_runner("a1", &[])
                .unwrap_err()
                .contains("--runner-command")
        );
        assert!(!signal_sent(0, 0));
        assert!(!signal_sent(-1, 0));
    }
}
