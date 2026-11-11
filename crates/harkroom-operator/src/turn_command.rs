//! 「정확한 명령」 승인의 오퍼레이터 쪽 — TS `packages/operator/src/turnCommand.ts` 의 `createTurnCommand` 이식(s21b-3b).
//!
//! 1. `permission.request`(kind=command) — 서버로 넘기기 전에 그 명령이 읽는 파일을 **이 프로세스가** 재서(`measure_command_files`)
//!    `command_files`(→ `COMMAND_FILES_HEADER`)에 싣는다. 링크에서 들어온 `command_files` 는 브릿지가 어떤 처리보다 먼저 지운다
//!    (`strip_link_only_fields`). 파일을 못 재면 서버로 넘기지 않고 거절을 돌려준다.
//! 2. `command.check` — PreToolUse hook 이 hook 소켓으로 묻는다. 그 턴의 임대·지금 잰 해시·cwd 로 서버
//!    `POST /agent/command-grants/match` 를 부르고 `{allow}` 만 돌려준다. 임대가 없거나 서버에 닿지 않거나 파일을 못 재면
//!    `allow:false`(닫힌 쪽 실패).
//!
//! hook 소켓은 `command.check` 하나만 한다(`thread.peek` 은 앞 처리기가 먼저 답한다) — 그 밖은 403, 서버로 나가지 않는다.
use crate::tool_rules::{ExactCommandVerdict, measure_command_files, validate_exact_command};
use crate::turn_leases::TurnLease;
use crate::turn_peek::{tool_call, tool_result};
use base64::Engine;
use base64::engine::general_purpose::STANDARD;
use harkroom_proto::p1::{RunnerLinkKind, RunnerLinkRequest, RunnerLinkResponse};
use serde_json::{Map, Value, json};

pub const COMMAND_CHECK_TOOL: &str = "command.check";
pub const MATCH_PATH: &str = "/agent/command-grants/match";
const HOOK_ONLY_BODY: &str = "the hook link only answers command.check";

/// 처리 결과 — 바로 답하거나, (파일 해시를 실어) 서버로 넘기거나, 다음 처리기로.
#[derive(Debug)]
pub enum CommandStep {
    Reply(RunnerLinkResponse),
    Forward(RunnerLinkRequest),
    Pass(RunnerLinkRequest),
}

/// `POST MATCH_PATH` — 에이전트 자격의 오퍼레이터 자체 요청. `(status, body)` 또는 닿지 못함.
pub type MatchPost<'a> = &'a dyn Fn(&str, String) -> Result<(u16, String), String>;

fn tool_reply(id: &str, rpc: Value, value: &Value, is_error: bool) -> RunnerLinkResponse {
    let mut m = tool_result(rpc, value);
    if is_error && let Some(r) = m.get_mut("result").and_then(Value::as_object_mut) {
        r.insert("isError".into(), Value::Bool(true));
    }
    RunnerLinkResponse::McpResponse {
        id: id.to_string(),
        messages: vec![m],
    }
}

