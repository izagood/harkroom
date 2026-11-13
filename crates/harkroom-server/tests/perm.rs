//! 인가 판정(`perm::can`·`require_cap`)이 TS `auth/permissions.ts::can()` 과 같은지 실제 Postgres 로 본다.
//! `HARKROOM_TEST_DATABASE_URL`(TS 마이그레이션이 전부 적용된 DB)이 없으면 건너뛴다. 시험이 넣은 행은 끝에 지운다.
use harkroom_server::auth::{Account, Auth};
use harkroom_server::perm::{Target, TargetKind, can, require_cap};
use sqlx::PgPool;

async fn mk(pool: &PgPool, handle: &str, kind: &str, role: &str) -> Account {
    let id: String = sqlx::query_scalar(
        "insert into account(handle, display_name, kind, login_id, role, is_admin) \
         values ($1, $1, $2, case when $2 = 'human' then $1 end, $3, $3 in ('owner','admin')) returning id::text",
    )
    .bind(handle)
    .bind(kind)
    .bind(role)
    .fetch_one(pool)
    .await
    .unwrap();
    Account {
        id,
        handle: handle.into(),
        display_name: handle.into(),
        kind: kind.into(),
        is_admin: role == "owner" || role == "admin",
        role: role.into(),
        status: "online".into(),
        status_text: None,
        avatar_attachment_id: None,
    }
}

async fn grant(pool: &PgPool, who: &Account, cap: &str, scope: &str, by: &Account) {
    sqlx::query(
        "insert into account_grant(account_id, capability, scope, granted_by) values ($1::uuid, $2, $3, $4::uuid)",
    )
    .bind(&who.id)
    .bind(cap)
    .bind(scope)
    .bind(&by.id)
    .execute(pool)
    .await
    .unwrap();
}

#[tokio::test]
async fn can_matches_ts_permissions() {
    let Ok(url) = std::env::var("HARKROOM_TEST_DATABASE_URL") else {
        eprintln!("skip: HARKROOM_TEST_DATABASE_URL unset");
        return;
    };
    let pool = PgPool::connect(&url).await.unwrap();
    let tag = format!("p{}", std::process::id());
    let admin = mk(&pool, &format!("{tag}-admin"), "human", "admin").await;
    let member = mk(&pool, &format!("{tag}-member"), "human", "member").await;
    let guest = mk(&pool, &format!("{tag}-guest"), "human", "guest").await;
    let agent = mk(&pool, &format!("{tag}-agent"), "agent", "member").await;
    sqlx::query(
        "insert into agent_config(account_id, owner_account_id) values ($1::uuid, $2::uuid)",
    )
    .bind(&agent.id)
    .bind(&member.id)
    .execute(&pool)
    .await
    .unwrap();
    let agent_target = Target {
        kind: TargetKind::Agent,
        id: &agent.id,
    };
    let other_scope = format!("channel:{}", agent.id);
    grant(&pool, &member, "channel.manage", &other_scope, &admin).await;
    grant(&pool, &guest, "channel.create", "", &admin).await;
    grant(&pool, &agent, "repo.merge", "", &admin).await;

    // 소유 > 기본 > grant > 역할.
    assert!(
        can(&pool, &member, "agent.manage", Some(&agent_target))
            .await
            .unwrap(),
        "소유"
    );
    assert!(
        !can(&pool, &guest, "agent.manage", Some(&agent_target))
            .await
            .unwrap()
    );
    assert!(
        can(&pool, &member, "operator.register", None)
            .await
            .unwrap(),
        "member 기본"
    );
    assert!(
        !can(&pool, &guest, "operator.register", None).await.unwrap(),
        "guest 는 기본 없음"
    );
    let ch = Target {
        kind: TargetKind::Channel,
        id: &agent.id,
    };
    assert!(
        can(&pool, &member, "channel.manage", Some(&ch))
            .await
            .unwrap(),
        "대상 grant"
    );
    assert!(
        !can(&pool, &member, "channel.manage", None).await.unwrap(),
        "대상 grant 는 전역을 열지 않는다"
    );
    assert!(
        !can(&pool, &guest, "channel.create", None).await.unwrap(),
        "guest 는 전역 grant 를 세지 않는다"
    );
    assert!(
        can(&pool, &admin, "audit.read", None).await.unwrap(),
        "admin 역할"
    );
    // 따로 판정하는 것은 admin·전역 grant 로도 거짓.
    for cap in ["repo.merge", "repo.read", "api.call", "tool.allow"] {
        assert!(!can(&pool, &admin, cap, None).await.unwrap(), "{cap}");
    }
    assert!(!can(&pool, &agent, "repo.merge", None).await.unwrap());
    assert!(
        can(&pool, &admin, "member.reset_password", None)
            .await
            .unwrap()
    );
    assert!(
        !can(&pool, &member, "member.reset_password", None)
            .await
            .unwrap()
    );

    // require_cap: 익명 401 · 거절 403 · 통과.
    let anon = require_cap(&pool, &Auth::default(), "audit.read", None).await;
    assert_eq!(anon.unwrap_err().status(), 401);
    let as_member = Auth {
        account: Some(member.clone()),
        ..Auth::default()
    };
    let no = require_cap(&pool, &as_member, "audit.read", None).await;
    assert_eq!(no.unwrap_err().status(), 403);
    // 대상 id 가 비면 대상 없이 판정한다(TS 와 같다).
    let empty = Target {
        kind: TargetKind::Channel,
        id: "",
    };
    let no = require_cap(&pool, &as_member, "channel.manage", Some(empty)).await;
    assert_eq!(no.unwrap_err().status(), 403);
    let yes = require_cap(
        &pool,
        &as_member,
        "agent.manage",
        Some(agent_target.clone()),
    )
    .await;
    assert_eq!(yes.unwrap().id, member.id);

    for id in [&agent.id, &guest.id, &member.id, &admin.id] {
        sqlx::query(
            "delete from account_grant where account_id = $1::uuid or granted_by = $1::uuid",
        )
        .bind(id)
        .execute(&pool)
        .await
        .unwrap();
        sqlx::query("delete from agent_config where account_id = $1::uuid")
            .bind(id)
            .execute(&pool)
            .await
            .unwrap();
    }
    for id in [&agent.id, &guest.id, &member.id, &admin.id] {
        sqlx::query("delete from account where id = $1::uuid")
            .bind(id)
            .execute(&pool)
            .await
            .unwrap();
    }
}
