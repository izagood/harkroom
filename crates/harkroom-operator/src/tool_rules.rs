//! shared `toolRules.ts` 의 `validateToolRule`·`validateExactCommand`(판정은 `harkroom_proto::tool_rules` 로 옮겼다) 와 operator `turnCommand.ts` 의
//! `measureCommandFiles`·`looksSecret` 이식(s21b-3b). 서버·hook·오퍼레이터가 **같은 판정**을 써야 승인한 것과 열리는 것이
//! 어긋나지 않는다 — 그래서 TS 정본과의 일치는 `tests/golden/tool_rules.json`(TS 가 낸 판정)으로 고정한다.
//!
//! TS 와 다른 점(의도):
//! - 미리 보기 자르기는 UTF-16 단위로 세되, 서로게이트 쌍을 가르지 않는다(TS 는 반쪽을 실을 수 있다 — Rust String 은 못 담는다).

use std::sync::LazyLock;

use regex::Regex;
use serde::Serialize;

pub use harkroom_proto::tool_rules::*;

fn re(s: &str) -> Regex {
    Regex::new(s).expect("고정 정규식")
}

// ---------------------------------------------------------------- 파일 재기(TS measureCommandFiles)

pub const COMMAND_FILE_MAX_BYTES: u64 = 1024 * 1024;
const PREVIEW_CHARS: usize = 1024;
const PREVIEW_TOTAL_CHARS: usize = 3072;

static SECRET_CONTENT_PATTERNS: LazyLock<Vec<Regex>> = LazyLock::new(|| {
    [
        r#"(?i)kind:\s*["']?Secret(?-u:\b)"#,
        r"(?-u:\b)stringData\s*:",
        r"-----BEGIN [A-Z ]*PRIVATE KEY",
        r#"(?i)(password|passwd|pwd|token|secret|api[_-]?key|access[_-]?key|private[_-]?key|client[_-]?secret|credentials?)["']?\s*[:=]"#,
        r"(?-u:\b)AKIA[0-9A-Z]{16}(?-u:\b)",
        r"(?-u:\b)(ghp|gho|ghs|github_pat|xox[abpr]|sk-[a-z]*)[-_A-Za-z0-9]{10,}",
    ]
    .iter()
    .map(|s| re(s))
    .collect()
});

