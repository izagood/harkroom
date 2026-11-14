//! `harkroom-server-rs` — env: `UPSTREAM_URL`(TS 서버, 예 `http://harkroom:3400`) · `DATABASE_URL` · `PORT`(기본 3500) ·
//! `CORS_ORIGINS`(TS 와 같은 허용 출처, 비면 요청 출처를 돌려줌 — `cors.rs`) · `HARKROOM_CORE`(`ts` 기본 · `rust` 면 `/ws`·`/ws-ticket` 을 답함, S5.3 C0) · `TRUST_PROXY`(감사 `ip` 규칙, TS 와 같은 꼴 — `trust_proxy.rs`) · `HARKROOM_FRONT_TS_ROUTES`(옮긴 줄을 TS 로 되돌림 — `"GET /accounts,GET /dms"` 또는 `*`, `routes.rs` 참고) ·
//! `DATABASE_WRITE_URL`(쓰기 역할, P3 — 없거나 권한이 모자라면 쓰는 줄을 켜지 않고 그 요청은 TS 로 간다, `write.rs` 참고).
use harkroom_server::{proxy, routes, schema, write};
use std::net::SocketAddr;

#[tokio::main]
async fn main() {
    let upstream = std::env::var("UPSTREAM_URL").expect("UPSTREAM_URL is required");
    let db = std::env::var("DATABASE_URL").expect("DATABASE_URL is required");
    let port: u16 = std::env::var("PORT")
        .ok()
        .and_then(|p| p.parse().ok())
        .unwrap_or(3500);

    let pool = sqlx::postgres::PgPoolOptions::new()
        .max_connections(2)
        .connect(&db)
        .await
        .expect("database");
    let applied = schema::applied_migrations(&pool)
        .await
        .expect("schema_migrations");
    let check = schema::compare(schema::KNOWN_MIGRATIONS, &applied);
    if !check.unknown.is_empty() {
        eprintln!(
            "front: DB has {} migration(s) this binary does not know (TS server is newer)",
            check.unknown.len()
        );
    }
    if !check.missing.is_empty() {
        eprintln!(
            "front: refusing to start — {} migration(s) not applied yet: {:?}",
            check.missing.len(),
            check.missing
        );
        std::process::exit(1);
    }
    let write = open_write_pool().await;
    let ts = routes::TsOverrides::parse(std::env::var("HARKROOM_FRONT_TS_ROUTES").ok().as_deref());
    let known: Vec<routes::Moved> = routes::MOVED
        .iter()
        .chain(routes::MOVED_WRITE)
        .cloned()
        .collect();
    let unknown = ts.unknown(&known);
    if !unknown.is_empty() {
        eprintln!("front: HARKROOM_FRONT_TS_ROUTES names unknown route(s): {unknown:?}");
    }
    // 감사 `ip` 규칙 — TS `TRUST_PROXY` 와 같은 꼴. 모르는 값이면 기동하지 않는다(TS 와 같다).
    let trust =
        match harkroom_server::trust_proxy::parse(std::env::var("TRUST_PROXY").ok().as_deref()) {
            Ok(t) => t,
            Err(e) => {
                eprintln!("front: refusing to start — {e}");
                std::process::exit(1);
            }
        };
    eprintln!(
        "front: trust proxy {}",
        match &trust {
            harkroom_server::trust_proxy::TrustProxy::None => "off".to_string(),
            harkroom_server::trust_proxy::TrustProxy::All => "all (not recommended)".to_string(),
            harkroom_server::trust_proxy::TrustProxy::Hops(n) => format!("{n} hops"),
            harkroom_server::trust_proxy::TrustProxy::Cidrs(c) => format!("{} cidr(s)", c.len()),
        }
    );
    let state = routes::AppState {
        up: proxy::Upstream::new(&upstream),
        pool,
        write,
        trust: std::sync::Arc::new(trust),
        cors: std::sync::Arc::new(harkroom_server::cors::Cors::from_env_value(
            std::env::var("CORS_ORIGINS").ok().as_deref(),
        )),
    };
    let mut active = routes::active(routes::MOVED, &ts);
    active.extend(routes::active(routes::writes_for(&state), &ts));
    eprintln!("front: rust routes {active:?}");
    // S5.3 코어(C0) — `HARKROOM_CORE=rust` 일 때만 `/ws`·`/ws-ticket` 을 앞단이 답한다. 기본 `ts` 는 지금과 같다.
    let core_mode =
        match harkroom_server::core::parse_mode(std::env::var("HARKROOM_CORE").ok().as_deref()) {
            Ok(m) => m,
            Err(e) => {
                eprintln!("front: refusing to start — {e}");
                std::process::exit(1);
            }
        };
    // C2a — 오퍼레이터 코어는 쓰기 풀에 오퍼레이터 권한이 다 있을 때만 선다. 아니면 `/operator`·`/operators*` 는 TS 에 남는다
    // (소켓과 REST 는 한 허브를 나눠야 하므로 함께 옮기거나 함께 남긴다).
    let operator_write = match (&core_mode, &state.write) {
        (harkroom_server::core::CoreMode::Rust, Some(w)) => {
            match write::missing_operator_privileges(w).await {
                Ok(m) if m.is_empty() => Some(w.clone()),
                Ok(m) => {
                    eprintln!("front: operator core off — missing privileges {m:?}");
                    None
                }
                Err(e) => {
                    eprintln!(
                        "front: operator core off — privilege check failed ({})",
                        e.as_database_error().map_or("io", |_| "db")
                    );
                    None
                }
            }
        }
        _ => None,
    };
    let operator_on = operator_write.is_some();
    let core_router = (core_mode == harkroom_server::core::CoreMode::Rust).then(|| {
        let hub = harkroom_server::core::events::Hub::new();
        harkroom_server::core::events::spawn_outbox_listener(state.pool.clone(), hub.clone());
        let core = harkroom_server::core::ws::Core::new(
            state.pool.clone(),
            hub,
            harkroom_server::core::ws::parse_origins(std::env::var("CORS_ORIGINS").ok().as_deref()),
            harkroom_server::core::ws::Timing::from_env(),
        );
        let auth = harkroom_server::auth::AuthPools {
            read: state.pool.clone(),
            write: state.write.clone(),
        };
        let mut core_routes =
            harkroom_server::core::ws::routes(core.clone(), auth.clone(), state.cors.clone());
        // C1b-1a — 메시지 읽기(`GET /messages/{id}`). 읽기 풀만 쓴다.
        let reads = harkroom_server::core::msg_read::routes(
            state.pool.clone(),
            auth.clone(),
            state.cors.clone(),
        );
        core_routes.router = core_routes.router.merge(reads.router);
        core_routes.http.extend(reads.http);
        core_routes.sockets.extend(reads.sockets);
        // C1e-1 — 채널 읽기(GET 9줄). 읽기 풀만 쓴다.
        let channels = harkroom_server::core::channels::routes(
            state.pool.clone(),
            auth.clone(),
            state.cors.clone(),
        );
        core_routes.router = core_routes.router.merge(channels.router);
        core_routes.http.extend(channels.http);
        core_routes.sockets.extend(channels.sockets);
        // C1b-1b — 채널·스레드 목록(`GET /channels/{id}/messages`). 같은 경로의 `POST` 는 fallback 으로 TS.
        let lists = harkroom_server::core::msg_list::routes(
            state.pool.clone(),
            auth.clone(),
            state.cors.clone(),
        );
        core_routes.router = core_routes.router.merge(lists.router);
        core_routes.http.extend(lists.http);
        core_routes.sockets.extend(lists.sockets);
        if let Some(write) = operator_write {
            // C2a — 오퍼레이터 소켓·REST. 허브는 프로세스에 하나이고 C2b~C5 의 소비자가 같은 것을 받는다.
            let operators = harkroom_server::core::operator::OperatorCore::new(
                state.pool.clone(),
                write,
                state.trust.clone(),
                core.hub.clone(),
                harkroom_server::core::operator_hub::OperatorHub::new(),
                harkroom_server::core::operator::OpTiming::from_env(),
            );
            let op = harkroom_server::core::operator::routes(operators, auth, state.cors.clone());
            core_routes.router = core_routes.router.merge(op.router);
            core_routes.http.extend(op.http);
            core_routes.sockets.extend(op.sockets);
        }
        // CI 대조 시험이 이 줄을 읽어 여기 적힌 **모든** HTTP 줄의 CORS(본 요청·프리플라이트)를 TS 와 맞춰 본다(`route_table.rs`).
        eprintln!(
            "front: rust core routes {:?} sockets {:?}",
            core_routes.http, core_routes.sockets
        );
        // 코어 줄과 같은 경로의 다른 메서드(예: 코어 `GET /channels/{id}/messages` 옆 TS `POST`)는 TS 로 — 405 가 나지 않게.
        harkroom_server::route_table::ts_fallback(core_routes.router, state.up.clone())
    });
    eprintln!(
        "front: core {}",
        if core_router.is_some() && operator_on {
            "rust (/ws, /ws-ticket, /operator, /operators*)"
        } else if core_router.is_some() {
            "rust (/ws, /ws-ticket; operator stays ts)"
        } else {
            "ts"
        }
    );
    let app = routes::router(state, routes::MOVED, &ts);
    let app = match core_router {
        Some(c) => c.merge(app),
        None => app,
    };
    let listener = tokio::net::TcpListener::bind(SocketAddr::from(([0, 0, 0, 0], port)))
        .await
        .expect("bind");
    eprintln!("front: listening on :{port}, upstream {upstream}");
    axum::serve(
        listener,
        app.into_make_service_with_connect_info::<SocketAddr>(),
    )
    .with_graceful_shutdown(shutdown())
    .await
    .expect("serve");
}

