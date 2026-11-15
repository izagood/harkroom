//! 받은함 기본 줄(`core::inbox_list`, S5.3 C6a-3a)이 실제 스키마에서 TS `listInbox` 의 거르기·순서·모양을 지키는지.
//! 안 읽음·읽음, 볼 수 없는 채널, 지운 글, 시스템 글 자리표시자, `viaEdit`·`teamId` 키 정리, 팀 명단, 상한 페이지를 본다.
//! `HARKROOM_TEST_DATABASE_URL` 이 없으면 건너뛴다(CI 는 `bus-e2e` 잡이 `packages/server/test/rustFrontDb.test.ts` 로 DB 를 넘긴다).
use harkroom_server::core::inbox_list::{InboxQuery, list_inbox, list_inbox_newest};
use serde_json::Value;
use sqlx::PgPool;

async fn id(pool: &PgPool, sql: &str, binds: &[&str]) -> String {
    let mut q = sqlx::query_scalar::<_, String>(sqlx::AssertSqlSafe(sql.to_string()));
    for b in binds {
        q = q.bind(*b);
    }
    q.fetch_one(pool).await.unwrap()
}

async fn account(pool: &PgPool, handle: &str, kind: &str) -> String {
    id(
        pool,
        "insert into account(handle, display_name, kind, login_id) values ($1, $1, $2, case when $2 = 'human' then $1 end) returning id::text",
        &[handle, kind],
    )
    .await
}

/// 키가 나오는 차례(TS 객체의 키 순서와 같아야 한다). `json_object_agg` 는 `"k" : v` 꼴로 쓰므로 키 뒤 공백을 접어서 찾는다.
fn key_order(body: &str, keys: &[&str]) -> Vec<usize> {
    let body = body.replace("\" : ", "\":");
    keys.iter()
        .map(|k| {
            body.find(&format!("\"{k}\":"))
                .unwrap_or_else(|| panic!("{k} in {body}"))
        })
        .collect()
}

