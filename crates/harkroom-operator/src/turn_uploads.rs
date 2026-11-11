//! 턴 파일 올리기 — TS `packages/operator/src/turnUploads.ts` 이식(s21b-3c).
//!
//! 하네스의 `attachment.upload{path}` 를 오퍼레이터가 받아, 턴 워크스페이스 안의 파일을 읽어 서버 `/uploads` 에
//! multipart 로 올리고 첨부 id 만 돌려준다. `secret.import`(turnSecrets)도 [`read_workspace_file`] 을 같이 쓴다(security L1).
//!
//! 지키는 것(TS 와 같다):
//! - 경로는 **이 에이전트의 턴 워크스페이스 아래만**. 기준은 브릿지가 실어 온 `cwd`, 에이전트는 링크가 인증한 값.
//!   경로와 기준을 둘 다 realpath 로 풀어 비교한다(심링크로 밖을 가리키면 거절). `cwd` 가 없으면 올리지 않는다(fail-closed).
//! - 판정한 경로를 O_NOFOLLOW 로 열고, 종류·크기는 연 핸들에서 본다.
//! - 크기는 서버 업로드 한도(25MB) 앞에서 자른다. 비밀 누출 검사는 서버 `/uploads` 가 한다(D5).
use harkroom_proto::p1::{RunnerLinkRequest, RunnerLinkResponse};
use serde_json::{Value, json};
use std::fs::File;
use std::io::Read;
use std::os::unix::fs::OpenOptionsExt;
use std::path::{Path, PathBuf};

use crate::turn_peek::tool_call;

pub const ATTACHMENT_UPLOAD_TOOL: &str = "attachment.upload";
/// 서버 기본 업로드 한도(`ATTACHMENT_MAX_BYTES` 25MB)와 같다.
pub const UPLOAD_MAX_BYTES: u64 = 25 * 1024 * 1024;
const UPLOAD_NOTE: &str = "Not posted yet. Attach it with message.post { attachmentIds: [id] }, or use it as artifact.publish { attachmentId } for an html page.";

/// 확장자 → 타입(TS `TYPES`). 모르는 것은 octet-stream.
pub fn content_type_for(filename: &str) -> &'static str {
    let ext = Path::new(filename)
        .extension()
        .and_then(|e| e.to_str())
        .map(str::to_ascii_lowercase)
        .unwrap_or_default();
    match ext.as_str() {
        "png" => "image/png",
        "jpg" | "jpeg" => "image/jpeg",
        "gif" => "image/gif",
        "webp" => "image/webp",
        "svg" => "image/svg+xml",
        "pdf" => "application/pdf",
        "html" | "htm" => "text/html",
        "txt" | "log" => "text/plain",
        "md" => "text/markdown",
        "json" => "application/json",
        "csv" => "text/csv",
        "zip" => "application/zip",
        _ => "application/octet-stream",
    }
}

/// 실패 하나(코드·문구). 문구는 TS 와 글자까지 같다.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Refusal {
    pub code: &'static str,
    pub message: String,
}

fn refuse(code: &'static str, message: impl Into<String>) -> Refusal {
    Refusal {
        code,
        message: message.into(),
    }
}

fn base_name(p: &Path) -> &str {
    p.file_name().and_then(|n| n.to_str()).unwrap_or("")
}

fn owns(name: &str, agent_id: &str) -> bool {
    name == agent_id || name.ends_with(&format!("-{agent_id}"))
}

/// 기준 디렉터리가 이 에이전트의 턴 워크스페이스인가 —
/// `<상태 루트>/(<id>|<handle>-<id>)[/<instance>]/workspaces/harkroom-<…>` (TS `isAgentTurnWorkspace`).
pub fn is_agent_turn_workspace(root: &Path, agent_id: &str) -> bool {
    if agent_id.is_empty() || !base_name(root).starts_with("harkroom-") {
        return false;
    }
    let Some(base) = root.parent() else {
        return false;
    };
    if base_name(base) != "workspaces" {
        return false;
    }
    let Some(state) = base.parent() else {
        return false;
    };
    owns(base_name(state), agent_id) || state.parent().is_some_and(|p| owns(base_name(p), agent_id))
}

