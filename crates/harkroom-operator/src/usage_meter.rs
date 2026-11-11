//! 공급자 사용률 요청(s21c3d-3) — TS `claudeAccounts.ts::providerUsage`·`codexAccounts.ts::providerUsage`·
//! `server.ts::readUsageRequest` 의 Rust 판.
//!
//! - 측정은 `cli_then_api`(CLI 먼저, 안 되면 같은 공급자 API)를 **캐시**(`UsageCache`, TTL 2분) 너머로 한다.
//!   화면 요청과 폴러가 같은 계정을 따로 재지 않게 claude 캐시 하나를 함께 쓴다(TS `measureUsage`).
//! - 응답에는 잰 결과만 싣는다 — 토큰·URL·CLI 원문은 싣지 않는다(`Measured` 의 칸이 전부다).
//! - 계정마다 함께 잰다(TS `Promise.all`) — 다만 동시에 도는 측정은 `MAX_PARALLEL` 개까지다.

use std::path::{Path, PathBuf};
use std::sync::Arc;

use serde_json::{Map, Value, json};

use crate::claude_accounts::Layout;
use crate::provider_usage::cache::{CacheOpts, UsageCache};
use crate::provider_usage::cli::{
    PROBE_TIMEOUT, StdRunCommand, StdSpawnRpc, claude_cli_usage, codex_cli_usage,
    default_usage_probe_dir,
};
use crate::provider_usage::{
    Measured, UreqUsageHttp, cli_then_api, fetch_claude_provider_usage, fetch_codex_provider_usage,
    read_claude_token, read_codex_token,
};

/// 동시에 도는 측정(CLI 자식 프로세스) 상한. 계정이 많아도 `claude` 를 한꺼번에 수십 개 띄우지 않는다.
pub const MAX_PARALLEL: usize = 4;

/// TS `ProviderUsageRequest`.
#[derive(Debug, Clone, Default, PartialEq)]
pub struct UsageRequest {
    pub force: bool,
    pub pool: Option<String>,
    pub account: Option<String>,
}

/// TS `readUsageRequest` — 객체가 아니면 빈 요청, 칸의 타입이 틀리면 거절.
pub fn read_usage_request(payload: Option<&Value>) -> Result<UsageRequest, String> {
    let Some(Value::Object(o)) = payload else {
        return Ok(UsageRequest::default());
    };
    let force = match o.get("force") {
        None => false,
        Some(Value::Bool(b)) => *b,
        Some(_) => return Err("force 가 boolean 이 아니다".into()),
    };
    let text = |k: &str, msg: &str| -> Result<Option<String>, String> {
        match o.get(k) {
            None => Ok(None),
            Some(Value::String(s)) => Ok(Some(s.clone())),
            Some(_) => Err(msg.into()),
        }
    };
    let pool = text("pool", "pool 이 문자열이 아니다")?;
    let account = text("account", "account 가 문자열이 아니다")?;
    Ok(UsageRequest {
        force,
        pool,
        account,
    })
}

type MeasureDir = Arc<dyn Fn(&Path, f64) -> Measured + Send + Sync>;

/// claude·codex 사용률 측정기. 복제는 같은 캐시를 가리킨다.
#[derive(Clone)]
pub struct UsageMeters {
    pub claude_cache: Arc<UsageCache>,
    pub codex_cache: Arc<UsageCache>,
    claude: MeasureDir,
    codex: MeasureDir,
    now: Arc<dyn Fn() -> f64 + Send + Sync>,
}

fn wall_ms() -> f64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as f64)
        .unwrap_or(0.0)
}

impl UsageMeters {
    /// 운영 배선 — CLI 는 `claude`·`codex`, API 는 ureq, 캐시는 TTL 2분, 시계는 벽시계.
    pub fn system() -> Self {
        let probe: Arc<PathBuf> = Arc::new(default_usage_probe_dir());
        let http = Arc::new(UreqUsageHttp::default());
        let (p1, h1) = (probe.clone(), http.clone());
        let claude: MeasureDir = Arc::new(move |dir: &Path, at: f64| {
            cli_then_api(
                || claude_cli_usage(dir, at, &StdRunCommand, &p1),
                || fetch_claude_provider_usage(dir, at, h1.as_ref(), &read_claude_token),
            )
        });
        let codex: MeasureDir = Arc::new(move |home: &Path, at: f64| {
            cli_then_api(
                || codex_cli_usage(home, at, &StdSpawnRpc, &probe, PROBE_TIMEOUT),
                || fetch_codex_provider_usage(home, at, http.as_ref(), &read_codex_token),
            )
        });
        Self::with(
            UsageCache::system(),
            UsageCache::system(),
            claude,
            codex,
            Arc::new(wall_ms),
        )
    }

    pub fn with(
        claude_cache: Arc<UsageCache>,
        codex_cache: Arc<UsageCache>,
        claude: MeasureDir,
        codex: MeasureDir,
        now: Arc<dyn Fn() -> f64 + Send + Sync>,
    ) -> Self {
        UsageMeters {
            claude_cache,
            codex_cache,
            claude,
            codex,
            now,
        }
    }

