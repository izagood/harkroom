//! TurnAttempt 본체 배선 첫 조각 — [`LaunchIo`]·[`LaunchRelease`] 의 **실제** 구현.
//!
//! - 턴 열쇠: [`HarkroomRestClient::register_turn_keys`] / [`HarkroomRestClient::end_turn_keys`](오퍼레이터 `/agent/turn-keys`).
//! - lane 키: [`ProviderLane::env_for`](오퍼레이터 마운트 → 하네스 env) / [`ProviderLane::release`](턴 파일 지우기, 없으면 무해).
//! - 비밀 임대: 마운트·끝내기 닫개(임대 장부가 Rust 로 오면 그 자리에 붙는다).
//! - 띄우기: 받은 lane env 를 넘겨 PTY 턴을 돌리는 닫개.
//!
//! 받은 lane env 는 `launch` 와 `release` 가 함께 보는 칸([`LaneSlot`])에 둔다 — 값이 든 자리라 `Debug` 를 두지 않는다.
//! 준비 실패 사유는 **단계 코드만** 돌려준다(오류 원문·경로·값은 서버·글로 나가지 않는다 — 로컬 로그 몫).

use std::cell::RefCell;
use std::collections::BTreeMap;
use std::rc::Rc;

use crate::adapter::AgentHarness;
use crate::provider_lane::ProviderLane;
use crate::rest::{HarkroomRestClient, OpenTurn, RunnerLink};
use crate::turn_launch::{LaunchIo, LaunchRelease, LaunchStep};

/// 하네스 env 에 얹을 lane 키(이름 → 값). 값이 들어 있다 — 찍지 않는다.
pub type LaneEnv = BTreeMap<String, String>;

/// `launch` 가 받은 lane env 를 `release` 가 거둘 수 있게 함께 쥐는 칸. 마운트 뒤 실패했는지도 함께 적는다.
#[derive(Clone, Default)]
pub struct LaneSlot(Rc<RefCell<LaneState>>);

#[derive(Default)]
struct LaneState {
    env: Option<LaneEnv>,
    /// 오퍼레이터가 마운트한 뒤 검증·턴 파일에서 실패했다 — 키 파일이 임대 디렉터리에 남아 있을 수 있다.
    mounted_then_failed: bool,
}

impl LaneSlot {
    fn put(&self, env: LaneEnv) {
        self.0.borrow_mut().env = Some(env);
    }
    fn take(&self) -> Option<LaneEnv> {
        self.0.borrow_mut().env.take()
    }
    fn get(&self) -> Option<LaneEnv> {
        self.0.borrow().env.clone()
    }
    fn note_mounted_then_failed(&self) {
        self.0.borrow_mut().mounted_then_failed = true;
    }
    fn take_mounted_then_failed(&self) -> bool {
        std::mem::take(&mut self.0.borrow_mut().mounted_then_failed)
    }
}

/// 실패 원인을 **로컬 로그에만** 남긴다(서버·글로는 단계 코드만 간다). 값은 원인 문구에 들지 않는다 — 경로·상태 코드뿐.
fn log_local(what: &str, detail: &dyn std::fmt::Display) {
    eprintln!("[launch] {what} 실패 — {detail}");
}

/// 비밀 임대 마운트·끝내기(한 번만 쓰는 닫개).
pub type SecretsMount<'a> = Box<dyn FnOnce() -> Result<(), String> + 'a>;
pub type SecretsEnd<'a> = Box<dyn FnOnce() + 'a>;
/// 하네스 띄우기 — lane env(없으면 빈 것)를 받아 끝까지 돈다.
pub type SpawnFn<'a, O> = Box<dyn FnOnce(LaneEnv) -> O + 'a>;

/// 실제 [`LaunchIo`].
pub struct RestLaunch<'a, L: RunnerLink, O> {
    pub client: &'a HarkroomRestClient<L>,
    /// 이 턴의 열쇠(값). `Debug` 를 두지 않는다.
    pub turn: OpenTurn,
    pub lane: Option<&'a ProviderLane>,
    pub harness: AgentHarness,
    pub cause: &'a str,
    pub lane_slot: LaneSlot,
    pub mount_secrets: Option<SecretsMount<'a>>,
    pub spawn: Option<SpawnFn<'a, O>>,
}

