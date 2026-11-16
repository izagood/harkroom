//! 새 터미널 턴 띄우기(정본 `interactiveTurn.ts` `spawn`, 분기 ③) — B-2c 2부의 글루.
//!
//! 판정은 떨어진 두 모듈이 한다: 조종 장부 절반은 [`crate::interactive_turn`], 회수 상태 기계는 [`crate::interactive_life`].
//! 여기는 그 둘에 정의·세션 기록·계정·명령 조립·PTY 를 잇는다. `RunnerMaker` 의 칸을 쓰려고 `call_maker` 의 자식 모듈로 둔다.
//!
//! 차례(정본 그대로): 정의 → 세션 기록(하네스가 바뀌었으면 세션만 버린다) → 계정(기록 계정을 따른다) → 모델 → 명령 조립
//! (interactive: 프롬프트·stdin 없음) → **한 잠금으로** 재검사·세션 열기·등록 → 관문(신뢰·bypass·codex 규칙) → PTY.
//! spawn 이 확인되면 곧장 `(sessionId, true)` 를 돌려준다(서버 10초 안에 티켓이 나가야 한다). 뜨기 전에 끝나면 열기 실패다.
//! 끝(어느 길이든): 회수 타이머 거두기 → codex 세션 id 찾기 → 세션 파일이 생겼으면 `turnsRun=1` → `lastFedSeq` 전진(클램프)
//! → 대기 장부 비우기 → 등록 해제 → 세션 닫기.

use std::path::{Path, PathBuf};
use std::sync::mpsc;
use std::sync::{Arc, Mutex};
use std::time::Duration;

use serde_json::Value;

use super::RunnerMaker;
use crate::adapter::{AgentHarness, MentionPermission};
use crate::interactive_life::{Act, InteractiveLife};
use crate::interactive_turn::{self, Claim, MENTION_STARTING_REJECTION, NO_RELAY_REJECTION};
use crate::mention_clients::AgentLink;
use crate::pty_turn::{PromptHooks, PtyControls, PtyTurnOptions, PtyTurnSink, run_pty_turn};
use crate::relay_session::{InteractiveOpenRequest, OpenSessionInput, SessionHandle};
use crate::session_store::SessionRecord;
use crate::turn_command::{TurnCommandOptions, build_turn_command};
use crate::turn_preset::{TurnMode, chrome_turn_for, preassigns_session_id};
use crate::turn_registry::SharedControl;

/// 뷰어가 없을 때 회수까지의 유예(스펙 §5-2 결정 5).
pub const ORPHAN_GRACE: Duration = Duration::from_secs(60);
/// SIGTERM 뒤 SIGKILL 까지.
pub const KILL_GRACE: Duration = Duration::from_secs(5);
/// 멘션 턴이 등록되기를 기다리는 상한·간격(정본 `awaitMentionStart`).
const MENTION_START_WAIT: Duration = Duration::from_secs(30);
const MENTION_START_POLL: Duration = Duration::from_millis(100);
/// 끝 처리에서 읽는 스레드 글 상한.
const READ_LIMIT: u32 = 200;

/// 하나의 인터랙티브 턴이 쥐는 것 — 회수 상태 기계와 PTY 손잡이. 타이머 스레드와 PTY 루프가 같이 쥔다.
struct Live {
    life: InteractiveLife,
    controls: Option<PtyControls>,
    /// 고아 타이머 세대 — 거둔 타이머가 깨어나도 세대가 다르면 아무것도 하지 않는다.
    orphan_gen: u64,
}

type SharedLive = Arc<Mutex<Live>>;

/// 도는 새 터미널 턴 목록 — 러너가 물러날 때 하나씩 회수하고, 끝 처리(세션 기록 저장)까지 기다린다.
#[derive(Default)]
pub(super) struct Roster {
    inner: Mutex<RosterInner>,
    idle: std::sync::Condvar,
}

#[derive(Default)]
struct RosterInner {
    next: u64,
    live: Vec<(u64, SharedLive)>,
}

