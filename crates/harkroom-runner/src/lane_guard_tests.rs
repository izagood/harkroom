//! TS `packages/agent/test/laneWorkspaceGuard.test.ts` 의 사례를 그대로 옮겼다.
use super::*;
use std::os::unix::fs::symlink;
use std::sync::atomic::{AtomicU64, Ordering};

fn tmp(tag: &str) -> PathBuf {
    static N: AtomicU64 = AtomicU64::new(0);
    let p = std::env::temp_dir().join(format!(
        "hk-lane-guard-{tag}-{}-{}",
        std::process::id(),
        N.fetch_add(1, Ordering::Relaxed)
    ));
    let _ = fs::remove_dir_all(&p);
    fs::create_dir_all(&p).unwrap();
    fs::canonicalize(&p).unwrap()
}

struct Dirs {
    ws: PathBuf,
    skills: PathBuf,
}

fn dirs() -> Dirs {
    let root = tmp("ws");
    let ws = root.join("ws");
    let skills = root.join("state").join("skills");
    fs::create_dir_all(&ws).unwrap();
    fs::create_dir_all(skills.join("plain")).unwrap();
    Dirs { ws, skills }
}

fn write(p: &Path) {
    fs::write(p, "x").unwrap();
}

fn mkdirp(p: &Path) {
    fs::create_dir_all(p).unwrap();
}

#[test]
fn plain_files_only_is_empty() {
    let d = dirs();
    write(&d.ws.join("README.md"));
    mkdirp(&d.ws.join("src"));
    assert!(lane_workspace_violations(&d.ws, &d.skills).is_empty());
}

#[test]
fn runner_skill_links_only_are_ours() {
    let d = dirs();
    for n in [".claude", ".agents"] {
        mkdirp(&d.ws.join(n).join("skills"));
        symlink(
            d.skills.join("plain"),
            d.ws.join(n).join("skills").join("plain"),
        )
        .unwrap();
    }
    assert!(lane_workspace_violations(&d.ws, &d.skills).is_empty());
}

#[test]
fn case_only_changes_are_caught() {
    let d = dirs();
    write(&d.ws.join("agents.md"));
    mkdirp(&d.ws.join(".Opencode").join("plugin"));
    write(&d.ws.join(".MCP.json"));
    write(&d.ws.join("Opencode.json"));
    assert_eq!(
        lane_workspace_violations(&d.ws, &d.skills),
        [".MCP.json", ".Opencode", "Opencode.json", "agents.md"]
    );
}

#[test]
fn foreign_definitions_dirs_and_links_are_caught() {
    let a = dirs();
    mkdirp(&a.ws.join(".claude").join("skills").join("x"));
    assert_eq!(lane_workspace_violations(&a.ws, &a.skills), [".claude"]);

    let b = dirs();
    mkdirp(&b.ws.join(".claude").join("agents"));
    assert_eq!(lane_workspace_violations(&b.ws, &b.skills), [".claude"]);

    let c = dirs();
    let elsewhere = tmp("other");
    mkdirp(&c.ws.join(".agents").join("skills"));
    symlink(
        &elsewhere,
        c.ws.join(".agents").join("skills").join("other"),
    )
    .unwrap();
    assert_eq!(lane_workspace_violations(&c.ws, &c.skills), [".agents"]);
}

#[test]
fn other_instruction_names_are_caught() {
    let d = dirs();
    write(&d.ws.join("CLAUDE.local.md"));
    write(&d.ws.join("CONTEXT.md"));
    assert_eq!(
        lane_workspace_violations(&d.ws, &d.skills),
        ["CLAUDE.local.md", "CONTEXT.md"]
    );
}

// security F2: 링크 대상은 `sync_skills` 가 만드는 꼴과 정확히 같을 때만 우리 것이다.
#[test]
fn sibling_prefix_and_dotdot_targets_are_caught() {
    let a = dirs();
    let sib = PathBuf::from(format!("{}-x/plain", a.skills.display()));
    mkdirp(&sib);
    mkdirp(&a.ws.join(".claude").join("skills"));
    symlink(&sib, a.ws.join(".claude").join("skills").join("plain")).unwrap();
    assert_eq!(lane_workspace_violations(&a.ws, &a.skills), [".claude"]);

    let b = dirs();
    mkdirp(&b.ws.join(".agents").join("skills"));
    symlink(
        format!("{}/../../ws", b.skills.display()),
        b.ws.join(".agents").join("skills").join("plain"),
    )
    .unwrap();
    assert_eq!(lane_workspace_violations(&b.ws, &b.skills), [".agents"]);
}

#[test]
fn unreadable_workspace_is_caught() {
    let d = dirs();
    assert_eq!(
        lane_workspace_violations(&d.ws.join("missing"), &d.skills),
        [UNREADABLE]
    );
}

#[test]
fn claude_md_verbatim_is_caught() {
    let d = dirs();
    write(&d.ws.join("CLAUDE.md"));
    assert_eq!(lane_workspace_violations(&d.ws, &d.skills), ["CLAUDE.md"]);
}

// security F1: codex 프로젝트 설정 폴더도 보호 이름이다.
#[test]
fn codex_dir_is_caught_whatever_it_holds() {
    let makers: [fn(&Path); 3] = [
        |ws| {
            mkdirp(&ws.join(".codex"));
            write(&ws.join(".codex").join("config.toml"));
        },
        |ws| mkdirp(&ws.join(".Codex")),
        |ws| mkdirp(&ws.join(".codex").join("skills")),
    ];
    for make in makers {
        let d = dirs();
        make(&d.ws);
        let got: Vec<String> = lane_workspace_violations(&d.ws, &d.skills)
            .iter()
            .map(|n| n.to_lowercase())
            .collect();
        assert_eq!(got, [".codex"]);
    }
}

