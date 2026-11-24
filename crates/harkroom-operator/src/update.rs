//! `harkroom-operator-rs update [--check] [--target <판>] [--allow-downgrade]` — 화면 없는 기기의 오퍼레이터가 스스로 판을 올린다(M1).
//!
//! 차례: 목록(`operator-manifest.json`)과 그 서명을 받는다 → **서명 검증**(공개키는 빌드 때 굽는다) → 판 판정 →
//! 제 플랫폼 파일을 받는다 → 크기·sha256 검증 → 지금 바이너리를 `.prev` 로 두고 rename 으로 바꾼다 → 새 바이너리로
//! 자기 점검 → 실패하면 `.prev` 로 되돌린다. `--check` 는 받기·검증까지만 한다.
//!
//! 지키는 것:
//! - 공개키가 구워지지 않았으면 거절한다. 검증 없이 바꾸는 길은 없다.
//! - 받은 바이트를 메모리에서 검증하고, **그 바이트**를 0700 폴더 안에 새로 만든 파일에 쓴 뒤 다시 읽어 맞춰 보고 rename 한다.
//! - 목록의 파일 이름은 한 마디 이름만 받는다(`/`·`\`·`..`·숨김 이름 거절).
//! - 받는 자리는 https 이고 정해 둔 호스트뿐이다 — 리다이렉트도 한 걸음마다 같은 판정을 거친다.
//! - 목표 판이 지금 판보다 낮으면 `--allow-downgrade` 없이는 거절한다. 목록의 판이 요청한 판과 다르면 거절한다.
//! - 앱 번들 안의 오퍼레이터는 바꾸지 않는다(앱 업데이트가 맡는다).
use std::io::{Read, Write};
use std::path::{Path, PathBuf};
use std::time::Duration;

use base64::Engine;
use base64::engine::general_purpose::STANDARD;
use serde_json::Value;

/// 목록 서명을 검증할 ed25519 공개키(32바이트, base64). 릴리스 빌드가 env 로 굽는다 — 없으면 `update` 는 거절한다.
const PUBKEY_B64: Option<&str> = option_env!("HARKROOM_UPDATE_PUBKEY");
const RELEASES: &str = "https://github.com/izagood/harkroom/releases";
const MANIFEST_NAME: &str = "operator-manifest.json";
/// 받기를 허락하는 호스트(릴리스 자산은 첫 호스트에서 뒤의 호스트로 넘어간다).
const ALLOWED_HOSTS: [&str; 3] = [
    "github.com",
    "objects.githubusercontent.com",
    "release-assets.githubusercontent.com",
];
const MAX_HOPS: usize = 5;
const MAX_MANIFEST_BYTES: u64 = 64 * 1024;
const MAX_BINARY_BYTES: u64 = 512 * 1024 * 1024;

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ManifestFile {
    pub platform: String,
    pub name: String,
    pub size: u64,
    pub sha256: String,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Manifest {
    pub version: String,
    pub files: Vec<ManifestFile>,
}

/// 안정 판(`a.b.c`)만 읽는다. 앞의 `v` 는 받아 준다.
pub fn parse_version(s: &str) -> Option<(u64, u64, u64)> {
    let s = s.strip_prefix('v').unwrap_or(s);
    let mut it = s.split('.');
    let mut next = || -> Option<u64> {
        let p = it.next()?;
        if p.is_empty() || p.len() > 9 || !p.bytes().all(|b| b.is_ascii_digit()) {
            return None;
        }
        p.parse().ok()
    };
    let v = (next()?, next()?, next()?);
    if it.next().is_some() {
        return None;
    }
    Some(v)
}

/// 한 마디 파일 이름인가 — 경로 구분자·`..`·숨김 이름·제어 문자를 거절한다.
pub fn safe_file_name(name: &str) -> bool {
    !name.is_empty()
        && name.len() <= 200
        && !name.starts_with('.')
        && !name.contains("..")
        && name
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || matches!(b, b'.' | b'-' | b'_'))
}

