//! TS `workspaceCleanupScan.ts` — 청소기의 눈. 이번 회차의 사실(`SweepFacts`)을 잰다. 규칙은 `plan_sweep` 에 있고 여기엔 없다.
//!
//! - worktree: 각 저장소의 `git worktree list --porcelain`. main worktree 는 빼고 센다(절대 지우지 않는다).
//! - 주인(스레드): 러너가 relay 로 보고한 장부(`owners.rs`). 보고에 없는 worktree 는 주인 모름이다.
//! - PR: `gh pr list`(브랜치, detached 면 sha). 실패하면 PR 모름.
//! - 스레드 ✅: 그 에이전트로 서버 `GET /messages/<root>` 의 `statusReaction.status === 'done'`.
//!
//! **이 모듈은 아무것도 지우지 않는다.**
//!
//! TS 보다 좁힌 곳(security c5-1 검토 — 후보를 모을 때부터 git 목록과 대조):
//! - 후보는 `git worktree list` 가 **지금** 아는 worktree 뿐이다(main·bare·locked·prunable 은 뺀다).
//! - 그 경로가 `safe_target` 모양이고, 실제 경로(`canonicalize`)가 적힌 경로와 같으며(심링크 거절), main worktree 와
//!   같거나 그 조상·자손이 아니어야 후보에 오른다.
use super::owners::OwnerRecord;
use super::{
    CleanupPr, ObservedWorktree, PrState, REBUILDABLE_DIRS, normalize_cleanup_path, safe_target,
};
use crate::local_merge::{Exec, iso_from_ms};
use harkroom_proto::p1::{RunnerLinkRequest, RunnerLinkResponse};
use serde_json::Value;
use std::collections::HashMap;
use std::path::Path;

#[derive(Debug, Clone, PartialEq, Eq, Default)]
pub struct PorcelainWorktree {
    pub path: String,
    pub head: Option<String>,
    pub branch: Option<String>,
    pub bare: bool,
    pub locked: bool,
    pub prunable: bool,
}

/// TS `parseWorktreePorcelain` — 빈 줄로 나뉜 묶음. 첫 묶음이 main worktree 다.
/// TS 보다 더: `locked`·`prunable` 줄도 읽는다(그런 worktree 는 후보에서 뺀다).
pub fn parse_worktree_porcelain(out: &str) -> Vec<PorcelainWorktree> {
    let mut list = Vec::new();
    let mut cur: Option<PorcelainWorktree> = None;
    let flush = |cur: &mut Option<PorcelainWorktree>, list: &mut Vec<PorcelainWorktree>| {
        if let Some(w) = cur.take().filter(|w| !w.path.is_empty()) {
            list.push(w);
        }
    };
    for line in out.lines() {
        if line.trim().is_empty() {
            flush(&mut cur, &mut list);
            continue;
        }
        let w = cur.get_or_insert_with(PorcelainWorktree::default);
        if let Some(p) = line.strip_prefix("worktree ") {
            w.path = p.to_string();
        } else if let Some(h) = line.strip_prefix("HEAD ") {
            w.head = Some(h.to_string());
        } else if let Some(b) = line.strip_prefix("branch ") {
            w.branch = Some(b.strip_prefix("refs/heads/").unwrap_or(b).to_string());
        } else if line == "bare" {
            w.bare = true;
        } else if line == "locked" || line.starts_with("locked ") {
            w.locked = true;
        } else if line == "prunable" || line.starts_with("prunable ") {
            w.prunable = true;
        }
    }
    flush(&mut cur, &mut list);
    list
}

fn slug_part_ok(s: &str) -> bool {
    !s.is_empty()
        && s.bytes()
            .all(|b| b.is_ascii_alphanumeric() || b == b'_' || b == b'.' || b == b'-')
}

/// TS `githubSlug` — origin URL → `owner/repo`(github.com 만).
pub fn github_slug(url: &str) -> Option<String> {
    let u = url.trim();
    let i = u.find("github.com")?;
    let rest = &u[i + "github.com".len()..];
    let rest = rest.strip_prefix(':').or_else(|| rest.strip_prefix('/'))?;
    let rest = rest.strip_suffix('/').unwrap_or(rest);
    let rest = rest.strip_suffix(".git").unwrap_or(rest);
    let (owner, repo) = rest.split_once('/')?;
    (slug_part_ok(owner) && slug_part_ok(repo)).then(|| format!("{owner}/{repo}"))
}

