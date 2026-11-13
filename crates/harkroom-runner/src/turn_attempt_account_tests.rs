use std::collections::BTreeMap;
use std::fs;

use harkroom_proto::p1::RunnerLinkResponse;
use serde_json::json;

use super::*;
use crate::adapter::{AgentHarness, MentionPermission};
use crate::link::LinkRequest;
use crate::mention_run::{TurnAttempt, TurnOk};
use crate::mention_target::{MentionTarget, build_mention_target};
use crate::pty_turn::TurnResult;
use crate::rest::{HarkroomRestClient, RunnerLink};
use crate::turn_attempt::{Attempted, LeaseNotice, TurnSecrets};
use crate::turn_attempt_run::{AttemptBase, AttemptParts, AttemptPrep, PtyTurnAttempt};
use crate::turn_env::TurnKeys as EnvTurnKeys;
use crate::turn_launch_io::{LaneEnv, SecretMountError};
use crate::turn_policy::AttemptError;
use crate::turn_preset::TurnMode;
use crate::turn_run::PtyOut;

fn acc(name: &str) -> ClaudeAccount {
    ClaudeAccount {
        name: name.into(),
        config_dir: PathBuf::from("/acct").join(name),
        pool: Some("p".into()),
    }
}

fn base() -> TurnCommandOptions<'static> {
    TurnCommandOptions::new(
        AgentHarness::ClaudeCode,
        TurnMode::Mention,
        MentionPermission::Auto,
        "/bin/harkroom-operator",
    )
}

#[test]
fn account_of_copies_and_marks_last() {
    let a = AttemptAccount::of(Some(&acc("a1")), false);
    assert_eq!(a.name.as_deref(), Some("a1"));
    assert_eq!(a.config_dir.as_deref(), Some(Path::new("/acct/a1")));
    assert_eq!(a.pool.as_deref(), Some("p"));
    assert!(!a.calls_for_human);
    let none = AttemptAccount::of(None, true);
    assert_eq!(
        none,
        AttemptAccount {
            calls_for_human: true,
            ..AttemptAccount::default()
        }
    );
}

/// 기본 옵션에 남은 폴더는 언제나 덮는다 — 계정 없는 시도는 `None`.
#[test]
fn command_overrides_base_config_dir() {
    let stale = PathBuf::from("/acct/stale");
    let mut b = base();
    b.claude_config_dir = Some(&stale);
    let a2 = AttemptAccount::of(Some(&acc("a2")), true);
    assert_eq!(
        a2.command(&b).claude_config_dir,
        Some(Path::new("/acct/a2"))
    );
    let none = AttemptAccount::of(None, true);
    assert_eq!(none.command(&b).claude_config_dir, None);
}

#[test]
fn homes_use_attempt_account_only() {
    let a = AttemptAccount::of(Some(&acc("a1")), false);
    let h = a.homes(Some(Path::new("/home")), None, Some(Path::new("/codex")));
    assert_eq!(h.claude_config_dir.as_deref(), Some(Path::new("/acct/a1")));
    assert_eq!(h.home.as_deref(), Some(Path::new("/home")));
    assert_eq!(h.codex_home.as_deref(), Some(Path::new("/codex")));
    assert!(
        AttemptAccount::of(None, true)
            .homes(None, None, None)
            .claude_config_dir
            .is_none()
    );
}

/// 걸린 시도에만 닿고, 놓인 뒤의 신호는 어디에도 닿지 않는다.
#[test]
fn live_slot_routes_to_bound_attempt_only() {
    let slot = LiveSlot::default();
    assert!(!slot.fence_lost() && !slot.cancel("h"));
    let first = Arc::new(LiveTurn::default());
    slot.bind(Some(Arc::clone(&first)));
    assert!(slot.is_bound());
    assert!(slot.cancel("human-1"));
    assert!(slot.fence_lost());
    assert_eq!(first.canceled_by().as_deref(), Some("human-1"));
    assert!(first.fenced_out());
    slot.bind(None);
    let second = Arc::new(LiveTurn::default());
    assert!(!slot.cancel("late"), "놓인 뒤 신호는 버린다");
    slot.bind(Some(Arc::clone(&second)));
    assert!(second.canceled_by().is_none() && !second.fenced_out());
}

// ---- PtyTurnAttempt 를 거친 계정 전환 ----

struct NoLink;
impl RunnerLink for &NoLink {
    fn request(&self, _req: LinkRequest) -> RunnerLinkResponse {
        panic!("열쇠 길이 없는 시험이다")
    }
}

struct NoNotice;
impl LeaseNotice for NoNotice {
    fn lease_ended(&self, _c: &str) {}
}

#[derive(Debug, PartialEq, Eq)]
struct Seen {
    account: Option<String>,
    command_dir: Option<PathBuf>,
    homes_dir: Option<PathBuf>,
    calls_for_human: bool,
    fenced_out: bool,
}

/// 실물 몫을 쓰는 시험용 parts — 시도마다 [`AttemptAccount`] 를 새로 짓고, 명령·기록 자리를 그것으로만 만든다.
struct Parts {
    base_dir: PathBuf,
    slot: LiveSlot,
    cur: Option<AttemptAccount>,
    homes_dir: Option<PathBuf>,
    /// 이 번째 시도 도중 펜스를 잃는다.
    fence_on: Option<usize>,
    seen: Vec<Seen>,
}