pub fn parse_manifest(bytes: &[u8]) -> Result<Manifest, String> {
    let v: Value =
        serde_json::from_slice(bytes).map_err(|_| "목록이 JSON 이 아니다".to_string())?;
    let version = v["version"].as_str().unwrap_or_default().to_string();
    if parse_version(&version).is_none() {
        return Err("목록의 판을 읽을 수 없다".into());
    }
    let mut files = Vec::new();
    for f in v["files"].as_array().ok_or("목록에 files 가 없다")? {
        let file = ManifestFile {
            platform: f["platform"].as_str().unwrap_or_default().to_string(),
            name: f["name"].as_str().unwrap_or_default().to_string(),
            size: f["size"].as_u64().ok_or("목록의 size 가 수가 아니다")?,
            sha256: f["sha256"].as_str().unwrap_or_default().to_string(),
        };
        if !safe_file_name(&file.name) {
            return Err("목록의 파일 이름이 한 마디 이름이 아니다".into());
        }
        if file.sha256.len() != 64 || !file.sha256.bytes().all(|b| b.is_ascii_hexdigit()) {
            return Err("목록의 sha256 꼴이 틀렸다".into());
        }
        if file.size == 0 || file.size > MAX_BINARY_BYTES {
            return Err("목록의 size 가 범위 밖이다".into());
        }
        files.push(file);
    }
    Ok(Manifest { version, files })
}

/// 목록 바이트의 ed25519 서명을 검증한다. 공개키가 없으면 거절한다.
pub fn verify_signature(
    pubkey_b64: Option<&str>,
    manifest: &[u8],
    sig_b64: &str,
) -> Result<(), String> {
    let key = pubkey_b64
        .map(str::trim)
        .filter(|k| !k.is_empty())
        .ok_or("서명 키 없음 — 이 빌드에는 업데이트 서명 공개키가 없다")?;
    let key = STANDARD
        .decode(key)
        .map_err(|_| "서명 공개키 꼴이 틀렸다".to_string())?;
    let sig = STANDARD
        .decode(sig_b64.trim())
        .map_err(|_| "서명 꼴이 틀렸다".to_string())?;
    if key.len() != 32 || sig.len() != 64 {
        return Err("서명 또는 공개키 길이가 틀렸다".into());
    }
    ring::signature::UnparsedPublicKey::new(&ring::signature::ED25519, &key)
        .verify(manifest, &sig)
        .map_err(|_| "목록 서명 검증 실패".to_string())
}

/// 판 판정. `Ok(true)` 는 바꿀 것이 있음, `Ok(false)` 는 이미 그 판.
pub fn check_target(
    current: &str,
    manifest_version: &str,
    requested: Option<&str>,
    allow_downgrade: bool,
) -> Result<bool, String> {
    let cur = parse_version(current).ok_or("지금 판을 모른다(릴리스 빌드가 아니다)")?;
    let got = parse_version(manifest_version).ok_or("목록의 판을 읽을 수 없다")?;
    if let Some(r) = requested {
        let want = parse_version(r).ok_or("--target 판을 읽을 수 없다")?;
        if want != got {
            return Err(format!(
                "목록의 판({manifest_version})이 요청한 판({r})과 다르다"
            ));
        }
    }
    if got == cur {
        return Ok(false);
    }
    if got < cur && !allow_downgrade {
        return Err(format!(
            "다운그레이드 거절: 목표 {manifest_version} < 지금 {current} (--allow-downgrade 로만)"
        ));
    }
    Ok(true)
}

pub fn platform_key(os: &str, arch: &str) -> String {
    format!("{os}-{arch}")
}

pub fn pick_file<'a>(m: &'a Manifest, platform: &str) -> Result<&'a ManifestFile, String> {
    let mut it = m.files.iter().filter(|f| f.platform == platform);
    match (it.next(), it.next()) {
        (Some(f), None) => Ok(f),
        (None, _) => Err(format!("목록에 이 플랫폼({platform}) 파일이 없다")),
        _ => Err(format!("목록에 이 플랫폼({platform}) 파일이 여럿이다")),
    }
}

fn sha256_hex(bytes: &[u8]) -> String {
    ring::digest::digest(&ring::digest::SHA256, bytes)
        .as_ref()
        .iter()
        .map(|b| format!("{b:02x}"))
        .collect()
}

