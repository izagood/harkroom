use std::cell::RefCell;
use std::path::PathBuf;

use harkroom_proto::p1::RunnerLinkResponse;

use super::*;
use crate::account_assign::shared::read_account_blocked;
use crate::account_failover::AccountFailureKind;
use crate::link::LinkRequest;
use crate::mention_settle::FailBody;

#[derive(Default)]
struct Io {
    fails: Vec<(String, String, Option<String>, FailOpts)>,
    read: Vec<Vec<i64>>,
    lease: Option<LeaseOutcome>,
}
impl MentionIo for &mut Io {
    fn fail(&mut self, c: &str, b: &str, a: Option<&str>, o: &FailOpts) -> Result<(), String> {
        self.fails
            .push((c.into(), b.into(), a.map(str::to_string), o.clone()));
        Ok(())
    }
    fn mark_read(&mut self, ids: &[i64]) -> Result<(), String> {
        self.read.push(ids.to_vec());
        Ok(())
    }
    fn issue_lease(&mut self, _cause: &str) -> LeaseOutcome {
        self.lease.take().unwrap_or(LeaseOutcome::None)
    }
}

#[derive(Default)]
struct Hooks {
    events: Vec<String>,
}
impl MentionHooks for &mut Hooks {
    fn now(&self) -> u64 {
        1_000
    }
    fn lease_issued(&mut self, cause: &str, lease: TurnLease) {
        self.events.push(format!("lease {cause} {}", lease.id));
    }
    fn release_lease(&mut self) {
        self.events.push("release_lease".into());
    }
    fn notice_fenced(&mut self) {}
    fn turn_outcome(&mut self, ok: bool) {
        self.events.push(format!("outcome {ok}"));
    }
    fn stop_requested(&mut self, _at: &str) {}
    fn executable_missing(&mut self) {
        self.events.push("executable_missing".into());
    }
    fn release_slot(&mut self, k: &str) {
        self.events.push(format!("slot {k}"));
    }
    fn turn_ended(&mut self, k: &str, m: &str) {
        self.events.push(format!("ended {k} {m}"));
    }
    fn log(&mut self, l: &str) {
        self.events.push(format!("log {l}"));
    }
}

fn deps<'a>(io: &'a mut Io, h: &'a mut Hooks) -> MentionDeps<'a, &'a mut Io, &'a mut Hooks> {
    MentionDeps::new(
        io,
        h,
        "c1".into(),
        Some("root".into()),
        "m1".into(),
        Box::new(|_, _| vec![None]),
    )
}

/// 실패 통지: 정해진 문장 + 계정 축 흔적(이름 없이 순번), reason 은 흔적 한 줄, 멘션 id 를 싣는다.
#[test]
fn fail_posts_fixed_text_with_trail_without_names() {
    let (mut io, mut h) = (Io::default(), Hooks::default());
    {
        let mut d = deps(&mut io, &mut h);
        d.account_trail(&[AccountFailure {
            account: Some("alice-personal".into()),
            kind: AccountFailureKind::Quota,
            resets_at: None,
        }]);
        d.fail(&FailNotice {
            body: FailBody::GaveUp,
            retryable: false,
            what: "w".into(),
            reason: None,
            code: None,
            lane_code: None,
        })
        .unwrap();
    }
    let (c, body, anchor, opts) = &io.fails[0];
    assert_eq!((c.as_str(), anchor.as_deref()), ("c1", Some("root")));
    assert!(body.contains("계정 1"), "{body}");
    assert!(!body.contains("alice"), "계정 이름은 싣지 않는다: {body}");
    assert!(!opts.reason.as_deref().unwrap().contains("alice"));
    assert_eq!(opts.mention_id.as_deref(), Some("m1"));
}

fn acct(dir: &std::path::Path) -> ClaudeAccount {
    ClaudeAccount {
        name: "a".into(),
        config_dir: dir.to_path_buf(),
        pool: None,
    }
}

/// 표식: 세우기·지우기가 그 계정 config 폴더의 표식 파일로 간다(관문·로그인 따로) · Keep 은 아무것도 안 한다.
#[test]
fn attention_and_auth_marks_go_to_marker_files() {
    let dir: PathBuf = std::env::temp_dir().join(format!("hk-mdeps-{}", std::process::id()));
    let _ = std::fs::remove_dir_all(&dir);
    std::fs::create_dir_all(&dir).unwrap();
    let a = acct(&dir);
    let (mut io, mut h) = (Io::default(), Hooks::default());
    let mut d = deps(&mut io, &mut h);
    d.attention(&a, Mark::Keep);
    assert!(read_account_blocked(&dir).is_none());
    d.auth(&a, Mark::Set);
    assert_eq!(read_account_blocked(&dir).unwrap().at_ms, 1_000.0);
    d.attention(&a, Mark::Set);
    d.attention(&a, Mark::Clear);
    d.auth(&a, Mark::Clear);
    assert!(read_account_blocked(&dir).is_none());
    let _ = std::fs::remove_dir_all(&dir);
}

