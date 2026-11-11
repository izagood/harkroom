//! 머지 관문 판정(PR gate) — TS `turnMerge.ts` 의 **읽기 전용** 부분(`createPrGate`·`createGhTokens`·판정 함수들) 이식.
//! 머지 길(`repo.merge`)과 읽기 전용 `pr.status` 가 같은 판정을 쓴다 — 「초록」의 뜻이 두 길에서 갈라지면 상태는 초록인데
//! 머지는 거절되는 일이 생긴다. 그래서 판정은 여기 한 군데에만 둔다.
//!
//! 이 모듈은 부작용이 없다 — gh 는 읽기(`pr view`·GraphQL query·activity GET)와 `auth token` 만 부른다.
//! 머지·큐 넣기·서버 보고는 부르는 쪽(turn_merge)이 정한다.
use crate::local_merge::{ExecResult, gh_env};
use crate::turn_leases::parse_iso_ms;
use indexmap::IndexMap;
use serde_json::Value;
use std::collections::HashMap;
use std::sync::{Arc, Mutex};

/// TS `SHA_RE` = `^[0-9a-f]{40}$`.
pub fn is_sha(s: &str) -> bool {
    s.len() == 40
        && s.bytes()
            .all(|c| c.is_ascii_digit() || (b'a'..=b'f').contains(&c))
}

#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct Refusal {
    pub code: String,
    pub message: String,
}
fn refusal(code: &str, message: impl Into<String>) -> Refusal {
    Refusal {
        code: code.into(),
        message: message.into(),
    }
}

/// statusCheckRollup 한 칸(check-run 또는 옛 status-context). `is_required` 는 GraphQL 필수 조회에서만 온다.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct CheckItem {
    pub status: Option<String>,
    pub conclusion: Option<String>,
    pub state: Option<String>,
    pub name: Option<String>,
    pub context: Option<String>,
    pub workflow_name: Option<String>,
    pub started_at: Option<String>,
    pub is_required: bool,
}

#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct PrView {
    pub state: Option<String>,
    pub is_draft: bool,
    pub head_ref_oid: Option<String>,
    pub base_ref_name: Option<String>,
    pub merge_state_status: Option<String>,
    pub checks: Vec<CheckItem>,
}

fn s_of(v: &Value, k: &str) -> Option<String> {
    v.get(k).and_then(Value::as_str).map(str::to_string)
}

impl PrView {
    /// `gh pr view --json …` 의 답. 객체가 아니면 None(TS 는 JSON.parse 실패를 `unparseable` 로 본다).
    pub fn parse(stdout: &str) -> Option<PrView> {
        let v: Value = serde_json::from_str(stdout).ok()?;
        if !v.is_object() {
            return None;
        }
        let checks = v
            .get("statusCheckRollup")
            .and_then(Value::as_array)
            .map(|a| a.iter().filter(|c| c.is_object()).map(check_of).collect())
            .unwrap_or_default();
        Some(PrView {
            state: s_of(&v, "state"),
            is_draft: v.get("isDraft").and_then(Value::as_bool).unwrap_or(false),
            head_ref_oid: s_of(&v, "headRefOid"),
            base_ref_name: s_of(&v, "baseRefName"),
            merge_state_status: s_of(&v, "mergeStateStatus"),
            checks,
        })
    }
}

fn check_of(c: &Value) -> CheckItem {
    CheckItem {
        status: s_of(c, "status"),
        conclusion: s_of(c, "conclusion"),
        state: s_of(c, "state"),
        name: s_of(c, "name"),
        context: s_of(c, "context"),
        workflow_name: s_of(c, "workflowName"),
        started_at: s_of(c, "startedAt"),
        is_required: c.get("isRequired").and_then(Value::as_bool) == Some(true),
    }
}

/// 체크 하나가 초록인가 — check-run 은 `conclusion`, 옛 status-context 는 `state` 로 말한다.
/// TS 는 `if (c.state)` — 빈 문자열은 거짓이라 conclusion 쪽으로 간다.
fn check_green(c: &CheckItem) -> bool {
    if let Some(s) = c.state.as_deref().filter(|s| !s.is_empty()) {
        return s == "SUCCESS";
    }
    if let Some(st) = c.status.as_deref().filter(|s| !s.is_empty())
        && st != "COMPLETED"
    {
        return false;
    }
    matches!(
        c.conclusion.as_deref(),
        Some("SUCCESS" | "SKIPPED" | "NEUTRAL")
    )
}

/// 실패로 끝난 실행(C1). 취소·진행 중은 여기 안 든다.
fn check_red(c: &CheckItem) -> bool {
    if let Some(s) = c.state.as_deref().filter(|s| !s.is_empty()) {
        return s == "FAILURE" || s == "ERROR";
    }
    matches!(
        c.conclusion.as_deref(),
        Some("FAILURE" | "TIMED_OUT" | "ACTION_REQUIRED")
    )
}

/// 시작 시각(ms). 없거나 gh 의 빈 값(`0001-01-01…`)이면 None.
fn started_of(c: &CheckItem) -> Option<u64> {
    c.started_at
        .as_deref()
        .and_then(parse_iso_ms)
        .filter(|t| *t > 0)
}

#[derive(Debug, Clone, PartialEq, Eq)]
struct Judged {
    name: String,
    green: bool,
    red: bool,
    required: bool,
}

/// 이름별로 묶어 **최신 실행 하나**로 판정한다(TS `checksByName` 과 같은 규칙·같은 열쇠·같은 순서).
fn checks_by_name(checks: &[CheckItem]) -> IndexMap<String, Judged> {
    let mut groups: IndexMap<String, (String, Vec<&CheckItem>)> = IndexMap::new();
    for (i, c) in checks.iter().enumerate() {
        let name = c
            .name
            .clone()
            .or_else(|| c.context.clone())
            .unwrap_or_else(|| format!("#{i}"));
        let k = match (&c.name, &c.context) {
            (Some(n), _) => format!("run\0{}\0{}", c.workflow_name.as_deref().unwrap_or(""), n),
            (None, Some(ctx)) => format!("ctx\0{ctx}"),
            _ => format!("#{i}"),
        };
        groups
            .entry(k)
            .or_insert_with(|| (name, Vec::new()))
            .1
            .push(c);
    }
    let mut out = IndexMap::new();
    for (k, (name, runs)) in groups {
        let live: Vec<&CheckItem> = runs
            .iter()
            .copied()
            .filter(|c| c.conclusion.as_deref() != Some("CANCELLED"))
            .collect();
        let pool = if live.is_empty() { runs.clone() } else { live };
        let times: Vec<Option<u64>> = pool.iter().map(|c| started_of(c)).collect();
        let judged: Vec<&CheckItem> = if times.iter().all(Option::is_some) {
            let max = times.iter().flatten().copied().max();
            pool.iter()
                .zip(&times)
                .filter(|(_, t)| **t == max)
                .map(|(c, _)| *c)
                .collect()
        } else {
            pool
        };
        out.insert(
            k,
            Judged {
                name,
                green: judged.iter().all(|c| check_green(c)),
                red: judged.iter().any(|c| check_red(c)),
                required: runs.iter().any(|c| c.is_required),
            },
        );
    }
    out
}

