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
use crate::turn_attempt_run::SpawnArgs;
use crate::turn_attempt_run::{AttemptBase, AttemptParts, AttemptPrep, PtyTurnAttempt};
use crate::turn_launch_io::SecretMountError;
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

/// 펜스 잃음은 걸린 시도에만 닿고, 놓인 뒤의 펜스 신호는 버린다.
#[test]
fn live_slot_fence_is_per_attempt() {
    let slot = LiveSlot::default();
    assert!(!slot.fence_lost());
    let first = Arc::new(LiveTurn::default());
    slot.bind(Some(Arc::clone(&first)));
    assert!(slot.is_bound());
    assert!(slot.fence_lost());
    assert!(first.fenced_out());
    slot.bind(None);
    assert!(!slot.fence_lost(), "놓인 뒤 펜스 신호는 버린다");
    let second = Arc::new(LiveTurn::default());
    slot.bind(Some(Arc::clone(&second)));
    assert!(!second.fenced_out());
    assert!(slot.canceled_by().is_none());
}

/// [중단] 은 멘션 단위로 남는다 — 돌던 시도에 닿고, 시도 사이에 와도 다음에 걸리는 시도에 먼저 실린다. 처음 사람이 남는다.
#[test]
fn live_slot_cancel_sticks_for_the_mention() {
    let slot = LiveSlot::default();
    let first = Arc::new(LiveTurn::default());
    slot.bind(Some(Arc::clone(&first)));
    assert!(slot.cancel("human-1"), "돌던 시도에 닿았다");
    assert_eq!(first.canceled_by().as_deref(), Some("human-1"));
    slot.bind(None);
    let second = Arc::new(LiveTurn::default());
    slot.bind(Some(Arc::clone(&second)));
    assert_eq!(second.canceled_by().as_deref(), Some("human-1"));
    assert!(second.gate().is_err(), "다음 시도의 관문이 막는다");

    let between = LiveSlot::default();
    assert!(!between.cancel("human-2"), "시도 사이 — 돌던 시도는 없다");
    assert!(!between.cancel("human-3"));
    assert_eq!(between.canceled_by().as_deref(), Some("human-2"));
    let next = Arc::new(LiveTurn::default());
    between.bind(Some(Arc::clone(&next)));
    assert_eq!(next.canceled_by().as_deref(), Some("human-2"));
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
    outcomes: Vec<&'static str>,
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
    fn spawn(&mut self, _args: SpawnArgs<'_>, _delivered: &mut bool) -> PtyOut {
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
        a: Attempted<PtyOut>,
        _s: &TurnSecrets,
        live: &LiveTurn,
    ) -> Result<TurnOk, AttemptError> {
        self.outcomes.push(match a {
            Attempted::Blocked(_) => "blocked",
            Attempted::Ran(_) => "ran",
            Attempted::SetupFailed { .. } => "setup",
        });
        if matches!(a, Attempted::Ran(_)) {
            self.seen.last_mut().unwrap().fenced_out = live.fenced_out();
        }
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
            outcomes: Vec::new(),
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

/// security(#2039 다음): a1 끝 ~ a2 시작 사이에 온 [중단] → a2 를 띄우지 않는다(관문이 막음) · a2 도 놓인 채 끝난다.
#[test]
fn cancel_between_attempts_blocks_next_spawn() {
    let root = std::env::temp_dir().join(format!("hk-attempt-cancel-{}", std::process::id()));
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
            base_dir: PathBuf::from("/acct/base"),
            slot: slot.clone(),
            cur: None,
            homes_dir: None,
            fence_on: None,
            seen: Vec::new(),
            outcomes: Vec::new(),
        },
    );
    let t = target();
    let (a1, a2) = (acc("a1"), acc("a2"));
    let mut d1 = false;
    assert!(a.run(&t, Some(&a1), false, &mut d1).is_err());
    assert!(!slot.is_bound());
    assert!(!slot.cancel("human-1"), "시도 사이 — 돌던 시도는 없다");
    let mut d2 = false;
    assert!(a.run(&t, Some(&a2), true, &mut d2).is_err());
    let p = a.parts.borrow();
    assert_eq!(p.outcomes, ["ran", "blocked"], "a2 는 관문이 막았다");
    assert_eq!(p.seen.len(), 1, "a2 는 띄우지 않았다");
    assert_eq!(p.seen[0].account.as_deref(), Some("a1"));
    assert!(!d2);
    assert!(!slot.is_bound());
    assert_eq!(slot.canceled_by().as_deref(), Some("human-1"));
    drop(p);
    let _ = fs::remove_dir_all(&root);
}

