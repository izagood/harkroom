//! claude 계정 풀의 **파일시스템 연산**(s21c3a) — TS `packages/operator/src/claudeAccounts.ts` 의 구조 부분 이식.
//!
//! 이 파일이 맡는 것: `pools.json` 읽기·원자 쓰기, 이름 문법과 뿌리 아래 경로 확인(`under`, 두 겹),
//! 디스크 모양 읽기(`read_layout`), 기동 때 `order` 맞추기(`reconcile_order`).
//! 로그인·사용량·터미널은 뒤 PR(c3b·c3d·c4) 몫이다.
//!
//! 단일 writer 규칙은 TS 와 같다 — `pools.json` 의 writer 는 오퍼레이터 하나뿐이고 러너는 읽기만 한다.

use std::collections::BTreeSet;
use std::fs;
use std::io::Write;
use std::os::unix::fs::OpenOptionsExt;
use std::path::{Component, Path, PathBuf};

use indexmap::IndexMap;
use serde_json::{Map, Value, json};

/// TS `CLAUDE_POOL_NAME_PATTERN` = `^[a-z0-9-]{1,32}$`.
pub fn is_pool_name(s: &str) -> bool {
    !s.is_empty()
        && s.len() <= 32
        && s.bytes()
            .all(|b| b.is_ascii_lowercase() || b.is_ascii_digit() || b == b'-')
}

/// TS `MAX_AGENT_POOLS`.
pub const MAX_AGENT_POOLS: usize = 16;

/// TS `isUnsafeKey` — JS 프로토타입 키. Rust 에는 위험이 없지만 같은 입력을 같은 답으로 거절한다.
pub fn is_unsafe_key(k: &str) -> bool {
    matches!(k, "__proto__" | "constructor" | "prototype")
}

const THRESHOLD_KEYS: [&str; 4] = [
    "newSessionPct",
    "newWeeklyPct",
    "moveSessionPct",
    "moveWeeklyPct",
];

/// `ClaudePoolsConfig`. 키 순서는 파일·입력 그대로 둔다(TS 객체 삽입 순서).
#[derive(Debug, Clone, PartialEq, Default)]
pub struct PoolsConfig {
    pub default_pool: Option<String>,
    pub order: IndexMap<String, Vec<String>>,
    pub agents: IndexMap<String, Vec<String>>,
    /// 풀 → 기준 칸(1..=100 인 수만). 없음과 `{}` 는 같은 뜻.
    pub assign: IndexMap<String, Map<String, Value>>,
}

fn name_of(v: &Value) -> Option<String> {
    v.as_str().filter(|s| is_pool_name(s)).map(str::to_string)
}

fn thresholds(raw: &Value) -> Option<Map<String, Value>> {
    let obj = raw.as_object()?;
    let mut out = Map::new();
    for k in THRESHOLD_KEYS {
        if let Some(n) = obj.get(k).and_then(Value::as_f64)
            && n.is_finite()
            && (1.0..=100.0).contains(&n)
        {
            out.insert(k.to_string(), obj[k].clone());
        }
    }
    (!out.is_empty()).then_some(out)
}

/// TS `parseClaudePoolsConfig` — 틀린 칸은 버리고 던지지 않는다.
pub fn parse_pools_config(raw: &Value) -> PoolsConfig {
    let Some(obj) = raw.as_object() else {
        return PoolsConfig::default();
    };
    let mut cfg = PoolsConfig {
        default_pool: obj.get("defaultPool").and_then(name_of),
        ..PoolsConfig::default()
    };
    if let Some(order) = obj.get("order").and_then(Value::as_object) {
        for (pool, list) in order {
            let (true, Some(list)) = (is_pool_name(pool), list.as_array()) else {
                continue;
            };
            cfg.order
                .insert(pool.clone(), list.iter().filter_map(name_of).collect());
        }
    }
    if let Some(agents) = obj.get("agents").and_then(Value::as_object) {
        for (agent_id, pools) in agents {
            if is_unsafe_key(agent_id) {
                continue;
            }
            let items: Vec<Value> = match pools {
                Value::Array(a) => a.clone(),
                other => vec![other.clone()],
            };
            let mut list: Vec<String> = Vec::new();
            for n in items.iter().filter_map(name_of) {
                if !list.contains(&n) {
                    list.push(n);
                }
            }
            list.truncate(MAX_AGENT_POOLS);
            if !list.is_empty() {
                cfg.agents.insert(agent_id.clone(), list);
            }
        }
    }
    if let Some(assign) = obj.get("assign").and_then(Value::as_object) {
        for (pool, t) in assign {
            if !is_pool_name(pool) {
                continue;
            }
            if let Some(t) = thresholds(t) {
                cfg.assign.insert(pool.clone(), t);
            }
        }
    }
    cfg
}

