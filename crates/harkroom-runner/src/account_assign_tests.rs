// 스레드별 계정 배정(C ②) 회귀선 — `accountAssign.test.ts` 이식. 숫자는 85/97, 95/98.
use super::shared::ModelWeekly;
use super::*;
use std::fs;
use std::sync::Arc;
use std::sync::atomic::AtomicUsize;

// Date.UTC(2026, 8, 29, 12, 0, 0)
const NOW: f64 = 1_790_683_200_000.0;
const H: f64 = 3_600_000.0;

#[derive(Default, Clone)]
struct E {
    session: Option<Option<f64>>,
    weekly: Option<f64>,
    weekly_reset_h: Option<Option<f64>>,
    session_reset_h: Option<f64>,
    sign_in: Option<&'static str>,
    read_ago_ms: Option<f64>,
    model: Option<(&'static str, f64)>,
}

fn entry(account: &str, o: E) -> UsageEntry {
    UsageEntry {
        pool: String::new(),
        account: account.to_string(),
        sign_in: o.sign_in.map(str::to_string),
        session: match o.session {
            Some(None) => None,
            s => Some(UsageWindow {
                used_percent: s.flatten().unwrap_or(10.0),
                resets_at_ms: Some(NOW + o.session_reset_h.unwrap_or(3.0) * H),
            }),
        },
        weekly: Some(UsageWindow {
            used_percent: o.weekly.unwrap_or(10.0),
            resets_at_ms: match o.weekly_reset_h {
                Some(None) => None,
                h => Some(NOW + h.flatten().unwrap_or(100.0) * H),
            },
        }),
        model_weekly: o
            .model
            .map(|(label, pct)| ModelWeekly {
                label: label.to_string(),
                window: UsageWindow {
                    used_percent: pct,
                    resets_at_ms: Some(NOW + 100.0 * H),
                },
            })
            .into_iter()
            .collect(),
        read_at_ms: Some(NOW - o.read_ago_ms.unwrap_or(60_000.0)),
        error: None,
    }
}

fn s(v: f64) -> Option<Option<f64>> {
    Some(Some(v))
}
fn wk(pct: f64) -> E {
    E {
        weekly: Some(pct),
        ..E::default()
    }
}
fn wkr(pct: f64, reset_h: f64) -> E {
    E {
        weekly: Some(pct),
        weekly_reset_h: s(reset_h),
        ..E::default()
    }
}
fn ses(pct: f64) -> E {
    E {
        session: s(pct),
        ..E::default()
    }
}

struct In {
    entries: Vec<UsageEntry>,
    accounts: Vec<String>,
    pinned: Option<&'static str>,
    recent: HashMap<String, u32>,
    model: Option<&'static str>,
    random: f64,
    blocked: HashSet<String>,
}

fn names(v: &[&str]) -> Vec<String> {
    v.iter().map(|s| s.to_string()).collect()
}

fn input(entries: Vec<UsageEntry>) -> In {
    In {
        entries,
        accounts: names(&["a", "b", "c"]),
        pinned: None,
        recent: HashMap::new(),
        model: None,
        random: 0.0,
        blocked: HashSet::new(),
    }
}

impl In {
    fn accounts(mut self, a: &[&str]) -> Self {
        self.accounts = names(a);
        self
    }
    fn pinned(mut self, p: &'static str) -> Self {
        self.pinned = Some(p);
        self
    }
    fn random(mut self, r: f64) -> Self {
        self.random = r;
        self
    }
    fn recent(mut self, r: &[(&str, u32)]) -> Self {
        self.recent = r.iter().map(|(k, v)| (k.to_string(), *v)).collect();
        self
    }
    fn blocked(mut self, b: &[&str]) -> Self {
        self.blocked = b.iter().map(|s| s.to_string()).collect();
        self
    }
    fn model(mut self, m: &'static str) -> Self {
        self.model = Some(m);
        self
    }
    fn pick(&self) -> PickResult {
        let usage: HashMap<String, UsageEntry> = self
            .entries
            .iter()
            .map(|e| (e.account.clone(), e.clone()))
            .collect();
        let r = self.random;
        let mut random = move || r;
        pick_account(PickInput {
            accounts: &self.accounts,
            usage: &usage,
            pinned: self.pinned,
            policy: &DEFAULT_ASSIGN_POLICY,
            now: NOW,
            recent_assignments: &self.recent,
            model: self.model,
            random: &mut random,
            blocked: &self.blocked,
        })
    }
}

#[test]
fn earliest_reset_headroom_first() {
    let r = input(vec![
        entry("a", wkr(60.0, 24.0)),
        entry("b", wkr(50.0, 144.0)),
    ])
    .accounts(&["b", "a"])
    .pick();
    assert_eq!(r.order, ["a", "b"]);
    assert_eq!(r.reason, PickReason::New);
}

#[test]
fn new_assign_excludes_85_97() {
    let r = input(vec![
        entry(
            "a",
            E {
                session: s(85.0),
                weekly: Some(0.0),
                ..E::default()
            },
        ),
        entry("b", wkr(97.0, 1.0)),
        entry("c", wk(50.0)),
    ])
    .pick();
    assert_eq!(r.order[0], "c");
    assert_eq!(r.order.len(), 3);
}

#[test]
fn pinned_kept_below_move_threshold() {
    let r = input(vec![
        entry(
            "a",
            E {
                session: s(90.0),
                weekly: Some(50.0),
                ..E::default()
            },
        ),
        entry("b", wk(0.0)),
    ])
    .accounts(&["a", "b"])
    .pinned("a")
    .pick();
    assert_eq!(r.reason, PickReason::Kept);
    assert_eq!(r.order, ["a", "b"]);
}

#[test]
fn pinned_moves_over_move_threshold() {
    for hot in [ses(95.0), wk(98.0)] {
        let r = input(vec![entry("a", hot), entry("b", wk(30.0))])
            .accounts(&["a", "b"])
            .pinned("a")
            .pick();
        assert_eq!(r.reason, PickReason::Moved);
        assert_eq!(r.order, ["b", "a"]);
    }
}

#[test]
fn tie_prefers_lower_session() {
    let r = input(vec![
        entry(
            "a",
            E {
                weekly: Some(50.0),
                session: s(60.0),
                ..E::default()
            },
        ),
        entry(
            "b",
            E {
                weekly: Some(52.0),
                session: s(10.0),
                ..E::default()
            },
        ),
    ])
    .accounts(&["a", "b"])
    .pick();
    assert_eq!(r.order, ["b", "a"]);
}

#[test]
fn per_assign_penalty() {
    let es = vec![entry("a", wk(50.0)), entry("b", wk(55.0))];
    assert_eq!(input(es.clone()).accounts(&["a", "b"]).pick().order[0], "a");
    let r = input(es).accounts(&["a", "b"]).recent(&[("a", 5)]).pick();
    assert_eq!(r.order[0], "b");
}

#[test]
fn random_among_top_two() {
    let es = vec![
        entry("a", wk(10.0)),
        entry("b", wk(40.0)),
        entry("c", wk(80.0)),
    ];
    assert_eq!(input(es.clone()).random(0.1).pick().order[0], "a");
    assert_eq!(input(es).random(0.9).pick().order[0], "b");
}

#[test]
fn same_sign_in_is_one_slot_latest_value() {
    let r = input(vec![
        entry(
            "a",
            E {
                weekly: Some(90.0),
                sign_in: Some("x"),
                read_ago_ms: Some(60_000.0),
                ..E::default()
            },
        ),
        entry(
            "b",
            E {
                weekly: Some(10.0),
                sign_in: Some("x"),
                read_ago_ms: Some(5.0 * 60_000.0),
                ..E::default()
            },
        ),
        entry("c", wk(50.0)),
    ])
    .pick();
    assert_eq!(r.order[0], "c");
}

#[test]
fn stale_is_unknown_with_median_score() {
    let r = input(vec![
        entry(
            "a",
            E {
                weekly: Some(99.0),
                read_ago_ms: Some(11.0 * 60_000.0),
                ..E::default()
            },
        ),
        entry("b", wk(20.0)),
        entry("c", wk(80.0)),
    ])
    .pick();
    assert_eq!(r.order, ["b", "a", "c"]);
}

#[test]
fn no_known_values_falls_back_to_pool_order() {
    let r = input(vec![]).accounts(&["b", "a"]).pick();
    assert_eq!(r.reason, PickReason::Unknown);
    assert_eq!(r.order, ["b", "a"]);
    assert_eq!(r.detail, "사용량을 모른다 — 풀 순서");
    let kept = input(vec![]).accounts(&["b", "a"]).pinned("a").pick();
    assert_eq!(kept.reason, PickReason::Kept);
    assert_eq!(kept.order, ["a", "b"]);
}

#[test]
fn all_hot_goes_to_soonest_unblock() {
    let r = input(vec![
        entry(
            "a",
            E {
                session: s(90.0),
                session_reset_h: Some(4.0),
                ..E::default()
            },
        ),
        entry(
            "b",
            E {
                session: s(90.0),
                session_reset_h: Some(1.0),
                ..E::default()
            },
        ),
        entry("c", wkr(97.0, 50.0)),
    ])
    .pick();
    assert_eq!(r.reason, PickReason::AllHot);
    assert_eq!(r.order[0], "b");
    assert_eq!(
        r.detail,
        "풀 전체가 새 배정 기준(5h 85% / 주간 97%) 이상 — b(5h 90% · 주간 10% · 점수 0.90/h)"
    );
}

#[test]
fn model_weekly_window_when_tighter() {
    let es = vec![
        entry(
            "a",
            E {
                weekly: Some(20.0),
                model: Some(("Opus weekly", 97.0)),
                ..E::default()
            },
        ),
        entry("b", wk(40.0)),
    ];
    assert_eq!(
        input(es.clone())
            .accounts(&["a", "b"])
            .model("claude-opus-5-5")
            .pick()
            .order[0],
        "b"
    );
    assert_eq!(
        input(es)
            .accounts(&["a", "b"])
            .model("claude-sonnet-5-5")
            .pick()
            .order[0],
        "a"
    );
}

// ── 상위 둘은 점수에 비례해 뽑는다 (2026-10-06) ──

fn proportional() -> Vec<UsageEntry> {
    vec![entry("a", wkr(10.0, 50.0)), entry("b", wkr(66.0, 100.0))]
}
const P_B: f64 = 0.34 / (1.8 + 0.34);

#[test]
fn second_probability_is_score_share() {
    let n = 10_000;
    let mut b = 0;
    for i in 0..n {
        let r = (f64::from(i) + 0.5) / f64::from(n);
        if input(proportional())
            .accounts(&["a", "b"])
            .random(r)
            .pick()
            .order[0]
            == "b"
        {
            b += 1;
        }
    }
    let ratio = f64::from(b) / f64::from(n);
    assert!((ratio - P_B).abs() < 0.0005, "{ratio} vs {P_B}");
}

#[test]
fn threshold_and_p_in_detail() {
    let lo = input(proportional())
        .accounts(&["a", "b"])
        .random(1.0 - P_B - 1e-6)
        .pick();
    let hi = input(proportional())
        .accounts(&["a", "b"])
        .random(1.0 - P_B + 1e-6)
        .pick();
    assert_eq!(lo.order, ["a", "b"]);
    assert!(
        lo.detail.contains(&format!("p={:.2}", 1.0 - P_B)),
        "{}",
        lo.detail
    );
    assert_eq!(hi.order, ["b", "a"]);
    assert!(hi.detail.contains(&format!("p={P_B:.2}")), "{}", hi.detail);
    assert_eq!(lo.detail, "a(5h 10% · 주간 10% · 점수 1.80/h) · p=0.84");
}

#[test]
fn both_zero_always_first() {
    let r = input(vec![entry("a", wk(10.0)), entry("b", wk(10.0))])
        .accounts(&["a", "b"])
        .recent(&[("a", 50), ("b", 50)])
        .random(0.999)
        .pick();
    assert_eq!(r.order[0], "a");
    assert!(!r.detail.contains("p="));
}

#[test]
fn second_zero_never_picked() {
    let r = input(vec![entry("a", wk(10.0)), entry("b", wk(10.0))])
        .accounts(&["a", "b"])
        .recent(&[("b", 50)])
        .random(0.999)
        .pick();
    assert_eq!(r.order[0], "a");
}

#[test]
fn single_account_ignores_random() {
    let r = input(vec![entry("a", wk(10.0))])
        .accounts(&["a"])
        .random(0.999)
        .pick();
    assert_eq!(r.order, ["a"]);
    assert_eq!(r.reason, PickReason::New);
    assert!(!r.detail.contains("p="));
}

// ── 같은 로그인은 후보 한 자리 (09-30 qa 실측) ──

fn grouped() -> In {
    let mk = |name: &str, sign_in: &'static str, weekly: f64, reset: f64, session: f64| {
        entry(
            name,
            E {
                sign_in: Some(sign_in),
                weekly: Some(weekly),
                weekly_reset_h: s(reset),
                session: s(session),
                ..E::default()
            },
        )
    };
    input(vec![
        mk("lychee", "s1", 64.0, 2.4, 70.0),
        mk("lime", "s1", 64.0, 2.4, 70.0),
        mk("plum", "s2", 0.0, 26.0, 0.0),
        mk("acct", "s3", 0.0, 170.0, 0.0),
    ])
    .accounts(&["lime", "lychee", "plum", "acct"])
}