/// security(#2040 다음) ①: 슬롯은 멘션마다 새로 — 앞 멘션의 [중단] 이 다음 멘션(다른 id·같은 id 다시 뜸)을 막지 않는다.
#[test]
fn mention_slots_are_fresh_per_mention() {
    let slots = MentionSlots::default();
    assert!(!slots.cancel("m1", "h"), "열리지 않은 멘션 신호는 버린다");

    let m1 = slots.open("m1");
    let live1 = Arc::new(LiveTurn::default());
    m1.slot().bind(Some(Arc::clone(&live1)));
    assert!(slots.cancel("m1", "human-1"));
    assert_eq!(live1.canceled_by().as_deref(), Some("human-1"));
    m1.slot().bind(None);
    drop(m1);
    assert!(!slots.is_open("m1"), "멘션이 끝나면 빠진다");

    // 다음 멘션 — 앞 멘션의 [중단] 이 실리지 않는다.
    let m2 = slots.open("m2");
    let live2 = Arc::new(LiveTurn::default());
    m2.slot().bind(Some(Arc::clone(&live2)));
    assert!(live2.canceled_by().is_none() && live2.gate().is_ok());
    // 같은 id 가 다시 떠도 새 슬롯이다.
    let again = slots.open("m1");
    let live3 = Arc::new(LiveTurn::default());
    again.slot().bind(Some(Arc::clone(&live3)));
    assert!(live3.gate().is_ok());
    assert!(again.slot().canceled_by().is_none());
    // m2 의 [중단] 은 m1 에 닿지 않는다.
    assert!(slots.cancel("m2", "human-2"));
    assert!(live3.canceled_by().is_none());
    assert_eq!(live2.canceled_by().as_deref(), Some("human-2"));
}

/// 옛 손잡이가 늦게 떨어져도 같은 id 로 새로 연 슬롯은 지우지 않는다 · 펜스도 그 멘션에만.
#[test]
fn stale_mention_slot_drop_keeps_newer() {
    let slots = MentionSlots::default();
    let old = slots.open("m1");
    let new = slots.open("m1");
    drop(old);
    assert!(slots.is_open("m1"));
    let live = Arc::new(LiveTurn::default());
    new.slot().bind(Some(Arc::clone(&live)));
    assert!(slots.fence_lost("m1"));
    assert!(live.fenced_out());
    assert!(!slots.fence_lost("m2"));
    drop(new);
    assert!(!slots.is_open("m1"));
}

fn pool_lane(pool: &str, names: &[&str]) -> ClaudePoolLane {
    ClaudePoolLane {
        pool: pool.into(),
        accounts: names
            .iter()
            .map(|n| ClaudeAccount {
                name: (*n).into(),
                config_dir: PathBuf::from("/acct").join(n),
                pool: Some(pool.into()),
            })
            .collect(),
    }
}

/// security: 칩은 순번만 — 풀 순서·그 풀 안 순서(1부터), 계정 없음은 기본 로그인, 모르면 비움. 이름을 내는 길이 없다.
#[test]
fn account_ranks_are_positions_only() {
    let snap = LaneSnapshot {
        pool: Some("p1".into()),
        chain: vec![
            pool_lane("p1", &["alice", "bob"]),
            pool_lane("p2", &["carol"]),
        ],
        lane: vec![],
    };
    let carol = ClaudeAccount {
        name: "carol".into(),
        config_dir: PathBuf::from("/acct/carol"),
        pool: Some("p2".into()),
    };
    assert_eq!(account_ranks(&snap, Some(&carol)), (Some(Some(1)), Some(2)));
    let bob_implicit = ClaudeAccount {
        name: "bob".into(),
        config_dir: PathBuf::from("/acct/bob"),
        pool: None,
    };
    assert_eq!(
        account_ranks(&snap, Some(&bob_implicit)),
        (Some(Some(2)), Some(1)),
        "풀을 모르면 lane 의 풀"
    );
    assert_eq!(
        account_ranks(&snap, None),
        (Some(None), None),
        "기본 로그인"
    );
    let stranger = ClaudeAccount {
        name: "zed".into(),
        config_dir: PathBuf::from("/acct/zed"),
        pool: Some("nope".into()),
    };
    assert_eq!(
        account_ranks(&snap, Some(&stranger)),
        (None, None),
        "모르면 비움"
    );
    let flat = LaneSnapshot {
        lane: vec![Some(bob_implicit.clone()), Some(carol.clone())],
        ..LaneSnapshot::default()
    };
    assert_eq!(
        account_ranks(&flat, Some(&carol)),
        (Some(Some(2)), None),
        "풀 순서가 없으면 축 순서"
    );
}
