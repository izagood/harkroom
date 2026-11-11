//! 공급자 한도 사용률(s21c3d-1). 정본은 `packages/operator/src/providerUsage.ts`(토큰 읽기·API 조회·응답
//! 해석·꼬리표)와 `usageChain.ts`(`cliThenApi` — CLI 먼저, 실패하면 API · `createUsageCache`)다.
//! CLI 실행(`cliUsage.ts`)은 `cli`(c3d-2), socket 요청은 c3d-3 이다.
//!
//! ## 토큰을 다루는 규율(TS 와 같다)
//! - **읽기만 한다.** 만료된 토큰을 갱신하지 않는다 — 그 파일·Keychain 의 주인은 CLI 다.
//! - 토큰은 이 모듈의 함수 인자 밖으로 나가지 않는다. 결과·오류 꼬리표·로그에 싣지 않는다.
//!
//! 화면(`ProviderUsageBars.tsx`)이 이 JSON 을 그대로 읽으므로 키 이름·빠지는 칸(`undefined` → 키 없음)을
//! TS 와 똑같이 맞춘다.
use std::fs;
use std::io::Read;
use std::path::Path;
use std::process::{Command, Stdio};
use std::time::{Duration, Instant};

use serde::Serialize;
use serde_json::Value;

pub const CLAUDE_OAUTH_USAGE_URL: &str = "https://api.anthropic.com/api/oauth/usage";
pub const CODEX_WHAM_USAGE_URL: &str = "https://chatgpt.com/backend-api/wham/usage";

