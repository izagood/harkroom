//! 작업 폴더 정리 — 러너 쪽(정본 `packages/agent/src/cleanupReport.ts` + `main.ts` 배선).
//!
//! 오퍼레이터는 러너 상태 트리를 읽지도 쓰지도 않는다. 그래서 이 트리 안의 사실과 이 트리 안의 지우기는 러너가 한다:
//! - **알리기** — 턴이 시작·끝날 때, 기동 때 한 번(표지 파일), 그리고 30분마다 relay `CLEANUP_REPORT_PATH` 로 보낸다:
//!   스레드별로 그 턴이 만든 worktree 경로·마지막 턴 시각·지금 도는가·작업 폴더.
//! - **지우기** — 오퍼레이터 답의 `deleteThreads` 를 받아 그 스레드의 작업 폴더와 Claude 세션 기록(`memory/` 밖)을 지우고
//!   세션 레코드를 뺀다. 지운 것은 다음 보고의 `deleted` 로 알린다.
//!
//! worktree 의 주인을 정하는 법: 그 턴의 하네스 기록에 **실행한 명령**(claude `tool_use.input.command`, codex
//! `function_call.arguments.command`)으로 `worktree add <경로>` 가 있고, `git -C <경로> worktree list --porcelain` 이 그 경로
//! 자체를 worktree 로 보여 줄 때만이다. 에이전트의 workingDir 저장소로 거르지 않는다(어느 저장소의 worktree 든 주인이 된다).
//! 상대 경로·`$VAR` 는 **같은 명령 글 안에서** `worktree add` 앞의 `cd <절대>`·`VAR=<절대>`·`git -C <절대>` 로만 푼다.
//! 못 풀면 건너뛴다.

use std::collections::{BTreeSet, HashMap};
use std::path::{Path, PathBuf};
use std::sync::mpsc::{Sender, channel};
use std::sync::{Arc, Mutex, OnceLock};
use std::time::Duration;

use serde_json::{Value, json};

use crate::session_store::SessionStore;

/// 기동 보고 표지(새 해석기로 한 번 다시 돈다 — v2).
pub const CLEANUP_BACKFILL_MARKER: &str = "cleanup-backfill-v2.json";
/// 한가한 러너도 지우기 요청을 받게 — 오퍼레이터 청소기 주기(1시간)의 절반.
pub const CLEANUP_TICK: Duration = Duration::from_secs(30 * 60);

// ── 경로 도움 ────────────────────────────────────────────────────────────────

/// TS `normalizeCleanupPath`(오퍼레이터 `normalize_cleanup_path` 와 같은 선) + `.`·`..` 글자 접기.
/// `/private/tmp/x` → `/tmp/x`, 끝 슬래시를 뗀다.
pub fn normalize_cleanup_path(p: &str) -> String {
    let s = p
        .strip_prefix("/private")
        .filter(|r| r.starts_with("/tmp/"))
        .unwrap_or(p);
    if !s.starts_with('/') {
        return s.trim_end_matches('/').to_string();
    }
    let mut parts: Vec<&str> = Vec::new();
    for c in s.split('/') {
        match c {
            "" | "." => {}
            ".." => {
                parts.pop();
            }
            x => parts.push(x),
        }
    }
    format!("/{}", parts.join("/"))
}

/// TS `claudeProjectDirName`.
pub fn claude_project_dir_name(cwd: &str) -> String {
    cwd.chars()
        .map(|c| {
            if c.is_ascii_alphanumeric() || c == '-' {
                c
            } else {
                '-'
            }
        })
        .collect()
}

// ── 명령 글 뽑기 ──────────────────────────────────────────────────────────────

