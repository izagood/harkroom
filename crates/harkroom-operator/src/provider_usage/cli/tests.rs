//! TS `packages/operator/test/cliUsage.test.ts` 대조.

use std::cell::RefCell;
use std::io::{BufRead, BufReader, Write};
use std::sync::{Arc, Mutex};

use super::*;
use crate::provider_usage::tz::parse_tzif;

// claude 2.1.283 `claude -p /usage` 실측 출력(TS 시험과 같은 글자).
const CLAUDE_OUT: &str = "You are currently using your subscription to power your Claude Code usage

Current session: 36% used · resets Sep 29 at 5:29am (Asia/Seoul)
Current week (all models): 21% used · resets Sep 30 at 6:59pm (Asia/Seoul)
Current week (Fable): 0% used · resets Sep 30 at 7pm (Asia/Seoul)

What's contributing to your limits usage?
Last 24h · 2900 requests · 52 sessions
  76% of your usage was at >150k context
";

/// 2026-09-28T17:45:00Z
const NOW: f64 = 1_790_617_500_000.0;

fn utc_ms(y: i64, mo: i64, d: i64, h: i64, mi: i64) -> f64 {
    ((days_from_civil(y, mo, d) * 86_400 + h * 3600 + mi * 60) * 1000) as f64
}

fn win(p: f64, at: Option<f64>) -> UsageWindow {
    UsageWindow {
        used_percent: p,
        resets_at_ms: at,
        window_minutes: None,
    }
}

#[test]
fn now_const_is_ts_now() {
    assert_eq!(utc_ms(2026, 9, 28, 17, 45), NOW);
}

