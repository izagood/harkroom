//! 위임 그림자(`core::work_shadow`, D1)를 실제 Postgres 로 본다 — 위임 → 부모·하위 작업 행(되풀이해도 한 번), 닫힘 → 상태·사건.
//! `HARKROOM_TEST_DATABASE_URL` 이 없으면 건너뛴다. 쓰기는 `HARKROOM_TEST_WRITE_DATABASE_URL` 이 있으면 그 역할로 한다.
use harkroom_server::core::work_shadow::{
    EVENT_DELEGATION_CLOSED, delegation_closed_with, delegation_created_with,
};
use sqlx::PgPool;

/// 작업 행에서 시험이 읽는 칸.
type WorkRow = (Option<String>, Option<String>, String, bool, Option<String>);

async fn id(admin: &PgPool, sql: &'static str, binds: &[&str]) -> String {
    let mut q = sqlx::query_scalar::<_, String>(sql);
    for b in binds {
        q = q.bind(*b);
    }
    q.fetch_one(admin).await.unwrap()
}

#[tokio::test]
async fn delegation_becomes_child_work_and_closes() {
    let Ok(url) = std::env::var("HARKROOM_TEST_DATABASE_URL") else {
        eprintln!("skip: HARKROOM_TEST_DATABASE_URL unset");
        return;
    };
    let admin = PgPool::connect(&url).await.unwrap();
    let w = match std::env::var("HARKROOM_TEST_WRITE_DATABASE_URL") {
        Ok(u) => PgPool::connect(&u).await.unwrap(),
        Err(_) => admin.clone(),
    };
    const AGENT: &str = "insert into account(handle, display_name, kind) values ($1, $1, 'agent') returning id::text";
    let human = id(&admin, "insert into account(handle, display_name, kind, login_id) values ($1, $1, 'human', $1) returning id::text", &["work_shadow_rs_human"]).await;
    let lead = id(&admin, AGENT, &["work_shadow_rs_lead"]).await;
    let a = id(&admin, AGENT, &["work_shadow_rs_a"]).await;
    let b = id(&admin, AGENT, &["work_shadow_rs_b"]).await;
    let ch = id(
        &admin,
        "insert into channel(name, kind, visibility, created_by) values ($1, 'standard', 'private', $2::uuid) returning id::text",
        &["work-shadow-rs", &human],
    )
    .await;
    const MSG: &str = "insert into message(channel_id, author_id, body, kind, meta) \
         values ($1::uuid, $2::uuid, 'x', 'user', '{}') returning id::text";
    let root_msg = id(&admin, MSG, &[&ch, &human]).await;
    let deleg_msg = id(&admin, MSG, &[&ch, &lead]).await;
    let team = id(
        &admin,
        "insert into agent_team(name, created_by) values ($1, $2::uuid) returning id::text",
        &["work shadow rs", &human],
    )
    .await;
    let deleg = id(
        &admin,
        "insert into team_delegation(message_id, team_id, lead_account_id, channel_id, thread_root_id, deadline_at) \
         values ($1::uuid, $2::uuid, $3::uuid, $4::uuid, $5::uuid, now() + interval '1 hour') returning id::text",
        &[&deleg_msg, &team, &lead, &ch, &root_msg],
    )
    .await;
    for d in [&a, &b] {
        sqlx::query("insert into team_delegation_item(delegation_id, delegate_account_id) values ($1::uuid, $2::uuid)")
            .bind(&deleg)
            .bind(d)
            .execute(&admin)
            .await
            .unwrap();
    }

    // 위임 → 위임자의 뿌리 작업 하나 + 담당마다 하위 작업(running). 되풀이해도 늘지 않는다.
    assert_eq!(delegation_created_with(&w, &deleg).await.unwrap(), 2);
    assert_eq!(delegation_created_with(&w, &deleg).await.unwrap(), 0);
    let rows: Vec<WorkRow> = sqlx::query_as(
        "select parent_id::text, assignee_account_id::text, state, due_at is not null, source_message_id::text \
           from work where thread_root_id = $1::uuid order by created_at, id",
    )
    .bind(&root_msg)
    .fetch_all(&admin)
    .await
    .unwrap();
    assert_eq!(rows.len(), 3, "{rows:?}");
    let parents: Vec<_> = rows.iter().filter(|r| r.0.is_none()).collect();
    assert_eq!(parents.len(), 1);
    assert_eq!(parents[0].1.as_deref(), Some(lead.as_str()));
    assert_eq!(parents[0].4.as_deref(), Some(root_msg.as_str()));
    let kids: Vec<_> = rows.iter().filter(|r| r.0.is_some()).collect();
    assert_eq!(kids.len(), 2);
    for k in &kids {
        assert_eq!(k.2, "running");
        assert!(k.3);
        assert_eq!(k.4.as_deref(), Some(deleg_msg.as_str()));
    }
    let child_of = |who: String| {
        let admin = admin.clone();
        let deleg = deleg.clone();
        async move {
            sqlx::query_as::<_, (String, String, Option<String>)>(
                "select id::text, state, requester_account_id::text from work \
                  where delegation_id = $1::uuid and assignee_account_id = $2::uuid",
            )
            .bind(deleg)
            .bind(who)
            .fetch_one(&admin)
            .await
            .unwrap()
        }
    };
    assert_eq!(child_of(a.clone()).await.2.as_deref(), Some(lead.as_str()));

    // 한 담당이 보고 → 그 하위 작업만 done + `delegation.closed` 사건. 되풀이는 아무것도 하지 않는다.
    assert_eq!(
        delegation_closed_with(&w, &deleg, Some(&a), "reported", None)
            .await
            .unwrap(),
        1
    );
    assert_eq!(
        delegation_closed_with(&w, &deleg, Some(&a), "reported", None)
            .await
            .unwrap(),
        0
    );
    let (a_work, a_state, _) = child_of(a.clone()).await;
    assert_eq!(a_state, "done");
    assert_eq!(child_of(b.clone()).await.1, "running");
    let ev: Vec<String> = sqlx::query_scalar(
        "select payload::text from work_event where work_id = $1::uuid and kind = $2",
    )
    .bind(&a_work)
    .bind(EVENT_DELEGATION_CLOSED)
    .fetch_all(&admin)
    .await
    .unwrap();
    assert_eq!(ev.len(), 1);
    let p: serde_json::Value = serde_json::from_str(&ev[0]).unwrap();
    assert_eq!(p["outcome"], "reported");
    assert!(p["reason"].is_null());

    // 나머지는 자동 닫힘(담당 모름) → 아직 안 끝난 것만 canceled. 끝난 작업은 그대로.
    assert_eq!(
        delegation_closed_with(&w, &deleg, None, "closed", Some("max_age"))
            .await
            .unwrap(),
        1
    );
    assert_eq!(child_of(b.clone()).await.1, "canceled");
    assert_eq!(child_of(a.clone()).await.1, "done");
    // 모르는 결말은 아무것도 하지 않는다.
    assert_eq!(
        delegation_closed_with(&w, &deleg, None, "nope", None)
            .await
            .unwrap(),
        0
    );
}