#[test]
fn top_two_are_sign_in_groups() {
    assert_eq!(grouped().random(0.0).pick().order[0], "lime");
    assert_eq!(grouped().random(0.9).pick().order[0], "plum");
}

#[test]
fn group_mates_go_to_tail() {
    assert_eq!(
        grouped().random(0.0).pick().order,
        ["lime", "plum", "acct", "lychee"]
    );
}

// ── 관문에 막힌 계정 (2026-10-01) ──

#[test]
fn blocked_excluded_and_last() {
    let r = input(vec![
        entry("a", wkr(0.0, 10.0)),
        entry("b", wk(50.0)),
        entry("c", wk(60.0)),
    ])
    .blocked(&["a"])
    .pick();
    assert_ne!(r.order[0], "a");
    assert_eq!(r.order.last().unwrap(), "a");
}

#[test]
fn blocked_pinned_moves() {
    let r = input(vec![entry("a", E::default()), entry("b", E::default())])
        .accounts(&["a", "b"])
        .pinned("a")
        .blocked(&["a"])
        .pick();
    assert_eq!(r.reason, PickReason::Moved);
    assert_eq!(r.order, ["b", "a"]);
}

#[test]
fn blocked_stays_last_even_if_others_hot() {
    let hot = |h: f64| E {
        session: s(99.0),
        session_reset_h: Some(h),
        ..E::default()
    };
    let r = input(vec![
        entry("a", wkr(0.0, 10.0)),
        entry("b", hot(1.0)),
        entry("c", hot(2.0)),
    ])
    .blocked(&["a"])
    .pick();
    assert_eq!(r.order.len(), 3);
    assert_eq!(r.order.last().unwrap(), "a");
}

