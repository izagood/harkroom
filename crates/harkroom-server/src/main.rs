//! `harkroom-server-rs` — env: `UPSTREAM_URL`(TS 서버, 예 `http://harkroom:3400`) · `DATABASE_URL` · `PORT`(기본 3500) ·
//! `HARKROOM_FRONT_TS_ROUTES`(옮긴 줄을 TS 로 되돌림 — `"GET /accounts,GET /dms"` 또는 `*`, `routes.rs` 참고) ·
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
    let state = routes::AppState {
        up: proxy::Upstream::new(&upstream),
        pool,
        write,
    };
    let mut active = routes::active(routes::MOVED, &ts);
    active.extend(routes::active(routes::writes_for(&state), &ts));
    eprintln!("front: rust routes {active:?}");
    let app = routes::router(state, routes::MOVED, &ts);
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
