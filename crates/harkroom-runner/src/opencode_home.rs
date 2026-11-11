//! opencode·kilo 격리 XDG 홈의 순수 절반(`opencodeHome.ts` 앞부분). 정본은 `packages/agent/src/opencodeHome.ts` 다.
//!
//! 여기에는 파일을 건드리지 않는 표·이름·변환만 둔다 — lane 에이전트 권한 표, 채널별 에이전트 이름, 승인 규칙 → `bash` 표,
//! 스킬 권한, XDG 자리 계산, MCP 표 번역, lane 모델 이름 문법, lane provider 블록, JSONC 정리, 지난 설정 파일 본문에서
//! lane 모델·채널 칸 다시 읽기. 설정 잠금(`withConfigLock`)과 홈 만들기(`ensureOpencodeHome`)는 다음 조각(B3c-2b-2)이다.

use std::collections::BTreeSet;
use std::path::{Path, PathBuf};
use std::sync::LazyLock;

use regex::Regex;
use serde_json::{Map, Value, json};

use crate::adapter::XdgApp;

/// opencode 자신의 이름표(`adapters/opencode.ts` 의 `xdgApp` 과 같다). kilo 는 어댑터 표의 `xdg_app` 을 넘긴다.
pub const OPENCODE_APP: XdgApp = XdgApp {
    dir: "opencode",
    config_file: "opencode.jsonc",
    schema: "https://opencode.ai/config.json",
    user_config_files: &["opencode.json"],
};

/// 읽기 전용 멘션 턴이 고르는 에이전트 이름.
pub const OPENCODE_READONLY_AGENT: &str = "harkroom-readonly";
/// API 키 연결(provider lane) 멘션 턴이 고르는 에이전트 이름.
pub const OPENCODE_LANE_AGENT: &str = "harkroom-lane";
/// lane provider 이름. 내장 `anthropic` 이 아니라 새 이름이어야 지운 `ANTHROPIC_API_KEY` 를 찾지 않는다.
pub const PROVIDER_LANE_OPENCODE_PROVIDER: &str = "harkroom-lane";
/// lane 블록에 남겨 둘 모델 수(n6). 넘치면 오래된 것부터 뺀다.
pub const PROVIDER_LANE_MODEL_KEEP: usize = 16;
/// lane 지시 파일 이름.
pub const LANE_INSTRUCTIONS_FILE: &str = "harkroom-lane-instructions.md";

/// lane 턴이 작업 폴더 안이어도 못 쓰는 자리 — 다음 턴의 도구·지시·MCP 를 바꾼다. kilo 이름도 같은 표에 든다.
const LANE_PROTECTED_PATHS: &[&str] = &[
    ".claude/*",
    ".opencode/*",
    "CLAUDE.md",
    "AGENTS.md",
    ".mcp.json",
    "opencode.json",
    "opencode.jsonc",
    ".kilo/*",
    ".kilocode/*",
    ".kilocoderules",
    "kilo.json",
    "kilo.jsonc",
];

/// lane 에이전트의 권한 표. 규칙은 **뒤에 적힌 것이 이긴다** — 맨 앞 `"*": "deny"` 가 기본 `ask` 까지 덮는다.
/// 열쇠 순서가 뜻이므로 `serde_json` 의 `preserve_order` 로 적은 순서를 지킨다.
pub fn opencode_lane_permission() -> Value {
    let mut edit = Map::new();
    edit.insert("*".into(), json!("allow"));
    for p in LANE_PROTECTED_PATHS {
        edit.insert((*p).into(), json!("deny"));
        edit.insert(format!("*/{p}"), json!("deny"));
    }
    let mut m = Map::new();
    m.insert("*".into(), json!("deny"));
    m.insert(
        "read".into(),
        json!({ "*": "allow", "*.env": "deny", "*.env.*": "deny" }),
    );
    m.insert("glob".into(), json!("allow"));
    m.insert("grep".into(), json!("allow"));
    m.insert("list".into(), json!("allow"));
    m.insert("todowrite".into(), json!("allow"));
    m.insert("skill".into(), json!({ "*": "deny" }));
    m.insert("edit".into(), Value::Object(edit));
    m.insert("harkroom_*".into(), json!("allow"));
    m.insert("avcs_*".into(), json!("allow"));
    Value::Object(m)
}

