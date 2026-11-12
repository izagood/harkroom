//! 턴 환경 계획의 둘째 조각(B4-2e5b-2). 정본 `mentionTurn.ts` 1571~1606·1681~1701 의 조립 절반.
//!
//! - [`opencode_lane_agent_for`]·[`opencode_lane_agent_verified`]: opencode API 키 연결 auto 턴이 뜰 채널별 lane 에이전트 이름과,
//!   설정을 쓴 뒤 그 칸이 지금 규칙과 같은지 확인(security U2 — 못 맞추면 `lane_setup` 으로 띄우지 않는다).
//! - [`turn_readonly_tools`]: 허용 도구 목록으로 읽기 전용을 거는 하네스(omp·pi)의 `--tools` 값.
//! - [`turn_mcp_plan`]: 턴 열쇠를 낼지, 그 턴의 MCP 설정 경로(턴 열쇠 칸·lane 칸·기본)와 opencode 턴 설정 파일.
//!
//! `build_turn_command` 호출과 표식 파일 심기는 부르는 쪽(턴 루프 조각) 몫이다.
//!
//! **열쇠 값**: [`TurnMcpPlan`] 의 `Debug` 는 [`TurnKeys`] 의 가림을 그대로 쓴다. 이 모듈은 열쇠 값을 로그에 쓰지 않는다.

use std::collections::BTreeMap;
use std::fs;
use std::path::{Path, PathBuf};

use crate::adapter::{
    AgentHarness, MentionPermission, ReadonlyTools, TurnKeyDelivery, XdgApp, readonly_tools_for,
    turn_key_delivery_of, uses_xdg_home,
};
use crate::omp_home::omp_readonly_tool_list;
use crate::opencode_home::{
    opencode_config_file, opencode_lane_agent_matches_text, opencode_lane_agent_name,
};
use crate::pi_home::readonly_tool_list;
use crate::provider_lane::{
    LaneFileError, ProviderLaneError, lane_scrubs_subprocess_env, write_lane_mcp_config,
    write_opencode_turn_mcp_config, write_turn_mcp_config,
};
use crate::rest::{TurnKeys, issue_turn_keys};

/// 정본 1572: opencode 계열(XDG 홈) API 키 연결 **auto** 턴만 채널별 lane 에이전트로 뜬다. 채널 id 가 이름 문법 밖이면 None.
pub fn opencode_lane_agent_for(
    provider_lane: bool,
    harness: AgentHarness,
    permission: MentionPermission,
    channel_id: &str,
) -> Option<String> {
    if provider_lane && uses_xdg_home(harness) && permission == MentionPermission::Auto {
        opencode_lane_agent_name(channel_id)
    } else {
        None
    }
}

/// 정본 `opencodeLaneAgentMatches` + 1577~1579: 쓴 설정 파일의 그 채널 칸이 primary 이고 `bash` 표가 지금 규칙과 같아야 띄운다.
/// 파일을 못 읽거나 해석 못 하거나 다르면 `lane_setup` — 거둔 규칙이 남은 칸으로 돌지 않게(security U2).
pub fn opencode_lane_agent_verified(
    opencode_home: &Path,
    channel_id: &str,
    tool_allows: &[impl AsRef<str>],
    app: &XdgApp,
) -> Result<(), ProviderLaneError> {
    let ok = fs::read_to_string(opencode_config_file(opencode_home, app))
        .is_ok_and(|text| opencode_lane_agent_matches_text(&text, channel_id, tool_allows));
    if ok {
        Ok(())
    } else {
        Err(ProviderLaneError::new("lane_setup"))
    }
}

