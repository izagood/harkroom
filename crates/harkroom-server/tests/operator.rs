//! 오퍼레이터 코어(C2a)를 실제 Postgres 로 — 가짜 오퍼레이터가 `/operator` 에 붙고 `/operators*` REST 를 부른다.
//! `HARKROOM_TEST_DATABASE_URL` 이 없으면 건너뛴다(CI 는 `db-tests` 잡이 `scripts/db-tests.sh` 로 DB 를 넘긴다).
//! 그 DB 에는 TS 서버의 마이그레이션이 전부 적용돼 있어야 한다. 시험이 넣은 행은 끝에 지운다 — 계정만은 남는다(`audit_log` 가
//! append-only 라 감사 줄이 가리키는 계정을 지울 수 없다. 시험마다 복제한 DB 라 버려진다).
//!
//! - 등록 코드 → claim → 토큰. 같은 코드 두 번은 401. 이름이 틀리면 400.
//! - 같은 오퍼레이터의 두 번째 소켓은 앞 소켓을 4409 로 밀어낸다(TS operatorHub 와 같음).
//! - hello 의 version 이 `operator.version` 에, 프레임을 받으면 `last_seen_at` 이 적힌다.
//! - hello 마다 그 오퍼레이터의 배정을 다시 민다(assign → assign.synced). 재접속에도, 종료 요청이 걸린 에이전트는 빼고.
//! - claim `replaces` 는 옛 행을 폐기하고 배정을 옮기며, 옛 소켓은 4401 로 끊긴다.
//! - PATCH 로 이름(label)을 바꾸고, DELETE 로 폐기하면 소켓이 4401 로 끊기고 그 토큰은 더 쓰이지 않는다.
//! - DB 에서 직접 폐기한 것(TS 쪽이 폐기한 경우)도 재검증 주기 안에 4401 로 끊긴다.
//! - TS 가 폐기 뒤 낸 `operator.changed`(outbox 로 온다)를 받으면 재검증 주기를 기다리지 않고 4401 로 끊는다. 폐기되지 않은
//!   오퍼레이터의 `operator.changed` 로는 끊지 않는다(`revoke_event_disconnects_without_waiting`).
mod common;

use axum::http::{Method, StatusCode};
use futures_util::{SinkExt, StreamExt};
use harkroom_server::auth::{AuthPools, hash_token};
use harkroom_server::core::events::Hub;
use harkroom_server::core::operator::{OpTiming, OperatorCore, router};
use harkroom_server::core::operator_hub::OperatorHub;
use serde_json::{Value, json};
use sqlx::PgPool;
use std::sync::Arc;
use std::time::Duration;
use tokio_tungstenite::tungstenite::Message;
use tokio_tungstenite::tungstenite::client::IntoClientRequest;

type Ws =
    tokio_tungstenite::WebSocketStream<tokio_tungstenite::MaybeTlsStream<tokio::net::TcpStream>>;

async fn connect(base: &str, token: &str) -> Ws {
    let mut req = format!("{}/operator", base.replace("http://", "ws://"))
        .into_client_request()
        .unwrap();
    req.headers_mut()
        .insert("authorization", format!("Bearer {token}").parse().unwrap());
    tokio_tungstenite::connect_async(req).await.unwrap().0
}

/// 닫기 코드가 올 때까지 읽는다(그 사이 오는 프레임은 버린다).
async fn close_code(ws: &mut Ws) -> Option<u16> {
    tokio::time::timeout(Duration::from_secs(10), async {
        while let Some(m) = ws.next().await {
            match m {
                Ok(Message::Close(Some(f))) => return Some(u16::from(f.code)),
                Ok(Message::Close(None)) | Err(_) => return None,
                Ok(_) => {}
            }
        }
        None
    })
    .await
    .expect("close within 10s")
}

/// 그 타입의 서버 프레임이 올 때까지 읽는다(앞에 온 프레임은 모아 돌려준다).
async fn until_frame(ws: &mut Ws, ty: &str) -> (Value, Vec<Value>) {
    tokio::time::timeout(Duration::from_secs(10), async {
        let mut seen = Vec::new();
        while let Some(m) = ws.next().await {
            if let Ok(Message::Text(t)) = m {
                let v: Value = serde_json::from_str(t.as_str()).unwrap();
                if v["type"] == ty {
                    return (v, seen);
                }
                seen.push(v);
            }
        }
        panic!("socket ended before {ty}");
    })
    .await
    .expect("frame within 10s")
}

/// 조건이 설 때까지 DB 를 본다(쓰기는 기다리지 않고 띄워 두므로).
async fn eventually(pool: &PgPool, sql: &'static str, id: &str) -> bool {
    for _ in 0..50 {
        let ok: bool = sqlx::query_scalar(sql)
            .bind(id)
            .fetch_one(pool)
            .await
            .unwrap();
        if ok {
            return true;
        }
        tokio::time::sleep(Duration::from_millis(100)).await;
    }
    false
}

async fn req(
    base: &str,
    m: Method,
    path: &str,
    token: Option<&str>,
    body: &str,
) -> (StatusCode, Value) {
    let auth = token.map(|t| format!("Bearer {t}"));
    let mut h: Vec<(&str, &str)> = vec![("content-type", "application/json")];
    if let Some(a) = &auth {
        h.push(("authorization", a));
    }
    let body = if body.is_empty() && m == Method::GET {
        ""
    } else {
        body
    };
    let h: Vec<(&str, &str)> = if body.is_empty() {
        h.into_iter()
            .filter(|(k, _)| *k != "content-type")
            .collect()
    } else {
        h
    };
    let (s, _, b) = common::send(base, m, path, &h, body).await;
    (s, serde_json::from_str(&b).unwrap_or(Value::Null))
}

