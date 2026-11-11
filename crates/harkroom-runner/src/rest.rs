//! `HarkroomAgentClient`(`packages/agent/src/harkroom.ts`)의 **REST 절반** — 링크의 `http.forward` 로 가는 호출들과
//! 턴 열쇠(`turnKeys.ts`). MCP 절반(`call()`·`inbox.poll`·`message.*`)은 다음 조각이다.
//!
//! 서버는 여기 없다: 인증(오퍼레이터 토큰 + `X-Harkroom-Agent`)은 오퍼레이터가 붙인다 — 그래서 PAT 도 URL 도 없다.
//!
//! 정본과 다른 점(일부러):
//! - 링크가 끊기면 정본 `RelayClient.request` 는 status 0 응답을 주거나 던진다. 여기 `LinkClient::request` 는 **언제나
//!   status 0 응답**이다 — 정본에서 `catch` 로 갈리던 자리는 status 0 으로 같은 결말이 나게 했다(각 메서드 주석).
//! - `mergeGrants`·`mergeApprovals` 의 같은 GET 합치기(inflight)는 없다. 대신 `merge_grant_info()` 한 번으로 둘을 받는다.
//! - 서버가 준 모양을 `as T` 로 믿지 않는다 — 목록 칸이 모양이 틀리면 정본의 거름(빈 목록·null)과 같은 쪽으로 간다.

use harkroom_proto::p1::RunnerLinkResponse;
use serde::Serialize;
use serde_json::{Value, json};
use std::collections::BTreeMap;
use std::sync::Mutex;

use crate::link::{LinkClient, LinkRequest};

pub const TURN_KEYS_PATH: &str = "/agent/turn-keys";
pub const TURN_KEYS_END_PATH: &str = "/agent/turn-keys/end";
pub const PROVIDER_LANE_MOUNT_PATH: &str = "/agent/provider-lane/mount";
pub const CLEANUP_REPORT_PATH: &str = "/agent/cleanup-report";

/// 이 클라이언트가 링크에서 쓰는 표면. `LinkClient` 가 그대로 맞는다 — 시험은 가짜를 준다.
pub trait RunnerLink: Send + Sync {
    fn request(&self, req: LinkRequest) -> RunnerLinkResponse;
}

impl RunnerLink for LinkClient {
    fn request(&self, req: LinkRequest) -> RunnerLinkResponse {
        LinkClient::request(self, req)
    }
}

/// `http.forward` 의 답.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct HttpReply {
    pub status: u16,
    pub body: String,
}

/// 정본 `harkroomError` — `status` 는 `isCredentialFailure` 가 읽는다(401·403 이면 harkroom 자격 실패).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct HarkroomError {
    pub message: String,
    pub status: Option<u16>,
}

impl HarkroomError {
    fn new(message: String, status: Option<u16>) -> Self {
        Self { message, status }
    }
    /// 정본 `isCredentialFailure` 의 harkroom 갈래: status 로만 판정한다(문구를 보지 않는다).
    pub fn is_credential(&self) -> bool {
        matches!(self.status, Some(401) | Some(403))
    }
}

impl std::fmt::Display for HarkroomError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(&self.message)
    }
}

impl std::error::Error for HarkroomError {}

/// JS `encodeURIComponent` 와 같은 꼴(남기는 글자: 영숫자와 `-_.!~*'()`).
pub fn encode_uri_component(s: &str) -> String {
    let mut out = String::with_capacity(s.len());
    for b in s.bytes() {
        if b.is_ascii_alphanumeric() || b"-_.!~*'()".contains(&b) {
            out.push(b as char);
        } else {
            out.push_str(&format!("%{b:02X}"));
        }
    }
    out
}

/// 턴 열쇠 — 하네스 아래에 주는 좁은 턴 자격(정본 `turnKeys.ts`). **`Debug` 는 값을 가린다**(security K3).
#[derive(Clone, PartialEq, Eq, Serialize)]
pub struct TurnKeys {
    pub bridge: String,
    pub shell: String,
}

impl std::fmt::Debug for TurnKeys {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("TurnKeys")
            .field("bridge", &"<redacted>")
            .field("shell", &"<redacted>")
            .finish()
    }
}

/// 32바이트 난수 둘(hex 64자).
pub fn issue_turn_keys() -> TurnKeys {
    fn hex32() -> String {
        use std::io::Read;
        let mut b = [0u8; 32];
        std::fs::File::open("/dev/urandom")
            .and_then(|mut f| f.read_exact(&mut b))
            .expect("/dev/urandom");
        b.iter().map(|x| format!("{x:02x}")).collect()
    }
    TurnKeys {
        bridge: hex32(),
        shell: hex32(),
    }
}

