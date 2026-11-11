//! TS `packages/operator/test/codexHook.test.ts` 와 같은 사례 — 실행 위치 확인(security W1~W6)과 규칙 파일을 같은 출처로 읽는지.

use super::*;
use crate::hook_cli::LANE_HOOK_TAIL_REASON;
use serde_json::json;
use std::os::unix::fs::symlink;

const APPROVED: &str = "Bash(gh pr list -R cli/cli --limit 3)";
const CMD: &str = "gh pr list -R cli/cli --limit 3";

struct Fx {
    root: PathBuf,
    home: PathBuf,
    cwd: PathBuf,
    other: PathBuf,
    transcript: PathBuf,
}

impl Drop for Fx {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir_all(&self.root);
    }
}

fn fx(tag: &str) -> Fx {
    let root = std::env::temp_dir().join(format!("hkr-codex-{tag}-{}", std::process::id()));
    let _ = std::fs::remove_dir_all(&root);
    let home = root.join("codex-home");
    let cwd = root.join("work");
    let other = root.join("elsewhere");
    std::fs::create_dir_all(home.join("sessions")).unwrap();
    std::fs::create_dir_all(home.join("rules")).unwrap();
    std::fs::create_dir_all(&cwd).unwrap();
    std::fs::create_dir_all(&other).unwrap();
    let transcript = home.join("sessions").join("rollout-x.jsonl");
    Fx {
        root,
        home,
        cwd,
        other,
        transcript,
    }
}

/// codex 0.154 대화 기록의 function_call 줄(실측 꼴).
fn call_line(id: &str, args: Value) -> String {
    json!({ "timestamp": "t", "type": "response_item", "payload": { "type": "function_call", "id": "fc", "name": "exec_command", "arguments": args.to_string(), "call_id": id } }).to_string()
}
fn output_line(id: &str, output: &str) -> String {
    json!({ "timestamp": "t", "type": "response_item", "payload": { "type": "function_call_output", "call_id": id, "output": output } }).to_string()
}

impl Fx {
    fn input(&self) -> Value {
        json!({ "tool_name": "Bash", "tool_input": { "command": CMD }, "tool_use_id": "call_7", "cwd": self.cwd, "transcript_path": self.transcript })
    }
    fn with(&self, k: &str, v: Value) -> Value {
        let mut i = self.input();
        if v.is_null() {
            i.as_object_mut().unwrap().remove(k);
        } else {
            i[k] = v;
        }
        i
    }
    fn write(&self, lines: &[String]) {
        std::fs::write(&self.transcript, format!("{}\n", lines.join("\n"))).unwrap();
    }
    fn check(&self, input: &Value) -> Option<Value> {
        check_codex_workdir(
            input,
            CMD,
            self.home.to_str().unwrap(),
            CODEX_TRANSCRIPT_TAIL_BYTES,
        )
    }
    fn spec(&self) -> CodexHookSpec {
        CodexHookSpec {
            rules: vec![APPROVED.into()],
            reach: vec![APPROVED.into()],
            codex_home: self.home.to_string_lossy().into_owned(),
        }
    }
}

fn reason(d: &Option<Value>) -> &str {
    d.as_ref().unwrap()["hookSpecificOutput"]["permissionDecisionReason"]
        .as_str()
        .unwrap()
}

#[test]
fn workdir_other_folder_denied() {
    let f = fx("w1");
    f.write(&[call_line(
        "call_7",
        json!({ "cmd": CMD, "workdir": f.other }),
    )]);
    assert_eq!(reason(&f.check(&f.input())), CODEX_HOOK_WORKDIR_REASON);
}

#[test]
fn workdir_absent_or_same_passes() {
    let f = fx("w2");
    f.write(&[call_line("call_7", json!({ "cmd": CMD }))]);
    assert!(f.check(&f.input()).is_none());
    f.write(&[call_line("call_7", json!({ "cmd": CMD, "workdir": f.cwd }))]);
    assert!(f.check(&f.input()).is_none());
    f.write(&[call_line("call_7", json!({ "cmd": CMD, "workdir": "." }))]);
    assert!(f.check(&f.input()).is_none());
    f.write(&[call_line("call_7", json!({ "cmd": CMD, "workdir": null }))]);
    assert!(f.check(&f.input()).is_none());
    // 빈 글자·문자열 아닌 값은 막는다.
    f.write(&[call_line("call_7", json!({ "cmd": CMD, "workdir": "" }))]);
    assert!(f.check(&f.input()).is_some());
    f.write(&[call_line("call_7", json!({ "cmd": CMD, "workdir": 3 }))]);
    assert!(f.check(&f.input()).is_some());
}

