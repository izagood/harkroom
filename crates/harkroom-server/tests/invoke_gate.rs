//! 호출 게이트(`core::invoke_gate`) — **누가 누구를 부를 수 있나**를 실제 스키마에서 본다(TS 없이). `HARKROOM_TEST_DATABASE_URL` 이
//! 없으면 건너뛴다(CI 는 `db-tests` 잡이 `scripts/db-tests.sh` 로 Rust 마이그레이션을 건 새 DB 를 넘긴다).
//!
//! 옛 판정은 TS 시험 장치가 픽스처를 넣고 두 쪽 답을 맞춰 봤다. 이제 픽스처(범위 넷·꺼짐·지움·설정 없음·형제 신뢰·대리 명단·
//! 회신권 열림/만료/닫힘·팀 범위)를 여기서 SQL 로 넣고, 갈래마다 기대값을 직접 단언한다.
use harkroom_server::core::invoke_gate::{
    AgentFacts, Ctx, TeamFacts, Via, invoke_facts, is_eligible_delegate, may_invoke,
    may_invoke_team,
};
use sqlx::{PgConnection, PgPool};
use std::collections::HashMap;

async fn human(pool: &PgPool, handle: &str) -> String {
    sqlx::query_scalar(
        "insert into account(handle, display_name, kind, login_id, role, is_admin) \
         values ($1, $1, 'human', $1, 'member', false) returning id::text",
    )
    .bind(handle)
    .fetch_one(pool)
    .await
    .unwrap()
}

/// `cfg` = (범위, 소유자, 형제 신뢰). `None` 이면 agent_config 행이 없다.
async fn agent(
    pool: &PgPool,
    handle: &str,
    cfg: Option<(&str, Option<&str>, bool)>,
    disabled: bool,
    deleted: bool,
) -> String {
    let id: String = sqlx::query_scalar(
        "insert into account(handle, display_name, kind, role, is_admin, disabled_at, deleted_at) \
         values ($1, $1, 'agent', 'member', false, case when $2 then now() end, case when $3 then now() end) \
         returning id::text",
    )
    .bind(handle)
    .bind(disabled)
    .bind(deleted)
    .fetch_one(pool)
    .await
    .unwrap();
    if let Some((scope, owner, trust)) = cfg {
        sqlx::query(
            "insert into agent_config(account_id, invoke_scope, owner_account_id, trust_siblings) \
             values ($1::uuid, $2, $3::uuid, $4)",
        )
        .bind(&id)
        .bind(scope)
        .bind(owner)
        .bind(trust)
        .execute(pool)
        .await
        .unwrap();
    }
    id
}

async fn exec(pool: &PgPool, sql: &'static str, binds: &[&str]) {
    let mut q = sqlx::query(sql);
    for b in binds {
        q = q.bind(*b);
    }
    q.execute(pool).await.unwrap();
}

async fn one(pool: &PgPool, sql: &'static str, binds: &[&str]) -> String {
    let mut q = sqlx::query_scalar::<_, String>(sql);
    for b in binds {
        q = q.bind(*b);
    }
    q.fetch_one(pool).await.unwrap()
}

async fn may(
    conn: &mut PgConnection,
    f: &AgentFacts,
    caller: &str,
    channel: &str,
    via: Via,
    thread: Option<&str>,
) -> bool {
    may_invoke(
        conn,
        f,
        &Ctx {
            caller_id: caller,
            channel_id: channel,
            via,
            reply_grant_thread_id: thread,
        },
    )
    .await
    .unwrap()
}