/// 쓰기 역할의 연결은 `scripts/db-tests.sh` 가 8개로 묶는다. 이 파일의 두 시험이 함께 돌므로 하나가 3개까지만 쓴다.
async fn write_pool(url: &str) -> PgPool {
    sqlx::postgres::PgPoolOptions::new()
        .max_connections(3)
        .connect(url)
        .await
        .unwrap()
}

#[tokio::test]
async fn fake_operator_against_real_schema() {
    let Ok(url) = std::env::var("HARKROOM_TEST_DATABASE_URL") else {
        eprintln!("skip: HARKROOM_TEST_DATABASE_URL unset");
        return;
    };
    let pool = PgPool::connect(&url).await.unwrap();
    let tag = format!("op{}", std::process::id());

    // 사람(member — 기본으로 operator.register 를 가진다)·에이전트·세션.
    let human: String = sqlx::query_scalar(
        "insert into account(handle, display_name, kind, login_id) values ($1, $1, 'human', $1) returning id::text",
    )
    .bind(format!("{tag}-human"))
    .fetch_one(&pool)
    .await
    .unwrap();
    let agent: String = sqlx::query_scalar(
        "insert into account(handle, display_name, kind) values ($1, $1, 'agent') returning id::text",
    )
    .bind(format!("{tag}-agent"))
    .fetch_one(&pool)
    .await
    .unwrap();
    let sess = format!("{tag}-sess");
    sqlx::query("insert into session(token_hash, account_id, expires_at) values ($1, $2::uuid, now() + interval '1 day')")
        .bind(hash_token(&sess))
        .bind(&human)
        .execute(&pool)
        .await
        .unwrap();

    // 바꿀 칸만 적는다 — `OpTiming` 칸이 늘어도 시험 초기화가 깨지지 않는다(쓰기 시한 등은 기본값).
    let timing = OpTiming {
        heartbeat: Duration::from_secs(3600),
        last_seen_write: Duration::from_secs(3600),
        revalidate: Duration::from_millis(300),
        status_min: Duration::from_millis(10),
        gh_lines: Duration::from_millis(500),
        cap_touch: Duration::from_millis(200),
        ..OpTiming::default()
    };
    // 쓰기 풀 — 있으면 `OPERATOR_PRIVILEGES` 만 가진 역할(rustFrontDb.test.ts 가 만든다). 표가 모자라면 아래 쓰기가 실패한다.
    let write = match std::env::var("HARKROOM_TEST_WRITE_DATABASE_URL") {
        Ok(w) => {
            let w = write_pool(&w).await;
            let missing = harkroom_server::write::missing_operator_privileges(&w)
                .await
                .unwrap();
            assert!(missing.is_empty(), "write role missing {missing:?}");
            w
        }
        Err(_) => pool.clone(),
    };
    let core = OperatorCore::new(
        pool.clone(),
        write.clone(),
        Arc::new(harkroom_server::trust_proxy::parse(None).unwrap()),
        Hub::new(),
        OperatorHub::new(),
        timing,
    );
    let app = router(
        core.clone(),
        AuthPools {
            read: pool.clone(),
            write: Some(write.clone()),
        },
        Arc::new(harkroom_server::cors::Cors::from_env_value(Some(
            "tauri://localhost",
        ))),
    );
    let base = format!("http://{}", common::serve(app).await);

    // ---- CORS — 데스크톱(`tauri://localhost`)은 `/operators*` 를 교차 출처로 부른다(401 에도 머리, 프리플라이트도 이 층이 답함) ----
    let origin = ("origin", "tauri://localhost");
    let (s, h, _) = common::send(&base, Method::GET, "/operators", &[origin], "").await;
    assert_eq!(s, StatusCode::UNAUTHORIZED);
    assert_eq!(
        h["access-control-allow-origin"], "tauri://localhost",
        "401 에도 CORS"
    );
    for (method, path) in [
        ("GET", "/operators"),
        ("POST", "/operators/register-codes"),
        (
            "GET",
            "/operators/00000000-0000-4000-8000-000000000999/capabilities",
        ),
        ("DELETE", "/operators/00000000-0000-4000-8000-000000000999"),
    ] {
        let (s, h, _) = common::send(
            &base,
            Method::OPTIONS,
            path,
            &[
                origin,
                ("access-control-request-method", method),
                ("access-control-request-headers", "authorization"),
            ],
            "",
        )
        .await;
        assert_eq!(s, StatusCode::NO_CONTENT, "preflight {method} {path}");
        assert_eq!(h["access-control-allow-origin"], "tauri://localhost");
        assert!(h.contains_key("access-control-allow-methods"));
    }

    // ---- 등록 코드 → claim ----
    let (s, _) = req(&base, Method::POST, "/operators/register-codes", None, "{}").await;
    assert_eq!(
        s,
        StatusCode::UNAUTHORIZED,
        "register-codes needs a session"
    );
    let claim = |code: String, extra: Value| {
        let mut b = json!({ "code": code, "name": format!("{tag}-mac") });
        if let Value::Object(e) = extra {
            b.as_object_mut().unwrap().extend(e);
        }
        b.to_string()
    };
    let (s, rc) = req(
        &base,
        Method::POST,
        "/operators/register-codes",
        Some(&sess),
        "{}",
    )
    .await;
    assert_eq!(s, StatusCode::OK, "{rc}");
    let code = rc["code"].as_str().unwrap().to_owned();
    assert!(code.starts_with("hkreg_"));
    let (s, bad) = req(
        &base,
        Method::POST,
        "/operators/claim",
        None,
        &json!({ "code": code, "name": "" }).to_string(),
    )
    .await;
    assert_eq!(s, StatusCode::BAD_REQUEST, "{bad}");
    let (s, c1) = req(
        &base,
        Method::POST,
        "/operators/claim",
        None,
        &claim(code.clone(), json!({})),
    )
    .await;
    assert_eq!(s, StatusCode::OK, "{c1}");
    let op1 = c1["operator"]["id"].as_str().unwrap().to_owned();
    let tok1 = c1["token"].as_str().unwrap().to_owned();
    assert!(tok1.starts_with("hkop_"));
    assert_eq!(c1["replaced"], Value::Null);
    let (s, _) = req(
        &base,
        Method::POST,
        "/operators/claim",
        None,
        &claim(code, json!({})),
    )
    .await;
    assert_eq!(s, StatusCode::UNAUTHORIZED, "a register code is one-shot");

    sqlx::query("insert into agent_assignment(agent_id, operator_id, assigned_by) values ($1::uuid, $2::uuid, $3::uuid)")
        .bind(&agent)
        .bind(&op1)
        .bind(&human)
        .execute(&pool)
        .await
        .unwrap();

    // ---- 소켓: hello → version·last_seen. 두 번째 소켓은 앞 것을 4409 로 ----
    let mut a = connect(&base, &tok1).await;
    a.send(Message::Text(
        json!({ "type": "hello", "version": "9.9.9-test" })
            .to_string()
            .into(),
    ))
    .await
    .unwrap();
    assert!(
        eventually(
            &pool,
            "select coalesce(version = '9.9.9-test', false) from operator where id = $1::uuid",
            &op1
        )
        .await,
        "hello version written"
    );
    assert!(
        eventually(
            &pool,
            "select last_seen_at is not null from operator where id = $1::uuid",
            &op1
        )
        .await,
        "last_seen_at written"
    );
    // ---- hello → 배정 재전송(assign 들 → assign.synced{agentIds}, TS assignmentRoutes onFrame) ----
    let (synced, before) = until_frame(&mut a, "assign.synced").await;
    assert_eq!(synced["agentIds"], json!([agent]), "{synced}");
    let assigns: Vec<&Value> = before.iter().filter(|f| f["type"] == "assign").collect();
    assert_eq!(assigns.len(), 1, "{before:?}");
    assert_eq!(assigns[0]["agentId"], json!(agent));
    let def = &assigns[0]["definition"];
    assert_eq!(def["agentId"], json!(agent), "{def}");
    assert_eq!(def["harness"], "claude-code", "{def}");
    assert_eq!(def["mcpServers"], json!([]), "{def}");
    assert_eq!(def["credentialScope"], "none", "{def}");
    let (s, me) = req(&base, Method::GET, "/operators/self", Some(&tok1), "").await;
    assert_eq!(s, StatusCode::OK, "{me}");
    assert_eq!(me["id"].as_str(), Some(op1.as_str()), "{me}");

    // ---- AC6 능력 스냅숏: capabilities 프레임 → `operator_capability` 줄. 새 연결은 hello 전까지 「모른다」(줄 지움) ----
    a.send(Message::Text(
        json!({ "type": "capabilities", "capabilities": { "harnesses": { "claude-code": { "models": [{ "id": "m-test" }] } } } })
            .to_string()
            .into(),
    ))
    .await
    .unwrap();
    assert!(
        eventually(
            &pool,
            "select coalesce((select body #>> '{harnesses,claude-code,models,0,id}' = 'm-test' from operator_capability where operator_id = $1::uuid), false)",
            &op1
        )
        .await,
        "capabilities snapshot written"
    );
    assert!(
        eventually(
            &pool,
            "select coalesce((select seen_at > updated_at from operator_capability where operator_id = $1::uuid), false)",
            &op1
        )
        .await,
        "seen_at touched while online"
    );
    let mut b = connect(&base, &tok1).await;
    assert_eq!(
        close_code(&mut a).await,
        Some(4409),
        "older socket replaced"
    );
    assert!(
        eventually(
            &pool,
            "select not exists (select 1 from operator_capability where operator_id = $1::uuid)",
            &op1
        )
        .await,
        "replacement clears snapshot until hello"
    );
    // ---- 재접속 → assign 재전송. 종료 요청이 걸린 에이전트는 밀지 않는다(synced 는 빈 목록) ----
    b.send(Message::Text(json!({ "type": "hello" }).to_string().into()))
        .await
        .unwrap();
    let (synced, before) = until_frame(&mut b, "assign.synced").await;
    assert_eq!(synced["agentIds"], json!([agent]), "reconnect resends");
    assert!(
        before
            .iter()
            .any(|f| f["type"] == "assign" && f["agentId"] == json!(agent))
    );
    sqlx::query("insert into agent_config(account_id, stop_requested_at) values ($1::uuid, now()) on conflict (account_id) do update set stop_requested_at = now()")
        .bind(&agent)
        .execute(&pool)
        .await
        .unwrap();
    b.send(Message::Text(json!({ "type": "hello" }).to_string().into()))
        .await
        .unwrap();
    let (synced, before) = until_frame(&mut b, "assign.synced").await;
    assert_eq!(synced["agentIds"], json!([]), "stopped agent not resent");
    assert!(!before.iter().any(|f| f["type"] == "assign"), "{before:?}");
    sqlx::query("update agent_config set stop_requested_at = null where account_id = $1::uuid")
        .bind(&agent)
        .execute(&pool)
        .await
        .unwrap();

    // ---- 배정 줄 PUT·DELETE /accounts/agents/{id}/assignment (TS assignmentRoutes) ----
    let apath = format!("/accounts/agents/{agent}/assignment");
    let put = |op: &str| json!({ "operatorId": op }).to_string();
    let (s, _) = req(&base, Method::PUT, &apath, None, &put(&op1)).await;
    assert_eq!(s, StatusCode::UNAUTHORIZED);
    let (s, e) = req(&base, Method::PUT, &apath, Some(&sess), &put(&op1)).await;
    assert_eq!(s, StatusCode::FORBIDDEN, "no agent.manage: {e}");
    sqlx::query("insert into account_grant(account_id, capability, scope, granted_by) values ($1::uuid, 'agent.manage', '', $1::uuid)")
        .bind(&human)
        .execute(&pool)
        .await
        .unwrap();
    let (s, e) = req(&base, Method::PUT, &apath, Some(&sess), "{}").await;
    assert_eq!(s, StatusCode::BAD_REQUEST, "{e}");
    let (s, e) = req(
        &base,
        Method::PUT,
        &apath,
        Some(&sess),
        &put("00000000-0000-4000-8000-000000000999"),
    )
    .await;
    assert_eq!(s, StatusCode::NOT_FOUND, "unknown operator: {e}");
    // hello 에 능력(agentIds)이 없었다 → 409 not_capable.
    let (s, e) = req(&base, Method::PUT, &apath, Some(&sess), &put(&op1)).await;
    assert_eq!(s, StatusCode::CONFLICT, "{e}");
    assert_eq!(e["error"]["code"], "not_capable", "{e}");
    b.send(Message::Text(
        json!({ "type": "hello", "capabilities": { "agentIds": [agent] } })
            .to_string()
            .into(),
    ))
    .await
    .unwrap();
    until_frame(&mut b, "assign.synced").await;
    let (s, row) = req(&base, Method::PUT, &apath, Some(&sess), &put(&op1)).await;
    assert_eq!(s, StatusCode::OK, "{row}");
    assert_eq!(row["operatorId"].as_str(), Some(op1.as_str()), "{row}");
    let (f, _) = until_frame(&mut b, "assign").await;
    assert_eq!(f["agentId"], json!(agent), "{f}");
    assert_eq!(f["definition"]["agentId"], json!(agent), "{f}");

    // 재배정: 옛 곳(op1)이 먼저 unassign{drain}, 새 곳(opx)이 assign.
    let (_, rc) = req(
        &base,
        Method::POST,
        "/operators/register-codes",
        Some(&sess),
        "{}",
    )
    .await;
    let (s, cx) = req(
        &base,
        Method::POST,
        "/operators/claim",
        None,
        &claim(rc["code"].as_str().unwrap().to_owned(), json!({})),
    )
    .await;
    assert_eq!(s, StatusCode::OK, "{cx}");
    let opx = cx["operator"]["id"].as_str().unwrap().to_owned();
    let mut x = connect(&base, cx["token"].as_str().unwrap()).await;
    x.send(Message::Text(
        json!({ "type": "hello", "capabilities": { "agentIds": [agent] } })
            .to_string()
            .into(),
    ))
    .await
    .unwrap();
    let (synced, _) = until_frame(&mut x, "assign.synced").await;
    assert_eq!(synced["agentIds"], json!([]), "{synced}");
    let (s, row) = req(&base, Method::PUT, &apath, Some(&sess), &put(&opx)).await;
    assert_eq!(s, StatusCode::OK, "{row}");
    assert_eq!(row["operatorId"].as_str(), Some(opx.as_str()), "{row}");
    let (f, _) = until_frame(&mut b, "unassign").await;
    assert_eq!(f["agentId"], json!(agent), "{f}");
    assert_eq!(f["drain"], json!(true), "{f}");
    let (f, _) = until_frame(&mut x, "assign").await;
    assert_eq!(f["agentId"], json!(agent), "{f}");
    let audits: i64 = sqlx::query_scalar(
        "select count(*) from audit_log where action = 'agent.assigned' and target = $1",
    )
    .bind(&agent)
    .fetch_one(&pool)
    .await
    .unwrap();
    assert_eq!(audits, 2, "agent.assigned audited per PUT");

    // DELETE → 옛 곳에 unassign{drain}, 204. 두 번째는 404.
    let (s, _) = req(&base, Method::DELETE, &apath, Some(&sess), "").await;
    assert_eq!(s, StatusCode::NO_CONTENT);
    let (f, _) = until_frame(&mut x, "unassign").await;
    assert_eq!(f["drain"], json!(true), "{f}");
    let left: i64 =
        sqlx::query_scalar("select count(*) from agent_assignment where agent_id = $1::uuid")
            .bind(&agent)
            .fetch_one(&pool)
            .await
            .unwrap();
    assert_eq!(left, 0, "assignment deleted");
    let (s, e) = req(&base, Method::DELETE, &apath, Some(&sess), "").await;
    assert_eq!(s, StatusCode::NOT_FOUND, "{e}");
    // 아래 claim replaces 시험은 op1 에 배정 하나가 있다고 본다 — 되돌려 둔다. opx 는 폐기해 소켓을 닫는다.
    let (s, row) = req(&base, Method::PUT, &apath, Some(&sess), &put(&op1)).await;
    assert_eq!(s, StatusCode::OK, "{row}");
    let (s, _) = req(
        &base,
        Method::DELETE,
        &format!("/operators/{opx}"),
        Some(&sess),
        "",
    )
    .await;
    assert_eq!(s, StatusCode::NO_CONTENT);
    assert_eq!(close_code(&mut x).await, Some(4401));

    // ---- 멈추기 줄 POST /accounts/agents/{id}/stop·stop/undo (TS accountRoutes) — 배정은 op1 ----
    until_frame(&mut b, "assign").await;
    let spath = format!("/accounts/agents/{agent}/stop");
    let upath = format!("/accounts/agents/{agent}/stop/undo");
    let (s, _) = req(&base, Method::POST, &spath, None, "").await;
    assert_eq!(s, StatusCode::UNAUTHORIZED);
    let (s, e) = req(
        &base,
        Method::POST,
        "/accounts/agents/00000000-0000-4000-8000-000000000999/stop",
        Some(&sess),
        "",
    )
    .await;
    assert_eq!(s, StatusCode::NOT_FOUND, "{e}");
    let (s, e) = req(
        &base,
        Method::POST,
        &format!("/accounts/agents/{human}/stop"),
        Some(&sess),
        "",
    )
    .await;
    assert_eq!(s, StatusCode::NOT_FOUND, "human is not an agent: {e}");
    let (s, view) = req(&base, Method::POST, &spath, Some(&sess), "").await;
    assert_eq!(s, StatusCode::OK, "{view}");
    assert_eq!(view["id"], json!(agent), "{view}");
    assert!(
        view["stopRequestedAt"]
            .as_str()
            .is_some_and(|t| t.ends_with('Z')),
        "{view}"
    );
    assert_eq!(view["stopAckedAt"], Value::Null, "{view}");
    assert_eq!(
        view["assignment"]["operatorId"],
        json!(op1),
        "assignment kept: {view}"
    );
    let (f, _) = until_frame(&mut b, "unassign").await;
    assert_eq!(f["agentId"], json!(agent), "{f}");
    assert_eq!(f["drain"], json!(true), "{f}");
    let (s, view) = req(&base, Method::POST, &upath, Some(&sess), "").await;
    assert_eq!(s, StatusCode::OK, "{view}");
    assert_eq!(view["stopRequestedAt"], Value::Null, "{view}");
    let (f, _) = until_frame(&mut b, "assign").await;
    assert_eq!(f["definition"]["agentId"], json!(agent), "{f}");
    // 요청이 없으면 되돌리기는 200 이고 감사를 남기지 않는다.
    let (s, _) = req(&base, Method::POST, &upath, Some(&sess), "").await;
    assert_eq!(s, StatusCode::OK);
    for (action, want) in [("agent.stop.requested", 1i64), ("agent.stop.undone", 1)] {
        let n: i64 =
            sqlx::query_scalar("select count(*) from audit_log where action = $1 and target = $2")
                .bind(action)
                .bind(&agent)
                .fetch_one(&pool)
                .await
                .unwrap();
        assert_eq!(n, want, "{action}");
    }

    // ---- 재시작 줄 POST /accounts/agents/{id}/restart (TS accountRoutes restart) ----
    let rpath = format!("/accounts/agents/{agent}/restart");
    let (s, _) = req(&base, Method::POST, &rpath, None, "").await;
    assert_eq!(s, StatusCode::UNAUTHORIZED);
    let (s, e) = req(
        &base,
        Method::POST,
        "/accounts/agents/00000000-0000-4000-8000-000000000999/restart",
        Some(&sess),
        "",
    )
    .await;
    assert_eq!(s, StatusCode::NOT_FOUND, "{e}");
    let (s, e) = req(
        &base,
        Method::POST,
        &format!("/accounts/agents/{human}/restart"),
        Some(&sess),
        "",
    )
    .await;
    assert_eq!(s, StatusCode::NOT_FOUND, "human account: {e}");
    // 정상: 새 정의(assign)를 먼저, 그다음 agent.restart. 배정은 그대로, 202 {operatorId}.
    let (s, r) = req(&base, Method::POST, &rpath, Some(&sess), "").await;
    assert_eq!(s, StatusCode::ACCEPTED, "{r}");
    assert_eq!(r["operatorId"].as_str(), Some(op1.as_str()), "{r}");
    let (f, before) = until_frame(&mut b, "agent.restart").await;
    assert_eq!(f["agentId"], json!(agent), "{f}");
    let last_assign = before
        .iter()
        .rev()
        .find(|v| v["type"] == "assign")
        .cloned()
        .unwrap_or(Value::Null);
    assert_eq!(
        last_assign["agentId"],
        json!(agent),
        "definition re-pushed before restart: {before:?}"
    );
    let audits: i64 = sqlx::query_scalar(
        "select count(*) from audit_log where action = 'agent.restart.requested' and target = $1",
    )
    .bind(&agent)
    .fetch_one(&pool)
    .await
    .unwrap();
    assert_eq!(audits, 1, "restart audited");
    // 멈춰 둔 에이전트 → 409 stopped.
    sqlx::query("insert into agent_config(account_id, stop_requested_at) values ($1::uuid, now()) on conflict (account_id) do update set stop_requested_at = now()")
        .bind(&agent)
        .execute(&pool)
        .await
        .unwrap();
    let (s, e) = req(&base, Method::POST, &rpath, Some(&sess), "").await;
    assert_eq!(s, StatusCode::CONFLICT, "{e}");
    assert_eq!(e["error"]["code"], "stopped", "{e}");
    sqlx::query("update agent_config set stop_requested_at = null where account_id = $1::uuid")
        .bind(&agent)
        .execute(&pool)
        .await
        .unwrap();
    // 붙어 있지 않은 오퍼레이터(폐기한 opx)에 배정 → 409 operator_offline.
    sqlx::query("update agent_assignment set operator_id = $2::uuid where agent_id = $1::uuid")
        .bind(&agent)
        .bind(&opx)
        .execute(&pool)
        .await
        .unwrap();
    let (s, e) = req(&base, Method::POST, &rpath, Some(&sess), "").await;
    assert_eq!(s, StatusCode::CONFLICT, "{e}");
    assert_eq!(e["error"]["code"], "operator_offline", "{e}");
    // 배정 없음 → 409 not_assigned.
    sqlx::query("delete from agent_assignment where agent_id = $1::uuid")
        .bind(&agent)
        .execute(&pool)
        .await
        .unwrap();
    let (s, e) = req(&base, Method::POST, &rpath, Some(&sess), "").await;
    assert_eq!(s, StatusCode::CONFLICT, "{e}");
    assert_eq!(e["error"]["code"], "not_assigned", "{e}");
    let audits: i64 = sqlx::query_scalar(
        "select count(*) from audit_log where action = 'agent.restart.requested' and target = $1",
    )
    .bind(&agent)
    .fetch_one(&pool)
    .await
    .unwrap();
    assert_eq!(audits, 1, "failed restarts are not audited");
    // 아래 claim replaces 시험을 위해 op1 배정으로 되돌린다.
    sqlx::query("insert into agent_assignment(agent_id, operator_id, assigned_by) values ($1::uuid, $2::uuid, $3::uuid)")
        .bind(&agent)
        .bind(&op1)
        .bind(&human)
        .execute(&pool)
        .await
        .unwrap();
    // ---- 머지 계정 줄 GET·PUT /agents/{id}/merge-accounts(/lines) (TS mergeAccountRoutes) — 배정은 op1 ----
    let mpath = format!("/agents/{agent}/merge-accounts");
    let lpath = format!("/agents/{agent}/merge-accounts/lines");
    // 계정 없이 오면 TS requireAccount 처럼 401 — uuid 가 아니어도, 몸이 비어도 400·404 보다 먼저다.
    for (m, p) in [
        (Method::GET, mpath.clone()),
        (Method::PUT, lpath.clone()),
        (Method::GET, "/agents/not-a-uuid/merge-accounts".to_owned()),
        (
            Method::PUT,
            "/agents/not-a-uuid/merge-accounts/lines".to_owned(),
        ),
    ] {
        let (s, e) = req(&base, m.clone(), &p, None, "").await;
        assert_eq!(
            (s, e["error"]["code"].clone()),
            (StatusCode::UNAUTHORIZED, json!("unauthorized")),
            "{m} {p}"
        );
    }
    // 소유자가 아니면 그런 에이전트가 있는지도 말하지 않는다.
    let (s, _) = req(&base, Method::GET, &mpath, Some(&sess), "").await;
    assert_eq!(s, StatusCode::NOT_FOUND);
    sqlx::query("update agent_config set owner_account_id = $2::uuid where account_id = $1::uuid")
        .bind(&agent)
        .bind(&human)
        .execute(&pool)
        .await
        .unwrap();
    let (s, v) = req(&base, Method::GET, &mpath, Some(&sess), "").await;
    assert_eq!(s, StatusCode::OK, "{v}");
    assert_eq!(v, json!({ "operatorId": op1, "report": null }), "{v}");
    sqlx::query(
        "insert into operator_gh_report (operator_id, logins, by_scope, reach) values ($1::uuid, '[\"alice\",\"bob\"]', '{}', '[]') \
         on conflict (operator_id) do update set logins = excluded.logins, by_scope = '{}'",
    )
    .bind(&op1)
    .execute(&pool)
    .await
    .unwrap();
    let (s, v) = req(&base, Method::GET, &mpath, Some(&sess), "").await;
    assert_eq!(s, StatusCode::OK, "{v}");
    assert_eq!(v["report"]["logins"], json!(["alice", "bob"]), "{v}");
    let put = |body: Value| {
        let (base, lpath, sess) = (base.clone(), lpath.clone(), sess.clone());
        async move { req(&base, Method::PUT, &lpath, Some(&sess), &body.to_string()).await }
    };
    let (s, e) = put(json!({ "scope": "nope", "ghUser": "alice" })).await;
    assert_eq!(
        (s, e["error"]["code"].clone()),
        (StatusCode::BAD_REQUEST, json!("bad_scope"))
    );
    // 유니코드 소문자화로 ASCII 가 되는 글자(켈빈 기호 U+212A)는 범위로 받지 않는다.
    let (s, e) = put(json!({ "scope": "Org/\u{212A}epo", "ghUser": "alice" })).await;
    assert_eq!(
        (s, e["error"]["code"].clone()),
        (StatusCode::BAD_REQUEST, json!("bad_scope"))
    );
    let (s, e) = put(json!({ "scope": "Org/Repo", "ghUser": "carol" })).await;
    assert_eq!(
        (s, e["error"]["code"].clone()),
        (StatusCode::CONFLICT, json!("unknown_login"))
    );
    // 성공 — 서버가 op1 에 gh.lines.set 을 보내고, 오퍼레이터가 같은 requestId 로 답한다.
    let call = tokio::spawn(put(json!({ "scope": "Org/Repo", "ghUser": "alice" })));
    let (f, _) = until_frame(&mut b, "gh.lines.set").await;
    assert_eq!(
        (f["scope"].clone(), f["ghUser"].clone()),
        (json!("org/repo"), json!("alice")),
        "{f}"
    );
    b.send(Message::Text(
        json!({ "type": "gh.lines.result", "requestId": f["requestId"], "ok": true })
            .to_string()
            .into(),
    ))
    .await
    .unwrap();
    let (s, v) = call.await.unwrap();
    assert_eq!((s, v), (StatusCode::OK, json!({ "ok": true })));
    let by: Value =
        sqlx::query_scalar("select by_scope from operator_gh_report where operator_id = $1::uuid")
            .bind(&op1)
            .fetch_one(&pool)
            .await
            .unwrap();
    assert_eq!(by, json!({ "org/repo": "alice" }));
    // 거절 — 오퍼레이터의 code 를 그대로 409 로.
    let call = tokio::spawn(put(json!({ "scope": "org/*", "ghUser": null })));
    let (f, _) = until_frame(&mut b, "gh.lines.set").await;
    b.send(Message::Text(
        json!({ "type": "gh.lines.result", "requestId": f["requestId"], "ok": false, "code": "no_agent" }).to_string().into(),
    ))
    .await
    .unwrap();
    let (s, e) = call.await.unwrap();
    assert_eq!(
        (s, e["error"]["code"].clone()),
        (StatusCode::CONFLICT, json!("no_agent"))
    );
    // 답이 없으면 504.
    let (s, e) = put(json!({ "scope": "org/repo", "ghUser": null })).await;
    assert_eq!(
        (s, e["error"]["code"].clone()),
        (StatusCode::GATEWAY_TIMEOUT, json!("operator_unreachable"))
    );
    until_frame(&mut b, "gh.lines.set").await;
    let n: i64 = sqlx::query_scalar("select count(*) from audit_log where action = 'operator.merge_line.set_remote' and target = $1")
        .bind(&op1)
        .fetch_one(&pool)
        .await
        .unwrap();
    assert_eq!(n, 3);

    // ---- 목록·이름 바꾸기 ----
    let (s, list) = req(&base, Method::GET, "/operators", Some(&sess), "").await;
    assert_eq!(s, StatusCode::OK, "{list}");
    assert!(list.to_string().contains(&op1), "{list}");
    let (s, renamed) = req(
        &base,
        Method::PATCH,
        &format!("/operators/{op1}"),
        Some(&sess),
        &json!({ "label": "  my  box " }).to_string(),
    )
    .await;
    assert_eq!(s, StatusCode::OK, "{renamed}");
    let label: Option<String> =
        sqlx::query_scalar("select label from operator where id = $1::uuid")
            .bind(&op1)
            .fetch_one(&pool)
            .await
            .unwrap();
    assert!(label.is_some(), "label stored");

    // ---- claim replaces: 옛 행 폐기·배정 이동·옛 소켓 4401·이름 이어받기 ----
    let (_, rc) = req(
        &base,
        Method::POST,
        "/operators/register-codes",
        Some(&sess),
        "{}",
    )
    .await;
    let (s, c2) = req(
        &base,
        Method::POST,
        "/operators/claim",
        None,
        &claim(
            rc["code"].as_str().unwrap().to_owned(),
            json!({ "replaces": op1 }),
        ),
    )
    .await;
    assert_eq!(s, StatusCode::OK, "{c2}");
    let op2 = c2["operator"]["id"].as_str().unwrap().to_owned();
    let tok2 = c2["token"].as_str().unwrap().to_owned();
    assert_eq!(
        c2["replaced"]["operatorId"].as_str(),
        Some(op1.as_str()),
        "{c2}"
    );
    assert_eq!(c2["replaced"]["movedAssignments"], json!(1), "{c2}");
    assert_eq!(
        close_code(&mut b).await,
        Some(4401),
        "replaced operator's socket revoked"
    );
    assert!(
        eventually(
            &pool,
            "select not exists (select 1 from operator_capability where operator_id = $1::uuid)",
            &op1
        )
        .await,
        "disconnect clears snapshot"
    );
    let on: String = sqlx::query_scalar(
        "select operator_id::text from agent_assignment where agent_id = $1::uuid",
    )
    .bind(&agent)
    .fetch_one(&pool)
    .await
    .unwrap();
    assert_eq!(on, op2, "assignment moved");
    let label2: Option<String> =
        sqlx::query_scalar("select label from operator where id = $1::uuid")
            .bind(&op2)
            .fetch_one(&pool)
            .await
            .unwrap();
    assert_eq!(label2, label, "label carried over");
    let (s, _) = req(&base, Method::GET, "/operators/self", Some(&tok1), "").await;
    assert_eq!(
        s,
        StatusCode::UNAUTHORIZED,
        "replaced token no longer works"
    );

    // ---- DELETE 폐기 → 4401, 토큰 무효 ----
    let mut c = connect(&base, &tok2).await;
    c.send(Message::Text(json!({ "type": "hello" }).to_string().into()))
        .await
        .unwrap();
    assert!(
        eventually(
            &pool,
            "select version is null from operator where id = $1::uuid",
            &op2
        )
        .await,
        "hello without version clears it"
    );
    let (s, _) = req(
        &base,
        Method::DELETE,
        &format!("/operators/{op2}"),
        Some(&sess),
        "",
    )
    .await;
    assert_eq!(s, StatusCode::NO_CONTENT);
    assert_eq!(
        close_code(&mut c).await,
        Some(4401),
        "revoked socket closed"
    );
    let (s, _) = req(&base, Method::GET, "/operators/self", Some(&tok2), "").await;
    assert_eq!(s, StatusCode::UNAUTHORIZED);

    // ---- 다른 프로세스(TS)가 폐기한 것 — 재검증이 4401 로 끊는다 ----
    let (_, rc) = req(
        &base,
        Method::POST,
        "/operators/register-codes",
        Some(&sess),
        "{}",
    )
    .await;
    let (_, c3) = req(
        &base,
        Method::POST,
        "/operators/claim",
        None,
        &claim(rc["code"].as_str().unwrap().to_owned(), json!({})),
    )
    .await;
    let op3 = c3["operator"]["id"].as_str().unwrap().to_owned();
    let mut d = connect(&base, c3["token"].as_str().unwrap()).await;
    d.send(Message::Text(json!({ "type": "hello" }).to_string().into()))
        .await
        .unwrap();
    sqlx::query("update operator set revoked_at = now() where id = $1::uuid")
        .bind(&op3)
        .execute(&pool)
        .await
        .unwrap();
    assert_eq!(
        close_code(&mut d).await,
        Some(4401),
        "revalidation closes a socket revoked elsewhere"
    );

    // 끊긴 소켓의 쓰기 일꾼이 남지 않는다.
    for _ in 0..50 {
        if core.live_socket_workers() == 0 {
            break;
        }
        tokio::time::sleep(Duration::from_millis(100)).await;
    }
    assert_eq!(core.live_socket_workers(), 0, "socket workers released");

    // ---- 정리 ----
    for (sql, id) in [
        (
            "delete from agent_assignment where agent_id = $1::uuid",
            &agent,
        ),
        (
            "delete from agent_config where account_id = $1::uuid",
            &agent,
        ),
        (
            "delete from operator_upgrade where operator_id in (select id from operator where owner_account_id = $1::uuid)",
            &human,
        ),
        (
            "delete from operator_gh_report where operator_id in (select id from operator where owner_account_id = $1::uuid)",
            &human,
        ),
        (
            "delete from operator where owner_account_id = $1::uuid",
            &human,
        ),
        ("delete from session where account_id = $1::uuid", &human),
        (
            "delete from account_grant where account_id = $1::uuid",
            &human,
        ),
    ] {
        sqlx::query(sql).bind(id).execute(&pool).await.unwrap();
    }
    println!("operator db test: ok");
}