/// IndexMap → JSON 객체(삽입 순서 유지). indexmap 에 serde 기능을 켜지 않는다.
pub fn map_json<V: Clone + Into<Value>>(m: &IndexMap<String, V>) -> Value {
    Value::Object(
        m.iter()
            .map(|(k, v)| (k.clone(), v.clone().into()))
            .collect(),
    )
}

impl PoolsConfig {
    /// 파일에 쓸 모양 — TS `writePoolsConfig` 와 같이 빈 `assign` 은 싣지 않는다.
    pub fn to_file_json(&self) -> Value {
        let mut out = Map::new();
        out.insert("defaultPool".into(), json!(self.default_pool));
        out.insert("order".into(), map_json(&self.order));
        out.insert("agents".into(), map_json(&self.agents));
        if !self.assign.is_empty() {
            out.insert("assign".into(), map_json(&self.assign));
        }
        Value::Object(out)
    }
}

/// 계정 풀 뿌리. 러너의 `claudeAccountsRoot()` 와 같은 값.
pub fn claude_accounts_root(get: impl Fn(&str) -> Option<String>, home: &str) -> PathBuf {
    match get("HARKROOM_CLAUDE_ACCOUNTS_DIR") {
        Some(d) => PathBuf::from(d),
        None => Path::new(home)
            .join(".harkroom-agent")
            .join("claude-accounts"),
    }
}

/// TS `claudePoolsFilePath` — 커뮤니티마다 프로세스 모드면 `<operatorRoot>/claude-pools.json`.
pub fn pools_file_path(
    accounts_root: &Path,
    get: impl Fn(&str) -> Option<String>,
) -> Result<PathBuf, String> {
    if get("HARKROOM_OPERATOR_PER_COMMUNITY").as_deref() != Some("1") {
        return Ok(accounts_root.join("pools.json"));
    }
    match get("HARKROOM_OPERATOR_ROOT") {
        Some(r) if r.starts_with('/') => Ok(normalize(Path::new(&r)).join("claude-pools.json")),
        _ => Err(
            "HARKROOM_OPERATOR_PER_COMMUNITY=1 인데 HARKROOM_OPERATOR_ROOT 가 절대 경로가 아니다"
                .into(),
        ),
    }
}

