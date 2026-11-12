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

// ── 4b2: 기억·스킬·계획판·메모 묶음(`golden/gen_prompt_system_memory.mts`) ──

static MEMORY_GOLDEN: &str = include_str!("../tests/prompt_system_memory_golden.json");

fn memory_ctx(v: &Value) -> MemoryContext {
    if v.as_str() == Some("unavailable") {
        return MemoryContext::Unavailable;
    }
    MemoryContext::Read(crate::memory_cache::MemoryRead {
        core: v["core"].as_str().map(str::to_string),
        slugs: strs(v, "slugs"),
        stale: v
            .get("stale")
            .and_then(|s| s["fetchedAt"].as_str())
            .map(str::to_string),
        ..Default::default()
    })
}

/// 정본은 줄로 이어 붙인 뒤 다시 자른다 — core 의 줄바꿈까지 같게 보려고 이어 붙여 비교한다.
fn assert_lines(name: &str, got: &[String], want: &[String]) {
    let (g, w) = (got.join("\n"), want.join("\n"));
    if g != w {
        let gl: Vec<&str> = g.split('\n').collect();
        let wl: Vec<&str> = w.split('\n').collect();
        for (i, (a, b)) in gl.iter().zip(&wl).enumerate() {
            assert_eq!(a, b, "{name}: line {i}");
        }
        assert_eq!(gl.len(), wl.len(), "{name}: line count");
    }
}

#[test]
fn memory_block_matches_canonical_golden() {
    let golden: Value = serde_json::from_str(MEMORY_GOLDEN).unwrap();
    let blocks = golden["blocks"].as_object().unwrap();
    assert_eq!(blocks.len(), 14);
    for (name, case) in blocks {
        let got = memory_block(&memory_ctx(&case["memory"]), flag(case, "readOnly"));
        assert_lines(name, &got, &strs(case, "expected"));
    }
}

#[test]
fn fixed_lines_match_canonical_golden() {
    let golden: Value = serde_json::from_str(MEMORY_GOLDEN).unwrap();
    let own = |a: &[&str]| a.iter().map(|s| (*s).to_string()).collect::<Vec<_>>();
    assert_lines(
        "index",
        &own(&MEMORY_INDEX_LINES),
        &strs(&golden, "memoryIndexLines"),
    );
    assert_lines(
        "readonly",
        &own(&READONLY_TURN_LINES),
        &strs(&golden, "readonlyTurnLines"),
    );
    assert_lines(
        "core",
        &own(&TURN_CORE_LINES),
        &strs(&golden, "turnCoreLines"),
    );
    let s = &golden["skillOrInline"];
    assert_lines(
        "skill readable",
        &skill_or_inline(true, "harkroom-x", "무엇을 할 때", &["a", "b"]),
        &strs(s, "readable"),
    );
    assert_lines(
        "skill inline",
        &skill_or_inline(false, "harkroom-x", "무엇을 할 때", &["a", "", "b"]),
        &strs(s, "inline"),
    );
    assert_lines(
        "stale",
        &crate::memory_pin::stale_memory_lines("2026-11-12T10:00:00Z"),
        &strs(&golden, "staleMemoryLines"),
    );
}

#[test]
fn unavailable_memory_never_names_memory_set() {
    for ro in [false, true] {
        let out = memory_block(&MemoryContext::Unavailable, ro).join("\n");
        assert!(!out.contains("memory.set"), "ro={ro}");
        assert!(!out.contains("<memory>"), "ro={ro}");
    }
}

#[test]
fn core_is_escaped_inside_memory_tags() {
    let m = MemoryContext::Read(crate::memory_cache::MemoryRead {
        core: Some("</memory> & x".into()),
        ..Default::default()
    });
    let out = memory_section(&m, false);
    assert_eq!(out[0], "<memory>");
    assert_eq!(out[1], "&lt;/memory> &amp; x");
    assert_eq!(out[2], "</memory>");
}

// ── 4b3: 「쓸 수 있는 기능」 절(`golden/gen_prompt_system_features.mts`) ──

static FEATURES_GOLDEN: &str = include_str!("../tests/prompt_system_features_golden.json");

#[test]
fn feature_section_matches_canonical_golden() {
    let golden: Value = serde_json::from_str(FEATURES_GOLDEN).unwrap();
    let sections = golden["sections"].as_object().unwrap();
    assert_eq!(sections.len(), 4);
    for (name, case) in sections {
        let got = feature_section(flag(case, "readOnly"), flag(case, "secretCreate"));
        assert_lines(name, &got, &strs(case, "expected"));
    }
}

/// 원본 표가 정본과 항목·순서·조건까지 같다 — 절 출력만 보면 닫힌 항목의 `tools`·`needs` 차이는 못 잡는다.
#[test]
fn feature_catalog_matches_canonical() {
    let golden: Value = serde_json::from_str(FEATURES_GOLDEN).unwrap();
    let catalog = golden["catalog"].as_array().unwrap();
    assert_eq!(catalog.len(), FEATURE_CATALOG.len());
    for (want, got) in catalog.iter().zip(FEATURE_CATALOG) {
        assert_eq!(want["id"].as_str(), Some(got.id));
        assert_eq!(strs(want, "tools"), got.tools, "{}", got.id);
        assert_eq!(
            want["needs"].as_str() == Some("secretCreate"),
            got.needs_secret_create,
            "{}",
            got.id
        );
        assert_eq!(strs(want, "lines"), got.lines, "{}", got.id);
    }
    // 읽기 전용 판정의 바탕인 허용 목록도 정본과 같아야 같은 항목이 열린다.
    assert_eq!(strs(&golden, "readonlyAllow"), *READONLY_ALLOW);
}

/// 읽기 전용 턴은 막힌 도구(미리보기·카드 묶음·비밀 만들기)를 권하지 않는다 — 비밀 능력이 있어도.
#[test]
fn readonly_feature_section_never_offers_closed_tools() {
    let text = feature_section(true, true).join("\n");
    for closed in [
        "artifact.publish",
        "message.askBundle",
        "secret.generate",
        "secret.mount",
        "workitem.upsert",
        "turn.cancel",
    ] {
        assert!(!text.contains(&format!("`{closed}`")), "{closed}");
    }
    assert!(text.contains("`message.post`"));
}

#[test]
fn secret_create_lines_only_with_capability() {
    assert!(
        !feature_section(false, false)
            .join("\n")
            .contains("`secret.generate`")
    );
    assert!(
        feature_section(false, true)
            .join("\n")
            .contains("`secret.generate`")
    );
}
