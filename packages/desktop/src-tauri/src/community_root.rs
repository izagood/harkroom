//! 커뮤니티마다 오퍼레이터를 따로 두는 구조(격리 C안)의 **뿌리 해석 — 앱(Rust) 쪽 절반**.
//!
//! 규칙의 정본은 `@harkroom/shared/operatorRoots.ts` 다. 앱은 오퍼레이터를 **띄우기 전에** 소켓 자리를
//! 알아야 하므로 같은 규칙을 여기서 다시 계산한다 — 두 규칙이 갈리면 앱이 보지 않는 자리에 오퍼레이터가
//! 소켓을 놓는다. 그래서 이 파일은 해석만 하고, 판단을 하나도 더하지 않는다:
//!
//! - 키는 baseUrl 의 끝 슬래시만 뗀 값(`communityRootKey`).
//! - 색인 `<앱 데이터 뿌리>/operators.json` 에 칸이 있으면 그 뿌리(옛 자리 `legacy` 포함).
//! - 없으면 `<HOME>/.harkroom-agent/c/<sha256 앞 8자>`, 그 뿌리를 다른 칸이 쓰면 16자, 그것도 겹치면 거절.
//! - 색인에 같은 뿌리를 두 칸이 쓰면 읽기부터 거절한다(security P1-n1).
//!
//! 스위치 `HARKROOM_OPERATOR_PER_COMMUNITY` 는 **앱 프로세스의 환경**에서 읽는다 — 기본 꺼짐이고, 꺼져
//! 있으면 이 모듈은 불리지 않는다(지금의 오퍼레이터 하나 그대로).

use std::collections::HashMap;
use std::path::{Path, PathBuf};

use serde::Deserialize;
use sha2::{Digest, Sha256};

pub const PER_COMMUNITY_ENV: &str = "HARKROOM_OPERATOR_PER_COMMUNITY";
pub const OPERATOR_ROOT_ENV: &str = "HARKROOM_OPERATOR_ROOT";
pub const OPERATOR_COMMUNITY_ENV: &str = "HARKROOM_OPERATOR_COMMUNITY";
/// 옛 단일 오퍼레이터 자리를 그 커뮤니티 뿌리로 쓰는 경우(D5). 러너가 작업 폴더를 옮기지 않는다(`agentStateRoot.ts`).
pub const OPERATOR_LEGACY_ENV: &str = "HARKROOM_OPERATOR_LEGACY";
pub const ROOTS_INDEX_FILE: &str = "operators.json";
const HASH_LEN: usize = 8;
const HASH_FALLBACK_LEN: usize = 16;

/// 스위치는 정확히 `1` 일 때만 켜진다(`perCommunityEnabled` 와 같다).
pub fn per_community_enabled() -> bool {
    std::env::var(PER_COMMUNITY_ENV).as_deref() == Ok("1")
}

/// 오퍼레이터 하나가 맡을 커뮤니티와 그 뿌리.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct CommunityTarget {
    /// `communityRootKey(baseUrl)` — 연결 맵의 키이자 오퍼레이터에 넘기는 `HARKROOM_OPERATOR_COMMUNITY`.
    pub key: String,
    pub root: PathBuf,
    /// 옛 단일 오퍼레이터 자리(D5). 만들지도 권한을 바꾸지도 않고 확인만 한다.
    pub legacy: bool,
}

#[derive(Deserialize, Default)]
struct IndexEntry {
    root: String,
    #[serde(default)]
    legacy: Option<bool>,
}

#[derive(Deserialize, Default)]
struct RootsIndex {
    #[serde(default)]
    communities: HashMap<String, IndexEntry>,
}

pub fn community_key(base_url: &str) -> String {
    base_url.trim_end_matches('/').to_string()
}

fn hash_prefix(key: &str, len: usize) -> String {
    let digest = Sha256::digest(key.as_bytes());
    let hex: String = digest.iter().map(|b| format!("{b:02x}")).collect();
    hex[..len].to_string()
}

fn computed_root(home: &Path, key: &str, len: usize) -> PathBuf {
    home.join(".harkroom-agent").join("c").join(hash_prefix(key, len))
}

/// `path.resolve` 와 같은 뜻의 글자 정규화 — 끝 슬래시·`.`·`..` 를 접는다(security P2a-n2). 파일 시스템은 안 본다.
fn normalize(p: &Path) -> PathBuf {
    use std::path::Component;
    let mut out = PathBuf::new();
    for c in p.components() {
        match c {
            Component::ParentDir => {
                out.pop();
            }
            Component::CurDir => {}
            other => out.push(other.as_os_str()),
        }
    }
    out
}