#[tokio::test]
async fn inbox_list_matches_ts_rules() {
    let Ok(url) = std::env::var("HARKROOM_TEST_DATABASE_URL") else {
        eprintln!("skip: HARKROOM_TEST_DATABASE_URL unset");
        return;
    };
    let pool = PgPool::connect(&url).await.unwrap();
    let me = account(&pool, "il_me", "human").await;
    let b = account(&pool, "il_b", "agent").await;
    let a = account(&pool, "il_a", "agent").await;
    sqlx::query("insert into agent_config (account_id, instructions) values ($1::uuid, E'db 담당\\n둘째 줄')")
        .bind(&b)
        .execute(&pool)
        .await
        .unwrap();
    let team = id(
        &pool,
        "insert into agent_team(name, created_by) values ('il \"팀\"', $1::uuid) returning id::text",
        &[&me],
    )
    .await;
    for m in [&a, &b] {
        sqlx::query(
            "insert into agent_team_member(team_id, agent_account_id) values ($1::uuid, $2::uuid)",
        )
        .bind(&team)
        .bind(m)
        .execute(&pool)
        .await
        .unwrap();
    }
    let public = id(
        &pool,
        "insert into channel(name, kind, visibility) values ('il-pub-' || gen_random_uuid(), 'standard', 'public') returning id::text",
        &[],
    )
    .await;
    let private = id(
        &pool,
        "insert into channel(name, kind, visibility) values ('il-priv-' || gen_random_uuid(), 'standard', 'private') returning id::text",
        &[],
    )
    .await;
    let msg = |ch: &str, kind: &str, body: &str, meta: &str| {
        let (ch, kind, body, meta) = (
            ch.to_string(),
            kind.to_string(),
            body.to_string(),
            meta.to_string(),
        );
        let pool = pool.clone();
        let author = a.clone();
        async move {
            sqlx::query_scalar::<_, String>(
                "insert into message(channel_id, author_id, body, kind, meta) values ($1::uuid, $2::uuid, $3, $4, $5::jsonb) returning id::text",
            )
            .bind(ch)
            .bind(author)
            .bind(body)
            .bind(kind)
            .bind(meta)
            .fetch_one(&pool)
            .await
            .unwrap()
        }
    };
    let m1 = msg(&public, "user", "@il_me 봐 줘", "{}").await;
    let m2 = msg(
        &public,
        "system",
        "{account}님이 들어왔다",
        &format!("{{\"accountId\":\"{b}\"}}"),
    )
    .await;
    let m3 = msg(&private, "user", "비공개", "{}").await;
    let m4 = msg(&public, "user", "지운 글", "{}").await;
    sqlx::query("update message set deleted_at = now() where id = $1::uuid")
        .bind(&m4)
        .execute(&pool)
        .await
        .unwrap();
    let inbox = |m: &str, reason: &str, extra: &str| {
        format!(
            "insert into inbox(account_id, message_id, reason{}) values ('{me}', '{m}', '{reason}'{}) returning id::text",
            if extra.is_empty() { "" } else { ", team_id" },
            if extra.is_empty() {
                String::new()
            } else {
                format!(", '{extra}'")
            },
        )
    };
    let i1: i64 = id(&pool, &inbox(&m1, "mention", &team), &[])
        .await
        .parse()
        .unwrap();
    let i2: i64 = id(&pool, &inbox(&m2, "thread_reply", ""), &[])
        .await
        .parse()
        .unwrap();
    sqlx::query("update inbox set via_edit = true, read_at = now() where id = $1")
        .bind(i2)
        .execute(&pool)
        .await
        .unwrap();
    id(&pool, &inbox(&m3, "mention", ""), &[]).await;
    id(&pool, &inbox(&m4, "mention", ""), &[]).await;

    // 안 읽은 것: i1 하나(i2 읽음 · 비공개 채널 · 지운 글은 빠진다).
    let unread = list_inbox(&pool, &me, InboxQuery::Unread { since: None })
        .await
        .unwrap();
    assert_eq!(unread.iter().map(|r| r.id).collect::<Vec<_>>(), vec![i1]);
    let row1 = &unread[0].body;
    let order = key_order(
        row1,
        &[
            "id",
            "messageId",
            "reason",
            "readAt",
            "channelId",
            "authorId",
            "body",
            "meta",
            "kind",
            "createdAt",
            "threadRootId",
            "team",
        ],
    );
    assert!(order.windows(2).all(|w| w[0] < w[1]), "key order {row1}");
    assert!(
        !row1.contains("\"teamId\"")
            && !row1.contains("\"viaEdit\"")
            && !row1.contains("\"bodyTruncated\""),
        "{row1}"
    );
    let v1: Value = serde_json::from_str(row1).unwrap();
    assert_eq!(v1["id"], i1);
    assert_eq!(v1["readAt"], Value::Null);
    assert!(v1["createdAt"].as_str().unwrap().ends_with('Z'));
    assert_eq!(v1["team"]["id"], team.as_str());
    assert_eq!(v1["team"]["name"], "il \"팀\"");
    let members = v1["team"]["members"].as_array().unwrap();
    assert_eq!(members.len(), 2);
    assert_eq!(members[0]["handle"], "il_a");
    assert_eq!(members[0]["specialty"], Value::Null);
    assert_eq!(members[1]["handle"], "il_b");
    assert_eq!(members[1]["specialty"], "db 담당");
    assert_eq!(members[1]["disabled"], false);
    assert!(row1.contains(&format!("\"members\":[{{\"accountId\":\"{a}\",\"handle\":\"il_a\",\"specialty\":null,\"disabled\":false}}")));

    // since=0: 읽은 것까지 id 오름차순. 시스템 글은 자리표시자를 handle 로 채우고, 수정으로 생긴 줄만 viaEdit.
    let all = list_inbox(&pool, &me, InboxQuery::Since(0)).await.unwrap();
    assert_eq!(all.iter().map(|r| r.id).collect::<Vec<_>>(), vec![i1, i2]);
    let v2: Value = serde_json::from_str(&all[1].body).unwrap();
    assert_eq!(v2["body"], "il_b님이 들어왔다");
    assert_eq!(v2["viaEdit"], true);
    assert!(v2["readAt"].as_str().unwrap().ends_with('Z'));
    assert!(v2.get("team").is_none());
    let after = list_inbox(&pool, &me, InboxQuery::Since(i1)).await.unwrap();
    assert_eq!(after.iter().map(|r| r.id).collect::<Vec<_>>(), vec![i2]);
    let unread_after = list_inbox(&pool, &me, InboxQuery::Unread { since: Some(i1) })
        .await
        .unwrap();
    assert!(unread_after.is_empty());

    // 상한 페이지: 최신 1줄 = i2, 앞에 더 있음. before=i2 이면 i1, 끝.
    let (page, truncated) = list_inbox_newest(&pool, &me, 1, None).await.unwrap();
    assert_eq!(
        (page.iter().map(|r| r.id).collect::<Vec<_>>(), truncated),
        (vec![i2], true)
    );
    let (page, truncated) = list_inbox_newest(&pool, &me, 1, Some(i2)).await.unwrap();
    assert_eq!(
        (page.iter().map(|r| r.id).collect::<Vec<_>>(), truncated),
        (vec![i1], false)
    );
    let (page, truncated) = list_inbox_newest(&pool, &me, 200, None).await.unwrap();
    assert_eq!(
        (page.iter().map(|r| r.id).collect::<Vec<_>>(), truncated),
        (vec![i1, i2], false)
    );
}

