//! `harkroom-server-rs` — env: `UPSTREAM_URL`(TS 서버, 예 `http://harkroom:3400`) · `DATABASE_URL` · `PORT`(기본 3500) ·
//! `CORS_ORIGINS`(TS 와 같은 허용 출처, 비면 요청 출처를 돌려줌 — `cors.rs`) · `HARKROOM_CORE`(`ts` 기본 · `rust` 면 `/ws`·`/ws-ticket` 을 답함, S5.3 C0) · `TRUST_PROXY`(감사 `ip` 규칙, TS 와 같은 꼴 — `trust_proxy.rs`) · `HARKROOM_FRONT_TS_ROUTES`(옮긴 줄을 TS 로 되돌림 — `"GET /accounts,GET /dms"` 또는 `*`, `routes.rs` 참고) ·
//! `DATABASE_WRITE_URL`(쓰기 역할, P3 — 없거나 권한이 모자라면 쓰는 줄을 켜지 않고 그 요청은 TS 로 간다, `write.rs` 참고) ·
//! `HARKROOM_RUST_MIGRATE`(`1` 이면 기동 때 마이그레이션을 Rust 가 돌림, `only` 면 돌리고 서버로 뜨지 않고 끝남(성공 0·실패 1,
//! 마이그레이션 Job 용 — 이때 `DATABASE_URL`·`UPSTREAM_URL` 은 없어도 된다), **기본 꺼짐** — S5.4 M1, `migrate.rs`) ·
//! `DATABASE_MIGRATE_URL`(그때 쓰는 DDL 역할 — 스위치를 켰는데 없으면 기동하지 않는다).
use harkroom_server::{migrate, proxy, routes, schema, write};
use std::net::SocketAddr;