/// `path.resolve` 와 같은 글자 정규화(파일시스템을 보지 않는다 — 심링크를 풀지 않는다).
fn normalize(p: &Path) -> PathBuf {
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

/// TS `under` — 이름 문법 + 조립 결과가 뿌리 아래인지 **두 겹**으로 잰다(이 경로로 지우기가 돈다).
pub fn under(root: &Path, names: &[&str]) -> Result<PathBuf, String> {
    for n in names {
        if !is_pool_name(n) {
            return Err(format!(
                "이름이 문법에 맞지 않는다: {} (/^[a-z0-9-]{{1,32}}$/)",
                Value::from(*n)
            ));
        }
    }
    let base = normalize(root);
    let mut target = base.clone();
    for n in names {
        target.push(n);
    }
    let target = normalize(&target);
    if target != base && !target.starts_with(&base) {
        return Err(format!("뿌리 밖의 경로다: {}", target.display()));
    }
    Ok(target)
}

/// 지우기·옮기기 자리 — `under` 에 더해, 뿌리 아래 각 칸이 **심링크가 아닌지** 실제 디스크로 본다(#1908 security 낮음).
/// 글자 판정만으로는 `<root>/p` 가 심링크일 때 `<root>/p/a` 가 뿌리 밖을 가리킨다. 심링크면 거절한다(TS 보다 좁다).
pub fn under_no_symlink(root: &Path, names: &[&str]) -> Result<PathBuf, String> {
    let target = under(root, names)?;
    let mut at = normalize(root);
    for n in names {
        at.push(n);
        if fs::symlink_metadata(&at).is_ok_and(|m| m.file_type().is_symlink()) {
            return Err(format!(
                "심링크 경로는 지우거나 옮기지 않는다: {}",
                at.display()
            ));
        }
    }
    Ok(target)
}

/// 하위 디렉터리 이름(사전순, 문법에 맞는 것만). 심링크를 따라간다(`stat`) — 러너와 같은 규율.
pub fn subdirs(dir: &Path) -> Vec<String> {
    let Ok(rd) = fs::read_dir(dir) else {
        return Vec::new();
    };
    let mut names: Vec<String> = rd
        .filter_map(|e| e.ok())
        .filter_map(|e| e.file_name().into_string().ok())
        .filter(|n| is_pool_name(n))
        .collect();
    names.sort();
    names
        .into_iter()
        .filter(|n| {
            fs::metadata(dir.join(n))
                .map(|m| m.is_dir())
                .unwrap_or(false)
        })
        .collect()
}

/// 계정이었던 디렉터리인가 — 관측 가능한 표식은 이 두 파일뿐이다.
pub fn looks_like_account(dir: &Path) -> bool {
    [".credentials.json", ".claude.json"]
        .iter()
        .any(|f| fs::metadata(dir.join(f)).is_ok())
}

/// `pools.json` 읽기. 없음 = `None`(평평한 구조 스위치), 깨짐 = 빈 설정.
pub fn read_pools_config(path: &Path) -> Option<PoolsConfig> {
    let text = fs::read_to_string(path).ok()?;
    Some(match serde_json::from_str::<Value>(&text) {
        Ok(v) => parse_pools_config(&v),
        Err(_) => parse_pools_config(&Value::Null),
    })
}

/// 원자 쓰기 — 유일 임시 이름(0600) → rename. TS `writePoolsConfig`(2칸 들여쓰기 + 끝 줄바꿈).
pub fn write_pools_config(path: &Path, cfg: &PoolsConfig) -> std::io::Result<()> {
    let suffix = crate::endpoint::random_hex(16)?;
    let mut tmp = path.as_os_str().to_owned();
    tmp.push(format!(".tmp-{suffix}"));
    let tmp = PathBuf::from(tmp);
    let mut text = serde_json::to_string_pretty(&cfg.to_file_json())
        .map_err(|e| std::io::Error::other(e.to_string()))?;
    text.push('\n');
    let res = (|| {
        let mut f = fs::OpenOptions::new()
            .write(true)
            .create_new(true)
            .mode(0o600)
            .open(&tmp)?;
        f.write_all(text.as_bytes())?;
        f.sync_all()?;
        fs::rename(&tmp, path)
    })();
    if res.is_err() {
        let _ = fs::remove_file(&tmp);
    }
    res
}

/// TS `updatePoolOrder` — 파일이 없거나 깨졌거나 객체가 아니면 **쓰지 않는다**(사람이 손댄 값을 덮지 않는다).
/// 바뀐 것이 없어도 쓰지 않는다. 썼으면 참.
pub fn update_pool_order(
    path: &Path,
    edit: impl FnOnce(&IndexMap<String, Vec<String>>) -> IndexMap<String, Vec<String>>,
) -> std::io::Result<bool> {
    let Ok(text) = fs::read_to_string(path) else {
        return Ok(false);
    };
    let Ok(raw) = serde_json::from_str::<Value>(&text) else {
        return Ok(false);
    };
    if !raw.is_object() {
        return Ok(false);
    }
    let cfg = parse_pools_config(&raw);
    let next = edit(&cfg.order);
    // TS 는 JSON.stringify 비교 — 키 순서까지 같아야 같다.
    if next == cfg.order && next.keys().eq(cfg.order.keys()) {
        return Ok(false);
    }
    write_pools_config(path, &PoolsConfig { order: next, ..cfg })?;
    Ok(true)
}

/// 계정 하나의 자리.
#[derive(Debug, Clone, PartialEq)]
pub struct AccountDir {
    pub name: String,
    pub dir: PathBuf,
}

#[derive(Debug, Clone, PartialEq)]
pub struct Layout {
    pub root: PathBuf,
    pub pools_mode: bool,
    pub default_pool: Option<String>,
    pub agents: IndexMap<String, Vec<String>>,
    pub assign: IndexMap<String, Map<String, Value>>,
    pub strays: Vec<String>,
    /// 계정이 없는 풀도 들어 있다.
    pub pools: Vec<(String, Vec<AccountDir>)>,
}

fn dirs_of(parent: &Path) -> Vec<AccountDir> {
    subdirs(parent)
        .into_iter()
        .map(|name| AccountDir {
            dir: parent.join(&name),
            name,
        })
        .collect()
}

/// TS `readClaudeAccountsLayout` — 디스크 모양 그대로, 상태는 재지 않는다.
pub fn read_layout(root: &Path, pools_path: &Path) -> Layout {
    let Some(cfg) = read_pools_config(pools_path) else {
        let accounts = dirs_of(root);
        return Layout {
            root: root.to_path_buf(),
            pools_mode: false,
            default_pool: None,
            agents: IndexMap::new(),
            assign: IndexMap::new(),
            strays: Vec::new(),
            pools: if accounts.is_empty() {
                Vec::new()
            } else {
                vec![(String::new(), accounts)]
            },
        };
    };
    let mut pools = Vec::new();
    let mut strays = Vec::new();
    for name in subdirs(root) {
        let dir = root.join(&name);
        if looks_like_account(&dir) {
            strays.push(name);
            continue;
        }
        pools.push((name, dirs_of(&dir)));
    }
    Layout {
        root: root.to_path_buf(),
        pools_mode: true,
        default_pool: cfg.default_pool,
        agents: cfg.agents,
        assign: cfg.assign,
        strays,
        pools,
    }
}

/// TS `reconcileOrder` — 디스크에 있는데 `order` 에 없는 계정은 끝에, 없는 이름은 뺀다.
/// `order` 에 없는 풀은 건드리지 않는다(TS 와 같다). 평평한 구조·깨진 파일은 그대로.
pub fn reconcile_order(
    root: &Path,
    pools_path: &Path,
) -> std::io::Result<(Vec<String>, Vec<String>)> {
    let layout = read_layout(root, pools_path);
    let mut added = Vec::new();
    let mut removed = Vec::new();
    if !layout.pools_mode {
        return Ok((added, removed));
    }
    let on_disk: IndexMap<String, Vec<String>> = layout
        .pools
        .iter()
        .map(|(p, a)| (p.clone(), a.iter().map(|x| x.name.clone()).collect()))
        .collect();
    update_pool_order(pools_path, |order| {
        let mut next: IndexMap<String, Vec<String>> = IndexMap::new();
        for (pool, list) in order {
            let Some(found) = on_disk.get(pool) else {
                next.insert(pool.clone(), list.clone());
                continue;
            };
            let kept: Vec<String> = list.iter().filter(|n| found.contains(n)).cloned().collect();
            for n in list {
                if !kept.contains(n) {
                    removed.push(format!("{pool}/{n}"));
                }
            }
            next.insert(pool.clone(), kept);
        }
        for (pool, found) in &on_disk {
            let Some(list) = next.get_mut(pool) else {
                continue;
            };
            for n in found {
                if !list.contains(n) {
                    list.push(n.clone());
                    added.push(format!("{pool}/{n}"));
                }
            }
        }
        next
    })?;
    Ok((added, removed))
}

/// 설정에 나오는 풀 이름 전부(만들 디렉터리) — TS `configure` 의 Set 순서.
pub fn pools_to_create(cfg: &PoolsConfig) -> Vec<String> {
    let mut seen = BTreeSet::new();
    let mut out = Vec::new();
    let all = cfg
        .default_pool
        .iter()
        .chain(cfg.order.keys())
        .chain(cfg.agents.values().flatten());
    for n in all {
        if seen.insert(n.clone()) {
            out.push(n.clone());
        }
    }
    out
}

/// 이 config 디렉터리의 Keychain 서비스 이름(실측 규칙): `Claude Code-credentials-<sha256(dir) 앞 8자>`.
pub fn keychain_service(config_dir: &Path) -> String {
    let d = ring::digest::digest(
        &ring::digest::SHA256,
        config_dir.as_os_str().as_encoded_bytes(),
    );
    let hex: String = d.as_ref().iter().map(|b| format!("{b:02x}")).collect();
    format!("Claude Code-credentials-{}", &hex[..8])
}

/// 절대 경로로 부른다 — PATH 에 끼운 가짜 `security` 가 서비스·계정 이름을 받는 길을 닫는다(#1908 security 낮음).
const SECURITY_BIN: &str = "/usr/bin/security";

fn security_cmd(verb: &str, config_dir: &Path) -> bool {
    if !cfg!(target_os = "macos") {
        return false;
    }
    let user = std::env::var("USER").unwrap_or_default();
    // `-w`(값 출력)를 붙이지 않는다 — 존재만 보고, 토큰 바이트가 이 프로세스를 지나지 않게 한다.
    let mut child = match std::process::Command::new(SECURITY_BIN)
        .args([verb, "-s", &keychain_service(config_dir), "-a", &user])
        .stdin(std::process::Stdio::null())
        .stdout(std::process::Stdio::null())
        .stderr(std::process::Stdio::null())
        .spawn()
    {
        Ok(c) => c,
        Err(_) => return false,
    };
    // TS 와 같은 10초 제한.
    let deadline = std::time::Instant::now() + std::time::Duration::from_secs(10);
    loop {
        match child.try_wait() {
            Ok(Some(st)) => return st.success(),
            Ok(None) if std::time::Instant::now() < deadline => {
                std::thread::sleep(std::time::Duration::from_millis(20));
            }
            _ => {
                let _ = child.kill();
                let _ = child.wait();
                return false;
            }
        }
    }
}

/// Keychain 항목이 있는가(값은 읽지 않는다).
pub fn os_has_keychain(config_dir: &Path) -> bool {
    security_cmd("find-generic-password", config_dir)
}

/// Keychain 항목을 지운다. 실패해도 계정 삭제를 막지 않는다(TS 와 같다).
pub fn os_delete_keychain(config_dir: &Path) {
    let _ = security_cmd("delete-generic-password", config_dir);
}

fn read_oauth_account(config_dir: &Path) -> Option<Map<String, Value>> {
    let text = fs::read_to_string(config_dir.join(".claude.json")).ok()?;
    let v: Value = serde_json::from_str(&text).ok()?;
    v.get("oauthAccount")?.as_object().cloned()
}

/// TS `accountStatusFromDisk` — 정체는 `.claude.json` 의 `oauthAccount`, 자격은 파일 또는 Keychain **존재**.
pub fn account_status_from_disk(config_dir: &Path, has_keychain: &dyn Fn(&Path) -> bool) -> Value {
    let Some(oauth) = read_oauth_account(config_dir) else {
        return json!({ "loggedIn": false });
    };
    let has_file = fs::metadata(config_dir.join(".credentials.json")).is_ok();
    if !has_file && !has_keychain(config_dir) {
        return json!({ "loggedIn": false });
    }
    let mut out = Map::new();
    out.insert("loggedIn".into(), Value::Bool(true));
    for (from, to) in [
        ("emailAddress", "email"),
        ("organizationName", "orgName"),
        ("organizationUuid", "orgId"),
        ("accountUuid", "accountId"),
    ] {
        if let Some(s) = oauth.get(from).and_then(Value::as_str) {
            out.insert(to.into(), Value::from(s));
        }
    }
    Value::Object(out)
}

/// 관문(`.harkroom-attention.json`, kind gate)·로그인 풀림(`.harkroom-auth.json`, kind credential) 표식의 시각.
/// 없거나 깨졌으면 `None`. 서 있음 = `atMs <= now + 60s`(시한 없음, TS `isAttentionActive`).
fn active_mark(config_dir: &Path, file: &str, kind: &str, now_ms: f64) -> Option<f64> {
    let text = fs::read_to_string(config_dir.join(file)).ok()?;
    let v: Value = serde_json::from_str(&text).ok()?;
    if v.get("kind").and_then(Value::as_str) != Some(kind) {
        return None;
    }
    let at = v
        .get("atMs")
        .and_then(Value::as_f64)
        .filter(|n| n.is_finite())?;
    (at <= now_ms + 60_000.0).then_some(at)
}

fn at_ms_json(at: f64) -> Value {
    if at.fract() == 0.0 && at.abs() < 9.0e15 {
        json!({ "atMs": at as i64 })
    } else {
        json!({ "atMs": at })
    }
}

type StatusFn = Box<dyn Fn(&Path) -> bool + Send + Sync>;
type DeleteFn = Box<dyn Fn(&Path) + Send + Sync>;

/// 계정 구조 포트(TS `ClaudeAccountsPort` 의 list·configure·removeAccount·removePool·move·reconcileOrder).
pub struct ClaudeAccounts {
    root: PathBuf,
    pools_path: PathBuf,
    has_keychain: StatusFn,
    delete_keychain: DeleteFn,
    now_ms: fn() -> f64,
}

fn wall_ms() -> f64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as f64)
        .unwrap_or(0.0)
}

