//! stdio MCP 정의를 넣기 전에 **사람에게 OS 확인창으로 묻는다.**
//!
//! stdio 정의의 명령은 에이전트 턴이 이 맥에서 그대로 실행한다. 웹뷰는 서버가 보낸 글을 그리는 표면이라, 웹뷰가 혼자
//! 프로그램을 고를 수 있으면 웹뷰가 뚫리는 순간이 곧 임의 실행이다(#431 의 경계). 그래서 확인을 웹뷰 밖에 둔다:
//! 이 창은 Rust 가 띄우고, `capabilities/default.json` 에 dialog 권한이 없어 웹뷰가 창을 부르거나 누를 수 없다.
//!
//! - **창의 글자가 곧 저장되는 글자다.** 안 보이는 글자는 거절하고(`check`), 창이 잘리지 않도록 길이를 묶는다.
//!   웹뷰가 주는 설명 문구는 창에 넣지 않는다 — 고정 문구와 명령·인자·env 이름뿐이다.
//! - **기본 버튼이 취소다.** 웹뷰가 사람이 Enter 를 치는 순간에 맞춰 창을 띄워도 저장되지 않는다.
//! - **한 번에 창 하나.** 거절해도 곧바로 겹쳐 뜨지 않는다.
//! - env 값은 창에 넣지 않는다(토큰이 있다). 값이 실행되는 코드를 바꾸는 변수는 오퍼레이터가 거절하고(`shared/mcpStdio.ts`),
//!   값이 안 보인다는 사실은 창이 고정 문구로 말한다.

use std::collections::BTreeMap;
use std::sync::atomic::{AtomicBool, Ordering};

// `shared/src/mcpStdio.ts` 의 `MCP_STDIO_LIMITS` 와 같은 값이다. 오퍼레이터가 저장 전에 다시 잰다.
const MAX_COMMAND: usize = 512;
const MAX_ARG: usize = 512;
const MAX_ARGS: usize = 24;
const MAX_TOTAL: usize = 1500;
const MAX_ENV_NAMES: usize = 32;
const MAX_ENV_NAME: usize = 128;

pub struct StdioRequest {
    pub name: String,
    pub command: String,
    pub args: Vec<String>,
    pub env: BTreeMap<String, String>,
    pub keep_env: Vec<String>,
}

/// 설정 화면은 메인 창에만 있다. 채널·스레드 새 창과 미리보기 창에서는 부르지 못한다.
pub fn ensure_main_window(label: &str) -> Result<(), String> {
    if label == "main" {
        Ok(())
    } else {
        Err(format!("이 창({label})에서는 stdio MCP 를 넣을 수 없다"))
    }
}

/// 창에 그대로 보이는 글자인가 — 제어·서식·줄 나눔 글자와 긴 공백(뒤 인자를 창 밖으로 민다)을 거절한다.
fn shown_as_is(text: &str) -> bool {
    let mut spaces = 0;
    for c in text.chars() {
        if c.is_control() || c == '\u{2028}' || c == '\u{2029}' || crate::attachment_save::is_format_char(c) {
            return false;
        }
        spaces = if c.is_whitespace() { spaces + 1 } else { 0 };
        if spaces >= 4 {
            return false;
        }
    }
    true
}

fn env_name_ok(name: &str) -> bool {
    let mut chars = name.chars();
    name.len() <= MAX_ENV_NAME
        && chars.next().is_some_and(|c| c.is_ascii_alphabetic() || c == '_')
        && chars.all(|c| c.is_ascii_alphanumeric() || c == '_')
}