/// 덧붙임 셋(C6a-3b-1): 넘겨받은 일(`delegatedBy`)·이 부름이 접은 내 깨움(`canceledWakes`)·이 일이 시작된 스레드(`startedIn`).
#[tokio::test]
async fn inbox_extras_match_ts_rules() {
    let Ok(url) = std::env::var("HARKROOM_TEST_DATABASE_URL") else {
        eprintln!("skip: HARKROOM_TEST_DATABASE_URL unset");
        return;
    };
    let pool = PgPool::connect(&url).await.unwrap();
    let owner = account(&pool, "ix_owner", "human").await;
    let me = account(&pool, "ix_me", "agent").await;
    let lead = account(&pool, "ix_lead", "agent").await;
    sqlx::query("insert into agent_config (account_id, instructions, owner_account_id) values ($1::uuid, '', $2::uuid)")
        .bind(&me)
        .bind(&owner)
        .execute(&pool)
        .await
        .unwrap();
    let ch = id(
        &pool,
        "insert into channel(name, kind, visibility) values ('ix-pub-' || gen_random_uuid(), 'standard', 'public') returning id::text",
        &[],
    )
    .await;
    let post = |author: &str, body: &str, root: Option<&str>, meta: &str| {
        let (author, body, root, meta, ch, pool) = (
            author.to_string(),
            body.to_string(),
            root.map(str::to_string),
            meta.to_string(),
            ch.clone(),
            pool.clone(),
        );
        async move {
            sqlx::query_scalar::<_, String>(
                "insert into message(channel_id, author_id, body, thread_root_id, meta, kind) values ($1::uuid, $2::uuid, $3, $4::uuid, $5::jsonb, 'user') returning id::text",
            )
            .bind(ch)
            .bind(author)
            .bind(body)
            .bind(root)
            .bind(meta)
            .fetch_one(&pool)
            .await
            .unwrap()
        }
    };
    let inbox = |m: String, reason: &'static str| {
        let (pool, me) = (pool.clone(), me.clone());
        async move {
            sqlx::query_scalar::<_, String>(
                "insert into inbox(account_id, message_id, reason) values ($1::uuid, $2::uuid, $3) returning id::text",
            )
            .bind(me)
            .bind(m)
            .bind(reason)
            .fetch_one(&pool)
            .await
            .unwrap()
        }
    };

    // 사람이 시작한 스레드(뿌리 r) — 사람이 나를 그 스레드에서 불렀다. 위임장은 그 뿌리에 걸린다.
    let r = post(&owner, "@ix_me 시작", None, "{}").await;
    inbox(r.clone(), "mention").await;
    let mandate = id(
        &pool,
        "insert into mandate (owner_account_id, root_message_id, channel_id, thread_root_id) values ($1::uuid, $2::uuid, $3::uuid, $2::uuid) returning id::text",
        &[&owner, &r, &ch],
    )
    .await;
    // 넘겨받은 일: 팀장 글 + team_delegation(팀 없음).
    let handed = post(&lead, "@ix_me 맡아", None, "{}").await;
    sqlx::query("insert into team_delegation (message_id, lead_account_id, channel_id, thread_root_id, deadline_at) values ($1::uuid, $2::uuid, $3::uuid, $1::uuid, '2026-01-02T03:04:05.678Z')")
        .bind(&handed)
        .bind(&lead)
        .bind(&ch)
        .execute(&pool)
        .await
        .unwrap();
    inbox(handed.clone(), "team_delegated").await;
    // 다른 스레드의 동료 글(같은 위임장) — 시작한 곳이 붙는다.
    let peer = post(&lead, "@ix_me 보고", None, "{}").await;
    sqlx::query("update message set mandate_id = $1::uuid where id = $2::uuid")
        .bind(&mandate)
        .bind(&peer)
        .execute(&pool)
        .await
        .unwrap();
    inbox(peer.clone(), "mention").await;
    // 사람이 부른 글 — 내 깨움 둘을 접었다(나중 것은 reportTo 있음, 남의 깨움은 안 보인다).
    let call = post(&owner, "@ix_me 지금", None, "{}").await;
    for (who, body, at, meta) in [
        (
            &me,
            "늦은 확인",
            "2030-01-02T00:00:00Z",
            r#"{"wake":{"reportTo":{"channelId":"c1","threadRootId":"t1"}}}"#,
        ),
        (
            &me,
            "이른 확인",
            "2030-01-01T00:00:00Z",
            r#"{"wake":{"reportTo":{"channelId":"c1"}}}"#,
        ),
        (&lead, "남의 깨움", "2030-01-01T00:00:00Z", "{}"),
    ] {
        let wm = post(who, body, None, meta).await;
        sqlx::query("insert into agent_wake (account_id, channel_id, message_id, wake_at, canceled_at, canceled_by_message_id) values ($1::uuid, $2::uuid, $3::uuid, $4::timestamptz, now(), $5::uuid)")
            .bind(who)
            .bind(&ch)
            .bind(&wm)
            .bind(at)
            .bind(&call)
            .execute(&pool)
            .await
            .unwrap();
    }
    inbox(call.clone(), "mention").await;

    let rows = list_inbox(&pool, &me, InboxQuery::Since(0)).await.unwrap();
    let by_msg = |m: &str| -> Value {
        let row = rows
            .iter()
            .find(|x| x.body.contains(m))
            .unwrap_or_else(|| panic!("row for {m}"));
        serde_json::from_str(&row.body).unwrap()
    };
    let h = by_msg(&handed);
    assert_eq!(
        h["delegatedBy"],
        serde_json::json!({"leadHandle":"ix_lead","teamName":null,"deadlineAt":"2026-01-02T03:04:05.678Z"})
    );
    assert!(h.get("startedIn").is_none() && h.get("canceledWakes").is_none());
    let p = by_msg(&peer);
    assert_eq!(
        p["startedIn"],
        serde_json::json!({"channelId": ch, "threadRootId": r})
    );
    assert!(p.get("delegatedBy").is_none());
    // 사람 글(r·call)에는 시작한 곳이 없다.
    assert!(by_msg(&r).get("startedIn").is_none());
    let c = by_msg(&call);
    assert!(c.get("startedIn").is_none());
    assert_eq!(
        c["canceledWakes"],
        serde_json::json!([
            {"reason":"이른 확인","wakeAt":"2030-01-01T00:00:00.000Z"},
            {"reason":"늦은 확인","wakeAt":"2030-01-02T00:00:00.000Z","reportTo":{"channelId":"c1","threadRootId":"t1"}}
        ])
    );
    // 키 차례: 덧붙임은 기본 칸 뒤.
    let row = rows.iter().find(|x| x.body.contains(&call)).unwrap();
    let order = key_order(&row.body, &["threadRootId", "canceledWakes"]);
    assert!(order[0] < order[1], "{}", row.body);
}