#[test]
fn workdir_relative_and_symlink_use_real_path() {
    let f = fx("w3");
    f.write(&[call_line(
        "call_7",
        json!({ "cmd": CMD, "workdir": "../elsewhere" }),
    )]);
    assert!(f.check(&f.input()).is_some());
    symlink(&f.other, f.cwd.join("link")).unwrap();
    f.write(&[call_line(
        "call_7",
        json!({ "cmd": CMD, "workdir": f.cwd.join("link") }),
    )]);
    assert!(f.check(&f.input()).is_some());
    symlink(&f.cwd, f.other.join("back")).unwrap();
    f.write(&[call_line(
        "call_7",
        json!({ "cmd": CMD, "workdir": f.other.join("back") }),
    )]);
    assert!(f.check(&f.input()).is_none());
    f.write(&[call_line(
        "call_7",
        json!({ "cmd": CMD, "workdir": f.root.join("missing") }),
    )]);
    assert!(f.check(&f.input()).is_some());
    // `../work` 는 글자로도 실제로도 작업 폴더다.
    f.write(&[call_line(
        "call_7",
        json!({ "cmd": CMD, "workdir": "../work" }),
    )]);
    assert!(f.check(&f.input()).is_none());
}

/// TS 보다 좁은 곳 — `link/..` 는 글자로 접으면 작업 폴더지만 실제로 따라가면 `link` 가 가리키는 곳의 부모다. 둘 다 맞아야 통과.
#[test]
fn workdir_lexical_and_physical_must_agree() {
    let f = fx("w3b");
    let deep = f.other.join("deep");
    std::fs::create_dir_all(&deep).unwrap();
    symlink(&deep, f.cwd.join("link")).unwrap();
    f.write(&[call_line(
        "call_7",
        json!({ "cmd": CMD, "workdir": "link/.." }),
    )]);
    assert!(f.check(&f.input()).is_some());
}

#[test]
fn call_id_missing_or_not_single_or_cmd_differs_denied() {
    let f = fx("w4");
    f.write(&[call_line("call_7", json!({ "cmd": CMD }))]);
    assert!(f.check(&f.with("tool_use_id", Value::Null)).is_some());
    assert!(f.check(&f.with("tool_use_id", json!(""))).is_some());
    assert!(f.check(&f.with("tool_use_id", json!("call_8"))).is_some());
    f.write(&[
        call_line("call_7", json!({ "cmd": CMD })),
        call_line("call_7", json!({ "cmd": CMD, "workdir": f.other })),
    ]);
    assert!(f.check(&f.input()).is_some());
    f.write(&[call_line(
        "call_7",
        json!({ "cmd": "gh pr list -R cli/cli --limit 4" }),
    )]);
    assert!(f.check(&f.input()).is_some());
    // 앞뒤 공백만 다른 명령은 같다(TS `trim`).
    f.write(&[call_line("call_7", json!({ "cmd": format!("  {CMD}\n") }))]);
    assert!(f.check(&f.input()).is_none());
    // cwd 가 상대 경로면 막는다.
    f.write(&[call_line("call_7", json!({ "cmd": CMD }))]);
    assert!(f.check(&f.with("cwd", json!("work"))).is_some());
}

#[test]
fn call_with_output_already_denied() {
    let f = fx("w5");
    f.write(&[
        call_line("call_7", json!({ "cmd": CMD })),
        output_line("call_7", "done"),
    ]);
    assert!(f.check(&f.input()).is_some());
}

#[test]
fn fake_line_inside_output_not_counted() {
    let f = fx("w6");
    let fake = call_line("call_7", json!({ "cmd": CMD }));
    f.write(&[
        output_line("call_6", &fake),
        call_line("call_7", json!({ "cmd": CMD, "workdir": f.other })),
    ]);
    assert!(f.check(&f.input()).is_some());
    f.write(&[output_line("call_6", &fake)]);
    assert!(f.check(&f.input()).is_some());
}

