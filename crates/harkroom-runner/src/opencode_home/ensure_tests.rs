//! 정본 `packages/agent/test/opencodeHome.test.ts` 의 `ensureOpencodeHome`·`withConfigLock` 경우를 옮겼다.

use super::*;
use std::os::unix::fs::MetadataExt;
use std::sync::atomic::{AtomicU32, Ordering};

const A: &str = "0f8b2a4c-1d3e-4f5a-9b6c-7d8e9f0a1b2c";
const B: &str = "1a2b3c4d-5e6f-4a7b-8c9d-0e1f2a3b4c5d";

struct Fx {
    root: PathBuf,
    home: PathBuf,
    source_config: PathBuf,
    source_data: PathBuf,
    bridge: Map<String, Value>,
}

impl Drop for Fx {
    fn drop(&mut self) {
        let _ = fs::remove_dir_all(&self.root);
    }
}

fn fixture(name: &str) -> Fx {
    static N: AtomicU32 = AtomicU32::new(0);
    let root = std::env::temp_dir().join(format!(
        "hk-oc-{name}-{}-{}",
        std::process::id(),
        N.fetch_add(1, Ordering::Relaxed)
    ));
    let _ = fs::remove_dir_all(&root);
    let src = root.join("src");
    fs::create_dir_all(src.join("data")).unwrap();
    let source_config = src.join("opencode.json");
    fs::write(
        &source_config,
        r#"{ "provider": { "p": { "npm": "x" } }, "model": "p/m", "small_model": "p/s", "mcp": { "evil": {} }, // c
        }"#,
    )
    .unwrap();
    fs::write(src.join("data").join("auth.json"), "{}").unwrap();
    let bridge =
        json!({ "harkroom": { "type": "stdio", "command": "/opt/hk/op", "args": ["mcp-bridge"] } });
    Fx {
        home: root.join("home"),
        source_config,
        source_data: src.join("data"),
        root,
        bridge: bridge.as_object().unwrap().clone(),
    }
}

fn opts<'a>(
    f: &'a Fx,
    lane: Option<ProviderLane<'a>>,
    app: Option<&'a XdgApp>,
) -> EnsureOpencodeHome<'a> {
    EnsureOpencodeHome {
        opencode_home: &f.home,
        mcp_servers: &f.bridge,
        source_config: Some(&f.source_config),
        source_data: Some(&f.source_data),
        app,
        provider_lane: lane,
        env: HumanEnv {
            home: &f.root,
            xdg_config_home: None,
            xdg_data_home: None,
        },
        lock_timeout: None,
    }
}

fn cfg(f: &Fx, app: &XdgApp) -> Value {
    serde_json::from_str(&fs::read_to_string(opencode_config_file(&f.home, app)).unwrap()).unwrap()
}

fn lane<'a>(model: Option<&'a str>, channel: Option<LaneChannel<'a>>) -> Option<ProviderLane<'a>> {
    Some(ProviderLane {
        model,
        skills_dir: None,
        channel,
    })
}

#[test]
fn inherits_provider_and_model_but_not_mcp_and_writes_readonly_agent() {
    let f = fixture("inherit");
    ensure_opencode_home(&opts(&f, None, None)).unwrap();
    let c = cfg(&f, &OPENCODE_APP);
    assert_eq!(c["provider"], json!({ "p": { "npm": "x" } }));
    assert_eq!(c["model"], "p/m");
    assert_eq!(c["small_model"], "p/s");
    assert!(c["mcp"].get("evil").is_none());
    assert_eq!(c["mcp"]["harkroom"]["type"], "local");
    assert_eq!(
        c["agent"][OPENCODE_READONLY_AGENT],
        json!({ "mode": "primary", "permission": { "edit": "deny", "bash": "deny", "webfetch": "deny" }, "model": "p/m" })
    );
    assert!(
        c["agent"].get(OPENCODE_LANE_AGENT).is_none(),
        "lane 이 아닌 러너엔 lane 에이전트 없음"
    );
    let keys: Vec<_> = c.as_object().unwrap().keys().cloned().collect();
    assert_eq!(
        keys,
        [
            "$schema",
            "provider",
            "model",
            "small_model",
            "mcp",
            "agent"
        ]
    );
    assert_eq!(fs::metadata(&f.home).unwrap().mode() & 0o777, 0o700);
}

