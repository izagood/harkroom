//! 턴 직전 작업 폴더 손질 — 정본 `packages/agent/src/mentionTurn.ts` 의 `scrubWorkspaceSettings`·`laneSafeSkill`·
//! `withLaneSkillHeader`·`syncSkills`(+`removeStaleLinks`·`linkSkill`)와 `stateDir.ts::runnerSkillsDir` 의 이식(s8 B4-2e-3).
//!
//! 내장 스킬 목록(`@harkroom/shared/builtinSkills` 의 `BUILTIN_SKILLS`)은 Rust 에 두 벌로 적지 않는다. TS 시험
//! (`packages/shared/test/builtinSkillsGolden.test.ts`)이 정본을 `crates/harkroom-runner/golden/builtin_skills.json` 과 비교하고
//! (다르면 빨강), 이 모듈은 그 파일을 `include_str!` 로 싣는다 — 정본을 고치면 골든을 다시 써야 TS 시험이 지난다.
//!
//! 모든 실패는 **턴을 막지 않는다**(정본과 같이 stderr 한 줄). 아직 턴 흐름에 붙지 않았다 — 오퍼레이터는 계속 node 러너를 띄운다.

use std::collections::HashSet;
use std::fs;
use std::io;
use std::path::{Path, PathBuf};
use std::sync::OnceLock;

use serde::Deserialize;

/// 스킬 하나 — 슬러그와 frontmatter 를 포함한 SKILL.md 전문.
#[derive(Debug, Clone, PartialEq, Eq, Deserialize)]
pub struct Skill {
    pub slug: String,
    pub body: String,
}

/// 정본 `BUILTIN_SKILL_PREFIX`.
pub const BUILTIN_SKILL_PREFIX: &str = "harkroom-";

#[derive(Deserialize)]
struct BuiltinGolden {
    prefix: String,
    skills: Vec<Skill>,
}

static BUILTIN_GOLDEN: &str = include_str!("../golden/builtin_skills.json");

fn builtin_golden() -> &'static BuiltinGolden {
    static CELL: OnceLock<BuiltinGolden> = OnceLock::new();
    CELL.get_or_init(|| {
        // 골든은 TS 시험이 쓰는 파일이다 — 깨졌으면 빌드한 판 자체가 잘못된 것이라 바로 멈춘다.
        let g: BuiltinGolden = serde_json::from_str(BUILTIN_GOLDEN)
            .expect("golden/builtin_skills.json 을 읽지 못했다");
        assert_eq!(
            g.prefix, BUILTIN_SKILL_PREFIX,
            "내장 스킬 접두가 정본과 다르다"
        );
        g
    })
}

/// 정본 `BUILTIN_SKILLS` — 러너가 코드와 같은 판으로 늘 다 까는 앱 기본 스킬.
pub fn builtin_skills() -> &'static [Skill] {
    &builtin_golden().skills
}

/// 정본 `isBuiltinSkillSlug`.
pub fn is_builtin_skill_slug(slug: &str) -> bool {
    slug.starts_with(BUILTIN_SKILL_PREFIX)
}

/// 정본 `runnerSkillsDir` — 러너가 승인된 스킬을 까는 자리. 하네스의 스킬 폴더는 이 아래를 가리키는 링크다.
pub fn runner_skills_dir(state_dir: &Path) -> PathBuf {
    state_dir.join("skills")
}

/// JS 정규식 `\s`·`String.prototype.trim` 이 공백으로 보는 글자(ECMAScript WhiteSpace + LineTerminator).
/// Rust `char::is_whitespace` 와는 U+0085(JS 는 공백 아님)·U+FEFF(JS 는 공백)가 다르다.
fn is_js_space(c: char) -> bool {
    matches!(
        c,
        '\t' | '\n' | '\u{0b}' | '\u{0c}' | '\r' | ' ' | '\u{a0}' | '\u{1680}' | '\u{2000}'
            ..='\u{200a}'
                | '\u{2028}'
                | '\u{2029}'
                | '\u{202f}'
                | '\u{205f}'
                | '\u{3000}'
                | '\u{feff}'
    )
}

fn js_trim(s: &str) -> &str {
    s.trim_matches(is_js_space)
}

