//! 턴 끝 판정 그림자(`core::turn_end_judge`, I2c-a)를 실제 Postgres 로 본다 — 끝난 임대 → 사실 → 판정 → 작업 사건 한 줄.
//! 작업 행은 그대로다(닫지 않는다). `HARKROOM_TEST_DATABASE_URL` 이 없으면 건너뛴다.
use harkroom_server::core::turn_end_judge::{
    EVENT_TURN_JUDGED, Judged, Mode, TURN_JUDGE_PRIVILEGES, Verdict, judge_with, open_roots,
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
    mode: Mode,
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
        judge_with(&self.w, &t.lease, &self.agent, self.mode)
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
        mode: Mode::Shadow,
    };
    let (roots_before, _, _) = open_roots(&e.w).await.unwrap();

    // ① 아직 안 끝난 임대·남의 임대는 판정하지 않는다.
    let t = e.turn().await;
    assert!(
        judge_with(&e.w, &t.lease, &e.agent, Mode::Shadow)
            .await
            .unwrap()
            .is_none()
    );
    // 보통의 답 하나로 끝난 턴 — 매듭은 없지만(silent) 글을 냈으니 뿌리 작업을 닫았을 것(answered).
    e.says(&t, "user", "{}").await;
    let j = e.finish(&t).await;
    assert!(
        judge_with(&e.w, &t.lease, &other, Mode::Shadow)
            .await
            .unwrap()
            .is_none()
    );
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
    let again = judge_with(&e.w, &t.lease, &e.agent, Mode::Shadow)
        .await
        .unwrap()
        .unwrap();
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
    let none = judge_with(&e.w, &t.lease, &e.agent, Mode::Shadow)
        .await
        .unwrap()
        .unwrap();
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

impl Env {
    /// 그 글의 인박스 행을 읽음으로 — 러너가 턴을 끝내며 하는 일이다.
    async fn read(&self, account: &str, message: &str) {
        sqlx::query("update inbox set read_at = now() where account_id = $1::uuid and message_id = $2::uuid")
            .bind(account)
            .bind(message)
            .execute(&self.admin)
            .await
            .unwrap();
    }

    /// 스레드 안의 글 하나(`author` 가 쓴 것) + `to` 의 인박스 행.
    async fn reply(&self, thread: &str, author: &str, meta: &str, to: &str) -> String {
        let id = one(
            &self.admin,
            "insert into message(channel_id, author_id, body, kind, meta, thread_root_id) \
             values ($1::uuid, $2::uuid, 'x', 'user', $3::jsonb, $4::uuid) returning id::text",
            &[&self.ch, author, meta, thread],
        )
        .await;
        sqlx::query("insert into inbox(account_id, message_id, reason) values ($1::uuid, $2::uuid, 'mention')")
            .bind(to)
            .bind(&id)
            .execute(&self.admin)
            .await
            .unwrap();
        id
    }

    async fn lease(&self, agent: &str, cause: &str) -> (String, String) {
        let Issue::Ok(i) = issue(&self.w, agent, &self.op, cause, None).await.unwrap() else {
            panic!("lease not issued");
        };
        (i.lease_id, i.token)
    }

    /// 작업 행의 (상태, 닫혔는가).
    async fn state(&self, work: &str) -> (String, bool) {
        sqlx::query_as("select state, closed_at is not null from work where id = $1::uuid")
            .bind(work)
            .fetch_one(&self.admin)
            .await
            .unwrap()
    }

    async fn rejudge(&self, t: &Turn) -> Judged {
        judge_with(&self.w, &t.lease, &self.agent, self.mode)
            .await
            .unwrap()
            .expect("judged")
    }
}

fn st(s: (String, bool)) -> (String, bool) {
    s
}