/// 하네스 기록(jsonl)에서 **실행한 명령**만 뽑는다 — 모델이 읽은 파일·출력에 적힌 `worktree add` 는 세지 않는다.
pub fn command_texts(jsonl: &str) -> Vec<String> {
    fn visit(v: &Value, depth: usize, out: &mut Vec<String>) {
        if depth > 8 {
            return;
        }
        match v {
            Value::Array(a) => a.iter().for_each(|x| visit(x, depth + 1, out)),
            Value::Object(o) => {
                let ty = o.get("type").and_then(Value::as_str);
                if ty == Some("tool_use")
                    && let Some(c) = o
                        .get("input")
                        .and_then(|i| i.get("command"))
                        .and_then(Value::as_str)
                {
                    out.push(c.to_string());
                    return;
                }
                if ty == Some("function_call")
                    && let Some(args) = o.get("arguments").and_then(Value::as_str)
                {
                    if let Ok(a) = serde_json::from_str::<Value>(args) {
                        match a.get("command") {
                            Some(Value::String(s)) => out.push(s.clone()),
                            Some(Value::Array(xs)) => {
                                let xs: Vec<&str> = xs.iter().filter_map(Value::as_str).collect();
                                // `["bash","-lc","<스크립트>"]` — 스크립트 글 자체를 본다(`cd` 가 명령 머리에 오게).
                                match xs.iter().position(|x| *x == "-c" || *x == "-lc") {
                                    Some(k) if k + 1 < xs.len() => out.push(xs[k + 1].to_string()),
                                    _ => out.push(xs.join(" ")),
                                }
                            }
                            _ => {}
                        }
                    }
                    return;
                }
                o.values().for_each(|x| visit(x, depth + 1, out));
            }
            _ => {}
        }
    }
    let mut out = Vec::new();
    for line in jsonl.lines() {
        if !line.contains("worktree add") {
            continue;
        }
        if let Ok(v) = serde_json::from_str::<Value>(line) {
            visit(&v, 0, &mut out);
        }
    }
    out
}

#[derive(Debug, PartialEq)]
enum Tok {
    Word(String),
    Sep,
}

/// 셸 글을 낱말·구분자로 가른다(가벼운 셈 — 따옴표는 벗기고 안의 빈칸은 지킨다).
fn tokenize(text: &str) -> Vec<Tok> {
    let mut out = Vec::new();
    let mut cur = String::new();
    let mut quote: Option<char> = None;
    let mut has = false;
    let flush = |cur: &mut String, has: &mut bool, out: &mut Vec<Tok>| {
        if *has {
            out.push(Tok::Word(std::mem::take(cur)));
            *has = false;
        }
    };
    for c in text.chars() {
        if let Some(q) = quote {
            if c == q {
                quote = None;
            } else {
                cur.push(c);
            }
            continue;
        }
        match c {
            '\'' | '"' => {
                quote = Some(c);
                has = true;
            }
            ';' | '&' | '|' | '\n' | '(' | ')' => {
                flush(&mut cur, &mut has, &mut out);
                if out.last() != Some(&Tok::Sep) {
                    out.push(Tok::Sep);
                }
            }
            c if c.is_whitespace() => flush(&mut cur, &mut has, &mut out),
            c => {
                cur.push(c);
                has = true;
            }
        }
    }
    flush(&mut cur, &mut has, &mut out);
    out
}

fn is_var_name(s: &str) -> bool {
    let mut cs = s.chars();
    cs.next()
        .is_some_and(|c| c.is_ascii_alphabetic() || c == '_')
        && cs.all(|c| c.is_ascii_alphanumeric() || c == '_')
}

/// `$VAR`·`${VAR}` 를 푼다. 모르는 변수가 하나라도 있으면 `None`.
fn expand_vars(s: &str, vars: &HashMap<String, String>) -> Option<String> {
    let mut out = String::new();
    let mut rest = s;
    while let Some(i) = rest.find('$') {
        out.push_str(&rest[..i]);
        let after = &rest[i + 1..];
        let (name, tail) = if let Some(b) = after.strip_prefix('{') {
            let end = b.find('}')?;
            (&b[..end], &b[end + 1..])
        } else {
            let end = after
                .find(|c: char| !(c.is_ascii_alphanumeric() || c == '_'))
                .unwrap_or(after.len());
            (&after[..end], &after[end..])
        };
        if !is_var_name(name) {
            return None;
        }
        out.push_str(vars.get(name)?);
        rest = tail;
    }
    out.push_str(rest);
    Some(out)
}