/// 받은 바이트가 목록의 크기·sha256 과 같은가.
pub fn verify_bytes(file: &ManifestFile, bytes: &[u8]) -> Result<(), String> {
    if bytes.len() as u64 != file.size {
        return Err(format!(
            "크기가 다르다: 목록 {} · 받은 것 {}",
            file.size,
            bytes.len()
        ));
    }
    if !sha256_hex(bytes).eq_ignore_ascii_case(&file.sha256) {
        return Err("sha256 이 다르다".into());
    }
    Ok(())
}

/// 받아도 되는 주소인가 — https 이고, 허락한 호스트이고, 사용자 정보·포트가 없다.
pub fn check_url(url: &str) -> Result<(), String> {
    let rest = url
        .strip_prefix("https://")
        .ok_or("https 가 아닌 주소는 받지 않는다")?;
    let authority = rest.split(['/', '?', '#']).next().unwrap_or_default();
    if authority.contains('@') || authority.contains(':') {
        return Err("주소에 사용자 정보·포트가 있다".into());
    }
    let host = authority.to_ascii_lowercase();
    if ALLOWED_HOSTS.contains(&host.as_str()) {
        Ok(())
    } else {
        Err(format!("허락하지 않은 호스트에서 받지 않는다: {host}"))
    }
}

/// 한 걸음 받기의 결과 — 본문이거나, 넘어갈 주소다.
pub enum Hop {
    Body(Vec<u8>),
    Redirect(String),
}

/// 리다이렉트를 손으로 따라가며 걸음마다 `check_url` 을 거친다.
pub fn fetch_checked(
    url: &str,
    max_bytes: u64,
    hop: &dyn Fn(&str, u64) -> Result<Hop, String>,
) -> Result<Vec<u8>, String> {
    let mut url = url.to_string();
    for _ in 0..MAX_HOPS {
        check_url(&url)?;
        match hop(&url, max_bytes)? {
            Hop::Body(b) => return Ok(b),
            Hop::Redirect(next) => url = next,
        }
    }
    Err("리다이렉트가 너무 많다".into())
}

fn http_hop(url: &str, max_bytes: u64) -> Result<Hop, String> {
    let agent = ureq::Agent::new_with_config(
        ureq::Agent::config_builder()
            .http_status_as_error(false)
            .max_redirects(0)
            .timeout_global(Some(Duration::from_secs(300)))
            .build(),
    );
    let mut res = agent
        .get(url)
        .call()
        .map_err(|e| format!("받기 실패: {e}"))?;
    let status = res.status();
    if status.is_redirection() {
        let loc = res
            .headers()
            .get("location")
            .and_then(|v| v.to_str().ok())
            .ok_or("리다이렉트에 location 이 없다")?;
        return Ok(Hop::Redirect(loc.to_string()));
    }
    if !status.is_success() {
        return Err(format!("받기 실패: HTTP {}", status.as_u16()));
    }
    let mut buf = Vec::new();
    res.body_mut()
        .as_reader()
        .take(max_bytes + 1)
        .read_to_end(&mut buf)
        .map_err(|e| format!("받기 실패: {e}"))?;
    if buf.len() as u64 > max_bytes {
        return Err("받은 것이 너무 크다".into());
    }
    Ok(Hop::Body(buf))
}