#[test]
fn claude_text_session_weekly_and_model_weekly_with_zone() {
    let r = parse_claude_usage_text(CLAUDE_OUT, NOW).unwrap();
    assert_eq!(
        r.session,
        Some(win(36.0, Some(utc_ms(2026, 9, 28, 20, 29))))
    );
    assert_eq!(r.weekly, Some(win(21.0, Some(utc_ms(2026, 9, 30, 9, 59)))));
    assert_eq!(
        r.extra,
        Some(vec![ExtraWindow {
            label: "Fable weekly".into(),
            window: win(0.0, Some(utc_ms(2026, 9, 30, 10, 0))),
        }])
    );
    // TS `{ fetchedAtMs, ...parsed }` 와 같은 키 순서.
    let j = serde_json::to_string(&r).unwrap();
    assert!(
        j.starts_with(r#"{"fetchedAtMs":1790617500000.0,"session":"#),
        "{j}"
    );
}

#[test]
fn reset_without_date_is_today_or_tomorrow_and_year_rolls() {
    assert_eq!(
        parse_claude_reset("7pm (UTC)", NOW),
        Some(utc_ms(2026, 9, 28, 19, 0))
    );
    assert_eq!(
        parse_claude_reset("5pm (UTC)", NOW),
        Some(utc_ms(2026, 9, 29, 17, 0))
    );
    assert_eq!(
        parse_claude_reset("Jan 2 at 9am (UTC)", utc_ms(2026, 12, 30, 0, 0)),
        Some(utc_ms(2027, 1, 2, 9, 0))
    );
    assert_eq!(parse_claude_reset("whenever", NOW), None);
    assert_eq!(parse_claude_reset("7pm (Not/AZone)", NOW), None);
}

#[test]
fn reset_zone_name_cannot_escape_zoneinfo() {
    for bad in [
        "../../etc/passwd",
        "/etc/localtime",
        "Asia/../UTC",
        "a b",
        "",
    ] {
        assert_eq!(
            parse_claude_reset(&format!("7pm ({bad})"), NOW),
            None,
            "{bad}"
        );
    }
}

#[test]
fn reset_dst_zone_uses_summer_and_winter_offsets() {
    // America/Los_Angeles: 7월은 PDT(-7), 1월은 PST(-8).
    assert_eq!(
        parse_claude_reset(
            "Jul 1 at 9am (America/Los_Angeles)",
            utc_ms(2026, 6, 30, 0, 0)
        ),
        Some(utc_ms(2026, 7, 1, 16, 0))
    );
    assert_eq!(
        parse_claude_reset(
            "Jan 5 at 9am (America/Los_Angeles)",
            utc_ms(2027, 1, 1, 0, 0)
        ),
        Some(utc_ms(2027, 1, 5, 17, 0))
    );
}

#[test]
fn posix_footer_rule_beyond_last_transition() {
    // v2 TZif: 전이 0개, 형식 1개(-8h), 꼬리 규칙 PST8PDT — 규칙만으로 여름·겨울을 가른다.
    let mut b = Vec::new();
    let header = |b: &mut Vec<u8>, typecnt: u32, charcnt: u32| {
        b.extend_from_slice(b"TZif2");
        b.extend_from_slice(&[0; 15]);
        for c in [0u32, 0, 0, 0, typecnt, charcnt] {
            b.extend_from_slice(&c.to_be_bytes());
        }
    };
    let body = |b: &mut Vec<u8>| {
        b.extend_from_slice(&(-8 * 3600i32).to_be_bytes());
        b.extend_from_slice(&[0, 0]);
        b.extend_from_slice(b"PST\0");
    };
    header(&mut b, 1, 4);
    body(&mut b);
    header(&mut b, 1, 4);
    body(&mut b);
    b.extend_from_slice(b"\nPST8PDT,M3.2.0,M11.1.0\n");
    let z = parse_tzif(&b).unwrap();
    let t = |y: i64, mo: i64, d: i64, h: i64| days_from_civil(y, mo, d) * 86_400 + h * 3600;
    assert_eq!(z.offset_at(t(2040, 7, 1, 0)), -7 * 3600);
    assert_eq!(z.offset_at(t(2040, 1, 1, 0)), -8 * 3600);
    // 2040-03-11(둘째 일요일) 02:00 PST = 10:00Z 부터 여름.
    assert_eq!(z.offset_at(t(2040, 3, 11, 10) - 1), -8 * 3600);
    assert_eq!(z.offset_at(t(2040, 3, 11, 10)), -7 * 3600);
}

#[test]
fn no_usage_lines_is_none() {
    assert_eq!(parse_claude_usage_text("Please run /login", NOW), None);
}

#[test]
fn ansi_is_stripped() {
    let r = parse_claude_usage_text("\x1b[1mCurrent session: 5% used\x1b[0m\r\n", NOW).unwrap();
    assert_eq!(r.session, Some(win(5.0, None)));
    assert_eq!(r.weekly, None);
}

type Seen = Option<(Vec<String>, Vec<(String, String)>)>;

struct FakeRun {
    seen: RefCell<Seen>,
    reply: (Option<i32>, &'static str),
}

impl RunCommand for FakeRun {
    fn run(
        &self,
        cmd: &str,
        args: &[&str],
        envs: &[(&str, &OsStr)],
        _cwd: &Path,
        timeout: Duration,
    ) -> (Option<i32>, String) {
        assert_eq!(cmd, "claude");
        assert_eq!(timeout, PROBE_TIMEOUT);
        *self.seen.borrow_mut() = Some((
            args.iter().map(|s| s.to_string()).collect(),
            envs.iter()
                .map(|(k, v)| (k.to_string(), v.to_string_lossy().into_owned()))
                .collect(),
        ));
        (self.reply.0, self.reply.1.to_owned())
    }
}

#[test]
fn claude_cli_runs_in_account_dir_without_session_or_tools() {
    let probe = std::env::temp_dir().join(format!("hk-probe-{}", std::process::id()));
    let run = FakeRun {
        seen: RefCell::new(None),
        reply: (Some(0), CLAUDE_OUT),
    };
    let r = claude_cli_usage(Path::new("/acc/aria"), NOW, &run, &probe);
    let (args, envs) = run.seen.borrow().clone().unwrap();
    assert_eq!(envs, vec![("CLAUDE_CONFIG_DIR".into(), "/acc/aria".into())]);
    assert_eq!(
        args,
        [
            "-p",
            "/usage",
            "--no-session-persistence",
            "--allowed-tools",
            "",
            "--settings",
            r#"{"remoteControlAtStartup":false}"#
        ]
    );
    assert_eq!(r.session.unwrap().used_percent, 36.0);
    {
        use std::os::unix::fs::PermissionsExt;
        let mode = std::fs::metadata(&probe).unwrap().permissions().mode() & 0o777;
        assert_eq!(mode, 0o700);
    }
    let _ = std::fs::remove_dir_all(&probe);

    let missing = FakeRun {
        seen: RefCell::new(None),
        reply: (None, ""),
    };
    let m = claude_cli_usage(Path::new("/x"), NOW, &missing, &std::env::temp_dir());
    assert_eq!(m, Measured::failed(NOW, "cli-unavailable"));
    let garbled = FakeRun {
        seen: RefCell::new(None),
        reply: (Some(1), "Please run /login"),
    };
    let g = claude_cli_usage(Path::new("/x"), NOW, &garbled, &std::env::temp_dir());
    assert_eq!(g.error.as_deref(), Some("cli-unparsed"));
}

#[test]
fn probe_dir_override_then_home() {
    assert_eq!(
        usage_probe_dir(Some(OsStr::new("/p")), Some(OsStr::new("/h"))),
        PathBuf::from("/p")
    );
    assert_eq!(
        usage_probe_dir(None, Some(OsStr::new("/h"))),
        PathBuf::from("/h/.harkroom-agent/usage-probe")
    );
}

/// 가짜 app-server: 받은 줄을 기록하고 `reply` 가 준 줄을 돌려준다.
struct FakeRpc {
    reply: fn(&Value) -> Option<Value>,
    written: Arc<Mutex<Vec<Value>>>,
    killed: Arc<Mutex<bool>>,
    home: Arc<Mutex<Option<PathBuf>>>,
}

impl FakeRpc {
    fn new(reply: fn(&Value) -> Option<Value>) -> Self {
        FakeRpc {
            reply,
            written: Arc::default(),
            killed: Arc::default(),
            home: Arc::default(),
        }
    }
}

impl SpawnRpc for FakeRpc {
    fn spawn(&self, codex_home: &Path, _cwd: &Path) -> Option<RpcChild> {
        *self.home.lock().unwrap() = Some(codex_home.to_owned());
        let (in_r, in_w) = std::io::pipe().ok()?;
        let (out_r, mut out_w) = std::io::pipe().ok()?;
        let reply = self.reply;
        let written = self.written.clone();
        std::thread::spawn(move || {
            for line in BufReader::new(in_r).lines() {
                let Ok(line) = line else { break };
                let v: Value = serde_json::from_str(&line).unwrap();
                written.lock().unwrap().push(v.clone());
                if let Some(r) = reply(&v) {
                    let _ = writeln!(out_w, "not json");
                    let _ = writeln!(out_w, "{r}");
                }
            }
            // stdin 이 닫히면 끝 — out_w 를 놓아 EOF.
        });
        let killed = self.killed.clone();
        Some(RpcChild {
            stdin: Box::new(in_w),
            stdout: Box::new(out_r),
            terminate: Box::new(move || *killed.lock().unwrap() = true),
        })
    }
}

fn rate() -> Value {
    serde_json::json!({"rateLimits": {
        "primary": {"usedPercent": 12, "windowDurationMins": 300, "resetsAt": 1790635491},
        "secondary": {"usedPercent": 3, "windowDurationMins": 10080, "resetsAt": 1791222291},
        "planType": "plus"
    }})
}

#[test]
fn codex_rpc_order_and_windows() {
    let fake = FakeRpc::new(|m| match m.get("id").and_then(Value::as_i64) {
        Some(1) => Some(serde_json::json!({"id": 1, "result": {}})),
        Some(2) => Some(serde_json::json!({"id": 2, "result": rate()})),
        _ => None,
    });
    let r = codex_cli_usage(
        Path::new("/h"),
        NOW,
        &fake,
        &std::env::temp_dir(),
        PROBE_TIMEOUT,
    );
    assert_eq!(*fake.home.lock().unwrap(), Some(PathBuf::from("/h")));
    let methods: Vec<String> = fake
        .written
        .lock()
        .unwrap()
        .iter()
        .map(|m| m["method"].as_str().unwrap().to_owned())
        .collect();
    assert_eq!(
        methods,
        ["initialize", "initialized", "account/rateLimits/read"]
    );
    assert_eq!(
        r.session,
        Some(UsageWindow {
            used_percent: 12.0,
            resets_at_ms: Some(1_790_635_491_000.0),
            window_minutes: Some(300.0)
        })
    );
    assert_eq!(r.weekly.as_ref().unwrap().window_minutes, Some(10080.0));
    assert_eq!(r.plan.as_deref(), Some("plus"));
    assert!(*fake.killed.lock().unwrap());
    // TS `{ fetchedAtMs, ...parsed }` = fetchedAtMs·session·weekly·plan.
    let j = serde_json::to_value(&r).unwrap();
    let keys: Vec<&String> = j.as_object().unwrap().keys().collect();
    assert_eq!(keys, ["fetchedAtMs", "session", "weekly", "plan"]);
}

#[test]
fn codex_rpc_error_and_silence_are_labels() {
    let err = FakeRpc::new(|m| match m.get("id").and_then(Value::as_i64) {
        Some(1) => Some(serde_json::json!({"id": 1, "result": {}})),
        Some(2) => Some(serde_json::json!({"id": 2, "error": {"message": "SECRET"}})),
        _ => None,
    });
    let e = codex_cli_usage(
        Path::new("/h"),
        NOW,
        &err,
        &std::env::temp_dir(),
        PROBE_TIMEOUT,
    );
    assert_eq!(e.error.as_deref(), Some("cli-error"));
    assert!(!serde_json::to_string(&e).unwrap().contains("SECRET"));

    let slow = FakeRpc::new(|_| None);
    let s = codex_cli_usage(
        Path::new("/h"),
        NOW,
        &slow,
        &std::env::temp_dir(),
        Duration::from_millis(20),
    );
    assert_eq!(s.error.as_deref(), Some("timeout"));
    assert!(*slow.killed.lock().unwrap());

    let unparsed = FakeRpc::new(|m| match m.get("id").and_then(Value::as_i64) {
        Some(1) => Some(serde_json::json!({"id": 1, "result": {}})),
        Some(2) => Some(serde_json::json!({"id": 2, "result": {}})),
        _ => None,
    });
    let u = codex_cli_usage(
        Path::new("/h"),
        NOW,
        &unparsed,
        &std::env::temp_dir(),
        PROBE_TIMEOUT,
    );
    assert_eq!(u.error.as_deref(), Some("cli-unparsed"));
}

struct NoSpawn;
impl SpawnRpc for NoSpawn {
    fn spawn(&self, _: &Path, _: &Path) -> Option<RpcChild> {
        None
    }
}

/// 자식이 답 없이 끝나면(stdout EOF) `cli-unavailable`.
struct ExitsAtOnce;
impl SpawnRpc for ExitsAtOnce {
    fn spawn(&self, _: &Path, _: &Path) -> Option<RpcChild> {
        let (_r, w) = std::io::pipe().ok()?;
        Some(RpcChild {
            stdin: Box::new(w),
            stdout: Box::new(std::io::empty()),
            terminate: Box::new(|| {}),
        })
    }
}

#[test]
fn codex_spawn_fail_or_exit_is_unavailable() {
    let t = std::env::temp_dir();
    assert_eq!(
        codex_cli_usage(Path::new("/h"), NOW, &NoSpawn, &t, PROBE_TIMEOUT),
        Measured::failed(NOW, "cli-unavailable")
    );
    assert_eq!(
        codex_cli_usage(Path::new("/h"), NOW, &ExitsAtOnce, &t, PROBE_TIMEOUT)
            .error
            .as_deref(),
        Some("cli-unavailable")
    );
}

#[test]
fn parse_codex_rate_limits_missing_shape_is_none() {
    assert_eq!(parse_codex_rate_limits(&serde_json::json!({}), NOW), None);
    assert_eq!(
        parse_codex_rate_limits(
            &serde_json::json!({"rateLimits": {"primary": {"x": 1}}}),
            NOW
        ),
        None
    );
}

/// 실물 `codex` 를 **빈 CODEX_HOME**(로그인 없음)으로 띄워 RPC 길이 끝까지 도는지만 본다 — 토큰 없음.
/// `cargo test --lib -- --ignored real_codex_without_login`.
#[test]
#[ignore = "실물 codex 필요"]
fn real_codex_without_login() {
    let home = std::env::temp_dir().join(format!("hk-codex-empty-{}", std::process::id()));
    std::fs::create_dir_all(&home).unwrap();
    let probe = home.join("probe");
    let started = Instant::now();
    let r = codex_cli_usage(&home, NOW, &StdSpawnRpc, &probe, Duration::from_secs(30));
    eprintln!(
        "real codex(no login) → {} in {:?}",
        serde_json::to_string(&r).unwrap(),
        started.elapsed()
    );
    assert!(r.error.is_some() || r.session.is_some());
    let _ = std::fs::remove_dir_all(&home);
}
