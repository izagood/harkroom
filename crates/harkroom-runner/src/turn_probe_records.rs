//! 정본 `mentionTurn.ts` 의 기록 탐침 실구현(B4-2f-4b-3b-1) — `probeDenials`·`probeMacPermission`·`probeMcpAuth`·
//! `probeApiError`, 그리고 하네스를 띄우기 전 펜스·중단 관문(`canceledBeforeSpawn`).
//!
//! 기록(claude JSONL 등)을 읽는 일은 [`ProbeRecords`] 뒤에 있다 — 실구현 [`TranscriptRecords`] 는 2f-1 의
//! `harness_errors` 읽개를 부른다. 스레드·오퍼레이터에 알리는 일은 [`ProbeSink`] 뒤에 있다.
//!
//! **올리는 글은 가린 통지 함수만 지난다**(security 22:35 조건 ①·③):
//! - 권한 거부 → [`permission_denial_notice`], macOS 권한 → [`mac_permission_notice`]. 비밀 목록에는 러너 비밀과
//!   **마운트한 비밀**을 함께 넘긴다(정본 `probeDenials` 는 러너 비밀만 넘겼다 — 더 닫는다).
//! - API 오류 → 원문은 판정용으로만 [`EndState`] 에 쥐고, 글은 [`EndState::api_error_notice`] 가 만든다.
//! - 화면에서 거둔 말(`ProbeState.screen_said`) → [`screen_said_for_post`] 가 [`quoted_line`] 을 거친 한 줄만 낸다.
//!
//! **펜스(security 조건 ④)**: `watch_fence(fence_aborted=true)` 는 `fenced_out` 표지만 세우고 회수하지 않는다. 부르는 쪽은
//! 턴 열쇠를 맡기거나·비밀·lane 키를 받거나·하네스를 띄우기 **전에** [`spawn_gate`] 를 부르고, `Err` 면 그 자리에서 멈춘다
//! (정본 `canceledBeforeSpawn` — 종료 코드 143, 실패 글은 `LEASE_LOST_NOTICE` 길).

use std::collections::HashSet;
use std::path::Path;

use crate::adapter::{AgentHarness, uses_omp_home};
use crate::harness_errors::{
    MAC_PERMISSION_PENDING_MS, MacPermissionWait, PermissionDenial, TranscriptDirs,
    read_last_api_error, read_mac_permission_waits, read_mcp_auth_rejections,
    read_permission_denials,
};
use crate::omp_home::read_omp_recorded_api_error;
use crate::prompt_system::BODY_LIMIT;
use crate::turn_end::EndState;
use crate::turn_life::TurnLife;
use crate::turn_notice::{
    DENIAL_NOTICE_MAX_PER_TURN, MAC_PERMISSION_NOTICE_MAX_PER_TURN, mac_permission_notice,
    mask_tokens, mask_whole, permission_denial_notice, quoted_line, tail_has_secret_fragment,
};

/// 기록 탐침의 턴 장부(정본 `end.deniedSeen`·`denialNotices`·`macSeen`·`macNotices`·`mcpRejectedSeen`).
#[derive(Debug, Default, Clone, PartialEq, Eq)]
pub struct RecordProbeState {
    pub denied_seen: HashSet<String>,
    pub denial_notices: usize,
    pub mac_seen: HashSet<String>,
    pub mac_notices: usize,
    pub mcp_rejected_seen: HashSet<String>,
}

/// 이 턴의 기록을 읽는 자리. 못 읽으면 빈 값·`None`(던지지 않는다 — 관측 실패로 턴을 죽이지 않는다).
pub trait ProbeRecords {
    fn denials(&mut self) -> Vec<PermissionDenial>;
    fn mac_waits(&mut self) -> Vec<MacPermissionWait>;
    fn mcp_auth_rejections(&mut self) -> Vec<String>;
    /// omp 처럼 하네스가 **자기 기록**에 남긴 API 오류(원문). 그런 기록이 없는 하네스는 `None`.
    fn recorded_api_error(&mut self) -> Option<String>;
    /// claude 기록의 마지막 API 오류 줄(원문).
    fn api_error(&mut self) -> Option<String>;
}