static CHANNEL_UUID: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(r"^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$")
        .expect("uuid 정규식")
});
/// 셸이 명령을 이어 붙이거나 바꿔 넣는 글자(operator `hookCli.ts` 의 `SHELL_META` 와 같은 줄).
static LANE_SHELL_META: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"[;&|`$<>(){}\\\n\r]").expect("셸 글자 정규식"));
static LANE_SKILL_NAME: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$").expect("스킬 이름 정규식"));
/// 모델 id 문법. 정본의 앞보기 `(?=.{1,128}$)` 는 `regex` crate 에 없어 길이를 따로 잰다(ASCII 만 받으므로 바이트 = 글자).
static LANE_MODEL_ID: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(r"^[A-Za-z0-9][A-Za-z0-9._:-]*(?:/[A-Za-z0-9._:-]+)*$").expect("모델 id 정규식")
});
static TRAILING_COMMA: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r",(\s*[}\]])").expect("끝 쉼표 정규식"));
static SKILL_FRONTMATTER: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"^---\r?\n((?s:.*?))\r?\n---").expect("frontmatter 정규식"));
static SKILL_NAME_LINE: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(r#"(?m)^name:[ \t\f\v]*["']?([^"'\r\n]+?)["']?[ \t\f\v]*$"#).expect("name 줄 정규식")
});

fn lane_model_id_ok(id: &str) -> bool {
    (1..=128).contains(&id.len()) && LANE_MODEL_ID.is_match(id)
}

/// 채널별 lane 에이전트 이름(`harkroom-lane-<채널 id>`). 채널 id 는 소문자 uuid 꼴만 받는다(security U3).
pub fn opencode_lane_agent_name(channel_id: &str) -> Option<String> {
    CHANNEL_UUID
        .is_match(channel_id)
        .then(|| format!("{OPENCODE_LANE_AGENT}-{channel_id}"))
}

/// 그 채널의 승인 규칙을 opencode `bash` 권한 표로 옮긴다. 명령 전체 규칙 `Bash(<명령>)` 만, `*`·`?`·셸 글자 없는 것만.
/// 맨 앞은 `"*": "deny"` 다(뒤가 이긴다).
pub fn lane_opencode_bash_table(tool_allows: &[impl AsRef<str>]) -> Map<String, Value> {
    let mut table = Map::new();
    table.insert("*".into(), json!("deny"));
    for rule in tool_allows {
        let rule = rule.as_ref();
        let Some(inner) = rule.strip_prefix("Bash(").and_then(|r| r.strip_suffix(')')) else {
            continue;
        };
        let cmd = inner.trim_matches(js_whitespace);
        if cmd.is_empty()
            || cmd.ends_with(":*")
            || cmd.contains(['*', '?'])
            || LANE_SHELL_META.is_match(cmd)
        {
            continue;
        }
        table.insert(cmd.into(), json!("allow"));
    }
    table
}

/// lane 에이전트의 스킬 권한: 러너가 깐 이름만 연다(security c).
pub fn lane_skill_permission(names: &[impl AsRef<str>]) -> Map<String, Value> {
    let mut m = Map::new();
    m.insert("*".into(), json!("deny"));
    for n in names
        .iter()
        .map(AsRef::as_ref)
        .filter(|n| LANE_SKILL_NAME.is_match(n))
    {
        m.insert(n.into(), json!("allow"));
    }
    m
}

/// `SKILL.md` 본문의 frontmatter `name`. 없으면 None.
pub fn skill_name_from_body(body: &str) -> Option<String> {
    let fm = SKILL_FRONTMATTER.captures(body)?.get(1)?.as_str();
    Some(SKILL_NAME_LINE.captures(fm)?.get(1)?.as_str().to_string())
}

