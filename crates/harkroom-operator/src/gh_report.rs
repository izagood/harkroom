//! gh 계정 보고(D1, TS `ghReport.ts`·`community.ts` 의 `beatGh`) — 이 머신의 gh 이름과 저장소별 계정 줄을 서버에 알린다.
//! 다른 기기의 승인 화면이 「이 에이전트는 어느 계정으로 머지하나」를 볼 수 있게. **토큰·이메일은 싣지 않는다** —
//! 모양(`GhReport`)에 그런 칸이 없다.
//!
//! 경계(security #1203 F1): 재료(`operator.json` 의 `merge`·gh 로그인)는 머신 전역이다. 그래서
//! - 줄(byScope)은 **이 커뮤니티에서 머지로 쓴 저장소**(`/agent/merge-checks` 를 이 커뮤니티로 보낸 저장소)에 맞는 줄만 싣는다.
//!   장부(`GhLedger`)는 서버 링크 하나(= 커뮤니티 하나)에 하나다 — TS 의 baseUrl 열쇠와 같은 경계. 메모리에만 든다.
//! - 로그인 목록·옛 기본값은 머신 값이라 거를 길이 없다 — 이 커뮤니티에 이 오퍼레이터 주인의 에이전트가 붙어 있을 때만
//!   싣는다(`own_agent_attached`). 아니면 빈 목록·null 로 보낸다.
//! - 닿음은 이미 아는 것만(이 커뮤니티의 머지가 그 계정으로 머지·큐에 넣었으면 true). 따로 재지 않는다.

use std::collections::{BTreeMap, BTreeSet};
use std::sync::Mutex;
use std::time::{Duration, Instant};

use serde::Serialize;
use serde_json::Value;

use crate::local_merge::{by_scope_of, is_gh_login, legacy_of};

const MAX_REPOS: usize = 64;
/// 로그인 목록 캐시 — 박동마다 gh 를 부르지 않게(TS run.ts `ghLoginsCached`, 5분).
pub const LOGINS_TTL: Duration = Duration::from_secs(5 * 60);

fn lock<T>(m: &Mutex<T>) -> std::sync::MutexGuard<'_, T> {
    m.lock().unwrap_or_else(|e| e.into_inner())
}

/// TS `REPO_RE` — `/^[a-z0-9][a-z0-9._-]{0,99}\/[a-z0-9._-]{1,100}$/`(소문자로 바꾼 뒤 잰다).
fn is_repo(r: &str) -> bool {
    let ok = |p: &str, min: usize, max: usize| {
        p.len() >= min
            && p.len() <= max
            && p.bytes().all(|b| {
                b.is_ascii_lowercase() || b.is_ascii_digit() || matches!(b, b'.' | b'_' | b'-')
            })
    };
    let Some((owner, name)) = r.split_once('/') else {
        return false;
    };
    owner
        .bytes()
        .next()
        .is_some_and(|b| b.is_ascii_lowercase() || b.is_ascii_digit())
        && ok(owner, 1, 100)
        && ok(name, 1, 100)
}

#[derive(Default)]
struct LedgerState {
    repos: BTreeSet<String>,
    reach: BTreeMap<(String, String), bool>,
}

/// TS `createGhLedger` — 이 커뮤니티가 머지로 물은 저장소와 닿은 계정. 커뮤니티(서버 링크)마다 하나.
#[derive(Default)]
pub struct GhLedger {
    st: Mutex<LedgerState>,
}

impl GhLedger {
    /// 이 커뮤니티가 이 저장소로 머지를 물었다.
    pub fn note_repo(&self, repo: &str) {
        let r = repo.to_lowercase();
        if !is_repo(&r) {
            return;
        }
        let mut st = lock(&self.st);
        if st.repos.len() >= MAX_REPOS && !st.repos.contains(&r) {
            return;
        }
        st.repos.insert(r);
    }

