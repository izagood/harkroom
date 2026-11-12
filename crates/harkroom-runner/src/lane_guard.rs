//! API 키 연결(전용 제공사 경로) 턴의 작업 폴더 검사 — TS 정본 `packages/agent/src/laneWorkspaceGuard.ts`(security, 2026-10-23).
//!
//! 작업 폴더의 몇몇 이름은 **다음 턴**의 지시·도구·플러그인을 바꾼다(`.claude/`·`.opencode/`·`.codex/`·`CLAUDE.md`·`AGENTS.md`·
//! `.mcp.json`·`opencode.json[c]`·`kilo.json[c]`·`.kilo/`·`.kilocoderules`). 권한 표의 이름 맞추기만으로는 다 닫히지 않는다 — 그래서
//! 하네스를 띄우기 **전에** 폴더를 훑어, 그런 이름이 (대소문자를 가리지 않고) 우리 것이 아닌 꼴로 있으면 그 턴을 띄우지 않는다.
//! 사람의 파일일 수 있으니 지우지 않는다(fail-closed).
//!
//! TS 와 다른 점(둘 다 더 닫힌 쪽):
//! - 러너 스킬 폴더 안 `skills/` 를 lstat 으로 디렉터리라 본 뒤 읽지 못하면 TS 는 빈 목록(=우리 것)으로 넘어갔다. 여기서는 걸린 것으로 본다.
//! - 링크 대상 비교는 경로 글자 그대로(바이트) 맞춘다. TS 는 `join` 으로 `skillsDir` 쪽만 정규화했다 — 러너가 넘기는 값은 이미 정규형이다.

use std::fs;
use std::path::{Path, PathBuf};

/// 다음 턴을 바꾸는 이름(소문자). 대소문자를 가리지 않고 맞춘다.
const PROTECTED_NAMES: &[&str] = &[
    // `.codex`: codex 프로젝트 설정 폴더(security F1). 러너는 여기 아무것도 깔지 않는다.
    ".claude",
    ".opencode",
    ".agents",
    ".codex",
    "claude.md",
    "claude.local.md",
    "agents.md",
    "context.md",
    ".mcp.json",
    "opencode.json",
    "opencode.jsonc",
    // kilo 프로젝트 설정·지시 이름(7.8.17 실측 — 이 이름들이 읽혔다).
    "kilo.json",
    "kilo.jsonc",
    ".kilo",
    ".kilocode",
    ".kilocoderules",
];

/// 러너가 스스로 까는 자리(`sync_skills`): `<이름>/skills/<slug>` 링크만 들어 있으면 우리 것이다. 이름은 글자 그대로 맞춘다.
const RUNNER_SKILL_DIRS: &[&str] = &[".claude", ".agents"];

/// 사람 홈 바로 그 자리에서 보는 이름 — 하네스가 위로 거슬러 읽는 **프로젝트** 설정 파일만이다. `~/.claude`·`~/.agents`·`~/.codex`
/// 같은 전역 자리는 늘 있어서(사람의 것) 걸면 모든 턴이 서고, 그쪽은 홈 표지 자리·스위치가 맡는다.
const HOME_PROJECT_NAMES: &[&str] = &[
    "opencode.json",
    "opencode.jsonc",
    "kilo.json",
    "kilo.jsonc",
    ".kilocoderules",
];

/// 홈의 하네스 설치 폴더 — 설치 파일만 허용한다(그 밖의 이름이 있으면 걸린다).
const HOME_INSTALL_DIRS: &[&str] = &[".opencode", ".kilo", ".kilocode"];
const HOME_INSTALL_ALLOWED: &[&str] = &[
    "bin",
    "node_modules",
    "package.json",
    "package-lock.json",
    "bun.lock",
    ".gitignore",
];

/// 못 읽은 자리의 표지 — TS 와 같은 글자.
pub const UNREADABLE: &str = "(unreadable)";

/// 폴더의 이름들. 못 읽으면 `None`.
fn names_of(dir: &Path) -> Option<Vec<String>> {
    let rd = fs::read_dir(dir).ok()?;
    let mut out = Vec::new();
    for e in rd {
        out.push(e.ok()?.file_name().to_string_lossy().into_owned());
    }
    Some(out)
}

fn is_protected(lower: &str) -> bool {
    PROTECTED_NAMES.contains(&lower)
}

