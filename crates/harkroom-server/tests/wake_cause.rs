//! 임대·사슬 판정 이전(`core::wake_cause`, EC)을 실제 Postgres 로 본다 — 깨움 행 문장 다섯이 inbox 문장과 같은 답을 내는지,
//! 읽음·지움·사유 바꿔 적기 뒤에도 같은지, 남의 깨움으로는 답이 생기지 않는지.
//! `HARKROOM_TEST_DATABASE_URL` 이 없으면 건너뛴다(CI 는 `scripts/db-tests.sh` 가 넘긴다).
//! - `HARKROOM_TEST_WRITE_DATABASE_URL` 이 있으면 쓰기는 그 역할(같이 쓰기 권한 + inbox 읽음 칸)로 돈다.
use harkroom_server::core::cause_link::{reasons_from, verified_link_from};
use harkroom_server::core::mcp::grant_delegate::cause_woke;
use harkroom_server::core::merge_checks::chain_followup;
use harkroom_server::core::turn_lease::{cause_diff, cause_row};
use harkroom_server::core::wake_cause::WAKE_CAUSE_PRIVILEGES;
use harkroom_server::core::wake_write::{cancel_now, read_close, write_now};
use sqlx::PgPool;

const LONG_AGO: &str = "2000-01-01T00:00:00.000Z";

async fn account(admin: &PgPool, handle: &str, kind: &str) -> String {
    sqlx::query_scalar(
        "insert into account(handle, display_name, kind, login_id) values ($1, $1, $2, case when $2 = 'human' then $1 end) returning id::text",
    )
    .bind(handle)
    .bind(kind)
    .fetch_one(admin)
    .await
    .unwrap()
}

async fn message(admin: &PgPool, ch: &str, author: &str) -> String {
    sqlx::query_scalar(
        "insert into message(channel_id, author_id, body, kind) values ($1::uuid, $2::uuid, 'x', 'user') returning id::text",
    )
    .bind(ch)
    .bind(author)
    .fetch_one(admin)
    .await
    .unwrap()
}

async fn inbox(admin: &PgPool, who: &str, msg: &str, reason: &str) -> i64 {
    sqlx::query_scalar(
        "insert into inbox(account_id, message_id, reason) values ($1::uuid, $2::uuid, $3) returning id",
    )
    .bind(who)
    .bind(msg)
    .bind(reason)
    .fetch_one(admin)
    .await
    .unwrap()
}

async fn mirror(w: &PgPool, msg: &str, who: &str) {
    let mut tx = w.begin().await.unwrap();
    write_now(&mut tx, msg, &[who.to_owned()]).await;
    tx.commit().await.unwrap();
}

/// 다섯 문장을 두 판으로 돌려 (inbox 답, 깨움 행 답)이 같은지 보고 inbox 답을 돌려준다:
/// (임대 원인 있음, principal, 사슬 고리 있음, 사유들, 후속 보고, 권한 위임 원인).
async fn both(
    pool: &PgPool,
    agent: &str,
    msg: &str,
) -> (bool, Option<String>, bool, Vec<String>, bool, bool) {
    let mut conn = pool.acquire().await.unwrap();
    let mut out = Vec::new();
    for wake in [false, true] {
        let cause = cause_row(&mut conn, wake, agent, msg, LONG_AGO)
            .await
            .unwrap();
        let link = verified_link_from(&mut conn, wake, agent, msg, LONG_AGO)
            .await
            .unwrap();
        let reasons = reasons_from(&mut conn, wake, agent, msg).await.unwrap();
        let followup = chain_followup(pool, wake, agent, Some(msg)).await.unwrap();
        let woke = cause_woke(pool, wake, agent, msg).await.unwrap();
        out.push((cause, link, reasons, followup, woke));
    }
    let (wake, inbox) = (out.pop().unwrap(), out.pop().unwrap());
    assert_eq!(
        cause_diff(inbox.0.as_ref(), wake.0.as_ref()),
        Vec::<&str>::new()
    );
    assert_eq!(
        (&inbox.1, &inbox.2, inbox.3, inbox.4),
        (&wake.1, &wake.2, wake.3, wake.4)
    );
    (
        inbox.0.is_some(),
        inbox.0.and_then(|c| c.3),
        inbox.1.is_some(),
        inbox.2,
        inbox.3,
        inbox.4,
    )
}