/// 계정 삭제(`DELETE /accounts/me`, TS)가 오퍼레이터를 폐기하고 `operator.changed` 를 내면 — outbox 로 이 허브에 온다 —
/// 재검증 주기(여기선 1시간)를 기다리지 않고 4401 로 끊는다. 폐기 안 된 오퍼레이터의 같은 이벤트로는 끊지 않는다.
#[tokio::test]
async fn revoke_event_disconnects_without_waiting() {
    let Ok(url) = std::env::var("HARKROOM_TEST_DATABASE_URL") else {
        eprintln!("skip: HARKROOM_TEST_DATABASE_URL unset");
        return;
    };
    let pool = PgPool::connect(&url).await.unwrap();
    let tag = format!("opr{}", std::process::id());
    let human: String = sqlx::query_scalar(
        "insert into account(handle, display_name, kind, login_id) values ($1, $1, 'human', $1) returning id::text",
    )
    .bind(format!("{tag}-human"))
    .fetch_one(&pool)
    .await
    .unwrap();
    let sess = format!("{tag}-sess");
    sqlx::query("insert into session(token_hash, account_id, expires_at) values ($1, $2::uuid, now() + interval '1 day')")
        .bind(hash_token(&sess))
        .bind(&human)
        .execute(&pool)
        .await
        .unwrap();
    // 바꿀 칸만 적는다 — `OpTiming` 칸이 늘어도 시험 초기화가 깨지지 않는다(쓰기 시한 등은 기본값).
    let timing = OpTiming {
        heartbeat: Duration::from_secs(3600),
        last_seen_write: Duration::from_secs(3600),
        revalidate: Duration::from_secs(3600),
        status_min: Duration::from_millis(10),
        gh_lines: Duration::from_millis(500),
        cap_touch: Duration::from_secs(3600),
        ..OpTiming::default()
    };
    let write = match std::env::var("HARKROOM_TEST_WRITE_DATABASE_URL") {
        Ok(w) => write_pool(&w).await,
        Err(_) => pool.clone(),
    };
    let core = OperatorCore::new(
        pool.clone(),
        write.clone(),
        Arc::new(harkroom_server::trust_proxy::parse(None).unwrap()),
        Hub::new(),
        OperatorHub::new(),
        timing,
    );
    let app = router(
        core.clone(),
        AuthPools {
            read: pool.clone(),
            write: Some(write.clone()),
        },
        Arc::new(harkroom_server::cors::Cors::from_env_value(None)),
    );
    let base = format!("http://{}", common::serve(app).await);

    let mut sockets = Vec::new();
    for n in 0..2 {
        let (s, rc) = req(
            &base,
            Method::POST,
            "/operators/register-codes",
            Some(&sess),
            "{}",
        )
        .await;
        assert_eq!(s, StatusCode::OK, "{rc}");
        let body = json!({ "code": rc["code"], "name": format!("{tag}-mac{n}") }).to_string();
        let (s, c) = req(&base, Method::POST, "/operators/claim", None, &body).await;
        assert_eq!(s, StatusCode::OK, "{c}");
        let id = c["operator"]["id"].as_str().unwrap().to_owned();
        let mut ws = connect(&base, c["token"].as_str().unwrap()).await;
        ws.send(Message::Text(json!({ "type": "hello" }).to_string().into()))
            .await
            .unwrap();
        for _ in 0..50 {
            if core.hub.is_online(&id) {
                break;
            }
            tokio::time::sleep(Duration::from_millis(50)).await;
        }
        assert!(core.hub.is_online(&id), "operator {n} online");
        sockets.push((id, ws));
    }
    let (kept_id, mut kept) = sockets.pop().unwrap();
    let (gone_id, mut gone) = sockets.pop().unwrap();

    // 폐기 안 된 오퍼레이터의 operator.changed — 끊지 않는다.
    core.events
        .emit(json!({ "type": "operator.changed", "operatorId": kept_id, "audience": "all" }));
    // TS 계정 삭제와 같은 순서: 커밋(폐기) 뒤 operator.changed.
    sqlx::query("update operator set revoked_at = now() where id = $1::uuid")
        .bind(&gone_id)
        .execute(&pool)
        .await
        .unwrap();
    core.events
        .emit(json!({ "type": "operator.changed", "operatorId": gone_id, "audience": "all" }));
    assert_eq!(
        close_code(&mut gone).await,
        Some(4401),
        "revoked operator closed on the event"
    );

    tokio::time::sleep(Duration::from_millis(300)).await;
    assert!(core.hub.is_online(&kept_id), "unrevoked operator stays");
    kept.close(None).await.unwrap();

    for (sql, id) in [
        (
            "delete from operator where owner_account_id = $1::uuid",
            &human,
        ),
        ("delete from session where account_id = $1::uuid", &human),
    ] {
        sqlx::query(sql).bind(id).execute(&pool).await.unwrap();
    }
}
