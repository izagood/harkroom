//! 오퍼레이터 허브(C2a, TS `ws/operatorHub.ts`) — 붙어 있는 오퍼레이터와 그들이 `hello` 로 알린 것(능력·러너·박동)을
//! **연결이 살아 있는 동안만** 든다. 저장하지 않는 이유는 TS 와 같다: 능력은 살아 있을 때의 사실이지 기록이 아니다.
//!
//! API 는 TS 의 11개 메서드를 그대로 옮긴다 — 소비자(배정·스레드 모델·계정·계정 삭제·머지 계정·릴레이·MCP)가 C2b~C5 에서
//! 이 허브를 부른다. 이벤트(`onFrame`·`onClose`)는 broadcast 로 내고, 받는 쪽은 `subscribe_*` 로 받는다.
//!
//! 프레임 파서는 TS `parseOperatorFrame` 처럼 **얕다**: `type` 이 아는 것인지·다중화 키 `runnerId` 가 있는지만 본다.
//! 박동 본문(`status`)은 `parse_operator_status` 가 허용한 칸만 골라 새로 만든다(H5 — 토큰·경로 같은 값이 실려 와도 들지 않는다).
use serde_json::{Map, Value, json};
use std::collections::HashMap;
use std::sync::{Arc, Mutex};
use std::time::{SystemTime, UNIX_EPOCH};
use tokio::sync::{broadcast, mpsc};

/// 소켓으로 내보낼 것. WS 루프(`operator.rs`)가 받아 쓴다.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum OpOut {
    Text(String),
    Close(u16, String),
}

/// 파싱된 오퍼레이터 → 서버 프레임(TS `OperatorToServerFrame`). 본문의 깊은 검증은 받는 쪽 일이다.
pub type Frame = Arc<Map<String, Value>>;

const OPERATOR_TYPES: &[&str] = &[
    "hello",
    "capabilities",
    "runner.started",
    "runner.exited",
    "runner.announce",
    "session.started",
    "session.updated",
    "session.ended",
    "pty.output",
    "pty.replay",
    "interactive.opened",
    "interactive.error",
    "attention.required",
    "status",
    "upgrade.progress",
    "local.input",
    "gh.report",
    "gh.lines.result",
];
const SERVER_TYPES: &[&str] = &[
    "assign",
    "unassign",
    "assign.synced",
    "agent.restart",
    "runner.kill",
    "pty.replay.request",
    "pty.input",
    "pty.resize",
    "viewer.count",
    "session.cancel",
    "interactive.open",
    "local.writer",
    "local.view",
    "gh.lines.set",
];
const NO_RUNNER_ID: &[&str] = &[
    "hello",
    "capabilities",
    "status",
    "upgrade.progress",
    "gh.report",
    "gh.lines.result",
    "gh.lines.set",
    "assign",
    "unassign",
    "assign.synced",
    "agent.restart",
];

/// TS `isVersionString` — 빈 문자열이 아니고 64자(UTF-16 단위) 이하.
pub fn is_version_string(v: &Value) -> bool {
    matches!(v, Value::String(s) if !s.is_empty() && utf16_len(s) <= 64)
}

fn utf16_len(s: &str) -> usize {
    s.encode_utf16().count()
}

fn parse(raw: &str, known: &[&str]) -> Option<Map<String, Value>> {
    let Ok(Value::Object(mut frame)) = serde_json::from_str::<Value>(raw) else {
        return None;
    };
    let ty = frame.get("type")?.as_str()?.to_owned();
    if !known.contains(&ty.as_str()) {
        return None;
    }
    if !NO_RUNNER_ID.contains(&ty.as_str()) && !frame.get("runnerId").is_some_and(Value::is_string)
    {
        return None;
    }
    if ty == "agent.restart" && !frame.get("agentId").is_some_and(Value::is_string) {
        return None;
    }
    // 버전이 틀린 모양이면 hello 를 버리지 않고 버전만 뗀다(TS 와 같음).
    if ty == "hello" && frame.get("version").is_some_and(|v| !is_version_string(v)) {
        frame.remove("version");
    }
    Some(frame)
}