/// 정본 1590~1606: 읽기 전용 턴의 닫힌 도구 목록. 허용 목록을 쓰지 않는 하네스나 읽기 전용이 아닌 턴은 None.
///
/// - 글롭이 먹는 하네스(omp, `list` 없음)는 묻지 않는다 — 서버 이름으로 좁힌 글롭이 곧 목록이다(security R).
/// - 이름을 다 적어야 하는 하네스(pi)는 `discover` 로 하네스에게 MCP 도구 이름을 묻는다(인자는 그 하네스의 목록 명령 인자).
///   못 받았거나 서버 하나라도 비면 경고 한 줄을 남기고 **내장 읽기 도구만** 연다 — 답할 길을 잃는 쪽이 쓰기가 열리는 쪽보다 낫다.
pub fn turn_readonly_tools<F>(
    key: &str,
    harness: AgentHarness,
    permission: MentionPermission,
    discover: F,
) -> Option<String>
where
    F: FnOnce(&[&'static str]) -> Option<BTreeMap<String, Vec<String>>>,
{
    if permission != MentionPermission::Readonly {
        return None;
    }
    let spec: ReadonlyTools = readonly_tools_for(harness)?;
    let Some(list_args) = spec.list else {
        return Some(omp_readonly_tool_list(&spec));
    };
    let discovered = discover(list_args);
    let missing = match &discovered {
        None => true,
        Some(d) => spec
            .mcp_servers
            .iter()
            .any(|s| d.get(*s).is_none_or(Vec::is_empty)),
    };
    if missing {
        // 도구 이름은 서버가 준 공개 이름뿐이라 그대로 남긴다(정본과 같다). 경로·열쇠는 없다.
        eprintln!(
            "[mentionTurn] {key}: {harness:?} 읽기 전용 — MCP 도구 이름을 못 받아 내장 읽기 도구만 연다 ({discovered:?})"
        );
    }
    Some(readonly_tool_list(&spec, discovered.as_ref()))
}

/// [`turn_mcp_plan`] 의 입력.
#[derive(Debug, Clone, Copy)]
pub struct TurnMcpInput<'a> {
    pub harness: AgentHarness,
    /// 서버에 턴 열쇠를 맡길 길이 있는가(정본 `deps.harkroom.registerTurnKeys` 가 있는가).
    pub can_register_turn_keys: bool,
    /// lane 이 그 턴에 준 env(없으면 lane 턴이 아니다). opencode lane 턴 파일(`OPENCODE_CONFIG`)을 여기서 읽는다.
    pub provider_env: Option<&'a BTreeMap<String, String>>,
    pub state_dir: &'a Path,
    /// 오퍼레이터가 쓴 기본 MCP 설정.
    pub mcp_config_path: &'a Path,
    pub turn_id: &'a str,
    /// 러너 env — 턴 열쇠가 없는 lane 턴의 브릿지 값을 lane 전용 MCP 설정 `env` 칸에 옮길 때만 읽는다.
    pub runner_env: &'a BTreeMap<String, String>,
}

/// 턴 열쇠와 그 턴의 MCP 설정 자리.
#[derive(Debug)]
pub struct TurnMcpPlan {
    /// 낸 턴 열쇠. 맡기기(`register_turn_keys`)는 띄우기 바로 앞에서 부르는 쪽이 한다.
    pub turn_keys: Option<TurnKeys>,
    /// `build_turn_command` 의 `mcp_config_path` 칸.
    pub mcp_config_path: PathBuf,
    /// opencode 턴 설정 파일(다리 열쇠를 실은 것). lane 턴이면 lane 턴 파일 그 자체다.
    pub opencode_turn_config: Option<PathBuf>,
    /// 이 턴이 새로 만든 opencode 턴 설정 — 턴이 끝나면 부르는 쪽이 지운다. lane 턴 파일은 lane 이 치우므로 들지 않는다.
    pub owned_turn_config: Option<PathBuf>,
}

/// 정본 1683~1701·1729~1732. 순서: 턴 열쇠(맡길 길과 하네스의 전달 길이 다 있을 때만) → 열쇠 전달 길에 따라
/// 턴 MCP 설정(claude 계열) 또는 opencode 턴 설정 → 둘 다 아니면 lane 이 env 를 걷는 하네스는 lane 전용 MCP 설정, 그 밖은 기본.
pub fn turn_mcp_plan(i: &TurnMcpInput<'_>) -> Result<TurnMcpPlan, LaneFileError> {
    let delivery = turn_key_delivery_of(i.harness);
    let turn_keys = (i.can_register_turn_keys && delivery.is_some()).then(issue_turn_keys);
    let lane = i.provider_env.is_some();

    let turn_mcp_config = match (&turn_keys, delivery) {
        (Some(k), Some(TurnKeyDelivery::McpConfigEnv)) => Some(write_turn_mcp_config(
            i.state_dir,
            i.mcp_config_path,
            i.turn_id,
            &k.bridge,
            lane && lane_scrubs_subprocess_env(i.harness),
        )?),
        _ => None,
    };

    let lane_turn_file: Option<PathBuf> = i
        .provider_env
        .and_then(|e| e.get("OPENCODE_CONFIG"))
        .filter(|v| !v.is_empty())
        .map(PathBuf::from);
    let opencode_turn_config = match (&turn_keys, delivery) {
        (Some(k), Some(TurnKeyDelivery::TurnConfigEnv)) => Some(write_opencode_turn_mcp_config(
            i.state_dir,
            i.mcp_config_path,
            i.turn_id,
            &k.bridge,
            lane_turn_file.as_deref(),
        )?),
        _ => None,
    };
    let owned_turn_config = opencode_turn_config
        .as_ref()
        .filter(|p| lane_turn_file.as_ref() != Some(*p))
        .cloned();

    let mcp_config_path = match turn_mcp_config {
        Some(p) => p,
        None if lane && lane_scrubs_subprocess_env(i.harness) => {
            write_lane_mcp_config(i.state_dir, i.mcp_config_path, i.runner_env)?
        }
        None => i.mcp_config_path.to_path_buf(),
    };

    Ok(TurnMcpPlan {
        turn_keys,
        mcp_config_path,
        opencode_turn_config,
        owned_turn_config,
    })
}

#[cfg(test)]
#[path = "turn_mcp_plan_tests.rs"]
mod tests;