fn read_index(app_data_root: &Path) -> Result<RootsIndex, String> {
    let path = app_data_root.join(ROOTS_INDEX_FILE);
    let text = match std::fs::read_to_string(&path) {
        Ok(t) => t,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(RootsIndex::default()),
        Err(e) => return Err(format!("오퍼레이터 색인을 읽지 못했다: `{}`: {e}", path.display())),
    };
    let index: RootsIndex = serde_json::from_str(&text)
        .map_err(|e| format!("오퍼레이터 색인이 깨졌다: `{}`: {e}", path.display()))?;
    let mut seen = std::collections::HashSet::new();
    for e in index.communities.values() {
        if !seen.insert(normalize(Path::new(&e.root))) {
            return Err(format!("오퍼레이터 색인에 같은 뿌리를 두 커뮤니티가 쓴다: `{}`", e.root));
        }
    }
    Ok(index)
}

/// baseUrl 의 뿌리를 정한다(`resolveCommunityRoot` 의 Rust 판). 소켓 길이는 호출부(`check_socket_path_length`)가 잰다.
pub fn resolve(app_data_root: &Path, home: &Path, base_url: &str) -> Result<CommunityTarget, String> {
    let key = community_key(base_url);
    if key.is_empty() {
        return Err("커뮤니티 주소가 비었다".to_string());
    }
    let index = read_index(app_data_root)?;
    if let Some(e) = index.communities.get(&key) {
        if !e.root.starts_with('/') {
            return Err(format!("오퍼레이터 색인의 뿌리가 절대 경로가 아니다: `{}`", e.root));
        }
        return Ok(CommunityTarget {
            key,
            root: normalize(Path::new(&e.root)),
            legacy: e.legacy.unwrap_or(false),
        });
    }
    let owner_of = |r: &Path| {
        let r = normalize(r);
        index
            .communities
            .iter()
            .find(|(k, e)| **k != key && normalize(Path::new(&e.root)) == r)
            .map(|(k, _)| k.clone())
    };
    let mut root = computed_root(home, &key, HASH_LEN);
    if owner_of(&root).is_some() {
        let longer = computed_root(home, &key, HASH_FALLBACK_LEN);
        if let Some(taken_by) = owner_of(&longer) {
            return Err(format!(
                "커뮤니티 뿌리 `{}` 를 다른 커뮤니티(`{taken_by}`)가 이미 쓴다",
                longer.display()
            ));
        }
        root = longer;
    }
    Ok(CommunityTarget { key, root, legacy: false })
}

/// 오퍼레이터 프로세스에 줄 커뮤니티 env. `Some(값)` 은 주고 `None` 은 지운다(앱이 물려받은 값이 새지 않게).
/// - 커뮤니티 모드: 스위치·뿌리·커뮤니티를 주고, **색인 칸이 `legacy` 일 때만** `LEGACY=1`, 아니면 지운다.
/// - 꺼짐: 넷 다 지운다.
pub fn community_env(target: Option<&CommunityTarget>) -> Vec<(&'static str, Option<String>)> {
    match target {
        Some(t) => vec![
            (PER_COMMUNITY_ENV, Some("1".to_string())),
            (OPERATOR_ROOT_ENV, Some(t.root.to_string_lossy().into_owned())),
            (OPERATOR_COMMUNITY_ENV, Some(t.key.clone())),
            (OPERATOR_LEGACY_ENV, if t.legacy { Some("1".to_string()) } else { None }),
        ],
        None => vec![
            (PER_COMMUNITY_ENV, None),
            (OPERATOR_ROOT_ENV, None),
            (OPERATOR_COMMUNITY_ENV, None),
            (OPERATOR_LEGACY_ENV, None),
        ],
    }
}

/// 커뮤니티를 고치는 명령(인자에 `baseUrl`)이 **다른 커뮤니티의 오퍼레이터**로 가지 않게 한다(security P6-F1 이중 확인).
/// 스위치가 켜져 있고 `community` 가 왔는데 그 키가 `baseUrl` 의 키와 다르면 거절한다. 꺼져 있으면 아무 일도 없다.
pub fn check_same_community(base_url: &str, community: Option<&str>) -> Result<(), String> {
    if !per_community_enabled() {
        return Ok(());
    }
    match community {
        Some(c) if community_key(c) != community_key(base_url) => Err(format!(
            "커뮤니티 `{}` 를 고치는 명령이 다른 커뮤니티(`{}`)의 오퍼레이터로 가려 했다",
            community_key(base_url),
            community_key(c)
        )),
        _ => Ok(()),
    }
}