impl Roster {
    fn lock(&self) -> std::sync::MutexGuard<'_, RosterInner> {
        self.inner.lock().unwrap_or_else(|e| e.into_inner())
    }
    fn add(&self, l: &SharedLive) -> u64 {
        let mut g = self.lock();
        g.next += 1;
        let id = g.next;
        g.live.push((id, Arc::clone(l)));
        id
    }
    fn remove(&self, id: u64) {
        let mut g = self.lock();
        g.live.retain(|(i, _)| *i != id);
        if g.live.is_empty() {
            self.idle.notify_all();
        }
    }
    /// 모두에 회수를 건다(SIGTERM → 유예 뒤 SIGKILL). 건 수를 돌려준다.
    fn shutdown_all(&self) -> usize {
        let lives: Vec<SharedLive> = self
            .lock()
            .live
            .iter()
            .map(|(_, l)| Arc::clone(l))
            .collect();
        for l in &lives {
            let acts = lock(l).life.shutdown();
            apply(l, acts);
        }
        lives.len()
    }
    /// 끝 처리까지 마친 턴이 0 이 되기를 `limit` 까지 기다린다. 남은 수를 돌려준다.
    fn wait_idle_for(&self, limit: Duration) -> usize {
        let deadline = std::time::Instant::now() + limit;
        let mut g = self.lock();
        while !g.live.is_empty() {
            let now = std::time::Instant::now();
            if now >= deadline {
                break;
            }
            g = self
                .idle
                .wait_timeout(g, deadline - now)
                .unwrap_or_else(|e| e.into_inner())
                .0;
        }
        g.live.len()
    }
}

fn lock(l: &SharedLive) -> std::sync::MutexGuard<'_, Live> {
    l.lock().unwrap_or_else(|e| e.into_inner())
}

/// 상태 기계가 돌려준 일을 한다. 잠금 밖에서 부른다.
fn apply(live: &SharedLive, acts: Vec<Act>) {
    for act in acts {
        match act {
            Act::StartOrphan => {
                let generation = {
                    let mut g = lock(live);
                    g.orphan_gen += 1;
                    g.orphan_gen
                };
                let l = Arc::clone(live);
                let _ = std::thread::Builder::new()
                    .name("interactive-orphan".into())
                    .spawn(move || {
                        std::thread::sleep(ORPHAN_GRACE);
                        let acts = {
                            let mut g = lock(&l);
                            if g.orphan_gen != generation {
                                return;
                            }
                            g.life.orphan_fired()
                        };
                        apply(&l, acts);
                    });
            }
            Act::CancelOrphan => {
                lock(live).orphan_gen += 1;
            }
            Act::Terminate => {
                if let Some(c) = lock(live).controls.clone() {
                    c.kill(false);
                }
                let l = Arc::clone(live);
                let _ = std::thread::Builder::new()
                    .name("interactive-kill".into())
                    .spawn(move || {
                        std::thread::sleep(KILL_GRACE);
                        let acts = lock(&l).life.kill_grace_fired();
                        apply(&l, acts);
                    });
            }
            Act::Kill => {
                if let Some(c) = lock(live).controls.clone() {
                    c.kill(true);
                }
            }
        }
    }
}

/// PTY 콜백 — 입력 통로를 세션에 잇고, 출력을 세션에 밀고, spawn 을 알린다.
struct Sink {
    session: Arc<SessionHandle>,
    live: SharedLive,
    spawned_tx: Option<mpsc::Sender<()>>,
}

impl PromptHooks for Sink {}

impl PtyTurnSink for Sink {
    fn on_spawn(&mut self, controls: PtyControls) {
        self.session.bind_input(Arc::new(controls.clone()));
        let acts = {
            let mut g = lock(&self.live);
            g.controls = Some(controls);
            g.life.spawned()
        };
        apply(&self.live, acts);
        if let Some(tx) = self.spawned_tx.take() {
            let _ = tx.send(());
        }
    }
    fn on_output(&mut self, frame: &[u8]) {
        self.session.push(frame);
    }
}

/// 사람이 대화했는가 — 세션 파일이 생겼으면 다음 턴은 resume 으로 조립된다(스파이크 §2). 판정할 길이 없는 하네스는
/// 「안 생김」으로 둔다: 같은 id 로 첫 턴을 다시 시도하는 쪽이다.
fn session_materialized(
    harness: AgentHarness,
    session_id: &str,
    claude_dir: Option<&Path>,
) -> bool {
    match (harness, claude_dir) {
        (AgentHarness::ClaudeCode, Some(dir)) => {
            crate::account_assign::shared::claude_session_file_exists(session_id, dir)
        }
        _ => false,
    }
}

