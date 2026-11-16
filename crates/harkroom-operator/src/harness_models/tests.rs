// 하네스가 받는 모델 목록 — TS `test/harnessModels.test.ts` 와 같은 칸 + hello 에 실리는지.
use super::*;
use crate::hello::{build_hello, capabilities};
use std::sync::Mutex;

fn never(_: &str, _: &[&str], _: &str) -> Option<String> {
    panic!("실행하면 안 된다")
}

#[test]
fn codex_list_only_in_priority_order() {
    let out = parse_codex_models(
        &json!({"models": [
            {"slug": "gpt-5.5", "display_name": "GPT-5.5", "visibility": "list", "priority": 12},
            {"slug": "gpt-reserve", "display_name": "GPT-Reserve", "visibility": "hide", "priority": 3},
            {"slug": "gpt-6-astra", "display_name": "GPT-6-Astra", "visibility": "list", "priority": 1},
        ]})
        .to_string(),
    );
    assert_eq!(
        out,
        Some(vec![
            json!({"id": "gpt-6-astra", "label": "GPT-6-Astra"}),
            json!({"id": "gpt-5.5", "label": "GPT-5.5"}),
        ])
    );
}

#[test]
fn codex_efforts_from_reasoning_levels_or_none() {
    let out = parse_codex_models(
        &json!({"models": [
            {"slug": "a", "visibility": "list", "priority": 1,
             "supported_reasoning_levels": [{"effort": "low", "description": "x"}, {"effort": "ultra"}]},
            {"slug": "b", "visibility": "list", "priority": 2, "supported_reasoning_levels": "weird"},
            {"slug": "c", "display_name": ""},
        ]})
        .to_string(),
    );
    assert_eq!(
        out,
        Some(vec![
            json!({"id": "a", "efforts": ["low", "ultra"]}),
            json!({"id": "b"}),
            // priority 없음은 맨 뒤, 빈 display_name 은 label 을 싣지 않는다.
            json!({"id": "c"}),
        ])
    );
}

