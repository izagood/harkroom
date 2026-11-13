//! 스레드별 작업 폴더(정본 `packages/agent/src/workspace.ts` + `mentionTurn.ts` 의 `resolveWorkspaceDir`).
//!
//! - 이름은 `harkroom-<에이전트 id>-<스레드 열쇠 sha256 앞 8자>` — 에이전트를 **id 로** 넣어 같은 스레드에 불린 두 에이전트가
//!   갈린다. 뿌리에 같은 해시로 끝나는 옛 이름(handle 시절)이 있으면 그것을 쓴다(#846 — 이름이 바뀌어도 같은 자리로).
//! - 정의에 `workingDir` 가 없으면 `<뿌리>/<이름>` 을 만들어 쓴다. 있으면 avcs 워크스페이스를 그 자리에 투영한다
//!   (`avcs workspace project <이름> --out <폴더>`, cwd = 저장소). 이미 있는 폴더면 다시 부르지 않는다. 저장소가 avcs 가 아니면
//!   (`not an AVCS repo`) 격리 없이 저장소 폴더를 쓴다. 그 밖의 실패·폴더 자리에 파일이 있는 경우는 오류다.

use std::path::{Path, PathBuf};

use sha2::{Digest, Sha256};

/// 바깥 명령을 부른다(실물 `std::process::Command`). (종료 코드, stderr).
pub type Exec<'a> = &'a dyn Fn(&str, &[&str], &Path) -> std::io::Result<(i32, String)>;

/// 정본 `workspaceName`.
pub fn workspace_name(agent_id: &str, thread_key: &str, existing: &[String]) -> String {
    let digest = Sha256::digest(thread_key.as_bytes());
    let hash: String = digest.iter().take(4).map(|b| format!("{b:02x}")).collect();
    let suffix = format!("-{hash}");
    existing
        .iter()
        .find(|n| n.ends_with(&suffix))
        .cloned()
        .unwrap_or_else(|| format!("harkroom-{agent_id}{suffix}"))
}

/// 정본 `resolveWorkspaceName` — 뿌리를 읽어 옛 이름을 찾는다(뿌리가 없으면 새 이름).
pub fn resolve_workspace_name(base: &Path, agent_id: &str, thread_key: &str) -> String {
    let existing: Vec<String> = std::fs::read_dir(base)
        .map(|rd| {
            rd.filter_map(|e| e.ok())
                .filter_map(|e| e.file_name().into_string().ok())
                .collect()
        })
        .unwrap_or_default();
    workspace_name(agent_id, thread_key, &existing)
}

/// 정본 `resolveWorkspaceDir`. 실패는 `Err`(원인 한 줄 — 경로·stderr 만, 비밀 없음).
pub fn resolve_workspace_dir(
    base: &Path,
    agent_id: &str,
    thread_key: &str,
    working_dir: Option<&str>,
    exec: Exec<'_>,
) -> Result<PathBuf, String> {
    let name = resolve_workspace_name(base, agent_id, thread_key);
    let dir = base.join(&name);
    let Some(repo) = working_dir else {
        std::fs::create_dir_all(&dir)
            .map_err(|e| format!("{} 를 만들지 못했다: {e}", dir.display()))?;
        return Ok(dir);
    };
    match std::fs::metadata(&dir) {
        Ok(m) if m.is_dir() => return Ok(dir),
        Ok(_) => {
            return Err(format!(
                "{} 에 디렉터리가 아닌 파일이 있다 — 사람이 정리해야 한다",
                dir.display()
            ));
        }
        Err(_) => {}
    }
    let out = dir.to_string_lossy().into_owned();
    let (code, stderr) = exec(
        "avcs",
        &["workspace", "project", &name, "--out", &out],
        Path::new(repo),
    )
    .map_err(|e| format!("avcs 를 부르지 못했다: {e}"))?;
    if code == 0 {
        return Ok(dir);
    }
    if stderr.contains("not an AVCS repo") {
        eprintln!("[workspace] {repo} 는 avcs repo 가 아니다 — 격리 없이 repoDir 로 폴백한다");
        return Ok(PathBuf::from(repo));
    }
    Err(format!("avcs workspace project 실패: {stderr}"))
}

/// 실물 [`Exec`].
pub fn exec_command(cmd: &str, args: &[&str], cwd: &Path) -> std::io::Result<(i32, String)> {
    let o = std::process::Command::new(cmd)
        .args(args)
        .current_dir(cwd)
        .output()?;
    Ok((
        o.status.code().unwrap_or(-1),
        String::from_utf8_lossy(&o.stderr).into_owned(),
    ))
}

#[cfg(test)]
#[path = "workspace_tests.rs"]
mod tests;
