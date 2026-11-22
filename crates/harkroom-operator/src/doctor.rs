//! `harkroom-operator-rs doctor [--json] [--base-url <url>] [--home <dir>] [--app-data <dir>]`
//! — 이 기기에서 오퍼레이터가 기대는 것들이 있는지 본다. **읽기만 한다**(파일·소켓·설정을 만들거나 고치지 않는다).
//!
//! 화면 없는 기기(리눅스 서버)에 오퍼레이터를 놓을 때, 배정을 받고 나서야 「러너가 안 뜬다」로 알게 되는 것들을
//! 미리 표로 보인다. 보는 것은 오퍼레이터·러너가 **실제로 부르는 자리**와 같다:
//!
//! | 줄 | 재는 것 | 쓰는 곳 |
//! |---|---|---|
//! | 시작 시각 | 자기 pid 의 커널 시작 시각이 읽히는가 | 고아 러너 채택(`adopt`) |
//! | du | `/usr/bin/du` | 워크스페이스 정리의 크기 재기 |
//! | 로그인 PATH | `$SHELL -lc 'echo "$PATH"'` | 러너가 하네스·git 을 찾는 PATH |
//! | git | 로그인 PATH 의 `git` | 러너의 저장소 작업 |
//! | gh | 고정 자리 셋(`default_gh_path`) | 머지 래퍼·`pr.status` |
//! | 하네스 | 설치·로그인(`detect_harnesses`) | 턴 실행 |
//! | 러너 | 이 실행 파일 옆의 `harkroom-runner-rs` | 배정된 에이전트 띄우기 |
//! | 용량 | 메모리·디스크로 잰 동시 턴 상한 | `turn_slots` |
//! | 뿌리 | (`--base-url` 을 줬을 때만) 그 커뮤니티의 뿌리·등록 여부 | `serve`·`register` |
//!
//! 판정은 셋이다: `ok` · `warn`(없어도 뜨지만 일부 기능이 빠진다) · `fail`(이대로면 턴을 못 돌린다).
//! 종료 코드: `fail` 이 없으면 0, 하나라도 있으면 1, 인자가 틀리면 2.
use crate::harnesses::{HARNESS_BINARIES, detect_harnesses};
use crate::serve::RUST_RUNNER_NAME;
use serde_json::{Value, json};
use std::path::{Path, PathBuf};
use std::time::Duration;

/// 로그인 셸 PATH 를 기다리는 시간 — `serve` 와 같다.
const LOGIN_PATH_TIMEOUT: Duration = Duration::from_secs(5);
/// 워크스페이스 정리가 부르는 자리(`workspace_cleanup::scan::measure`).
const DU_PATH: &str = "/usr/bin/du";
/// 머지 래퍼가 보는 gh 자리(`local_merge::default_gh_path` 와 같은 순서).
const GH_CANDIDATES: [&str; 3] = ["/opt/homebrew/bin/gh", "/usr/local/bin/gh", "/usr/bin/gh"];

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Level {
    Ok,
    Warn,
    Fail,
}

impl Level {
    pub fn label(self) -> &'static str {
        match self {
            Level::Ok => "ok",
            Level::Warn => "warn",
            Level::Fail => "fail",
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Check {
    pub name: &'static str,
    pub level: Level,
    pub detail: String,
}

fn check(name: &'static str, level: Level, detail: impl Into<String>) -> Check {
    Check {
        name,
        level,
        detail: detail.into(),
    }
}

/// 하네스 하나의 상태.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct HarnessFact {
    pub name: String,
    pub installed: bool,
    pub logged_in: bool,
}

/// 뿌리 줄의 재료(`--base-url` 을 줬을 때만 있다).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct RootFact {
    /// 뿌리 경로, 못 정했으면 그 까닭.
    pub root: Result<String, String>,
    /// 등록 설정(`operator/operator.json`)이 있는가.
    pub registered: bool,
}