/// 한도 창 하나. TS `ProviderUsageWindow`.
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct UsageWindow {
    pub used_percent: f64,
    pub resets_at_ms: Option<f64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub window_minutes: Option<f64>,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct ExtraWindow {
    pub label: String,
    pub window: UsageWindow,
}

/// TS `Omit<ProviderAccountUsage, 'account' | 'pool'>` — 잰 값. `account`·`pool` 은 요청 처리에서 붙인다.
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Measured {
    pub fetched_at_ms: f64,
    pub session: Option<UsageWindow>,
    pub weekly: Option<UsageWindow>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub extra: Option<Vec<ExtraWindow>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub plan: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
    /// TS 는 `{ ...a, source }` 로 맨 뒤에 붙인다 — 키 순서도 그대로.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub source: Option<&'static str>,
}

impl Measured {
    /// TS `{ fetchedAtMs: now, session: null, weekly: null, error }`.
    pub fn failed(now: f64, error: &str) -> Self {
        Measured {
            source: None,
            session: None,
            weekly: None,
            extra: None,
            plan: None,
            fetched_at_ms: now,
            error: Some(error.into()),
        }
    }
}

/// TS `num` — 유한한 수만.
fn num(v: Option<&Value>) -> Option<f64> {
    v.and_then(Value::as_f64).filter(|n| n.is_finite())
}

fn clamp_percent(p: f64) -> f64 {
    p.clamp(0.0, 100.0)
}

/// RFC 3339 → epoch ms. TS `Date.parse` 가 읽는 판(서버가 주는 `…Z`·`…+00:00`, 소수 초)만 다룬다.
fn parse_iso_ms(s: &str) -> Option<f64> {
    let b = s.as_bytes();
    if b.len() < 19
        || b[4] != b'-'
        || b[7] != b'-'
        || (b[10] != b'T' && b[10] != b't')
        || b[13] != b':'
        || b[16] != b':'
    {
        return None;
    }
    let n = |r: std::ops::Range<usize>| s.get(r)?.parse::<i64>().ok();
    let (y, mo, d, h, mi, se) = (
        n(0..4)?,
        n(5..7)?,
        n(8..10)?,
        n(11..13)?,
        n(14..16)?,
        n(17..19)?,
    );
    if !(1..=12).contains(&mo) || !(1..=31).contains(&d) || h > 23 || mi > 59 || se > 59 {
        return None;
    }
    let mut rest = &s[19..];
    let mut frac_ms = 0.0;
    if let Some(r) = rest.strip_prefix('.') {
        let digits: String = r.chars().take_while(char::is_ascii_digit).collect();
        if digits.is_empty() {
            return None;
        }
        let ms: String = digits.chars().chain("000".chars()).take(3).collect();
        frac_ms = ms.parse::<f64>().ok()?;
        rest = &r[digits.len()..];
    }
    let offset_min = match rest {
        "Z" | "z" => 0,
        o if o.len() == 6 && (o.starts_with('+') || o.starts_with('-')) && &o[3..4] == ":" => {
            let v = o[1..3].parse::<i64>().ok()? * 60 + o[4..6].parse::<i64>().ok()?;
            if o.starts_with('-') { -v } else { v }
        }
        _ => return None,
    };
    // 그레고리력 날짜 → 일 수(Howard Hinnant days_from_civil).
    let yy = if mo <= 2 { y - 1 } else { y };
    let era = yy.div_euclid(400);
    let yoe = yy - era * 400;
    let mp = (mo + 9) % 12;
    let doy = (153 * mp + 2) / 5 + d - 1;
    let doe = yoe * 365 + yoe / 4 - yoe / 100 + doy;
    let days = era * 146_097 + doe - 719_468;
    let secs = days * 86_400 + h * 3600 + mi * 60 + se - offset_min * 60;
    Some(secs as f64 * 1000.0 + frac_ms)
}

fn claude_window(raw: Option<&Value>) -> Option<UsageWindow> {
    let o = raw?.as_object()?;
    let u = num(o.get("utilization"))?;
    let resets = o
        .get("resets_at")
        .and_then(Value::as_str)
        .and_then(parse_iso_ms);
    Some(UsageWindow {
        used_percent: clamp_percent(u),
        resets_at_ms: resets,
        window_minutes: None,
    })
}

/// TS `parseClaudeOAuthUsage` — 모르는 모양이면 빈 창들(던지지 않는다). `extra` 는 늘 실린다(빈 배열이라도).
pub fn parse_claude_oauth_usage(raw: &Value, now: f64) -> Measured {
    let empty = serde_json::Map::new();
    let o = raw.as_object().unwrap_or(&empty);
    let mut extra = Vec::new();
    for (key, label) in [
        ("seven_day_opus", "Opus weekly"),
        ("seven_day_sonnet", "Sonnet weekly"),
    ] {
        if let Some(w) = claude_window(o.get(key)) {
            extra.push(ExtraWindow {
                label: label.into(),
                window: w,
            });
        }
    }
    Measured {
        source: None,
        session: claude_window(o.get("five_hour")),
        weekly: claude_window(o.get("seven_day")),
        extra: Some(extra),
        plan: None,
        fetched_at_ms: now,
        error: None,
    }
}

fn codex_window(raw: Option<&Value>, now: f64) -> Option<UsageWindow> {
    let o = raw?.as_object()?;
    let used = num(o.get("used_percent"))?;
    // `reset_at`(epoch 초)이 먼저, 없으면 `reset_after_seconds`(지금부터). 판본마다 갈린다.
    let resets_at_ms = match (num(o.get("reset_at")), num(o.get("reset_after_seconds"))) {
        (Some(at), _) => Some(at * 1000.0),
        (None, Some(after)) => Some(now + after * 1000.0),
        _ => None,
    };
    let window_minutes = num(o.get("limit_window_seconds")).map(|s| js_round(s / 60.0));
    Some(UsageWindow {
        used_percent: clamp_percent(used),
        resets_at_ms,
        window_minutes,
    })
}

/// JS `Math.round` — .5 는 +∞ 쪽으로(음수에서 Rust `round` 와 갈린다).
fn js_round(x: f64) -> f64 {
    (x + 0.5).floor()
}

/// TS `parseCodexWhamUsage`. `extra` 는 싣지 않는다(TS 와 같다).
pub fn parse_codex_wham_usage(raw: &Value, now: f64) -> Measured {
    let empty = serde_json::Map::new();
    let o = raw.as_object().unwrap_or(&empty);
    let rl = o
        .get("rate_limit")
        .and_then(Value::as_object)
        .unwrap_or(&empty);
    Measured {
        source: None,
        session: codex_window(rl.get("primary_window"), now),
        weekly: codex_window(rl.get("secondary_window"), now),
        extra: None,
        plan: o
            .get("plan_type")
            .and_then(Value::as_str)
            .map(str::to_owned),
        fetched_at_ms: now,
        error: None,
    }
}

/// HTTP 실패의 갈래. TS 는 `Error.message`(`HTTP <n>`)·`AbortError` 로 가른다 — 여기서는 타입으로.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum FetchError {
    Status(u16),
    Timeout,
    Network,
}

/// TS `errorLabel` — 메시지를 싣지 않고 짧은 꼬리표만(URL·헤더가 섞일 수 있다).
pub fn error_label(e: FetchError) -> String {
    match e {
        FetchError::Status(401 | 403) => "unauthorized".into(),
        FetchError::Status(n) => format!("http-{n}"),
        FetchError::Timeout => "timeout".into(),
        FetchError::Network => "network".into(),
    }
}

/// 인증 꼬리표 — 이것이면 API 결과를 고른다(TS `AUTH_ERRORS`).
fn is_auth_error(e: &str) -> bool {
    matches!(e, "unauthorized" | "no-credentials")
}

