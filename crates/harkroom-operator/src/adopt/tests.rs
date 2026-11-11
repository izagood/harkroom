use super::*;
use crate::runner_ledger::RetiringFacts;
use std::collections::HashMap;

/// 시험용 probe — pid 별 (살았나, 시작 시각).
struct Fake(HashMap<i32, (bool, Option<i64>)>);

impl IdentityProbe for Fake {
    fn boot_time_sec(&self, pid: i32) -> Option<i64> {
        self.0.get(&pid).and_then(|x| x.1)
    }
    fn alive(&self, pid: i32) -> bool {
        self.0.get(&pid).is_some_and(|x| x.0)
    }
}

fn fake(rows: &[(i32, bool, Option<i64>)]) -> Fake {
    Fake(rows.iter().map(|&(p, a, b)| (p, (a, b))).collect())
}

fn entry(agent: &str, pid: i32, started: i64, boot: Option<i64>) -> RunnerLedgerEntry {
    RunnerLedgerEntry {
        agent_id: agent.into(),
        pid,
        incarnation_id: format!("inc-{pid}"),
        link_secret: Some("s3cret-value".into()),
        started_at_ms: started,
        boot_time_sec: boot,
        spawned_by_nonce: "n".into(),
        spawned_by_app_version: Some("0.4.498".into()),
        retiring: None,
    }
}

#[test]
fn dead_pid_is_not_adopted() {
    let p = fake(&[(10, false, Some(100))]);
    assert_eq!(
        judge_candidate(&entry("a", 10, 1, Some(100)), &p),
        Verdict::Dead
    );
}

#[test]
fn reused_pid_is_not_adopted() {
    let p = fake(&[(10, true, Some(200))]);
    assert_eq!(
        judge_candidate(&entry("a", 10, 1, Some(100)), &p),
        Verdict::PidReused {
            expected: 100,
            actual: Some(200)
        }
    );
}

#[test]
fn missing_ledger_boot_time_is_not_adopted() {
    let p = fake(&[(10, true, Some(100))]);
    assert!(matches!(
        judge_candidate(&entry("a", 10, 1, None), &p),
        Verdict::Unverifiable(_)
    ));
}

#[test]
fn alive_but_unreadable_boot_time_is_not_adopted() {
    let p = fake(&[(10, true, None)]);
    assert_eq!(
        judge_candidate(&entry("a", 10, 1, Some(100)), &p),
        Verdict::PidReused {
            expected: 100,
            actual: None
        }
    );
}

#[test]
fn matching_identity_is_adopted() {
    let p = fake(&[(10, true, Some(100))]);
    assert_eq!(
        judge_candidate(&entry("a", 10, 1, Some(100)), &p),
        Verdict::Adopt
    );
}

#[test]
fn only_latest_per_agent_is_adopted() {
    let p = fake(&[(10, true, Some(100)), (11, true, Some(101))]);
    let plan = plan_adoption(
        &[entry("a", 11, 5, Some(101)), entry("a", 10, 9, Some(100))],
        &p,
        None,
    );
    assert_eq!(plan.adopt.len(), 1);
    assert_eq!(plan.adopt[0].pid, 10);
    assert_eq!(plan.rejected.len(), 1);
    assert_eq!(plan.rejected[0].0.pid, 11);
    assert!(matches!(plan.rejected[0].1, Verdict::Unverifiable(_)));
}

#[test]
fn other_generation_is_retired_not_adopted_and_unknown_version_skips_check() {
    let p = fake(&[(10, true, Some(100)), (11, true, Some(101))]);
    let mut old = entry("b", 11, 1, Some(101));
    old.spawned_by_app_version = None;
    let entries = [entry("a", 10, 1, Some(100)), old];
    let plan = plan_adoption(&entries, &p, Some("0.4.498"));
    assert_eq!(plan.adopt.len(), 1);
    assert_eq!(
        plan.rejected[0].1,
        Verdict::StaleGeneration {
            theirs: None,
            mine: "0.4.498".into()
        }
    );
    // 지금 버전을 모르면 세대를 묻지 않는다 — 모르는 것을 근거로 죽이지 않는다.
    assert_eq!(plan_adoption(&entries, &p, None).adopt.len(), 2);
    // 세대 판정은 신원 뒤 — 죽은 pid 는 Dead 로 남지 Stale 이 되지 않는다.
    let p2 = fake(&[(10, false, Some(100))]);
    let plan = plan_adoption(&entries[..1], &p2, Some("other"));
    assert_eq!(plan.rejected[0].1, Verdict::Dead);
}