/// 이 기기에서 읽은 사실. 판정([`judge`])은 이것만 본다 — 시험이 실물 없이 모든 갈래를 밟는다.
#[derive(Debug, Clone, PartialEq, Eq, Default)]
pub struct Facts {
    /// 자기 pid 의 시작 시각이 읽혔는가.
    pub boot_time_readable: bool,
    pub du: bool,
    pub shell: Option<String>,
    pub login_path: Option<String>,
    /// 로그인 PATH 에서 찾은 git.
    pub git: Option<String>,
    /// 고정 자리에서 찾은 gh.
    pub gh_fixed: Option<String>,
    /// 고정 자리에는 없고 로그인 PATH 에만 있는 gh.
    pub gh_on_path: Option<String>,
    pub harnesses: Vec<HarnessFact>,
    /// 옆자리 러너 경로(실행 파일 위치를 모르면 None)와, 그 파일이 실행 가능한가.
    pub runner: Option<(String, bool)>,
    /// 용량 한 줄(`device_capacity::describe`)과, 메모리를 읽었는가.
    pub capacity: String,
    pub memory_readable: bool,
    pub root: Option<RootFact>,
    /// 이 사용자의 journal 파일(`user-<uid>.journal`)이 있는가. systemd 가 감독하는 기기(Linux)에서만 잰다 — 아니면 None(줄 없음).
    pub user_journal: Option<bool>,
}

/// journald 가 journal 파일을 두는 자리(영속 → 휘발).
const JOURNAL_DIRS: [&str; 2] = ["/var/log/journal", "/run/log/journal"];

/// `<dir>/<machine-id>/user-<uid>.journal` 이 하나라도 있는가. 없으면 이 사용자의 유닛 로그는 시스템 journal 에만 있어
/// `journalctl --user` 가 권한 오류로 끝난다(사용자별로 나누지 않는 기기).
pub fn user_journal_present(dirs: &[&Path], uid: u32) -> bool {
    let name = format!("user-{uid}.journal");
    dirs.iter().any(|d| {
        std::fs::read_dir(d)
            .is_ok_and(|machines| machines.flatten().any(|m| m.path().join(&name).is_file()))
    })
}

