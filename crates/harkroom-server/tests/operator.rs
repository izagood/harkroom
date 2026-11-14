//! 오퍼레이터 코어(C2a)를 실제 Postgres 로 — 가짜 오퍼레이터가 `/operator` 에 붙고 `/operators*` REST 를 부른다.
//! `HARKROOM_TEST_DATABASE_URL` 이 없으면 건너뛴다(CI 는 `bus-e2e` 잡이 `packages/server/test/rustFrontDb.test.ts` 로 DB 를 넘긴다).
//! 그 DB 에는 TS 서버의 마이그레이션이 전부 적용돼 있어야 한다. 시험이 넣은 행은 끝에 지운다 — 계정만은 남는다(`audit_log` 가
//! append-only 라 감사 줄이 가리키는 계정을 지울 수 없다. 시험마다 복제한 DB 라 버려진다).
//!
//! - 등록 코드 → claim → 토큰. 같은 코드 두 번은 401. 이름이 틀리면 400.
//! - 같은 오퍼레이터의 두 번째 소켓은 앞 소켓을 4409 로 밀어낸다(TS operatorHub 와 같음).
//! - hello 의 version 이 `operator.version` 에, 프레임을 받으면 `last_seen_at` 이 적힌다.
//! - claim `replaces` 는 옛 행을 폐기하고 배정을 옮기며, 옛 소켓은 4401 로 끊긴다.
//! - PATCH 로 이름(label)을 바꾸고, DELETE 로 폐기하면 소켓이 4401 로 끊기고 그 토큰은 더 쓰이지 않는다.
//! - DB 에서 직접 폐기한 것(TS 쪽이 폐기한 경우)도 재검증 주기 안에 4401 로 끊긴다.
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

    let timing = OpTiming {
        heartbeat: Duration::from_secs(3600),
        last_seen_write: Duration::from_secs(3600),
        revalidate: Duration::from_millis(300),
        send_timeout: Duration::from_secs(5),
        status_min: Duration::from_millis(10),
    };
    // 쓰기 풀 — 있으면 `OPERATOR_PRIVILEGES` 만 가진 역할(rustFrontDb.test.ts 가 만든다). 표가 모자라면 아래 쓰기가 실패한다.
    let write = match std::env::var("HARKROOM_TEST_WRITE_DATABASE_URL") {
        Ok(w) => {
            let w = PgPool::connect(&w).await.unwrap();
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
    );
    let base = format!("http://{}", common::serve(app).await);

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
    let (s, me) = req(&base, Method::GET, "/operators/self", Some(&tok1), "").await;
    assert_eq!(s, StatusCode::OK, "{me}");
    assert_eq!(me["id"].as_str(), Some(op1.as_str()), "{me}");

    let mut b = connect(&base, &tok1).await;
    assert_eq!(
        close_code(&mut a).await,
        Some(4409),
        "older socket replaced"
    );

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
    ] {
        sqlx::query(sql).bind(id).execute(&pool).await.unwrap();
    }
    println!("operator db test: ok");
}
