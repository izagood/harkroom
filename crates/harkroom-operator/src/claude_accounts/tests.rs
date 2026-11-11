use super::*;

fn tmpdir(tag: &str) -> PathBuf {
    let d = std::env::temp_dir().join(format!(
        "hk-c3a-{tag}-{}",
        crate::endpoint::random_hex(6).unwrap()
    ));
    fs::create_dir_all(&d).unwrap();
    d
}

#[test]
fn pool_name_grammar_matches_ts() {
    assert!(is_pool_name("work-1"));
    for bad in ["", ".", "..", "A", "a/b", "a b", &"x".repeat(33)] {
        assert!(!is_pool_name(bad), "{bad:?}");
    }
}

#[test]
fn under_rejects_grammar_and_escape() {
    let root = Path::new("/r/acc");
    assert_eq!(
        under(root, &["p", "a"]).unwrap(),
        PathBuf::from("/r/acc/p/a")
    );
    assert!(under(root, &[".."]).is_err());
    assert!(under(root, &["p/../.."]).is_err());
    assert!(under(root, &["Work"]).is_err());
}

#[test]
fn parse_drops_bad_fields_like_ts() {
    let cfg = parse_pools_config(&json!({
        "defaultPool": "BAD",
        "order": { "work": ["a", "B", "b"], "X": ["a"], "solo": "a" },
        "agents": { "ag1": "work", "ag2": ["work", "work", "x!"], "__proto__": ["work"], "ag3": [] },
        "assign": { "work": { "newSessionPct": 80, "newWeeklyPct": 0, "junk": 5 }, "p2": { "x": 1 } }
    }));
    assert_eq!(cfg.default_pool, None);
    assert_eq!(
        cfg.order.get("work").unwrap(),
        &vec!["a".to_string(), "b".to_string()]
    );
    assert_eq!(cfg.order.len(), 1);
    assert_eq!(cfg.agents.get("ag1").unwrap(), &vec!["work".to_string()]);
    assert_eq!(cfg.agents.get("ag2").unwrap(), &vec!["work".to_string()]);
    assert!(!cfg.agents.contains_key("__proto__") && !cfg.agents.contains_key("ag3"));
    assert_eq!(
        map_json(&cfg.assign),
        json!({ "work": { "newSessionPct": 80 } })
    );
}

#[test]
fn pools_path_follows_community_mode() {
    let acc = Path::new("/h/acc");
    let none = |_: &str| None;
    assert_eq!(
        pools_file_path(acc, none).unwrap(),
        PathBuf::from("/h/acc/pools.json")
    );
    let per = |k: &str| match k {
        "HARKROOM_OPERATOR_PER_COMMUNITY" => Some("1".to_string()),
        "HARKROOM_OPERATOR_ROOT" => Some("/c/root/../r2".to_string()),
        _ => None,
    };
    assert_eq!(
        pools_file_path(acc, per).unwrap(),
        PathBuf::from("/c/r2/claude-pools.json")
    );
    let bad = |k: &str| (k == "HARKROOM_OPERATOR_PER_COMMUNITY").then(|| "1".to_string());
    assert!(pools_file_path(acc, bad).is_err());
}

#[test]
fn write_is_atomic_0600_and_omits_empty_assign() {
    let d = tmpdir("w");
    let p = d.join("pools.json");
    let mut cfg = parse_pools_config(
        &json!({ "defaultPool": "work", "order": { "work": ["a"] }, "agents": {} }),
    );
    write_pools_config(&p, &cfg).unwrap();
    let text = fs::read_to_string(&p).unwrap();
    assert_eq!(
        text,
        "{\n  \"defaultPool\": \"work\",\n  \"order\": {\n    \"work\": [\n      \"a\"\n    ]\n  },\n  \"agents\": {}\n}\n"
    );
    use std::os::unix::fs::PermissionsExt;
    assert_eq!(
        fs::metadata(&p).unwrap().permissions().mode() & 0o777,
        0o600
    );
    cfg.assign.insert(
        "work".into(),
        json!({ "newSessionPct": 70 }).as_object().unwrap().clone(),
    );
    write_pools_config(&p, &cfg).unwrap();
    assert!(fs::read_to_string(&p).unwrap().contains("\"assign\""));
    assert_eq!(
        fs::read_dir(&d).unwrap().count(),
        1,
        "임시 파일이 남지 않는다"
    );
    fs::remove_dir_all(d).ok();
}