/// 열쇠 값을 기록·로그 가림 목록에 넣을 때 쓴다.
pub fn turn_key_values(keys: Option<&TurnKeys>) -> Vec<String> {
    keys.map(|k| vec![k.bridge.clone(), k.shell.clone()])
        .unwrap_or_default()
}

/// 맡긴 턴 하나.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct OpenTurn {
    pub turn_id: String,
    pub cause: Option<String>,
    pub keys: TurnKeys,
}

/// 맡기지 못했다 — 그 턴은 띄우지 않는다. 문장에 열쇠 값을 싣지 않는다. `status: None` 은 링크(끊김).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct TurnKeyRegisterError {
    pub status: Option<u16>,
}

impl std::fmt::Display for TurnKeyRegisterError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        let s = self
            .status
            .map(|s| s.to_string())
            .unwrap_or_else(|| "link".into());
        write!(
            f,
            "턴 자격을 오퍼레이터에 맡기지 못했다({s}) — 오퍼레이터가 이 판을 모르면 앱을 업데이트하라"
        )
    }
}

impl std::error::Error for TurnKeyRegisterError {}

/// 턴 임대(비밀 보관소). **`Debug` 는 토큰을 가린다.**
#[derive(Clone, PartialEq, Eq)]
pub struct TurnLease {
    pub id: String,
    pub token: String,
    pub expires_at: String,
}

impl std::fmt::Debug for TurnLease {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("TurnLease")
            .field("id", &self.id)
            .field("token", &"<redacted>")
            .field("expires_at", &self.expires_at)
            .finish()
    }
}

/// `issueTurnLease` 의 결말.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum LeaseOutcome {
    Lease(TurnLease),
    /// 409 `lease_used` — 앞 러너가 이미 받아 갔다. 호출부가 기다렸다 다시 묻는다.
    LeaseUsed,
    /// 0·5xx — 임대가 생겼는지조차 모른다(거절이 아니다).
    Unreachable,
    /// 거절(403 not_invoked·404 보관소 꺼짐 등) — 비밀 없이 돈다.
    None,
}

#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct ApiGrantInfo {
    pub connectors: Vec<String>,
    pub delegatable: Vec<String>,
}

#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct ToolRuleSets {
    pub rules: Vec<String>,
    /// 합을 안 주는 옛 서버·끊김은 `None` — 부르는 쪽은 규칙 파일을 쓰지 않는다.
    pub reach: Option<Vec<String>>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct MergeApproval {
    pub repo: String,
    pub number: i64,
    pub channel_id: String,
    pub thread_root_id: String,
}

