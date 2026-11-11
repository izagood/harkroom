//! `harkroom-operator-rs api <연결> <METHOD> </경로> [--data @파일|<글자>] [--content-type <형식>]` — 외부 API 래퍼의
//! **하네스 쪽**(TS `main.ts::apiMain`·`turnApi.ts::parseApiArgs` 이식, s21b-3d-3a).
//!
//! 인자를 재고 본문 파일을 읽어 오퍼레이터에 `api.call` 한 번으로 넘긴다. 판정·키·호출은 전부 오퍼레이터 쪽(`turn_api.rs`)이고
//! 이 프로세스는 키도 임대도 모른다. 결과 JSON 한 줄에 `exit` 를 싣는다(꼬리 `; echo $?` 를 붙이면 allow 규칙이 깨진다).
use crate::merge::{
    ENV_CAUSE, ENV_RUNNER_ID, ENV_SECRET, ENV_SOCKET, LinkEnv, ToolReply, call_operator_tool,
};
use crate::turn_api::{API_MAX_BODY, API_METHODS, API_TOOL, is_connector};
use serde_json::{Map, Value, json};
use std::time::Duration;

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ApiArgs {
    pub connector: String,
    pub method: String,
    pub path: String,
    pub body: Option<String>,
    pub content_type: Option<String>,
}

const USAGE: &str = "사용법: harkroom-operator api <연결> <GET|POST|PUT|PATCH|DELETE> </경로> [--data @파일|<글자>] [--content-type <형식>]";

/// TS `/^[\w.+-]+\/[\w.+-]+(;\s*charset=[\w-]+)?$/i`.
fn is_content_type(s: &str) -> bool {
    let tok = |t: &str| {
        !t.is_empty()
            && t.chars()
                .all(|c| c.is_ascii_alphanumeric() || "_.+-".contains(c))
    };
    let (mime, rest) = match s.find(';') {
        Some(i) => (&s[..i], Some(&s[i + 1..])),
        None => (s, None),
    };
    let Some((a, b)) = mime.split_once('/') else {
        return false;
    };
    if !tok(a) || !tok(b) {
        return false;
    }
    match rest {
        None => true,
        Some(r) => {
            let r = r.trim_start_matches([' ', '\t', '\n', '\r', '\x0b', '\x0c']);
            let lower = r.to_ascii_lowercase();
            let Some(v) = lower.strip_prefix("charset=") else {
                return false;
            };
            !v.is_empty()
                && v.chars()
                    .all(|c| c.is_ascii_alphanumeric() || c == '_' || c == '-')
        }
    }
}

