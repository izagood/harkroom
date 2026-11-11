//! TS `workspaceCleanupService.ts` 의 `createCleanupPorts` 이식 — 지우기 직전 검사(`check`)와 실제로 지우는 손(`remove`).
//!
//! **TS 보다 좁게 잡은 것**(security c5 막음 조건 1~3 — 지우기 **직전**에 다시 잰다):
//! 1. worktree 는 그 저장소의 `git worktree list --porcelain` 에 **지금** 등록돼 있고 main·bare·locked 가 아니어야 하며,
//!    지우는 손은 `git worktree remove`(`--force` 없음) 하나다. 변경이 있으면 git 이 거절한다.
//! 2. 지키는 자리(홈·`.harkroom-agent`·claude/codex 계정 뿌리·앱 데이터 폴더)와 같거나 그 조상이면 거절한다(`guards_protected`).
//!    계정 뿌리·앱 데이터 폴더는 **그 안쪽도** 거절한다(`deny_inside`, security c5-2 낮음 제안).
//! 3. 실제 경로(`canonicalize`)를 지금 다시 재어 적힌 경로와 같아야 한다 — 어느 칸이든 심링크면 거절.
//! - 스레드 폴더·세션 기록은 오퍼레이터가 지우지 않는다(TS 는 `rm -rf`). 러너에게 맡기는 것은 서비스(`service.rs`)다.
//! - 브랜치 지우기·`merge-base` 에 넘기는 sha 는 40자 16진수만, 브랜치 이름은 `-` 로 시작하지 않는 것만 받는다.
use super::scan::{
    ScanDeps, args, candidate_path_ok, git_env, is_within, parse_worktree_porcelain,
};
use super::{
    BlockReason, CleanupItem, CleanupKind, CleanupPorts, normalize_cleanup_path,
    remove_rebuildable, safe_target,
};
use std::collections::HashSet;
use std::path::Path;
use std::sync::Arc;

fn sha_ok(s: &str) -> bool {
    s.len() == 40 && s.bytes().all(|b| b.is_ascii_hexdigit())
}

fn branch_ok(s: &str) -> bool {
    !s.is_empty() && !s.starts_with('-') && !s.contains("..") && !s.bytes().any(|b| b <= b' ')
}

/// 실제 경로가 적힌 경로와 같은가(조건 3). 없거나 심링크가 끼면 false.
pub fn real_path_matches(path: &str) -> bool {
    let p = normalize_cleanup_path(path);
    match std::fs::canonicalize(path) {
        Ok(real) => real
            .to_str()
            .is_some_and(|r| normalize_cleanup_path(r) == p),
        Err(_) => false,
    }
}

pub struct GitPorts {
    pub deps: Arc<ScanDeps>,
    /// 그 안쪽도 지우지 않는 자리(계정 뿌리·앱 데이터 폴더). 실제 경로로 넣는다.
    pub deny_inside: Vec<String>,
}

impl GitPorts {
    fn git(&self, a: &[&str]) -> crate::local_merge::ExecResult {
        (self.deps.exec)(&self.deps.git_path, &args(a), &git_env(&self.deps.home))
    }

    /// TS `isPushed` — `head` 가 원격 ref 나 PR head 에 들어 있는가.
    fn is_pushed(&self, item: &CleanupItem, head: &str) -> bool {
        let pr_head = item.pr.as_ref().and_then(|p| p.head_sha.as_deref());
        if pr_head == Some(head) {
            return true;
        }
        let r = self.git(&["-C", &item.path, "branch", "-r", "--contains", head]);
        if r.code == 0 && !r.stdout.trim().is_empty() {
            return true;
        }
        if let Some(ph) = pr_head.filter(|s| sha_ok(s)) {
            return self
                .git(&["-C", &item.path, "merge-base", "--is-ancestor", head, ph])
                .code
                == 0;
        }
        false
    }

    /// 지우기 직전의 경로 조건(1~3). 통과하면 Ok, 아니면 거절 이유.
    pub fn removal_guard(&self, item: &CleanupItem) -> Result<(), String> {
        let path = item.path.as_str();
        if !safe_target(path) {
            return Err("받지 않는 경로 모양".into());
        }
        let p = normalize_cleanup_path(path);
        // 조건 3: 지금 다시 잰 실제 경로.
        if !real_path_matches(path) {
            return Err("실제 경로가 다르다(심링크·사라짐)".into());
        }
        // 조건 2: 지키는 자리·그 조상, 그리고 계정 뿌리·앱 데이터 폴더의 안쪽.
        if super::scan::guards_protected(&p, &self.deps.protected)
            || self
                .deny_inside
                .iter()
                .any(|g| is_within(&p, &normalize_cleanup_path(g)))
        {
            return Err("지키는 자리".into());
        }
        if item.kind != CleanupKind::Worktree {
            return Ok(());
        }
        // 조건 1: 그 저장소의 git 목록에 지금 등록돼 있고 main 이 아니다.
        let Some(repo) = item.repo.as_deref() else {
            return Err("저장소를 모르는 worktree".into());
        };
        if !repo.starts_with('/') {
            return Err("저장소 경로가 절대 경로가 아니다".into());
        }
        let r = self.git(&["-C", repo, "worktree", "list", "--porcelain"]);
        if r.code != 0 {
            return Err("git worktree list 실패".into());
        }
        let list = parse_worktree_porcelain(&r.stdout);
        let Some(main) = list.first() else {
            return Err("git 목록이 비었다".into());
        };
        let entry = list
            .iter()
            .skip(1)
            .find(|w| normalize_cleanup_path(&w.path) == p);
        match entry {
            Some(w) if !w.bare && !w.locked => {}
            _ => return Err("git 목록에 등록된 worktree 가 아니다".into()),
        }
        if !candidate_path_ok(path, &main.path, &self.deps.protected) {
            return Err("main worktree 와 겹치거나 지키는 자리".into());
        }
        Ok(())
    }
}

