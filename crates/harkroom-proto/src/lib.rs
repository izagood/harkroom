//! TS 와 Rust 가 함께 쓰는 프로세스 경계의 모양(S1, Rust 전환). 아직 어디에도 연결하지 않는다.
//!
//! | 경계 | 정본(TS) | 이 crate |
//! |---|---|---|
//! | P1 러너 ↔ 오퍼레이터 링크 | `packages/shared/src/runnerLink.ts` | [`p1`] |
//! | P2 오퍼레이터 ↔ 서버 WS | `packages/shared/src/operatorProtocol.ts` | [`p2`] |
//! | P3 앱(Tauri) ↔ 오퍼레이터 소켓 | `packages/shared/src/daemonProtocol.ts` | [`p3`] — 봉투만. 요청별 payload 는 S2 앞에서 |
//! | P4 `harkroom-operator merge` 한 줄 출력 | operator `main.ts::mergeMain`·`turnMerge.ts` | [`p4`] |
//! | P5 로컬 공유 파일 | `operatorRoots.ts` | `harkroom-roots` crate |
//!
//! ## 어긋남을 잡는 법
//! 타입을 생성하지 않는다(서버 ↔ UI 만 S5.1 에서 ts-rs). 대신 TS 시험 `packages/shared/test/protoGolden.test.ts` 가
//! TS 타입 검사를 통과한 표본을 `golden/proto.json` 에 쓰고, 이 crate 의 시험이 그것을 **파싱 → 다시 직렬화 = 원본**으로 본다.
//! 필드 이름·enum 값·있고 없음이 하나라도 다르면 빨갛다.
//!
//! 깊은 도메인 객체(세션 보기·능력·상태 보고 등)는 아직 [`serde_json::Value`] 로 둔다 — 지금의 Tauri 클라이언트처럼
//! 이 경계는 그것을 해석하지 않고 넘긴다. 그 객체를 해석하는 Rust 코드가 생길 때 그 자리에서 타입을 붙인다.

pub use serde_json::Value;

/// `null` 이 올 수도 있는 **선택** 필드(`x?: T | null`)를 왕복에서 지키는 꼴 — 없음(`None`)과 `null`(`Some(None)`)을 가른다.
pub mod double_option {
    use serde::{Deserialize, Deserializer, Serialize, Serializer};

    pub fn deserialize<'de, T: Deserialize<'de>, D: Deserializer<'de>>(
        d: D,
    ) -> Result<Option<Option<T>>, D::Error> {
        Option::<T>::deserialize(d).map(Some)
    }

    pub fn serialize<T: Serialize, S: Serializer>(
        v: &Option<Option<T>>,
        s: S,
    ) -> Result<S::Ok, S::Error> {
        match v {
            Some(inner) => inner.serialize(s),
            None => s.serialize_none(),
        }
    }
}

/// 한 값만 받는 문자열 표지(`type: 'hello'` 같은 것)를 만든다.
macro_rules! literal {
    ($name:ident, $lit:literal) => {
        #[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
        pub struct $name;
        impl serde::Serialize for $name {
            fn serialize<S: serde::Serializer>(&self, s: S) -> Result<S::Ok, S::Error> {
                s.serialize_str($lit)
            }
        }
        impl<'de> serde::Deserialize<'de> for $name {
            fn deserialize<D: serde::Deserializer<'de>>(d: D) -> Result<Self, D::Error> {
                let v = String::deserialize(d)?;
                if v == $lit {
                    Ok($name)
                } else {
                    Err(serde::de::Error::custom(format!(
                        "expected {:?}, got {v:?}",
                        $lit
                    )))
                }
            }
        }
    };
}

/// P1 — 러너 ↔ 오퍼레이터 링크(유닉스 소켓, 줄마다 JSON 하나). 러너는 서버를 모르고 이 링크로만 말한다.
pub mod p1 {
    use super::Value;
    use serde::{Deserialize, Serialize};

    pub const RUNNER_LINK_PROTOCOL_VERSION: u32 = 1;

