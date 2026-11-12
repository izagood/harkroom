use super::*;
use std::os::unix::fs::symlink;
use std::sync::atomic::{AtomicU64, Ordering};

/// TS 정본(`laneSafeSkill`·`withLaneSkillHeader`)으로 뽑은 사례 — frontmatter 변형·BOM·CR·유니코드 공백·200자 자르기.
static LANE_GOLDEN: &str = include_str!("../tests/lane_skill_golden.json");

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct LaneCase {
    name: String,
    slug: String,
    body: String,
    lane_safe: bool,
    header: String,
}

fn tmp() -> PathBuf {
    static N: AtomicU64 = AtomicU64::new(0);
    let p = std::env::temp_dir().join(format!(
        "hk-skills-sync-{}-{}",
        std::process::id(),
        N.fetch_add(1, Ordering::Relaxed)
    ));
    let _ = fs::remove_dir_all(&p);
    fs::create_dir_all(&p).unwrap();
    // macOS 의 /var → /private/var 를 풀어 둔다(링크 대상 비교가 글자 비교라서).
    fs::canonicalize(&p).unwrap()
}

fn sk(slug: &str, body: &str) -> Skill {
    Skill {
        slug: slug.into(),
        body: body.into(),
    }
}

#[test]
fn lane_golden_matches_ts() {
    let cases: Vec<LaneCase> = serde_json::from_str(LANE_GOLDEN).unwrap();
    assert!(cases.len() >= 30);
    for c in &cases {
        assert_eq!(
            lane_safe_skill(&c.body),
            c.lane_safe,
            "laneSafe: {}",
            c.name
        );
        assert_eq!(
            with_lane_skill_header(&c.slug, &c.body),
            c.header,
            "header: {}",
            c.name
        );
    }
}

#[test]
fn builtin_golden_loads() {
    let b = builtin_skills();
    assert!(!b.is_empty());
    for s in b {
        assert!(is_builtin_skill_slug(&s.slug), "{}", s.slug);
        // 내장 스킬은 API 키 연결 턴에도 깔려야 한다(정본 주석: name·description 만 둔다).
        assert!(lane_safe_skill(&s.body), "{}", s.slug);
    }
    assert!(!is_builtin_skill_slug("my-skill"));
}

#[test]
fn scrub_removes_settings_files_dirs_and_links() {
    let ws = tmp();
    let outside = tmp();
    fs::write(outside.join("keep.json"), "{}").unwrap();
    let dot = ws.join(".claude");
    fs::create_dir_all(dot.join("settings.local.json")).unwrap();
    fs::write(dot.join("settings.local.json").join("x"), "1").unwrap();
    symlink(outside.join("keep.json"), dot.join("settings.json")).unwrap();
    fs::write(dot.join("other.json"), "{}").unwrap();

    let removed = scrub_workspace_settings(&ws);
    assert_eq!(
        removed,
        vec![dot.join("settings.json"), dot.join("settings.local.json")]
    );
    assert!(fs::symlink_metadata(dot.join("settings.json")).is_err());
    assert!(fs::symlink_metadata(dot.join("settings.local.json")).is_err());
    assert!(dot.join("other.json").exists());
    // 링크 너머 파일은 그대로다.
    assert!(outside.join("keep.json").exists());
}

#[test]
fn scrub_dot_claude_link_removes_only_the_link() {
    let ws = tmp();
    let home = tmp();
    fs::write(home.join("settings.json"), "{}").unwrap();
    symlink(&home, ws.join(".claude")).unwrap();
    assert_eq!(scrub_workspace_settings(&ws), vec![ws.join(".claude")]);
    assert!(fs::symlink_metadata(ws.join(".claude")).is_err());
    assert!(home.join("settings.json").exists());
}

#[test]
fn scrub_nothing_when_missing_or_file() {
    let ws = tmp();
    assert!(scrub_workspace_settings(&ws).is_empty());
    fs::write(ws.join(".claude"), "x").unwrap();
    assert!(scrub_workspace_settings(&ws).is_empty());
    assert!(ws.join(".claude").is_file());
}

