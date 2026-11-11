use super::*;

fn tmpdir(tag: &str) -> PathBuf {
    let d = std::env::temp_dir().join(format!(
        "hk-c3c-{tag}-{}",
        crate::endpoint::random_hex(6).unwrap()
    ));
    fs::create_dir_all(&d).unwrap();
    d
}

fn b64(v: &Value) -> String {
    base64::engine::general_purpose::URL_SAFE_NO_PAD.encode(v.to_string())
}

fn write_auth(home: &Path, body: &Value) {
    fs::create_dir_all(home).unwrap();
    fs::write(home.join("auth.json"), body.to_string()).unwrap();
}

fn chatgpt_auth(email: &str, plan: &str) -> Value {
    let claims =
        json!({ "email": email, "https://api.openai.com/auth": { "chatgpt_plan_type": plan } });
    json!({ "tokens": { "id_token": format!("h.{}.s", b64(&claims)), "access_token": "AT", "refresh_token": "RT" } })
}

fn port(root: &Path) -> CodexAccounts {
    CodexAccounts::new(
        root.to_path_buf(),
        root.join("_system"),
        root.join("active.json"),
    )
}

#[test]
fn name_grammar_and_active_parse_match_ts() {
    assert!(is_account_name("work-1"));
    for bad in ["", ".", "..", "A", "a/b", "a b", &"x".repeat(33)] {
        assert!(!is_account_name(bad), "{bad:?}");
    }
    assert_eq!(
        parse_codex_active(&json!({"active": "a"})),
        Some("a".into())
    );
    for raw in [
        json!(null),
        json!([]),
        json!({"active": null}),
        json!({"active": "../x"}),
        json!({"active": 3}),
    ] {
        assert_eq!(parse_codex_active(&raw), None, "{raw}");
    }
}

#[test]
fn under_rejects_grammar_and_escape() {
    let root = Path::new("/r/codex");
    assert_eq!(under(root, "a").unwrap(), PathBuf::from("/r/codex/a"));
    for bad in ["..", ".", "a/../..", "Work", ""] {
        assert!(under(root, bad).is_err(), "{bad:?}");
    }
}

#[test]
fn roots_follow_env_like_ts() {
    let none = |_: &str| None::<String>;
    assert_eq!(
        codex_accounts_root(none, "/h"),
        PathBuf::from("/h/.harkroom-agent/codex-accounts")
    );
    assert_eq!(
        codex_accounts_root(
            |k| (k == "HARKROOM_CODEX_ACCOUNTS_DIR").then(|| "/x/./y/../c".into()),
            "/h"
        ),
        PathBuf::from("/x/c")
    );
    assert_eq!(system_codex_home(none, "/h"), PathBuf::from("/h/.codex"));
    assert_eq!(
        system_codex_home(|k| (k == "CODEX_HOME").then(|| "/cx".into()), "/h"),
        PathBuf::from("/cx")
    );
    let root = Path::new("/h/c");
    assert_eq!(
        active_file_path(root, none).unwrap(),
        PathBuf::from("/h/c/active.json")
    );
    let per = |k: &str| match k {
        "HARKROOM_OPERATOR_PER_COMMUNITY" => Some("1".to_string()),
        "HARKROOM_OPERATOR_ROOT" => Some("/op/c1".to_string()),
        _ => None,
    };
    assert_eq!(
        active_file_path(root, per).unwrap(),
        PathBuf::from("/op/c1/codex-active.json")
    );
    let bad = |k: &str| (k == "HARKROOM_OPERATOR_PER_COMMUNITY").then(|| "1".to_string());
    assert!(active_file_path(root, bad).is_err());
}

#[test]
fn status_reads_identity_not_tokens() {
    let d = tmpdir("status");
    assert_eq!(status_from_disk(&d), json!({"loggedIn": false}));
    write_auth(&d, &chatgpt_auth("me@example.com", "pro"));
    let s = status_from_disk(&d);
    assert_eq!(s["loggedIn"], true);
    assert_eq!(s["authMode"], "chatgpt");
    assert_eq!(s["email"], "me@example.com");
    assert_eq!(s["plan"], "pro");
    assert!(s["signedInAtMs"].as_u64().unwrap() > 0);
    let text = s.to_string();
    for secret in ["AT", "RT", "id_token"] {
        assert!(!text.contains(secret), "{secret} 가 새었다: {text}");
    }
    write_auth(&d, &json!({"OPENAI_API_KEY": "sk-x"}));
    let s = status_from_disk(&d);
    assert_eq!(s["authMode"], "apikey");
    assert!(!s.to_string().contains("sk-x"));
    for broken in [json!({}), json!({"OPENAI_API_KEY": ""}), json!([1])] {
        write_auth(&d, &broken);
        assert_eq!(status_from_disk(&d), json!({"loggedIn": false}), "{broken}");
    }
    fs::write(d.join("auth.json"), "{not json").unwrap();
    assert_eq!(status_from_disk(&d), json!({"loggedIn": false}));
    // 깨진 id_token 이어도 로그인은 있다(이름표만 빠진다).
    write_auth(&d, &json!({"tokens": {"id_token": "a.!!!.c"}}));
    assert_eq!(status_from_disk(&d)["loggedIn"], true);
    assert!(status_from_disk(&d).get("email").is_none());
    fs::remove_dir_all(&d).unwrap();
}

