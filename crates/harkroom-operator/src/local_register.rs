//! `operatorRegister`(s9) — 앱이 받은 등록 코드(설정 › Operators, 5분·1회)를 `POST /operators/claim` 으로 토큰과 바꿔
//! 이 커뮤니티 뿌리의 secrets 에 두고, `operator.json` 에 그 커뮤니티 칸의 `operatorId` 를 적는다.
//! 정본은 TS `packages/operator/src/cli.ts`(`register`)·`localAgents.ts`(`register` → `onRegistered`)·
//! `packages/shared/src/daemonProtocol.ts`(`readOperatorRegisterPayload`)다.
//!
//! TS 와 같은 것:
//! - 다시 등록이면 옛 `operatorId` 를 `replaces` 로 싣는다 — 서버가 (그 사람의 것일 때만) 옛 행을 폐기하고 배정을 옮긴다.
//! - **토큰이 먼저다** — 설정만 있고 토큰이 없는 칸은 기동 때 「등록 전」으로 건너뛴다. 있던 `agents` 는 그대로 둔다.
//! - 실패는 사람이 고칠 사유다 — 서버 문구를 그대로 `bad-payload` 로 올린다(`등록 실패(<status>): …`).
//!
//! TS 와 다른 것(일부러):
//! - **이 뿌리의 커뮤니티만 받는다.** Rust 오퍼레이터는 커뮤니티마다 프로세스다 — 남의 커뮤니티 코드는 claim 하기 **전에** 거절한다
//!   (코드를 쓰지 않는다).
//! - 토큰 파일은 임시 파일(0600)에 쓰고 rename 한다 — 쓰다 끊겨도 반쪽 토큰이 남지 않는다.
use crate::forward::Transport;
use crate::local_agents::LocalAgents;
use harkroom_proto::p3::{DaemonError, DaemonErrorCode};
use serde_json::{Value, json};

fn bad(message: impl Into<String>) -> DaemonError {
    DaemonError {
        code: DaemonErrorCode::BadPayload,
        message: message.into(),
    }
}

/// 등록 요청. `name` 은 앞뒤 공백을 걷은 뒤 비어 있지 않을 때만 있다.
#[derive(Clone, PartialEq, Eq)]
pub struct RegisterInput {
    pub base_url: String,
    pub code: String,
    pub name: Option<String>,
}

impl std::fmt::Debug for RegisterInput {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("RegisterInput")
            .field("base_url", &self.base_url)
            .field("code", &"<redacted>")
            .field("name", &self.name)
            .finish()
    }
}

/// TS `readOperatorRegisterPayload`.
pub fn read_register_payload(payload: Option<&Value>) -> Result<RegisterInput, DaemonError> {
    let need = || bad("operatorRegister 에는 baseUrl·code 가 필요하다");
    let obj = payload.and_then(Value::as_object).ok_or_else(need)?;
    let base = obj
        .get("baseUrl")
        .and_then(Value::as_str)
        .filter(|s| !s.is_empty())
        .ok_or_else(need)?;
    let code = obj
        .get("code")
        .and_then(Value::as_str)
        .filter(|s| !s.is_empty())
        .ok_or_else(need)?;
    let name = match obj.get("name") {
        None | Some(Value::Null) => None,
        Some(Value::String(s)) => {
            let t = s.trim_matches(|c: char| c.is_whitespace() || c == '\u{feff}');
            (!t.is_empty()).then(|| t.to_string())
        }
        Some(_) => return Err(bad("name 은 문자열이어야 한다")),
    };
    Ok(RegisterInput {
        base_url: base.to_string(),
        code: code.to_string(),
        name,
    })
}

