//! 계획 진행 루프의 멈춤 판정(`loops::plan_progress`)이 실제 스키마에서 신호를 읽고, 단계별 시계(`thread_plan.stall`)를 적고,
//! 켜져 있으면 관리자를 깨우는지 본다. `HARKROOM_TEST_DATABASE_URL` 이 없으면 건너뛴다. 계획·글은 시험이 직접 깐다.
use harkroom_server::core::msg_post::PostState;
use harkroom_server::core::thread_plan_read::plan_view_json_with;
use harkroom_server::loops::plan_progress::{
    PLAN_STALL_CLOCK_PRIVILEGES, PLAN_STALL_PRIVILEGES, Seen, StallState, sweep,
};
use serde_json::Value;
use sqlx::PgPool;

const HOUR: i64 = 3600;

async fn one(admin: &PgPool, sql: &'static str, binds: &[&str]) -> String {
    let mut q = sqlx::query_scalar(sql);
    for b in binds {
        q = q.bind(*b);
    }
    q.fetch_one(admin).await.unwrap()
}

async fn run(admin: &PgPool, sql: &'static str, binds: &[&str]) {
    let mut q = sqlx::query(sql);
    for b in binds {
        q = q.bind(*b);
    }
    q.execute(admin).await.unwrap();
}

/// 그 계획의 (조용함, 멈춤) 수 — 새 기록으로 한 번 훑는다(같은 판정을 두 번 남기지 않는 규칙에 가리지 않게). 창은 한 시간이다.
async fn counts(pool: &PgPool, root: &str) -> (i64, i64) {
    let mut state = StallState::new(HOUR);
    let events = sweep(pool, &mut Seen::new(), Some(&mut state))
        .await
        .unwrap();
    let of = |branch: &str| {
        events
            .iter()
            .filter(|e| e.thread_root_id.as_deref() == Some(root))
            .find(|e| e.detail.as_ref().is_some_and(|d| d["branch"] == branch))
            .map(|e| {
                // 줄에는 단계 id 가 실리고 수와 맞는다.
                let steps = e.detail.as_ref().unwrap()["steps"]
                    .as_array()
                    .unwrap()
                    .len();
                assert_eq!(e.value, Some(steps as i64));
                steps as i64
            })
            .unwrap_or(0)
    };
    (of("quiet"), of("would_stall"))
}

/// 그 단계의 시계를 두 시간 전으로 돌린다(시간이 흐른 것처럼).
async fn age(admin: &PgPool, root: &str, step: &'static str) {
    sqlx::query(
        "update thread_plan set stall = jsonb_set(stall, array['steps', $2, 'quietAt'], \
           to_jsonb(extract(epoch from now())::int8 - 7200)) where root_id = $1::uuid",
    )
    .bind(root)
    .bind(step)
    .execute(admin)
    .await
    .unwrap();
}

/// 시계를 돌린 뒤의 수.
async fn aged(admin: &PgPool, root: &str) -> (i64, i64) {
    age(admin, root, "s1").await;
    counts(admin, root).await
}

async fn clock(admin: &PgPool, root: &str) -> Value {
    let raw: String =
        sqlx::query_scalar("select stall::text from thread_plan where root_id = $1::uuid")
            .bind(root)
            .fetch_one(admin)
            .await
            .unwrap();
    serde_json::from_str(&raw).unwrap()
}