fn link_target(p: &Path) -> Option<PathBuf> {
    fs::read_link(p).ok()
}

#[test]
fn sync_writes_skills_and_links_both_harness_dirs() {
    let state = tmp();
    let ws = tmp();
    let builtins = [sk("harkroom-x", "---\nname: harkroom-x\n---\nB")];
    sync_skills(
        &state,
        &ws,
        || {
            Ok(vec![
                sk("alpha", "# Alpha\nbody"),
                sk("harkroom-x", "shadow"),
            ])
        },
        SyncSkillsOpts {
            drop_tool_grants: false,
            builtins: Some(&builtins),
        },
    );
    let sd = runner_skills_dir(&state);
    assert_eq!(
        fs::read_to_string(sd.join("alpha/SKILL.md")).unwrap(),
        "# Alpha\nbody"
    );
    // 내장 이름을 쓴 워크스페이스 스킬은 깔지 않는다 — 내장이 이긴다.
    assert_eq!(
        fs::read_to_string(sd.join("harkroom-x/SKILL.md")).unwrap(),
        "---\nname: harkroom-x\n---\nB"
    );
    for h in [".claude/skills", ".agents/skills"] {
        assert_eq!(
            link_target(&ws.join(h).join("alpha")),
            Some(sd.join("alpha"))
        );
        assert_eq!(
            link_target(&ws.join(h).join("harkroom-x")),
            Some(sd.join("harkroom-x"))
        );
    }
}

#[test]
fn sync_removes_stale_skills_and_only_our_links() {
    let state = tmp();
    let ws = tmp();
    let other = tmp();
    let none: [Skill; 0] = [];
    let opts = SyncSkillsOpts {
        drop_tool_grants: false,
        builtins: Some(&none),
    };
    sync_skills(&state, &ws, || Ok(vec![sk("aa", "A"), sk("bb", "B")]), opts);
    let claude = ws.join(".claude/skills");
    // 사람이 넣은 디렉터리·다른 곳을 가리키는 링크·예전 `.codex/skills` 의 우리 링크.
    fs::create_dir_all(claude.join("mine")).unwrap();
    symlink(&other, claude.join("foreign")).unwrap();
    let legacy = ws.join(".codex/skills");
    fs::create_dir_all(&legacy).unwrap();
    symlink(runner_skills_dir(&state).join("aa"), legacy.join("aa")).unwrap();
    symlink(&other, legacy.join("keep")).unwrap();

    sync_skills(&state, &ws, || Ok(vec![sk("aa", "A2")]), opts);
    let sd = runner_skills_dir(&state);
    assert!(!sd.join("bb").exists());
    assert_eq!(fs::read_to_string(sd.join("aa/SKILL.md")).unwrap(), "A2");
    assert!(fs::symlink_metadata(claude.join("bb")).is_err());
    assert!(fs::symlink_metadata(ws.join(".agents/skills/b")).is_err());
    assert!(claude.join("mine").is_dir());
    assert_eq!(link_target(&claude.join("foreign")), Some(other.clone()));
    assert!(fs::symlink_metadata(legacy.join("aa")).is_err());
    assert_eq!(link_target(&legacy.join("keep")), Some(other));
}

#[test]
fn sync_relinks_wrong_or_plain_entries() {
    let state = tmp();
    let ws = tmp();
    let other = tmp();
    let claude = ws.join(".claude/skills");
    fs::create_dir_all(&claude).unwrap();
    symlink(&other, claude.join("aa")).unwrap();
    let agents = ws.join(".agents/skills");
    fs::create_dir_all(agents.join("aa")).unwrap();
    let none: [Skill; 0] = [];
    sync_skills(
        &state,
        &ws,
        || Ok(vec![sk("aa", "A")]),
        SyncSkillsOpts {
            drop_tool_grants: false,
            builtins: Some(&none),
        },
    );
    let want = runner_skills_dir(&state).join("aa");
    assert_eq!(link_target(&claude.join("aa")), Some(want.clone()));
    assert_eq!(link_target(&agents.join("aa")), Some(want));
}