#[test]
fn bad_arguments_denied() {
    let f = fx("w7");
    let line = |args: Value| {
        json!({ "type": "response_item", "payload": { "type": "function_call", "arguments": args, "call_id": "call_7" } })
            .to_string()
    };
    for a in [
        json!({ "cmd": CMD }),
        json!("not json"),
        json!("[1]"),
        json!("null"),
    ] {
        f.write(&[line(a)]);
        assert!(f.check(&f.input()).is_some());
    }
}

#[test]
fn transcript_missing_or_outside_home_denied() {
    let f = fx("w8");
    assert!(f.check(&f.input()).is_some());
    let outside = f.cwd.join("rollout-x.jsonl");
    std::fs::write(
        &outside,
        format!("{}\n", call_line("call_7", json!({ "cmd": CMD }))),
    )
    .unwrap();
    assert!(
        f.check(&f.with("transcript_path", json!(outside)))
            .is_some()
    );
    let linked = f.home.join("sessions").join("linked.jsonl");
    symlink(&outside, &linked).unwrap();
    assert!(f.check(&f.with("transcript_path", json!(linked))).is_some());
    // 홈 그 자체도 막는다.
    assert!(f.check(&f.with("transcript_path", json!(f.home))).is_some());
}

#[test]
fn reads_only_the_tail() {
    let f = fx("w9");
    f.write(&[call_line("call_7", json!({ "cmd": CMD })), "x".repeat(4096)]);
    let home = f.home.to_str().unwrap();
    assert!(check_codex_workdir(&f.input(), CMD, home, 1024).is_some());
    assert!(check_codex_workdir(&f.input(), CMD, home, 64 * 1024).is_none());
}

#[test]
fn decide_outside_rules_not_judged() {
    let f = fx("d1");
    let i = f.with("tool_input", json!({ "command": "ls -la" }));
    assert!(decide_codex_hook(&i.to_string(), &f.spec()).is_none());
    let mut m = f.with("tool_input", json!({}));
    m["tool_name"] = json!("mcp__harkroom__message_post");
    assert!(decide_codex_hook(&m.to_string(), &f.spec()).is_none());
}

#[test]
fn decide_checks_workdir_only_for_approved() {
    let f = fx("d2");
    f.write(&[call_line(
        "call_7",
        json!({ "cmd": CMD, "workdir": f.other }),
    )]);
    assert!(decide_codex_hook(&f.input().to_string(), &f.spec()).is_some());
    f.write(&[call_line("call_7", json!({ "cmd": CMD }))]);
    assert!(decide_codex_hook(&f.input().to_string(), &f.spec()).is_none());
}

#[test]
fn decide_reach_includes_rules_file_now() {
    let f = fx("d3");
    std::fs::write(
        f.home.join("rules").join("harkroom.rules"),
        "# harkroom: owner-approved commands (written by the runner each turn; do not edit)\nprefix_rule(pattern = [\"kubectl\", \"get\", \"pods\"], decision = \"allow\")\n",
    )
    .unwrap();
    let raw = f
        .with("tool_input", json!({ "command": "kubectl get pods -A" }))
        .to_string();
    assert_eq!(
        reason(&decide_codex_hook(&raw, &f.spec())),
        LANE_HOOK_TAIL_REASON
    );
    let mut s = f.spec();
    s.codex_home = f.root.join("no-home").to_string_lossy().into_owned();
    assert!(decide_codex_hook(&raw, &s).is_none());
}

#[test]
fn decide_bad_rules_file_blocks_shell() {
    let f = fx("d4");
    std::fs::write(
        f.home.join("rules").join("harkroom.rules"),
        "prefix_rule(pattern = [\"ls\"], decision = \"prompt\")\n",
    )
    .unwrap();
    let raw = f.with("tool_input", json!({ "command": "ls" })).to_string();
    assert!(decide_codex_hook(&raw, &f.spec()).is_some());
    // 규칙 파일 자리가 폴더라 못 읽어도 막는다.
    let g = fx("d4b");
    std::fs::create_dir_all(g.home.join("rules").join("harkroom.rules")).unwrap();
    assert!(decide_codex_hook(&raw, &g.spec()).is_some());
}