    literal!(HelloTag, "hello");
    literal!(RunnerRole, "runner");

    #[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
    #[serde(rename_all = "lowercase")]
    pub enum RunnerLinkKind {
        Relay,
        Bridge,
        Hook,
        Wrapper,
    }

    /// 연결 첫 줄. `secret`(러너 코어·옛 브릿지)과 `turnKey`(턴 열쇠) 중 정확히 하나를 싣는다 — 그 검사는 받는 쪽(`checkRunnerHello`) 몫이다.
    #[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
    #[serde(rename_all = "camelCase")]
    pub struct RunnerHello {
        #[serde(rename = "type")]
        pub ty: HelloTag,
        pub version: u32,
        pub role: RunnerRole,
        pub runner_id: String,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        pub secret: Option<String>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        pub turn_key: Option<String>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        pub kind: Option<RunnerLinkKind>,
    }

    #[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
    #[serde(tag = "type")]
    pub enum RunnerLinkRequest {
        #[serde(rename = "mcp.request", rename_all = "camelCase")]
        McpRequest {
            id: String,
            payload: Value,
            #[serde(default, skip_serializing_if = "Option::is_none")]
            cause: Option<String>,
            #[serde(default, skip_serializing_if = "Option::is_none")]
            cwd: Option<String>,
            #[serde(default, skip_serializing_if = "Option::is_none")]
            turn_id: Option<String>,
            #[serde(default, skip_serializing_if = "Option::is_none")]
            command_files: Option<String>,
        },
        #[serde(rename = "http.forward", rename_all = "camelCase")]
        HttpForward {
            id: String,
            method: String,
            path: String,
            #[serde(default, skip_serializing_if = "Option::is_none")]
            body: Option<String>,
            #[serde(default, skip_serializing_if = "Option::is_none")]
            body_base64: Option<String>,
            #[serde(default, skip_serializing_if = "Option::is_none")]
            content_type: Option<String>,
        },
    }

    #[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
    #[serde(tag = "type")]
    pub enum RunnerLinkResponse {
        /// 서버가 돌려준 JSON-RPC 메시지들. 알림(202)이면 빈 배열.
        #[serde(rename = "mcp.response")]
        McpResponse { id: String, messages: Vec<Value> },
        #[serde(rename = "mcp.error")]
        McpError {
            id: String,
            status: u16,
            message: String,
        },
        #[serde(rename = "http.response")]
        HttpResponse {
            id: String,
            status: u16,
            body: String,
        },
    }

    #[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
    #[serde(tag = "type")]
    pub enum RunnerLinkNotice {
        #[serde(rename = "runner.pollStopped")]
        PollStopped {
            holding: Vec<i64>,
            #[serde(default, skip_serializing_if = "Option::is_none")]
            done: Option<Vec<i64>>,
        },
        #[serde(rename = "mcp.authRejected", rename_all = "camelCase")]
        McpAuthRejected {
            servers: Vec<String>,
            turn_started_at_ms: i64,
        },
        #[serde(rename = "secret.lease", rename_all = "camelCase")]
        SecretLease {
            cause: String,
            lease_id: String,
            token: String,
            expires_at: String,
        },
        #[serde(rename = "secret.leaseEnded")]
        SecretLeaseEnded { cause: String },
        #[serde(rename = "secret.leaseHeartbeat")]
        SecretLeaseHeartbeat { cause: String },
        /// `code` 는 `PROVIDER_LANE_FAILURE_CODES` 중 하나다(목록은 골든 `constants` 와 같은지 시험이 본다).
        #[serde(rename = "providerLane.result")]
        ProviderLaneResult {
            ok: bool,
            #[serde(default, skip_serializing_if = "Option::is_none")]
            code: Option<String>,
        },
        #[serde(rename = "providerLane.mode")]
        ProviderLaneMode { on: bool },
        #[serde(rename = "providerLane.turn")]
        ProviderLaneTurn { ok: bool },
    }

