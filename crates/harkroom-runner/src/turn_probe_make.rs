//! 감시 루프 짓개 실물 — [`probe_make`] 가 [`MakeLoop`] 을 돌려준다. 돌 때마다 `run_beside` 가 넘긴 **그 시도의** 감시 자리·
//! 감시 목록·시도 문맥([`LoopCtx`])만으로 탐침 IO 를 짓는다(security ②-3c 조건 ①).
//!
//! - 쥐는 것: 멘션 단위로 바뀌지 않는 설정([`ProbeLoopConfig`] — MCP 손님·채널·앵커·하네스·홈·멘션 슬롯)만.
//!   시도마다 바뀌는 값(세션 id·턴 id·턴 시작 시각·시작 seq·**계정 폴더**·**끝 신호**)은 이 값에 없다 — 인자로만 온다.
//! - 감시 자리로 가는 것: 회수 시계([`reclaim_on_watch`]), SIGTERM([`terminate_on_watch`]), PTY 쓰기([`write_on_watch`]),
//!   재촉 IO([`WatchNudgeIo`] 의 자리)는 모두 **받은 `Watch`** 로 짓는다(조건 ②).
//! - 가림 목록: 통지 sink 의 `secrets` 와 탐침의 `secrets` 는 **받은 `NoticeSecrets`** 의 사본이다.
//! - 펜스: 멘션 슬롯의 지금 걸린 시도가 임대를 잃었는가([`LiveSlot::fenced_out`]). 감시 루프는 이것을 감시 자리를 쥐지 않은 채
//!   묻는다 — 잠금 차례 watch → slot 을 거스르는 길이 없다.
//!
//! 아직 없는 것: 화면 끝 감시가 없어(`screen_idle_ended` 가 `None`) 하네스 자체 기록의 차례 끝(`read_recorded_end`)은 불리지
//! 않는다 — `None` 으로 둔다. opencode 조회·codex/opencode 의 마지막 말도 아직 잇지 않는다(claude 기록만).

use std::path::PathBuf;
use std::sync::Arc;
use std::sync::atomic::AtomicBool;

use crate::adapter::{AgentHarness, reads_session_transcript};
use crate::harness_errors::{
    MacPermissionWait, PermissionDenial, TranscriptDirs, read_last_assistant_text,
    session_transcript_mtime_ms,
};
use crate::mcp::HarkroomMcpClient;
use crate::mention_parts::LoopCtx;
use crate::rest::RunnerLink;
use crate::turn_attempt_account::LiveSlot;
use crate::turn_end::{EndConfig, Tail};
use crate::turn_notice::NudgeCaller;
use crate::turn_nudge_io::WatchNudgeIo;
use crate::turn_probe::ProbeState;
use crate::turn_probe_io::{SpokeKey, TurnProbeIo};
use crate::turn_probe_records::{NoticeSecrets, ProbeRecords, RecordProbeState, TranscriptRecords};
use crate::turn_probe_rest::LANE_NUDGE_WAIT_MS;
use crate::turn_probe_rest::{FenceCheck, NudgeTarget, TurnProbeRest};
use crate::turn_probe_sink::McpProbeSink;
use crate::turn_probe_state::{
    OPENCODE_QUIET_MS, TranscriptTurnStateRecords, TurnStateProbe, TurnStateRecords,
};
use crate::turn_report::off_anchor_evidence;
use crate::turn_watch::{Watch, reclaim_on_watch, terminate_on_watch, write_on_watch};
use crate::turn_watch_loop::{LoopParts, MakeLoop};

/// 멘션 단위 설정 — 시도마다 바뀌는 값은 넣지 않는다.
pub struct ProbeLoopConfig<'a, L: RunnerLink> {
    pub client: &'a HarkroomMcpClient<L>,
    pub key: String,
    pub me_id: String,
    pub channel_id: String,
    pub anchor: Option<String>,
    pub harness: AgentHarness,
    pub home: Option<PathBuf>,
    pub omp_home: Option<PathBuf>,
    pub end_cfg: EndConfig,
    /// API 키 연결 턴이고 TUI 하네스다.
    pub lane_tui: bool,
    pub caller: NudgeCaller,
    /// MCP 헤더 거절 서버 이름을 오퍼레이터에(실물 `LinkClient::notify_mcp_auth_rejected`). 두 번째 값은 턴 시작 시각.
    pub report_auth: &'a (dyn Fn(&[String], i64) + Send + Sync),
    /// 이 멘션의 슬롯(펜스).
    pub slot: LiveSlot,
    pub clock: fn() -> i64,
}