fn is_hash24(s: &str) -> bool {
    s.len() == 24
        && s.bytes()
            .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
}

/// 기준이 이 에이전트의 omp 스레드 폴더면 그 스레드의 기준 폴더들 —
/// `<상태 루트>[/<instance>]/omp-home/cwd/<24자 해시>/cwd` (TS `ompThreadRoots`). 아니면 None.
fn omp_thread_roots(root: &Path, agent_id: &str) -> Option<Vec<PathBuf>> {
    if agent_id.is_empty() || base_name(root) != "cwd" {
        return None;
    }
    let hash_dir = root.parent()?;
    let hash = base_name(hash_dir);
    let cwd_root = hash_dir.parent()?;
    let omp_home = cwd_root.parent()?;
    if !is_hash24(hash) || base_name(cwd_root) != "cwd" || base_name(omp_home) != "omp-home" {
        return None;
    }
    let state = omp_home.parent()?;
    if !owns(base_name(state), agent_id)
        && !state.parent().is_some_and(|p| owns(base_name(p), agent_id))
    {
        return None;
    }
    let mut roots = vec![root.to_path_buf()];
    let ws = state
        .join("workspaces")
        .join(format!("harkroom-{agent_id}-{}", &hash[..8]));
    let left = omp_home.join("leftovers").join(hash);
    roots.extend(
        [ws, left]
            .into_iter()
            .filter_map(|p| std::fs::canonicalize(p).ok()),
    );
    Some(roots)
}

/// `path` 를 `cwd` 아래의 실제 파일로 푼다(TS `resolveInsideWorkspace`). 둘 다 realpath.
pub fn resolve_inside_workspace(cwd: &str, path: &str, agent_id: &str) -> Result<PathBuf, Refusal> {
    let root = std::fs::canonicalize(cwd)
        .map_err(|_| refuse("no_workspace", "the turn workspace could not be resolved"))?;
    let roots = if is_agent_turn_workspace(&root, agent_id) {
        vec![root]
    } else {
        omp_thread_roots(&root, agent_id).ok_or_else(|| {
            refuse(
                "no_workspace",
                "this harness does not run in your harkroom turn workspace; uploads are disabled here",
            )
        })?
    };
    let p = Path::new(path);
    // 상대 경로는 기준 폴더들을 차례로 찾는다(앞 폴더에 없을 때만 뒤로).
    let candidates: Vec<PathBuf> = if p.is_absolute() {
        vec![p.to_path_buf()]
    } else {
        roots.iter().map(|r| r.join(p)).collect()
    };
    let target = candidates
        .iter()
        .find_map(|c| std::fs::canonicalize(c).ok())
        .ok_or_else(|| refuse("not_found", format!("no such file: {path}")))?;
    // Path::starts_with 는 성분 단위라 `/a/bc` 가 `/a/b` 안으로 읽히지 않는다(TS 의 `r + sep` 비교와 같다).
    if !roots.iter().any(|r| target.starts_with(r)) {
        return Err(refuse(
            "outside_workspace",
            "the file must be inside this turn workspace — copy it there first",
        ));
    }
    Ok(target)
}

fn limit_text(max: u64) -> String {
    if max >= 1024 * 1024 {
        format!("{}MB", max / 1024 / 1024)
    } else {
        format!("{}KB", max / 1024)
    }
}

/// 턴 워크스페이스 안의 일반 파일 하나를 읽는다(TS `readWorkspaceFile`). 판정한 경로를 O_NOFOLLOW 로 연다.
pub fn read_workspace_file(
    cwd: &str,
    path: &str,
    agent_id: &str,
    max_bytes: u64,
) -> Result<(PathBuf, Vec<u8>), Refusal> {
    let resolved = resolve_inside_workspace(cwd, path, agent_id)?;
    let limit = limit_text(max_bytes);
    let mut f: File = std::fs::OpenOptions::new()
        .read(true)
        .custom_flags(libc::O_NOFOLLOW)
        .open(&resolved)
        .map_err(|_| refuse("read_failed", format!("could not open {path}")))?;
    let meta = f
        .metadata()
        .map_err(|_| refuse("read_failed", format!("could not read {path}")))?;
    if !meta.is_file() {
        return Err(refuse("not_a_file", format!("not a regular file: {path}")));
    }
    if meta.len() > max_bytes {
        return Err(refuse("too_large", format!("the file exceeds {limit}")));
    }
    // 열고 나서 자란 파일 — 한도 + 1 까지만 읽어 다시 본다.
    let mut bytes = Vec::with_capacity(meta.len() as usize);
    (&mut f)
        .take(max_bytes + 1)
        .read_to_end(&mut bytes)
        .map_err(|_| refuse("read_failed", format!("could not read {path}")))?;
    if bytes.len() as u64 > max_bytes {
        return Err(refuse("too_large", format!("the file exceeds {limit}")));
    }
    Ok((resolved, bytes))
}