/// TS `cliThenApi` — CLI 가 되면 그것, 아니면 API. 둘 다 실패면 API 가 인증 꼬리표일 때만 API 쪽
/// 오류를(다시 로그인하라는 뜻이라 사람이 할 일이 분명하다), 아니면 CLI 쪽 오류를 싣는다.
pub fn cli_then_api(cli: impl FnOnce() -> Measured, api: impl FnOnce() -> Measured) -> Measured {
    let a = cli();
    if a.error.is_none() {
        return Measured {
            source: Some("cli"),
            ..a
        };
    }
    let b = api();
    if b.error.is_none() {
        return Measured {
            source: Some("api"),
            ..b
        };
    }
    if b.error.as_deref().is_some_and(is_auth_error) {
        Measured {
            source: Some("api"),
            ..b
        }
    } else {
        Measured {
            source: Some("cli"),
            ..a
        }
    }
}

// ── 토큰 읽기 ─────────────────────────────────────────────────────────────────

/// TS `ClaudeOAuthToken`. `Debug` 를 일부러 두지 않는다 — 실수로 로그에 찍히지 않게.
pub struct ClaudeToken {
    pub access_token: String,
    /// epoch ms. 없으면 모른다.
    pub expires_at_ms: Option<f64>,
}

/// TS `parseClaudeCredentials` — `claudeAiOauth.accessToken`(빈 글자 아님)·`expiresAt`(수).
fn parse_claude_credentials(raw: &Value) -> Option<ClaudeToken> {
    let o = raw.get("claudeAiOauth")?.as_object()?;
    let t = o.get("accessToken")?.as_str()?;
    if t.is_empty() {
        return None;
    }
    Some(ClaudeToken {
        access_token: t.to_owned(),
        expires_at_ms: num(o.get("expiresAt")),
    })
}

/// 절대 경로 — PATH 에 끼운 가짜 `security` 가 값을 받는 길을 닫는다(`claude_accounts::SECURITY_BIN` 과 같은 까닭).
const SECURITY_BIN: &str = "/usr/bin/security";
const SECURITY_TIMEOUT: Duration = Duration::from_secs(10);

/// `security find-generic-password … -w` 의 stdout. **값이 이 프로세스를 지나는 유일한 자리**다(TS 와 같다).
/// 10초 넘으면 죽이고 `None`. stdout 은 따로 읽는다 — 기다리는 동안 파이프가 차서 서로 막히지 않게.
fn keychain_read(config_dir: &Path) -> Option<String> {
    if !cfg!(target_os = "macos") {
        return None;
    }
    let user = std::env::var("USER").unwrap_or_default();
    let service = crate::claude_accounts::keychain_service(config_dir);
    let mut child = Command::new(SECURITY_BIN)
        .args(["find-generic-password", "-s", &service, "-a", &user, "-w"])
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        .spawn()
        .ok()?;
    let mut out = child.stdout.take()?;
    let reader = std::thread::spawn(move || {
        let mut buf = String::new();
        out.read_to_string(&mut buf).ok().map(|_| buf)
    });
    let deadline = Instant::now() + SECURITY_TIMEOUT;
    let ok = loop {
        match child.try_wait() {
            Ok(Some(st)) => break st.success(),
            Ok(None) if Instant::now() < deadline => std::thread::sleep(Duration::from_millis(20)),
            _ => {
                let _ = child.kill();
                let _ = child.wait();
                break false;
            }
        }
    };
    let text = reader.join().ok().flatten()?;
    ok.then_some(text)
}

/// TS `nodeReadClaudeToken` — 파일(`.credentials.json`)이 먼저, 없거나 못 읽으면 macOS Keychain.
pub fn read_claude_token(config_dir: &Path) -> Option<ClaudeToken> {
    if let Some(t) = fs::read_to_string(config_dir.join(".credentials.json"))
        .ok()
        .and_then(|s| serde_json::from_str::<Value>(&s).ok())
        .and_then(|v| parse_claude_credentials(&v))
    {
        return Some(t);
    }
    let out = keychain_read(config_dir)?;
    parse_claude_credentials(&serde_json::from_str(&out).ok()?)
}

/// TS `CodexToken`. `Debug` 없음(위와 같은 까닭).
pub struct CodexToken {
    pub access_token: String,
    pub account_id: Option<String>,
}

/// TS `nodeReadCodexToken` — `auth.json` 의 `tokens.access_token`(빈 글자 아님)·`tokens.account_id`.
pub fn read_codex_token(codex_home: &Path) -> Option<CodexToken> {
    let v: Value =
        serde_json::from_str(&fs::read_to_string(codex_home.join("auth.json")).ok()?).ok()?;
    let t = v.get("tokens")?;
    let access = t.get("access_token")?.as_str()?;
    if access.is_empty() {
        return None;
    }
    Some(CodexToken {
        access_token: access.to_owned(),
        account_id: t
            .get("account_id")
            .and_then(Value::as_str)
            .map(str::to_owned),
    })
}

