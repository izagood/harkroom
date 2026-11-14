//! claude 계정 풀의 **해석**(L3c-3a) — TS `packages/shared/src/claudeAccountLane.ts`(와 그것이 부르는
//! `claudePools.ts`·`operatorRoots.ts::claudePoolsFilePath`)의 Rust 판.
//!
//! 러너가 어느 계정으로 도는지(`load_claude_account_lane`)와 오퍼레이터가 「이 에이전트가 계정 풀로 도는가」
//! (`claude_account_use`)를 **같은 함수**로 판정하려고 공용 crate 로 둔다 — 판정을 베껴 두면 한쪽만 바뀌는 날
//! 에이전트가 다른 계정·과금으로 조용히 돈다.
//!
//! 정본은 TS 다. `golden/lane.json` 은 TS 함수를 **실행해서** 만든 값이고(`packages/shared/test/claudeAccountLaneGolden.test.ts`),
//! `tests/lane_golden.rs` 가 같은 입력으로 이 판을 돌려 한 칸이라도 다르면 실패한다. TS 의 버릇(순서 env 의 겹친 이름,
//! `order` 의 겹친 이름이 그대로 두 번 나오는 것, 커뮤니티 뿌리가 틀리면 해석은 암묵 풀로·판정은 `unreadable` 로 가는 것)도
//! 그대로 옮겼다 — 고치려면 TS 와 같이 고친다.
//!
//! 아직 아무 데도 붙이지 않았다(러너 연결은 L3c-3b, 오퍼레이터 판정은 L3c-3e).

use std::collections::HashMap;
use std::fs;
use std::io::ErrorKind;
use std::path::{Component, Path, PathBuf};

use serde_json::{Map, Value, json};

/// TS `CLAUDE_ACCOUNT_PATTERN`·`CLAUDE_POOL_NAME_PATTERN` = `^[a-z0-9-]{1,32}$`. 이 이름이 경로 세그먼트가 된다.
pub fn is_account_name(s: &str) -> bool {
    !s.is_empty()
        && s.len() <= 32
        && s.bytes()
            .all(|b| b.is_ascii_lowercase() || b.is_ascii_digit() || b == b'-')
}

/// TS `MAX_AGENT_POOLS`.
pub const MAX_AGENT_POOLS: usize = 16;

/// TS `ClaudeAccount`.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ClaudeAccount {
    pub name: String,
    /// 이 계정의 `CLAUDE_CONFIG_DIR`.
    pub config_dir: PathBuf,
    /// 이 계정이 든 풀. `None` 은 뿌리(암묵 풀)다 — TS 는 이때 `pool` 칸을 아예 싣지 않는다.
    pub pool: Option<String>,
}

/// TS `ClaudePoolLane` — 에이전트 풀 순서의 한 칸.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ClaudePoolLane {
    pub pool: String,
    pub accounts: Vec<ClaudeAccount>,
}

/// TS `loadClaudeAccountLane` 의 반환값.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ClaudeAccountLane {
    pub pool: Option<String>,
    pub accounts: Vec<ClaudeAccount>,
    /// 배정·기본 풀로 정해졌을 때만 있다(강제 풀·암묵 풀·없음은 `None`).
    pub chain: Option<Vec<ClaudePoolLane>>,
}

/// TS `claudeAccountUse` 의 반환값.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ClaudeAccountUse {
    None,
    Pool,
    /// 닫힌 쪽 — 부르는 쪽은 이것도 「풀로 돈다」로 다룬다.
    Unreadable,
}

impl ClaudeAccountUse {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::None => "none",
            Self::Pool => "pool",
            Self::Unreadable => "unreadable",
        }
    }
}

/// `ClaudePoolsConfig` 중 해석에 쓰는 칸. `assign`(배정 기준)은 여기서 쓰지 않는다.
#[derive(Debug, Clone, PartialEq, Eq, Default)]
pub struct PoolsConfig {
    pub default_pool: Option<String>,
    pub order: HashMap<String, Vec<String>>,
    pub agents: HashMap<String, Vec<String>>,
}