fn only_runner_skill_links(dir: &Path, skills_dir: &Path) -> bool {
    if !fs::symlink_metadata(dir).is_ok_and(|m| m.is_dir()) {
        return false;
    }
    let Some(top) = names_of(dir) else {
        return false;
    };
    if top.iter().any(|n| n != "skills") {
        return false;
    }
    if top.is_empty() {
        return true;
    }
    let skills = dir.join("skills");
    if !fs::symlink_metadata(&skills).is_ok_and(|m| m.is_dir()) {
        return false;
    }
    // TS 는 여기서 못 읽으면 빈 목록(=통과)이었다 — 걸린 것으로 본다(머리말).
    let Some(entries) = names_of(&skills) else {
        return false;
    };
    for name in entries {
        let p = skills.join(&name);
        if !fs::symlink_metadata(&p).is_ok_and(|m| m.file_type().is_symlink()) {
            return false;
        }
        // `sync_skills` 가 만드는 꼴(`<skillsDir>/<slug>`) 그대로일 때만 우리 것이다 — 앞머리 비교는 형제 폴더·`..` 를 통과시킨다.
        let Ok(target) = fs::read_link(&p) else {
            return false;
        };
        if target.as_os_str() != skills_dir.join(&name).as_os_str() {
            return false;
        }
    }
    true
}

/// TS `laneWorkspaceViolations` — 작업 폴더 맨 위에서 다음 턴을 바꾸는 이름 중 우리 것이 아닌 것(없으면 빈 목록, 정렬).
/// `skills_dir` 은 러너 상태의 스킬 디렉터리(`runner_skills_dir`) — 그곳을 가리키는 링크만 우리 것으로 본다.
pub fn lane_workspace_violations(workspace_dir: &Path, skills_dir: &Path) -> Vec<String> {
    // 못 읽으면 걸린 것으로 본다(fail-closed) — 빈 목록으로 두면 검사 없이 턴이 뜬다.
    let Some(names) = names_of(workspace_dir) else {
        return vec![UNREADABLE.to_string()];
    };
    let mut out: Vec<String> = names
        .into_iter()
        .filter(|name| is_protected(&name.to_lowercase()))
        .filter(|name| {
            !(RUNNER_SKILL_DIRS.contains(&name.as_str())
                && only_runner_skill_links(&workspace_dir.join(name), skills_dir))
        })
        .collect();
    out.sort();
    out
}

fn label_join(label: &Path, parts: &[&str]) -> String {
    let mut p = PathBuf::from(label);
    for s in parts {
        p.push(s);
    }
    p.to_string_lossy().into_owned()
}

/// TS `laneParentViolations` — 작업 폴더의 **부모 사슬**(바로 위부터 `home` 까지)에서 다음 턴을 바꾸는 이름(security G3, 2026-10-25).
///
/// 하네스 판과 무관한 검사다 — 프로젝트 설정 끄기 스위치가 새 판에서 조용히 안 먹어도 위 폴더에 심은 것이 없으면 구멍이 열리지 않는다.
/// 하네스는 실제 경로로 거슬러 오르므로 두 경로 다 `canonicalize` 로 풀고 시작한다. `home` 밖의 작업 폴더는 보지 않는다.
/// 못 읽은 것은 걸린 것으로 본다(fail-closed). 찾은 것은 `home` 기준 상대 경로(홈 자리는 `~/…`)로, 정렬해 돌려준다.
pub fn lane_parent_violations(workspace_dir: &Path, home: &Path) -> Vec<String> {
    let (Ok(real_ws), Ok(real_home)) = (fs::canonicalize(workspace_dir), fs::canonicalize(home))
    else {
        return vec![UNREADABLE.to_string()];
    };
    let mut out = Vec::new();
    let under_home = |p: &Path| p != real_home && p.starts_with(&real_home);
    if !under_home(&real_ws) {
        return out;
    }
    let mut dir = real_ws.parent().map(Path::to_path_buf);
    while let Some(d) = dir {
        let at_home = d == real_home;
        let label = match d.strip_prefix(&real_home) {
            Ok(rel) if !rel.as_os_str().is_empty() => rel.to_path_buf(),
            _ => PathBuf::from("~"),
        };
        let Some(names) = names_of(&d) else {
            out.push(label_join(&label, &[UNREADABLE]));
            break;
        };
        for name in &names {
            let lower = name.to_lowercase();
            if !at_home {
                if is_protected(&lower) {
                    out.push(label_join(&label, &[name]));
                }
            } else if HOME_PROJECT_NAMES.contains(&lower.as_str()) {
                out.push(label_join(&label, &[name]));
            } else if HOME_INSTALL_DIRS.contains(&lower.as_str()) {
                // 홈의 하네스 설치 폴더는 설치 파일만 허용한다.
                match names_of(&d.join(name)) {
                    None => out.push(label_join(&label, &[name])),
                    Some(inside) => out.extend(
                        inside
                            .iter()
                            .filter(|n| !HOME_INSTALL_ALLOWED.contains(&n.as_str()))
                            .map(|n| label_join(&label, &[name, n])),
                    ),
                }
            }
        }
        if at_home || !under_home(&d) {
            break;
        }
        dir = d.parent().map(Path::to_path_buf);
    }
    out.sort();
    out
}

#[cfg(test)]
#[path = "lane_guard_tests.rs"]
mod tests;