fn is_dir(p: &Path) -> bool {
    fs::metadata(p).map(|m| m.is_dir()).unwrap_or(false)
}

impl ClaudeAccounts {
    /// 운영 배선 — Keychain 은 `security`, 시계는 벽시계.
    pub fn new(root: PathBuf, pools_path: PathBuf) -> Self {
        Self::with(
            root,
            pools_path,
            Box::new(os_has_keychain),
            Box::new(os_delete_keychain),
            wall_ms,
        )
    }

    pub fn with(
        root: PathBuf,
        pools_path: PathBuf,
        has_keychain: StatusFn,
        delete_keychain: DeleteFn,
        now_ms: fn() -> f64,
    ) -> Self {
        Self {
            root,
            pools_path,
            has_keychain,
            delete_keychain,
            now_ms,
        }
    }

    pub fn root(&self) -> &Path {
        &self.root
    }

    pub fn pools_path(&self) -> &Path {
        &self.pools_path
    }

    fn status(&self, dir: &Path) -> Value {
        account_status_from_disk(dir, &*self.has_keychain)
    }

    /// `claudeAccountsList` 답 — TS `ClaudeAccountsSnapshot` 과 같은 키 순서.
    pub fn list(&self) -> Value {
        let layout = read_layout(&self.root, &self.pools_path);
        let now = (self.now_ms)();
        let pools: Vec<Value> = layout
            .pools
            .iter()
            .map(|(name, accounts)| {
                let accounts: Vec<Value> = accounts
                    .iter()
                    .map(|a| {
                        let mut v = Map::new();
                        v.insert("name".into(), Value::from(a.name.as_str()));
                        v.insert("status".into(), self.status(&a.dir));
                        if let Some(at) =
                            active_mark(&a.dir, ".harkroom-attention.json", "gate", now)
                        {
                            v.insert("attention".into(), at_ms_json(at));
                        }
                        if let Some(at) =
                            active_mark(&a.dir, ".harkroom-auth.json", "credential", now)
                        {
                            v.insert("authFailure".into(), at_ms_json(at));
                        }
                        Value::Object(v)
                    })
                    .collect();
                json!({ "name": name, "accounts": accounts })
            })
            .collect();
        json!({
            "root": layout.root.to_string_lossy(),
            "mode": if layout.pools_mode { "pools" } else { "flat" },
            "defaultPool": layout.default_pool,
            "agents": map_json(&layout.agents),
            "assign": map_json(&layout.assign),
            "pools": pools,
            "strays": layout.strays,
        })
    }

