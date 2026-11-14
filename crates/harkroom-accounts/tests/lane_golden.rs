//! 정본(TS) 골든과 같은 답 — `golden/lane.json` 은 `packages/shared/test/claudeAccountLaneGolden.test.ts` 가
//! TS `loadClaudeAccountLane`·`claudeAccountUse` 를 **실행해서** 쓴다. 여기서는 같은 입력으로 같은 디스크 모양을
//! 임시 폴더에 만들고 Rust 판을 돌려, 표본 하나라도 한 칸이 다르면 실패한다.
use std::collections::HashMap;
use std::fs;
use std::os::unix::fs::symlink;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicUsize, Ordering};

use harkroom_accounts::{claude_account_use, load_claude_account_lane};
use serde_json::{Value, json};

const AID: &str = "00000000-aaaa-4bbb-8ccc-000000000001";

fn golden() -> Value {
    let p = Path::new(env!("CARGO_MANIFEST_DIR")).join("golden/lane.json");
    serde_json::from_str(&fs::read_to_string(p).unwrap()).unwrap()
}

fn tmp_dir() -> PathBuf {
    static N: AtomicUsize = AtomicUsize::new(0);
    let d = std::env::temp_dir().join(format!(
        "hk-lane-rs-{}-{}",
        std::process::id(),
        N.fetch_add(1, Ordering::SeqCst)
    ));
    let _ = fs::remove_dir_all(&d);
    fs::create_dir_all(&d).unwrap();
    d
}

fn str_map(v: &Value) -> Vec<(String, String)> {
    v.as_object()
        .map(|m| {
            m.iter()
                .map(|(k, v)| (k.clone(), v.as_str().unwrap().to_string()))
                .collect()
        })
        .unwrap_or_default()
}

fn run(case: &Value) -> Value {
    let tmp = tmp_dir();
    let t = tmp.to_str().unwrap().to_string();
    for d in case["dirs"].as_array().into_iter().flatten() {
        fs::create_dir_all(tmp.join(d.as_str().unwrap())).unwrap();
    }
    for (p, text) in str_map(&case["files"]) {
        let at = tmp.join(&p);
        fs::create_dir_all(at.parent().unwrap()).unwrap();
        fs::write(at, text).unwrap();
    }
    for (p, target) in str_map(&case["links"]) {
        let at = tmp.join(&p);
        fs::create_dir_all(at.parent().unwrap()).unwrap();
        symlink(tmp.join(target), at).unwrap();
    }
    let root = tmp.join("accounts");
    let mut env: HashMap<String, String> = HashMap::new();
    env.insert(
        "HARKROOM_CLAUDE_ACCOUNTS_DIR".into(),
        root.to_str().unwrap().into(),
    );
    for (k, v) in str_map(&case["env"]) {
        env.insert(k, v.replace("<tmp>", &t));
    }
    let get = |k: &str| env.get(k).cloned();

    let agent_id = case["agentId"].as_str().unwrap_or(AID);
    let forced = case["forcedPool"].as_str();
    let order = env.get("HARKROOM_CLAUDE_ACCOUNTS").map(String::as_str);
    let lane = match load_claude_account_lane(&root, agent_id, forced, order, get) {
        Ok(l) => l.to_json(),
        Err(e) => json!({ "error": e }),
    };
    let used = claude_account_use(agent_id, forced, get, Path::new("/nonexistent-home"));
    let out = json!({ "lane": lane, "use": used.as_str() });
    let _ = fs::remove_dir_all(&tmp);
    serde_json::from_str(&out.to_string().replace(&t, "<tmp>")).unwrap()
}

#[test]
fn lane_matches_ts_golden() {
    let g = golden();
    let cases = g["cases"].as_array().unwrap();
    assert!(cases.len() >= 30, "골든 표본이 너무 적다: {}", cases.len());
    let mut bad = Vec::new();
    for c in cases {
        let got = run(c);
        if got != c["expected"] {
            bad.push(format!(
                "{}\n  TS:   {}\n  Rust: {}",
                c["name"], c["expected"], got
            ));
        }
    }
    assert!(bad.is_empty(), "TS 골든과 다르다:\n{}", bad.join("\n"));
}