/// 그 시도의 세션·시작 시각으로 기록을 읽는 소유본 — 부를 때마다 빌림 읽개([`TranscriptRecords`])를 짓는다.
pub struct AttemptRecords {
    pub harness: AgentHarness,
    pub session_id: Option<String>,
    pub config_dir: Option<PathBuf>,
    pub home: Option<PathBuf>,
    pub omp_home: Option<PathBuf>,
    pub since_ms: i64,
    pub now: fn() -> i64,
}

impl AttemptRecords {
    fn dirs(&self) -> TranscriptDirs<'_> {
        TranscriptDirs {
            config_dir: self.config_dir.as_deref(),
            home: self.home.as_deref(),
        }
    }
    fn view(&self) -> TranscriptRecords<'_> {
        TranscriptRecords {
            harness: self.harness,
            session_id: self.session_id.as_deref(),
            dirs: self.dirs(),
            since_ms: self.since_ms,
            omp_home: self.omp_home.as_deref(),
            now_ms: self.now,
        }
    }
    fn state_view(&self) -> TranscriptTurnStateRecords<'_> {
        TranscriptTurnStateRecords {
            harness: self.harness,
            session_id: self.session_id.as_deref(),
            dirs: self.dirs(),
            opencode: None,
        }
    }
}

impl ProbeRecords for AttemptRecords {
    fn denials(&mut self) -> Vec<PermissionDenial> {
        self.view().denials()
    }
    fn mac_waits(&mut self) -> Vec<MacPermissionWait> {
        self.view().mac_waits()
    }
    fn mcp_auth_rejections(&mut self) -> Vec<String> {
        self.view().mcp_auth_rejections()
    }
    fn recorded_api_error(&mut self) -> Option<String> {
        self.view().recorded_api_error()
    }
    fn api_error(&mut self) -> Option<String> {
        self.view().api_error()
    }
}

impl TurnStateRecords for AttemptRecords {
    fn turn_state(&mut self, since_ms: i64) -> Option<Tail> {
        self.state_view().turn_state(since_ms)
    }
    fn pending_background(&mut self, since_ms: i64) -> Option<u32> {
        self.state_view().pending_background(since_ms)
    }
    fn transcript_mtime_ms(&mut self) -> Option<i64> {
        self.state_view().transcript_mtime_ms()
    }
    fn opencode_turn_state(&mut self, since_ms: i64) -> Option<Tail> {
        self.state_view().opencode_turn_state(since_ms)
    }
}

/// 실물 탐침 IO.
pub type AttemptProbeIo<'a, L> = TurnProbeIo<
    'a,
    AttemptRecords,
    McpProbeSink<'a, L>,
    AttemptRecords,
    TurnProbeRest<WatchNudgeIo<'a>>,
>;

fn records_of<L: RunnerLink>(c: &ProbeLoopConfig<'_, L>, ctx: &LoopCtx) -> AttemptRecords {
    AttemptRecords {
        harness: c.harness,
        session_id: ctx.session_id.clone(),
        config_dir: ctx.claude_config_dir.clone(),
        home: c.home.clone(),
        omp_home: c.omp_home.clone(),
        since_ms: ctx.turn_started_at_ms,
        now: c.clock,
    }
}