#[test]
fn retiring_rows_are_judged_but_never_adopted_and_do_not_compete() {
    let p = fake(&[
        (10, true, Some(100)),
        (11, true, Some(101)),
        (12, true, Some(5)),
    ]);
    let mut retiring = entry("a", 11, 99, Some(101));
    retiring.retiring = Some(RetiringFacts::default());
    let mut reused = entry("a", 12, 98, Some(102));
    reused.retiring = Some(RetiringFacts::default());
    let plan = plan_adoption(
        &[entry("a", 10, 1, Some(100)), retiring, reused],
        &p,
        Some("0.4.498"),
    );
    // 더 늦게 뜬 회수 중 줄이 있어도 지금 러너는 채택된다.
    assert_eq!(plan.adopt.len(), 1);
    assert_eq!(plan.adopt[0].pid, 10);
    assert_eq!(plan.rejected[0].1, Verdict::Retiring);
    // 회수 중이어도 pid 가 재사용됐으면 Retiring 이 아니다(retire 가 남에게 SIGTERM 을 안 보낸다).
    assert!(matches!(plan.rejected[1].1, Verdict::PidReused { .. }));
}

#[test]
fn describe_never_carries_link_secret() {
    let e = entry("a", 10, 1, Some(100));
    for v in [
        Verdict::Dead,
        Verdict::Unverifiable("x".into()),
        Verdict::PidReused {
            expected: 1,
            actual: None,
        },
        Verdict::StaleGeneration {
            theirs: None,
            mine: "m".into(),
        },
        Verdict::Retiring,
    ] {
        let s = describe_verdict(&e, &v);
        assert!(s.contains("agent=a pid=10"), "{s}");
        assert!(!s.contains("s3cret"), "{s}");
    }
    assert!(
        describe_verdict(
            &e,
            &Verdict::PidReused {
                expected: 1,
                actual: None
            }
        )
        .contains("(못 읽음)")
    );
}

#[test]
fn lstart_parses_like_date_parse() {
    assert_eq!(parse_lstart(""), None);
    assert_eq!(parse_lstart("Wed Nov 11 17:30"), None);
    assert_eq!(parse_lstart("Wed Foo 11 17:30:56 2026"), None);
    let a = parse_lstart("Wed Nov 11 17:30:56 2026").unwrap();
    let b = parse_lstart("Wed Nov 11 17:30:57 2026").unwrap();
    assert_eq!(b - a, 1);
    // node `Math.floor(Date.parse(t)/1000)` 를 TZ=Asia/Seoul 에서 잰 값과 같아야 한다(그 TZ 로 돌릴 때만 잰다).
    if std::env::var("TZ").as_deref() == Ok("Asia/Seoul") {
        assert_eq!(a, 1_794_385_856);
        assert_eq!(
            parse_lstart("Sun Nov  1 00:00:00 2026"),
            Some(1_793_458_800)
        );
    }
    // 한 자리 날짜도 받는다(`Nov  1` — 공백 둘).
    assert!(parse_lstart("Sun Nov  1 00:00:00 2026").is_some());
}

#[test]
fn real_probe_reads_own_process_and_rejects_nonsense() {
    let me = std::process::id() as i32;
    let p = PsProbe;
    assert!(p.alive(me));
    let boot = p.boot_time_sec(me).expect("자기 시작 시각을 못 읽었다");
    let now = crate::runners::now_ms() / 1000;
    assert!(
        boot <= now && now - boot < 24 * 3600,
        "boot={boot} now={now}"
    );
    assert_eq!(p.boot_time_sec(0), None);
    assert_eq!(p.boot_time_sec(-1), None);
}