impl ClaudeAccount {
    /// TS 가 `JSON.stringify` 하는 모양(골든 대조용).
    pub fn to_json(&self) -> Value {
        let mut m = Map::new();
        m.insert("name".into(), json!(self.name));
        m.insert("configDir".into(), json!(self.config_dir.to_string_lossy()));
        if let Some(p) = &self.pool {
            m.insert("pool".into(), json!(p));
        }
        Value::Object(m)
    }
}

impl ClaudeAccountLane {
    /// TS 가 `JSON.stringify` 하는 모양(골든 대조용).
    pub fn to_json(&self) -> Value {
        let accounts =
            |a: &[ClaudeAccount]| Value::Array(a.iter().map(ClaudeAccount::to_json).collect());
        let mut m = Map::new();
        m.insert("pool".into(), json!(self.pool));
        m.insert("accounts".into(), accounts(&self.accounts));
        if let Some(chain) = &self.chain {
            m.insert(
                "chain".into(),
                Value::Array(
                    chain
                        .iter()
                        .map(|c| json!({ "pool": c.pool, "accounts": accounts(&c.accounts) }))
                        .collect(),
                ),
            );
        }
        Value::Object(m)
    }
}

fn is_unsafe_key(k: &str) -> bool {
    matches!(k, "__proto__" | "constructor" | "prototype")
}

fn name_of(v: &Value) -> Option<String> {
    v.as_str()
        .filter(|s| is_account_name(s))
        .map(str::to_string)
}

/// TS `parseClaudePoolsConfig`(해석에 쓰는 칸만) — 틀린 칸은 버리고 던지지 않는다.
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
            let (true, Some(list)) = (is_account_name(pool), list.as_array()) else {
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
            let items = match pools {
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
    cfg
}

/// TS `agentPoolChain`.
pub fn agent_pool_chain<'a>(cfg: &'a PoolsConfig, agent_id: &str) -> &'a [String] {
    cfg.agents.get(agent_id).map(Vec::as_slice).unwrap_or(&[])
}

/// TS `orderAccounts` — 설정 순서(디스크에 있는 것만, 겹친 이름도 그대로) 뒤에 설정에 없는 것을 사전순으로.
pub fn order_accounts(cfg: &PoolsConfig, pool: &str, found: &[String]) -> Vec<String> {
    let wanted = cfg.order.get(pool).map(Vec::as_slice).unwrap_or(&[]);
    let in_order: Vec<String> = wanted
        .iter()
        .filter(|n| found.contains(n))
        .cloned()
        .collect();
    let mut rest: Vec<String> = found
        .iter()
        .filter(|n| !in_order.contains(n))
        .cloned()
        .collect();
    rest.sort();
    in_order.into_iter().chain(rest).collect()
}

/// TS `claudeAccountsRoot` — `HARKROOM_CLAUDE_ACCOUNTS_DIR`, 없으면 `<home>/.harkroom-agent/claude-accounts`.
pub fn claude_accounts_root(get: impl Fn(&str) -> Option<String>, home: &Path) -> PathBuf {
    match get("HARKROOM_CLAUDE_ACCOUNTS_DIR") {
        Some(d) => PathBuf::from(d),
        None => home.join(".harkroom-agent").join("claude-accounts"),
    }
}

/// `path.resolve` 와 같은 글자 정규화(파일시스템을 보지 않는다).
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