/// 내용에 비밀이 있어 보이면 미리 보기를 싣지 않는다(security F1). `\b` 는 TS 와 같은 ASCII 경계(`(?-u:\b)`) — 유니코드 경계면 `éAKIA…` 를 놓친다(골든).
pub fn looks_secret(text: &str) -> bool {
    SECRET_CONTENT_PATTERNS.iter().any(|r| r.is_match(text))
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct CommandFileDigest {
    pub path: String,
    pub sha256: String,
    pub size: u64,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub preview: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct MeasureError {
    pub code: &'static str,
    pub message: String,
    pub path: String,
}

fn hex(b: &[u8]) -> String {
    b.iter().map(|x| format!("{x:02x}")).collect()
}

/// UTF-16 단위로 `limit` 까지 — 서로게이트 쌍은 가르지 않는다.
fn utf16_prefix(s: &str, limit: usize) -> (&str, usize) {
    let mut units = 0;
    for (i, c) in s.char_indices() {
        let n = c.len_utf16();
        if units + n > limit {
            return (&s[..i], units);
        }
        units += n;
    }
    (s, units)
}

/// C2(`realpath(p) == p`·lstat 일반 파일·1MiB) + sha256. `with_preview` 면 비밀 아닌 자리에 앞부분을 싣는다(요청 카드용).
pub fn measure_command_files(
    files: &[CommandFileArg],
    with_preview: bool,
) -> Result<Vec<CommandFileDigest>, MeasureError> {
    let err = |code, message: String, path: &str| MeasureError {
        code,
        message,
        path: path.to_string(),
    };
    let too_large = || format!("files over {COMMAND_FILE_MAX_BYTES} bytes cannot be pinned");
    let mut out = Vec::new();
    let mut budget = PREVIEW_TOTAL_CHARS;
    for f in files {
        let real = std::fs::canonicalize(&f.path).map_err(|_| {
            err(
                "file_missing",
                "a file this command reads does not exist".into(),
                &f.path,
            )
        })?;
        if real.to_str() != Some(f.path.as_str()) {
            return Err(err(
                "file_link",
                "a file path goes through a symbolic link — use the real path".into(),
                &f.path,
            ));
        }
        let st = std::fs::symlink_metadata(&f.path)
            .ok()
            .filter(|m| m.is_file())
            .ok_or_else(|| {
                err(
                    "file_not_regular",
                    "only regular files can be pinned (no directories or devices)".into(),
                    &f.path,
                )
            })?;
        if st.len() > COMMAND_FILE_MAX_BYTES {
            return Err(err("file_too_large", too_large(), &f.path));
        }
        let buf = std::fs::read(&f.path).map_err(|_| {
            err(
                "file_missing",
                "a file this command reads does not exist".into(),
                &f.path,
            )
        })?;
        if buf.len() as u64 > COMMAND_FILE_MAX_BYTES {
            return Err(err("file_too_large", too_large(), &f.path));
        }
        let mut d = CommandFileDigest {
            path: f.path.clone(),
            sha256: hex(ring::digest::digest(&ring::digest::SHA256, &buf).as_ref()),
            size: buf.len() as u64,
            preview: None,
        };
        if with_preview && !f.secret && budget > 0 {
            let text = String::from_utf8_lossy(&buf);
            if !looks_secret(&text) {
                let (p, used) = utf16_prefix(&text, PREVIEW_CHARS.min(budget));
                budget -= used;
                d.preview = Some(p.to_string());
            }
        }
        out.push(d);
    }
    Ok(out)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn exact_json(v: &ExactCommandVerdict) -> serde_json::Value {
        match v {
            ExactCommandVerdict::Ok {
                command,
                warnings,
                files,
            } => {
                serde_json::json!({"ok": true, "command": command, "warnings": warnings, "files": files})
            }
            ExactCommandVerdict::Refused(c) => serde_json::json!({"ok": false, "code": c}),
        }
    }

    fn rule_json(v: &ToolRuleVerdict) -> serde_json::Value {
        match v {
            ToolRuleVerdict::Ok {
                rule,
                kind,
                warnings,
            } => serde_json::json!({
                "ok": true, "rule": rule,
                "kind": match kind { RuleKind::BashPrefix => "bash_prefix", RuleKind::BashExact => "bash_exact", RuleKind::McpTool => "mcp_tool" },
                "warnings": warnings,
            }),
            ToolRuleVerdict::Refused(c) => serde_json::json!({"ok": false, "code": c}),
        }
    }

    /// TS 정본이 낸 판정(`golden/tool_rules.json`, scripts/gen-tool-rules-golden.ts)과 한 글자도 다르지 않아야 한다.
    #[test]
    fn matches_ts_golden() {
        let raw = std::fs::read_to_string(concat!(
            env!("CARGO_MANIFEST_DIR"),
            "/golden/tool_rules.json"
        ))
        .unwrap();
        let g: serde_json::Value = serde_json::from_str(&raw).unwrap();
        let mut n = 0;
        for c in g["rules"].as_array().unwrap() {
            let got = rule_json(&validate_tool_rule(c["input"].as_str().unwrap()));
            assert_eq!(got, c["want"], "validateToolRule({})", c["input"]);
            n += 1;
        }
        for c in g["exact"].as_array().unwrap() {
            let got = exact_json(&validate_exact_command(c["input"].as_str().unwrap()));
            assert_eq!(got, c["want"], "validateExactCommand({})", c["input"]);
            n += 1;
        }
        for c in g["secret"].as_array().unwrap() {
            assert_eq!(
                looks_secret(c["input"].as_str().unwrap()),
                c["want"].as_bool().unwrap(),
                "looksSecret({})",
                c["input"]
            );
            n += 1;
        }
        assert!(n > 100, "골든 사례가 너무 적다: {n}");
    }

    #[test]
    fn measure_pins_regular_files_and_refuses_links() {
        let dir = std::fs::canonicalize(std::env::temp_dir())
            .unwrap()
            .join(format!("hk-tr-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        let a = dir.join("a.yaml");
        std::fs::write(&a, "apiVersion: v1\nkind: ConfigMap\n").unwrap();
        let s = dir.join("s.yaml");
        std::fs::write(&s, "kind: Secret\nstringData:\n  x: y\n").unwrap();
        let l = dir.join("l.yaml");
        std::os::unix::fs::symlink(&a, &l).unwrap();
        let arg = |p: &std::path::Path, secret| CommandFileArg {
            path: p.to_str().unwrap().into(),
            flag: "-f".into(),
            secret,
        };

        let d = measure_command_files(&[arg(&a, false), arg(&s, false)], true).unwrap();
        assert_eq!(d[0].size, 31);
        assert_eq!(d[0].sha256.len(), 64);
        assert_eq!(
            d[0].preview.as_deref(),
            Some("apiVersion: v1\nkind: ConfigMap\n")
        );
        assert_eq!(d[1].preview, None, "비밀 꼴이면 미리 보기 없음");
        assert_eq!(
            measure_command_files(&[arg(&a, true)], true).unwrap()[0].preview,
            None,
            "비밀 자리"
        );
        assert_eq!(
            measure_command_files(&[arg(&a, false)], false).unwrap()[0].preview,
            None,
            "match 용"
        );
        assert_eq!(
            measure_command_files(&[arg(&l, false)], false)
                .unwrap_err()
                .code,
            "file_link"
        );
        assert_eq!(
            measure_command_files(&[arg(&dir, false)], false)
                .unwrap_err()
                .code,
            "file_not_regular"
        );
        assert_eq!(
            measure_command_files(&[arg(&dir.join("nope"), false)], false)
                .unwrap_err()
                .code,
            "file_missing"
        );
        let big = dir.join("big");
        std::fs::write(&big, vec![b'a'; (COMMAND_FILE_MAX_BYTES + 1) as usize]).unwrap();
        assert_eq!(
            measure_command_files(&[arg(&big, false)], false)
                .unwrap_err()
                .code,
            "file_too_large"
        );
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn preview_budget_counts_utf16_without_splitting_pairs() {
        assert_eq!(utf16_prefix("ab😀c", 3), ("ab", 2));
        assert_eq!(utf16_prefix("ab😀c", 4), ("ab😀", 4));
    }
}