/// 알리는 자리. 실패는 로그만 남긴다.
pub trait ProbeSink {
    /// 스레드에 progress 로 올린다(발화로 세지 않는다).
    fn progress(&mut self, body: &str) -> Result<(), String>;
    /// MCP 헤더를 거절당한 서버 이름을 오퍼레이터에 알린다.
    fn report_mcp_auth_rejected(&mut self, servers: &[String]);
    fn log(&mut self, line: &str);
}

/// 통지에 쓸 비밀 목록 — 러너 비밀(PAT)과 이 턴에 마운트한 비밀·턴 열쇠.
#[derive(Clone, Default)]
pub struct NoticeSecrets {
    pub pat: String,
    /// 마운트한 비밀·턴 열쇠 값. 통째 가림과 12자 조각 검사에 쓴다.
    pub mounted: Vec<String>,
    /// 이 멘션의 임대 폴더 — 턴 **도중** `secret.mount` 로 생긴 값을 쓸 때마다 다시 읽는다([`NoticeSecrets::mounted_now`]).
    pub lease_dir: Option<std::path::PathBuf>,
}

impl std::fmt::Debug for NoticeSecrets {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("NoticeSecrets")
            .field("pat", &"<가림>")
            .field("mounted", &self.mounted.len())
            .finish()
    }
}

impl NoticeSecrets {
    /// 지금 가릴 값 — 띄울 때 지은 것 ∪ 임대 폴더를 **지금** 다시 읽은 것(정본 `tailSecrets` 는 쓸 때 `secretNeedles(cause)` 를
    /// 읽는다 — 띄운 뒤 마운트한 값도 가린다). 긴 것부터.
    ///
    /// 임대 폴더를 **못 읽으면**(권한·I/O 오류 등 — 폴더 없음은 아님) `None` — 무엇을 가릴지 모르니 화면·꼬리 인용을 내보내지
    /// 않는다(닫히는 쪽, T3a security 막음 1).
    pub fn mounted_now(&self) -> Option<Vec<String>> {
        let mut all: std::collections::BTreeSet<String> = self.mounted.iter().cloned().collect();
        if let Some(d) = &self.lease_dir {
            all.extend(crate::turn_attempt::lease_needles_checked(d).ok()?);
        }
        let mut v: Vec<String> = all.into_iter().collect();
        v.sort_by(|a, b| b.len().cmp(&a.len()).then_with(|| a.cmp(b)));
        Some(v)
    }
    /// 스레드에 올릴 통지 본문의 마지막 관문 — 마운트한 비밀·PAT 를 통째로 가리고 값을 모르는 토큰을 꼴로 가린다. 가린 뒤에도
    /// 비밀의 12자 조각이 보이면 `None`(올리지 않는다). 통지 함수가 이미 가린 본문에도 한 번 더 건다 — sink 를 지나는 길은 이것뿐이다.
    pub fn guard_body(&self, body: &str) -> Option<String> {
        // 임대 폴더를 못 읽으면 올리지 않는다(가리지 못한 본문은 내보내지 않는다).
        let mut all = self.mounted_now()?;
        if !self.pat.is_empty() {
            all.push(self.pat.clone());
        }
        all.sort_by_key(|s| std::cmp::Reverse(s.len()));
        let masked = mask_tokens(&mask_whole(body, &all));
        if !all.is_empty() && tail_has_secret_fragment(&masked, &all) {
            return None;
        }
        Some(masked)
    }
}

fn cap(body: String) -> String {
    if body.chars().count() <= BODY_LIMIT {
        return body;
    }
    body.chars().take(BODY_LIMIT).collect()
}