    /// TS `configure` — 이름이 하나라도 정규화에서 떨어지면 던진다(UI·디스크 어긋남을 잡는 자리).
    pub fn configure(&self, raw: &Value) -> Result<(), String> {
        let mut norm = parse_pools_config(raw);
        let sent_default = raw.get("defaultPool").and_then(Value::as_str);
        if raw.get("assign").is_none() {
            norm.assign = read_pools_config(&self.pools_path)
                .map(|c| c.assign)
                .unwrap_or_default();
        }
        if norm.default_pool.as_deref() != sent_default {
            return Err(format!(
                "defaultPool 이 문법에 맞지 않는다: {}",
                raw.get("defaultPool")
                    .map(Value::to_string)
                    .unwrap_or_else(|| "undefined".into())
            ));
        }
        let empty = Map::new();
        let order = raw
            .get("order")
            .and_then(Value::as_object)
            .unwrap_or(&empty);
        if norm.order.len() != order.len() {
            return Err("order 에 문법에 맞지 않는 풀 이름이 있다".into());
        }
        for (pool, list) in order {
            let sent = list.as_array().map(Vec::len).unwrap_or(0);
            if norm.order.get(pool).map(Vec::len).unwrap_or(0) != sent {
                return Err(format!(
                    "order[{pool}] 에 문법에 맞지 않는 계정 이름이 있다"
                ));
            }
        }
        let agents = raw
            .get("agents")
            .and_then(Value::as_object)
            .unwrap_or(&empty);
        if norm.agents.len() != agents.len() {
            return Err("agents 에 문법에 맞지 않는 풀 이름이 있다".into());
        }
        for (agent_id, list) in agents {
            let sent = list.as_array().map(Vec::len).unwrap_or(1);
            if norm.agents.get(agent_id).map(Vec::len).unwrap_or(0) != sent {
                return Err(format!(
                    "agents[{agent_id}] 에 문법에 맞지 않거나 겹친 풀 이름이 있다"
                ));
            }
        }
        mkdir_700(&self.root).map_err(|e| e.to_string())?;
        for name in pools_to_create(&norm) {
            mkdir_700(&under(&self.root, &[&name])?).map_err(|e| e.to_string())?;
        }
        write_pools_config(&self.pools_path, &norm).map_err(|e| e.to_string())
    }