/// 검증한 바이트로 `exe` 를 바꾼다. 실패하면 원래 바이너리로 되돌린다.
///
/// 임시 파일은 `exe` 옆(같은 파일 시스템)의 0700 폴더 안에 **새로** 만든다. 쓴 뒤 다시 읽어 `file` 과 맞춰 본 것만
/// rename 한다. `self_check` 는 바꾼 뒤의 `exe` 가 뜨는지 본다.
#[cfg(unix)]
pub fn install(
    exe: &Path,
    file: &ManifestFile,
    bytes: &[u8],
    self_check: &dyn Fn(&Path) -> bool,
) -> Result<PathBuf, String> {
    use std::os::unix::fs::{DirBuilderExt, OpenOptionsExt};
    verify_bytes(file, bytes)?;
    let dir = exe.parent().ok_or("실행 파일의 폴더를 모른다")?;
    let base = exe
        .file_name()
        .and_then(|n| n.to_str())
        .ok_or("실행 파일 이름을 모른다")?;
    let stage = dir.join(format!(".{base}.update.{}", std::process::id()));
    // create(재귀 아님) — 이미 있으면(남이 미리 놓은 폴더·링크) 실패한다.
    std::fs::DirBuilder::new()
        .mode(0o700)
        .create(&stage)
        .map_err(|e| format!("임시 폴더를 만들 수 없다: {e}"))?;
    let result = (|| -> Result<PathBuf, String> {
        let new = stage.join("new");
        let mut f = std::fs::OpenOptions::new()
            .write(true)
            .create_new(true)
            .mode(0o755)
            .open(&new)
            .map_err(|e| format!("임시 파일을 만들 수 없다: {e}"))?;
        f.write_all(bytes).map_err(|e| format!("쓰기 실패: {e}"))?;
        f.sync_all().map_err(|e| format!("쓰기 실패: {e}"))?;
        drop(f);
        // 쓴 것을 다시 읽어 맞춘다 — rename 할 파일이 검증한 바로 그 내용이어야 한다.
        let written = std::fs::read(&new).map_err(|e| format!("다시 읽기 실패: {e}"))?;
        verify_bytes(file, &written)?;
        // 지금 바이너리를 보관한다(복사 → rename, 반쯤 쓰인 `.prev` 를 남기지 않는다).
        let prev = dir.join(format!("{base}.prev"));
        let keep = stage.join("prev");
        std::fs::copy(exe, &keep).map_err(|e| format!("보관 실패: {e}"))?;
        std::fs::rename(&keep, &prev).map_err(|e| format!("보관 실패: {e}"))?;
        std::fs::rename(&new, exe).map_err(|e| format!("교체 실패: {e}"))?;
        if !self_check(exe) {
            let back = stage.join("back");
            std::fs::copy(&prev, &back)
                .and_then(|_| std::fs::rename(&back, exe))
                .map_err(|e| format!("자기 점검 실패, 되돌림도 실패: {e}"))?;
            return Err("새 바이너리의 자기 점검 실패 — 이전 판으로 되돌렸다".into());
        }
        Ok(prev)
    })();
    let _ = std::fs::remove_dir_all(&stage);
    result
}

#[derive(Debug, Default, PartialEq, Eq)]
pub struct UpdateArgs {
    pub check: bool,
    pub target: Option<String>,
    pub allow_downgrade: bool,
}

pub fn parse_update_args(argv: &[String]) -> Result<UpdateArgs, String> {
    let mut a = UpdateArgs::default();
    let mut it = argv.iter();
    while let Some(arg) = it.next() {
        match arg.as_str() {
            "--check" => a.check = true,
            "--allow-downgrade" => a.allow_downgrade = true,
            "--target" => {
                let v = it.next().ok_or("--target 에 판이 없다")?;
                parse_version(v).ok_or("--target 판을 읽을 수 없다")?;
                a.target = Some(v.strip_prefix('v').unwrap_or(v).to_string());
            }
            other => return Err(format!("모르는 인자: {other}")),
        }
    }
    Ok(a)
}

fn asset_url(target: Option<&str>, name: &str) -> String {
    match target {
        Some(v) => format!("{RELEASES}/download/v{v}/{name}"),
        None => format!("{RELEASES}/latest/download/{name}"),
    }
}