/// 짓개 실물. 돌려준 닫개는 받은 `Watch`·`NoticeSecrets`·`LoopCtx` 와 `c`(멘션 설정)만 쓴다.
///
/// 설정은 **값으로** 받아 닫개가 쥔다 — `run_mention` 한 번에 하나를 지어 넘긴다(그 멘션의 슬롯과 함께).
pub fn probe_make<'a, L: RunnerLink + 'a>(
    c: ProbeLoopConfig<'a, L>,
) -> MakeLoop<'a, AttemptProbeIo<'a, L>> {
    Box::new(
        move |watch: &Watch, notice: &NoticeSecrets, ctx: &LoopCtx| {
            let c = &c;
            let client = c.client;
            let report = c.report_auth;
            let (ch, root) = (c.channel_id.clone(), c.anchor.clone());
            let read_thread = Box::new(move || {
                client
                    .read_thread(
                        &ch,
                        root.as_deref(),
                        None,
                        crate::turn_prepare_io::THREAD_PAGE,
                    )
                    .map_err(|e| e.to_string())
            });
            let said_records = records_of(c, ctx);
            let (key, me, ch2, root2, start_seq, turn_id) = (
                c.key.clone(),
                c.me_id.clone(),
                c.channel_id.clone(),
                c.anchor.clone(),
                ctx.turn_start_seq,
                ctx.turn_id.clone(),
            );
            let nudge = WatchNudgeIo::new(
                c.key.clone(),
                c.clock,
                c.lane_tui,
                c.caller,
                watch.clone(),
                Box::new(move || {
                    read_last_assistant_text(
                        said_records.harness,
                        said_records.session_id.as_deref(),
                        said_records.dirs(),
                        Some(said_records.since_ms),
                    )
                }),
                Box::new(move || {
                    let mut io = client;
                    off_anchor_evidence(
                        &mut io,
                        &key,
                        &me,
                        &ch2,
                        root2.as_deref(),
                        start_seq,
                        &turn_id,
                    )
                }),
            );
            let mtime = records_of(c, ctx);
            let rest = TurnProbeRest {
                nudge,
                nudge_target: NudgeTarget {
                    channel_id: c.channel_id.clone(),
                    thread_root_id: c.anchor.clone(),
                },
                nudge_wait_ms: LANE_NUDGE_WAIT_MS,
                on_reclaim: reclaim_on_watch(watch),
                ended: ctx.ended.clone(),
                terminate: terminate_on_watch(watch),
                write_pty: write_on_watch(watch),
                reads_transcript: reads_session_transcript(c.harness),
                transcript_mtime_ms: Box::new(move || {
                    session_transcript_mtime_ms(
                        mtime.harness,
                        mtime.session_id.as_deref(),
                        mtime.dirs(),
                    )
                }),
                reclaim_timer: None,
            };
            let started = ctx.turn_started_at_ms;
            let io = TurnProbeIo {
                clock: c.clock,
                // PTY 종료 = 이 시도의 끝 신호(`run_beside` 가 PTY 턴이 돌아올 때 세운다).
                exited: ctx.ended.clone(),
                ended: ctx.ended.clone(),
                read_thread,
                spoke_key: SpokeKey {
                    me_id: c.me_id.clone(),
                    since_seq: ctx.turn_start_seq,
                    turn_id: Some(ctx.turn_id.clone()),
                },
                records: records_of(c, ctx),
                record_state: RecordProbeState::default(),
                sink: McpProbeSink {
                    client,
                    key: c.key.clone(),
                    channel_id: c.channel_id.clone(),
                    anchor: c.anchor.clone(),
                    secrets: notice.clone(),
                    report_auth: Box::new(move |s: &[String]| report(s, started)),
                },
                secrets: notice.clone(),
                turn_state_records: records_of(c, ctx),
                turn_state_probe: TurnStateProbe::default(),
                harness: c.harness,
                turn_started_at_ms: started,
                opencode_quiet_ms: OPENCODE_QUIET_MS,
                lane_nudged_at_ms: 0,
                cfg: c.end_cfg,
                read_recorded_end: Box::new(|_since| None),
                terminate: terminate_on_watch(watch),
                rest,
            };
            let slot = c.slot.clone();
            LoopParts {
                io,
                probe: ProbeState {
                    turn_started_at_ms: started,
                    ..ProbeState::default()
                },
                ended: Some(ctx.ended.clone()),
                fence: Some(FenceCheck {
                    listening: Arc::new(AtomicBool::new(true)),
                    // 임대 잃음 또는 러너 물러남(P2) — 둘 다 같은 거둠·SIGTERM 길이다. 물러남은 임대 잃음 표지를 세우지 않는다.
                    lost: Box::new(move || slot.fenced_out() || slot.stopping()),
                    on_lost: crate::turn_watch::fence_reclaim(),
                }),
            }
        },
    )
}

#[cfg(test)]
#[path = "turn_probe_make_tests.rs"]
mod tests;