/// 정본 `probeDenials` — 새로 본 거부만 한 통지로 묶어 올린다(턴마다 상한).
pub fn probe_denials(
    st: &mut RecordProbeState,
    records: &mut impl ProbeRecords,
    sink: &mut impl ProbeSink,
    secrets: &NoticeSecrets,
) {
    if st.denial_notices >= DENIAL_NOTICE_MAX_PER_TURN {
        return;
    }
    let fresh: Vec<PermissionDenial> = records
        .denials()
        .into_iter()
        .filter(|d| !st.denied_seen.contains(&d.tool_use_id))
        .collect();
    if fresh.is_empty() {
        return;
    }
    for d in &fresh {
        st.denied_seen.insert(d.tool_use_id.clone());
    }
    st.denial_notices += 1;
    // 로컬 로그에는 도구 이름과 건수만 — 이유·명령 원문은 남기지 않는다.
    sink.log(&format!(
        "권한 거부 {}건 ({})",
        fresh.len(),
        fresh
            .iter()
            .map(|d| d.tool.as_str())
            .collect::<Vec<_>>()
            .join(", ")
    ));
    let body = cap(permission_denial_notice(
        &fresh,
        &secrets.pat,
        &secrets
            .mounted_now()
            .unwrap_or_else(|| secrets.mounted.clone()),
    ));
    if let Err(e) = sink.progress(&body) {
        sink.log(&format!("권한 거부 통지 실패 — {e}"));
    }
}

/// 정본 `probeMacPermission` — 새로 본 macOS 권한 대기만 한 통지로 묶어 올린다(같은 호출은 한 번만).
pub fn probe_mac_permission(
    st: &mut RecordProbeState,
    records: &mut impl ProbeRecords,
    sink: &mut impl ProbeSink,
    secrets: &NoticeSecrets,
) {
    if st.mac_notices >= MAC_PERMISSION_NOTICE_MAX_PER_TURN {
        return;
    }
    let fresh: Vec<MacPermissionWait> = records
        .mac_waits()
        .into_iter()
        .filter(|w| !st.mac_seen.contains(&w.tool_use_id))
        .collect();
    if fresh.is_empty() {
        return;
    }
    for w in &fresh {
        st.mac_seen.insert(w.tool_use_id.clone());
    }
    st.mac_notices += 1;
    sink.log(&format!("macOS 권한 창 {}건", fresh.len()));
    let body = cap(mac_permission_notice(
        &fresh,
        &secrets.pat,
        &secrets
            .mounted_now()
            .unwrap_or_else(|| secrets.mounted.clone()),
    ));
    if let Err(e) = sink.progress(&body) {
        sink.log(&format!("macOS 권한 통지 실패 — {e}"));
    }
}

/// 정본 `probeMcpAuth` — 헤더를 거절당한 MCP 서버를 이름당 한 번 오퍼레이터에 알린다. 스레드에는 쓰지 않는다.
pub fn probe_mcp_auth(
    st: &mut RecordProbeState,
    records: &mut impl ProbeRecords,
    sink: &mut impl ProbeSink,
) {
    let fresh: Vec<String> = records
        .mcp_auth_rejections()
        .into_iter()
        .filter(|n| !st.mcp_rejected_seen.contains(n))
        .collect();
    if fresh.is_empty() {
        return;
    }
    for n in &fresh {
        st.mcp_rejected_seen.insert(n.clone());
    }
    sink.log(&format!(
        "MCP 인증 헤더 거절 — {} (오퍼레이터에 알린다)",
        fresh.join(", ")
    ));
    sink.report_mcp_auth_rejected(&fresh);
}

/// 정본 `probeApiError` — 회수했으면 `Some(SIGTERM 필요 여부)`, 오류가 없거나 이미 끝났으면 `None`.
/// 기록 갈래가 먼저다. 원문은 판정용으로만 [`EndState`] 에 쥐고, 로그에는 원문을 남기지 않는다.
pub fn probe_api_error(
    end: &mut EndState,
    records: &mut impl ProbeRecords,
    sink: &mut impl ProbeSink,
    secrets: &NoticeSecrets,
) -> Option<bool> {
    if let Some(recorded) = records.recorded_api_error()
        && let Some(kill) = end.on_recorded_api_error(
            &recorded,
            &secrets.pat,
            &secrets
                .mounted_now()
                .unwrap_or_else(|| secrets.mounted.clone()),
        )
    {
        sink.log("하네스가 기록에 API 오류를 남겼다 — 회수한다");
        return Some(kill);
    }
    let text = records.api_error()?;
    let kill = end.on_api_error(&text)?;
    sink.log("하네스가 API 에러를 냈다 — 회수한다");
    Some(kill)
}