/// 업로드 파일명 — 헤더에 들어가므로 따옴표·제어문자·경로 성분을 뺀다(TS `safeFilename`).
pub fn safe_filename(raw: &str) -> String {
    let base = raw.rsplit('/').next().unwrap_or(raw);
    let cleaned: String = base
        .chars()
        .map(|c| {
            if c == '"' || c == '\\' || (c as u32) < 0x20 || c == '\x7f' {
                '_'
            } else {
                c
            }
        })
        .collect();
    let trimmed = cleaned.trim();
    // TS 는 UTF-16 255 단위로 자른다. 여기서는 문자 255 개 — BMP 밖 문자에서만 차이가 나고 서버 `displayName` 이 한 번 더 좁힌다.
    let out: String = trimmed.chars().take(255).collect();
    if out.is_empty() { "file".into() } else { out }
}

/// multipart 본문과 그 Content-Type(TS `multipart`).
pub fn multipart(
    filename: &str,
    content_type: &str,
    bytes: &[u8],
    boundary_id: &str,
) -> (Vec<u8>, String) {
    let boundary = format!("----harkroom-upload-{boundary_id}");
    let mut body = format!(
        "--{boundary}\r\nContent-Disposition: form-data; name=\"file\"; filename=\"{filename}\"\r\nContent-Type: {content_type}\r\n\r\n"
    )
    .into_bytes();
    body.extend_from_slice(bytes);
    body.extend_from_slice(format!("\r\n--{boundary}--\r\n").as_bytes());
    (body, format!("multipart/form-data; boundary={boundary}"))
}

fn tool_result(id: Value, value: &Value, is_error: bool) -> Value {
    let mut result = json!({"content": [{"type": "text", "text": value.to_string()}]});
    if is_error {
        result["isError"] = Value::Bool(true);
    }
    json!({"jsonrpc": "2.0", "id": id, "result": result})
}

/// `attachment.upload` 면 답하고 아니면 None(TS `createTurnUploads().maybeHandle`).
/// `post` 는 에이전트 자격으로 그 서버에 (경로, Content-Type, 본문)을 POST 하고 (상태, 본문)을 돌려준다 — 오퍼레이터 자체
/// 요청이라 러너 REST 허용 목록을 거치지 않는다(TS `community.forward`). Err 는 닿지 못한 것이다.
pub type Post<'a> = &'a dyn Fn(&str, &str, Vec<u8>) -> Result<(u16, String), String>;