/// JS `s.replace(/^\s*\n/, '')` — 앞머리 공백 덩어리 안의 **마지막** 줄바꿈까지 걷는다(욕심 많은 `\s*` 가 되짚는다).
fn strip_leading_blank_lines(s: &str) -> &str {
    let run = s.len() - s.trim_start_matches(is_js_space).len();
    match s[..run].rfind('\n') {
        Some(i) => &s[i + 1..],
        None => s,
    }
}

/// JS `s.split(/\r?\n/)`.
fn split_lines(s: &str) -> Vec<&str> {
    s.split('\n')
        .map(|l| l.strip_suffix('\r').unwrap_or(l))
        .collect()
}

/// 정본 `LANE_SKILL_KEYS` — lane 에 깔아도 되는 frontmatter 키(허용 목록).
const LANE_SKILL_KEYS: &[&str] = &["name", "description"];

/// 정본 `laneSafeSkill` — API 키 연결 턴에 깔아도 되는 스킬인가(security F1, 허용 목록, fail-closed).
///
/// frontmatter 가 없으면 받는다. 있으면 닫는 `---` 까지의 줄이 전부 빈 줄이거나 들여쓰기 없는 `name: …`·`description: …`
/// 이어야 받는다. 모르는 키·따옴표 키·이어지는 줄·주석·닫히지 않은 블록은 모두 뺀다.
pub fn lane_safe_skill(body: &str) -> bool {
    let text = body.strip_prefix('\u{feff}').unwrap_or(body);
    // `\r\n?` → `\n`
    let text = text.replace("\r\n", "\n").replace('\r', "\n");
    let lines: Vec<&str> = strip_leading_blank_lines(&text).split('\n').collect();
    if lines.first().map(|l| js_trim(l)) != Some("---") {
        return true;
    }
    let Some(end) = lines
        .iter()
        .skip(1)
        .position(|l| *l == "---")
        .map(|i| i + 1)
    else {
        return false;
    };
    lines[1..end].iter().all(|line| {
        if js_trim(line).is_empty() {
            return true;
        }
        lane_key(line).is_some_and(|k| LANE_SKILL_KEYS.contains(&k))
    })
}

/// `/^([a-z]+):(?:[ \t]|$)/` 의 첫 묶음.
fn lane_key(line: &str) -> Option<&str> {
    let n = line.bytes().take_while(u8::is_ascii_lowercase).count();
    if n == 0 {
        return None;
    }
    let rest = line[n..].strip_prefix(':')?;
    match rest.as_bytes().first() {
        None | Some(b' ') | Some(b'\t') => Some(&line[..n]),
        _ => None,
    }
}

/// 정본 `withLaneSkillHeader` — frontmatter 가 없는 스킬에 `name`(slug)·`description`(본문 첫 줄, 200자)을 붙인다
/// (security L2 n1). 이미 frontmatter 가 있으면 본문 그대로 돌려준다.
pub fn with_lane_skill_header(slug: &str, body: &str) -> String {
    let text = body.strip_prefix('\u{feff}').unwrap_or(body);
    if split_lines(strip_leading_blank_lines(text))
        .first()
        .map(|l| js_trim(l))
        == Some("---")
    {
        return body.to_string();
    }
    let first = split_lines(text)
        .into_iter()
        .map(|l| js_trim(strip_heading(l)))
        .find(|l| !l.is_empty())
        .unwrap_or(slug);
    let first: String = first.chars().take(200).collect();
    // 큰따옴표 문자열(JSON 꼴은 YAML 로도 읽힌다)로 써서 `:`·`#` 이 섞여도 값 하나로 읽힌다.
    let desc = serde_json::to_string(&first).unwrap_or_else(|_| "\"\"".into());
    format!("---\nname: {slug}\ndescription: {desc}\n---\n{text}")
}

/// `l.replace(/^#+\s*/, '')`.
fn strip_heading(l: &str) -> &str {
    let rest = l.trim_start_matches('#');
    if rest.len() == l.len() {
        return l;
    }
    rest.trim_start_matches(is_js_space)
}

/// 경로가 있으면(링크 포함) 지운다 — `rm(path, { force: true, recursive: true })`. 링크는 링크만 지운다.
fn rm_rf(path: &Path) -> io::Result<()> {
    match fs::symlink_metadata(path) {
        Ok(m) if m.file_type().is_dir() => fs::remove_dir_all(path),
        Ok(_) => fs::remove_file(path),
        Err(e) if e.kind() == io::ErrorKind::NotFound => Ok(()),
        Err(e) => Err(e),
    }
}

