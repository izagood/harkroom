//! 턴 비밀 도구 — TS `packages/operator/src/turnSecrets.ts` 의 도구 절반(`secret.mount`·`generate`·`import`·`rotate`)
//! 이식(s21b-3c-2). 임대 장부는 [`crate::turn_leases`] 다.
//!
//! - **값은 MCP 결과에 싣지 않는다.** 서버에서 받은 값은 `<root>/<leaseId>/<secretId>`(폴더 0700·파일 0600)로만 나가고
//!   결과에는 경로만 실린다. 파일 이름은 secret id 다 — 사람이 정한 이름으로 경로를 짓지 않는다(M5).
//! - 심링크를 따라가지 않는다(P3): 먼저 지우고 `create_new` 로 새로 만든다. 그 사이 무언가 생기면 실패한다.
//! - 판정은 전부 서버다(security F1). 여기의 검사는 난간이다. import 는 `turn_uploads::read_workspace_file`(L1)을 그대로 쓰고,
//!   성공하면 값을 그 임대의 폴더에 써 두고(러너의 D7 가리기 바늘, L3) 원본을 지운다.
//! - 서버 요청은 오퍼레이터 자체 POST 다(에이전트 자격) — 러너 REST 허용 목록을 거치지 않는다.
use crate::turn_leases::TurnLease;
use crate::turn_peek::tool_call;
use crate::turn_uploads::read_workspace_file;
use base64::Engine;
use harkroom_proto::p1::{RunnerLinkRequest, RunnerLinkResponse};
use serde_json::{Map, Value, json};
use std::io::Write;
use std::os::unix::fs::{OpenOptionsExt, PermissionsExt};
use std::path::{Path, PathBuf};

pub const SECRET_MOUNT_TOOL: &str = "secret.mount";
pub const SECRET_GENERATE_TOOL: &str = "secret.generate";
pub const SECRET_IMPORT_TOOL: &str = "secret.import";
pub const SECRET_ROTATE_TOOL: &str = "secret.rotate";
const TOOLS: [&str; 4] = [
    SECRET_MOUNT_TOOL,
    SECRET_GENERATE_TOOL,
    SECRET_IMPORT_TOOL,
    SECRET_ROTATE_TOOL,
];
/// 서버 D6 와 같다. 넘는 파일은 읽기 전에 거절한다.
pub const SECRET_IMPORT_MAX_BYTES: u64 = 64 * 1024;
const GENERATE_TYPES: [&str; 4] = ["password", "token_hex", "token_base64url", "ssh_ed25519"];
const NOTE: &str = "The value was never shown to you and must stay that way: use it only by path via secret.mount; never print, echo, or copy it into messages, memory, files, or commits.";
const MOUNT_NOTE: &str = "The value is in this file only for this turn. Use it by path (e.g. `curl -H @file`, `$(<file)`); never print, echo, or copy its contents into messages, memory, files, or commits.";

/// 에이전트 자격 JSON POST(경로, 본문) → (상태, 본문). Err 는 닿지 못한 것.
pub type Post<'a> = &'a dyn Fn(&str, String) -> Result<(u16, String), String>;

/// `[a-z0-9][a-z0-9_-]{0,63}` (TS NAME).
fn valid_name(s: &str) -> bool {
    let b = s.as_bytes();
    !b.is_empty()
        && b.len() <= 64
        && (b[0].is_ascii_lowercase() || b[0].is_ascii_digit())
        && b[1..]
            .iter()
            .all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || *c == b'_' || *c == b'-')
}

/// 텍스트로 볼 수 있는 값인가 — 올바른 UTF-8 이고 NUL 이 없다(TS `looksText`).
pub fn looks_text(b: &[u8]) -> bool {
    !b.contains(&0) && std::str::from_utf8(b).is_ok()
}

/// 서버 FILENAME 과 같은 모양 — 경로 성분·제어문자를 뺀다(TS `secretFilename`). 255 는 문자 단위(TS 는 UTF-16).
pub fn secret_filename(path: &Path) -> String {
    let base = path
        .file_name()
        .map(|n| n.to_string_lossy().into_owned())
        .unwrap_or_default();
    let n: String = base
        .chars()
        .map(|c| {
            if (c as u32) < 0x20 || c == '\x7f' || c == '\\' {
                '_'
            } else {
                c
            }
        })
        .take(255)
        .collect();
    if n.is_empty() || n == "." || n == ".." {
        "file".into()
    } else {
        n
    }
}

