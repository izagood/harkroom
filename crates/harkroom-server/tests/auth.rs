//! 인증 판정이 TS `auth/plugin.ts` 와 같은지 실제 Postgres 로 본다. `HARKROOM_TEST_DATABASE_URL` 이 없으면 건너뛴다(CI 에는 DB 가 없다).
//! 그 DB 에는 TS 서버의 마이그레이션이 전부 적용돼 있어야 한다. 시험이 넣은 행은 끝에 지운다.
use axum::body::{Body, to_bytes};
use axum::http::{Request, StatusCode};
use axum::routing::get;
use harkroom_server::auth::{
    self, Auth, RequireAccount, RequireAdmin, RequireOperator, Resolved, Via, hash_token,
};
use sqlx::PgPool;
use std::net::SocketAddr;

struct Seed {
    human: String,
    agent: String,
    other_agent: String,
    operator: String,
    tag: String,
}

async fn seed(pool: &PgPool) -> Seed {
    let tag = format!("t{}", std::process::id());
    let mk = |handle: String, kind: &'static str| {
        let pool = pool.clone();
        async move {
            sqlx::query_scalar::<_, String>(
                "insert into account(handle, display_name, kind, login_id) values ($1, $1, $2, case when $2 = 'human' then $1 end) returning id::text",
            )
            .bind(handle)
            .bind(kind)
            .fetch_one(&pool)
            .await
            .unwrap()
        }
    };
    let human = mk(format!("{tag}-human"), "human").await;
    let agent = mk(format!("{tag}-agent"), "agent").await;
    let other_agent = mk(format!("{tag}-agent2"), "agent").await;
    let tok = |s: &str| hash_token(&format!("{tag}-{s}"));

    // 세션: 살아 있는 것 · 만료된 것 · 곧 만료(늘려야 하는 것).
    for (name, expires) in [
        ("sess", "10 days"),
        ("sess-old", "-1 minute"),
        ("sess-soon", "1 day"),
    ] {
        sqlx::query(
            "insert into session(token_hash, account_id, expires_at) values ($1, $2::uuid, now() + $3::interval)",
        )
        .bind(tok(name))
        .bind(&human)
        .bind(expires)
        .execute(pool)
        .await
        .unwrap();
    }
    // PAT: 에이전트 것 · 폐기된 것 · 사람 것(옛 발급 — 서면 안 된다).
    for (name, acct, revoked) in [
        ("pat", &agent, false),
        ("pat-revoked", &agent, true),
        ("pat-human", &human, false),
    ] {
        sqlx::query(
            "insert into pat(token_hash, account_id, label, revoked_at) values ($1, $2::uuid, 'x', case when $3 then now() end)",
        )
        .bind(tok(name))
        .bind(acct)
        .bind(revoked)
        .execute(pool)
        .await
        .unwrap();
    }
    let operator: String = sqlx::query_scalar(
        "insert into operator(owner_account_id, name, token_hash) values ($1::uuid, 'op', $2) returning id::text",
    )
    .bind(&human)
    .bind(hash_token(&format!("hkop_{tag}")))
    .fetch_one(pool)
    .await
    .unwrap();
    sqlx::query("insert into agent_assignment(agent_id, operator_id, assigned_by) values ($1::uuid, $2::uuid, $3::uuid)")
        .bind(&agent)
        .bind(&operator)
        .bind(&human)
        .execute(pool)
        .await
        .unwrap();
    Seed {
        human,
        agent,
        other_agent,
        operator,
        tag,
    }
}

async fn cleanup(pool: &PgPool, s: &Seed) {
    let ids = [&s.human, &s.agent, &s.other_agent];
    sqlx::query("delete from agent_assignment where operator_id = $1::uuid")
        .bind(&s.operator)
        .execute(pool)
        .await
        .unwrap();
    sqlx::query("delete from operator where id = $1::uuid")
        .bind(&s.operator)
        .execute(pool)
        .await
        .unwrap();
    for sql in [
        "delete from session where account_id = $1::uuid",
        "delete from pat where account_id = $1::uuid",
    ] {
        for id in ids {
            sqlx::query(sql).bind(id).execute(pool).await.unwrap();
        }
    }
    for id in ids {
        sqlx::query("delete from account where id = $1::uuid")
            .bind(id)
            .execute(pool)
            .await
            .unwrap();
    }
}