/// TS `parseApiArgs` 와 같은 순서·문구. `read_file` 은 `@파일` 을 읽는다(경로는 cwd 기준).
pub fn parse_api_args(
    argv: &[String],
    read_file: impl Fn(&str) -> std::io::Result<Vec<u8>>,
) -> Result<ApiArgs, String> {
    let (Some(connector), Some(raw_method), Some(path)) = (argv.first(), argv.get(1), argv.get(2))
    else {
        return Err(USAGE.into());
    };
    if connector.is_empty() || raw_method.is_empty() || path.is_empty() {
        return Err(USAGE.into());
    }
    if !is_connector(connector) {
        return Err(format!("연결 이름이 아니다: {connector}"));
    }
    let method = raw_method.to_uppercase();
    if !API_METHODS.contains(&method.as_str()) {
        return Err(format!("메서드가 아니다: {raw_method}"));
    }
    // TS 의 length 는 UTF-16 단위다 — 2000 은 ASCII 경로에서 같고, 비 ASCII 는 서버·오퍼레이터가 다시 거른다.
    if !path.starts_with('/') || path.encode_utf16().count() > 2000 {
        return Err(
            "경로는 / 로 시작한다(전체 URL 이 아니라 경로만 — 주소는 연결이 정한다)".into(),
        );
    }
    let rest = &argv[3..];
    let mut body: Option<String> = None;
    let mut content_type: Option<String> = None;
    let mut i = 0;
    while i < rest.len() {
        let flag = &rest[i];
        let Some(value) = rest.get(i + 1) else {
            return Err(format!("{flag} 에 값이 없다"));
        };
        if flag == "--data" && body.is_none() {
            if let Some(p) = value.strip_prefix('@') {
                let buf = read_file(p).map_err(|_| format!("파일을 읽지 못했다: {p}"))?;
                if buf.len() > API_MAX_BODY {
                    return Err(format!("본문이 {API_MAX_BODY} 바이트보다 크다"));
                }
                body = Some(String::from_utf8_lossy(&buf).into_owned());
            } else {
                if value.len() > API_MAX_BODY {
                    return Err(format!("본문이 {API_MAX_BODY} 바이트보다 크다"));
                }
                body = Some(value.clone());
            }
            i += 2;
            continue;
        }
        if flag == "--content-type" && content_type.is_none() && is_content_type(value) {
            content_type = Some(value.clone());
            i += 2;
            continue;
        }
        return Err(format!(
            "받지 않는 인자: {flag} — --data·--content-type 만 받는다(헤더·주소는 연결이 정한다)"
        ));
    }
    if let Some(b) = &body
        && (method == "GET" || method == "DELETE")
        && !b.is_empty()
    {
        return Err(format!("{method} 에는 본문을 싣지 않는다"));
    }
    let content_type = body
        .as_ref()
        .map(|_| content_type.unwrap_or_else(|| "application/json".into()));
    Ok(ApiArgs {
        connector: connector.clone(),
        method,
        path: path.clone(),
        body,
        content_type,
    })
}

/// `--data @파일` 을 읽는다(#1882 정리, TS `readApiBodyFile` 과 같은 규칙).
/// - 작업 폴더(`base`, 하네스 셸의 cwd) **안의 일반 파일**만 — 절대 경로·`..`·심링크로 밖을 가리키면 거절한다.
///   판정은 실제 경로(canonicalize)끼리 하고, 연 핸들의 종류를 다시 본다.
/// - 상한+1 바이트까지만 읽는다 — 큰 파일·끝없는 파일(`/dev/zero` 류)을 통째로 메모리에 올리지 않는다.
///   상한을 넘었는지는 `parse_api_args` 가 길이로 판정한다.
pub fn read_body_file(base: &std::path::Path, p: &str) -> std::io::Result<Vec<u8>> {
    use std::io::{Error, ErrorKind, Read};
    let rel = std::path::Path::new(p);
    if p.is_empty()
        || rel.is_absolute()
        || rel.components().any(|c| {
            !matches!(
                c,
                std::path::Component::Normal(_) | std::path::Component::CurDir
            )
        })
    {
        return Err(Error::new(
            ErrorKind::PermissionDenied,
            "outside the working folder",
        ));
    }
    let root = base.canonicalize()?;
    let real = root.join(rel).canonicalize()?;
    if !real.starts_with(&root) {
        return Err(Error::new(
            ErrorKind::PermissionDenied,
            "outside the working folder",
        ));
    }
    // FIFO 를 열면 쓰는 쪽이 올 때까지 멈춘다 — 열기 전에 종류를 보고, O_NONBLOCK·O_NOFOLLOW 로 연 뒤 핸들에서 다시 본다.
    if !std::fs::symlink_metadata(&real)?.is_file() {
        return Err(Error::new(ErrorKind::InvalidInput, "not a regular file"));
    }
    let f = {
        use std::os::unix::fs::OpenOptionsExt;
        std::fs::OpenOptions::new()
            .read(true)
            .custom_flags(libc::O_NOFOLLOW | libc::O_NONBLOCK)
            .open(&real)?
    };
    if !f.metadata()?.is_file() {
        return Err(Error::new(ErrorKind::InvalidInput, "not a regular file"));
    }
    let mut buf = Vec::new();
    f.take(API_MAX_BODY as u64 + 1).read_to_end(&mut buf)?;
    Ok(buf)
}