/// 러너 스킬 자리의 `<slug>/SKILL.md` 이름들(정렬·중복 없음). 못 읽으면 빈 목록이다.
pub fn runner_skill_names(dir: Option<&Path>) -> Vec<String> {
    let Some(dir) = dir else { return Vec::new() };
    let Ok(entries) = std::fs::read_dir(dir) else {
        return Vec::new();
    };
    let mut out = BTreeSet::new();
    for e in entries.flatten() {
        let body = std::fs::read_to_string(e.path().join("SKILL.md")).unwrap_or_default();
        if let Some(n) = skill_name_from_body(&body) {
            out.insert(n);
        }
    }
    out.into_iter().collect()
}

/// 사람이 쓰는 opencode 설정 파일(provider 정의가 여기 있다). `xdg_config_home` 은 env `XDG_CONFIG_HOME`.
pub fn source_opencode_config(xdg_config_home: Option<&str>, home: &Path, app: &XdgApp) -> PathBuf {
    let base = xdg_config_home
        .map(PathBuf::from)
        .unwrap_or_else(|| home.join(".config"));
    base.join(app.dir).join(
        app.user_config_files
            .first()
            .copied()
            .unwrap_or(app.config_file),
    )
}

/// 사람이 쓰는 opencode data 루트. `xdg_data_home` 은 env `XDG_DATA_HOME`.
pub fn source_opencode_data(xdg_data_home: Option<&str>, home: &Path, app: &XdgApp) -> PathBuf {
    let base = xdg_data_home
        .map(PathBuf::from)
        .unwrap_or_else(|| home.join(".local").join("share"));
    base.join(app.dir)
}

/// 러너 전용 루트 안의 세 XDG 디렉터리 — 곧 자식에게 줄 env 다.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct OpencodeDirs {
    pub xdg_config_home: PathBuf,
    pub xdg_data_home: PathBuf,
    pub xdg_state_home: PathBuf,
}

pub fn opencode_dirs(opencode_home: &Path) -> OpencodeDirs {
    OpencodeDirs {
        xdg_config_home: opencode_home.join("config"),
        xdg_data_home: opencode_home.join("data"),
        xdg_state_home: opencode_home.join("state"),
    }
}

/// 이 루트에서 opencode 가 읽는 설정 파일.
pub fn opencode_config_file(opencode_home: &Path, app: &XdgApp) -> PathBuf {
    opencode_dirs(opencode_home)
        .xdg_config_home
        .join(app.dir)
        .join(app.config_file)
}

/// lane 턴의 홈 표지 자리(`OPENCODE_TEST_HOME`) — 비워 둔 폴더라 사람 홈의 지시·스킬이 안 실린다.
pub fn opencode_lane_home(opencode_home: &Path) -> PathBuf {
    opencode_home.join("lane-home")
}

/// 오퍼레이터가 만든 MCP 표(claude 형식)를 opencode 모양으로 옮긴다. stdio → `local`(명령 배열), http/sse → `remote`.
/// 모르는 갈래는 **버린다** — 잘못 만든 항목 하나가 설정 전체를 거절시킨다.
pub fn to_opencode_mcp(servers: &Map<String, Value>) -> Map<String, Value> {
    let mut out = Map::new();
    for (name, def) in servers {
        if let Some(url) = def.get("url").and_then(Value::as_str) {
            let mut e = Map::new();
            e.insert("type".into(), json!("remote"));
            e.insert("url".into(), json!(url));
            e.insert("enabled".into(), json!(true));
            if let Some(h) = def.get("headers").filter(|h| !h.is_null()) {
                e.insert("headers".into(), h.clone());
            }
            out.insert(name.clone(), Value::Object(e));
            continue;
        }
        if let Some(cmd) = def.get("command").and_then(Value::as_str) {
            let mut argv = vec![json!(cmd)];
            if let Some(args) = def.get("args").and_then(Value::as_array) {
                argv.extend(args.iter().cloned());
            }
            let mut e = Map::new();
            e.insert("type".into(), json!("local"));
            e.insert("command".into(), Value::Array(argv));
            e.insert("enabled".into(), json!(true));
            if let Some(env) = def.get("env").filter(|v| !v.is_null()) {
                e.insert("environment".into(), env.clone());
            }
            out.insert(name.clone(), Value::Object(e));
        }
    }
    out
}