/// 창을 띄우기 전의 검사. 잘라서 보이는 일이 없도록 넘으면 창을 띄우지 않는다.
pub fn check(r: &StdioRequest) -> Result<(), String> {
    let name_ok = !r.name.is_empty()
        && r.name.len() <= 32
        && r.name.chars().all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || c == '-');
    if !name_ok {
        return Err("stdio MCP 의 이름은 [a-z0-9-] 1~32자다".into());
    }
    if r.command.is_empty() || r.command.chars().count() > MAX_COMMAND || r.args.len() > MAX_ARGS {
        return Err("stdio MCP 의 명령·인자가 상한을 넘었다".into());
    }
    let mut total = r.command.chars().count();
    for text in std::iter::once(&r.command).chain(r.args.iter()) {
        if !shown_as_is(text) {
            return Err("stdio MCP 의 명령·인자에 화면에 안 보이는 글자가 있다".into());
        }
    }
    for arg in &r.args {
        let n = arg.chars().count();
        if n > MAX_ARG {
            return Err("stdio MCP 의 인자가 상한을 넘었다".into());
        }
        total += n;
    }
    if total > MAX_TOTAL {
        return Err("stdio MCP 의 명령·인자가 상한을 넘었다".into());
    }
    if r.env.len() + r.keep_env.len() > MAX_ENV_NAMES
        || !r.env.keys().chain(r.keep_env.iter()).all(|k| env_name_ok(k))
    {
        return Err("stdio MCP 의 env 이름을 받을 수 없다".into());
    }
    Ok(())
}

struct Words {
    title: &'static str,
    lead: &'static str,
    command: &'static str,
    args: &'static str,
    env_note: &'static str,
    env_new: &'static str,
    env_keep: &'static str,
    allow: &'static str,
    cancel: &'static str,
}

const KO: Words = Words {
    title: "stdio MCP 서버 실행 허용",
    lead: "이 명령은 이 서버를 켠 에이전트의 턴마다 이 맥에서 내 권한으로 실행된다. 직접 입력한 내용이 맞을 때만 허용한다.",
    command: "명령",
    args: "인자",
    env_note: "환경 변수의 값은 여기 보이지 않는다. 직접 넣은 이름이 아니면 취소한다.",
    env_new: "새로 넣는 환경 변수",
    env_keep: "그대로 두는 환경 변수",
    allow: "실행 허용",
    cancel: "취소",
};

const EN: Words = Words {
    title: "Allow stdio MCP server to run",
    lead: "This command runs on this Mac with your permissions on every turn of an agent that uses this server. Allow it only if you entered exactly this.",
    command: "Command",
    args: "Arguments",
    env_note: "Environment variable values are not shown here. Cancel unless you entered these names yourself.",
    env_new: "New environment variables",
    env_keep: "Environment variables kept as they are",
    allow: "Allow to run",
    cancel: "Cancel",
};

/// 창의 본문. 인자는 경계가 보이도록 번호를 붙여 한 줄씩 적는다.
fn body(r: &StdioRequest, w: &Words) -> String {
    let mut out = format!("{}\n\n{}\n", w.lead, r.name);
    out.push_str(&format!("{}: {}\n", w.command, r.command));
    if !r.args.is_empty() {
        out.push_str(&format!("{}:\n", w.args));
        for (i, arg) in r.args.iter().enumerate() {
            out.push_str(&format!("  {}. {}\n", i + 1, arg));
        }
    }
    if !r.env.is_empty() || !r.keep_env.is_empty() {
        out.push_str(&format!("\n{}\n", w.env_note));
    }
    if !r.env.is_empty() {
        let names: Vec<&str> = r.env.keys().map(String::as_str).collect();
        out.push_str(&format!("{}: {}\n", w.env_new, names.join(", ")));
    }
    if !r.keep_env.is_empty() {
        out.push_str(&format!("{}: {}\n", w.env_keep, r.keep_env.join(", ")));
    }
    out
}

/// 첫 버튼이 Enter 를 받으므로 **취소를 첫 버튼에 둔다.**
fn approved(result: &tauri_plugin_dialog::MessageDialogResult, allow: &str) -> bool {
    matches!(result, tauri_plugin_dialog::MessageDialogResult::Custom(label) if label == allow)
}

static ASKING: AtomicBool = AtomicBool::new(false);

