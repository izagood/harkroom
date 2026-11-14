use super::*;
use std::fs;
use std::os::unix::fs::symlink;

/// 설치기가 까는 꼴: <root>/agent/bin/pi(런처) · install/current-version · install/releases/<v>/node_modules/.bin/pi ·
/// <root>/path/pi → ../agent/bin/pi(사람 PATH 의 링크).
struct Fx(PathBuf);

impl Drop for Fx {
    fn drop(&mut self) {
        let _ = fs::remove_dir_all(&self.0);
    }
}

fn exe(p: &Path) {
    fs::create_dir_all(p.parent().unwrap()).unwrap();
    fs::write(p, "#!/bin/sh\nexit 0\n").unwrap();
    fs::set_permissions(p, fs::Permissions::from_mode(0o755)).unwrap();
}

fn fx(version: Option<&str>, release: bool, bin: bool) -> Fx {
    static N: std::sync::atomic::AtomicU32 = std::sync::atomic::AtomicU32::new(0);
    let raw = std::env::temp_dir().join(format!(
        "pi-launch-{}-{}",
        std::process::id(),
        N.fetch_add(1, std::sync::atomic::Ordering::Relaxed)
    ));
    fs::create_dir_all(&raw).unwrap();
    let root = fs::canonicalize(&raw).unwrap();
    let agent = root.join("agent");
    exe(&agent.join("bin/pi"));
    fs::create_dir_all(agent.join("install")).unwrap();
    if let Some(v) = version {
        fs::write(agent.join("install/current-version"), format!("{v}\n")).unwrap();
        if release {
            let dir = agent
                .join("install/releases")
                .join(v)
                .join("node_modules/.bin");
            fs::create_dir_all(&dir).unwrap();
            if bin {
                exe(&dir.join("pi"));
            }
        }
    }
    fs::create_dir_all(root.join("path")).unwrap();
    symlink("../agent/bin/pi", root.join("path/pi")).unwrap();
    Fx(root)
}

fn env_of(fx: &Fx, extra: &[(&str, String)]) -> BTreeMap<String, String> {
    let mut e = BTreeMap::from([
        (
            "PATH".to_string(),
            fx.0.join("path").to_string_lossy().into_owned(),
        ),
        (
            "HOME".to_string(),
            fx.0.join("home").to_string_lossy().into_owned(),
        ),
    ]);
    for (k, v) in extra {
        e.insert((*k).to_string(), v.clone());
    }
    e
}

fn release_bin(fx: &Fx, v: &str) -> String {
    fx.0.join("agent/install/releases")
        .join(v)
        .join("node_modules/.bin/pi")
        .to_string_lossy()
        .into_owned()
}

#[test]
fn 런처가_풀리면_판_실행_파일을_직접_부른다() {
    let f = fx(Some("1.4.0"), true, true);
    let got = resolve_pi_launch(&env_of(&f, &[]));
    assert_eq!(got.command, release_bin(&f, "1.4.0"));
    assert_eq!(got.path_prepend, None);
}

#[test]
fn 폴백_current_version_없음() {
    let f = fx(None, false, false);
    assert_eq!(resolve_pi_launch(&env_of(&f, &[])), PiLaunch::fallback());
}

#[test]
fn 폴백_판_폴더_없음() {
    let f = fx(Some("1.4.0"), false, false);
    assert_eq!(resolve_pi_launch(&env_of(&f, &[])), PiLaunch::fallback());
}

#[test]
fn 폴백_실행_파일_없음_또는_실행_권한_없음() {
    let f = fx(Some("1.4.0"), true, false);
    assert_eq!(resolve_pi_launch(&env_of(&f, &[])), PiLaunch::fallback());
    let p = PathBuf::from(release_bin(&f, "1.4.0"));
    fs::write(&p, "#!/bin/sh\n").unwrap();
    fs::set_permissions(&p, fs::Permissions::from_mode(0o644)).unwrap();
    assert_eq!(resolve_pi_launch(&env_of(&f, &[])), PiLaunch::fallback());
}

#[test]
fn 판_문자가_규칙_밖이면_폴백() {
    for v in ["..", ".", "../x", "a b"] {
        let f = fx(Some(v), false, false);
        assert_eq!(
            resolve_pi_launch(&env_of(&f, &[])),
            PiLaunch::fallback(),
            "{v}"
        );
    }
}

#[test]
fn path_에_없거나_런처_꼴이_아니면_폴백() {
    let f = fx(Some("1.4.0"), true, true);
    let mut e = env_of(&f, &[]);
    e.insert(
        "PATH".into(),
        f.0.join("nope").to_string_lossy().into_owned(),
    );
    assert_eq!(resolve_pi_launch(&e), PiLaunch::fallback());
    // npm 전역 설치처럼 `…/bin/pi` 가 아닌 실행 파일
    let other = f.0.join("other");
    exe(&other.join("pi"));
    e.insert("PATH".into(), other.to_string_lossy().into_owned());
    assert_eq!(resolve_pi_launch(&e), PiLaunch::fallback());
}

#[test]
fn pi_전용_node_가_있으면_path_앞에() {
    let f = fx(Some("1.4.0"), true, true);
    exe(&f.0.join("home/.local/share/pi-node/current/bin/node"));
    assert_eq!(
        resolve_pi_launch(&env_of(&f, &[])).path_prepend,
        Some(f.0.join("home/.local/share/pi-node/current/bin"))
    );
    exe(&f.0.join("xdg/pi-node/current/bin/node"));
    let xdg = f.0.join("xdg").to_string_lossy().into_owned();
    assert_eq!(
        resolve_pi_launch(&env_of(&f, &[("XDG_DATA_HOME", xdg)])).path_prepend,
        Some(f.0.join("xdg/pi-node/current/bin"))
    );
}

#[test]
fn 설치_폴더는_읽기만_한다() {
    let f = fx(Some("1.4.0"), true, true);
    let install = f.0.join("agent/install");
    let before = fs::metadata(&install).unwrap().modified().unwrap();
    let _ = resolve_pi_launch(&env_of(&f, &[]));
    assert_eq!(fs::metadata(&install).unwrap().modified().unwrap(), before);
}

#[test]
fn env_에서_관리_자리_이름을_걷고_node_를_앞에() {
    let mut e = BTreeMap::from([
        ("PATH".to_string(), "/usr/bin".to_string()),
        (
            PI_MANAGED_INSTALL_ROOT_ENV.to_string(),
            "/x/install".to_string(),
        ),
    ]);
    apply_pi_launch_env(
        &mut e,
        &PiLaunch {
            command: "/r/pi".into(),
            path_prepend: Some(PathBuf::from("/n/bin")),
        },
    );
    assert_eq!(
        e,
        BTreeMap::from([("PATH".to_string(), "/n/bin:/usr/bin".to_string())])
    );
}
