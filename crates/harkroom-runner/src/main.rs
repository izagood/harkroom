//! `harkroom-runner-rs` — Rust 러너 기동(L3d-3b-2). 설정을 읽고 오퍼레이터 링크에 붙은 뒤 인박스 폴 루프를 돈다.
//!
//! **기본 러너는 node 다.** 이 실행 파일은 오퍼레이터가 에이전트별로 `runner: "rust"` 를 준 에이전트에만 띄운다(B4-5 스위치,
//! C6 뒤). 이 파일이 들어와도 그 스위치가 켜지기 전에는 아무 에이전트도 이것으로 돌지 않는다.
//!
//! 물러나기 차례: 시그널·원격 종료 요청 → 폴 멈춤(`PollLoop::stop`) → 인박스 놓음 알림 → drain(턴 시한 + 5분까지만) →
//! 도는 턴에 물러남 표지(SIGTERM) → 10초 유예 → 남은 PTY 그룹에 SIGKILL → 남은 임대 장부 놓기(박동 멈춤·기록 가리기·끝 알림) → 링크 닫기.

use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use harkroom_runner::call_maker::{Names, RunnerMaker, RunnerSink};
use harkroom_runner::config::{load_config, process_env, turn_secrets_dir};
use harkroom_runner::link::{LinkClient, LinkOptions};
use harkroom_runner::mention_admit_deps::{MentionLauncher, ThreadLauncher};
use harkroom_runner::mention_body::{BodyShared, body_fn};
use harkroom_runner::mention_clients::AgentClients;
use harkroom_runner::mention_hooks::{LeaseBook, LeaseHandoff};
use harkroom_runner::mention_ledger::Ledger;
use harkroom_runner::mention_sched::ChannelScheduler;
use harkroom_runner::poll_admit::link_admit_fn;
use harkroom_runner::poll_loop::{AdmitOutcome, BatchContext, LoopHooks, Me, PollLoop, Scheduler};
use harkroom_runner::poll_sched::{RunnerScheduler, Running, spawn_event_pump};
use harkroom_runner::rest::HarkroomError;
use harkroom_runner::runner_boot::{BootFacts, agent_state_dir, maker_config, state_dir_names};
use harkroom_runner::runner_wire::{BundlePoll, ExitPlan, LinkEvents, runner_exit_plan};
use harkroom_runner::thread_claims::ThreadClaims;
use harkroom_runner::turn_attempt_account::MentionSlots;
use serde_json::Value;

/// 물러남 표지 뒤 SIGKILL 전 유예.
const SHUTDOWN_GRACE: Duration = Duration::from_secs(10);

/// 서버에 알리는 러너 판.
const VERSION: &str = env!("CARGO_PKG_VERSION");

type Link = Arc<LinkClient>;

fn now_ms() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0)
}

fn exit_with(plan: ExitPlan) -> ! {
    for l in &plan.lines {
        eprintln!("{l}");
    }
    std::process::exit(plan.code);
}

/// 시그널 표지 — 처리기는 표지만 세우고, 지키는 스레드가 폴 루프를 멈춘다(처리기 안에서 잠금을 잡지 않는다).
static STOP_SIGNAL: AtomicBool = AtomicBool::new(false);

extern "C" fn on_signal(_sig: libc::c_int) {
    STOP_SIGNAL.store(true, Ordering::SeqCst);
}

/// 배치마다 짓개의 이름 표를 고치고 받아들인다(이름 바뀜·채널 이름·계정 handle).
struct NamingScheduler {
    inner: RunnerScheduler,
    maker: Arc<RunnerMaker<Link>>,
    poll: Arc<PollLoop>,
}

impl Scheduler for NamingScheduler {
    fn admit(&self, batch: &Value, ctx: &BatchContext) -> Result<AdmitOutcome, HarkroomError> {
        self.maker.set_names(Names {
            channel_names: ctx.channel_names.clone(),
            handles: ctx.handles.clone(),
            me_handle: self.poll.me().handle,
            agent_ids: Some(ctx.agent_ids.clone()),
        });
        self.inner.admit(batch, ctx)
    }
    fn holding_entries(&self) -> Vec<i64> {
        self.inner.holding_entries()
    }
    fn done_entries(&self) -> Vec<i64> {
        self.inner.done_entries()
    }
    fn drain(&self) {
        self.inner.drain();
    }
}