#[test]
fn list_shows_active_only_when_logged_in() {
    let root = tmpdir("list");
    write_auth(&root.join("a"), &chatgpt_auth("a@x", "plus"));
    fs::create_dir_all(root.join("b")).unwrap();
    fs::create_dir_all(root.join("Bad")).unwrap();
    fs::write(root.join("file"), "").unwrap();
    let p = port(&root);
    let snap = p.list();
    assert_eq!(snap["active"], Value::Null);
    let names: Vec<&str> = snap["accounts"]
        .as_array()
        .unwrap()
        .iter()
        .map(|a| a["name"].as_str().unwrap())
        .collect();
    assert_eq!(names, ["a", "b"]);
    assert_eq!(snap["system"], json!({"loggedIn": false}));

    p.activate(Some("a")).unwrap();
    assert_eq!(p.list()["active"], "a");
    // 가리킨 계정이 로그인을 잃으면 화면도 시스템 기본으로 보인다(러너와 같은 판정).
    fs::remove_file(root.join("a/auth.json")).unwrap();
    assert_eq!(p.list()["active"], Value::Null);
    fs::remove_dir_all(&root).unwrap();
}

#[test]
fn activate_refuses_logged_out_and_writes_atomically() {
    let root = tmpdir("activate");
    fs::create_dir_all(root.join("b")).unwrap();
    write_auth(&root.join("a"), &chatgpt_auth("a@x", "plus"));
    let p = port(&root);
    assert!(
        p.activate(Some("b"))
            .unwrap_err()
            .contains("로그인되지 않은")
    );
    assert!(p.activate(Some("..")).is_err());
    p.activate(Some("a")).unwrap();
    let path = root.join("active.json");
    assert_eq!(
        serde_json::from_str::<Value>(&fs::read_to_string(&path).unwrap()).unwrap(),
        json!({"active": "a"})
    );
    use std::os::unix::fs::PermissionsExt;
    assert_eq!(
        fs::metadata(&path).unwrap().permissions().mode() & 0o777,
        0o600
    );
    p.activate(None).unwrap();
    assert_eq!(p.read_active(), None);
    // 임시 파일이 남지 않는다.
    let left: Vec<_> = fs::read_dir(&root)
        .unwrap()
        .filter_map(|e| e.ok())
        .map(|e| e.file_name().into_string().unwrap())
        .filter(|n| n.contains(".tmp-"))
        .collect();
    assert!(left.is_empty(), "{left:?}");
    fs::remove_dir_all(&root).unwrap();
}

#[test]
fn remove_resets_active_first_and_refuses_symlink() {
    let root = tmpdir("remove");
    write_auth(&root.join("a"), &chatgpt_auth("a@x", "plus"));
    let p = port(&root);
    p.activate(Some("a")).unwrap();
    p.remove_account("a").unwrap();
    assert!(!root.join("a").exists());
    assert_eq!(p.read_active(), None);
    assert!(p.remove_account("a").unwrap_err().contains("계정이 없다"));
    assert!(p.remove_account("..").is_err());

    // 계정 칸이 심링크면 지우지 않는다 — 뿌리 밖이 지워지면 안 된다.
    let outside = tmpdir("outside");
    fs::write(outside.join("keep"), "x").unwrap();
    std::os::unix::fs::symlink(&outside, root.join("ln")).unwrap();
    assert!(p.remove_account("ln").unwrap_err().contains("심링크"));
    assert!(outside.join("keep").exists());
    fs::remove_dir_all(&root).unwrap();
    fs::remove_dir_all(&outside).unwrap();
}

#[test]
fn payload_readers_match_ts() {
    assert_eq!(
        read_account_ref(Some(&json!({"account": "a"}))).unwrap(),
        "a"
    );
    for bad in [
        json!({}),
        json!({"account": ""}),
        json!({"account": 1}),
        json!("a"),
    ] {
        assert!(read_account_ref(Some(&bad)).is_err(), "{bad}");
    }
    assert!(read_account_ref(None).is_err());
    assert_eq!(
        read_activate(Some(&json!({"account": null}))).unwrap(),
        None
    );
    assert_eq!(
        read_activate(Some(&json!({"account": "a"}))).unwrap(),
        Some("a".into())
    );
    for bad in [
        json!({}),
        json!({"account": ""}),
        json!({"account": 3}),
        json!(null),
    ] {
        assert!(read_activate(Some(&bad)).is_err(), "{bad}");
    }
}