/// lane 모델 칸의 값에서 gateway 가 받는 id 를 꺼낸다(옛 `harkroom-lane/` 머리는 뗀다). 문법에 안 맞으면 None.
pub fn provider_lane_model_id(model: Option<&str>) -> Option<String> {
    let raw = model.unwrap_or("").trim_matches(js_whitespace);
    let id = raw
        .strip_prefix(&format!("{PROVIDER_LANE_OPENCODE_PROVIDER}/"))
        .unwrap_or(raw);
    lane_model_id_ok(id).then(|| id.to_string())
}

/// lane 턴이 하네스에 넘길 모델 이름. XDG 홈 하네스는 `harkroom-lane/<id>`, 나머지는 원문. lane 이 아니면 그대로다.
pub fn lane_run_model(lane: bool, xdg_home: bool, model: Option<&str>) -> Option<String> {
    if !lane {
        return model.map(str::to_string);
    }
    if xdg_home {
        return provider_lane_model_id(model)
            .map(|id| format!("{PROVIDER_LANE_OPENCODE_PROVIDER}/{id}"));
    }
    let prefix = format!("{PROVIDER_LANE_OPENCODE_PROVIDER}/");
    model.map(|m| m.strip_prefix(&prefix).unwrap_or(m).to_string())
}

/// XDG 홈 lane 턴의 모델이 비었거나 문법에 안 맞아 띄워 봐야 서는가. 참이면 러너는 키를 받기 전에 `bad_model` 로 실패한다.
pub fn opencode_lane_model_missing(lane: bool, xdg_home: bool, model: Option<&str>) -> bool {
    lane && xdg_home && provider_lane_model_id(model).is_none()
}

/// 지난번 설정 파일 본문에 적힌 lane 모델 id 들(n6) — 덮지 않고 쌓는다. 문법은 다시 잰다. 못 읽으면 빈 목록.
pub fn previous_lane_models(config_text: &str) -> Vec<String> {
    let Ok(doc) = serde_json::from_str::<Value>(config_text) else {
        return Vec::new();
    };
    match doc.pointer(&format!(
        "/provider/{PROVIDER_LANE_OPENCODE_PROVIDER}/models"
    )) {
        Some(Value::Object(models)) => models
            .keys()
            .filter(|id| lane_model_id_ok(id))
            .cloned()
            .collect(),
        _ => Vec::new(),
    }
}

/// 지난 설정 파일 본문의 채널 칸들의 `bash` 표. 이름 꼴과 표 모양(값 allow/deny, 맨 앞 `*` deny, 열쇠에 패턴·셸 글자 없음)을
/// 다시 재고, 어긋난 칸은 버린다.
pub fn previous_lane_channel_agents(config_text: &str) -> Map<String, Value> {
    let mut out = Map::new();
    let Ok(doc) = serde_json::from_str::<Value>(config_text) else {
        return out;
    };
    let Some(agents) = doc.get("agent").and_then(Value::as_object) else {
        return out;
    };
    let prefix = format!("{OPENCODE_LANE_AGENT}-");
    for (name, def) in agents {
        let Some(id) = name.strip_prefix(&prefix).filter(|id| !id.is_empty()) else {
            continue;
        };
        if opencode_lane_agent_name(id).as_deref() != Some(name.as_str()) {
            continue;
        }
        let Some(bash) = def.pointer("/permission/bash").and_then(Value::as_object) else {
            continue;
        };
        let first_ok = bash
            .iter()
            .next()
            .is_some_and(|(k, v)| k == "*" && v == "deny");
        let all_ok = bash.iter().all(|(k, v)| {
            (v == "allow" || v == "deny")
                && (k == "*" || (!k.contains(['*', '?']) && !LANE_SHELL_META.is_match(k)))
        });
        if first_ok && all_ok {
            out.insert(name.clone(), Value::Object(bash.clone()));
        }
    }
    out
}