#[test]
fn layout_flat_vs_pools_with_strays_and_symlinks() {
    let d = tmpdir("l");
    let pp = d.join("pools.json");
    fs::create_dir_all(d.join("a1")).unwrap();
    fs::create_dir_all(d.join("Bad")).unwrap();
    let flat = read_layout(&d, &pp);
    assert!(!flat.pools_mode);
    assert_eq!(flat.pools.len(), 1);
    assert_eq!(flat.pools[0].0, "");
    assert_eq!(flat.pools[0].1[0].name, "a1");

    fs::write(d.join("a1/.claude.json"), "{}").unwrap();
    fs::create_dir_all(d.join("work/x")).unwrap();
    fs::create_dir_all(d.join("empty")).unwrap();
    let other = tmpdir("l-target");
    std::os::unix::fs::symlink(&other, d.join("work/y")).unwrap();
    fs::write(&pp, "{\"defaultPool\":\"work\",\"order\":{},\"agents\":{}}").unwrap();
    let l = read_layout(&d, &pp);
    assert!(l.pools_mode);
    assert_eq!(l.strays, vec!["a1".to_string()]);
    let names: Vec<_> = l.pools.iter().map(|(n, a)| (n.as_str(), a.len())).collect();
    assert_eq!(names, vec![("empty", 0), ("work", 2)]);
    fs::remove_dir_all(d).ok();
    fs::remove_dir_all(other).ok();
}

#[test]
fn reconcile_appends_and_drops_but_never_overwrites_broken() {
    let d = tmpdir("r");
    let pp = d.join("pools.json");
    fs::create_dir_all(d.join("work/a")).unwrap();
    fs::create_dir_all(d.join("work/c")).unwrap();
    fs::write(&pp, "{\"defaultPool\":\"work\",\"order\":{\"work\":[\"b\",\"a\"],\"gone\":[\"z\"]},\"agents\":{}}").unwrap();
    let (added, removed) = reconcile_order(&d, &pp).unwrap();
    assert_eq!(added, vec!["work/c".to_string()]);
    assert_eq!(removed, vec!["work/b".to_string()]);
    let cfg = read_pools_config(&pp).unwrap();
    assert_eq!(
        cfg.order.get("work").unwrap(),
        &vec!["a".to_string(), "c".to_string()]
    );
    assert_eq!(cfg.order.get("gone").unwrap(), &vec!["z".to_string()]);
    // 두 번째는 바뀐 것이 없다.
    assert_eq!(reconcile_order(&d, &pp).unwrap(), (vec![], vec![]));
    // 깨진 파일은 덮지 않는다.
    fs::write(&pp, "{broken").unwrap();
    assert_eq!(reconcile_order(&d, &pp).unwrap(), (vec![], vec![]));
    assert_eq!(fs::read_to_string(&pp).unwrap(), "{broken");
    fs::remove_dir_all(d).ok();
}

fn port(
    root: &Path,
    kc: bool,
) -> (
    ClaudeAccounts,
    std::sync::Arc<std::sync::Mutex<Vec<PathBuf>>>,
) {
    let deleted = std::sync::Arc::new(std::sync::Mutex::new(Vec::new()));
    let d2 = deleted.clone();
    let p = ClaudeAccounts::with(
        root.to_path_buf(),
        root.join("pools.json"),
        Box::new(move |_| kc),
        Box::new(move |d| d2.lock().unwrap().push(d.to_path_buf())),
        || 1_000_000.0,
    );
    (p, deleted)
}

#[test]
fn status_needs_identity_and_credential_presence() {
    let d = tmpdir("s");
    let none = |_: &Path| false;
    let yes = |_: &Path| true;
    assert_eq!(
        account_status_from_disk(&d, &yes),
        json!({ "loggedIn": false })
    );
    fs::write(
        d.join(".claude.json"),
        r#"{"oauthAccount":{"emailAddress":"e@x","organizationUuid":"o","accountUuid":"a","n":1}}"#,
    )
    .unwrap();
    assert_eq!(
        account_status_from_disk(&d, &none),
        json!({ "loggedIn": false })
    );
    assert_eq!(
        account_status_from_disk(&d, &yes),
        json!({ "loggedIn": true, "email": "e@x", "orgId": "o", "accountId": "a" })
    );
    fs::write(d.join(".credentials.json"), "{}").unwrap();
    assert_eq!(account_status_from_disk(&d, &none)["loggedIn"], json!(true));
    fs::remove_dir_all(d).ok();
}

#[test]
fn keychain_service_matches_ts_rule() {
    // node: sha256('/a/b').hex.slice(0,8)
    let d = ring::digest::digest(&ring::digest::SHA256, b"/a/b");
    let hex: String = d.as_ref().iter().map(|b| format!("{b:02x}")).collect();
    assert_eq!(
        keychain_service(Path::new("/a/b")),
        format!("Claude Code-credentials-{}", &hex[..8])
    );
}