/// 사실 → 판정 줄. 줄의 순서는 고정이다(출력·시험이 기댄다).
pub fn judge(f: &Facts) -> Vec<Check> {
    let mut out = Vec::new();
    let source = crate::adopt::BOOT_TIME_SOURCE;
    out.push(if f.boot_time_readable {
        check("시작 시각", Level::Ok, format!("{source} 로 읽힌다"))
    } else {
        check(
            "시작 시각",
            Level::Fail,
            format!(
                "{source} 로 자기 시작 시각을 못 읽었다 — 오퍼레이터가 다시 뜰 때 돌던 러너를 이어받지 못한다"
            ),
        )
    });
    out.push(if f.du {
        check("du", Level::Ok, DU_PATH)
    } else {
        check(
            "du",
            Level::Warn,
            format!("{DU_PATH} 가 없다 — 워크스페이스 정리에서 크기를 못 잰다"),
        )
    });
    let shell = f.shell.as_deref().unwrap_or("/bin/sh");
    out.push(match &f.login_path {
        Some(p) => check(
            "로그인 PATH",
            Level::Ok,
            format!("{shell} — {}곳", p.split(':').filter(|d| !d.is_empty()).count()),
        ),
        None => check(
            "로그인 PATH",
            Level::Warn,
            format!(
                "{shell} -lc 'echo \"$PATH\"' 가 5초 안에 PATH 를 내지 않았다 — 러너가 하네스·git 을 못 찾을 수 있다"
            ),
        ),
    });
    out.push(match &f.git {
        Some(p) => check("git", Level::Ok, p.clone()),
        None => check(
            "git",
            Level::Warn,
            "로그인 PATH 에 git 이 없다 — 저장소를 다루는 턴이 실패한다",
        ),
    });
    out.push(match (&f.gh_fixed, &f.gh_on_path) {
        (Some(p), _) => check("gh", Level::Ok, p.clone()),
        (None, Some(p)) => check(
            "gh",
            Level::Warn,
            format!(
                "{p} 에 있지만 머지 래퍼는 {} 만 본다 — 그 자리 중 하나에 두거나 심링크를 건다",
                GH_CANDIDATES.join(" · ")
            ),
        ),
        (None, None) => check(
            "gh",
            Level::Warn,
            format!(
                "{} 어디에도 없다 — 머지 래퍼·pr.status 를 못 쓴다",
                GH_CANDIDATES.join(" · ")
            ),
        ),
    });
    let installed: Vec<&HarnessFact> = f.harnesses.iter().filter(|h| h.installed).collect();
    out.push(if installed.is_empty() {
        check(
            "하네스",
            Level::Fail,
            format!(
                "설치된 하네스가 없다({}) — 턴을 돌릴 프로그램이 없다",
                HARNESS_BINARIES.map(|(_, bin)| bin).join(" · ")
            ),
        )
    } else {
        let list = installed
            .iter()
            .map(|h| {
                format!(
                    "{}({})",
                    h.name,
                    if h.logged_in {
                        "로그인됨"
                    } else {
                        "로그인 안 됨"
                    }
                )
            })
            .collect::<Vec<_>>()
            .join(", ");
        if installed.iter().any(|h| h.logged_in) {
            check("하네스", Level::Ok, list)
        } else {
            check(
                "하네스",
                Level::Warn,
                format!("{list} — 로그인된 하네스가 없다"),
            )
        }
    });
    out.push(match &f.runner {
        Some((p, true)) => check("러너", Level::Ok, p.clone()),
        Some((p, false)) => check(
            "러너",
            Level::Fail,
            format!("{p} 가 없거나 실행할 수 없다 — 배정이 와도 러너를 못 띄운다"),
        ),
        None => check(
            "러너",
            Level::Fail,
            format!("이 실행 파일의 위치를 몰라 옆자리 {RUST_RUNNER_NAME} 를 못 찾는다"),
        ),
    });
    out.push(check(
        "용량",
        if f.memory_readable {
            Level::Ok
        } else {
            Level::Warn
        },
        if f.memory_readable {
            f.capacity.clone()
        } else {
            format!("{} — 메모리를 못 읽어 고정값으로 간다", f.capacity)
        },
    ));
    if let Some(present) = f.user_journal {
        out.push(if present {
            check(
                "로그",
                Level::Ok,
                "journalctl --user -u 'harkroom-operator@<키>' -f 로 읽힌다",
            )
        } else {
            check(
                "로그",
                Level::Warn,
                "이 사용자의 journal 파일이 없다 — `journalctl --user` 가 권한 오류를 낼 수 있다. 그러면 `sudo journalctl _SYSTEMD_USER_UNIT=harkroom-operator@<키>.service -f` 로 읽는다(sudo 없이 읽으려면 `sudo usermod -aG systemd-journal \"$USER\"` 뒤 다시 로그인)",
            )
        });
    }
    if let Some(r) = &f.root {
        out.push(match (&r.root, r.registered) {
            (Ok(root), true) => check("뿌리", Level::Ok, format!("{root} (등록됨)")),
            (Ok(root), false) => check(
                "뿌리",
                Level::Warn,
                format!("{root} — 아직 등록되지 않았다(`register` 먼저)"),
            ),
            (Err(e), _) => check("뿌리", Level::Fail, e.clone()),
        });
    }
    out
}

/// 종료 코드 — `fail` 이 하나라도 있으면 1.
pub fn exit_code(checks: &[Check]) -> i32 {
    i32::from(checks.iter().any(|c| c.level == Level::Fail))
}