#[test]
fn links_auth_one_level_deep_and_is_idempotent() {
    let f = fixture("auth");
    ensure_opencode_home(&opts(&f, None, None)).unwrap();
    let first = fs::read_to_string(opencode_config_file(&f.home, &OPENCODE_APP)).unwrap();
    ensure_opencode_home(&opts(&f, None, None)).unwrap();
    let link = f.home.join("data/opencode/auth.json");
    assert_eq!(
        fs::read_link(&link).unwrap(),
        f.source_data.join("auth.json")
    );
    assert_eq!(
        first,
        fs::read_to_string(opencode_config_file(&f.home, &OPENCODE_APP)).unwrap()
    );
}

#[test]
fn wrong_auth_link_fails_loudly_and_runner_owned_file_is_kept() {
    let f = fixture("badlink");
    let dir = f.home.join("data/opencode");
    fs::create_dir_all(&dir).unwrap();
    std::os::unix::fs::symlink(f.root.join("elsewhere"), dir.join("auth.json")).unwrap();
    let e = ensure_opencode_home(&opts(&f, None, None)).unwrap_err();
    assert!(matches!(e, OpencodeHomeError::UnexpectedAuthLink { .. }));
    // 일반 파일(러너 전용 로그인)은 그대로 둔다.
    fs::remove_file(dir.join("auth.json")).unwrap();
    fs::write(dir.join("auth.json"), "mine").unwrap();
    ensure_opencode_home(&opts(&f, None, None)).unwrap();
    assert_eq!(fs::read_to_string(dir.join("auth.json")).unwrap(), "mine");
}

#[test]
fn no_human_config_still_starts() {
    let f = fixture("nocfg");
    let mut o = opts(&f, None, None);
    let missing = f.root.join("missing.json");
    o.source_config = Some(&missing);
    ensure_opencode_home(&o).unwrap();
    let c = cfg(&f, &OPENCODE_APP);
    assert!(c.get("provider").is_none() && c.get("model").is_none());
    assert!(c["agent"][OPENCODE_READONLY_AGENT].get("model").is_none());
}