/// 낱말을 절대 경로로(변수·`~/`·기준 폴더). 못 풀면 `None`.
fn resolve(
    word: &str,
    vars: &HashMap<String, String>,
    home: &str,
    base: Option<&str>,
) -> Option<String> {
    let w = expand_vars(word, vars)?;
    if w.is_empty() {
        return None;
    }
    let abs = if w.starts_with('/') {
        w
    } else if let Some(r) = w.strip_prefix("~/") {
        format!("{home}/{r}")
    } else if w == "~" {
        home.to_string()
    } else {
        format!("{}/{w}", base?)
    };
    Some(normalize_cleanup_path(&abs))
}

/// 절대·`~` 로만 푼다(`cd`·`VAR=`·`git -C` 의 값 — 상대 기준은 쓰지 않는다).
fn resolve_abs(word: &str, vars: &HashMap<String, String>, home: &str) -> Option<String> {
    resolve(word, vars, home, None)
}

/// 명령 글 하나에서 `git worktree add` 의 대상 경로(정규화). 절대·`~/` 는 그대로, 상대·`$VAR` 는 같은 글 안 앞쪽의
/// 마지막 `cd <절대>`·`VAR=<절대>`(`export` 포함)·같은 git 호출의 `git -C <절대>`(cd 보다 앞선다)로 푼다. 못 풀면 건너뛴다.
pub fn worktree_add_paths(text: &str, home: &str) -> Vec<String> {
    let toks = tokenize(text);
    let mut out = Vec::new();
    let mut vars: HashMap<String, String> = HashMap::new();
    let mut cwd: Option<String> = None;
    let mut seg_start = 0usize;
    let mut i = 0usize;
    let word = |j: usize| match toks.get(j) {
        Some(Tok::Word(w)) => Some(w.as_str()),
        _ => None,
    };
    while i < toks.len() {
        let Some(w) = word(i) else {
            seg_start = i + 1;
            i += 1;
            continue;
        };
        let at_cmd_start =
            i == seg_start || (i == seg_start + 1 && word(seg_start) == Some("export"));
        if at_cmd_start
            && let Some((name, val)) = w.split_once('=')
            && is_var_name(name)
        {
            match resolve_abs(val, &vars, home) {
                Some(p) => vars.insert(name.to_string(), p),
                None => vars.remove(name),
            };
            // 같은 줄의 다음 낱말도 대입일 수 있다(`A=/x B=/y`).
            seg_start = i + 1;
            i += 1;
            continue;
        }
        if i == seg_start && w == "cd" {
            cwd = word(i + 1).and_then(|d| resolve_abs(d, &vars, home));
            i += 2;
            continue;
        }
        if w == "worktree" && word(i + 1) == Some("add") {
            // 같은 git 호출의 `-C <절대>`.
            let mut git_c: Option<String> = None;
            if let Some(g) = (seg_start..i).rev().find(|&j| word(j) == Some("git")) {
                let mut j = g + 1;
                while j < i {
                    if word(j) == Some("-C") {
                        git_c = word(j + 1).and_then(|d| resolve_abs(d, &vars, home));
                        j += 2;
                    } else {
                        j += 1;
                    }
                }
            }
            let base = git_c.or_else(|| cwd.clone());
            let mut j = i + 2;
            while let Some(t) = word(j) {
                if t == "-b" || t == "-B" || t == "--reason" {
                    j += 2;
                    continue;
                }
                if t.starts_with('-') {
                    j += 1;
                    continue;
                }
                if let Some(p) = resolve(t, &vars, home, base.as_deref()) {
                    out.push(p);
                }
                break;
            }
            i = j + 1;
            continue;
        }
        i += 1;
    }
    out
}

/// `git -C <경로> worktree list --porcelain` 의 경로들(정규화). 실패하면 빈 목록.
pub fn git_worktree_paths(repo: &Path) -> Vec<String> {
    let out = std::process::Command::new("git")
        .arg("-C")
        .arg(repo)
        .args(["worktree", "list", "--porcelain"])
        .env("GIT_TERMINAL_PROMPT", "0")
        .stdin(std::process::Stdio::null())
        .stderr(std::process::Stdio::null())
        .output();
    match out {
        Ok(o) if o.status.success() => String::from_utf8_lossy(&o.stdout)
            .lines()
            .filter_map(|l| l.strip_prefix("worktree "))
            .map(normalize_cleanup_path)
            .collect(),
        _ => Vec::new(),
    }
}

