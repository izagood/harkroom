//! 멘션 재료 짓개(L1) — 멘션 하나에 대해 서버를 읽어(`read_mention`) 지시문 재료([`SystemInputs`])와 보고처 약속을 짓는다. 정본
//! `mentionTurn.ts` 1470~1515 의 턴마다 읽기와 `buildSystemPrompt` 입력이다.
//!
//! - **손님은 묶음에서만**: 읽기는 모두 [`AgentClients`] 의 MCP·REST 손님으로 한다(다른 손님을 받는 인자가 없다).
//! - **보고처 약속은 그 멘션의 깨움에서만**([`report_promise`]): 대상(`MentionTarget`)의 깨움이 예약 깨움이고 보고처와 예약
//!   seq 가 있을 때만 짓는다. 다른 멘션·다른 줄에서 가져올 길이 없다(인자가 그 대상 하나다). 옛 서버처럼 예약 seq 가 없으면
//!   정본은 보고처 스레드의 마지막 seq 를 읽어 기준선으로 삼지만, 여기서는 판정을 접는다(`None`) — 근거 없이 경고하지 않는 쪽.
//! - 지시문 파일은 지금 자리(`write_turn_system_prompt`)를 그대로 쓴다 — 이 파일은 재료만 짓는다.

use serde_json::Value;

use crate::adapter::{AgentHarness, MentionPermission, uses_xdg_home};
use crate::memory_pin::MemoryContext;
use crate::mention_call::OwnedPromise;
use crate::mention_clients::{AgentClients, AgentLink};
use crate::mention_parts::{ApiInputs, MergeInputs, PermissionInputs, SystemInputs};
use crate::mention_target::{MentionTarget, TargetWake};
use crate::prompt_system::MergeApproved;
use crate::rest::{ApiGrantInfo, MergeGrantInfo, ToolRuleSets};
use crate::thread_model::{TurnModel, resolve_turn_model};
use crate::turn_preset::{attaches_command_hook, attaches_post_tool_hook};
use crate::turn_rules::safe_tool_allows;

/// 멘션 하나에 대해 서버에서 읽은 것.
#[derive(Clone, Debug)]
pub struct MentionReads {
    /// 에이전트 정의(`GET /agent/config`).
    pub def: Value,
    pub guide: String,
    pub merge: MergeGrantInfo,
    pub api: ApiGrantInfo,
    pub secret_create: bool,
    pub rules: ToolRuleSets,
    pub turn_model: TurnModel,
}

/// 정의를 못 읽었다 — 턴을 띄우지 않는다(정본도 정의 없이 돌지 않는다).
#[derive(Debug, PartialEq, Eq)]
pub struct DefinitionUnreadable;

/// 멘션 하나의 서버 읽기 — 묶음 손님으로만. 정의만 필수이고 나머지는 정본처럼 실패하면 빈 값.
pub fn read_mention<L: AgentLink>(
    clients: &AgentClients<L>,
    target: &MentionTarget,
) -> Result<MentionReads, DefinitionUnreadable> {
    let rest = clients.rest();
    let def = rest.definition().map_err(|e| {
        eprintln!("[mentionTurn] 정의 읽기 실패 — {e}");
        DefinitionUnreadable
    })?;
    let guide = clients.mcp().guide(None).unwrap_or_default();
    let anchor = target.thread_root_id.as_str();
    let s = |k: &str| def.get(k).and_then(Value::as_str);
    let turn_model = resolve_turn_model(
        Some(|id: &str| rest.thread_model(id)),
        s("model"),
        s("effort"),
        Some(anchor),
        &mut |line| eprintln!("[mentionTurn] {line}"),
    );
    Ok(MentionReads {
        guide,
        merge: rest.merge_grant_info(),
        api: rest.api_grant_info(),
        secret_create: rest.secret_create_granted(),
        rules: rest.tool_rule_sets(&target.channel_id, Some(&target.mention_id)),
        turn_model,
        def,
    })
}

/// 지시문 재료의 러너 쪽 값(정의에 없는 것).
pub struct SystemContext<'a> {
    /// 배치마다 바뀔 수 있는 값(이름 바뀜·채널 이름)이라 소유본이다 — 짓개가 잠금 안의 표에서 꺼내 넘긴다.
    pub handle: String,
    pub channel_name: String,
    pub memory: MemoryContext,
    pub operator_bin: &'a str,
    pub harness: AgentHarness,
    pub command_hook: bool,
    pub post_tool_hook: bool,
    /// API 키 연결 턴이면 `Some(모델 id)`.
    pub lane_model: Option<String>,
    pub turn_budget_ms: u64,
}

/// 정본 `buildSystemPrompt` 입력 — 머지 승인은 **이 스레드** 것만 싣는다.
pub fn system_inputs(
    r: &MentionReads,
    target: &MentionTarget,
    c: SystemContext<'_>,
) -> SystemInputs {
    let perm = if r.def.get("mentionPermission").and_then(Value::as_str) == Some("readonly") {
        MentionPermission::Readonly
    } else {
        MentionPermission::Auto
    };
    let approved: Vec<MergeApproved> = r
        .merge
        .approvals
        .iter()
        .filter(|a| a.channel_id == target.channel_id && a.thread_root_id == target.thread_root_id)
        .filter_map(|a| {
            Some(MergeApproved {
                repo: a.repo.clone(),
                number: u64::try_from(a.number).ok()?,
            })
        })
        .collect();
    let mut repos = r.merge.repos.clone();
    for a in &approved {
        if !repos.contains(&a.repo) {
            repos.push(a.repo.clone());
        }
    }
    SystemInputs {
        handle: c.handle,
        channel_name: c.channel_name,
        instructions: r
            .def
            .get("instructions")
            .and_then(Value::as_str)
            .unwrap_or_default()
            .to_string(),
        guide: r.guide.clone(),
        memory: c.memory,
        read_only: perm == MentionPermission::Readonly,
        turn_budget_ms: Some(c.turn_budget_ms),
        merge: Some(MergeInputs {
            operator_bin: c.operator_bin.to_string(),
            repos,
            approved,
        }),
        permissions: Some(PermissionInputs {
            tool_allows: safe_tool_allows(&r.rules.rules),
            command_hook: attaches_command_hook(c.harness, perm, c.command_hook),
            exact_shell_only: c.lane_model.is_some() && uses_xdg_home(c.harness),
            new_posts_hook: c.post_tool_hook && attaches_post_tool_hook(c.harness, perm),
        }),
        api: Some(ApiInputs {
            operator_bin: c.operator_bin.to_string(),
            connectors: r.api.connectors.clone(),
            delegatable: r.api.delegatable.clone(),
        }),
        secret_create: r.secret_create,
        lane_model: c.lane_model,
    }
}

/// 보고처 약속 — **이 멘션의** 예약 깨움에 보고처와 예약 seq 가 있을 때만.
pub fn report_promise(target: &MentionTarget) -> Option<OwnedPromise> {
    let Some(TargetWake::Scheduled(w)) = &target.wake else {
        return None;
    };
    Some(OwnedPromise {
        report_to: w.report_to.clone()?,
        base_seq: w.scheduled_seq?,
        scheduled_turn_id: w.scheduled_turn_id.clone(),
        reason: w.reason.clone(),
    })
}

#[cfg(test)]
#[path = "mention_inputs_tests.rs"]
mod tests;