/// TS `parsePrList` — 같은 브랜치로 PR 이 여럿이면 열린 것이 이긴다. 아니면 번호가 큰 것.
pub fn parse_pr_list(out: &str) -> Option<CleanupPr> {
    let rows: Value = serde_json::from_str(out).ok()?;
    let rows = rows.as_array()?;
    let mut all: Vec<CleanupPr> = rows
        .iter()
        .filter_map(|r| {
            let number = r.get("number")?.as_i64()?;
            let state = match r.get("state")?.as_str()?.to_ascii_lowercase().as_str() {
                "open" => PrState::Open,
                "merged" => PrState::Merged,
                "closed" => PrState::Closed,
                _ => return None,
            };
            Some(CleanupPr {
                number,
                state,
                head_sha: r
                    .get("headRefOid")
                    .and_then(Value::as_str)
                    .map(str::to_string),
            })
        })
        .collect();
    if let Some(open) = all.iter().find(|p| p.state == PrState::Open) {
        return Some(open.clone());
    }
    all.sort_by_key(|p| std::cmp::Reverse(p.number));
    all.into_iter().next()
}

pub struct ScanDeps {
    pub exec: Exec,
    pub git_path: String,
    pub gh_path: String,
    pub gh_env: Vec<(String, String)>,
    pub home: String,
    /// 지우면 안 되는 자리(security c5 조건 2) — 홈, `.harkroom-agent`, claude/codex 계정 뿌리, 앱 데이터 폴더.
    /// 후보가 이 중 하나와 **같거나 그 조상**이면 후보로 올리지 않는다. 실제 경로(canonicalize)로 넣는다.
    pub protected: Vec<String>,
}

pub(super) fn git_env(home: &str) -> Vec<(String, String)> {
    vec![
        ("HOME".into(), home.to_string()),
        (
            "PATH".into(),
            "/usr/bin:/bin:/usr/local/bin:/opt/homebrew/bin".into(),
        ),
        ("GIT_TERMINAL_PROMPT".into(), "0".into()),
    ]
}

pub(super) fn args(a: &[&str]) -> Vec<String> {
    a.iter().map(|s| s.to_string()).collect()
}

fn mtime_ms(m: &std::fs::Metadata) -> Option<u64> {
    m.modified()
        .ok()?
        .duration_since(std::time::UNIX_EPOCH)
        .ok()
        .map(|d| d.as_millis() as u64)
}

/// TS `measure` — 크기(바이트)와 마지막 수정 시각. `du` 는 심링크를 따라가지 않는다.
pub fn measure(deps: &ScanDeps, path: &str) -> (Option<f64>, Option<String>) {
    let du = (deps.exec)(
        "/usr/bin/du",
        &args(&["-sk", path]),
        &[("PATH".into(), "/usr/bin:/bin".into())],
    );
    let size = (du.code == 0)
        .then(|| du.stdout.split_whitespace().next()?.parse::<u64>().ok())
        .flatten()
        .map(|kb| (kb * 1024) as f64);
    let last = std::fs::metadata(path)
        .ok()
        .as_ref()
        .and_then(mtime_ms)
        .map(iso_from_ms);
    (size, last)
}

/// TS `prHeadIsOurs` — PR head 가 worktree head 와 같거나 그 조상인가.
pub fn pr_head_is_ours(
    deps: &ScanDeps,
    path: &str,
    pr_head: Option<&str>,
    head: Option<&str>,
) -> bool {
    let (Some(pr), Some(h)) = (pr_head, head) else {
        return false;
    };
    if pr == h {
        return true;
    }
    // 옵션으로 읽히지 않게 sha 모양만 넘긴다.
    if !pr.bytes().all(|b| b.is_ascii_hexdigit()) || !h.bytes().all(|b| b.is_ascii_hexdigit()) {
        return false;
    }
    (deps.exec)(
        &deps.git_path,
        &args(&["-C", path, "merge-base", "--is-ancestor", pr, h]),
        &git_env(&deps.home),
    )
    .code
        == 0
}

pub(super) fn is_within(child: &str, parent: &str) -> bool {
    child == parent || child.starts_with(&format!("{}/", parent.trim_end_matches('/')))
}