/// 창이 닫힐 때까지 막는다 — 메인 스레드에서 부르지 않는다(`on_daemon_pool` 위에서 부른다).
pub fn ask_human(app: &tauri::AppHandle, r: &StdioRequest, locale: &str) -> Result<bool, String> {
    use tauri_plugin_dialog::{DialogExt, MessageDialogButtons, MessageDialogKind};

    if ASKING.swap(true, Ordering::SeqCst) {
        return Err("이미 떠 있는 확인창이 있다".into());
    }
    let w = if locale == "ko" { &KO } else { &EN };
    let result = app
        .dialog()
        .message(body(r, w))
        .title(w.title)
        .kind(MessageDialogKind::Warning)
        .buttons(MessageDialogButtons::OkCancelCustom(w.cancel.to_string(), w.allow.to_string()))
        .blocking_show_with_result();
    ASKING.store(false, Ordering::SeqCst);
    Ok(approved(&result, w.allow))
}

#[cfg(test)]
mod tests {
    use super::*;
    use tauri_plugin_dialog::MessageDialogResult;

    fn request(command: &str, args: &[&str]) -> StdioRequest {
        StdioRequest {
            name: "local-files".into(),
            command: command.into(),
            args: args.iter().map(|a| a.to_string()).collect(),
            env: BTreeMap::new(),
            keep_env: vec![],
        }
    }

    #[test]
    fn 평범한_명령은_통과한다() {
        assert!(check(&request("/opt/tools/files-mcp", &["--root", "/srv/my files"])).is_ok());
        assert!(check(&request("npx", &["-y", "example-mcp"])).is_ok());
    }

    #[test]
    fn 안_보이는_글자와_긴_공백은_창을_띄우지_않는다() {
        for bad in ["a\nb", "a\u{202E}b", "a\u{200B}b", "a\u{2028}b", "a\tb", "a    b"] {
            assert!(check(&request("x", &[bad])).is_err(), "인자 {bad:?}");
            assert!(check(&request(bad, &[])).is_err(), "명령 {bad:?}");
        }
    }

    #[test]
    fn 상한을_넘으면_자르지_않고_거절한다() {
        assert!(check(&request(&"a".repeat(513), &[])).is_err());
        assert!(check(&request("x", &[&"a".repeat(513)])).is_err());
        assert!(check(&request("x", &vec!["a"; 25])).is_err());
        assert!(check(&request("x", &vec![&"a".repeat(100) as &str; 16])).is_err());
    }

    #[test]
    fn env_이름은_문법을_지키고_값은_창에_없다() {
        let mut r = request("x", &[]);
        r.env.insert("API_TOKEN".into(), "SECRET-VALUE".into());
        r.keep_env.push("KEPT".into());
        assert!(check(&r).is_ok());
        let shown = body(&r, &KO);
        assert!(shown.contains("API_TOKEN") && shown.contains("KEPT"));
        assert!(!shown.contains("SECRET-VALUE"));
        // 값이 안 보인다는 말은 env 줄보다 앞에 온다.
        assert!(shown.find(KO.env_note).unwrap() < shown.find("API_TOKEN").unwrap());
        assert!(!body(&request("x", &[]), &KO).contains(KO.env_note));
        r.env.insert("A=B".into(), "v".into());
        assert!(check(&r).is_err());
    }

    #[test]
    fn 본문에_이름_명령_인자가_모두_보인다() {
        let shown = body(&request("/opt/mcp", &["--a", "b c"]), &EN);
        for part in ["local-files", "/opt/mcp", "1. --a", "2. b c"] {
            assert!(shown.contains(part), "{part} 없음: {shown}");
        }
    }

    #[test]
    fn 허용_버튼만_허락이다() {
        assert!(approved(&MessageDialogResult::Custom(KO.allow.to_string()), KO.allow));
        assert!(!approved(&MessageDialogResult::Custom(KO.cancel.to_string()), KO.allow));
        assert!(!approved(&MessageDialogResult::Ok, KO.allow));
        assert!(!approved(&MessageDialogResult::Cancel, KO.allow));
    }

    #[test]
    fn 메인_창에서만_부른다() {
        assert!(ensure_main_window("main").is_ok());
        assert!(ensure_main_window("win-abc").is_err());
        assert!(ensure_main_window("preview").is_err());
    }
}