/// TS `parseOperatorFrame`.
pub fn parse_operator_frame(raw: &str) -> Option<Map<String, Value>> {
    parse(raw, OPERATOR_TYPES)
}

/// TS `parseServerFrame` — 서버가 보내는 프레임의 모양 점검(시험·`send` 의 디버그 단언).
pub fn parse_server_frame(raw: &str) -> Option<Map<String, Value>> {
    parse(raw, SERVER_TYPES)
}

/// TS `isMachineDigest` — sha256 hex 64자(소문자).
pub fn is_machine_digest(v: &Value) -> bool {
    matches!(v, Value::String(s) if s.len() == 64 && s.bytes().all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b)))
}

// ---- 박동(TS `parseOperatorStatus`) ----

const MAX_CREDENTIALS: usize = 64;
const MAX_STATUS_AGENTS: usize = 256;
pub const MAX_STATUS_MCP: usize = 64;
const JS_MAX_SAFE: f64 = 9_007_199_254_740_991.0;

/// TS `count` — 0 이상 정수이고 상한 이하. JSON 수가 `1.0` 이어도 정수로 본다(JS 와 같음).
fn count(v: Option<&Value>, max: f64) -> Option<u64> {
    let n = v?.as_f64()?;
    (n.fract() == 0.0 && n >= 0.0 && n <= max).then_some(n as u64)
}

/// TS `shortText` — 비지 않고 `max` 자(UTF-16) 이하, 제어 문자(U+0000–U+001F) 없음.
fn short_text(v: Option<&Value>, max: usize) -> Option<&str> {
    let s = v?.as_str()?;
    (!s.is_empty() && utf16_len(s) <= max && !s.chars().any(|c| (c as u32) < 0x20)).then_some(s)
}

fn credential_name_ok(s: &str) -> bool {
    // /^[a-z0-9][a-z0-9._-]{0,47}$/
    let b = s.as_bytes();
    !b.is_empty()
        && b.len() <= 48
        && (b[0].is_ascii_lowercase() || b[0].is_ascii_digit())
        && b[1..].iter().all(|c| {
            c.is_ascii_lowercase() || c.is_ascii_digit() || matches!(c, b'.' | b'_' | b'-')
        })
}

fn mcp_name_ok(s: &str) -> bool {
    // /^[a-z0-9-]{1,32}$/
    !s.is_empty()
        && s.len() <= 32
        && s.bytes()
            .all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || c == b'-')
}

fn fingerprint_ok(s: &str) -> bool {
    s.len() == 16
        && s.bytes()
            .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
}