/// 사람이 읽을 표. 마지막 줄이 결론이다.
pub fn render_text(checks: &[Check]) -> String {
    let mut out = String::new();
    for c in checks {
        out.push_str(&format!(
            "[{:<4}] {} — {}\n",
            c.level.label(),
            c.name,
            c.detail
        ));
    }
    let count = |l: Level| checks.iter().filter(|c| c.level == l).count();
    let (fail, warn) = (count(Level::Fail), count(Level::Warn));
    out.push_str(&if fail > 0 {
        format!("결과: fail {fail}건 · warn {warn}건 — fail 을 고치기 전에는 턴을 못 돌린다")
    } else if warn > 0 {
        format!("결과: warn {warn}건 — 뜨기는 하지만 위 기능이 빠진다")
    } else {
        "결과: 모두 ok".to_string()
    });
    out
}

/// `--json` 한 줄.
pub fn render_json(checks: &[Check]) -> String {
    json!({
        "ok": exit_code(checks) == 0,
        "checks": checks
            .iter()
            .map(|c| json!({"name": c.name, "level": c.level.label(), "detail": c.detail}))
            .collect::<Vec<Value>>(),
    })
    .to_string()
}

#[derive(Debug, Clone, PartialEq, Eq, Default)]
pub struct DoctorArgs {
    pub json: bool,
    pub base_url: Option<String>,
    pub home: Option<String>,
    pub app_data: Option<String>,
}

pub const USAGE: &str = "usage: harkroom-operator-rs doctor [--json] [--base-url <url>] [--home <dir>] [--app-data <dir>]";

pub fn parse_doctor_args(argv: &[String]) -> Result<DoctorArgs, String> {
    let mut a = DoctorArgs::default();
    let mut it = argv.iter();
    while let Some(arg) = it.next() {
        let slot = match arg.as_str() {
            "--json" => {
                a.json = true;
                continue;
            }
            "--base-url" => &mut a.base_url,
            "--home" => &mut a.home,
            "--app-data" => &mut a.app_data,
            other => return Err(format!("모르는 인자: {other}\n{USAGE}")),
        };
        match it.next() {
            Some(v) if !v.is_empty() && !v.starts_with("--") => *slot = Some(v.clone()),
            _ => return Err(format!("{arg} 에 값이 없다\n{USAGE}")),
        }
    }
    Ok(a)
}

fn executable(p: &Path) -> bool {
    use std::os::unix::fs::PermissionsExt;
    std::fs::metadata(p).is_ok_and(|m| m.is_file() && m.permissions().mode() & 0o111 != 0)
}

/// PATH 에서 실행 가능한 `bin` 의 첫 자리.
pub fn find_on_path(path: &str, bin: &str, is_exec: &dyn Fn(&Path) -> bool) -> Option<String> {
    path.split(':')
        .filter(|d| !d.is_empty())
        .map(|d| Path::new(d).join(bin))
        .find(|p| is_exec(p))
        .map(|p| p.to_string_lossy().into_owned())
}