/// 켬(`Mode::On`) — 판정대로 **뿌리 작업만** 닫는다. 하위(위임) 작업은 닫지 않고, 뿌리도 열린 하위·도는 턴·안 읽힌 글이 있으면
/// 닫지 않는다. 옛 뿌리 정리는 움직임 없는 오래된 뿌리만 접는다.
#[tokio::test]
async fn on_mode_closes_only_settled_roots() {
    use harkroom_server::core::turn_end_judge::{
        EVENT_ROOT_SWEPT, Skip, TURN_CLOSE_PRIVILEGES, sweep,
    };
    use harkroom_server::core::work_route::route_with_mode;
    use harkroom_server::core::work_shadow::{delegation_closed_with, delegation_created_with};
    let Ok(url) = std::env::var("HARKROOM_TEST_DATABASE_URL") else {
        eprintln!("skip: HARKROOM_TEST_DATABASE_URL unset");
        return;
    };
    let admin = PgPool::connect(&url).await.unwrap();
    let w = match std::env::var("HARKROOM_TEST_WRITE_DATABASE_URL") {
        Ok(u) => PgPool::connect(&u).await.unwrap(),
        Err(_) => admin.clone(),
    };
    let missing = harkroom_server::write::missing_in(&w, TURN_CLOSE_PRIVILEGES, &[])
        .await
        .unwrap();
    assert!(missing.is_empty(), "{missing:?}");
    let human = one(
        &admin,
        "insert into account(handle, display_name, kind, login_id) values ($1, $1, 'human', $1) returning id::text",
        &["tejon_rs_human"],
    )
    .await;
    const AGENT: &str = "insert into account(handle, display_name, kind) values ($1, $1, 'agent') returning id::text";
    let agent = one(&admin, AGENT, &["tejon_rs_agent"]).await;
    let other = one(&admin, AGENT, &["tejon_rs_other"]).await;
    let op = one(
        &admin,
        "insert into operator(owner_account_id, name, token_hash) values ($1::uuid, $2, md5(random()::text)) returning id::text",
        &[&human, "tejon-rs-op"],
    )
    .await;
    let ch = one(
        &admin,
        "insert into channel(name, kind, visibility, created_by) values ($1, 'standard', 'private', $2::uuid) returning id::text",
        &["tejon-rs", &human],
    )
    .await;
    let e = Env {
        admin: admin.clone(),
        w,
        human,
        agent,
        op,
        ch,
        mode: Mode::On,
    };
    let done = |b: bool| (String::from("done"), b);
    let open = || (String::from("open"), false);

    // ① 보통의 답으로 끝난 턴. 원인 글이 아직 안 읽혔으면(턴이 다시 뜬다) 닫지 않는다 → 읽힌 뒤에는 닫는다.
    let t = e.turn().await;
    e.says(&t, "user", "{}").await;
    let j = e.finish(&t).await;
    assert_eq!((j.closed, j.skip), (false, Some(Skip::PendingMessage)));
    assert_eq!(st(e.state(&t.work).await), open());
    e.read(&e.agent, &t.cause).await;
    let j = e.rejudge(&t).await;
    assert_eq!((j.closed, j.skip, j.overlap), (true, None, false));
    assert_eq!(st(e.state(&t.work).await), done(true));
    let ev = e.events(&t.work).await;
    assert_eq!(ev[0]["closeSkipped"], "pending_message");
    assert_eq!(
        (&ev[1]["closed"], &ev[1]["closeBy"]),
        (&Value::Bool(true), &Value::from("answered"))
    );
    let by: String = sqlx::query_scalar(
        "select payload->>'by' from work_event where work_id = $1::uuid and kind = 'state' order by id desc limit 1",
    )
    .bind(&t.work)
    .fetch_one(&e.admin)
    .await
    .unwrap();
    assert_eq!(by, "answered");
    // 이미 닫힌 뿌리는 다시 닫지 않는다(상태도 그대로).
    let j = e.rejudge(&t).await;
    assert_eq!((j.closed, j.skip), (false, Some(Skip::Closed)));
    assert_eq!(st(e.state(&t.work).await), done(true));

    // ② 실패 → failed. 글도 없이 끝난 턴·열린 카드는 닫지 않는다.
    let t = e.turn().await;
    e.says(
        &t,
        "user",
        r#"{"kind":"failure","failure":{"retryable":true}}"#,
    )
    .await;
    e.read(&e.agent, &t.cause).await;
    assert!(e.finish(&t).await.closed);
    assert_eq!(st(e.state(&t.work).await), (String::from("failed"), true));
    let t = e.turn().await;
    e.read(&e.agent, &t.cause).await;
    let j = e.finish(&t).await;
    assert_eq!((j.close, j.closed, j.skip), (None, false, None));
    assert_eq!(st(e.state(&t.work).await), open());
    let t = e.turn().await;
    e.says(&t, "user", r#"{"kind":"ask","ask":{"options":[]}}"#)
        .await;
    e.read(&e.agent, &t.cause).await;
    let j = e.finish(&t).await;
    assert_eq!((j.verdict, j.closed), (Verdict::WaitingOnHuman, false));
    assert_eq!(st(e.state(&t.work).await), open());

    // ③ 위임 — 하위 작업은 이 판정이 닫지 않는다. 뿌리는 열린 하위 위임·안 끝난 하위 작업이 있는 동안 닫히지 않는다.
    let t = e.turn().await;
    let deleg_msg = e
        .reply(&t.cause, &e.agent, r#"{"kind":"delegation"}"#, &other)
        .await;
    let team = one(
        &e.admin,
        "insert into agent_team(name, created_by) values ($1, $2::uuid) returning id::text",
        &["tejon rs", &e.human],
    )
    .await;
    let deleg = one(
        &e.admin,
        "insert into team_delegation(message_id, team_id, lead_account_id, channel_id, thread_root_id, deadline_at) \
         values ($1::uuid, $2::uuid, $3::uuid, $4::uuid, $5::uuid, now() + interval '1 hour') returning id::text",
        &[&deleg_msg, &team, &e.agent, &e.ch, &t.cause],
    )
    .await;
    sqlx::query("insert into team_delegation_item(delegation_id, delegate_account_id) values ($1::uuid, $2::uuid)")
        .bind(&deleg)
        .bind(&other)
        .execute(&e.admin)
        .await
        .unwrap();
    assert_eq!(delegation_created_with(&e.w, &deleg).await.unwrap(), 1);
    let child = one(
        &e.admin,
        "select id::text from work where delegation_id = $1::uuid",
        &[&deleg],
    )
    .await;
    // 위임자의 턴이 글을 내고 끝났다 — 열린 하위 위임을 기다린다(닫지 않는다).
    e.read(&e.agent, &t.cause).await;
    let j = e.finish(&t).await;
    assert_eq!(
        (j.verdict, j.close, j.closed),
        (Verdict::WaitingOnChild, None, false)
    );
    assert_eq!(st(e.state(&t.work).await), open());
    // 담당의 턴이 보고로 끝났다 — 그 턴의 작업은 하위 작업이다: 닫을 것도 아니고 닫지도 않는다.
    let (lease_o, token_o) = e.lease(&other, &deleg_msg).await;
    one(
        &e.admin,
        "insert into message(channel_id, author_id, body, kind, meta, thread_root_id) \
         values ($1::uuid, $2::uuid, 'x', 'user', '{\"kind\":\"report\"}'::jsonb, $3::uuid) returning id::text",
        &[&e.ch, &other, &t.cause],
    )
    .await;
    e.read(&other, &deleg_msg).await;
    assert!(end(&e.w, &lease_o, &token_o, &other).await.unwrap());
    let jo = judge_with(&e.w, &lease_o, &other, Mode::On)
        .await
        .unwrap()
        .unwrap();
    let target = jo.target.clone().unwrap();
    assert_eq!(
        (target.work_id.as_str(), target.root, target.via.as_str()),
        (child.as_str(), false, "source")
    );
    assert_eq!(
        (jo.verdict, jo.close, jo.closed, jo.skip),
        (Verdict::Settled, None, false, None)
    );
    assert_eq!(st(e.state(&child).await), (String::from("running"), false));
    assert_eq!(st(e.state(&t.work).await), open());
    // 위임 의무는 닫혔는데 하위 작업 행이 아직 열려 있다 — 뿌리는 닫을 판정이어도 닫지 않는다.
    sqlx::query("update team_delegation_item set outcome = 'reported', closed_at = now() where delegation_id = $1::uuid")
        .bind(&deleg)
        .execute(&e.admin)
        .await
        .unwrap();
    let j = e.rejudge(&t).await;
    assert_eq!((j.closed, j.skip), (false, Some(Skip::OpenChild)));
    assert_eq!(st(e.state(&t.work).await), open());
    // 하위 작업이 (위임 쪽 길로) 닫힌 뒤에야 뿌리가 닫힌다.
    assert_eq!(
        delegation_closed_with(&e.w, &deleg, None, "reported", None)
            .await
            .unwrap(),
        1
    );
    assert_eq!(st(e.state(&child).await), done(true));
    assert!(e.rejudge(&t).await.closed);
    assert_eq!(st(e.state(&t.work).await), done(true));

    // ④ 같은 작업으로 온 뒤 글이 안 읽혔거나, 그 글의 턴이 돌고 있으면 닫지 않는다. 뒤 턴이 끝나면 그 판정이 닫는다.
    let t = e.turn().await;
    e.says(&t, "user", "{}").await;
    e.read(&e.agent, &t.cause).await;
    let next = e.reply(&t.cause, &e.human, "{}", &e.agent).await;
    let routed = route_with_mode(&e.w, &next, std::slice::from_ref(&e.agent), true)
        .await
        .unwrap();
    assert_eq!(routed[0].0, t.work, "뒤 글은 열린 뿌리로 간다");
    let j = e.finish(&t).await;
    assert_eq!(
        (j.closed, j.skip, j.overlap),
        (false, Some(Skip::PendingMessage), false)
    );
    // 임대는 안 읽힌 글에만 선다 — 러너는 턴을 띄운 뒤에 읽음으로 바꾼다.
    let (lease2, token2) = e.lease(&e.agent, &next).await;
    e.read(&e.agent, &next).await;
    let j = e.rejudge(&t).await;
    assert_eq!((j.closed, j.skip), (false, Some(Skip::LiveTurn)));
    assert_eq!(st(e.state(&t.work).await), open());
    e.says(&t, "user", r#"{"kind":"report"}"#).await;
    assert!(end(&e.w, &lease2, &token2, &e.agent).await.unwrap());
    let j2 = judge_with(&e.w, &lease2, &e.agent, Mode::On)
        .await
        .unwrap()
        .unwrap();
    assert_eq!(
        j2.target.as_ref().map(|x| x.work_id.as_str()),
        Some(t.work.as_str())
    );
    assert!(j2.closed);
    assert_eq!(st(e.state(&t.work).await), done(true));
    // 닫힌 뒤에 온 글은 새 뿌리로 간다.
    let later = e.reply(&t.cause, &e.human, "{}", &e.agent).await;
    let routed = route_with_mode(&e.w, &later, std::slice::from_ref(&e.agent), true)
        .await
        .unwrap();
    assert_ne!(routed[0].0, t.work);
    e.read(&e.agent, &later).await;

    // ⑤ 겹친 턴 — 같은 스레드에서 두 임대의 창이 겹치면 판정에 적는다.
    let t = e.turn().await;
    let next = e.reply(&t.cause, &e.human, "{}", &e.agent).await;
    route_with_mode(&e.w, &next, std::slice::from_ref(&e.agent), true)
        .await
        .unwrap();
    e.read(&e.agent, &t.cause).await;
    let (lease2, token2) = e.lease(&e.agent, &next).await;
    e.read(&e.agent, &next).await;
    e.says(&t, "user", "{}").await;
    let j = e.finish(&t).await;
    assert_eq!(
        (j.overlap, j.closed, j.skip),
        (true, false, Some(Skip::LiveTurn))
    );
    assert!(end(&e.w, &lease2, &token2, &e.agent).await.unwrap());
    let j2 = judge_with(&e.w, &lease2, &e.agent, Mode::On)
        .await
        .unwrap()
        .unwrap();
    assert!(j2.overlap && j2.closed);

    // ⑥ 취소 — 스레드가 적힌 감사 줄은 그 스레드의 턴만 취소로 읽는다.
    let (ta, tb) = (e.turn().await, e.turn().await);
    sqlx::query(
        "insert into audit_log(action, actor_id, actor_handle, target, detail) \
         values ('agent.turn.canceled', $1::uuid, 'tejon_rs_human', $2, \
                 jsonb_build_object('channelId', $3::text, 'threadRootId', $4::text))",
    )
    .bind(&e.human)
    .bind(&e.agent)
    .bind(&e.ch)
    .bind(&ta.cause)
    .execute(&e.admin)
    .await
    .unwrap();
    e.read(&e.agent, &ta.cause).await;
    e.read(&e.agent, &tb.cause).await;
    let jb = e.finish(&tb).await;
    assert!(!jb.facts.turn_canceled, "다른 스레드의 취소는 읽지 않는다");
    assert_eq!(st(e.state(&tb.work).await), open());
    let ja = e.finish(&ta).await;
    assert!(ja.facts.turn_canceled && ja.closed);
    assert_eq!(
        st(e.state(&ta.work).await),
        (String::from("canceled"), true)
    );

    // ⑦ 옛 뿌리 정리 — 오래 고쳐지지 않았고 움직임이 없는 뿌리만 접는다.
    let age = std::time::Duration::from_secs(24 * 60 * 60);
    let old = |work: String| {
        let admin = e.admin.clone();
        async move {
            sqlx::query(
                "update work set updated_at = now() - interval '2 days' where id = $1::uuid",
            )
            .bind(&work)
            .execute(&admin)
            .await
            .unwrap();
        }
    };
    let stale = e.turn().await; // 임대가 끝난 오래된 뿌리 → 접는다
    let live = e.turn().await; // 임대가 살아 있는 오래된 뿌리 → 그대로
    let asking = e.turn().await; // 열린 카드가 있는 오래된 뿌리 → 그대로
    let parent = e.turn().await; // 안 끝난 하위 작업이 있는 오래된 뿌리 → 그대로
    let touched = e.turn().await; // 오래됐지만 방금 글이 온 뿌리(라우팅 on 이 시각을 고친다) → 그대로
    for t in [&stale, &asking, &parent, &touched] {
        assert!(end(&e.w, &t.lease, &t.token, &e.agent).await.unwrap());
    }
    e.says(&asking, "user", r#"{"kind":"ask","ask":{"options":[]}}"#)
        .await;
    let kid = harkroom_server::core::work::create(
        &e.w,
        &harkroom_server::core::work::NewWork {
            channel_id: &e.ch,
            thread_root_id: &parent.cause,
            parent_id: Some(&parent.work),
            assignee_account_id: Some(&other),
            ..Default::default()
        },
        None,
    )
    .await
    .unwrap()
    .expect("child");
    for t in [&stale, &live, &asking, &parent, &touched] {
        old(t.work.clone()).await;
    }
    old(kid.clone()).await;
    let more = e.reply(&touched.cause, &e.human, "{}", &e.agent).await;
    route_with_mode(&e.w, &more, std::slice::from_ref(&e.agent), true)
        .await
        .unwrap();
    let fresh_before: i64 = sqlx::query_scalar(
        "select count(*) from work where channel_id = $1::uuid and closed_at is null",
    )
    .bind(&e.ch)
    .fetch_one(&e.admin)
    .await
    .unwrap();
    assert_eq!(sweep(&e.w, age, 500).await.unwrap(), 1);
    assert_eq!(
        st(e.state(&stale.work).await),
        (String::from("canceled"), true)
    );
    for t in [&live, &asking, &parent, &touched] {
        assert_eq!(st(e.state(&t.work).await), open(), "{}", t.work);
    }
    assert_eq!(st(e.state(&kid).await), open(), "하위 작업은 접지 않는다");
    let swept: (String, String) = sqlx::query_as(
        "select payload->>'from', payload->>'reason' from work_event where work_id = $1::uuid and kind = $2",
    )
    .bind(&stale.work)
    .bind(EVENT_ROOT_SWEPT)
    .fetch_one(&e.admin)
    .await
    .unwrap();
    assert_eq!(swept, (String::from("open"), String::from("stale")));
    let fresh_after: i64 = sqlx::query_scalar(
        "select count(*) from work where channel_id = $1::uuid and closed_at is null",
    )
    .bind(&e.ch)
    .fetch_one(&e.admin)
    .await
    .unwrap();
    assert_eq!(fresh_after, fresh_before - 1);
    // 되풀이해도 더 접지 않는다.
    assert_eq!(sweep(&e.w, age, 500).await.unwrap(), 0);

    // ⑧ 닫힌 뿌리는 다시 열리지 않는다 — 뒤에 온 글도 새 위임도 **새 뿌리**를 세운다. 뒤 턴은 새 뿌리만 닫는다.
    let roots = |thread: String| {
        let admin = e.admin.clone();
        let agent = e.agent.clone();
        async move {
            sqlx::query_as::<_, (String, bool)>(
                "select id::text, closed_at is not null from work \
                  where thread_root_id = $1::uuid and assignee_account_id = $2::uuid \
                    and parent_id is null and delegation_id is null order by created_at, id",
            )
            .bind(&thread)
            .bind(&agent)
            .fetch_all(&admin)
            .await
            .unwrap()
        }
    };
    let t = e.turn().await;
    e.says(&t, "user", r#"{"kind":"report"}"#).await;
    e.read(&e.agent, &t.cause).await;
    assert!(e.finish(&t).await.closed);
    assert_eq!(roots(t.cause.clone()).await, vec![(t.work.clone(), true)]);
    // 뒤 글 → 새 뿌리(판정 `new`). 그 글의 턴이 답하고 끝나면 새 뿌리가 닫히고, 옛 뿌리는 닫힌 그대로다(닫힘 사건 한 줄).
    let later = e.reply(&t.cause, &e.human, "{}", &e.agent).await;
    let routed = route_with_mode(&e.w, &later, std::slice::from_ref(&e.agent), true)
        .await
        .unwrap();
    let second = routed[0].0.clone();
    assert_ne!(second, t.work);
    assert_eq!(routed[0].1.as_str(), "new");
    let (lease2, token2) = e.lease(&e.agent, &later).await;
    e.read(&e.agent, &later).await;
    e.says(&t, "user", "{}").await;
    assert!(end(&e.w, &lease2, &token2, &e.agent).await.unwrap());
    let j2 = judge_with(&e.w, &lease2, &e.agent, Mode::On)
        .await
        .unwrap()
        .unwrap();
    assert_eq!(
        j2.target.as_ref().map(|x| (x.work_id.as_str(), x.root)),
        Some((second.as_str(), true))
    );
    assert!(j2.closed);
    assert_eq!(
        roots(t.cause.clone()).await,
        vec![(t.work.clone(), true), (second.clone(), true)]
    );
    let closes: i64 = sqlx::query_scalar(
        "select count(*) from work_event where work_id = $1::uuid and kind = 'state'",
    )
    .bind(&t.work)
    .fetch_one(&e.admin)
    .await
    .unwrap();
    assert_eq!(closes, 1, "옛 뿌리는 한 번만 닫힌다");
    // 새 위임 → 닫힌 뿌리 밑에 서지 않는다. 위임 쪽이 새 뿌리를 세우고 하위 작업을 그 밑에 둔다.
    let deleg_msg = e
        .reply(&t.cause, &e.agent, r#"{"kind":"delegation"}"#, &other)
        .await;
    let deleg = one(
        &e.admin,
        "insert into team_delegation(message_id, team_id, lead_account_id, channel_id, thread_root_id, deadline_at) \
         values ($1::uuid, $2::uuid, $3::uuid, $4::uuid, $5::uuid, now() + interval '1 hour') returning id::text",
        &[&deleg_msg, &team, &e.agent, &e.ch, &t.cause],
    )
    .await;
    sqlx::query("insert into team_delegation_item(delegation_id, delegate_account_id) values ($1::uuid, $2::uuid)")
        .bind(&deleg)
        .bind(&other)
        .execute(&e.admin)
        .await
        .unwrap();
    assert_eq!(delegation_created_with(&e.w, &deleg).await.unwrap(), 1);
    let parent_of_child = one(
        &e.admin,
        "select parent_id::text from work where delegation_id = $1::uuid",
        &[&deleg],
    )
    .await;
    let all = roots(t.cause.clone()).await;
    assert_eq!(all.len(), 3, "{all:?}");
    assert_eq!(all[2], (parent_of_child.clone(), false));
    assert!(all[0].1 && all[1].1, "닫힌 뿌리 둘은 그대로다");
    // 옛 턴을 다시 판정해도 닫힌 뿌리는 그대로이고(`closed`), 뒤에 선 새 뿌리를 대신 닫지 않는다 — 새 뿌리는 그 뿌리로 온 턴이 닫는다.
    let j = e.rejudge(&t).await;
    assert_eq!((j.closed, j.skip), (false, Some(Skip::Closed)));
    assert_eq!(st(e.state(&parent_of_child).await), open());
    assert_eq!(
        delegation_closed_with(&e.w, &deleg, None, "reported", None)
            .await
            .unwrap(),
        1
    );

    // ⑨ 작업을 못 찾은 판정(`work=none`) — 닫을 것이 없다. 사건도 작업 행도 만들지 않는다.
    let t = e.turn().await;
    e.says(&t, "user", r#"{"kind":"report"}"#).await;
    e.read(&e.agent, &t.cause).await;
    sqlx::query("delete from work where id = $1::uuid")
        .bind(&t.work)
        .execute(&e.admin)
        .await
        .unwrap();
    let j = e.finish(&t).await;
    assert_eq!(j.verdict, Verdict::Settled);
    assert_eq!(
        (j.target, j.close, j.closed, j.skip),
        (None, None, false, None)
    );
    assert!(roots(t.cause.clone()).await.is_empty());

    // ⑩ 끝내기 없이 만료된 임대 — 판정 자리를 지나지 않는다(판정 없음, 뿌리는 열린 채). 오래되면 정리가 접는다.
    let t = e.turn().await;
    e.says(&t, "user", r#"{"kind":"report"}"#).await;
    e.read(&e.agent, &t.cause).await;
    sqlx::query(
        "update secret_turn_lease set expires_at = now() - interval '1 minute' where id = $1::uuid",
    )
    .bind(&t.lease)
    .execute(&e.admin)
    .await
    .unwrap();
    assert!(
        judge_with(&e.w, &t.lease, &e.agent, Mode::On)
            .await
            .unwrap()
            .is_none()
    );
    assert!(e.events(&t.work).await.is_empty());
    assert_eq!(st(e.state(&t.work).await), open());
    assert_eq!(
        sweep(&e.w, age, 500).await.unwrap(),
        0,
        "아직 하루가 안 됐다"
    );
    old(t.work.clone()).await;
    assert_eq!(sweep(&e.w, age, 500).await.unwrap(), 1);
    assert_eq!(st(e.state(&t.work).await), (String::from("canceled"), true));
}