/// 박동 본문을 허용한 칸만 골라 새 객체로 만든다. 필수는 `turns.running` 하나, 나머지는 틀리면 그 칸만 뗀다.
pub fn parse_operator_status(value: &Value) -> Option<Value> {
    let v = value.as_object()?;
    let turns = v.get("turns").and_then(Value::as_object);
    let running = count(turns.and_then(|t| t.get("running")), 10_000.0)?;
    // TS: `count(max) || null` — 0 도 null 이 된다.
    let max = count(turns.and_then(|t| t.get("max")), 10_000.0).filter(|n| *n != 0);
    let mut out = Map::new();
    out.insert("turns".into(), json!({ "running": running, "max": max }));
    if let Some(p) = v.get("platform").and_then(Value::as_str)
        && matches!(p, "darwin" | "linux" | "win32")
    {
        out.insert("platform".into(), json!(p));
    }
    if let Some(s) = short_text(v.get("startedAt"), 40)
        && let Some(iso) = normalize_iso(s)
    {
        out.insert("startedAt".into(), json!(iso));
    }
    let bytes = |o: Option<&Value>| -> Option<Map<String, Value>> {
        let r = o?.as_object()?;
        let total = count(r.get("totalBytes"), JS_MAX_SAFE)?;
        let free = count(r.get("freeBytes"), JS_MAX_SAFE)?;
        (free <= total).then(|| {
            let mut m = Map::new();
            m.insert("totalBytes".into(), json!(total));
            m.insert("freeBytes".into(), json!(free));
            m
        })
    };
    if let Some(mut memory) = bytes(v.get("memory")) {
        if let Some(rss) = count(
            v.get("memory").and_then(|m| m.get("turnRssBytes")),
            JS_MAX_SAFE,
        ) {
            memory.insert("turnRssBytes".into(), json!(rss));
        }
        out.insert("memory".into(), Value::Object(memory));
    }
    if let Some(disk) = bytes(v.get("disk")) {
        out.insert("disk".into(), Value::Object(disk));
    }
    if let Some(list) = v.get("runners").and_then(Value::as_array) {
        let runners: Vec<Value> = list
            .iter()
            .take(MAX_STATUS_AGENTS)
            .filter_map(|r| {
                let r = r.as_object()?;
                let agent = short_text(r.get("agentId"), 64)?;
                let n = count(r.get("turns"), 10_000.0)?;
                Some(json!({ "agentId": agent, "turns": n }))
            })
            .collect();
        out.insert("runners".into(), Value::Array(runners));
    }
    if let Some(list) = v.get("credentials").and_then(Value::as_array) {
        let creds: Vec<Value> = list
            .iter()
            .take(MAX_CREDENTIALS)
            .filter_map(|c| {
                let r = c.as_object()?;
                let kind = r
                    .get("kind")
                    .and_then(Value::as_str)
                    .filter(|k| matches!(*k, "claude" | "codex" | "mcp" | "gh"))?;
                let state = r
                    .get("state")
                    .and_then(Value::as_str)
                    .filter(|k| matches!(*k, "present" | "expired" | "missing"))?;
                let name = r
                    .get("name")
                    .and_then(Value::as_str)
                    .filter(|n| credential_name_ok(n))?;
                let agent_ids: Vec<&str> = r
                    .get("agentIds")
                    .and_then(Value::as_array)
                    .map(|a| {
                        a.iter()
                            .filter_map(|x| short_text(Some(x), 64))
                            .take(MAX_STATUS_AGENTS)
                            .collect()
                    })
                    .unwrap_or_default();
                Some(json!({ "kind": kind, "name": name, "state": state, "agentIds": agent_ids }))
            })
            .collect();
        out.insert("credentials".into(), Value::Array(creds));
    }
    if let Some(mcp) = parse_mcp_status(v.get("mcp")) {
        out.insert("mcp".into(), Value::Array(mcp));
    }
    Some(Value::Object(out))
}

fn parse_mcp_status(value: Option<&Value>) -> Option<Vec<Value>> {
    let list = value?.as_array()?;
    let mut out = Vec::new();
    let mut seen = std::collections::HashSet::new();
    for e in list.iter().take(MAX_STATUS_MCP) {
        let Some(r) = e.as_object() else { continue };
        let Some(name) = r
            .get("name")
            .and_then(Value::as_str)
            .filter(|n| mcp_name_ok(n))
        else {
            continue;
        };
        let Some(defined) = r.get("defined").and_then(Value::as_bool) else {
            continue;
        };
        if !seen.insert(name.to_owned()) {
            continue;
        }
        let mut entry = Map::new();
        entry.insert("name".into(), json!(name));
        entry.insert("defined".into(), json!(defined));
        if defined {
            if let Some(s) = r
                .get("source")
                .and_then(Value::as_str)
                .filter(|s| matches!(*s, "operator" | "claude"))
            {
                entry.insert("source".into(), json!(s));
            }
            if let Some(t) = r
                .get("transport")
                .and_then(Value::as_str)
                .filter(|s| matches!(*s, "stdio" | "http" | "sse"))
            {
                entry.insert("transport".into(), json!(t));
            }
            if let Some(b) = r.get("oauth").and_then(Value::as_bool) {
                entry.insert("oauth".into(), json!(b));
            }
            if let Some(a) = r.get("auth").and_then(Value::as_str).filter(|s| {
                matches!(
                    *s,
                    "none" | "pending" | "ok" | "expired" | "rejected" | "error"
                )
            }) {
                entry.insert("auth".into(), json!(a));
            }
            if let Some(at) = short_text(r.get("authAt"), 40).and_then(normalize_iso) {
                entry.insert("authAt".into(), json!(at));
            }
            if let Some(fp) = r
                .get("clientIdFp")
                .and_then(Value::as_str)
                .filter(|s| fingerprint_ok(s))
            {
                entry.insert("clientIdFp".into(), json!(fp));
            }
        }
        out.push(Value::Object(entry));
    }
    Some(out)
}