/// 임대: 결과를 상태로만 접는다 · 받은 임대는 lease_issued 로만.
#[test]
fn lease_outcomes_fold_to_state() {
    for (out, want) in [
        (LeaseOutcome::LeaseUsed, LeaseState::LeaseUsed),
        (LeaseOutcome::Unreachable, LeaseState::Unreachable),
        (LeaseOutcome::None, LeaseState::Declined),
    ] {
        let (mut io, mut h) = (
            Io {
                lease: Some(out),
                ..Io::default()
            },
            Hooks::default(),
        );
        assert_eq!(deps(&mut io, &mut h).acquire_lease("m1"), want);
    }
    let (mut io, mut h) = (
        Io {
            lease: Some(LeaseOutcome::Lease(TurnLease {
                id: "L1".into(),
                token: "tok".into(),
                expires_at: "x".into(),
                delegation_recall: false,
            })),
            ..Io::default()
        },
        Hooks::default(),
    );
    assert_eq!(deps(&mut io, &mut h).acquire_lease("m1"), LeaseState::Ready);
    assert_eq!(h.events, ["lease m1 L1"]);
}

struct ErrLink;
impl RunnerLink for &ErrLink {
    fn request(&self, _req: LinkRequest) -> RunnerLinkResponse {
        RunnerLinkResponse::HttpResponse {
            id: "x".into(),
            status: 500,
            body: r#"{"error":{"code":"boom","message":"SECRET_BODY_TEXT sk-live-aaaaaaaaaaaaaaaaaaaaaaaa"}}"#
                .into(),
        }
    }
}

/// security: 턴 임대 REST 오류의 응답 원문은 로그·상태 어디에도 실리지 않는다(상태·접힌 코드만).
#[test]
fn lease_rest_error_body_never_leaks() {
    let link = ErrLink;
    let rest = HarkroomRestClient::new(&link);
    let mcp = HarkroomMcpClient::new(&link, "t");
    let lines: RefCell<Vec<String>> = RefCell::default();
    let log = |l: &str| lines.borrow_mut().push(l.to_string());
    let io = LinkIo {
        mcp: &mcp,
        rest: &rest,
        claim_holder: None,
        thread_key: None,
        log: &log,
    };
    let mut h = Hooks::default();
    let st = {
        let mut d = MentionDeps::new(
            io,
            &mut h,
            "c1".into(),
            None,
            "m1".into(),
            Box::new(|_, _| vec![None]),
        );
        d.acquire_lease("m1")
    };
    assert_eq!(st, LeaseState::Unreachable);
    let all = lines.borrow().join("\n");
    assert!(
        !all.contains("SECRET_BODY_TEXT") && !all.contains("sk-live"),
        "{all}"
    );
    assert!(h.events.is_empty());
}

struct WorkLink(std::sync::Mutex<Vec<(String, Option<String>)>>);
impl RunnerLink for &WorkLink {
    fn request(&self, req: LinkRequest) -> RunnerLinkResponse {
        let (path, body) = match &req {
            LinkRequest::Http { path, body, .. } => (path.clone(), body.clone()),
            _ => (String::new(), None),
        };
        let answer = if path == "/agent/turn-slots" {
            r#"{"max":4,"inUse":1,"work":{"workId":"w1","attempts":3}}"#
        } else {
            r#"{"leaseId":"L1","token":"example-token","expiresAt":"2026-01-01T00:00:00.000Z"}"#
        };
        self.0.lock().unwrap().push((path, body));
        RunnerLinkResponse::HttpResponse {
            id: "x".into(),
            status: 200,
            body: answer.into(),
        }
    }
}

/// I2d — 턴 칸을 받을 때 넘겨받은 쥔 줄은 **그 스레드 키의** 임대 발급에만 실린다.
#[test]
fn lease_request_carries_the_work_handed_with_the_slot_of_that_thread() {
    let link = WorkLink(std::sync::Mutex::default());
    let rest = HarkroomRestClient::new(&link);
    let mcp = HarkroomMcpClient::new(&link, "t");
    let log = |_: &str| {};
    rest.acquire_turn_slot("c1/t1", None);
    let lease_body = |key: Option<&str>| {
        let mut io = LinkIo {
            mcp: &mcp,
            rest: &rest,
            claim_holder: None,
            thread_key: key,
            log: &log,
        };
        io.issue_lease("m1");
        let seen = link.0.lock().unwrap();
        let (path, body) = seen.last().unwrap();
        assert_eq!(path, "/agent/turn-leases");
        serde_json::from_str::<serde_json::Value>(body.as_deref().unwrap()).unwrap()
    };
    assert_eq!(
        lease_body(Some("c1/t1"))["work"],
        serde_json::json!({"workId": "w1", "attempts": 3})
    );
    assert!(lease_body(Some("c1/other")).get("work").is_none());
    assert!(lease_body(None).get("work").is_none());
}

/// 실행 파일 부재만 물러나기로 넘긴다 · 자리 놓기·감시 끝은 hooks 로.
#[test]
fn before_fail_and_release_hooks() {
    let (mut io, mut h) = (Io::default(), Hooks::default());
    {
        let mut d = deps(&mut io, &mut h);
        d.before_fail(&AttemptError::default(), "m1");
        d.before_fail(
            &AttemptError {
                executable_missing: true,
                ..AttemptError::default()
            },
            "m1",
        );
        d.release_slot("c:t");
        d.turn_ended("c:t", "m1");
        d.mark_read(&[7]).unwrap();
    }
    assert_eq!(h.events, ["executable_missing", "slot c:t", "ended c:t m1"]);
    assert_eq!(io.read, [vec![7]]);
}