#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct MergeGrantInfo {
    pub repos: Vec<String>,
    pub approvals: Vec<MergeApproval>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ClaimOutcome {
    Held,
    Taken,
    Unsupported,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum SlotOutcome {
    Granted,
    Full,
    Unsupported,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ApprovedSkill {
    pub slug: String,
    pub body: String,
}

fn strings(v: Option<&Value>) -> Option<Vec<String>> {
    v.and_then(Value::as_array).map(|a| {
        a.iter()
            .filter_map(|x| x.as_str().map(str::to_string))
            .collect()
    })
}

/// 연결 이름 꼴 `^[a-z0-9][a-z0-9_-]{0,63}$`.
fn is_connector_name(s: &str) -> bool {
    let b = s.as_bytes();
    !b.is_empty()
        && b.len() <= 64
        && (b[0].is_ascii_lowercase() || b[0].is_ascii_digit())
        && b[1..]
            .iter()
            .all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || *c == b'_' || *c == b'-')
}

/// 서버 오류 코드 꼴 `^[a-z_]{1,40}$`.
fn is_error_code(s: &str) -> bool {
    !s.is_empty() && s.len() <= 40 && s.bytes().all(|c| c.is_ascii_lowercase() || c == b'_')
}

pub struct HarkroomRestClient<L: RunnerLink> {
    link: L,
    /// 지금 도는 턴의 열쇠 — 오퍼레이터가 바뀌면 다시 맡긴다(`re_register_turn_keys`). 디스크에 쓰지 않는다.
    open_turn_keys: Mutex<BTreeMap<String, OpenTurn>>,
}

impl<L: RunnerLink> HarkroomRestClient<L> {
    pub fn new(link: L) -> Self {
        Self {
            link,
            open_turn_keys: Mutex::new(BTreeMap::new()),
        }
    }

    /// `http.forward` 한 번. `body` 가 있으면 JSON 으로 싣는다.
    pub fn forward(&self, method: &str, path: &str, body: Option<&Value>) -> HttpReply {
        let req = LinkRequest::Http {
            method: method.to_string(),
            path: path.to_string(),
            body: body.map(|b| b.to_string()),
            content_type: body.map(|_| "application/json".to_string()),
        };
        match self.link.request(req) {
            RunnerLinkResponse::HttpResponse { status, body, .. } => HttpReply { status, body },
            // http.forward 에 MCP 답이 오는 일은 없다 — 확인하지 못한 것으로 친다.
            RunnerLinkResponse::McpResponse { .. } | RunnerLinkResponse::McpError { .. } => {
                HttpReply {
                    status: 0,
                    body: "unexpected mcp response".into(),
                }
            }
        }
    }

    /// 정본 `rest<T>`: 2xx 가 아니면 status 를 실어 실패. 빈 본문은 `Null`.
    fn rest(
        &self,
        method: &str,
        path: &str,
        what: &str,
        body: Option<&Value>,
    ) -> Result<Value, HarkroomError> {
        let res = self.forward(method, path, body);
        if !(200..300).contains(&res.status) {
            let tail = if res.status == 0 {
                format!(" ({})", res.body)
            } else {
                String::new()
            };
            return Err(HarkroomError::new(
                format!("{what} 실패: {}{tail}", res.status),
                (res.status != 0).then_some(res.status),
            ));
        }
        if res.body.is_empty() {
            return Ok(Value::Null);
        }
        serde_json::from_str(&res.body)
            .map_err(|e| HarkroomError::new(format!("{what}: JSON 이 아니다 ({e})"), None))
    }

    /// 서버가 들고 있는 자기 정의(`GET /agent/config`). 모양(`AgentView`)은 그대로 넘긴다.
    pub fn definition(&self) -> Result<Value, HarkroomError> {
        self.rest("GET", "/agent/config", "agent/config", None)
    }

    /// 이 스레드에서 쓸 모델·effort. 실패는 던진다 — 물러날지는 호출자가 정한다.
    pub fn thread_model(&self, message_id: &str) -> Result<Value, HarkroomError> {
        self.rest(
            "GET",
            &format!(
                "/agent/thread-model?messageId={}",
                encode_uri_component(message_id)
            ),
            "agent/thread-model",
            None,
        )
    }

    /// 턴 임대. 거절 사유를 한 줄 남긴다(원인 글 id·상태·짧은 코드만 — 토큰·비밀 이름 없음).
    pub fn issue_turn_lease(
        &self,
        cause_message_id: &str,
        log: &dyn Fn(&str),
        claim_holder: Option<&str>,
    ) -> LeaseOutcome {
        let mut body = json!({ "causeMessageId": cause_message_id });
        if let Some(h) = claim_holder.filter(|h| !h.is_empty()) {
            body["claimHolder"] = json!(h);
        }
        let res = self.forward("POST", "/agent/turn-leases", Some(&body));
        if res.status != 200 || res.body.is_empty() {
            let code = serde_json::from_str::<Value>(&res.body)
                .ok()
                .and_then(|v| {
                    v.pointer("/error/code")
                        .and_then(Value::as_str)
                        .map(str::to_string)
                })
                .filter(|c| is_error_code(c))
                .unwrap_or_else(|| "unknown".into());
            log(&format!(
                "[secretLeases] 임대 발급 거절 cause={cause_message_id} status={} code={code}",
                res.status
            ));
            if res.status == 409 && code == "lease_used" {
                return LeaseOutcome::LeaseUsed;
            }
            return if res.status == 0 || res.status >= 500 {
                LeaseOutcome::Unreachable
            } else {
                LeaseOutcome::None
            };
        }
        let lease = serde_json::from_str::<Value>(&res.body)
            .ok()
            .and_then(|v| v.get("lease").cloned());
        let s = |k: &str| {
            lease
                .as_ref()
                .and_then(|l| l.get(k))
                .and_then(Value::as_str)
                .map(str::to_string)
        };
        match (s("id"), s("token"), s("expiresAt")) {
            (Some(id), Some(token), Some(expires_at)) => LeaseOutcome::Lease(TurnLease {
                id,
                token,
                expires_at,
            }),
            _ => LeaseOutcome::None,
        }
    }

    /// 쓸 수 있는 API 연결과 다시 줄 수 있는 연결. 옛 서버·실패는 빈 목록(fail-closed).
    pub fn api_grant_info(&self) -> ApiGrantInfo {
        let names = |v: Option<&Value>| {
            strings(v)
                .unwrap_or_default()
                .into_iter()
                .filter(|s| is_connector_name(s))
                .collect::<Vec<_>>()
        };
        match self.rest("GET", "/agent/api-grants", "api-grants", None) {
            Ok(r) => ApiGrantInfo {
                connectors: names(r.get("connectors")),
                delegatable: names(r.get("delegatable")),
            },
            Err(_) => ApiGrantInfo::default(),
        }
    }

    pub fn api_grants(&self) -> Vec<String> {
        self.api_grant_info().connectors
    }

    /// 비밀을 만들 수 있는가. 옛 서버·실패는 false.
    pub fn secret_create_granted(&self) -> bool {
        self.rest("GET", "/agent/secret-create", "secret-create", None)
            .map(|r| r.get("granted") == Some(&Value::Bool(true)))
            .unwrap_or(false)
    }

    /// 이 채널의 allow 규칙과 모든 채널 규칙의 합(`reach`). 끊김·옛 서버는 `rules: []`·`reach: None`.
    pub fn tool_rule_sets(&self, channel_id: &str, cause_message_id: Option<&str>) -> ToolRuleSets {
        let cause = cause_message_id
            .filter(|c| !c.is_empty())
            .map(|c| format!("&cause={}", encode_uri_component(c)))
            .unwrap_or_default();
        let path = format!(
            "/agent/tool-allows?channelId={}{cause}",
            encode_uri_component(channel_id)
        );
        match self.rest("GET", &path, "tool-allows", None) {
            Ok(r) => ToolRuleSets {
                rules: strings(r.get("rules")).unwrap_or_default(),
                reach: strings(r.get("reach")),
            },
            Err(_) => ToolRuleSets::default(),
        }
    }

    pub fn tool_allows(&self, channel_id: &str) -> Vec<String> {
        self.tool_rule_sets(channel_id, None).rules
    }

    /// `/agent/merge-grants` 한 번 — 머지해도 되는 저장소와 아직 안 쓴 1회 승인. 실패는 빈 목록(fail-closed).
    pub fn merge_grant_info(&self) -> MergeGrantInfo {
        let Ok(r) = self.rest("GET", "/agent/merge-grants", "merge-grants", None) else {
            return MergeGrantInfo::default();
        };
        let approvals = r
            .get("approvals")
            .and_then(Value::as_array)
            .map(|a| {
                a.iter()
                    .filter_map(|x| {
                        let s = |k: &str| x.get(k).and_then(Value::as_str).map(str::to_string);
                        Some(MergeApproval {
                            repo: s("repo")?,
                            number: x.get("number").and_then(Value::as_i64)?,
                            channel_id: s("channelId")?,
                            thread_root_id: s("threadRootId")?,
                        })
                    })
                    .collect()
            })
            .unwrap_or_default();
        MergeGrantInfo {
            repos: strings(r.get("repos")).unwrap_or_default(),
            approvals,
        }
    }

    /// 스레드 임대. 200 잡음 · 409 남이 쥠 · 404 옛 서버. 그 밖(끊김·5xx)은 실패 — 띄울지는 호출자(fail-closed).
    pub fn claim_thread(
        &self,
        channel_id: &str,
        thread_root_id: &str,
        holder: &str,
        ttl_sec: u64,
    ) -> Result<ClaimOutcome, HarkroomError> {
        let body = json!({ "channelId": channel_id, "threadRootId": thread_root_id, "holder": holder, "ttlSec": ttl_sec });
        let res = self.forward("POST", "/agent/thread-claims", Some(&body));
        match res.status {
            200 => Ok(ClaimOutcome::Held),
            409 => Ok(ClaimOutcome::Taken),
            404 => Ok(ClaimOutcome::Unsupported),
            0 => Err(HarkroomError::new(
                format!("agent/thread-claims 실패: 0 ({})", res.body),
                None,
            )),
            s => Err(HarkroomError::new(
                format!("agent/thread-claims 실패: {s}"),
                Some(s),
            )),
        }
    }

    /// 404 는 옛 서버 — 놓을 것이 처음부터 없었다.
    pub fn release_thread(
        &self,
        channel_id: &str,
        thread_root_id: &str,
        holder: &str,
    ) -> Result<(), HarkroomError> {
        let body =
            json!({ "channelId": channel_id, "threadRootId": thread_root_id, "holder": holder });
        let res = self.forward("POST", "/agent/thread-claims/release", Some(&body));
        if !(200..300).contains(&res.status) && res.status != 404 {
            return Err(HarkroomError::new(
                format!("agent/thread-claims/release 실패: {}", res.status),
                (res.status != 0).then_some(res.status),
            ));
        }
        Ok(())
    }

    /// 동시 턴 자리(오퍼레이터가 직접 답한다). 200 받음 · 409 꽉 참 · 그 밖(옛 오퍼레이터 404·끊김 0)은 띄운다(fail-open).
    pub fn acquire_turn_slot(&self, key: &str, keep_free: Option<u32>) -> SlotOutcome {
        let mut body = json!({ "key": key });
        if let Some(k) = keep_free.filter(|k| *k > 0) {
            body["keepFree"] = json!(k);
        }
        match self
            .forward("POST", "/agent/turn-slots", Some(&body))
            .status
        {
            200 => SlotOutcome::Granted,
            409 => SlotOutcome::Full,
            _ => SlotOutcome::Unsupported,
        }
    }

    /// 실패는 삼킨다 — 러너가 죽으면 오퍼레이터가 링크 끊김으로 돌려받는다.
    pub fn release_turn_slot(&self, key: &str) {
        self.forward(
            "POST",
            "/agent/turn-slots/release",
            Some(&json!({ "key": key })),
        );
    }

    /// 전용 제공사 경로의 턴 마운트(오퍼레이터가 직접 답한다). 판정은 호출자 몫 — 링크 끊김은 status 0 으로 돌아간다
    /// (정본은 던진다 — 어느 쪽이든 lane 턴은 비밀 없이 띄우지 않는다).
    pub fn mount_provider_lane(&self, cause: &str) -> HttpReply {
        self.forward(
            "POST",
            PROVIDER_LANE_MOUNT_PATH,
            Some(&json!({ "cause": cause })),
        )
    }

    fn post_turn_keys(&self, turn: &OpenTurn) -> Result<(), TurnKeyRegisterError> {
        let body = json!({ "turnId": turn.turn_id, "cause": turn.cause, "keys": turn.keys });
        match self.forward("POST", TURN_KEYS_PATH, Some(&body)).status {
            200 => Ok(()),
            0 => Err(TurnKeyRegisterError { status: None }),
            s => Err(TurnKeyRegisterError { status: Some(s) }),
        }
    }

    /// 턴 열쇠를 오퍼레이터에 맡긴다. 200 이 아니면 실패 — 그 턴은 띄우지 않는다.
    pub fn register_turn_keys(&self, turn: OpenTurn) -> Result<(), TurnKeyRegisterError> {
        self.post_turn_keys(&turn)?;
        self.open_turn_keys
            .lock()
            .unwrap()
            .insert(turn.turn_id.clone(), turn);
        Ok(())
    }

    /// 실패는 삼킨다 — 오퍼레이터가 수명 상한으로 쓴다.
    pub fn end_turn_keys(&self, turn_id: &str) {
        self.open_turn_keys.lock().unwrap().remove(turn_id);
        self.forward(
            "POST",
            TURN_KEYS_END_PATH,
            Some(&json!({ "turnId": turn_id })),
        );
    }

    /// 열린 턴의 열쇠를 다시 맡긴다 — 링크가 열릴 때마다 부른다(오퍼레이터가 바뀌면 장부가 비어 있다). 실패는 세기만 한다.
    pub fn re_register_turn_keys(&self) -> (usize, usize) {
        let snapshot: Vec<OpenTurn> = self
            .open_turn_keys
            .lock()
            .unwrap()
            .values()
            .cloned()
            .collect();
        let (mut ok, mut failed) = (0, 0);
        for turn in snapshot {
            // 기다리는 사이 끝난 턴을 되살리지 않는다.
            if !self
                .open_turn_keys
                .lock()
                .unwrap()
                .contains_key(&turn.turn_id)
            {
                continue;
            }
            match self.post_turn_keys(&turn) {
                Ok(()) => ok += 1,
                Err(_) => failed += 1,
            }
        }
        (ok, failed)
    }

    /// 작업 폴더 정리 보고(오퍼레이터가 직접 답한다). 답은 지울 스레드들(`deleteThreads`). 옛 오퍼레이터·링크 오류는 `None`.
    pub fn report_cleanup(&self, report: &Value) -> Option<Vec<Value>> {
        let res = self.forward("POST", CLEANUP_REPORT_PATH, Some(report));
        match res.status {
            204 => Some(Vec::new()),
            200 => {
                let body: Value = serde_json::from_str(&res.body).ok()?;
                Some(
                    body.get("deleteThreads")
                        .and_then(Value::as_array)
                        .cloned()
                        .unwrap_or_default(),
                )
            }
            _ => None,
        }
    }

    /// 턴을 마쳤다(본문 없음 — 시각은 서버가 찍는다). 실패는 던진다 — 삼킬지는 호출자 몫.
    pub fn report_activity(&self) -> Result<(), HarkroomError> {
        self.rest("POST", "/agent/activity", "agent/activity", None)
            .map(|_| ())
    }

    /// 워크스페이스 전체 계정 목록(`AccountView` 그대로).
    pub fn accounts(&self) -> Result<Vec<Value>, HarkroomError> {
        let body = self.rest("GET", "/accounts", "accounts", None)?;
        body.get("accounts")
            .and_then(Value::as_array)
            .cloned()
            .ok_or_else(|| HarkroomError::new("accounts: accounts 목록이 없다".into(), None))
    }

    /// 승인된 스킬. 실패를 던진다 — 빈 목록으로 뭉개면 호출자가 있는 스킬을 '사라진 것'으로 지운다.
    /// 같은 까닭으로 모양이 틀린 줄이 하나라도 있으면 통째로 실패다.
    pub fn list_approved_skills(&self) -> Result<Vec<ApprovedSkill>, HarkroomError> {
        let body = self.rest("GET", "/skills?state=approved", "skills", None)?;
        let bad = || HarkroomError::new("skills: 목록 모양이 다르다".into(), None);
        body.as_array()
            .ok_or_else(bad)?
            .iter()
            .map(|x| {
                let s = |k: &str| x.get(k).and_then(Value::as_str).map(str::to_string);
                match (s("slug"), s("body")) {
                    (Some(slug), Some(body)) => Ok(ApprovedSkill { slug, body }),
                    _ => Err(bad()),
                }
            })
            .collect()
    }

    /// 이번 턴에 부른 스킬을 보고한다. 실패는 던진다.
    pub fn record_skill_use(&self, slugs: &[String]) -> Result<(), HarkroomError> {
        self.rest(
            "POST",
            "/skills/usage",
            "skills/usage",
            Some(&json!({ "slugs": slugs })),
        )
        .map(|_| ())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::collections::VecDeque;

    #[derive(Default)]
    struct Fake {
        seen: Mutex<Vec<(String, String, Option<Value>)>>,
        replies: Mutex<VecDeque<(u16, String)>>,
    }

    impl Fake {
        fn with(replies: &[(u16, &str)]) -> Self {
            let f = Fake::default();
            *f.replies.lock().unwrap() = replies.iter().map(|(s, b)| (*s, b.to_string())).collect();
            f
        }
    }

    impl RunnerLink for &Fake {
        fn request(&self, req: LinkRequest) -> RunnerLinkResponse {
            let LinkRequest::Http {
                method,
                path,
                body,
                content_type,
            } = req
            else {
                panic!("mcp")
            };
            assert_eq!(content_type.is_some(), body.is_some());
            let body = body.map(|b| serde_json::from_str(&b).unwrap());
            self.seen.lock().unwrap().push((method, path, body));
            let (status, body) = self
                .replies
                .lock()
                .unwrap()
                .pop_front()
                .unwrap_or((0, "operator link down".into()));
            RunnerLinkResponse::HttpResponse {
                id: "x".into(),
                status,
                body,
            }
        }
    }

    fn last(f: &Fake) -> (String, String, Option<Value>) {
        f.seen.lock().unwrap().last().cloned().unwrap()
    }

    #[test]
    fn encode_matches_js() {
        assert_eq!(encode_uri_component("a b&c=d/é"), "a%20b%26c%3Dd%2F%C3%A9");
        assert_eq!(encode_uri_component("-_.!~*'()"), "-_.!~*'()");
    }

    #[test]
    fn rest_errors_carry_status() {
        let f = Fake::with(&[(401, "no"), (204, "")]);
        let c = HarkroomRestClient::new(&f);
        let e = c.definition().unwrap_err();
        assert_eq!(e.message, "agent/config 실패: 401");
        assert!(e.is_credential());
        assert_eq!(last(&f).1, "/agent/config");
        c.report_activity().unwrap();
        assert_eq!(last(&f), ("POST".into(), "/agent/activity".into(), None));
        // 링크 없음: status 0 은 status 없는 실패이고 본문을 덧붙인다.
        let e = c.definition().unwrap_err();
        assert_eq!(e.message, "agent/config 실패: 0 (operator link down)");
        assert_eq!(e.status, None);
        assert!(!e.is_credential());
    }

    #[test]
    fn thread_model_and_tool_allows_encode_query() {
        let f = Fake::with(&[
            (200, "{}"),
            (200, r#"{"rules":["Bash(ls)",1],"reach":["a"]}"#),
        ]);
        let c = HarkroomRestClient::new(&f);
        c.thread_model("m 1").unwrap();
        assert_eq!(last(&f).1, "/agent/thread-model?messageId=m%201");
        let r = c.tool_rule_sets("ch", Some("c/1"));
        assert_eq!(last(&f).1, "/agent/tool-allows?channelId=ch&cause=c%2F1");
        assert_eq!(r.rules, vec!["Bash(ls)"]);
        assert_eq!(r.reach, Some(vec!["a".to_string()]));
        // 끊김 → 빈 규칙·reach 없음
        assert_eq!(c.tool_rule_sets("ch", None), ToolRuleSets::default());
    }

    #[test]
    fn turn_lease_outcomes() {
        let f = Fake::with(&[
            (
                200,
                r#"{"lease":{"id":"l1","token":"s3cr3t","expiresAt":"t"}}"#,
            ),
            (409, r#"{"error":{"code":"lease_used"}}"#),
            (503, ""),
            (403, r#"{"error":{"code":"NOT valid!"}}"#),
            (200, r#"{"lease":{"id":"l1"}}"#),
        ]);
        let c = HarkroomRestClient::new(&f);
        let lines = Mutex::new(Vec::<String>::new());
        let log = |l: &str| lines.lock().unwrap().push(l.to_string());
        let LeaseOutcome::Lease(l) = c.issue_turn_lease("m1", &log, Some("h1")) else {
            panic!()
        };
        assert_eq!(l.token, "s3cr3t");
        assert!(!format!("{l:?}").contains("s3cr3t"));
        assert_eq!(
            last(&f).2,
            Some(json!({"causeMessageId":"m1","claimHolder":"h1"}))
        );
        assert_eq!(
            c.issue_turn_lease("m1", &log, None),
            LeaseOutcome::LeaseUsed
        );
        assert_eq!(last(&f).2, Some(json!({"causeMessageId":"m1"})));
        assert_eq!(
            c.issue_turn_lease("m1", &log, None),
            LeaseOutcome::Unreachable
        );
        assert_eq!(c.issue_turn_lease("m1", &log, None), LeaseOutcome::None);
        assert_eq!(c.issue_turn_lease("m1", &log, None), LeaseOutcome::None);
        assert_eq!(
            c.issue_turn_lease("m1", &log, None),
            LeaseOutcome::Unreachable
        ); // 링크 없음
        let lines = lines.lock().unwrap();
        assert_eq!(
            *lines,
            vec![
                "[secretLeases] 임대 발급 거절 cause=m1 status=409 code=lease_used",
                "[secretLeases] 임대 발급 거절 cause=m1 status=503 code=unknown",
                "[secretLeases] 임대 발급 거절 cause=m1 status=403 code=unknown",
                "[secretLeases] 임대 발급 거절 cause=m1 status=0 code=unknown",
            ]
        );
    }

    #[test]
    fn grants_filter_and_fail_closed() {
        let f = Fake::with(&[
            (
                200,
                r#"{"connectors":["gh","Bad","x_1",3],"delegatable":["gh"]}"#,
            ),
            (200, r#"{"granted":true}"#),
            (
                200,
                r#"{"repos":["o/r"],"approvals":[{"repo":"o/r","number":5,"channelId":"c","threadRootId":"t"},{"repo":"o/r","number":"5"}]}"#,
            ),
        ]);
        let c = HarkroomRestClient::new(&f);
        assert_eq!(
            c.api_grant_info(),
            ApiGrantInfo {
                connectors: vec!["gh".into(), "x_1".into()],
                delegatable: vec!["gh".into()]
            }
        );
        assert!(c.secret_create_granted());
        let m = c.merge_grant_info();
        assert_eq!(m.repos, vec!["o/r"]);
        assert_eq!(m.approvals.len(), 1);
        assert_eq!(m.approvals[0].number, 5);
        // 끊김 — 모두 비거나 false
        assert_eq!(c.api_grants(), Vec::<String>::new());
        assert!(!c.secret_create_granted());
        assert_eq!(c.merge_grant_info(), MergeGrantInfo::default());
    }

    #[test]
    fn thread_claims_and_slots() {
        let f = Fake::with(&[
            (200, ""),
            (409, ""),
            (404, ""),
            (500, ""),
            (404, ""),
            (500, ""),
            (200, ""),
            (409, ""),
            (404, ""),
        ]);
        let c = HarkroomRestClient::new(&f);
        assert_eq!(c.claim_thread("c", "t", "h", 60), Ok(ClaimOutcome::Held));
        assert_eq!(
            last(&f).2,
            Some(json!({"channelId":"c","threadRootId":"t","holder":"h","ttlSec":60}))
        );
        assert_eq!(c.claim_thread("c", "t", "h", 60), Ok(ClaimOutcome::Taken));
        assert_eq!(
            c.claim_thread("c", "t", "h", 60),
            Ok(ClaimOutcome::Unsupported)
        );
        assert_eq!(
            c.claim_thread("c", "t", "h", 60).unwrap_err().status,
            Some(500)
        );
        c.release_thread("c", "t", "h").unwrap();
        assert!(c.release_thread("c", "t", "h").is_err());
        assert_eq!(c.acquire_turn_slot("k", Some(2)), SlotOutcome::Granted);
        assert_eq!(last(&f).2, Some(json!({"key":"k","keepFree":2})));
        assert_eq!(c.acquire_turn_slot("k", Some(0)), SlotOutcome::Full);
        assert_eq!(last(&f).2, Some(json!({"key":"k"})));
        assert_eq!(c.acquire_turn_slot("k", None), SlotOutcome::Unsupported);
        assert_eq!(c.acquire_turn_slot("k", None), SlotOutcome::Unsupported); // 끊김
        // 끊김은 status 없는 실패
        assert_eq!(c.claim_thread("c", "t", "h", 60).unwrap_err().status, None);
        c.release_turn_slot("k");
        assert_eq!(last(&f).1, "/agent/turn-slots/release");
    }

    #[test]
    fn turn_keys_register_end_reregister() {
        let f = Fake::with(&[(200, ""), (200, ""), (500, ""), (200, ""), (200, "")]);
        let c = HarkroomRestClient::new(&f);
        let keys = issue_turn_keys();
        assert_eq!(keys.bridge.len(), 64);
        assert_ne!(keys.bridge, keys.shell);
        assert!(!format!("{keys:?}").contains(&keys.bridge));
        assert_eq!(turn_key_values(Some(&keys)).len(), 2);
        let t = |id: &str| OpenTurn {
            turn_id: id.into(),
            cause: None,
            keys: keys.clone(),
        };
        c.register_turn_keys(t("t1")).unwrap();
        assert_eq!(
            last(&f),
            (
                "POST".into(),
                TURN_KEYS_PATH.into(),
                Some(
                    json!({"turnId":"t1","cause":null,"keys":{"bridge":keys.bridge,"shell":keys.shell}})
                )
            )
        );
        c.register_turn_keys(t("t2")).unwrap();
        let e = c.register_turn_keys(t("t3")).unwrap_err();
        assert_eq!(e.status, Some(500));
        assert!(!e.to_string().contains(&keys.bridge));
        // t3 는 맡기지 못했으니 장부에 없다 → 다시 맡기기는 t1·t2 둘
        assert_eq!(c.re_register_turn_keys(), (2, 0));
        c.end_turn_keys("t1");
        assert_eq!(
            last(&f),
            (
                "POST".into(),
                TURN_KEYS_END_PATH.into(),
                Some(json!({"turnId":"t1"}))
            )
        );
        // 남은 t2 — 링크 끊김이면 실패로 센다
        assert_eq!(c.re_register_turn_keys(), (0, 1));
        assert_eq!(
            c.register_turn_keys(t("t4")).unwrap_err(),
            TurnKeyRegisterError { status: None }
        );
    }

    #[test]
    fn cleanup_lane_skills_accounts() {
        let f = Fake::with(&[
            (204, ""),
            (200, r#"{"deleteThreads":[{"channelId":"c"}]}"#),
            (404, ""),
            (200, "{oops"),
            (202, "{}"),
            (200, r#"{"accounts":[{"id":"a"}]}"#),
            (200, r#"[{"slug":"s","body":"b"}]"#),
            (200, r#"[{"slug":"s"}]"#),
            (200, ""),
        ]);
        let c = HarkroomRestClient::new(&f);
        let rep = json!({"threads":[]});
        assert_eq!(c.report_cleanup(&rep), Some(vec![]));
        assert_eq!(c.report_cleanup(&rep), Some(vec![json!({"channelId":"c"})]));
        assert_eq!(c.report_cleanup(&rep), None);
        assert_eq!(c.report_cleanup(&rep), None);
        assert_eq!(
            c.mount_provider_lane("m1"),
            HttpReply {
                status: 202,
                body: "{}".into()
            }
        );
        assert_eq!(last(&f).1, PROVIDER_LANE_MOUNT_PATH);
        assert_eq!(c.accounts().unwrap(), vec![json!({"id":"a"})]);
        assert_eq!(
            c.list_approved_skills().unwrap(),
            vec![ApprovedSkill {
                slug: "s".into(),
                body: "b".into()
            }]
        );
        assert!(c.list_approved_skills().is_err());
        c.record_skill_use(&["s".into()]).unwrap();
        assert_eq!(
            last(&f),
            (
                "POST".into(),
                "/skills/usage".into(),
                Some(json!({"slugs":["s"]}))
            )
        );
    }
}