/// TS `{ ...out, exit }`.
pub fn render_api(reply: &ToolReply) -> (String, i32) {
    let mut out: Map<String, Value> = match serde_json::from_str::<Value>(&reply.text) {
        Ok(Value::Object(m)) => m,
        Ok(Value::Array(a)) => a
            .into_iter()
            .enumerate()
            .map(|(i, v)| (i.to_string(), v))
            .collect(),
        Ok(_) => Map::new(),
        Err(_) => {
            let mut m = Map::new();
            m.insert("raw".into(), json!(reply.text));
            m
        }
    };
    let exit = if reply.ok { 0 } else { 1 };
    out.insert("exit".into(), json!(exit));
    (Value::Object(out).to_string(), exit)
}

/// `apiMain` 전체: (출력 한 줄, 종료 코드).
pub fn api_main(
    argv: &[String],
    link: Option<LinkEnv>,
    read_file: impl Fn(&str) -> std::io::Result<Vec<u8>>,
    timeout: Duration,
) -> (String, i32) {
    let parsed = match parse_api_args(argv, read_file) {
        Ok(p) => p,
        Err(message) => {
            return (
                json!({ "error": { "code": "bad_request", "message": message }, "exit": 2 })
                    .to_string(),
                2,
            );
        }
    };
    let Some(link) = link else {
        let message = format!(
            "{ENV_SOCKET}·{ENV_RUNNER_ID}·{ENV_SECRET}·{ENV_CAUSE} are required — the wrapper only runs inside a runner-launched mention turn"
        );
        return (
            json!({ "error": { "code": "not_in_turn", "message": message }, "exit": 2 })
                .to_string(),
            2,
        );
    };
    let args = json!({
        "connector": parsed.connector, "method": parsed.method, "path": parsed.path,
        "body": parsed.body, "contentType": parsed.content_type,
    });
    render_api(&call_operator_tool(&link, API_TOOL, args, timeout))
}

