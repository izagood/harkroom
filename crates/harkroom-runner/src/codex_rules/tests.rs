//! 정본 `packages/agent/test/codexRules.test.ts` 와 shared `providerLane.test.ts` 의 `codexRulesFile` 경우를 옮긴 것.
//! 턴 argv(`buildTurnCommand` codex 갈래)는 B3d 몫이다.
use super::*;
use std::cell::RefCell;
use std::os::unix::fs::PermissionsExt;
use std::sync::atomic::{AtomicU64, Ordering};

const RULE: &str = "Bash(gh pr list -R cli/cli --limit 3)";
const OTHER: &str = "Bash(kubectl get pods)";
const BIN: &str = "/opt/harkroom/harkroom-operator";

struct Tmp(PathBuf);
impl Drop for Tmp {
    fn drop(&mut self) {
        let _ = fs::remove_dir_all(&self.0);
    }
}
fn tmpdir() -> Tmp {
    static N: AtomicU64 = AtomicU64::new(0);
    let d = std::env::temp_dir().join(format!(
        "hk-codex-rules-{}-{}",
        std::process::id(),
        N.fetch_add(1, Ordering::SeqCst)
    ));
    let _ = fs::remove_dir_all(&d);
    fs::create_dir_all(&d).unwrap();
    Tmp(fs::canonicalize(&d).unwrap())
}

struct Fx {
    _t: Tmp,
    root: PathBuf,
    home: PathBuf,
    work: PathBuf,
}
fn fx() -> Fx {
    let t = tmpdir();
    let root = t.0.clone();
    let home = root.join("codex-home");
    let work = root.join("work");
    fs::create_dir_all(&home).unwrap();
    fs::create_dir_all(&work).unwrap();
    Fx {
        _t: t,
        root,
        home,
        work,
    }
}

/// codex `hooks/list` 흉내 — config 에 적힌 hash 가 지금 hash 와 같으면 trusted.
struct Fake {
    hash: &'static str,
    version: Option<&'static str>,
    roots: Option<Vec<PathBuf>>,
    calls: RefCell<u32>,
    broken: bool,
    status: Option<&'static str>,
}
fn fake() -> Fake {
    Fake {
        hash: "sha256:abc",
        version: Some("codex-cli 0.154.0"),
        roots: None,
        calls: RefCell::new(0),
        broken: false,
        status: None,
    }
}
impl CodexRulesDeps for Fake {
    fn version(&self) -> Option<String> {
        self.version.map(str::to_string)
    }
    fn list_hooks(&self, h: &Path, _cwd: &Path) -> Result<Vec<CodexHookListEntry>, ListHooksError> {
        *self.calls.borrow_mut() += 1;
        if self.broken {
            return Ok(vec![]);
        }
        if fs::read_to_string(codex_hooks_path(h)).is_err() {
            return Ok(vec![]);
        }
        let config = fs::read_to_string(h.join("config.toml")).unwrap_or_default();
        let src = codex_hooks_path(h).to_string_lossy().into_owned();
        let key = format!("{src}:pre_tool_use:0:0");
        let trusted = config.contains(&format!("[hooks.state.{}]", json_str(&key)))
            && config.contains(&format!("trusted_hash = {}", json_str(self.hash)));
        let status = self
            .status
            .unwrap_or(if trusted { "trusted" } else { "untrusted" });
        Ok(vec![CodexHookListEntry {
            key,
            source_path: src,
            event_name: "preToolUse".into(),
            command: None,
            current_hash: self.hash.into(),
            trust_status: status.into(),
        }])
    }
    fn writable_roots(&self, ws: &Path) -> Vec<PathBuf> {
        self.roots.clone().unwrap_or_else(|| vec![ws.to_path_buf()])
    }
}

fn s(v: &[&str]) -> Vec<String> {
    v.iter().map(|x| x.to_string()).collect()
}