    /// 이 커뮤니티의 머지가 이 계정으로 이 저장소에 닿았다/못 닿았다.
    pub fn note_reach(&self, repo: &str, login: &str, reachable: bool) {
        let r = repo.to_lowercase();
        if !is_repo(&r) || !is_gh_login(login) {
            return;
        }
        let key = (r, login.to_string());
        let mut st = lock(&self.st);
        if st.reach.len() >= MAX_REPOS * 4 && !st.reach.contains_key(&key) {
            return;
        }
        st.reach.insert(key, reachable);
    }

    /// TS run.ts `noteGhUse` — 머지 길이 서버로 보내는 `/agent/merge-checks`·`/agent/merge-results` 본문에서 저장소·닿음을 적는다.
    /// `pr.status` 같은 읽기 길에는 걸지 않는다 — 읽기 한 번으로 계정 줄이 보고에 실리는 길을 만들지 않는다.
    pub fn note_merge_post(&self, path: &str, body: &str) {
        if path != "/agent/merge-checks" && path != "/agent/merge-results" {
            return;
        }
        let Ok(b) = serde_json::from_str::<Value>(body) else {
            return;
        };
        let Some(repo) = b.get("repo").and_then(Value::as_str) else {
            return;
        };
        self.note_repo(repo);
        if path == "/agent/merge-results"
            && let Some(u) = b.get("ghUserUsed").and_then(Value::as_str)
            && matches!(
                b.get("result").and_then(Value::as_str),
                Some("merged" | "queued")
            )
        {
            self.note_reach(repo, u, true);
        }
    }

    pub fn repos(&self) -> BTreeSet<String> {
        lock(&self.st).repos.clone()
    }

    pub fn reach(&self) -> BTreeMap<(String, String), bool> {
        lock(&self.st).reach.clone()
    }
}

/// 닿음 한 줄(TS `GhReport['reach'][number]`).
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct GhReachLine {
    pub scope: String,
    pub login: String,
    pub reachable: bool,
}

/// TS `GhReport` — 칸은 이것뿐이다. 토큰·이메일 칸은 애초에 없다.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GhReport {
    pub logins: Vec<String>,
    pub by_scope: BTreeMap<String, String>,
    pub default_gh_user: Option<String>,
    pub reach: Vec<GhReachLine>,
}

impl GhReport {
    /// 머신 값(로그인 목록·옛 기본값)을 뺀다(n7 결정 A). 줄·닿음은 이미 이 커뮤니티 것이라 그대로 둔다.
    pub fn without_machine(self) -> Self {
        Self {
            logins: Vec::new(),
            default_gh_user: None,
            ..self
        }
    }
}

/// TS `buildGhReport` — `repos` 는 이 커뮤니티가 머지로 물은 저장소. 그 저장소에 맞는 줄(정확한 `owner/name`, 또는
/// `owner/*`)만 남긴다. `logins` 는 `gh auth status` 의 이름뿐(토큰 칸은 애초에 읽지 않는다, `parse_gh_accounts`).
pub fn build_gh_report(
    merge: Option<&Value>,
    logins: &[String],
    repos: &BTreeSet<String>,
    reach: &BTreeMap<(String, String), bool>,
) -> GhReport {
    let mut by_scope = BTreeMap::new();
    for (scope, login) in by_scope_of(merge).unwrap_or_default() {
        let Some(login) = login.as_str() else {
            continue;
        };
        let mut parts = scope.split('/');
        let (owner, name) = (parts.next().unwrap_or(""), parts.next());
        let relevant = if name == Some("*") {
            repos.iter().any(|r| r.split('/').next() == Some(owner))
        } else {
            repos.contains(&scope)
        };
        if relevant {
            by_scope.insert(scope, login.to_string());
        }
    }
    let reach = reach
        .iter()
        .filter(|((repo, _), _)| repos.contains(repo))
        .map(|((repo, login), ok)| GhReachLine {
            scope: repo.clone(),
            login: login.clone(),
            reachable: *ok,
        })
        .collect();
    let logins: BTreeSet<String> = logins.iter().filter(|l| is_gh_login(l)).cloned().collect();
    GhReport {
        logins: logins.into_iter().collect(),
        by_scope,
        default_gh_user: legacy_of(merge),
        reach,
    }
}