#[test]
fn all_blocked_keeps_order() {
    let r = input(vec![entry("a", E::default()), entry("b", E::default())])
        .accounts(&["a", "b"])
        .blocked(&["a", "b"])
        .pick();
    let mut o = r.order.clone();
    o.sort();
    assert_eq!(o, ["a", "b"]);
}

#[test]
fn blocked_last_when_unknown() {
    let r = input(vec![]).accounts(&["a", "b"]).blocked(&["a"]).pick();
    assert_eq!(r.order, ["b", "a"]);
}

// ── createAccountAssigner ──

fn tmp_root(name: &str) -> PathBuf {
    static N: AtomicUsize = AtomicUsize::new(0);
    let d = std::env::temp_dir().join(format!(
        "hk-assign-{name}-{}-{}",
        std::process::id(),
        N.fetch_add(1, AtomicOrdering::Relaxed)
    ));
    let _ = fs::remove_dir_all(&d);
    fs::create_dir_all(&d).unwrap();
    d
}

fn entry_json(e: &UsageEntry, pool: &str) -> Value {
    let w = |w: &Option<UsageWindow>| match w {
        Some(w) => {
            serde_json::json!({ "usedPercent": w.used_percent, "resetsAtMs": w.resets_at_ms })
        }
        None => Value::Null,
    };
    serde_json::json!({
        "pool": pool,
        "account": e.account,
        "signIn": e.sign_in,
        "session": w(&e.session),
        "weekly": w(&e.weekly),
        "modelWeekly": e.model_weekly.iter().map(|m| serde_json::json!({
            "label": m.label,
            "window": { "usedPercent": m.window.used_percent, "resetsAtMs": m.window.resets_at_ms },
        })).collect::<Vec<_>>(),
        "readAtMs": e.read_at_ms,
    })
}