fn not_green(by: &IndexMap<String, Judged>, only_required: bool) -> Vec<String> {
    by.values()
        .filter(|v| (!only_required || v.required) && (v.red || !v.green))
        .map(|v| v.name.clone())
        .collect()
}

/// TS `namesOf` — `join(', ').slice(0, 200)`(UTF-16 단위 — 체크 이름은 사실상 ASCII 라 글자 단위로 자른다).
fn names_of(names: &[String]) -> String {
    names.join(", ").chars().take(200).collect()
}

/// 결과 JSON 의 `ignoredChecks` 값 — 이름 80자·20개까지.
pub fn ignored_list(ignored: &[String]) -> Vec<String> {
    ignored
        .iter()
        .take(20)
        .map(|n| n.chars().take(80).collect())
        .collect()
}

/// PR 의 초록 아닌 체크 이름(이름별, C1).
pub fn not_green_checks(pr: &PrView) -> Vec<String> {
    not_green(&checks_by_name(&pr.checks), false)
}

const RELAX_STATES: [&str; 3] = ["CLEAN", "UNSTABLE", "HAS_HOOKS"];

/// 머지 전 PR 상태 판정(TS `refusalOf`).
pub fn refusal_of(pr: &PrView, head_sha: &str, relax_checks: bool) -> Option<Refusal> {
    if pr.state.as_deref() != Some("OPEN") {
        return Some(refusal(
            "not_open",
            format!("PR is {}", pr.state.as_deref().unwrap_or("unknown")),
        ));
    }
    if pr.is_draft {
        return Some(refusal("draft", "PR is a draft"));
    }
    if pr.head_ref_oid.as_deref() != Some(head_sha) {
        return Some(refusal(
            "head_moved",
            format!(
                "PR head is {}, not {head_sha}",
                pr.head_ref_oid.as_deref().unwrap_or("?")
            ),
        ));
    }
    let mss = pr.merge_state_status.as_deref();
    if relax_checks {
        if RELAX_STATES.contains(&mss.unwrap_or("")) {
            return None;
        }
        return Some(refusal(
            "not_mergeable",
            format!(
                "mergeStateStatus is {} — an approval that skips CI still needs CLEAN, UNSTABLE or HAS_HOOKS (conflicts, an out-of-date branch and other branch protection are not skipped)",
                mss.unwrap_or("unknown")
            ),
        ));
    }
    let by = checks_by_name(&pr.checks);
    let red = not_green(&by, false);
    if mss != Some("CLEAN") {
        let tail = if red.is_empty() {
            String::new()
        } else {
            format!(" — not green: {}", names_of(&red))
        };
        return Some(refusal(
            "not_mergeable",
            format!(
                "mergeStateStatus is {} (need CLEAN){tail}",
                mss.unwrap_or("unknown")
            ),
        ));
    }
    if by.is_empty() || !red.is_empty() {
        let msg = if by.is_empty() {
            "no checks reported".to_string()
        } else {
            format!("not green: {}", names_of(&red))
        };
        return Some(refusal("ci_not_green", msg));
    }
    None
}

/// 필수 체크 조회(GraphQL, 읽기 전용) — TS `REQUIRED_QUERY` 와 글자까지 같다.
pub const REQUIRED_QUERY: &str = "query($owner:String!,$name:String!,$number:Int!){repository(owner:$owner,name:$name){pullRequest(number:$number){commits(last:1){nodes{commit{oid statusCheckRollup{contexts(first:100){pageInfo{hasNextPage} nodes{__typename ... on CheckRun{name status conclusion startedAt checkSuite{workflowRun{workflow{name}}} isRequired(pullRequestNumber:$number)} ... on StatusContext{context state createdAt isRequired(pullRequestNumber:$number)}}}}}}}}}}";

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct RequiredChecks {
    pub head_oid: String,
    pub truncated: bool,
    pub checks: Vec<CheckItem>,
}

/// `REQUIRED_QUERY` 의 답. 모양이 틀리면 None(→ 머지하지 않는다).
pub fn parse_required_checks(stdout: &str) -> Option<RequiredChecks> {
    let v: Value = serde_json::from_str(stdout).ok()?;
    let commit = v.pointer("/data/repository/pullRequest/commits/nodes/0/commit")?;
    let oid = commit.get("oid")?.as_str()?.to_string();
    let ctx = commit
        .get("statusCheckRollup")
        .and_then(|r| r.get("contexts"));
    let checks = ctx
        .and_then(|c| c.get("nodes"))
        .and_then(Value::as_array)
        .map(|nodes| {
            nodes
                .iter()
                .filter(|n| n.is_object())
                .map(|n| {
                    let mut c = check_of(n);
                    c.workflow_name = n
                        .pointer("/checkSuite/workflowRun/workflow/name")
                        .and_then(Value::as_str)
                        .map(str::to_string);
                    c.started_at = s_of(n, "startedAt").or_else(|| s_of(n, "createdAt"));
                    c
                })
                .collect()
        })
        .unwrap_or_default();
    let truncated = ctx
        .and_then(|c| c.pointer("/pageInfo/hasNextPage"))
        .and_then(Value::as_bool)
        == Some(true);
    Some(RequiredChecks {
        head_oid: oid,
        truncated,
        checks,
    })
}

/// `UNSTABLE` 판정 — 필수 체크가 하나 이상이고 전부 초록이면 통과(`Ok(ignored)`).
pub fn unstable_verdict(rc: &RequiredChecks, head_sha: &str) -> Result<Vec<String>, Refusal> {
    if rc.head_oid != head_sha {
        return Err(refusal(
            "head_moved",
            format!("PR head is {}, not {head_sha}", rc.head_oid),
        ));
    }
    if rc.truncated {
        return Err(refusal(
            "not_mergeable",
            "mergeStateStatus is UNSTABLE and the PR has more than 100 checks — not judged (need CLEAN)",
        ));
    }
    let by = checks_by_name(&rc.checks);
    let required = by.values().filter(|v| v.required).count();
    let red = not_green(&by, false);
    if required == 0 {
        let names = names_of(&red);
        return Err(refusal(
            "ci_not_green",
            format!(
                "not green: {} — the base branch defines no required status checks, so every check must pass; make the checks that must pass required (branch protection or a ruleset) to let other failures through",
                if names.is_empty() {
                    "(none reported)".to_string()
                } else {
                    names
                }
            ),
        ));
    }
    let required_red = not_green(&by, true);
    if !required_red.is_empty() {
        return Err(refusal(
            "ci_not_green",
            format!("required checks not green: {}", names_of(&required_red)),
        ));
    }
    Ok(red)
}