    pub fn remove_account(&self, pool: &str, account: &str) -> Result<(), String> {
        let dir = under_no_symlink(&self.root, &[pool, account])?;
        if !is_dir(&dir) {
            return Err(format!("계정이 없다: {pool}/{account}"));
        }
        fs::remove_dir_all(&dir).map_err(|e| e.to_string())?;
        (self.delete_keychain)(&dir);
        if let Some(cfg) = read_pools_config(&self.pools_path)
            && let Some(list) = cfg
                .order
                .get(pool)
                .filter(|l| l.iter().any(|n| n == account))
        {
            let mut order = cfg.order.clone();
            order.insert(
                pool.to_string(),
                list.iter().filter(|n| *n != account).cloned().collect(),
            );
            write_pools_config(&self.pools_path, &PoolsConfig { order, ..cfg })
                .map_err(|e| e.to_string())?;
        }
        Ok(())
    }

    pub fn remove_pool(&self, pool: &str) -> Result<(), String> {
        let dir = under_no_symlink(&self.root, &[pool])?;
        if !is_dir(&dir) {
            return Err(format!("풀이 없다: {pool}"));
        }
        fs::remove_dir_all(&dir).map_err(|e| e.to_string())
    }

    /// 평평한 계정을 풀로 옮긴다. 이름이 겹치면 거절한다. `order` 실패는 옮김을 되돌리지 않는다(TS 와 같다).
    pub fn move_account(&self, account: &str, to_pool: &str) -> Result<Value, String> {
        let from = under_no_symlink(&self.root, &[account])?;
        let pool_dir = under_no_symlink(&self.root, &[to_pool])?;
        let to = under(&self.root, &[to_pool, account])?;
        if !is_dir(&from) {
            return Err(format!("옮길 계정이 없다: {account}"));
        }
        if !is_dir(&pool_dir) {
            return Err(format!("대상 풀이 없다: {to_pool}"));
        }
        if fs::symlink_metadata(&to).is_ok() {
            return Err(format!("대상에 같은 이름이 이미 있다: {to_pool}/{account}"));
        }
        fs::rename(&from, &to).map_err(|e| e.to_string())?;
        let _ = update_pool_order(&self.pools_path, |order| {
            let mut next: IndexMap<String, Vec<String>> = order
                .iter()
                .map(|(p, l)| {
                    let l = if p == to_pool {
                        l.clone()
                    } else {
                        l.iter().filter(|n| *n != account).cloned().collect()
                    };
                    (p.clone(), l)
                })
                .collect();
            let list = next.entry(to_pool.to_string()).or_default();
            if !list.iter().any(|n| n == account) {
                list.push(account.to_string());
            }
            next
        });
        let logged_in = self.status(&to).get("loggedIn") == Some(&Value::Bool(true));
        Ok(json!({ "loggedIn": logged_in }))
    }

