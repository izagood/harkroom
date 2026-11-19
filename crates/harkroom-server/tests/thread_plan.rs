//! 계획판 자동 진행 깨움(`loops::thread_plan_auto::wake`, P5)을 실제 Postgres 로 본다 — 깨움 글이 관리 에이전트의 inbox 에 닿는지,
//! 그리고 위임장 유효성 문장이 `THREAD_PLAN_PRIVILEGES` 의 칸 단위 GRANT 만으로 도는지.
//! `HARKROOM_TEST_DATABASE_URL` 이 없으면 건너뛴다(CI 는 `packages/server/test/rustFrontDb.test.ts` 가 넘긴다).
use harkroom_server::core::mandate_line_write::valid_owner_sql;
use harkroom_server::core::msg_post::PostState;
use harkroom_server::loops::thread_plan::THREAD_PLAN_PRIVILEGES;
use harkroom_server::loops::thread_plan_auto::{plan_auto_range_of, wake};
use serde_json::{Value, json};
use sqlx::PgPool;

async fn one(admin: &PgPool, sql: &'static str, binds: &[&str]) -> String {
    let mut q = sqlx::query_scalar::<_, String>(sql);
    for b in binds {
        q = q.bind(*b);
    }
    q.fetch_one(admin).await.unwrap()
}

/// 깨움 글 한 줄 — id·작성자·principal·위임 키·meta.
type Posted = (String, String, Option<String>, Option<String>, Value);

struct Fx {
    human: String,
    manager: String,
    ch: String,
    mandate: String,
}

/// 사람·관리 에이전트·채널(둘 다 멤버)·사람이 켠 자동화 위임장 하나.
async fn fixture(admin: &PgPool, tag: &str) -> Fx {
    let human = one(
        admin,
        "insert into account(handle, display_name, kind, login_id) values ($1, $1, 'human', $1) returning id::text",
        &[&format!("tp_h_{tag}")],
    )
    .await;
    let manager = one(
        admin,
        "insert into account(handle, display_name, kind) values ($1, $1, 'agent') returning id::text",
        &[&format!("tp_m_{tag}")],
    )
    .await;
    let ch = one(
        admin,
        "insert into channel(name, kind) values ($1, 'standard') returning id::text",
        &[&format!("thread-plan-rs-{tag}")],
    )
    .await;
    for who in [&human, &manager] {
        sqlx::query(
            "insert into channel_member(channel_id, account_id) values ($1::uuid, $2::uuid)",
        )
        .bind(&ch)
        .bind(who)
        .execute(admin)
        .await
        .unwrap();
    }
    let auto = one(
        admin,
        "insert into automation(owner_id, channel_id, name, body, trigger, enabled, approved_at) \
         values ($1::uuid, $2::uuid, 'plan probe', 'b', '{\"kind\":\"webhook\"}', true, now()) returning id::text",
        &[&human, &ch],
    )
    .await;
    let mandate = one(
        admin,
        "insert into mandate(owner_account_id, channel_id, automation_id) values ($1::uuid, $2::uuid, $3::uuid) returning id::text",
        &[&human, &ch, &auto],
    )
    .await;
    Fx {
        human,
        manager,
        ch,
        mandate,
    }
}

/// 깨움 → 관리 에이전트 inbox. 글 하나가 나가고, principal·위임 키 도장이 찍히고, 깨운 단계가 `auto_woken` 에 남는다.
/// 같은 판을 다시 돌려도 이미 깨운 단계라 글이 늘지 않는다.
#[tokio::test]
async fn wake_reaches_manager_inbox() {
    let Ok(url) = std::env::var("HARKROOM_TEST_DATABASE_URL") else {
        eprintln!("skip: HARKROOM_TEST_DATABASE_URL unset");
        return;
    };
    let admin = PgPool::connect(&url).await.unwrap();
    let fx = fixture(&admin, "wake").await;
    let root = one(
        &admin,
        "insert into message(channel_id, author_id, body, kind) values ($1::uuid, $2::uuid, 'plan', 'user') returning id::text",
        &[&fx.ch, &fx.human],
    )
    .await;
    let doc = json!({
        "managerId": fx.manager,
        "steps": [
            { "id": "s1", "title": "첫 단계", "state": "pending", "dependsOn": [] },
            { "id": "s2", "title": "둘째", "state": "pending", "dependsOn": ["s1"] }
        ]
    });
    let range = Value::Object(plan_auto_range_of(&doc, "s2"));
    sqlx::query(
        "insert into thread_plan(root_id, channel_id, doc, auto_until, auto_source, auto_by, auto_mandate, auto_at, auto_range) \
         values ($1::uuid, $2::uuid, $3::jsonb, 's2', $1::uuid, $4::uuid, $5::uuid, now(), $6::jsonb)",
    )
    .bind(&root)
    .bind(&fx.ch)
    .bind(doc.to_string())
    .bind(&fx.human)
    .bind(&fx.mandate)
    .bind(range.to_string())
    .execute(&admin)
    .await
    .unwrap();

    let st = PostState {
        read: admin.clone(),
        write: admin.clone(),
        up: harkroom_server::proxy::Upstream::new("http://127.0.0.1:0"),
        implicit_ok: false,
    };
    wake(&st, &root).await.unwrap();

    let posted: Vec<Posted> = sqlx::query_as(
        "select id::text, author_id::text, principal_account_id::text, mandate_id::text, meta \
           from message where thread_root_id = $1::uuid and meta ? 'planAuto'",
    )
    .bind(&root)
    .fetch_all(&admin)
    .await
    .unwrap();
    assert_eq!(posted.len(), 1, "깨움 글은 하나: {posted:?}");
    let (msg, author, principal, mandate, meta) = &posted[0];
    assert_eq!(author, &fx.human, "깨움 글의 작성자는 켠 사람");
    assert_eq!(
        principal.as_deref(),
        Some(fx.human.as_str()),
        "principal 도장"
    );
    assert_eq!(
        mandate.as_deref(),
        Some(fx.mandate.as_str()),
        "위임 키 도장"
    );
    assert_eq!(
        meta["planAuto"]["stepIds"],
        json!(["s1"]),
        "ready 인 s1 만 깨운다"
    );

    let inbox: Vec<String> =
        sqlx::query_scalar("select account_id::text from inbox where message_id = $1::uuid")
            .bind(msg)
            .fetch_all(&admin)
            .await
            .unwrap();
    assert!(
        inbox.contains(&fx.manager),
        "관리 에이전트 inbox 에 닿아야 한다: {inbox:?}"
    );

    let (until, woken): (Option<String>, Value) =
        sqlx::query_as("select auto_until, auto_woken from thread_plan where root_id = $1::uuid")
            .bind(&root)
            .fetch_one(&admin)
            .await
            .unwrap();
    assert_eq!(until.as_deref(), Some("s2"), "닿았으니 켜진 채로 남는다");
    assert!(woken.get("s1").is_some(), "깨운 단계 표시: {woken}");

    // 다시 돌려도 이미 깨운 단계라 글이 늘지 않는다.
    wake(&st, &root).await.unwrap();
    let n: i64 = sqlx::query_scalar(
        "select count(*) from message where thread_root_id = $1::uuid and meta ? 'planAuto'",
    )
    .bind(&root)
    .fetch_one(&admin)
    .await
    .unwrap();
    assert_eq!(n, 1, "두 번째 깨움은 글을 더 쓰지 않는다");
    println!("thread_plan wake: 관리 에이전트 inbox 1건 · principal·mandate 도장 · 재실행 멱등");
}

