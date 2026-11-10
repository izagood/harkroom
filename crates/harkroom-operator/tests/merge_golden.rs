//! `golden/merge.json`(정본 TS 가 쓴다 — `packages/operator/test/mergeCliGolden.test.ts`)의 경우마다 같은 가짜 오퍼레이터
//! 소켓을 세우고 Rust 바이너리를 띄워, 찍힌 한 줄·종료 코드·소켓으로 보낸 줄이 골든과 같은지 본다.
use serde_json::Value;
use std::io::{BufRead, BufReader, Write};
use std::os::unix::net::UnixListener;
use std::process::Command;
use std::sync::{Arc, Mutex};

fn golden() -> Value {
    let p = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("golden/merge.json");
    serde_json::from_str(&std::fs::read_to_string(p).unwrap()).unwrap()
}

/// TS 시험의 `normalize` 와 같다 — 요청 id·cwd 는 실행마다 다르다.
fn normalize(mut f: Value) -> Value {
    if f["type"] == "mcp.request" {
        f["id"] = "<id>".into();
    }
    if let Some(o) = f.as_object_mut()
        && o.contains_key("cwd")
    {
        o.insert("cwd".into(), "<cwd>".into());
    }
    f
}

fn run_case(c: &Value) -> Value {
    let dir = std::env::temp_dir().join(format!(
        "hk-merge-rs-{}-{}",
        std::process::id(),
        c["name"].as_str().unwrap()
    ));
    let _ = std::fs::remove_dir_all(&dir);
    std::fs::create_dir_all(&dir).unwrap();
    let sock = dir.join("s");
    let listener = UnixListener::bind(&sock).unwrap();
    let frames = Arc::new(Mutex::new(Vec::<Value>::new()));
    let reply = c["reply"].clone();
    let seen = frames.clone();
    std::thread::spawn(move || {
        let Ok((conn, _)) = listener.accept() else {
            return;
        };
        let mut writer = conn.try_clone().unwrap();
        for line in BufReader::new(conn).lines() {
            let Ok(line) = line else { return };
            let frame: Value = serde_json::from_str(&line).unwrap();
            seen.lock().unwrap().push(frame.clone());
            if reply == "rejected" && frame["type"] == "hello" {
                let _ = writeln!(
                    writer,
                    "{}",
                    serde_json::json!({ "type": "link.rejected", "reason": "x" })
                );
                let _ = writer.shutdown(std::net::Shutdown::Both);
                return;
            }
            if frame["type"] != "mcp.request" {
                continue;
            }
            if reply == "close" {
                let _ = writer.shutdown(std::net::Shutdown::Both);
                return;
            }
            if let Some(obj) = reply.as_object() {
                let mut r = obj.clone();
                r.insert("id".into(), frame["id"].clone());
                let _ = writeln!(writer, "{}", Value::Object(r));
            }
        }
    });

    let mut cmd = Command::new(env!("CARGO_BIN_EXE_harkroom-operator-rs"));
    cmd.arg("merge")
        .args(
            c["argv"]
                .as_array()
                .unwrap()
                .iter()
                .map(|a| a.as_str().unwrap()),
        )
        .current_dir(&dir)
        .env_clear();
    cmd.env("PATH", std::env::var("PATH").unwrap_or_default());
    match c["env"].as_str().unwrap() {
        "none" => {}
        mode => {
            cmd.env("HARKROOM_OPERATOR_SOCKET", &sock)
                .env("HARKROOM_RUNNER_ID", "r1");
            if mode == "turnKey" {
                cmd.env("HARKROOM_TURN_GRANT", "tk");
            } else {
                cmd.env("HARKROOM_RUNNER_SECRET", "sec")
                    .env("HARKROOM_TURN_CAUSE", "cz");
            }
        }
    }
    let out = cmd.output().unwrap();
    let _ = std::fs::remove_dir_all(&dir);
    let frames: Vec<Value> = frames
        .lock()
        .unwrap()
        .iter()
        .take(2)
        .cloned()
        .map(normalize)
        .collect();
    serde_json::json!({
        "stdout": String::from_utf8(out.stdout).unwrap().trim(),
        "exit": out.status.code().unwrap(),
        "frames": frames,
    })
}

#[test]
fn merge_cli_matches_ts_golden() {
    let g = golden();
    let cases = g["cases"].as_array().unwrap();
    assert!(
        cases.len() >= 13,
        "골든 경우가 모자란다 — TS 시험을 UPDATE_MERGE_GOLDEN=1 로 돌렸는가"
    );
    for c in cases {
        assert_eq!(
            run_case(c),
            c["expect"],
            "경우 {} 가 TS 골든과 다르다",
            c["name"]
        );
    }
}