    pub fn reconcile_order(&self) -> std::io::Result<(Vec<String>, Vec<String>)> {
        reconcile_order(&self.root, &self.pools_path)
    }
}

fn mkdir_700(p: &Path) -> std::io::Result<()> {
    use std::os::unix::fs::DirBuilderExt;
    fs::DirBuilder::new().recursive(true).mode(0o700).create(p)
}

/// TS `readPoolsConfigPayload` — 모양만 잰다. 이름 문법은 `configure` 가 다시 잰다(떨어지면 던지게).
/// 옛 UI 의 `agents.<id>: "pool"` 은 길이 1 목록으로 받는다.
pub fn read_configure_payload(payload: Option<&Value>) -> Result<Value, String> {
    let Some(obj) = payload.and_then(Value::as_object) else {
        return Err("payload 가 객체가 아니다".into());
    };
    let default_pool = match obj.get("defaultPool") {
        Some(Value::Null) => Value::Null,
        Some(Value::String(s)) => Value::from(s.as_str()),
        _ => return Err("defaultPool 이 문자열도 null 도 아니다".into()),
    };
    let Some(order) = obj.get("order").and_then(Value::as_object) else {
        return Err("order 가 객체가 아니다".into());
    };
    let Some(agents) = obj.get("agents").and_then(Value::as_object) else {
        return Err("agents 가 객체가 아니다".into());
    };
    let str_list = |v: &Value| {
        v.as_array()
            .filter(|a| a.iter().all(Value::is_string))
            .cloned()
    };
    let mut out_order = Map::new();
    for (pool, list) in order {
        let Some(list) = str_list(list) else {
            return Err(format!("order.{pool} 가 문자열 배열이 아니다"));
        };
        if is_unsafe_key(pool) {
            return Err(format!("order 에 쓸 수 없는 키가 있다: {pool}"));
        }
        out_order.insert(pool.clone(), Value::Array(list));
    }
    let mut out_agents = Map::new();
    for (agent_id, pools) in agents {
        let list = match pools {
            Value::String(_) => Some(vec![pools.clone()]),
            other => str_list(other),
        };
        let Some(list) = list else {
            return Err(format!("agents.{agent_id} 가 문자열 배열이 아니다"));
        };
        if is_unsafe_key(agent_id) {
            return Err(format!("agents 에 쓸 수 없는 키가 있다: {agent_id}"));
        }
        if list.len() > MAX_AGENT_POOLS {
            return Err(format!(
                "agents.{agent_id} 풀이 {MAX_AGENT_POOLS}개를 넘는다"
            ));
        }
        out_agents.insert(agent_id.clone(), Value::Array(list));
    }
    let mut out = Map::new();
    out.insert("defaultPool".into(), default_pool);
    out.insert("order".into(), Value::Object(out_order));
    out.insert("agents".into(), Value::Object(out_agents));
    match obj.get("assign") {
        None => {}
        Some(a @ Value::Object(_)) => {
            out.insert("assign".into(), a.clone());
        }
        Some(_) => return Err("assign 이 객체가 아니다".into()),
    }
    Ok(Value::Object(out))
}

