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
                Ok(m) if m.is_empty() => Some(w.clone()),
                Ok(m) => {
                    eprintln!("front: mcp workitem.upsert core off — missing privileges {m:?}");
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
    // S5.4 AC4 — 초대 만들기(메일 없는 것)·취소. 두 겹 잠금: `HARKROOM_CORE=rust` 그리고 쓰기 풀에 그 칸 권한이 다 있을 때만.
    let invites_write = match (&core_mode, &state.write) {
        (harkroom_server::core::CoreMode::Rust, Some(w)) => {
            use harkroom_server::core::invites_write as k;
            match write::missing_in(w, k::INVITES_WRITE_PRIVILEGES, &[]).await {
                Ok(m) if m.is_empty() => Some(w.clone()),
                Ok(m) => {
                    eprintln!("front: invites write core off — missing privileges {m:?}");
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
    // S5.4 AC4 — keys PUT·agent/activity. 두 겹 잠금: `HARKROOM_CORE=rust` 그리고 쓰기 풀에 그 칸 권한이 다 있을 때만.
    let keys_activity_write = match (&core_mode, &state.write) {
        (harkroom_server::core::CoreMode::Rust, Some(w)) => {
            use harkroom_server::core::account_keys_activity as k;
            match write::missing_in(w, k::KEYS_ACTIVITY_PRIVILEGES, &[]).await {
                Ok(m) if m.is_empty() => Some(w.clone()),
                Ok(m) => {
                    eprintln!("front: keys/activity core off — missing privileges {m:?}");
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
    let secrets_read_write = match (&core_mode, &state.write) {
        (harkroom_server::core::CoreMode::Rust, Some(w)) => {
            use harkroom_server::core::secrets_read as s;
            match write::missing_in(w, s::SECRETS_READ_PRIVILEGES, &[]).await {
                Ok(m) if m.is_empty() => Some(w.clone()),
                Ok(m) => {
                    eprintln!("front: secrets read core off — missing privileges {m:?}");
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
    // S5.4 TM1 — 스레드 모델 지정 읽기(`GET /channels/{id}/threads/{rootId}/agent-models`). 읽기 풀만 쓴다.
    // 두 겹 잠금: `HARKROOM_CORE=rust` 그리고 읽기 역할에 그 표들의 SELECT 가 다 있을 때만 — 아니면 TS 에 남는다.
    let thread_models_read = match &core_mode {
        harkroom_server::core::CoreMode::Rust => {
            use harkroom_server::core::thread_models_read as tm;
            match write::missing_in(&state.pool, tm::THREAD_MODELS_READ_PRIVILEGES, &[]).await {
                Ok(m) if m.is_empty() => true,
                Ok(m) => {
                    eprintln!("front: thread models read core off — missing privileges {m:?}");
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
    // S5.4 TP1 — `GET /threads/{rootId}/plan`. 두 겹 잠금: `HARKROOM_CORE=rust` 그리고 읽기 풀에 그 SELECT 가 다 있을 때만. 계획 쓰기는 언제나 TS.
    let thread_plan_read_on = match &core_mode {
        harkroom_server::core::CoreMode::Rust => {
            use harkroom_server::core::thread_plan_read as t;
            match write::missing_in(&state.pool, t::THREAD_PLAN_READ_PRIVILEGES, &[]).await {
                Ok(m) if m.is_empty() => true,
                Ok(m) => {
                    eprintln!("front: thread plan read core off — missing privileges {m:?}");
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
    // S5.4 RD1 — `GET /invites`·`GET /connectors`. 두 겹 잠금: `HARKROOM_CORE=rust` 그리고 읽기 풀에 그 SELECT 가 다 있을 때만. 리스·에이전트 목록·`/agent/config` 는 언제나 TS.
    let misc_reads_on = match &core_mode {
        harkroom_server::core::CoreMode::Rust => {
            use harkroom_server::core::misc_reads as m;
            match write::missing_in(&state.pool, m::MISC_READS_PRIVILEGES, &[]).await {
                Ok(m) if m.is_empty() => true,
                Ok(m) => {
                    eprintln!("front: misc reads core off — missing privileges {m:?}");
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
    // S5.4 CH3b — 자동 멘션 걸기·풀기·채널 문서 저장. 두 겹 잠금: `HARKROOM_CORE=rust` 그리고 쓰기 풀에 그 권한이 다 있을 때만.
    let auto_mention_doc = match (&core_mode, &state.write) {
        (harkroom_server::core::CoreMode::Rust, Some(w)) => {
            use harkroom_server::core::channel_auto_mention_doc as c;
            match write::missing_in(w, c::AUTO_MENTION_DOC_PRIVILEGES, &[]).await {
                Ok(m) if m.is_empty() => Some(w.clone()),
                Ok(m) => {
                    eprintln!("front: auto-mention/doc write core off — missing privileges {m:?}");
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
    // S5.4 AC2 — `GET /accounts/agents/{id}/memory`·`…/memory/{slug}/revisions`·`…/background/runs/{runId}`. 두 겹 잠금: `HARKROOM_CORE=rust` 그리고 읽기 풀에 그 SELECT 가 다 있을 때만. 정리 후보·백그라운드·기억 쓰기는 언제나 TS.
    let agent_memory_read_on = match &core_mode {
        harkroom_server::core::CoreMode::Rust => {
            use harkroom_server::core::agent_memory_read as t;
            match write::missing_in(&state.pool, t::AGENT_MEMORY_READ_PRIVILEGES, &[]).await {
                Ok(m) if m.is_empty() => true,
                Ok(m) => {
                    eprintln!("front: agent memory read core off — missing privileges {m:?}");
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
    // S5.4 — 로그인 ID 읽기(`GET /accounts/login-ids`). 쓰기 풀에 감사 INSERT 가 있을 때만 — 아니면 TS 에 남는다.
    let account_login_ids_write = match (&core_mode, &state.write) {
        (harkroom_server::core::CoreMode::Rust, Some(w)) => {
            use harkroom_server::core::account_login_ids as a;
            match write::missing_in(w, a::ACCOUNT_LOGIN_IDS_PRIVILEGES, &[]).await {
                Ok(m) if m.is_empty() => Some(w.clone()),
                Ok(m) => {
                    eprintln!("front: account login ids core off — missing privileges {m:?}");
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
    // S5.4 — 고를 수 있는 모델 목록 쓰기(`PUT /accounts/agents/{id}/pickable-models`, `clearOutside: true` 는 안에서 TS 로).
    // 두 겹 잠금: `HARKROOM_CORE=rust` 그리고 쓰기 풀에 그 칸 권한이 다 있을 때만.
    let pickable_models_write = match (&core_mode, &state.write) {
        (harkroom_server::core::CoreMode::Rust, Some(w)) => {
            use harkroom_server::core::pickable_models as a;
            match write::missing_in(w, a::PICKABLE_MODELS_PRIVILEGES, &[]).await {
                Ok(m) if m.is_empty() => Some(w.clone()),
                Ok(m) => {
                    eprintln!("front: pickable models core off — missing privileges {m:?}");
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
    // S5.4 — 계정 권한 목록 읽기(`GET /accounts/{id}/grants`). 읽기 풀에 SELECT 가 있을 때만 — 아니면 TS 에 남는다.
    let account_grants_read_on = match &core_mode {
        harkroom_server::core::CoreMode::Rust => {
            use harkroom_server::core::account_grants_read as t;
            match write::missing_in(&state.pool, t::ACCOUNT_GRANTS_READ_PRIVILEGES, &[]).await {
                Ok(m) if m.is_empty() => true,
                Ok(m) => {
                    eprintln!("front: account grants read core off — missing privileges {m:?}");
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
        // S5.4 MS2a — 메시지 검색(`GET /search`). 읽기 풀만 쓴다(MCP `message.search` 와 같은 문장). `@`·기간·형식이 애매한 질의는 TS 로.
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
        let grant_reads = harkroom_server::core::grant_reads::routes(
            state.pool.clone(),
            auth.clone(),
            state.cors.clone(),
        );
        core_routes.router = core_routes.router.merge(grant_reads.router);
        core_routes.http.extend(grant_reads.http);
        core_routes.sockets.extend(grant_reads.sockets);
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
        // S5.4 AC4 — 초대 쓰기 2줄(메일이 실린 POST 는 안에서 TS 로 넘긴다, resend 는 TS). 권한이 다 있을 때만.
        if let Some(write) = invites_write {
            let iw = harkroom_server::core::invites_write::routes(
                harkroom_server::core::invites_write::InvitesWriteState {
                    read: state.pool.clone(),
                    write,
                    trust: state.trust.clone(),
                    up: state.up.clone(),
                },
                auth.clone(),
                state.cors.clone(),
            );
            core_routes.router = core_routes.router.merge(iw.router);
            core_routes.http.extend(iw.http);
            core_routes.sockets.extend(iw.sockets);
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
        // S5.4 — 로그인 ID 읽기 1줄. 권한이 있을 때만 — 아니면 TS 에 남는다(재설정 코드 발급·거두기는 언제나 TS).
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
        // S5.4 — 고를 수 있는 모델 목록 쓰기 1줄. 권한이 있을 때만 — 아니면 TS 에 남는다.
        if let Some(write) = pickable_models_write {
            let pm = harkroom_server::core::pickable_models::routes(
                harkroom_server::core::pickable_models::PickableModelsState {
                    write,
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
        // S5.4 — 보관소 잠그기 1줄. 권한이 있을 때만 — 아니면 TS 에 남는다(열기 POST 는 argon2·리미터 때문에 TS).
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
                work_item: work_item_write,
                work_item_upsert: work_item_upsert_write,
                pr_watch: pr_watch_write,
                automation: automation_write,
                automation_run: automation_run_write,
                memory: mem_write,
                memory_body: mem_body_write,
                delegate: mcp_post.clone().filter(|_| mcp_delegate_ok),
                wake: mcp_post.clone().filter(|_| mcp_wake_ok),
                skill: mcp_post.clone().filter(|_| mcp_skill_ok),
                post: mcp_post,
                relay_moved: operator_on,
                relay: relay_cell.clone(),
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
    let guard = harkroom_server::loops::push::LeakGuard::from_env()
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