/// TS `check` — 판정 → 임대 → 재기(미리 보기 없음) → match. 어느 단계든 실패면 `{allow:false}`.
fn check(
    args: &Map<String, Value>,
    agent_id: &str,
    lease: Option<&TurnLease>,
    post: MatchPost<'_>,
    log: &dyn Fn(&str),
) -> Value {
    let deny = json!({"allow": false});
    let s = |k: &str| args.get(k).and_then(Value::as_str);
    let ExactCommandVerdict::Ok { command, files, .. } =
        validate_exact_command(s("command").unwrap_or(""))
    else {
        return deny;
    };
    // lookup_for 가 이미 그 에이전트의 임대만 돌려주지만 TS 와 같은 자리에서 한 번 더 본다.
    let Some(lease) = lease.filter(|l| l.agent_id == agent_id) else {
        return deny;
    };
    let Ok(digests) = measure_command_files(&files, false) else {
        return deny;
    };
    let mut body = json!({
        "leaseId": lease.lease_id,
        "token": lease.token,
        "command": command,
        "files": digests.iter().map(|d| json!({"path": d.path, "sha256": d.sha256})).collect::<Vec<_>>(),
    });
    if let Some(cwd) = s("cwd").filter(|c| !c.is_empty()) {
        body["cwd"] = json!(cwd);
    }
    // TS `slice(0, 200)` 은 UTF-16 단위 — 200 단위를 넘기지 않되 서로게이트 쌍은 가르지 않는다.
    if let Some(t) = s("toolUseId").filter(|t| !t.is_empty()) {
        let mut units = 0;
        let cut: String = t
            .chars()
            .take_while(|c| {
                units += c.len_utf16();
                units <= 200
            })
            .collect();
        if !cut.is_empty() {
            body["toolUseId"] = json!(cut);
        }
    }
    let (status, text) = match post(agent_id, body.to_string()) {
        Ok(r) => r,
        Err(e) => {
            log(&format!("command.check: match 실패 — {e}"));
            return deny;
        }
    };
    if status != 200 {
        return deny;
    }
    let r: Value = serde_json::from_str(&text).unwrap_or(Value::Null);
    match (r.get("allow"), r.get("grantId").and_then(Value::as_str)) {
        (Some(Value::Bool(true)), Some(g)) => json!({"allow": true, "grantId": g}),
        _ => deny,
    }
}

/// TS `maybeHandle`. `req` 는 이미 `strip_link_only_fields` 를 지난 것이어야 한다. `lease` 는 그 요청의 cause·에이전트로 찾은 임대.
pub fn maybe_handle(
    req: RunnerLinkRequest,
    kind: RunnerLinkKind,
    agent_id: &str,
    lease: Option<&TurnLease>,
    post: MatchPost<'_>,
    log: &dyn Fn(&str),
) -> CommandStep {
    let name = match &req {
        RunnerLinkRequest::McpRequest { payload, .. } => tool_call(payload)
            .and_then(|c| c.get("params")?.get("name")?.as_str())
            .map(str::to_string),
        _ => None,
    };
    if kind == RunnerLinkKind::Hook && name.as_deref() != Some(COMMAND_CHECK_TOOL) {
        return CommandStep::Reply(match req {
            RunnerLinkRequest::McpRequest { id, .. } => RunnerLinkResponse::McpError {
                id,
                status: 403,
                message: HOOK_ONLY_BODY.into(),
            },
            RunnerLinkRequest::HttpForward { id, .. } => RunnerLinkResponse::HttpResponse {
                id,
                status: 403,
                body: HOOK_ONLY_BODY.into(),
            },
        });
    }
    let RunnerLinkRequest::McpRequest { id, payload, .. } = &req else {
        return CommandStep::Pass(req);
    };
    let Some(name) = name else {
        return CommandStep::Pass(req);
    };
    let rpc = payload.get("id").cloned().unwrap_or(Value::Null);
    let args = payload
        .get("params")
        .and_then(|p| p.get("arguments"))
        .and_then(Value::as_object)
        .cloned()
        .unwrap_or_default();

    if name == COMMAND_CHECK_TOOL {
        // hook 소켓에서만 받는다(security) — 에이전트가 MCP 로 불러 1회 grant 를 미리 써 버리지 못하게. 서버로도 넘기지 않는다.
        if kind != RunnerLinkKind::Hook {
            let v = json!({"allow": false, "error": {"code": "hook_only", "message": "command.check is answered only on the hook link"}});
            return CommandStep::Reply(tool_reply(id, rpc, &v, true));
        }
        let v = check(&args, agent_id, lease, post, log);
        return CommandStep::Reply(tool_reply(id, rpc, &v, false));
    }

    if name == "permission.request"
        && args.get("kind").and_then(Value::as_str) == Some("command")
        && let Some(cmd) = args.get("command").and_then(Value::as_str)
    {
        // 판정에 걸리는 명령·파일 없는 명령은 서버가 정확한 거절 코드로 답한다 — 재지 않고 그대로 넘긴다(헤더 없음).
        let ExactCommandVerdict::Ok { files, .. } = validate_exact_command(cmd) else {
            return CommandStep::Forward(req);
        };
        if files.is_empty() {
            return CommandStep::Forward(req);
        }
        let digests = match measure_command_files(&files, true) {
            Ok(d) => d,
            Err(e) => {
                let v = json!({"error": {"code": e.code, "message": e.message, "path": e.path}});
                return CommandStep::Reply(tool_reply(id, rpc, &v, true));
            }
        };
        let encoded = STANDARD.encode(serde_json::to_vec(&digests).unwrap_or_default());
        let RunnerLinkRequest::McpRequest {
            id,
            payload,
            cause,
            cwd,
            turn_id,
            ..
        } = req
        else {
            unreachable!("위에서 McpRequest 로 확인했다")
        };
        return CommandStep::Forward(RunnerLinkRequest::McpRequest {
            id,
            payload,
            cause,
            cwd,
            turn_id,
            command_files: Some(encoded),
        });
    }
    CommandStep::Pass(req)
}