/// `operatorRegister` 한 번. 성공하면 TS `OperatorRegisterResult` 꼴(`operatorId`·`name`·`baseUrl`·`replaced`)을 돌려준다.
pub fn register(
    local: &LocalAgents,
    transport: &dyn Transport,
    input: &RegisterInput,
    hostname: &dyn Fn() -> String,
) -> Result<Value, DaemonError> {
    // 남의 커뮤니티면 claim 전에 거절한다 — 코드를 쓰지 않고, 이 뿌리에 남의 토큰을 두지 않는다.
    let base_url = local.own_community(&input.base_url)?;
    let name = input.name.clone().unwrap_or_else(hostname);
    let replaces = local.operator_id();
    let mut body = json!({ "code": input.code, "name": name });
    if let Some(r) = &replaces {
        body["replaces"] = Value::String(r.clone());
    }
    let url = format!("{base_url}/operators/claim");
    let headers = [("content-type".to_string(), "application/json".to_string())];
    let reply = transport
        .send("POST", &url, &headers, Some(body.to_string().into_bytes()))
        .map_err(|e| bad(format!("등록 실패(0): {e}")))?;
    let parsed: Option<Value> = serde_json::from_str(&reply.body).ok();
    let field = |k: &str| parsed.as_ref().and_then(|v| v.get(k));
    let operator = field("operator").filter(|o| o.is_object());
    let operator_id = operator
        .and_then(|o| o.get("id"))
        .and_then(Value::as_str)
        .filter(|s| !s.is_empty());
    let token = field("token")
        .and_then(Value::as_str)
        .filter(|s| !s.is_empty());
    let (Some(operator_id), Some(token), true) =
        (operator_id, token, (200..300).contains(&reply.status))
    else {
        let msg = field("error")
            .and_then(|e| e.get("message"))
            .and_then(Value::as_str)
            .unwrap_or("서버가 토큰을 주지 않았다");
        return Err(bad(format!("등록 실패({}): {msg}", reply.status)));
    };
    let op_name = operator
        .and_then(|o| o.get("name"))
        .and_then(Value::as_str)
        .unwrap_or(&name)
        .to_string();
    local.save_token(token)?;
    local.set_operator_id(operator_id)?;
    let replaced = field("replaced").cloned().unwrap_or(Value::Null);
    Ok(json!({
        "operatorId": operator_id,
        "name": op_name,
        "baseUrl": base_url,
        "replaced": replaced,
    }))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::forward::HttpReply;
    use std::sync::Mutex;

    const URL: &str = "https://c.example.com";

    struct Fake {
        status: u16,
        body: String,
        seen: Mutex<Vec<(String, String, Value)>>,
    }

    impl Fake {
        fn new(status: u16, body: Value) -> Self {
            Fake {
                status,
                body: body.to_string(),
                seen: Mutex::new(Vec::new()),
            }
        }
    }

    impl Transport for Fake {
        fn send(
            &self,
            method: &str,
            url: &str,
            _headers: &[(String, String)],
            body: Option<Vec<u8>>,
        ) -> Result<HttpReply, String> {
            let b = body
                .and_then(|b| serde_json::from_slice(&b).ok())
                .unwrap_or(Value::Null);
            self.seen
                .lock()
                .unwrap()
                .push((method.into(), url.into(), b));
            Ok(HttpReply {
                status: self.status,
                content_type: "application/json".into(),
                body: self.body.clone(),
            })
        }
    }

    struct Root(std::path::PathBuf);

    impl Root {
        fn path(&self) -> &std::path::Path {
            &self.0
        }
    }

    impl Drop for Root {
        fn drop(&mut self) {
            let _ = std::fs::remove_dir_all(&self.0);
        }
    }

    fn root() -> (Root, LocalAgents) {
        use std::sync::atomic::{AtomicU32, Ordering};
        static SEQ: AtomicU32 = AtomicU32::new(0);
        let r = std::env::temp_dir().join(format!(
            "hk-reg-{}-{}",
            std::process::id(),
            SEQ.fetch_add(1, Ordering::SeqCst)
        ));
        let _ = std::fs::remove_dir_all(&r);
        std::fs::create_dir_all(&r).unwrap();
        let l = LocalAgents::new(r.to_str().unwrap(), URL);
        (Root(r), l)
    }

    fn input(base: &str) -> RegisterInput {
        RegisterInput {
            base_url: base.into(),
            code: "C0DE".into(),
            name: None,
        }
    }

    #[test]
    fn payload_matches_ts_reader() {
        let ok = read_register_payload(Some(
            &json!({"baseUrl": URL, "code": "x", "name": "  mac  "}),
        ))
        .unwrap();
        assert_eq!(ok.name.as_deref(), Some("mac"));
        let blank =
            read_register_payload(Some(&json!({"baseUrl": URL, "code": "x", "name": "  "})))
                .unwrap();
        assert_eq!(blank.name, None);
        for bad_p in [
            json!({"baseUrl": URL}),
            json!({"code": "x"}),
            json!({"baseUrl": "", "code": "x"}),
            json!({"baseUrl": URL, "code": "x", "name": 3}),
        ] {
            let e = read_register_payload(Some(&bad_p)).unwrap_err();
            assert_eq!(e.code, DaemonErrorCode::BadPayload);
        }
        let secret =
            read_register_payload(Some(&json!({"baseUrl": URL, "code": "s3cr3t-code"}))).unwrap();
        assert!(
            !format!("{secret:?}").contains("s3cr3t-code"),
            "Debug 는 코드를 숨긴다"
        );
    }

    #[test]
    fn claims_saves_token_first_and_keeps_agents() {
        let (d, l) = root();
        let cfg = d.path().join("operator/operator.json");
        std::fs::create_dir_all(cfg.parent().unwrap()).unwrap();
        let agent = "3210a8f7-6e21-4274-90f4-930d0dc9b6ff";
        std::fs::write(
            &cfg,
            json!({"communities": {URL: {"operatorId": "old-id", "agents": {agent: {"runner": "rust"}}}}})
                .to_string(),
        )
        .unwrap();
        let fake = Fake::new(
            201,
            json!({"operator": {"id": "new-id", "name": "mac"}, "token": "tok-1",
                   "replaced": {"operatorId": "old-id", "movedAssignments": 2}}),
        );
        let out = register(&l, &fake, &input(&format!("{URL}/")), &|| "host".into()).unwrap();
        assert_eq!(
            out,
            json!({"operatorId": "new-id", "name": "mac", "baseUrl": URL,
                   "replaced": {"operatorId": "old-id", "movedAssignments": 2}})
        );
        let seen = fake.seen.lock().unwrap();
        assert_eq!(seen[0].0, "POST");
        assert_eq!(seen[0].1, format!("{URL}/operators/claim"));
        assert_eq!(
            seen[0].2,
            json!({"code": "C0DE", "name": "host", "replaces": "old-id"})
        );
        assert_eq!(l.operator_token().as_deref(), Some("tok-1"));
        let tok = d.path().join(format!(
            "operator/secrets/operator-token.{}",
            harkroom_roots::community_root_hash(URL, 16)
        ));
        use std::os::unix::fs::PermissionsExt;
        assert_eq!(std::fs::read_to_string(&tok).unwrap(), "tok-1\n");
        assert_eq!(
            std::fs::metadata(&tok).unwrap().permissions().mode() & 0o777,
            0o600
        );
        assert_eq!(
            std::fs::metadata(tok.parent().unwrap())
                .unwrap()
                .permissions()
                .mode()
                & 0o777,
            0o700
        );
        let c: Value = serde_json::from_str(&std::fs::read_to_string(&cfg).unwrap()).unwrap();
        assert_eq!(c["communities"][URL]["operatorId"], "new-id");
        assert_eq!(c["communities"][URL]["agents"][agent]["runner"], "rust");
    }

    #[test]
    fn first_register_has_no_replaces_and_old_server_gives_null() {
        let (_d, l) = root();
        let fake = Fake::new(
            200,
            json!({"operator": {"id": "id-1", "name": "n"}, "token": "t"}),
        );
        let out = register(&l, &fake, &input(URL), &|| "host".into()).unwrap();
        assert_eq!(out["replaced"], Value::Null);
        assert_eq!(
            fake.seen.lock().unwrap()[0].2,
            json!({"code": "C0DE", "name": "host"})
        );
    }

    #[test]
    fn server_refusal_keeps_message_and_writes_nothing() {
        let (d, l) = root();
        let fake = Fake::new(
            400,
            json!({"error": {"code": "invalid_code", "message": "코드가 만료됐다"}}),
        );
        let e = register(&l, &fake, &input(URL), &|| "h".into()).unwrap_err();
        assert_eq!(e.code, DaemonErrorCode::BadPayload);
        assert_eq!(e.message, "등록 실패(400): 코드가 만료됐다");
        assert!(l.operator_token().is_none());
        assert!(!d.path().join("operator/operator.json").exists());
        // 200 인데 토큰이 없으면 같은 거절이다.
        let no_tok = Fake::new(200, json!({"operator": {"id": "x", "name": "n"}}));
        let e = register(&l, &no_tok, &input(URL), &|| "h".into()).unwrap_err();
        assert_eq!(e.message, "등록 실패(200): 서버가 토큰을 주지 않았다");
    }

    #[test]
    fn other_community_is_refused_before_claim() {
        let (_d, l) = root();
        let fake = Fake::new(
            200,
            json!({"operator": {"id": "x", "name": "n"}, "token": "t"}),
        );
        let e = register(&l, &fake, &input("https://other.example.com"), &|| {
            "h".into()
        })
        .unwrap_err();
        assert_eq!(e.code, DaemonErrorCode::BadPayload);
        assert!(fake.seen.lock().unwrap().is_empty(), "claim 하지 않는다");
        assert!(l.operator_token().is_none());
    }
}