/// 정본 `scrubWorkspaceSettings` — 턴을 띄우기 전에 작업 폴더의 Claude Code 설정 파일을 지운다(security R2).
///
/// 권한은 서버 grant → argv 로만 들어와야 한다. 에이전트가 지난 턴에 셸로 `.claude/settings*.json` 을 써 두면 그 allow 가
/// 다음 턴부터 산다. `.claude` 자체가 링크면 그 너머 사람의 설정을 지우지 않도록 **링크만** 지운다(security n1).
/// 디렉터리·링크여도 턴을 죽이지 않는다(security n2). 지운 경로들을 돌려준다.
pub fn scrub_workspace_settings(workspace_dir: &Path) -> Vec<PathBuf> {
    let mut removed = Vec::new();
    let dir = workspace_dir.join(".claude");
    match fs::symlink_metadata(&dir) {
        Ok(m) if m.file_type().is_symlink() => {
            let _ = fs::remove_file(&dir);
            eprintln!(
                "[mentionTurn] 작업 폴더의 .claude 가 링크였다 — 링크만 지웠다: {}",
                dir.display()
            );
            return vec![dir];
        }
        Ok(m) if m.is_dir() => {}
        _ => return removed,
    }
    for name in ["settings.json", "settings.local.json"] {
        let path = dir.join(name);
        if fs::symlink_metadata(&path).is_err() {
            continue;
        }
        match rm_rf(&path) {
            Ok(()) => {
                eprintln!(
                    "[mentionTurn] 작업 폴더의 {name} 을 지웠다 — 권한은 서버 승인으로만 들어온다: {}",
                    path.display()
                );
                removed.push(path);
            }
            Err(e) => eprintln!(
                "[mentionTurn] {} 를 지우지 못했다(턴은 계속한다): {e}",
                path.display()
            ),
        }
    }
    removed
}

/// [`sync_skills`] 의 고름.
#[derive(Debug, Default, Clone, Copy)]
pub struct SyncSkillsOpts<'a> {
    /// API 키 연결 턴(security, 2026-10-23): [`lane_safe_skill`] 을 지나는 스킬만 깔고 [`with_lane_skill_header`] 를 붙인다.
    pub drop_tool_grants: bool,
    /// 내장 스킬. `None` 이면 [`builtin_skills`]. 시험이 바꿔 끼운다.
    pub builtins: Option<&'a [Skill]>,
}

/// 정본 `syncSkills` — 승인된 워크스페이스 스킬과 내장 스킬을 러너 상태 디렉터리에 쓰고, 하네스 스킬 폴더
/// (`.claude/skills`·`.agents/skills`)에 링크를 건다. 사라진 스킬은 파일과 링크를 **함께** 걷는다.
///
/// `list_skills` 가 실패하거나 파일 일이 실패해도 턴은 계속한다(stderr 한 줄).
pub fn sync_skills<F>(
    state_dir: &Path,
    workspace_dir: &Path,
    list_skills: F,
    opts: SyncSkillsOpts<'_>,
) where
    F: FnOnce() -> Result<Vec<Skill>, String>,
{
    if let Err(e) = sync_skills_inner(state_dir, workspace_dir, list_skills, opts) {
        eprintln!("[mentionTurn] 스킬 동기화 실패(턴은 계속한다): {e}");
    }
}