#[derive(Default)]
struct Ports {
    locals: Vec<&'static str>,
    occupied: Vec<&'static str>,
    log: std::sync::Mutex<Vec<String>>,
}

impl AdoptPorts for Ports {
    fn is_local(&self, agent_id: &str) -> bool {
        self.locals.contains(&agent_id)
    }
    fn adopt(&self, e: &RunnerLedgerEntry) -> bool {
        if self.occupied.contains(&e.agent_id.as_str()) {
            return false;
        }
        self.log
            .lock()
            .unwrap()
            .push(format!("adopt {} {}", e.agent_id, e.pid));
        true
    }
    fn retire(&self, e: &RunnerLedgerEntry) {
        self.log
            .lock()
            .unwrap()
            .push(format!("retire {} {}", e.agent_id, e.pid));
    }
    fn link_expect(&self, runner_id: &str, agent_id: &str, secret: &str) {
        self.log
            .lock()
            .unwrap()
            .push(format!("expect {runner_id} {agent_id} {secret}"));
    }
}

#[test]
fn adopt_orphans_adopts_local_retires_stale_and_pairs_secret_with_incarnation() {
    let ok = entry("a1", 10, 1, Some(100));
    let mut stale = entry("a2", 20, 1, Some(200));
    stale.spawned_by_app_version = Some("0.4.400".into());
    let not_local = entry("a3", 30, 1, Some(300));
    let mut no_secret = entry("a4", 40, 1, Some(400));
    no_secret.link_secret = None;
    let occupied = entry("a5", 50, 1, Some(500));
    let dead = entry("a6", 60, 1, Some(600));
    let probe = fake(&[
        (10, true, Some(100)),
        (20, true, Some(200)),
        (30, true, Some(300)),
        (40, true, Some(400)),
        (50, true, Some(500)),
        (60, false, None),
    ]);
    let ports = Ports {
        locals: vec!["a1", "a2", "a4", "a5", "a6"],
        occupied: vec!["a5"],
        ..Default::default()
    };
    let (adopted, lines) = adopt_orphans(
        vec![ok, stale, not_local, no_secret, occupied, dead],
        vec![],
        &probe,
        Some("0.4.498"),
        &ports,
    );
    assert_eq!(adopted, vec!["a1", "a4"]);
    let log = ports.log.into_inner().unwrap();
    assert_eq!(
        log,
        vec![
            "retire a2 20",
            "expect inc-20 a2 s3cret-value",
            "adopt a1 10",
            "expect inc-10 a1 s3cret-value",
            "retire a3 30",
            "adopt a4 40",
        ]
    );
    // 거절 사유는 사람이 읽는다 — secret 은 싣지 않는다.
    assert_eq!(lines.len(), 4, "{lines:?}");
    assert!(lines.iter().all(|l| !l.contains("s3cret")));
    assert!(lines.iter().any(|l| l.contains("로컬 설정에 없는")));
    assert!(
        lines
            .iter()
            .any(|l| l.contains("이미 이 오퍼레이터가 아는"))
    );
}

#[test]
fn adopt_orphans_prefers_fresh_ledger_over_legacy_for_same_pid() {
    let fresh = entry("a1", 10, 5, Some(100));
    let mut legacy_same = entry("a1", 10, 9, Some(100));
    legacy_same.incarnation_id = "legacy-inc".into();
    let legacy_other = entry("b1", 11, 1, Some(110));
    let probe = fake(&[(10, true, Some(100)), (11, true, Some(110))]);
    let ports = Ports {
        locals: vec!["a1", "b1"],
        ..Default::default()
    };
    let (adopted, lines) = adopt_orphans(
        vec![fresh],
        vec![legacy_same, legacy_other],
        &probe,
        Some("0.4.498"),
        &ports,
    );
    assert_eq!(adopted, vec!["a1", "b1"]);
    assert!(lines.is_empty(), "{lines:?}");
    let log = ports.log.into_inner().unwrap();
    assert!(log.contains(&"expect inc-10 a1 s3cret-value".to_string()));
    assert!(!log.iter().any(|l| l.contains("legacy-inc")));
}