#[tokio::test]
async fn stall_reads_each_signal_keeps_a_clock_and_wakes_the_manager() {
    let Ok(url) = std::env::var("HARKROOM_TEST_DATABASE_URL") else {
        eprintln!("skip: HARKROOM_TEST_DATABASE_URL unset");
        return;
    };
    let admin = PgPool::connect(&url).await.unwrap();
    let needed = [PLAN_STALL_PRIVILEGES, PLAN_STALL_CLOCK_PRIVILEGES].concat();
    let missing = harkroom_server::write::missing_in(&admin, &needed, &[])
        .await
        .unwrap();
    assert!(missing.is_empty(), "{missing:?}");

    let account =
        "insert into account(handle, display_name, kind) values ($1, $1, $2) returning id::text";
    let lead = one(&admin, account, &["ps_lead", "agent"]).await;
    let agent = one(&admin, account, &["ps_agent", "agent"]).await;
    let other = one(&admin, account, &["ps_other", "agent"]).await;
    let human = one(&admin, account, &["ps_human", "human"]).await;
    let ch = one(
        &admin,
        "insert into channel(name, kind) values ('ps-rs', 'standard') returning id::text",
        &[],
    )
    .await;
    for member in [&lead, &agent, &other, &human] {
        run(
            &admin,
            "insert into channel_member(channel_id, account_id) values ($1::uuid, $2::uuid)",
            &[&ch, member],
        )
        .await;
    }
    let post = "insert into message(channel_id, author_id, body, kind) values ($1::uuid, $2::uuid, 'x', 'user') returning id::text";
    let root = one(&admin, post, &[&ch, &lead]).await;
    // s1: 에이전트 담당 active · s2: 사람 담당 active · s3: 에이전트 담당 pending. 관리자는 lead(에이전트).
    let doc = serde_json::json!({"goal": "", "managerId": lead, "groups": [], "steps": [
        {"id": "s1", "title": "a @b", "state": "active", "assigneeId": agent, "links": [], "dependsOn": []},
        {"id": "s2", "title": "b", "state": "active", "assigneeId": human, "links": [], "dependsOn": []},
        {"id": "s3", "title": "c", "state": "pending", "assigneeId": agent, "links": [], "dependsOn": ["s1"]}
    ]})
    .to_string();
    run(
        &admin,
        "insert into thread_plan(root_id, channel_id, doc) values ($1::uuid, $2::uuid, $3::jsonb)",
        &[&root, &ch, &doc],
    )
    .await;
    let stamp =
        "select rev::text || ' ' || updated_at::text from thread_plan where root_id = $1::uuid";
    let before = one(&admin, stamp, &[&root]).await;

    // 오판 꼴 ① 방금 ▶ 가 됐다(또는 스위치를 방금 켰다) — 조용하지만 멈춤이 아니다. 시계는 지금부터, 대상 단계만.
    assert_eq!(counts(&admin, &root).await, (1, 0));
    let c = clock(&admin, &root).await;
    assert!(c["seenAt"].as_i64().unwrap() > 0);
    assert!(c["steps"]["s1"]["quietAt"].as_i64().unwrap() > 0);
    assert_eq!(c["steps"].as_object().unwrap().len(), 1, "{c}");
    // 진짜 멈춤 — 신호도 담당의 글도 없이 시간이 넘었다. 멈춤 표시가 적힌다. 판(rev·updated_at)은 그대로다.
    assert_eq!(aged(&admin, &root).await, (1, 1));
    assert!(clock(&admin, &root).await["steps"]["s1"]["markedAt"].is_i64());
    assert_eq!(one(&admin, stamp, &[&root]).await, before);

    // 담당이 이 스레드에 방금 썼다 — 멈춤이 아니다(표시도 지워진다). 두 시간 전 글이면 다시 멈춤이다(창은 한 시간).
    let reply = "insert into message(channel_id, author_id, body, kind, thread_root_id) \
                 values ($1::uuid, $2::uuid, 'x', 'user', $3::uuid) returning id::text";
    let said = one(&admin, reply, &[&ch, &agent, &root]).await;
    assert_eq!(counts(&admin, &root).await, (1, 0));
    assert!(clock(&admin, &root).await["steps"]["s1"]["markedAt"].is_null());
    let old = "update message set created_at = now() - interval '2 hours' where id = $1::uuid";
    run(&admin, old, &[&said]).await;
    assert_eq!(counts(&admin, &root).await, (1, 1));
    // 서버가 담당 이름으로 세운 줄(system)은 담당의 글이 아니다.
    run(
        &admin,
        "insert into message(channel_id, author_id, body, kind, thread_root_id) values ($1::uuid, $2::uuid, 'x', 'system', $3::uuid)",
        &[&ch, &agent, &root],
    )
    .await;
    assert_eq!(counts(&admin, &root).await, (1, 1));

    // 오판 꼴 ② 같은 단계의 열린 위임이 **담당이 아닌 계정**에게 가 있다 — 신호다. 시계도 다시 시작한다.
    let call = one(&admin, reply, &[&ch, &lead, &root]).await;
    run(&admin, old, &[&call]).await;
    let delegation = one(
        &admin,
        "insert into team_delegation(message_id, lead_account_id, channel_id, thread_root_id, deadline_at, plan_step_id) \
         values ($1::uuid, $2::uuid, $3::uuid, $4::uuid, now() + interval '1 hour', 's1') returning id::text",
        &[&call, &agent, &ch, &root],
    )
    .await;
    run(
        &admin,
        "insert into team_delegation_item(delegation_id, delegate_account_id) values ($1::uuid, $2::uuid)",
        &[&delegation, &other],
    )
    .await;
    assert_eq!(counts(&admin, &root).await, (0, 0));
    // 다른 단계가 적힌 위임은 s1 의 신호가 아니다 — 다만 방금 신호가 있었으니 시계는 새로 간다.
    let step = "update team_delegation set plan_step_id = $2 where id = $1::uuid";
    run(&admin, step, &[&delegation, "s3"]).await;
    assert_eq!(counts(&admin, &root).await, (1, 0));
    assert_eq!(aged(&admin, &root).await, (1, 1));
    // 단계가 안 적힌 위임은 담당에게 간 것만 신호다(담당의 active 단계 모두).
    sqlx::query("update team_delegation set plan_step_id = null where id = $1::uuid")
        .bind(&delegation)
        .execute(&admin)
        .await
        .unwrap();
    assert_eq!(aged(&admin, &root).await, (1, 1));
    let to = "update team_delegation_item set delegate_account_id = $2::uuid where delegation_id = $1::uuid";
    run(&admin, to, &[&delegation, &agent]).await;
    assert_eq!(counts(&admin, &root).await, (0, 0));
    run(
        &admin,
        "update team_delegation_item set outcome = 'done', closed_at = now() where delegation_id = $1::uuid",
        &[&delegation],
    )
    .await;
    assert_eq!(aged(&admin, &root).await, (1, 1));

    // 오판 꼴 ③ 담당이 이 스레드에 세운 열린 카드(단계에 안 달려 있어도) — 사람 답을 기다리는 중이다. 두 시간 전 카드여도 그렇다.
    let card = one(
        &admin,
        "insert into message(channel_id, author_id, body, kind, thread_root_id, meta, created_at) \
         values ($1::uuid, $2::uuid, 'q', 'user', $3::uuid, '{\"ask\": {\"question\": \"q\"}}'::jsonb, now() - interval '2 hours') \
         returning id::text",
        &[&ch, &agent, &root],
    )
    .await;
    assert_eq!(counts(&admin, &root).await, (0, 0));
    // 남이 세운 카드·권한 카드·답한 카드는 신호가 아니다.
    run(
        &admin,
        "update message set author_id = $2::uuid where id = $1::uuid",
        &[&card, &other],
    )
    .await;
    assert_eq!(aged(&admin, &root).await, (1, 1));
    run(
        &admin,
        "update message set author_id = $2::uuid where id = $1::uuid",
        &[&card, &agent],
    )
    .await;
    assert_eq!(counts(&admin, &root).await, (0, 0));
    run(
        &admin,
        "update message set meta = meta || '{\"permissionRequest\": {}}'::jsonb where id = $1::uuid",
        &[&card],
    )
    .await;
    assert_eq!(aged(&admin, &root).await, (1, 1));
    run(
        &admin,
        "update message set meta = '{\"ask\": {\"question\": \"q\", \"answeredWith\": \"yes\"}}'::jsonb where id = $1::uuid",
        &[&card],
    )
    .await;
    assert_eq!(aged(&admin, &root).await, (1, 1));

    // 살아 있는 턴 임대 — 신호. 끝나면 다시 조용하다.
    let operator = one(
        &admin,
        "insert into operator(owner_account_id, name, token_hash) values ($1::uuid, 'ps', 'ps-token-hash') returning id::text",
        &[&human],
    )
    .await;
    let lease = one(
        &admin,
        "insert into secret_turn_lease(token_hash, agent_id, operator_id, cause_message_id, channel_id, thread_root_id, expires_at) \
         values ('ps-lease', $1::uuid, $2::uuid, $3::uuid, $4::uuid, $5::uuid, now() + interval '5 minutes') returning id::text",
        &[&agent, &operator, &call, &ch, &root],
    )
    .await;
    assert_eq!(counts(&admin, &root).await, (0, 0));
    run(
        &admin,
        "update secret_turn_lease set ended_at = now() where id = $1::uuid",
        &[&lease],
    )
    .await;
    assert_eq!(aged(&admin, &root).await, (1, 1));

    // 걸린 예약 — 신호. 취소되면 다시 조용하다. (예약 글은 두 시간 전 것이라 「최근 글」이 아니다.)
    let wake_msg = one(&admin, reply, &[&ch, &agent, &root]).await;
    run(&admin, old, &[&wake_msg]).await;
    let wake = one(
        &admin,
        "insert into agent_wake(account_id, channel_id, message_id, wake_at) \
         values ($1::uuid, $2::uuid, $3::uuid, now() + interval '10 minutes') returning id::text",
        &[&agent, &ch, &wake_msg],
    )
    .await;
    assert_eq!(counts(&admin, &root).await, (0, 0));
    run(
        &admin,
        "update agent_wake set canceled_at = now() where id = $1::uuid",
        &[&wake],
    )
    .await;
    assert_eq!(aged(&admin, &root).await, (1, 1));

    // 열린 PR 감시 — 신호. 끝나면 다시 조용하다.
    let watch = one(
        &admin,
        "insert into pr_watch(repo, number, head, until, expires_at) \
         values ('o/ps-rs', 1, repeat('a', 40), 'checks', now() + interval '1 hour') returning id::text",
        &[],
    )
    .await;
    run(
        &admin,
        "insert into pr_watch_subscriber(watch_id, account_id, channel_id, thread_root_id) \
         values ($1::uuid, $2::uuid, $3::uuid, $4::uuid)",
        &[&watch, &agent, &ch, &root],
    )
    .await;
    assert_eq!(counts(&admin, &root).await, (0, 0));
    run(
        &admin,
        "update pr_watch set state = 'done', ended_at = now() where id = $1::uuid",
        &[&watch],
    )
    .await;
    assert_eq!(aged(&admin, &root).await, (1, 1));

    // 멈춤 판정을 끄면(권한 없음과 같은 길) 그 갈래는 남지 않고 시계도 건드리지 않는다.
    let kept = clock(&admin, &root).await;
    let off = sweep(&admin, &mut Seen::new(), None).await.unwrap();
    assert!(off.iter().all(|e| {
        let branch = &e.detail.as_ref().unwrap()["branch"];
        branch != "quiet" && branch != "would_stall"
    }));
    assert_eq!(clock(&admin, &root).await, kept);

    // 읽기 답 — 켜져 있을 때만 멈춘 단계가 실린다. 아직 깨우지 않았으니 wokenAt 은 null 이다.
    let view = |on: bool| {
        let (admin, lead, root) = (admin.clone(), lead.clone(), root.clone());
        async move {
            let body = plan_view_json_with(&admin, &lead, &root, on).await.unwrap();
            serde_json::from_str::<Value>(&body).unwrap()["plan"].clone()
        }
    };
    assert!(view(false).await.get("stalled").is_none());
    let shown = view(true).await;
    assert_eq!(shown["stalled"].as_object().unwrap().len(), 1, "{shown}");
    assert!(
        shown["stalled"]["s1"]["since"]
            .as_str()
            .unwrap()
            .ends_with(".000Z")
    );
    assert!(shown["stalled"]["s1"]["wokenAt"].is_null());

    // 깨움이 켜졌다 — 관리자(에이전트) 이름의 시스템 줄 하나와 관리자 inbox 의 `wake` 한 줄. 줄은 부르지 않는다(멘션 없음).
    let waking = || {
        let mut state = StallState::new(HOUR);
        state.wake = Some(PostState {
            read: admin.clone(),
            write: admin.clone(),
            up: harkroom_server::proxy::Upstream::new("http://127.0.0.1:0"),
            implicit_ok: false,
        });
        state
    };
    let lines =
        "select count(*)::text from message where thread_root_id = $1::uuid and meta ? 'planStall'";
    let mut state = waking();
    sweep(&admin, &mut Seen::new(), Some(&mut state))
        .await
        .unwrap();
    assert_eq!(one(&admin, lines, &[&root]).await, "1");
    let line: (String, String, String, String, String) = sqlx::query_as(
        "select id::text, author_id::text, kind, body, meta::text from message \
          where thread_root_id = $1::uuid and meta ? 'planStall'",
    )
    .bind(&root)
    .fetch_one(&admin)
    .await
    .unwrap();
    assert_eq!(
        (line.1.as_str(), line.2.as_str()),
        (lead.as_str(), "system")
    );
    assert!(
        line.3.starts_with("멈춤?: ") && line.3.contains("- s1 a ＠b (담당 ps_agent · 2시간째)"),
        "{}",
        line.3
    );
    let meta: Value = serde_json::from_str(&line.4).unwrap();
    assert_eq!(meta["planStall"]["stepIds"], serde_json::json!(["s1"]));
    assert_eq!(meta["planStall"]["managerId"], lead.as_str());
    let inbox = "select string_agg(account_id::text || ' ' || reason, ',' order by reason) from inbox where message_id = $1::uuid and reason = 'wake'";
    assert_eq!(one(&admin, inbox, &[&line.0]).await, format!("{lead} wake"));
    let c = clock(&admin, &root).await;
    assert!(
        c["steps"]["s1"]["wokenAt"].is_i64() && c["lastWokenAt"].is_i64(),
        "{c}"
    );
    assert!(view(true).await["stalled"]["s1"]["wokenAt"].is_string());
    // 같은 단계는 다시 깨우지 않는다 — 창이 지나도, 새 상태로 훑어도.
    for _ in 0..2 {
        let mut state = waking();
        sweep(&admin, &mut Seen::new(), Some(&mut state))
            .await
            .unwrap();
    }
    run(
        &admin,
        "update thread_plan set stall = jsonb_set(stall, '{lastWokenAt}', to_jsonb(extract(epoch from now())::int8 - 7200)) where root_id = $1::uuid",
        &[&root],
    )
    .await;
    let mut state = waking();
    sweep(&admin, &mut Seen::new(), Some(&mut state))
        .await
        .unwrap();
    assert_eq!(one(&admin, lines, &[&root]).await, "1");

    // 관리자가 사람이면 깨우지 않는다 — 표시만 남는다. (깨운 표시를 지워 다시 깨울 수 있는 꼴로 만든 뒤 본다.)
    run(
        &admin,
        "update thread_plan set doc = jsonb_set(doc, '{managerId}', to_jsonb($2::text)), \
           stall = stall #- '{steps,s1,wokenAt}' #- '{lastWokenAt}' where root_id = $1::uuid",
        &[&root, &human],
    )
    .await;
    let mut state = waking();
    sweep(&admin, &mut Seen::new(), Some(&mut state))
        .await
        .unwrap();
    assert_eq!(one(&admin, lines, &[&root]).await, "1");
    let c = clock(&admin, &root).await;
    assert!(
        c["steps"]["s1"]["markedAt"].is_i64() && c["steps"]["s1"]["wokenAt"].is_null(),
        "{c}"
    );
    // 쉬는(disabled) 관리자 에이전트도 깨우지 않는다. 다시 살아나면 깨운다.
    run(
        &admin,
        "update thread_plan set doc = jsonb_set(doc, '{managerId}', to_jsonb($2::text)) where root_id = $1::uuid",
        &[&root, &lead],
    )
    .await;
    run(
        &admin,
        "update account set disabled_at = now() where id = $1::uuid",
        &[&lead],
    )
    .await;
    let mut state = waking();
    sweep(&admin, &mut Seen::new(), Some(&mut state))
        .await
        .unwrap();
    assert_eq!(one(&admin, lines, &[&root]).await, "1");
    run(
        &admin,
        "update account set disabled_at = null where id = $1::uuid",
        &[&lead],
    )
    .await;
    let mut state = waking();
    sweep(&admin, &mut Seen::new(), Some(&mut state))
        .await
        .unwrap();
    assert_eq!(one(&admin, lines, &[&root]).await, "2");

    // 단계가 active 를 벗어나면 시계도 지워진다.
    run(
        &admin,
        "update thread_plan set doc = jsonb_set(doc, '{steps,0,state}', '\"done\"') where root_id = $1::uuid",
        &[&root],
    )
    .await;
    assert_eq!(counts(&admin, &root).await, (0, 0));
    assert!(
        clock(&admin, &root).await["steps"]
            .as_object()
            .unwrap()
            .is_empty()
    );
    assert!(view(true).await.get("stalled").is_none());
}
