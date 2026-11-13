use super::*;
use serde_json::json;

type Fetch = Box<dyn FnOnce(&str) -> Result<Value, String>>;

fn run(fetch: Option<Fetch>, id: Option<&str>) -> (TurnModel, Vec<String>) {
    let mut lines = Vec::new();
    let got = resolve_turn_model(fetch, Some("sonnet"), Some("medium"), id, &mut |l| {
        lines.push(l)
    });
    (got, lines)
}

fn src(m: AxisSource, e: AxisSource) -> TurnModelSource {
    TurnModelSource {
        model: m,
        effort: e,
    }
}

#[test]
fn uses_server_value_as_is() {
    let (got, lines) = run(
        Some(Box::new(|id| {
            assert_eq!(id, "m1");
            Ok(
                json!({"model":"opus","effort":"medium","source":{"model":"thread","effort":"agent"}}),
            )
        })),
        Some("m1"),
    );
    assert_eq!(got.model.as_deref(), Some("opus"));
    assert_eq!(got.source, src(AxisSource::Thread, AxisSource::Agent));
    assert!(uses_thread_model(Some(&got)));
    assert!(lines.is_empty());
}

#[test]
fn falls_back_on_error_and_logs() {
    let (got, lines) = run(
        Some(Box::new(|_| Err("agent/thread-model 실패: 404".into()))),
        Some("m1"),
    );
    assert_eq!(got.model.as_deref(), Some("sonnet"));
    assert_eq!(got.effort.as_deref(), Some("medium"));
    assert!(!uses_thread_model(Some(&got)));
    assert!(lines[0].contains("404"));
}

#[test]
fn falls_back_on_malformed_body() {
    let (got, lines) = run(Some(Box::new(|_| Ok(json!({"model": 3})))), Some("m1"));
    assert_eq!(got.source, src(AxisSource::Agent, AxisSource::Agent));
    assert_eq!(lines.len(), 1);
}

#[test]
fn unsafe_thread_axis_falls_back_per_axis() {
    let (got, lines) = run(
        Some(Box::new(|_| {
            Ok(
                json!({"model":"--dangerously-skip-permissions","effort":"high","source":{"model":"thread","effort":"thread"}}),
            )
        })),
        Some("m1"),
    );
    assert_eq!(got.model.as_deref(), Some("sonnet"));
    assert_eq!(got.effort.as_deref(), Some("high"));
    assert_eq!(got.source, src(AxisSource::Agent, AxisSource::Thread));
    assert_eq!(lines.len(), 1);
}

#[test]
fn null_thread_axis_and_brackets_pass() {
    let (got, lines) = run(
        Some(Box::new(|_| {
            Ok(
                json!({"model":"claude-opus-5-5[1m]","effort":null,"source":{"model":"thread","effort":"thread"}}),
            )
        })),
        Some("m1"),
    );
    assert_eq!(got.model.as_deref(), Some("claude-opus-5-5[1m]"));
    assert_eq!(got.effort, None);
    assert!(lines.is_empty());
}

#[test]
fn no_anchor_or_no_source_does_not_ask() {
    let (got, _) = run(Some(Box::new(|_| panic!("부르면 안 된다"))), None);
    assert_eq!(got.model.as_deref(), Some("sonnet"));
    let (got, _) = run(None, Some("m1"));
    assert_eq!(got.source, src(AxisSource::Agent, AxisSource::Agent));
}

#[test]
fn root_from_key() {
    assert_eq!(root_from_thread_key("c1/r1"), Some("r1"));
    assert_eq!(root_from_thread_key("c1/_root"), None);
    assert_eq!(root_from_thread_key("c1/"), None);
}

/// 턴 연결 nit ②(#1982): 서버가 `source: agent` 로 돌려준 값도 argv 로 가므로 모양을 본다 — 틀리면 에이전트 설정 값으로.
#[test]
fn unsafe_agent_axis_also_falls_back() {
    let (got, lines) = run(
        Some(Box::new(|_| {
            Ok(json!({"model":"--yolo","effort":"-x","source":{"model":"agent","effort":"agent"}}))
        })),
        Some("m1"),
    );
    assert_eq!(got.model.as_deref(), Some("sonnet"));
    assert_eq!(got.effort.as_deref(), Some("medium"));
    assert_eq!(got.source, src(AxisSource::Agent, AxisSource::Agent));
    assert_eq!(lines.len(), 1);
}