fn root_with(name: &str, entries: Option<&[(UsageEntry, &str)]>) -> PathBuf {
    let root = tmp_root(name);
    if let Some(entries) = entries {
        let doc = serde_json::json!({
            "version": 1,
            "writtenAtMs": NOW,
            "accounts": entries.iter().map(|(e, p)| entry_json(e, p)).collect::<Vec<_>>(),
        });
        fs::write(root.join("usage.json"), doc.to_string()).unwrap();
    }
    root
}

fn acct(name: &str) -> ClaudeAccount {
    ClaudeAccount {
        name: name.to_string(),
        config_dir: PathBuf::from(format!("/x/{name}")),
        pool: None,
    }
}

fn lane_names(lane: &Lane) -> Vec<String> {
    lane.iter()
        .map(|a| a.as_ref().map_or("null".to_string(), |a| a.name.clone()))
        .collect()
}

type Lines = Arc<Mutex<Vec<String>>>;

fn with_test_deps(mut d: AccountAssignerDeps, lines: Option<Lines>) -> AccountAssignerDeps {
    d.now = Some(Box::new(|| NOW));
    d.random = Some(Box::new(|| 0.0));
    d.log = Some(Box::new(move |l: &str| {
        if let Some(lines) = &lines {
            lines.lock().unwrap().push(l.to_string());
        }
    }));
    d
}