/// 지키는 자리(`protected`) 중 하나와 같거나 그 조상인가 — 지우면 그 자리까지 사라지는 경로(security c5 조건 2).
/// c5-3 의 지우기 직전 검사도 이것을 쓴다.
pub fn guards_protected(path: &str, protected: &[String]) -> bool {
    let p = normalize_cleanup_path(path);
    protected
        .iter()
        .any(|g| is_within(&normalize_cleanup_path(g), &p))
}

/// 후보로 올려도 되는 worktree 경로인가(TS 에 없는 검사). 모양·실제 경로·main 과의 관계·지키는 자리를 본다.
pub fn candidate_path_ok(path: &str, main: &str, protected: &[String]) -> bool {
    let p = normalize_cleanup_path(path);
    let m = normalize_cleanup_path(main);
    if !safe_target(&p) || is_within(&p, &m) || is_within(&m, &p) || guards_protected(&p, protected)
    {
        return false;
    }
    // 실제 경로가 적힌 경로와 같아야 한다 — 어느 칸이든 심링크면 거절.
    match std::fs::canonicalize(path) {
        Ok(real) => real
            .to_str()
            .is_some_and(|r| normalize_cleanup_path(r) == p),
        Err(_) => false,
    }
}

/// TS `scanRepo` — 한 저장소의 worktree 들(main 제외)에 브랜치·PR·크기·주인을 붙인다.
pub fn scan_repo(
    deps: &ScanDeps,
    repo: &str,
    owners: &HashMap<String, OwnerRecord>,
) -> Vec<ObservedWorktree> {
    let env = git_env(&deps.home);
    let r = (deps.exec)(
        &deps.git_path,
        &args(&["-C", repo, "worktree", "list", "--porcelain"]),
        &env,
    );
    if r.code != 0 {
        return Vec::new();
    }
    let mut list = parse_worktree_porcelain(&r.stdout).into_iter();
    let Some(main) = list.next() else {
        return Vec::new();
    };
    let origin = (deps.exec)(
        &deps.git_path,
        &args(&["-C", &main.path, "remote", "get-url", "origin"]),
        &env,
    );
    let slug = (origin.code == 0)
        .then(|| github_slug(&origin.stdout))
        .flatten();
    let mut out = Vec::new();
    for w in list {
        if w.bare
            || w.locked
            || w.prunable
            || !candidate_path_ok(&w.path, &main.path, &deps.protected)
        {
            continue;
        }
        let mut pr = None;
        if let Some(slug) = &slug {
            let pick = match (&w.branch, &w.head) {
                (Some(b), _) => Some(("--head", b.clone())),
                (None, Some(h)) => Some(("--search", h.clone())),
                _ => None,
            };
            if let Some((flag, val)) = pick {
                let mut a = args(&[
                    "pr",
                    "list",
                    "-R",
                    slug,
                    "--state",
                    "all",
                    "--json",
                    "number,state,headRefOid",
                    "--limit",
                    "5",
                ]);
                a.push(flag.to_string());
                a.push(val);
                let g = (deps.exec)(&deps.gh_path, &a, &deps.gh_env);
                pr = (g.code == 0).then(|| parse_pr_list(&g.stdout)).flatten();
                // 그 PR 이 **이 worktree 의** PR 인지 본다 — 브랜치 이름을 다시 쓰면 `--head` 가 옛 머지 PR 을 잡는다.
                if pr.as_ref().is_some_and(|p| {
                    !pr_head_is_ours(deps, &w.path, p.head_sha.as_deref(), w.head.as_deref())
                }) {
                    pr = None;
                }
            }
        }
        let thread = owners
            .get(&normalize_cleanup_path(&w.path))
            .map(OwnerRecord::thread);
        let (size, last_modified_at) = measure(deps, &w.path);
        out.push(ObservedWorktree {
            path: w.path,
            repo: main.path.clone(),
            branch: w.branch,
            head_sha: w.head,
            thread,
            pr,
            last_modified_at,
            size,
            ..Default::default()
        });
    }
    out
}