#[test]
fn codex_bad_shape_is_unknown_not_empty() {
    assert_eq!(parse_codex_models("not json"), None);
    assert_eq!(parse_codex_models(r#"{"other":1}"#), None);
    assert_eq!(parse_codex_models(r#"{"models":[]}"#), Some(vec![]));
}

#[test]
fn opencode_keeps_provider_model_lines_once() {
    assert_eq!(
        parse_opencode_models(
            "opencode/big-pickle\nrro/openai/gpt-oss-120b\n\nWARN something\n/x\na/\na b/c\nopencode/big-pickle\n"
        ),
        vec![
            json!({"id": "opencode/big-pickle"}),
            json!({"id": "rro/openai/gpt-oss-120b"})
        ]
    );
}

#[test]
fn claude_is_aliases_without_running() {
    let out =
        list_harness_models("claude-code", Some("/usr/bin"), Path::new("/h"), &never).unwrap();
    assert_eq!(
        out.iter()
            .map(|m| m["id"].as_str().unwrap())
            .collect::<Vec<_>>(),
        ["fable", "opus", "sonnet", "haiku"]
    );
    assert_eq!(
        out[1],
        json!({"id": "opus", "label": "Opus (latest)", "efforts": ["low", "medium", "high", "xhigh", "max"]})
    );
}

#[test]
fn opencode_and_codex_use_runner_path() {
    let calls: Mutex<Vec<(String, Vec<String>, String)>> = Mutex::new(vec![]);
    let exec = |bin: &str, args: &[&str], path: &str| {
        calls.lock().unwrap().push((
            bin.into(),
            args.iter().map(|a| a.to_string()).collect(),
            path.into(),
        ));
        Some(if bin == "codex" {
            r#"{"models":[]}"#.into()
        } else {
            "a/b\n".into()
        })
    };
    assert_eq!(
        list_harness_models("opencode", Some("/usr/bin"), Path::new("/h"), &exec),
        Some(vec![json!({"id": "a/b"})])
    );
    assert_eq!(
        list_harness_models("codex", None, Path::new("/h"), &exec),
        Some(vec![])
    );
    assert_eq!(
        *calls.lock().unwrap(),
        vec![
            (
                "opencode".into(),
                vec!["models".into()],
                "/usr/bin:/h/.opencode/bin".into()
            ),
            (
                "codex".into(),
                vec!["debug".into(), "models".into()],
                "".into()
            ),
        ]
    );
}

#[test]
fn failure_and_other_harnesses_are_unknown() {
    let fail = |_: &str, _: &[&str], _: &str| None;
    assert_eq!(
        list_harness_models("codex", None, Path::new("/h"), &fail),
        None
    );
    assert_eq!(
        list_harness_models("opencode", None, Path::new("/h"), &fail),
        None
    );
    // kilo·pi·omp 는 묻지 않는다 — 다른 하네스의 목록을 그 하네스 것으로 올리지 않는다.
    for h in ["kilo", "pi", "omp"] {
        assert_eq!(
            list_harness_models(h, None, Path::new("/h"), &never),
            None,
            "{h}"
        );
    }
}

/// G5 의 목적 — hello 의 `capabilities.harnesses.<하네스>.models` 에 하네스별 목록이 실린다.
/// 설치 안 된 하네스·조회 실패한 하네스에는 칸이 없다(「모른다」 — 서버 `checkOffered` 가 막지 않는다).
#[test]
fn hello_carries_per_harness_models() {
    let mut detected = Map::new();
    for (h, installed) in [
        ("claude-code", true),
        ("codex", true),
        ("opencode", true),
        ("kilo", true),
        ("pi", false),
    ] {
        detected.insert(h.into(), json!({"installed": installed, "loggedIn": true}));
    }
    let exec = |bin: &str, _: &[&str], _: &str| match bin {
        "codex" => Some(
            json!({"models": [{"slug": "gpt-5.5", "display_name": "GPT-5.5", "visibility": "list",
                "supported_reasoning_levels": [{"effort": "high"}]}]})
            .to_string(),
        ),
        _ => None, // opencode 조회 실패
    };
    let models = measure(&detected, Some("/usr/bin"), Path::new("/h"), &exec);
    let frame = build_hello(
        capabilities(&["a1".into()], with_models(detected, &models)),
        vec![],
        vec![],
        None,
    );
    let v = serde_json::to_value(&frame).unwrap();
    let h = &v["capabilities"]["harnesses"];
    assert_eq!(
        h["codex"],
        json!({"installed": true, "loggedIn": true,
               "models": [{"id": "gpt-5.5", "label": "GPT-5.5", "efforts": ["high"]}]})
    );
    assert_eq!(h["claude-code"]["models"].as_array().unwrap().len(), 4);
    assert_eq!(h["claude-code"]["models"][0]["id"], "fable");
    for k in ["opencode", "kilo", "pi"] {
        assert!(h[k].get("models").is_none(), "{k} 에는 models 칸이 없다");
    }
    // 키 순서도 TS `{...v, models}` 와 같다.
    assert_eq!(
        h["codex"].as_object().unwrap().keys().collect::<Vec<_>>(),
        ["installed", "loggedIn", "models"]
    );
}

#[test]
fn not_installed_is_not_measured() {
    let mut detected = Map::new();
    detected.insert(
        "codex".into(),
        json!({"installed": false, "loggedIn": true}),
    );
    assert!(measure(&detected, None, Path::new("/h"), &never).is_empty());
}

#[test]
fn system_exec_reads_large_output_and_times_out() {
    // 파이프 버퍼(64KiB)보다 큰 출력도 막히지 않는다.
    let out = system_exec(
        "/bin/sh",
        &["-c", "head -c 200000 /dev/zero | tr '\\0' a"],
        "/usr/bin:/bin",
        Duration::from_secs(10),
    )
    .unwrap();
    assert_eq!(out.len(), 200_000);
    assert_eq!(
        system_exec(
            "/bin/sh",
            &["-c", "exit 3"],
            "/usr/bin:/bin",
            Duration::from_secs(5)
        ),
        None
    );
    let t = Instant::now();
    assert_eq!(
        system_exec(
            "/bin/sh",
            &["-c", "sleep 5"],
            "/usr/bin:/bin",
            Duration::from_millis(200)
        ),
        None
    );
    assert!(t.elapsed() < Duration::from_secs(3));
    assert_eq!(
        system_exec("/no/such/bin", &[], "", Duration::from_secs(1)),
        None
    );
}