#[test]
fn assigner_reads_own_pool_and_follows_pin() {
    let root = root_with(
        "pool",
        Some(&[
            (entry("a", wk(90.0)), "work"),
            (entry("b", wk(10.0)), "work"),
            (entry("a", wk(0.0)), "other"),
        ]),
    );
    let lines: Lines = Arc::default();
    let d = AccountAssignerDeps::new(
        vec![Some(acct("a")), Some(acct("b"))],
        Some("work".into()),
        root,
        |k| (k == "t1").then(|| "a".to_string()),
    );
    let a = create_account_assigner(with_test_deps(d, Some(lines.clone())));
    assert_eq!(lane_names(&a.lane_for("t1", None)), ["a", "b"]);
    assert_eq!(lane_names(&a.lane_for("t2", None)), ["b", "a"]);
    let lines = lines.lock().unwrap();
    assert!(
        lines
            .iter()
            .any(|l| l.contains("t2") && l.contains("새 스레드")),
        "{lines:?}"
    );
    assert_eq!(
        lines[0],
        "[계정 배정] t2: 새 스레드 → b — b(5h 10% · 주간 10% · 점수 0.90/h) · p=0.90"
    );
}

#[test]
fn assigner_reads_pools_json_each_turn() {
    let root = root_with(
        "poolsjson",
        Some(&[
            (
                entry(
                    "a",
                    E {
                        session: s(70.0),
                        weekly: Some(10.0),
                        ..E::default()
                    },
                ),
                "work",
            ),
            (
                entry(
                    "b",
                    E {
                        session: s(10.0),
                        weekly: Some(60.0),
                        ..E::default()
                    },
                ),
                "work",
            ),
        ]),
    );
    let d = AccountAssignerDeps::new(
        vec![Some(acct("a")), Some(acct("b"))],
        Some("work".into()),
        root.clone(),
        |_| None,
    );
    let a = create_account_assigner(with_test_deps(d, None));
    assert_eq!(lane_names(&a.lane_for("t1", None))[0], "a");
    fs::write(
        root.join("pools.json"),
        r#"{"defaultPool":"work","order":{},"agents":{},"assign":{"work":{"newSessionPct":60}}}"#,
    )
    .unwrap();
    assert_eq!(lane_names(&a.lane_for("t2", None))[0], "b");
}

#[test]
fn assigner_without_usage_keeps_lane() {
    let root = root_with("nousage", None);
    let mut d =
        AccountAssignerDeps::new(vec![Some(acct("a")), Some(acct("b"))], None, root, |_| None);
    d.now = Some(Box::new(|| NOW));
    let a = create_account_assigner(d);
    assert_eq!(lane_names(&a.lane_for("t", None)), ["a", "b"]);
}

#[test]
fn assigner_without_pool_returns_lane() {
    let d = AccountAssignerDeps::new(vec![None], None, PathBuf::from("/nonexistent"), |_| None);
    let a = create_account_assigner(d);
    assert_eq!(a.lane_for("t", None), vec![None]);
}

#[test]
fn assigner_counts_recent_assignments_as_penalty() {
    let root = root_with(
        "penalty",
        Some(&[(entry("a", wk(50.0)), ""), (entry("b", wk(53.0)), "")]),
    );
    let t = Arc::new(Mutex::new(NOW));
    let mut d = with_test_deps(
        AccountAssignerDeps::new(vec![Some(acct("a")), Some(acct("b"))], None, root, |_| None),
        None,
    );
    let tc = t.clone();
    d.now = Some(Box::new(move || *tc.lock().unwrap()));
    let a = create_account_assigner(d);
    let mut firsts = Vec::new();
    for i in 0..4 {
        *t.lock().unwrap() += 1000.0;
        firsts.push(lane_names(&a.lane_for(&format!("t{i}"), None))[0].clone());
    }
    assert_eq!(firsts[0], "a");
    assert!(firsts.iter().any(|f| f == "b"), "{firsts:?}");
}

