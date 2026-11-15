//! pi 를 **런처를 거치지 않고** 띄우는 실행 파일 해석(p2b, security 감②). 정본 `packages/agent/src/piLaunch.ts`.
//!
//! 설치기가 까는 `<agent>/bin/pi` 는 sh 런처다: `<agent>/install/current-version` 을 읽어
//! `<agent>/install/releases/<판>/node_modules/.bin/pi` 를 exec 하는데, 그 앞에 `PI_MANAGED_INSTALL_ROOT=<agent>/install`
//! 을 export 한다 — 그 이름을 받은 pi 는 사람의 설치 폴더를 제 관리 자리로 알고 손댄다. 러너는 런처가 하는 일 중
//! **판 고르기와 node PATH** 만 똑같이 하고, 그 이름은 싣지 않는다(부모 env 에 있어도 걷는다).
//! 어느 하나라도 어긋나면(`current-version` 없음·판 폴더 없음·실행 파일 없음, 또는 런처 꼴이 아님) 지금처럼 `pi`.

use std::collections::{BTreeMap, HashMap};
use std::os::unix::fs::PermissionsExt as _;
use std::path::{Path, PathBuf};

/// 런처가 export 하는 이름 — 러너가 띄우는 pi 에는 싣지 않는다.
pub const PI_MANAGED_INSTALL_ROOT_ENV: &str = "PI_MANAGED_INSTALL_ROOT";

/// 런처를 못 풀었을 때 부르는 이름.
pub const PI_FALLBACK_COMMAND: &str = "pi";

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct PiLaunch {
    /// 띄울 실행 파일. 런처를 못 풀면 `"pi"`.
    pub command: String,
    /// PATH 앞에 붙일 pi 전용 node 폴더.
    pub path_prepend: Option<PathBuf>,
}

impl PiLaunch {
    fn fallback() -> Self {
        Self {
            command: PI_FALLBACK_COMMAND.to_string(),
            path_prepend: None,
        }
    }
}

/// 자식 env 의 두 꼴(턴 계획은 `BTreeMap`, 보조 조회는 `HashMap`)을 같은 길로 다룬다.
pub trait EnvMap {
    fn get_var(&self, k: &str) -> Option<&str>;
    fn set_var(&mut self, k: &str, v: String);
    fn remove_var(&mut self, k: &str);
}

impl EnvMap for BTreeMap<String, String> {
    fn get_var(&self, k: &str) -> Option<&str> {
        self.get(k).map(String::as_str)
    }
    fn set_var(&mut self, k: &str, v: String) {
        self.insert(k.to_string(), v);
    }
    fn remove_var(&mut self, k: &str) {
        self.remove(k);
    }
}

impl EnvMap for HashMap<String, String> {
    fn get_var(&self, k: &str) -> Option<&str> {
        self.get(k).map(String::as_str)
    }
    fn set_var(&mut self, k: &str, v: String) {
        self.insert(k.to_string(), v);
    }
    fn remove_var(&mut self, k: &str) {
        self.remove(k);
    }
}

fn executable(p: &Path) -> bool {
    // 런처의 `[ -x ]` 와 같다 — 실행 비트가 하나라도 있는 보통 파일(링크는 따라간다).
    std::fs::metadata(p).is_ok_and(|m| m.is_file() && m.permissions().mode() & 0o111 != 0)
}

fn valid_version(v: &str) -> bool {
    !v.is_empty()
        && v != "."
        && v != ".."
        && v.bytes()
            .all(|b| b.is_ascii_alphanumeric() || matches!(b, b'.' | b'_' | b'+' | b'-'))
}

/// 그 env(자식이 받을 PATH·HOME·XDG_DATA_HOME)로 pi 를 어떻게 띄울지 정한다. 파일만 읽는다 — 쓰지 않는다.
pub fn resolve_pi_launch(env: &impl EnvMap) -> PiLaunch {
    let path = env.get_var("PATH").unwrap_or("");
    let Some(found) = path
        .split(':')
        .filter(|d| !d.is_empty())
        .map(|d| Path::new(d).join("pi"))
        .find(|c| executable(c))
    else {
        return PiLaunch::fallback();
    };
    let Ok(launcher) = std::fs::canonicalize(&found) else {
        return PiLaunch::fallback();
    };
    let bin_dir = launcher.parent();
    let is_launcher = launcher.file_name().is_some_and(|n| n == "pi")
        && bin_dir
            .and_then(Path::file_name)
            .is_some_and(|n| n == "bin");
    let Some(agent_dir) = bin_dir.and_then(Path::parent).filter(|_| is_launcher) else {
        return PiLaunch::fallback();
    };
    let install = agent_dir.join("install");
    let Ok(raw) = std::fs::read_to_string(install.join("current-version")) else {
        return PiLaunch::fallback();
    };
    let version = raw.split('\n').next().unwrap_or("");
    if !valid_version(version) {
        return PiLaunch::fallback();
    }
    let release_bin = install
        .join("releases")
        .join(version)
        .join("node_modules")
        .join(".bin")
        .join("pi");
    if !executable(&release_bin) {
        return PiLaunch::fallback();
    }
    let data_home = env
        .get_var("XDG_DATA_HOME")
        .filter(|v| !v.is_empty())
        .map(PathBuf::from)
        .or_else(|| {
            env.get_var("HOME")
                .map(|h| Path::new(h).join(".local/share"))
        });
    let path_prepend = data_home
        .map(|d| d.join("pi-node/current/bin"))
        .filter(|b| executable(&b.join("node")));
    PiLaunch {
        command: release_bin.to_string_lossy().into_owned(),
        path_prepend,
    }
}

/// 해석한 띄우기를 자식 env 에 얹는다 — PATH 앞에 node 폴더, 런처 이름은 걷는다.
pub fn apply_pi_launch_env(env: &mut impl EnvMap, launch: &PiLaunch) {
    env.remove_var(PI_MANAGED_INSTALL_ROOT_ENV);
    if let Some(dir) = &launch.path_prepend {
        let dir = dir.to_string_lossy();
        let next = match env.get_var("PATH").filter(|p| !p.is_empty()) {
            Some(p) => format!("{dir}:{p}"),
            None => dir.into_owned(),
        };
        env.set_var("PATH", next);
    }
}

#[cfg(test)]
#[path = "pi_launch/tests.rs"]
mod tests;