fn err(code: &str, message: &str) -> Value {
    json!({"error": {"code": code, "message": message}})
}

/// 마운트 루트(`<커뮤니티 뿌리>/turn-secrets`)와 그 아래 임대 폴더.
#[derive(Clone, Debug)]
pub struct SecretsRoot {
    pub root: PathBuf,
}

impl SecretsRoot {
    pub fn dir_of(&self, lease_id: &str) -> Option<PathBuf> {
        // 임대 id 는 서버가 준 uuid 다. 경로 성분이 섞이면 쓰지 않는다.
        (!lease_id.is_empty()
            && lease_id != "."
            && lease_id != ".."
            && !lease_id.contains(['/', '\\', '\0']))
        .then(|| self.root.join(lease_id))
    }

    /// 임대 폴더를 지운다(TS `drop` 의 rm). 없으면 그냥 넘어간다.
    pub fn drop_lease(&self, lease_id: &str) {
        let Some(dir) = self.dir_of(lease_id) else {
            return;
        };
        if let Err(e) = std::fs::remove_dir_all(&dir)
            && e.kind() != std::io::ErrorKind::NotFound
        {
            eprintln!("turn-secrets: {lease_id} 디렉터리를 지우지 못했다 — {e}");
        }
    }

    /// 기동 때 한 번 — 앞 오퍼레이터가 남긴 폴더를 전부 지운다(TS `sweepAll`).
    pub fn sweep_all(&self) -> usize {
        let Ok(rd) = std::fs::read_dir(&self.root) else {
            return 0;
        };
        let mut n = 0;
        for e in rd.flatten() {
            let p = e.path();
            let _ = if e.file_type().is_ok_and(|t| t.is_dir()) {
                std::fs::remove_dir_all(&p)
            } else {
                std::fs::remove_file(&p)
            };
            n += 1;
        }
        n
    }

    /// 루트와 임대 폴더를 0700 으로 박는다(P4 — create 의 mode 는 umask 를 탄다).
    fn ensure_dir(&self, lease_id: &str) -> std::io::Result<PathBuf> {
        let dir = self
            .dir_of(lease_id)
            .ok_or_else(|| std::io::Error::other("bad lease id"))?;
        for d in [&self.root, &dir] {
            std::fs::create_dir_all(d)?;
            std::fs::set_permissions(d, std::fs::Permissions::from_mode(0o700))?;
        }
        Ok(dir)
    }

    /// 심링크를 따라가지 않고 0600 새 파일로 쓴다(P3).
    fn write_new(path: &Path, value: &[u8]) -> std::io::Result<()> {
        match std::fs::remove_file(path) {
            Ok(()) => {}
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => {}
            Err(e) => return Err(e),
        }
        let mut f = std::fs::OpenOptions::new()
            .write(true)
            .create_new(true)
            .mode(0o600)
            .custom_flags(libc::O_NOFOLLOW)
            .open(path)?;
        f.write_all(value)?;
        f.set_permissions(std::fs::Permissions::from_mode(0o600))
    }
}

/// 한 호출의 문맥.
pub struct Ctx<'a> {
    pub lease: &'a TurnLease,
    pub root: &'a SecretsRoot,
    pub post: Post<'a>,
    pub new_id: &'a dyn Fn() -> String,
    pub log: &'a dyn Fn(&str),
}

type Outcome = Result<Value, Value>;

fn with_lease(lease: &TurnLease, mut body: Map<String, Value>) -> String {
    let mut out = Map::new();
    out.insert("leaseId".into(), Value::String(lease.lease_id.clone()));
    out.insert("token".into(), Value::String(lease.token.clone()));
    out.append(&mut body);
    Value::Object(out).to_string()
}