/// 새 뿌리를 색인에 적는다 — 이미 이 커뮤니티 칸이 있으면 손대지 않는다(옛 자리·operatorId 를 보존한다).
/// 다른 칸이 같은 뿌리를 쓰면 거절한다(security P1-n1). 임시 파일에 0600 으로 쓰고 rename 한다.
/// 뿌리 디렉터리 확인(`ensure_root_dir`)이 끝난 **뒤에** 부른다 — 쓸 수 없는 뿌리를 색인에 남기지 않는다.
pub fn record_root(app_data_root: &Path, target: &CommunityTarget) -> Result<(), String> {
    let path = app_data_root.join(ROOTS_INDEX_FILE);
    let mut doc: serde_json::Value = match std::fs::read_to_string(&path) {
        Ok(t) => serde_json::from_str(&t).map_err(|e| format!("오퍼레이터 색인이 깨졌다: `{}`: {e}", path.display()))?,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => serde_json::json!({ "version": 1, "communities": {} }),
        Err(e) => return Err(format!("오퍼레이터 색인을 읽지 못했다: `{}`: {e}", path.display())),
    };
    let communities = doc
        .get_mut("communities")
        .and_then(|c| c.as_object_mut())
        .ok_or_else(|| format!("오퍼레이터 색인의 모양이 다르다: `{}`", path.display()))?;
    if communities.contains_key(&target.key) {
        return Ok(());
    }
    let mine = normalize(&target.root);
    if let Some((k, _)) = communities.iter().find(|(_, e)| {
        e.get("root").and_then(|r| r.as_str()).map(|r| normalize(Path::new(r)) == mine).unwrap_or(false)
    }) {
        return Err(format!("뿌리 `{}` 는 이미 다른 커뮤니티(`{k}`)의 것이다", target.root.display()));
    }
    communities.insert(target.key.clone(), serde_json::json!({ "root": mine.to_string_lossy() }));
    write_index_doc(app_data_root, &doc)
}

/// 색인을 0600 임시 파일에 쓰고 rename 한다.
fn write_index_doc(app_data_root: &Path, doc: &serde_json::Value) -> Result<(), String> {
    let path = app_data_root.join(ROOTS_INDEX_FILE);
    std::fs::create_dir_all(app_data_root).map_err(|e| format!("앱 데이터 디렉터리를 만들지 못했다: {e}"))?;
    let tmp = app_data_root.join(format!("{ROOTS_INDEX_FILE}.{}.tmp", std::process::id()));
    let text = format!("{}\n", serde_json::to_string_pretty(doc).map_err(|e| e.to_string())?);
    {
        use std::io::Write;
        #[cfg(unix)]
        use std::os::unix::fs::OpenOptionsExt;
        let mut opts = std::fs::OpenOptions::new();
        opts.write(true).create(true).truncate(true);
        #[cfg(unix)]
        opts.mode(0o600);
        let mut f = opts.open(&tmp).map_err(|e| format!("오퍼레이터 색인을 쓰지 못했다: {e}"))?;
        f.write_all(text.as_bytes()).map_err(|e| format!("오퍼레이터 색인을 쓰지 못했다: {e}"))?;
    }
    std::fs::rename(&tmp, &path).map_err(|e| format!("오퍼레이터 색인을 바꿔 끼우지 못했다: {e}"))?;
    Ok(())
}

/// 옛 단일 설정의 자리. 커뮤니티마다 모드에서도 legacy 커뮤니티는 이 파일을 그대로 쓴다.
fn legacy_config_path(app_data_root: &Path) -> PathBuf {
    app_data_root.join("operator").join("operator.json")
}

/// 오퍼레이터 토큰 파일 이름 — `operator/src/secrets.ts::fileFor` 와 같은 규칙(sha256(끝 슬래시 뗀 baseUrl) 앞 16자).
fn token_file_name(key: &str) -> String {
    format!("operator-token.{}", hash_prefix(&community_key(key), 16))
}

fn read_json(path: &Path) -> Result<Option<serde_json::Value>, String> {
    match std::fs::read_to_string(path) {
        Ok(t) => serde_json::from_str(&t).map(Some).map_err(|e| format!("설정이 깨졌다: `{}`: {e}", path.display())),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(None),
        Err(e) => Err(format!("설정을 읽지 못했다: `{}`: {e}", path.display())),
    }
}

/// 0600 임시 파일 → rename 으로 JSON 을 쓴다(부모는 0700 으로 만든다).
fn write_json_atomic(path: &Path, v: &serde_json::Value) -> Result<(), String> {
    let dir = path.parent().ok_or_else(|| format!("부모가 없다: `{}`", path.display()))?;
    make_private_dir(dir)?;
    let tmp = dir.join(format!(".{}.{}.tmp", path.file_name().and_then(|n| n.to_str()).unwrap_or("x"), std::process::id()));
    let text = format!("{}\n", serde_json::to_string_pretty(v).map_err(|e| e.to_string())?);
    write_private(&tmp, text.as_bytes())?;
    std::fs::rename(&tmp, path).map_err(|e| format!("`{}` 를 바꿔 끼우지 못했다: {e}", path.display()))
}