#[test]
fn kilo_names_are_caught() {
    for (name, is_dir) in [
        ("kilo.json", false),
        ("kilo.jsonc", false),
        ("Kilo.JSON", false),
        (".kilo", true),
        (".kilocode", true),
        (".kilocoderules", false),
        (".KiloCodeRules", false),
    ] {
        let d = dirs();
        if is_dir {
            mkdirp(&d.ws.join(name));
        } else {
            write(&d.ws.join(name));
        }
        assert_eq!(lane_workspace_violations(&d.ws, &d.skills), [name]);
    }
}

#[test]
fn kilo_rules_dirs_are_caught() {
    for n in [".kilo", ".kilocode"] {
        let d = dirs();
        mkdirp(&d.ws.join(n).join("rules"));
        write(&d.ws.join(n).join("rules").join("x.md"));
        assert_eq!(lane_workspace_violations(&d.ws, &d.skills), [n]);
    }
}

/// 러너 스킬 폴더 안 `skills/` 를 읽지 못하면 걸린 것으로 본다(TS 는 통과였다 — 머리말).
#[test]
fn unreadable_runner_skills_dir_is_caught() {
    use std::os::unix::fs::PermissionsExt;
    let d = dirs();
    let s = d.ws.join(".claude").join("skills");
    mkdirp(&s);
    fs::set_permissions(&s, fs::Permissions::from_mode(0o000)).unwrap();
    // root 로 돌면 0o000 도 읽힌다 — 그때는 이 사례가 성립하지 않아 넘어간다.
    let readable = fs::read_dir(&s).is_ok();
    let got = lane_workspace_violations(&d.ws, &d.skills);
    fs::set_permissions(&s, fs::Permissions::from_mode(0o755)).unwrap();
    if !readable {
        assert_eq!(got, [".claude"]);
    }
}

// security G3(2026-10-25): 하네스 판과 무관하게 부모 사슬도 본다 — 사람 홈 자리에서는 프로젝트 설정 파일 이름만.
struct Tree {
    home: PathBuf,
    ws: PathBuf,
}

fn tree() -> Tree {
    let home = tmp("parent");
    let ws = home
        .join(".harkroom-agent")
        .join("agent-1")
        .join("workspaces")
        .join("w");
    mkdirp(&ws);
    Tree { home, ws }
}

fn sorted(mut v: Vec<String>) -> Vec<String> {
    v.sort();
    v
}

fn j(parts: &[&str]) -> String {
    parts
        .iter()
        .collect::<PathBuf>()
        .to_string_lossy()
        .into_owned()
}

#[test]
fn parent_chain_empty_ignores_global_home_dirs() {
    let t = tree();
    for d in [".claude", ".agents", ".codex", ".opencode"] {
        mkdirp(&t.home.join(d));
    }
    assert!(lane_parent_violations(&t.ws, &t.home).is_empty());
}

#[test]
fn parent_chain_catches_protected_and_home_project_files() {
    let t = tree();
    mkdirp(
        &t.home
            .join(".harkroom-agent")
            .join("agent-1")
            .join(".opencode"),
    );
    write(&t.home.join(".harkroom-agent").join("Kilo.JSON"));
    write(&t.home.join("opencode.json"));
    assert_eq!(
        lane_parent_violations(&t.ws, &t.home),
        sorted(vec![
            j(&[".harkroom-agent", "Kilo.JSON"]),
            j(&[".harkroom-agent", "agent-1", ".opencode"]),
            j(&["~", "opencode.json"]),
        ])
    );
}

#[test]
fn outside_home_is_skipped_and_unresolvable_is_caught() {
    let t = tree();
    let outside = tmp("outside");
    assert!(lane_parent_violations(&outside, &t.home).is_empty());
    assert_eq!(
        lane_parent_violations(&t.home.join("no-such").join("ws"), &t.home),
        [UNREADABLE]
    );
}

// security n1: 링크에서 멈추면 남은 부모를 안 보고 통과한다 — 하네스처럼 실제 경로 사슬을 본다.
#[test]
fn linked_workspace_walks_real_parent_chain() {
    let t = tree();
    let real = t.home.join("real");
    mkdirp(&real.join("inner").join("ws"));
    write(&t.home.join("kilo.jsonc"));
    symlink(&real, t.home.join("link")).unwrap();
    assert_eq!(
        lane_parent_violations(&t.home.join("link").join("inner").join("ws"), &t.home),
        [j(&["~", "kilo.jsonc"])]
    );
}

// security F1: 홈의 하네스 설치 폴더는 설치 파일만 허용한다.
#[test]
fn home_install_dirs_allow_only_install_files() {
    let t = tree();
    for d in [".opencode", ".kilo"] {
        mkdirp(&t.home.join(d).join("bin"));
        mkdirp(&t.home.join(d).join("node_modules"));
    }
    for f in [
        "package.json",
        "package-lock.json",
        "bun.lock",
        ".gitignore",
    ] {
        write(&t.home.join(".opencode").join(f));
    }
    assert!(lane_parent_violations(&t.ws, &t.home).is_empty());
    write(&t.home.join(".opencode").join("opencode.json"));
    mkdirp(&t.home.join(".kilo").join("plugin"));
    write(&t.home.join(".kilo").join("plugin").join("x.js"));
    mkdirp(&t.home.join(".kilocode").join("rules"));
    assert_eq!(
        lane_parent_violations(&t.ws, &t.home),
        sorted(vec![
            j(&["~", ".opencode", "opencode.json"]),
            j(&["~", ".kilo", "plugin"]),
            j(&["~", ".kilocode", "rules"]),
        ])
    );
}
