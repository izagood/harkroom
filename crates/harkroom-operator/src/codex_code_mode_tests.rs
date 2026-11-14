use super::*;
use crate::codex_hook::check_codex_workdir;

const FIXTURE: &str =
    include_str!("../../../packages/shared/test/fixtures/codex-code-mode-hook.json");

/// TS `codexHook.test.ts` 와 같은 fixture — 각 경우의 기록을 codex 홈 아래에 쓰고 실행 위치 확인을 돌린다.
#[test]
fn shared_fixture_cases() {
    let doc: Value = serde_json::from_str(FIXTURE).unwrap();
    let root = std::env::temp_dir().join(format!("hk-ccm-{}", std::process::id()));
    let _ = std::fs::remove_dir_all(&root);
    let (home, cwd, other) = (root.join("codex-home"), root.join("ws"), root.join("other"));
    for d in [&home.join("sessions"), &cwd, &other] {
        std::fs::create_dir_all(d).unwrap();
    }
    let cwd_s = cwd.canonicalize().unwrap().to_string_lossy().into_owned();
    let other_s = other.canonicalize().unwrap().to_string_lossy().into_owned();
    let transcript = home.join("sessions/rollout.jsonl");
    let tr_s = transcript.to_string_lossy().into_owned();
    let fill = |v: &Value| {
        serde_json::from_str::<Value>(
            &v.to_string()
                .replace("{CWD}", &cwd_s)
                .replace("{OTHER}", &other_s)
                .replace("{TRANSCRIPT}", &tr_s),
        )
        .unwrap()
    };
    let mut seen = 0;
    for c in doc["cases"].as_array().unwrap() {
        let name = c["name"].as_str().unwrap();
        let lines: Vec<String> = c["lines"]
            .as_array()
            .unwrap()
            .iter()
            .map(|l| fill(l).to_string())
            .collect();
        std::fs::write(&transcript, lines.join("\n") + "\n").unwrap();
        let input = fill(&c["input"]);
        let cmd = input["tool_input"]["command"].as_str().unwrap().to_string();
        let got = check_codex_workdir(&input, &cmd, &home.to_string_lossy(), 1 << 20);
        let want_pass = c["expect"] == "pass";
        assert_eq!(got.is_none(), want_pass, "{name}");
        seen += 1;
    }
    assert!(seen >= 20);
    let _ = std::fs::remove_dir_all(&root);
}

#[test]
fn parser_accepts_only_the_two_forms() {
    let ok = |s: &str| parse_exec_cell(s).map(|c| c.cmd);
    assert_eq!(ok("tools.exec_command({cmd:\"a\"})").as_deref(), Some("a"));
    assert_eq!(
        ok("  await tools.exec_command( { cmd : \"a\" , } ) ;\n").as_deref(),
        Some("a")
    );
    assert_eq!(
        ok("text(await tools.exec_command({cmd:\"a\"}))").as_deref(),
        Some("a")
    );
    for bad in [
        "text(tools.exec_command({cmd:\"a\"}))",
        "awaittools.exec_command({cmd:\"a\"})",
        "tools.exec_command({cmd:\"a\"});;",
        "tools.exec_command({cmd:\"a\"}) ; x",
        "tools . exec_command({cmd:\"a\"})",
        "tools.exec_command({workdir:\"/w\"})",
        "tools.exec_command({cmd:\"a\",})x",
        "tools.exec_command({cmd:\"\\ud800\"})",
    ] {
        assert_eq!(parse_exec_cell(bad), None, "{bad}");
    }
}