    /// TS `measureUsage(dir, at, mode)` — claude 계정 하나. 폴러도 이것을 쓴다(같은 캐시).
    pub fn measure_claude(&self, dir: &Path, at: f64, opts: CacheOpts) -> Measured {
        let f = self.claude.clone();
        let d = dir.to_path_buf();
        self.claude_cache
            .get(&dir.to_string_lossy(), move || f(&d, at), opts)
    }

    fn measure_codex(&self, home: &Path, at: f64, opts: CacheOpts) -> Measured {
        let f = self.codex.clone();
        let h = home.to_path_buf();
        self.codex_cache
            .get(&home.to_string_lossy(), move || f(&h, at), opts)
    }

    /// 폴러 경로 — 지금 시각으로, 캐시 기본 모드(TS `port.measureUsage(configDir)`).
    pub fn poller_measure(&self, dir: &Path) -> Measured {
        self.measure_claude(dir, (self.now)(), CacheOpts::default())
    }

    /// TS `claudeAccounts.providerUsage(req)`.
    pub fn claude_snapshot(&self, layout: &Layout, req: &UsageRequest) -> Value {
        let at = (self.now)();
        let targets: Vec<(String, String, PathBuf)> = layout
            .pools
            .iter()
            .flat_map(|(pool, accounts)| {
                accounts
                    .iter()
                    .map(move |a| (pool.clone(), a.name.clone(), a.dir.clone()))
            })
            .collect();
        let want_pool = req.pool.clone().unwrap_or_default();
        let measured = in_batches(&targets, |(pool, name, dir)| {
            let forced = req.force
                && req
                    .account
                    .as_ref()
                    .is_none_or(|a| a == name && *pool == want_pool);
            self.measure_claude(dir, at, mode(forced))
        });
        let accounts = targets
            .iter()
            .zip(measured)
            .map(|((pool, name, _), m)| entry(name, Some(pool), &m))
            .collect::<Vec<_>>();
        json!({ "measuredAtMs": crate::provider_usage::ms_value(at), "accounts": accounts })
    }

    /// TS `codexAccounts.providerUsage(req)` — 시스템 기본 로그인(`''`) 먼저, 그다음 계정 폴더.
    pub fn codex_snapshot(&self, system_home: &Path, root: &Path, req: &UsageRequest) -> Value {
        let at = (self.now)();
        let mut homes = vec![(String::new(), system_home.to_path_buf())];
        homes.extend(
            crate::codex_accounts::subdirs(root)
                .into_iter()
                .map(|n| (n.clone(), root.join(n))),
        );
        let measured = in_batches(&homes, |(account, home)| {
            let forced = req.force && req.account.as_ref().is_none_or(|a| a == account);
            self.measure_codex(home, at, mode(forced))
        });
        let accounts = homes
            .iter()
            .zip(measured)
            .map(|((account, _), m)| entry(account, None, &m))
            .collect::<Vec<_>>();
        json!({ "measuredAtMs": crate::provider_usage::ms_value(at), "accounts": accounts })
    }
}

/// 화면 경로 — 지난 값을 곧바로 돌려주고 뒤에서 다시 잰다(`stale`). 사람이 [Refresh usage] 를 눌렀으면 새 값을 기다린다.
fn mode(forced: bool) -> CacheOpts {
    if forced {
        CacheOpts {
            force: true,
            stale: false,
        }
    } else {
        CacheOpts {
            stale: true,
            force: false,
        }
    }
}

/// TS `{ account, pool?, ...measured }` — `account`·`pool` 이 앞, 잰 칸이 뒤(키 순서도 TS 와 같다).
fn entry(account: &str, pool: Option<&str>, m: &Measured) -> Value {
    let mut o = Map::new();
    o.insert("account".into(), json!(account));
    if let Some(p) = pool {
        o.insert("pool".into(), json!(p));
    }
    if let Ok(Value::Object(rest)) = serde_json::to_value(m) {
        o.extend(rest);
    }
    Value::Object(o)
}

/// 차례를 지키며 `MAX_PARALLEL` 개씩 함께 돌린다. 한 측정이 panic 하면 그 칸은 `network` 실패로 친다.
fn in_batches<T: Sync>(items: &[T], f: impl Fn(&T) -> Measured + Sync) -> Vec<Measured> {
    let mut out = Vec::with_capacity(items.len());
    for chunk in items.chunks(MAX_PARALLEL) {
        std::thread::scope(|s| {
            let hs: Vec<_> = chunk.iter().map(|t| s.spawn(|| f(t))).collect();
            for h in hs {
                out.push(
                    h.join()
                        .unwrap_or_else(|_| Measured::failed(wall_ms(), "network")),
                );
            }
        });
    }
    out
}

#[cfg(test)]
mod tests;