#[test]
fn decide_bad_input_blocks() {
    let f = fx("d5");
    assert!(decide_codex_hook("not json", &f.spec()).is_some());
    assert!(decide_codex_hook("null", &f.spec()).is_some());
}

#[test]
fn rules_file_roundtrip() {
    // TS `codexRulesFile([APPROVED, 'Bash(kubectl get:*)', 'mcp__harkroom'])` 의 출력.
    let text = "# harkroom: owner-approved commands (written by the runner each turn; do not edit)\nprefix_rule(pattern = [\"gh\", \"pr\", \"list\", \"-R\", \"cli/cli\", \"--limit\", \"3\"], decision = \"allow\")\nprefix_rule(pattern = [\"kubectl\", \"get\"], decision = \"allow\")\n";
    assert_eq!(
        parse_codex_rules_file(text),
        Some(vec![APPROVED.to_string(), "Bash(kubectl get)".into()])
    );
    assert_eq!(
        parse_codex_rules_file(&format!(
            "{text}prefix_rule(pattern = [\"rm\"], decision = \"forbidden\")\n"
        )),
        None
    );
    assert_eq!(parse_codex_rules_file(""), Some(vec![]));
    // 빈 목록·글자 허용 목록 밖·문자열 아닌 낱말은 None.
    for bad in [
        "prefix_rule(pattern = [], decision = \"allow\")",
        "prefix_rule(pattern = [\"a b\"], decision = \"allow\")",
        "prefix_rule(pattern = [\"a\\\"\"], decision = \"allow\")",
        "prefix_rule(pattern = [1], decision = \"allow\")",
        "prefix_rule(pattern = [\"a\",\"b\"], decision = \"allow\")",
    ] {
        assert_eq!(parse_codex_rules_file(bad), None, "{bad}");
    }
}

#[test]
fn hook_spec_decode() {
    let enc = |v: Value| base64::engine::general_purpose::URL_SAFE_NO_PAD.encode(v.to_string());
    let s = CodexHookSpec {
        rules: vec![APPROVED.into()],
        reach: vec![APPROVED.into(), "Bash(ls)".into()],
        codex_home: "/h".into(),
    };
    let good = json!({ "rules": [APPROVED], "reach": [APPROVED, "Bash(ls)"], "codexHome": "/h" });
    assert_eq!(decode_codex_hook_spec(&enc(good.clone())), Some(s.clone()));
    // 덧붙임이 있어도 푼다(Node base64url).
    let padded = base64::engine::general_purpose::URL_SAFE.encode(good.to_string());
    if padded.ends_with('=') {
        // `=` 는 글자 허용 목록 밖이라 TS 처럼 막는다.
        assert_eq!(decode_codex_hook_spec(&padded), None);
    }
    assert_eq!(decode_codex_hook_spec(""), None);
    assert_eq!(decode_codex_hook_spec("!!"), None);
    let mut rel = good.clone();
    rel["codexHome"] = json!("rel");
    assert_eq!(decode_codex_hook_spec(&enc(rel)), None);
    let mut sp = good.clone();
    sp["rules"] = json!(["a b"]);
    assert_eq!(decode_codex_hook_spec(&enc(sp)), None);
    assert_eq!(decode_codex_hook_spec(&enc(json!([1]))), None);
    assert_eq!(decode_codex_hook_spec(&enc(json!(null))), None);

    let env_of = |vars: Vec<(&'static str, String)>| {
        move |k: &str| vars.iter().find(|(n, _)| *n == k).map(|(_, v)| v.clone())
    };
    assert_eq!(
        codex_spec_from_env(&env_of(vec![(CODEX_HOOK_SPEC_ENV, enc(good))])),
        Some(s)
    );
    assert_eq!(
        codex_spec_from_env(&env_of(vec![
            (CODEX_HOOK_SPEC_ENV, "!!".into()),
            ("CODEX_HOME", "/c".into())
        ])),
        None
    );
    assert_eq!(
        codex_spec_from_env(&env_of(vec![("CODEX_HOME", "/c".into())])).map(|s| s.codex_home),
        Some("/c".into())
    );
    assert_eq!(
        codex_spec_from_env(&env_of(vec![("CODEX_HOME", "c".into())])),
        None
    );
    assert_eq!(codex_spec_from_env(&env_of(vec![])), None);
}