pub fn maybe_handle(
    agent_id: &str,
    req: &RunnerLinkRequest,
    max_bytes: u64,
    post: Post<'_>,
    new_id: &dyn Fn() -> String,
    log: &dyn Fn(&str),
) -> Option<RunnerLinkResponse> {
    let RunnerLinkRequest::McpRequest {
        id, payload, cwd, ..
    } = req
    else {
        return None;
    };
    let call = tool_call(payload)?;
    let params = call.get("params")?;
    if params.get("name").and_then(Value::as_str) != Some(ATTACHMENT_UPLOAD_TOOL) {
        return None;
    }
    let rpc_id = call.get("id").cloned().unwrap_or(Value::Null);
    let reply = |v: Value, is_error: bool| RunnerLinkResponse::McpResponse {
        id: id.clone(),
        messages: vec![tool_result(rpc_id.clone(), &v, is_error)],
    };
    let fail = |code: &str, message: &str| {
        reply(json!({"error": {"code": code, "message": message}}), true)
    };
    let args = params.get("arguments").cloned().unwrap_or(Value::Null);
    let Some(path) = args
        .get("path")
        .and_then(Value::as_str)
        .filter(|p| !p.trim().is_empty())
    else {
        return Some(fail("bad_request", "path is required"));
    };
    let filename_arg = match args.get("filename") {
        None => None,
        Some(Value::String(s)) if !s.trim().is_empty() => Some(s.as_str()),
        Some(_) => return Some(fail("bad_request", "filename must be a non-empty string")),
    };
    let Some(cwd) = cwd.as_deref().filter(|c| !c.is_empty()) else {
        return Some(fail(
            "no_workspace",
            "this bridge does not report its workspace; update the harkroom app",
        ));
    };
    let (real, bytes) = match read_workspace_file(cwd, path, agent_id, max_bytes) {
        Ok(r) => r,
        Err(r) => return Some(fail(r.code, &r.message)),
    };
    let filename = safe_filename(filename_arg.unwrap_or(&real.to_string_lossy()));
    let content_type = content_type_for(&filename);
    let (body, form_type) = multipart(&filename, content_type, &bytes, &new_id());
    let (status, text) = match post("/uploads", &form_type, body) {
        Ok((status, text)) if status != 0 => (status, text),
        _ => return Some(fail("unavailable", "the server could not be reached")),
    };
    let parsed: Value = serde_json::from_str(&text).unwrap_or(Value::Null);
    let att_id = parsed.get("id").and_then(Value::as_str);
    if status != 201 || att_id.is_none() {
        let err = parsed.get("error");
        let code = err
            .and_then(|e| e.get("code"))
            .and_then(Value::as_str)
            .map(str::to_string)
            .unwrap_or_else(|| format!("http_{status}"));
        log(&format!("turn-uploads: 업로드 거절 {status} {code}"));
        let message = err
            .and_then(|e| e.get("message"))
            .and_then(Value::as_str)
            .map(str::to_string)
            .unwrap_or_else(|| format!("upload refused ({status})"));
        return Some(reply(
            json!({"error": {"code": code, "message": message}}),
            true,
        ));
    }
    // TS 는 undefined 칸을 JSON 에서 뺀다 — 서버가 준 칸만 싣는다.
    let mut out = serde_json::Map::new();
    out.insert("attachmentId".into(), json!(att_id));
    for k in ["filename", "contentType", "sizeBytes"] {
        if let Some(v) = parsed.get(k).filter(|v| !v.is_null()) {
            out.insert(k.into(), v.clone());
        }
    }
    out.insert("note".into(), json!(UPLOAD_NOTE));
    Some(reply(Value::Object(out), false))
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::cell::RefCell;

    /// 테스트가 본 POST 하나.
    struct Sent {
        path: String,
        content_type: String,
        body: Vec<u8>,
    }

    const AGENT: &str = "11111111-2222-4333-8444-555555555555";

    /// `<tmp>/<AGENT>/workspaces/harkroom-t1` 를 만들어 (상태 루트, 워크스페이스)를 돌려준다.
    fn workspace(tag: &str) -> (PathBuf, PathBuf) {
        let base = std::env::temp_dir().join(format!("hk-up-{tag}-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&base);
        let ws = base.join(AGENT).join("workspaces").join("harkroom-t1");
        std::fs::create_dir_all(&ws).unwrap();
        (
            std::fs::canonicalize(&base).unwrap(),
            std::fs::canonicalize(&ws).unwrap(),
        )
    }

    fn call(args: Value, cwd: Option<&Path>) -> RunnerLinkRequest {
        RunnerLinkRequest::McpRequest {
            id: "r1".into(),
            payload: json!({"jsonrpc": "2.0", "id": 7, "method": "tools/call",
                "params": {"name": ATTACHMENT_UPLOAD_TOOL, "arguments": args}}),
            cause: Some("c1".into()),
            cwd: cwd.map(|p| p.to_string_lossy().into_owned()),
            turn_id: None,
            command_files: None,
        }
    }

    fn text_of(r: &RunnerLinkResponse) -> (Value, bool) {
        let RunnerLinkResponse::McpResponse { messages, .. } = r else {
            panic!("not mcp")
        };
        let res = &messages[0]["result"];
        let v: Value = serde_json::from_str(res["content"][0]["text"].as_str().unwrap()).unwrap();
        (v, res.get("isError") == Some(&Value::Bool(true)))
    }

    fn run(
        req: &RunnerLinkRequest,
        status: u16,
        body: &str,
        sent: &RefCell<Vec<Sent>>,
    ) -> Option<RunnerLinkResponse> {
        let post = |path: &str, ct: &str, b: Vec<u8>| {
            sent.borrow_mut().push(Sent {
                path: path.into(),
                content_type: ct.into(),
                body: b,
            });
            if status == 0 {
                Err("down".to_string())
            } else {
                Ok((status, body.to_string()))
            }
        };
        maybe_handle(
            AGENT,
            req,
            UPLOAD_MAX_BYTES,
            &post,
            &|| "ID".into(),
            &|_| {},
        )
    }

    #[test]
    fn workspace_shape() {
        let p = |s: &str| PathBuf::from(s);
        assert!(is_agent_turn_workspace(
            &p(&format!("/s/{AGENT}/workspaces/harkroom-x")),
            AGENT
        ));
        assert!(is_agent_turn_workspace(
            &p(&format!("/s/me-{AGENT}/workspaces/harkroom-x")),
            AGENT
        ));
        assert!(is_agent_turn_workspace(
            &p(&format!("/s/{AGENT}/i1/workspaces/harkroom-x")),
            AGENT
        ));
        assert!(!is_agent_turn_workspace(
            &p("/s/other/workspaces/harkroom-x"),
            AGENT
        ));
        assert!(!is_agent_turn_workspace(
            &p(&format!("/s/{AGENT}/workspaces/other")),
            AGENT
        ));
        assert!(!is_agent_turn_workspace(
            &p(&format!("/s/{AGENT}/workspaces/harkroom-x")),
            ""
        ));
    }

    #[test]
    fn uploads_file_inside_workspace() {
        let (_b, ws) = workspace("ok");
        std::fs::write(ws.join("shot.png"), b"PNG").unwrap();
        let sent = RefCell::new(vec![]);
        let r = run(
            &call(json!({"path": "shot.png"}), Some(&ws)),
            201,
            r#"{"id":"att1","filename":"shot.png","contentType":"image/png","sizeBytes":3}"#,
            &sent,
        )
        .unwrap();
        let (v, err) = text_of(&r);
        assert!(!err);
        assert_eq!(v["attachmentId"], "att1");
        assert_eq!(v["sizeBytes"], 3);
        let s = &sent.borrow()[0];
        assert_eq!(s.path, "/uploads");
        assert_eq!(
            s.content_type,
            "multipart/form-data; boundary=----harkroom-upload-ID"
        );
        let raw = String::from_utf8(s.body.clone()).unwrap();
        assert!(raw.contains("filename=\"shot.png\"\r\nContent-Type: image/png\r\n\r\nPNG\r\n"));
    }

    #[test]
    fn refuses_symlink_out_and_missing_cwd() {
        let (b, ws) = workspace("sym");
        std::fs::write(b.join("secret.txt"), b"x").unwrap();
        std::os::unix::fs::symlink(b.join("secret.txt"), ws.join("link.txt")).unwrap();
        let sent = RefCell::new(vec![]);
        let (v, err) = text_of(
            &run(
                &call(json!({"path": "link.txt"}), Some(&ws)),
                201,
                "{}",
                &sent,
            )
            .unwrap(),
        );
        assert!(err);
        assert_eq!(v["error"]["code"], "outside_workspace");
        let (v, _) = text_of(
            &run(
                &call(json!({"path": "../../../secret.txt"}), Some(&ws)),
                201,
                "{}",
                &sent,
            )
            .unwrap(),
        );
        assert_eq!(v["error"]["code"], "outside_workspace");
        let (v, _) = text_of(&run(&call(json!({"path": "a"}), None), 201, "{}", &sent).unwrap());
        assert_eq!(v["error"]["code"], "no_workspace");
        // 남의 워크스페이스·홈 같은 곳은 기준이 될 수 없다.
        let (v, _) = text_of(
            &run(
                &call(json!({"path": "secret.txt"}), Some(&b)),
                201,
                "{}",
                &sent,
            )
            .unwrap(),
        );
        assert_eq!(v["error"]["code"], "no_workspace");
        assert!(sent.borrow().is_empty());
    }

    #[test]
    fn size_kind_and_args() {
        let (_b, ws) = workspace("size");
        std::fs::write(ws.join("big"), vec![0u8; 2048]).unwrap();
        std::fs::create_dir(ws.join("dir")).unwrap();
        let e = read_workspace_file(&ws.to_string_lossy(), "big", AGENT, 1024).unwrap_err();
        assert_eq!(
            (e.code, e.message.as_str()),
            ("too_large", "the file exceeds 1KB")
        );
        assert_eq!(
            read_workspace_file(&ws.to_string_lossy(), "dir", AGENT, 1024)
                .unwrap_err()
                .code,
            "not_a_file"
        );
        assert_eq!(
            read_workspace_file(&ws.to_string_lossy(), "nope", AGENT, 1024)
                .unwrap_err()
                .code,
            "not_found"
        );
        let sent = RefCell::new(vec![]);
        let (v, _) =
            text_of(&run(&call(json!({"path": " "}), Some(&ws)), 201, "{}", &sent).unwrap());
        assert_eq!(v["error"]["code"], "bad_request");
        let (v, _) = text_of(
            &run(
                &call(json!({"path": "big", "filename": 3}), Some(&ws)),
                201,
                "{}",
                &sent,
            )
            .unwrap(),
        );
        assert_eq!(v["error"]["message"], "filename must be a non-empty string");
    }

    #[test]
    fn server_refusal_and_unreachable() {
        let (_b, ws) = workspace("srv");
        std::fs::write(ws.join("a.txt"), b"hi").unwrap();
        let sent = RefCell::new(vec![]);
        let (v, _) = text_of(
            &run(
                &call(json!({"path": "a.txt"}), Some(&ws)),
                413,
                r#"{"error":{"code":"too_large","message":"limit"}}"#,
                &sent,
            )
            .unwrap(),
        );
        assert_eq!(v["error"], json!({"code": "too_large", "message": "limit"}));
        let (v, _) =
            text_of(&run(&call(json!({"path": "a.txt"}), Some(&ws)), 500, "", &sent).unwrap());
        assert_eq!(
            v["error"],
            json!({"code": "http_500", "message": "upload refused (500)"})
        );
        let (v, _) =
            text_of(&run(&call(json!({"path": "a.txt"}), Some(&ws)), 0, "", &sent).unwrap());
        assert_eq!(v["error"]["code"], "unavailable");
    }

    #[test]
    fn omp_thread_folder_and_other_tools() {
        let (b, _) = workspace("omp");
        let hash = "0123456789abcdef01234567";
        let omp = b
            .join(AGENT)
            .join("omp-home")
            .join("cwd")
            .join(hash)
            .join("cwd");
        std::fs::create_dir_all(&omp).unwrap();
        let ws2 = b
            .join(AGENT)
            .join("workspaces")
            .join(format!("harkroom-{AGENT}-01234567"));
        std::fs::create_dir_all(&ws2).unwrap();
        std::fs::write(ws2.join("r.md"), b"x").unwrap();
        let got = read_workspace_file(&omp.to_string_lossy(), "r.md", AGENT, 10).unwrap();
        assert_eq!(got.1, b"x");
        let other = RunnerLinkRequest::McpRequest {
            id: "r".into(),
            payload: json!({"method": "tools/call", "params": {"name": "message.post"}}),
            cause: None,
            cwd: None,
            turn_id: None,
            command_files: None,
        };
        let sent = RefCell::new(vec![]);
        assert!(run(&other, 201, "{}", &sent).is_none());
    }

    #[test]
    fn filename_and_types() {
        assert_eq!(safe_filename("/a/b/x\"y\n.png"), "x_y_.png");
        assert_eq!(safe_filename("  "), "file");
        assert_eq!(content_type_for("A.JPEG"), "image/jpeg");
        assert_eq!(content_type_for("x"), "application/octet-stream");
    }
}