// ---- 시각(ISO 8601) ----
// TS 는 `new Date(x).toISOString()` 으로 다듬는다. JS `Date.parse` 가 받는 꼴은 넓지만 오퍼레이터는 언제나
// `toISOString()` 을 보낸다 — 여기서는 RFC 3339 꼴(`YYYY-MM-DDTHH:MM:SS[.frac](Z|±HH:MM)`)만 받는다. 그 밖은 칸을 뗀다.

fn days_from_civil(y: i64, m: i64, d: i64) -> i64 {
    let y = if m <= 2 { y - 1 } else { y };
    let era = y.div_euclid(400);
    let yoe = y - era * 400;
    let doy = (153 * (m + if m > 2 { -3 } else { 9 }) + 2) / 5 + d - 1;
    let doe = yoe * 365 + yoe / 4 - yoe / 100 + doy;
    era * 146_097 + doe - 719_468
}

fn civil_from_days(z: i64) -> (i64, i64, i64) {
    let z = z + 719_468;
    let era = z.div_euclid(146_097);
    let doe = z - era * 146_097;
    let yoe = (doe - doe / 1460 + doe / 36_524 - doe / 146_096) / 365;
    let y = yoe + era * 400;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let d = doy - (153 * mp + 2) / 5 + 1;
    let m = if mp < 10 { mp + 3 } else { mp - 9 };
    (if m <= 2 { y + 1 } else { y }, m, d)
}

/// 유닉스 밀리초 → `toISOString()` 꼴(`2026-11-14T11:16:37.000Z`).
pub fn iso_from_ms(ms: i64) -> String {
    let days = ms.div_euclid(86_400_000);
    let rem = ms.rem_euclid(86_400_000);
    let (y, m, d) = civil_from_days(days);
    format!(
        "{y:04}-{m:02}-{d:02}T{:02}:{:02}:{:02}.{:03}Z",
        rem / 3_600_000,
        rem / 60_000 % 60,
        rem / 1000 % 60,
        rem % 1000
    )
}

pub fn now_iso() -> String {
    let ms = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0);
    iso_from_ms(ms)
}

fn normalize_iso(s: &str) -> Option<String> {
    let b = s.as_bytes();
    let num = |r: std::ops::Range<usize>| -> Option<i64> {
        let part = b.get(r)?;
        part.iter()
            .all(u8::is_ascii_digit)
            .then(|| std::str::from_utf8(part).ok()?.parse().ok())?
    };
    if b.len() < 20
        || b[4] != b'-'
        || b[7] != b'-'
        || b[10] != b'T'
        || b[13] != b':'
        || b[16] != b':'
    {
        return None;
    }
    let (y, mo, d, h, mi, se) = (
        num(0..4)?,
        num(5..7)?,
        num(8..10)?,
        num(11..13)?,
        num(14..16)?,
        num(17..19)?,
    );
    let mut i = 19;
    let mut ms = 0i64;
    if b[i] == b'.' {
        let start = i + 1;
        i = start;
        while i < b.len() && b[i].is_ascii_digit() {
            i += 1;
        }
        let digits = &s[start..i];
        if digits.is_empty() {
            return None;
        }
        let mut three = digits.chars().take(3).collect::<String>();
        while three.len() < 3 {
            three.push('0');
        }
        ms = three.parse().ok()?;
    }
    let offset_min = match &s[i..] {
        "Z" => 0,
        rest if rest.len() == 6
            && (rest.starts_with('+') || rest.starts_with('-'))
            && &rest[3..4] == ":" =>
        {
            let oh = num(i + 1..i + 3)?;
            let om = num(i + 4..i + 6)?;
            if oh > 23 || om > 59 {
                return None;
            }
            let v = oh * 60 + om;
            if rest.starts_with('-') { -v } else { v }
        }
        _ => return None,
    };
    let leap = (y % 4 == 0 && y % 100 != 0) || y % 400 == 0;
    let dim = [
        31,
        if leap { 29 } else { 28 },
        31,
        30,
        31,
        30,
        31,
        31,
        30,
        31,
        30,
        31,
    ];
    if !(1..=12).contains(&mo)
        || d < 1
        || d > dim[(mo - 1) as usize]
        || h > 24
        || mi > 59
        || se > 59
    {
        return None;
    }
    // JS 는 24:00:00 만 24시로 받는다.
    if h == 24 && (mi != 0 || se != 0 || ms != 0) {
        return None;
    }
    let total =
        days_from_civil(y, mo, d) * 86_400_000 + ((h * 60 + mi - offset_min) * 60 + se) * 1000 + ms;
    Some(iso_from_ms(total))
}

