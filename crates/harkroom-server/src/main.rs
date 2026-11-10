//! `harkroom-server-rs` — env: `UPSTREAM_URL`(TS 서버, 예 `http://harkroom:3400`) · `DATABASE_URL` · `PORT`(기본 3500).
use harkroom_server::{proxy, schema};
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
    drop(pool);

    let app = proxy::router(proxy::Upstream::new(&upstream));
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