    pub const RUNNER_LINK_NOTICE_TYPES: [&str; 8] = [
        "runner.pollStopped",
        "mcp.authRejected",
        "secret.lease",
        "secret.leaseEnded",
        "secret.leaseHeartbeat",
        "providerLane.result",
        "providerLane.mode",
        "providerLane.turn",
    ];

    #[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
    #[serde(tag = "type")]
    pub enum OperatorToRunnerNotice {
        #[serde(rename = "handover.released")]
        HandoverReleased,
    }

    #[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
    #[serde(rename_all = "snake_case")]
    pub enum RejectReason {
        UnknownRunner,
    }

    #[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
    #[serde(tag = "type")]
    pub enum RunnerLinkRejected {
        #[serde(rename = "link.rejected")]
        LinkRejected { reason: RejectReason },
    }

    /// `PROVIDER_LANE_FAILURE_CODES`(정본 `providerLane.ts`). 목록 파일은 골든과 같은 순서이고, 같은지 시험이 본다.
    pub const PROVIDER_LANE_FAILURE_CODES: &[&str] = &include!("provider_lane_failure_codes.in");
}

/// P2 — 오퍼레이터 ↔ 서버 WS 프레임.
pub mod p2 {
    use super::Value;
    use serde::{Deserialize, Serialize};

    #[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
    #[serde(rename_all = "camelCase")]
    pub struct RunnerAnnounce {
        pub agent_id: String,
        pub runner_id: String,
        pub pid: i64,
    }

    #[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
    #[serde(rename_all = "lowercase")]
    pub enum CredentialScope {
        Personal,
        Community,
        None,
    }

    /// 서버가 오퍼레이터에 맡기는 에이전트 정의.
    #[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
    #[serde(rename_all = "camelCase")]
    pub struct AgentDefinition {
        pub agent_id: String,
        pub handle: String,
        pub harness: String,
        pub instructions: String,
        pub model: Option<String>,
        pub effort: Option<String>,
        pub mention_permission: String,
        pub working_dir_default: Option<String>,
        pub credential_scope: CredentialScope,
        pub owner_account_id: Option<String>,
        pub mcp_servers: Vec<String>,
    }

    /// `protocol: 1` 만 받는 표지.
    #[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
    #[serde(try_from = "u32", into = "u32")]
    pub struct ProtocolOne;
    impl TryFrom<u32> for ProtocolOne {
        type Error = String;
        fn try_from(v: u32) -> Result<Self, Self::Error> {
            if v == 1 {
                Ok(ProtocolOne)
            } else {
                Err(format!("operator protocol {v}"))
            }
        }
    }
    impl From<ProtocolOne> for u32 {
        fn from(_: ProtocolOne) -> u32 {
            1
        }
    }

