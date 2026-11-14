//! [`report_promise`]·[`system_inputs`] — 보고처 약속은 그 멘션의 예약 깨움에서만, 머지 승인은 그 스레드 것만.
use serde_json::json;

use super::*;
use crate::mention_scheduler::{WakeReportTo, WakeTarget};
use crate::rest::MergeApproval;
use crate::thread_model::{AxisSource, TurnModelSource};

fn target(wake: Option<TargetWake>) -> MentionTarget {
    MentionTarget {
        channel_id: "c".into(),
        thread_root_id: "root".into(),
        mention_id: "m".into(),
        mention_row: json!({}),
        bundled_rows: vec![],
        wake,
        canceled_wakes: vec![],
        started_in: None,
        team: None,
        delegation: None,
        delegation_followup: None,
        delegation_update: None,
        delegations: vec![],
        delegated_by: None,
        edited_mention: None,
    }
}

fn scheduled(report: bool, seq: Option<i64>) -> TargetWake {
    TargetWake::Scheduled(WakeTarget {
        reason: "CI 확인".into(),
        report_to: report.then(|| WakeReportTo {
            channel_id: "c2".into(),
            thread_root_id: "r2".into(),
        }),
        scheduled_seq: seq,
        scheduled_turn_id: Some("t-prev".into()),
        watch: false,
        origin: None,
    })
}

#[test]
fn promise_only_from_this_mentions_scheduled_wake() {
    let p = report_promise(&target(Some(scheduled(true, Some(42))))).unwrap();
    assert_eq!(p.report_to.thread_root_id, "r2");
    assert_eq!((p.base_seq, p.reason.as_str()), (42, "CI 확인"));
    assert_eq!(p.scheduled_turn_id.as_deref(), Some("t-prev"));
    assert_eq!(report_promise(&target(None)), None, "깨움이 아니면 없다");
    assert_eq!(
        report_promise(&target(Some(scheduled(false, Some(42))))),
        None,
        "보고처 없음"
    );
    assert_eq!(
        report_promise(&target(Some(scheduled(true, None)))),
        None,
        "예약 seq 없으면 판정을 접는다"
    );
    assert_eq!(
        report_promise(&target(Some(TargetWake::AskClosed("x")))),
        None,
        "카드 깨움은 아니다"
    );
}

fn reads() -> MentionReads {
    MentionReads {
        def: json!({"instructions": "지시", "mentionPermission": "auto"}),
        guide: "가이드".into(),
        merge: MergeGrantInfo {
            repos: vec!["o/a".into()],
            approvals: vec![
                MergeApproval {
                    repo: "o/b".into(),
                    number: 7,
                    channel_id: "c".into(),
                    thread_root_id: "root".into(),
                },
                MergeApproval {
                    repo: "o/x".into(),
                    number: 9,
                    channel_id: "c".into(),
                    thread_root_id: "other".into(),
                },
            ],
        },
        api: ApiGrantInfo::default(),
        secret_create: true,
        rules: ToolRuleSets::default(),
        turn_model: TurnModel {
            model: None,
            effort: None,
            source: TurnModelSource {
                model: AxisSource::Agent,
                effort: AxisSource::Agent,
            },
        },
    }
}

#[test]
fn merge_approvals_are_this_threads_only() {
    let s = system_inputs(
        &reads(),
        &target(None),
        SystemContext {
            handle: "h".into(),
            channel_name: "task".into(),
            memory: MemoryContext::Unavailable,
            operator_bin: "/bin/op",
            harness: AgentHarness::ClaudeCode,
            command_hook: false,
            post_tool_hook: false,
            lane: false,
            lane_model: None,
            turn_budget_ms: 1_800_000,
        },
    );
    let m = s.merge.unwrap();
    assert_eq!(m.repos, vec!["o/a".to_string(), "o/b".to_string()]);
    assert_eq!(m.approved.len(), 1, "다른 스레드 승인은 싣지 않는다");
    assert_eq!(m.approved[0].repo, "o/b");
    assert_eq!(
        (s.instructions.as_str(), s.secret_create, s.read_only),
        ("지시", true, false)
    );
}

/// 명령 전체 규칙만 열리는 문장은 **lane 턴이면** 붙는다 — 모델 id 가 비어도(정본 `Boolean(deps.providerEnv) && usesXdgHome`).
#[test]
fn exact_shell_only_follows_lane_not_model_id() {
    let ctx = |harness, lane, lane_model: Option<&str>| SystemContext {
        handle: "h".into(),
        channel_name: "task".into(),
        memory: MemoryContext::Unavailable,
        operator_bin: "/bin/op",
        harness,
        command_hook: false,
        post_tool_hook: false,
        lane,
        lane_model: lane_model.map(str::to_string),
        turn_budget_ms: 1_800_000,
    };
    let exact = |c| {
        system_inputs(&reads(), &target(None), c)
            .permissions
            .unwrap()
            .exact_shell_only
    };
    assert!(
        exact(ctx(AgentHarness::Opencode, true, None)),
        "lane·모델 없음"
    );
    assert!(
        exact(ctx(AgentHarness::Opencode, true, Some("harkroom-lane/m"))),
        "lane·모델 있음"
    );
    assert!(
        !exact(ctx(AgentHarness::Opencode, false, None)),
        "기본 로그인"
    );
    assert!(
        !exact(ctx(AgentHarness::ClaudeCode, true, None)),
        "xdg 아닌 하네스"
    );
}