impl CleanupPorts for GitPorts {
    fn check(&self, item: &CleanupItem, running_threads: &HashSet<String>) -> Option<BlockReason> {
        if item
            .thread
            .as_ref()
            .is_some_and(|t| running_threads.contains(&t.key()))
        {
            return Some(BlockReason::TurnRunning);
        }
        if item.kind != CleanupKind::Worktree {
            return None;
        }
        // `--untracked-files=all`: 저장소 설정 `status.showUntrackedFiles=no` 여도 untracked 를 본다(security n3).
        let st = self.git(&[
            "-C",
            &item.path,
            "status",
            "--porcelain",
            "--untracked-files=all",
        ]);
        if st.code != 0 || !st.stdout.trim().is_empty() {
            return Some(BlockReason::Uncommitted);
        }
        // HEAD·브랜치는 지금 다시 읽는다 — 원장 값은 스캔 때 것이다.
        let head = self.git(&["-C", &item.path, "rev-parse", "HEAD"]);
        let head = head.stdout.trim().to_string();
        let b = self.git(&["-C", &item.path, "symbolic-ref", "-q", "--short", "HEAD"]);
        let branch = (b.code == 0)
            .then(|| b.stdout.trim().to_string())
            .filter(|s| !s.is_empty());
        if !sha_ok(&head) || Some(&head) != item.head_sha.as_ref() || branch != item.branch {
            return Some(BlockReason::Unpushed);
        }
        if !self.is_pushed(item, &head) {
            return Some(BlockReason::Unpushed);
        }
        None
    }

    fn remove(&self, item: &CleanupItem) -> Result<(), String> {
        if item.kind != CleanupKind::Worktree {
            // 스레드 폴더·세션 기록은 러너 상태 트리 안이다(#431 D5) — 오퍼레이터는 지우지 않는다.
            return Err("worktree 가 아닌 것은 오퍼레이터가 지우지 않는다".into());
        }
        let (Some(repo), Some(head)) = (item.repo.as_deref(), item.head_sha.as_deref()) else {
            return Err("worktree without repo".into());
        };
        if let Err(why) = self.removal_guard(item) {
            eprintln!("작업 폴더 청소: 지우지 않는다({why}) — {}", item.path);
            return Err(why);
        }
        // --force 없이: 변경이 있으면 git 이 거절한다.
        let r = self.git(&["-C", repo, "worktree", "remove", &item.path]);
        if r.code != 0 {
            let e = r.stderr.trim();
            return Err(if e.is_empty() {
                "git worktree remove failed".into()
            } else {
                e.to_string()
            });
        }
        // 브랜치는 끝이 검사한 커밋 그대로일 때만 지운다(`update-ref -d <ref> <old>` 는 값이 다르면 거절한다).
        if let Some(b) = item.branch.as_deref().filter(|b| branch_ok(b))
            && sha_ok(head)
        {
            let r = format!("refs/heads/{b}");
            let _ = self.git(&["-C", repo, "update-ref", "-d", &r, head]);
        }
        Ok(())
    }

    fn size(&self, path: &str) -> Option<f64> {
        super::scan::measure(&self.deps, path).0
    }

    fn remove_deps(&self, root: &str) -> Result<(), String> {
        if !safe_target(root) || !real_path_matches(root) {
            return Err("받지 않는 경로".into());
        }
        remove_rebuildable(Path::new(root), &|name, symlink| {
            // 올려 둔 파일이 하나도 없어야 한다(심링크 자체가 올라가 있어도 안 된다).
            let tracked = self.git(&["-C", root, "ls-files", "--", name]);
            if tracked.code != 0 || !tracked.stdout.trim().is_empty() {
                return false;
            }
            if symlink {
                return true;
            }
            // 폴더는 그 저장소가 무시하는 것이어야 한다.
            self.git(&["-C", root, "check-ignore", "-q", "--", name])
                .code
                == 0
        })
        .map_err(|e| e.to_string())
    }
}

#[cfg(test)]
mod tests;