#[test]
fn reads_user_config_files_in_order_from_xdg_config_home() {
    let f = fixture("xdg");
    let xdg = f.root.join("xdgc");
    fs::create_dir_all(xdg.join("opencode")).unwrap();
    fs::write(xdg.join("opencode/opencode.json"), r#"{ "model": "q/r", }"#).unwrap();
    let xdg_s = xdg.to_string_lossy().to_string();
    let mut o = opts(&f, None, None);
    o.source_config = None;
    o.env.xdg_config_home = Some(&xdg_s);
    ensure_opencode_home(&o).unwrap();
    assert_eq!(cfg(&f, &OPENCODE_APP)["model"], "q/r");
}

#[test]
fn kilo_and_opencode_share_a_root_without_overwriting() {
    let f = fixture("kilo");
    let kilo = crate::adapter::adapter(crate::adapter::AgentHarness::Kilo)
        .unwrap()
        .xdg_app
        .unwrap();
    ensure_opencode_home(&opts(&f, None, Some(&kilo))).unwrap();
    ensure_opencode_home(&opts(&f, None, None)).unwrap();
    assert_eq!(cfg(&f, &kilo)["$schema"], kilo.schema);
    assert_eq!(cfg(&f, &OPENCODE_APP)["$schema"], OPENCODE_APP.schema);
    assert!(f.home.join(format!("data/{}/auth.json", kilo.dir)).exists());
}

#[test]
fn lane_writes_only_lane_block_no_human_login_and_unlinks_old_link() {
    let f = fixture("lane");
    ensure_opencode_home(&opts(&f, None, None)).unwrap();
    let link = f.home.join("data/opencode/auth.json");
    assert!(
        fs::symlink_metadata(&link)
            .unwrap()
            .file_type()
            .is_symlink()
    );
    ensure_opencode_home(&opts(
        &f,
        lane(Some("ExampleOrg/example-model"), None),
        None,
    ))
    .unwrap();
    assert!(fs::symlink_metadata(&link).is_err(), "링크만 뗀다");
    assert!(
        f.source_data.join("auth.json").exists(),
        "사람 파일은 그대로"
    );
    let c = cfg(&f, &OPENCODE_APP);
    assert_eq!(
        c["enabled_providers"],
        json!([PROVIDER_LANE_OPENCODE_PROVIDER])
    );
    assert_eq!(c["model"], "harkroom-lane/ExampleOrg/example-model");
    assert!(c["provider"].get("p").is_none());
    assert!(
        c["provider"][PROVIDER_LANE_OPENCODE_PROVIDER]
            .get("options")
            .is_none()
    );
    assert_eq!(c["agent"][OPENCODE_LANE_AGENT]["mode"], "primary");
    assert_eq!(c["agent"][OPENCODE_LANE_AGENT]["permission"]["*"], "deny");
    assert!(c["agent"][OPENCODE_LANE_AGENT].get("prompt").is_none());
    let instr = f.home.join(LANE_INSTRUCTIONS_FILE);
    assert_eq!(c["instructions"], json!([instr.to_string_lossy()]));
    assert_eq!(
        fs::read_to_string(&instr).unwrap(),
        format!("{LANE_REPLY_INSTRUCTIONS}\n")
    );
    assert_eq!(
        fs::read_dir(opencode_lane_home(&f.home)).unwrap().count(),
        0
    );
}

#[test]
fn lane_models_accumulate_up_to_keep() {
    let f = fixture("models");
    let ids: Vec<String> = (0..PROVIDER_LANE_MODEL_KEEP + 2)
        .map(|i| format!("m-{i}"))
        .collect();
    for id in &ids {
        ensure_opencode_home(&opts(&f, lane(Some(id), None), None)).unwrap();
    }
    let models =
        cfg(&f, &OPENCODE_APP)["provider"][PROVIDER_LANE_OPENCODE_PROVIDER]["models"].clone();
    let got: Vec<_> = models.as_object().unwrap().keys().cloned().collect();
    assert_eq!(got, ids[2..].to_vec());
}

#[test]
fn lane_skills_open_only_runner_dir_and_allow_those_names() {
    let f = fixture("skills");
    let skills = f.root.join("skills");
    fs::create_dir_all(skills.join("s1")).unwrap();
    fs::write(skills.join("s1/SKILL.md"), "---\nname: s-one\n---\n").unwrap();
    let l = Some(ProviderLane {
        model: None,
        skills_dir: Some(&skills),
        channel: None,
    });
    ensure_opencode_home(&opts(&f, l, None)).unwrap();
    let c = cfg(&f, &OPENCODE_APP);
    assert_eq!(c["skills"], json!({ "paths": [skills.to_string_lossy()] }));
    assert_eq!(
        c["agent"][OPENCODE_LANE_AGENT]["permission"]["skill"],
        json!({ "*": "deny", "s-one": "allow" })
    );
}

#[test]
fn channel_slot_rewritten_others_kept_and_widened_dropped() {
    let f = fixture("chan");
    let a1 = vec![
        "Bash(git status)".to_string(),
        "Bash(git log -1)".to_string(),
    ];
    let a2 = vec!["Bash(git status)".to_string()];
    let b1 = vec!["Bash(git diff --stat)".to_string()];
    ensure_opencode_home(&opts(
        &f,
        lane(
            None,
            Some(LaneChannel {
                id: A,
                tool_allows: &a1,
            }),
        ),
        None,
    ))
    .unwrap();
    ensure_opencode_home(&opts(
        &f,
        lane(
            None,
            Some(LaneChannel {
                id: B,
                tool_allows: &b1,
            }),
        ),
        None,
    ))
    .unwrap();
    ensure_opencode_home(&opts(
        &f,
        lane(
            None,
            Some(LaneChannel {
                id: A,
                tool_allows: &a2,
            }),
        ),
        None,
    ))
    .unwrap();
    let c = cfg(&f, &OPENCODE_APP);
    assert_eq!(
        c["agent"][format!("harkroom-lane-{A}")]["permission"]["bash"],
        json!({ "*": "deny", "git status": "allow" })
    );
    assert_eq!(
        c["agent"][format!("harkroom-lane-{B}")]["permission"]["bash"],
        json!({ "*": "deny", "git diff --stat": "allow" })
    );
    assert_eq!(c["agent"][format!("harkroom-lane-{B}")]["mode"], "primary");
    let text = fs::read_to_string(opencode_config_file(&f.home, &OPENCODE_APP)).unwrap();
    assert!(opencode_lane_agent_matches_text(&text, A, &a2));
    // 손으로 넓힌 B 칸은 다음 쓰기에서 버린다.
    let widened = text.replace("\"git diff --stat\": \"allow\"", "\"git *\": \"allow\"");
    fs::write(opencode_config_file(&f.home, &OPENCODE_APP), widened).unwrap();
    ensure_opencode_home(&opts(&f, lane(None, None), None)).unwrap();
    assert!(
        cfg(&f, &OPENCODE_APP)["agent"]
            .get(format!("harkroom-lane-{B}"))
            .is_none()
    );
}

#[test]
fn concurrent_channel_writes_never_resurrect_revoked_rule() {
    let f = fixture("race");
    let wide = vec![
        "Bash(git status)".to_string(),
        "Bash(git log -1)".to_string(),
    ];
    let narrow = vec!["Bash(git status)".to_string()];
    for i in 0..8 {
        ensure_opencode_home(&opts(
            &f,
            lane(
                None,
                Some(LaneChannel {
                    id: A,
                    tool_allows: &wide,
                }),
            ),
            None,
        ))
        .unwrap();
        let other = vec![format!("Bash(git diff --stat {i})")];
        std::thread::scope(|s| {
            let x = s.spawn(|| {
                ensure_opencode_home(&opts(
                    &f,
                    lane(
                        None,
                        Some(LaneChannel {
                            id: A,
                            tool_allows: &narrow,
                        }),
                    ),
                    None,
                ))
            });
            let y = s.spawn(|| {
                ensure_opencode_home(&opts(
                    &f,
                    lane(
                        None,
                        Some(LaneChannel {
                            id: B,
                            tool_allows: &other,
                        }),
                    ),
                    None,
                ))
            });
            x.join().unwrap().unwrap();
            y.join().unwrap().unwrap();
        });
        let c = cfg(&f, &OPENCODE_APP);
        assert_eq!(
            c["agent"][format!("harkroom-lane-{A}")]["permission"]["bash"],
            json!({ "*": "deny", "git status": "allow" })
        );
        assert_eq!(
            c["agent"][format!("harkroom-lane-{B}")]["permission"]["bash"]
                [format!("git diff --stat {i}")],
            "allow"
        );
    }
    assert!(fs::symlink_metadata(opencode_config_lock_path(&f.home)).is_err());
}

#[test]
fn live_owner_lock_times_out_without_writing() {
    let f = fixture("held");
    fs::create_dir_all(&f.home).unwrap();
    fs::write(
        opencode_config_lock_path(&f.home),
        format!("{} {}\n", std::process::id(), now_ms()),
    )
    .unwrap();
    let allows = vec!["Bash(git status)".to_string()];
    let mut o = opts(
        &f,
        lane(
            None,
            Some(LaneChannel {
                id: A,
                tool_allows: &allows,
            }),
        ),
        None,
    );
    o.lock_timeout = Some(Duration::from_millis(100));
    assert!(matches!(
        ensure_opencode_home(&o),
        Err(OpencodeHomeError::LockTimeout)
    ));
    assert!(!opencode_config_file(&f.home, &OPENCODE_APP).exists());
}

#[test]
fn config_is_swapped_in_with_new_inode_no_tmp_left_mode_0600() {
    let f = fixture("swap");
    let o = opts(&f, lane(None, None), None);
    ensure_opencode_home(&o).unwrap();
    let file = opencode_config_file(&f.home, &OPENCODE_APP);
    let before = fs::metadata(&file).unwrap().ino();
    ensure_opencode_home(&o).unwrap();
    assert_ne!(fs::metadata(&file).unwrap().ino(), before);
    let tmps = fs::read_dir(file.parent().unwrap())
        .unwrap()
        .flatten()
        .filter(|e| e.file_name().to_string_lossy().ends_with(".tmp"))
        .count();
    assert_eq!(tmps, 0);
    assert_eq!(fs::metadata(&file).unwrap().mode() & 0o777, 0o600);
}

#[test]
fn dead_owner_or_stale_lock_is_cleared() {
    let f = fixture("stale");
    fs::create_dir_all(&f.root).unwrap();
    let lock = f.root.join(".config.lock");
    fs::write(&lock, "999999 0\n").unwrap();
    let ok = with_config_lock(&lock, Some(Duration::from_millis(200)), None, || Ok("ok")).unwrap();
    assert_eq!(ok, "ok");
    fs::write(&lock, format!("{} 0\n", std::process::id())).unwrap();
    fs::File::options()
        .write(true)
        .open(&lock)
        .unwrap()
        .set_modified(UNIX_EPOCH)
        .unwrap();
    let ok2 = with_config_lock(
        &lock,
        Some(Duration::from_millis(200)),
        Some(Duration::from_secs(1)),
        || Ok("ok2"),
    )
    .unwrap();
    assert_eq!(ok2, "ok2");
    assert!(!lock.exists());
}
