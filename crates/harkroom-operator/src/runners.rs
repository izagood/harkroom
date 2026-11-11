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
//! - 장부(s21c-2b-2): 띄우고 끝날 때마다 표 전체를 `<appDataDir>/operator/runners-v1.json` 에 적는다(`set_ledger` 로 배선했을 때만).
//!   **표 잠금을 쥔 채 `save` 를 부른다** — JS 는 단일 스레드라 저절로 서는 「마지막 스냅샷 = 지금 표」를 여기서는 잠금이 세운다.
//!   커널 시작 시각(`bootTimeSec`)은 spawn 직후, **waiter 스레드가 `wait` 하기 전에** 읽는다 — 거두기 전이라 끝났어도 좀비가 pid 를
//!   쥐고 있어 재사용 창이 없다(TS 는 `child.on('exit')` 를 건 뒤 await 로 읽어 그 창이 조금 있다).
//!   링크 secret 은 요청 env 의 `HARKROOM_RUNNER_SECRET`(TS `runners.ts` 의 `linkSecret`)이다.
//!
//! **아직 옮기지 않은 것**: 기동 때 고아 채택(`adoptRunner`, s21c-2b-3)·회수 중 세대(retiring·이관 보류)·
//! 러너 로그 파일과 종료 통지의 `tailLines`(지금은 빈 배열, 출력은 버린다) — s21c-2c.
use crate::runner_ledger::{RunnerLedgerEntry, RunnerLedgerWriter};
use serde_json::{Value, json};
use std::collections::HashMap;
use std::os::unix::process::{CommandExt, ExitStatusExt};
use std::process::{Command, Stdio};
use std::sync::{Arc, Mutex, OnceLock};
use std::time::{SystemTime, UNIX_EPOCH};

/// 러너를 띄울 고정값. 기동 인자에서만 온다.
#[derive(Debug, Clone)]
pub struct RunnerLaunch {
    pub command: String,
    pub args: Vec<String>,
}

/// `Debug` 는 손으로 쓴다 — `link_secret` 이 `{:?}` 로 새지 않게(장부 줄과 같은 이유).
#[derive(Clone, PartialEq)]
pub struct RunnerRecord {
    pub agent_id: String,
    pub pid: i32,
    pub incarnation_id: String,
    pub started_at_ms: i64,
    pub term_sent_at_ms: Option<i64>,
    /// 커널 시작 시각(초). 못 읽었으면 None — 그러면 다음 오퍼레이터가 채택하지 않는다(`adopt.rs`).
    pub boot_time_sec: Option<i64>,
    /// 러너 링크 secret(`HARKROOM_RUNNER_SECRET`). 장부에 실려 다음 오퍼레이터가 채택한 러너의 링크를 다시 받는다.
    pub link_secret: Option<String>,
    /// 앞 오퍼레이터가 남긴 고아를 채택한 줄인가(s21c-2b-3 에서 채운다).
    pub adopted: bool,
}

impl std::fmt::Debug for RunnerRecord {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("RunnerRecord")
            .field("agent_id", &self.agent_id)
            .field("pid", &self.pid)
            .field("incarnation_id", &self.incarnation_id)
            .field("started_at_ms", &self.started_at_ms)
            .field("term_sent_at_ms", &self.term_sent_at_ms)
            .field("boot_time_sec", &self.boot_time_sec)
            .field(
                "link_secret",
                &self.link_secret.as_ref().map(|_| "<redacted>"),
            )
            .field("adopted", &self.adopted)
            .finish()
    }
}

/// 장부 배선(TS run.ts `ledgerSink`) — 쓰기 창구와 줄마다 찍을 출처(이 오퍼레이터의 launch nonce·앱 세대).
pub struct LedgerBinding {
    pub writer: RunnerLedgerWriter,
    pub nonce: String,
    /// `--app-version`. 없으면 장부에 세대를 적지 않는다(TS 와 같다 — 다음 오퍼레이터는 낡은 세대로 본다).
    pub app_version: Option<String>,
}