fn mount(cx: &Ctx<'_>, name: &str) -> Outcome {
    let mut b = Map::new();
    b.insert("name".into(), Value::String(name.into()));
    let (status, text) = match (cx.post)("/agent/secrets/reveal", with_lease(cx.lease, b)) {
        Ok(r) => r,
        Err(_) => return Err(err("unavailable", "the server could not be reached")),
    };
    let mut parsed: Value = serde_json::from_str(&text).unwrap_or(Value::Null);
    let secret = parsed.get("secret").filter(|s| s.is_object()).cloned();
    let value_b64 = parsed
        .get("valueBase64")
        .and_then(Value::as_str)
        .map(str::to_string);
    if let Some(v) = parsed.get_mut("valueBase64") {
        *v = Value::Null;
    }
    let (Some(secret), Some(value_b64), 200) = (secret, value_b64, status) else {
        let code = parsed
            .pointer("/error/code")
            .and_then(Value::as_str)
            .map(str::to_string)
            .unwrap_or_else(|| {
                if status == 0 {
                    "unavailable".into()
                } else {
                    format!("http_{status}")
                }
            });
        return Err(err(&code, &format!("secret not mounted: {code}")));
    };
    let id = secret.get("id").and_then(Value::as_str).unwrap_or_default();
    let mounted = (|| -> std::io::Result<PathBuf> {
        let dir = cx.root.ensure_dir(&cx.lease.lease_id)?;
        if id.is_empty() || id.contains(['/', '\\', '\0']) || id == "." || id == ".." {
            return Err(std::io::Error::other("bad secret id"));
        }
        let path = dir.join(id);
        let mut bytes = base64::engine::general_purpose::STANDARD
            .decode(value_b64.as_bytes())
            .map_err(std::io::Error::other)?;
        let r = SecretsRoot::write_new(&path, &bytes);
        bytes.fill(0);
        r.map(|()| path)
    })();
    let path = match mounted {
        Ok(p) => p,
        Err(e) => {
            (cx.log)(&format!("turn-secrets: secret.mount 실패 — {e}"));
            return Err(err(
                "mount_failed",
                "the secret could not be written to the turn directory",
            ));
        }
    };
    let mut out = Map::new();
    out.insert(
        "path".into(),
        Value::String(path.to_string_lossy().into_owned()),
    );
    for k in ["name", "kind"] {
        out.insert(k.into(), secret.get(k).cloned().unwrap_or(Value::Null));
    }
    if let Some(f) = secret
        .get("filename")
        .and_then(Value::as_str)
        .filter(|f| !f.is_empty())
    {
        out.insert("filename".into(), Value::String(f.into()));
    }
    out.insert(
        "version".into(),
        secret.get("version").cloned().unwrap_or(Value::Null),
    );
    out.insert("note".into(), Value::String(MOUNT_NOTE.into()));
    Ok(Value::Object(out))
}

/// 서버 REST 를 임대와 함께 부른다(TS `post`). `secret_in_body` 는 import 면 `already_granted` 로 바꿔 안내한다(n3·n5).
fn post(cx: &Ctx<'_>, path: &str, body: Map<String, Value>, importing: bool) -> Outcome {
    let Ok((status, text)) = (cx.post)(path, with_lease(cx.lease, body)) else {
        return Err(err("unavailable", "the server could not be reached"));
    };
    if status == 0 {
        return Err(err("unavailable", "the server could not be reached"));
    }
    let parsed: Value = serde_json::from_str(&text).unwrap_or(json!({}));
    if status == 200 || status == 201 {
        return Ok(parsed);
    }
    let code = parsed
        .pointer("/error/code")
        .and_then(Value::as_str)
        .map(str::to_string)
        .unwrap_or_else(|| format!("http_{status}"));
    if code == "secret_in_body" {
        return Err(if importing {
            err(
                "already_granted",
                "this value is already a secret you were granted — use that secret by name (secret.list / secret.mount) instead of importing it. Delete the file; do not print it.",
            )
        } else {
            err(
                "secret_in_body",
                "the description contains the value of a secret you were granted — describe the secret without its value.",
            )
        });
    }
    if code == "operator_required" || status == 404 {
        return Err(err(
            "unsupported",
            "the harkroom server does not support agent-created secrets yet",
        ));
    }
    let what = if path.ends_with("/rotate") {
        "rotated"
    } else {
        "created"
    };
    Err(err(&code, &format!("secret not {what}: {code}")))
}

struct Source {
    path: PathBuf,
    value: Vec<u8>,
    source: Value,
}

impl Drop for Source {
    fn drop(&mut self) {
        self.value.fill(0);
    }
}