/// TS `repoOfWorktree` — worktree 경로 → 그 저장소(main worktree 경로). 사라진 경로·git 아님·bare 는 None.
/// TS 보다 좁게: 경로 자체가 심링크면 None(`symlink_metadata`).
pub fn repo_of_worktree(deps: &ScanDeps, path: &str) -> Option<String> {
    if !std::fs::symlink_metadata(path).ok()?.is_dir() {
        return None;
    }
    let r = (deps.exec)(
        &deps.git_path,
        &args(&[
            "-C",
            path,
            "rev-parse",
            "--path-format=absolute",
            "--git-common-dir",
        ]),
        &git_env(&deps.home),
    );
    if r.code != 0 {
        return None;
    }
    let common = Path::new(r.stdout.trim());
    (common.file_name()? == ".git")
        .then(|| common.parent()?.to_str().map(str::to_string))
        .flatten()
}

/// TS `lastActivityAt` — HEAD 커밋 시각·HEAD reflog mtime·`<path>/.git` mtime 중 가장 늦은 것. 하나도 못 읽으면 None.
pub fn last_activity_at(deps: &ScanDeps, path: &str) -> Option<String> {
    let env = git_env(&deps.home);
    let r = (deps.exec)(
        &deps.git_path,
        &args(&["-C", path, "log", "-1", "--format=%cI", "HEAD"]),
        &env,
    );
    let commit = (r.code == 0)
        .then(|| crate::turn_leases::parse_iso_ms(r.stdout.trim()))
        .flatten();
    let g = (deps.exec)(
        &deps.git_path,
        &args(&[
            "-C",
            path,
            "rev-parse",
            "--path-format=absolute",
            "--git-dir",
        ]),
        &env,
    );
    let reflog = (g.code == 0 && !g.stdout.trim().is_empty())
        .then(|| {
            std::fs::symlink_metadata(Path::new(g.stdout.trim()).join("logs").join("HEAD"))
                .ok()
                .as_ref()
                .and_then(mtime_ms)
        })
        .flatten();
    let made = std::fs::symlink_metadata(Path::new(path).join(".git"))
        .ok()
        .as_ref()
        .and_then(mtime_ms);
    [commit, reflog, made]
        .into_iter()
        .flatten()
        .max()
        .map(iso_from_ms)
}

/// TS `onlyRebuildableIgnored` — 무시된 것이 모두 다시 만들 수 있는 폴더(마지막 마디가 그 이름)인가. git 이 못 읽으면 false.
pub fn only_rebuildable_ignored(deps: &ScanDeps, path: &str) -> bool {
    let r = (deps.exec)(
        &deps.git_path,
        &args(&[
            "-C",
            path,
            "status",
            "--porcelain",
            "-z",
            "--ignored=matching",
            "--untracked-files=normal",
        ]),
        &git_env(&deps.home),
    );
    if r.code != 0 {
        return false;
    }
    r.stdout
        .split('\0')
        .filter_map(|e| e.strip_prefix("!! "))
        .all(|e| {
            let last = e.trim_end_matches('/').rsplit('/').next().unwrap_or("");
            REBUILDABLE_DIRS.contains(&last)
        })
}

/// 서버로 요청 하나를 그 에이전트 자격으로 보낸다(c5-3 에서 잇는다).
pub type Forward<'a> = &'a dyn Fn(&str, RunnerLinkRequest) -> RunnerLinkResponse;

fn uuidish(s: &str) -> bool {
    s.len() == 36 && s.bytes().all(|b| b.is_ascii_hexdigit() || b == b'-')
}

/// TS `isThreadDone` — 루트 메시지의 statusReaction 이 done 인가. 못 읽으면 false(지우지 않는 쪽).
/// TS 보다 좁게: rootId 가 uuid 모양이 아니면 묻지 않는다(경로에 그대로 들어간다).
pub fn is_thread_done(forward: Forward<'_>, agent_id: &str, root_id: &str, req_id: &str) -> bool {
    if !uuidish(root_id) {
        return false;
    }
    let res = forward(
        agent_id,
        RunnerLinkRequest::HttpForward {
            id: req_id.to_string(),
            method: "GET".into(),
            path: format!("/messages/{root_id}"),
            body: None,
            body_base64: None,
            content_type: None,
        },
    );
    let RunnerLinkResponse::HttpResponse {
        status: 200, body, ..
    } = res
    else {
        return false;
    };
    serde_json::from_str::<Value>(&body)
        .ok()
        .and_then(|v| {
            v.get("statusReaction")?
                .get("status")?
                .as_str()
                .map(|s| s == "done")
        })
        .unwrap_or(false)
}

#[cfg(test)]
mod tests;
