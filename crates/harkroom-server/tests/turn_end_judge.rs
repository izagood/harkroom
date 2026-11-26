//! 턴 끝 판정 그림자(`core::turn_end_judge`, I2c-a)를 실제 Postgres 로 본다 — 끝난 임대 → 사실 → 판정 → 작업 사건 한 줄.
//! 작업 행은 그대로다(닫지 않는다). `HARKROOM_TEST_DATABASE_URL` 이 없으면 건너뛴다.
use harkroom_server::core::turn_end_judge::{
    EVENT_TURN_JUDGED, Judged, TURN_JUDGE_PRIVILEGES, Verdict, judge_with, open_roots,
};
use harkroom_server::core::turn_lease::{Issue, end, issue};
use harkroom_server::core::work_route::route_with;
use serde_json::Value;
use sqlx::PgPool;

async fn one(admin: &PgPool, sql: &'static str, binds: &[&str]) -> String {
    let mut q = sqlx::query_scalar::<_, String>(sql);
    for b in binds {
        q = q.bind(*b);
    }
    q.fetch_one(admin).await.unwrap()
}

struct Env {
    admin: PgPool,
    w: PgPool,
    human: String,
    agent: String,
    op: String,
    ch: String,
}

/// 한 턴: 사람이 에이전트를 부른 글(스레드 뿌리) + 그 글의 임대. 라우팅 그림자도 돌려 뿌리 작업을 세운다.
struct Turn {
    cause: String,
    lease: String,
    token: String,
    work: String,
}

impl Env {
    async fn turn(&self) -> Turn {
        let cause = one(
            &self.admin,
            "insert into message(channel_id, author_id, body, kind) values ($1::uuid, $2::uuid, 'hi', 'user') returning id::text",
            &[&self.ch, &self.human],
        )
        .await;
        sqlx::query("insert into inbox(account_id, message_id, reason) values ($1::uuid, $2::uuid, 'mention')")
            .bind(&self.agent)
            .bind(&cause)
            .execute(&self.admin)
            .await
            .unwrap();
        let made = route_with(&self.w, &cause, std::slice::from_ref(&self.agent))
            .await
            .unwrap();
        assert_eq!(made.len(), 1);
        let Issue::Ok(i) = issue(&self.w, &self.agent, &self.op, &cause, None)
            .await
            .unwrap()
        else {
            panic!("lease not issued");
        };
        Turn {
            cause,
            lease: i.lease_id,
            token: i.token,
            work: made[0].0.clone(),
        }
    }

    /// 에이전트가 그 스레드에 쓴 글(`kind`, `meta`).
    async fn says(&self, t: &Turn, kind: &str, meta: &str) -> String {
        one(
            &self.admin,
            "insert into message(channel_id, author_id, body, kind, meta, thread_root_id) \
             values ($1::uuid, $2::uuid, 'x', $3, $4::jsonb, $5::uuid) returning id::text",
            &[&self.ch, &self.agent, kind, meta, &t.cause],
        )
        .await
    }

    async fn finish(&self, t: &Turn) -> Judged {
        assert!(end(&self.w, &t.lease, &t.token, &self.agent).await.unwrap());
        judge_with(&self.w, &t.lease, &self.agent)
            .await
            .unwrap()
            .expect("judged")
    }

    /// 그 작업의 판정 사건 payload 들.
    async fn events(&self, work: &str) -> Vec<Value> {
        let rows: Vec<String> = sqlx::query_scalar(
            "select payload::text from work_event where work_id = $1::uuid and kind = $2 order by id",
        )
        .bind(work)
        .bind(EVENT_TURN_JUDGED)
        .fetch_all(&self.admin)
        .await
        .unwrap();
        rows.iter()
            .map(|r| serde_json::from_str(r).unwrap())
            .collect()
    }

    /// 작업 행은 그대로다 — 상태 `open`, 닫힘 없음.
    async fn untouched(&self, work: &str) {
        let (state, closed): (String, bool) =
            sqlx::query_as("select state, closed_at is not null from work where id = $1::uuid")
                .bind(work)
                .fetch_one(&self.admin)
                .await
                .unwrap();
        assert_eq!((state.as_str(), closed), ("open", false));
    }
}