impl<L: AgentLink + Send + Sync + 'static> RunnerMaker<L> {
    /// 새 터미널 턴을 띄운다(정본 `spawn`). 이미 도는 턴이 있으면 거기 붙는다(`created: false`).
    pub fn interactive_open(
        self: &Arc<Self>,
        control: &SharedControl,
        req: &InteractiveOpenRequest,
    ) -> Result<(String, bool), String> {
        let relay = self
            .relay
            .clone()
            .ok_or_else(|| crate::interactive_open::RUNNER_STARTING.to_string())?;
        let c = &self.cfg;
        let key = crate::mention_ledger::thread_key(&req.channel_id, Some(&req.thread_root_id));

        // 정의는 매번 새로 읽는다(하네스·모델이 UI 에서 바뀐다).
        let def = self
            .clients
            .rest()
            .definition()
            .map_err(|e| format!("에이전트 정의를 읽지 못했다: {}", e.message))?;
        let harness = def
            .get("harness")
            .and_then(Value::as_str)
            .and_then(AgentHarness::parse)
            .ok_or_else(|| "에이전트 정의의 하네스를 쓸 수 없다".to_string())?;
        let new_session_id = || -> Result<Option<String>, String> {
            Ok(preassigns_session_id(harness)
                .map_err(|_| "이 하네스는 터미널 열기를 지원하지 않는다".to_string())?
                .then(crate::link::random_uuid))
        };
        let rec = match self.store.get(&key) {
            // 하네스가 바뀌었으면 세션 기억만 버리고 작업 폴더는 재사용한다(멘션 턴과 같은 판단).
            Some(r) if r.harness != harness => SessionRecord {
                workspace_dir: r.workspace_dir,
                session_id: new_session_id()?,
                harness,
                last_fed_seq: 0,
                turns_run: 0,
                claude_account: None,
                claude_pool: None,
                unseen_own_after_seq: None,
                canceled_by: None,
            },
            Some(r) => r,
            None => {
                let ws = crate::workspace::resolve_workspace_dir(
                    &c.workspace_base_dir,
                    &c.me_id,
                    &key,
                    def.get("workingDir").and_then(Value::as_str),
                    &crate::workspace::exec_command,
                )
                .map_err(|_| "작업 폴더를 짓지 못했다".to_string())?;
                SessionRecord {
                    workspace_dir: ws.to_string_lossy().into_owned(),
                    session_id: new_session_id()?,
                    harness,
                    last_fed_seq: 0,
                    turns_run: 0,
                    claude_account: None,
                    claude_pool: None,
                    unseen_own_after_seq: None,
                    canceled_by: None,
                }
            }
        };
        let is_first_turn = rec.turns_run == 0 || rec.session_id.is_none();

        // 이 세션을 만든 계정을 따른다. 기록 계정이 지금 lane 에 없으면 lane 첫 계정(옛 동작).
        let lane = match self.accounts.as_ref() {
            Some(hub) => hub.lane_for(&key, None),
            None => crate::account_lane::fallback_lane(&c.runner_env, &c.state_dir),
        };
        let followed = rec
            .claude_account
            .as_ref()
            .and_then(|name| lane.iter().flatten().find(|a| &a.name == name).cloned());
        let account = followed.or_else(|| lane.first().cloned().flatten());
        let claude_dir: Option<PathBuf> = account.as_ref().map(|a| a.config_dir.clone());
        let mut rec = rec;
        if rec.claude_account.is_none() {
            rec.claude_account = account.as_ref().map(|a| a.name.clone());
            rec.claude_pool = Some(account.as_ref().and_then(|a| a.pool.clone()));
        }

        // 사람이 연 터미널 턴도 스레드 지정 모델을 따른다(결정 7).
        let rest = self.clients.rest();
        let turn_model = crate::thread_model::resolve_turn_model(
            Some(|r: &str| rest.thread_model(r)),
            def.get("model").and_then(Value::as_str),
            def.get("effort").and_then(Value::as_str),
            crate::thread_model::root_from_thread_key(&key),
            &mut |l| eprintln!("[interactive] {l}"),
        );
        let perm = def
            .get("mentionPermission")
            .and_then(Value::as_str)
            .and_then(|s| match s {
                "readonly" => Some(MentionPermission::Readonly),
                "auto" => Some(MentionPermission::Auto),
                _ => None,
            })
            .unwrap_or(MentionPermission::Auto);
        let codex_home = c.codex.as_ref().map(|x| x.home.clone());
        let opencode_home = c.opencode.as_ref().map(|x| x.home.clone());
        let pi_home = c.pi.as_ref().map(|x| x.home.clone());
        let plan = {
            let mut o =
                TurnCommandOptions::new(harness, TurnMode::Interactive, perm, &c.operator_bin);
            o.mcp_config_path = &self.mcp_config;
            o.session_id = rec.session_id.as_deref();
            o.is_first_turn = is_first_turn;
            o.model = turn_model.model.as_deref();
            o.effort = turn_model.effort.as_deref();
            o.claude_config_dir = claude_dir.as_deref();
            o.codex_home = codex_home.as_deref();
            o.opencode_home = opencode_home.as_deref();
            o.pi_home = pi_home.as_deref();
            o.chrome = chrome_turn_for(
                def.get("chromeEnabled").and_then(Value::as_bool),
                Some(perm),
                Some(c.chrome_host),
            );
            build_turn_command(&o, &c.parent_env, &c.home)
                .map_err(|e| format!("터미널 명령을 짓지 못했다: {e:?}"))?
                .into_pty_plan()
        };
        let accepts_input = crate::pty::accepts_pty_input(plan.stdin_file.as_deref());

        // 계정 칩 — 풀 표면이 있는 하네스에만, 이름 없이 순번만(계정 칩 A, #1039). 기록 계정을 따르면 그 계정의 풀로 센다.
        let ranks = if crate::adapter::has_account_pool(harness).unwrap_or(false) {
            let snap = self
                .accounts
                .as_ref()
                .map(|h| h.snapshot())
                .unwrap_or_default();
            crate::turn_attempt_account::account_ranks(&snap, account.as_ref())
        } else {
            (None, None)
        };

        // 한 잠금으로 재검사·세션 열기·등록. 멘션 턴이 막 시작되는 중이면 등록될 때까지 기다렸다 다시 본다.
        let live: SharedLive = Arc::new(Mutex::new(Live {
            life: InteractiveLife::new(),
            controls: None,
            orphan_gen: 0,
        }));
        let mut session: Option<SessionHandle> = None;
        let deadline = std::time::Instant::now() + MENTION_START_WAIT;
        let _registered = loop {
            let running = relay.mention_session_of(&req.channel_id, &req.thread_root_id);
            let (lv, lc) = (Arc::clone(&live), Arc::clone(&live));
            let got =
                interactive_turn::claim(control, &key, &req.opened_by_handle, running, || {
                    let h = relay.open_session(OpenSessionInput {
                        agent_account_id: c.me_id.clone(),
                        channel_id: req.channel_id.clone(),
                        thread_root_id: Some(req.thread_root_id.clone()),
                        harness: harness.as_str().to_string(),
                        mode: Some("interactive".into()),
                        accepts_input,
                        claude_account_rank: ranks.0,
                        claude_pool_rank: ranks.1,
                        on_viewer_count: Some(Arc::new(move |n| {
                            let acts = lock(&lv).life.viewer_count(n);
                            apply(&lv, acts);
                        })),
                        on_cancel: Some(Arc::new(move |by: &str| {
                            eprintln!("[interactive] 사람이 조종을 끝냈다 — PTY 를 회수한다");
                            let acts = lock(&lc).life.cancel(by);
                            apply(&lc, acts);
                        })),
                    });
                    let id = h.session_id().to_string();
                    session = Some(h);
                    id
                });
            match got {
                Claim::MentionStarting if std::time::Instant::now() < deadline => {
                    std::thread::sleep(MENTION_START_POLL);
                }
                Claim::MentionStarting => return Err(MENTION_STARTING_REJECTION.to_string()),
                Claim::NoRelay => return Err(NO_RELAY_REJECTION.to_string()),
                Claim::Attach(id) => return Ok((id, false)),
                Claim::Registered(id) => break id,
            }
        };
        let session = Arc::new(session.expect("등록했으면 세션을 열었다"));
        let roster_id = self.interactive.add(&live);

        // 관문 — 신뢰·bypass(사람이 매번 경고 화면에 답하지 않게). codex 대화형은 규칙 파일을 쓰지 않는다 — 남은 것을 지운다.
        crate::workspace_trust::prepare_harness_gates(
            harness,
            &rec.workspace_dir,
            claude_dir.as_deref(),
            codex_home.as_deref(),
            &c.home,
        );
        if harness == AgentHarness::Codex
            && let Some(h) = codex_home.as_deref()
            && crate::codex_rules::sweep_codex_rules(h).is_err()
        {
            let me = Arc::clone(self);
            me.finish(
                control,
                &key,
                req,
                &rec,
                None,
                claude_dir.as_deref(),
                &session,
            );
            self.interactive.remove(roster_id);
            return Err("codex 규칙 파일을 지우지 못해 띄우지 않는다".to_string());
        }

        let (tx, rx) = mpsc::channel::<()>();
        let (done_tx, done_rx) = mpsc::channel::<String>();
        let me = Arc::clone(self);
        let (control2, key2, req2) = (Arc::clone(control), key.clone(), req.clone());
        let mut opts = PtyTurnOptions::at(PathBuf::from(&rec.workspace_dir));
        opts.timeout_ms = 0; // 사람이 앉아 있는 턴에는 시계가 없다.
        if let Some(cols) = req.cols {
            opts.cols = cols;
        }
        if let Some(rows) = req.rows {
            opts.rows = rows;
        }
        opts.record_dir = c.pty_record_dir.clone();
        let started_ms = super::now_i64();
        let spawn_session = Arc::clone(&session);
        let (rec_for_fail, claude_dir_for_fail) = (rec.clone(), claude_dir.clone());
        let spawned = std::thread::Builder::new()
            .name("interactive-turn".into())
            .spawn(move || {
                let mut sink = Sink {
                    session: Arc::clone(&spawn_session),
                    live: Arc::clone(&live),
                    spawned_tx: Some(tx),
                };
                let result = run_pty_turn(&plan, opts, &mut sink);
                drop(sink);
                let acts = lock(&live).life.exit();
                apply(&live, acts);
                match &result {
                    Ok(r) => {
                        eprintln!(
                            "[interactive] 인터랙티브 턴 종료 (exitCode={})",
                            r.exit_code
                        );
                        let _ = done_tx.send(format!(
                            "인터랙티브 턴이 뜨자마자 끝났다 (exitCode={}) — 러너 로그를 확인해라",
                            r.exit_code
                        ));
                    }
                    Err(e) => {
                        eprintln!("[interactive] 인터랙티브 턴 실패 — {e}");
                        let _ = done_tx.send(e.to_string());
                    }
                }
                let cd = claude_dir.clone();
                me.finish(
                    &control2,
                    &key2,
                    &req2,
                    &rec,
                    Some(started_ms),
                    cd.as_deref(),
                    &spawn_session,
                );
                me.interactive.remove(roster_id);
            });
        if spawned.is_err() {
            self.finish(
                control,
                &key,
                req,
                &rec_for_fail,
                None,
                claude_dir_for_fail.as_deref(),
                &session,
            );
            self.interactive.remove(roster_id);
            return Err("터미널 턴 스레드를 띄우지 못했다".to_string());
        }

        // spawn 이 확인되면 곧장 돌려준다. 뜨기 전에 끝나면 그 까닭이 열기 실패다.
        match rx.recv() {
            Ok(()) => Ok((session.session_id().to_string(), true)),
            Err(_) => Err(done_rx
                .recv()
                .unwrap_or_else(|_| "인터랙티브 턴이 뜨지 못했다".to_string())),
        }
    }

    /// 러너가 물러난다 — 도는 새 터미널 턴을 모두 회수하고(SIGTERM → 5초 뒤 SIGKILL) 끝 처리까지 `limit` 만큼 기다린다.
    /// 건 수와 남은 수를 돌려준다. 링크를 닫기 **전에** 불러야 끝 처리가 스레드를 읽고 기록을 저장한다.
    pub fn shutdown_interactive(&self, limit: Duration) -> (usize, usize) {
        let n = self.interactive.shutdown_all();
        if n == 0 {
            return (0, 0);
        }
        (n, self.interactive.wait_idle_for(limit))
    }

    /// 턴의 끝 — 세션 기록 저장·장부 해제·세션 닫기(정본 `finish`). 저장 실패는 다음 멘션이 같은 구간을 다시 먹는 쪽으로 기운다.
    #[allow(clippy::too_many_arguments)]
    fn finish(
        &self,
        control: &SharedControl,
        key: &str,
        req: &InteractiveOpenRequest,
        rec: &SessionRecord,
        started_ms: Option<i64>,
        claude_dir: Option<&Path>,
        session: &SessionHandle,
    ) {
        let mut session_id = rec.session_id.clone();
        let mut turns_run = rec.turns_run;
        if let Some(since) = started_ms {
            let discovers =
                crate::adapter::discovers_session_id_after_turn(rec.harness).unwrap_or(false);
            if discovers
                && session_id.is_none()
                && let Some(cx) = self.cfg.codex.as_ref()
            {
                session_id = crate::harness_records::find_codex_session_id(
                    &crate::codex_home::codex_sessions_dir(&cx.home),
                    Path::new(&rec.workspace_dir),
                    since,
                );
            }
            if turns_run == 0
                && let Some(id) = session_id.as_deref()
                && session_materialized(rec.harness, id, claude_dir)
            {
                turns_run = 1;
            }
        }
        let max_seq = self
            .clients
            .mcp()
            .read_thread(
                &req.channel_id,
                Some(&req.thread_root_id),
                i64::try_from(rec.last_fed_seq).ok(),
                READ_LIMIT,
            )
            .map(|msgs| {
                msgs.iter()
                    .filter_map(|m| m.get("seq").and_then(Value::as_u64))
                    .fold(rec.last_fed_seq, u64::max)
            });
        let store = Arc::clone(&self.store);
        interactive_turn::settle(control, key, |min_pending| {
            let Ok(max_seq) = max_seq else {
                eprintln!("[interactive] 스레드를 읽지 못해 lastFedSeq 를 당기지 않는다");
                let _ = store.put(
                    key,
                    SessionRecord {
                        session_id: session_id.clone(),
                        turns_run,
                        ..rec.clone()
                    },
                );
                return;
            };
            let last =
                interactive_turn::advance_last_fed_seq(rec.last_fed_seq, max_seq, min_pending);
            if let Err(e) = store.put(
                key,
                SessionRecord {
                    session_id: session_id.clone(),
                    turns_run,
                    last_fed_seq: last,
                    ..rec.clone()
                },
            ) {
                eprintln!("[interactive] 세션 기록을 저장하지 못했다: {}", e.kind());
            }
        });
        session.close();
    }
}