fn read_source(
    cx: &Ctx<'_>,
    cwd: Option<&str>,
    path: Option<&Value>,
    kind: Option<&Value>,
) -> Result<Source, Value> {
    let Some(path) = path
        .and_then(Value::as_str)
        .filter(|p| !p.trim().is_empty())
    else {
        return Err(err("bad_request", "path is required"));
    };
    let kind = match kind {
        None => None,
        Some(Value::String(k)) if k == "text" || k == "file" => Some(k.as_str()),
        Some(_) => return Err(err("bad_request", "kind must be 'text' or 'file'")),
    };
    // 기준이 없으면 읽지 않는다 — 옛 브릿지는 cwd 를 싣지 않는다(fail-closed).
    let Some(cwd) = cwd.filter(|c| !c.is_empty()) else {
        return Err(err(
            "no_workspace",
            "this bridge does not report its workspace; update the harkroom app",
        ));
    };
    let (real, bytes) = read_workspace_file(cwd, path, &cx.lease.agent_id, SECRET_IMPORT_MAX_BYTES)
        .map_err(|r| err(r.code, &r.message))?;
    if bytes.is_empty() {
        return Err(err("empty", "the file is empty"));
    }
    let text = looks_text(&bytes);
    let k = kind.unwrap_or(if text { "text" } else { "file" });
    if k == "text" && !text {
        let mut bytes = bytes;
        bytes.fill(0);
        return Err(err(
            "bad_request",
            "the file is not UTF-8 text; use kind 'file'",
        ));
    }
    let mut imp = Map::new();
    imp.insert("kind".into(), Value::String(k.into()));
    if k == "file" {
        imp.insert("filename".into(), Value::String(secret_filename(&real)));
    }
    imp.insert(
        "valueBase64".into(),
        Value::String(base64::engine::general_purpose::STANDARD.encode(&bytes)),
    );
    Ok(Source {
        path: real,
        value: bytes,
        source: json!({"import": imp}),
    })
}

/// 성공한 import 뒤: 가리기 자리에 기록하고(L3) 원본을 지운다(TS `settleImport`).
fn settle_import(cx: &Ctx<'_>, src: &Source, keep: bool) -> bool {
    let wrote = cx.root.ensure_dir(&cx.lease.lease_id).and_then(|dir| {
        SecretsRoot::write_new(&dir.join(format!("import-{}", (cx.new_id)())), &src.value)
    });
    if let Err(e) = wrote {
        (cx.log)(&format!("turn-secrets: 가리기 자리 기록 실패 — {e}"));
    }
    if keep {
        return false;
    }
    match std::fs::remove_file(&src.path) {
        Ok(()) => true,
        Err(e) => e.kind() == std::io::ErrorKind::NotFound,
    }
}

fn secret_out(r: &Value, keys: &[&str]) -> Map<String, Value> {
    let s = r.get("secret").cloned().unwrap_or(json!({}));
    keys.iter()
        .map(|k| ((*k).to_string(), s.get(*k).cloned().unwrap_or(Value::Null)))
        .collect()
}

fn create_body(a: &Value, source: Value) -> Map<String, Value> {
    let mut b = Map::new();
    b.insert("name".into(), a.get("name").cloned().unwrap_or(Value::Null));
    if let Some(d) = a.get("description").filter(|d| d.is_string()) {
        b.insert("description".into(), d.clone());
    }
    if let Some(e) = a.get("expiresInDays") {
        b.insert("expiresInDays".into(), e.clone());
    }
    b.insert("source".into(), source);
    b
}

fn gen_source(g: &Value) -> Value {
    let mut s = Map::new();
    s.insert("type".into(), g.get("type").cloned().unwrap_or(Value::Null));
    if let Some(l) = g.get("length") {
        s.insert("length".into(), l.clone());
    }
    json!({"generate": s})
}

fn is_gen_type(v: Option<&Value>) -> bool {
    v.and_then(Value::as_str)
        .is_some_and(|t| GENERATE_TYPES.contains(&t))
}

fn generate(cx: &Ctx<'_>, a: &Value) -> Outcome {
    if !is_gen_type(a.get("type")) {
        return Err(err(
            "bad_request",
            "type must be one of password, token_hex, token_base64url, ssh_ed25519",
        ));
    }
    let mount_too = match a.get("mount") {
        None => false,
        Some(Value::Bool(b)) => *b,
        Some(_) => return Err(err("bad_request", "mount must be a boolean")),
    };
    let r = post(cx, "/agent/secrets", create_body(a, gen_source(a)), false)?;
    let mut out = secret_out(&r, &["name", "kind", "version", "expiresAt"]);
    if let Some(pk) = r
        .get("publicKey")
        .filter(|p| !p.is_null() && p.as_str() != Some(""))
    {
        out.insert("publicKey".into(), pk.clone());
    }
    if mount_too {
        let name = out
            .get("name")
            .and_then(Value::as_str)
            .unwrap_or_default()
            .to_string();
        match mount(cx, &name) {
            Ok(m) => {
                out.insert("path".into(), m.get("path").cloned().unwrap_or(Value::Null));
            }
            Err(e) => {
                out.insert(
                    "mountError".into(),
                    e.get("error").cloned().unwrap_or(Value::Null),
                );
            }
        }
    }
    out.insert("note".into(), Value::String(NOTE.into()));
    Ok(Value::Object(out))
}