/// 박동 한 번이 쓰는 재료(시험에서 가짜로 바꾼다).
pub trait GhReportPorts {
    /// 이 커뮤니티에 로컬 에이전트가 있나. 없으면 보고를 내지 않는다.
    fn has_local_agents(&self) -> bool;
    /// 지금 `operator.json` 의 `merge`.
    fn merge_config(&self) -> Option<Value>;
    /// gh 로그인 이름(캐시된 값이어도 된다). 못 읽으면 빈 목록.
    fn logins(&self) -> Vec<String>;
    /// 이 커뮤니티에 붙은 에이전트 중 주인이 이 오퍼레이터 주인과 같은 것이 있나(TS `ownAgentAttached`).
    fn own_agent_attached(&self) -> bool;
    /// `gh.report` 프레임의 `report` 를 보낸다. 보냈으면 true.
    fn send(&self, report: Value) -> bool;
}

/// 한 커뮤니티의 보고 상태 — 장부와 마지막으로 보낸 값. 같은 값이면 다시 보내지 않는다(TS `lastGh`).
#[derive(Default)]
pub struct GhReporter {
    pub ledger: std::sync::Arc<GhLedger>,
    last: Mutex<Option<String>>,
}

impl GhReporter {
    pub fn new(ledger: std::sync::Arc<GhLedger>) -> Self {
        Self {
            ledger,
            last: Mutex::new(None),
        }
    }

    /// 다시 붙으면 잊는다 — 서버가 첫 값을 받게.
    pub fn reset(&self) {
        *lock(&self.last) = None;
    }

    /// TS `beatGh`.
    pub fn beat(&self, ports: &dyn GhReportPorts) {
        if !ports.has_local_agents() {
            return;
        }
        let built = build_gh_report(
            ports.merge_config().as_ref(),
            &ports.logins(),
            &self.ledger.repos(),
            &self.ledger.reach(),
        );
        let report = if ports.own_agent_attached() {
            built
        } else {
            built.without_machine()
        };
        let Ok(value) = serde_json::to_value(&report) else {
            return;
        };
        let key = value.to_string();
        let mut last = lock(&self.last);
        if last.as_deref() == Some(key.as_str()) {
            return;
        }
        if ports.send(value) {
            *last = Some(key);
        }
    }
}

/// 로그인 목록 캐시(TS run.ts `ghLoginsCached`). 이름뿐 — 토큰 칸은 읽지 않는다.
#[derive(Default)]
pub struct LoginsCache {
    st: Mutex<Option<(Instant, Vec<String>)>>,
}

impl LoginsCache {
    pub fn get(&self, now: Instant, fetch: impl FnOnce() -> Vec<String>) -> Vec<String> {
        if let Some((at, l)) = lock(&self.st).as_ref()
            && now.duration_since(*at) < LOGINS_TTL
        {
            return l.clone();
        }
        let logins = fetch();
        *lock(&self.st) = Some((now, logins.clone()));
        logins
    }
}