/// 기록 파일들에서 이 턴이 만든 worktree — 뽑은 경로마다 그 경로 자체가 worktree 목록에 있을 때만.
pub fn owned_worktrees(
    transcripts: &[PathBuf],
    home: &str,
    list: &dyn Fn(&Path) -> Vec<String>,
) -> Vec<String> {
    let mut seen = BTreeSet::new();
    let mut out = Vec::new();
    for t in transcripts {
        let Ok(text) = std::fs::read_to_string(t) else {
            continue;
        };
        for cmd in command_texts(&text) {
            for p in worktree_add_paths(&cmd, home) {
                if seen.insert(p.clone()) && list(Path::new(&p)).contains(&p) {
                    out.push(p);
                }
            }
        }
    }
    out
}

// ── 지우기 ───────────────────────────────────────────────────────────────────

/// `child` 가 `root` 아래에 있는가(실제 경로로). `child` 가 심링크면 거절한다.
pub fn is_inside_root(root: &Path, child: &Path) -> bool {
    let Ok(st) = std::fs::symlink_metadata(child) else {
        return false;
    };
    if st.file_type().is_symlink() || !st.is_dir() {
        return false;
    }
    let (Ok(r), Ok(c)) = (std::fs::canonicalize(root), std::fs::canonicalize(child)) else {
        return false;
    };
    c != r && c.starts_with(&r)
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum DeleteOutcome {
    Deleted,
    Absent,
    Refused,
}

/// 한 스레드를 지운다: 작업 폴더 + 그 작업 폴더의 Claude 세션 기록(`projects/<인코딩>/` 안의 `memory/` 밖 전부) + 세션 레코드.
/// 세션 레코드가 없으면(이 러너의 스레드가 아니다) `Absent`, 작업 폴더가 뿌리 밖·심링크면 아무것도 지우지 않고 `Refused`.
pub fn delete_thread(
    store: &SessionStore,
    workspace_base_dir: &Path,
    claude_project_roots: &[PathBuf],
    key: &str,
) -> DeleteOutcome {
    let Some(rec) = store.get(key) else {
        return DeleteOutcome::Absent;
    };
    let ws = Path::new(&rec.workspace_dir);
    if !is_inside_root(workspace_base_dir, ws) {
        return DeleteOutcome::Refused;
    }
    // 레코드를 먼저 뺀다 — 지우다 죽어도 다음 턴이 지운 세션을 이어받으려 하지 않는다.
    let _ = store.delete(key);
    let _ = std::fs::remove_dir_all(ws);
    let name = claude_project_dir_name(&rec.workspace_dir);
    for root in claude_project_roots {
        let dir = root.join(&name);
        if !is_inside_root(root, &dir) {
            continue;
        }
        for ent in std::fs::read_dir(&dir).into_iter().flatten().flatten() {
            if ent.file_name() == "memory" {
                continue; // Claude 파일 메모리는 남긴다
            }
            let p = ent.path();
            match ent.file_type() {
                Ok(t) if t.is_dir() => {
                    let _ = std::fs::remove_dir_all(&p);
                }
                _ => {
                    let _ = std::fs::remove_file(&p);
                }
            }
        }
    }
    DeleteOutcome::Deleted
}

/// `claude-accounts` 아래 `projects/` 뿌리들 — `<계정>/projects` 와 `<풀>/<계정>/projects` 두 깊이.
pub fn claude_project_roots_under(root: &Path) -> Vec<PathBuf> {
    fn walk(dir: &Path, depth: usize, out: &mut Vec<PathBuf>) {
        for ent in std::fs::read_dir(dir).into_iter().flatten().flatten() {
            let n = ent.file_name().to_string_lossy().into_owned();
            if n.starts_with('.') {
                continue;
            }
            let p = ent.path();
            if !std::fs::symlink_metadata(&p).is_ok_and(|m| m.is_dir()) {
                continue;
            }
            if n == "projects" {
                out.push(p);
            } else if depth < 2 {
                walk(&p, depth + 1, out);
            }
        }
    }
    let mut out = Vec::new();
    walk(root, 0, &mut out);
    out
}

// ── 알리기 ───────────────────────────────────────────────────────────────────

fn ref_of(key: &str) -> Option<(String, String)> {
    let (c, t) = key.split_once('/')?;
    (!c.is_empty() && !t.is_empty() && !t.contains('/')).then(|| (c.to_string(), t.to_string()))
}

fn thread_report(
    key: &str,
    worktrees: &[String],
    last: Option<String>,
    running: bool,
    ws: Option<String>,
) -> Option<Value> {
    let (c, t) = ref_of(key)?;
    Some(json!({
        "channelId": c, "threadRootId": t, "worktrees": worktrees,
        "lastTurnAt": last, "running": running, "workspaceDir": ws,
    }))
}

type SendFn = Box<dyn Fn(&Value) -> Option<Vec<Value>> + Send + Sync>;
type ListFn = Box<dyn Fn(&Path) -> Vec<String> + Send + Sync>;
type WsFn = Box<dyn Fn(&str) -> Option<String> + Send + Sync>;
type DeleteFn = Box<dyn Fn(&str) -> DeleteOutcome + Send + Sync>;

/// 리포터의 바깥 길.
pub struct CleanupDeps {
    /// relay 보고 — 답의 `deleteThreads`. 실패는 `None`.
    pub send: SendFn,
    pub list_worktrees: ListFn,
    pub home: String,
    /// 그 스레드의 지금 작업 폴더(세션 레코드).
    pub workspace_dir_of: WsFn,
    /// 답의 `deleteThreads` 를 지운다(스레드 열쇠). 없으면 지우지 않는다.
    pub delete_thread: Option<DeleteFn>,
    pub now_iso: Box<dyn Fn() -> String + Send + Sync>,
}

#[derive(Default)]
struct State {
    /// 도는 스레드(같은 열쇠가 겹치면 센다).
    open: HashMap<String, usize>,
    pending_deleted: Vec<Value>,
    /// 멘션 id → 그 턴의 기록 파일(정본 `turnTranscripts`).
    transcripts: HashMap<String, BTreeSet<PathBuf>>,
}

/// 정본 `createCleanupReporter`. 메서드는 동기로 보낸다 — 실물은 [`spawn_worker`] 의 일꾼이 부른다.
pub struct CleanupReporter {
    deps: CleanupDeps,
    state: Mutex<State>,
}

impl CleanupReporter {
    pub fn new(deps: CleanupDeps) -> Self {
        Self {
            deps,
            state: Mutex::default(),
        }
    }
    fn st(&self) -> std::sync::MutexGuard<'_, State> {
        self.state.lock().unwrap_or_else(|p| p.into_inner())
    }
    /// 장부에 "도는 중" 으로 동기로 올린다 — 이 뒤에 온 지우기 요청은 이 스레드를 건너뛴다.
    pub fn mark_open(&self, key: &str) {
        *self.st().open.entry(key.to_string()).or_default() += 1;
    }
    fn close(&self, key: &str) {
        let mut s = self.st();
        if let Some(n) = s.open.get_mut(key) {
            *n -= 1;
            if *n == 0 {
                s.open.remove(key);
            }
        }
    }
    pub fn is_open(&self, key: &str) -> bool {
        self.st().open.contains_key(key)
    }
    /// 이 멘션의 턴이 쓴 기록 파일(정본 `noteTranscript`) — jsonl 만.
    pub fn note_transcript(&self, mention_id: &str, path: PathBuf) {
        if path.extension().is_some_and(|e| e == "jsonl") {
            self.st()
                .transcripts
                .entry(mention_id.to_string())
                .or_default()
                .insert(path);
        }
    }

    fn send(&self, threads: Vec<Value>) {
        let (report, deleted) = {
            let mut s = self.st();
            let keys: BTreeSet<String> = threads
                .iter()
                .filter_map(|t| {
                    Some(format!(
                        "{}/{}",
                        t.get("channelId")?.as_str()?,
                        t.get("threadRootId")?.as_str()?
                    ))
                })
                .collect();
            let mut all = threads;
            for k in s.open.keys() {
                if !keys.contains(k)
                    && let Some(t) = thread_report(k, &[], None, true, None)
                {
                    all.push(t);
                }
            }
            let deleted = std::mem::take(&mut s.pending_deleted);
            let mut report = json!({ "threads": all });
            if !deleted.is_empty() {
                report["deleted"] = Value::Array(deleted.clone());
            }
            (report, deleted)
        };
        let Some(reply) = (self.deps.send)(&report) else {
            self.st().pending_deleted.extend(deleted);
            return;
        };
        let Some(del) = &self.deps.delete_thread else {
            return;
        };
        for r in reply {
            let (Some(c), Some(t)) = (
                r.get("channelId").and_then(Value::as_str),
                r.get("threadRootId").and_then(Value::as_str),
            ) else {
                continue;
            };
            let key = format!("{c}/{t}");
            if ref_of(&key).is_none() || self.is_open(&key) {
                continue; // 도는 턴은 건드리지 않는다
            }
            match del(&key) {
                DeleteOutcome::Deleted => self
                    .st()
                    .pending_deleted
                    .push(json!({ "channelId": c, "threadRootId": t })),
                DeleteOutcome::Refused => {
                    eprintln!("[cleanup] {t} 작업 폴더가 상태 트리 밖이라 지우지 않았다")
                }
                DeleteOutcome::Absent => {}
            }
        }
    }

    /// 턴 시작 보고(`mark_open` 은 부르는 쪽이 먼저 했다).
    pub fn turn_started(&self, key: &str) {
        let ws = (self.deps.workspace_dir_of)(key);
        if let Some(t) = thread_report(key, &[], Some((self.deps.now_iso)()), true, ws) {
            self.send(vec![t]);
        }
    }

    /// 턴 끝 보고 — 그 멘션의 기록에서 이 턴이 만든 worktree 를 읽는다.
    pub fn turn_ended(&self, key: &str, mention_id: &str) {
        self.close(key);
        let transcripts: Vec<PathBuf> = self
            .st()
            .transcripts
            .remove(mention_id)
            .map(|s| s.into_iter().collect())
            .unwrap_or_default();
        let worktrees = owned_worktrees(&transcripts, &self.deps.home, &*self.deps.list_worktrees);
        let ws = (self.deps.workspace_dir_of)(key);
        if let Some(t) = thread_report(key, &worktrees, Some((self.deps.now_iso)()), false, ws) {
            self.send(vec![t]);
        }
    }

    pub fn backfill(&self, threads: Vec<Value>) {
        if !threads.is_empty() {
            self.send(threads);
        }
    }

    pub fn tick(&self) {
        self.send(Vec::new());
    }
}