#[cfg(test)]
mod roster_tests {
    use super::*;

    fn fresh() -> SharedLive {
        Arc::new(Mutex::new(Live {
            life: InteractiveLife::new(),
            controls: None,
            orphan_gen: 0,
        }))
    }

    #[test]
    fn empty_roster_has_nothing_to_reclaim() {
        let r = Roster::default();
        assert_eq!(r.shutdown_all(), 0);
        assert_eq!(r.wait_idle_for(Duration::from_millis(10)), 0);
    }

    #[test]
    fn shutdown_reaches_every_live_turn_and_waits_for_finish() {
        let r = Arc::new(Roster::default());
        let (a, b) = (fresh(), fresh());
        let ia = r.add(&a);
        let ib = r.add(&b);
        assert_eq!(r.shutdown_all(), 2);
        // 뜨기 전에 물러남을 받은 턴은 spawn 순간 회수된다 — 상태 기계가 그 표지를 쥐고 있다.
        for l in [&a, &b] {
            assert!(!lock(l).life.spawned().is_empty());
        }
        let r2 = Arc::clone(&r);
        let t = std::thread::spawn(move || {
            std::thread::sleep(Duration::from_millis(20));
            r2.remove(ia);
            r2.remove(ib);
        });
        assert_eq!(r.wait_idle_for(Duration::from_secs(5)), 0);
        t.join().unwrap();
    }

    #[test]
    fn wait_gives_up_after_limit_and_reports_left() {
        let r = Roster::default();
        let a = fresh();
        r.add(&a);
        assert_eq!(r.wait_idle_for(Duration::from_millis(20)), 1);
    }
}