fn sync_skills_inner<F>(
    state_dir: &Path,
    workspace_dir: &Path,
    list_skills: F,
    opts: SyncSkillsOpts<'_>,
) -> Result<(), String>
where
    F: FnOnce() -> Result<Vec<Skill>, String>,
{
    let skills_dir = runner_skills_dir(state_dir);
    let harness_dirs = [
        workspace_dir.join(".claude").join("skills"),
        // Codex 공식 repo-scope 경로. `.codex/skills` 는 스캔 대상이 아니다.
        workspace_dir.join(".agents").join("skills"),
    ];
    let legacy_codex_dir = workspace_dir.join(".codex").join("skills");

    let approved = list_skills()?;
    let builtins: &[Skill] = match opts.builtins {
        Some(b) => b,
        None => builtin_skills(),
    };
    let shadowing: Vec<&str> = approved
        .iter()
        .filter(|s| is_builtin_skill_slug(&s.slug))
        .map(|s| s.slug.as_str())
        .collect();
    if !shadowing.is_empty() {
        eprintln!(
            "[mentionTurn] 내장 스킬 이름(harkroom-*)을 쓴 워크스페이스 스킬 {}개를 깔지 않았다: {}",
            shadowing.len(),
            shadowing.join(", ")
        );
    }
    let listed: Vec<&Skill> = builtins
        .iter()
        .chain(approved.iter().filter(|s| !is_builtin_skill_slug(&s.slug)))
        .collect();
    let skills: Vec<&Skill> = if opts.drop_tool_grants {
        listed
            .iter()
            .copied()
            .filter(|s| lane_safe_skill(&s.body))
            .collect()
    } else {
        listed.clone()
    };
    if skills.len() < listed.len() {
        eprintln!(
            "[mentionTurn] API 키 연결 턴 — 허용 목록 밖 frontmatter 를 가진 스킬 {}개를 깔지 않았다",
            listed.len() - skills.len()
        );
    }
    let wanted: HashSet<&str> = skills.iter().map(|s| s.slug.as_str()).collect();

    // 사라진 스킬(비활성·삭제): 상태 디렉터리의 파일과 하네스의 링크를 함께 지운다.
    if let Ok(entries) = fs::read_dir(&skills_dir) {
        for e in entries {
            let e = e.map_err(|e| e.to_string())?;
            let name = e.file_name();
            if wanted.contains(name.to_string_lossy().as_ref()) {
                continue;
            }
            rm_rf(&skills_dir.join(&name)).map_err(|e| e.to_string())?;
        }
    }
    for dir in &harness_dirs {
        remove_stale_links(dir, &skills_dir, &wanted).map_err(|e| e.to_string())?;
    }
    // 예전 구현이 만든 잘못된 경로의 **우리 링크만** 걷는다.
    remove_stale_links(&legacy_codex_dir, &skills_dir, &HashSet::new())
        .map_err(|e| e.to_string())?;

    for skill in skills {
        let skill_path = skills_dir.join(&skill.slug);
        fs::create_dir_all(&skill_path).map_err(|e| e.to_string())?;
        let body = if opts.drop_tool_grants {
            with_lane_skill_header(&skill.slug, &skill.body)
        } else {
            skill.body.clone()
        };
        fs::write(skill_path.join("SKILL.md"), body).map_err(|e| e.to_string())?;
        for dir in &harness_dirs {
            fs::create_dir_all(dir).map_err(|e| e.to_string())?;
            link_skill(&skill_path, &dir.join(&skill.slug)).map_err(|e| e.to_string())?;
        }
    }
    Ok(())
}

/// 정본 `removeStaleLinks` — 하네스 디렉터리에서 **우리가 만든** 링크(대상이 `skills_dir` 로 시작) 중 `wanted` 에 없는 것만 지운다.
/// 사람이 직접 넣은 스킬 디렉터리와 다른 도구의 링크는 건드리지 않는다. 앞머리 비교는 정본과 같은 글자 비교다.
fn remove_stale_links(
    harness_dir: &Path,
    skills_dir: &Path,
    wanted: &HashSet<&str>,
) -> io::Result<()> {
    let Ok(entries) = fs::read_dir(harness_dir) else {
        return Ok(());
    };
    let prefix = skills_dir.to_string_lossy();
    for e in entries.flatten() {
        let name = e.file_name();
        if wanted.contains(name.to_string_lossy().as_ref()) {
            continue;
        }
        let link_path = harness_dir.join(&name);
        let Ok(m) = fs::symlink_metadata(&link_path) else {
            continue;
        };
        if !m.file_type().is_symlink() {
            continue;
        }
        let Ok(target) = fs::read_link(&link_path) else {
            continue;
        };
        if target.to_string_lossy().starts_with(prefix.as_ref()) {
            rm_rf(&link_path)?;
        }
    }
    Ok(())
}

/// 정본 `linkSkill` — 링크가 이미 올바르면 그대로 두고, 아니면(없거나·파일이거나·다른 곳을 가리키면) 다시 건다.
fn link_skill(target: &Path, link_path: &Path) -> io::Result<()> {
    let meta = fs::symlink_metadata(link_path).ok();
    if let Some(m) = &meta {
        if m.file_type().is_symlink() && fs::read_link(link_path).ok().as_deref() == Some(target) {
            return Ok(());
        }
        rm_rf(link_path)?;
    }
    std::os::unix::fs::symlink(target, link_path)
}

#[cfg(test)]
#[path = "skills_sync_tests.rs"]
mod tests;