fn non_empty_str<'a>(obj: &'a Map<String, Value>, key: &str, msg: &str) -> Result<&'a str, String> {
    match obj.get(key).and_then(Value::as_str) {
        Some(s) if !s.is_empty() => Ok(s),
        _ => Err(msg.into()),
    }
}

fn payload_obj(payload: Option<&Value>) -> Result<&Map<String, Value>, String> {
    payload
        .and_then(Value::as_object)
        .ok_or_else(|| "payload 가 객체가 아니다".to_string())
}

/// TS `readAccountRef`.
pub fn read_account_ref(payload: Option<&Value>) -> Result<(String, String), String> {
    let o = payload_obj(payload)?;
    let pool = non_empty_str(o, "pool", "pool 이 없다")?;
    let account = non_empty_str(o, "account", "account 가 없다")?;
    Ok((pool.into(), account.into()))
}

/// TS `readPoolRef`.
pub fn read_pool_ref(payload: Option<&Value>) -> Result<String, String> {
    Ok(non_empty_str(payload_obj(payload)?, "pool", "pool 이 없다")?.into())
}

/// TS `readAccountMove`.
pub fn read_account_move(payload: Option<&Value>) -> Result<(String, String), String> {
    let o = payload_obj(payload)?;
    let account = non_empty_str(o, "account", "account 가 없다")?;
    let to_pool = non_empty_str(o, "toPool", "toPool 이 없다")?;
    Ok((account.into(), to_pool.into()))
}

#[cfg(test)]
#[path = "claude_accounts/tests.rs"]
mod tests;