#[test]
fn assigner_follows_current_lane() {
    let root = root_with(
        "current",
        Some(&[
            (entry("a", wkr(50.0, 10.0)), "work"),
            (entry("b", wkr(50.0, 10.0)), "work"),
            (entry("c", wkr(0.0, 10.0)), "work"),
        ]),
    );
    let lane = Arc::new(Mutex::new(vec![Some(acct("a")), Some(acct("b"))]));
    let mut d = with_test_deps(
        AccountAssignerDeps::new(
            vec![Some(acct("a")), Some(acct("b"))],
            Some("work".into()),
            root,
            |_| None,
        ),
        None,
    );
    let lc = lane.clone();
    d.current = Some(Box::new(move || CurrentLane {
        pool: Some("work".into()),
        lane: lc.lock().unwrap().clone(),
        chain: None,
    }));
    let a = create_account_assigner(d);
    assert_eq!(lane_names(&a.lane_for("t1", None)), ["a", "b"]);
    *lane.lock().unwrap() = vec![Some(acct("b")), Some(acct("c"))];
    assert_eq!(lane_names(&a.lane_for("t2", None)), ["c", "b"]);
}

#[test]
fn assigner_puts_marked_account_last_until_cleared() {
    let root = root_with(
        "gate",
        Some(&[
            (entry("a", wkr(0.0, 10.0)), "work"),
            (entry("b", wk(50.0)), "work"),
        ]),
    );
    let at_ms = Arc::new(Mutex::new(NOW - 60_000.0));
    let marked = Arc::new(Mutex::new(true));
    let mk = |gated_by_flag: bool| {
        let mut d = with_test_deps(
            AccountAssignerDeps::new(
                vec![Some(acct("a")), Some(acct("b"))],
                Some("work".into()),
                root.clone(),
                |_| None,
            ),
            None,
        );
        let (at, m) = (at_ms.clone(), marked.clone());
        d.read_attention = Some(Box::new(move |dir: &Path| {
            (dir == Path::new("/x/a") && (!gated_by_flag || *m.lock().unwrap())).then(|| {
                Attention {
                    kind: shared::AttentionKind::Gate,
                    at_ms: *at.lock().unwrap(),
                }
            })
        }));
        create_account_assigner(d)
    };
    let a1 = mk(false);
    let a2 = mk(true);
    assert_eq!(lane_names(&a1.lane_for("t1", None)), ["b", "a"]);
    *at_ms.lock().unwrap() = NOW - 24.0 * 60.0 * 60_000.0;
    assert_eq!(lane_names(&a2.lane_for("t2", None)), ["b", "a"]);
    *marked.lock().unwrap() = false;
    assert_eq!(lane_names(&a2.lane_for("t3", None))[0], "a");
}

#[test]
fn default_read_attention_reads_marker_files() {
    let dir = tmp_root("marker");
    assert_eq!(read_account_blocked(&dir), None);
    fs::write(
        dir.join(shared::CLAUDE_AUTH_FILE),
        r#"{"kind":"credential","atMs":5}"#,
    )
    .unwrap();
    assert_eq!(
        read_account_blocked(&dir).map(|a| a.kind),
        Some(shared::AttentionKind::Credential)
    );
    fs::write(
        dir.join(shared::CLAUDE_ATTENTION_FILE),
        r#"{"kind":"gate","atMs":7}"#,
    )
    .unwrap();
    let a = read_account_blocked(&dir).unwrap();
    assert_eq!((a.kind, a.at_ms), (shared::AttentionKind::Gate, 7.0));
    assert!(is_attention_active(Some(&a), 0.0));
    let future = Attention {
        kind: shared::AttentionKind::Gate,
        at_ms: 60_001.0,
    };
    assert!(!is_attention_active(Some(&future), 0.0));
}

#[test]
fn session_file_exists_under_projects() {
    let dir = tmp_root("sess");
    assert!(!claude_session_file_exists("s1", &dir));
    fs::create_dir_all(dir.join("projects").join("p")).unwrap();
    fs::write(dir.join("projects/p/s1.jsonl"), "").unwrap();
    assert!(claude_session_file_exists("s1", &dir));
    assert!(!claude_session_file_exists("s2", &dir));
}

// ── 풀 순서(2026-10-15, D1~D5 A) ──

fn at(pool: &str, name: &str) -> ClaudeAccount {
    ClaudeAccount {
        name: name.to_string(),
        config_dir: PathBuf::from(format!("/x/{pool}/{name}")),
        pool: Some(pool.to_string()),
    }
}