/// 기동 때 알릴 것 — 세션 레코드마다 그 작업 폴더의 Claude 세션 기록에서 worktree 를 모은다. 마지막 턴 시각은 기록 파일의
/// 가장 늦은 수정 시각이다.
pub fn collect_backfill(
    sessions: &[(String, String)],
    claude_project_roots: &[PathBuf],
    home: &str,
    list: &dyn Fn(&Path) -> Vec<String>,
) -> Vec<Value> {
    let mut out = Vec::new();
    for (key, ws) in sessions {
        let mut files = Vec::new();
        let mut last: u128 = 0;
        let name = claude_project_dir_name(ws);
        for root in claude_project_roots {
            for ent in std::fs::read_dir(root.join(&name))
                .into_iter()
                .flatten()
                .flatten()
            {
                let p = ent.path();
                if p.extension().is_none_or(|e| e != "jsonl") {
                    continue;
                }
                if let Ok(m) = std::fs::symlink_metadata(&p)
                    && m.is_file()
                {
                    if let Ok(t) = m.modified()
                        && let Ok(d) = t.duration_since(std::time::UNIX_EPOCH)
                    {
                        last = last.max(d.as_millis());
                    }
                    files.push(p);
                }
            }
        }
        let mut worktrees = owned_worktrees(&files, home, list);
        if worktrees.len() > 50 {
            worktrees.drain(..worktrees.len() - 50);
        }
        let last = (last > 0).then(|| crate::pty_record::iso_utc(last));
        if let Some(t) = thread_report(key, &worktrees, last, false, Some(ws.clone())) {
            out.push(t);
        }
    }
    out
}