#[tokio::test]
async fn ended_lease_is_judged_and_recorded_without_closing() {
    let Ok(url) = std::env::var("HARKROOM_TEST_DATABASE_URL") else {
        eprintln!("skip: HARKROOM_TEST_DATABASE_URL unset");
        return;
    };
    let admin = PgPool::connect(&url).await.unwrap();
    let w = match std::env::var("HARKROOM_TEST_WRITE_DATABASE_URL") {
        Ok(u) => PgPool::connect(&u).await.unwrap(),
        Err(_) => admin.clone(),
    };
    let missing = harkroom_server::write::missing_in(
        &admin,
        TURN_JUDGE_PRIVILEGES,
        harkroom_server::core::work::WORK_SEQUENCE_PRIVILEGES,
    )
    .await
    .unwrap();
    assert!(missing.is_empty(), "{missing:?}");

    let human = one(
        &admin,
        "insert into account(handle, display_name, kind, login_id) values ($1, $1, 'human', $1) returning id::text",
        &["tej_rs_human"],
    )
    .await;
    const AGENT: &str = "insert into account(handle, display_name, kind) values ($1, $1, 'agent') returning id::text";
    let agent = one(&admin, AGENT, &["tej_rs_agent"]).await;
    let other = one(&admin, AGENT, &["tej_rs_other"]).await;
    let op = one(
        &admin,
        "insert into operator(owner_account_id, name, token_hash) values ($1::uuid, $2, md5(random()::text)) returning id::text",
        &[&human, "tej-rs-op"],
    )
    .await;
    let ch = one(
        &admin,
        "insert into channel(name, kind, visibility, created_by) values ($1, 'standard', 'private', $2::uuid) returning id::text",
        &["tej-rs", &human],
    )
    .await;
    let e = Env {
        admin: admin.clone(),
        w,
        human,
        agent,
        op,
        ch,
    };
    let (roots_before, _, _) = open_roots(&e.w).await.unwrap();

    // ① 아직 안 끝난 임대·남의 임대는 판정하지 않는다.
    let t = e.turn().await;
    assert!(
        judge_with(&e.w, &t.lease, &e.agent)
            .await
            .unwrap()
            .is_none()
    );
    // 보통의 답 하나로 끝난 턴 — 매듭은 없지만(silent) 글을 냈으니 뿌리 작업을 닫았을 것(answered).
    e.says(&t, "user", "{}").await;
    let j = e.finish(&t).await;
    assert!(judge_with(&e.w, &t.lease, &other).await.unwrap().is_none());
    assert_eq!(j.verdict, Verdict::Silent);
    assert!(j.facts.posted_any && !j.facts.posted_report);
    let target = j.target.clone().unwrap();
    assert_eq!(
        (target.work_id.as_str(), target.root, target.via.as_str()),
        (t.work.as_str(), true, "routed")
    );
    assert_eq!(j.close.map(|c| (c.by, c.state)), Some(("answered", "done")));
    // 위 두 번의 `None` 은 사건을 남기지 않았다 — 한 줄뿐이다.
    let ev = e.events(&t.work).await;
    assert_eq!(ev.len(), 1, "{ev:?}");
    assert_eq!(ev[0]["leaseId"], t.lease.as_str());
    assert_eq!(ev[0]["causeMessageId"], t.cause.as_str());
    assert_eq!(ev[0]["verdict"], "silent");
    assert_eq!(ev[0]["wouldClose"], "done");
    assert_eq!(ev[0]["closeBy"], "answered");
    assert_eq!(ev[0]["facts"]["posted"], true);
    e.untouched(&t.work).await;

    // ② 글도 없이 끝났다 — silent, 닫지 않는다. 진행 줄(`progress`)은 글로 세지 않는다.
    let t = e.turn().await;
    e.says(&t, "progress", "{}").await;
    let j = e.finish(&t).await;
    assert_eq!(j.verdict, Verdict::Silent);
    assert!(!j.facts.posted_any);
    assert_eq!(j.close, None);
    assert!(e.events(&t.work).await[0]["wouldClose"].is_null());

    // ③ 보고 → settled, done.
    let t = e.turn().await;
    e.says(&t, "user", r#"{"kind":"report"}"#).await;
    let j = e.finish(&t).await;
    assert_eq!(j.verdict, Verdict::Settled);
    assert_eq!(j.close.map(|c| (c.by, c.state)), Some(("report", "done")));

    // ④ 실패 → settled, failed.
    let t = e.turn().await;
    e.says(
        &t,
        "user",
        r#"{"kind":"failure","failure":{"retryable":true}}"#,
    )
    .await;
    let j = e.finish(&t).await;
    assert_eq!(j.close.map(|c| (c.by, c.state)), Some(("fail", "failed")));

    // ⑤ 열린 카드 → 사람을 기다린다, 닫지 않는다. 답이 달리면 더는 열린 카드가 아니다.
    let t = e.turn().await;
    let card = e
        .says(&t, "user", r#"{"kind":"ask","ask":{"options":[]}}"#)
        .await;
    let j = e.finish(&t).await;
    assert_eq!(j.verdict, Verdict::WaitingOnHuman);
    assert_eq!(j.close, None);
    e.untouched(&t.work).await;
    sqlx::query("update message set meta = jsonb_set(meta, '{ask,answeredWith}', '\"a\"') where id = $1::uuid")
        .bind(&card)
        .execute(&e.admin)
        .await
        .unwrap();
    let again = judge_with(&e.w, &t.lease, &e.agent).await.unwrap().unwrap();
    assert!(!again.facts.open_ask);

    // ⑥ 걸어 둔 예약 → 예약을 기다린다.
    let t = e.turn().await;
    let wake = e.says(&t, "wake", "{}").await;
    sqlx::query(
        "insert into agent_wake(account_id, channel_id, message_id, wake_at) \
         values ($1::uuid, $2::uuid, $3::uuid, now() + interval '10 minutes')",
    )
    .bind(&e.agent)
    .bind(&e.ch)
    .bind(&wake)
    .execute(&e.admin)
    .await
    .unwrap();
    let j = e.finish(&t).await;
    assert_eq!(j.verdict, Verdict::WaitingOnWake);
    assert!(!j.facts.posted_any, "예약 줄은 글이 아니다");
    assert_eq!(j.close, None);

    // ⑦ 라우팅 사건이 없는 원인 글 — 그 스레드의 열린 작업으로 떨어진다(thread). 작업이 하나도 없으면 사건을 남기지 않는다.
    let t = e.turn().await;
    sqlx::query("delete from work_event where work_id = $1::uuid and kind = 'message.routed'")
        .bind(&t.work)
        .execute(&e.admin)
        .await
        .unwrap();
    sqlx::query("update work set source_message_id = null where id = $1::uuid")
        .bind(&t.work)
        .execute(&e.admin)
        .await
        .unwrap();
    let j = e.finish(&t).await;
    assert_eq!(j.target.as_ref().map(|x| x.via.as_str()), Some("thread"));
    sqlx::query("delete from work where id = $1::uuid")
        .bind(&t.work)
        .execute(&e.admin)
        .await
        .unwrap();
    let none = judge_with(&e.w, &t.lease, &e.agent).await.unwrap().unwrap();
    assert_eq!((none.target, none.close), (None, None));

    // ⑧ 취소(감사 줄) → settled, canceled. 맨 끝에 둔다 — 감사 줄은 에이전트·채널까지만 가른다.
    let t = e.turn().await;
    sqlx::query(
        "insert into audit_log(action, actor_id, actor_handle, target, detail) \
         values ('agent.turn.canceled', $1::uuid, 'tej_rs_human', $2, jsonb_build_object('channelId', $3::text))",
    )
    .bind(&e.human)
    .bind(&e.agent)
    .bind(&e.ch)
    .execute(&e.admin)
    .await
    .unwrap();
    let j = e.finish(&t).await;
    assert!(j.facts.turn_canceled);
    assert_eq!(
        j.close.map(|c| (c.by, c.state)),
        Some(("canceled", "canceled"))
    );
    e.untouched(&t.work).await;

    // 옛 뿌리 세기 — 이 시험이 세운 뿌리(7개 남음)는 하나도 닫히지 않았고, 수는 서로 어긋나지 않는다.
    let (all, old, idle) = open_roots(&e.w).await.unwrap();
    assert!(all >= roots_before + 7, "{all} {roots_before}");
    assert!(old <= all && idle <= all);
    let mine: i64 = sqlx::query_scalar(
        "select count(*) from work where channel_id = $1::uuid and closed_at is null and state = 'open'",
    )
    .bind(&e.ch)
    .fetch_one(&e.admin)
    .await
    .unwrap();
    assert_eq!(mine, 7);
}