fn headers(pairs: &[(&str, &str)]) -> axum::http::HeaderMap {
    let mut h = axum::http::HeaderMap::new();
    for (k, v) in pairs {
        h.append(
            axum::http::HeaderName::from_bytes(k.as_bytes()).unwrap(),
            v.parse().unwrap(),
        );
    }
    h
}

async fn who(pool: &PgPool, pairs: &[(&str, &str)]) -> Resolved {
    auth::resolve(pool, &headers(pairs)).await.unwrap()
}

fn ok(r: Resolved) -> Auth {
    match r {
        Resolved::Ok(a) => *a,
        Resolved::NotAssigned => panic!("not_assigned"),
    }
}

async fn serve(app: axum::Router) -> SocketAddr {
    let l = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let a = l.local_addr().unwrap();
    tokio::spawn(async move { axum::serve(l, app).await.unwrap() });
    a
}

async fn call(addr: SocketAddr, path: &str, pairs: &[(&str, &str)]) -> (StatusCode, String) {
    let client = hyper_util::client::legacy::Client::builder(hyper_util::rt::TokioExecutor::new())
        .build_http::<Body>();
    let mut req = Request::get(format!("http://{addr}{path}"));
    for (k, v) in pairs {
        req = req.header(*k, *v);
    }
    let res = client
        .request(req.body(Body::empty()).unwrap())
        .await
        .unwrap();
    let status = res.status();
    let body = to_bytes(Body::new(res.into_body()), 1 << 16).await.unwrap();
    (status, String::from_utf8_lossy(&body).into_owned())
}