/// 이 기기에서 사실을 읽는다. 로그인 셸을 한 번 띄우는 것 말고는 파일 존재·메타만 본다.
fn gather(args: &DoctorArgs, env: &dyn Fn(&str) -> Option<String>, home: &str) -> Facts {
    let shell = env("SHELL").filter(|s| !s.is_empty());
    let login_path = crate::hello::read_login_path(shell.as_deref(), LOGIN_PATH_TIMEOUT);
    let home_path = Path::new(home);
    let harnesses = detect_harnesses(login_path.as_deref(), env, home_path, &|p| p.exists())
        .into_iter()
        .map(|(name, v)| HarnessFact {
            name,
            installed: v["installed"].as_bool().unwrap_or(false),
            logged_in: v["loggedIn"].as_bool().unwrap_or(false),
        })
        .collect();
    let gh_fixed = GH_CANDIDATES
        .into_iter()
        .find(|p| executable(Path::new(p)))
        .map(str::to_string);
    let on_path = |bin: &str| {
        login_path
            .as_deref()
            .and_then(|p| find_on_path(p, bin, &executable))
    };
    let runner = std::env::current_exe().ok().and_then(|exe| {
        let p: PathBuf = exe.parent()?.join(RUST_RUNNER_NAME);
        let ok = executable(&p);
        Some((p.to_string_lossy().into_owned(), ok))
    });
    let app_data = args
        .app_data
        .clone()
        .unwrap_or_else(|| crate::register_cli::default_app_data(env, home));
    // 뿌리 열쇠는 `register` 와 같이 고른다(끝의 `/` 등을 걷은 값).
    let root = args.base_url.as_deref().map(|url| {
        let root = crate::register_cli::register_root(
            home,
            harkroom_roots::community_root_key(url),
            &app_data,
        );
        let registered = root.as_ref().is_ok_and(|r| {
            Path::new(r)
                .join("operator")
                .join("operator.json")
                .is_file()
        });
        RootFact { root, registered }
    });
    // 디스크는 턴이 쓰는 자리(뿌리) → 홈 순으로 잰다 — `turn_slots` 와 같은 차례.
    let root_path = root
        .as_ref()
        .and_then(|r| r.root.as_ref().ok())
        .map(PathBuf::from);
    let mut disk: Vec<&Path> = Vec::new();
    if let Some(r) = &root_path {
        disk.push(r);
    }
    disk.push(home_path);
    let cap = crate::device_capacity::measure(&disk);
    let decision = crate::device_capacity::decide(&cap, 0);
    Facts {
        boot_time_readable: crate::adopt::ps_boot_time_sec(std::process::id() as i32).is_some(),
        du: executable(Path::new(DU_PATH)),
        git: on_path("git"),
        gh_on_path: if gh_fixed.is_none() {
            on_path("gh")
        } else {
            None
        },
        gh_fixed,
        shell,
        login_path,
        harnesses,
        runner,
        capacity: crate::device_capacity::describe(&decision, &cap, 0),
        memory_readable: cap.mem_total.is_some(),
        root,
        user_journal: cfg!(target_os = "linux").then(|| {
            // SAFETY: 인자도 실패도 없는 호출이다.
            let uid = unsafe { libc::getuid() };
            user_journal_present(&JOURNAL_DIRS.map(Path::new), uid)
        }),
    }
}