#[test]
fn sync_lane_drops_unsafe_and_adds_header() {
    let state = tmp();
    let ws = tmp();
    let none: [Skill; 0] = [];
    let opts = SyncSkillsOpts {
        drop_tool_grants: false,
        builtins: Some(&none),
    };
    let unsafe_body = "---\nname: bad\nallowed-tools: Bash\n---\nx";
    sync_skills(
        &state,
        &ws,
        || Ok(vec![sk("bad", unsafe_body), sk("ok", "# Ok skill\nx")]),
        opts,
    );
    let sd = runner_skills_dir(&state);
    assert!(sd.join("bad/SKILL.md").exists());

    // 다음 턴이 API 키 연결 턴이면 이미 깔린 위험한 스킬도 함께 걷힌다.
    sync_skills(
        &state,
        &ws,
        || Ok(vec![sk("bad", unsafe_body), sk("ok", "# Ok skill\nx")]),
        SyncSkillsOpts {
            drop_tool_grants: true,
            builtins: Some(&none),
        },
    );
    assert!(!sd.join("bad").exists());
    assert!(fs::symlink_metadata(ws.join(".claude/skills/bad")).is_err());
    assert_eq!(
        fs::read_to_string(sd.join("ok/SKILL.md")).unwrap(),
        "---\nname: ok\ndescription: \"Ok skill\"\n---\n# Ok skill\nx"
    );
}

#[test]
fn sync_list_failure_keeps_existing_and_does_not_panic() {
    let state = tmp();
    let ws = tmp();
    let none: [Skill; 0] = [];
    let opts = SyncSkillsOpts {
        drop_tool_grants: false,
        builtins: Some(&none),
    };
    sync_skills(&state, &ws, || Ok(vec![sk("aa", "A")]), opts);
    sync_skills(&state, &ws, || Err("server down".into()), opts);
    // 목록을 못 받은 턴은 아무것도 걷지 않는다(정본: 예외가 걷기 전에 난다).
    assert!(runner_skills_dir(&state).join("aa/SKILL.md").exists());
}

#[test]
fn sync_default_builtins_are_installed() {
    let state = tmp();
    let ws = tmp();
    sync_skills(&state, &ws, || Ok(Vec::new()), SyncSkillsOpts::default());
    for s in builtin_skills() {
        let p = runner_skills_dir(&state).join(&s.slug).join("SKILL.md");
        assert_eq!(fs::read_to_string(p).unwrap(), s.body);
    }
}

/// security #1981 낮음 1: slug 는 경로 조각이다 — 서버 확인이 빠져도 러너가 모양이 틀린 slug 를 깔지 않는다.
#[test]
fn sync_skips_malformed_slugs() {
    let state = tmp();
    let ws = tmp();
    let long = "a".repeat(41);
    let bad = [
        "../escape",
        "a/b",
        "UPPER",
        "x",
        long.as_str(),
        ".hidden",
        "",
    ];
    sync_skills(
        &state,
        &ws,
        || {
            let mut v: Vec<Skill> = bad.iter().map(|s| sk(s, "# bad")).collect();
            v.push(sk("ok-1", "# ok"));
            Ok(v)
        },
        SyncSkillsOpts {
            drop_tool_grants: false,
            builtins: Some(&[]),
        },
    );
    let names = |p: &Path| {
        let mut v: Vec<String> = fs::read_dir(p)
            .unwrap()
            .map(|e| e.unwrap().file_name().to_string_lossy().into_owned())
            .collect();
        v.sort();
        v
    };
    assert_eq!(names(&runner_skills_dir(&state)), vec!["ok-1"]);
    assert_eq!(names(&ws.join(".claude/skills")), vec!["ok-1"]);
    assert_eq!(names(&state), vec!["skills"]);
    assert!(is_runner_skill_slug("harkroom-artifact"));
    for s in bad {
        assert!(!is_runner_skill_slug(s), "{s}");
    }
}
