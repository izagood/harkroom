use super::*;
use std::path::PathBuf;

#[derive(Debug, PartialEq, Eq)]
enum E {
    Quota(Option<&'static str>),
    Waiting,
    Timeout,
    Credential,
    Plain,
}

impl AccountFailureClass for E {
    fn account_failure(&self) -> Option<FailureOf> {
        let f = |kind, resets_at: Option<&str>| {
            Some(FailureOf {
                kind,
                resets_at: resets_at.map(str::to_string),
            })
        };
        match self {
            E::Quota(r) => f(AccountFailureKind::Quota, *r),
            E::Waiting => f(AccountFailureKind::Gate, None),
            E::Timeout => f(AccountFailureKind::Timeout, None),
            E::Credential => f(AccountFailureKind::Credential, None),
            E::Plain => None,
        }
    }
}

fn acct(name: &str) -> Option<ClaudeAccount> {
    Some(ClaudeAccount {
        name: name.into(),
        config_dir: PathBuf::from(format!("cfg/{name}")),
        pool: None,
    })
}

type Calls = Vec<(Option<String>, bool)>;
type Out = Result<Result<u32, FailoverError<E>>, EmptyLane>;

fn run(
    lane: &[Option<ClaudeAccount>],
    mut results: Vec<Result<u32, E>>,
) -> (Out, Calls, Vec<String>) {
    let mut calls = Vec::new();
    let mut switches = Vec::new();
    results.reverse();
    let out = with_account_failover(
        lane,
        |a, last| {
            calls.push((a.map(|a| a.name.clone()), last));
            results.pop().expect("시도 수가 결과보다 많다")
        },
        |from, to, why| switches.push(switch_log_line("m1", from, to, why)),
    );
    (out, calls, switches)
}

#[test]
fn empty_lane_is_caller_bug() {
    let (out, calls, _) = run(&[], vec![]);
    assert_eq!(out, Err(EmptyLane));
    assert!(calls.is_empty());
}

#[test]
fn no_pool_runs_once_as_last() {
    let (out, calls, sw) = run(&[None], vec![Ok(7)]);
    assert_eq!(out, Ok(Ok(7)));
    assert_eq!(calls, vec![(None, true)]);
    assert!(sw.is_empty());
}

#[test]
fn single_account_switch_failure_has_no_trail() {
    let (out, _, _) = run(&[acct("a")], vec![Err(E::Quota(Some("23:00")))]);
    let err = out.unwrap().unwrap_err();
    assert_eq!(err.error, E::Quota(Some("23:00")));
    assert!(err.trail.is_empty());
}

#[test]
fn switches_then_succeeds() {
    let lane = [acct("a"), acct("b"), acct("c")];
    let (out, calls, sw) = run(&lane, vec![Err(E::Waiting), Ok(1)]);
    assert_eq!(out, Ok(Ok(1)));
    assert_eq!(
        calls,
        vec![(Some("a".into()), false), (Some("b".into()), false)]
    );
    assert_eq!(sw, vec!["  m1 계정 전환: a → b (이유: gate)".to_string()]);
}

#[test]
fn non_switch_error_stops_with_prior_trail() {
    let lane = [acct("a"), acct("b"), acct("c")];
    let (out, calls, _) = run(&lane, vec![Err(E::Quota(None)), Err(E::Plain)]);
    let err = out.unwrap().unwrap_err();
    assert_eq!(err.error, E::Plain);
    assert_eq!(calls.len(), 2);
    assert_eq!(
        err.trail,
        vec![AccountFailure {
            account: Some("a".into()),
            kind: AccountFailureKind::Quota,
            resets_at: None
        }]
    );
}

#[test]
fn all_accounts_exhausted_keeps_every_reason() {
    let lane = [acct("a"), acct("b"), acct("c")];
    let (out, calls, sw) = run(
        &lane,
        vec![
            Err(E::Waiting),
            Err(E::Credential),
            Err(E::Quota(Some("t"))),
        ],
    );
    let err = out.unwrap().unwrap_err();
    assert_eq!(err.error, E::Quota(Some("t")));
    assert_eq!(calls.last(), Some(&(Some("c".into()), true)));
    let kinds: Vec<_> = err.trail.iter().map(|f| f.kind).collect();
    assert_eq!(
        kinds,
        vec![
            AccountFailureKind::Gate,
            AccountFailureKind::Credential,
            AccountFailureKind::Quota
        ]
    );
    assert_eq!(err.trail[2].resets_at.as_deref(), Some("t"));
    assert_eq!(sw[1], "  m1 계정 전환: b → c (이유: credential)");
}

#[test]
fn timeout_switches_too() {
    let lane = [acct("a"), None];
    let (out, _, sw) = run(&lane, vec![Err(E::Timeout), Ok(2)]);
    assert_eq!(out, Ok(Ok(2)));
    assert_eq!(
        sw,
        vec!["  m1 계정 전환: a → (기본) (이유: timeout)".to_string()]
    );
}

#[test]
fn marks_clear_attention_only_when_delivered() {
    use Mark::*;
    let m = |end, d| marks_after(end, d);
    assert_eq!(
        m(AttemptEnd::Ok, true),
        Marks {
            attention: Clear,
            auth: Clear
        }
    );
    assert_eq!(
        m(AttemptEnd::Ok, false),
        Marks {
            attention: Keep,
            auth: Clear
        }
    );
    // 관문 앞에서 멈춘 시도는 표식을 세운다(지우지 않는다 — #1047 F1).
    assert_eq!(
        m(AttemptEnd::Waiting, false),
        Marks {
            attention: Set,
            auth: Keep
        }
    );
    assert_eq!(
        m(AttemptEnd::Credential, false),
        Marks {
            attention: Keep,
            auth: Set
        }
    );
    assert_eq!(
        m(AttemptEnd::Credential, true),
        Marks {
            attention: Clear,
            auth: Set
        }
    );
    assert_eq!(
        m(AttemptEnd::OtherErr, true),
        Marks {
            attention: Clear,
            auth: Keep
        }
    );
    assert_eq!(
        m(AttemptEnd::OtherErr, false),
        Marks {
            attention: Keep,
            auth: Keep
        }
    );
}