fn main() {
    let env = process_env();
    let config = match load_config(&env) {
        Ok(c) => c,
        Err(e) => {
            eprintln!("{e}");
            std::process::exit(1);
        }
    };
    let started_at_ms = now_ms();
    let provider_lane = env.get("HARKROOM_PROVIDER_LANE").map(String::as_str) == Some("1");
    let mut opts = LinkOptions::new(config.operator_link.clone());
    opts.provider_lane = Some(provider_lane);
    // 지난 러너가 남긴 lane 턴 파일을 기동 때 걷는다(정본 `main.ts` 655 `sweepLaneTurnDir`).
    harkroom_runner::provider_lane::sweep_lane_turn_dir(std::path::Path::new(&config.state_dir));
    // 옛 lane 대체 길이 남긴 `lane-mcp.json`(그때의 러너 링크 secret)을 지운다(정본 `sweepLaneMcpConfig`, L3c-3c).
    harkroom_runner::provider_lane::sweep_lane_mcp_config(std::path::Path::new(&config.state_dir));
    let link: Link = LinkClient::new(opts);
    link.start();
    if !link.when_connected(Duration::from_secs(10)) {
        eprintln!("오퍼레이터 링크가 10초 안에 붙지 않았다 — 계속 재시도한다");
    }

    let clients = Arc::new(AgentClients::new(Arc::clone(&link), VERSION));
    let (me_id, me_handle) = match clients.mcp().me() {
        Ok(v) => v,
        Err(e) => {
            if let Some(p) = runner_exit_plan(&e) {
                exit_with(p);
            }
            eprintln!("내 계정을 읽지 못했다(상태 {:?}) — 물러난다", e.status);
            std::process::exit(1);
        }
    };
    // 하네스는 멘션마다 그 멘션이 읽은 정의에서 정한다(`call_maker::harness_of`) — 기동 때 가정하지 않는다.

    // 에이전트별 상태·작업 폴더 뿌리(정본 `resolveAgentStateDir`) — 작업 폴더 뿌리를 에이전트끼리 나누지 않는다.
    let base = PathBuf::from(&config.state_dir);
    let agent_state = agent_state_dir(
        &base,
        &me_id,
        config.agent_instance.as_deref(),
        &state_dir_names(&base),
    );
    // 지난 프로세스가 비정상 종료해 남긴 스레드별 지시문 파일을 쓸어 낸다(정상 종료면 멘션 끝에 지워져 없다).
    let swept = harkroom_runner::turn_files::sweep_system_prompt_files(&agent_state);
    if swept > 0 {
        eprintln!("[main] 지난 실행이 남긴 지시문 파일 {swept}개를 지웠다");
    }
    // 스레드 임대 holder — 이 러너 프로세스 하나(같은 에이전트 러너 둘을 가른다).
    let claim_holder = format!(
        "{}-{}-{started_at_ms}",
        config.operator_link.runner_id,
        std::process::id()
    );
    let home = PathBuf::from(env.get("HOME").cloned().unwrap_or_default());
    let maker_cfg = maker_config(
        &config,
        &env,
        BootFacts {
            me_id: &me_id,
            claim_holder: &claim_holder,
            agent_state,
            home,
        },
    );
    let report_link = Arc::clone(&link);
    let lane_source = harkroom_runner::account_lane::LaneSource::from_env(
        &maker_cfg.runner_env,
        &maker_cfg.home,
        &me_id,
    );
    let mut maker = RunnerMaker::new(
        maker_cfg,
        Arc::clone(&clients),
        Box::new(move |servers: &[String], at: i64| {
            report_link.notify_mcp_auth_rejected(servers, at)
        }),
    );
    // claude 계정 축(L3c-3b·3d, 정본 `loadLane`). API 키 lane 러너는 계정 풀을 쓰지 않고 lane 전용 폴더 하나로 돈다 —
    // 기본 로그인 축으로 하네스를 띄우는 길이 없다. 풀 해석이 실패하면(예: 없는 강제 풀) 정본처럼 뜨지 않는다.
    let source = if provider_lane {
        match harkroom_runner::account_lane::LaneSource::provider_lane(&maker.config().state_dir) {
            Ok(s) => s,
            Err(e) => {
                eprintln!(
                    "lane 전용 계정 폴더를 만들지 못했다 — 뜨지 않는다: {}",
                    e.kind()
                );
                std::process::exit(1);
            }
        }
    } else {
        lane_source
    };
    // API 키 연결(정본 `main.ts` 645 `createProviderLane`, L3c-3d2) — lane 러너만. 턴마다 오퍼레이터에 그 턴 키를
    // 마운트하고(REST `PROVIDER_LANE_MOUNT_PATH`) 하네스 env 에만 넣는다. codex lane 홈은 lane 전용 자리(정본
    // `providerLaneCodexDir`) — 거기 로그인(auth.json)이 있으면 띄우지 않는다.
    if provider_lane {
        let (mount_clients, result_link) = (Arc::clone(&clients), Arc::clone(&link));
        let state_dir = maker.config().state_dir.clone();
        let mut deps =
            harkroom_runner::provider_lane::ProviderLaneDeps::new(Box::new(move |cause: &str| {
                mount_clients.rest().mount_provider_lane(cause)
            }));
        deps.turn_secrets_dir = turn_secrets_dir(&env);
        deps.report = Some(Box::new(move |ok, code| {
            result_link.notify_provider_lane_result(ok, code)
        }));
        deps.codex_home = Some(state_dir.join("codex-provider-lane"));
        deps.claude_dir =
            Some(harkroom_runner::account_lane::provider_lane_account(&state_dir).config_dir);
        deps.state_dir = Some(state_dir);
        maker.set_provider_lane(harkroom_runner::provider_lane::ProviderLane::new(deps));
    }
    // codex 격리 홈(c1, 정본 `main.ts` 361) — lane 러너는 lane 전용 자리, 아니면 `<state>/codex-home` 에 활성 계정 로그인 링크.
    // 이 홈이 없으면 codex 턴은 띄우지 않는다(`codex_home_missing`) — 사람 `~/.codex` 로 돌지 않게.
    {
        use std::os::unix::fs::DirBuilderExt as _;
        let state_dir = maker.config().state_dir.clone();
        let codex = if provider_lane {
            let home = state_dir.join("codex-provider-lane");
            if let Err(e) = std::fs::DirBuilder::new()
                .recursive(true)
                .mode(0o700)
                .create(&home)
            {
                eprintln!("codex lane 홈을 만들지 못했다 — 뜨지 않는다: {}", e.kind());
                std::process::exit(1);
            }
            harkroom_runner::codex_prep::CodexPrep {
                home,
                sync_auth: false,
                env: env.clone(),
            }
        } else {
            let home = state_dir.join("codex-home");
            if let Err(e) = harkroom_runner::codex_home::sync_codex_auth(&home, &env) {
                eprintln!("codex 격리 홈을 맞추지 못했다 — 뜨지 않는다: {e}");
                std::process::exit(1);
            }
            harkroom_runner::codex_prep::CodexPrep {
                home,
                sync_auth: true,
                env: env.clone(),
            }
        };
        maker.set_codex(codex);
    }
    match harkroom_runner::account_lane::AccountLaneHub::start(
        source,
        maker.store(),
        Arc::new(|l: &str| eprintln!("{l}")),
    ) {
        Ok(hub) => {
            let s = hub.snapshot();
            let n = s.lane.iter().flatten().count();
            eprintln!(
                "claude 계정 {n}개 (풀: {})",
                s.pool.as_deref().unwrap_or("기본(뿌리)")
            );
            maker.set_accounts(hub);
        }
        Err(e) => {
            eprintln!("claude 계정 축을 정하지 못했다 — 뜨지 않는다: {e}");
            std::process::exit(1);
        }
    }
    let maker = Arc::new(maker);

    let ledger = Arc::new(Mutex::new(Ledger::new(&[], now_ms())));
    let slots = MentionSlots::default();
    // 턴 비밀 뿌리는 오퍼레이터가 준 값 그대로(없으면 임대 값 가리기만 건너뛴다).
    let book = Arc::new(LeaseBook::with_life(
        clients.lease_life(turn_secrets_dir(&env)),
    ));
    let (tx, rx) = std::sync::mpsc::channel();
    let body = Arc::new(BodyShared {
        ledger: Arc::clone(&ledger),
        slots: slots.clone(),
        book: Arc::clone(&book),
        clients: maker.clients(),
        sched: ChannelScheduler(tx),
        maker: Arc::clone(&maker),
    });
    let launcher: Box<dyn MentionLauncher + Send> = Box::new(ThreadLauncher::new(
        slots.clone(),
        body_fn::<_, RunnerSink, _>(Arc::clone(&body)),
    ));
    let claims = Arc::new(ThreadClaims::new(
        Arc::clone(&clients),
        claim_holder.clone(),
    ));
    let running = Arc::new(Running::default());
    let shutdown_slots = slots.clone();
    let admit = link_admit_fn(Arc::clone(&clients), Arc::clone(&claims), slots, now_ms);
    let drain_limit = Duration::from_millis(config.turn_timeout_ms) + Duration::from_secs(5 * 60);
    let poll = Arc::new(PollLoop::new(
        Me {
            id: me_id.clone(),
            handle: me_handle,
        },
        started_at_ms as i64,
    ));
    let sched = NamingScheduler {
        inner: RunnerScheduler::new(ledger, admit, launcher, Arc::clone(&running))
            .with_drain_limit(drain_limit),
        maker: Arc::clone(&maker),
        poll: Arc::clone(&poll),
    };

    let (stop_poll, lane_link) = (Arc::clone(&poll), Arc::clone(&link));
    let on_lane_turn: Option<Box<dyn Fn(bool) + Send + Sync>> = if provider_lane {
        Some(Box::new(move |ok| lane_link.notify_provider_lane_turn(ok)))
    } else {
        None
    };
    let events = Arc::new(LinkEvents::new(
        Arc::clone(&clients),
        Box::new(move |at: &str| {
            stop_poll.consider_stop_request(Some(at));
        }),
        Box::new(|p: ExitPlan| exit_with(p)),
        on_lane_turn,
    ));
    if let Err(e) = spawn_event_pump(rx, events, Arc::clone(&running)) {
        eprintln!("스케줄러 사건 받는 쪽을 띄우지 못했다: {e}");
        std::process::exit(1);
    }

    // SIGTERM·SIGINT → 폴 멈춤(도는 턴은 끝까지).
    // SAFETY: 처리기는 원자 표지 하나만 세운다(비동기 시그널 안전).
    unsafe {
        libc::signal(libc::SIGTERM, on_signal as *const () as libc::sighandler_t);
        libc::signal(libc::SIGINT, on_signal as *const () as libc::sighandler_t);
    }
    let watch_poll = Arc::clone(&poll);
    let _ = std::thread::Builder::new()
        .name("signal-watch".into())
        .spawn(move || {
            while !STOP_SIGNAL.load(Ordering::SeqCst) {
                std::thread::sleep(Duration::from_millis(200));
            }
            eprintln!("[main] 종료 시그널 — 폴을 멈추고 도는 턴을 마친 뒤 물러난다");
            watch_poll.stop();
        });

    println!(
        "harkroom-runner-rs: 오퍼레이터 {} (runner {}) — 인박스 폴을 시작한다",
        config.operator_link.socket_path, config.operator_link.runner_id
    );
    let src = BundlePoll::new(
        Arc::clone(&clients),
        config.poll_timeout_ms,
        config
            .inbox_lease
            .then(|| config.operator_link.runner_id.clone()),
    );
    let stopped_link = Arc::clone(&link);
    let note_maker = Arc::clone(&maker);
    let note_rev = move |rev: Option<&str>| note_maker.note_memory_rev(rev);
    let exit_if = |e: &HarkroomError| {
        if let Some(p) = runner_exit_plan(e) {
            exit_with(p);
        }
    };
    let poll_stopped =
        move |holding: &[i64], done: &[i64]| stopped_link.notify_poll_stopped(holding, done);
    // 폴 멈춤 → 인박스 놓음 알림 → drain(시한) 은 `PollLoop::run` 안의 차례다.
    poll.run(
        &src,
        &sched,
        &LoopHooks {
            note_memory_rev: &note_rev,
            exit_if_unrecoverable: &exit_if,
            notify_poll_stopped: &poll_stopped,
        },
    );
    // drain 시한이 지나도 도는 턴이 있으면(P2): 물러남 표지 → 감시 루프가 SIGTERM → 10초 유예 → 남은 PTY 그룹에 SIGKILL.
    // 기록 가리기(아래 임대 놓기)는 SIGKILL **뒤**다 — 하네스가 죽은 뒤에 가려야 덮어쓰기에 지지 않는다.
    if shutdown_slots.stop_all() > 0 {
        let left = running.wait_idle_for(SHUTDOWN_GRACE);
        if left > 0 {
            let killed = shutdown_slots.kill_all();
            eprintln!(
                "[shutdown] 유예가 지나도 턴 {left}개가 돈다 — PTY 그룹 {killed}개에 SIGKILL"
            );
            let _ = running.wait_idle_for(Duration::from_secs(2));
        }
    }
    // drain 시한이 지나도 남은 임대를 놓는다(박동 멈춤 → 기록 가리기 → 끝 알림). 그 뒤 링크를 닫는다.
    for cause in book.causes() {
        if book.release(&cause) {
            LeaseHandoff::lease_ended(&*link, &cause);
        }
    }
    link.stop();
    println!("종료");
}
