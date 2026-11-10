//! 정본(TS) 표본을 파싱 → 다시 직렬화해 원본과 같은지 — `golden/proto.json` 은 `packages/shared/test/protoGolden.test.ts` 가 쓴다.
use harkroom_proto::*;
use serde::{Serialize, de::DeserializeOwned};
use std::collections::BTreeSet;

fn golden() -> Value {
    let p = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("golden/proto.json");
    serde_json::from_str(&std::fs::read_to_string(p).unwrap()).unwrap()
}

/// 표본 하나하나가 이 Rust 타입으로 읽히고, 다시 쓰면 한 글자도 다르지 않은 JSON 값이 된다.
fn round_trip<T: DeserializeOwned + Serialize>(samples: &Value, what: &str) -> usize {
    let arr = samples
        .as_array()
        .unwrap_or_else(|| panic!("{what}: 표본 배열이 없다"));
    assert!(!arr.is_empty(), "{what}: 표본이 비었다");
    for s in arr {
        let parsed: T = serde_json::from_value(s.clone())
            .unwrap_or_else(|e| panic!("{what}: 못 읽었다 {e}\n{s}"));
        let back = serde_json::to_value(&parsed).unwrap();
        assert_eq!(&back, s, "{what}: 왕복이 원본과 다르다");
    }
    arr.len()
}

fn types_of(samples: &Value) -> BTreeSet<String> {
    samples
        .as_array()
        .unwrap()
        .iter()
        .map(|s| s["type"].as_str().unwrap().to_string())
        .collect()
}

#[test]
fn constants_match_ts() {
    let c = &golden()["constants"];
    assert_eq!(
        c["runnerLinkProtocolVersion"],
        p1::RUNNER_LINK_PROTOCOL_VERSION
    );
    assert_eq!(c["daemonProtocolVersion"], p3::DAEMON_PROTOCOL_VERSION);
    assert_eq!(c["maxLineBytes"], p3::MAX_LINE_BYTES);
    assert_eq!(
        c["requestTypes"],
        serde_json::to_value(p3::REQUEST_TYPES).unwrap()
    );
    assert_eq!(
        c["eventNames"],
        serde_json::to_value(p3::EVENT_NAMES).unwrap()
    );
    assert_eq!(
        c["daemonErrorCodes"],
        serde_json::to_value(p3::DAEMON_ERROR_CODES).unwrap()
    );
    assert_eq!(
        c["providerLaneFailureCodes"],
        serde_json::to_value(p1::PROVIDER_LANE_FAILURE_CODES).unwrap()
    );
}

#[test]
fn p1_runner_link_round_trips() {
    let g = &golden()["p1"];
    round_trip::<p1::RunnerHello>(&g["hello"], "p1.hello");
    round_trip::<p1::RunnerLinkRequest>(&g["request"], "p1.request");
    round_trip::<p1::RunnerLinkResponse>(&g["response"], "p1.response");
    round_trip::<p1::RunnerLinkNotice>(&g["notice"], "p1.notice");
    round_trip::<p1::OperatorToRunnerNotice>(&g["operatorNotice"], "p1.operatorNotice");
    round_trip::<p1::RunnerLinkRejected>(&g["rejected"], "p1.rejected");
    // 표본이 모든 변종을 덮는다 — TS 에 변종을 더하고 표본을 안 더하면 여기서 안다.
    let want: BTreeSet<String> = p1::RUNNER_LINK_NOTICE_TYPES
        .iter()
        .map(|s| s.to_string())
        .collect();
    assert_eq!(types_of(&g["notice"]), want);
    assert_eq!(
        types_of(&g["request"]),
        ["http.forward", "mcp.request"].map(String::from).into()
    );
    assert_eq!(
        types_of(&g["response"]),
        ["http.response", "mcp.error", "mcp.response"]
            .map(String::from)
            .into()
    );
}

#[test]
fn p2_operator_ws_round_trips_and_covers_every_frame() {
    let g = &golden()["p2"];
    round_trip::<p2::OperatorToServerFrame>(&g["operatorToServer"], "p2.operatorToServer");
    round_trip::<p2::ServerToOperatorFrame>(&g["serverToOperator"], "p2.serverToOperator");
    let up: BTreeSet<String> = p2::OPERATOR_TO_SERVER_TYPES
        .iter()
        .map(|s| s.to_string())
        .collect();
    let down: BTreeSet<String> = p2::SERVER_TO_OPERATOR_TYPES
        .iter()
        .map(|s| s.to_string())
        .collect();
    assert_eq!(types_of(&g["operatorToServer"]), up);
    assert_eq!(types_of(&g["serverToOperator"]), down);
}

#[test]
fn p3_app_socket_envelope_round_trips() {
    let g = &golden()["p3"];
    round_trip::<p3::HelloMessage>(&g["hello"], "p3.hello");
    round_trip::<p3::HelloResult>(&g["helloResult"], "p3.helloResult");
    round_trip::<p3::DaemonRequest>(&g["request"], "p3.request");
    round_trip::<p3::DaemonResponse>(&g["response"], "p3.response");
    round_trip::<p3::DaemonEventMessage>(&g["event"], "p3.event");
    for r in g["request"].as_array().unwrap() {
        assert!(p3::REQUEST_TYPES.contains(&r["type"].as_str().unwrap()));
    }
    for e in g["event"].as_array().unwrap() {
        assert!(p3::EVENT_NAMES.contains(&e["event"].as_str().unwrap()));
    }
}

#[test]
fn p4_merge_cli_output_round_trips() {
    let g = &golden()["p4"];
    round_trip::<p4::MergeOutput>(&g["mergeOutput"], "p4.mergeOutput");
    // 지시문이 읽는 갈래: 거절이면 denialId 가 error 안에 있다.
    let denied: p4::MergeOutput = serde_json::from_value(g["mergeOutput"][4].clone()).unwrap();
    assert!(!denied.merged && denied.exit == 1 && denied.error.unwrap().denial_id.is_some());
}

#[test]
fn wrong_literals_are_refused() {
    assert!(
        serde_json::from_value::<p1::RunnerHello>(
            serde_json::json!({"type":"hi","version":1,"role":"runner","runnerId":"r"})
        )
        .is_err()
    );
    assert!(serde_json::from_value::<p2::OperatorToServerFrame>(serde_json::json!({"type":"hello","protocol":2,"capabilities":{},"runners":[],"sessions":[]})).is_err());
    assert!(
        serde_json::from_value::<p3::DaemonError>(serde_json::json!({"code":"nope","message":""}))
            .is_err()
    );
}
