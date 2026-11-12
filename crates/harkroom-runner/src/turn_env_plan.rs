//! 턴 환경 계획의 첫 조각(B4-2e5b-1). 정본 `mentionTurn.ts` 1607~1680·1755~1787 의 판정 절반.
//!
//! - [`lane_preflight`]: API 키 연결 턴을 키를 받기 **전에** 멈출 까닭을 정본 순서대로 잰다
//!   (모델 문법 → 작업 폴더·부모 사슬의 보호 이름 → pi lane 홈의 로그인).
//! - [`lane_harness_model`]: omp·pi lane 이 홈에 적을 주소·키 파일·모델 id 와 하네스에 넘길 모델 이름.
//! - [`turn_marker_file`]: MCP 준비 표식·「확인을 기다려 멈춤」 신호 파일 자리(러너 상태 폴더, 0700).
//!
//! 파일 쓰기(`models.json`·턴 MCP 설정)·턴 열쇠·`build_turn_command` 호출은 부르는 쪽(턴 루프 조각) 몫이다.
//!
//! **경로 노출(security 20:19)**: 작업 폴더 검사에서 찾은 경로는 이 모듈이 로컬 로그(stderr)에만 쓴다. 돌려주는 값은
//! [`ProviderLaneError`] 코드(`workspace_protected`) 하나뿐이라 서버로 경로가 나갈 길이 없다.

use std::collections::BTreeMap;
use std::fs::{self, DirBuilder};
use std::io;
use std::os::unix::fs::{DirBuilderExt, PermissionsExt};
use std::path::{Path, PathBuf};

use crate::adapter::{
    AgentHarness, MentionPermission, uses_omp_home, uses_pi_home, uses_xdg_home,
    waits_for_mcp_before_prompt,
};
use crate::lane_guard::{lane_parent_violations, lane_workspace_violations};
use crate::omp_home::OMP_LANE_PROVIDER;
use crate::opencode_home::{lane_run_model, opencode_lane_model_missing, provider_lane_model_id};
use crate::pi_home::pi_lane_login_present;
use crate::pi_lane::PI_LANE_PROVIDER;
use crate::provider_lane::{
    OMP_LANE_BASE_URL_ENV, OMP_LANE_KEY_FILE_ENV, PI_LANE_BASE_URL_ENV, PI_LANE_KEY_FILE_ENV,
    ProviderLaneError, lane_model_missing,
};
use crate::skills_sync::runner_skills_dir;
use crate::turn_preset::attaches_gate_hook;

/// [`lane_preflight`] 의 입력. `provider_lane` 이 거짓이면 아무것도 재지 않는다.
#[derive(Debug, Clone, Copy)]
pub struct LanePreflight<'a> {
    /// 로그 머리(`<채널>:<앵커>` 꼴 스레드 키). 서버로 나가지 않는다.
    pub key: &'a str,
    pub harness: AgentHarness,
    pub provider_lane: bool,
    pub model: Option<&'a str>,
    pub workspace_dir: &'a Path,
    pub state_dir: &'a Path,
    pub home: &'a Path,
    /// pi lane 턴의 스레드 홈(`ensure_pi_lane_thread`). pi 가 아니거나 lane 이 아니면 None.
    pub turn_pi_home: Option<&'a Path>,
}

/// 정본 순서: ① `bad_model`(opencode·kilo·codex·pi lane 모델이 비었거나 문법 밖) ② `workspace_protected`(작업 폴더와 그 위 ~ 까지에
/// 우리 것이 아닌 보호 이름) ③ `harness_login_present`(pi lane 홈에 로그인 — `models.json` 의 키를 이긴다). 셋 다 키를 받기 전이다.
pub fn lane_preflight(p: &LanePreflight<'_>) -> Result<(), ProviderLaneError> {
    if !p.provider_lane {
        return Ok(());
    }
    if opencode_lane_model_missing(true, uses_xdg_home(p.harness), p.model)
        || lane_model_missing(true, p.harness, p.model)
    {
        return Err(ProviderLaneError::new("bad_model"));
    }
    let found: Vec<String> =
        lane_workspace_violations(p.workspace_dir, &runner_skills_dir(p.state_dir))
            .into_iter()
            .chain(lane_parent_violations(p.workspace_dir, p.home))
            .collect();
    if !found.is_empty() {
        // 경로는 로컬 로그에만(security 20:19). 서버에는 코드만 나간다.
        eprintln!(
            "[mentionTurn] {}: API 키 연결 턴 — 작업 폴더에 보호 이름이 있어 띄우지 않는다: {}",
            p.key,
            found.join(", ")
        );
        return Err(ProviderLaneError::new("workspace_protected"));
    }
    if uses_pi_home(p.harness) && p.turn_pi_home.is_some_and(pi_lane_login_present) {
        return Err(ProviderLaneError::new("harness_login_present"));
    }
    Ok(())
}

/// omp·pi lane 이 그 홈에 적을 값. 키 값은 들지 않는다 — 키 **파일 경로**만 든다.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct LaneHomeModel {
    pub base_url: String,
    pub key_path: String,
    /// gateway 가 받는 모델 id(`provider_lane_model_id`).
    pub model_id: String,
}

/// [`lane_harness_model`] 의 결과.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum LaneHarnessModel {
    /// omp — lane 으로만 돈다. 스레드 홈 `agent/` 에 `models.json` 을 쓴다.
    Omp(LaneHomeModel),
    /// pi lane — 스레드 홈에 `models.json` 을 쓴다.
    Pi(LaneHomeModel),
    /// 홈에 적을 것이 없는 하네스(또는 lane 이 아닌 pi).
    None,
}