fn import_value(cx: &Ctx<'_>, a: &Value, cwd: Option<&str>) -> Outcome {
    let keep = match a.get("keepSource") {
        None => false,
        Some(Value::Bool(b)) => *b,
        Some(_) => return Err(err("bad_request", "keepSource must be a boolean")),
    };
    let src = read_source(cx, cwd, a.get("path"), a.get("kind"))?;
    let r = post(
        cx,
        "/agent/secrets",
        create_body(a, src.source.clone()),
        true,
    )?;
    let mut out = secret_out(&r, &["name", "kind", "version", "expiresAt"]);
    let deleted = settle_import(cx, &src, keep);
    out.insert("sourceDeleted".into(), Value::Bool(deleted));
    // 원본을 남겼으면 평문 파일이 워크스페이스에 있다(security n6).
    let note = if deleted {
        NOTE.to_string()
    } else {
        format!(
            "{NOTE} The source file is still in the workspace (keepSource): delete it as soon as you are done and never commit it."
        )
    };
    out.insert("note".into(), Value::String(note));
    Ok(Value::Object(out))
}

fn rotate_value(cx: &Ctx<'_>, a: &Value, cwd: Option<&str>) -> Outcome {
    let g = a.get("generate");
    let p = a.get("path");
    if g.is_some() == p.is_some() {
        return Err(err(
            "bad_request",
            "give exactly one of generate:{type,length?} or path",
        ));
    }
    let name = a.get("name").cloned().unwrap_or(Value::Null);
    if let Some(g) = g {
        if !g.is_object() || !is_gen_type(g.get("type")) {
            return Err(err(
                "bad_request",
                "generate.type must be one of password, token_hex, token_base64url, ssh_ed25519",
            ));
        }
        let mut b = Map::new();
        b.insert("name".into(), name);
        b.insert("source".into(), gen_source(g));
        let r = post(cx, "/agent/secrets/rotate", b, false)?;
        let mut out = secret_out(&r, &["name", "version"]);
        if let Some(pk) = r
            .get("publicKey")
            .filter(|p| !p.is_null() && p.as_str() != Some(""))
        {
            out.insert("publicKey".into(), pk.clone());
        }
        out.insert("note".into(), Value::String(NOTE.into()));
        return Ok(Value::Object(out));
    }
    let src = read_source(cx, cwd, p, None)?;
    let mut b = Map::new();
    b.insert("name".into(), name);
    b.insert("source".into(), src.source.clone());
    let r = post(cx, "/agent/secrets/rotate", b, true)?;
    let mut out = secret_out(&r, &["name", "version"]);
    let deleted = settle_import(cx, &src, false);
    out.insert("sourceDeleted".into(), Value::Bool(deleted));
    out.insert("note".into(), Value::String(NOTE.into()));
    Ok(Value::Object(out))
}

fn tool_result(id: Value, value: &Value, is_error: bool) -> Value {
    let mut result = json!({"content": [{"type": "text", "text": value.to_string()}]});
    if is_error {
        result["isError"] = Value::Bool(true);
    }
    json!({"jsonrpc": "2.0", "id": id, "result": result})
}

/// 비밀 도구 호출이면 그 이름(TS `secretToolOf`).
pub fn secret_tool_of(req: &RunnerLinkRequest) -> Option<&'static str> {
    let RunnerLinkRequest::McpRequest { payload, .. } = req else {
        return None;
    };
    let name = tool_call(payload)?.pointer("/params/name")?.as_str()?;
    TOOLS.iter().copied().find(|t| *t == name)
}