/// TS `claudePoolsFilePath` — `HARKROOM_OPERATOR_PER_COMMUNITY=1` 이면 `<HARKROOM_OPERATOR_ROOT>/claude-pools.json`,
/// 아니면 `<계정 뿌리>/pools.json`. 켜졌는데 뿌리가 절대 경로가 아니면 `Err`.
pub fn claude_pools_file_path(
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

fn list_or_none(names: &[String]) -> String {
    if names.is_empty() {
        "(없음)".into()
    } else {
        names.join(", ")
    }
}

/// TS `loadClaudeAccounts` — 뿌리 아래 계정(사전순, 문법에 맞고 `stat` 으로 디렉터리인 것 — 링크를 따라간다).
/// 뿌리가 없거나 읽히지 않으면 빈 목록. `order`(`HARKROOM_CLAUDE_ACCOUNTS`)가 있으면 그 순서·부분집합이고,
/// 없는 이름이 있으면 `Err`.
pub fn load_claude_accounts(
    root: &Path,
    order: Option<&str>,
) -> Result<Vec<ClaudeAccount>, String> {
    let Ok(rd) = fs::read_dir(root) else {
        return Ok(Vec::new());
    };
    let mut named: Vec<String> = rd
        .filter_map(|e| e.ok())
        .filter_map(|e| e.file_name().into_string().ok())
        .filter(|n| is_account_name(n))
        .collect();
    named.sort();
    let found: Vec<String> = named
        .into_iter()
        .filter(|n| fs::metadata(root.join(n)).is_ok_and(|m| m.is_dir()))
        .collect();

    let account = |name: &str| ClaudeAccount {
        name: name.to_string(),
        config_dir: root.join(name),
        pool: None,
    };
    let order: Vec<&str> = order
        .unwrap_or("")
        .split(',')
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .collect();
    if order.is_empty() {
        return Ok(found.iter().map(|n| account(n)).collect());
    }
    let missing: Vec<String> = order
        .iter()
        .filter(|n| !found.iter().any(|f| f == *n))
        .map(|n| n.to_string())
        .collect();
    if !missing.is_empty() {
        return Err(format!(
            "HARKROOM_CLAUDE_ACCOUNTS 에 없는 계정이 있다: {}. {} 아래에 있는 계정은 {} 이다.",
            missing.join(", "),
            root.display(),
            list_or_none(&found),
        ));
    }
    Ok(order.iter().map(|n| account(n)).collect())
}

/// TS `readPoolsConfig` — **없으면(읽지 못하면) `None`, 깨졌으면 빈 설정**. 파일의 존재가 풀 모드 스위치다.
/// 커뮤니티 뿌리가 틀려 자리를 못 정해도 `None` 이다(TS 가 그 throw 를 읽기 실패로 받는다).
pub fn read_pools_config(root: &Path, get: impl Fn(&str) -> Option<String>) -> Option<PoolsConfig> {
    let path = claude_pools_file_path(root, get).ok()?;
    let bytes = fs::read(&path).ok()?;
    let text = String::from_utf8_lossy(&bytes);
    Some(match serde_json::from_str::<Value>(&text) {
        Ok(v) => parse_pools_config(&v),
        Err(_) => {
            eprintln!(
                "[claudeAccounts] pools.json 을 읽을 수 없다 — 빈 설정으로 본다: {}",
                path.display()
            );
            PoolsConfig::default()
        }
    })
}

fn accounts_in(
    root: &Path,
    pool: &str,
    cfg: &PoolsConfig,
    order: Option<&str>,
) -> Result<Vec<ClaudeAccount>, String> {
    let dir = root.join(pool);
    let with_pool = |a: ClaudeAccount| ClaudeAccount {
        pool: Some(pool.to_string()),
        ..a
    };
    if let Some(o) = order.filter(|o| !o.trim().is_empty()) {
        return Ok(load_claude_accounts(&dir, Some(o))?
            .into_iter()
            .map(with_pool)
            .collect());
    }
    let found: Vec<String> = load_claude_accounts(&dir, None)?
        .into_iter()
        .map(|a| a.name)
        .collect();
    Ok(order_accounts(cfg, pool, &found)
        .into_iter()
        .map(|name| ClaudeAccount {
            config_dir: dir.join(&name),
            name,
            pool: Some(pool.to_string()),
        })
        .collect())
}

/// TS `loadClaudeAccountLane` — 강제(`forced_pool` = `HARKROOM_CLAUDE_POOL`) → 에이전트 배정 → 기본 풀 → 암묵 풀 → 없음.
///
/// `order` 는 `HARKROOM_CLAUDE_ACCOUNTS`, `get` 은 env 읽기(`pools.json` 자리를 정한다). 강제 풀이 없는 풀이거나
/// `order` 에 없는 계정이 있으면 `Err`(TS 가 던지는 것과 같은 문구). 배정·기본 풀이 없는 풀이면 경고하고 건너뛴다.
pub fn load_claude_account_lane(
    root: &Path,
    agent_id: &str,
    forced_pool: Option<&str>,
    order: Option<&str>,
    get: impl Fn(&str) -> Option<String>,
) -> Result<ClaudeAccountLane, String> {
    let Some(cfg) = read_pools_config(root, get) else {
        return Ok(ClaudeAccountLane {
            pool: None,
            accounts: load_claude_accounts(root, order)?,
            chain: None,
        });
    };

    let pools: Vec<String> = load_claude_accounts(root, None)?
        .into_iter()
        .map(|p| p.name)
        .collect();

    if let Some(forced) = forced_pool.filter(|f| !f.is_empty()) {
        if !pools.iter().any(|p| p == forced) {
            return Err(format!(
                "HARKROOM_CLAUDE_POOL 이 없는 풀을 가리킨다: {forced}. {} 아래에 있는 풀은 {} 이다.",
                root.display(),
                list_or_none(&pools),
            ));
        }
        return Ok(ClaudeAccountLane {
            pool: Some(forced.to_string()),
            accounts: accounts_in(root, forced, &cfg, order)?,
            chain: None,
        });
    }

    let mut chain: Vec<ClaudePoolLane> = Vec::new();
    for candidate in agent_pool_chain(&cfg, agent_id) {
        if !pools.contains(candidate) {
            eprintln!(
                "[claudeAccounts] 에이전트 배정이 없는 풀을 가리킨다 — 건너뛴다: {candidate}"
            );
            continue;
        }
        chain.push(ClaudePoolLane {
            pool: candidate.clone(),
            accounts: accounts_in(root, candidate, &cfg, order)?,
        });
    }
    if !chain.is_empty() {
        // 대표값은 계정이 있는 첫 풀이다.
        let head = chain
            .iter()
            .find(|c| !c.accounts.is_empty())
            .unwrap_or(&chain[0])
            .clone();
        return Ok(ClaudeAccountLane {
            pool: Some(head.pool),
            accounts: head.accounts,
            chain: Some(chain),
        });
    }

    if let Some(default_pool) = &cfg.default_pool {
        if pools.contains(default_pool) {
            let accounts = accounts_in(root, default_pool, &cfg, order)?;
            return Ok(ClaudeAccountLane {
                pool: Some(default_pool.clone()),
                accounts: accounts.clone(),
                chain: Some(vec![ClaudePoolLane {
                    pool: default_pool.clone(),
                    accounts,
                }]),
            });
        }
        eprintln!("[claudeAccounts] 기본 풀이 없는 풀을 가리킨다 — 무시한다: {default_pool}");
    }
    Ok(ClaudeAccountLane {
        pool: None,
        accounts: Vec::new(),
        chain: None,
    })
}

/// TS `claudeAccountUse` — 이 에이전트의 러너가 계정 풀로 도는가. **닫힌 쪽으로 실패한다**: 뿌리가 있는데 읽지
/// 못하거나, `pools.json` 이 있는데 읽거나 해석하지 못하거나, 커뮤니티 뿌리가 틀리거나, 해석이 `Err` 면 `Unreadable`.
pub fn claude_account_use(
    agent_id: &str,
    forced_pool: Option<&str>,
    get: impl Fn(&str) -> Option<String>,
    home: &Path,
) -> ClaudeAccountUse {
    let root = claude_accounts_root(&get, home);
    if let Err(e) = fs::read_dir(&root)
        && e.kind() != ErrorKind::NotFound
    {
        return ClaudeAccountUse::Unreadable;
    }
    let Ok(path) = claude_pools_file_path(&root, &get) else {
        return ClaudeAccountUse::Unreadable;
    };
    match fs::read(&path) {
        Ok(bytes) => {
            if serde_json::from_str::<Value>(&String::from_utf8_lossy(&bytes)).is_err() {
                return ClaudeAccountUse::Unreadable;
            }
        }
        Err(e) if e.kind() != ErrorKind::NotFound => return ClaudeAccountUse::Unreadable,
        Err(_) => {}
    }
    let order = get("HARKROOM_CLAUDE_ACCOUNTS");
    match load_claude_account_lane(&root, agent_id, forced_pool, order.as_deref(), &get) {
        Ok(lane) => {
            let any = !lane.accounts.is_empty()
                || lane.chain.iter().flatten().any(|c| !c.accounts.is_empty());
            if any {
                ClaudeAccountUse::Pool
            } else {
                ClaudeAccountUse::None
            }
        }
        Err(_) => ClaudeAccountUse::Unreadable,
    }
}