impl<L: RunnerLink, O> LaunchIo for RestLaunch<'_, L, O> {
    type Out = O;

    fn prepare(&mut self, step: LaunchStep) -> Result<(), String> {
        match step {
            LaunchStep::TurnKeys => {
                self.client
                    .register_turn_keys(self.turn.clone())
                    .map_err(|e| {
                        log_local("턴 열쇠 맡기기", &status_of(e.status));
                        "turn_keys".to_string()
                    })
            }
            LaunchStep::Secrets => match self.mount_secrets.take() {
                Some(f) => f().map_err(|e| {
                    log_local("비밀 마운트", &e);
                    "secrets".to_string()
                }),
                None => Ok(()),
            },
            LaunchStep::LaneKeys => {
                let Some(lane) = self.lane else {
                    return Err("lane_off".to_string());
                };
                match lane.env_for(self.cause, self.harness) {
                    Ok(env) => {
                        self.lane_slot.put(env);
                        Ok(())
                    }
                    // 서버·글로는 접힌 코드만(턴 연결 nit ⑤). 경로·원인은 로컬 로그로만.
                    Err(e) => {
                        log_local("lane 키", &e.local_detail());
                        if e.after_mount() {
                            // 키 파일이 오퍼레이터 임대 디렉터리에 있을 수 있다 — 턴 끝에 그 임대를 끝낸다.
                            self.lane_slot.note_mounted_then_failed();
                        }
                        Err(e.lane_code().unwrap_or("lane_file").to_string())
                    }
                }
            }
        }
    }

    fn spawn(&mut self) -> O {
        let env = self.lane_slot.get().unwrap_or_default();
        let f = self
            .spawn
            .take()
            .expect("spawn 은 launch 가 한 번만 부른다");
        f(env)
    }
}

/// 실제 [`LaunchRelease`] — 세 갈래 모두 없는 것에도 무해하다.
pub struct RestRelease<'a, L: RunnerLink> {
    pub client: &'a HarkroomRestClient<L>,
    pub turn_id: String,
    pub lane: Option<&'a ProviderLane>,
    pub lane_slot: LaneSlot,
    pub end_secrets: Option<SecretsEnd<'a>>,
    /// 마운트 뒤 실패한 lane 의 임대를 끝낸다(오퍼레이터가 임대 디렉터리째 지운다). 비밀 단계를 거치지 않은 턴에도
    /// 키 파일이 남지 않게 lane 거두기가 직접 부른다. 한 번만 쓴다.
    pub end_lane_mount: Option<SecretsEnd<'a>>,
}

impl<L: RunnerLink> LaunchRelease for RestRelease<'_, L> {
    fn release(&mut self, step: LaunchStep) -> Result<(), String> {
        match step {
            // 맡기기가 Err 였어도 보낸다(#2012 ⑤). 모르는 턴이면 오퍼레이터가 지울 것 없이 200.
            LaunchStep::TurnKeys => self.client.end_turn_keys(&self.turn_id).map_err(|e| {
                log_local("턴 열쇠 거두기", &status_of(e.status));
                "turn_keys".to_string()
            }),
            LaunchStep::Secrets => {
                if let Some(f) = self.end_secrets.take() {
                    f();
                }
                Ok(())
            }
            LaunchStep::LaneKeys => {
                if self.lane_slot.take_mounted_then_failed()
                    && let Some(f) = self.end_lane_mount.take()
                {
                    f();
                }
                // 받은 env 가 없으면(마운트 실패·두 번째 부름) 지울 턴 파일이 없다.
                let (Some(lane), Some(env)) = (self.lane, self.lane_slot.take()) else {
                    return Ok(());
                };
                lane.release(&env).map_err(|e| {
                    log_local("lane 턴 파일 지우기", &e);
                    "lane_file".to_string()
                })
            }
        }
    }
}

fn status_of(status: Option<u16>) -> String {
    status.map_or_else(|| "link".to_string(), |s| format!("status {s}"))
}

#[cfg(test)]
#[path = "turn_launch_io_tests.rs"]
mod tests;