pub const QUEUE_QUERY: &str = "query($owner:String!,$name:String!,$number:Int!){repository(owner:$owner,name:$name){pullRequest(number:$number){id isMergeQueueEnabled isInMergeQueue mergeQueueEntry{position state}}}}";
pub const ENQUEUE_MUTATION: &str = "mutation($id:ID!,$head:GitObjectID!){enqueuePullRequest(input:{pullRequestId:$id,expectedHeadOid:$head}){mergeQueueEntry{position state}}}";

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct QueueEntry {
    pub position: Option<i64>,
    pub state: Option<String>,
}
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct QueueInfo {
    pub id: String,
    pub enabled: bool,
    pub in_queue: bool,
    pub entry: Option<QueueEntry>,
}

/// TS `entryOf` — 객체가 아니면 None. `position` 은 JS number(정수만 실제로 온다), `state` 는 40자까지.
pub fn entry_of(e: Option<&Value>) -> Option<QueueEntry> {
    let e = e.filter(|e| e.is_object())?;
    Some(QueueEntry {
        position: e.get("position").and_then(Value::as_i64),
        state: e
            .get("state")
            .and_then(Value::as_str)
            .map(|s| s.chars().take(40).collect()),
    })
}

pub fn parse_queue_info(stdout: &str) -> Option<QueueInfo> {
    let v: Value = serde_json::from_str(stdout).ok()?;
    let pr = v.pointer("/data/repository/pullRequest")?;
    let id = pr.get("id")?.as_str()?.to_string();
    let enabled = pr.get("isMergeQueueEnabled")?.as_bool()?;
    let entry = entry_of(pr.get("mergeQueueEntry"));
    let in_queue =
        pr.get("isInMergeQueue").and_then(Value::as_bool) == Some(true) || entry.is_some();
    Some(QueueInfo {
        id,
        enabled,
        in_queue,
        entry,
    })
}

/// 큐에 이미 들어 있다는 GitHub 의 답(경합). 문구만 믿지 않고 부르는 쪽이 다시 읽는다(security n1).
pub fn is_already_queued_error(stderr: &str) -> bool {
    static RE: std::sync::OnceLock<regex::Regex> = std::sync::OnceLock::new();
    RE.get_or_init(|| {
        regex::Regex::new(r"(?i)already (?:been )?(?:added to|in|queued in) (?:the )?(?:merge )?queue|is already queued").expect("re")
    })
    .is_match(stderr)
}

/// gh 의 실패가 「이 gh 계정으로는 이 저장소를 볼 수/쓸 수 없다」인가(→ `no_repo_access`).
pub fn is_repo_access_error(stderr: &str) -> bool {
    static RE: std::sync::OnceLock<regex::Regex> = std::sync::OnceLock::new();
    RE.get_or_init(|| {
        regex::Regex::new(r"(?i)Could not resolve to a Repository|Resource not accessible|must have (?:push|write|admin) access|does not have the correct permissions|HTTP 40[34]|not have permission").expect("re")
    })
    .is_match(stderr)
}

pub const NO_PR_CI_PR_QUERY: &str = "query($owner:String!,$name:String!,$number:Int!){repository(owner:$owner,name:$name){pullRequest(number:$number){baseRefOid headRefOid headRefName isCrossRepository}}}";
const WORKFLOW_TREE_BASE: &str = "object(expression:$baseExpr){__typename ... on Tree{entries{name type mode object{__typename ... on Blob{text isTruncated isBinary}}}}}";
const WORKFLOW_TREE_HEAD: &str = "object(expression:$headExpr){__typename ... on Tree{entries{name type mode object{__typename ... on Blob{text isTruncated isBinary}}}}}";
/// TS `NO_PR_CI_REPO_QUERY` 와 글자까지 같다(시험이 대조한다).
pub fn no_pr_ci_repo_query() -> String {
    format!(
        "query($owner:String!,$name:String!,$baseExpr:String!,$headExpr:String!,$base:GitObjectID!){{repository(owner:$owner,name:$name){{base:{WORKFLOW_TREE_BASE} head:{WORKFLOW_TREE_HEAD} commit:object(oid:$base){{... on Commit{{checkSuites(first:100){{totalCount nodes{{app{{slug}} checkRuns(first:1){{totalCount}}}}}} status{{contexts{{context}}}}}}}}}}}}"
    )
}
/// push 뒤 이만큼은 「체크 0개」를 믿지 않는다.
pub const NO_PR_CI_GRACE_MS: u64 = 120_000;

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct NoPrCiPr {
    pub base_ref_oid: String,
    pub head_ref_oid: String,
    pub head_ref_name: String,
    pub is_cross_repository: bool,
}

pub fn parse_no_pr_ci_pr(stdout: &str) -> Option<NoPrCiPr> {
    let v: Value = serde_json::from_str(stdout).ok()?;
    let p = v.pointer("/data/repository/pullRequest")?;
    let base = p.get("baseRefOid")?.as_str()?;
    if !is_sha(base) {
        return None;
    }
    Some(NoPrCiPr {
        base_ref_oid: base.to_string(),
        head_ref_oid: p.get("headRefOid")?.as_str()?.to_string(),
        head_ref_name: p.get("headRefName")?.as_str()?.to_string(),
        is_cross_repository: p.get("isCrossRepository").and_then(Value::as_bool) == Some(true),
    })
}

fn pr_trigger(text: &str) -> bool {
    static RE: std::sync::OnceLock<regex::Regex> = std::sync::OnceLock::new();
    RE.get_or_init(|| regex::Regex::new(r"\b(?:pull_request\w*|merge_group)\b").expect("re"))
        .is_match(text)
}
fn is_yaml(name: &str) -> bool {
    let l = name.to_ascii_lowercase();
    l.ends_with(".yml") || l.ends_with(".yaml")
}
fn cut(s: &str, n: usize) -> String {
    s.chars().take(n).collect()
}