/// 위임장 유효성 문장(골든 `grant_valid_mandate_owner`)이 `THREAD_PLAN_PRIVILEGES` 의 칸 단위 GRANT 만으로 도는지 —
/// automation 4칸이 빠지면 위임장 있는 판의 깨우기가 permission denied 로 멈춘다(security #2391 메모 1).
/// 표 단위 SELECT·수신 비밀 칸은 주지 않는다. CI 의 쓰기 역할은 `pg_read_all_data` 라 이것을 못 보므로 여기서 역할을 직접 만든다.
#[tokio::test]
async fn valid_owner_runs_with_thread_plan_privileges_only() {
    let Ok(url) = std::env::var("HARKROOM_TEST_DATABASE_URL") else {
        eprintln!("skip: HARKROOM_TEST_DATABASE_URL unset");
        return;
    };
    let admin = PgPool::connect(&url).await.unwrap();
    let fx = fixture(&admin, "grant").await;
    let role = format!("tp_gp_{}", fx.ch.replace('-', ""));
    for sql in [
        format!("create role {role} nologin"),
        format!("grant usage on schema public to {role}"),
    ] {
        sqlx::query(sqlx::AssertSqlSafe(sql))
            .execute(&admin)
            .await
            .unwrap();
    }
    for (obj, privilege) in THREAD_PLAN_PRIVILEGES {
        let grant = match obj.split_once('.') {
            Some((table, column)) => format!("grant {privilege} ({column}) on {table} to {role}"),
            None => format!("grant {privilege} on {obj} to {role}"),
        };
        sqlx::query(sqlx::AssertSqlSafe(grant))
            .execute(&admin)
            .await
            .unwrap();
    }
    let table_select: bool =
        sqlx::query_scalar("select has_table_privilege($1, 'automation', 'SELECT')")
            .bind(&role)
            .fetch_one(&admin)
            .await
            .unwrap();
    assert!(
        !table_select,
        "automation 표 단위 SELECT 는 요구하지 않는다"
    );
    for secret in ["ingress_token_hash", "ingress_secret_enc"] {
        let can: bool =
            sqlx::query_scalar("select has_column_privilege($1, 'automation', $2, 'SELECT')")
                .bind(&role)
                .bind(secret)
                .fetch_one(&admin)
                .await
                .unwrap();
        assert!(!can, "{secret} 는 SELECT 를 주지 않는다");
    }

    let mut tx = admin.begin().await.unwrap();
    sqlx::query(sqlx::AssertSqlSafe(format!("set local role {role}")))
        .execute(&mut *tx)
        .await
        .unwrap();
    let got: Option<(String,)> = sqlx::query_as(valid_owner_sql())
        .bind(&fx.mandate)
        .bind("1970-01-01T00:00:00Z")
        .fetch_optional(&mut *tx)
        .await
        .expect("THREAD_PLAN_PRIVILEGES 만으로 유효성 문장이 돌아야 한다");
    tx.rollback().await.unwrap();
    assert_eq!(got.map(|g| g.0), Some(fx.human.clone()));
    sqlx::query(sqlx::AssertSqlSafe(format!(
        "drop owned by {role}; drop role {role}"
    )))
    .execute(&admin)
    .await
    .ok();
    println!("thread_plan: 위임장 유효성 문장이 칸 단위 GRANT 만으로 통과");
}