fn run(args: &UpdateArgs) -> Result<String, String> {
    // 키가 없으면 네트워크에 나가기 전에 거절한다.
    verify_signature(PUBKEY_B64, b"", "").or_else(|e| {
        if e.starts_with("서명 키 없음") {
            Err(e)
        } else {
            Ok(())
        }
    })?;
    let current = option_env!("HARKROOM_BUILD_VERSION").unwrap_or_default();
    let target = args.target.as_deref();
    let manifest_bytes = fetch_checked(
        &asset_url(target, MANIFEST_NAME),
        MAX_MANIFEST_BYTES,
        &http_hop,
    )?;
    let sig = fetch_checked(
        &asset_url(target, &format!("{MANIFEST_NAME}.sig")),
        MAX_MANIFEST_BYTES,
        &http_hop,
    )?;
    verify_signature(PUBKEY_B64, &manifest_bytes, &String::from_utf8_lossy(&sig))?;
    let manifest = parse_manifest(&manifest_bytes)?;
    if !check_target(current, &manifest.version, target, args.allow_downgrade)? {
        return Ok(format!("이미 {} 이다", manifest.version));
    }
    let platform = platform_key(std::env::consts::OS, std::env::consts::ARCH);
    let file = pick_file(&manifest, &platform)?;
    // 파일은 목록과 같은 릴리스(목록의 판)에서 받는다.
    let bytes = fetch_checked(
        &asset_url(Some(&manifest.version), &file.name),
        file.size,
        &http_hop,
    )?;
    verify_bytes(file, &bytes)?;
    if args.check {
        return Ok(format!(
            "{current} → {} 검증 통과(--check: 바꾸지 않았다)",
            manifest.version
        ));
    }
    let exe = std::env::current_exe()
        .and_then(|p| p.canonicalize())
        .map_err(|e| format!("실행 파일 자리를 모른다: {e}"))?;
    let kind = crate::hello::install_kind_of(&exe.to_string_lossy(), false, !current.is_empty());
    if kind != "bundle" {
        return Err(match kind {
            "app" => "앱 번들 안의 오퍼레이터다 — 앱 업데이트를 쓰라".to_string(),
            _ => "릴리스 묶음으로 깐 오퍼레이터가 아니다 — 바꾸지 않는다".to_string(),
        });
    }
    #[cfg(unix)]
    {
        let prev = install(&exe, file, &bytes, &|p| {
            std::process::Command::new(p)
                .arg("--version")
                .output()
                .map(|o| {
                    o.status.success()
                        && String::from_utf8_lossy(&o.stdout).contains(&manifest.version)
                })
                .unwrap_or(false)
        })?;
        Ok(format!(
            "{current} → {} 로 바꿨다(이전 판: {})",
            manifest.version,
            prev.display()
        ))
    }
    #[cfg(not(unix))]
    Err("이 플랫폼에서는 바꾸지 않는다".to_string())
}