/// 화면에서 거둔 말(원문)을 스레드에 올릴 한 줄로 — [`quoted_line`](통째 가림·조각 검사·토큰 가림)을 거친다
/// (security 22:35 조건 ①). 가린 뒤 남는 것이 없으면 `None`(올리지 않는다).
pub fn screen_said_for_post(raw: Option<&str>, secrets: &NoticeSecrets) -> Option<String> {
    // 임대 폴더를 못 읽으면 화면 인용을 빼고 올린다.
    let line = quoted_line(raw, &secrets.pat, &secrets.mounted_now()?);
    (!line.is_empty()).then_some(line)
}

/// 하네스를 띄우기 전 관문이 막은 까닭(정본 `canceledBeforeSpawn`).
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum SpawnBlocked {
    /// 턴 임대를 잃었다 — 실패 글은 `LEASE_LOST_NOTICE` 길.
    FencedOut,
    /// 사람이 [중단] 했다.
    Canceled,
}

/// 턴 열쇠를 맡기거나·비밀·lane 키를 받거나·하네스를 띄우기 **전에** 부른다(security 조건 ④). `Err` 면 그 일을 하지 않고
/// 멈춘다 — 띄웠다가 죽이지 않고 아예 안 띄운다(프롬프트가 주입돼 모델 호출 한 번이 버려지는 것을 막는다).
/// `canceled` 는 사람이 [중단] 을 눌렀는가(정본 `end.canceledBy` 가 있는가).
pub fn spawn_gate(life: &TurnLife, canceled: bool) -> Result<(), SpawnBlocked> {
    if life.fenced_out {
        return Err(SpawnBlocked::FencedOut);
    }
    if canceled {
        return Err(SpawnBlocked::Canceled);
    }
    Ok(())
}

/// [`ProbeRecords`] 실구현 — 2f-1 의 `harness_errors` 읽개(claude 기록)와 omp 자기 기록을 부른다.
pub struct TranscriptRecords<'a> {
    pub harness: AgentHarness,
    pub session_id: Option<&'a str>,
    pub dirs: TranscriptDirs<'a>,
    /// 턴 시작 시각 — 그 뒤 레코드만 센다.
    pub since_ms: i64,
    /// omp 상태 루트. omp 를 쓰지 않으면 `None`.
    pub omp_home: Option<&'a Path>,
    /// 지금 시각(macOS 대기 판정).
    pub now_ms: fn() -> i64,
}

impl ProbeRecords for TranscriptRecords<'_> {
    fn denials(&mut self) -> Vec<PermissionDenial> {
        read_permission_denials(
            self.harness,
            self.session_id,
            self.dirs,
            Some(self.since_ms),
        )
    }
    fn mac_waits(&mut self) -> Vec<MacPermissionWait> {
        read_mac_permission_waits(
            self.harness,
            self.session_id,
            self.dirs,
            Some(self.since_ms),
            (self.now_ms)(),
            MAC_PERMISSION_PENDING_MS,
        )
    }
    fn mcp_auth_rejections(&mut self) -> Vec<String> {
        read_mcp_auth_rejections(
            self.harness,
            self.session_id,
            self.dirs,
            Some(self.since_ms),
        )
    }
    fn recorded_api_error(&mut self) -> Option<String> {
        if !uses_omp_home(self.harness) {
            return None;
        }
        read_omp_recorded_api_error(self.omp_home?, self.session_id, self.since_ms)
    }
    fn api_error(&mut self) -> Option<String> {
        read_last_api_error(
            self.harness,
            self.session_id,
            self.dirs,
            Some(self.since_ms),
        )
        .map(|e| e.text)
    }
}

#[cfg(test)]
#[path = "turn_probe_records_tests.rs"]
mod tests;