#[tokio::main]
async fn main() {
    // S5.4 M1 — 켰을 때만 스키마 대조보다 먼저 마이그레이션을 돌린다. TS 실행기와 같은 잠금 키라 동시에 떠도 한쪽씩 돈다.
    // `only` 면 여기서 끝난다 — 그래서 서버 env(`UPSTREAM_URL`·`DATABASE_URL`)는 이 뒤에서 읽는다.
    let migrate_only = migrate::only(std::env::var("HARKROOM_RUST_MIGRATE").ok().as_deref());
    match migrate::config(|n| std::env::var(n).ok()) {
        Ok(None) => {}
        Ok(Some(url)) => match migrate::run_when_reachable(&url, migrate::REACHABLE_DEADLINE).await
        {
            Ok(applied) => {
                eprintln!("front: migrations applied: {}", applied.len());
                if migrate_only {
                    eprintln!("front: HARKROOM_RUST_MIGRATE=only — exiting without serving");
                    std::process::exit(0);
                }
            }
            Err(e) => {
                eprintln!("front: refusing to start — {e}");
                std::process::exit(1);
            }
        },
        Err(e) => {
            eprintln!("front: refusing to start — {e}");
            std::process::exit(1);
        }
    }

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
                    refuse_missing_grants(&m);
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
                    refuse_missing_grants(&m);
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
    // S5.4 A2a — MCP `workitem.remove`. 쓰기 풀에 work_item 지우기·outbox 권한이 다 있을 때만 — 아니면 TS 에 남는다.
    let work_item_write = match (&core_mode, &state.write) {
        (harkroom_server::core::CoreMode::Rust, Some(w)) => {
            use harkroom_server::core::mcp::workitem as wi;
            match write::missing_in(
                w,
                wi::WORK_ITEM_REMOVE_PRIVILEGES,
                wi::WORK_ITEM_REMOVE_SEQUENCES,
            )
            .await
            {
                Ok(m) if m.is_empty() => Some(w.clone()),
                Ok(m) => {
                    eprintln!("front: mcp workitem.remove core off — missing privileges {m:?}");
                    refuse_missing_grants(&m);
                    None
                }
                Err(e) => {
                    eprintln!(
                        "front: mcp workitem.remove core off — privilege check failed ({})",
                        e.as_database_error().map_or("io", |_| "db")
                    );
                    None
                }
            }
        }
        _ => None,
    };
    // S5.4 MCP 2 — MCP `pr.watch`. 쓰기 풀에 감시 넣기·판정이 읽는 칸이 다 있을 때만 — 아니면 TS 에 남는다.
    let pr_watch_write = match (&core_mode, &state.write) {
        (harkroom_server::core::CoreMode::Rust, Some(w)) => {
            match write::missing_in(
                w,
                harkroom_server::core::mcp::pr_watch::PR_WATCH_PRIVILEGES,
                &[],
            )
            .await
            {
                Ok(m) if m.is_empty() => Some(w.clone()),
                Ok(m) => {
                    eprintln!("front: mcp pr.watch core off — missing privileges {m:?}");
                    refuse_missing_grants(&m);
                    None
                }
                Err(e) => {
                    eprintln!(
                        "front: mcp pr.watch core off — privilege check failed ({})",
                        e.as_database_error().map_or("io", |_| "db")
                    );
                    None
                }
            }
        }
        _ => None,
    };
    // S5.4 MCP 4 — MCP `automation.propose`. 쓰기 풀에 제안 행 INSERT 칸·returning SELECT 칸이 다 있을 때만 — 아니면 TS 에 남는다.
    let automation_write = match (&core_mode, &state.write) {
        (harkroom_server::core::CoreMode::Rust, Some(w)) => {
            match write::missing_in(
                w,
                harkroom_server::core::mcp::automation_propose::AUTOMATION_PROPOSE_PRIVILEGES,
                &[],
            )
            .await
            {
                Ok(m) if m.is_empty() => Some(w.clone()),
                Ok(m) => {
                    eprintln!("front: mcp automation.propose core off — missing privileges {m:?}");
                    refuse_missing_grants(&m);
                    None
                }
                Err(e) => {
                    eprintln!(
                        "front: mcp automation.propose core off — privilege check failed ({})",
                        e.as_database_error().map_or("io", |_| "db")
                    );
                    None
                }
            }
        }
        _ => None,
    };
    // S5.4 MCP 5 — MCP `automation.run`. 쓰기 풀에 회차 INSERT·셈 칸과 잠금용 UPDATE 칸이 다 있을 때만 — 아니면 TS 에 남는다.
    let automation_run_write = match (&core_mode, &state.write) {
        (harkroom_server::core::CoreMode::Rust, Some(w)) => {
            match write::missing_in(
                w,
                harkroom_server::core::mcp::automation_run::AUTOMATION_RUN_PRIVILEGES,
                &[],
            )
            .await
            {
                Ok(m) if m.is_empty() => Some(w.clone()),
                Ok(m) => {
                    eprintln!("front: mcp automation.run core off — missing privileges {m:?}");
                    refuse_missing_grants(&m);
                    None
                }
                Err(e) => {
                    eprintln!(
                        "front: mcp automation.run core off — privilege check failed ({})",
                        e.as_database_error().map_or("io", |_| "db")
                    );
                    None
                }
            }
        }
        _ => None,
    };
    // S5.4 MCP 6 — MCP `grant.delegate`(거절·원인 없는 새 위임). 쓰기 풀에 `GRANT_DELEGATE_PRIVILEGES` 가 다 있을 때만 — 아니면 TS 에 남는다.
    let grant_delegate_write = match (&core_mode, &state.write) {
        (harkroom_server::core::CoreMode::Rust, Some(w)) => {
            match write::missing_in(
                w,
                harkroom_server::core::mcp::grant_delegate::GRANT_DELEGATE_PRIVILEGES,
                harkroom_server::core::mcp::grant_delegate::GRANT_DELEGATE_SEQUENCE_PRIVILEGES,
            )
            .await
            {
                Ok(m) if m.is_empty() => Some(w.clone()),
                Ok(m) => {
                    eprintln!("front: mcp grant.delegate core off — missing privileges {m:?}");
                    refuse_missing_grants(&m);
                    None
                }
                Err(e) => {
                    eprintln!(
                        "front: mcp grant.delegate core off — privilege check failed ({})",
                        e.as_database_error().map_or("io", |_| "db")
                    );
                    None
                }
            }
        }
        _ => None,
    };
    // S5.4 A2a — MCP `workitem.upsert`. 쓰기 풀에 work_item 넣기·고칠 칸·outbox 권한이 다 있을 때만 — 아니면 TS 에 남는다.
    let work_item_upsert_write = match (&core_mode, &state.write) {
        (harkroom_server::core::CoreMode::Rust, Some(w)) => {
            use harkroom_server::core::mcp::workitem as wi;
            match write::missing_in(
                w,
                wi::WORK_ITEM_UPSERT_PRIVILEGES,
                wi::WORK_ITEM_UPSERT_SEQUENCES,
            )
            .await
            {
                Ok(m) if m.is_empty() => {
                    // REST `PUT /work-items` 도 같은 권한·같은 코어를 쓴다 — 이때만 Rust 가 답한다.
                    harkroom_server::writes_misc::WORK_ITEM_UPSERT_READY
                        .store(true, std::sync::atomic::Ordering::Relaxed);
                    Some(w.clone())
                }
                Ok(m) => {
                    eprintln!("front: mcp workitem.upsert core off — missing privileges {m:?}");
                    refuse_missing_grants(&m);
                    None
                }
                Err(e) => {
                    eprintln!(
                        "front: mcp workitem.upsert core off — privilege check failed ({})",
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
                    refuse_missing_grants(&m);
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
                    refuse_missing_grants(&m);
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
    // C4b ⑥ G1 — MCP 권한 좁히기(`grant.revoke`·`permission.revoke`). 쓰기 풀에 그 권한이 다 있을 때만 — 아니면 TS 가 답한다.
    let grant_write = match (&core_mode, &state.write) {
        (harkroom_server::core::CoreMode::Rust, Some(w)) => {
            use harkroom_server::core::mcp::grant_writes as g;
            match write::missing_in(
                w,
                g::GRANT_REVOKE_PRIVILEGES,
                g::GRANT_REVOKE_SEQUENCE_PRIVILEGES,
            )
            .await
            {
                Ok(m) if m.is_empty() => Some(w.clone()),
                Ok(m) => {
                    eprintln!("front: mcp grant write core off — missing privileges {m:?}");
                    refuse_missing_grants(&m);
                    None
                }
                Err(e) => {
                    eprintln!(
                        "front: mcp grant write core off — privilege check failed ({})",
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
                    refuse_missing_grants(&m);
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
    // S5.4 CH1 — 사이드바 섹션 쓰기. 두 겹 잠금: `HARKROOM_CORE=rust` 그리고 쓰기 풀에 그 칸 권한이 다 있을 때만.
    let section_write = match (&core_mode, &state.write) {
        (harkroom_server::core::CoreMode::Rust, Some(w)) => {
            use harkroom_server::core::sections_write as s;
            match write::missing_in(w, s::SECTION_WRITE_PRIVILEGES, &[]).await {
                Ok(m) if m.is_empty() => Some(w.clone()),
                Ok(m) => {
                    eprintln!("front: section write core off — missing privileges {m:?}");
                    refuse_missing_grants(&m);
                    None
                }
                Err(e) => {
                    eprintln!(
                        "front: section write core off — privilege check failed ({})",
                        e.as_database_error().map_or("io", |_| "db")
                    );
                    None
                }
            }
        }
        _ => None,
    };
    // S5.4 CH3c — 채널 선호·옛 섹션 이름. 두 겹 잠금: `HARKROOM_CORE=rust` 그리고 쓰기 풀에 그 칸 권한이 다 있을 때만.
    let pref_write = match (&core_mode, &state.write) {
        (harkroom_server::core::CoreMode::Rust, Some(w)) => {
            use harkroom_server::core::channel_pref_write as p;
            match write::missing_in(w, p::PREF_WRITE_PRIVILEGES, &[]).await {
                Ok(m) if m.is_empty() => Some(w.clone()),
                Ok(m) => {
                    eprintln!("front: channel pref write core off — missing privileges {m:?}");
                    refuse_missing_grants(&m);
                    None
                }
                Err(e) => {
                    eprintln!(
                        "front: channel pref write core off — privilege check failed ({})",
                        e.as_database_error().map_or("io", |_| "db")
                    );
                    None
                }
            }
        }
        _ => None,
    };
    // S5.4 AC1 — 내 상태·에이전트 PAT. 두 겹 잠금: `HARKROOM_CORE=rust` 그리고 쓰기 풀에 그 칸 권한이 다 있을 때만.
    let account_self_write = match (&core_mode, &state.write) {
        (harkroom_server::core::CoreMode::Rust, Some(w)) => {
            use harkroom_server::core::account_self as a;
            match write::missing_in(
                w,
                a::ACCOUNT_SELF_PRIVILEGES,
                a::ACCOUNT_SELF_SEQUENCE_PRIVILEGES,
            )
            .await
            {
                Ok(m) if m.is_empty() => Some(w.clone()),
                Ok(m) => {
                    eprintln!("front: account self core off — missing privileges {m:?}");
                    refuse_missing_grants(&m);
                    None
                }
                Err(e) => {
                    eprintln!(
                        "front: account self core off — privilege check failed ({})",
                        e.as_database_error().map_or("io", |_| "db")
                    );
                    None
                }
            }
        }
        _ => None,
    };
    // S5.4 AC4 — handle 바꾸기(me·admin). 두 겹 잠금: `HARKROOM_CORE=rust` 그리고 쓰기 풀에 그 칸 권한이 다 있을 때만.
    let account_handle_write = match (&core_mode, &state.write) {
        (harkroom_server::core::CoreMode::Rust, Some(w)) => {
            use harkroom_server::core::account_handle as a;
            match write::missing_in(
                w,
                a::ACCOUNT_HANDLE_PRIVILEGES,
                a::ACCOUNT_HANDLE_SEQUENCE_PRIVILEGES,
            )
            .await
            {
                Ok(m) if m.is_empty() => Some(w.clone()),
                Ok(m) => {
                    eprintln!("front: account handle core off — missing privileges {m:?}");
                    refuse_missing_grants(&m);
                    None
                }
                Err(e) => {
                    eprintln!(
                        "front: account handle core off — privilege check failed ({})",
                        e.as_database_error().map_or("io", |_| "db")
                    );
                    None
                }
            }
        }
        _ => None,
    };
    // S5.4 AT2 — 자동화 수신 끄기(`DELETE /automations/{id}/ingress`). 두 겹 잠금: `HARKROOM_CORE=rust` 그리고 쓰기 풀에 그 칸 권한이 다 있을 때만.
    let automations_write = match (&core_mode, &state.write) {
        (harkroom_server::core::CoreMode::Rust, Some(w)) => {
            use harkroom_server::core::automations_write as k;
            match write::missing_in(w, k::AUTOMATIONS_WRITE_PRIVILEGES, &[]).await {
                Ok(m) if m.is_empty() => Some(w.clone()),
                Ok(m) => {
                    eprintln!("front: automations write core off — missing privileges {m:?}");
                    refuse_missing_grants(&m);
                    None
                }
                Err(e) => {
                    eprintln!(
                        "front: automations write core off — privilege check failed ({})",
                        e.as_database_error().map_or("io", |_| "db")
                    );
                    None
                }
            }
        }
        _ => None,
    };
    // S5.4 AT5 — 자동화 만들기(`POST /automations`). 두 겹 잠금: `HARKROOM_CORE=rust` 그리고 쓰기 풀에 그 칸 권한이 다 있을 때만.
    let automation_create = match (&core_mode, &state.write) {
        (harkroom_server::core::CoreMode::Rust, Some(w)) => {
            use harkroom_server::core::automation_create as k;
            match write::missing_in(w, k::AUTOMATION_CREATE_PRIVILEGES, &[]).await {
                Ok(m) if m.is_empty() => Some(w.clone()),
                Ok(m) => {
                    eprintln!("front: automation create core off — missing privileges {m:?}");
                    refuse_missing_grants(&m);
                    None
                }
                Err(e) => {
                    eprintln!(
                        "front: automation create core off — privilege check failed ({})",
                        e.as_database_error().map_or("io", |_| "db")
                    );
                    None
                }
            }
        }
        _ => None,
    };
    // S5.4 AT4 — 자동화 제안 승인(`POST /automations/{id}/approve`). 두 겹 잠금: `HARKROOM_CORE=rust` 그리고 쓰기 풀에 그 칸 권한이 다 있을 때만.
    let automation_approve = match (&core_mode, &state.write) {
        (harkroom_server::core::CoreMode::Rust, Some(w)) => {
            use harkroom_server::core::automation_approve as k;
            match write::missing_in(w, k::AUTOMATION_APPROVE_PRIVILEGES, &[]).await {
                Ok(m) if m.is_empty() => Some(w.clone()),
                Ok(m) => {
                    eprintln!("front: automation approve core off — missing privileges {m:?}");
                    refuse_missing_grants(&m);
                    None
                }
                Err(e) => {
                    eprintln!(
                        "front: automation approve core off — privilege check failed ({})",
                        e.as_database_error().map_or("io", |_| "db")
                    );
                    None
                }
            }
        }
        _ => None,
    };
    // S5.4 AT3 — 자동화 「지금 한 번」(`POST /automations/{id}/run`). 두 겹 잠금: `HARKROOM_CORE=rust` 그리고 쓰기 풀에 그 칸 권한이 다 있을 때만.
    let automation_run_now = match (&core_mode, &state.write) {
        (harkroom_server::core::CoreMode::Rust, Some(w)) => {
            use harkroom_server::core::automation_run_now as k;
            let need: Vec<(&str, &str)> = k::AUTOMATION_RUN_NOW_PRIVILEGES
                .iter()
                .chain(k::AUTOMATION_RUN_NOW_PAUSE_PRIVILEGES)
                .copied()
                .collect();
            match write::missing_in(w, &need, &[]).await {
                Ok(m) if m.is_empty() => Some(w.clone()),
                Ok(m) => {
                    eprintln!("front: automation run-now core off — missing privileges {m:?}");
                    refuse_missing_grants(&m);
                    None
                }
                Err(e) => {
                    eprintln!(
                        "front: automation run-now core off — privilege check failed ({})",
                        e.as_database_error().map_or("io", |_| "db")
                    );
                    None
                }
            }
        }
        _ => None,
    };
    // S5.4 AT8 — 수신 켜기(`POST /automations/{id}/ingress`). 두 겹 잠금: `HARKROOM_CORE=rust` 그리고 쓰기 풀에 그 칸 권한이 다 있을 때만.
    let automation_ingress_issue = match (&core_mode, &state.write) {
        (harkroom_server::core::CoreMode::Rust, Some(w)) => {
            use harkroom_server::core::automation_ingress_issue as k;
            match write::missing_in(w, k::PRIVILEGES, &[]).await {
                Ok(m) if m.is_empty() => Some(w.clone()),
                Ok(m) => {
                    eprintln!(
                        "front: automation ingress issue core off — missing privileges {m:?}"
                    );
                    refuse_missing_grants(&m);
                    None
                }
                Err(e) => {
                    eprintln!(
                        "front: automation ingress issue core off — privilege check failed ({})",
                        e.as_database_error().map_or("io", |_| "db")
                    );
                    None
                }
            }
        }
        _ => None,
    };
    // S5.4 AT7 — 들어오는 hook(github·generic). 두 겹 잠금: `HARKROOM_CORE=rust` 그리고 읽기 풀에 수신 비밀 칸 SELECT 가 있을 때만.
    // S5.4 AT7 — hook 의 회차 만들기(generic). 쓰기 풀에 run-now 와 같은 칸이 다 있을 때만 — 아니면 그 단계는 TS 로 넘긴다.
    let automation_hooks_write = match (&core_mode, &state.write) {
        (harkroom_server::core::CoreMode::Rust, Some(w)) => {
            use harkroom_server::core::automation_hooks as k;
            match write::missing_in(w, &k::write_privileges(), &[]).await {
                Ok(m) if m.is_empty() => Some(w.clone()),
                _ => None,
            }
        }
        _ => None,
    };
    let automation_hooks_on = match core_mode {
        harkroom_server::core::CoreMode::Rust => {
            use harkroom_server::core::automation_hooks as k;
            match write::missing_in(&state.pool, k::PRIVILEGES, &[]).await {
                Ok(m) if m.is_empty() => true,
                Ok(m) => {
                    eprintln!("front: automation hooks core off — missing privileges {m:?}");
                    refuse_missing_grants(&m);
                    false
                }
                Err(e) => {
                    eprintln!(
                        "front: automation hooks core off — privilege check failed ({})",
                        e.as_database_error().map_or("io", |_| "db")
                    );
                    false
                }
            }
        }
        _ => false,
    };
    // S5.4 결정 5 — 자동화 지우기(`DELETE /automations/{id}`) + 위임 끝 카드 갱신(`core::perm_card`). 두 겹 잠금.
    let automation_delete = match (&core_mode, &state.write) {
        (harkroom_server::core::CoreMode::Rust, Some(w)) => {
            use harkroom_server::core::{automation_delete as k, perm_card as pc};
            let need = [k::AUTOMATION_DELETE_PRIVILEGES, pc::PERM_CARD_PRIVILEGES].concat();
            match write::missing_in(w, &need, pc::PERM_CARD_SEQUENCE_PRIVILEGES).await {
                Ok(m) if m.is_empty() => Some(w.clone()),
                Ok(m) => {
                    eprintln!("front: automation delete core off — missing privileges {m:?}");
                    refuse_missing_grants(&m);
                    None
                }
                Err(e) => {
                    eprintln!(
                        "front: automation delete core off — privilege check failed ({})",
                        e.as_database_error().map_or("io", |_| "db")
                    );
                    None
                }
            }
        }
        _ => None,
    };
    // S5.4 MD2 — 위임장 줄 빼기(`DELETE /mandates/{id}/lines/{lineId}`) + 카드 `message.updated`. 두 겹 잠금.
    let mandate_line_revoke = match (&core_mode, &state.write) {
        (harkroom_server::core::CoreMode::Rust, Some(w)) => {
            use harkroom_server::core::{mandate_line_revoke as k, perm_card as pc};
            let need = [k::MANDATE_LINE_REVOKE_PRIVILEGES, pc::PERM_CARD_PRIVILEGES].concat();
            match write::missing_in(w, &need, pc::PERM_CARD_SEQUENCE_PRIVILEGES).await {
                Ok(m) if m.is_empty() => Some(w.clone()),
                Ok(m) => {
                    eprintln!("front: mandate line revoke core off — missing privileges {m:?}");
                    refuse_missing_grants(&m);
                    None
                }
                Err(e) => {
                    eprintln!(
                        "front: mandate line revoke core off — privilege check failed ({})",
                        e.as_database_error().map_or("io", |_| "db")
                    );
                    None
                }
            }
        }
        _ => None,
    };
    // S5.4 AT6 — 자동화 고치기(`PATCH /automations/{id}`) + 위임 끝 카드 갱신. 두 겹 잠금.
    let automation_patch = match (&core_mode, &state.write) {
        (harkroom_server::core::CoreMode::Rust, Some(w)) => {
            use harkroom_server::core::{automation_patch as k, perm_card as pc};
            let need = [k::AUTOMATION_PATCH_PRIVILEGES, pc::PERM_CARD_PRIVILEGES].concat();
            match write::missing_in(w, &need, pc::PERM_CARD_SEQUENCE_PRIVILEGES).await {
                Ok(m) if m.is_empty() => Some(w.clone()),
                Ok(m) => {
                    eprintln!("front: automation patch core off — missing privileges {m:?}");
                    refuse_missing_grants(&m);
                    None
                }
                Err(e) => {
                    eprintln!(
                        "front: automation patch core off — privilege check failed ({})",
                        e.as_database_error().map_or("io", |_| "db")
                    );
                    None
                }
            }
        }
        _ => None,
    };
    // S5.4 결정 5 — 소유자의 [위임 끝](`POST /mandates/{id}/end`) + 위임 끝 카드 갱신(`core::perm_card`). 두 겹 잠금.
    let mandate_end = match (&core_mode, &state.write) {
        (harkroom_server::core::CoreMode::Rust, Some(w)) => {
            use harkroom_server::core::{mandate_end as k, perm_card as pc};
            let need = [k::MANDATE_END_PRIVILEGES, pc::PERM_CARD_PRIVILEGES].concat();
            match write::missing_in(w, &need, pc::PERM_CARD_SEQUENCE_PRIVILEGES).await {
                Ok(m) if m.is_empty() => Some(w.clone()),
                Ok(m) => {
                    eprintln!("front: mandate end core off — missing privileges {m:?}");
                    refuse_missing_grants(&m);
                    None
                }
                Err(e) => {
                    eprintln!(
                        "front: mandate end core off — privilege check failed ({})",
                        e.as_database_error().map_or("io", |_| "db")
                    );
                    None
                }
            }
        }
        _ => None,
    };
    // S5.4 — API 연결 지우기(`DELETE /connectors/{id}`). 두 겹 잠금: `HARKROOM_CORE=rust` 그리고 쓰기 풀에 그 칸 권한이 다 있을 때만. PATCH 는 TS.
    let connectors_write = match (&core_mode, &state.write) {
        (harkroom_server::core::CoreMode::Rust, Some(w)) => {
            use harkroom_server::core::connectors_write as k;
            match write::missing_in(w, k::CONNECTORS_WRITE_PRIVILEGES, &[]).await {
                Ok(m) if m.is_empty() => Some(w.clone()),
                Ok(m) => {
                    eprintln!("front: connectors write core off — missing privileges {m:?}");
                    refuse_missing_grants(&m);
                    None
                }
                Err(e) => {
                    eprintln!(
                        "front: connectors write core off — privilege check failed ({})",
                        e.as_database_error().map_or("io", |_| "db")
                    );
                    None
                }
            }
        }
        _ => None,
    };
    // S5.4 — API 연결 만들기·고치기. 두 겹 잠금: `HARKROOM_CORE=rust` 그리고 쓰기 풀에 그 칸 권한이 다 있을 때만.
    let connectors_upsert = match (&core_mode, &state.write) {
        (harkroom_server::core::CoreMode::Rust, Some(w)) => {
            use harkroom_server::core::connectors_upsert as k;
            match write::missing_in(w, k::CONNECTORS_UPSERT_PRIVILEGES, &[]).await {
                Ok(m) if m.is_empty() => Some(w.clone()),
                Ok(m) => {
                    eprintln!("front: connectors upsert core off — missing privileges {m:?}");
                    refuse_missing_grants(&m);
                    None
                }
                Err(e) => {
                    eprintln!(
                        "front: connectors upsert core off — privilege check failed ({})",
                        e.as_database_error().map_or("io", |_| "db")
                    );
                    None
                }
            }
        }
        _ => None,
    };
    // S5.4 AC4 — 초대 만들기(메일 없는 것)·취소. 두 겹 잠금: `HARKROOM_CORE=rust` 그리고 쓰기 풀에 그 칸 권한이 다 있을 때만.
    let invites_write = match (&core_mode, &state.write) {
        (harkroom_server::core::CoreMode::Rust, Some(w)) => {
            use harkroom_server::core::invites_write as k;
            match write::missing_in(w, k::INVITES_WRITE_PRIVILEGES, &[]).await {
                Ok(m) if m.is_empty() => Some(w.clone()),
                Ok(m) => {
                    eprintln!("front: invites write core off — missing privileges {m:?}");
                    refuse_missing_grants(&m);
                    None
                }
                Err(e) => {
                    eprintln!(
                        "front: invites write core off — privilege check failed ({})",
                        e.as_database_error().map_or("io", |_| "db")
                    );
                    None
                }
            }
        }
        _ => None,
    };
    // S5.4 — GET /agent/config. 두 겹 잠금: `HARKROOM_CORE=rust` 그리고 쓰기 풀에 그 권한이 다 있을 때만.
    let agent_config_write = match (&core_mode, &state.write) {
        (harkroom_server::core::CoreMode::Rust, Some(w)) => {
            use harkroom_server::core::agent_config_read as k;
            match write::missing_in(w, k::AGENT_CONFIG_PRIVILEGES, &[]).await {
                Ok(m) if m.is_empty() => Some(w.clone()),
                Ok(m) => {
                    eprintln!("front: agent config core off — missing privileges {m:?}");
                    refuse_missing_grants(&m);
                    None
                }
                Err(e) => {
                    eprintln!(
                        "front: agent config core off — privilege check failed ({})",
                        e.as_database_error().map_or("io", |_| "db")
                    );
                    None
                }
            }
        }
        _ => None,
    };
    // S5.4 AC4 — keys PUT·agent/activity. 두 겹 잠금: `HARKROOM_CORE=rust` 그리고 쓰기 풀에 그 칸 권한이 다 있을 때만.
    let keys_activity_write = match (&core_mode, &state.write) {
        (harkroom_server::core::CoreMode::Rust, Some(w)) => {
            use harkroom_server::core::account_keys_activity as k;
            match write::missing_in(w, k::KEYS_ACTIVITY_PRIVILEGES, &[]).await {
                Ok(m) if m.is_empty() => Some(w.clone()),
                Ok(m) => {
                    eprintln!("front: keys/activity core off — missing privileges {m:?}");
                    refuse_missing_grants(&m);
                    None
                }
                Err(e) => {
                    eprintln!(
                        "front: keys/activity core off — privilege check failed ({})",
                        e.as_database_error().map_or("io", |_| "db")
                    );
                    None
                }
            }
        }
        _ => None,
    };
    // S5.4 AU1 — 인증 가벼운 줄(me·logout·재설정 알림). 두 겹 잠금: `HARKROOM_CORE=rust` 그리고 쓰기 풀에 그 권한이 다 있을 때만.
    let auth_light_write = match (&core_mode, &state.write) {
        (harkroom_server::core::CoreMode::Rust, Some(w)) => {
            use harkroom_server::core::auth_light as a;
            match write::missing_in(w, a::AUTH_LIGHT_PRIVILEGES, &[]).await {
                Ok(m) if m.is_empty() => Some(w.clone()),
                Ok(m) => {
                    eprintln!("front: auth light core off — missing privileges {m:?}");
                    refuse_missing_grants(&m);
                    None
                }
                Err(e) => {
                    eprintln!(
                        "front: auth light core off — privilege check failed ({})",
                        e.as_database_error().map_or("io", |_| "db")
                    );
                    None
                }
            }
        }
        _ => None,
    };
    // S5.4 SE1 — 비밀 REST 읽기·지우기. 두 겹 잠금: `HARKROOM_CORE=rust` 그리고 쓰기 풀에 그 권한이 다 있을 때만.
    // S5.4 SE2 — 비밀 부여(`PUT /secrets/{id}/grants`). 두 겹 잠금: `HARKROOM_CORE=rust` 그리고 쓰기 풀에 그 칸 권한이 다 있을 때만.
    let secret_grant_give = match (&core_mode, &state.write) {
        (harkroom_server::core::CoreMode::Rust, Some(w)) => {
            use harkroom_server::core::secret_grant_give as k;
            match write::missing_in(w, k::SECRET_GRANT_GIVE_PRIVILEGES, &[]).await {
                Ok(m) if m.is_empty() => Some(w.clone()),
                Ok(m) => {
                    eprintln!("front: secret grant give core off — missing privileges {m:?}");
                    refuse_missing_grants(&m);
                    None
                }
                Err(e) => {
                    eprintln!(
                        "front: secret grant give core off — privilege check failed ({})",
                        e.as_database_error().map_or("io", |_| "db")
                    );
                    None
                }
            }
        }
        _ => None,
    };
    // S5.4 SE3 — 비밀 쓰기(`POST /secrets`·`PATCH /secrets/{id}`·`PUT /secrets/{id}/value`). 세 겹 잠금: `HARKROOM_CORE=rust`,
    // 쓰기 풀에 그 칸 권한이 다 있고, 키 env 를 읽어 DB 확인값과 맞춰 볼 수 있을 때만(키가 없거나 틀리면 TS 처럼 409 로 답한다).
    let secret_writes = match (&core_mode, &state.write) {
        (harkroom_server::core::CoreMode::Rust, Some(w)) => {
            use harkroom_server::core::secret_writes as k;
            match write::missing_in(w, &k::privileges(), &[]).await {
                Ok(m) if m.is_empty() => {
                    match k::load_state(state.pool.clone(), w.clone(), state.trust.clone()).await {
                        Ok(st) => Some(st),
                        Err(e) => {
                            eprintln!("front: secret writes core off — secret keys: {e}");
                            None
                        }
                    }
                }
                Ok(m) => {
                    eprintln!("front: secret writes core off — missing privileges {m:?}");
                    refuse_missing_grants(&m);
                    None
                }
                Err(e) => {
                    eprintln!(
                        "front: secret writes core off — privilege check failed ({})",
                        e.as_database_error().map_or("io", |_| "db")
                    );
                    None
                }
            }
        }
        _ => None,
    };
    // S5.4 — 소유자 보기 `POST /secrets/{id}/reveal`. 세 겹 잠금: `HARKROOM_CORE=rust`, 쓰기 풀에 그 칸 권한이 다 있고,
    // 키 env 를 읽어 DB 확인값과 맞춰 볼 수 있을 때만. 아니면 TS 에 남는다(`secret_reveal.rs` 머리말).
    let secret_reveal = match (&core_mode, &state.write) {
        (harkroom_server::core::CoreMode::Rust, Some(w)) => {
            use harkroom_server::core::secret_reveal as k;
            match write::missing_in(w, &k::privileges(), k::SECRET_REVEAL_SEQUENCES).await {
                Ok(m) if m.is_empty() => {
                    match k::load_state(state.pool.clone(), w.clone(), state.trust.clone()).await {
                        Ok(st) => Some(st),
                        Err(e) => {
                            eprintln!("front: secret reveal core off — secret keys: {e}");
                            None
                        }
                    }
                }
                Ok(m) => {
                    eprintln!("front: secret reveal core off — missing privileges {m:?}");
                    refuse_missing_grants(&m);
                    None
                }
                Err(e) => {
                    eprintln!(
                        "front: secret reveal core off — privilege check failed ({})",
                        e.as_database_error().map_or("io", |_| "db")
                    );
                    None
                }
            }
        }
        _ => None,
    };
    // S5.4 SE4 — `GET /agent/secret-create`. 세 겹 잠금: `HARKROOM_CORE=rust`, 쓰기 풀에 그 칸 권한이 다 있고, 키 env 를 읽어
    // DB 확인값과 맞춰 볼 수 있을 때만. `POST /agent/secrets`·`/agent/secrets/rotate`(generate·import)는 아래 두 겹 잠금을 더 본다.
    let agent_secret_create = match (&core_mode, &state.write) {
        (harkroom_server::core::CoreMode::Rust, Some(w)) => {
            use harkroom_server::core::agent_secret_create as k;
            match write::missing_in(w, &k::privileges(), &[]).await {
                Ok(m) if m.is_empty() => match k::load_state(w.clone()).await {
                    Ok(st) => Some(st),
                    Err(e) => {
                        eprintln!("front: agent secret create core off — secret keys: {e}");
                        None
                    }
                },
                Ok(m) => {
                    eprintln!("front: agent secret create core off — missing privileges {m:?}");
                    refuse_missing_grants(&m);
                    None
                }
                Err(e) => {
                    eprintln!(
                        "front: agent secret create core off — privilege check failed ({})",
                        e.as_database_error().map_or("io", |_| "db")
                    );
                    None
                }
            }
        }
        _ => None,
    };
    // S5.4 — `POST /agent/secrets/reveal`. 세 겹 잠금: `HARKROOM_CORE=rust`, 쓰기 풀에 그 칸 권한이 다 있고, 키 env 를 읽어
    // DB 확인값과 맞춰 볼 수 있을 때만. 아니면 TS 에 남는다(`agent_secret_reveal.rs` 머리말).
    let agent_secret_reveal = match (&core_mode, &state.write) {
        (harkroom_server::core::CoreMode::Rust, Some(w)) => {
            use harkroom_server::core::agent_secret_reveal as k;
            match write::missing_in(w, &k::privileges(), k::AGENT_SECRET_REVEAL_SEQUENCES).await {
                Ok(m) if m.is_empty() => match k::load_state(w.clone()).await {
                    Ok(st) => Some(st),
                    Err(e) => {
                        eprintln!("front: agent secret reveal core off — secret keys: {e}");
                        None
                    }
                },
                Ok(m) => {
                    eprintln!("front: agent secret reveal core off — missing privileges {m:?}");
                    refuse_missing_grants(&m);
                    None
                }
                Err(e) => {
                    eprintln!(
                        "front: agent secret reveal core off — privilege check failed ({})",
                        e.as_database_error().map_or("io", |_| "db")
                    );
                    None
                }
            }
        }
        _ => None,
    };
    // `POST /agent/secrets`·`/agent/secrets/rotate` — 두 줄이 닿는 칸이 다 있을 때만(`agent_secret_create.rs` 머리말).
    let agent_secret_write_ok = match (&agent_secret_create, &state.write) {
        (Some(_), Some(w)) => {
            use harkroom_server::core::agent_secret_create as k;
            match write::missing_in(w, &k::write_privileges(), &[]).await {
                Ok(m) if m.is_empty() => true,
                Ok(m) => {
                    eprintln!(
                        "front: agent secret create/rotate core off — missing privileges {m:?}"
                    );
                    refuse_missing_grants(&m);
                    false
                }
                Err(e) => {
                    eprintln!(
                        "front: agent secret create/rotate core off — privilege check failed ({})",
                        e.as_database_error().map_or("io", |_| "db")
                    );
                    false
                }
            }
        }
        _ => false,
    };
    let secrets_read_write = match (&core_mode, &state.write) {
        (harkroom_server::core::CoreMode::Rust, Some(w)) => {
            use harkroom_server::core::secrets_read as s;
            match write::missing_in(w, s::SECRETS_READ_PRIVILEGES, &[]).await {
                Ok(m) if m.is_empty() => Some(w.clone()),
                Ok(m) => {
                    eprintln!("front: secrets read core off — missing privileges {m:?}");
                    refuse_missing_grants(&m);
                    None
                }
                Err(e) => {
                    eprintln!(
                        "front: secrets read core off — privilege check failed ({})",
                        e.as_database_error().map_or("io", |_| "db")
                    );
                    None
                }
            }
        }
        _ => None,
    };
    // S5.4 MI3 — `GET /settings/projection`. 두 겹 잠금: `HARKROOM_CORE=rust` 그리고 읽기 풀에 그 권한이 있을 때만. PUT 은 언제나 TS(투영 폴러가 TS 메모리에 있다).
    let settings_rest_on = match &core_mode {
        harkroom_server::core::CoreMode::Rust => {
            use harkroom_server::core::settings_rest as s;
            match write::missing_in(&state.pool, s::SETTINGS_REST_PRIVILEGES, &[]).await {
                Ok(m) if m.is_empty() => true,
                Ok(m) => {
                    eprintln!("front: settings rest core off — missing privileges {m:?}");
                    refuse_missing_grants(&m);
                    false
                }
                Err(e) => {
                    eprintln!(
                        "front: settings rest core off — privilege check failed ({})",
                        e.as_database_error().map_or("io", |_| "db")
                    );
                    false
                }
            }
        }
        _ => false,
    };
    // `PUT /settings/projection` — 읽기 줄이 섰고 쓰기 풀에 그 칸 권한이 있을 때만(아니면 TS).
    let settings_projection_write = match (&state.write, settings_rest_on) {
        (Some(w), true) => {
            use harkroom_server::core::settings_rest as s;
            match write::missing_in(w, s::SETTINGS_PROJECTION_WRITE_PRIVILEGES, &[]).await {
                Ok(m) if m.is_empty() => Some(w.clone()),
                Ok(m) => {
                    eprintln!("front: settings projection write off — missing privileges {m:?}");
                    refuse_missing_grants(&m);
                    None
                }
                Err(e) => {
                    eprintln!(
                        "front: settings projection write off — privilege check failed ({})",
                        e.as_database_error().map_or("io", |_| "db")
                    );
                    None
                }
            }
        }
        _ => None,
    };
    // S5.4 TM1 — 스레드 모델 지정 읽기(`GET /channels/{id}/threads/{rootId}/agent-models`). 읽기 풀만 쓴다.
    // 두 겹 잠금: `HARKROOM_CORE=rust` 그리고 읽기 역할에 그 표들의 SELECT 가 다 있을 때만 — 아니면 TS 에 남는다.
    let thread_models_read = match &core_mode {
        harkroom_server::core::CoreMode::Rust => {
            use harkroom_server::core::thread_models_read as tm;
            match write::missing_in(&state.pool, tm::THREAD_MODELS_READ_PRIVILEGES, &[]).await {
                Ok(m) if m.is_empty() => true,
                Ok(m) => {
                    eprintln!("front: thread models read core off — missing privileges {m:?}");
                    refuse_missing_grants(&m);
                    false
                }
                Err(e) => {
                    eprintln!(
                        "front: thread models read core off — privilege check failed ({})",
                        e.as_database_error().map_or("io", |_| "db")
                    );
                    false
                }
            }
        }
        _ => false,
    };
    // S5.4 CF1 — 채널 파일 목록(`GET /channels/{id}/files`). 두 겹 잠금: `HARKROOM_CORE=rust` 그리고 읽기 역할 SELECT.
    let channel_files_on = match &core_mode {
        harkroom_server::core::CoreMode::Rust => {
            use harkroom_server::core::channel_files as cf;
            match write::missing_in(&state.pool, cf::CHANNEL_FILES_READ_PRIVILEGES, &[]).await {
                Ok(m) if m.is_empty() => true,
                Ok(m) => {
                    eprintln!("front: channel files core off — missing privileges {m:?}");
                    refuse_missing_grants(&m);
                    false
                }
                Err(e) => {
                    eprintln!(
                        "front: channel files core off — privilege check failed ({})",
                        e.as_database_error().map_or("io", |_| "db")
                    );
                    false
                }
            }
        }
        _ => false,
    };
    // S5.4 TP1 — `GET /threads/{rootId}/plan`. 두 겹 잠금: `HARKROOM_CORE=rust` 그리고 읽기 풀에 그 SELECT 가 다 있을 때만. 계획 쓰기는 언제나 TS.
    let thread_plan_read_on = match &core_mode {
        harkroom_server::core::CoreMode::Rust => {
            use harkroom_server::core::thread_plan_read as t;
            match write::missing_in(&state.pool, t::THREAD_PLAN_READ_PRIVILEGES, &[]).await {
                Ok(m) if m.is_empty() => true,
                Ok(m) => {
                    eprintln!("front: thread plan read core off — missing privileges {m:?}");
                    refuse_missing_grants(&m);
                    false
                }
                Err(e) => {
                    eprintln!(
                        "front: thread plan read core off — privilege check failed ({})",
                        e.as_database_error().map_or("io", |_| "db")
                    );
                    false
                }
            }
        }
        _ => false,
    };
    // S5.4 RD1 — `GET /invites`·`GET /connectors`. 두 겹 잠금: `HARKROOM_CORE=rust` 그리고 읽기 풀에 그 SELECT 가 다 있을 때만. 리스·에이전트 목록은 언제나 TS(`/agent/config` 는 `agent_config_read.rs`).
    let misc_reads_on = match &core_mode {
        harkroom_server::core::CoreMode::Rust => {
            use harkroom_server::core::misc_reads as m;
            match write::missing_in(&state.pool, m::MISC_READS_PRIVILEGES, &[]).await {
                Ok(m) if m.is_empty() => true,
                Ok(m) => {
                    eprintln!("front: misc reads core off — missing privileges {m:?}");
                    refuse_missing_grants(&m);
                    false
                }
                Err(e) => {
                    eprintln!(
                        "front: misc reads core off — privilege check failed ({})",
                        e.as_database_error().map_or("io", |_| "db")
                    );
                    false
                }
            }
        }
        _ => false,
    };
    // S5.4 CH3a — 핀 고정·해제·예약 글 만들기·취소. 두 겹 잠금: `HARKROOM_CORE=rust` 그리고 쓰기 풀에 그 권한이 다 있을 때만.
    let pins_sched = match (&core_mode, &state.write) {
        (harkroom_server::core::CoreMode::Rust, Some(w)) => {
            use harkroom_server::core::channel_pins_sched as c;
            match write::missing_in(w, c::PINS_SCHED_PRIVILEGES, &[]).await {
                Ok(m) if m.is_empty() => Some(w.clone()),
                Ok(m) => {
                    eprintln!("front: pins/scheduled write core off — missing privileges {m:?}");
                    refuse_missing_grants(&m);
                    None
                }
                Err(e) => {
                    eprintln!(
                        "front: pins/scheduled write core off — privilege check failed ({})",
                        e.as_database_error().map_or("io", |_| "db")
                    );
                    None
                }
            }
        }
        _ => None,
    };
    // S5.4 CH4b-1 — DM 열기. 두 겹 잠금: `HARKROOM_CORE=rust` 그리고 쓰기 풀에 그 권한이 다 있을 때만.
    let dm_open = match (&core_mode, &state.write) {
        (harkroom_server::core::CoreMode::Rust, Some(w)) => {
            use harkroom_server::core::dm_open as c;
            match write::missing_in(w, c::DM_OPEN_PRIVILEGES, &[]).await {
                Ok(m) if m.is_empty() => Some(w.clone()),
                Ok(m) => {
                    eprintln!("front: dm open core off — missing privileges {m:?}");
                    refuse_missing_grants(&m);
                    None
                }
                Err(e) => {
                    eprintln!(
                        "front: dm open core off — privilege check failed ({})",
                        e.as_database_error().map_or("io", |_| "db")
                    );
                    None
                }
            }
        }
        _ => None,
    };
    // `POST /dms` 가 코어에 붙으면 같은 경로의 `GET /dms` 도 코어 라우터가 단다(읽기 표에서는 뺀다 — 두 라우터가 같은 경로를
    // fallback 과 함께 가지면 합칠 수 없다).
    let dm_core_on = dm_open.is_some();
    let ts_get_dms = ts.keys.contains("GET /dms") || ts.all;
    // S5.4 CH4a — 채널 만들기·고치기. 두 겹 잠금: `HARKROOM_CORE=rust` 그리고 쓰기 풀에 그 권한이 다 있을 때만.
    let channel_create_update = match (&core_mode, &state.write) {
        (harkroom_server::core::CoreMode::Rust, Some(w)) => {
            use harkroom_server::core::channel_create_update as c;
            match write::missing_in(w, c::CREATE_UPDATE_PRIVILEGES, &[]).await {
                Ok(m) if m.is_empty() => Some(w.clone()),
                Ok(m) => {
                    eprintln!("front: channel create/update core off — missing privileges {m:?}");
                    refuse_missing_grants(&m);
                    None
                }
                Err(e) => {
                    eprintln!(
                        "front: channel create/update core off — privilege check failed ({})",
                        e.as_database_error().map_or("io", |_| "db")
                    );
                    None
                }
            }
        }
        _ => None,
    };
    // S5.4 결정 3 — 채널 지우기. 세 겹 잠금: `HARKROOM_CORE=rust`, 쓰기 풀에 그 권한이 다 있을 때, 그리고 첨부 저장소
    // (`ATTACHMENT_ROOT`)가 있을 때만 — 없으면 지운 채널의 파일이 고아로 남으므로 TS 에 남는다.
    let channel_delete = match (&core_mode, &state.write) {
        (harkroom_server::core::CoreMode::Rust, Some(w)) => {
            use harkroom_server::core::attachment_store::LocalStorage;
            use harkroom_server::core::channel_delete as c;
            match (
                write::missing_in(w, c::DELETE_PRIVILEGES, &[]).await,
                LocalStorage::from_env(),
            ) {
                (Ok(m), Ok(Some(s))) if m.is_empty() => Some((w.clone(), s)),
                (Ok(m), Ok(Some(_))) => {
                    eprintln!("front: channel delete core off — missing privileges {m:?}");
                    refuse_missing_grants(&m);
                    None
                }
                (Ok(_), Ok(None)) => {
                    eprintln!("front: channel delete core off — ATTACHMENT_ROOT not set");
                    None
                }
                (Ok(_), Err(e)) => {
                    eprintln!("front: channel delete core off — attachment root ({e})");
                    None
                }
                (Err(e), _) => {
                    eprintln!(
                        "front: channel delete core off — privilege check failed ({})",
                        e.as_database_error().map_or("io", |_| "db")
                    );
                    None
                }
            }
        }
        _ => None,
    };
    // S5.4 결정 3 — 첨부 내려받기(`GET /attachments/{id}`). 세 겹 잠금: `HARKROOM_CORE=rust`, 읽기 역할에 그 SELECT 가 다 있을 때,
    // 그리고 첨부 저장소(`ATTACHMENT_ROOT`)가 있을 때만 — 없으면 파일을 찾을 곳을 모르므로 TS 에 남는다.
    let attachment_download = match &core_mode {
        harkroom_server::core::CoreMode::Rust => {
            use harkroom_server::core::attachment_download as c;
            use harkroom_server::core::attachment_store::LocalStorage;
            match (
                write::missing_in(&state.pool, c::DOWNLOAD_PRIVILEGES, &[]).await,
                LocalStorage::from_env(),
            ) {
                (Ok(m), Ok(Some(s))) if m.is_empty() => Some(s),
                (Ok(m), Ok(Some(_))) => {
                    eprintln!("front: attachment download core off — missing privileges {m:?}");
                    refuse_missing_grants(&m);
                    None
                }
                (Ok(_), Ok(None)) => {
                    eprintln!("front: attachment download core off — ATTACHMENT_ROOT not set");
                    None
                }
                (Ok(_), Err(e)) => {
                    eprintln!("front: attachment download core off — attachment root ({e})");
                    None
                }
                (Err(e), _) => {
                    eprintln!(
                        "front: attachment download core off — privilege check failed ({})",
                        e.as_database_error().map_or("io", |_| "db")
                    );
                    None
                }
            }
        }
        _ => None,
    };
    // S5.4 — 아바타 읽기(`GET /accounts/{id}/avatar`·`…/avatar/source`). 세 겹 잠금: `HARKROOM_CORE=rust`, 읽기 역할에
    // 그 SELECT 가 다 있을 때, 첨부 저장소(`ATTACHMENT_ROOT`)가 있을 때만 — 아니면 TS 에 남는다.
    let avatar_read = match &core_mode {
        harkroom_server::core::CoreMode::Rust => {
            use harkroom_server::core::attachment_store::LocalStorage;
            use harkroom_server::core::avatar_read as c;
            match (
                write::missing_in(&state.pool, c::AVATAR_READ_PRIVILEGES, &[]).await,
                LocalStorage::from_env(),
            ) {
                (Ok(m), Ok(Some(s))) if m.is_empty() => Some(s),
                (Ok(m), Ok(Some(_))) => {
                    eprintln!("front: avatar read core off — missing privileges {m:?}");
                    refuse_missing_grants(&m);
                    None
                }
                (Ok(_), Ok(None)) => {
                    eprintln!("front: avatar read core off — ATTACHMENT_ROOT not set");
                    None
                }
                (Ok(_), Err(e)) => {
                    eprintln!("front: avatar read core off — attachment root ({e})");
                    None
                }
                (Err(e), _) => {
                    eprintln!(
                        "front: avatar read core off — privilege check failed ({})",
                        e.as_database_error().map_or("io", |_| "db")
                    );
                    None
                }
            }
        }
        _ => None,
    };
    // S5.4 — `GET /workspace/icon`. 아바타 읽기(같은 저장소)가 켜졌고 아이콘 칸 권한이 있을 때만.
    let workspace_icon = match &avatar_read {
        Some(s) => match write::missing_in(
            &state.pool,
            harkroom_server::core::avatar_read::WORKSPACE_ICON_PRIVILEGES,
            &[],
        )
        .await
        {
            Ok(m) if m.is_empty() => Some(s.clone()),
            Ok(m) => {
                eprintln!("front: workspace icon core off — missing privileges {m:?}");
                refuse_missing_grants(&m);
                None
            }
            Err(e) => {
                eprintln!(
                    "front: workspace icon core off — privilege check failed ({})",
                    e.as_database_error().map_or("io", |_| "db")
                );
                None
            }
        },
        None => None,
    };
    // S5.4 — 아바타 걸기(`PUT /accounts/me/avatar`·`PUT /accounts/agents/{id}/avatar`). 네 겹 잠금: `HARKROOM_CORE=rust`,
    // 쓰기 풀에 그 칸 권한이 다 있을 때, 아바타 읽기 코어가 켜졌을 때(같은 읽기 SELECT·같은 저장소)만 — 아니면 TS 에 남는다.
    // 래스터 그림은 코어가 TS 에 넘긴다(sharp 판정).
    let avatar_write = match (&core_mode, &state.write, &avatar_read) {
        (harkroom_server::core::CoreMode::Rust, Some(w), Some(storage)) => {
            use harkroom_server::core::avatar_write as c;
            match write::missing_in(
                w,
                c::AVATAR_WRITE_PRIVILEGES,
                c::AVATAR_WRITE_SEQUENCE_PRIVILEGES,
            )
            .await
            {
                Ok(m) if m.is_empty() => Some((w.clone(), storage.clone())),
                Ok(m) => {
                    eprintln!("front: avatar write core off — missing privileges {m:?}");
                    refuse_missing_grants(&m);
                    None
                }
                Err(e) => {
                    eprintln!(
                        "front: avatar write core off — privilege check failed ({})",
                        e.as_database_error().map_or("io", |_| "db")
                    );
                    None
                }
            }
        }
        _ => None,
    };
    // S5.4 — 첨부 올리기(`POST /uploads`). 네 겹 잠금: `HARKROOM_CORE=rust`, 쓰기 풀에 그 칸 권한이 다 있을 때,
    // 첨부 저장소(`ATTACHMENT_ROOT`)가 있을 때, `ATTACHMENT_MAX_BYTES` 를 읽을 수 있을 때만 — 아니면 TS 에 남는다.
    let attachment_upload = match (&core_mode, &state.write) {
        (harkroom_server::core::CoreMode::Rust, Some(w)) => {
            use harkroom_server::core::attachment_store::LocalStorage;
            use harkroom_server::core::attachment_upload as c;
            match (
                write::missing_in(w, c::UPLOAD_PRIVILEGES, &[]).await,
                LocalStorage::from_env(),
                c::max_bytes_from_env(),
            ) {
                (Ok(m), _, _) if !m.is_empty() => {
                    eprintln!("front: attachment upload core off — missing privileges {m:?}");
                    refuse_missing_grants(&m);
                    None
                }
                (Ok(_), Ok(Some(s)), Some(max)) => Some((w.clone(), s, max)),
                (Ok(_), Ok(None), _) => {
                    eprintln!("front: attachment upload core off — ATTACHMENT_ROOT not set");
                    None
                }
                (Ok(_), Err(e), _) => {
                    eprintln!("front: attachment upload core off — attachment root ({e})");
                    None
                }
                (Ok(_), _, None) => {
                    eprintln!(
                        "front: attachment upload core off — ATTACHMENT_MAX_BYTES unreadable"
                    );
                    None
                }
                (Err(e), _, _) => {
                    eprintln!(
                        "front: attachment upload core off — privilege check failed ({})",
                        e.as_database_error().map_or("io", |_| "db")
                    );
                    None
                }
            }
        }
        _ => None,
    };
    // 에이전트 업로드의 비밀 값 검사(`core/leak_guard.rs`) — 권한·키 env 가 다 맞을 때만. 아니면 에이전트 업로드는 TS.
    // MCP `artifact.publish` 새 안 게시가 쓸 첨부 저장소 — 업로드 줄과 같은 잠금(권한·저장소·상한)을 지났을 때만.
    let artifact_storage = attachment_upload.as_ref().map(|(_, s, _)| s.clone());
    let agent_upload_leak = match &attachment_upload {
        Some((write, _, _)) => {
            use harkroom_server::core::leak_guard as lg;
            match write::missing_in(write, &lg::privileges(), lg::LEAK_GUARD_SEQUENCES).await {
                Ok(m) if m.is_empty() => match lg::LeakGuard::load(write.clone()).await {
                    Ok(g) => Some(std::sync::Arc::new(g)),
                    Err(e) => {
                        eprintln!("front: agent upload leak guard off — secret keys: {e}");
                        None
                    }
                },
                Ok(m) => {
                    eprintln!("front: agent upload leak guard off — missing privileges {m:?}");
                    refuse_missing_grants(&m);
                    None
                }
                Err(e) => {
                    eprintln!(
                        "front: agent upload leak guard off — privilege check failed ({})",
                        e.as_database_error().map_or("io", |_| "db")
                    );
                    None
                }
            }
        }
        None => None,
    };
    // S5.4 CT1 — 채널에 팀 넣기(`POST /channels/{id}/teams/{teamId}/add`). 두 겹 잠금: `HARKROOM_CORE=rust` 그리고 쓰기 풀에 그 칸 권한이 다 있을 때만.
    let channel_team_add = match (&core_mode, &state.write) {
        (harkroom_server::core::CoreMode::Rust, Some(w)) => {
            use harkroom_server::core::channel_team_add as c;
            match write::missing_in(w, c::TEAM_ADD_PRIVILEGES, &[]).await {
                Ok(m) if m.is_empty() => Some(w.clone()),
                Ok(m) => {
                    eprintln!("front: channel team add core off — missing privileges {m:?}");
                    refuse_missing_grants(&m);
                    None
                }
                Err(e) => {
                    eprintln!(
                        "front: channel team add core off — privilege check failed ({})",
                        e.as_database_error().map_or("io", |_| "db")
                    );
                    None
                }
            }
        }
        _ => None,
    };
    // S5.4 CH3b — 자동 멘션 걸기·풀기·채널 문서 저장. 두 겹 잠금: `HARKROOM_CORE=rust` 그리고 쓰기 풀에 그 권한이 다 있을 때만.
    let auto_mention_doc = match (&core_mode, &state.write) {
        (harkroom_server::core::CoreMode::Rust, Some(w)) => {
            use harkroom_server::core::channel_auto_mention_doc as c;
            match write::missing_in(w, c::AUTO_MENTION_DOC_PRIVILEGES, &[]).await {
                Ok(m) if m.is_empty() => Some(w.clone()),
                Ok(m) => {
                    eprintln!("front: auto-mention/doc write core off — missing privileges {m:?}");
                    refuse_missing_grants(&m);
                    None
                }
                Err(e) => {
                    eprintln!(
                        "front: auto-mention/doc write core off — privilege check failed ({})",
                        e.as_database_error().map_or("io", |_| "db")
                    );
                    None
                }
            }
        }
        _ => None,
    };
    // S5.4 CH2 — 채널 읽음 상태 쓰기(`PUT /channels/{id}/read`·`/unread`). 두 겹 잠금: `HARKROOM_CORE=rust` 그리고 쓰기 풀에 그 칸 권한이 다 있을 때만.
    let channel_read_write = match (&core_mode, &state.write) {
        (harkroom_server::core::CoreMode::Rust, Some(w)) => {
            use harkroom_server::core::channel_read_write as c;
            match write::missing_in(w, c::CHANNEL_READ_WRITE_PRIVILEGES, &[]).await {
                Ok(m) if m.is_empty() => Some(w.clone()),
                Ok(m) => {
                    eprintln!("front: channel read write core off — missing privileges {m:?}");
                    refuse_missing_grants(&m);
                    None
                }
                Err(e) => {
                    eprintln!(
                        "front: channel read write core off — privilege check failed ({})",
                        e.as_database_error().map_or("io", |_| "db")
                    );
                    None
                }
            }
        }
        _ => None,
    };
    // S5.4 — `GET /agent/pr-watches/due`. 만료 UPDATE(`expireWatches`)를 하므로 쓰기 풀에 [`PR_WATCH_DUE_PRIVILEGES`] 가 다 있고,
    // `HARKROOM_DELEGATION_V2` 값이 있을 때만(없으면 TS 와 스위치 판정이 갈릴 수 있어 TS 에 남긴다).
    let pr_watch_due_write = match (&core_mode, &state.write) {
        (harkroom_server::core::CoreMode::Rust, Some(w))
            if std::env::var("HARKROOM_DELEGATION_V2").is_ok_and(|v| !v.trim().is_empty()) =>
        {
            use harkroom_server::core::pr_watch_due as t;
            match write::missing_in(w, t::PR_WATCH_DUE_PRIVILEGES, &[]).await {
                Ok(m) if m.is_empty() => Some(w.clone()),
                Ok(m) => {
                    eprintln!("front: pr-watches due core off — missing privileges {m:?}");
                    refuse_missing_grants(&m);
                    None
                }
                Err(e) => {
                    eprintln!(
                        "front: pr-watches due core off — privilege check failed ({})",
                        e.as_database_error().map_or("io", |_| "db")
                    );
                    None
                }
            }
        }
        _ => None,
    };
    // S5.4 — `POST /agent/merge-approvals/peek`. 읽기만 — 두 겹 잠금(`HARKROOM_CORE=rust` + 읽기 풀 SELECT).
    let merge_peek_on = match &core_mode {
        harkroom_server::core::CoreMode::Rust => {
            use harkroom_server::core::merge_approval_peek as t;
            match write::missing_in(&state.pool, t::MERGE_APPROVAL_PEEK_PRIVILEGES, &[]).await {
                Ok(m) if m.is_empty() => true,
                Ok(m) => {
                    eprintln!("front: merge approval peek core off — missing privileges {m:?}");
                    refuse_missing_grants(&m);
                    false
                }
                Err(e) => {
                    eprintln!(
                        "front: merge approval peek core off — privilege check failed ({})",
                        e.as_database_error().map_or("io", |_| "db")
                    );
                    false
                }
            }
        }
        _ => false,
    };
    // S5.4 — `POST /agents/{id}/merge-denials/{denialId}/grant`. 쓰기 풀에 [`MERGE_DENIAL_GRANT_PRIVILEGES`] 가 다 있을 때만.
    let merge_denial_grant_write = match (&core_mode, &state.write) {
        (harkroom_server::core::CoreMode::Rust, Some(w)) => {
            use harkroom_server::core::merge_denial_grant as t;
            match write::missing_in(w, t::MERGE_DENIAL_GRANT_PRIVILEGES, &[]).await {
                Ok(m) if m.is_empty() => Some(w.clone()),
                Ok(m) => {
                    eprintln!("front: merge denial grant core off — missing privileges {m:?}");
                    refuse_missing_grants(&m);
                    None
                }
                Err(e) => {
                    eprintln!(
                        "front: merge denial grant core off — privilege check failed ({})",
                        e.as_database_error().map_or("io", |_| "db")
                    );
                    None
                }
            }
        }
        _ => None,
    };
    // S5.4 — `POST /agent/merge-results` 의 N1 관문(읽기). 쓰기 풀에 [`MERGE_RESULTS_PRIVILEGES`] 가 다 있을 때만 — 아니면 403/400 만.
    let merge_results_read = match (&core_mode, &state.write) {
        (harkroom_server::core::CoreMode::Rust, Some(w)) => {
            use harkroom_server::core::merge_checks as t;
            match write::missing_in(w, t::MERGE_RESULTS_PRIVILEGES, &[]).await {
                Ok(m) if m.is_empty() => Some(w.clone()),
                Ok(m) => {
                    eprintln!("front: merge results gate off — missing privileges {m:?}");
                    refuse_missing_grants(&m);
                    None
                }
                Err(e) => {
                    eprintln!(
                        "front: merge results gate off — privilege check failed ({})",
                        e.as_database_error().map_or("io", |_| "db")
                    );
                    None
                }
            }
        }
        _ => None,
    };
    // S5.4 — `POST /agent/merge-checks` 의 이른 거절(`lease_invalid`·`bad_repo` + `repo.merge.denied` 감사). 쓰기 풀에 [`MERGE_CHECKS_DENY_PRIVILEGES`] 가 다 있을 때만.
    let merge_checks_deny = match (&core_mode, &state.write) {
        (harkroom_server::core::CoreMode::Rust, Some(w)) => {
            use harkroom_server::core::merge_checks as t;
            match write::missing_in(w, t::MERGE_CHECKS_DENY_PRIVILEGES, &[]).await {
                Ok(m) if m.is_empty() => Some(w.clone()),
                Ok(m) => {
                    eprintln!("front: merge checks deny off — missing privileges {m:?}");
                    refuse_missing_grants(&m);
                    None
                }
                Err(e) => {
                    eprintln!(
                        "front: merge checks deny off — privilege check failed ({})",
                        e.as_database_error().map_or("io", |_| "db")
                    );
                    None
                }
            }
        }
        _ => None,
    };
    // S5.4 — `POST /agent/merge-checks` 의 흔한 허락 길. 이른 거절이 켜졌고 [`MERGE_CHECKS_ALLOW_PRIVILEGES`] 까지 있을 때만.
    let merge_checks_allow = match &merge_checks_deny {
        Some(w) => {
            use harkroom_server::core::merge_checks as t;
            match write::missing_in(w, t::MERGE_CHECKS_ALLOW_PRIVILEGES, &[]).await {
                Ok(m) if m.is_empty() => Some(w.clone()),
                Ok(m) => {
                    eprintln!("front: merge checks allow off — missing privileges {m:?}");
                    refuse_missing_grants(&m);
                    None
                }
                Err(e) => {
                    eprintln!(
                        "front: merge checks allow off — privilege check failed ({})",
                        e.as_database_error().map_or("io", |_| "db")
                    );
                    None
                }
            }
        }
        None => None,
    };
    // S5.4 — `POST /agent/merge-checks` 의 `not_granted` 거절(카드용 `merge_denial`·`denialId`). 허락 길이 켜졌고 [`MERGE_CHECKS_CARD_PRIVILEGES`] 까지 있을 때만.
    let merge_checks_card = match &merge_checks_allow {
        Some(w) => {
            use harkroom_server::core::merge_checks as t;
            match write::missing_in(w, t::MERGE_CHECKS_CARD_PRIVILEGES, &[]).await {
                Ok(m) if m.is_empty() => Some(w.clone()),
                Ok(m) => {
                    eprintln!("front: merge checks card off — missing privileges {m:?}");
                    refuse_missing_grants(&m);
                    None
                }
                Err(e) => {
                    eprintln!(
                        "front: merge checks card off — privilege check failed ({})",
                        e.as_database_error().map_or("io", |_| "db")
                    );
                    None
                }
            }
        }
        None => None,
    };
    // S5.4 — `POST /agent/api-checks` 의 임대 거절(`lease_invalid` + `api.call.denied` 감사). 쓰기 풀에 [`API_CHECKS_DENY_PRIVILEGES`] 가 다 있을 때만.
    let api_checks_deny = match (&core_mode, &state.write) {
        (harkroom_server::core::CoreMode::Rust, Some(w)) => {
            use harkroom_server::core::api_checks as t;
            match write::missing_in(w, t::API_CHECKS_DENY_PRIVILEGES, &[]).await {
                Ok(m) if m.is_empty() => Some(w.clone()),
                Ok(m) => {
                    eprintln!("front: api checks deny off — missing privileges {m:?}");
                    refuse_missing_grants(&m);
                    None
                }
                Err(e) => {
                    eprintln!(
                        "front: api checks deny off — privilege check failed ({})",
                        e.as_database_error().map_or("io", |_| "db")
                    );
                    None
                }
            }
        }
        _ => None,
    };
    // S5.4 — `POST /agent/merge-closed`. 쓰기 풀에 [`MERGE_CLOSED_PRIVILEGES`] 가 다 있을 때만.
    let merge_closed_write = match (&core_mode, &state.write) {
        (harkroom_server::core::CoreMode::Rust, Some(w)) => {
            use harkroom_server::core::merge_closed as t;
            match write::missing_in(w, t::MERGE_CLOSED_PRIVILEGES, &[]).await {
                Ok(m) if m.is_empty() => Some(w.clone()),
                Ok(m) => {
                    eprintln!("front: merge closed core off — missing privileges {m:?}");
                    refuse_missing_grants(&m);
                    None
                }
                Err(e) => {
                    eprintln!(
                        "front: merge closed core off — privilege check failed ({})",
                        e.as_database_error().map_or("io", |_| "db")
                    );
                    None
                }
            }
        }
        _ => None,
    };
    // S5.4 — `GET /link-previews`. 같은 두 겹 잠금(읽기 풀 칸 SELECT). 만료된 행은 TS 로 넘긴다(재가져오기).
    let link_preview_read_on = match &core_mode {
        harkroom_server::core::CoreMode::Rust => {
            use harkroom_server::core::link_preview_read as t;
            match write::missing_in(&state.pool, t::LINK_PREVIEW_READ_PRIVILEGES, &[]).await {
                Ok(m) if m.is_empty() => true,
                Ok(m) => {
                    eprintln!("front: link preview read core off — missing privileges {m:?}");
                    false
                }
                Err(e) => {
                    eprintln!(
                        "front: link preview read core off — privilege check failed ({})",
                        e.as_database_error().map_or("io", |_| "db")
                    );
                    false
                }
            }
        }
        _ => false,
    };
    // S5.4 — `GET /agent-wakes`. 같은 두 겹 잠금(읽기 풀 SELECT).
    let agent_wakes_read_on = match &core_mode {
        harkroom_server::core::CoreMode::Rust => {
            use harkroom_server::core::agent_wakes_read as t;
            match write::missing_in(&state.pool, t::AGENT_WAKES_READ_PRIVILEGES, &[]).await {
                Ok(m) if m.is_empty() => true,
                Ok(m) => {
                    eprintln!("front: agent wakes read core off — missing privileges {m:?}");
                    refuse_missing_grants(&m);
                    false
                }
                Err(e) => {
                    eprintln!(
                        "front: agent wakes read core off — privilege check failed ({})",
                        e.as_database_error().map_or("io", |_| "db")
                    );
                    false
                }
            }
        }
        _ => false,
    };
    // S5.4 AG1 — `GET /agent/merge-grants`·`/agent/api-grants`·`/agent/thread-model`. 두 겹 잠금: `HARKROOM_CORE=rust` 그리고
    // 읽기 풀에 그 SELECT 가 다 있을 때만. `/agent/pr-watches/due` 는 만료 UPDATE 가 있어 쓰기 풀로 따로 켠다(`pr_watch_due_write`).
    let agent_grants_read_on = match &core_mode {
        harkroom_server::core::CoreMode::Rust => {
            use harkroom_server::core::agent_grants_read as t;
            match write::missing_in(&state.pool, t::AGENT_GRANTS_READ_PRIVILEGES, &[]).await {
                Ok(m) if m.is_empty() => true,
                Ok(m) => {
                    eprintln!("front: agent grants read core off — missing privileges {m:?}");
                    refuse_missing_grants(&m);
                    false
                }
                Err(e) => {
                    eprintln!(
                        "front: agent grants read core off — privilege check failed ({})",
                        e.as_database_error().map_or("io", |_| "db")
                    );
                    false
                }
            }
        }
        _ => false,
    };
    // S5.4 AC2 — `GET /accounts/agents/{id}/memory`·`…/memory/{slug}/revisions`·`…/background/runs/{runId}`. 두 겹 잠금: `HARKROOM_CORE=rust` 그리고 읽기 풀에 그 SELECT 가 다 있을 때만. `…/background`(목록)도 함께. 정리 후보는 `agent_memory_audit_read`, 기억 쓰기는 `agent_memory_write`.
    let agent_memory_read_on = match &core_mode {
        harkroom_server::core::CoreMode::Rust => {
            use harkroom_server::core::agent_memory_read as t;
            match write::missing_in(&state.pool, t::AGENT_MEMORY_READ_PRIVILEGES, &[]).await {
                Ok(m) if m.is_empty() => true,
                Ok(m) => {
                    eprintln!("front: agent memory read core off — missing privileges {m:?}");
                    refuse_missing_grants(&m);
                    false
                }
                Err(e) => {
                    eprintln!(
                        "front: agent memory read core off — privilege check failed ({})",
                        e.as_database_error().map_or("io", |_| "db")
                    );
                    false
                }
            }
        }
        _ => false,
    };
    // S5.4 — 자기 비밀번호 바꾸기(`POST /auth/password`). 쓰기 풀에 그 권한이 다 있을 때만 — 아니면 TS 에 남는다.
    let auth_password_write = match (&core_mode, &state.write) {
        (harkroom_server::core::CoreMode::Rust, Some(w)) => {
            use harkroom_server::core::auth_password as a;
            match write::missing_in(w, a::AUTH_PASSWORD_PRIVILEGES, &[]).await {
                Ok(m) if m.is_empty() => Some(w.clone()),
                Ok(m) => {
                    eprintln!("front: auth password core off — missing privileges {m:?}");
                    refuse_missing_grants(&m);
                    None
                }
                Err(e) => {
                    eprintln!(
                        "front: auth password core off — privilege check failed ({})",
                        e.as_database_error().map_or("io", |_| "db")
                    );
                    None
                }
            }
        }
        _ => None,
    };
    // S5.4 — 재설정 코드 발급(`POST /accounts/{id}/password-reset-code`). 쓰기 풀에 그 권한이 다 있을 때만 — 아니면 TS 에 남는다.
    let account_reset_code_issue_write = match (&core_mode, &state.write) {
        (harkroom_server::core::CoreMode::Rust, Some(w)) => {
            use harkroom_server::core::account_reset_code_issue as a;
            match write::missing_in(w, a::ACCOUNT_RESET_CODE_ISSUE_PRIVILEGES, &[]).await {
                Ok(m) if m.is_empty() => Some(w.clone()),
                Ok(m) => {
                    eprintln!(
                        "front: account reset code issue core off — missing privileges {m:?}"
                    );
                    refuse_missing_grants(&m);
                    None
                }
                Err(e) => {
                    eprintln!(
                        "front: account reset code issue core off — privilege check failed ({})",
                        e.as_database_error().map_or("io", |_| "db")
                    );
                    None
                }
            }
        }
        _ => None,
    };
    // S5.4 — 역할 바꾸기(`PUT /accounts/{id}/role`). 쓰기 풀에 그 권한이 다 있을 때만 — 아니면 TS 에 남는다.
    let account_role_write = match (&core_mode, &state.write) {
        (harkroom_server::core::CoreMode::Rust, Some(w)) => {
            use harkroom_server::core::account_role as a;
            match write::missing_in(w, a::ACCOUNT_ROLE_PRIVILEGES, &[]).await {
                Ok(m) if m.is_empty() => Some(w.clone()),
                Ok(m) => {
                    eprintln!("front: account role core off — missing privileges {m:?}");
                    refuse_missing_grants(&m);
                    None
                }
                Err(e) => {
                    eprintln!(
                        "front: account role core off — privilege check failed ({})",
                        e.as_database_error().map_or("io", |_| "db")
                    );
                    None
                }
            }
        }
        _ => None,
    };
    // S5.4 — grant 주기(`PUT /accounts/{id}/grants`, api.call·tool.allow 는 안에서 TS 로). 쓰기 풀에 그 권한이 다 있을 때만.
    let account_grant_give_write = match (&core_mode, &state.write) {
        (harkroom_server::core::CoreMode::Rust, Some(w)) => {
            use harkroom_server::core::account_grant_give as a;
            match write::missing_in(w, a::ACCOUNT_GRANT_GIVE_PRIVILEGES, &[]).await {
                Ok(m) if m.is_empty() => Some(w.clone()),
                Ok(m) => {
                    eprintln!("front: account grant give core off — missing privileges {m:?}");
                    refuse_missing_grants(&m);
                    None
                }
                Err(e) => {
                    eprintln!(
                        "front: account grant give core off — privilege check failed ({})",
                        e.as_database_error().map_or("io", |_| "db")
                    );
                    None
                }
            }
        }
        _ => None,
    };
    // S5.4 — grant 거두기(`DELETE /accounts/{id}/grants/{capability}`). 쓰기 풀에 그 권한이 다 있을 때만 — 아니면 TS 에 남는다.
    let account_grant_revoke_write = match (&core_mode, &state.write) {
        (harkroom_server::core::CoreMode::Rust, Some(w)) => {
            use harkroom_server::core::account_grant_revoke as a;
            match write::missing_in(w, a::ACCOUNT_GRANT_REVOKE_PRIVILEGES, &[]).await {
                Ok(m) if m.is_empty() => Some(w.clone()),
                Ok(m) => {
                    eprintln!("front: account grant revoke core off — missing privileges {m:?}");
                    refuse_missing_grants(&m);
                    None
                }
                Err(e) => {
                    eprintln!(
                        "front: account grant revoke core off — privilege check failed ({})",
                        e.as_database_error().map_or("io", |_| "db")
                    );
                    None
                }
            }
        }
        _ => None,
    };
    // S5.4 — 재설정 코드 거두기(`DELETE /accounts/{id}/password-reset-code`). 쓰기 풀에 그 권한이 다 있을 때만 — 아니면 TS 에 남는다.
    let account_reset_code_revoke_write = match (&core_mode, &state.write) {
        (harkroom_server::core::CoreMode::Rust, Some(w)) => {
            use harkroom_server::core::account_reset_code_revoke as a;
            match write::missing_in(w, a::ACCOUNT_RESET_CODE_REVOKE_PRIVILEGES, &[]).await {
                Ok(m) if m.is_empty() => Some(w.clone()),
                Ok(m) => {
                    eprintln!(
                        "front: account reset code revoke core off — missing privileges {m:?}"
                    );
                    refuse_missing_grants(&m);
                    None
                }
                Err(e) => {
                    eprintln!(
                        "front: account reset code revoke core off — privilege check failed ({})",
                        e.as_database_error().map_or("io", |_| "db")
                    );
                    None
                }
            }
        }
        _ => None,
    };
    // S5.4 — 에이전트 지우기(`DELETE /accounts/agents/{id}`). 세 겹 잠금: `HARKROOM_CORE=rust`, 첨부 저장소, 쓰기 풀에 그 권한이 다 있을 때만.
    let agent_delete_write = match (&core_mode, &state.write, &avatar_read) {
        (harkroom_server::core::CoreMode::Rust, Some(w), Some(storage)) => {
            use harkroom_server::core::agent_delete as a;
            match write::missing_in(w, a::AGENT_DELETE_PRIVILEGES, &[]).await {
                Ok(m) if m.is_empty() => Some((w.clone(), storage.clone())),
                Ok(m) => {
                    eprintln!("front: agent delete core off — missing privileges {m:?}");
                    refuse_missing_grants(&m);
                    None
                }
                Err(e) => {
                    eprintln!(
                        "front: agent delete core off — privilege check failed ({})",
                        e.as_database_error().map_or("io", |_| "db")
                    );
                    None
                }
            }
        }
        _ => None,
    };
    // S5.4 — 에이전트 고치기(PATCH) 성공 길(설정·스위치 칸만). 쓰기 풀에 그 권한이 다 있을 때만 — 아니면 TS.
    let agent_patch_write = match &core_mode {
        harkroom_server::core::CoreMode::Rust => match &state.write {
            Some(w) => match write::missing_in(
                w,
                harkroom_server::core::agent_create::AGENT_PATCH_PRIVILEGES,
                &[],
            )
            .await
            {
                Ok(m) if m.is_empty() => Some(w.clone()),
                Ok(m) => {
                    eprintln!("front: agent patch core write off — missing privileges {m:?}");
                    None
                }
                Err(e) => {
                    eprintln!(
                        "front: agent patch core write off — privilege check failed ({})",
                        e.as_database_error().map_or("io", |_| "db")
                    );
                    None
                }
            },
            None => None,
        },
        _ => None,
    };
    // S5.4 — 에이전트 PATCH 의 이름 바꾸기(`handle`). 패치 쓰기가 켜졌고 이름 권한도 다 있을 때만 — 아니면 TS.
    let agent_patch_rename = match &agent_patch_write {
        Some(w) => match write::missing_in(
            w,
            harkroom_server::core::agent_create::AGENT_RENAME_PRIVILEGES,
            harkroom_server::core::agent_create::AGENT_RENAME_SEQUENCE_PRIVILEGES,
        )
        .await
        {
            Ok(m) if m.is_empty() => true,
            Ok(m) => {
                eprintln!("front: agent rename core write off — missing privileges {m:?}");
                false
            }
            Err(e) => {
                eprintln!("front: agent rename core write off — privilege check failed ({e})");
                false
            }
        },
        None => false,
    };
    let agent_patch_disable = match &agent_patch_write {
        Some(w) => match write::missing_in(
            w,
            harkroom_server::core::agent_create::AGENT_DISABLE_PRIVILEGES,
            &[],
        )
        .await
        {
            Ok(m) if m.is_empty() => true,
            Ok(m) => {
                eprintln!("front: agent disable core write off — missing privileges {m:?}");
                false
            }
            Err(e) => {
                eprintln!("front: agent disable core write off — privilege check failed ({e})");
                false
            }
        },
        None => false,
    };
    // S5.4 — 에이전트 만들기 성공 길. 쓰기 풀에 그 권한이 다 있을 때만 — 아니면 판정만 Rust, 생성은 TS.
    let agent_create_write = match &core_mode {
        harkroom_server::core::CoreMode::Rust => match &state.write {
            Some(w) => match write::missing_in(
                w,
                harkroom_server::core::agent_create::AGENT_CREATE_PRIVILEGES,
                &[],
            )
            .await
            {
                Ok(m) if m.is_empty() => Some(w.clone()),
                Ok(m) => {
                    eprintln!("front: agent create core write off — missing privileges {m:?}");
                    None
                }
                Err(e) => {
                    eprintln!(
                        "front: agent create core write off — privilege check failed ({})",
                        e.as_database_error().map_or("io", |_| "db")
                    );
                    None
                }
            },
            None => None,
        },
        _ => None,
    };
    // S5.4 — 기억 정리 후보(`GET /accounts/agents/{id}/memory/audit`). 두 겹 잠금: `HARKROOM_CORE=rust` 그리고 읽기 풀에 그 SELECT 가 다 있을 때만.
    let agent_memory_audit_read_on = match &core_mode {
        harkroom_server::core::CoreMode::Rust => {
            use harkroom_server::core::agent_memory_audit_read as t;
            match write::missing_in(&state.pool, t::AGENT_MEMORY_AUDIT_READ_PRIVILEGES, &[]).await {
                Ok(m) if m.is_empty() => true,
                Ok(m) => {
                    eprintln!("front: agent memory audit read core off — missing privileges {m:?}");
                    refuse_missing_grants(&m);
                    false
                }
                Err(e) => {
                    eprintln!(
                        "front: agent memory audit read core off — privilege check failed ({})",
                        e.as_database_error().map_or("io", |_| "db")
                    );
                    false
                }
            }
        }
        _ => false,
    };
    // S5.4 — 로그인 ID 읽기(`GET /accounts/login-ids`). 쓰기 풀에 감사 INSERT 가 있을 때만 — 아니면 TS 에 남는다.
    let account_login_ids_write = match (&core_mode, &state.write) {
        (harkroom_server::core::CoreMode::Rust, Some(w)) => {
            use harkroom_server::core::account_login_ids as a;
            match write::missing_in(w, a::ACCOUNT_LOGIN_IDS_PRIVILEGES, &[]).await {
                Ok(m) if m.is_empty() => Some(w.clone()),
                Ok(m) => {
                    eprintln!("front: account login ids core off — missing privileges {m:?}");
                    refuse_missing_grants(&m);
                    None
                }
                Err(e) => {
                    eprintln!(
                        "front: account login ids core off — privilege check failed ({})",
                        e.as_database_error().map_or("io", |_| "db")
                    );
                    None
                }
            }
        }
        _ => None,
    };
    // S5.4 — 고를 수 있는 모델 목록 쓰기(`PUT /accounts/agents/{id}/pickable-models`, `clearOutside: true` 는 글 코어가 없을 때만 TS 로).
    // 두 겹 잠금: `HARKROOM_CORE=rust` 그리고 쓰기 풀에 그 칸 권한이 다 있을 때만.
    let pickable_models_write = match (&core_mode, &state.write) {
        (harkroom_server::core::CoreMode::Rust, Some(w)) => {
            use harkroom_server::core::pickable_models as a;
            match write::missing_in(w, a::PICKABLE_MODELS_PRIVILEGES, &[]).await {
                Ok(m) if m.is_empty() => Some(w.clone()),
                Ok(m) => {
                    eprintln!("front: pickable models core off — missing privileges {m:?}");
                    refuse_missing_grants(&m);
                    None
                }
                Err(e) => {
                    eprintln!(
                        "front: pickable models core off — privilege check failed ({})",
                        e.as_database_error().map_or("io", |_| "db")
                    );
                    None
                }
            }
        }
        _ => None,
    };
    // S5.4 — 보관소 잠그기(`DELETE /auth/step-up`). 쓰기 풀에 세션의 창 칸 UPDATE 가 있을 때만 — 아니면 TS 에 남는다.
    let step_up_end_write = match (&core_mode, &state.write) {
        (harkroom_server::core::CoreMode::Rust, Some(w)) => {
            use harkroom_server::core::step_up_end as a;
            match write::missing_in(w, a::STEP_UP_END_PRIVILEGES, &[]).await {
                Ok(m) if m.is_empty() => Some(w.clone()),
                Ok(m) => {
                    eprintln!("front: step-up end core off — missing privileges {m:?}");
                    refuse_missing_grants(&m);
                    None
                }
                Err(e) => {
                    eprintln!(
                        "front: step-up end core off — privilege check failed ({})",
                        e.as_database_error().map_or("io", |_| "db")
                    );
                    None
                }
            }
        }
        _ => None,
    };
    // S5.4 — 로그인(`POST /auth/login`). 쓰기 풀에 계정 조회·세션 INSERT·감사 INSERT 칸 권한이 있을 때만 — 아니면 TS 에 남는다.
    // 리밋 키(`login:*`·`loginAccountIp:*`·`loginAccount:*`)는 이 경로만 쓰므로 통째로 Rust 리미터로 옮겨 간다.
    let auth_login_write = match (&core_mode, &state.write) {
        (harkroom_server::core::CoreMode::Rust, Some(w)) => {
            use harkroom_server::core::auth_login as a;
            match write::missing_in(w, a::AUTH_LOGIN_PRIVILEGES, &[]).await {
                Ok(m) if m.is_empty() => Some(w.clone()),
                Ok(m) => {
                    eprintln!("front: auth login core off — missing privileges {m:?}");
                    refuse_missing_grants(&m);
                    None
                }
                Err(e) => {
                    eprintln!(
                        "front: auth login core off — privilege check failed ({})",
                        e.as_database_error().map_or("io", |_| "db")
                    );
                    None
                }
            }
        }
        _ => None,
    };
    // S5.4 — 가입 표면 셋(`POST /bootstrap`·`/claim`·`/auth/register`). 셋이 `signup:{ip}` 리밋 키를 나눠 쓰므로 권한 하나로 묶어
    // 셋을 같이 옮기거나 셋 다 TS 에 남긴다 — 일부만 옮기면 두 리미터가 따로 세어 한도가 두 배가 된다.
    let auth_signup_write = match (&core_mode, &state.write) {
        (harkroom_server::core::CoreMode::Rust, Some(w)) => {
            use harkroom_server::core::auth_signup as a;
            match write::missing_in(w, a::AUTH_SIGNUP_PRIVILEGES, &[]).await {
                Ok(m) if m.is_empty() => Some(w.clone()),
                Ok(m) => {
                    eprintln!("front: auth signup core off — missing privileges {m:?}");
                    refuse_missing_grants(&m);
                    None
                }
                Err(e) => {
                    eprintln!(
                        "front: auth signup core off — privilege check failed ({})",
                        e.as_database_error().map_or("io", |_| "db")
                    );
                    None
                }
            }
        }
        _ => None,
    };
    // S5.4 — 재설정 코드 쓰기(`POST /auth/password-reset`). 권한이 있을 때만 — 아니면 TS 에 남는다.
    // 리밋 키 `passwordReset:*`(주소·로그인 ID 둘 다)는 이 경로만 쓰므로 통째로 Rust 리미터로 옮겨 간다.
    let password_reset_use_write = match (&core_mode, &state.write) {
        (harkroom_server::core::CoreMode::Rust, Some(w)) => {
            use harkroom_server::core::password_reset_use as a;
            match write::missing_in(w, a::PASSWORD_RESET_USE_PRIVILEGES, &[]).await {
                Ok(m) if m.is_empty() => Some(w.clone()),
                Ok(m) => {
                    eprintln!("front: password reset core off — missing privileges {m:?}");
                    refuse_missing_grants(&m);
                    None
                }
                Err(e) => {
                    eprintln!(
                        "front: password reset core off — privilege check failed ({})",
                        e.as_database_error().map_or("io", |_| "db")
                    );
                    None
                }
            }
        }
        _ => None,
    };
    // S5.4 — 보관소 잠금 해제(`POST /auth/step-up`). 쓰기 풀에 계정 해시 SELECT·세션 창 UPDATE·감사 INSERT 칸 권한이 있을 때만 — 아니면 TS 에 남는다.
    let step_up_open_write = match (&core_mode, &state.write) {
        (harkroom_server::core::CoreMode::Rust, Some(w)) => {
            use harkroom_server::core::step_up_open as a;
            match write::missing_in(w, a::STEP_UP_OPEN_PRIVILEGES, &[]).await {
                Ok(m) if m.is_empty() => Some(w.clone()),
                Ok(m) => {
                    eprintln!("front: step-up open core off — missing privileges {m:?}");
                    refuse_missing_grants(&m);
                    None
                }
                Err(e) => {
                    eprintln!(
                        "front: step-up open core off — privilege check failed ({})",
                        e.as_database_error().map_or("io", |_| "db")
                    );
                    None
                }
            }
        }
        _ => None,
    };
    // S5.4 — 계정 권한 목록 읽기(`GET /accounts/{id}/grants`). 읽기 풀에 SELECT 가 있을 때만 — 아니면 TS 에 남는다.
    let account_grants_read_on = match &core_mode {
        harkroom_server::core::CoreMode::Rust => {
            use harkroom_server::core::account_grants_read as t;
            match write::missing_in(&state.pool, t::ACCOUNT_GRANTS_READ_PRIVILEGES, &[]).await {
                Ok(m) if m.is_empty() => true,
                Ok(m) => {
                    eprintln!("front: account grants read core off — missing privileges {m:?}");
                    refuse_missing_grants(&m);
                    false
                }
                Err(e) => {
                    eprintln!(
                        "front: account grants read core off — privilege check failed ({})",
                        e.as_database_error().map_or("io", |_| "db")
                    );
                    false
                }
            }
        }
        _ => false,
    };
    // S5.4 MS1 — 저장한 글 다섯 줄(`GET /saved`·`/saved/summary`, `PUT`·`PATCH`·`DELETE /saved/{messageId}`). 두 겹 잠금:
    // `HARKROOM_CORE=rust` 그리고 읽기 풀·쓰기 풀에 그 권한이 다 있을 때만 — 아니면 다섯 줄 모두 TS 에 남는다.
    let saved_write = match (&core_mode, &state.write) {
        (harkroom_server::core::CoreMode::Rust, Some(w)) => {
            use harkroom_server::core::saved as sv;
            let r = async {
                let mut m =
                    write::missing_in(w, sv::SAVED_PRIVILEGES, sv::SAVED_SEQUENCE_PRIVILEGES)
                        .await?;
                m.extend(write::missing_in(&state.pool, sv::SAVED_READ_PRIVILEGES, &[]).await?);
                Ok::<_, sqlx::Error>(m)
            }
            .await;
            match r {
                Ok(m) if m.is_empty() => Some(w.clone()),
                Ok(m) => {
                    eprintln!("front: saved messages core off — missing privileges {m:?}");
                    refuse_missing_grants(&m);
                    None
                }
                Err(e) => {
                    eprintln!(
                        "front: saved messages core off — privilege check failed ({})",
                        e.as_database_error().map_or("io", |_| "db")
                    );
                    None
                }
            }
        }
        _ => None,
    };
    // C3b-2b-2 — MCP `message.askBundle` 있던 묶음에 줄 더하기. 두 겹 잠금: `HARKROOM_CORE=rust` 그리고 묶음 푸시까지 그 권한이 다 있을 때만.
    let bundle_write = match (&core_mode, &state.write) {
        (harkroom_server::core::CoreMode::Rust, Some(w)) => {
            use harkroom_server::core::ask_bundle_add as b;
            match write::missing_in(
                w,
                b::ASK_BUNDLE_ADD_PRIVILEGES,
                b::ASK_BUNDLE_ADD_SEQUENCE_PRIVILEGES,
            )
            .await
            {
                Ok(m) if m.is_empty() => Some(w.clone()),
                Ok(m) => {
                    eprintln!("front: ask bundle add core off — missing privileges {m:?}");
                    refuse_missing_grants(&m);
                    None
                }
                Err(e) => {
                    eprintln!(
                        "front: ask bundle add core off — privilege check failed ({})",
                        e.as_database_error().map_or("io", |_| "db")
                    );
                    None
                }
            }
        }
        _ => None,
    };
    // C4b — MCP `delegation.close` 의 쓰기(`writes::DELEGATION_CLOSE_PRIVILEGES`). 다 있을 때만 — 아니면 그 도구는 TS 가 답한다.
    let mcp_deleg_write = match (&core_mode, &state.write) {
        (harkroom_server::core::CoreMode::Rust, Some(w)) => {
            use harkroom_server::core::mcp::writes as mw;
            match write::missing_in(w, mw::DELEGATION_CLOSE_PRIVILEGES, &[]).await {
                Ok(m) if m.is_empty() => Some(w.clone()),
                Ok(m) => {
                    eprintln!("front: mcp delegation.close off — missing privileges {m:?}");
                    refuse_missing_grants(&m);
                    None
                }
                Err(e) => {
                    eprintln!(
                        "front: mcp delegation.close off — privilege check failed ({})",
                        e.as_database_error().map_or("io", |_| "db")
                    );
                    None
                }
            }
        }
        _ => None,
    };
    // S5.4 — MCP `inbox.poll` 의 `version` 기록(TS `recordRunnerVersion`). 쓰기 풀에 `RUNNER_VERSION_PRIVILEGES` 가 다 있을 때만 — 아니면 TS.
    let runner_version_write = match (&core_mode, &state.write) {
        (harkroom_server::core::CoreMode::Rust, Some(w)) => {
            match write::missing_in(
                w,
                harkroom_server::core::mcp::inbox_poll::RUNNER_VERSION_PRIVILEGES,
                &[],
            )
            .await
            {
                Ok(m) if m.is_empty() => Some(w.clone()),
                Ok(m) => {
                    eprintln!("front: mcp inbox.poll version off — missing privileges {m:?}");
                    refuse_missing_grants(&m);
                    None
                }
                Err(e) => {
                    eprintln!(
                        "front: mcp inbox.poll version off — privilege check failed ({})",
                        e.as_database_error().map_or("io", |_| "db")
                    );
                    None
                }
            }
        }
        _ => None,
    };
    // S5.4 — MCP `inbox.poll` 의 `lease` 임대(TS `leaseInboxEntries`). 쓰기 풀에 `INBOX_LEASE_PRIVILEGES` 가 다 있을 때만 — 아니면 TS.
    let inbox_lease_write = match (&core_mode, &state.write) {
        (harkroom_server::core::CoreMode::Rust, Some(w)) => {
            match write::missing_in(
                w,
                harkroom_server::core::mcp::inbox_poll::INBOX_LEASE_PRIVILEGES,
                &[],
            )
            .await
            {
                Ok(m) if m.is_empty() => Some(w.clone()),
                Ok(m) => {
                    eprintln!("front: mcp inbox.poll lease off — missing privileges {m:?}");
                    refuse_missing_grants(&m);
                    None
                }
                Err(e) => {
                    eprintln!(
                        "front: mcp inbox.poll lease off — privilege check failed ({})",
                        e.as_database_error().map_or("io", |_| "db")
                    );
                    None
                }
            }
        }
        _ => None,
    };
    // C4b B1a — MCP 기억 쓰기(memory.get·recalled·lease·archive·unarchive). `HARKROOM_CORE=rust` 그리고 쓰기 풀에 그 권한이 다 있을 때만.
    let mem_write = match (&core_mode, &state.write) {
        (harkroom_server::core::CoreMode::Rust, Some(w)) => {
            use harkroom_server::core::mcp::mem_writes as m;
            match write::missing_in(
                w,
                m::MEMORY_WRITE_PRIVILEGES,
                m::MEMORY_WRITE_SEQUENCE_PRIVILEGES,
            )
            .await
            {
                Ok(m) if m.is_empty() => Some(w.clone()),
                Ok(m) => {
                    eprintln!("front: mcp memory writes off — missing privileges {m:?}");
                    refuse_missing_grants(&m);
                    None
                }
                Err(e) => {
                    eprintln!(
                        "front: mcp memory writes off — privilege check failed ({})",
                        e.as_database_error().map_or("io", |_| "db")
                    );
                    None
                }
            }
        }
        _ => None,
    };
    // C4b B1b — MCP 기억 본문 쓰기(memory.set·merge·restore). B1a 풀이 섰고 쓰기 풀에 `MEMORY_BODY_PRIVILEGES` 도 다 있을 때만.
    let mem_body_write = match &mem_write {
        Some(w) => {
            use harkroom_server::core::mcp::mem_body as b;
            match write::missing_in(w, b::MEMORY_BODY_PRIVILEGES, &[]).await {
                Ok(m) if m.is_empty() => Some(w.clone()),
                Ok(m) => {
                    eprintln!("front: mcp memory body writes off — missing privileges {m:?}");
                    refuse_missing_grants(&m);
                    None
                }
                Err(e) => {
                    eprintln!(
                        "front: mcp memory body writes off — privilege check failed ({})",
                        e.as_database_error().map_or("io", |_| "db")
                    );
                    None
                }
            }
        }
        None => None,
    };
    // S5.4 AC3 — 사람이 에이전트 기억을 고치는 다섯 줄과 백그라운드 켜고 끄기. 기억 읽기 줄과 MCP 기억 본문 쓰기 풀이 섰고
    // 쓰기 풀에 `AGENT_MEMORY_WRITE_PRIVILEGES` 도 다 있을 때만 — 아니면 여섯 줄 모두 TS 에 남는다(fail-closed).
    let agent_memory_write = match (&mem_body_write, agent_memory_read_on) {
        (Some(w), true) => {
            use harkroom_server::core::agent_memory_write as a;
            match write::missing_in(w, a::AGENT_MEMORY_WRITE_PRIVILEGES, &[]).await {
                Ok(m) if m.is_empty() => Some(w.clone()),
                Ok(m) => {
                    eprintln!("front: agent memory write core off — missing privileges {m:?}");
                    refuse_missing_grants(&m);
                    None
                }
                Err(e) => {
                    eprintln!(
                        "front: agent memory write core off — privilege check failed ({})",
                        e.as_database_error().map_or("io", |_| "db")
                    );
                    None
                }
            }
        }
        _ => None,
    };
    // C3b-1 — 선택 카드 답하기·닫기. 두 겹 잠금: `HARKROOM_CORE=rust` 그리고 쓰기 풀에 `ASK_PRIVILEGES` 가 다 있을 때만.
    // C4b B2-1 — MCP `thread.note`. 두 겹 잠금: `HARKROOM_CORE=rust` 그리고 쓰기 풀에 `THREAD_NOTE_PRIVILEGES` 가 다 있을 때만.
    let note_write = match (&core_mode, &state.write) {
        (harkroom_server::core::CoreMode::Rust, Some(w)) => {
            use harkroom_server::core::mcp::note as n;
            match write::missing_in(w, n::THREAD_NOTE_PRIVILEGES, &[]).await {
                Ok(m) if m.is_empty() => Some(w.clone()),
                Ok(m) => {
                    eprintln!("front: thread note core off — missing privileges {m:?}");
                    refuse_missing_grants(&m);
                    None
                }
                Err(e) => {
                    eprintln!(
                        "front: thread note core off — privilege check failed ({})",
                        e.as_database_error().map_or("io", |_| "db")
                    );
                    None
                }
            }
        }
        _ => None,
    };
    // S5.4 A4b2 — MCP `thread.plan` 쓰기·`thread.plan.item`. 세 겹 잠금: `HARKROOM_CORE=rust`, 계획 읽기가 켜짐(루트·가시성 판정을 같이 쓴다),
    // 쓰기 풀에 `PLAN_WRITE_PRIVILEGES` 가 다 있을 때만. 없으면 TS 가 답한다.
    let plan_write = match (&core_mode, &state.write) {
        (harkroom_server::core::CoreMode::Rust, Some(w)) if thread_plan_read_on => {
            use harkroom_server::core::mcp::plan_write as p;
            match write::missing_in(
                w,
                p::PLAN_WRITE_PRIVILEGES,
                p::PLAN_WRITE_SEQUENCE_PRIVILEGES,
            )
            .await
            {
                Ok(m) if m.is_empty() => Some(w.clone()),
                Ok(m) => {
                    eprintln!("front: thread plan write core off — missing privileges {m:?}");
                    refuse_missing_grants(&m);
                    None
                }
                Err(e) => {
                    eprintln!(
                        "front: thread plan write core off — privilege check failed ({})",
                        e.as_database_error().map_or("io", |_| "db")
                    );
                    None
                }
            }
        }
        _ => None,
    };
    let ask_write = match (&core_mode, &state.write) {
        (harkroom_server::core::CoreMode::Rust, Some(w)) => {
            use harkroom_server::core::ask as a;
            match write::missing_in(w, a::ASK_PRIVILEGES, a::ASK_SEQUENCE_PRIVILEGES).await {
                Ok(m) if m.is_empty() => Some(w.clone()),
                Ok(m) => {
                    eprintln!("front: ask card core off — missing privileges {m:?}");
                    refuse_missing_grants(&m);
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
    // C3b-3c — 권한 카드 거절. 세 겹: 선택 카드 코어(`HARKROOM_CORE=rust` + `ASK_PRIVILEGES`) 그리고 거절 두 겹 검사
    // (`DENY_PRIVILEGES` 칸 + 잠금 함수 EXECUTE). 꺼지면 `deny_pool` 이 까닭을 한 줄 남기고, 켜지면 아래 한 줄을 남긴다(W2).
    let ask_deny = match &ask_write {
        Some(w) => harkroom_server::core::decide_core::deny_pool(w).await,
        None => None,
    };
    if ask_deny.is_some() {
        eprintln!("front: permission deny core on");
    }
    // S5.3 B2 — 권한 카드 승인(소유자). 거절과 같은 세 겹에 grant·이벤트 쓰기 칸(`APPROVE_PRIVILEGES`)을 더한다(fail-closed).
    let ask_approve = match &ask_write {
        Some(w) => harkroom_server::core::decide_approve::approve_pool(w).await,
        None => None,
    };
    if let Some(w) = &ask_approve {
        eprintln!("front: permission approve core on");
        // S5.4 — 머지 거절 카드의 [이번 한 번](fail-closed, 칸이 없으면 TS).
        if harkroom_server::core::decide_merge_once::check_merge_once_core(w).await {
            eprintln!("front: permission merge once core on");
        }
        // S5.3 C1 — 있는 위임장에 줄 쓰기 칸(fail-closed, 없으면 위임장 있는 승인은 TS).
        if harkroom_server::core::decide_approve::check_mandate_core(w).await {
            eprintln!("front: permission mandate core on");
            // S5.3 C3 — 위임장 있는 command 승인(새 칸 없음, C1 스위치를 따른다).
            if harkroom_server::core::decide_approve::mandate_command_core_on() {
                eprintln!("front: permission mandate command core on");
            }
            // S5.3 C2 — 위임장 새로 세우기 칸(fail-closed, 없으면 위임장 없는 approve_new_mandate 는 TS).
            if harkroom_server::core::decide_approve::new_mandate_core_on() {
                eprintln!("front: permission new mandate core on");
            }
        }
    }
    // C3b B1 — `POST /agent/command-grants/match`(명령 grant 하나를 쓰고 감사). `HARKROOM_CORE=rust` 그리고 쓰기 풀에
    // `MATCH_PRIVILEGES` 가 다 있을 때만(fail-closed) — 아니면 경로를 붙이지 않아 TS 가 받는다.
    let match_write = match (&core_mode, &state.write) {
        (harkroom_server::core::CoreMode::Rust, Some(w)) => {
            use harkroom_server::core::command_match as cm;
            match write::missing_in(w, cm::MATCH_PRIVILEGES, &[]).await {
                Ok(m) if m.is_empty() => Some(w.clone()),
                Ok(m) => {
                    eprintln!("front: command grant match core off — missing privileges {m:?}");
                    refuse_missing_grants(&m);
                    None
                }
                Err(e) => {
                    eprintln!(
                        "front: command grant match core off — privilege check failed ({})",
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
                    refuse_missing_grants(&m);
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
    // C1c-4d — 암묵 위임은 글 쓰기 풀에 그 칸(`IMPLICIT_DELEGATION_PRIVILEGES`)까지 있을 때만 Rust 가 적는다. 없으면 부름이 든 에이전트 글만 TS 에 남는다.
    let implicit_ok = match &post_write {
        Some(w) => match write::missing_in(
            w,
            harkroom_server::core::implicit_delegation::IMPLICIT_DELEGATION_PRIVILEGES,
            &[],
        )
        .await
        {
            Ok(m) if m.is_empty() => true,
            Ok(m) => {
                eprintln!("front: implicit delegation core off — missing privileges {m:?}");
                refuse_missing_grants(&m);
                false
            }
            Err(e) => {
                eprintln!(
                    "front: implicit delegation core off — privilege check failed ({})",
                    e.as_database_error().map_or("io", |_| "db")
                );
                false
            }
        },
        None => false,
    };
    // C1c-4c — MCP `message.post` 는 글 쓰기 풀에 principal 옮겨 적기 칸(`MCP_POST_EXTRA_PRIVILEGES`)까지 있을 때만. 없으면 MCP 글만 TS 에 남는다.
    let mcp_post_ok = match &post_write {
        Some(w) => match write::missing_in(
            w,
            harkroom_server::core::msg_post::MCP_POST_EXTRA_PRIVILEGES,
            &[],
        )
        .await
        {
            Ok(m) if m.is_empty() => true,
            Ok(m) => {
                eprintln!("front: mcp message.post core off — missing privileges {m:?}");
                refuse_missing_grants(&m);
                false
            }
            Err(e) => {
                eprintln!(
                    "front: mcp message.post core off — privilege check failed ({})",
                    e.as_database_error().map_or("io", |_| "db")
                );
                false
            }
        },
        None => false,
    };
    // S5.4 CH4b-2 — 멤버 넣기·빼기. 세 겹 잠금: `HARKROOM_CORE=rust`, 글 올리기 코어가 켜짐(시스템 글이 그 경로를 탄다),
    // 쓰기 풀에 멤버 권한이 다 있을 때만.
    let members_write = match &post_write {
        Some(w) => {
            use harkroom_server::core::channel_members as c;
            match write::missing_in(w, c::MEMBER_PRIVILEGES, &[]).await {
                Ok(m) if m.is_empty() => Some(w.clone()),
                Ok(m) => {
                    eprintln!("front: channel members core off — missing privileges {m:?}");
                    refuse_missing_grants(&m);
                    None
                }
                Err(e) => {
                    eprintln!(
                        "front: channel members core off — privilege check failed ({})",
                        e.as_database_error().map_or("io", |_| "db")
                    );
                    None
                }
            }
        }
        None => None,
    };
    // S5.4 TM2 — 스레드 모델 지정 풀기. 글 올리기 코어(시스템 줄이 스레드 안으로 그 경로를 탄다)와 풀기 권한이 다 있을 때만.
    let thread_model_clear = match &post_write {
        Some(w) => {
            use harkroom_server::core::thread_model_clear as c;
            match write::missing_in(w, c::THREAD_MODEL_CLEAR_PRIVILEGES, &[]).await {
                Ok(m) if m.is_empty() => Some(w.clone()),
                Ok(m) => {
                    eprintln!("front: thread model clear core off — missing privileges {m:?}");
                    refuse_missing_grants(&m);
                    None
                }
                Err(e) => {
                    eprintln!(
                        "front: thread model clear core off — privilege check failed ({})",
                        e.as_database_error().map_or("io", |_| "db")
                    );
                    None
                }
            }
        }
        None => None,
    };
    // 받을 `failed` 보고(CI 거절 아님)는 글 경로와 [`MERGE_RESULTS_WRITE_PRIVILEGES`] 가 다 있을 때만 Rust 가 적는다 — 없으면 TS.
    let merge_results_post = match (&post_write, &merge_results_read) {
        (Some(w), Some(_)) => {
            use harkroom_server::core::merge_checks as t;
            match write::missing_in(w, t::MERGE_RESULTS_WRITE_PRIVILEGES, &[]).await {
                Ok(m) if m.is_empty() => Some(harkroom_server::core::msg_post::PostState {
                    read: state.pool.clone(),
                    write: w.clone(),
                    up: state.up.clone(),
                    implicit_ok,
                }),
                Ok(m) => {
                    eprintln!("front: merge results write off — missing privileges {m:?}");
                    None
                }
                Err(e) => {
                    eprintln!(
                        "front: merge results write off — privilege check failed ({})",
                        e.as_database_error().map_or("io", |_| "db")
                    );
                    None
                }
            }
        }
        _ => None,
    };
    // S5.4 — `POST /agent/api-results`. 글 올리기 코어(시스템 줄)와 [`API_RESULTS_PRIVILEGES`] 가 다 있을 때만.
    let api_results_write = match &post_write {
        Some(w) => {
            use harkroom_server::core::api_results as c;
            match write::missing_in(w, c::API_RESULTS_PRIVILEGES, &[]).await {
                Ok(m) if m.is_empty() => Some(w.clone()),
                Ok(m) => {
                    eprintln!("front: api results core off — missing privileges {m:?}");
                    refuse_missing_grants(&m);
                    None
                }
                Err(e) => {
                    eprintln!(
                        "front: api results core off — privilege check failed ({})",
                        e.as_database_error().map_or("io", |_| "db")
                    );
                    None
                }
            }
        }
        None => None,
    };
    // S5.4 — `POST /agent/pr-watches/{id}/status`. 글 올리기 코어(시스템 줄)와 [`PR_WATCH_STATUS_PRIVILEGES`] 가 다 있고
    // `HARKROOM_DELEGATION_V2` 값이 있을 때만(due 와 같은 이유).
    let pr_watch_status_write = match &post_write {
        Some(w) if std::env::var("HARKROOM_DELEGATION_V2").is_ok_and(|v| !v.trim().is_empty()) => {
            use harkroom_server::core::pr_watch_status as c;
            match write::missing_in(w, c::PR_WATCH_STATUS_PRIVILEGES, &[]).await {
                Ok(m) if m.is_empty() => Some(w.clone()),
                Ok(m) => {
                    eprintln!("front: pr-watch status core off — missing privileges {m:?}");
                    refuse_missing_grants(&m);
                    None
                }
                Err(e) => {
                    eprintln!(
                        "front: pr-watch status core off — privilege check failed ({})",
                        e.as_database_error().map_or("io", |_| "db")
                    );
                    None
                }
            }
        }
        _ => None,
    };
    // S5.4 TP3 — 계획 자동 진행 끄기. 글 올리기 코어(시스템 줄이 스레드 안으로 그 경로를 탄다)와 끄기 칸 권한이 다 있을 때만.
    let thread_plan_auto_off = match &post_write {
        Some(w) => {
            use harkroom_server::core::thread_plan_auto_off as c;
            match write::missing_in(w, c::THREAD_PLAN_AUTO_OFF_PRIVILEGES, &[]).await {
                Ok(m) if m.is_empty() => Some(w.clone()),
                Ok(m) => {
                    eprintln!("front: thread plan auto-off core off — missing privileges {m:?}");
                    refuse_missing_grants(&m);
                    None
                }
                Err(e) => {
                    eprintln!(
                        "front: thread plan auto-off core off — privilege check failed ({})",
                        e.as_database_error().map_or("io", |_| "db")
                    );
                    None
                }
            }
        }
        None => None,
    };
    // C3b-2c-4b — MCP `message.delegate` 의 쓰기(게이트를 지난 위임)는 MCP 글 칸에 더해 위임 칸(`DELEGATE_WRITE_PRIVILEGES`)까지 있을 때만.
    // 없으면 게이트를 지난 위임만 TS 에 남는다(거절 갈래는 그대로 Rust).
    let mcp_delegate_ok = mcp_post_ok
        && match &post_write {
            Some(w) => match write::missing_in(
                w,
                harkroom_server::core::delegate_write::DELEGATE_WRITE_PRIVILEGES,
                &[],
            )
            .await
            {
                Ok(m) if m.is_empty() => true,
                Ok(m) => {
                    eprintln!(
                        "front: mcp message.delegate write core off — missing privileges {m:?}"
                    );
                    refuse_missing_grants(&m);
                    false
                }
                Err(e) => {
                    eprintln!(
                        "front: mcp message.delegate write core off — privilege check failed ({})",
                        e.as_database_error().map_or("io", |_| "db")
                    );
                    false
                }
            },
            None => false,
        };
    // S5.4 A3 — MCP `turn.wake` 는 MCP 글 칸에 더해 agent_wake 칸(`TURN_WAKE_PRIVILEGES`)까지 있을 때만. 없으면 TS 에 남는다.
    let mcp_wake_ok = mcp_post_ok
        && match &post_write {
            Some(w) => match write::missing_in(
                w,
                harkroom_server::core::mcp::turn_wake::TURN_WAKE_PRIVILEGES,
                &[],
            )
            .await
            {
                Ok(m) if m.is_empty() => true,
                Ok(m) => {
                    eprintln!("front: mcp turn.wake core off — missing privileges {m:?}");
                    refuse_missing_grants(&m);
                    false
                }
                Err(e) => {
                    eprintln!(
                        "front: mcp turn.wake core off — privilege check failed ({})",
                        e.as_database_error().map_or("io", |_| "db")
                    );
                    false
                }
            },
            None => false,
        };
    // S5.4 MCP 3 — MCP `skill.propose`. 글 쓰기 풀에 제안 행 칸이 다 있을 때만 — 아니면 TS 에 남는다.
    // MCP `artifact.publish` 새 안(v1) — 글 쓰기 풀에 아티팩트 행·업로드 정리 칸이 다 있고 첨부 저장소가 있을 때만. 아니면 게시는 TS.
    let mcp_artifact_ok = mcp_post_ok
        && artifact_storage.is_some()
        && match &post_write {
            Some(w) => {
                use harkroom_server::core::mcp::{artifact_publish as ap, artifact_write as aw};
                let need: Vec<(&str, &str)> = aw::ARTIFACT_PUBLISH_PRIVILEGES
                    .iter()
                    .chain(ap::ARTIFACT_UPLOAD_CLEANUP_PRIVILEGES)
                    .chain(harkroom_server::core::attachment_upload::UPLOAD_PRIVILEGES)
                    .copied()
                    .collect();
                match write::missing_in(w, &need, &[]).await {
                    Ok(m) if m.is_empty() => true,
                    Ok(m) => {
                        eprintln!(
                            "front: mcp artifact.publish core off — missing privileges {m:?}"
                        );
                        refuse_missing_grants(&m);
                        false
                    }
                    Err(e) => {
                        eprintln!(
                            "front: mcp artifact.publish core off — privilege check failed ({})",
                            e.as_database_error().map_or("io", |_| "db")
                        );
                        false
                    }
                }
            }
            None => false,
        };
    // 고쳐 올리기(`artifactId`)·표지(`coverAttachmentId`)는 칸이 더 있을 때만 — 없으면 그 모양만 TS 로 넘긴다(새 안은 그대로 Rust).
    let artifact_extra = |name: &'static str, need: &'static [(&'static str, &'static str)]| {
        let w = post_write.clone();
        async move {
            if !mcp_artifact_ok {
                return false;
            }
            let Some(w) = w else { return false };
            match write::missing_in(&w, need, &[]).await {
                Ok(m) if m.is_empty() => true,
                Ok(m) => {
                    eprintln!("front: mcp artifact.publish {name} off — missing privileges {m:?}");
                    false
                }
                Err(_) => false,
            }
        }
    };
    let mcp_artifact_revise = artifact_extra(
        "artifactId",
        harkroom_server::core::mcp::artifact_write::ARTIFACT_REVISE_PRIVILEGES,
    )
    .await;
    let mcp_artifact_cover = artifact_extra(
        "coverAttachmentId",
        harkroom_server::core::mcp::artifact_write::ARTIFACT_COVER_PRIVILEGES,
    )
    .await;
    let mcp_skill_ok = mcp_post_ok
        && match &post_write {
            Some(w) => match write::missing_in(
                w,
                harkroom_server::core::mcp::skill_propose::SKILL_PROPOSE_PRIVILEGES,
                &[],
            )
            .await
            {
                Ok(m) if m.is_empty() => true,
                Ok(m) => {
                    eprintln!("front: mcp skill.propose core off — missing privileges {m:?}");
                    refuse_missing_grants(&m);
                    false
                }
                Err(e) => {
                    eprintln!(
                        "front: mcp skill.propose core off — privilege check failed ({})",
                        e.as_database_error().map_or("io", |_| "db")
                    );
                    false
                }
            },
            None => false,
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
                    refuse_missing_grants(&m);
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
                    refuse_missing_grants(&m);
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
                    refuse_missing_grants(&m);
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
                    refuse_missing_grants(&m);
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
    // C6a-2 — 스레드 처리 상태(`PUT /inbox/threads/{rootId}`). 쓰기 풀에 그 권한이 다 있을 때만 — 아니면 TS 에 남는다.
    let inbox_thread_write = match (&core_mode, &state.write) {
        (harkroom_server::core::CoreMode::Rust, Some(w)) => {
            use harkroom_server::core::inbox_thread as it;
            match write::missing_in(
                w,
                it::INBOX_THREAD_PRIVILEGES,
                it::INBOX_THREAD_SEQUENCE_PRIVILEGES,
            )
            .await
            {
                Ok(m) if m.is_empty() => Some(w.clone()),
                Ok(m) => {
                    eprintln!("front: inbox thread core off — missing privileges {m:?}");
                    refuse_missing_grants(&m);
                    None
                }
                Err(e) => {
                    eprintln!(
                        "front: inbox thread core off — privilege check failed ({})",
                        e.as_database_error().map_or("io", |_| "db")
                    );
                    None
                }
            }
        }
        _ => None,
    };
    let operator_on = operator_write.is_some();
    // S5.4 TM4 — 스레드 모델 지정(`PUT …/agent-models/{agentId}`). 하네스 목록을 스냅숏으로 보므로 오퍼레이터 코어가 Rust 일 때만,
    // 그리고 글 올리기 코어(시스템 줄)와 지정 권한이 다 있을 때만 — 아니면 TS 에 남는다.
    let thread_model_set = match (&post_write, operator_on) {
        (Some(w), true) => {
            use harkroom_server::core::thread_model_set as c;
            match write::missing_in(w, c::THREAD_MODEL_SET_PRIVILEGES, &[]).await {
                Ok(m) if m.is_empty() => Some(w.clone()),
                Ok(m) => {
                    eprintln!("front: thread model set core off — missing privileges {m:?}");
                    refuse_missing_grants(&m);
                    None
                }
                Err(e) => {
                    eprintln!(
                        "front: thread model set core off — privilege check failed ({})",
                        e.as_database_error().map_or("io", |_| "db")
                    );
                    None
                }
            }
        }
        _ => None,
    };
    // S5.4 TM3 — `GET /agents/{agentId}/model-options`: 오퍼레이터 코어 + 읽기 칸 권한.
    let agent_model_options = operator_on && {
        use harkroom_server::core::agent_model_options as mo;
        match write::missing_in(&state.pool, mo::AGENT_MODEL_OPTIONS_PRIVILEGES, &[]).await {
            Ok(m) if m.is_empty() => true,
            Ok(m) => {
                eprintln!("front: agent model-options core off — missing privileges {m:?}");
                refuse_missing_grants(&m);
                false
            }
            Err(e) => {
                eprintln!(
                    "front: agent model-options core off — privilege check failed ({})",
                    e.as_database_error().map_or("io", |_| "db")
                );
                false
            }
        }
    };
    // C6c-3 — 릴레이 세션 사본은 오퍼레이터 코어와 함께만 선다(한 스위치). 허브 줄을 못 넣으면 사본 없이 릴레이만 돈다(TS 와 같음).
    let relay_live = match &operator_write {
        Some(w) => match harkroom_server::core::relay_live::SessionLive::start(
            w.clone(),
            harkroom_server::core::relay_live::LiveOpts::default(),
        )
        .await
        {
            Ok(l) => Some(l),
            Err(e) => {
                eprintln!(
                    "front: relay session copy off ({})",
                    e.as_database_error().map_or("io", |_| "db")
                );
                None
            }
        },
        None => None,
    };
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
        // S5.4 MS2a — 메시지 검색(`GET /search`). 읽기 풀만 쓴다(MCP `message.search` 와 같은 문장). `@handle`·기간도 Rust 가 푼다.
        let search = harkroom_server::core::search_rest::routes(
            harkroom_server::core::search_rest::SearchState {
                pool: state.pool.clone(),
                up: state.up.clone(),
            },
            auth.clone(),
            state.cors.clone(),
        );
        core_routes.router = core_routes.router.merge(search.router);
        core_routes.http.extend(search.http);
        core_routes.sockets.extend(search.sockets);
        // S5.4 MS2b — 받은함 목록(`GET /inbox`). 읽기 풀만 쓴다. `threads`·위임 v2 켜짐(또는 모름)·형식이 애매한 질의는 TS 로.
        let inbox_rest = harkroom_server::core::inbox_rest::routes(
            harkroom_server::core::inbox_rest::InboxRestState {
                pool: state.pool.clone(),
                up: state.up.clone(),
            },
            auth.clone(),
            state.cors.clone(),
        );
        core_routes.router = core_routes.router.merge(inbox_rest.router);
        core_routes.http.extend(inbox_rest.http);
        core_routes.sockets.extend(inbox_rest.sockets);
        // S5.4 MS2c-2 — 「내 작업」 보드(`GET /inbox/board`). 판 태그 304·간추림·압축. 읽기 풀만 쓴다. 위임 v2 모름·모르는 질의는 TS 로.
        let inbox_board = harkroom_server::core::inbox_board::routes(
            harkroom_server::core::inbox_board::InboxBoardState {
                pool: state.pool.clone(),
                up: state.up.clone(),
            },
            auth.clone(),
            state.cors.clone(),
        );
        core_routes.router = core_routes.router.merge(inbox_board.router);
        core_routes.http.extend(inbox_board.http);
        core_routes.sockets.extend(inbox_board.sockets);
        // C3b-3d — 카드 버튼을 그릴지(`GET /agents/{id}/decide-check`). 잠그지 않는 판정이라 읽기 풀만 쓴다.
        let decide_check = harkroom_server::core::decide_check::routes(
            state.pool.clone(),
            auth.clone(),
            state.cors.clone(),
        );
        core_routes.router = core_routes.router.merge(decide_check.router);
        core_routes.http.extend(decide_check.http);
        core_routes.sockets.extend(decide_check.sockets);
        // S5.4 TM1 — 스레드 모델 지정 읽기. 읽기 역할에 SELECT 가 다 있을 때만 — 정하기·풀기(PUT·DELETE)는 언제나 TS.
        if channel_files_on {
            let cf = harkroom_server::core::channel_files::routes(
                state.pool.clone(),
                auth.clone(),
                state.cors.clone(),
            );
            core_routes.router = core_routes.router.merge(cf.router);
            core_routes.http.extend(cf.http);
            core_routes.sockets.extend(cf.sockets);
        }
        if thread_models_read {
            let tm = harkroom_server::core::thread_models_read::routes(
                state.pool.clone(),
                auth.clone(),
                state.cors.clone(),
            );
            core_routes.router = core_routes.router.merge(tm.router);
            core_routes.http.extend(tm.http);
            core_routes.sockets.extend(tm.sockets);
        }
        // S5.4 TM3 — `GET /agents/{agentId}/model-options`. 오퍼레이터 코어가 Rust 일 때만(하네스 목록이 스냅숏에서 같은 답이다)
        // + 읽기 칸 권한이 있을 때만 — 아니면 TS 에 남는다.
        if agent_model_options {
            let r = harkroom_server::core::agent_model_options::routes(
                state.pool.clone(),
                auth.clone(),
                state.cors.clone(),
            );
            core_routes.router = core_routes.router.merge(r.router);
            core_routes.http.extend(r.http);
            core_routes.sockets.extend(r.sockets);
        }
        // C3b grant 읽기 줄 — 러너·오퍼레이터가 읽는 `GET /agent/tool-allows`·`/agent/command-grants`. 읽기 풀만(match 는 아래 B1).
        // S5.4 AT1 — 자동화 읽기(`GET /automations`·`GET /automations/{id}`). 읽기 풀만 쓴다 — 지우기·만들기·수신은 TS.
        let automations = harkroom_server::core::automations_read::routes(
            state.pool.clone(),
            auth.clone(),
            state.cors.clone(),
        );
        core_routes.router = core_routes.router.merge(automations.router);
        core_routes.http.extend(automations.http);
        core_routes.sockets.extend(automations.sockets);
        // S5.4 MD1 — 위임장 줄 읽기(`GET /mandates/{id}/lines`). 읽기 풀만 — 줄 빼기·위임 끝내기는 TS.
        let mandate_lines = harkroom_server::core::mandate_lines_read::routes(
            state.pool.clone(),
            auth.clone(),
            state.cors.clone(),
        );
        core_routes.router = core_routes.router.merge(mandate_lines.router);
        core_routes.http.extend(mandate_lines.http);
        core_routes.sockets.extend(mandate_lines.sockets);
        let grant_reads = harkroom_server::core::grant_reads::routes(
            state.pool.clone(),
            auth.clone(),
            state.cors.clone(),
        );
        core_routes.router = core_routes.router.merge(grant_reads.router);
        core_routes.http.extend(grant_reads.http);
        core_routes.sockets.extend(grant_reads.sockets);
        if agent_grants_read_on {
            let ag = harkroom_server::core::agent_grants_read::routes(
                state.pool.clone(),
                auth.clone(),
                state.cors.clone(),
            );
            core_routes.router = core_routes.router.merge(ag.router);
            core_routes.http.extend(ag.http);
            core_routes.sockets.extend(ag.sockets);
        }
        if merge_peek_on {
            let mp = harkroom_server::core::merge_approval_peek::routes(
                state.pool.clone(),
                auth.clone(),
                state.cors.clone(),
            );
            core_routes.router = core_routes.router.merge(mp.router);
            core_routes.http.extend(mp.http);
            core_routes.sockets.extend(mp.sockets);
        }
        if let Some(w) = merge_denial_grant_write {
            let mg = harkroom_server::core::merge_denial_grant::routes(
                w,
                auth.clone(),
                state.cors.clone(),
            );
            core_routes.router = core_routes.router.merge(mg.router);
            core_routes.http.extend(mg.http);
            core_routes.sockets.extend(mg.sockets);
        }
        if let Some(w) = merge_closed_write {
            let mc =
                harkroom_server::core::merge_closed::routes(w, auth.clone(), state.cors.clone());
            core_routes.router = core_routes.router.merge(mc.router);
            core_routes.http.extend(mc.http);
            core_routes.sockets.extend(mc.sockets);
        }
        if let Some(w) = pr_watch_due_write {
            let pd =
                harkroom_server::core::pr_watch_due::routes(w, auth.clone(), state.cors.clone());
            core_routes.router = core_routes.router.merge(pd.router);
            core_routes.http.extend(pd.http);
            core_routes.sockets.extend(pd.sockets);
        }
        if link_preview_read_on {
            let lp = harkroom_server::core::link_preview_read::routes(
                harkroom_server::core::link_preview_read::LinkPreviewState {
                    read: state.pool.clone(),
                    // 글 쓰기 풀(그 권한에 link_preview 칸이 들어 있다) — 없으면 만료된 행은 TS 로 넘긴다.
                    write: post_write.clone(),
                    up: state.up.clone(),
                },
                auth.clone(),
                state.cors.clone(),
            );
            core_routes.router = core_routes.router.merge(lp.router);
            core_routes.http.extend(lp.http);
            core_routes.sockets.extend(lp.sockets);
        }
        if agent_wakes_read_on {
            let aw = harkroom_server::core::agent_wakes_read::routes(
                state.pool.clone(),
                auth.clone(),
                state.cors.clone(),
            );
            core_routes.router = core_routes.router.merge(aw.router);
            core_routes.http.extend(aw.http);
            core_routes.sockets.extend(aw.sockets);
        }
        // C3b B1 — 명령 grant 쓰기(`POST /agent/command-grants/match`). 쓰기 풀 권한이 다 있을 때만.
        if let Some(write) = match_write {
            let m = harkroom_server::core::command_match::routes(
                harkroom_server::core::command_match::MatchState {
                    read: state.pool.clone(),
                    write,
                },
                auth.clone(),
                state.cors.clone(),
            );
            core_routes.router = core_routes.router.merge(m.router);
            core_routes.http.extend(m.http);
            core_routes.sockets.extend(m.sockets);
        }
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
        // S5.4 CH1 — 섹션 쓰기 4줄. 권한이 다 있을 때만 — 아니면 TS 에 남는다(`GET /channel-sections` 는 읽기 코어 것).
        if let Some(write) = section_write {
            let sec = harkroom_server::core::sections_write::routes(
                harkroom_server::core::sections_write::SectionState {
                    read: state.pool.clone(),
                    write,
                },
                auth.clone(),
                state.cors.clone(),
            );
            core_routes.router = core_routes.router.merge(sec.router);
            core_routes.http.extend(sec.http);
            core_routes.sockets.extend(sec.sockets);
        }
        // S5.4 CH3c — 채널 선호·옛 섹션 이름 2줄. 권한이 다 있을 때만 — 아니면 TS 에 남는다.
        if let Some(write) = pref_write {
            let pw = harkroom_server::core::channel_pref_write::routes(
                harkroom_server::core::channel_pref_write::PrefState { write },
                auth.clone(),
                state.cors.clone(),
            );
            core_routes.router = core_routes.router.merge(pw.router);
            core_routes.http.extend(pw.http);
            core_routes.sockets.extend(pw.sockets);
        }
        // S5.4 AC1 — 내 상태·PAT 4줄. 권한이 다 있을 때만 — 아니면 TS 에 남는다.
        if let Some(write) = account_self_write {
            let acc = harkroom_server::core::account_self::routes(
                harkroom_server::core::account_self::AccountSelfState {
                    read: state.pool.clone(),
                    write,
                    trust: state.trust.clone(),
                },
                auth.clone(),
                state.cors.clone(),
            );
            core_routes.router = core_routes.router.merge(acc.router);
            core_routes.http.extend(acc.http);
            core_routes.sockets.extend(acc.sockets);
        }
        // S5.4 AC4 — handle 바꾸기 2줄. 권한이 다 있을 때만 — 아니면 TS 에 남는다.
        if let Some(write) = account_handle_write {
            let ah = harkroom_server::core::account_handle::routes(
                harkroom_server::core::account_handle::AccountHandleState {
                    read: state.pool.clone(),
                    write,
                    trust: state.trust.clone(),
                },
                auth.clone(),
                state.cors.clone(),
            );
            core_routes.router = core_routes.router.merge(ah.router);
            core_routes.http.extend(ah.http);
            core_routes.sockets.extend(ah.sockets);
        }
        // S5.4 AT2 — 자동화 수신 끄기. 권한이 다 있을 때만 — 아니면 TS 에 남는다.
        if let Some(write) = automations_write {
            let aw = harkroom_server::core::automations_write::routes(
                write,
                auth.clone(),
                state.cors.clone(),
            );
            core_routes.router = core_routes.router.merge(aw.router);
            core_routes.http.extend(aw.http);
            core_routes.sockets.extend(aw.sockets);
        }
        // S5.4 AT5 — 자동화 만들기. 권한이 다 있을 때만 — 아니면 TS 에 남는다.
        if let Some(write) = automation_create {
            let ac = harkroom_server::core::automation_create::routes(
                harkroom_server::core::automation_create::CreateState {
                    read: state.pool.clone(),
                    write,
                    up: state.up.clone(),
                },
                auth.clone(),
                state.cors.clone(),
            );
            core_routes.router = core_routes.router.merge(ac.router);
            core_routes.http.extend(ac.http);
            core_routes.sockets.extend(ac.sockets);
        }
        // S5.4 AT4 — 자동화 제안 승인. 권한이 다 있을 때만 — 아니면 TS 에 남는다.
        if let Some(write) = automation_approve {
            let ap = harkroom_server::core::automation_approve::routes(
                harkroom_server::core::automation_approve::ApproveState {
                    read: state.pool.clone(),
                    write,
                    up: state.up.clone(),
                },
                auth.clone(),
                state.cors.clone(),
            );
            core_routes.router = core_routes.router.merge(ap.router);
            core_routes.http.extend(ap.http);
            core_routes.sockets.extend(ap.sockets);
        }
        // S5.4 AT3 — 자동화 「지금 한 번」. 권한이 다 있을 때만 — 아니면 TS 에 남는다.
        if let Some(write) = automation_run_now {
            let rn = harkroom_server::core::automation_run_now::routes(
                harkroom_server::core::automation_run_now::RunNowState {
                    read: state.pool.clone(),
                    write,
                    up: state.up.clone(),
                },
                auth.clone(),
                state.cors.clone(),
            );
            core_routes.router = core_routes.router.merge(rn.router);
            core_routes.http.extend(rn.http);
            core_routes.sockets.extend(rn.sockets);
        }
        // S5.4 AT7 — 들어오는 hook(github·generic). 읽기 풀에 수신 비밀 칸 SELECT 가 있을 때만 — 아니면 TS 에 남는다.
        // S5.4 AT8 — 수신 켜기. 권한이 다 있을 때만 — 아니면 TS 에 남는다.
        if let Some(write) = automation_ingress_issue {
            use harkroom_server::core::automation_ingress_issue as k;
            let ii = k::routes(
                k::IssueState::new(state.pool.clone(), write),
                auth.clone(),
                state.cors.clone(),
            );
            core_routes.router = core_routes.router.merge(ii.router);
            core_routes.http.extend(ii.http);
            core_routes.sockets.extend(ii.sockets);
        }
        if automation_hooks_on {
            use harkroom_server::core::automation_hooks as k;
            let hk = k::routes(
                k::HooksState::new(state.pool.clone(), state.up.clone(), automation_hooks_write),
                state.cors.clone(),
            );
            core_routes.router = core_routes.router.merge(hk.router);
            core_routes.http.extend(hk.http);
            core_routes.sockets.extend(hk.sockets);
        }
        // S5.4 결정 5 — 자동화 지우기. 권한이 다 있을 때만 — 아니면 TS 에 남는다.
        if let Some(write) = automation_delete {
            let ad = harkroom_server::core::automation_delete::routes(
                write,
                auth.clone(),
                state.cors.clone(),
            );
            core_routes.router = core_routes.router.merge(ad.router);
            core_routes.http.extend(ad.http);
            core_routes.sockets.extend(ad.sockets);
        }
        // S5.4 MD2 — 위임장 줄 빼기. 권한이 다 있을 때만 — 아니면 TS 에 남는다.
        if let Some(write) = mandate_line_revoke {
            let ml = harkroom_server::core::mandate_line_revoke::routes(
                harkroom_server::core::mandate_line_revoke::MandateLineRevokeState {
                    write,
                    up: state.up.clone(),
                },
                auth.clone(),
                state.cors.clone(),
            );
            core_routes.router = core_routes.router.merge(ml.router);
            core_routes.http.extend(ml.http);
            core_routes.sockets.extend(ml.sockets);
        }
        // S5.4 AT6 — 자동화 고치기. 권한이 다 있을 때만 — 아니면 TS 에 남는다.
        if let Some(write) = automation_patch {
            let ap = harkroom_server::core::automation_patch::routes(
                harkroom_server::core::automation_patch::PatchState {
                    read: state.pool.clone(),
                    write,
                    up: state.up.clone(),
                },
                auth.clone(),
                state.cors.clone(),
            );
            core_routes.router = core_routes.router.merge(ap.router);
            core_routes.http.extend(ap.http);
            core_routes.sockets.extend(ap.sockets);
        }
        // S5.4 결정 5 — 위임 끝. 권한이 다 있을 때만 — 아니면 TS 에 남는다.
        if let Some(write) = mandate_end {
            let me = harkroom_server::core::mandate_end::routes(
                harkroom_server::core::mandate_end::MandateEndState {
                    write,
                    trust: state.trust.clone(),
                },
                auth.clone(),
                state.cors.clone(),
            );
            core_routes.router = core_routes.router.merge(me.router);
            core_routes.http.extend(me.http);
            core_routes.sockets.extend(me.sockets);
        }
        // S5.4 — API 연결 지우기. 권한이 다 있을 때만 — 아니면 TS 에 남는다.
        if let Some(write) = connectors_write {
            let cw = harkroom_server::core::connectors_write::routes(
                harkroom_server::core::connectors_write::ConnectorsWriteState {
                    write,
                    trust: state.trust.clone(),
                },
                auth.clone(),
                state.cors.clone(),
            );
            core_routes.router = core_routes.router.merge(cw.router);
            core_routes.http.extend(cw.http);
            core_routes.sockets.extend(cw.sockets);
        }
        // S5.4 — API 연결 POST·PATCH(주소에 ASCII 밖 글자가 있으면 안에서 TS 로 넘긴다). 권한이 다 있을 때만.
        if let Some(write) = connectors_upsert {
            let cu = harkroom_server::core::connectors_upsert::routes(
                harkroom_server::core::connectors_upsert::ConnectorsUpsertState {
                    write,
                    trust: state.trust.clone(),
                    up: state.up.clone(),
                },
                auth.clone(),
                state.cors.clone(),
            );
            core_routes.router = core_routes.router.merge(cu.router);
            core_routes.http.extend(cu.http);
            core_routes.sockets.extend(cu.sockets);
        }
        // S5.4 AC4 — 초대 쓰기(발급·취소·다시 보내기, 메일 포함). 권한이 다 있을 때만.
        if let Some(write) = invites_write {
            // TS `loadMailConfig` 와 같다: 칸이 하나도 없으면 메일 끔, 일부만 있으면 기동을 멈춘다.
            let mailer = match harkroom_server::core::invite_mail::load_mail_config(|k| {
                std::env::var(k).ok()
            })
            .and_then(|c| {
                c.map(|c| harkroom_server::core::invite_mail::Mailer::new(&c))
                    .transpose()
            }) {
                Ok(m) => m.map(std::sync::Arc::new),
                Err(e) => {
                    eprintln!("front: {e}");
                    std::process::exit(1);
                }
            };
            let iw = harkroom_server::core::invites_write::routes(
                harkroom_server::core::invites_write::InvitesWriteState {
                    read: state.pool.clone(),
                    write,
                    trust: state.trust.clone(),
                    mailer,
                },
                auth.clone(),
                state.cors.clone(),
            );
            core_routes.router = core_routes.router.merge(iw.router);
            core_routes.http.extend(iw.http);
            core_routes.sockets.extend(iw.sockets);
        }
        // S5.4 — GET /agent/config. 권한이 다 있을 때만 — 아니면 TS 에 남는다.
        if let Some(write) = agent_config_write {
            let ac = harkroom_server::core::agent_config_read::routes(
                harkroom_server::core::agent_config_read::AgentConfigState {
                    read: state.pool.clone(),
                    write,
                },
                auth.clone(),
                state.cors.clone(),
            );
            core_routes.router = core_routes.router.merge(ac.router);
            core_routes.http.extend(ac.http);
            core_routes.sockets.extend(ac.sockets);
        }
        // S5.4 AC4 — keys PUT·agent/activity 2줄. 권한이 다 있을 때만 — 아니면 TS 에 남는다.
        if let Some(write) = keys_activity_write {
            let ka = harkroom_server::core::account_keys_activity::routes(
                harkroom_server::core::account_keys_activity::KeysActivityState { write },
                auth.clone(),
                state.cors.clone(),
            );
            core_routes.router = core_routes.router.merge(ka.router);
            core_routes.http.extend(ka.http);
            core_routes.sockets.extend(ka.sockets);
        }
        // S5.4 AU1 — 인증 가벼운 줄 4개. 권한이 다 있을 때만 — 아니면 TS 에 남는다(login·register 등은 언제나 TS).
        if let Some(write) = auth_light_write {
            let au = harkroom_server::core::auth_light::routes(
                harkroom_server::core::auth_light::AuthLightState {
                    read: state.pool.clone(),
                    write,
                    trust: state.trust.clone(),
                },
                auth.clone(),
                state.cors.clone(),
            );
            core_routes.router = core_routes.router.merge(au.router);
            core_routes.http.extend(au.http);
            core_routes.sockets.extend(au.sockets);
        }
        // S5.4 SE1 — 비밀 읽기·지우기 5줄. 권한이 다 있을 때만 — 아니면 TS 에 남는다(목록·만들기·값·부여 주기·보기는 언제나 TS).
        // S5.4 SE2 — 비밀 부여. 권한이 다 있을 때만 — 아니면 TS 에 남는다.
        if let Some(write) = secret_grant_give {
            let sg = harkroom_server::core::secret_grant_give::routes(
                harkroom_server::core::secrets_read::SecretsReadState {
                    read: state.pool.clone(),
                    write,
                    trust: state.trust.clone(),
                },
                auth.clone(),
                state.cors.clone(),
            );
            core_routes.router = core_routes.router.merge(sg.router);
            core_routes.http.extend(sg.http);
            core_routes.sockets.extend(sg.sockets);
        }
        if let Some(st) = secret_writes {
            let sw =
                harkroom_server::core::secret_writes::routes(st, auth.clone(), state.cors.clone());
            core_routes.router = core_routes.router.merge(sw.router);
            core_routes.http.extend(sw.http);
            core_routes.sockets.extend(sw.sockets);
        }
        if let Some(st) = secret_reveal {
            let sr =
                harkroom_server::core::secret_reveal::routes(st, auth.clone(), state.cors.clone());
            core_routes.router = core_routes.router.merge(sr.router);
            core_routes.http.extend(sr.http);
            core_routes.sockets.extend(sr.sockets);
        }
        if let Some(st) = agent_secret_reveal {
            let ar = harkroom_server::core::agent_secret_reveal::routes(
                st,
                auth.clone(),
                state.cors.clone(),
            );
            core_routes.router = core_routes.router.merge(ar.router);
            core_routes.http.extend(ar.http);
            core_routes.sockets.extend(ar.sockets);
        }
        if let Some(st) = agent_secret_create {
            // 만들기·회전 두 줄: 글 경로(소유자 알림)와 두 줄의 칸 권한이 다 있을 때만 — 아니면 TS 에 남는다.
            let st = match (&post_write, agent_secret_write_ok) {
                (Some(w), true) => st.with_post(harkroom_server::core::msg_post::PostState {
                    read: state.pool.clone(),
                    write: w.clone(),
                    up: state.up.clone(),
                    implicit_ok,
                }),
                _ => st,
            };
            let sc = harkroom_server::core::agent_secret_create::routes(
                st,
                auth.clone(),
                state.cors.clone(),
            );
            core_routes.router = core_routes.router.merge(sc.router);
            core_routes.http.extend(sc.http);
            core_routes.sockets.extend(sc.sockets);
        }
        if let Some(write) = secrets_read_write {
            let se = harkroom_server::core::secrets_read::routes(
                harkroom_server::core::secrets_read::SecretsReadState {
                    read: state.pool.clone(),
                    write,
                    trust: state.trust.clone(),
                },
                auth.clone(),
                state.cors.clone(),
            );
            core_routes.router = core_routes.router.merge(se.router);
            core_routes.http.extend(se.http);
            core_routes.sockets.extend(se.sockets);
        }
        // S5.4 MI3 — 투영 설정 읽기 1줄. 권한이 있을 때만 — 아니면 TS 에 남는다(PUT 은 언제나 TS).
        if settings_rest_on {
            let sr = harkroom_server::core::settings_rest::routes(
                harkroom_server::core::settings_rest::SettingsRestState {
                    read: state.pool.clone(),
                    // TS `config.avcsBaseUrl` 과 같이 원문(`?? null`) — 빈 문자열도 그대로 싣는다.
                    env_base_url: std::env::var("AVCS_BASE_URL").ok(),
                    write: settings_projection_write.clone(),
                    trust: state.trust.clone(),
                },
                auth.clone(),
                state.cors.clone(),
            );
            core_routes.router = core_routes.router.merge(sr.router);
            core_routes.http.extend(sr.http);
            core_routes.sockets.extend(sr.sockets);
        }
        // S5.4 TP1 — 계획판 읽기 1줄. 권한이 있을 때만 — 아니면 TS 에 남는다(시작·관리자·자동 끄기·MCP 쓰기는 언제나 TS).
        if thread_plan_read_on {
            let tp = harkroom_server::core::thread_plan_read::routes(
                state.pool.clone(),
                auth.clone(),
                state.cors.clone(),
            );
            core_routes.router = core_routes.router.merge(tp.router);
            core_routes.http.extend(tp.http);
            core_routes.sockets.extend(tp.sockets);
        }
        // S5.4 RD1 — 초대·API 연결 목록 읽기 2줄. 권한이 있을 때만 — 아니면 TS 에 남는다.
        if misc_reads_on {
            let mr = harkroom_server::core::misc_reads::routes(
                state.pool.clone(),
                auth.clone(),
                state.cors.clone(),
            );
            core_routes.router = core_routes.router.merge(mr.router);
            core_routes.http.extend(mr.http);
            core_routes.sockets.extend(mr.sockets);
        }
        // S5.4 CH2 — 읽음·미읽음 표시 2줄. 권한이 다 있을 때만 — 아니면 TS 에 남는다(`PATCH /channels/{id}/pref` 는 언제나 TS).
        // S5.4 CH3b — 자동 멘션 걸기·풀기·문서 저장 3줄. 권한이 다 있을 때만 — 아니면 TS 에 남는다.
        // S5.4 CH4a — 채널 만들기·고치기 2줄. 권한이 다 있을 때만 — 아니면 TS 에 남는다. `DELETE /channels/{id}` 는 언제나 TS(첨부 저장소가 TS 에만 있다).
        // S5.4 CH4b-1 — DM 열기 1줄. 권한이 다 있을 때만 — 아니면 TS 에 남는다.
        if let Some(write) = dm_open {
            let dm = harkroom_server::core::dm_open::routes(
                harkroom_server::core::dm_open::DmOpenState {
                    read: state.pool.clone(),
                    write,
                    get_dms: !ts_get_dms,
                },
                auth.clone(),
                state.cors.clone(),
            );
            core_routes.router = core_routes.router.merge(dm.router);
            core_routes.http.extend(dm.http);
            core_routes.sockets.extend(dm.sockets);
        }
        // S5.4 CH4b-2 — 멤버 넣기·빼기 2줄. 글 올리기 코어와 멤버 권한이 다 있을 때만 — 아니면 TS 에 남는다.
        if let Some(write) = members_write {
            let cm = harkroom_server::core::channel_members::routes(
                harkroom_server::core::channel_members::MembersState {
                    post: harkroom_server::core::msg_post::PostState {
                        read: state.pool.clone(),
                        write,
                        up: state.up.clone(),
                        implicit_ok,
                    },
                    trust: (*state.trust).clone(),
                },
                auth.clone(),
                state.cors.clone(),
            );
            core_routes.router = core_routes.router.merge(cm.router);
            core_routes.http.extend(cm.http);
            core_routes.sockets.extend(cm.sockets);
        }
        // S5.4 TM4 — 스레드 모델 지정 1줄. 오퍼레이터 코어·글 올리기 코어·권한이 다 있을 때만 — 아니면 TS 에 남는다.
        if let Some(write) = thread_model_set {
            let ts = harkroom_server::core::thread_model_set::routes(
                harkroom_server::core::thread_model_set::SetState {
                    post: harkroom_server::core::msg_post::PostState {
                        read: state.pool.clone(),
                        write,
                        up: state.up.clone(),
                        implicit_ok,
                    },
                    trust: (*state.trust).clone(),
                },
                auth.clone(),
                state.cors.clone(),
            );
            core_routes.router = core_routes.router.merge(ts.router);
            core_routes.http.extend(ts.http);
            core_routes.sockets.extend(ts.sockets);
        }
        // S5.4 TM2 — 스레드 모델 지정 풀기. 글 올리기 코어와 풀기 권한이 다 있을 때만 — 아니면 TS 에 남는다.
        if let Some(write) = thread_model_clear.clone() {
            let tc = harkroom_server::core::thread_model_clear::routes(
                harkroom_server::core::thread_model_clear::ClearState {
                    post: harkroom_server::core::msg_post::PostState {
                        read: state.pool.clone(),
                        write,
                        up: state.up.clone(),
                        implicit_ok,
                    },
                    trust: (*state.trust).clone(),
                },
                auth.clone(),
                state.cors.clone(),
            );
            core_routes.router = core_routes.router.merge(tc.router);
            core_routes.http.extend(tc.http);
            core_routes.sockets.extend(tc.sockets);
        }
        // S5.4 — `POST /agent/api-results`. 글 올리기 코어와 칸 권한이 다 있을 때만 — 아니면 TS 에 남는다.
        if let Some(write) = api_results_write {
            let ar = harkroom_server::core::api_results::routes(
                harkroom_server::core::api_results::ApiResultsState {
                    post: harkroom_server::core::msg_post::PostState {
                        read: state.pool.clone(),
                        write,
                        up: state.up.clone(),
                        implicit_ok,
                    },
                },
                auth.clone(),
                state.cors.clone(),
            );
            core_routes.router = core_routes.router.merge(ar.router);
            core_routes.http.extend(ar.http);
            core_routes.sockets.extend(ar.sockets);
        }
        // S5.4 — `POST /agent/pr-watches/{id}/status`. 글 올리기 코어와 칸 권한이 다 있을 때만 — 아니면 TS 에 남는다.
        if let Some(write) = pr_watch_status_write {
            let ps = harkroom_server::core::pr_watch_status::routes(
                harkroom_server::core::msg_post::PostState {
                    read: state.pool.clone(),
                    write,
                    up: state.up.clone(),
                    implicit_ok,
                },
                auth.clone(),
                state.cors.clone(),
            );
            core_routes.router = core_routes.router.merge(ps.router);
            core_routes.http.extend(ps.http);
            core_routes.sockets.extend(ps.sockets);
        }
        // S5.4 — `POST /agent/merge-checks`·`/agent/merge-results`(부분). 오퍼레이터·모양 판정과 (권한이 있으면) 이른 거절만 Rust, 나머지는 TS 로 넘긴다.
        if matches!(core_mode, harkroom_server::core::CoreMode::Rust) {
            let mk = harkroom_server::core::merge_checks::routes(
                state.up.clone(),
                merge_checks_deny.clone(),
                merge_checks_allow.clone(),
                merge_checks_card.clone(),
                merge_results_read.clone(),
                merge_results_post.clone(),
                auth.clone(),
                state.cors.clone(),
            );
            core_routes.router = core_routes.router.merge(mk.router);
            core_routes.http.extend(mk.http);
            core_routes.sockets.extend(mk.sockets);
        }
        // S5.4 — `POST /agent/api-checks`(부분). 오퍼레이터·모양 판정과 (권한이 있으면) 임대 거절만 Rust, 나머지는 TS 로 넘긴다.
        if matches!(core_mode, harkroom_server::core::CoreMode::Rust) {
            let ac = harkroom_server::core::api_checks::routes(
                state.up.clone(),
                api_checks_deny.clone(),
                auth.clone(),
                state.cors.clone(),
            );
            core_routes.router = core_routes.router.merge(ac.router);
            core_routes.http.extend(ac.http);
            core_routes.sockets.extend(ac.sockets);
        }
        // S5.4 TP3 — 계획 자동 진행 끄기. 글 올리기 코어와 끄기 칸 권한이 다 있을 때만 — 아니면 TS 에 남는다.
        let plan_manager_post =
            thread_plan_auto_off
                .clone()
                .map(|write| harkroom_server::core::msg_post::PostState {
                    read: state.pool.clone(),
                    write,
                    up: state.up.clone(),
                    implicit_ok,
                });
        if let Some(write) = thread_plan_auto_off {
            let pa = harkroom_server::core::thread_plan_auto_off::routes(
                harkroom_server::core::thread_plan_auto_off::AutoOffState {
                    post: harkroom_server::core::msg_post::PostState {
                        read: state.pool.clone(),
                        write,
                        up: state.up.clone(),
                        implicit_ok,
                    },
                },
                auth.clone(),
                state.cors.clone(),
            );
            core_routes.router = core_routes.router.merge(pa.router);
            core_routes.http.extend(pa.http);
            core_routes.sockets.extend(pa.sockets);
        }
        // S5.4 TP4 — 계획 관리 에이전트 바꾸기. MCP 계획 쓰기(같은 쓰기 경로·같은 권한)가 켜졌을 때만 — 아니면 TS 에 남는다.
        if let Some(write) = plan_write.clone() {
            let pm = harkroom_server::core::thread_plan_manager::routes(
                harkroom_server::core::thread_plan_manager::ManagerState {
                    write,
                    up: state.up.clone(),
                    post: plan_manager_post.clone(),
                },
                auth.clone(),
                state.cors.clone(),
            );
            core_routes.router = core_routes.router.merge(pm.router);
            core_routes.http.extend(pm.http);
            core_routes.sockets.extend(pm.sockets);
        }
        // S5.4 CT1 — 채널에 팀 넣기. 쓰기 풀에 칸 권한이 다 있을 때만 — 아니면 TS 에 남는다.
        if let Some(write) = channel_team_add {
            let ta = harkroom_server::core::channel_team_add::routes(
                harkroom_server::core::channel_team_add::TeamAddState {
                    write,
                    trust: (*state.trust).clone(),
                },
                auth.clone(),
                state.cors.clone(),
            );
            core_routes.router = core_routes.router.merge(ta.router);
            core_routes.http.extend(ta.http);
            core_routes.sockets.extend(ta.sockets);
        }
        if let Some(write) = channel_create_update {
            let cu = harkroom_server::core::channel_create_update::routes(
                harkroom_server::core::channel_create_update::CreateUpdateState {
                    read: state.pool.clone(),
                    write,
                    trust: (*state.trust).clone(),
                },
                auth.clone(),
                state.cors.clone(),
            );
            core_routes.router = core_routes.router.merge(cu.router);
            core_routes.http.extend(cu.http);
            core_routes.sockets.extend(cu.sockets);
        }
        if let Some((write, storage)) = channel_delete {
            let cd = harkroom_server::core::channel_delete::routes(
                harkroom_server::core::channel_delete::DeleteState {
                    read: state.pool.clone(),
                    write,
                    trust: (*state.trust).clone(),
                    storage,
                },
                auth.clone(),
                state.cors.clone(),
            );
            core_routes.router = core_routes.router.merge(cd.router);
            core_routes.http.extend(cd.http);
            core_routes.sockets.extend(cd.sockets);
        }
        // 주소 단위(`upload:{ip}`·`login:{ip}` …)와 비밀번호 추측 표면(step-up·login)은 이 프로세스에서 리미터 하나를
        // 나눠 쓴다(키는 서로 다르다).
        let auth_limiter = std::sync::Arc::new(harkroom_server::rate_limit::RateLimiter::default());
        if let Some((write, storage, max_bytes)) = attachment_upload {
            let au = harkroom_server::core::attachment_upload::routes(
                harkroom_server::core::attachment_upload::UploadState {
                    write,
                    storage,
                    max_bytes,
                    up: state.up.clone(),
                    limiter: auth_limiter.clone(),
                    trust: state.trust.clone(),
                    leak: agent_upload_leak.clone(),
                },
                auth.clone(),
                state.cors.clone(),
            );
            core_routes.router = core_routes.router.merge(au.router);
            core_routes.http.extend(au.http);
            core_routes.sockets.extend(au.sockets);
        }
        if let Some((write, storage)) = avatar_write {
            let aw = harkroom_server::core::avatar_write::routes(
                harkroom_server::core::avatar_write::AvatarWriteState {
                    read: state.pool.clone(),
                    write,
                    storage,
                    up: state.up.clone(),
                    trust: state.trust.clone(),
                },
                auth.clone(),
                state.cors.clone(),
            );
            core_routes.router = core_routes.router.merge(aw.router);
            core_routes.http.extend(aw.http);
            core_routes.sockets.extend(aw.sockets);
        }
        if let Some(storage) = workspace_icon {
            let wi = harkroom_server::core::avatar_read::icon_routes(
                harkroom_server::core::avatar_read::AvatarReadState {
                    read: state.pool.clone(),
                    storage,
                    up: state.up.clone(),
                },
                auth.clone(),
                state.cors.clone(),
            );
            core_routes.router = core_routes.router.merge(wi.router);
            core_routes.http.extend(wi.http);
            core_routes.sockets.extend(wi.sockets);
        }
        if let Some(storage) = avatar_read {
            let av = harkroom_server::core::avatar_read::routes(
                harkroom_server::core::avatar_read::AvatarReadState {
                    read: state.pool.clone(),
                    storage,
                    up: state.up.clone(),
                },
                auth.clone(),
                state.cors.clone(),
            );
            core_routes.router = core_routes.router.merge(av.router);
            core_routes.http.extend(av.http);
            core_routes.sockets.extend(av.sockets);
        }
        if let Some(storage) = attachment_download {
            let ad = harkroom_server::core::attachment_download::routes(
                harkroom_server::core::attachment_download::DownloadState {
                    read: state.pool.clone(),
                    storage,
                },
                auth.clone(),
                state.cors.clone(),
            );
            core_routes.router = core_routes.router.merge(ad.router);
            core_routes.http.extend(ad.http);
            core_routes.sockets.extend(ad.sockets);
        }
        if let Some(write) = auto_mention_doc {
            let am = harkroom_server::core::channel_auto_mention_doc::routes(
                harkroom_server::core::channel_auto_mention_doc::AutoMentionDocState {
                    read: state.pool.clone(),
                    write,
                    trust: (*state.trust).clone(),
                },
                auth.clone(),
                state.cors.clone(),
            );
            core_routes.router = core_routes.router.merge(am.router);
            core_routes.http.extend(am.http);
            core_routes.sockets.extend(am.sockets);
        }
        if let Some(write) = channel_read_write {
            let cr = harkroom_server::core::channel_read_write::routes(
                harkroom_server::core::channel_read_write::ReadWriteState {
                    read: state.pool.clone(),
                    write,
                },
                auth.clone(),
                state.cors.clone(),
            );
            core_routes.router = core_routes.router.merge(cr.router);
            core_routes.http.extend(cr.http);
            core_routes.sockets.extend(cr.sockets);
        }
        // S5.4 CH3a — 핀·예약 글 쓰기 4줄. 권한이 다 있을 때만 — 아니면 TS 에 남는다.
        if let Some(write) = pins_sched {
            let ps = harkroom_server::core::channel_pins_sched::routes(
                harkroom_server::core::channel_pins_sched::PinsSchedState {
                    read: state.pool.clone(),
                    write,
                    trust: (*state.trust).clone(),
                },
                auth.clone(),
                state.cors.clone(),
            );
            core_routes.router = core_routes.router.merge(ps.router);
            core_routes.http.extend(ps.http);
            core_routes.sockets.extend(ps.sockets);
        }
        // S5.4 — 로그인 ID 읽기 1줄. 권한이 있을 때만 — 아니면 TS 에 남는다(재설정 코드 발급은 언제나 TS).
        if let Some(write) = account_login_ids_write {
            let li = harkroom_server::core::account_login_ids::routes(
                harkroom_server::core::account_login_ids::LoginIdsState {
                    read: state.pool.clone(),
                    write,
                    trust: state.trust.clone(),
                    once: Default::default(),
                },
                auth.clone(),
                state.cors.clone(),
            );
            core_routes.router = core_routes.router.merge(li.router);
            core_routes.http.extend(li.http);
            core_routes.sockets.extend(li.sockets);
        }
        // S5.4 — 초대 안내 페이지(`GET /join`). DB 를 쓰지 않아 코어 모드면 언제나 붙는다.
        if matches!(core_mode, harkroom_server::core::CoreMode::Rust) {
            let jp = harkroom_server::core::join_page::routes(state.cors.clone());
            core_routes.router = core_routes.router.merge(jp.router);
            core_routes.http.extend(jp.http);
            core_routes.sockets.extend(jp.sockets);
        }
        // S5.4 — 재설정 코드 발급 1줄. 권한이 있을 때만 — 아니면 TS 에 남는다.
        if let Some(write) = account_reset_code_issue_write {
            let ri = harkroom_server::core::account_reset_code_issue::routes(
                harkroom_server::core::account_reset_code_issue::ResetCodeIssueState {
                    read: state.pool.clone(),
                    write,
                    trust: state.trust.clone(),
                },
                auth.clone(),
                state.cors.clone(),
            );
            core_routes.router = core_routes.router.merge(ri.router);
            core_routes.http.extend(ri.http);
            core_routes.sockets.extend(ri.sockets);
        }
        // S5.4 — 역할 바꾸기 1줄. 권한이 있을 때만 — 아니면 TS 에 남는다.
        if let Some(write) = account_role_write {
            let ar = harkroom_server::core::account_role::routes(
                harkroom_server::core::account_role::AccountRoleState {
                    write,
                    trust: state.trust.clone(),
                },
                auth.clone(),
                state.cors.clone(),
            );
            core_routes.router = core_routes.router.merge(ar.router);
            core_routes.http.extend(ar.http);
            core_routes.sockets.extend(ar.sockets);
        }
        // S5.4 — grant 거두기 1줄. 권한이 있을 때만 — 아니면 TS 에 남는다.
        if let Some(write) = account_grant_revoke_write {
            let gr = harkroom_server::core::account_grant_revoke::routes(
                harkroom_server::core::account_grant_revoke::AccountGrantRevokeState {
                    write,
                    trust: state.trust.clone(),
                },
                auth.clone(),
                state.cors.clone(),
            );
            core_routes.router = core_routes.router.merge(gr.router);
            core_routes.http.extend(gr.http);
            core_routes.sockets.extend(gr.sockets);
        }
        // S5.4 — 에이전트 만들기 앞단(`POST /accounts/agents`): 능력 판정만 Rust, 나머지는 안에서 TS 로.
        if matches!(core_mode, harkroom_server::core::CoreMode::Rust) {
            use harkroom_server::core::agent_create as acm;
            let ac = acm::routes(
                acm::AgentCreateState {
                    pool: state.pool.clone(),
                    up: state.up.clone(),
                    write: agent_create_write.clone(),
                    patch_write: agent_patch_write.clone(),
                    patch_rename: agent_patch_rename,
                    patch_disable: agent_patch_disable,
                    trust: state.trust.clone(),
                },
                auth.clone(),
                state.cors.clone(),
            );
            core_routes.router = core_routes.router.merge(ac.router);
            core_routes.http.extend(ac.http);
            core_routes.sockets.extend(ac.sockets);
        }
        // S5.4 — grant 주기 1줄. 권한이 있을 때만 — 아니면 TS 에 남는다.
        if let Some(write) = account_grant_give_write {
            let gg = harkroom_server::core::account_grant_give::routes(
                harkroom_server::core::account_grant_give::AccountGrantGiveState {
                    write,
                    trust: state.trust.clone(),
                    up: state.up.clone(),
                },
                auth.clone(),
                state.cors.clone(),
            );
            core_routes.router = core_routes.router.merge(gg.router);
            core_routes.http.extend(gg.http);
            core_routes.sockets.extend(gg.sockets);
        }
        // S5.4 — 자기 비밀번호 바꾸기 1줄. 권한이 있을 때만 — 아니면 TS 에 남는다.
        if let Some(write) = auth_password_write {
            let ap = harkroom_server::core::auth_password::routes(
                harkroom_server::core::auth_password::AuthPasswordState {
                    write,
                    trust: state.trust.clone(),
                },
                auth.clone(),
                state.cors.clone(),
            );
            core_routes.router = core_routes.router.merge(ap.router);
            core_routes.http.extend(ap.http);
            core_routes.sockets.extend(ap.sockets);
        }
        // S5.4 — 재설정 코드 거두기 1줄. 권한이 있을 때만 — 아니면 TS 에 남는다(발급은 언제나 TS).
        if let Some(write) = account_reset_code_revoke_write {
            let rc = harkroom_server::core::account_reset_code_revoke::routes(
                harkroom_server::core::account_reset_code_revoke::ResetCodeRevokeState {
                    read: state.pool.clone(),
                    write,
                    trust: state.trust.clone(),
                },
                auth.clone(),
                state.cors.clone(),
            );
            core_routes.router = core_routes.router.merge(rc.router);
            core_routes.http.extend(rc.http);
            core_routes.sockets.extend(rc.sockets);
        }
        // S5.4 — 에이전트 지우기 1줄. 권한·저장소가 있을 때만 — 아니면 TS 에 남는다.
        if let Some((write, storage)) = agent_delete_write {
            let ad = harkroom_server::core::agent_delete::routes(
                harkroom_server::core::agent_delete::AgentDeleteState {
                    write,
                    storage,
                    trust: state.trust.clone(),
                },
                auth.clone(),
                state.cors.clone(),
            );
            core_routes.router = core_routes.router.merge(ad.router);
            core_routes.http.extend(ad.http);
            core_routes.sockets.extend(ad.sockets);
        }
        // S5.4 — 고를 수 있는 모델 목록 쓰기 1줄. 권한이 있을 때만 — 아니면 TS 에 남는다.
        if let Some(write) = pickable_models_write {
            let pm = harkroom_server::core::pickable_models::routes(
                harkroom_server::core::pickable_models::PickableModelsState {
                    write,
                    // `clearOutside: true` 는 글 올리기 코어·풀기 권한이 다 있을 때만 Rust — 아니면 그 갈래만 TS.
                    clear: thread_model_clear.clone().map(|w| {
                        harkroom_server::core::msg_post::PostState {
                            read: state.pool.clone(),
                            write: w,
                            up: state.up.clone(),
                            implicit_ok,
                        }
                    }),
                    trust: state.trust.clone(),
                    up: state.up.clone(),
                },
                auth.clone(),
                state.cors.clone(),
            );
            core_routes.router = core_routes.router.merge(pm.router);
            core_routes.http.extend(pm.http);
            core_routes.sockets.extend(pm.sockets);
        }
        // S5.4 — 보관소 잠그기 1줄. 권한이 있을 때만 — 아니면 TS 에 남는다(열기 POST 는 `step_up_open`).
        if let Some(write) = step_up_end_write {
            let su = harkroom_server::core::step_up_end::routes(
                harkroom_server::core::step_up_end::StepUpEndState {
                    write,
                    trust: state.trust.clone(),
                },
                auth.clone(),
                state.cors.clone(),
            );
            core_routes.router = core_routes.router.merge(su.router);
            core_routes.http.extend(su.http);
            core_routes.sockets.extend(su.sockets);
        }
        // S5.4 — 보관소 잠금 해제 1줄. 권한이 있을 때만 — 아니면 TS 에 남는다.
        // 시도 상한(`stepUp:{accountId}`)은 이 프로세스의 리미터가 센다 — TS 리미터와 따로 센다. login·passwordReset·stepUp 의
        // 계정 단위 키는 같이 옮겨야 한다(login 은 아직 TS). 옮길 때 이 리미터 하나를 나눠 쓴다.
        // 리미터 `auth_limiter` 는 위(첨부 올리기 줄 앞)에서 만들었다.
        if let Some(write) = step_up_open_write {
            let so = harkroom_server::core::step_up_open::routes(
                harkroom_server::core::step_up_open::StepUpOpenState::new(
                    write,
                    state.trust.clone(),
                    auth_limiter.clone(),
                ),
                auth.clone(),
                state.cors.clone(),
            );
            core_routes.router = core_routes.router.merge(so.router);
            core_routes.http.extend(so.http);
            core_routes.sockets.extend(so.sockets);
        }
        // S5.4 — 로그인 1줄(주소 단위 `login:{ip}` 훅 포함). 권한이 있을 때만 — 아니면 TS 에 남는다.
        if let Some(write) = auth_login_write {
            let al = harkroom_server::core::auth_login::routes(
                harkroom_server::core::auth_login::AuthLoginState {
                    write,
                    trust: state.trust.clone(),
                    limiter: auth_limiter.clone(),
                    dummy: std::sync::Arc::new(std::sync::OnceLock::new()),
                },
                state.cors.clone(),
            );
            core_routes.router = core_routes.router.merge(al.router);
            core_routes.http.extend(al.http);
            core_routes.sockets.extend(al.sockets);
        }
        // S5.4 — 가입 표면 3줄(주소 단위 `signup:{ip}` 훅 포함, 셋이 한 키). 권한이 있을 때만 — 아니면 셋 다 TS 에 남는다.
        if let Some(write) = auth_signup_write {
            let su = harkroom_server::core::auth_signup::routes(
                harkroom_server::core::auth_signup::AuthSignupState {
                    write,
                    trust: state.trust.clone(),
                    limiter: auth_limiter.clone(),
                },
                state.cors.clone(),
            );
            core_routes.router = core_routes.router.merge(su.router);
            core_routes.http.extend(su.http);
            core_routes.sockets.extend(su.sockets);
        }
        // S5.4 — 재설정 코드 쓰기 1줄(주소 단위 `passwordReset:{ip}` 훅 포함). 권한이 있을 때만 — 아니면 TS 에 남는다.
        if let Some(write) = password_reset_use_write {
            let pr = harkroom_server::core::password_reset_use::routes(
                harkroom_server::core::password_reset_use::PasswordResetUseState {
                    write,
                    trust: state.trust.clone(),
                    limiter: auth_limiter.clone(),
                },
                state.cors.clone(),
            );
            core_routes.router = core_routes.router.merge(pr.router);
            core_routes.http.extend(pr.http);
            core_routes.sockets.extend(pr.sockets);
        }
        // S5.4 — 계정 권한 목록 읽기 1줄. 권한이 있을 때만 — 아니면 TS 에 남는다(권한 주기 PUT 은 언제나 TS).
        if account_grants_read_on {
            let ag = harkroom_server::core::account_grants_read::routes(
                state.pool.clone(),
                auth.clone(),
                state.cors.clone(),
            );
            core_routes.router = core_routes.router.merge(ag.router);
            core_routes.http.extend(ag.http);
            core_routes.sockets.extend(ag.sockets);
        }
        // S5.4 AC2 — 에이전트 기억 읽기 2줄. 권한이 있을 때만 — 아니면 TS 에 남는다(정리 후보·백그라운드 읽기는 언제나 TS).
        if agent_memory_read_on {
            let am = harkroom_server::core::agent_memory_read::routes(
                state.pool.clone(),
                auth.clone(),
                state.cors.clone(),
            );
            core_routes.router = core_routes.router.merge(am.router);
            core_routes.http.extend(am.http);
            core_routes.sockets.extend(am.sockets);
        }
        // S5.4 — 기억 정리 후보 1줄. 권한이 있을 때만 — 아니면 TS 에 남는다. JS 와 판정이 갈릴 본문이면 TS 로 넘긴다.
        if agent_memory_audit_read_on {
            let au = harkroom_server::core::agent_memory_audit_read::routes(
                harkroom_server::core::agent_memory_audit_read::AuditReadState {
                    read: state.pool.clone(),
                    up: state.up.clone(),
                },
                auth.clone(),
                state.cors.clone(),
            );
            core_routes.router = core_routes.router.merge(au.router);
            core_routes.http.extend(au.http);
            core_routes.sockets.extend(au.sockets);
        }
        // S5.4 AC3 — 기억 쓰기 다섯 줄 + 백그라운드 켜고 끄기. 권한이 다 있을 때만 — 아니면 TS 에 남는다(회차 되돌리기는 언제나 TS).
        if let Some(write) = agent_memory_write {
            let aw = harkroom_server::core::agent_memory_write::routes(
                harkroom_server::core::agent_memory_write::MemoryWriteState {
                    read: state.pool.clone(),
                    write,
                    trust: (*state.trust).clone(),
                },
                auth.clone(),
                state.cors.clone(),
            );
            core_routes.router = core_routes.router.merge(aw.router);
            core_routes.http.extend(aw.http);
            core_routes.sockets.extend(aw.sockets);
        }
        // S5.4 MS1 — 저장한 글 다섯 줄. 권한이 다 있을 때만 — 아니면 TS 에 남는다.
        if let Some(write) = saved_write {
            let sv = harkroom_server::core::saved::routes(
                harkroom_server::core::saved::SavedState {
                    read: state.pool.clone(),
                    write,
                },
                auth.clone(),
                state.cors.clone(),
            );
            core_routes.router = core_routes.router.merge(sv.router);
            core_routes.http.extend(sv.http);
            core_routes.sockets.extend(sv.sockets);
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
                    deny: ask_deny,
                    approve: ask_approve,
                },
                auth.clone(),
                state.cors.clone(),
            );
            core_routes.router = core_routes.router.merge(ask.router);
            core_routes.http.extend(ask.http);
            core_routes.sockets.extend(ask.sockets);
        }
        // C1c-1 — 글 올리기(`POST /channels/{id}/messages`). 맡지 않는 글은 핸들러가 읽은 바이트 그대로 TS 로 넘긴다.
        // C1c-4c — MCP `message.post` 는 같은 쓰기 풀에 principal 옮겨 적기 칸까지 있을 때만(위 `mcp_post_ok`).
        let mcp_post = post_write.clone().filter(|_| mcp_post_ok).map(|w| {
            std::sync::Arc::new(harkroom_server::core::msg_post::PostState {
                read: state.pool.clone(),
                write: w,
                up: state.up.clone(),
                implicit_ok,
            })
        });
        if let Some(write) = post_write {
            let post = harkroom_server::core::msg_post::routes(
                harkroom_server::core::msg_post::PostState {
                    read: state.pool.clone(),
                    write,
                    up: state.up.clone(),
                    implicit_ok,
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
        // C6a-2 — 스레드 처리 상태. 쓰기 풀에 그 권한이 다 있을 때만 — 아니면 TS 에 남는다.
        if let Some(write) = inbox_thread_write {
            let it = harkroom_server::core::inbox_thread::routes(
                harkroom_server::core::inbox_thread::InboxThreadState {
                    read: state.pool.clone(),
                    write,
                },
                auth.clone(),
                state.cors.clone(),
            );
            core_routes.router = core_routes.router.merge(it.router);
            core_routes.http.extend(it.http);
            core_routes.sockets.extend(it.sockets);
        }
        // C4a-1 — `POST /mcp`. 에이전트 게이트·본문 한도(TS 와 같다) 뒤, Rust 가 답하는 읽기 도구(C4a-3)가 아니면 원래 바이트를 TS 로 투명 전달한다.
        // `turn.cancel` 이 쓸 릴레이 코어 — 릴레이 줄(아래)에서 채운다.
        let relay_cell: std::sync::Arc<
            std::sync::OnceLock<std::sync::Arc<harkroom_server::core::relay_routes::RelayCore>>,
        > = Default::default();
        let mcp = harkroom_server::core::mcp::route::routes(
            state.up.clone(),
            state.pool.clone(),
            // C4b — 도구 묶음마다 그 권한이 다 있는 쓰기 풀일 때만 Rust 가 답한다(리액션 · inbox.read ·
            // 선택 카드 → `message.askBundleResolve` · 묶음 푸시 권한까지 있으면 `message.askBundle`(있던 묶음) · delegation.close · 권한 좁히기 · thread.note · 기억).
            harkroom_server::core::mcp::writes::McpWrites {
                react: mcp_react_write,
                inbox: inbox_write,
                bg: bg_write,
                ask: mcp_ask_write,
                bundle: bundle_write,
                bg_complete: bg_complete_write,
                delegation: mcp_deleg_write,
                grant: grant_write,
                note: note_write,
                plan_read: thread_plan_read_on,
                plan_write,
                plan_auto_off: plan_manager_post.clone().map(std::sync::Arc::new),
                work_item: work_item_write,
                work_item_upsert: work_item_upsert_write,
                pr_watch: pr_watch_write,
                automation: automation_write,
                automation_run: automation_run_write,
                runner_version: runner_version_write,
                inbox_lease: inbox_lease_write,
                inbox_hub: Some(core.hub.clone()),
                grant_delegate: grant_delegate_write,
                memory: mem_write,
                memory_body: mem_body_write,
                delegate: mcp_post.clone().filter(|_| mcp_delegate_ok),
                wake: mcp_post.clone().filter(|_| mcp_wake_ok),
                skill: mcp_post.clone().filter(|_| mcp_skill_ok),
                artifact: mcp_post
                    .clone()
                    .filter(|_| mcp_artifact_ok)
                    .zip(artifact_storage)
                    .map(|(post, storage)| {
                        std::sync::Arc::new(
                            harkroom_server::core::mcp::artifact_publish::ArtifactWrite {
                                post,
                                storage,
                                revise: mcp_artifact_revise,
                                cover: mcp_artifact_cover,
                            },
                        )
                    }),
                post: mcp_post,
                relay_moved: operator_on,
                relay: relay_cell.clone(),
                leak: agent_upload_leak,
            },
            auth.clone(),
            state.cors.clone(),
        );
        core_routes.router = core_routes.router.merge(mcp.router);
        core_routes.http.extend(mcp.http);
        core_routes.sockets.extend(mcp.sockets);
        if let Some(write) = operator_write {
            // C2a — 오퍼레이터 소켓·REST. 허브는 프로세스에 하나이고 C2b~C5 의 소비자가 같은 것을 받는다.
            let op_hub = harkroom_server::core::operator_hub::OperatorHub::new();
            let operators = harkroom_server::core::operator::OperatorCore::new(
                state.pool.clone(),
                write.clone(),
                state.trust.clone(),
                core.hub.clone(),
                op_hub.clone(),
                harkroom_server::core::operator::OpTiming::from_env(),
            );
            let op = harkroom_server::core::operator::routes(
                operators,
                auth.clone(),
                state.cors.clone(),
            );
            core_routes.router = core_routes.router.merge(op.router);
            core_routes.http.extend(op.http);
            core_routes.sockets.extend(op.sockets);
            // AC5 안전판 — TS 허브는 이제 비어 있으므로, 그 허브로 오퍼레이터에게 알리거나 소켓을 끊는 TS 줄은 옮겨질 때까지 503.
            let guard =
                harkroom_server::core::operator_guard::routes(auth.clone(), state.cors.clone());
            core_routes.router = core_routes.router.merge(guard.router);
            core_routes.http.extend(guard.http);
            // C6c-3 — 에이전트 릴레이(`/agent-sessions*`·`/agent-attach`). 러너 소켓이 이 허브에 붙으므로 오퍼레이터와 **함께만** 옮긴다.
            {
                use harkroom_server::core::{
                    relay, relay_attention, relay_link, relay_live, relay_routes, turn_settle,
                };
                let hub = relay::RelayHub::new(Some(relay_attention::attention_hook(
                    state.pool.clone(),
                    write.clone(),
                )));
                let presence = relay_live::PresenceMark::new(
                    write.clone(),
                    Some(relay_attention::online_hook(write.clone())),
                    relay_live::LiveOpts::default().on_error,
                );
                // ⓖ — offline 은 스윕이 낸다(TS `startSweep`). 프로세스와 함께 산다.
                presence.start_sweep();
                let link = relay_link::RelayLink::spawn(
                    hub,
                    op_hub,
                    relay_link::db_assign_check(state.pool.clone()),
                    relay_live::link_hooks(relay_live, Some(presence)),
                );
                let rc = relay_routes::RelayCore::new(
                    state.pool.clone(),
                    write.clone(),
                    state.trust.clone(),
                    link,
                    core.allowed_origins.clone(),
                    harkroom_server::core::ws::Timing::from_env(),
                    turn_settle::settle_hook(write),
                );
                let _ = relay_cell.set(rc.clone());
                let r = relay_routes::routes(rc, auth, state.cors.clone());
                core_routes.router = core_routes.router.merge(r.router);
                core_routes.http.extend(r.http);
                core_routes.sockets.extend(r.sockets);
            }
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
            "rust (/ws, /ws-ticket, /operator, /operators*, /agent-sessions*, /agent-attach)"
        } else if core_router.is_some() {
            "rust (/ws, /ws-ticket; operator stays ts)"
        } else {
            "ts"
        }
    );
    let moved: Vec<routes::Moved> = routes::MOVED
        .iter()
        .copied()
        .filter(|m| !(dm_core_on && m.key == "GET /dms"))
        .collect();
    let app = routes::router(state, &moved, &ts);
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

/// 쓰기 풀에 Rust 가 맡을 길의 권한(GRANT)이 빠졌다. 기본은 예전대로 그 길을 TS 로 넘긴다(TS 운영에 영향 없음).
/// `HARKROOM_REQUIRE_GRANTS=1` 이면 넘기지 않고 기동을 거절한다(exit 1) — 배포가 GRANT 를 덜 깐 것을 조용히 TS 로 덮지 않으려면 켠다.
fn refuse_missing_grants(missing: &[String]) {
    if !require_grants(std::env::var("HARKROOM_REQUIRE_GRANTS").ok().as_deref()) {
        return;
    }
    eprintln!(
        "front: refusing to start — missing privileges {missing:?} (HARKROOM_REQUIRE_GRANTS=1; unset it to forward to TS instead)"
    );
    std::process::exit(1);
}

fn require_grants(v: Option<&str>) -> bool {
    matches!(v, Some("1" | "true"))
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
            refuse_missing_grants(&m);
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
        bg, bg_produce, delegation_deadline, mandate_idle, outbox_prune, permission_expire,
        retention, scheduled, wake,
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
    let open = |max: u32| loop_pool_options(max).connect(&url);
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
    // S5.4 L1 — 위임 기한 스윕. 스위치(`HARKROOM_DELEGATION_V2`) 값을 모르면 v0/v1 을 못 고르므로 띄우지 않는다(TS 에 남는다).
    match delegation_deadline::v2_switch(std::env::var("HARKROOM_DELEGATION_V2").ok().as_deref()) {
        None => eprintln!("front: loop delegation.deadline off — HARKROOM_DELEGATION_V2 unset"),
        Some(v2) => match write::missing_in(
            &pool,
            delegation_deadline::DELEGATION_DEADLINE_PRIVILEGES,
            delegation_deadline::DELEGATION_DEADLINE_SEQUENCE_PRIVILEGES,
        )
        .await
        {
            Ok(m) if m.is_empty() => {
                eprintln!(
                    "front: loop delegation.deadline on (v2={v2}; runs only while server_loop owner is rust)"
                );
                delegation_deadline::spawn(gate.clone(), pool.clone(), v2);
            }
            Ok(m) => eprintln!("front: loop delegation.deadline off — missing privileges {m:?}"),
            Err(e) => {
                eprintln!("front: loop delegation.deadline off — privilege check failed: {e}")
            }
        },
    }
    // C5c-4 — event_outbox 정리(보존 5분이 지난 줄, 1분마다). 문지기 이름 `outbox.prune`.
    match write::missing_in(&pool, outbox_prune::OUTBOX_PRUNE_PRIVILEGES, &[]).await {
        Ok(m) if m.is_empty() => {
            eprintln!("front: loop outbox.prune on (runs only while server_loop owner is rust)");
            outbox_prune::spawn(gate.clone(), pool.clone());
        }
        Ok(m) => eprintln!("front: loop outbox.prune off — missing privileges {m:?}"),
        Err(e) => eprintln!("front: loop outbox.prune off — privilege check failed: {e}"),
    }
    // decision 4 — avcs 투영(lease·커서·상태 줄). 문지기 이름 `projection`(줄이 없으면 `ts` — 꺼짐).
    {
        use harkroom_server::loops::projection as pj;
        match write::missing_in(
            &pool,
            pj::PROJECTION_PRIVILEGES,
            pj::PROJECTION_SEQUENCE_PRIVILEGES,
        )
        .await
        {
            Ok(m) if m.is_empty() => {
                eprintln!("front: loop projection on (runs only while server_loop owner is rust)");
                pj::spawn(gate.clone(), pool.clone());
            }
            Ok(m) => eprintln!("front: loop projection off — missing privileges {m:?}"),
            Err(e) => eprintln!("front: loop projection off — privilege check failed: {e}"),
        }
    }
    // S5.4 L1 — 예약 글 발송. 글 쓰기 권한 + 예약 행 표시 칸이 다 있어야 띄운다.
    let post_privs = [
        harkroom_server::core::msg_post::MESSAGE_POST_PRIVILEGES,
        scheduled::SCHEDULED_PRIVILEGES,
    ]
    .concat();
    let seqs = harkroom_server::core::msg_post::MESSAGE_POST_SEQUENCE_PRIVILEGES;
    match write::missing_in(&pool, &post_privs, seqs).await {
        Ok(m) if m.is_empty() => {
            let implicit_ok = matches!(write::missing_in(&pool, harkroom_server::core::implicit_delegation::IMPLICIT_DELEGATION_PRIVILEGES, &[]).await, Ok(m) if m.is_empty());
            eprintln!("front: loop scheduled on (runs only while server_loop owner is rust)");
            scheduled::spawn(gate.clone(), pool.clone(), implicit_ok);
        }
        Ok(m) => eprintln!("front: loop scheduled off — missing privileges {m:?}"),
        Err(e) => eprintln!("front: loop scheduled off — privilege check failed: {e}"),
    }
    // S5.4 — 자동화 sweep(골격: 발송 단계 일부만, `loops::automation` 모듈 문서의 TODO). 주인 `automation` 은 TODO 가 끝날 때까지 `ts`.
    let auto_privs = [
        harkroom_server::core::msg_post::MESSAGE_POST_PRIVILEGES,
        harkroom_server::loops::automation::AUTOMATION_SWEEP_PRIVILEGES,
    ]
    .concat();
    match write::missing_in(&pool, &auto_privs, seqs).await {
        Ok(m) if m.is_empty() => {
            let implicit_ok = matches!(write::missing_in(&pool, harkroom_server::core::implicit_delegation::IMPLICIT_DELEGATION_PRIVILEGES, &[]).await, Ok(m) if m.is_empty());
            eprintln!("front: loop automation on (runs only while server_loop owner is rust)");
            harkroom_server::loops::automation::spawn(gate.clone(), pool.clone(), implicit_ok);
        }
        Ok(m) => eprintln!("front: loop automation off — missing privileges {m:?}"),
        Err(e) => eprintln!("front: loop automation off — privilege check failed: {e}"),
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
    // C5e-2 — 푸시 발송. 문지기 이름 `push`.
    match push_sweeper(&pool).await {
        Ok(Some(s)) => {
            eprintln!("front: loop push on (runs only while server_loop owner is rust)");
            harkroom_server::loops::push::spawn(gate.clone(), s);
        }
        Ok(None) => eprintln!("front: loop push off — APNS_* not set"),
        Err(why) => eprintln!("front: loop push off — {why}"),
    }
    // S5.4 L2 — 답 없는 요청 통지. 문지기 이름 `stale` — 글 올리기 권한과 표시 칸이 다 있어야 띄운다.
    match write::missing_in(
        &pool,
        &[
            harkroom_server::core::msg_post::MESSAGE_POST_PRIVILEGES,
            harkroom_server::loops::stale::STALE_PRIVILEGES,
        ]
        .concat(),
        harkroom_server::core::msg_post::MESSAGE_POST_SEQUENCE_PRIVILEGES,
    )
    .await
    {
        Ok(m) if m.is_empty() => {
            eprintln!("front: loop stale on (runs only while server_loop owner is rust)");
            harkroom_server::loops::stale::spawn(
                gate.clone(),
                harkroom_server::core::msg_post::PostState {
                    read: pool.clone(),
                    write: pool.clone(),
                    up: harkroom_server::proxy::Upstream::new(
                        &std::env::var("UPSTREAM_URL").unwrap_or_default(),
                    ),
                    implicit_ok: false,
                },
            );
        }
        Ok(m) => eprintln!("front: loop stale off — missing privileges {m:?}"),
        Err(e) => eprintln!("front: loop stale off — privilege check failed: {e}"),
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

/// 푸시 sweeper 를 세운다(C5e-2). `Ok(None)` 은 APNS_* 가 하나도 없음(TS 도 끔). 띄우지 않는 까닭은 `Err` 로 — 값은 싣지 않는다.
/// 넷이 다 맞을 때만: APNS 설정·키를 읽음 · `PUSH_PRIVILEGES` 가 다 있음 · 누출 검사를 TS 와 같게 할 수 있음(키링을 열었거나, 봉인된
/// 비밀이 하나도 없음 — 키링 없이 비밀이 있으면 에이전트 글의 미리보기를 검사 없이 보내게 되므로 띄우지 않는다).
async fn push_sweeper(
    pool: &sqlx::PgPool,
) -> Result<
    Option<
        std::sync::Arc<
            harkroom_server::loops::push::PushSweeper<harkroom_server::push::apns::ApnsTransport>,
        >,
    >,
    String,
> {
    use harkroom_server::push::apns::{ApnsTransport, load_apns_config};
    let Some(cfg) = load_apns_config(|n| std::env::var(n).ok())? else {
        return Ok(None);
    };
    match write::missing_in(pool, harkroom_server::loops::push::PUSH_PRIVILEGES, &[]).await {
        Ok(m) if m.is_empty() => {}
        Ok(m) => return Err(format!("missing privileges {m:?}")),
        Err(e) => return Err(format!("privilege check failed: {e}")),
    }
    let guard = harkroom_server::loops::push::LeakGuard::from_env_verified(pool)
        .await
        .map_err(|e| format!("secret keys: {e}"))?;
    if !guard.is_on() {
        let sealed: bool = sqlx::query_scalar(
            "select exists (select 1 from secret_version where sealed is not null and revoked_at is null)",
        )
        .fetch_one(pool)
        .await
        .map_err(|e| format!("secret check failed: {e}"))?;
        if sealed {
            return Err(
                "sealed secrets exist but secret keys are not loaded (leak check would be skipped)"
                    .into(),
            );
        }
    }
    let transport = ApnsTransport::new(cfg)?;
    Ok(Some(std::sync::Arc::new(
        harkroom_server::loops::push::PushSweeper::new(pool.clone(), transport, guard),
    )))
}

/// Rust 로 옮긴 루프 수(wake·retention·mandate.idle·permission.expire·outbox.prune·scheduled·bg·push·stale·bg.produce = 10,
/// `spawn_loops` 가 띄우는 순서) — 문지기 풀 크기. 루프를 더하면 같이 올린다.
const LOOP_GATE_CONNECTIONS: u32 = 10;
/// sweep 풀 크기.
const LOOP_SWEEP_CONNECTIONS: u32 = 3;
/// 루프 풀에서 쉬는 연결을 닫기까지. 루프 대부분은 주인이 `rust` 가 아니면 tick 마다 잠깐 잠금만 보고 놓는다 —
/// sqlx 기본(10분)이면 그 잠깐 쓴 연결이 풀 크기만큼 남아 쓰기 역할의 연결 한도를 평소에도 차지한다.
const LOOP_POOL_IDLE: std::time::Duration = std::time::Duration::from_secs(30);

/// 루프 풀(문지기·sweep) 설정 — 최대 `max`, 평소 0 개(`min_connections 0`)로 시작해 쉬는 연결은 [`LOOP_POOL_IDLE`] 뒤 닫는다.
/// 풀 크기(최대)는 그대로라 루프가 겹칠 때 쓸 몫은 줄지 않는다.
fn loop_pool_options(max: u32) -> sqlx::postgres::PgPoolOptions {
    sqlx::postgres::PgPoolOptions::new()
        .max_connections(max)
        .min_connections(0)
        .idle_timeout(LOOP_POOL_IDLE)
        .acquire_timeout(std::time::Duration::from_secs(10))
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
    // 기다리던 MCP 긴 폴을 걷어낸다(TS `lifecycle.onDrain`) — 아니면 graceful shutdown 이 최대 25초 붙잡힌다.
    harkroom_server::core::mcp::inbox_poll::begin_drain();
}

#[cfg(test)]
mod loop_pool_tests {
    use super::*;

    /// 루프 풀은 평소 연결을 쥐지 않고(최소 0), 쉬는 연결을 짧게 닫으며, 최대 크기는 그대로다(s24 S7 — 쓰기 역할 연결 한도).
    #[test]
    fn loop_pools_start_empty_and_drop_idle_connections() {
        for max in [LOOP_GATE_CONNECTIONS, LOOP_SWEEP_CONNECTIONS] {
            let o = loop_pool_options(max);
            assert_eq!(o.get_max_connections(), max);
            assert_eq!(o.get_min_connections(), 0);
            assert_eq!(o.get_idle_timeout(), Some(LOOP_POOL_IDLE));
        }
        assert!(LOOP_POOL_IDLE <= std::time::Duration::from_secs(60));
    }
}

#[cfg(test)]
mod grant_tests {
    #[test]
    fn require_grants_is_opt_in() {
        assert!(!super::require_grants(None));
        assert!(!super::require_grants(Some("0")));
        assert!(!super::require_grants(Some("")));
        assert!(super::require_grants(Some("1")));
        assert!(super::require_grants(Some("true")));
    }
}
