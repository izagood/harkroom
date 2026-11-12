//! `tests/prompt_system_sections_golden.json` 은 정본 `buildSystemPrompt` 를 한 절만 켜고 돌려 그 절을 잘라 낸 출력이다
//! (`golden/gen_prompt_system_sections.mts`). 정본이 바뀌면 스크립트로 다시 뽑는다.

use serde_json::Value;

use super::*;

static GOLDEN: &str = include_str!("../tests/prompt_system_sections_golden.json");

fn strs(v: &Value, key: &str) -> Vec<String> {
    v.get(key)
        .and_then(Value::as_array)
        .map(|a| {
            a.iter()
                .filter_map(|s| s.as_str().map(str::to_string))
                .collect()
        })
        .unwrap_or_default()
}

fn flag(v: &Value, key: &str) -> bool {
    v.get(key).and_then(Value::as_bool).unwrap_or(false)
}

fn render(kind: &str, input: &Value) -> Vec<String> {
    match kind {
        "merge" => {
            let repos = strs(input, "repos");
            let approved: Vec<MergeApproved> = input
                .get("approved")
                .and_then(Value::as_array)
                .map(|a| {
                    a.iter()
                        .map(|x| MergeApproved {
                            repo: x["repo"].as_str().unwrap().to_string(),
                            number: x["number"].as_u64().unwrap(),
                        })
                        .collect()
                })
                .unwrap_or_default();
            merge_section(&MergeOpts {
                operator_bin: input["operatorBin"].as_str().unwrap(),
                repos: &repos,
                approved: &approved,
            })
        }
        "permissions" => {
            let allows = strs(input, "toolAllows");
            permission_section(&PermissionOpts {
                tool_allows: &allows,
                command_hook: flag(input, "commandHook"),
                exact_shell_only: flag(input, "exactShellOnly"),
                new_posts_hook: flag(input, "newPostsHook"),
            })
        }
        "api" => {
            let connectors = strs(input, "connectors");
            let delegatable = strs(input, "delegatable");
            api_section(&ApiOpts {
                operator_bin: input["operatorBin"].as_str().unwrap(),
                connectors: &connectors,
                delegatable: &delegatable,
            })
        }
        other => panic!("unknown kind {other}"),
    }
}

#[test]
fn sections_match_canonical_golden() {
    let golden: Value = serde_json::from_str(GOLDEN).unwrap();
    let cases = golden.as_object().unwrap();
    assert_eq!(cases.len(), 9);
    for (name, case) in cases {
        let got = render(case["kind"].as_str().unwrap(), &case["input"]);
        let want = strs(case, "expected");
        assert_eq!(got.len(), want.len(), "{name}: line count");
        for (i, (g, w)) in got.iter().zip(&want).enumerate() {
            assert_eq!(g, w, "{name}: line {i}");
        }
    }
}

#[test]
fn new_posts_line_only_with_hook() {
    let none: [String; 0] = [];
    let off = permission_section(&PermissionOpts {
        tool_allows: &none,
        ..Default::default()
    });
    assert!(!off.iter().any(|l| l == NEW_POSTS_LINE));
    let on = permission_section(&PermissionOpts {
        tool_allows: &none,
        new_posts_hook: true,
        ..Default::default()
    });
    assert_eq!(on[0], NEW_POSTS_LINE);
}

#[test]
fn org_wildcard_note_only_for_owner_star() {
    let repos = vec!["o/r".to_string()];
    let out = merge_section(&MergeOpts {
        operator_bin: "bin",
        repos: &repos,
        approved: &[],
    });
    assert!(!out.iter().any(|l| l.starts_with("`owner/*`")));
    let repos = vec!["o/*".to_string()];
    let out = merge_section(&MergeOpts {
        operator_bin: "bin",
        repos: &repos,
        approved: &[],
    });
    assert!(out.iter().any(|l| l.starts_with("`owner/*`")));
}