/// `secret.mount`·`generate`·`import`·`rotate` 면 답하고 아니면 None(TS `maybeHandle`).
/// `lease` 는 `lookup_for(runner, agent, cause)` 결과 — 없으면 `no_lease`(R1 fail-closed).
pub fn maybe_handle(
    req: &RunnerLinkRequest,
    lease: Option<&TurnLease>,
    root: Option<&SecretsRoot>,
    post: Post<'_>,
    new_id: &dyn Fn() -> String,
    log: &dyn Fn(&str),
) -> Option<RunnerLinkResponse> {
    let tool = secret_tool_of(req)?;
    let RunnerLinkRequest::McpRequest {
        id, payload, cwd, ..
    } = req
    else {
        return None;
    };
    let rpc_id = payload.get("id").cloned().unwrap_or(Value::Null);
    let reply = |v: Value, is_error: bool| RunnerLinkResponse::McpResponse {
        id: id.clone(),
        messages: vec![tool_result(rpc_id.clone(), &v, is_error)],
    };
    let args = payload
        .pointer("/params/arguments")
        .filter(|a| a.is_object())
        .cloned()
        .unwrap_or_else(|| json!({}));
    if !args
        .get("name")
        .and_then(Value::as_str)
        .is_some_and(valid_name)
    {
        let m = if tool == SECRET_MOUNT_TOOL {
            "name must be a secret name from secret.list"
        } else {
            "name must match [a-z0-9][a-z0-9_-]{0,63}"
        };
        return Some(reply(err("bad_request", m), true));
    }
    let (Some(lease), Some(root)) = (lease, root) else {
        return Some(reply(
            err("no_lease", "secrets are not available in this turn"),
            true,
        ));
    };
    let cx = Ctx {
        lease,
        root,
        post,
        new_id,
        log,
    };
    let name = args.get("name").and_then(Value::as_str).unwrap_or_default();
    let r = match tool {
        SECRET_MOUNT_TOOL => mount(&cx, name),
        SECRET_GENERATE_TOOL => generate(&cx, &args),
        SECRET_IMPORT_TOOL => import_value(&cx, &args, cwd.as_deref()),
        _ => rotate_value(&cx, &args, cwd.as_deref()),
    };
    Some(match r {
        Ok(v) => reply(v, false),
        Err(v) => reply(v, true),
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::cell::RefCell;

    const AGENT: &str = "11111111-2222-4333-8444-555555555555";
    // 시험용 가짜 값 — 비밀 검사에 걸리지 않게 쪼갠다.
    fn fake_value() -> String {
        ["fake", "-", "value", "-", "x9"].concat()
    }

    fn lease() -> TurnLease {
        TurnLease {
            lease_id: "L1".into(),
            token: "T1".into(),
            agent_id: AGENT.into(),
        }
    }

    fn base(tag: &str) -> PathBuf {
        let b = std::env::temp_dir().join(format!("hk-sec-{tag}-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&b);
        std::fs::create_dir_all(&b).unwrap();
        std::fs::canonicalize(&b).unwrap()
    }

    fn call(tool: &str, args: Value, cwd: Option<&Path>) -> RunnerLinkRequest {
        RunnerLinkRequest::McpRequest {
            id: "r1".into(),
            payload: json!({"jsonrpc": "2.0", "id": 7, "method": "tools/call",
                "params": {"name": tool, "arguments": args}}),
            cause: Some("c1".into()),
            cwd: cwd.map(|p| p.to_string_lossy().into_owned()),
            turn_id: None,
            command_files: None,
        }
    }

    fn out(r: Option<RunnerLinkResponse>) -> (Value, bool) {
        let Some(RunnerLinkResponse::McpResponse { messages, .. }) = r else {
            panic!("응답 없음")
        };
        let res = &messages[0]["result"];
        let text = res["content"][0]["text"].as_str().unwrap();
        (
            serde_json::from_str(text).unwrap(),
            res.get("isError") == Some(&Value::Bool(true)),
        )
    }

    #[test]
    fn mount_writes_0600_file_named_by_id_and_returns_path_only() {
        let b = base("mount");
        let root = SecretsRoot {
            root: b.join("turn-secrets"),
        };
        let seen = RefCell::new(Vec::new());
        let v = fake_value();
        let post = |p: &str, body: String| {
            seen.borrow_mut().push((p.to_string(), body));
            Ok((200, json!({"secret": {"id": "S1", "name": "db", "kind": "text", "filename": null, "version": 2},
                "valueBase64": base64::engine::general_purpose::STANDARD.encode(&v)}).to_string()))
        };
        let l = lease();
        let (o, is_err) = out(maybe_handle(
            &call(SECRET_MOUNT_TOOL, json!({"name": "db"}), None),
            Some(&l),
            Some(&root),
            &post,
            &|| "n".into(),
            &|_| {},
        ));
        assert!(!is_err, "{o}");
        let path = b.join("turn-secrets").join("L1").join("S1");
        assert_eq!(o["path"], path.to_string_lossy().as_ref());
        assert_eq!(o["version"], 2);
        assert!(!o.to_string().contains(&v), "값은 결과에 싣지 않는다");
        assert_eq!(std::fs::read_to_string(&path).unwrap(), v);
        let mode = |p: &Path| std::fs::metadata(p).unwrap().permissions().mode() & 0o777;
        assert_eq!(mode(&path), 0o600);
        assert_eq!(mode(&b.join("turn-secrets").join("L1")), 0o700);
        assert_eq!(mode(&b.join("turn-secrets")), 0o700);
        let (p, body) = seen.borrow()[0].clone();
        assert_eq!(p, "/agent/secrets/reveal");
        assert_eq!(
            serde_json::from_str::<Value>(&body).unwrap(),
            json!({"leaseId": "L1", "token": "T1", "name": "db"})
        );
        // 심링크 자리에 다시 마운트해도 대상 파일을 덮지 않는다(P3).
        let target = b.join("victim");
        std::fs::write(&target, "keep").unwrap();
        std::fs::remove_file(&path).unwrap();
        std::os::unix::fs::symlink(&target, &path).unwrap();
        let (_, is_err) = out(maybe_handle(
            &call(SECRET_MOUNT_TOOL, json!({"name": "db"}), None),
            Some(&l),
            Some(&root),
            &post,
            &|| "n".into(),
            &|_| {},
        ));
        assert!(!is_err);
        assert_eq!(std::fs::read_to_string(&target).unwrap(), "keep");
        assert!(
            !std::fs::symlink_metadata(&path)
                .unwrap()
                .file_type()
                .is_symlink()
        );
        root.drop_lease("L1");
        assert!(!b.join("turn-secrets").join("L1").exists(), "끝나면 지운다");
        root.drop_lease("../x");
        let _ = std::fs::remove_dir_all(&b);
    }

    #[test]
    fn refusals_without_lease_bad_name_and_server_codes() {
        let root = SecretsRoot {
            root: base("ref").join("turn-secrets"),
        };
        let never = |_: &str, _: String| -> Result<(u16, String), String> {
            panic!("서버로 가지 않는다")
        };
        let l = lease();
        let (o, e) = out(maybe_handle(
            &call(SECRET_MOUNT_TOOL, json!({"name": "db"}), None),
            None,
            Some(&root),
            &never,
            &|| "n".into(),
            &|_| {},
        ));
        assert!(e);
        assert_eq!(o["error"]["code"], "no_lease");
        let (o, _) = out(maybe_handle(
            &call(SECRET_GENERATE_TOOL, json!({"name": "Bad"}), None),
            Some(&l),
            Some(&root),
            &never,
            &|| "n".into(),
            &|_| {},
        ));
        assert_eq!(
            o["error"]["message"],
            "name must match [a-z0-9][a-z0-9_-]{0,63}"
        );
        let (o, _) = out(maybe_handle(
            &call(
                SECRET_GENERATE_TOOL,
                json!({"name": "a", "type": "rsa"}),
                None,
            ),
            Some(&l),
            Some(&root),
            &never,
            &|| "n".into(),
            &|_| {},
        ));
        assert_eq!(o["error"]["code"], "bad_request");
        let (o, _) = out(maybe_handle(
            &call(SECRET_ROTATE_TOOL, json!({"name": "a"}), None),
            Some(&l),
            Some(&root),
            &never,
            &|| "n".into(),
            &|_| {},
        ));
        assert_eq!(
            o["error"]["message"],
            "give exactly one of generate:{type,length?} or path"
        );
        let (o, _) = out(maybe_handle(
            &call(SECRET_IMPORT_TOOL, json!({"name": "a", "path": "x"}), None),
            Some(&l),
            Some(&root),
            &never,
            &|| "n".into(),
            &|_| {},
        ));
        assert_eq!(o["error"]["code"], "no_workspace");
        let gone = |_: &str, _: String| Ok((404, String::new()));
        let (o, _) = out(maybe_handle(
            &call(
                SECRET_GENERATE_TOOL,
                json!({"name": "a", "type": "password"}),
                None,
            ),
            Some(&l),
            Some(&root),
            &gone,
            &|| "n".into(),
            &|_| {},
        ));
        assert_eq!(o["error"]["code"], "unsupported");
        let leak =
            |_: &str, _: String| Ok((400, r#"{"error":{"code":"secret_in_body"}}"#.to_string()));
        let (o, _) = out(maybe_handle(
            &call(
                SECRET_GENERATE_TOOL,
                json!({"name": "a", "type": "password"}),
                None,
            ),
            Some(&l),
            Some(&root),
            &leak,
            &|| "n".into(),
            &|_| {},
        ));
        assert_eq!(o["error"]["code"], "secret_in_body");
        assert!(
            maybe_handle(
                &call("message.post", json!({}), None),
                Some(&l),
                Some(&root),
                &never,
                &|| "n".into(),
                &|_| {}
            )
            .is_none()
        );
    }

    #[test]
    fn import_reads_workspace_file_remembers_value_and_deletes_source() {
        let b = base("imp");
        let ws = b.join(AGENT).join("workspaces").join("harkroom-t1");
        std::fs::create_dir_all(&ws).unwrap();
        let ws = std::fs::canonicalize(&ws).unwrap();
        let root = SecretsRoot {
            root: b.join("turn-secrets"),
        };
        let v = fake_value();
        std::fs::write(ws.join("k.txt"), &v).unwrap();
        let l = lease();
        let leak =
            |_: &str, _: String| Ok((400, r#"{"error":{"code":"secret_in_body"}}"#.to_string()));
        let (o, _) = out(maybe_handle(
            &call(
                SECRET_IMPORT_TOOL,
                json!({"name": "a", "path": "k.txt"}),
                Some(&ws),
            ),
            Some(&l),
            Some(&root),
            &leak,
            &|| "n".into(),
            &|_| {},
        ));
        assert_eq!(
            o["error"]["code"], "already_granted",
            "import 의 secret_in_body 는 이미 가진 비밀"
        );
        assert!(ws.join("k.txt").exists(), "거절이면 원본을 지우지 않는다");
        let seen = RefCell::new(String::new());
        let ok = |p: &str, body: String| {
            assert_eq!(p, "/agent/secrets");
            *seen.borrow_mut() = body;
            Ok((
                201,
                json!({"secret": {"name": "a", "kind": "text", "version": 1, "expiresAt": null}})
                    .to_string(),
            ))
        };
        let (o, e) = out(maybe_handle(
            &call(
                SECRET_IMPORT_TOOL,
                json!({"name": "a", "path": "k.txt"}),
                Some(&ws),
            ),
            Some(&l),
            Some(&root),
            &ok,
            &|| "u1".into(),
            &|_| {},
        ));
        assert!(!e, "{o}");
        assert_eq!(o["sourceDeleted"], true);
        assert!(!o.to_string().contains(&v));
        assert!(!ws.join("k.txt").exists());
        let sent: Value = serde_json::from_str(&seen.borrow()).unwrap();
        assert_eq!(sent["source"]["import"]["kind"], "text");
        assert_eq!(
            std::fs::read_to_string(b.join("turn-secrets/L1/import-u1")).unwrap(),
            v,
            "가리기 바늘(L3)"
        );
        // 워크스페이스 밖은 읽지 않는다.
        let (o, _) = out(maybe_handle(
            &call(
                SECRET_IMPORT_TOOL,
                json!({"name": "a", "path": "../../../../x"}),
                Some(&ws),
            ),
            Some(&l),
            Some(&root),
            &ok,
            &|| "u2".into(),
            &|_| {},
        ));
        assert!(o["error"]["code"].is_string());
        // 64KB 를 넘으면 거절.
        std::fs::write(ws.join("big"), vec![b'a'; 64 * 1024 + 1]).unwrap();
        let (o, _) = out(maybe_handle(
            &call(
                SECRET_IMPORT_TOOL,
                json!({"name": "a", "path": "big"}),
                Some(&ws),
            ),
            Some(&l),
            Some(&root),
            &ok,
            &|| "u3".into(),
            &|_| {},
        ));
        assert_eq!(o["error"]["code"], "too_large");
        let _ = std::fs::remove_dir_all(&b);
    }

    #[test]
    fn text_and_filename_helpers() {
        assert!(looks_text(b"abc"));
        assert!(!looks_text(b"a\0b"));
        assert!(!looks_text(&[0xff, 0xfe]));
        assert_eq!(secret_filename(Path::new("/w/a\tb.pem")), "a_b.pem");
        assert_eq!(secret_filename(Path::new("/")), "file");
        assert!(
            valid_name("a-1_b")
                && !valid_name("-a")
                && !valid_name("A")
                && !valid_name(&"a".repeat(65))
        );
    }
}