/// base·head 두 커밋의 workflow 와 base 커밋의 외부 CI 흔적으로 판정(TS `prCiVerdict`). None = 「PR CI 없음」을 읽어서 안 때.
pub fn pr_ci_verdict(stdout: &str) -> Option<Refusal> {
    let refuse = |why: String| {
        Some(refusal(
            "ci_not_green",
            format!("no checks reported — {why}"),
        ))
    };
    let cant = "could not read whether this repository runs CI on pull requests".to_string();
    let Ok(v) = serde_json::from_str::<Value>(stdout) else {
        return refuse(cant);
    };
    let Some(repo) = v.pointer("/data/repository").filter(|r| r.is_object()) else {
        return refuse(cant);
    };
    for side in ["base", "head"] {
        let tree = match repo.get(side) {
            None | Some(Value::Null) => continue,
            Some(t) => t,
        };
        let entries = match (
            tree.get("__typename").and_then(Value::as_str),
            tree.get("entries").and_then(Value::as_array),
        ) {
            (Some("Tree"), Some(e)) => e,
            _ => {
                return refuse(format!(
                    ".github/workflows on the {side} commit is not a directory"
                ));
            }
        };
        if entries.len() >= 100 {
            return refuse(format!(
                "too many files in .github/workflows on the {side} commit — not judged"
            ));
        }
        for e in entries {
            let name = e.get("name").and_then(Value::as_str).unwrap_or("");
            if e.get("type").and_then(Value::as_str) != Some("blob") || !is_yaml(name) {
                continue;
            }
            let mode = e.get("mode").and_then(Value::as_u64);
            if !matches!(mode, Some(0o100644 | 0o100755)) {
                return refuse(format!(
                    "workflow {} on the {side} commit is not a regular file (symbolic link?) — not judged",
                    cut(name, 80)
                ));
            }
            let o = e.get("object").filter(|o| o.is_object());
            let text = o.and_then(|o| {
                let ok = o.get("__typename").and_then(Value::as_str) == Some("Blob")
                    && o.get("isTruncated").and_then(Value::as_bool) == Some(false)
                    && o.get("isBinary").and_then(Value::as_bool) != Some(true);
                if ok {
                    o.get("text").and_then(Value::as_str)
                } else {
                    None
                }
            });
            let Some(text) = text else {
                return refuse(format!(
                    "could not read workflow {} on the {side} commit",
                    cut(name, 80)
                ));
            };
            if pr_trigger(text) {
                return refuse(format!(
                    "workflow {} on the {side} commit runs on pull requests — CI has not reported yet",
                    cut(name, 80)
                ));
            }
        }
    }
    let commit = repo.get("commit").filter(|c| c.is_object());
    let suites = commit
        .and_then(|c| c.get("checkSuites"))
        .filter(|s| s.is_object());
    let (Some(commit), Some(suites)) = (commit, suites) else {
        return refuse("could not read the base commit checks".into());
    };
    let (Some(total), Some(nodes)) = (
        suites.get("totalCount").and_then(Value::as_f64),
        suites.get("nodes").and_then(Value::as_array),
    ) else {
        return refuse("could not read the base commit checks".into());
    };
    if total > nodes.len() as f64 {
        return refuse("the base commit has more than 100 check suites — not judged".into());
    }
    let external = nodes.iter().find(|s| {
        let slug = s.pointer("/app/slug");
        let runs = s.pointer("/checkRuns/totalCount").and_then(Value::as_f64);
        slug.and_then(Value::as_str) != Some("github-actions") && runs.is_none_or(|n| n > 0.0)
    });
    if let Some(ext) = external {
        let slug = match ext.pointer("/app/slug") {
            Some(Value::String(s)) => s.clone(),
            Some(Value::Null) | None => "an unknown app".to_string(),
            Some(other) => other.to_string(),
        };
        return refuse(format!(
            "the base commit has checks from {} — an external CI may not have reported yet",
            cut(&slug, 40)
        ));
    }
    match commit.get("status") {
        None | Some(Value::Null) => {}
        Some(st) => {
            let ok_empty = st
                .get("contexts")
                .and_then(Value::as_array)
                .is_some_and(|c| c.is_empty());
            if !ok_empty {
                return refuse("the base commit has commit statuses — an external CI may not have reported yet".into());
            }
        }
    }
    None
}

/// `GET repos/{r}/activity?ref=` 에서 그 head 로 밀린 시각. 없으면 None.
pub fn pushed_at_of(stdout: &str, head_sha: &str) -> Option<u64> {
    let v: Value = serde_json::from_str(stdout).ok()?;
    let hit = v.as_array()?.iter().find(|i| {
        i.get("after").and_then(Value::as_str) == Some(head_sha)
            && i.get("timestamp").is_some_and(Value::is_string)
    })?;
    parse_iso_ms(hit.get("timestamp")?.as_str()?)
}

/// 관문 판정. `why` 가 None 이면 통과.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct GateVerdict {
    pub why: Option<Refusal>,
    pub ignored: Vec<String>,
    pub failing: Vec<String>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum ViewError {
    Stderr(String),
    Unparseable,
}

#[derive(Debug, Clone, PartialEq, Eq)]
// 머지 한 번에 하나 만들고 바로 소비한다 — 상자에 담을 이득이 없다.
#[allow(clippy::large_enum_variant)]
pub enum PrInspection {
    ViewFailed(ViewError),
    /// `queue` 는 OPEN 일 때만 읽는다. 이미 큐에 있으면 `verdict` 는 None.
    Ok {
        pr: PrView,
        queue: Option<QueueInfo>,
        verdict: Option<GateVerdict>,
        no_pr_checks: bool,
    },
}

pub type GhFn = Arc<dyn Fn(&[String], &[(String, String)]) -> ExecResult + Send + Sync>;
pub type FirstSeen = Arc<Mutex<HashMap<String, u64>>>;

/// TS `createPrGate`. `first_seen` 은 머지 길과 `pr.status` 가 **같은 것**을 받아야 한다.
#[derive(Clone)]
pub struct PrGate {
    pub gh: GhFn,
    pub now: Arc<dyn Fn() -> u64 + Send + Sync>,
    pub first_seen: FirstSeen,
}

const PR_VIEW_FIELDS: &str =
    "state,isDraft,headRefOid,baseRefName,mergeStateStatus,statusCheckRollup";

fn sv(a: &[&str]) -> Vec<String> {
    a.iter().map(|s| s.to_string()).collect()
}

impl PrGate {
    fn split(repo: &str) -> (&str, &str) {
        repo.split_once('/').unwrap_or((repo, ""))
    }

    pub fn queue_info(
        &self,
        repo: &str,
        number: u64,
        env: &[(String, String)],
    ) -> Option<QueueInfo> {
        let (owner, name) = Self::split(repo);
        let r = (self.gh)(
            &sv(&[
                "api",
                "graphql",
                "-f",
                &format!("query={QUEUE_QUERY}"),
                "-f",
                &format!("owner={owner}"),
                "-f",
                &format!("name={name}"),
                "-F",
                &format!("number={number}"),
            ]),
            env,
        );
        if r.code != 0 {
            return None;
        }
        parse_queue_info(&r.stdout)
    }

    fn view_raw(
        &self,
        repo: &str,
        number: u64,
        env: &[(String, String)],
    ) -> Result<PrView, ViewError> {
        let r = (self.gh)(
            &sv(&[
                "pr",
                "view",
                &number.to_string(),
                "-R",
                repo,
                "--json",
                PR_VIEW_FIELDS,
            ]),
            env,
        );
        if r.code != 0 {
            return Err(ViewError::Stderr(r.stderr));
        }
        PrView::parse(&r.stdout).ok_or(ViewError::Unparseable)
    }

    /// `gh pr view` 하나(읽기 전용). 오류 문구는 300자까지.
    pub fn view_pr(
        &self,
        repo: &str,
        number: u64,
        env: &[(String, String)],
    ) -> Result<PrView, String> {
        self.view_raw(repo, number, env).map_err(|e| match e {
            ViewError::Stderr(s) => cut(s.trim(), 300),
            ViewError::Unparseable => "gh pr view returned no JSON".to_string(),
        })
    }

