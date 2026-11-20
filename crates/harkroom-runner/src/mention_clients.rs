//! 이 에이전트의 서버 손님 묶음 — MCP 손님과 REST 손님을 **한 링크**에서 지어 쥐고, 멘션 실행이 쓰는 서버 길을 모두 여기서만
//! 꺼낸다(security ③b 조건): 준비([`McpPrepareIo`]), 멘션 deps([`LinkIo`] — 실패 통지·읽음·턴 임대), 감시 루프
//! ([`crate::mention_watch::mention_watch_loop`] — 탐침 sink·스레드 읽기·앵커 밖 확인).
//!
//! 턴 열쇠 맡기기·거두기([`AgentClients::attempt_base`] 의 REST)·임대 끝 알림·턴 임대 넘기기([`crate::mention_hooks::LinkHooks`])도
//! 같은 묶음의 링크로 간다.
//!
//! 턴 뒤 IO([`AgentClients::after_turn`])도 묶음의 MCP 손님으로 돈다.
//!
//! 손님 칸은 비공개다. 멘션 실행 쪽 짓개는 손님을 따로 받지 않고 이 묶음만 받으므로, 다른 계정(다른 링크)의 손님이 끼어들
//! 자리가 없다. 러너 하나가 에이전트 하나이고 링크는 그 에이전트의 것이다.

use std::collections::BTreeMap;
use std::path::Path;
use std::sync::Arc;

use crate::adapter::AgentHarness;
use crate::link::LinkClient;
use crate::mcp::HarkroomMcpClient;
use crate::mention_deps::LinkIo;
use crate::mention_hooks::LeaseHandoff;
use crate::rest::{HarkroomRestClient, RunnerLink};
use crate::turn_after::SilentSaid;
use crate::turn_attempt::LeaseNotice;
use crate::turn_attempt::TurnSecrets;
use crate::turn_attempt_fold::{AfterInputs, run_after_turn};
use crate::turn_attempt_run::AttemptBase;
use crate::turn_prepare_io::McpPrepareIo;
use crate::turn_success::AfterTurnPlan;

/// 이 에이전트의 MCP·REST 손님(같은 링크).
pub struct AgentClients<L: RunnerLink> {
    link: L,
    mcp: HarkroomMcpClient<L>,
    rest: HarkroomRestClient<L>,
}

impl<L: RunnerLink + Clone> AgentClients<L> {
    /// 링크 하나로 두 손님을 짓는다.
    pub fn new(link: L, version: impl Into<String>) -> Self {
        Self {
            mcp: HarkroomMcpClient::new(link.clone(), version),
            rest: HarkroomRestClient::new(link.clone()),
            link,
        }
    }
}

/// 손님 묶음이 링크보다 늦게 서므로 링크의 `on_link_open` 고리는 이 칸을 통해 부른다(정본 `main.ts` `relinkTurnKeys`).
pub type ClientsCell<L> = Arc<std::sync::OnceLock<Arc<AgentClients<L>>>>;

/// 링크가 열릴 때마다 열린 턴의 열쇠를 다시 맡기는 고리 — 오퍼레이터가 바뀌면 새 오퍼레이터의 장부는 비어 있어서,
/// 다시 맡기지 않으면 도는 턴의 MCP 다리가 받아들여지지 않고 그 턴의 도구 호출이 전부 시한까지 기다리다 끝난다.
/// 칸이 비어 있으면(첫 연결) 맡길 것이 없다. 링크 읽기 고리 밖에서 보낸다 — 고리 안에서 답을 기다리면 읽을 손이 없다.
pub fn turn_keys_relink<L: RunnerLink + Send + Sync + 'static>(
    cell: ClientsCell<L>,
) -> Box<dyn Fn() + Send + Sync> {
    Box::new(move || {
        let Some(clients) = cell.get().cloned() else {
            return;
        };
        let _ = std::thread::Builder::new()
            .name("turn-keys-relink".into())
            .spawn(move || {
                let (ok, failed) = clients.rest().re_register_turn_keys();
                if ok + failed > 0 {
                    eprintln!(
                        "[main] 링크가 열려 턴 열쇠를 다시 맡겼다: 성공 {ok}개, 실패 {failed}개"
                    );
                }
            });
    })
}

impl<L: RunnerLink> AgentClients<L> {
    /// 두 손님을 지은 그 링크(오퍼레이터 알림 — 턴 임대 넘기기·끝 알림이 이 길로 간다).
    pub fn link(&self) -> &L {
        &self.link
    }
    pub fn mcp(&self) -> &HarkroomMcpClient<L> {
        &self.mcp
    }
    pub fn rest(&self) -> &HarkroomRestClient<L> {
        &self.rest
    }
    /// 준비가 스레드를 읽는 길.
    pub fn prepare_io(&self) -> McpPrepareIo<'_, L> {
        McpPrepareIo { client: &self.mcp }
    }
    /// 턴 뒤 IO(정본 `afterTurn` — 무발화·대기 통지·보고처 약속·앵커 밖 확인) — MCP 손님은 묶음의 것이다.
    pub fn after_turn<'a>(
        &'a self,
        plan: &AfterTurnPlan,
        secrets: &'a TurnSecrets,
        i: &'a AfterInputs<'a>,
        last_said: Box<dyn FnMut() -> Option<String> + 'a>,
        silent_said: Box<dyn FnMut() -> SilentSaid + 'a>,
    ) -> Result<(), String> {
        run_after_turn(&self.mcp, plan, secrets, i, last_said, silent_said)
    }
    /// 멘션 deps 의 서버 길.
    pub fn link_io<'a>(
        &'a self,
        claim_holder: Option<&'a str>,
        log: &'a dyn Fn(&str),
    ) -> LinkIo<'a, L> {
        LinkIo {
            mcp: &self.mcp,
            rest: &self.rest,
            claim_holder,
            log,
        }
    }
}