// ── API 조회 ──────────────────────────────────────────────────────────────────

/// 요청 하나의 상한(TS `FETCH_TIMEOUT_MS`). 화면이 폴링하므로 매달리면 다음 폴과 겹친다.
pub const FETCH_TIMEOUT: Duration = Duration::from_secs(10);
/// 응답 본문 상한 — 사용량 JSON 은 수 KB 다. 넘으면 `network` 로 친다.
const MAX_BODY_BYTES: u64 = 1 << 20;

/// TS `FetchLike` + `getJson` — GET 하고 2xx 면 JSON. 시험은 가짜를 꽂는다.
pub trait UsageHttp {
    fn get_json(&self, url: &str, headers: &[(&str, &str)]) -> Result<Value, FetchError>;
}

/// ureq 판. 상태 코드만 싣는다 — 본문·오류 문자열에는 무엇이 들어 있을지 모른다.
pub struct UreqUsageHttp {
    agent: ureq::Agent,
}

impl Default for UreqUsageHttp {
    fn default() -> Self {
        Self {
            agent: ureq::Agent::new_with_config(
                ureq::Agent::config_builder()
                    .http_status_as_error(false)
                    // 리다이렉트는 따라가지 않는다 — Authorization 이 다른 곳으로 실려 가지 않게. 3xx 는 `http-3xx` 로 친다.
                    .max_redirects(0)
                    .max_redirects_will_error(false)
                    .timeout_global(Some(FETCH_TIMEOUT))
                    .build(),
            ),
        }
    }
}

impl UsageHttp for UreqUsageHttp {
    fn get_json(&self, url: &str, headers: &[(&str, &str)]) -> Result<Value, FetchError> {
        let mut req = self.agent.get(url);
        for (k, v) in headers {
            req = req.header(*k, *v);
        }
        let mut res = req.call().map_err(|e| match e {
            ureq::Error::Timeout(_) => FetchError::Timeout,
            _ => FetchError::Network,
        })?;
        let status = res.status().as_u16();
        if !(200..300).contains(&status) {
            return Err(FetchError::Status(status));
        }
        let text = res
            .body_mut()
            .with_config()
            .limit(MAX_BODY_BYTES)
            .read_to_string()
            .map_err(|e| match e {
                ureq::Error::Timeout(_) => FetchError::Timeout,
                _ => FetchError::Network,
            })?;
        // TS `res.json()` 이 던지면 `errorLabel` 은 `network` 다.
        serde_json::from_str(&text).map_err(|_| FetchError::Network)
    }
}

/// TS `fetchClaudeProviderUsage`. 토큰이 없으면 `no-credentials`, 만료면 `token-expired`(갱신하지 않는다).
pub fn fetch_claude_provider_usage(
    config_dir: &Path,
    now: f64,
    http: &dyn UsageHttp,
    read_token: &dyn Fn(&Path) -> Option<ClaudeToken>,
) -> Measured {
    let Some(token) = read_token(config_dir) else {
        return Measured::failed(now, "no-credentials");
    };
    if token.expires_at_ms.is_some_and(|e| e <= now) {
        return Measured::failed(now, "token-expired");
    }
    let auth = format!("Bearer {}", token.access_token);
    match http.get_json(
        CLAUDE_OAUTH_USAGE_URL,
        &[
            ("Authorization", &auth),
            ("anthropic-beta", "oauth-2025-04-20"),
            ("Accept", "application/json"),
        ],
    ) {
        Ok(raw) => parse_claude_oauth_usage(&raw, now),
        Err(e) => Measured::failed(now, &error_label(e)),
    }
}

/// TS `fetchCodexProviderUsage`. account id 가 있을 때만 `ChatGPT-Account-Id` 를 싣는다.
pub fn fetch_codex_provider_usage(
    codex_home: &Path,
    now: f64,
    http: &dyn UsageHttp,
    read_token: &dyn Fn(&Path) -> Option<CodexToken>,
) -> Measured {
    let Some(token) = read_token(codex_home) else {
        return Measured::failed(now, "no-credentials");
    };
    let auth = format!("Bearer {}", token.access_token);
    let mut headers: Vec<(&str, &str)> = vec![("Authorization", &auth)];
    if let Some(id) = token.account_id.as_deref() {
        headers.push(("ChatGPT-Account-Id", id));
    }
    headers.push(("Accept", "application/json"));
    match http.get_json(CODEX_WHAM_USAGE_URL, &headers) {
        Ok(raw) => parse_codex_wham_usage(&raw, now),
        Err(e) => Measured::failed(now, &error_label(e)),
    }
}

pub mod cache;
pub mod cli;
mod tz;

#[cfg(test)]
mod tests;