#[test]
fn list_marks_attention_and_auth_failure_only_when_active() {
    let d = tmpdir("list");
    fs::create_dir_all(d.join("work/a")).unwrap();
    fs::create_dir_all(d.join("work/b")).unwrap();
    fs::write(
        d.join("pools.json"),
        r#"{"defaultPool":"work","order":{"work":["a"]},"agents":{"ag":["work"]}}"#,
    )
    .unwrap();
    fs::write(
        d.join("work/a/.harkroom-attention.json"),
        r#"{"kind":"gate","atMs":5}"#,
    )
    .unwrap();
    fs::write(
        d.join("work/a/.harkroom-auth.json"),
        r#"{"kind":"credential","atMs":9000000}"#,
    )
    .unwrap();
    fs::write(
        d.join("work/b/.harkroom-auth.json"),
        r#"{"kind":"credential","atMs":7}"#,
    )
    .unwrap();
    let (p, _) = port(&d, false);
    let v = p.list();
    assert_eq!(v["mode"], json!("pools"));
    assert_eq!(v["defaultPool"], json!("work"));
    assert_eq!(v["agents"], json!({ "ag": ["work"] }));
    let a = &v["pools"][0]["accounts"][0];
    assert_eq!(a["attention"], json!({ "atMs": 5 }));
    assert!(
        a.get("authFailure").is_none(),
        "미래 1분 넘은 표식은 깨진 것"
    );
    assert_eq!(
        v["pools"][0]["accounts"][1]["authFailure"],
        json!({ "atMs": 7 })
    );
    let keys: Vec<_> = v.as_object().unwrap().keys().cloned().collect();
    assert_eq!(
        keys,
        [
            "root",
            "mode",
            "defaultPool",
            "agents",
            "assign",
            "pools",
            "strays"
        ]
    );
    fs::remove_dir_all(d).ok();
}

#[test]
fn configure_rejects_dropped_names_and_keeps_assign() {
    let d = tmpdir("cfg");
    let (p, _) = port(&d, false);
    let ok = read_configure_payload(Some(&json!({
        "defaultPool": "work", "order": { "work": [] }, "agents": { "ag": "home" },
        "assign": { "work": { "newSessionPct": 70 } }
    })))
    .unwrap();
    p.configure(&ok).unwrap();
    assert!(d.join("work").is_dir() && d.join("home").is_dir());
    // assign 이 빠진 옛 UI 는 있던 assign 을 지우지 않는다.
    let old_ui = read_configure_payload(Some(
        &json!({ "defaultPool": null, "order": {}, "agents": {} }),
    ))
    .unwrap();
    p.configure(&old_ui).unwrap();
    assert!(
        !read_pools_config(&d.join("pools.json"))
            .unwrap()
            .assign
            .is_empty()
    );
    for bad in [
        json!({ "defaultPool": "BAD", "order": {}, "agents": {} }),
        json!({ "defaultPool": null, "order": { "..": [] }, "agents": {} }),
        json!({ "defaultPool": null, "order": { "w": ["a", "A"] }, "agents": {} }),
        json!({ "defaultPool": null, "order": {}, "agents": { "ag": ["w", "w"] } }),
    ] {
        let raw = read_configure_payload(Some(&bad)).unwrap();
        assert!(p.configure(&raw).is_err(), "{bad}");
    }
    assert!(!d.join("..").join("BAD").exists());
    fs::remove_dir_all(d).ok();
}

#[test]
fn configure_payload_shape_like_ts() {
    let e = |v: Value| read_configure_payload(Some(&v)).unwrap_err();
    assert_eq!(
        e(json!({ "order": {}, "agents": {} })),
        "defaultPool 이 문자열도 null 도 아니다"
    );
    assert_eq!(
        e(json!({ "defaultPool": null, "order": [], "agents": {} })),
        "order 가 객체가 아니다"
    );
    assert_eq!(
        e(json!({ "defaultPool": null, "order": { "w": [1] }, "agents": {} })),
        "order.w 가 문자열 배열이 아니다"
    );
    assert_eq!(
        e(json!({ "defaultPool": null, "order": { "__proto__": [] }, "agents": {} })),
        "order 에 쓸 수 없는 키가 있다: __proto__"
    );
    let many: Vec<String> = (0..17).map(|i| format!("p{i}")).collect();
    assert_eq!(
        e(json!({ "defaultPool": null, "order": {}, "agents": { "ag": many } })),
        "agents.ag 풀이 16개를 넘는다"
    );
    assert_eq!(
        e(json!({ "defaultPool": null, "order": {}, "agents": {}, "assign": 1 })),
        "assign 이 객체가 아니다"
    );
    assert_eq!(
        read_configure_payload(None).unwrap_err(),
        "payload 가 객체가 아니다"
    );
}