    #[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
    #[serde(tag = "type")]
    pub enum OperatorToServerFrame {
        #[serde(rename = "hello")]
        Hello {
            protocol: ProtocolOne,
            capabilities: Value,
            runners: Vec<RunnerAnnounce>,
            sessions: Vec<Value>,
            #[serde(default, skip_serializing_if = "Option::is_none")]
            version: Option<String>,
        },
        #[serde(rename = "runner.started", rename_all = "camelCase")]
        RunnerStarted { agent_id: String, runner_id: String },
        #[serde(rename = "runner.exited", rename_all = "camelCase")]
        RunnerExited {
            runner_id: String,
            code: Option<i64>,
            #[serde(default, skip_serializing_if = "Option::is_none")]
            reason: Option<String>,
            #[serde(default, skip_serializing_if = "Option::is_none")]
            agent_id: Option<String>,
        },
        #[serde(rename = "capabilities")]
        Capabilities { capabilities: Value },
        #[serde(rename = "status")]
        Status {
            status: Value,
            #[serde(
                default,
                skip_serializing_if = "Option::is_none",
                with = "super::double_option"
            )]
            machine: Option<Option<Value>>,
        },
        #[serde(rename = "upgrade.progress")]
        UpgradeProgress {
            stage: Value,
            #[serde(
                default,
                skip_serializing_if = "Option::is_none",
                with = "super::double_option"
            )]
            from: Option<Option<Value>>,
            #[serde(
                default,
                skip_serializing_if = "Option::is_none",
                with = "super::double_option"
            )]
            to: Option<Option<Value>>,
            #[serde(
                default,
                skip_serializing_if = "Option::is_none",
                with = "super::double_option"
            )]
            error: Option<Option<Value>>,
        },
        #[serde(rename = "gh.report")]
        GhReport { report: Value },
        #[serde(rename = "gh.lines.result", rename_all = "camelCase")]
        GhLinesResult {
            request_id: Value,
            ok: Value,
            #[serde(
                default,
                skip_serializing_if = "Option::is_none",
                with = "super::double_option"
            )]
            code: Option<Option<Value>>,
            #[serde(
                default,
                skip_serializing_if = "Option::is_none",
                with = "super::double_option"
            )]
            previous: Option<Option<Value>>,
        },
        #[serde(rename = "runner.announce", rename_all = "camelCase")]
        RunnerAnnounce {
            runner_id: String,
            sessions: Vec<Value>,
            #[serde(default, skip_serializing_if = "Option::is_none")]
            caps: Option<Vec<Value>>,
        },
        #[serde(rename = "session.started", rename_all = "camelCase")]
        SessionStarted { runner_id: String, session: Value },
        #[serde(rename = "session.updated", rename_all = "camelCase")]
        SessionUpdated { runner_id: String, session: Value },
        #[serde(rename = "session.ended", rename_all = "camelCase")]
        SessionEnded {
            runner_id: String,
            session_id: String,
        },
        /// `bytes` 는 base64 다(중계 구간은 디코드하지 않는다).
        #[serde(rename = "pty.output", rename_all = "camelCase")]
        PtyOutput {
            runner_id: String,
            session_id: String,
            bytes: String,
        },
        #[serde(rename = "pty.replay", rename_all = "camelCase")]
        PtyReplay {
            runner_id: String,
            session_id: String,
            bytes: String,
        },
        #[serde(rename = "interactive.opened", rename_all = "camelCase")]
        InteractiveOpened {
            runner_id: String,
            request_id: String,
            session_id: String,
            created: bool,
        },
        #[serde(rename = "interactive.error", rename_all = "camelCase")]
        InteractiveError {
            runner_id: String,
            request_id: String,
            message: String,
        },
        #[serde(rename = "attention.required", rename_all = "camelCase")]
        AttentionRequired {
            runner_id: String,
            session_id: String,
            account_label: String,
            screen: String,
        },
        #[serde(rename = "local.input", rename_all = "camelCase")]
        LocalInput {
            runner_id: String,
            session_id: String,
            r#gen: i64,
            bytes: i64,
        },
    }

    /// 정본의 `OPERATOR_TYPES`.
    pub const OPERATOR_TO_SERVER_TYPES: [&str; 18] = [
        "hello",
        "capabilities",
        "runner.started",
        "runner.exited",
        "runner.announce",
        "session.started",
        "session.updated",
        "session.ended",
        "pty.output",
        "pty.replay",
        "interactive.opened",
        "interactive.error",
        "attention.required",
        "status",
        "upgrade.progress",
        "local.input",
        "gh.report",
        "gh.lines.result",
    ];

    #[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
    #[serde(tag = "type")]
    pub enum ServerToOperatorFrame {
        #[serde(rename = "assign", rename_all = "camelCase")]
        Assign {
            agent_id: String,
            definition: AgentDefinition,
        },
        #[serde(rename = "unassign", rename_all = "camelCase")]
        Unassign { agent_id: String, drain: bool },
        /// hello 뒤 배정 재전송 묶음의 끝 — `agent_ids` 는 그 묶음에 보낸 에이전트 전부(「남길 것」으로만 쓴다).
        #[serde(rename = "assign.synced", rename_all = "camelCase")]
        AssignSynced { agent_ids: Vec<String> },
        #[serde(rename = "agent.restart", rename_all = "camelCase")]
        AgentRestart { agent_id: String },
        #[serde(rename = "runner.kill", rename_all = "camelCase")]
        RunnerKill { runner_id: String },
        #[serde(rename = "pty.replay.request", rename_all = "camelCase")]
        PtyReplayRequest {
            runner_id: String,
            session_id: String,
        },
        #[serde(rename = "pty.input", rename_all = "camelCase")]
        PtyInput {
            runner_id: String,
            session_id: String,
            bytes: String,
        },
        #[serde(rename = "pty.resize", rename_all = "camelCase")]
        PtyResize {
            runner_id: String,
            session_id: String,
            cols: u16,
            rows: u16,
        },
        #[serde(rename = "viewer.count", rename_all = "camelCase")]
        ViewerCount {
            runner_id: String,
            session_id: String,
            count: i64,
        },
        #[serde(rename = "session.cancel", rename_all = "camelCase")]
        SessionCancel {
            runner_id: String,
            session_id: String,
            by_handle: String,
        },
        #[serde(rename = "interactive.open", rename_all = "camelCase")]
        InteractiveOpen {
            runner_id: String,
            request_id: String,
            channel_id: String,
            thread_root_id: String,
            opened_by_handle: String,
            #[serde(default, skip_serializing_if = "Option::is_none")]
            cols: Option<u16>,
            #[serde(default, skip_serializing_if = "Option::is_none")]
            rows: Option<u16>,
        },
        #[serde(rename = "local.writer", rename_all = "camelCase")]
        LocalWriter {
            runner_id: String,
            session_id: String,
            writer_key: Option<String>,
            r#gen: i64,
        },
        #[serde(rename = "local.view", rename_all = "camelCase")]
        LocalView {
            runner_id: String,
            session_id: String,
            view_key: String,
            granted: bool,
        },
        #[serde(rename = "gh.lines.set", rename_all = "camelCase")]
        GhLinesSet {
            request_id: String,
            scope: String,
            gh_user: Option<String>,
        },
    }

    /// 정본의 `SERVER_TYPES`.
    pub const SERVER_TO_OPERATOR_TYPES: [&str; 14] = [
        "assign",
        "unassign",
        "assign.synced",
        "agent.restart",
        "runner.kill",
        "pty.replay.request",
        "pty.input",
        "pty.resize",
        "viewer.count",
        "session.cancel",
        "interactive.open",
        "local.writer",
        "local.view",
        "gh.lines.set",
    ];
}