#[tokio::test]
async fn wake_statements_answer_like_the_inbox_statements() {
    let Ok(url) = std::env::var("HARKROOM_TEST_DATABASE_URL") else {
        eprintln!("skip: HARKROOM_TEST_DATABASE_URL unset");
        return;
    };
    let write_url =
        std::env::var("HARKROOM_TEST_WRITE_DATABASE_URL").unwrap_or_else(|_| url.clone());
    let admin = PgPool::connect(&url).await.unwrap();
    let w = PgPool::connect(&write_url).await.unwrap();
    for pool in [&admin, &w] {
        let missing = harkroom_server::write::missing_in(pool, WAKE_CAUSE_PRIVILEGES, &[])
            .await
            .unwrap();
        assert!(missing.is_empty(), "role lacks {missing:?}");
    }

    let agent = account(&admin, "wc-agent", "agent").await;
    let other = account(&admin, "wc-other", "agent").await;
    let human = account(&admin, "wc-human", "human").await;
    let ch: String = sqlx::query_scalar(
        "insert into channel(name, kind) values ('wc-rs', 'standard') returning id::text",
    )
    .fetch_one(&admin)
    .await
    .unwrap();

    // ① 사람이 부른 글 — 깨움 행이 아직 없으면 깨움 행 문장은 아무것도 못 본다(같이 쓰기가 꺼진 서버에서 켜지 않는 까닭).
    let m1 = message(&admin, &ch, &human).await;
    let i1 = inbox(&admin, &agent, &m1, "mention").await;
    let mut conn = admin.acquire().await.unwrap();
    assert!(
        cause_row(&mut conn, false, &agent, &m1, LONG_AGO)
            .await
            .unwrap()
            .is_some()
    );
    assert!(
        cause_row(&mut conn, true, &agent, &m1, LONG_AGO)
            .await
            .unwrap()
            .is_none()
    );
    drop(conn);

    // ② 깨움 행이 생기면 다섯 문장이 같은 답을 낸다 — 임대 원인이 있고 principal 은 부른 사람이다.
    mirror(&w, &m1, &agent).await;
    let (cause, principal, link, reasons, followup, woke) = both(&admin, &agent, &m1).await;
    assert!(cause && link && woke && !followup);
    assert_eq!(principal.as_deref(), Some(human.as_str()));
    assert_eq!(reasons, vec!["mention".to_string()]);

    // ③ 남의 깨움으로는 답이 생기지 않는다.
    let (cause, _, link, reasons, _, woke) = both(&admin, &other, &m1).await;
    assert!(!cause && !link && !woke && reasons.is_empty());

    // ④ 신선도 하한보다 오래된 줄은 두 판 모두 원인·고리가 아니다.
    let mut conn = admin.acquire().await.unwrap();
    for wake in [false, true] {
        let far = "2999-01-01T00:00:00.000Z";
        assert!(
            cause_row(&mut conn, wake, &agent, &m1, far)
                .await
                .unwrap()
                .is_none()
        );
        assert!(
            verified_link_from(&mut conn, wake, &agent, &m1, far)
                .await
                .unwrap()
                .is_none()
        );
    }
    drop(conn);

    // ⑤ `delivered` 도 열린 깨움이다 — 임대 원인이 그대로 있다.
    sqlx::query("update wake set state = 'delivered' where inbox_id = $1")
        .bind(i1)
        .execute(&admin)
        .await
        .unwrap();
    assert!(both(&admin, &agent, &m1).await.0);

    // ⑥ 읽음은 둘을 같이 닫는다 — 임대 원인은 사라지고, 사슬 고리·사유(닫힌 뒤에도 읽는 것)는 남는다.
    assert_eq!(read_close(&w, &agent, &[i1]).await.unwrap(), 1);
    let (cause, _, link, reasons, _, woke) = both(&admin, &agent, &m1).await;
    assert!(!cause && link && woke);
    assert_eq!(reasons, vec!["mention".to_string()]);

    // ⑦ 닫힌 뒤 inbox 줄의 사유가 바뀌어도(위임 줄 바꿔 적기) 깨움의 사유가 따라간다.
    sqlx::query("update inbox set reason = 'delegation_update' where id = $1")
        .bind(i1)
        .execute(&admin)
        .await
        .unwrap();
    mirror(&w, &m1, &agent).await;
    assert_eq!(
        both(&admin, &agent, &m1).await.3,
        vec!["delegation_update".to_string()]
    );

    // ⑧ 후속 보고로 깬 글 — 두 판 모두 principal 을 잇지 않고, 사슬 고리가 아니고, 후속 보고로 읽는다.
    let m2 = message(&admin, &ch, &human).await;
    inbox(&admin, &agent, &m2, "delegation_followup").await;
    mirror(&w, &m2, &agent).await;
    let (cause, principal, link, reasons, followup, woke) = both(&admin, &agent, &m2).await;
    assert!(cause && !link && followup && woke);
    assert_eq!(principal, None);
    assert_eq!(reasons, vec!["delegation_followup".to_string()]);

    // ⑨ 안 읽은 줄이 지워지면(새 줄로 갈음) 그 깨움도 닫힌다 — 지워진 부름이 깨움 행에서만 임대 원인으로 남지 않는다.
    let m3 = message(&admin, &ch, &human).await;
    let i3 = inbox(&admin, &agent, &m3, "delegation_update").await;
    mirror(&w, &m3, &agent).await;
    assert!(both(&admin, &agent, &m3).await.0);
    sqlx::query("delete from inbox where id = $1")
        .bind(i3)
        .execute(&admin)
        .await
        .unwrap();
    let mut tx = w.begin().await.unwrap();
    cancel_now(&mut tx, &[i3]).await;
    tx.commit().await.unwrap();
    let mut conn = admin.acquire().await.unwrap();
    for wake in [false, true] {
        assert!(
            cause_row(&mut conn, wake, &agent, &m3, LONG_AGO)
                .await
                .unwrap()
                .is_none()
        );
    }
    let state: String = sqlx::query_scalar("select state from wake where inbox_id = $1")
        .bind(i3)
        .fetch_one(&admin)
        .await
        .unwrap();
    assert_eq!(state, "canceled");

    // ⑩ 지운 글은 두 판 모두 원인이 아니다.
    sqlx::query("update message set deleted_at = now() where id = $1::uuid")
        .bind(&m2)
        .execute(&admin)
        .await
        .unwrap();
    let (cause, _, link, _, _, woke) = both(&admin, &agent, &m2).await;
    assert!(!cause && !link && !woke);
}