// ── 실물 배선 ────────────────────────────────────────────────────────────────

enum Job {
    Started(String),
    Ended(String, String),
    Tick,
    Backfill(PathBuf, Box<dyn FnOnce() -> Vec<Value> + Send>),
}

/// 러너 수명의 리포터 손잡이 — 사건은 일꾼 스레드에 넘긴다(턴·받아들이기를 막지 않는다).
pub struct CleanupHandle {
    reporter: Arc<CleanupReporter>,
    tx: Mutex<Sender<Job>>,
}

static HANDLE: OnceLock<CleanupHandle> = OnceLock::new();

/// 일꾼을 띄우고 손잡이를 단다(기동 때 한 번). 30분 박동도 건다.
pub fn install(reporter: CleanupReporter) -> std::io::Result<()> {
    let reporter = Arc::new(reporter);
    let (tx, rx) = channel::<Job>();
    let r = Arc::clone(&reporter);
    std::thread::Builder::new()
        .name("cleanup-report".into())
        .spawn(move || {
            for job in rx {
                let r = &r;
                let _ = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| match job {
                    Job::Started(k) => r.turn_started(&k),
                    Job::Ended(k, m) => r.turn_ended(&k, &m),
                    Job::Tick => r.tick(),
                    Job::Backfill(marker, collect) => {
                        let threads = collect();
                        let n = threads.len();
                        r.backfill(threads);
                        let body =
                            json!({ "at": crate::pty_record::iso_utc(now_ms()), "threads": n });
                        if let Err(e) = write_private(&marker, &body.to_string()) {
                            eprintln!("[cleanup] 기동 보고 표지를 남기지 못했다: {}", e.kind());
                        }
                    }
                }));
            }
        })?;
    let tick_tx = tx.clone();
    std::thread::Builder::new()
        .name("cleanup-tick".into())
        .spawn(move || {
            loop {
                std::thread::sleep(CLEANUP_TICK);
                if tick_tx.send(Job::Tick).is_err() {
                    return;
                }
            }
        })?;
    let _ = HANDLE.set(CleanupHandle {
        reporter,
        tx: Mutex::new(tx),
    });
    Ok(())
}