impl LedgerBinding {
    fn entries(&self, table: &HashMap<String, RunnerRecord>) -> Vec<RunnerLedgerEntry> {
        let mut rows: Vec<&RunnerRecord> = table.values().collect();
        rows.sort_by_key(|r| r.started_at_ms);
        rows.into_iter()
            .map(|r| RunnerLedgerEntry {
                agent_id: r.agent_id.clone(),
                pid: r.pid,
                incarnation_id: r.incarnation_id.clone(),
                link_secret: r.link_secret.clone().filter(|s| !s.is_empty()),
                started_at_ms: r.started_at_ms,
                boot_time_sec: r.boot_time_sec,
                spawned_by_nonce: self.nonce.clone(),
                spawned_by_app_version: self.app_version.clone(),
                retiring: None,
            })
            .collect()
    }
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

type BootProbe = fn(i32) -> Option<i64>;

pub struct RunnerTable {
    launch: Option<RunnerLaunch>,
    by_agent: Mutex<HashMap<String, RunnerRecord>>,
    on_exit: ExitSink,
    /// 장부. 배선 전(시험·토큰 없는 기동)에는 비어 있고 아무것도 쓰지 않는다.
    ledger: OnceLock<LedgerBinding>,
    /// 커널 시작 시각을 읽는 자리 — 실물은 `ps`, 시험은 주입.
    boot_probe: BootProbe,
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

/// 배정 조정기(`assignments.rs` `runner_env`)와 이관 보류가 **정하는** 러너 env 이름들. 오퍼레이터를 띄운 셸에 같은 이름이 있으면
/// 그 값이 러너로 새어 사람이 켜지 않은 기능이 켜진다(예: `HARKROOM_COMMAND_HOOK=1`, security #1888 낮음) — spawn 전에 부모 env 에서 걷어 낸다.
/// 요청 env 가 준 값은 그 뒤에 얹으므로 그대로 산다.
///
/// `HARKROOM_*` 전부가 아닌 이유: 러너는 부모 env 의 `HARKROOM_CLAUDE_ACCOUNTS_DIR`·`HARKROOM_AGENT_INSTANCE`·`HARKROOM_MAX_TURNS` 같은
/// 사람이 정한 손잡이도 읽는다(TS `withUserEnv` — "하네스가 무엇을 읽는지 모른다"). `CODEX_HOME` 도 러너가 로그인 원본으로 읽는다(`codexHome.ts`).
pub const COORDINATOR_OWNED_ENV: &[&str] = &[
    "HARKROOM_OPERATOR_SOCKET",
    "HARKROOM_RUNNER_ID",
    "HARKROOM_RUNNER_SECRET",
    "HARKROOM_OPERATOR_BIN",
    "HARKROOM_MCP_CONFIG",
    "HARKROOM_TURN_SECRETS_DIR",
    "HARKROOM_WORKING_DIR",
    "HARKROOM_CLAUDE_POOL",
    "HARKROOM_COMMAND_HOOK",
    "HARKROOM_POST_TOOL_HOOK",
    "HARKROOM_CHROME_HOST",
    "HARKROOM_PROVIDER_LANE",
    "HARKROOM_HANDOVER_HOLD",
    "HARKROOM_HANDOVER_DONE",
];

/// 러너 명령을 세운다 — 오퍼레이터 env 를 물려받되(`withUserEnv`) 조정기 몫 이름은 먼저 걷고, 요청 env 를 얹는다.
fn runner_command(launch: &RunnerLaunch, env: &[(String, String)]) -> Command {
    let mut cmd = Command::new(&launch.command);
    cmd.args(&launch.args);
    for k in COORDINATOR_OWNED_ENV {
        cmd.env_remove(k);
    }
    cmd.envs(env.iter().map(|(k, v)| (k.as_str(), v.as_str())))
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .process_group(0);
    cmd
}

impl RunnerTable {
    pub fn new(launch: Option<RunnerLaunch>, on_exit: ExitSink) -> Arc<Self> {
        Arc::new(Self {
            launch,
            by_agent: Mutex::new(HashMap::new()),
            on_exit,
            ledger: OnceLock::new(),
            boot_probe: crate::adopt::ps_boot_time_sec,
        })
    }