/// 에이전트 링크 — 손님을 지을 링크이자 오퍼레이터 알림(임대 넘기기·끝)이 가는 길. 실물은 `&LinkClient`.
pub trait AgentLink: RunnerLink + Clone {
    type Operator: LeaseNotice + LeaseHandoff;
    fn operator(&self) -> &Self::Operator;
}

impl AgentLink for &LinkClient {
    type Operator = LinkClient;
    fn operator(&self) -> &LinkClient {
        self
    }
}

/// 러너가 쥔 링크(`LinkClient::new` 의 `Arc`) — 박동 시계처럼 러너 수명을 넘겨 쥐어야 하는 자리가 쓴다.
impl AgentLink for std::sync::Arc<LinkClient> {
    type Operator = LinkClient;
    fn operator(&self) -> &LinkClient {
        self
    }
}

/// 시도 범위의 임대 끝 알림 자리 — **아무것도 보내지 않는다.** 턴 임대는 멘션 하나의 것이다: 정본은 임대 끝(`notifyEnded`)을
/// `secretLeases.release` 한 곳(`secretLeases.ts` 130~137, `main.ts` 637)에서만 보내고, `release` 는 스케줄러가 **멘션 결말**에서만
/// 부른다(`mentionTurn.ts` 에는 없다). 오퍼레이터는 끝 알림을 받으면 `(runner, cause)` 임대를 장부에서 빼고 서버에 end 를
/// 보낸다(`turn_leases.rs::ended`) — 시도마다 보내면 재시도·계정 전환의 다음 시도가 임대 없이 돈다. 그래서 시도 끝(띄우기
/// 정리·lane 가드)은 이 자리로 보내 아무것도 하지 않고, 끝 알림은 [`crate::mention_hooks::LinkHooks`] 의 결말(`release_lease`·
/// 패닉 Drop)에서 한 번만 간다. lane 턴 파일 지우기는 lane 가드가 그대로 한다.
#[derive(Debug, Default)]
pub struct KeepMentionLease;

impl LeaseNotice for KeepMentionLease {
    fn lease_ended(&self, _cause: &str) {}
}

static KEEP_MENTION_LEASE: KeepMentionLease = KeepMentionLease;

impl<L: AgentLink + Send + Sync + 'static> AgentClients<L> {
    /// 러너 수명 장부의 실물 재료 — 박동은 **이 묶음의 링크**로(`LeaseHandoff::heartbeat`), 비밀 뿌리는 오퍼레이터가 넘긴
    /// `HARKROOM_TURN_SECRETS_DIR`(오퍼레이터 `serve.rs` 의 `turn-secrets`, 정본 `main.ts` 640 과 같은 값).
    pub fn lease_life(
        &self,
        secrets_dir: Option<std::path::PathBuf>,
    ) -> crate::mention_hooks::LeaseLife {
        let link = self.link.clone();
        crate::mention_hooks::LeaseLife {
            beat: std::sync::Arc::new(move |cause: &str| {
                crate::mention_hooks::LeaseHandoff::heartbeat(link.operator(), cause)
            }),
            every: crate::mention_hooks::LEASE_HEARTBEAT,
            secrets_dir,
        }
    }
}

impl<L: AgentLink> AgentClients<L> {
    /// 오퍼레이터 알림 길 — 묶음을 지은 그 링크.
    pub fn operator(&self) -> &L::Operator {
        self.link.operator()
    }

    /// 시도 실물의 러너 재료 — 턴 열쇠 맡기기·거두기(REST)는 묶음의 REST 손님, 임대 끝 알림은 묶음의 링크.
    #[allow(clippy::too_many_arguments)]
    pub fn attempt_base<'a>(
        &'a self,
        harness: AgentHarness,
        can_register_turn_keys: bool,
        state_dir: &'a Path,
        mcp_config_path: &'a Path,
        runner_env: &'a BTreeMap<String, String>,
        pat: &'a str,
    ) -> AttemptBase<'a, L, KeepMentionLease> {
        AttemptBase {
            client: &self.rest,
            // 시도 끝은 임대를 끝내지 않는다 — [`KeepMentionLease`].
            notice: &KEEP_MENTION_LEASE,
            harness,
            can_register_turn_keys,
            state_dir,
            mcp_config_path,
            runner_env,
            pat,
        }
    }
}

#[cfg(test)]
#[path = "mention_clients_tests.rs"]
mod tests;