impl LaneHarnessModel {
    /// 정본 `buildTurnCommand` 의 `model` 칸 — omp/pi 는 `<lane provider>/<id>`, 나머지는 `lane_run_model`.
    pub fn run_model(
        &self,
        provider_lane: bool,
        harness: AgentHarness,
        model: Option<&str>,
    ) -> Option<String> {
        match self {
            Self::Omp(m) => Some(format!("{OMP_LANE_PROVIDER}/{}", m.model_id)),
            Self::Pi(m) => Some(format!("{PI_LANE_PROVIDER}/{}", m.model_id)),
            Self::None => lane_run_model(provider_lane, uses_xdg_home(harness), model),
        }
    }
}

fn home_model(
    provider_env: Option<&BTreeMap<String, String>>,
    base_env: &str,
    key_env: &str,
    model: Option<&str>,
) -> Result<LaneHomeModel, ProviderLaneError> {
    let get = |k: &str| {
        provider_env
            .and_then(|e| e.get(k))
            .filter(|v| !v.is_empty())
            .cloned()
    };
    let (Some(base_url), Some(key_path)) = (get(base_env), get(key_env)) else {
        return Err(ProviderLaneError::new("lane_unset"));
    };
    let model_id = provider_lane_model_id(model).ok_or(ProviderLaneError::new("bad_model"))?;
    Ok(LaneHomeModel {
        base_url,
        key_path,
        model_id,
    })
}

/// 정본 1665~1687. omp 는 lane 이 없으면 돌 모델이 없다(`lane_unset`) — 러너는 사람 로그인을 물려받지 않는다.
/// pi 는 lane 턴일 때만, 그리고 스레드 홈이 있어야 한다(없으면 `lane_unset`).
pub fn lane_harness_model(
    harness: AgentHarness,
    provider_env: Option<&BTreeMap<String, String>>,
    turn_pi_home: Option<&Path>,
    model: Option<&str>,
) -> Result<LaneHarnessModel, ProviderLaneError> {
    if uses_omp_home(harness) {
        return home_model(
            provider_env,
            OMP_LANE_BASE_URL_ENV,
            OMP_LANE_KEY_FILE_ENV,
            model,
        )
        .map(LaneHarnessModel::Omp);
    }
    if provider_env.is_some() && uses_pi_home(harness) {
        if turn_pi_home.is_none() {
            return Err(ProviderLaneError::new("lane_unset"));
        }
        return home_model(
            provider_env,
            PI_LANE_BASE_URL_ENV,
            PI_LANE_KEY_FILE_ENV,
            model,
        )
        .map(LaneHarnessModel::Pi);
    }
    Ok(LaneHarnessModel::None)
}

/// 턴마다 새로 심는 표식 파일의 종류.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum TurnMarker {
    /// 브릿지가 첫 `tools/list` 답을 쓴 뒤 만드는 파일(`HARKROOM_MCP_READY_FILE`).
    McpReady,
    /// 물음 hook·Notification hook 이 쓰는 「확인을 기다려 멈춤」 신호(`HARKROOM_GATE_FILE`).
    GateSignal,
}

impl TurnMarker {
    pub fn dir_name(self) -> &'static str {
        match self {
            Self::McpReady => "mcp-ready",
            Self::GateSignal => "gate-signal",
        }
    }

    /// 이 턴에 이 표식을 심는가. 둘 다 TUI 턴에서만 뜻이 있다.
    pub fn wanted(
        self,
        harness: AgentHarness,
        uses_tui: bool,
        p: MentionPermission,
        provider_lane: bool,
    ) -> bool {
        uses_tui
            && match self {
                Self::McpReady => waits_for_mcp_before_prompt(harness).unwrap_or(false),
                Self::GateSignal => attaches_gate_hook(harness, p, provider_lane),
            }
    }
}

fn ensure_private_dir(dir: &Path) -> io::Result<()> {
    DirBuilder::new().recursive(true).mode(0o700).create(dir)?;
    // 이미 있던 폴더는 mode 가 먹지 않는다 — 링크·남의 것·열린 권한이면 쓰지 않는다(공용 `/tmp` 로 떨어지지 않게 한 까닭과 같다).
    let meta = fs::symlink_metadata(dir)?;
    if !meta.is_dir() {
        return Err(io::Error::other("not a directory"));
    }
    if meta.permissions().mode() & 0o077 != 0 {
        return Err(io::Error::other("group/other access"));
    }
    Ok(())
}

/// 표식 파일 자리 `<state_dir>/<종류>/<새 id>`. 폴더를 못 만들면 None — 정본처럼 그 표식 없이 돈다(MCP 준비는 기다리지 않고,
/// 멈춤 판정은 화면으로 한다). 파일은 만들지 않는다 — 브릿지·hook 이 만든다.
pub fn turn_marker_file(
    state_dir: &Path,
    marker: TurnMarker,
    key: &str,
    new_id: &mut dyn FnMut() -> String,
) -> Option<PathBuf> {
    let dir = state_dir.join(marker.dir_name());
    match ensure_private_dir(&dir) {
        Ok(()) => Some(dir.join(new_id())),
        Err(e) => {
            eprintln!(
                "[mentionTurn] {key}: {} 자리를 못 만들어 표식 없이 돈다: {e}",
                marker.dir_name()
            );
            None
        }
    }
}

#[cfg(test)]
#[path = "turn_env_plan_tests.rs"]
mod tests;