/// P3 — 앱(Tauri) ↔ 오퍼레이터 소켓의 봉투(NDJSON — 줄마다 JSON 하나, 한 줄 상한 [`p3::MAX_LINE_BYTES`]).
pub mod p3 {
    use super::Value;
    use serde::{Deserialize, Serialize};

    pub const DAEMON_PROTOCOL_VERSION: u32 = 1;
    pub const MAX_LINE_BYTES: usize = 1024 * 1024;

    literal!(HelloTag, "hello");
    literal!(AppRole, "app");
    literal!(EventTag, "event");

    #[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
    pub struct HelloMessage {
        #[serde(rename = "type")]
        pub ty: HelloTag,
        pub version: u32,
        pub token: String,
        pub role: AppRole,
    }

    #[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
    #[serde(rename_all = "camelCase")]
    pub struct DaemonIdentity {
        pub pid: i64,
        pub started_at_ms: i64,
        pub launch_nonce: String,
        pub entry_path: String,
        pub app_version: String,
    }

    #[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
    #[serde(rename_all = "kebab-case")]
    pub enum DaemonErrorCode {
        LineTooLong,
        InvalidJson,
        VersionMismatch,
        Unauthorized,
        NotAuthenticated,
        UnknownRequest,
        BadPayload,
        NoSuchRunner,
        Retiring,
        Internal,
    }

    pub const DAEMON_ERROR_CODES: [DaemonErrorCode; 10] = [
        DaemonErrorCode::LineTooLong,
        DaemonErrorCode::InvalidJson,
        DaemonErrorCode::VersionMismatch,
        DaemonErrorCode::Unauthorized,
        DaemonErrorCode::NotAuthenticated,
        DaemonErrorCode::UnknownRequest,
        DaemonErrorCode::BadPayload,
        DaemonErrorCode::NoSuchRunner,
        DaemonErrorCode::Retiring,
        DaemonErrorCode::Internal,
    ];