/// 지금(UTC ISO-8601 밀리초).
pub fn now_iso() -> String {
    crate::pty_record::iso_utc(now_ms())
}

fn now_ms() -> u128 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis())
        .unwrap_or(0)
}

fn write_private(path: &Path, body: &str) -> std::io::Result<()> {
    use std::io::Write;
    use std::os::unix::fs::OpenOptionsExt;
    let mut f = std::fs::OpenOptions::new()
        .write(true)
        .create(true)
        .truncate(true)
        .mode(0o600)
        .open(path)?;
    f.write_all(body.as_bytes())
}

fn enqueue(job: Job) {
    if let Some(h) = HANDLE.get() {
        let _ = h.tx.lock().unwrap_or_else(|p| p.into_inner()).send(job);
    }
}

/// 턴 시작(정본 `turnWatch.started`) — 장부에는 동기로 먼저 올린다(security F2).
pub fn on_turn_started(key: &str) {
    if let Some(h) = HANDLE.get() {
        h.reporter.mark_open(key);
        enqueue(Job::Started(key.to_string()));
    }
}

/// 턴 끝(정본 `turnWatch.ended`).
pub fn on_turn_ended(key: &str, mention_id: &str) {
    enqueue(Job::Ended(key.to_string(), mention_id.to_string()));
}

/// 그 멘션의 턴이 쓴 기록 파일.
pub fn on_transcript(mention_id: &str, path: &Path) {
    if let Some(h) = HANDLE.get() {
        h.reporter.note_transcript(mention_id, path.to_path_buf());
    }
}

/// 기동 보고 — 표지가 없을 때 한 번(일꾼에서 돈다 — 턴을 막지 않는다).
pub fn backfill_once(marker: PathBuf, collect: Box<dyn FnOnce() -> Vec<Value> + Send>) {
    if marker.exists() {
        return;
    }
    enqueue(Job::Backfill(marker, collect));
}

#[cfg(test)]
#[path = "cleanup_report_tests.rs"]
mod tests;