/// `DATABASE_WRITE_URL` 이 있으면 쓰기 풀(2)을 연다. 연결이 안 되거나 [`write::REQUIRED_PRIVILEGES`] 중 빠진 것이 있으면
/// 쓰는 줄을 켜지 않는다(`None`) — 반쯤 되는 쓰기보다 TS 로 넘기는 편이 안전하다. 읽는 줄은 그대로 뜬다.
async fn open_write_pool() -> Option<sqlx::PgPool> {
    let url = std::env::var("DATABASE_WRITE_URL")
        .ok()
        .filter(|u| !u.is_empty())?;
    let pool = match sqlx::postgres::PgPoolOptions::new()
        .max_connections(2)
        // 연결을 기다리는 시한(sqlx 기본 30초) — 쓰기 풀이 막히면 쓰는 요청이 30초 매달리는 대신 3초 뒤 500 으로 끝난다.
        // 인증 기록은 이 풀을 기다리지 않는다(`auth::record` 가 응답 뒤로 돌린다). P4a, security 가용성 권고.
        .acquire_timeout(std::time::Duration::from_secs(3))
        .connect(&url)
        .await
    {
        Ok(p) => p,
        Err(e) => {
            eprintln!(
                "front: write pool off — connect failed ({})",
                e.as_database_error().map_or("io", |_| "db")
            );
            return None;
        }
    };
    match write::missing_privileges(&pool).await {
        Ok(m) if m.is_empty() => {
            eprintln!("front: write pool on");
            Some(pool)
        }
        Ok(m) => {
            eprintln!("front: write pool off — missing privileges {m:?}");
            None
        }
        Err(e) => {
            eprintln!(
                "front: write pool off — privilege check failed ({})",
                e.as_database_error().map_or("io", |_| "db")
            );
            None
        }
    }
}

/// Ctrl-C 또는 SIGTERM 에서 멈춘다. 컨테이너에서 이 바이너리는 PID 1 이라 처리기가 없는 SIGTERM 은 무시되고,
/// k8s·`docker stop` 은 유예 시간을 다 기다린 뒤 SIGKILL 로 끊는다(롤링 배포마다 그만큼 늦어진다).
async fn shutdown() {
    let mut term = tokio::signal::unix::signal(tokio::signal::unix::SignalKind::terminate())
        .expect("SIGTERM handler");
    tokio::select! {
        _ = tokio::signal::ctrl_c() => {}
        _ = term.recv() => {}
    }
}