/// 쓴 뒤 확인(U2)의 순수 절반: 설정 본문의 그 채널 칸이 primary 이고 `bash` 표가 지금 규칙으로 계산한 표와 (순서까지) 같은가.
pub fn opencode_lane_agent_matches_text(
    config_text: &str,
    channel_id: &str,
    tool_allows: &[impl AsRef<str>],
) -> bool {
    let Some(name) = opencode_lane_agent_name(channel_id) else {
        return false;
    };
    let Ok(doc) = serde_json::from_str::<Value>(config_text) else {
        return false;
    };
    let Some(def) = doc.get("agent").and_then(|a| a.get(&name)) else {
        return false;
    };
    if def.get("mode").and_then(Value::as_str) != Some("primary") {
        return false;
    }
    let want = lane_opencode_bash_table(tool_allows);
    match def.pointer("/permission/bash").and_then(Value::as_object) {
        // JSON.stringify 비교와 같은 뜻: 열쇠 순서까지 같아야 한다.
        Some(got) => got.iter().eq(want.iter()),
        None => false,
    }
}

/// lane provider 블록(security ⓕ). 주소·키는 없다 — 그 턴의 파일이 준다. 이 턴 모델 + 지난 모델(최대 `PROVIDER_LANE_MODEL_KEEP`).
pub fn provider_lane_config(model: Option<&str>, previous: &[String]) -> Map<String, Value> {
    let id = provider_lane_model_id(model);
    let name = PROVIDER_LANE_OPENCODE_PROVIDER;
    let mut ids: Vec<&str> = previous
        .iter()
        .map(String::as_str)
        .filter(|x| Some(*x) != id.as_deref())
        .collect();
    if let Some(id) = id.as_deref() {
        ids.push(id);
    }
    let start = ids.len().saturating_sub(PROVIDER_LANE_MODEL_KEEP);
    let mut models = Map::new();
    for x in &ids[start..] {
        models.insert((*x).into(), json!({ "name": x }));
    }
    let mut provider = Map::new();
    provider.insert(
        name.into(),
        json!({ "npm": "@ai-sdk/anthropic", "name": "Harkroom provider lane", "models": Value::Object(models) }),
    );
    let mut out = Map::new();
    out.insert("provider".into(), Value::Object(provider));
    out.insert("enabled_providers".into(), json!([name]));
    out.insert("autoupdate".into(), json!(false));
    if let Some(id) = id {
        out.insert("model".into(), json!(format!("{name}/{id}")));
        out.insert("small_model".into(), json!(format!("{name}/{id}")));
    }
    out
}

/// JSONC(주석·끝 쉼표)를 JSON 으로. 문자열 안의 `//`(URL)는 건드리지 않는다. 정본과 같게 끝 쉼표 걷기는 본문 전체에 건다.
pub fn strip_jsonc(text: &str) -> String {
    let c: Vec<char> = text.chars().collect();
    let mut out = String::with_capacity(text.len());
    let mut i = 0;
    while i < c.len() {
        let ch = c[i];
        if ch == '"' {
            let mut j = i + 1;
            while j < c.len() && c[j] != '"' {
                j += if c[j] == '\\' { 2 } else { 1 };
            }
            out.extend(&c[i..(j + 1).min(c.len())]);
            i = j;
        } else if ch == '/' && c.get(i + 1) == Some(&'/') {
            while i < c.len() && c[i] != '\n' {
                i += 1;
            }
            out.push('\n');
        } else if ch == '/' && c.get(i + 1) == Some(&'*') {
            i += 2;
            while i < c.len() && !(c[i] == '*' && c.get(i + 1) == Some(&'/')) {
                i += 1;
            }
            i += 1;
        } else {
            out.push(ch);
        }
        i += 1;
    }
    TRAILING_COMMA.replace_all(&out, "$1").into_owned()
}

/// JS `String.prototype.trim` 이 걷는 글자(유니코드 공백 + BOM). Rust `char::is_whitespace` 에는 BOM 이 없다.
fn js_whitespace(c: char) -> bool {
    c.is_whitespace() || c == '\u{feff}'
}

#[cfg(test)]
mod tests;