fn make_private_dir(dir: &Path) -> Result<(), String> {
    #[cfg(unix)]
    let res = {
        use std::os::unix::fs::DirBuilderExt;
        std::fs::DirBuilder::new().recursive(true).mode(0o700).create(dir)
    };
    #[cfg(not(unix))]
    let res = std::fs::create_dir_all(dir);
    res.map_err(|e| format!("디렉터리를 만들지 못했다: `{}`: {e}", dir.display()))
}

fn write_private(path: &Path, bytes: &[u8]) -> Result<(), String> {
    use std::io::Write;
    #[cfg(unix)]
    use std::os::unix::fs::OpenOptionsExt;
    let mut opts = std::fs::OpenOptions::new();
    opts.write(true).create(true).truncate(true);
    #[cfg(unix)]
    opts.mode(0o600);
    let mut f = opts.open(path).map_err(|e| format!("`{}` 를 쓰지 못했다: {e}", path.display()))?;
    f.write_all(bytes).map_err(|e| format!("`{}` 를 쓰지 못했다: {e}", path.display()))
}

/// `src` 가 있고 `dst` 가 아직 없을 때만 0600 으로 복사한다(있는 것을 덮지 않는다).
fn copy_if_absent(src: &Path, dst: &Path) -> Result<(), String> {
    if !src.is_file() || dst.exists() {
        return Ok(());
    }
    let bytes = std::fs::read(src).map_err(|e| format!("`{}` 를 읽지 못했다: {e}", src.display()))?;
    if let Some(dir) = dst.parent() {
        make_private_dir(dir)?;
    }
    write_private(dst, &bytes)
}