fn prepare(
    f: &Fx,
    deps: &Fake,
    reach: Option<&[String]>,
    rules: &[String],
) -> Result<BTreeMap<String, String>, CodexRulesError> {
    prepare_codex_rules(
        &PrepareCodexRules {
            codex_home: &f.home,
            workspace_dir: &f.work,
            operator_bin: BIN,
            rules,
            reach,
        },
        deps,
    )
}

fn decode(v: &str) -> Value {
    serde_json::from_slice(&URL_SAFE_NO_PAD.decode(v).unwrap()).unwrap()
}

fn prefix_lines(text: &str) -> Vec<&str> {
    text.lines()
        .filter(|l| l.starts_with("prefix_rule"))
        .collect()
}

#[test]
fn prepare_writes_hook_trust_then_rules_and_env() {
    let f = fx();
    let d = fake();
    let reach = s(&[RULE, OTHER]);
    let env = prepare(&f, &d, Some(&reach), &s(&[RULE])).unwrap();
    assert_eq!(*d.calls.borrow(), 2);
    let rules = fs::read_to_string(codex_rules_path(&f.home)).unwrap();
    assert_eq!(
        prefix_lines(&rules),
        vec![
            r#"prefix_rule(pattern = ["gh", "pr", "list", "-R", "cli/cli", "--limit", "3"], decision = "allow")"#,
            r#"prefix_rule(pattern = ["kubectl", "get", "pods"], decision = "allow")"#,
        ]
    );
    assert!(
        fs::read_to_string(f.home.join("config.toml"))
            .unwrap()
            .contains(r#"trusted_hash = "sha256:abc""#)
    );
    assert_eq!(
        decode(&env[CODEX_HOOK_SPEC_ENV]),
        json!({ "rules": [RULE], "reach": [RULE, OTHER], "codexHome": f.home.to_string_lossy() })
    );
    for p in [codex_rules_path(&f.home), codex_hooks_path(&f.home)] {
        assert_eq!(
            fs::metadata(&p).unwrap().permissions().mode() & 0o777,
            0o600
        );
    }
    assert_eq!(
        fs::metadata(f.home.join("rules"))
            .unwrap()
            .permissions()
            .mode()
            & 0o777,
        0o700
    );
    // 두 번째 턴은 이미 trusted — 한 번만 묻고 config 를 다시 쓰지 않는다.
    let before = fs::metadata(f.home.join("config.toml"))
        .unwrap()
        .modified()
        .unwrap();
    *d.calls.borrow_mut() = 0;
    prepare(&f, &d, Some(&reach), &s(&[RULE])).unwrap();
    assert_eq!(*d.calls.borrow(), 1);
    assert_eq!(
        fs::metadata(f.home.join("config.toml"))
            .unwrap()
            .modified()
            .unwrap(),
        before
    );
}

#[test]
fn untrusted_hook_fails_closed_and_removes_rules() {
    let f = fx();
    let reach = s(&[RULE, OTHER]);
    prepare(&f, &fake(), Some(&reach), &s(&[RULE])).unwrap();
    let broken = Fake {
        broken: true,
        ..fake()
    };
    let e = prepare(&f, &broken, Some(&reach), &s(&[RULE])).unwrap_err();
    assert!(matches!(e, CodexRulesError::HookUntrusted));
    assert_eq!(e.code(), "codex_hook_untrusted");
    assert!(!codex_rules_path(&f.home).exists());
    let modified = Fake {
        status: Some("modified"),
        ..fake()
    };
    assert!(matches!(
        prepare(&f, &modified, Some(&reach), &s(&[RULE])),
        Err(CodexRulesError::HookUntrusted)
    ));
    assert!(!codex_rules_path(&f.home).exists());
}

#[test]
fn unmeasured_version_writes_nothing_and_removes_leftover() {
    let f = fx();
    let reach = s(&[RULE, OTHER]);
    prepare(&f, &fake(), Some(&reach), &s(&[RULE])).unwrap();
    for v in [Some("codex-cli 0.155.0"), None, Some("codex 0.154.0")] {
        fs::write(
            codex_rules_path(&f.home),
            "prefix_rule(pattern = [\"ls\"], decision = \"allow\")\n",
        )
        .unwrap();
        let d = Fake {
            version: v,
            ..fake()
        };
        assert!(
            prepare(&f, &d, Some(&reach), &s(&[RULE]))
                .unwrap()
                .is_empty()
        );
        assert!(!codex_rules_path(&f.home).exists(), "{v:?}");
    }
}

#[test]
fn old_server_or_home_inside_writable_writes_nothing() {
    let f = fx();
    assert!(prepare(&f, &fake(), None, &s(&[RULE])).unwrap().is_empty());
    assert!(!codex_rules_path(&f.home).exists());
    let inside = Fake {
        roots: Some(vec![f.root.clone()]),
        ..fake()
    };
    let reach = s(&[RULE]);
    assert!(
        prepare(&f, &inside, Some(&reach), &s(&[RULE]))
            .unwrap()
            .is_empty()
    );
    assert!(!codex_rules_path(&f.home).exists());
    assert!(!codex_hooks_path(&f.home).exists());
}

#[test]
fn sweep_removes_only_outside_measured_version() {
    let f = fx();
    fs::create_dir_all(f.home.join("rules")).unwrap();
    for (v, kept) in [
        (Some("codex-cli 0.154.0"), true),
        (Some("codex-cli 0.155.0"), false),
        (None, false),
    ] {
        fs::write(
            codex_rules_path(&f.home),
            "prefix_rule(pattern = [\"ls\"], decision = \"allow\")\n",
        )
        .unwrap();
        sweep_codex_rules(
            &f.home,
            &Fake {
                version: v,
                ..fake()
            },
        )
        .unwrap();
        assert_eq!(codex_rules_path(&f.home).exists(), kept, "{v:?}");
    }
    // 지울 것이 없어도 오류가 아니다.
    sweep_codex_rules(
        &f.home,
        &Fake {
            version: None,
            ..fake()
        },
    )
    .unwrap();
}

#[test]
fn home_outside_writable_checks_above_below_same() {
    let f = fx();
    assert!(codex_home_outside_writable(
        &f.home,
        std::slice::from_ref(&f.work)
    ));
    assert!(!codex_home_outside_writable(
        &f.home,
        std::slice::from_ref(&f.root)
    ));
    assert!(!codex_home_outside_writable(
        &f.home,
        std::slice::from_ref(&f.home)
    ));
    let sub = f.home.join("sub");
    assert!(codex_home_outside_writable(
        &f.home,
        std::slice::from_ref(&sub)
    ));
    fs::create_dir(&sub).unwrap();
    assert!(!codex_home_outside_writable(
        &f.home,
        std::slice::from_ref(&sub)
    ));
    assert!(!codex_home_outside_writable(
        &f.root.join("missing"),
        std::slice::from_ref(&f.work)
    ));
    // 마디 단위: `/x/codex-home2` 는 `/x/codex-home` 안이 아니다.
    let sib = f.root.join("codex-home2");
    fs::create_dir(&sib).unwrap();
    assert!(codex_home_outside_writable(&f.home, &[sib]));
    // 링크로 들어온 쓰기 자리도 실제 경로로 잡는다.
    let link = f.work.join("to-home");
    std::os::unix::fs::symlink(&f.home, &link).unwrap();
    assert!(!codex_home_outside_writable(&f.home, &[link]));
}

#[test]
fn hook_command_clears_env_and_reloads_only_spec_values() {
    let cmd = codex_hook_command(BIN);
    assert!(cmd.starts_with("/usr/bin/env -i "));
    assert!(cmd.contains(&format!("{CODEX_HOOK_SPEC_ENV}=\"${CODEX_HOOK_SPEC_ENV}\"")));
    for bad in ["BRIDGE", "LANE_API_KEY", "TURN_GRANT", "RUNNER"] {
        assert!(!cmd.contains(bad), "{bad}");
    }
    assert!(cmd.ends_with("hook pretool --codex || exit 2"));
    assert!(cmd.contains(r#""/opt/harkroom/harkroom-operator" hook"#));
    // 정본 JSON.stringify(…, null, 2) 와 같은 꼴.
    let j = codex_hooks_json(BIN);
    assert!(j.ends_with("}\n"));
    let v: Value = serde_json::from_str(&j).unwrap();
    assert_eq!(v["hooks"]["PreToolUse"][0]["matcher"], ".*");
    assert_eq!(v["hooks"]["PreToolUse"][0]["hooks"][0]["command"], cmd);
    assert!(j.starts_with("{\n  \"hooks\": {\n    \"PreToolUse\": [\n"));
}

#[test]
fn hook_trust_block_replaces_between_markers() {
    let key = "/h/hooks.json:pre_tool_use:0:0";
    let a = with_hook_trust(
        "[projects.\"/w\"]\ntrust_level = \"trusted\"\n",
        key,
        "sha256:1",
    )
    .unwrap();
    assert!(a.contains("[projects.\"/w\"]"));
    assert!(a.contains("\n\n# harkroom:hook-trust begin"));
    assert_eq!(with_hook_trust(&a, key, "sha256:1"), None);
    let b = with_hook_trust(&a, key, "sha256:2").unwrap();
    assert_eq!(b.matches("hooks.state").count(), 1);
    assert!(b.contains("sha256:2"));
    // 빈 글·끝 개행 없는 글.
    assert!(
        with_hook_trust("", key, "h")
            .unwrap()
            .starts_with("\n# harkroom:hook-trust begin")
    );
    assert!(
        with_hook_trust("x = 1", key, "h")
            .unwrap()
            .starts_with("x = 1\n\n# harkroom")
    );
    // 끝 표시 뒤에 개행이 없어도(손으로 고친 파일) 글자를 먹지 않고, 여러 바이트 글자에서 깨지지 않는다.
    let cut = format!("{STATE_BEGIN}\nold\n{STATE_END}é");
    let c = with_hook_trust(&cut, key, "h").unwrap();
    assert!(c.ends_with("# harkroom:hook-trust end\né"));
    // 키의 따옴표·개행은 JSON 이스케이프로 TOML 문자열 안에 남는다.
    let q = with_hook_trust("", "a\"b\nc", "h").unwrap();
    assert!(q.contains(r#"[hooks.state."a\"b\nc"]"#));
}

#[test]
fn version_line() {
    assert!(codex_rules_version_ok(Some("codex-cli 0.154.0\n")));
    assert!(!codex_rules_version_ok(Some("codex-cli 0.154.1")));
    assert!(!codex_rules_version_ok(Some("codex 0.154.0")));
    assert!(!codex_rules_version_ok(None));
}

#[test]
fn rules_file_keeps_shell_rules_only() {
    let out = codex_rules_file(&[
        "Bash(gh pr list -R cli/cli --limit 3)",
        "Bash(kubectl --context lab get:*)",
        "mcp__github__get_issue",
        "WebFetch",
    ]);
    assert_eq!(
        prefix_lines(&out),
        vec![
            r#"prefix_rule(pattern = ["gh", "pr", "list", "-R", "cli/cli", "--limit", "3"], decision = "allow")"#,
            r#"prefix_rule(pattern = ["kubectl", "--context", "lab", "get"], decision = "allow")"#,
        ]
    );
    assert!(out.starts_with("# harkroom"));
    assert!(out.ends_with('\n'));
}

#[test]
fn rules_file_drops_rules_failing_validation() {
    let out = codex_rules_file(&[
        "Bash(gh pr list; rm -rf /)",
        "Bash(echo \"x\" foo)",
        "Bash(bash -lc id)",
        "Bash(harkroom-operator merge o/r 1)",
        "Bash(*)",
        "Bash(git:*)",
        "Bash(gh pr view 1\\ 2)",
    ]);
    assert!(!out.contains("prefix_rule"));
}

#[test]
fn rules_file_collapses_spaces_and_dedups() {
    let out = codex_rules_file(&["Bash(gh  pr view 1)", "Bash(gh pr view 1)"]);
    assert_eq!(out.matches("prefix_rule").count(), 1);
    assert!(out.contains(r#"["gh", "pr", "view", "1"]"#));
}

#[test]
fn rules_file_empty_is_header_only() {
    assert_eq!(
        codex_rules_file::<&str>(&[]),
        "# harkroom: owner-approved commands (written by the runner each turn; do not edit)\n"
    );
}

#[test]
fn hook_spec_drops_malformed_rules() {
    let v = decode(&encode_codex_hook_spec(
        &["Bash(ls)", "1bad", "mcp__a__b"],
        &["Bash(ls)"],
        Path::new("/h"),
    ));
    assert_eq!(
        v,
        json!({ "rules": ["Bash(ls)", "mcp__a__b"], "reach": ["Bash(ls)"], "codexHome": "/h" })
    );
}

#[test]
fn list_hooks_spawn_failure_has_no_path_in_display() {
    let t = tmpdir();
    let e = list_codex_hooks(&ListHooksOpts {
        codex_bin: &t.0.join("no-such-codex"),
        codex_home: &t.0,
        cwd: &t.0,
        path: "/usr/bin:/bin",
        home: None,
        timeout: Duration::from_secs(2),
    })
    .unwrap_err();
    assert!(matches!(e, ListHooksError::Spawn(_)));
    assert!(!e.to_string().contains(&*t.0.to_string_lossy()));
}

/// 가짜 app-server(셸 스크립트)로 JSON-RPC 순서와 시한을 본다.
#[test]
fn list_hooks_talks_jsonrpc_and_times_out() {
    let t = tmpdir();
    let script = |name: &str, body: &str| -> PathBuf {
        let p = t.0.join(name);
        fs::write(&p, format!("#!/bin/sh\n{body}\n")).unwrap();
        fs::set_permissions(&p, fs::Permissions::from_mode(0o700)).unwrap();
        p
    };
    let ok = script(
        "codex-ok",
        r#"read a; echo 'noise'; echo '{"id":1,"result":{}}'; read b; read c
case "$c" in *'"hooks/list"'*) ;; *) exit 3;; esac
echo '{"id":2,"result":{"data":[{"hooks":[{"key":"k","sourcePath":"/h/hooks.json","eventName":"preToolUse","currentHash":"x","trustStatus":"trusted"},{"bad":1}]},{"cwd":"/w"}]}}'
sleep 5"#,
    );
    fn opts<'a>(bin: &'a Path, dir: &'a Path) -> ListHooksOpts<'a> {
        ListHooksOpts {
            codex_bin: bin,
            codex_home: dir,
            cwd: dir,
            path: "/usr/bin:/bin",
            home: None,
            timeout: Duration::from_secs(3),
        }
    }
    let got = list_codex_hooks(&opts(&ok, &t.0)).unwrap();
    assert_eq!(got.len(), 1);
    assert_eq!(got[0].key, "k");
    let err = script(
        "codex-err",
        r#"read a; echo '{"id":1}'; read b; read c; echo '{"id":2,"error":{"message":"no"}}'"#,
    );
    assert!(matches!(
        list_codex_hooks(&opts(&err, &t.0)),
        Err(ListHooksError::Failed)
    ));
    let quit = script("codex-quit", "exit 0");
    assert!(matches!(
        list_codex_hooks(&opts(&quit, &t.0)),
        Err(ListHooksError::Exited)
    ));
    let slow = script("codex-slow", "sleep 10");
    let start = Instant::now();
    let mut o = opts(&slow, &t.0);
    o.timeout = Duration::from_millis(300);
    assert!(matches!(
        list_codex_hooks(&o),
        Err(ListHooksError::TimedOut)
    ));
    assert!(start.elapsed() < Duration::from_secs(5));
}