fn chain() -> Vec<ClaudePoolLane> {
    vec![
        ClaudePoolLane {
            pool: "work".into(),
            accounts: vec![at("work", "a"), at("work", "b")],
        },
        ClaudePoolLane {
            pool: "personal".into(),
            accounts: vec![at("personal", "c")],
        },
    ]
}

fn chain_root(name: &str, entries: &[(UsageEntry, &str)]) -> PathBuf {
    root_with(name, Some(entries))
}

fn make_chain(
    root: PathBuf,
    chain: Vec<ClaudePoolLane>,
    pins: HashMap<String, (String, Option<String>)>,
    lines: Option<Lines>,
) -> AccountAssignerDeps {
    let pins = Arc::new(pins);
    let p1 = pins.clone();
    let mut d = with_test_deps(
        AccountAssignerDeps::new(
            chain[0].accounts.iter().cloned().map(Some).collect(),
            Some("work".into()),
            root,
            move |k| p1.get(k).map(|p| p.0.clone()),
        ),
        lines,
    );
    let first: Lane = chain[0].accounts.iter().cloned().map(Some).collect();
    d.current = Some(Box::new(move || CurrentLane {
        pool: Some("work".into()),
        lane: first.clone(),
        chain: Some(chain.clone()),
    }));
    d.pinned_pool_of = Some(Box::new(move |k| pins.get(k).and_then(|p| p.1.clone())));
    d.read_attention = Some(Box::new(|_| None));
    d
}

fn pool_names(lane: &Lane) -> Vec<String> {
    lane.iter()
        .map(|a| {
            let a = a.as_ref().unwrap();
            format!("{}/{}", a.pool.as_deref().unwrap_or("undefined"), a.name)
        })
        .collect()
}

fn pin(k: &str, name: &str, pool: Option<&str>) -> HashMap<String, (String, Option<String>)> {
    HashMap::from([(k.to_string(), (name.to_string(), pool.map(str::to_string)))])
}

#[test]
fn chain_picks_from_first_pool_with_others_as_tail() {
    let root = chain_root(
        "c1",
        &[
            (entry("a", wk(50.0)), "work"),
            (entry("b", wk(10.0)), "work"),
            (entry("c", wk(0.0)), "personal"),
        ],
    );
    let a = create_account_assigner(make_chain(root, chain(), HashMap::new(), None));
    assert_eq!(
        pool_names(&a.lane_for("t1", None)),
        ["work/b", "work/a", "personal/c"]
    );
}

#[test]
fn chain_moves_new_threads_to_second_pool_when_first_exhausted() {
    let root = chain_root(
        "c2",
        &[
            (entry("a", ses(90.0)), "work"),
            (entry("b", ses(86.0)), "work"),
            (entry("c", ses(40.0)), "personal"),
        ],
    );
    let lines: Lines = Arc::default();
    let a = create_account_assigner(make_chain(
        root,
        chain(),
        HashMap::new(),
        Some(lines.clone()),
    ));
    assert_eq!(pool_names(&a.lane_for("t1", None))[0], "personal/c");
    let lines = lines.lock().unwrap();
    assert!(
        lines
            .iter()
            .any(|l| l.contains("2번 personal") && l.contains("소진: work")),
        "{lines:?}"
    );
    assert_eq!(lines[0], "[풀 순서] 새 스레드는 2번 personal (소진: work)");
}

#[test]
fn chain_keeps_thread_on_second_pool_d3() {
    let root = chain_root(
        "c3",
        &[
            (entry("a", ses(10.0)), "work"),
            (entry("b", ses(10.0)), "work"),
            (entry("c", ses(90.0)), "personal"),
        ],
    );
    let a = create_account_assigner(make_chain(
        root,
        chain(),
        pin("old", "c", Some("personal")),
        None,
    ));
    assert_eq!(pool_names(&a.lane_for("old", None))[0], "personal/c");
    assert!(pool_names(&a.lane_for("new", None))[0].starts_with("work/"));
}

#[test]
fn chain_moves_pinned_over_move_threshold() {
    let root = chain_root(
        "c4",
        &[
            (entry("a", ses(10.0)), "work"),
            (entry("b", ses(10.0)), "work"),
            (entry("c", ses(96.0)), "personal"),
        ],
    );
    let lines: Lines = Arc::default();
    let a = create_account_assigner(make_chain(
        root,
        chain(),
        pin("old", "c", Some("personal")),
        Some(lines.clone()),
    ));
    assert!(pool_names(&a.lane_for("old", None))[0].starts_with("work/"));
    assert!(
        lines
            .lock()
            .unwrap()
            .iter()
            .any(|l| l.contains("old: 옮김"))
    );
}