    /// 장부를 건다. 한 번만 — 두 번째는 stderr 에 남기고 버린다(`set_on_runner_exit` 와 같은 꼴).
    pub fn set_ledger(&self, binding: LedgerBinding) {
        if self.ledger.set(binding).is_err() {
            eprintln!("러너 장부가 이미 배선돼 있다 — 두 번째 배선을 버린다");
        }
    }

    /// 표 잠금을 쥔 자리에서만 부른다 — 스냅샷이 지금 표와 같은 순서로 창구에 들어가야 마지막 save 가 지금 표다.
    fn save_locked(&self, table: &HashMap<String, RunnerRecord>) {
        if let Some(l) = self.ledger.get() {
            l.writer.save(l.entries(table));
        }
    }

    fn table(&self) -> std::sync::MutexGuard<'_, HashMap<String, RunnerRecord>> {
        self.by_agent.lock().unwrap_or_else(|p| p.into_inner())
    }

    /// 러너 하나를 띄운다. 표의 잠금을 쥔 채 띄워 같은 에이전트의 동시 spawn 이 둘을 만들지 않게 한다.
    ///
    /// `runner_id` 는 밖(배정 조정기)에서 정한 세대 id 다 — 러너는 그 id 를 env(`HARKROOM_RUNNER_ID`)로 받아 링크에 hello 하므로
    /// spawn **전에** 정해져 있어야 하고, 표의 `incarnation_id` 도 같은 값이어야 한다(TS `spawnRunner(agentId, env, incarnationId?)`).
    /// 없으면 여기서 만든다(앱 `spawnRunner` 요청 경로).
    pub fn spawn_runner(
        self: &Arc<Self>,
        agent_id: &str,
        env: &[(String, String)],
        runner_id: Option<&str>,
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
        let incarnation_id = match runner_id {
            Some(id) if !id.is_empty() => id.to_string(),
            Some(_) => return Err("러너 id 가 비었다".into()),
            None => new_incarnation_id().map_err(|e| e.to_string())?,
        };
        let mut cmd = runner_command(launch, env);
        let mut child = cmd.spawn().map_err(|e| format!("러너를 못 띄웠다: {e}"))?;
        let pid = i32::try_from(child.id()).map_err(|_| "러너 pid 가 범위를 넘었다".to_string())?;
        // 커널 시작 시각은 **waiter 가 거두기 전에** 읽는다 — 그 전까지는 러너가 끝났어도 좀비가 pid 를 쥐고 있어서
        // 무관한 프로세스의 시작 시각을 우리 러너 것으로 적을 길이 없다. 못 읽으면 None(다음 오퍼레이터가 채택하지 않는다).
        let boot_time_sec = (self.boot_probe)(pid);
        let record = RunnerRecord {
            agent_id: agent_id.to_string(),
            pid,
            incarnation_id: incarnation_id.clone(),
            started_at_ms: now_ms(),
            term_sent_at_ms: None,
            boot_time_sec,
            link_secret: env
                .iter()
                .find(|(k, _)| k == "HARKROOM_RUNNER_SECRET")
                .map(|(_, v)| v.clone())
                .filter(|v| !v.is_empty()),
            adopted: false,
        };
        table.insert(agent_id.to_string(), record.clone());
        self.save_locked(&table);
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
                    // 장부도 줄인다 — 정상 종료한 러너가 다음 오퍼레이터의 후보로 남지 않게(TS exit 핸들러와 같다).
                    me.save_locked(&t);
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

    /// `RunnerInfo[]`.
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
                    "adopted": r.adopted,
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

    /// 앞 오퍼레이터가 남긴 고아를 표에 올린다(TS `RunnerRegistry.adopt`). 신원 확인은 하지 않는다 —
    /// `adopt::plan_adoption` 이 이미 했고, 판정을 두 곳에 두면 한쪽만 강화되는 날이 온다.
    ///
    /// - `incarnation_id` 는 **장부 것을 그대로** 쓴다 — 새로 만들면 앱이 아는 세대와 갈려 `kill_runner` 가 조용히 거절된다.
    /// - 그 에이전트에 살아 있는 표가 있으면 **채택하지 않는다**(None) — 지금 러너를 밀어내 고아를 만들지 않는다.
    /// - `term_sent_at_ms` 는 None — 이 오퍼레이터는 SIGTERM 을 보낸 적이 없다(추측으로 채우지 않는다).
    /// - 내 자식이 아니라 wait 할 수 없다 — 종료는 `poll_adopted` 가 `kill(pid, 0)` 으로 묻는다.
    pub fn adopt_runner(&self, entry: &RunnerLedgerEntry) -> Option<RunnerRecord> {
        let mut table = self.table();
        if let Some(existing) = table.get(&entry.agent_id)
            && signal_sent(existing.pid, 0)
        {
            return None;
        }
        let record = RunnerRecord {
            agent_id: entry.agent_id.clone(),
            pid: entry.pid,
            incarnation_id: entry.incarnation_id.clone(),
            started_at_ms: entry.started_at_ms,
            term_sent_at_ms: None,
            boot_time_sec: entry.boot_time_sec,
            // secret 도 잇는다 — 다음 장부 쓰기가 빠뜨리면 두 번째 재시작에서 다시 잃는다.
            link_secret: entry.link_secret.clone().filter(|s| !s.is_empty()),
            adopted: true,
        };
        table.insert(entry.agent_id.clone(), record.clone());
        self.save_locked(&table);
        Some(record)
    }

    /// 채택한 러너의 생사를 묻고 끝난 것을 표·장부에서 뺀 뒤 종료를 알린다(TS `pollAdopted`).
    /// 코드·시그널은 **모른다**(None) — 지어내지 않는다. 주기는 부르는 쪽이 정한다(여기엔 타이머가 없다).
    pub fn poll_adopted(&self) {
        let mut gone = Vec::new();
        {
            let mut table = self.table();
            let dead: Vec<String> = table
                .values()
                .filter(|r| r.adopted && !signal_sent(r.pid, 0))
                .map(|r| r.agent_id.clone())
                .collect();
            for agent in dead {
                if let Some(r) = table.remove(&agent) {
                    gone.push(r);
                }
            }
            if !gone.is_empty() {
                self.save_locked(&table);
            }
        }
        for r in gone {
            (self.on_exit)(RunnerExit {
                agent_id: r.agent_id,
                incarnation_id: r.incarnation_id,
                code: None,
                signal: None,
            });
        }
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
        t.spawn_runner("a1", env, None).unwrap()
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
    fn given_runner_id_becomes_incarnation_and_empty_is_refused() {
        let (t, rx) = table("exit 0");
        let r = {
            let _g = crate::fork_guard();
            t.spawn_runner("a1", &[], Some("rid-from-coordinator"))
                .unwrap()
        };
        assert_eq!(r.record().incarnation_id, "rid-from-coordinator");
        let e = rx.recv_timeout(Duration::from_secs(10)).unwrap();
        assert_eq!(e.incarnation_id, "rid-from-coordinator");
        assert!(t.spawn_runner("a2", &[], Some("")).is_err());
    }

    #[test]
    fn coordinator_owned_parent_env_is_removed_then_request_env_applies() {
        let launch = RunnerLaunch {
            command: "/bin/sh".into(),
            args: vec![],
        };
        let cmd = runner_command(
            &launch,
            &[
                ("HARKROOM_CHROME_HOST".into(), "0".into()),
                ("X".into(), "1".into()),
            ],
        );
        let envs: HashMap<String, Option<String>> = cmd
            .get_envs()
            .map(|(k, v)| {
                (
                    k.to_string_lossy().into_owned(),
                    v.map(|v| v.to_string_lossy().into_owned()),
                )
            })
            .collect();
        // 조정기가 이번에 안 준 이름은 지운다(None) — 부모 셸의 `HARKROOM_COMMAND_HOOK=1` 이 새지 않는다.
        assert_eq!(envs.get("HARKROOM_COMMAND_HOOK"), Some(&None));
        assert_eq!(envs.get("HARKROOM_WORKING_DIR"), Some(&None));
        // 준 이름은 요청 값이 이긴다.
        assert_eq!(envs.get("HARKROOM_CHROME_HOST"), Some(&Some("0".into())));
        assert_eq!(envs.get("X"), Some(&Some("1".into())));
        // 사람이 정한 손잡이는 건드리지 않는다(물려받는다).
        assert!(!envs.contains_key("HARKROOM_CLAUDE_ACCOUNTS_DIR"));
        assert!(!envs.contains_key("CODEX_HOME"));
    }

    #[test]
    fn coordinator_owned_list_covers_every_key_runner_env_writes() {
        let src = include_str!("assignments.rs");
        let i = src.find("fn runner_env(").unwrap();
        let body = &src[i..i + src[i..].find("\n    }\n").unwrap()];
        let mut n = 0;
        for part in body.split("put(\"").skip(1) {
            let k = &part[..part.find('"').unwrap()];
            // PATH·AGENT_VERSION 은 사람 셸 값이 있어도 되는 이름이다 — 조정기 몫은 HARKROOM_* 만.
            if !k.starts_with("HARKROOM_") {
                continue;
            }
            assert!(COORDINATOR_OWNED_ENV.contains(&k), "{k} 가 목록에 없다");
            n += 1;
        }
        assert!(n >= 10, "runner_env 의 put 을 못 찾았다: {n}");
        assert!(COORDINATOR_OWNED_ENV.contains(&crate::assignments::PROVIDER_LANE_ENV));
    }

    type Snapshots = Arc<Mutex<Vec<Vec<RunnerLedgerEntry>>>>;

    /// 장부를 건 표 — 쓰기는 디스크 대신 스냅샷 목록에 쌓는다.
    fn ledgered(
        script: &str,
        probe: BootProbe,
    ) -> (Arc<RunnerTable>, mpsc::Receiver<RunnerExit>, Snapshots) {
        let (tx, rx) = mpsc::channel();
        let tx = Mutex::new(tx);
        let t = Arc::new(RunnerTable {
            launch: Some(RunnerLaunch {
                command: "/bin/sh".into(),
                args: vec!["-c".into(), script.into()],
            }),
            by_agent: Mutex::new(HashMap::new()),
            on_exit: Arc::new(move |e| {
                let _ = tx.lock().unwrap().send(e);
            }),
            ledger: OnceLock::new(),
            boot_probe: probe,
        });
        let snaps: Snapshots = Arc::new(Mutex::new(Vec::new()));
        let sink = Arc::clone(&snaps);
        t.set_ledger(LedgerBinding {
            writer: RunnerLedgerWriter::with_write(
                std::env::temp_dir(),
                Box::new(|_| {}),
                Box::new(move |_, entries, _| sink.lock().unwrap().push(entries.to_vec())),
            ),
            nonce: "nonce-1".into(),
            app_version: Some("0.4.498".into()),
        });
        (t, rx, snaps)
    }

    fn last(t: &RunnerTable, snaps: &Snapshots) -> Vec<RunnerLedgerEntry> {
        t.ledger.get().unwrap().writer.drain();
        snaps.lock().unwrap().last().cloned().unwrap()
    }

    #[test]
    fn spawn_and_exit_write_ledger_with_boot_time_secret_and_origin() {
        let (t, rx, snaps) = ledgered("read _ < /dev/null; sleep 0.3", |pid| {
            Some(i64::from(pid) + 7)
        });
        let r = spawn(&t, &[("HARKROOM_RUNNER_SECRET".into(), "s3cret".into())])
            .record()
            .clone();
        assert_eq!(r.boot_time_sec, Some(i64::from(r.pid) + 7));
        assert_eq!(r.link_secret.as_deref(), Some("s3cret"));
        let rows = last(&t, &snaps);
        assert_eq!(rows.len(), 1);
        let e = &rows[0];
        assert_eq!((e.agent_id.as_str(), e.pid), ("a1", r.pid));
        assert_eq!(e.incarnation_id, r.incarnation_id);
        assert_eq!(e.boot_time_sec, Some(i64::from(r.pid) + 7));
        assert_eq!(e.link_secret.as_deref(), Some("s3cret"));
        assert_eq!(e.spawned_by_nonce, "nonce-1");
        assert_eq!(e.spawned_by_app_version.as_deref(), Some("0.4.498"));
        assert_eq!(e.retiring, None);
        // 끝나면 장부에서도 빠진다 — 정상 종료한 러너가 다음 오퍼레이터의 후보로 남지 않는다.
        rx.recv_timeout(Duration::from_secs(10)).unwrap();
        assert!(last(&t, &snaps).is_empty());
    }

    #[test]
    fn missing_boot_time_and_empty_secret_are_written_as_absent() {
        let (t, _rx, snaps) = ledgered("sleep 30", |_| None);
        let r = spawn(&t, &[("HARKROOM_RUNNER_SECRET".into(), String::new())])
            .record()
            .clone();
        let rows = last(&t, &snaps);
        assert_eq!(rows[0].boot_time_sec, None);
        assert_eq!(rows[0].link_secret, None);
        signal_sent(r.pid, libc::SIGKILL);
    }

    #[test]
    fn boot_time_is_read_before_reaping_even_if_runner_exits_at_once() {
        // 러너가 곧바로 끝나도 waiter 가 거두기 전이라 좀비가 pid 를 쥐고 있다 — 실물 ps 로 그 pid 의 시작 시각이 읽힌다.
        let (t, rx, _snaps) = ledgered("exit 0", crate::adopt::ps_boot_time_sec);
        let r = spawn(&t, &[]).record().clone();
        let now = now_ms() / 1000;
        let b = r
            .boot_time_sec
            .expect("거두기 전에는 좀비라도 시작 시각이 읽혀야 한다");
        assert!((now - b).abs() <= 5, "boot={b} now={now}");
        rx.recv_timeout(Duration::from_secs(10)).unwrap();
    }

    #[test]
    fn record_debug_hides_link_secret() {
        let (t, _rx, _snaps) = ledgered("sleep 30", |_| None);
        let r = spawn(&t, &[("HARKROOM_RUNNER_SECRET".into(), "s3cret".into())])
            .record()
            .clone();
        let d = format!("{r:?}");
        assert!(!d.contains("s3cret"), "{d}");
        assert!(d.contains("<redacted>"));
        signal_sent(r.pid, libc::SIGKILL);
    }

    fn orphan(agent: &str, pid: i32) -> RunnerLedgerEntry {
        RunnerLedgerEntry {
            agent_id: agent.into(),
            pid,
            incarnation_id: "inc-orphan".into(),
            link_secret: Some("orph-s".into()),
            started_at_ms: 42,
            boot_time_sec: Some(7),
            spawned_by_nonce: "old-nonce".into(),
            spawned_by_app_version: Some("0.4.498".into()),
            retiring: None,
        }
    }

    /// 남의 자식처럼 다룰 프로세스 — 이 시험이 띄우되 표 밖에서 거둔다.
    fn outside(secs: &str) -> std::process::Child {
        let _g = crate::fork_guard();
        std::process::Command::new("/bin/sleep")
            .arg(secs)
            .spawn()
            .unwrap()
    }

    #[test]
    fn adopt_keeps_ledger_incarnation_and_secret_then_poll_reports_unknown_exit() {
        let (t, rx, snaps) = ledgered("sleep 30", |_| None);
        let mut child = outside("30");
        let pid = child.id() as i32;
        let r = t
            .adopt_runner(&orphan("a1", pid))
            .expect("빈 자리면 채택한다");
        assert!(r.adopted);
        assert_eq!(r.incarnation_id, "inc-orphan");
        assert_eq!(r.term_sent_at_ms, None);
        assert_eq!(t.current_incarnation("a1").as_deref(), Some("inc-orphan"));
        let rows = last(&t, &snaps);
        assert_eq!(rows[0].link_secret.as_deref(), Some("orph-s"));
        assert_eq!(rows[0].boot_time_sec, Some(7));
        // 살아 있으면 poll 은 아무것도 안 한다.
        t.poll_adopted();
        assert!(rx.try_recv().is_err());
        // 같은 에이전트의 spawn 은 채택한 세대를 그대로 돌려준다(둘이 되지 않는다).
        assert!(matches!(spawn(&t, &[]), SpawnOutcome::Existing(_)));
        child.kill().unwrap();
        child.wait().unwrap();
        t.poll_adopted();
        let e = rx.recv_timeout(Duration::from_secs(5)).unwrap();
        assert_eq!(
            (e.agent_id.as_str(), e.incarnation_id.as_str()),
            ("a1", "inc-orphan")
        );
        assert_eq!((e.code, e.signal), (None, None));
        assert!(last(&t, &snaps).is_empty());
        assert_eq!(t.current_incarnation("a1"), None);
    }

    #[test]
    fn adopt_refuses_when_live_runner_holds_the_seat() {
        let (t, _rx, _snaps) = ledgered("sleep 30", |_| None);
        let live = spawn(&t, &[]).record().clone();
        let mut child = outside("30");
        assert_eq!(t.adopt_runner(&orphan("a1", child.id() as i32)), None);
        assert_eq!(
            t.current_incarnation("a1").as_deref(),
            Some(live.incarnation_id.as_str())
        );
        child.kill().unwrap();
        child.wait().unwrap();
        signal_sent(live.pid, libc::SIGKILL);
    }

    #[test]
    fn zombie_keeps_boot_time_readable_until_reaped_order_fixed() {
        // security c2b-3 ③ — 순서를 고정한다: 러너가 표지 파일을 남기고 **끝난 것을 확인한 뒤**, 거두기(wait) 전에 읽는다.
        let mark = std::env::temp_dir().join(format!("hk-zombie-{}", std::process::id()));
        let _ = std::fs::remove_file(&mark);
        let mut child = {
            let _g = crate::fork_guard();
            std::process::Command::new("/bin/sh")
                .arg("-c")
                .arg(format!("touch '{}'", mark.display()))
                .spawn()
                .unwrap()
        };
        let pid = child.id() as i32;
        let deadline = std::time::Instant::now() + Duration::from_secs(10);
        while !mark.exists() {
            assert!(
                std::time::Instant::now() < deadline,
                "표지 파일이 안 생겼다"
            );
            std::thread::sleep(Duration::from_millis(10));
        }
        // 파일이 생긴 뒤에도 셸이 끝날 때까지 기다린다 — waitpid(WNOHANG|WNOWAIT) 대신 ps 의 상태(Z)로 본다.
        loop {
            let st = std::process::Command::new("/bin/ps")
                .args(["-o", "stat=", "-p", &pid.to_string()])
                .output()
                .unwrap();
            if String::from_utf8_lossy(&st.stdout)
                .trim_start()
                .starts_with('Z')
            {
                break;
            }
            assert!(std::time::Instant::now() < deadline, "좀비가 안 됐다");
            std::thread::sleep(Duration::from_millis(10));
        }
        assert!(signal_sent(pid, 0), "거두기 전 좀비는 kill(pid,0) 이 산다");
        let b = crate::adopt::ps_boot_time_sec(pid).expect("좀비라도 시작 시각이 읽혀야 한다");
        assert!((now_ms() / 1000 - b).abs() <= 5);
        child.wait().unwrap();
        let _ = std::fs::remove_file(&mark);
    }

    #[test]
    fn no_launch_means_refusal() {
        let t = RunnerTable::new(None, Arc::new(|_| {}));
        assert!(
            t.spawn_runner("a1", &[], None)
                .unwrap_err()
                .contains("--runner-command")
        );
        assert!(!signal_sent(0, 0));
        assert!(!signal_sent(-1, 0));
    }
}