#[cfg(test)]
mod tests {
    //! TS `packages/operator/test/turnCommand.test.ts` 의 `describe('turnCommand')` 사례를 옮겼다(재기·비밀 사례는 tool_rules 시험).
    use super::*;
    use crate::forward::strip_link_only_fields;
    use std::cell::RefCell;

    fn tmp() -> std::path::PathBuf {
        let d = std::env::temp_dir().join(format!(
            "cmdf-{}-{}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        std::fs::create_dir_all(&d).unwrap();
        std::fs::canonicalize(d).unwrap()
    }

    fn call(name: &str, args: Value, cause: &str, files: Option<&str>) -> RunnerLinkRequest {
        RunnerLinkRequest::McpRequest {
            id: "r1".into(),
            payload: json!({"jsonrpc": "2.0", "id": 7, "method": "tools/call", "params": {"name": name, "arguments": args}}),
            cause: Some(cause.into()),
            cwd: None,
            turn_id: None,
            command_files: files.map(str::to_string),
        }
    }

    fn lease() -> TurnLease {
        TurnLease {
            lease_id: "L1".into(),
            token: "T1".into(),
            agent_id: "agent-1".into(),
        }
    }

    fn text(s: &CommandStep) -> String {
        match s {
            CommandStep::Reply(r) => serde_json::to_string(r).unwrap(),
            other => panic!("Reply 가 아니다: {other:?}"),
        }
    }

    fn no_post(_: &str, _: String) -> Result<(u16, String), String> {
        panic!("서버에 묻지 않아야 한다")
    }

    #[test]
    fn link_command_files_are_stripped_and_only_measured_digests_go_out() {
        let d = tmp();
        let pf = d.join("p.json");
        std::fs::write(&pf, "{\"real\":1}").unwrap();
        let pf = pf.to_str().unwrap();
        let cmd = format!("kubectl --kubeconfig {pf} --context rc apply -f {pf}");
        let forged =
            STANDARD.encode(json!([{"path": pf, "sha256": "f".repeat(64), "size": 1}]).to_string());
        let req = strip_link_only_fields(call(
            "permission.request",
            json!({"kind": "command", "command": cmd, "channelId": "c", "threadRootId": "t", "reason": "r"}),
            "cause-1",
            Some(&forged),
        ));
        let RunnerLinkRequest::McpRequest { command_files, .. } = &req else {
            panic!()
        };
        assert!(command_files.is_none());
        let step = maybe_handle(
            req,
            RunnerLinkKind::Bridge,
            "agent-1",
            Some(&lease()),
            &no_post,
            &|_| {},
        );
        let CommandStep::Forward(RunnerLinkRequest::McpRequest {
            command_files: Some(h),
            ..
        }) = step
        else {
            panic!("파일 해시를 실어 넘겨야 한다: {step:?}")
        };
        let digests: Value = serde_json::from_slice(&STANDARD.decode(h).unwrap()).unwrap();
        let a = digests.as_array().unwrap();
        assert_eq!(a.len(), 1);
        assert_ne!(a[0]["sha256"], json!("f".repeat(64)));
        assert_eq!(a[0]["path"], json!(pf));
        assert_eq!(a[0]["size"], json!(10));
        // --kubeconfig 자리(secret)가 먼저 나와 같은 파일 하나 — 비밀 자리는 미리 보기 없음.
        assert!(a[0].get("preview").is_none());
    }

    #[test]
    fn unmeasurable_files_are_refused_locally_and_refused_commands_go_out_bare() {
        let bad = maybe_handle(
            call(
                "permission.request",
                json!({"kind": "command", "command": "kubectl --kubeconfig /nope/k --context rc get pods"}),
                "cause-1",
                None,
            ),
            RunnerLinkKind::Bridge,
            "agent-1",
            Some(&lease()),
            &no_post,
            &|_| {},
        );
        let t = text(&bad);
        assert!(t.contains("file_missing") && t.contains("isError"), "{t}");
        let plain = maybe_handle(
            call(
                "permission.request",
                json!({"kind": "command", "command": "ls -la /tmp"}),
                "cause-1",
                None,
            ),
            RunnerLinkKind::Bridge,
            "agent-1",
            Some(&lease()),
            &no_post,
            &|_| {},
        );
        assert!(matches!(
            plain,
            CommandStep::Forward(RunnerLinkRequest::McpRequest {
                command_files: None,
                ..
            })
        ));
        // 다른 도구·kind 는 건드리지 않는다.
        for (n, a) in [
            (
                "permission.request",
                json!({"kind": "tool", "rule": "Bash(a b:*)"}),
            ),
            ("message.post", json!({})),
        ] {
            let s = maybe_handle(
                call(n, a, "cause-1", None),
                RunnerLinkKind::Bridge,
                "agent-1",
                Some(&lease()),
                &no_post,
                &|_| {},
            );
            assert!(matches!(s, CommandStep::Pass(_)), "{n}");
        }
    }

    #[test]
    fn command_check_uses_held_lease_measured_hash_and_cwd_and_returns_only_allow() {
        let d = tmp();
        let k = d.join("k");
        std::fs::write(&k, "kubeconfig").unwrap();
        let k = k.to_str().unwrap();
        let cmd = format!("kubectl --kubeconfig {k} --context rc get pods");
        let bodies = RefCell::new(Vec::<(String, Value)>::new());
        let post = |agent: &str, b: String| {
            bodies
                .borrow_mut()
                .push((agent.to_string(), serde_json::from_str(&b).unwrap()));
            Ok((
                200,
                json!({"allow": true, "grantId": "g1", "singleUse": true}).to_string(),
            ))
        };
        let l = lease();
        let res = maybe_handle(
            call(
                COMMAND_CHECK_TOOL,
                json!({"command": cmd, "cwd": "/srv/ws", "toolUseId": "tu", "leaseId": "FORGED", "token": "FORGED"}),
                "cause-1",
                None,
            ),
            RunnerLinkKind::Hook,
            "agent-1",
            Some(&l),
            &post,
            &|_| {},
        );
        let t = text(&res);
        assert!(
            t.contains(r#"\"allow\":true"#) && t.contains("g1") && !t.contains("singleUse"),
            "{t}"
        );
        let b = &bodies.borrow()[0];
        assert_eq!(b.0, "agent-1");
        assert_eq!(b.1["leaseId"], json!("L1"));
        assert_eq!(b.1["token"], json!("T1"));
        assert_eq!(b.1["cwd"], json!("/srv/ws"));
        assert_eq!(b.1["toolUseId"], json!("tu"));
        assert_eq!(b.1["files"][0]["path"], json!(k));
        assert!(b.1["files"][0].get("preview").is_none());

        // 임대 없음·남의 에이전트·셸 문법이면 서버에 묻지도 않는다.
        let other = TurnLease {
            agent_id: "agent-2".into(),
            ..lease()
        };
        for (lz, c) in [
            (None, cmd.clone()),
            (Some(&other), cmd.clone()),
            (Some(&l), "ls /tmp; rm -rf /".to_string()),
        ] {
            let r = maybe_handle(
                call(COMMAND_CHECK_TOOL, json!({"command": c}), "cause-1", None),
                RunnerLinkKind::Hook,
                "agent-1",
                lz,
                &post,
                &|_| {},
            );
            assert!(text(&r).contains(r#"\"allow\":false"#));
        }
        // 브릿지(에이전트 MCP)에서 온 command.check 는 서버에 묻지 않고 거절한다 — 1회 grant 를 미리 쓰지 못하게.
        let via = maybe_handle(
            call(COMMAND_CHECK_TOOL, json!({"command": cmd}), "cause-1", None),
            RunnerLinkKind::Bridge,
            "agent-1",
            Some(&l),
            &post,
            &|_| {},
        );
        assert!(text(&via).contains("hook_only"));
        // hook 소켓은 command.check 말고는 아무것도 못 한다.
        let m = maybe_handle(
            call("message.post", json!({"body": "x"}), "cause-1", None),
            RunnerLinkKind::Hook,
            "agent-1",
            Some(&l),
            &post,
            &|_| {},
        );
        assert!(matches!(
            m,
            CommandStep::Reply(RunnerLinkResponse::McpError { status: 403, .. })
        ));
        let h = maybe_handle(
            serde_json::from_value(json!({"type": "http.forward", "id": "h", "method": "GET", "path": "/agent/config"})).unwrap(),
            RunnerLinkKind::Hook, "agent-1", Some(&l), &post, &|_| {},
        );
        assert!(matches!(
            h,
            CommandStep::Reply(RunnerLinkResponse::HttpResponse { status: 403, .. })
        ));
        assert_eq!(bodies.borrow().len(), 1);
    }

    #[test]
    fn match_failures_close_the_gate() {
        let d = tmp();
        let k = d.join("k");
        std::fs::write(&k, "x").unwrap();
        let cmd = format!(
            "kubectl --kubeconfig {} --context rc get pods",
            k.to_str().unwrap()
        );
        let cases: Vec<Result<(u16, String), String>> = vec![
            Err("down".into()),
            Ok((500, "{}".into())),
            Ok((200, "not json".into())),
            Ok((200, json!({"allow": true}).to_string())),
            Ok((200, json!({"allow": "true", "grantId": "g"}).to_string())),
            Ok((200, json!({"allow": true, "grantId": 3}).to_string())),
        ];
        for c in cases {
            let post = |_: &str, _: String| c.clone();
            let r = maybe_handle(
                call(COMMAND_CHECK_TOOL, json!({"command": cmd}), "c", None),
                RunnerLinkKind::Hook,
                "agent-1",
                Some(&lease()),
                &post,
                &|_| {},
            );
            assert!(text(&r).contains(r#"\"allow\":false"#), "{c:?}");
        }
    }

    #[test]
    fn tool_use_id_is_cut_at_200_utf16_units_without_splitting_pairs() {
        let d = tmp();
        let k = d.join("k");
        std::fs::write(&k, "x").unwrap();
        let cmd = format!(
            "kubectl --kubeconfig {} --context rc get pods",
            k.to_str().unwrap()
        );
        let got = RefCell::new(String::new());
        let post = |_: &str, b: String| {
            let v: Value = serde_json::from_str(&b).unwrap();
            *got.borrow_mut() = v["toolUseId"].as_str().unwrap().to_string();
            Ok((200, "{}".into()))
        };
        let id = format!("{}😀tail", "a".repeat(199));
        maybe_handle(
            call(
                COMMAND_CHECK_TOOL,
                json!({"command": cmd, "toolUseId": id}),
                "c",
                None,
            ),
            RunnerLinkKind::Hook,
            "agent-1",
            Some(&lease()),
            &post,
            &|_| {},
        );
        assert_eq!(*got.borrow(), "a".repeat(199));
    }
}