#[test]
fn remove_account_deletes_dir_keychain_and_order() {
    let d = tmpdir("rm");
    fs::create_dir_all(d.join("work/a")).unwrap();
    fs::write(
        d.join("pools.json"),
        r#"{"defaultPool":"work","order":{"work":["a","b"]},"agents":{}}"#,
    )
    .unwrap();
    let (p, deleted) = port(&d, false);
    assert!(p.remove_account("work", "..").is_err());
    assert_eq!(
        p.remove_account("work", "zz").unwrap_err(),
        "계정이 없다: work/zz"
    );
    p.remove_account("work", "a").unwrap();
    assert!(!d.join("work/a").exists());
    assert_eq!(*deleted.lock().unwrap(), vec![d.join("work/a")]);
    assert_eq!(
        read_pools_config(&d.join("pools.json")).unwrap().order["work"],
        vec!["b".to_string()]
    );
    assert_eq!(p.remove_pool("nope").unwrap_err(), "풀이 없다: nope");
    p.remove_pool("work").unwrap();
    assert!(!d.join("work").exists());
    fs::remove_dir_all(d).ok();
}

#[test]
fn move_flat_account_into_pool() {
    let d = tmpdir("mv");
    fs::create_dir_all(d.join("a")).unwrap();
    fs::write(d.join("a/.claude.json"), r#"{"oauthAccount":{}}"#).unwrap();
    fs::create_dir_all(d.join("work")).unwrap();
    fs::write(
        d.join("pools.json"),
        r#"{"defaultPool":"work","order":{"x":["a"]},"agents":{}}"#,
    )
    .unwrap();
    let (p, _) = port(&d, true);
    assert_eq!(
        p.move_account("a", "none").unwrap_err(),
        "대상 풀이 없다: none"
    );
    assert_eq!(
        p.move_account("a", "work").unwrap(),
        json!({ "loggedIn": true })
    );
    assert!(d.join("work/a/.claude.json").exists());
    let order = read_pools_config(&d.join("pools.json")).unwrap().order;
    assert_eq!(order["x"], Vec::<String>::new());
    assert_eq!(order["work"], vec!["a".to_string()]);
    fs::create_dir_all(d.join("a")).unwrap();
    assert_eq!(
        p.move_account("a", "work").unwrap_err(),
        "대상에 같은 이름이 이미 있다: work/a"
    );
    fs::remove_dir_all(d).ok();
}

#[test]
fn refs_like_ts() {
    assert_eq!(
        read_account_ref(Some(&json!({ "pool": "", "account": "a" }))).unwrap_err(),
        "pool 이 없다"
    );
    assert_eq!(
        read_account_ref(Some(&json!({ "pool": "p" }))).unwrap_err(),
        "account 가 없다"
    );
    assert_eq!(read_pool_ref(Some(&json!({}))).unwrap_err(), "pool 이 없다");
    assert_eq!(
        read_account_move(Some(&json!({ "account": "a" }))).unwrap_err(),
        "toPool 이 없다"
    );
}

#[test]
fn remove_and_move_refuse_symlinked_components() {
    let base = std::env::temp_dir().join(format!("hk-acct-sym-{}", std::process::id()));
    let _ = fs::remove_dir_all(&base);
    let root = base.join("root");
    let outside = base.join("outside");
    fs::create_dir_all(outside.join("a")).unwrap();
    fs::write(outside.join("a/keep"), "k").unwrap();
    fs::create_dir_all(&root).unwrap();
    std::os::unix::fs::symlink(&outside, root.join("p")).unwrap();
    // 글자로는 뿌리 아래다.
    assert!(under(&root, &["p", "a"]).is_ok());
    assert!(
        under_no_symlink(&root, &["p", "a"])
            .unwrap_err()
            .contains("심링크")
    );
    let acc = ClaudeAccounts::with(
        root.clone(),
        root.join("pools.json"),
        Box::new(|_| false),
        Box::new(|_| {}),
        || 0.0,
    );
    assert!(acc.remove_account("p", "a").is_err());
    assert!(acc.remove_pool("p").is_err());
    fs::create_dir_all(root.join("flat")).unwrap();
    assert!(acc.move_account("flat", "p").is_err());
    assert!(outside.join("a/keep").exists(), "뿌리 밖은 그대로여야 한다");
    assert!(root.join("flat").exists());
    let _ = fs::remove_dir_all(&base);
}