fn dup_chain() -> Vec<ClaudePoolLane> {
    vec![
        ClaudePoolLane {
            pool: "work".into(),
            accounts: vec![at("work", "x")],
        },
        ClaudePoolLane {
            pool: "personal".into(),
            accounts: vec![at("personal", "x")],
        },
    ]
}

#[test]
fn chain_same_name_follows_recorded_pool() {
    let root = chain_root(
        "c5",
        &[
            (entry("x", ses(10.0)), "work"),
            (entry("x", ses(10.0)), "personal"),
        ],
    );
    let a = create_account_assigner(make_chain(
        root,
        dup_chain(),
        pin("t", "x", Some("personal")),
        None,
    ));
    assert_eq!(pool_names(&a.lane_for("t", None))[0], "personal/x");
}

#[test]
fn chain_legacy_record_follows_session_file() {
    let root = chain_root(
        "c6",
        &[
            (entry("x", ses(10.0)), "work"),
            (entry("x", ses(10.0)), "personal"),
        ],
    );
    let seen: Lines = Arc::default();
    let make2 = |session_in: Option<&'static str>| {
        let mut d = make_chain(root.clone(), dup_chain(), pin("t", "x", None), None);
        d.session_id_of = Some(Box::new(|_| Some("sess-1".to_string())));
        let seen = seen.clone();
        d.has_session = Some(Box::new(move |id: &str, dir: &Path| {
            seen.lock().unwrap().push(format!("{id}@{}", dir.display()));
            session_in.is_some_and(|s| dir == Path::new(s))
        }));
        create_account_assigner(d)
    };
    assert_eq!(
        pool_names(&make2(Some("/x/personal/x")).lane_for("t", None))[0],
        "personal/x"
    );
    assert_eq!(
        *seen.lock().unwrap(),
        ["sess-1@/x/work/x", "sess-1@/x/personal/x"]
    );
    assert_eq!(pool_names(&make2(None).lane_for("t", None))[0], "work/x");
}

#[test]
fn chain_all_exhausted_goes_to_soonest_pool_d4() {
    let hot = |h: f64| E {
        session: s(90.0),
        session_reset_h: Some(h),
        ..E::default()
    };
    let root = chain_root(
        "c7",
        &[
            (entry("a", hot(3.0)), "work"),
            (entry("b", hot(3.0)), "work"),
            (entry("c", hot(1.0)), "personal"),
        ],
    );
    let lines: Lines = Arc::default();
    let a = create_account_assigner(make_chain(
        root,
        chain(),
        HashMap::new(),
        Some(lines.clone()),
    ));
    assert_eq!(pool_names(&a.lane_for("t", None))[0], "personal/c");
    assert!(
        lines
            .lock()
            .unwrap()
            .iter()
            .any(|l| l.contains("모든 풀이"))
    );
}

#[test]
fn parse_usage_is_tolerant() {
    let v: Value = serde_json::json!({
        "version": 1,
        "accounts": [
            { "account": "" },
            "junk",
            { "account": "a", "weekly": { "usedPercent": 150 }, "session": { "usedPercent": "x" },
              "modelWeekly": [{ "label": "Opus weekly", "window": { "usedPercent": 5 } }, { "label": 3 }] },
        ],
    });
    let out = parse_usage_accounts(&v);
    assert_eq!(out.len(), 1);
    assert_eq!(out[0].pool, "");
    assert_eq!(out[0].weekly.unwrap().used_percent, 100.0);
    assert_eq!(out[0].session, None);
    assert_eq!(out[0].model_weekly.len(), 1);
    assert!(parse_usage_accounts(&serde_json::json!({ "version": 2, "accounts": [] })).is_empty());
}

#[test]
fn assign_thresholds_resolve_like_ts() {
    let cfg = parse_assign_config(&serde_json::json!({
        "assign": { "work": { "newSessionPct": 96, "moveSessionPct": 90, "newWeeklyPct": 0 }, "Bad": { "newSessionPct": 50 } },
    }));
    assert!(!cfg.assign.contains_key("Bad"));
    let t = resolve_assign_thresholds(Some(&cfg), Some("work"));
    assert_eq!(t.new_session_pct, 96.0);
    assert_eq!(t.move_session_pct, 96.0);
    assert_eq!(t.new_weekly_pct, 97.0);
    assert_eq!(
        resolve_assign_thresholds(Some(&cfg), Some("")),
        DEFAULT_ASSIGN_THRESHOLDS
    );
}