    #[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
    pub struct DaemonError {
        pub code: DaemonErrorCode,
        pub message: String,
    }

    #[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
    #[serde(untagged)]
    pub enum HelloResult {
        Ok {
            ok: super::True,
            daemon: DaemonIdentity,
        },
        Err {
            ok: super::False,
            error: DaemonError,
        },
    }

    /// `type` 은 [`REQUEST_TYPES`] 중 하나다. 요청별 payload 는 아직 JSON 값이다.
    #[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
    pub struct DaemonRequest {
        pub id: String,
        #[serde(rename = "type")]
        pub ty: String,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        pub payload: Option<Value>,
    }

    #[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
    pub struct DaemonResponse {
        pub id: String,
        pub ok: bool,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        pub payload: Option<Value>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        pub error: Option<DaemonError>,
    }

    /// `event` 는 [`EVENT_NAMES`] 중 하나다.
    #[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
    pub struct DaemonEventMessage {
        #[serde(rename = "type")]
        pub ty: EventTag,
        pub event: String,
        pub payload: Value,
    }

    pub const EVENT_NAMES: [&str; 5] = [
        "runnerExit",
        "claudeLoginOutput",
        "codexLoginOutput",
        "terminalOutput",
        "terminalEnded",
    ];

    /// 정본 `REQUEST_TYPES` 의 순서 그대로(목록 파일은 골든에서 옮겼고, 같은지 시험이 본다).
    pub const REQUEST_TYPES: &[&str] = &include!("request_types.in");
}

/// P4 — `harkroom-operator merge <owner/name> <n> --head <sha>` 의 한 줄 JSON 출력. 에이전트 지시문과 허용 규칙이 이 키에 기댄다.
pub mod p4 {
    use super::Value;
    use serde::{Deserialize, Serialize};

    #[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
    #[serde(rename_all = "camelCase")]
    pub struct MergeError {
        pub code: String,
        pub message: String,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        pub denial_id: Option<String>,
    }

    /// 지시문이 읽는 키만 타입으로 둔다. 나머지(`grantedBy`·`queue`·`pr`·`prHeadRefOid`·`raw`…)는 `rest` 에 그대로 남아 왕복한다.
    #[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
    #[serde(rename_all = "camelCase")]
    pub struct MergeOutput {
        pub merged: bool,
        /// 프로세스 종료 코드와 같다: 0 성공·1 거절·2 인자/환경 오류.
        pub exit: i32,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        pub error: Option<MergeError>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        pub queued: Option<bool>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        pub already_queued: Option<bool>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        pub repo: Option<String>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        pub number: Option<u64>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        pub head_sha: Option<String>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        pub ignored_checks: Option<Vec<String>>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        pub no_pr_checks: Option<bool>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        pub note: Option<String>,
        #[serde(flatten)]
        pub rest: serde_json::Map<String, Value>,
    }
}

/// JSON `true` 만 받는 표지.
#[derive(Debug, Clone, Copy, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
#[serde(try_from = "bool", into = "bool")]
pub struct True;
impl TryFrom<bool> for True {
    type Error = &'static str;
    fn try_from(v: bool) -> Result<Self, Self::Error> {
        if v { Ok(True) } else { Err("expected true") }
    }
}
impl From<True> for bool {
    fn from(_: True) -> bool {
        true
    }
}

/// JSON `false` 만 받는 표지.
#[derive(Debug, Clone, Copy, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
#[serde(try_from = "bool", into = "bool")]
pub struct False;
impl TryFrom<bool> for False {
    type Error = &'static str;
    fn try_from(v: bool) -> Result<Self, Self::Error> {
        if v { Err("expected false") } else { Ok(False) }
    }
}
impl From<False> for bool {
    fn from(_: False) -> bool {
        false
    }
}