impl AttemptParts for Parts {
    fn bind_live(&mut self, live: Option<Arc<LiveTurn>>) {
        self.slot.bind(live);
    }
    fn prepare(
        &mut self,
        _t: &MentionTarget,
        account: Option<&ClaudeAccount>,
        is_last: bool,
        _turn_id: &str,
    ) -> AttemptPrep {
        let a = AttemptAccount::of(account, is_last);
        let homes = a.homes(Some(Path::new("/home")), None, None);
        self.homes_dir = homes.claude_config_dir.clone();
        self.cur = Some(a);
        AttemptPrep {
            key: "k".into(),
            cause: "m1".into(),
            secrets: false,
            lease_dir: None,
            session_id: Some("s".into()),
            homes,
        }
    }
    fn mount_secrets(&mut self, _c: &str) -> Result<(), SecretMountError> {
        unreachable!()
    }
    fn spawn(
        &mut self,
        _turn_id: &str,
        _keys: Option<&EnvTurnKeys>,
        _mcp: &Path,
        _lane_env: LaneEnv,
        _delivered: &mut bool,
    ) -> PtyOut {
        // 기본 옵션에는 남의 폴더가 들어 있다 — 시도의 계정이 덮어야 한다.
        let mut b = base();
        b.claude_config_dir = Some(&self.base_dir);
        let a = self.cur.as_ref().unwrap();
        let o = a.command(&b);
        if self.fence_on == Some(self.seen.len()) {
            assert!(self.slot.fence_lost());
        }
        self.seen.push(Seen {
            account: a.name.clone(),
            command_dir: o.claude_config_dir.map(Path::to_path_buf),
            homes_dir: self.homes_dir.clone(),
            calls_for_human: a.calls_for_human,
            fenced_out: false,
        });
        Ok(TurnResult {
            exit_code: 1,
            timed_out: false,
            tail: String::new(),
        })
    }
    fn outcome(
        &mut self,
        _a: Attempted<PtyOut>,
        _s: &TurnSecrets,
        live: &LiveTurn,
    ) -> Result<TurnOk, AttemptError> {
        self.seen.last_mut().unwrap().fenced_out = live.fenced_out();
        Err(AttemptError {
            message: "fail".into(),
            ..AttemptError::default()
        })
    }
    fn after(&mut self, _s: &TurnSecrets) -> Result<(), String> {
        Ok(())
    }
}

fn target() -> MentionTarget {
    let m = json!({ "id": "m1", "channelId": "c1", "body": "사유", "seq": 9, "meta": null });
    build_mention_target(&json!({ "id": "e1" }), &m, "root", &[])
}

/// security: 계정을 a1 → a2 → (없음) 으로 바꿔 가며 시도할 때, 각 시도의 명령 옵션·기록 찾기 자리의 계정 폴더는 **그
/// 시도의 계정 것만**이다 — 앞 시도·기본 옵션의 폴더가 섞이지 않는다. 앞 시도의 펜스 잃음도 다음 시도에 안 남는다.
#[test]
fn config_dir_does_not_mix_across_attempts() {
    let root = std::env::temp_dir().join(format!("hk-attempt-acct-{}", std::process::id()));
    let _ = fs::remove_dir_all(&root);
    fs::create_dir_all(&root).unwrap();
    let mcp = root.join("mcp.json");
    fs::write(&mcp, "{}").unwrap();
    let env = BTreeMap::new();
    let link = NoLink;
    let client = HarkroomRestClient::new(&link);
    let slot = LiveSlot::default();
    let mut a = PtyTurnAttempt::new(
        AttemptBase {
            client: &client,
            notice: &NoNotice,
            harness: AgentHarness::ClaudeCode,
            can_register_turn_keys: false,
            state_dir: &root,
            mcp_config_path: &mcp,
            runner_env: &env,
            pat: "hk_pat_x",
        },
        Parts {
            base_dir: PathBuf::from("/acct/base-leftover"),
            slot: slot.clone(),
            cur: None,
            homes_dir: None,
            fence_on: Some(0),
            seen: Vec::new(),
        },
    );
    let t = target();
    let (a1, a2) = (acc("a1"), acc("a2"));
    for (account, last) in [(Some(&a1), false), (Some(&a2), false), (None, true)] {
        let mut d = false;
        assert!(a.run(&t, account, last, &mut d).is_err());
        assert!(!slot.is_bound(), "시도가 끝나면 놓인다");
    }
    let seen = &a.parts.borrow().seen;
    assert_eq!(
        *seen,
        [
            Seen {
                account: Some("a1".into()),
                command_dir: Some("/acct/a1".into()),
                homes_dir: Some("/acct/a1".into()),
                calls_for_human: false,
                fenced_out: true,
            },
            Seen {
                account: Some("a2".into()),
                command_dir: Some("/acct/a2".into()),
                homes_dir: Some("/acct/a2".into()),
                calls_for_human: false,
                fenced_out: false,
            },
            Seen {
                account: None,
                command_dir: None,
                homes_dir: None,
                calls_for_human: true,
                fenced_out: false,
            },
        ]
    );
    let _ = fs::remove_dir_all(&root);
}