/// `(stdout, stderr, exit)` — 인자 오류 2, 거절·실패 1.
pub fn update_main(argv: &[String]) -> (String, String, i32) {
    let args = match parse_update_args(argv) {
        Ok(a) => a,
        Err(e) => return (String::new(), e, 2),
    };
    match run(&args) {
        Ok(out) => (out, String::new(), 0),
        Err(e) => (String::new(), format!("update: {e}"), 1),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use ring::signature::KeyPair;

    fn keypair() -> ring::signature::Ed25519KeyPair {
        let rng = ring::rand::SystemRandom::new();
        let pkcs8 = ring::signature::Ed25519KeyPair::generate_pkcs8(&rng).unwrap();
        ring::signature::Ed25519KeyPair::from_pkcs8(pkcs8.as_ref()).unwrap()
    }

    fn file_for(bytes: &[u8]) -> ManifestFile {
        ManifestFile {
            platform: "linux-x86_64".into(),
            name: "harkroom-operator-rs-linux-x86_64".into(),
            size: bytes.len() as u64,
            sha256: sha256_hex(bytes),
        }
    }

    fn manifest_json(name: &str) -> String {
        format!(
            r#"{{"version":"1.2.3","files":[{{"platform":"linux-x86_64","name":"{name}","size":3,"sha256":"{}"}}]}}"#,
            sha256_hex(b"abc")
        )
    }

    fn tmp(name: &str) -> PathBuf {
        let d = std::env::temp_dir().join(format!("hk-update-{name}-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&d);
        std::fs::create_dir_all(&d).unwrap();
        d
    }

    #[test]
    fn versions() {
        assert_eq!(parse_version("v0.5.63"), Some((0, 5, 63)));
        for bad in ["", "1.2", "1.2.3.4", "1.2.3-rc1", "1..3", "a.b.c", "1.2.+3"] {
            assert_eq!(parse_version(bad), None, "{bad}");
        }
    }

    #[test]
    fn manifest_parses_and_rejects_path_escape() {
        let m = parse_manifest(manifest_json("op-linux").as_bytes()).unwrap();
        assert_eq!(m.version, "1.2.3");
        assert_eq!(pick_file(&m, "linux-x86_64").unwrap().name, "op-linux");
        assert!(pick_file(&m, "linux-aarch64").is_err());
        for bad in [
            "../op",
            "a/b",
            "/etc/passwd",
            "..",
            ".hidden",
            "a\\\\b",
            "",
            "a..b",
            "a b",
        ] {
            assert!(
                parse_manifest(manifest_json(bad).as_bytes()).is_err(),
                "{bad}"
            );
        }
        assert!(parse_manifest(b"not json").is_err());
        assert!(parse_manifest(br#"{"version":"1.2.3"}"#).is_err());
    }

    #[test]
    fn signature_required_and_checked() {
        let kp = keypair();
        let key = STANDARD.encode(kp.public_key().as_ref());
        let body = manifest_json("op");
        let sig = STANDARD.encode(kp.sign(body.as_bytes()).as_ref());
        assert!(verify_signature(Some(&key), body.as_bytes(), &sig).is_ok());
        // 키가 없거나 비었으면 거절.
        for none in [None, Some(""), Some("  ")] {
            let e = verify_signature(none, body.as_bytes(), &sig).unwrap_err();
            assert!(e.starts_with("서명 키 없음"), "{e}");
        }
        // 한 글자라도 바뀐 목록·다른 키·깨진 서명은 거절.
        let tampered = body.replace("1.2.3", "9.9.9");
        assert!(verify_signature(Some(&key), tampered.as_bytes(), &sig).is_err());
        let other = STANDARD.encode(keypair().public_key().as_ref());
        assert!(verify_signature(Some(&other), body.as_bytes(), &sig).is_err());
        assert!(verify_signature(Some(&key), body.as_bytes(), "AAAA").is_err());
        assert!(verify_signature(Some(&key), body.as_bytes(), "").is_err());
    }

    #[test]
    fn target_rules() {
        assert_eq!(check_target("1.2.3", "1.2.4", None, false), Ok(true));
        assert_eq!(check_target("1.2.3", "1.2.3", None, false), Ok(false));
        assert_eq!(
            check_target("1.2.3", "v1.2.4", Some("1.2.4"), false),
            Ok(true)
        );
        // 다운그레이드는 명시 옵션으로만.
        assert!(check_target("1.2.3", "1.2.2", None, false).is_err());
        assert!(check_target("1.10.0", "1.9.9", Some("1.9.9"), false).is_err());
        assert_eq!(
            check_target("1.2.3", "1.2.2", Some("1.2.2"), true),
            Ok(true)
        );
        // 목록의 판이 요청과 다르면 거절(옵션이 있어도).
        assert!(check_target("1.2.3", "1.2.5", Some("1.2.4"), true).is_err());
        // 지금 판을 모르면 거절.
        assert!(check_target("", "1.2.4", None, true).is_err());
    }

    #[test]
    fn bytes_must_match_size_and_hash() {
        let f = file_for(b"abc");
        assert!(verify_bytes(&f, b"abc").is_ok());
        assert!(verify_bytes(&f, b"abd").is_err());
        assert!(verify_bytes(&f, b"abcd").is_err());
    }

    #[test]
    fn urls_and_redirects_stay_on_allowed_hosts() {
        assert!(check_url("https://github.com/o/r/releases/latest/download/x").is_ok());
        assert!(check_url("https://GitHub.com/x").is_ok());
        for bad in [
            "http://github.com/x",
            "https://evil.example/x",
            "https://github.com.evil.example/x",
            "https://github.com@evil.example/x",
            "https://evil.example#github.com/x",
            "https://github.com:8443/x",
            "file:///etc/passwd",
            "/relative",
        ] {
            assert!(check_url(bad).is_err(), "{bad}");
        }
        // 허락한 호스트로 넘어가는 것은 따라간다.
        let ok = fetch_checked("https://github.com/a", 10, &|u, _| {
            Ok(if u.ends_with("/a") {
                Hop::Redirect("https://objects.githubusercontent.com/b".into())
            } else {
                Hop::Body(b"ok".to_vec())
            })
        });
        assert_eq!(ok.unwrap(), b"ok");
        // 다른 호스트로 넘기면 그 호스트에는 요청조차 보내지 않는다.
        let asked = std::cell::RefCell::new(Vec::new());
        let r = fetch_checked("https://github.com/a", 10, &|u, _| {
            asked.borrow_mut().push(u.to_string());
            Ok(Hop::Redirect("https://evil.example/b".into()))
        });
        assert!(r.is_err());
        assert_eq!(*asked.borrow(), vec!["https://github.com/a".to_string()]);
        // 끝없는 리다이렉트는 끊는다.
        let r = fetch_checked("https://github.com/a", 10, &|_, _| {
            Ok(Hop::Redirect("https://github.com/a".into()))
        });
        assert!(r.is_err());
    }

    #[cfg(unix)]
    #[test]
    fn install_swaps_and_keeps_prev() {
        use std::os::unix::fs::PermissionsExt;
        let d = tmp("swap");
        let exe = d.join("op");
        std::fs::write(&exe, b"old").unwrap();
        let seen_mode = std::cell::Cell::new(0);
        let prev = install(&exe, &file_for(b"new!"), b"new!", &|p| {
            // 자기 점검 때 임시 폴더는 소유자만 들어갈 수 있다.
            let stage = p
                .parent()
                .unwrap()
                .join(format!(".op.update.{}", std::process::id()));
            seen_mode.set(std::fs::metadata(stage).unwrap().permissions().mode() & 0o777);
            std::fs::read(p).unwrap() == b"new!"
        })
        .unwrap();
        assert_eq!(seen_mode.get(), 0o700);
        assert_eq!(std::fs::read(&exe).unwrap(), b"new!");
        assert_eq!(std::fs::read(&prev).unwrap(), b"old");
        assert_eq!(prev, d.join("op.prev"));
        assert_ne!(
            std::fs::metadata(&exe).unwrap().permissions().mode() & 0o100,
            0
        );
        // 임시 폴더는 남지 않는다.
        let left: Vec<_> = std::fs::read_dir(&d)
            .unwrap()
            .map(|e| e.unwrap().file_name())
            .collect();
        assert_eq!(left.len(), 2, "{left:?}");
        let _ = std::fs::remove_dir_all(&d);
    }

    #[cfg(unix)]
    #[test]
    fn install_rolls_back_when_self_check_fails() {
        let d = tmp("rollback");
        let exe = d.join("op");
        std::fs::write(&exe, b"old").unwrap();
        let e = install(&exe, &file_for(b"broken"), b"broken", &|_| false).unwrap_err();
        assert!(e.contains("되돌렸다"), "{e}");
        assert_eq!(std::fs::read(&exe).unwrap(), b"old");
        let _ = std::fs::remove_dir_all(&d);
    }

    #[cfg(unix)]
    #[test]
    fn install_refuses_unverified_bytes_and_preplaced_stage() {
        let d = tmp("refuse");
        let exe = d.join("op");
        std::fs::write(&exe, b"old").unwrap();
        // 목록과 다른 바이트는 파일 시스템에 손대기 전에 거절.
        assert!(install(&exe, &file_for(b"good"), b"evil", &|_| true).is_err());
        assert_eq!(std::fs::read(&exe).unwrap(), b"old");
        assert!(!d.join("op.prev").exists());
        // 임시 폴더 자리에 남이 미리 놓은 것이 있으면 거절(그 안에 쓰지 않는다).
        let stage = d.join(format!(".op.update.{}", std::process::id()));
        std::fs::create_dir(&stage).unwrap();
        assert!(install(&exe, &file_for(b"good"), b"good", &|_| true).is_err());
        assert_eq!(std::fs::read(&exe).unwrap(), b"old");
        let _ = std::fs::remove_dir_all(&d);
    }

    #[test]
    fn args() {
        let s = |v: &[&str]| v.iter().map(|x| x.to_string()).collect::<Vec<_>>();
        assert_eq!(
            parse_update_args(&s(&["--check", "--target", "v1.2.3"])).unwrap(),
            UpdateArgs {
                check: true,
                target: Some("1.2.3".into()),
                allow_downgrade: false
            }
        );
        assert!(parse_update_args(&s(&["--target"])).is_err());
        assert!(parse_update_args(&s(&["--target", "../x"])).is_err());
        assert!(parse_update_args(&s(&["--force"])).is_err());
    }
}