/// 기계에 하나인 계정 **선택** 파일(D2) — 켜짐이면 뿌리마다 `claude-pools.json`·`codex-active.json` 을 읽는다(P2b).
fn account_choice_sources(home: &Path) -> [(PathBuf, &'static str); 2] {
    let claude = std::env::var_os("HARKROOM_CLAUDE_ACCOUNTS_DIR").map(PathBuf::from).unwrap_or_else(|| home.join(".harkroom-agent").join("claude-accounts"));
    let codex = std::env::var_os("HARKROOM_CODEX_ACCOUNTS_DIR").map(PathBuf::from).unwrap_or_else(|| home.join(".harkroom-agent").join("codex-accounts"));
    [(claude.join("pools.json"), "claude-pools.json"), (codex.join("active.json"), "codex-active.json")]
}

/// 한 커뮤니티를 그 뿌리로 옮긴다(복사): 설정 칸(그 커뮤니티 하나 + 커뮤니티 밖 설정)·오퍼레이터 토큰·MCP 정의·MCP 토큰·
/// 계정 선택. 뿌리 확인(`ensure_root_dir`)을 먼저 한다. 설정 칸은 옛 설정이 정본이라 덮어쓴다(꺼져 있던 동안 바뀌었을 수 있다).
fn copy_community_into(app_data_root: &Path, home: &Path, legacy_cfg: &serde_json::Value, key: &str, section: &serde_json::Value, target: &CommunityTarget) -> Result<(), String> {
    ensure_root_dir(target)?;
    let mut cfg = legacy_cfg.clone();
    if let Some(obj) = cfg.as_object_mut() {
        obj.insert("communities".to_string(), serde_json::json!({ key: section }));
    }
    write_json_atomic(&target.root.join("operator").join("operator.json"), &cfg)?;
    let from = app_data_root.join("operator");
    let to = target.root.join("operator");
    let token = token_file_name(key);
    copy_if_absent(&from.join("secrets").join(&token), &to.join("secrets").join(&token))?;
    copy_if_absent(&from.join("mcp-servers.json"), &to.join("mcp-servers.json"))?;
    copy_if_absent(&from.join("secrets").join("mcp-oauth.json"), &to.join("secrets").join("mcp-oauth.json"))?;
    for (src, name) in account_choice_sources(home) {
        copy_if_absent(&src, &target.root.join(name))?;
    }
    Ok(())
}

/// **옮기기(D5)** — 커뮤니티마다 모드를 켜고 뜰 때 부른다.
///
/// 1단계: 색인이 없으면 옛 단일 설정(`<앱 데이터>/operator/operator.json`)에서 에이전트가 가장 많은 칸을 그 자리 그대로 쓰는
/// legacy 칸으로 적는다(이동 0). 앞서 끄며 남긴 `operators.json.off` 가 있으면 새로 고르지 않고 그것을 되살린다(security #1649 n1 —
/// 16자 비킴 기록이 사라지지 않게).
/// 2단계: legacy 가 아닌 칸은 각자 뿌리로 **복사한 뒤에** 옛 설정에서 지운다(security #1649 M1). 하나라도 실패하면 옛 설정을 고치지
/// 않는다 — 그 칸은 옛 설정에 남고, 커뮤니티마다 모드의 legacy 프로세스는 #1650 의 거르기로 그 칸을 띄우지 않는다.
///
/// `legacy: true` 를 쓰는 곳은 이 함수 하나이고 색인이 없을 때만 쓴다. 옛 설정이 깨졌으면 아무것도 쓰지 않고 오류다.
/// 돌려주는 값은 legacy 커뮤니티 키(옛 설정이 없거나 비었으면 None).
pub fn adopt_legacy(app_data_root: &Path, home: &Path) -> Result<Option<String>, String> {
    let index_path = app_data_root.join(ROOTS_INDEX_FILE);
    let off_path = app_data_root.join(format!("{ROOTS_INDEX_FILE}.off"));
    if !index_path.exists() && off_path.exists() {
        std::fs::rename(&off_path, &index_path).map_err(|e| format!("꺼 둔 색인을 되살리지 못했다: {e}"))?;
    }
    let cfg_path = legacy_config_path(app_data_root);
    let Some(mut cfg) = read_json(&cfg_path)? else { return Ok(None) };
    let communities: Vec<(String, serde_json::Value)> = cfg
        .get("communities")
        .and_then(|c| c.as_object())
        .map(|c| c.iter().map(|(k, v)| (community_key(k), v.clone())).filter(|(k, _)| !k.is_empty()).collect())
        .unwrap_or_default();
    let mut index = read_index(app_data_root)?;
    let legacy_key = match index.communities.iter().find(|(_, e)| e.legacy == Some(true)).map(|(k, _)| k.clone()) {
        Some(k) => k,
        None => {
            if !index.communities.is_empty() {
                return Ok(None); // legacy 없는 색인 — 손대지 않는다
            }
            let agents_of = |e: &serde_json::Value| e.get("agents").and_then(|a| a.as_object()).map(|a| a.len()).unwrap_or(0);
            let Some(key) = communities
                .iter()
                .map(|(k, e)| (k.clone(), agents_of(e)))
                .max_by(|(ka, na), (kb, nb)| na.cmp(nb).then_with(|| kb.cmp(ka)))
                .map(|(k, _)| k)
            else {
                return Ok(None);
            };
            let doc = serde_json::json!({
                "version": 1,
                "communities": { key.clone(): { "root": normalize(app_data_root).to_string_lossy(), "legacy": true } },
            });
            write_index_doc(app_data_root, &doc)?;
            index = read_index(app_data_root)?;
            key
        }
    };
    // legacy 커뮤니티도 켜짐에서는 뿌리의 계정 선택 파일을 읽는다(P2b) — 옛 자리 그대로 쓰게 복사해 둔다.
    for (src, name) in account_choice_sources(home) {
        copy_if_absent(&src, &app_data_root.join(name))?;
    }
    let mut moved: Vec<String> = Vec::new();
    for (key, section) in communities.iter().filter(|(k, _)| *k != legacy_key) {
        let target = resolve(app_data_root, home, key)?;
        copy_community_into(app_data_root, home, &cfg, key, section, &target)?;
        if !index.communities.contains_key(key) {
            record_root(app_data_root, &target)?;
        }
        moved.push(key.clone());
    }
    if !moved.is_empty() {
        if let Some(obj) = cfg.get_mut("communities").and_then(|c| c.as_object_mut()) {
            obj.retain(|k, _| !moved.contains(&community_key(k)));
        }
        write_json_atomic(&cfg_path, &cfg)?;
    }
    Ok(Some(legacy_key))
}

/// **되돌리기** — 스위치를 끄고 뜰 때 부른다. 각 뿌리로 옮겼던 칸(설정 칸·토큰)을 옛 단일 설정에 **도로 합친 뒤** 색인을
/// `operators.json.off` 로 옮긴다(지우지 않는다 — 다시 켜면 그대로 되살린다, security #1649 n1). 꺼진 앱은 색인을 읽지 않고 옛 단일
/// 오퍼레이터로 모든 커뮤니티를 든다. 뿌리(`c/<해시>`)는 지우지 않는다. 옮겼으면 true.
pub fn revert_index(app_data_root: &Path) -> Result<bool, String> {
    let index_path = app_data_root.join(ROOTS_INDEX_FILE);
    if !index_path.exists() {
        return Ok(false);
    }
    let index = read_index(app_data_root)?;
    let cfg_path = legacy_config_path(app_data_root);
    let mut cfg = read_json(&cfg_path)?.unwrap_or_else(|| serde_json::json!({ "communities": {} }));
    let mut changed = false;
    for (key, e) in index.communities.iter().filter(|(_, e)| e.legacy != Some(true)) {
        let root = Path::new(&e.root);
        let Some(rc) = read_json(&root.join("operator").join("operator.json"))? else { continue };
        let Some(section) = rc.get("communities").and_then(|c| c.as_object()).and_then(|c| c.iter().find(|(k, _)| community_key(k) == *key).map(|(_, v)| v.clone())) else { continue };
        if let Some(obj) = cfg.as_object_mut() {
            let comms = obj.entry("communities").or_insert_with(|| serde_json::json!({}));
            if let Some(c) = comms.as_object_mut() {
                c.insert(key.clone(), section);
                changed = true;
            }
        }
        let token = token_file_name(key);
        copy_if_absent(&root.join("operator").join("secrets").join(&token), &app_data_root.join("operator").join("secrets").join(&token))?;
    }
    if changed {
        write_json_atomic(&cfg_path, &cfg)?;
    }
    std::fs::rename(&index_path, app_data_root.join(format!("{ROOTS_INDEX_FILE}.off"))).map_err(|e| format!("오퍼레이터 색인을 꺼 두지 못했다: {e}"))?;
    Ok(true)
}

/// 뿌리 디렉터리를 쓸 수 있게 한다 — 토큰·소켓을 쓰기 **전에** 부른다(security P1-n2, P2a 지적).
/// `ensureCommunityRootDir` 와 같은 기준: 새 뿌리는 0700, 이미 있으면 심링크 아님·디렉터리·내 소유, 넓으면 좁힌다.
/// 옛 자리는 만들지도 권한을 바꾸지도 않고 확인만 한다.
#[cfg(unix)]
pub fn ensure_root_dir(target: &CommunityTarget) -> Result<(), String> {
    use std::os::unix::fs::{DirBuilderExt, MetadataExt, PermissionsExt};
    let root = &target.root;
    if !target.legacy {
        std::fs::DirBuilder::new()
            .recursive(true)
            .mode(0o700)
            .create(root)
            .map_err(|e| format!("오퍼레이터 뿌리를 만들지 못했다: `{}`: {e}", root.display()))?;
    }
    let st = std::fs::symlink_metadata(root)
        .map_err(|e| format!("오퍼레이터 뿌리를 보지 못했다: `{}`: {e}", root.display()))?;
    if st.file_type().is_symlink() {
        return Err(format!("오퍼레이터 뿌리가 심링크다: `{}`", root.display()));
    }
    if !st.is_dir() {
        return Err(format!("오퍼레이터 뿌리가 디렉터리가 아니다: `{}`", root.display()));
    }
    // SAFETY: getuid 는 실패하지 않는다.
    let uid = unsafe { libc::getuid() };
    if st.uid() != uid {
        return Err(format!(
            "오퍼레이터 뿌리의 주인이 내가 아니다(uid {}): `{}`",
            st.uid(),
            root.display()
        ));
    }
    if !target.legacy && st.mode() & 0o077 != 0 {
        std::fs::set_permissions(root, std::fs::Permissions::from_mode(0o700))
            .map_err(|e| format!("오퍼레이터 뿌리 권한을 좁히지 못했다: `{}`: {e}", root.display()))?;
    }
    Ok(())
}

#[cfg(not(unix))]
pub fn ensure_root_dir(target: &CommunityTarget) -> Result<(), String> {
    std::fs::create_dir_all(&target.root)
        .map_err(|e| format!("오퍼레이터 뿌리를 만들지 못했다: `{}`: {e}", target.root.display()))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn tmp(name: &str) -> PathBuf {
        let d = std::env::temp_dir().join(format!("hr-croot-{name}-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&d);
        std::fs::create_dir_all(&d).unwrap();
        d
    }

    #[test]
    fn hash_matches_shared_rule() {
        // shared: createHash('sha256').update('https://a.example').digest('hex').slice(0, 8)
        // 같은 입력의 sha256 은 언어와 무관하므로 끝 슬래시를 뗀 키가 같으면 뿌리가 같다.
        assert_eq!(hash_prefix("abc", 8), "ba7816bf");
        let home = Path::new("/h");
        let a = resolve(&tmp("hm"), home, "https://a.example/").unwrap();
        let b = resolve(&tmp("hm2"), home, "https://a.example").unwrap();
        assert_eq!(a.root, b.root);
        assert_eq!(a.key, "https://a.example");
        assert!(a.root.starts_with("/h/.harkroom-agent/c"));
    }

    #[test]
    fn index_entry_wins_and_legacy_is_kept() {
        let d = tmp("idx");
        std::fs::write(
            d.join(ROOTS_INDEX_FILE),
            r#"{"version":1,"communities":{"https://a.example":{"root":"/old/app/","legacy":true}}}"#,
        )
        .unwrap();
        let t = resolve(&d, Path::new("/h"), "https://a.example").unwrap();
        assert_eq!(t.root, PathBuf::from("/old/app"));
        assert!(t.legacy);
    }

    #[test]
    fn duplicate_roots_in_index_are_rejected() {
        let d = tmp("dup");
        std::fs::write(
            d.join(ROOTS_INDEX_FILE),
            r#"{"version":1,"communities":{"https://a":{"root":"/x/a"},"https://b":{"root":"/x/a/"}}}"#,
        )
        .unwrap();
        assert!(resolve(&d, Path::new("/h"), "https://c").is_err());
    }

    #[test]
    fn hash_collision_moves_to_16_chars() {
        let d = tmp("col");
        let home = Path::new("/h");
        let mine = computed_root(home, "https://b", 8);
        std::fs::write(
            d.join(ROOTS_INDEX_FILE),
            format!(
                r#"{{"version":1,"communities":{{"https://a":{{"root":"{}"}}}}}}"#,
                mine.display()
            ),
        )
        .unwrap();
        let t = resolve(&d, home, "https://b").unwrap();
        assert_eq!(t.root, computed_root(home, "https://b", 16));
    }

    #[cfg(unix)]
    #[test]
    fn root_dir_is_0700_and_symlink_rejected() {
        use std::os::unix::fs::PermissionsExt;
        let d = tmp("dir");
        let t = CommunityTarget { key: "k".into(), root: d.join("r"), legacy: false };
        ensure_root_dir(&t).unwrap();
        let mode = std::fs::metadata(&t.root).unwrap().permissions().mode() & 0o777;
        assert_eq!(mode, 0o700);
        std::fs::set_permissions(&t.root, std::fs::Permissions::from_mode(0o755)).unwrap();
        ensure_root_dir(&t).unwrap();
        assert_eq!(std::fs::metadata(&t.root).unwrap().permissions().mode() & 0o777, 0o700);

        let link = d.join("link");
        std::os::unix::fs::symlink(&t.root, &link).unwrap();
        let bad = CommunityTarget { key: "k".into(), root: link, legacy: false };
        assert!(ensure_root_dir(&bad).is_err());
    }

    #[test]
    fn record_root_writes_new_entry_once_and_refuses_shared_root() {
        let dir = std::env::temp_dir().join(format!("hk-cr-rec-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        let a = CommunityTarget { key: "https://a.example.com".into(), root: PathBuf::from("/r/a"), legacy: false };
        record_root(&dir, &a).unwrap();
        record_root(&dir, &a).unwrap();
        let idx = read_index(&dir).unwrap();
        assert_eq!(idx.communities.len(), 1);
        assert_eq!(idx.communities["https://a.example.com"].root, "/r/a");
        let b = CommunityTarget { key: "https://b.example.com".into(), root: PathBuf::from("/r/a/"), legacy: false };
        assert!(record_root(&dir, &b).is_err());
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            let mode = std::fs::metadata(dir.join(ROOTS_INDEX_FILE)).unwrap().permissions().mode() & 0o777;
            assert_eq!(mode, 0o600);
        }
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn check_same_community_rejects_cross_community_when_on() {
        // 스위치 env 는 프로세스 전역이라 이 시험 안에서만 켜고 끈다.
        std::env::set_var(PER_COMMUNITY_ENV, "1");
        assert!(check_same_community("https://a.example.com", Some("https://a.example.com/")).is_ok());
        assert!(check_same_community("https://a.example.com", Some("https://b.example.com")).is_err());
        assert!(check_same_community("https://a.example.com", None).is_ok());
        std::env::remove_var(PER_COMMUNITY_ENV);
        assert!(check_same_community("https://a.example.com", Some("https://b.example.com")).is_ok());
    }

    #[test]
    fn community_env_gives_legacy_only_for_legacy_entries() {
        let get = |env: &[(&str, Option<String>)], k: &str| env.iter().find(|(n, _)| *n == k).map(|(_, v)| v.clone()).unwrap();
        let legacy = CommunityTarget { key: "https://a.example.com".into(), root: PathBuf::from("/old/app-data"), legacy: true };
        let fresh = CommunityTarget { key: "https://b.example.com".into(), root: PathBuf::from("/h/.harkroom-agent/c/abcd1234"), legacy: false };
        let e = community_env(Some(&legacy));
        assert_eq!(get(&e, OPERATOR_LEGACY_ENV), Some("1".to_string()));
        assert_eq!(get(&e, OPERATOR_ROOT_ENV), Some("/old/app-data".to_string()));
        assert_eq!(get(&e, OPERATOR_COMMUNITY_ENV), Some("https://a.example.com".to_string()));
        let e = community_env(Some(&fresh));
        assert_eq!(get(&e, OPERATOR_LEGACY_ENV), None, "새 커뮤니티는 LEGACY 를 지운다");
        assert_eq!(get(&e, PER_COMMUNITY_ENV), Some("1".to_string()));
        let e = community_env(None);
        for k in [PER_COMMUNITY_ENV, OPERATOR_ROOT_ENV, OPERATOR_COMMUNITY_ENV, OPERATOR_LEGACY_ENV] {
            assert_eq!(get(&e, k), None, "꺼짐이면 {k} 를 지운다");
        }
    }

    fn tmp_root(tag: &str) -> PathBuf {
        let d = std::env::temp_dir().join(format!("hk-cr-{tag}-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&d);
        std::fs::create_dir_all(d.join("operator")).unwrap();
        d
    }

    #[test]
    fn adopt_legacy_splits_others_into_their_roots_and_revert_merges_back() {
        let d = tmp_root("adopt");
        let home = d.join("home");
        let a = "https://a.example.com";
        let b = "https://b.example.com";
        std::fs::write(
            d.join("operator").join("operator.json"),
            format!(r#"{{"merge":{{"ghUser":"g"}},"communities":{{"{a}/":{{"agents":{{"x":{{}}}}}},"{b}":{{"agents":{{"x":{{}},"y":{{}}}}}}}}}}"#),
        )
        .unwrap();
        std::fs::create_dir_all(d.join("operator").join("secrets")).unwrap();
        std::fs::write(d.join("operator").join("secrets").join(token_file_name(a)), "tok-a").unwrap();
        // 1·2단계: B(에이전트 더 많음)가 legacy, A 는 제 뿌리로 옮겨지고 옛 설정에서 빠진다.
        assert_eq!(adopt_legacy(&d, &home).unwrap().as_deref(), Some(b));
        let idx = read_index(&d).unwrap();
        assert_eq!(idx.communities[b].legacy, Some(true));
        let a_root = PathBuf::from(&idx.communities[a].root);
        assert!(a_root.starts_with(home.join(".harkroom-agent").join("c")));
        let a_cfg = read_json(&a_root.join("operator").join("operator.json")).unwrap().unwrap();
        assert_eq!(a_cfg["communities"].as_object().unwrap().keys().collect::<Vec<_>>(), vec![a]);
        assert_eq!(a_cfg["merge"]["ghUser"], "g");
        assert_eq!(std::fs::read_to_string(a_root.join("operator").join("secrets").join(token_file_name(a))).unwrap(), "tok-a");
        let legacy_cfg = read_json(&d.join("operator").join("operator.json")).unwrap().unwrap();
        assert_eq!(legacy_cfg["communities"].as_object().unwrap().keys().collect::<Vec<_>>(), vec![b]);
        // 다시 띄워도 그대로(legacy 는 색인에서 찾고 옛 설정에는 B 만).
        assert_eq!(adopt_legacy(&d, &home).unwrap().as_deref(), Some(b));
        // 되돌리기: A 칸을 옛 설정에 도로 합치고 색인은 .off 로.
        assert!(revert_index(&d).unwrap());
        assert!(!d.join(ROOTS_INDEX_FILE).exists());
        assert!(d.join(format!("{ROOTS_INDEX_FILE}.off")).exists());
        let back = read_json(&d.join("operator").join("operator.json")).unwrap().unwrap();
        let mut keys: Vec<_> = back["communities"].as_object().unwrap().keys().cloned().collect();
        keys.sort();
        assert_eq!(keys, vec![a.to_string(), b.to_string()]);
        assert!(!revert_index(&d).unwrap());
        // 다시 켜기: .off 를 되살리고(같은 A 뿌리) 다시 나눈다.
        assert_eq!(adopt_legacy(&d, &home).unwrap().as_deref(), Some(b));
        assert_eq!(PathBuf::from(&read_index(&d).unwrap().communities[a].root), a_root);
        let again = read_json(&d.join("operator").join("operator.json")).unwrap().unwrap();
        assert_eq!(again["communities"].as_object().unwrap().keys().collect::<Vec<_>>(), vec![b]);
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            assert_eq!(std::fs::metadata(d.join(ROOTS_INDEX_FILE)).unwrap().permissions().mode() & 0o777, 0o600);
            assert_eq!(std::fs::metadata(a_root.join("operator").join("operator.json")).unwrap().permissions().mode() & 0o777, 0o600);
        }
        let _ = std::fs::remove_dir_all(&d);
    }

    #[test]
    fn adopt_legacy_writes_nothing_without_old_config_and_refuses_broken_one() {
        let d = tmp_root("none");
        let home = d.join("home");
        assert_eq!(adopt_legacy(&d, &home).unwrap(), None);
        assert!(!d.join(ROOTS_INDEX_FILE).exists());
        std::fs::write(d.join("operator").join("operator.json"), r#"{"communities":{}}"#).unwrap();
        assert_eq!(adopt_legacy(&d, &home).unwrap(), None);
        std::fs::write(d.join("operator").join("operator.json"), "{").unwrap();
        assert!(adopt_legacy(&d, &home).is_err());
        assert!(!d.join(ROOTS_INDEX_FILE).exists());
        let _ = std::fs::remove_dir_all(&d);
    }
}