    fn no_pr_ci(
        &self,
        repo: &str,
        number: u64,
        head_sha: &str,
        env: &[(String, String)],
    ) -> Option<Refusal> {
        let (owner, name) = Self::split(repo);
        let cant = refusal(
            "ci_not_green",
            "no checks reported — could not read whether this repository runs CI on pull requests",
        );
        let p = (self.gh)(
            &sv(&[
                "api",
                "graphql",
                "-f",
                &format!("query={NO_PR_CI_PR_QUERY}"),
                "-f",
                &format!("owner={owner}"),
                "-f",
                &format!("name={name}"),
                "-F",
                &format!("number={number}"),
            ]),
            env,
        );
        let Some(info) = (if p.code == 0 {
            parse_no_pr_ci_pr(&p.stdout)
        } else {
            None
        }) else {
            return Some(cant);
        };
        if info.head_ref_oid != head_sha {
            return Some(refusal(
                "head_moved",
                format!("PR head is {}, not {head_sha}", info.head_ref_oid),
            ));
        }
        let r = (self.gh)(
            &sv(&[
                "api",
                "graphql",
                "-f",
                &format!("query={}", no_pr_ci_repo_query()),
                "-f",
                &format!("owner={owner}"),
                "-f",
                &format!("name={name}"),
                "-f",
                &format!("baseExpr={}:.github/workflows", info.base_ref_oid),
                "-f",
                &format!("headExpr={head_sha}:.github/workflows"),
                "-f",
                &format!("base={}", info.base_ref_oid),
            ]),
            env,
        );
        if r.code != 0 {
            return Some(cant);
        }
        if let Some(v) = pr_ci_verdict(&r.stdout) {
            return Some(v);
        }
        let mut pushed_at = None;
        if !info.is_cross_repository {
            let a = (self.gh)(
                &sv(&[
                    "api",
                    "-X",
                    "GET",
                    &format!("repos/{repo}/activity"),
                    "-f",
                    &format!("ref={}", info.head_ref_name),
                    "-F",
                    "per_page=100",
                ]),
                env,
            );
            pushed_at = if a.code == 0 {
                pushed_at_of(&a.stdout, head_sha)
            } else {
                None
            };
        }
        let now = (self.now)();
        let pushed_at = pushed_at.unwrap_or_else(|| {
            let key = format!("{repo}#{number}@{head_sha}");
            *self
                .first_seen
                .lock()
                .unwrap_or_else(|e| e.into_inner())
                .entry(key)
                .or_insert(now)
        });
        let deadline = pushed_at + NO_PR_CI_GRACE_MS;
        if deadline > now {
            let wait = deadline - now;
            return Some(refusal(
                "ci_pending",
                format!(
                    "no checks reported yet and this repository defines no CI for pull requests — waiting {}s more in case checks start; call the same command again after that",
                    wait.div_ceil(1000)
                ),
            ));
        }
        None
    }

    fn judge(
        &self,
        repo: &str,
        number: u64,
        head_sha: &str,
        pr: &PrView,
        env: &[(String, String)],
        relax: bool,
    ) -> (GateVerdict, bool) {
        let why = refusal_of(pr, head_sha, relax);
        if why.as_ref().is_some_and(|w| w.code == "ci_not_green")
            && !relax
            && pr.merge_state_status.as_deref() == Some("CLEAN")
            && pr.checks.is_empty()
        {
            let v = self.no_pr_ci(repo, number, head_sha, env);
            let passed = v.is_none();
            return (
                GateVerdict {
                    why: v,
                    ignored: vec![],
                    failing: vec![],
                },
                passed,
            );
        }
        let Some(why) = why else {
            let ignored = if relax { not_green_checks(pr) } else { vec![] };
            return (
                GateVerdict {
                    why: None,
                    ignored,
                    failing: vec![],
                },
                false,
            );
        };
        if why.code != "not_mergeable" || pr.merge_state_status.as_deref() != Some("UNSTABLE") {
            let failing = if why.code == "ci_not_green" {
                not_green_checks(pr)
            } else {
                vec![]
            };
            return (
                GateVerdict {
                    why: Some(why),
                    ignored: vec![],
                    failing,
                },
                false,
            );
        }
        let (owner, name) = Self::split(repo);
        let r = (self.gh)(
            &sv(&[
                "api",
                "graphql",
                "-f",
                &format!("query={REQUIRED_QUERY}"),
                "-f",
                &format!("owner={owner}"),
                "-f",
                &format!("name={name}"),
                "-F",
                &format!("number={number}"),
            ]),
            env,
        );
        let Some(rc) = (if r.code == 0 {
            parse_required_checks(&r.stdout)
        } else {
            None
        }) else {
            return (
                GateVerdict {
                    why: Some(refusal(
                        &why.code,
                        format!("{} — could not read which checks are required", why.message),
                    )),
                    ignored: vec![],
                    failing: not_green_checks(pr),
                },
                false,
            );
        };
        match unstable_verdict(&rc, head_sha) {
            Err(v) => (
                GateVerdict {
                    why: Some(v),
                    ignored: vec![],
                    failing: not_green(&checks_by_name(&rc.checks), false),
                },
                false,
            ),
            Ok(ignored) => (
                GateVerdict {
                    why: None,
                    ignored,
                    failing: vec![],
                },
                false,
            ),
        }
    }

    /// PR 을 읽고 관문을 잰다. `head_sha` 가 없으면 PR 의 지금 head 로 잰다(상태 읽기).
    pub fn inspect(
        &self,
        repo: &str,
        number: u64,
        env: &[(String, String)],
        head_sha: Option<&str>,
        relax_checks: bool,
    ) -> PrInspection {
        let pr = match self.view_raw(repo, number, env) {
            Ok(pr) => pr,
            Err(e) => return PrInspection::ViewFailed(e),
        };
        let queue = if pr.state.as_deref() == Some("OPEN") {
            self.queue_info(repo, number, env)
        } else {
            None
        };
        if queue.as_ref().is_some_and(|q| q.in_queue) {
            return PrInspection::Ok {
                pr,
                queue,
                verdict: None,
                no_pr_checks: false,
            };
        }
        let head = head_sha
            .map(str::to_string)
            .or_else(|| pr.head_ref_oid.clone())
            .unwrap_or_default();
        let (verdict, no_pr_checks) = self.judge(repo, number, &head, &pr, env, relax_checks);
        PrInspection::Ok {
            pr,
            queue,
            verdict: Some(verdict),
            no_pr_checks,
        }
    }
}

/// gh 토큰 고르기 실패.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct GhTokenFail {
    pub code: &'static str,
    pub message: String,
}
/// 고른 토큰. Debug 에 토큰을 싣지 않는다.
#[derive(Clone, PartialEq, Eq)]
pub struct GhToken {
    pub token: String,
    pub login: String,
}
impl std::fmt::Debug for GhToken {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("GhToken")
            .field("token", &"<redacted>")
            .field("login", &self.login)
            .finish()
    }
}

pub type GhUserFor = Arc<dyn Fn(&str) -> Option<(String, String)> + Send + Sync>;

/// TS `createGhTokens` — 머지와 `pr.status` 가 같은 것을 쓴다. 활성 gh 계정으로 넘어가는 길은 없다(security P1).
#[derive(Clone)]
pub struct GhTokens {
    pub exec: crate::local_merge::Exec,
    pub gh_path: String,
    pub home: String,
    /// 저장소 → (login, scope). `merge.byScope`(정확한 `owner/name` → `owner/*`).
    pub gh_user_for: GhUserFor,
}