#[tokio::test]
async fn auth_matches_ts_plugin() {
    let Ok(url) = std::env::var("HARKROOM_TEST_DATABASE_URL") else {
        eprintln!("skip: HARKROOM_TEST_DATABASE_URL unset");
        return;
    };
    let pool = PgPool::connect(&url).await.unwrap();
    let s = seed(&pool).await;
    let t = s.tag.clone();
    let bearer = |name: &str| format!("Bearer {t}-{name}");
    let op_bearer = format!("Bearer hkop_{t}");

    // 익명: 헤더 없음 · Bearer 아님 · 모르는 토큰.
    assert_eq!(ok(who(&pool, &[]).await), Auth::default());
    assert_eq!(
        ok(who(&pool, &[("authorization", "Basic x")]).await),
        Auth::default()
    );
    assert_eq!(
        ok(who(&pool, &[("authorization", "Bearer nope")]).await),
        Auth::default()
    );

    // 세션.
    let a = ok(who(&pool, &[("authorization", &bearer("sess"))]).await);
    assert_eq!(a.via, Some(Via::Session));
    assert_eq!(a.account.as_ref().unwrap().id, s.human);
    assert_eq!(
        a.credential_hash.as_deref(),
        Some(hash_token(&format!("{t}-sess")).as_str())
    );
    // 사람 세션에 붙은 에이전트 헤더는 읽지 않는다.
    let a = ok(who(
        &pool,
        &[
            ("authorization", &bearer("sess")),
            ("x-harkroom-agent", &s.agent),
        ],
    )
    .await);
    assert_eq!(a.account.unwrap().id, s.human);
    // 만료된 세션은 익명.
    assert_eq!(
        ok(who(&pool, &[("authorization", &bearer("sess-old"))]).await),
        Auth::default()
    );
    // 곧 만료되는 세션은 쓰면 14일로 늘어난다.
    ok(who(&pool, &[("authorization", &bearer("sess-soon"))]).await);
    let days: f64 = sqlx::query_scalar(
        "select extract(epoch from expires_at - now())::float8 / 86400 from session where token_hash = $1",
    )
    .bind(hash_token(&format!("{t}-sess-soon")))
    .fetch_one(&pool)
    .await
    .unwrap();
    assert!(days > 13.9, "renewed to {days} days");

    // PAT: 에이전트만, 폐기된 것·사람 것은 익명. 마지막 사용 시각이 적힌다.
    let a = ok(who(&pool, &[("authorization", &bearer("pat"))]).await);
    assert_eq!(a.via, Some(Via::Pat));
    assert_eq!(a.account.unwrap().id, s.agent);
    let used: bool =
        sqlx::query_scalar("select last_used_at is not null from pat where token_hash = $1")
            .bind(hash_token(&format!("{t}-pat")))
            .fetch_one(&pool)
            .await
            .unwrap();
    assert!(used);
    assert_eq!(
        ok(who(&pool, &[("authorization", &bearer("pat-revoked"))]).await),
        Auth::default()
    );
    assert_eq!(
        ok(who(&pool, &[("authorization", &bearer("pat-human"))]).await),
        Auth::default()
    );

    // 오퍼레이터: 헤더 없으면 오퍼레이터로만, 배정된 에이전트면 그 에이전트로, 아니면 403.
    let a = ok(who(&pool, &[("authorization", &op_bearer)]).await);
    assert_eq!((a.via, a.account.is_none()), (Some(Via::Operator), true));
    assert_eq!(a.operator.unwrap().id, s.operator);
    let a = ok(who(
        &pool,
        &[
            ("authorization", &op_bearer),
            ("x-harkroom-agent", &s.agent),
        ],
    )
    .await);
    assert_eq!(a.via, Some(Via::Operator));
    assert_eq!(a.account.unwrap().id, s.agent);
    assert_eq!(
        who(
            &pool,
            &[
                ("authorization", &op_bearer),
                ("x-harkroom-agent", &s.other_agent)
            ]
        )
        .await,
        Resolved::NotAssigned
    );
    assert_eq!(
        who(
            &pool,
            &[
                ("authorization", &op_bearer),
                ("x-harkroom-agent", "not-a-uuid")
            ]
        )
        .await,
        Resolved::NotAssigned
    );
    assert_eq!(
        who(
            &pool,
            &[
                ("authorization", &op_bearer),
                ("x-harkroom-agent", &s.agent),
                ("x-harkroom-agent", &s.agent)
            ]
        )
        .await,
        Resolved::NotAssigned
    );
    // 오퍼레이터 표에 없는 hkop_ 토큰은 세션·PAT 표로 넘어가지 않고 익명.
    assert_eq!(
        ok(who(&pool, &[("authorization", "Bearer hkop_nope")]).await),
        Auth::default()
    );

    // 미들웨어 + 추출기: 상태 코드와 오류 꼴.
    let app = axum::Router::new()
        .route(
            "/me",
            get(|RequireAccount(a, _): RequireAccount| async move { a.handle }),
        )
        .route(
            "/admin",
            get(|RequireAdmin(a): RequireAdmin| async move { a.handle }),
        )
        .route(
            "/op",
            get(|RequireOperator(o, _): RequireOperator| async move { o.name }),
        )
        .layer(axum::middleware::from_fn_with_state(
            pool.clone(),
            auth::layer,
        ));
    let addr = serve(app).await;
    let (st, body) = call(addr, "/me", &[]).await;
    assert_eq!(st, StatusCode::UNAUTHORIZED);
    assert!(body.contains(r#""code":"unauthorized""#));
    assert_eq!(
        call(addr, "/me", &[("authorization", &bearer("sess"))]).await,
        (StatusCode::OK, format!("{t}-human"))
    );
    assert_eq!(
        call(addr, "/admin", &[("authorization", &bearer("sess"))])
            .await
            .0,
        StatusCode::FORBIDDEN
    );
    assert_eq!(call(addr, "/admin", &[]).await.0, StatusCode::FORBIDDEN);
    assert_eq!(
        call(addr, "/op", &[("authorization", &bearer("pat"))])
            .await
            .0,
        StatusCode::UNAUTHORIZED
    );
    assert_eq!(
        call(addr, "/op", &[("authorization", &op_bearer)]).await,
        (StatusCode::OK, "op".into())
    );
    let (st, body) = call(
        addr,
        "/me",
        &[
            ("authorization", &op_bearer),
            ("x-harkroom-agent", &s.other_agent),
        ],
    )
    .await;
    assert_eq!(st, StatusCode::FORBIDDEN);
    assert!(body.contains(r#""code":"not_assigned""#));
    assert_eq!(
        call(
            addr,
            "/me",
            &[
                ("authorization", &op_bearer),
                ("x-harkroom-agent", &s.agent)
            ]
        )
        .await,
        (StatusCode::OK, format!("{t}-agent"))
    );

    cleanup(&pool, &s).await;
}
