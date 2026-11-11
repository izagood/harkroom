//! 하네스 능력 — TS `packages/operator/src/harnesses.ts` 이식(s21a-2).
//!
//! hello 의 `capabilities.harnesses` 로 "이 머신에 어떤 하네스가 있고 로그인돼 있나"를 올린다.
//! 판정 재료는 파일 존재 둘뿐이다: 실행 파일이 로그인 셸 PATH(또는 설치 관례 자리)에 있나(installed),
//! 자격증명 파일이 있나(loggedIn). 로그인이 **유효**한지는 모른다 — 없는 것을 있다고 하지 않는 쪽으로만 잰다.
//! 표(실행 파일·PATH 밖 자리·자격증명 자리)는 TS 와 같아야 한다 — 시험이 칸마다 대조한다.
use serde_json::{Map, Value, json};
use std::path::{Path, PathBuf};

/// 러너가 실제로 부르는 실행 파일 이름(TS `HARNESS_BINARIES`). 순서도 TS 객체 순서와 같다.
pub const HARNESS_BINARIES: [(&str, &str); 6] = [
    ("claude-code", "claude"),
    ("codex", "codex"),
    ("opencode", "opencode"),
    ("kilo", "kilo"),
    ("pi", "pi"),
    ("omp", "omp"),
];

/// TS shared `harnessFallbackBinDirs` — PATH 밖에 설치되는 자리(홈 기준).
pub fn fallback_bin_dir(harness: &str) -> Option<&'static str> {
    match harness {
        "opencode" => Some(".opencode/bin"),
        "kilo" => Some(".kilo/bin"),
        "pi" => Some(".pi/agent/bin"),
        "omp" => Some(".local/bin"),
        _ => None,
    }
}

/// 빈 값은 없는 것으로 친다(TS `env.X || 기본`).
fn env_or(env: &dyn Fn(&str) -> Option<String>, key: &str, default: PathBuf) -> PathBuf {
    match env(key) {
        Some(v) if !v.is_empty() => PathBuf::from(v),
        _ => default,
    }
}

/// TS `credentialFile`.
fn credential_file(harness: &str, env: &dyn Fn(&str) -> Option<String>, home: &Path) -> PathBuf {
    let xdg = || env_or(env, "XDG_DATA_HOME", home.join(".local").join("share"));
    match harness {
        "claude-code" => {
            env_or(env, "CLAUDE_CONFIG_DIR", home.join(".claude")).join(".credentials.json")
        }
        "codex" => env_or(env, "CODEX_HOME", home.join(".codex")).join("auth.json"),
        "opencode" => xdg().join("opencode").join("auth.json"),
        "kilo" => xdg().join("kilo").join("auth.json"),
        "pi" => {
            env_or(env, "PI_CODING_AGENT_DIR", home.join(".pi").join("agent")).join("auth.json")
        }
        // TS 와 같이 omp 도 PI_CODING_AGENT_DIR 를 본다(기본 `~/.omp/agent`).
        _ => env_or(env, "PI_CODING_AGENT_DIR", home.join(".omp").join("agent")).join("models.yml"),
    }
}

/// TS `detectHarnesses` — `{ "<harness>": { installed, loggedIn } }`.
/// `path` 는 로그인 셸 PATH — `None` 이면 PATH 로는 아무것도 installed 가 아니다.
pub fn detect_harnesses(
    path: Option<&str>,
    env: &dyn Fn(&str) -> Option<String>,
    home: &Path,
    exists: &dyn Fn(&Path) -> bool,
) -> Map<String, Value> {
    let dirs: Vec<&str> = path
        .map(|p| p.split(':').filter(|d| !d.is_empty()).collect())
        .unwrap_or_default();
    let mut out = Map::new();
    for (harness, bin) in HARNESS_BINARIES {
        let mut installed = dirs.iter().any(|d| exists(&Path::new(d).join(bin)));
        if !installed && let Some(rel) = fallback_bin_dir(harness) {
            installed = exists(&home.join(rel).join(bin));
        }
        let logged_in = exists(&credential_file(harness, env, home))
            || (harness == "pi"
                && exists(
                    &env_or(env, "PI_CODING_AGENT_DIR", home.join(".pi").join("agent"))
                        .join("models.json"),
                ));
        out.insert(
            harness.to_string(),
            json!({ "installed": installed, "loggedIn": logged_in }),
        );
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::collections::HashSet;

    fn run(path: Option<&str>, env: &[(&str, &str)], files: &[&str]) -> Value {
        let env: Vec<(String, String)> = env
            .iter()
            .map(|(k, v)| (k.to_string(), v.to_string()))
            .collect();
        let files: HashSet<PathBuf> = files.iter().map(PathBuf::from).collect();
        let get = move |k: &str| env.iter().find(|(a, _)| a == k).map(|(_, v)| v.clone());
        Value::Object(detect_harnesses(path, &get, Path::new("/h"), &|p| {
            files.contains(p)
        }))
    }

    #[test]
    fn nothing_without_path_or_files() {
        let v = run(None, &[], &[]);
        assert_eq!(v.as_object().unwrap().len(), 6);
        for (h, _) in HARNESS_BINARIES {
            assert_eq!(v[h], json!({"installed": false, "loggedIn": false}), "{h}");
        }
    }

    #[test]
    fn path_fallback_and_credentials_match_ts_table() {
        let v = run(
            Some("/usr/bin::/opt/bin"),
            &[("CODEX_HOME", "/c"), ("XDG_DATA_HOME", "")],
            &[
                "/opt/bin/claude",
                "/h/.claude/.credentials.json",
                "/c/auth.json",
                "/h/.opencode/bin/opencode",
                "/h/.local/share/opencode/auth.json",
                "/h/.kilo/bin/kilo",
                "/h/.pi/agent/models.json",
                "/h/.local/bin/omp",
                "/h/.omp/agent/models.yml",
            ],
        );
        assert_eq!(
            v["claude-code"],
            json!({"installed": true, "loggedIn": true})
        );
        assert_eq!(v["codex"], json!({"installed": false, "loggedIn": true}));
        assert_eq!(v["opencode"], json!({"installed": true, "loggedIn": true}));
        assert_eq!(v["kilo"], json!({"installed": true, "loggedIn": false}));
        assert_eq!(v["pi"], json!({"installed": false, "loggedIn": true}));
        assert_eq!(v["omp"], json!({"installed": true, "loggedIn": true}));
    }

    #[test]
    fn env_overrides_credential_dirs() {
        let v = run(
            None,
            &[("CLAUDE_CONFIG_DIR", "/cc"), ("PI_CODING_AGENT_DIR", "/p")],
            &["/cc/.credentials.json", "/p/auth.json", "/p/models.yml"],
        );
        assert_eq!(v["claude-code"]["loggedIn"], json!(true));
        assert_eq!(v["pi"]["loggedIn"], json!(true));
        assert_eq!(v["omp"]["loggedIn"], json!(true));
    }
}