fn is_login(s: &str) -> bool {
    (1..=39).contains(&s.len()) && s.bytes().all(|c| c.is_ascii_alphanumeric() || c == b'-')
}

impl GhTokens {
    pub fn token_for(&self, repo: &str) -> Result<GhToken, GhTokenFail> {
        match (self.gh_user_for)(repo) {
            Some((login, scope)) if is_login(&login) => {
                self.token_for_login(&login, &format!("set for {scope}"))
            }
            _ => Err(GhTokenFail {
                code: "no_gh_user",
                message: format!(
                    "no GitHub account is set for {repo} on this device — a person picks one in Settings › Agents › Permissions › PR merge (the wrapper never merges with the active gh account)"
                ),
            }),
        }
    }

    pub fn token_for_login(&self, user: &str, why: &str) -> Result<GhToken, GhTokenFail> {
        if !is_login(user) {
            return Err(GhTokenFail {
                code: "no_gh_user",
                message: format!("not a GitHub login: {}", cut(user, 40)),
            });
        }
        let r = (self.exec)(
            &self.gh_path,
            &sv(&["auth", "token", "-u", user]),
            &gh_env(&self.home, None),
        );
        let token = r.stdout.trim().to_string();
        if r.code != 0 || token.is_empty() {
            static RE: std::sync::OnceLock<regex::Regex> = std::sync::OnceLock::new();
            let re = RE.get_or_init(|| {
                regex::Regex::new(
                    r"(?i)no (?:oauth )?token found|not logged in|no account|unknown user",
                )
                .expect("re")
            });
            if re.is_match(&r.stderr) {
                return Err(GhTokenFail {
                    code: "gh_user_not_logged_in",
                    message: format!(
                        "{user} ({why}) is not logged in to gh on this device — log in again or pick another account"
                    ),
                });
            }
            return Err(GhTokenFail {
                code: "gh_token_failed",
                message: format!(
                    "gh auth token -u {user} failed: {}",
                    cut(r.stderr.trim(), 200)
                ),
            });
        }
        Ok(GhToken {
            token,
            login: user.to_string(),
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    const H: &str = "0123456789abcdef0123456789abcdef01234567";

    fn ok(stdout: &str) -> ExecResult {
        ExecResult {
            code: 0,
            stdout: stdout.into(),
            stderr: String::new(),
        }
    }
    fn pr(v: Value) -> PrView {
        PrView::parse(&v.to_string()).unwrap()
    }
    fn base(mss: &str, checks: Value) -> PrView {
        pr(
            json!({"state":"OPEN","isDraft":false,"headRefOid":H,"baseRefName":"main","mergeStateStatus":mss,"statusCheckRollup":checks}),
        )
    }

    #[test]
    fn refusal_basic_order() {
        let p = pr(json!({"state":"MERGED","headRefOid":H}));
        assert_eq!(refusal_of(&p, H, false).unwrap().code, "not_open");
        let p = pr(json!({"state":"OPEN","isDraft":true,"headRefOid":H}));
        assert_eq!(refusal_of(&p, H, false).unwrap().code, "draft");
        let p = pr(json!({"state":"OPEN","headRefOid":"x"}));
        let r = refusal_of(&p, H, false).unwrap();
        assert_eq!(
            (r.code.as_str(), r.message),
            ("head_moved", format!("PR head is x, not {H}"))
        );
    }

    #[test]
    fn clean_green_passes_and_no_checks_refused() {
        let green = json!([{"name":"t","status":"COMPLETED","conclusion":"SUCCESS"}]);
        assert_eq!(refusal_of(&base("CLEAN", green), H, false), None);
        let r = refusal_of(&base("CLEAN", json!([])), H, false).unwrap();
        assert_eq!(
            (r.code.as_str(), r.message.as_str()),
            ("ci_not_green", "no checks reported")
        );
        let r = refusal_of(
            &base("BLOCKED", json!([{"name":"t","conclusion":"FAILURE"}])),
            H,
            false,
        )
        .unwrap();
        assert_eq!(
            r.message,
            "mergeStateStatus is BLOCKED (need CLEAN) — not green: t"
        );
    }

    #[test]
    fn relax_only_skips_ci() {
        assert_eq!(refusal_of(&base("UNSTABLE", json!([])), H, true), None);
        assert_eq!(
            refusal_of(&base("DIRTY", json!([])), H, true).unwrap().code,
            "not_mergeable"
        );
    }

    #[test]
    fn latest_run_wins_and_cancelled_dropped() {
        // 옛 실패 + 새 초록 → 초록(C1)
        let c = json!([
            {"name":"t","workflowName":"CI","status":"COMPLETED","conclusion":"FAILURE","startedAt":"2026-11-11T01:00:00Z"},
            {"name":"t","workflowName":"CI","status":"COMPLETED","conclusion":"SUCCESS","startedAt":"2026-11-11T02:00:00Z"},
        ]);
        assert_eq!(refusal_of(&base("CLEAN", c), H, false), None);
        // 옛 초록 + 새 빨강 → 빨강
        let c = json!([
            {"name":"t","workflowName":"CI","status":"COMPLETED","conclusion":"SUCCESS","startedAt":"2026-11-11T01:00:00Z"},
            {"name":"t","workflowName":"CI","status":"COMPLETED","conclusion":"FAILURE","startedAt":"2026-11-11T02:00:00Z"},
        ]);
        assert_eq!(
            refusal_of(&base("CLEAN", c), H, false).unwrap().code,
            "ci_not_green"
        );
        // 늦게 찍힌 취소는 빼고 앞 성공으로
        let c = json!([
            {"name":"t","status":"COMPLETED","conclusion":"SUCCESS","startedAt":"2026-11-11T01:00:00Z"},
            {"name":"t","status":"COMPLETED","conclusion":"CANCELLED","startedAt":"2026-11-11T02:00:00Z"},
        ]);
        assert_eq!(refusal_of(&base("CLEAN", c), H, false), None);
        // 시각 모르는 실행이 끼면 전부 본다
        let c = json!([
            {"name":"t","status":"COMPLETED","conclusion":"SUCCESS","startedAt":"2026-11-11T01:00:00Z"},
            {"name":"t","status":"QUEUED"},
        ]);
        assert_eq!(
            refusal_of(&base("CLEAN", c), H, false).unwrap().code,
            "ci_not_green"
        );
        // 다른 workflow 의 같은 job 이름은 따로
        let c = json!([
            {"name":"build","workflowName":"A","status":"COMPLETED","conclusion":"FAILURE","startedAt":"2026-11-11T01:00:00Z"},
            {"name":"build","workflowName":"B","status":"COMPLETED","conclusion":"SUCCESS","startedAt":"2026-11-11T02:00:00Z"},
        ]);
        assert_eq!(
            not_green_checks(&base("CLEAN", c)),
            vec!["build".to_string()]
        );
        // status-context 는 state 로, gh 빈 시각(0001)은 모름
        let c = json!([{"context":"ext","state":"SUCCESS","startedAt":"0001-01-01T00:00:00Z"}]);
        assert_eq!(refusal_of(&base("CLEAN", c), H, false), None);
    }

    fn required_json(head: &str, nodes: Value, more: bool) -> String {
        json!({"data":{"repository":{"pullRequest":{"commits":{"nodes":[{"commit":{"oid":head,"statusCheckRollup":{"contexts":{"pageInfo":{"hasNextPage":more},"nodes":nodes}}}}]}}}}}).to_string()
    }

    #[test]
    fn unstable_needs_required_checks() {
        let nodes = json!([
            {"__typename":"CheckRun","name":"test","status":"COMPLETED","conclusion":"SUCCESS","startedAt":"2026-11-11T01:00:00Z","checkSuite":{"workflowRun":{"workflow":{"name":"CI"}}},"isRequired":true},
            {"__typename":"CheckRun","name":"lint","status":"COMPLETED","conclusion":"FAILURE","startedAt":"2026-11-11T01:00:00Z","checkSuite":{"workflowRun":{"workflow":{"name":"CI"}}},"isRequired":false},
            {"__typename":"StatusContext","context":"ext","state":"PENDING","createdAt":"2026-11-11T01:00:00Z","isRequired":false},
        ]);
        let rc = parse_required_checks(&required_json(H, nodes, false)).unwrap();
        assert_eq!(rc.checks[0].workflow_name.as_deref(), Some("CI"));
        assert_eq!(
            rc.checks[2].started_at.as_deref(),
            Some("2026-11-11T01:00:00Z")
        );
        assert_eq!(
            unstable_verdict(&rc, H),
            Ok(vec!["lint".into(), "ext".into()])
        );
        assert_eq!(
            unstable_verdict(&rc, "f".repeat(40).as_str())
                .unwrap_err()
                .code,
            "head_moved"
        );
        // 필수가 하나도 없으면 거절
        let rc = parse_required_checks(&required_json(
            H,
            json!([{"name":"lint","conclusion":"FAILURE"}]),
            false,
        ))
        .unwrap();
        let e = unstable_verdict(&rc, H).unwrap_err();
        assert!(
            e.message
                .starts_with("not green: lint — the base branch defines no required status checks")
        );
        // 잘림
        let rc = parse_required_checks(&required_json(H, json!([]), true)).unwrap();
        assert_eq!(unstable_verdict(&rc, H).unwrap_err().code, "not_mergeable");
        assert_eq!(parse_required_checks("{}"), None);
    }

    #[test]
    fn queue_parse() {
        let q = parse_queue_info(&json!({"data":{"repository":{"pullRequest":{"id":"PR_1","isMergeQueueEnabled":true,"isInMergeQueue":false,"mergeQueueEntry":{"position":2,"state":"QUEUED"}}}}}).to_string()).unwrap();
        assert!(q.in_queue && q.enabled);
        assert_eq!(
            q.entry,
            Some(QueueEntry {
                position: Some(2),
                state: Some("QUEUED".into())
            })
        );
        assert_eq!(
            parse_queue_info(
                &json!({"data":{"repository":{"pullRequest":{"id":"PR_1"}}}}).to_string()
            ),
            None
        );
        assert!(is_already_queued_error(
            "GraphQL: Pull request is already in the queue (enqueuePullRequest)"
        ));
        assert!(!is_already_queued_error("something else"));
        assert!(is_repo_access_error(
            "GraphQL: Could not resolve to a Repository with the name"
        ));
        assert!(is_repo_access_error("HTTP 403: forbidden"));
    }

    fn wf(name: &str, text: &str, mode: u64) -> Value {
        json!({"name":name,"type":"blob","mode":mode,"object":{"__typename":"Blob","text":text,"isTruncated":false,"isBinary":false}})
    }
    fn repo_json(base: Value, head: Value, suites: Value, status: Value) -> String {
        json!({"data":{"repository":{"base":base,"head":head,"commit":{"checkSuites":suites,"status":status}}}}).to_string()
    }

    #[test]
    fn pr_ci_verdict_cases() {
        let none_suites = json!({"totalCount":0,"nodes":[]});
        assert_eq!(
            pr_ci_verdict(&repo_json(
                Value::Null,
                Value::Null,
                none_suites.clone(),
                Value::Null
            )),
            None
        );
        let tree = |e: Value| json!({"__typename":"Tree","entries":e});
        let push_only = tree(json!([wf("ci.yml", "on: push", 0o100644)]));
        assert_eq!(
            pr_ci_verdict(&repo_json(
                push_only.clone(),
                push_only,
                none_suites.clone(),
                Value::Null
            )),
            None
        );
        let pr_t = tree(json!([wf("ci.yml", "on: [pull_request_target]", 0o100644)]));
        assert!(
            pr_ci_verdict(&repo_json(
                Value::Null,
                pr_t,
                none_suites.clone(),
                Value::Null
            ))
            .unwrap()
            .message
            .contains("runs on pull requests")
        );
        let link = tree(json!([wf("ci.yml", "on: push", 0o120000)]));
        assert!(
            pr_ci_verdict(&repo_json(
                link,
                Value::Null,
                none_suites.clone(),
                Value::Null
            ))
            .unwrap()
            .message
            .contains("not a regular file")
        );
        let ext = json!({"totalCount":1,"nodes":[{"app":{"slug":"circleci"},"checkRuns":{"totalCount":1}}]});
        assert!(
            pr_ci_verdict(&repo_json(Value::Null, Value::Null, ext, Value::Null))
                .unwrap()
                .message
                .contains("checks from circleci")
        );
        let gha = json!({"totalCount":1,"nodes":[{"app":{"slug":"github-actions"},"checkRuns":{"totalCount":3}}]});
        assert_eq!(
            pr_ci_verdict(&repo_json(
                Value::Null,
                Value::Null,
                gha,
                json!({"contexts":[]})
            )),
            None
        );
        assert!(
            pr_ci_verdict(&repo_json(
                Value::Null,
                Value::Null,
                none_suites.clone(),
                json!({"contexts":[{"context":"x"}]})
            ))
            .is_some()
        );
        assert!(
            pr_ci_verdict("nope")
                .unwrap()
                .message
                .contains("could not read whether")
        );
    }

    #[test]
    fn repo_query_matches_ts_shape() {
        let q = no_pr_ci_repo_query();
        assert!(q.starts_with("query($owner:String!,$name:String!,$baseExpr:String!,$headExpr:String!,$base:GitObjectID!){repository(owner:$owner,name:$name){base:object(expression:$baseExpr){"));
        assert!(q.contains(" head:object(expression:$headExpr){"));
        assert!(q.ends_with("status{contexts{context}}}}}}"));
        assert_eq!(q.matches('{').count(), q.matches('}').count());
    }

    #[test]
    fn pushed_at() {
        let a = json!([{"after":"x","timestamp":"2026-11-11T00:00:00Z"},{"after":H,"timestamp":"2026-11-11T00:00:01Z"}]).to_string();
        assert_eq!(pushed_at_of(&a, H), parse_iso_ms("2026-11-11T00:00:01Z"));
        assert_eq!(pushed_at_of("{}", H), None);
    }

    fn gate(
        script: Vec<(&'static str, ExecResult)>,
        now: u64,
    ) -> (PrGate, Arc<Mutex<Vec<Vec<String>>>>) {
        let calls = Arc::new(Mutex::new(Vec::new()));
        let c2 = calls.clone();
        let script = Arc::new(script);
        let gh: GhFn = Arc::new(move |args: &[String], _env: &[(String, String)]| {
            c2.lock().unwrap().push(args.to_vec());
            let joined = args.join(" ");
            script
                .iter()
                .find(|(k, _)| joined.contains(k))
                .map(|(_, r)| r.clone())
                .unwrap_or(ExecResult {
                    code: 1,
                    stdout: String::new(),
                    stderr: "unscripted".into(),
                })
        });
        (
            PrGate {
                gh,
                now: Arc::new(move || now),
                first_seen: Arc::new(Mutex::new(HashMap::new())),
            },
            calls,
        )
    }

    #[test]
    fn inspect_already_queued_skips_verdict() {
        let view = json!({"state":"OPEN","headRefOid":H,"mergeStateStatus":"BLOCKED","statusCheckRollup":[]}).to_string();
        let q = json!({"data":{"repository":{"pullRequest":{"id":"PR_1","isMergeQueueEnabled":true,"isInMergeQueue":true,"mergeQueueEntry":null}}}}).to_string();
        let (g, _) = gate(
            vec![("pr view", ok(&view)), ("isMergeQueueEnabled", ok(&q))],
            0,
        );
        match g.inspect("o/r", 5, &[], Some(H), false) {
            PrInspection::Ok { verdict, queue, .. } => {
                assert_eq!(verdict, None);
                assert!(queue.unwrap().in_queue);
            }
            other => panic!("{other:?}"),
        }
    }

    #[test]
    fn inspect_no_pr_ci_grace_then_pass() {
        let view = json!({"state":"OPEN","headRefOid":H,"mergeStateStatus":"CLEAN","statusCheckRollup":[]}).to_string();
        let info = json!({"data":{"repository":{"pullRequest":{"baseRefOid":"a".repeat(40),"headRefOid":H,"headRefName":"b","isCrossRepository":true}}}}).to_string();
        let repo = repo_json(
            Value::Null,
            Value::Null,
            json!({"totalCount":0,"nodes":[]}),
            Value::Null,
        );
        let script = || {
            vec![
                ("pr view", ok(&view)),
                ("isMergeQueueEnabled", ok("{}")),
                ("isCrossRepository", ok(&info)),
                ("checkSuites", ok(&repo)),
            ]
        };
        let (g, _) = gate(script(), 1_000_000);
        let PrInspection::Ok {
            verdict,
            no_pr_checks,
            ..
        } = g.inspect("o/r", 5, &[], Some(H), false)
        else {
            panic!()
        };
        let why = verdict.unwrap().why.unwrap();
        assert_eq!(why.code, "ci_pending");
        assert!(why.message.contains("waiting 120s more"));
        assert!(!no_pr_checks);
        // 같은 first_seen 으로 2분 뒤 — 통과
        let (g2, _) = gate(script(), 1_000_000 + NO_PR_CI_GRACE_MS);
        let g2 = PrGate {
            first_seen: g.first_seen.clone(),
            ..g2
        };
        let PrInspection::Ok {
            verdict,
            no_pr_checks,
            ..
        } = g2.inspect("o/r", 5, &[], Some(H), false)
        else {
            panic!()
        };
        assert_eq!(verdict.unwrap().why, None);
        assert!(no_pr_checks);
    }

    #[test]
    fn inspect_unstable_reads_required() {
        let view = json!({"state":"OPEN","headRefOid":H,"mergeStateStatus":"UNSTABLE","statusCheckRollup":[{"name":"lint","conclusion":"FAILURE"}]}).to_string();
        let nodes = json!([{"name":"test","status":"COMPLETED","conclusion":"SUCCESS","isRequired":true},{"name":"lint","status":"COMPLETED","conclusion":"FAILURE","isRequired":false}]);
        let (g, _) = gate(
            vec![
                ("pr view", ok(&view)),
                ("isMergeQueueEnabled", ok("{}")),
                ("isRequired", ok(&required_json(H, nodes, false))),
            ],
            0,
        );
        let PrInspection::Ok { verdict, .. } = g.inspect("o/r", 5, &[], None, false) else {
            panic!()
        };
        let v = verdict.unwrap();
        assert_eq!(v.why, None);
        assert_eq!(v.ignored, vec!["lint".to_string()]);
        // 필수 조회 실패 → 원래 거절 + 문구
        let (g, _) = gate(
            vec![("pr view", ok(&view)), ("isMergeQueueEnabled", ok("{}"))],
            0,
        );
        let PrInspection::Ok { verdict, .. } = g.inspect("o/r", 5, &[], None, false) else {
            panic!()
        };
        let v = verdict.unwrap();
        assert!(
            v.why
                .unwrap()
                .message
                .ends_with("— could not read which checks are required")
        );
        assert_eq!(v.failing, vec!["lint".to_string()]);
    }

    #[test]
    fn inspect_view_fail() {
        let (g, _) = gate(vec![], 0);
        assert_eq!(
            g.inspect("o/r", 5, &[], None, false),
            PrInspection::ViewFailed(ViewError::Stderr("unscripted".into()))
        );
        let (g, _) = gate(vec![("pr view", ok("not json"))], 0);
        assert_eq!(
            g.view_pr("o/r", 5, &[]),
            Err("gh pr view returned no JSON".into())
        );
    }

    #[test]
    fn gh_tokens_fail_closed() {
        let exec: crate::local_merge::Exec =
            Arc::new(|_f: &str, args: &[String], env: &[(String, String)]| {
                assert!(!env.iter().any(|(k, _)| k == "GH_TOKEN"));
                if args.last().map(String::as_str) == Some("alice") {
                    ExecResult {
                        code: 0,
                        stdout: "tok-\n".into(),
                        stderr: String::new(),
                    }
                } else {
                    ExecResult {
                        code: 1,
                        stdout: String::new(),
                        stderr: "no oauth token found for bob".into(),
                    }
                }
            });
        let t = GhTokens {
            exec,
            gh_path: "/usr/bin/gh".into(),
            home: "/h".into(),
            gh_user_for: Arc::new(|repo: &str| match repo {
                "o/a" => Some(("alice".into(), "o/a".into())),
                "o/b" => Some(("bob".into(), "o/*".into())),
                "o/bad" => Some(("bad login".into(), "o/bad".into())),
                _ => None,
            }),
        };
        let ok = t.token_for("o/a").unwrap();
        assert_eq!((ok.token.as_str(), ok.login.as_str()), ("tok-", "alice"));
        assert!(!format!("{ok:?}").contains("tok-"));
        assert_eq!(
            t.token_for("o/b").unwrap_err().code,
            "gh_user_not_logged_in"
        );
        assert_eq!(t.token_for("o/none").unwrap_err().code, "no_gh_user");
        assert_eq!(t.token_for("o/bad").unwrap_err().code, "no_gh_user");
    }
}
