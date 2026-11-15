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

    // 읽기 풀 4 · 연결 기다리는 시한 3초(쓰기 풀과 같다 — 막히면 30초 매달리지 않고 500). outbox 리스너는 이 풀 밖의 전용 연결이다
    // (`core::events::spawn_outbox_listener`). 파드당 연결: 읽기 4 + 리스너 1 + 쓰기 2 = 7 — DB 역할 한도는 그보다 커야 한다.
    let pool = sqlx::postgres::PgPoolOptions::new()
        .max_connections(4)
        .acquire_timeout(std::time::Duration::from_secs(3))
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
    // C5b — 서버 루프(예약 깨움). 주인이 `rust` 일 때만 실제로 돈다(`server_loop`, 기본 `ts`).
    if write.is_some() {
        spawn_loops().await;
    }
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
    // C4b ④-a — MCP `inbox.read`. 쓰기 풀에 읽음 시각 칸 권한이 있을 때만 — 아니면 TS 에 남는다.
    let inbox_write = match (&core_mode, &state.write) {
        (harkroom_server::core::CoreMode::Rust, Some(w)) => {
            match write::missing_in(
                w,
                harkroom_server::core::mcp::writes::INBOX_READ_PRIVILEGES,
                &[],
            )
            .await
            {
                Ok(m) if m.is_empty() => Some(w.clone()),
                Ok(m) => {
                    eprintln!("front: mcp inbox.read core off — missing privileges {m:?}");
                    None
                }
                Err(e) => {
                    eprintln!(
                        "front: mcp inbox.read core off — privilege check failed ({})",
                        e.as_database_error().map_or("io", |_| "db")
                    );
                    None
                }
            }
        }
        _ => None,
    };
    // C4b ④-a(2/2) — MCP `bg.claim`. 쓰기 풀에 bg_job 고르기·집기 권한이 있을 때만 — 아니면 TS 에 남는다.
    let bg_write = match (&core_mode, &state.write) {
        (harkroom_server::core::CoreMode::Rust, Some(w)) => {
            match write::missing_in(
                w,
                harkroom_server::core::mcp::bg_claim::BG_CLAIM_PRIVILEGES,
                &[],
            )
            .await
            {
                Ok(m) if m.is_empty() => Some(w.clone()),
                Ok(m) => {
                    eprintln!("front: mcp bg.claim core off — missing privileges {m:?}");
                    None
                }
                Err(e) => {
                    eprintln!(
                        "front: mcp bg.claim core off — privilege check failed ({})",
                        e.as_database_error().map_or("io", |_| "db")
                    );
                    None
                }
            }
        }
        _ => None,
    };
    // C4b ④-a(2/2) — MCP `bg.complete`(러너 길). 쓰기 풀에 회차 닫기·메모 보관 권한이 있을 때만 — 아니면 TS 에 남는다.
    let bg_complete_write = match (&core_mode, &state.write) {
        (harkroom_server::core::CoreMode::Rust, Some(w)) => {
            match write::missing_in(
                w,
                harkroom_server::core::mcp::bg_complete::BG_COMPLETE_PRIVILEGES,
                &[],
            )
            .await
            {
                Ok(m) if m.is_empty() => Some(w.clone()),
                Ok(m) => {
                    eprintln!("front: mcp bg.complete core off — missing privileges {m:?}");
                    None
                }
                Err(e) => {
                    eprintln!(
                        "front: mcp bg.complete core off — privilege check failed ({})",
                        e.as_database_error().map_or("io", |_| "db")
                    );
                    None
                }
            }
        }
        _ => None,
    };
    let react_write = match (&core_mode, &state.write) {
        (harkroom_server::core::CoreMode::Rust, Some(w)) => {
            use harkroom_server::core::msg_react as r;
            match write::missing_in(
                w,
                r::MESSAGE_REACTION_PRIVILEGES,
                r::MESSAGE_REACTION_SEQUENCE_PRIVILEGES,
            )
            .await
            {
                Ok(m) if m.is_empty() => Some(w.clone()),
                Ok(m) => {
                    eprintln!("front: reaction core off — missing privileges {m:?}");
                    None
                }
                Err(e) => {
                    eprintln!(
                        "front: reaction core off — privilege check failed ({})",
                        e.as_database_error().map_or("io", |_| "db")
                    );
                    None
                }
            }
        }
        _ => None,
    };
    // C3b-1 — 선택 카드 답하기·닫기. 두 겹 잠금: `HARKROOM_CORE=rust` 그리고 쓰기 풀에 `ASK_PRIVILEGES` 가 다 있을 때만.
    let ask_write = match (&core_mode, &state.write) {
        (harkroom_server::core::CoreMode::Rust, Some(w)) => {
            use harkroom_server::core::ask as a;
            match write::missing_in(w, a::ASK_PRIVILEGES, a::ASK_SEQUENCE_PRIVILEGES).await {
                Ok(m) if m.is_empty() => Some(w.clone()),
                Ok(m) => {
                    eprintln!("front: ask card core off — missing privileges {m:?}");
                    None
                }
                Err(e) => {
                    eprintln!(
                        "front: ask card core off — privilege check failed ({})",
                        e.as_database_error().map_or("io", |_| "db")
                    );
                    None
                }
            }
        }
        _ => None,
    };
    // C1c-1 — 글 올리기(사람 최상위 글 뼈대). 두 겹 잠금: `HARKROOM_CORE=rust` 그리고 쓰기 풀에 `MESSAGE_POST_PRIVILEGES` 가 다 있을 때만.
    let post_write = match (&core_mode, &state.write) {
        (harkroom_server::core::CoreMode::Rust, Some(w)) => {
            use harkroom_server::core::msg_post as p;
            match write::missing_in(
                w,
                p::MESSAGE_POST_PRIVILEGES,
                p::MESSAGE_POST_SEQUENCE_PRIVILEGES,
            )
            .await
            {
                Ok(m) if m.is_empty() => Some(w.clone()),
                Ok(m) => {
                    eprintln!("front: message post core off — missing privileges {m:?}");
                    None
                }
                Err(err) => {
                    eprintln!(
                        "front: message post core off — privilege check failed ({})",
                        err.as_database_error().map_or("io", |_| "db")
                    );
                    None
                }
            }
        }
        _ => None,
    };
    // C3a-3c — 글 고치기. 위 블록들과 같이 쓰기 역할에 그 권한이 **하나라도 없으면** 붙이지 않는다(그 경로는 TS 가 받는다).
    let edit_write = match (&core_mode, &state.write) {
        (harkroom_server::core::CoreMode::Rust, Some(w)) => {
            use harkroom_server::core::msg_edit as e;
            match write::missing_in(
                w,
                e::MESSAGE_EDIT_PRIVILEGES,
                e::MESSAGE_EDIT_SEQUENCE_PRIVILEGES,
            )
            .await
            {
                Ok(m) if m.is_empty() => Some(w.clone()),
                Ok(m) => {
                    eprintln!("front: message edit core off — missing privileges {m:?}");
                    None
                }
                Err(err) => {
                    eprintln!(
                        "front: message edit core off — privilege check failed ({})",
                        err.as_database_error().map_or("io", |_| "db")
                    );
                    None
                }
            }
        }
        _ => None,
    };
    let delete_write = match (&core_mode, &state.write) {
        (harkroom_server::core::CoreMode::Rust, Some(w)) => {
            use harkroom_server::core::msg_delete as d;
            match write::missing_in(
                w,
                d::MESSAGE_DELETE_PRIVILEGES,
                d::MESSAGE_DELETE_SEQUENCE_PRIVILEGES,
            )
            .await
            {
                Ok(m) if m.is_empty() => Some(w.clone()),
                Ok(m) => {
                    eprintln!("front: message delete core off — missing privileges {m:?}");
                    None
                }
                Err(e) => {
                    eprintln!(
                        "front: message delete core off — privilege check failed ({})",
                        e.as_database_error().map_or("io", |_| "db")
                    );
                    None
                }
            }
        }
        _ => None,
    };
    // C6a-1 — 인박스 읽음 표시(`POST /inbox/read`). 쓰기 풀에 그 칸 권한이 있을 때만 — 아니면 TS 에 남는다.
    let inbox_read_write = match (&core_mode, &state.write) {
        (harkroom_server::core::CoreMode::Rust, Some(w)) => {
            use harkroom_server::core::inbox_read as ir;
            match write::missing_in(w, ir::INBOX_READ_PRIVILEGES, &[]).await {
                Ok(m) if m.is_empty() => Some(w.clone()),
                Ok(m) => {
                    eprintln!("front: inbox read core off — missing privileges {m:?}");
                    None
                }
                Err(e) => {
                    eprintln!(
                        "front: inbox read core off — privilege check failed ({})",
                        e.as_database_error().map_or("io", |_| "db")
                    );
                    None
                }
            }
        }
        _ => None,
    };
    // C6b-2 — 턴 임대 세 줄(`/agent/turn-leases*`). 두 겹 잠금: `HARKROOM_CORE=rust` 그리고 쓰기 풀에 `TURN_LEASE_PRIVILEGES` 가 다 있을 때만.
    let lease_write = match (&core_mode, &state.write) {
        (harkroom_server::core::CoreMode::Rust, Some(w)) => {
            use harkroom_server::core::turn_lease as l;
            match write::missing_in(w, l::TURN_LEASE_PRIVILEGES, &[]).await {
                Ok(m) if m.is_empty() => Some(w.clone()),
                Ok(m) => {
                    eprintln!("front: turn lease core off — missing privileges {m:?}");
                    None
                }
                Err(e) => {
                    eprintln!(
                        "front: turn lease core off — privilege check failed ({})",
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
        harkroom_server::core::events::spawn_outbox_listener(
            state.pool.clone(),
            db.clone(),
            hub.clone(),
        );
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
        // C3a-1 — 리액션 쓰기(`PUT`·`DELETE …/reactions/{emoji}`). 쓰기 풀에 그 권한이 다 있을 때만 — 아니면 TS 에 남는다.
        let mcp_react_write = react_write.clone();
        if let Some(write) = react_write {
            let react = harkroom_server::core::msg_react::routes(
                harkroom_server::core::msg_react::ReactState {
                    read: state.pool.clone(),
                    write,
                },
                auth.clone(),
                state.cors.clone(),
            );
            core_routes.router = core_routes.router.merge(react.router);
            core_routes.http.extend(react.http);
            core_routes.sockets.extend(react.sockets);
        }
        // C3a-2 — 지우기·「채널에도 보이기」 켜고 끄기. 쓰기 풀에 그 권한이 다 있을 때만 — 아니면 TS 에 남는다.
        if let Some(write) = delete_write {
            let del = harkroom_server::core::msg_delete::routes(
                harkroom_server::core::msg_delete::DeleteState {
                    read: state.pool.clone(),
                    write,
                    trust: state.trust.clone(),
                },
                auth.clone(),
                state.cors.clone(),
            );
            core_routes.router = core_routes.router.merge(del.router);
            core_routes.http.extend(del.http);
            core_routes.sockets.extend(del.sockets);
        }
        // C3a-3c — 글 고치기(`PATCH /channels/{id}/messages/{messageId}`). 권한이 다 있을 때만 — 아니면 TS 에 남는다.
        if let Some(write) = edit_write {
            let edit = harkroom_server::core::msg_edit::routes(
                harkroom_server::core::msg_edit::EditState {
                    read: state.pool.clone(),
                    write,
                },
                auth.clone(),
                state.cors.clone(),
            );
            core_routes.router = core_routes.router.merge(edit.router);
            core_routes.http.extend(edit.http);
            core_routes.sockets.extend(edit.sockets);
        }
        // C3b-1 — 선택 카드 답하기·닫기. 권한·머지 카드와 못 읽는 카드는 핸들러가 TS 로 넘긴다.
        let mcp_ask_write = ask_write.clone();
        if let Some(write) = ask_write {
            let ask = harkroom_server::core::ask::routes(
                harkroom_server::core::ask::AskState {
                    read: state.pool.clone(),
                    write,
                    up: state.up.clone(),
                },
                auth.clone(),
                state.cors.clone(),
            );
            core_routes.router = core_routes.router.merge(ask.router);
            core_routes.http.extend(ask.http);
            core_routes.sockets.extend(ask.sockets);
        }
        // C1c-1 — 글 올리기(`POST /channels/{id}/messages`). 맡지 않는 글은 핸들러가 읽은 바이트 그대로 TS 로 넘긴다.
        if let Some(write) = post_write {
            let post = harkroom_server::core::msg_post::routes(
                harkroom_server::core::msg_post::PostState {
                    read: state.pool.clone(),
                    write,
                    up: state.up.clone(),
                },
                auth.clone(),
                state.cors.clone(),
            );
            core_routes.router = core_routes.router.merge(post.router);
            core_routes.http.extend(post.http);
            core_routes.sockets.extend(post.sockets);
        }
        // C6a-1 — 인박스 읽음 표시. 쓰기 풀에 그 권한이 있을 때만 — 아니면 TS 에 남는다.
        if let Some(write) = inbox_read_write {
            let ir = harkroom_server::core::inbox_read::routes(
                harkroom_server::core::inbox_read::InboxReadState { write },
                auth.clone(),
                state.cors.clone(),
            );
            core_routes.router = core_routes.router.merge(ir.router);
            core_routes.http.extend(ir.http);
            core_routes.sockets.extend(ir.sockets);
        }
        // C6b-2 — 턴 임대 발급·늘리기·끝내기. 자동화 회차 글(위임장 ⑤b)은 핸들러가 TS 로 넘긴다.
        if let Some(write) = lease_write {
            let leases = harkroom_server::core::turn_lease_routes::routes(
                harkroom_server::core::turn_lease_routes::LeaseState {
                    write,
                    up: state.up.clone(),
                    trust: state.trust.clone(),
                },
                auth.clone(),
                state.cors.clone(),
            );
            core_routes.router = core_routes.router.merge(leases.router);
            core_routes.http.extend(leases.http);
            core_routes.sockets.extend(leases.sockets);
        }
        // C4a-1 — `POST /mcp`. 에이전트 게이트·본문 한도(TS 와 같다) 뒤, Rust 가 답하는 읽기 도구(C4a-3)가 아니면 원래 바이트를 TS 로 투명 전달한다.
        let mcp = harkroom_server::core::mcp::route::routes(
            state.up.clone(),
            state.pool.clone(),
            // C4b — 도구 묶음마다 그 권한이 다 있는 쓰기 풀일 때만 Rust 가 답한다(리액션 · inbox.read ·
            // 선택 카드 → `message.askBundleResolve`).
            harkroom_server::core::mcp::writes::McpWrites {
                react: mcp_react_write,
                inbox: inbox_write,
                bg: bg_write,
                ask: mcp_ask_write,
                bg_complete: bg_complete_write,
            },
            auth.clone(),
            state.cors.clone(),
        );
        core_routes.router = core_routes.router.merge(mcp.router);
        core_routes.http.extend(mcp.http);
        core_routes.sockets.extend(mcp.sockets);
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

/// 서버 루프 전용 풀(3)을 따로 연다 — 루프 tick 은 문지기 연결 1 + sweep 연결 1 + 이벤트 연결 1 을 쓰는데 쓰기 풀은 2 이고
/// 요청과 나눠 쓴다. 이 풀이 막혀도 요청은 막히지 않는다. 권한([`loops::wake::WAKE_PRIVILEGES`])이 모자라면 띄우지 않는다(TS 에 남는다).
async fn spawn_loops() {
    use harkroom_server::loops::{
        bg, bg_produce, mandate_idle, outbox_prune, permission_expire, retention, wake,
    };
    let Some(url) = std::env::var("DATABASE_WRITE_URL")
        .ok()
        .filter(|u| !u.is_empty())
    else {
        return;
    };
    // 풀 둘 — 문지기(잠금) 연결 전용 `gate` 와 sweep 이 쓰는 `pool`. 잠금 연결을 쥔 채 같은 풀에서 sweep 연결을 빌리면 루프가 겹칠 때
    // 풀이 바닥나 sweep 이 acquire 시한에 걸린다. gate 는 루프 수만큼(한 루프는 tick 하나에 잠금 연결 하나), pool 은 sweep 몫(wake 는
    // 한 건 트랜잭션 + 커밋 뒤 이벤트 = 2).
    let open = |max: u32| {
        sqlx::postgres::PgPoolOptions::new()
            .max_connections(max)
            .acquire_timeout(std::time::Duration::from_secs(10))
            .connect(&url)
    };
    let (gate, pool) = match (
        open(LOOP_GATE_CONNECTIONS).await,
        open(LOOP_SWEEP_CONNECTIONS).await,
    ) {
        (Ok(g), Ok(p)) => (g, p),
        _ => {
            eprintln!("front: loops off — connect failed");
            return;
        }
    };
    match write::missing_in(&pool, wake::WAKE_PRIVILEGES, wake::WAKE_SEQUENCE_PRIVILEGES).await {
        Ok(m) if m.is_empty() => {
            eprintln!("front: loop wake on (runs only while server_loop owner is rust)");
            wake::spawn(gate.clone(), pool.clone());
        }
        Ok(m) => eprintln!("front: loop wake off — missing privileges {m:?}"),
        Err(e) => eprintln!("front: loop wake off — privilege check failed: {e}"),
    }
    // C5c — 보존 기간 정리.
    match write::missing_in(&pool, retention::RETENTION_PRIVILEGES, &[]).await {
        Ok(m) if m.is_empty() => {
            let del = retention::delete_enabled(
                std::env::var("HARKROOM_RETENTION_DELETE").ok().as_deref(),
            );
            eprintln!(
                "front: loop retention on (delete={del}; runs only while server_loop owner is rust)"
            );
            retention::spawn(gate.clone(), pool.clone(), del);
        }
        Ok(m) => eprintln!("front: loop retention off — missing privileges {m:?}"),
        Err(e) => eprintln!("front: loop retention off — privilege check failed: {e}"),
    }
    // C5c-2a — 위임 idle 끝.
    match write::missing_in(
        &pool,
        mandate_idle::MANDATE_IDLE_PRIVILEGES,
        mandate_idle::MANDATE_IDLE_SEQUENCE_PRIVILEGES,
    )
    .await
    {
        Ok(m) if m.is_empty() => {
            eprintln!("front: loop mandate.idle on (runs only while server_loop owner is rust)");
            mandate_idle::spawn(gate.clone(), pool.clone());
        }
        Ok(m) => eprintln!("front: loop mandate.idle off — missing privileges {m:?}"),
        Err(e) => eprintln!("front: loop mandate.idle off — privilege check failed: {e}"),
    }
    // C5c-2b — 권한 요청 만료.
    match write::missing_in(
        &pool,
        permission_expire::PERMISSION_EXPIRE_PRIVILEGES,
        permission_expire::PERMISSION_EXPIRE_SEQUENCE_PRIVILEGES,
    )
    .await
    {
        Ok(m) if m.is_empty() => {
            eprintln!(
                "front: loop permission.expire on (runs only while server_loop owner is rust)"
            );
            permission_expire::spawn(gate.clone(), pool.clone());
        }
        Ok(m) => eprintln!("front: loop permission.expire off — missing privileges {m:?}"),
        Err(e) => eprintln!("front: loop permission.expire off — privilege check failed: {e}"),
    }
    // C5c-4 — event_outbox 정리(한 시간 지난 줄). 문지기 이름 `outbox.prune`.
    match write::missing_in(&pool, outbox_prune::OUTBOX_PRUNE_PRIVILEGES, &[]).await {
        Ok(m) if m.is_empty() => {
            eprintln!("front: loop outbox.prune on (runs only while server_loop owner is rust)");
            outbox_prune::spawn(gate.clone(), pool.clone());
        }
        Ok(m) => eprintln!("front: loop outbox.prune off — missing privileges {m:?}"),
        Err(e) => eprintln!("front: loop outbox.prune off — privilege check failed: {e}"),
    }
    // C5c-3a — 백그라운드 회차 닫기. 스위치는 TS 와 같은 env.
    let bg_on =
        bg::background_enabled(std::env::var("HARKROOM_BACKGROUND_ENABLED").ok().as_deref());
    match write::missing_in(&pool, bg::BG_PRIVILEGES, &[]).await {
        Ok(m) if m.is_empty() => {
            eprintln!(
                "front: loop bg on (enabled={bg_on}; runs only while server_loop owner is rust)"
            );
            bg::spawn(gate.clone(), pool.clone(), bg_on);
        }
        Ok(m) => eprintln!("front: loop bg off — missing privileges {m:?}"),
        Err(e) => eprintln!("front: loop bg off — privilege check failed: {e}"),
    }
    // C5c-3b-2 — 백그라운드 회차 생산(distill → cleanup → organize, 1시간에 한 번). 문지기 이름 `bg.produce` — 주인이 rust 일 때만 돈다.
    match write::missing_in(&pool, bg_produce::BG_PRODUCE_PRIVILEGES, &[]).await {
        Ok(m) if m.is_empty() => {
            let max = bg_produce::daily_max(
                std::env::var("HARKROOM_BACKGROUND_DAILY_MAX")
                    .ok()
                    .as_deref(),
            );
            eprintln!(
                "front: loop bg.produce on (enabled={bg_on}; runs only while server_loop owner is rust)"
            );
            bg_produce::spawn(gate, pool, bg_on, max);
        }
        Ok(m) => eprintln!("front: loop bg.produce off — missing privileges {m:?}"),
        Err(e) => eprintln!("front: loop bg.produce off — privilege check failed: {e}"),
    }
}

/// Rust 로 옮긴 루프 수(wake·retention·mandate.idle·permission.expire·outbox.prune·bg·bg.produce) — 문지기 풀 크기. 루프를 더하면 같이 올린다.
const LOOP_GATE_CONNECTIONS: u32 = 7;
/// sweep 풀 크기.
const LOOP_SWEEP_CONNECTIONS: u32 = 3;

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