/// `doctor` 진입점. (stdout 글, stderr 글, 종료 코드).
pub fn doctor_main(argv: &[String], env: &dyn Fn(&str) -> Option<String>) -> (String, String, i32) {
    let args = match parse_doctor_args(argv) {
        Ok(a) => a,
        Err(e) => return (String::new(), e, 2),
    };
    if let Some(url) = &args.base_url
        && let Err(e) = crate::register_cli::check_url(url)
    {
        return (String::new(), e, 2);
    }
    let Some(home) = args
        .home
        .clone()
        .or_else(|| env("HOME"))
        .filter(|h| !h.is_empty())
    else {
        return (String::new(), "HOME 을 모른다".to_string(), 2);
    };
    let checks = judge(&gather(&args, env, &home));
    let out = if args.json {
        render_json(&checks)
    } else {
        render_text(&checks)
    };
    (out, String::new(), exit_code(&checks))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn healthy() -> Facts {
        Facts {
            boot_time_readable: true,
            du: true,
            shell: Some("/bin/bash".into()),
            login_path: Some("/usr/local/bin:/usr/bin::/bin".into()),
            git: Some("/usr/bin/git".into()),
            gh_fixed: Some("/usr/bin/gh".into()),
            gh_on_path: None,
            harnesses: vec![
                HarnessFact {
                    name: "claude-code".into(),
                    installed: true,
                    logged_in: true,
                },
                HarnessFact {
                    name: "codex".into(),
                    installed: true,
                    logged_in: false,
                },
                HarnessFact {
                    name: "pi".into(),
                    installed: false,
                    logged_in: true,
                },
            ],
            runner: Some(("/opt/harkroom/harkroom-runner-rs".into(), true)),
            capacity: "동시 턴 상한: 8".into(),
            memory_readable: true,
            root: None,
            user_journal: None,
        }
    }

    /// 사용자별 journal 이 없는 기기는 `journalctl --user` 가 막힌다 — 경고로 다른 명령을 알려 준다(턴은 멈추지 않는다).
    #[test]
    fn missing_user_journal_warns_with_the_command_that_works() {
        let mut f = healthy();
        f.user_journal = Some(true);
        let c = judge(&f);
        assert_eq!(level_of(&c, "로그"), Level::Ok);
        // 뿌리 줄보다 앞, 용량 줄 다음이다.
        assert_eq!(c.last().unwrap().name, "로그");
        f.user_journal = Some(false);
        let c = judge(&f);
        assert_eq!(level_of(&c, "로그"), Level::Warn);
        assert_eq!(exit_code(&c), 0);
        let d = &c.iter().find(|x| x.name == "로그").unwrap().detail;
        assert!(d.contains("sudo journalctl _SYSTEMD_USER_UNIT=harkroom-operator@<키>.service -f"));
        assert!(d.contains("usermod -aG systemd-journal"));
    }

    #[test]
    fn user_journal_is_found_per_machine_dir_and_uid() {
        let base = std::env::temp_dir().join(format!("hr-doctor-journal-{}", std::process::id()));
        let machine = base.join("persist").join("0123abcd");
        std::fs::create_dir_all(&machine).unwrap();
        std::fs::create_dir_all(base.join("volatile")).unwrap();
        std::fs::write(machine.join("system.journal"), b"").unwrap();
        std::fs::write(machine.join("user-1000.journal"), b"").unwrap();
        let (persist, volatile, gone) = (
            base.join("persist"),
            base.join("volatile"),
            base.join("gone"),
        );
        let dirs = [gone.as_path(), volatile.as_path(), persist.as_path()];
        assert!(user_journal_present(&dirs, 1000));
        // 남의 uid 파일·시스템 journal 만으로는 아니다.
        assert!(!user_journal_present(&dirs, 1001));
        assert!(!user_journal_present(&dirs[..2], 1000));
        std::fs::remove_dir_all(&base).unwrap();
    }

    fn level_of(checks: &[Check], name: &str) -> Level {
        checks
            .iter()
            .find(|c| c.name == name)
            .unwrap_or_else(|| panic!("{name} 줄이 없다"))
            .level
    }

    #[test]
    fn healthy_device_is_all_ok_in_fixed_order() {
        let c = judge(&healthy());
        let names: Vec<&str> = c.iter().map(|x| x.name).collect();
        assert_eq!(
            names,
            [
                "시작 시각",
                "du",
                "로그인 PATH",
                "git",
                "gh",
                "하네스",
                "러너",
                "용량"
            ]
        );
        assert!(c.iter().all(|x| x.level == Level::Ok), "{c:?}");
        assert_eq!(exit_code(&c), 0);
        // 빈 PATH 칸은 세지 않는다.
        assert!(c[2].detail.contains("3곳"), "{}", c[2].detail);
        // 설치 안 된 하네스는 목록에 없다.
        assert_eq!(c[5].detail, "claude-code(로그인됨), codex(로그인 안 됨)");
        assert!(render_text(&c).ends_with("결과: 모두 ok"));
    }

    #[test]
    fn missing_optional_tools_warn_but_exit_zero() {
        let mut f = healthy();
        f.du = false;
        f.login_path = None;
        f.shell = None;
        f.git = None;
        f.gh_fixed = None;
        f.memory_readable = false;
        f.harnesses[0].logged_in = false;
        let c = judge(&f);
        for name in ["du", "로그인 PATH", "git", "gh", "하네스", "용량"] {
            assert_eq!(level_of(&c, name), Level::Warn, "{name}");
        }
        assert_eq!(exit_code(&c), 0);
        assert!(c[2].detail.starts_with("/bin/sh "), "{}", c[2].detail);
        assert!(render_text(&c).contains("결과: warn 6건"));
    }

    #[test]
    fn gh_outside_fixed_places_is_called_out() {
        let mut f = healthy();
        f.gh_fixed = None;
        f.gh_on_path = Some("/home/u/.local/bin/gh".into());
        let c = judge(&f);
        let gh = c.iter().find(|x| x.name == "gh").unwrap();
        assert_eq!(gh.level, Level::Warn);
        assert!(gh.detail.starts_with("/home/u/.local/bin/gh 에 있지만"));
        assert!(gh.detail.contains("/usr/bin/gh"));
    }

    #[test]
    fn what_stops_turns_is_fail_and_exit_one() {
        type Break = fn(&mut Facts);
        let cases: [(&str, Break); 5] = [
            ("시작 시각", |f| f.boot_time_readable = false),
            ("하네스", |f| {
                f.harnesses.iter_mut().for_each(|h| h.installed = false)
            }),
            ("하네스", |f| f.harnesses.clear()),
            ("러너", |f| {
                f.runner = Some(("/x/harkroom-runner-rs".into(), false))
            }),
            ("러너", |f| f.runner = None),
        ];
        for (name, break_it) in cases {
            let mut f = healthy();
            break_it(&mut f);
            let c = judge(&f);
            assert_eq!(level_of(&c, name), Level::Fail, "{name}");
            assert_eq!(c.iter().filter(|x| x.level == Level::Fail).count(), 1);
            assert_eq!(exit_code(&c), 1, "{name}");
            assert!(render_text(&c).contains("결과: fail 1건"));
        }
    }

    #[test]
    fn root_line_appears_only_with_base_url() {
        let mut f = healthy();
        f.root = Some(RootFact {
            root: Ok("/h/.harkroom/c-1".into()),
            registered: true,
        });
        let c = judge(&f);
        assert_eq!(c.last().unwrap().name, "뿌리");
        assert_eq!(level_of(&c, "뿌리"), Level::Ok);
        f.root = Some(RootFact {
            root: Ok("/h/.harkroom/c-1".into()),
            registered: false,
        });
        assert_eq!(level_of(&judge(&f), "뿌리"), Level::Warn);
        f.root = Some(RootFact {
            root: Err("색인이 깨졌다".into()),
            registered: false,
        });
        let c = judge(&f);
        assert_eq!(level_of(&c, "뿌리"), Level::Fail);
        assert_eq!(exit_code(&c), 1);
    }

    #[test]
    fn json_is_one_line_with_levels() {
        let mut f = healthy();
        f.git = None;
        let c = judge(&f);
        let line = render_json(&c);
        assert!(!line.contains('\n'));
        let v: Value = serde_json::from_str(&line).unwrap();
        assert_eq!(v["ok"], json!(true));
        assert_eq!(v["checks"].as_array().unwrap().len(), c.len());
        assert_eq!(v["checks"][3]["name"], json!("git"));
        assert_eq!(v["checks"][3]["level"], json!("warn"));
        f.runner = None;
        let v: Value = serde_json::from_str(&render_json(&judge(&f))).unwrap();
        assert_eq!(v["ok"], json!(false));
    }

    fn s(v: &[&str]) -> Vec<String> {
        v.iter().map(|x| x.to_string()).collect()
    }

    #[test]
    fn args_parse_and_reject() {
        assert_eq!(parse_doctor_args(&[]).unwrap(), DoctorArgs::default());
        let a = parse_doctor_args(&s(&[
            "--json",
            "--base-url",
            "https://c.example.com",
            "--home",
            "/h",
            "--app-data",
            "/d",
        ]))
        .unwrap();
        assert!(a.json);
        assert_eq!(a.base_url.as_deref(), Some("https://c.example.com"));
        assert_eq!(a.home.as_deref(), Some("/h"));
        assert_eq!(a.app_data.as_deref(), Some("/d"));
        for bad in [
            s(&["--nope"]),
            s(&["--home"]),
            s(&["--home", "--json"]),
            s(&["--base-url", ""]),
            s(&["extra"]),
        ] {
            let e = parse_doctor_args(&bad).unwrap_err();
            assert!(e.contains("usage:"), "{bad:?} → {e}");
        }
    }

    #[test]
    fn main_rejects_bad_input_with_exit_two() {
        let no_env = |_: &str| None;
        let (out, err, code) = doctor_main(&s(&["--nope"]), &no_env);
        assert_eq!((out.as_str(), code), ("", 2));
        assert!(err.contains("모르는 인자"));
        let (_, err, code) = doctor_main(&[], &no_env);
        assert_eq!((err.as_str(), code), ("HOME 을 모른다", 2));
        let (_, _, code) = doctor_main(&s(&["--base-url", "not a url", "--home", "/h"]), &no_env);
        assert_eq!(code, 2);
    }

    #[test]
    fn find_on_path_takes_first_executable_and_skips_empty_dirs() {
        let exec = |p: &Path| p == Path::new("/b/git") || p == Path::new("/c/git");
        assert_eq!(
            find_on_path("/a::/b:/c", "git", &exec).as_deref(),
            Some("/b/git")
        );
        assert_eq!(find_on_path("/a", "git", &exec), None);
        assert_eq!(find_on_path("", "git", &exec), None);
    }

    /// 실물: 이 기기에서 돌려 본다 — 줄이 다 나오고, 쓰기 없이 끝나며, 시작 시각이 읽힌다(리눅스 CI 에서는 `/proc` 길).
    #[test]
    fn real_run_reads_this_device_without_writing() {
        // 소켓 경로 길이 한도(뿌리 판정) 때문에 짧은 자리를 쓴다 — macOS 의 temp_dir 은 길다.
        let dir = Path::new("/tmp").join(format!("hkd-{}", std::process::id()));
        let home = dir.join("home");
        std::fs::create_dir_all(&home).unwrap();
        let home_s = home.to_string_lossy().into_owned();
        let app_data = dir.join("data").to_string_lossy().into_owned();
        let env = |k: &str| (k == "SHELL").then(|| "/bin/sh".to_string());
        let (out, err, code) = doctor_main(
            &s(&[
                "--json",
                "--home",
                &home_s,
                "--app-data",
                &app_data,
                "--base-url",
                "https://c.example.com",
            ]),
            &env,
        );
        assert_eq!(err, "");
        let v: Value = serde_json::from_str(&out).unwrap();
        let checks = v["checks"].as_array().unwrap();
        // 리눅스에서는 「로그」 줄이 하나 더 있다(사용자 journal 판별).
        let expected = if cfg!(target_os = "linux") { 10 } else { 9 };
        assert_eq!(checks.len(), expected, "{out}");
        assert_eq!(checks[0]["level"], json!("ok"), "{out}");
        assert_eq!(checks[2]["level"], json!("ok"), "{out}");
        // 빈 홈: 등록 전이라 뿌리는 warn 이다. 뿌리는 늘 마지막 줄이다.
        let root = checks.last().unwrap();
        assert_eq!(root["name"], json!("뿌리"));
        assert_eq!(root["level"], json!("warn"), "{out}");
        assert_eq!(code, i32::from(v["ok"] == json!(false)));
        // 아무것도 만들지 않았다.
        assert_eq!(std::fs::read_dir(&home).unwrap().count(), 0);
        assert!(!Path::new(&app_data).exists());
        let _ = std::fs::remove_dir_all(&dir);
    }
}