#[cfg(test)]
mod tests {
    #[test]
    fn read_body_file_stays_inside_the_working_folder() {
        let root = std::env::temp_dir().join(format!("hk-apibody-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&root);
        let work = root.join("work");
        std::fs::create_dir_all(work.join("sub")).unwrap();
        std::fs::write(work.join("sub/b.json"), b"{}").unwrap();
        std::fs::write(root.join("outside.txt"), b"secret").unwrap();
        std::os::unix::fs::symlink(root.join("outside.txt"), work.join("link")).unwrap();
        std::os::unix::fs::symlink(&root, work.join("dirlink")).unwrap();
        // 안의 일반 파일은 읽는다.
        assert_eq!(read_body_file(&work, "sub/b.json").unwrap(), b"{}");
        assert_eq!(read_body_file(&work, "./sub/b.json").unwrap(), b"{}");
        // 절대 경로·..·밖을 가리키는 심링크(파일·폴더)·폴더는 거절.
        let abs = root.join("outside.txt").to_string_lossy().into_owned();
        for p in [
            abs.as_str(),
            "../outside.txt",
            "sub/../../outside.txt",
            "link",
            "dirlink/outside.txt",
            "sub",
            "",
        ] {
            assert!(read_body_file(&work, p).is_err(), "{p} 는 거절돼야 한다");
        }
        // 상한+1 까지만 읽는다 → parse_api_args 가 크다고 거절한다.
        let big = vec![b'a'; API_MAX_BODY + 10];
        std::fs::write(work.join("big"), &big).unwrap();
        assert_eq!(
            read_body_file(&work, "big").unwrap().len(),
            API_MAX_BODY + 1
        );
        let argv: Vec<String> = ["c", "POST", "/x", "--data", "@big"]
            .iter()
            .map(|s| s.to_string())
            .collect();
        let err = parse_api_args(&argv, |p| read_body_file(&work, p)).unwrap_err();
        assert!(err.contains("바이트보다 크다"), "{err}");
        let _ = std::fs::remove_dir_all(&root);
    }

    use super::*;

    fn v(a: &[&str]) -> Vec<String> {
        a.iter().map(|s| s.to_string()).collect()
    }
    fn no_file(_: &str) -> std::io::Result<Vec<u8>> {
        Err(std::io::Error::other("x"))
    }

    #[test]
    fn parses_like_ts() {
        let a =
            parse_api_args(&v(&["linear", "post", "/graphql", "--data", "{}"]), no_file).unwrap();
        assert_eq!(a.method, "POST");
        assert_eq!(a.body.as_deref(), Some("{}"));
        assert_eq!(a.content_type.as_deref(), Some("application/json"));
        let g = parse_api_args(&v(&["linear", "GET", "/me"]), no_file).unwrap();
        assert_eq!((g.body, g.content_type), (None, None));
        let f = parse_api_args(
            &v(&[
                "c1",
                "PUT",
                "/x",
                "--data",
                "@b.json",
                "--content-type",
                "text/plain; charset=utf-8",
            ]),
            |p| {
                assert_eq!(p, "b.json");
                Ok(b"hi".to_vec())
            },
        )
        .unwrap();
        assert_eq!(f.body.as_deref(), Some("hi"));
        assert_eq!(f.content_type.as_deref(), Some("text/plain; charset=utf-8"));
    }

    #[test]
    fn rejects_like_ts() {
        let e = |a: &[&str]| parse_api_args(&v(a), no_file).unwrap_err();
        assert!(e(&["linear", "GET"]).starts_with("사용법:"));
        assert!(e(&["Bad Name", "GET", "/x"]).starts_with("연결 이름이 아니다"));
        assert!(e(&["linear", "TRACE", "/x"]).starts_with("메서드가 아니다"));
        assert!(e(&["linear", "GET", "https://x/y"]).starts_with("경로는 / 로 시작한다"));
        assert!(e(&["linear", "POST", "/x", "--data"]).ends_with("에 값이 없다"));
        assert!(
            e(&["linear", "POST", "/x", "--header", "a"]).starts_with("받지 않는 인자: --header")
        );
        assert!(e(&["linear", "POST", "/x", "--data", "@nope"]).starts_with("파일을 읽지 못했다"));
        assert_eq!(
            e(&["linear", "GET", "/x", "--data", "a"]),
            "GET 에는 본문을 싣지 않는다"
        );
        assert!(
            e(&["linear", "POST", "/x", "--content-type", "bad type"])
                .starts_with("받지 않는 인자")
        );
        let big = "x".repeat(API_MAX_BODY + 1);
        assert!(
            parse_api_args(&v(&["linear", "POST", "/x", "--data", &big]), no_file)
                .unwrap_err()
                .contains("바이트보다 크다")
        );
    }

    #[test]
    fn main_renders_bad_request_and_not_in_turn() {
        let (line, code) = api_main(&v(&["linear"]), None, no_file, Duration::from_secs(1));
        assert_eq!(code, 2);
        let j: Value = serde_json::from_str(&line).unwrap();
        assert_eq!(j["error"]["code"], "bad_request");
        assert_eq!(j["exit"], 2);
        let (line, code) = api_main(
            &v(&["linear", "GET", "/me"]),
            None,
            no_file,
            Duration::from_secs(1),
        );
        assert_eq!(code, 2);
        assert!(line.contains("not_in_turn"));
    }

    #[test]
    fn render_appends_exit() {
        let (l, c) = render_api(&ToolReply {
            ok: true,
            text: r#"{"status":200,"body":"{}"}"#.into(),
        });
        assert_eq!(
            (l.as_str(), c),
            (r#"{"status":200,"body":"{}","exit":0}"#, 0)
        );
        let (l, c) = render_api(&ToolReply {
            ok: false,
            text: "nope".into(),
        });
        assert_eq!((l.as_str(), c), (r#"{"raw":"nope","exit":1}"#, 1));
    }
}