/// 실제 gh 로 로그인 이름을 읽는다(토큰 없는 env, `gh auth status --json hosts`).
pub fn read_gh_logins(exec: &crate::local_merge::Exec, gh_path: &str, home: &str) -> Vec<String> {
    let args: Vec<String> = ["auth", "status", "--json", "hosts"]
        .iter()
        .map(|s| s.to_string())
        .collect();
    let r = exec(gh_path, &args, &crate::local_merge::gh_env(home, None));
    crate::local_merge::parse_gh_accounts(&r.stdout)
        .unwrap_or_default()
        .into_iter()
        .map(|(l, _)| l)
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;
    use std::cell::{Cell, RefCell};

    fn merge() -> Value {
        json!({
            "ghUser": "legacy-user",
            "byScope": {"work-org/*": "work-bot", "work-org/app": "work-admin", "me/notes": "me", "other-co/secret": "other-bot"},
            "token": "ghp_SHOULD_NOT_LEAK",
        })
    }

    fn s(v: &[&str]) -> Vec<String> {
        v.iter().map(|x| x.to_string()).collect()
    }

    #[test]
    fn only_lines_for_repos_this_community_merged_and_no_token_or_email() {
        let (work_l, me_l) = (GhLedger::default(), GhLedger::default());
        work_l.note_repo("Work-Org/App");
        me_l.note_repo("me/notes");
        work_l.note_reach("work-org/app", "work-admin", true);
        me_l.note_reach("me/notes", "me", true);
        let m = merge();
        let work = build_gh_report(
            Some(&m),
            &s(&["work-admin", "me", "bad login!"]),
            &work_l.repos(),
            &work_l.reach(),
        );
        let v = serde_json::to_value(&work).unwrap();
        assert_eq!(
            v,
            json!({
                "logins": ["me", "work-admin"],
                "byScope": {"work-org/*": "work-bot", "work-org/app": "work-admin"},
                "defaultGhUser": "legacy-user",
                "reach": [{"scope": "work-org/app", "login": "work-admin", "reachable": true}],
            })
        );
        let text = v.to_string().to_lowercase();
        for bad in ["ghp_", "token", "email", "@", "other-co", "me/notes"] {
            assert!(!text.contains(bad), "{bad} 가 샜다: {text}");
        }
        let me = build_gh_report(Some(&m), &[], &me_l.repos(), &me_l.reach());
        assert_eq!(
            me.by_scope,
            BTreeMap::from([("me/notes".to_string(), "me".to_string())])
        );
    }

    #[test]
    fn no_merged_repo_means_no_lines() {
        let r = build_gh_report(
            Some(&merge()),
            &s(&["me"]),
            &BTreeSet::new(),
            &BTreeMap::new(),
        );
        assert!(r.by_scope.is_empty());
        assert!(r.reach.is_empty());
    }

    #[test]
    fn reach_of_other_repos_is_dropped() {
        let l = GhLedger::default();
        l.note_repo("a/b");
        l.note_reach("c/d", "x", true);
        let r = build_gh_report(None, &[], &l.repos(), &l.reach());
        assert!(r.reach.is_empty());
    }

    #[test]
    fn report_shape_has_no_room_for_token_or_email() {
        // 모양이 칸을 정한다 — 어떤 재료를 넣어도 나오는 열쇠는 이 넷뿐이다.
        let l = GhLedger::default();
        l.note_repo("o/r");
        let m = json!({"ghUser": "a", "byScope": {"o/r": "a"}, "token": "ghp_x", "email": "a@example.com"});
        let v = serde_json::to_value(build_gh_report(
            Some(&m),
            &s(&["a", "a@example.com"]),
            &l.repos(),
            &l.reach(),
        ))
        .unwrap();
        let mut keys: Vec<&String> = v.as_object().unwrap().keys().collect();
        keys.sort();
        assert_eq!(keys, ["byScope", "defaultGhUser", "logins", "reach"]);
        assert!(!v.to_string().contains("ghp_") && !v.to_string().contains('@'));
    }

    #[test]
    fn ledger_reads_only_merge_posts() {
        let l = GhLedger::default();
        l.note_merge_post("/agent/pr-status", r#"{"repo":"x/y"}"#);
        l.note_merge_post("/agent/merge-checks", r#"{"repo":"O/R","token":"t"}"#);
        l.note_merge_post(
            "/agent/merge-results",
            r#"{"repo":"o/r","result":"failed","ghUserUsed":"bot"}"#,
        );
        l.note_merge_post(
            "/agent/merge-results",
            r#"{"repo":"o/q","result":"queued","ghUserUsed":"bot"}"#,
        );
        l.note_merge_post("/agent/merge-checks", "not json");
        l.note_repo("../evil");
        assert_eq!(
            l.repos().into_iter().collect::<Vec<_>>(),
            ["o/q".to_string(), "o/r".to_string()]
        );
        assert_eq!(
            l.reach(),
            BTreeMap::from([(("o/q".to_string(), "bot".to_string()), true)])
        );
    }

    #[test]
    fn ledger_is_bounded() {
        let l = GhLedger::default();
        for i in 0..100 {
            l.note_repo(&format!("o/r{i}"));
        }
        assert_eq!(l.repos().len(), MAX_REPOS);
    }

    struct Fake {
        agents: bool,
        own: bool,
        sent: RefCell<Vec<Value>>,
        login_calls: Cell<u32>,
    }

    impl Fake {
        fn new(agents: bool, own: bool) -> Self {
            Self {
                agents,
                own,
                sent: RefCell::new(Vec::new()),
                login_calls: Cell::new(0),
            }
        }
    }

    impl GhReportPorts for Fake {
        fn has_local_agents(&self) -> bool {
            self.agents
        }
        fn merge_config(&self) -> Option<Value> {
            Some(json!({"ghUser": "legacy-user", "byScope": {"work-org/app": "work-bot"}}))
        }
        fn logins(&self) -> Vec<String> {
            self.login_calls.set(self.login_calls.get() + 1);
            s(&["me", "work-bot"])
        }
        fn own_agent_attached(&self) -> bool {
            self.own
        }
        fn send(&self, report: Value) -> bool {
            self.sent.borrow_mut().push(report);
            true
        }
    }

    fn reporter() -> GhReporter {
        let r = GhReporter::default();
        r.ledger.note_merge_post(
            "/agent/merge-results",
            r#"{"repo":"work-org/app","result":"merged","ghUserUsed":"work-bot"}"#,
        );
        r
    }

    fn machineless() -> Value {
        json!({"byScope": {"work-org/app": "work-bot"}, "reach": [{"scope": "work-org/app", "login": "work-bot", "reachable": true}]})
    }

    fn with(mut v: Value, logins: Value, default: Value) -> Value {
        v["logins"] = logins;
        v["defaultGhUser"] = default;
        v
    }

    #[test]
    fn sends_only_when_this_community_has_local_agents() {
        let f = Fake::new(false, true);
        reporter().beat(&f);
        assert!(f.sent.borrow().is_empty());
    }

    #[test]
    fn own_agent_attached_carries_machine_values() {
        let f = Fake::new(true, true);
        reporter().beat(&f);
        assert_eq!(
            f.sent.borrow().as_slice(),
            [with(
                machineless(),
                json!(["me", "work-bot"]),
                json!("legacy-user")
            )]
        );
    }

    #[test]
    fn foreign_agents_only_drop_machine_values_but_keep_lines() {
        let f = Fake::new(true, false);
        reporter().beat(&f);
        assert_eq!(
            f.sent.borrow().as_slice(),
            [with(machineless(), json!([]), Value::Null)]
        );
    }

    #[test]
    fn same_report_is_not_resent_until_reset() {
        let f = Fake::new(true, true);
        let r = reporter();
        r.beat(&f);
        r.beat(&f);
        assert_eq!(f.sent.borrow().len(), 1);
        r.reset();
        r.beat(&f);
        assert_eq!(f.sent.borrow().len(), 2);
    }

    #[test]
    fn logins_cache_reuses_within_ttl() {
        let c = LoginsCache::default();
        let t0 = Instant::now();
        let calls = Cell::new(0);
        let fetch = || {
            calls.set(calls.get() + 1);
            s(&["a"])
        };
        assert_eq!(c.get(t0, fetch), s(&["a"]));
        assert_eq!(c.get(t0 + Duration::from_secs(10), fetch), s(&["a"]));
        assert_eq!(calls.get(), 1);
        c.get(t0 + LOGINS_TTL + Duration::from_secs(1), fetch);
        assert_eq!(calls.get(), 2);
    }

    #[test]
    fn read_gh_logins_takes_names_only() {
        let exec: crate::local_merge::Exec = std::sync::Arc::new(|_f, args, env| {
            assert_eq!(args.join(" "), "auth status --json hosts");
            assert!(!env.iter().any(|(k, _)| k == "GH_TOKEN"));
            crate::local_merge::ExecResult {
                code: 0,
                stdout: r#"{"hosts":{"github.com":[{"login":"a","active":true,"token":"gho_x"},{"login":"b c"}]}}"#.into(),
                stderr: String::new(),
            }
        });
        assert_eq!(read_gh_logins(&exec, "gh", "/h"), s(&["a"]));
    }
}