// ---- 허브 ----

struct LiveOperator {
    conn: u64,
    tx: mpsc::UnboundedSender<OpOut>,
    capabilities: Option<Value>,
    /// runnerId → agentId.
    runners: HashMap<String, String>,
    /// 마지막 박동(허용한 칸만 + `receivedAt`).
    status: Option<Value>,
}

#[derive(Default)]
struct State {
    live: HashMap<String, LiveOperator>,
    refusals: HashMap<String, (String, String)>,
}

/// 허브 — 프로세스에 하나. 복제는 같은 허브를 가리킨다.
#[derive(Clone)]
pub struct OperatorHub {
    state: Arc<Mutex<State>>,
    frames: broadcast::Sender<(String, Frame)>,
    closes: broadcast::Sender<String>,
}

impl Default for OperatorHub {
    fn default() -> Self {
        Self::new()
    }
}

/// `add_operator` 가 돌려주는 등록 표. `detach` 로 지운다(소켓 close 경로) — 이미 교체됐으면 아무 일도 없다.
pub struct Registration {
    pub operator_id: String,
    conn: u64,
}

impl OperatorHub {
    pub fn new() -> Self {
        Self {
            state: Arc::default(),
            frames: broadcast::channel(4096).0,
            closes: broadcast::channel(256).0,
        }
    }