#[tokio::test]
async fn invoke_gate_decisions() {
    let Ok(url) = std::env::var("HARKROOM_TEST_DATABASE_URL") else {
        eprintln!("skip: HARKROOM_TEST_DATABASE_URL unset");
        return;
    };
    let pool = PgPool::connect(&url).await.unwrap();

    let owner = human(&pool, "ig-owner").await;
    let other = human(&pool, "ig-other").await;
    let member = human(&pool, "ig-member").await;
    let lister = human(&pool, "ig-lister").await;
    let o = Some(owner.as_str());
    let a_com = agent(&pool, "ig-com", Some(("community", o, true)), false, false).await;
    let a_own = agent(&pool, "ig-own", Some(("owner", o, false)), false, false).await;
    let a_own_trust = agent(&pool, "ig-own-trust", Some(("owner", o, true)), false, false).await;
    let a_list = agent(&pool, "ig-list", Some(("list", o, true)), false, false).await;
    let a_chan = agent(&pool, "ig-chan", Some(("channel", o, true)), false, false).await;
    let a_off = agent(&pool, "ig-off", Some(("community", o, true)), true, false).await;
    let a_gone = agent(&pool, "ig-gone", Some(("owner", o, true)), false, true).await;
    let a_bare = agent(&pool, "ig-bare", None, false, false).await;
    let a_orphan = agent(&pool, "ig-orphan", Some(("owner", None, true)), false, false).await;
    // 대리 호출자 후보 — 같은 소유자의 owner 에이전트(명단 밖·명단 안), 같은 소유자의 community, 남의 owner, 지운 형제.
    let sib = agent(&pool, "ig-sib", Some(("owner", o, true)), false, false).await;
    let sib_listed = agent(&pool, "ig-sib-listed", Some(("owner", o, true)), false, false).await;
    let sib_com = agent(&pool, "ig-sib-com", Some(("community", o, true)), false, false).await;
    let sib_other = agent(&pool, "ig-sib-other", Some(("owner", Some(&other), true)), false, false).await;
    let sib_gone = agent(&pool, "ig-sib-gone", Some(("owner", o, true)), false, true).await;
    let replier = agent(&pool, "ig-replier", Some(("community", Some(&other), true)), false, false).await;
    let expired = agent(&pool, "ig-expired", Some(("community", Some(&other), true)), false, false).await;
    let closed = agent(&pool, "ig-closed", Some(("community", Some(&other), true)), false, false).await;
    exec(
        &pool,
        "insert into agent_owner_delegate(agent_id, delegate_id) values ($1::uuid, $2::uuid), ($3::uuid, $2::uuid)",
        &[&a_own, &sib_listed, &a_gone],
    )
    .await;
    exec(
        &pool,
        "insert into agent_invoker(agent_id, account_id) values ($1::uuid, $2::uuid)",
        &[&a_list, &lister],
    )
    .await;
    let ch = one(
        &pool,
        "insert into channel(name, kind, visibility, created_by) values ('ig-ch', 'standard', 'public', $1::uuid) returning id::text",
        &[&owner],
    )
    .await;
    exec(
        &pool,
        "insert into channel_member(channel_id, account_id) values ($1::uuid, $2::uuid)",
        &[&ch, &member],
    )
    .await;
    let dm = one(&pool, "insert into channel(kind, topic) values ('dm', '') returning id::text", &[]).await;
    exec(
        &pool,
        "insert into channel_member(channel_id, account_id) values ($1::uuid, $2::uuid), ($1::uuid, $3::uuid)",
        &[&dm, &member, &other],
    )
    .await;
    let root = "insert into message(channel_id, author_id, body, kind) values ($1::uuid, $2::uuid, 'root', 'user') returning id::text";
    let thread = one(&pool, root, &[&ch, &owner]).await;
    let other_thread = one(&pool, root, &[&ch, &owner]).await;
    // 회신권: replier←aOwn 열림, expired←aOwn 만료, closed←aOwn 닫힘. aList→replier 도 열어 둔다(같은 스레드·다른 대상).
    exec(
        &pool,
        "insert into invoke_reply_grant(grantee_id, granter_id, thread_root_id, expires_at, closed_at) values \
         ($1::uuid, $4::uuid, $5::uuid, now() + interval '1 hour', null), \
         ($2::uuid, $4::uuid, $5::uuid, now() - interval '1 second', null), \
         ($3::uuid, $4::uuid, $5::uuid, now() + interval '1 hour', now()), \
         ($1::uuid, $6::uuid, $5::uuid, now() + interval '1 hour', null)",
        &[&replier, &expired, &closed, &a_own, &thread, &a_list],
    )
    .await;
    let mut teams: HashMap<&str, TeamFacts> = HashMap::new();
    for (name, scope, tow) in [
        ("ig-t-com", "community", o),
        ("ig-t-own", "owner", o),
        ("ig-t-orphan", "owner", None),
        ("ig-t-list", "list", o),
        ("ig-t-chan", "channel", o),
    ] {
        let id: String = sqlx::query_scalar(
            "insert into agent_team(name, created_by, invoke_scope, owner_account_id) \
             values ($1, $2::uuid, $3, $4::uuid) returning id::text",
        )
        .bind(name)
        .bind(&owner)
        .bind(scope)
        .bind(tow)
        .fetch_one(&pool)
        .await
        .unwrap();
        teams.insert(
            name,
            TeamFacts {
                team_id: id,
                invoke_scope: scope.to_owned(),
                owner_account_id: tow.map(str::to_owned),
            },
        );
    }
    exec(
        &pool,
        "insert into agent_team_invoker(team_id, account_id) values ($1::uuid, $2::uuid)",
        &[&teams["ig-t-list"].team_id, &lister],
    )
    .await;

    let mut conn = pool.acquire().await.unwrap();
    let c = &mut *conn;

    // ── facts: 사람·없는 id 는 빠지고, 설정 없는 에이전트는 community, 꺼짐·지움은 off.
    let agents = [
        &a_com, &a_own, &a_own_trust, &a_list, &a_chan, &a_off, &a_gone, &a_bare, &a_orphan,
    ];
    let mut ids: Vec<String> = agents.iter().map(|s| s.to_string()).collect();
    ids.push(owner.clone());
    ids.push("00000000-0000-4000-8000-000000000000".into());
    let facts = invoke_facts(c, &ids).await.unwrap();
    let mut got: Vec<&String> = facts.keys().collect();
    got.sort();
    let mut want: Vec<&String> = agents.to_vec();
    want.sort();
    assert_eq!(got, want, "사람·없는 id 는 facts 에서 빠진다");
    assert_eq!(facts[&a_bare].invoke_scope, "community", "설정 없는 에이전트는 community");
    assert!(!facts[&a_bare].off);
    assert!(facts[&a_off].off && facts[&a_gone].off, "꺼짐·지움은 off");
    assert!(!facts[&a_own].off);
    assert_eq!(facts[&a_orphan].owner_account_id, None);
    let f = |id: &String| facts[id].clone();

    use Via::*;
    // ── community: 부름 길과 상관없이 통과, 꺼지면 거절.
    assert!(may(c, &f(&a_com), &other, "", AutoMention, None).await);
    assert!(may(c, &f(&a_com), &other, &ch, Group, None).await);
    assert!(may(c, &f(&a_bare), &other, &ch, ChannelAll, None).await, "설정 없음 = community");
    assert!(!may(c, &f(&a_off), &owner, &ch, Mention, None).await, "꺼진 에이전트는 소유자도 못 부른다");
    assert!(!may(c, &f(&a_gone), &owner, &ch, Mention, None).await, "지운 에이전트는 소유자도 못 부른다");

    // ── owner 범위: 소유자의 mention·team 만, 다른 부름 길·남은 거절, 소유자 없는 에이전트는 아무도.
    assert!(may(c, &f(&a_own), &owner, "", Mention, None).await);
    assert!(may(c, &f(&a_own), &owner, &ch, Team, None).await);
    assert!(!may(c, &f(&a_own), &other, &ch, Mention, None).await);
    for via in [Group, ChannelAll, AutoMention] {
        assert!(!may(c, &f(&a_own), &owner, &ch, via, None).await, "owner 범위는 {via:?} 로 못 부른다");
    }
    assert!(!may(c, &f(&a_orphan), &owner, &ch, Mention, None).await, "소유자 없는 owner 범위");
    assert!(!may(c, &f(&a_orphan), &other, &ch, Mention, None).await);

    // ── 대리 호출자(형제 신뢰 083·대리 명단 073).
    assert!(!may(c, &f(&a_own), &sib, &ch, Mention, None).await, "신뢰 끔 + 명단 밖 형제는 거절");
    assert!(may(c, &f(&a_own), &sib_listed, &ch, Mention, None).await, "명단 안 형제는 통과");
    assert!(may(c, &f(&a_own_trust), &sib, &ch, Team, None).await, "형제 신뢰면 통과");
    assert!(!may(c, &f(&a_own_trust), &sib_com, &ch, Mention, None).await, "community 형제는 대리가 아니다");
    assert!(!may(c, &f(&a_own_trust), &sib_other, &ch, Mention, None).await, "남의 owner 에이전트");
    assert!(!may(c, &f(&a_own_trust), &sib_gone, &ch, Mention, None).await, "지운 형제");
    assert!(!may(c, &f(&a_own_trust), &sib, &ch, Group, None).await, "대리도 group 으로는 못 부른다");

    // ── list 범위.
    assert!(may(c, &f(&a_list), &lister, &ch, Mention, None).await);
    assert!(!may(c, &f(&a_list), &other, &ch, Team, None).await);
    assert!(!may(c, &f(&a_list), &lister, &ch, Group, None).await);

    // ── channel 범위: 멤버인 일반 채널만, DM·채널 없음·비멤버는 거절.
    assert!(may(c, &f(&a_chan), &member, &ch, Mention, None).await);
    assert!(!may(c, &f(&a_chan), &member, &dm, Mention, None).await, "DM 은 channel 범위가 아니다");
    assert!(!may(c, &f(&a_chan), &other, &ch, Mention, None).await);
    assert!(!may(c, &f(&a_chan), &member, "", Mention, None).await);

    // ── 회신권(084): mention + 그 스레드 + 열린 권리만.
    let t = Some(thread.as_str());
    assert!(may(c, &f(&a_own), &replier, &ch, Mention, t).await, "열린 회신권");
    assert!(!may(c, &f(&a_own), &replier, &ch, Team, t).await, "회신권은 mention 만");
    assert!(!may(c, &f(&a_own), &replier, &ch, Mention, Some(&other_thread)).await, "다른 스레드");
    assert!(!may(c, &f(&a_own), &replier, &ch, Mention, None).await, "스레드 없음");
    assert!(!may(c, &f(&a_own), &expired, &ch, Mention, t).await, "만료된 회신권");
    assert!(!may(c, &f(&a_own), &closed, &ch, Mention, t).await, "닫힌 회신권");
    assert!(!may(c, &f(&a_own_trust), &replier, &ch, Mention, t).await, "다른 대상의 회신권은 안 쓴다");
    assert!(!may(c, &f(&a_off), &replier, &ch, Mention, t).await);

    // ── is_eligible_delegate(listed=true 는 신뢰·명단, false 는 같은 소유자의 살아 있는 owner 에이전트면 됨).
    let del = |a: &String| (a.clone(), facts[a].owner_account_id.clone());
    for (agent_id, own, cand, listed, want) in [
        (del(&a_own), &sib, true, false),
        (del(&a_own), &sib, false, true),
        (del(&a_own), &sib_listed, true, true),
        (del(&a_own_trust), &sib, true, true),
        (del(&a_own_trust), &sib_com, false, false),
        (del(&a_own_trust), &sib_other, false, false),
        (del(&a_own_trust), &sib_gone, false, false),
        (del(&a_own_trust), &owner, false, false),
        (del(&a_own_trust), &a_own_trust, false, false),
        (del(&a_orphan), &sib, false, false),
    ]
    .into_iter()
    .map(|((a, o), cand, listed, want)| (a, o, cand, listed, want))
    {
        let got = is_eligible_delegate(c, &agent_id, own.as_deref(), cand, listed).await.unwrap();
        assert_eq!(got, want, "delegate agent={agent_id} cand={cand} listed={listed}");
    }

    // ── 팀 범위(068).
    let tm = |n: &str| teams[n].clone();
    for (team, caller, channel, want) in [
        ("ig-t-com", &other, "", true),
        ("ig-t-own", &owner, "", true),
        ("ig-t-own", &other, ch.as_str(), false),
        ("ig-t-orphan", &owner, ch.as_str(), false),
        ("ig-t-list", &lister, ch.as_str(), true),
        ("ig-t-list", &other, ch.as_str(), false),
        ("ig-t-chan", &member, ch.as_str(), true),
        ("ig-t-chan", &member, dm.as_str(), false),
        ("ig-t-chan", &member, "", false),
        ("ig-t-chan", &other, ch.as_str(), false),
    ] {
        let got = may_invoke_team(c, &tm(team), caller, channel).await.unwrap();
        assert_eq!(got, want, "team={team} caller={caller} channel={channel}");
    }
}