    fn lock(&self) -> std::sync::MutexGuard<'_, State> {
        self.state.lock().unwrap_or_else(|e| e.into_inner())
    }

    /// TS `addOperator` — 같은 오퍼레이터가 두 번 붙으면 앞 소켓을 4409 로 끊고 `close` 를 낸다.
    pub fn add_operator(
        &self,
        operator_id: &str,
        tx: mpsc::UnboundedSender<OpOut>,
    ) -> Registration {
        static N: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(1);
        let conn = N.fetch_add(1, std::sync::atomic::Ordering::Relaxed);
        let previous = self.lock().live.insert(
            operator_id.to_owned(),
            LiveOperator {
                conn,
                tx,
                capabilities: None,
                runners: HashMap::new(),
                status: None,
            },
        );
        if let Some(prev) = previous {
            let _ = prev.tx.send(OpOut::Close(
                4409,
                "replaced by a newer operator connection".into(),
            ));
            let _ = self.closes.send(operator_id.to_owned());
        }
        Registration {
            operator_id: operator_id.to_owned(),
            conn,
        }
    }

    pub fn detach(&self, reg: &Registration) {
        let removed = {
            let mut s = self.lock();
            if s.live
                .get(&reg.operator_id)
                .is_some_and(|e| e.conn == reg.conn)
            {
                s.live.remove(&reg.operator_id);
                true
            } else {
                false
            }
        };
        if removed {
            let _ = self.closes.send(reg.operator_id.clone());
        }
    }

    /// TS `onOperatorMessage` — 파싱 실패·모르는 타입·등록 없는 오퍼레이터는 조용히 버린다.
    /// `reg` 로 부르는 까닭: 교체된 앞 소켓이 닫히기 전에 보낸 프레임이 새 연결의 상태를 덮지 않게(TS 는 id 로만 찾는다 —
    /// 같은 틱 안에서 앞 소켓의 메시지가 더 오지 않는 Node 와 달리, 여기는 앞 소켓의 루프가 아직 돌 수 있다).
    pub fn on_operator_message(&self, reg: &Registration, raw: &str) {
        let Some(frame) = parse_operator_frame(raw) else {
            return;
        };
        let id = &reg.operator_id;
        {
            let mut s = self.lock();
            let State { live, refusals } = &mut *s;
            let Some(entry) = live.get_mut(id).filter(|e| e.conn == reg.conn) else {
                return;
            };
            match frame.get("type").and_then(Value::as_str).unwrap_or("") {
                "hello" => {
                    entry.capabilities = frame.get("capabilities").cloned();
                    entry.runners.clear();
                    for r in frame
                        .get("runners")
                        .and_then(Value::as_array)
                        .into_iter()
                        .flatten()
                    {
                        if let (Some(rid), Some(aid)) = (
                            r.get("runnerId").and_then(Value::as_str),
                            r.get("agentId").and_then(Value::as_str),
                        ) {
                            entry.runners.insert(rid.to_owned(), aid.to_owned());
                            refusals.remove(aid);
                        }
                    }
                }
                "capabilities" => entry.capabilities = frame.get("capabilities").cloned(),
                "status" => {
                    // 틀린 박동은 버리고 앞의 값을 둔다. 프레임도 내지 않는다(TS 는 여기서 return).
                    let Some(Value::Object(mut st)) =
                        frame.get("status").and_then(parse_operator_status)
                    else {
                        return;
                    };
                    st.insert("receivedAt".into(), json!(now_iso()));
                    entry.status = Some(Value::Object(st));
                }
                "runner.started" => {
                    if let (Some(rid), Some(aid)) = (
                        frame.get("runnerId").and_then(Value::as_str),
                        frame.get("agentId").and_then(Value::as_str),
                    ) {
                        entry.runners.insert(rid.to_owned(), aid.to_owned());
                        refusals.remove(aid);
                    }
                }
                "runner.exited" => {
                    if let Some(rid) = frame.get("runnerId").and_then(Value::as_str) {
                        entry.runners.remove(rid);
                    }
                    // TS: `frame.reason && frame.agentId` — 빈 문자열은 거짓이다.
                    if let (Some(reason), Some(aid)) = (
                        frame
                            .get("reason")
                            .and_then(Value::as_str)
                            .filter(|s| !s.is_empty()),
                        frame
                            .get("agentId")
                            .and_then(Value::as_str)
                            .filter(|s| !s.is_empty()),
                    ) {
                        refusals.insert(aid.to_owned(), (reason.to_owned(), now_iso()));
                    }
                }
                _ => {}
            }
        }
        let _ = self.frames.send((id.clone(), Arc::new(frame)));
    }

    /// TS `disconnect` — 등록은 소켓 루프의 close 경로가 지운다.
    pub fn disconnect(&self, operator_id: &str, code: u16, reason: &str) {
        if let Some(e) = self.lock().live.get(operator_id) {
            let _ = e.tx.send(OpOut::Close(code, reason.to_owned()));
        }
    }

    pub fn is_online(&self, operator_id: &str) -> bool {
        self.lock().live.contains_key(operator_id)
    }

    /// `{ reason, at }` 또는 None.
    pub fn refusal_of(&self, agent_id: &str) -> Option<Value> {
        self.lock()
            .refusals
            .get(agent_id)
            .map(|(reason, at)| json!({ "reason": reason, "at": at }))
    }

    pub fn capabilities(&self, operator_id: &str) -> Option<Value> {
        self.lock().live.get(operator_id)?.capabilities.clone()
    }

    pub fn status(&self, operator_id: &str) -> Option<Value> {
        self.lock().live.get(operator_id)?.status.clone()
    }

    /// TS `send` — 보냈는가까지. 오프라인·소켓이 죽었으면 false.
    pub fn send(&self, operator_id: &str, frame: &Value) -> bool {
        debug_assert!(
            parse_server_frame(&frame.to_string()).is_some(),
            "unknown server frame"
        );
        match self.lock().live.get(operator_id) {
            Some(e) => e.tx.send(OpOut::Text(frame.to_string())).is_ok(),
            None => false,
        }
    }

    /// TS `runnerOf` — `(operatorId, runnerId)`.
    pub fn runner_of(&self, agent_id: &str) -> Option<(String, String)> {
        let s = self.lock();
        s.live.iter().find_map(|(op, e)| {
            e.runners
                .iter()
                .find(|(_, a)| *a == agent_id)
                .map(|(r, _)| (op.clone(), r.clone()))
        })
    }

    /// TS `onFrame` — 파싱된 모든 프레임(틀린 박동 제외).
    pub fn subscribe_frames(&self) -> broadcast::Receiver<(String, Frame)> {
        self.frames.subscribe()
    }

    /// TS `onClose` — 소켓 close·교체.
    pub fn subscribe_closes(&self) -> broadcast::Receiver<String> {
        self.closes.subscribe()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn hub_with(id: &str) -> (OperatorHub, Registration, mpsc::UnboundedReceiver<OpOut>) {
        let hub = OperatorHub::new();
        let (tx, rx) = mpsc::unbounded_channel();
        let reg = hub.add_operator(id, tx);
        (hub, reg, rx)
    }

    #[test]
    fn frame_parser_is_shallow_like_ts() {
        assert!(parse_operator_frame("not json").is_none());
        assert!(parse_operator_frame("[]").is_none());
        assert!(parse_operator_frame(r#"{"type":"nope"}"#).is_none());
        assert!(parse_operator_frame(r#"{"type":"pty.output"}"#).is_none());
        assert!(parse_operator_frame(r#"{"type":"pty.output","runnerId":"r"}"#).is_some());
        assert!(parse_operator_frame(r#"{"type":"status"}"#).is_some());
        let h = parse_operator_frame(r#"{"type":"hello","version":""}"#).unwrap();
        assert!(!h.contains_key("version"));
        let h = parse_operator_frame(r#"{"type":"hello","version":"0.4.1"}"#).unwrap();
        assert_eq!(h["version"], "0.4.1");
        assert!(parse_server_frame(r#"{"type":"agent.restart"}"#).is_none());
        assert!(parse_server_frame(r#"{"type":"agent.restart","agentId":"a"}"#).is_some());
        assert!(parse_server_frame(r#"{"type":"hello"}"#).is_none());
    }

    #[test]
    fn status_keeps_only_allowed_fields() {
        let raw = json!({
            "turns": { "running": 2, "max": 0 }, "platform": "darwin", "token": "secret",
            "startedAt": "2026-11-14T20:16:37+09:00",
            "memory": { "totalBytes": 10, "freeBytes": 4, "turnRssBytes": 3, "x": 1 },
            "disk": { "totalBytes": 1, "freeBytes": 2 },
            "runners": [{ "agentId": "a", "turns": 1, "path": "/x" }, { "agentId": "", "turns": 1 }],
            "credentials": [
                { "kind": "gh", "name": "octo", "state": "present", "agentIds": ["a", 3] },
                { "kind": "gh", "name": "Upper", "state": "present" },
                { "kind": "aws", "name": "x", "state": "present" }
            ],
            "mcp": [
                { "name": "harkroom", "defined": true, "transport": "http", "url": "https://x", "clientIdFp": "0123456789abcdef", "authAt": "bad" },
                { "name": "harkroom", "defined": false },
                { "name": "off", "defined": false, "transport": "http" }
            ]
        });
        let s = parse_operator_status(&raw).unwrap();
        assert_eq!(
            s,
            json!({
                "turns": { "running": 2, "max": null }, "platform": "darwin",
                "startedAt": "2026-11-14T11:16:37.000Z",
                "memory": { "totalBytes": 10, "freeBytes": 4, "turnRssBytes": 3 },
                "runners": [{ "agentId": "a", "turns": 1 }],
                "credentials": [{ "kind": "gh", "name": "octo", "state": "present", "agentIds": ["a"] }],
                "mcp": [
                    { "name": "harkroom", "defined": true, "transport": "http", "clientIdFp": "0123456789abcdef" },
                    { "name": "off", "defined": false }
                ]
            })
        );
        assert!(parse_operator_status(&json!({ "turns": { "running": -1 } })).is_none());
        assert!(parse_operator_status(&json!({ "turns": { "running": 1.5 } })).is_none());
        assert!(parse_operator_status(&json!({})).is_none());
    }

    #[test]
    fn iso_round_trip() {
        assert_eq!(iso_from_ms(0), "1970-01-01T00:00:00.000Z");
        assert_eq!(
            normalize_iso("2026-11-14T11:16:37.1234Z").as_deref(),
            Some("2026-11-14T11:16:37.123Z")
        );
        assert_eq!(
            normalize_iso("2024-03-01T00:30:00-01:00").as_deref(),
            Some("2024-03-01T01:30:00.000Z")
        );
        assert!(normalize_iso("2026-02-30T00:00:00Z").is_none());
        assert!(normalize_iso("2026-11-14T11:16:37").is_none());
    }

    #[test]
    fn hub_tracks_runners_refusals_and_status() {
        let (hub, reg, _rx) = hub_with("op1");
        let mut frames = hub.subscribe_frames();
        hub.on_operator_message(
            &reg,
            r#"{"type":"runner.exited","runnerId":"r0","code":null,"reason":"mcp_server_missing:x","agentId":"a1"}"#,
        );
        assert_eq!(
            hub.refusal_of("a1").unwrap()["reason"],
            "mcp_server_missing:x"
        );
        hub.on_operator_message(
            &reg,
            r#"{"type":"hello","protocol":1,"capabilities":{"harnesses":["claude"]},"runners":[{"agentId":"a1","runnerId":"r1","pid":1}],"sessions":[]}"#,
        );
        assert!(hub.refusal_of("a1").is_none());
        assert_eq!(hub.runner_of("a1"), Some(("op1".into(), "r1".into())));
        assert_eq!(hub.capabilities("op1").unwrap()["harnesses"][0], "claude");
        hub.on_operator_message(
            &reg,
            r#"{"type":"status","status":{"turns":{"running":1}}}"#,
        );
        assert!(hub.status("op1").unwrap()["receivedAt"].is_string());
        // 틀린 박동은 앞 값을 두고 프레임도 내지 않는다.
        hub.on_operator_message(&reg, r#"{"type":"status","status":{}}"#);
        assert!(hub.status("op1").is_some());
        hub.on_operator_message(&reg, r#"{"type":"runner.exited","runnerId":"r1","code":0}"#);
        assert!(hub.runner_of("a1").is_none());
        let types: Vec<String> = std::iter::from_fn(|| frames.try_recv().ok())
            .map(|(_, f)| f["type"].as_str().unwrap().to_owned())
            .collect();
        assert_eq!(types, ["runner.exited", "hello", "status", "runner.exited"]);
    }

    #[test]
    fn second_connection_replaces_first() {
        let (hub, first, mut rx1) = hub_with("op1");
        let mut closes = hub.subscribe_closes();
        let (tx2, mut rx2) = mpsc::unbounded_channel();
        let second = hub.add_operator("op1", tx2);
        assert_eq!(
            rx1.try_recv().unwrap(),
            OpOut::Close(4409, "replaced by a newer operator connection".into())
        );
        assert_eq!(closes.try_recv().unwrap(), "op1");
        // 앞 소켓의 늦은 프레임·detach 는 새 등록을 건드리지 않는다.
        hub.on_operator_message(&first, r#"{"type":"capabilities","capabilities":{"x":1}}"#);
        assert!(hub.capabilities("op1").is_none());
        hub.detach(&first);
        assert!(hub.is_online("op1"));
        assert!(closes.try_recv().is_err());
        assert!(hub.send(
            "op1",
            &json!({ "type": "unassign", "agentId": "a", "drain": true })
        ));
        assert!(matches!(rx2.try_recv().unwrap(), OpOut::Text(_)));
        hub.disconnect("op1", 4401, "revoked");
        assert_eq!(
            rx2.try_recv().unwrap(),
            OpOut::Close(4401, "revoked".into())
        );
        hub.detach(&second);
        assert!(!hub.is_online("op1"));
        assert_eq!(closes.try_recv().unwrap(), "op1");
        assert!(!hub.send(
            "op1",
            &json!({ "type": "unassign", "agentId": "a", "drain": true })
        ));
    }
}
