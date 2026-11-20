//! 살아 있는 러너 세션의 DB 사본·에이전트 presence(S5.3 C6c-3, TS `services/sessionLive.ts`·`mcp/presence.ts` 의 쓰기 쪽).
//!
//! 릴레이 허브(메모리)가 여전히 정본이다. 이 파일은 릴레이 링크([`super::relay_link::LinkHooks`])에 붙어
//! - `agent_session_live`(마이그레이션 172)에 세션을 남기고 `relay_hub.seen_at` 을 박동으로 갱신한다(impl `'rust'`),
//! - 러너 프레임이 올 때마다 `agent_presence`(마이그레이션 171)를 10초에 한 번 묶어 쓴다(턴 중에는 프레임이 유일한 생존 신호다).
//!
//! 규율(security C6c):
//! - ① 허용 목록 칸만 싣는다([`live_row`]). 계정·풀 이름·프레임 원문·키·바이트 수는 받지도 넘기지도 않는다.
//! - ①′ 주인 agent 는 배정을 확인한 링크의 것이다. 남의 에이전트가 같은 세션 id 를 보내도 주인이 바뀌지 않는다.
//! - ①″ 쓸기는 seen_at 이 TTL 을 넘긴 **다른** 허브 줄만 지운다(행은 cascade).
//! - r1 박동은 `insert … on conflict do update` 다. 줄이 새로 들어갔으면(쓸려 나갔었다) 이 허브의 세션을 다시 쓴다.
//! - r1a 다시 쓸 때는 `on conflict do nothing` — 멈춘 사이 다른 허브로 옮겨 간 행의 `hub_epoch`·`operator_id` 를 덮지 않는다.
//! - r1b 쓰기가 실패한 세션은 표시해 두고 다음 박동에 다시 쓴다(되살리기 중의 실패도 같다).
//! - r2 `channel_id`·`thread_root_id` 는 러너가 보낸 값이다 — **그 에이전트가 그 채널의 멤버이고 스레드 뿌리가 그 채널의 글일 때만**
//!   쓴다(같은 INSERT 안의 `exists`). 아니면 행이 없다(없는 것을 있다고 하지 않는다).
//!
//! 쓰기는 일꾼 하나가 들어온 순서대로 한다(started 뒤의 ended 가 먼저 닿으면 유령 행이 남는다). 실패는 기록만 하고 릴레이를 막지 않는다.
//! 로그에는 세션 id·에이전트 id 도 남기지 않는다 — 무엇을 하다 실패했는지(`what`)와 오류만.
use super::relay_link::{FrameHook, GoneHook, LinkHooks};
use serde_json::{Map, Value};
use sqlx::PgPool;
use std::collections::HashMap;
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};
use tokio::sync::{mpsc, oneshot};

/// 허브 박동 주기와 생존 TTL(TS `RELAY_HUB_BEAT_MS`·`RELAY_HUB_TTL_SEC`). TTL 은 박동 셋을 놓쳐야 넘는다.
pub const RELAY_HUB_BEAT: Duration = Duration::from_secs(30);
pub const RELAY_HUB_TTL_SEC: i64 = 90;
/// presence TTL(TS `createAgentPresence({ ttlMs: 30_000 })`)과 DB 쓰기 간격(TS `PERSIST_EVERY_MS`).
pub const PRESENCE_TTL: Duration = Duration::from_secs(30);
pub const PRESENCE_PERSIST_EVERY: Duration = Duration::from_secs(10);
/// shared `MAX_AGENT_POOLS`·`MAX_ACCOUNT_RANK`.
const MAX_AGENT_POOLS: i64 = 16;
const MAX_ACCOUNT_RANK: i64 = 99;

/// 허용 목록 칸(TS `LiveRow`).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct LiveRow {
    pub session_id: String,
    pub channel_id: String,
    pub thread_root_id: Option<String>,
    pub harness: String,
    pub mode: Option<&'static str>,
    pub started_at: Option<String>,
    pub pool_rank: Option<i32>,
    pub account_rank: Option<i32>,
}

fn is_uuid(s: &str) -> bool {
    super::channels::is_uuid(s)
}

fn rank(v: Option<&Value>, max: i64) -> Option<i32> {
    // TS `Number.isInteger(v) && 1 <= v <= max` — 2.0 같은 정수 꼴 실수도 받는다.
    let f = v?.as_f64()?;
    (f.fract() == 0.0 && f >= 1.0 && f <= max as f64).then_some(f as i32)
}

/// ISO 8601(날짜 + 시각 + 시간대) 꼴만 받는다. TS `Date.parse` 는 더 너그럽지만 러너는 `toISOString()` 을 보낸다 —
/// 그 밖의 꼴은 null(없는 것을 있다고 하지 않는다). Postgres `timestamptz` 가 틀린 날짜(2월 30일)를 거절하지 않도록 범위도 본다.
fn iso_instant(s: &str) -> Option<String> {
    let b = s.as_bytes();
    if b.len() < 20 || b.len() > 35 {
        return None;
    }
    let digits = |r: std::ops::Range<usize>| b[r].iter().all(u8::is_ascii_digit);
    let num = |r: std::ops::Range<usize>| s[r].parse::<u32>().ok();
    if !(digits(0..4)
        && b[4] == b'-'
        && digits(5..7)
        && b[7] == b'-'
        && digits(8..10)
        && b[10] == b'T'
        && digits(11..13)
        && b[13] == b':'
        && digits(14..16)
        && b[16] == b':'
        && digits(17..19))
    {
        return None;
    }
    let (y, mo, d) = (num(0..4)?, num(5..7)?, num(8..10)?);
    let (h, mi, se) = (num(11..13)?, num(14..16)?, num(17..19)?);
    let leap = (y % 4 == 0 && y % 100 != 0) || y % 400 == 0;
    let dim = match mo {
        1 | 3 | 5 | 7 | 8 | 10 | 12 => 31,
        4 | 6 | 9 | 11 => 30,
        2 if leap => 29,
        2 => 28,
        _ => return None,
    };
    if y == 0 || d == 0 || d > dim || h > 23 || mi > 59 || se > 59 {
        return None;
    }
    let mut i = 19;
    if b.get(i) == Some(&b'.') {
        i += 1;
        let start = i;
        while b.get(i).is_some_and(u8::is_ascii_digit) {
            i += 1;
        }
        if i == start || i - start > 9 {
            return None;
        }
    }
    let tz = &s[i..];
    let ok = tz == "Z"
        || (tz.len() == 6
            && matches!(tz.as_bytes()[0], b'+' | b'-')
            && tz.as_bytes()[3] == b':'
            && tz[1..3].parse::<u32>().is_ok_and(|v| v <= 23)
            && tz[4..6].parse::<u32>().is_ok_and(|v| v <= 59));
    ok.then(|| s.to_owned())
}

/// 허용 목록 칸만 꺼낸다(TS `liveRow`). 틀린 모양이면 None(쓰지 않는다).
pub fn live_row(session: &Value) -> Option<LiveRow> {
    let s = session.as_object()?;
    let session_id = s.get("sessionId")?.as_str()?;
    if session_id.is_empty() || session_id.chars().count() > 128 {
        return None;
    }
    let channel_id = s.get("channelId")?.as_str().filter(|c| is_uuid(c))?;
    let thread_root_id = s
        .get("threadRootId")
        .and_then(Value::as_str)
        .filter(|t| is_uuid(t))
        .map(str::to_owned);
    let harness = s.get("harness")?.as_str()?;
    if harness.is_empty() || harness.chars().count() > 32 {
        return None;
    }
    let mode = match s.get("mode").and_then(Value::as_str) {
        Some("mention") => Some("mention"),
        Some("interactive") => Some("interactive"),
        _ => None,
    };
    Some(LiveRow {
        session_id: session_id.to_owned(),
        channel_id: channel_id.to_owned(),
        thread_root_id,
        harness: harness.to_owned(),
        mode,
        started_at: s
            .get("startedAt")
            .and_then(Value::as_str)
            .and_then(iso_instant),
        pool_rank: rank(s.get("claudePoolRank"), MAX_AGENT_POOLS),
        account_rank: rank(s.get("claudeAccountRank"), MAX_ACCOUNT_RANK),
    })
}

/// 이 허브가 쓴 행의 메모리 사본(허용 목록 칸만).
#[derive(Debug, Clone)]
struct Mine {
    operator_id: String,
    agent: String,
    row: LiveRow,
}

enum Op {
    Started(String, String, LiveRow),
    Ended(String, String),
    Replaced(String, String, Vec<LiveRow>),
    RunnerGone(String, String),
    Beat(Option<oneshot::Sender<Result<bool, String>>>),
    Flush(oneshot::Sender<()>),
    Stop(oneshot::Sender<()>),
}

/// 에이전트 presence 가 바뀌었을 때(`presence.changed` 자리) — `(agent, online)`.
pub type OnlineHook = Arc<dyn Fn(&str, bool) + Send + Sync>;
pub type ErrorHook = Arc<dyn Fn(&str, &sqlx::Error) + Send + Sync>;

/// 살아 있는 세션 사본(TS `SessionLiveStore`). 복제해 나눠 쓴다 — 일꾼은 하나다.
#[derive(Clone)]
pub struct SessionLive {
    epoch: Arc<str>,
    tx: mpsc::UnboundedSender<Op>,
}

/// 다시 쓸 때 어느 꼴로 쓰는가.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum Write {
    /// 보통 쓰기 — 같은 주인이면 고친다.
    Upsert,
    /// r1a 되살리기 — 빈 자리만 채운다.
    FillOnly,
}

struct Worker {
    pool: PgPool,
    epoch: Arc<str>,
    ttl_sec: i64,
    mine: HashMap<String, Mine>,
    /// r1b — 쓰기가 실패해 다음 박동에 다시 쓸 세션(그때 쓸 꼴).
    retry: HashMap<String, Write>,
    on_error: ErrorHook,
    /// R1 — 세션 행이 생기거나 사라지면 그 스레드에 신호를 낸다([`super::thread_turns::signal`]).
    signal: bool,
}

/// 쓰기 한 번의 결과.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum Wrote {
    /// 행이 새로 들어갔다.
    New,
    /// 행이 이미 있었다(고쳤거나, 되살리기에서 자리가 차 있었다).
    Had,
    /// 멤버가 아니거나 남의 주인이라 안 쓰였다.
    No,
}

macro_rules! write_sql_head {
    () => {
        "insert into agent_session_live
   (session_id, agent_account_id, operator_id, channel_id, thread_root_id, harness, mode, started_at,
    status, claude_pool_rank, claude_account_rank, hub_epoch, updated_at)
 select $1, $2::uuid, $3::uuid, $4::uuid, $5::uuid, $6, $7, $8::timestamptz, 'running', $9, $10, $11::uuid, now()
  where exists (select 1 from channel_member m where m.channel_id = $4::uuid and m.account_id = $2::uuid)
    and ($5::uuid is null or exists (select 1 from message t where t.id = $5::uuid and t.channel_id = $4::uuid))"
    };
}
const WRITE_UPSERT_SQL: &str = concat!(
    write_sql_head!(),
    " on conflict (session_id) do update set
       operator_id = excluded.operator_id, channel_id = excluded.channel_id,
       thread_root_id = excluded.thread_root_id, harness = excluded.harness, mode = excluded.mode,
       started_at = excluded.started_at, status = excluded.status,
       claude_pool_rank = excluded.claude_pool_rank, claude_account_rank = excluded.claude_account_rank,
       hub_epoch = excluded.hub_epoch, updated_at = now()
     where agent_session_live.agent_account_id = excluded.agent_account_id
     returning (xmax = 0)"
);
const WRITE_FILL_SQL: &str = concat!(
    write_sql_head!(),
    " on conflict (session_id) do nothing returning true"
);

impl Worker {
    /// 한 행을 쓴다([`Wrote`]).
    async fn write(&self, m: &Mine, how: Write) -> Result<Wrote, sqlx::Error> {
        let sql = match how {
            Write::Upsert => WRITE_UPSERT_SQL,
            Write::FillOnly => WRITE_FILL_SQL,
        };
        let r = &m.row;
        let new: Option<bool> = sqlx::query_scalar(sql)
            .bind(&r.session_id)
            .bind(&m.agent)
            .bind(&m.operator_id)
            .bind(&r.channel_id)
            .bind(&r.thread_root_id)
            .bind(&r.harness)
            .bind(r.mode)
            .bind(&r.started_at)
            .bind(r.pool_rank)
            .bind(r.account_rank)
            .bind(&*self.epoch)
            .fetch_optional(&self.pool)
            .await?;
        match (new, how) {
            (Some(true), _) => return Ok(Wrote::New),
            (Some(false), _) => return Ok(Wrote::Had),
            (None, Write::Upsert) => return Ok(Wrote::No),
            (None, Write::FillOnly) => {}
        }
        // do nothing 은 자리가 차 있어도 행을 돌려주지 않는다 — 다른 허브가 이미 든 행이면 「있다」로 친다(사본에서는 지우지 않는다).
        let had = sqlx::query_scalar::<_, bool>(
            "select exists (select 1 from agent_session_live where session_id = $1)",
        )
        .bind(&r.session_id)
        .fetch_one(&self.pool)
        .await?;
        Ok(if had { Wrote::Had } else { Wrote::No })
    }

    /// R1 — 행이 생기거나 사라진 자리에 신호를 낸다. 뿌리가 없는 세션은 건너뛴다. 실패는 기록만 한다(사본 쓰기는 이미 끝났다).
    async fn tell(&self, spots: Vec<(String, Option<String>)>) {
        if !self.signal {
            return;
        }
        let spots = super::thread_turns::distinct(
            spots
                .into_iter()
                .filter_map(|(c, r)| Some((c, r?)))
                .collect(),
        );
        if let Err(e) = super::thread_turns::signal(&self.pool, &spots).await {
            (self.on_error)("turn_signal", &e);
        }
    }

    async fn put(&mut self, m: Mine, how: Write) {
        let sid = m.row.session_id.clone();
        match self.write(&m, how).await {
            Ok(Wrote::New) => {
                self.retry.remove(&sid);
                self.tell(vec![(
                    m.row.channel_id.clone(),
                    m.row.thread_root_id.clone(),
                )])
                .await;
            }
            Ok(Wrote::Had) => {
                self.retry.remove(&sid);
            }
            Ok(Wrote::No) => {
                // r2 멤버가 아니거나 남의 주인이다 — 이 허브가 든 세션이 아니다.
                self.retry.remove(&sid);
                if self.mine.get(&sid).is_some_and(|x| x.agent == m.agent) {
                    self.mine.remove(&sid);
                }
            }
            Err(e) => {
                self.retry.insert(sid, how);
                (self.on_error)("session_write", &e);
            }
        }
    }

    async fn upsert(&mut self, operator_id: String, agent: String, row: LiveRow) {
        // 남의 에이전트가 같은 세션 id 를 보내면 DB 처럼 사본의 주인도 바꾸지 않는다.
        if self
            .mine
            .get(&row.session_id)
            .is_some_and(|had| had.agent != agent)
        {
            return;
        }
        if !is_uuid(&operator_id) || !is_uuid(&agent) {
            return;
        }
        let m = Mine {
            operator_id,
            agent,
            row,
        };
        self.mine.insert(m.row.session_id.clone(), m.clone());
        self.put(m, Write::Upsert).await;
    }

    async fn ended(&mut self, agent: String, sid: String) {
        if self.mine.get(&sid).is_some_and(|m| m.agent == agent) {
            self.mine.remove(&sid);
            self.retry.remove(&sid);
        }
        if !is_uuid(&agent) {
            return;
        }
        match sqlx::query_as::<_, (String, Option<String>)>(
            "delete from agent_session_live where session_id = $1 and agent_account_id = $2::uuid
              returning channel_id::text, thread_root_id::text",
        )
        .bind(&sid)
        .bind(&agent)
        .fetch_all(&self.pool)
        .await
        {
            Ok(gone) => self.tell(gone).await,
            Err(e) => (self.on_error)("session_end", &e),
        }
    }

    async fn replaced(&mut self, operator_id: String, agent: String, rows: Vec<LiveRow>) {
        let keep: Vec<String> = rows.iter().map(|r| r.session_id.clone()).collect();
        let drop: Vec<String> = self
            .mine
            .iter()
            .filter(|(id, m)| m.agent == agent && !keep.contains(id))
            .map(|(id, _)| id.clone())
            .collect();
        for id in drop {
            self.mine.remove(&id);
            self.retry.remove(&id);
        }
        if !is_uuid(&agent) {
            return;
        }
        // announce 는 러너가 진실의 원천이다(같은 에이전트의 러너는 하나 — 4409). 허브를 가리지 않고 목록 밖을 지운다.
        match sqlx::query_as::<_, (String, Option<String>)>(
            "delete from agent_session_live where agent_account_id = $1::uuid and not (session_id = any($2::text[]))
              returning channel_id::text, thread_root_id::text",
        )
        .bind(&agent)
        .bind(&keep)
        .fetch_all(&self.pool)
        .await
        {
            Ok(gone) => self.tell(gone).await,
            Err(e) => (self.on_error)("session_replace", &e),
        }
        for r in rows {
            self.upsert(operator_id.clone(), agent.clone(), r).await;
        }
    }

    async fn runner_gone(&mut self, operator_id: String, agent: String) {
        let drop: Vec<String> = self
            .mine
            .iter()
            .filter(|(_, m)| m.agent == agent && m.operator_id == operator_id)
            .map(|(id, _)| id.clone())
            .collect();
        for id in drop {
            self.mine.remove(&id);
            self.retry.remove(&id);
        }
        if !is_uuid(&agent) || !is_uuid(&operator_id) {
            return;
        }
        match sqlx::query_as::<_, (String, Option<String>)>(
            "delete from agent_session_live
              where agent_account_id = $1::uuid and operator_id = $2::uuid and hub_epoch = $3::uuid
              returning channel_id::text, thread_root_id::text",
        )
        .bind(&agent)
        .bind(&operator_id)
        .bind(&*self.epoch)
        .fetch_all(&self.pool)
        .await
        {
            Ok(gone) => self.tell(gone).await,
            Err(e) => (self.on_error)("session_gone", &e),
        }
    }

    async fn sweep_dead(&self) -> Result<u64, sqlx::Error> {
        // R1 — 죽은 허브의 행은 cascade 로 사라져 돌려받지 못한다. 지우기 전에 그 자리를 읽어 둔다(신호를 켰을 때만).
        let gone: Vec<(String, Option<String>)> = if self.signal {
            sqlx::query_as(
                "select distinct l.channel_id::text, l.thread_root_id::text from agent_session_live l
                   join relay_hub h on h.hub_epoch = l.hub_epoch
                  where h.hub_epoch <> $1::uuid and h.seen_at < now() - make_interval(secs => $2)",
            )
            .bind(&*self.epoch)
            .bind(self.ttl_sec as f64)
            .fetch_all(&self.pool)
            .await?
        } else {
            Vec::new()
        };
        let n = sqlx::query(
            "delete from relay_hub where hub_epoch <> $1::uuid and seen_at < now() - make_interval(secs => $2)",
        )
        .bind(&*self.epoch)
        .bind(self.ttl_sec as f64)
        .execute(&self.pool)
        .await?
        .rows_affected();
        if n > 0 {
            self.tell(gone).await;
        }
        Ok(n)
    }

    /// 박동 한 번(TS `beatOnce`). 줄이 쓸려 나갔다 다시 넣었으면 true.
    async fn beat(&mut self) -> Result<bool, sqlx::Error> {
        let revived: bool = sqlx::query_scalar(
            "insert into relay_hub (hub_epoch, impl) values ($1::uuid, 'rust')
               on conflict (hub_epoch) do update set seen_at = now()
             returning (xmax = 0)",
        )
        .bind(&*self.epoch)
        .fetch_one(&self.pool)
        .await?;
        if revived {
            // 행도 cascade 로 사라졌다 — 이 허브가 든 세션을 다시 쓰되 빈 자리만 채운다(r1a).
            for id in self.mine.keys() {
                self.retry.insert(id.clone(), Write::FillOnly);
            }
        }
        // r1b — 실패 표시가 남은 세션을 다시 쓴다. 되살리기 중의 실패도 여기서 다음 박동으로 넘어간다.
        let pending: Vec<(String, Write)> =
            self.retry.iter().map(|(k, v)| (k.clone(), *v)).collect();
        for (id, how) in pending {
            match self.mine.get(&id).cloned() {
                Some(m) => self.put(m, how).await,
                None => {
                    self.retry.remove(&id);
                }
            }
        }
        if let Err(e) = self.sweep_dead().await {
            (self.on_error)("hub_sweep", &e);
        }
        Ok(revived)
    }
}

/// 시작 손잡이(시험이 박동·TTL·epoch 를 준다).
#[derive(Clone)]
pub struct LiveOpts {
    pub beat: Duration,
    pub ttl_sec: i64,
    /// 없으면 DB 가 만든다(`gen_random_uuid()`).
    pub epoch: Option<String>,
    pub on_error: ErrorHook,
    /// R1 — 세션 행이 생기거나 사라질 때 `thread.turns.changed` 신호를 낸다. 기본은 끔(쓰는 풀에 권한이 있을 때만 `main.rs` 가 켠다).
    pub signal: bool,
}

impl Default for LiveOpts {
    fn default() -> Self {
        Self {
            beat: RELAY_HUB_BEAT,
            ttl_sec: RELAY_HUB_TTL_SEC,
            epoch: None,
            on_error: Arc::new(|what, e| eprintln!("relay live: {what} failed: {e}")),
            signal: false,
        }
    }
}

impl SessionLive {
    /// 허브 줄을 넣고 죽은 허브를 쓸고 박동을 시작한다(TS `start`). 허브 줄을 못 넣으면 Err — 사본 없이 릴레이만 돈다(호출처가 정한다).
    pub async fn start(pool: PgPool, opts: LiveOpts) -> Result<Self, sqlx::Error> {
        let epoch: String = match &opts.epoch {
            Some(e) => {
                sqlx::query("insert into relay_hub (hub_epoch, impl) values ($1::uuid, 'rust') on conflict (hub_epoch) do nothing")
                    .bind(e)
                    .execute(&pool)
                    .await?;
                e.clone()
            }
            None => {
                sqlx::query_scalar(
                    "insert into relay_hub (hub_epoch, impl) values (gen_random_uuid(), 'rust') returning hub_epoch::text",
                )
                .fetch_one(&pool)
                .await?
            }
        };
        let epoch: Arc<str> = epoch.into();
        let mut w = Worker {
            pool,
            epoch: epoch.clone(),
            ttl_sec: opts.ttl_sec,
            mine: HashMap::new(),
            retry: HashMap::new(),
            on_error: opts.on_error.clone(),
            signal: opts.signal,
        };
        if let Err(e) = w.sweep_dead().await {
            (w.on_error)("hub_sweep", &e);
        }
        let (tx, mut rx) = mpsc::unbounded_channel::<Op>();
        tokio::spawn(async move {
            while let Some(op) = rx.recv().await {
                match op {
                    Op::Started(o, a, r) => w.upsert(o, a, r).await,
                    Op::Ended(a, s) => w.ended(a, s).await,
                    Op::Replaced(o, a, rows) => w.replaced(o, a, rows).await,
                    Op::RunnerGone(o, a) => w.runner_gone(o, a).await,
                    Op::Beat(reply) => {
                        let r = w.beat().await;
                        if let Err(e) = &r {
                            (w.on_error)("hub_beat", e);
                        }
                        if let Some(reply) = reply {
                            let _ = reply.send(r.map_err(|e| e.to_string()));
                        }
                    }
                    Op::Flush(reply) => {
                        let _ = reply.send(());
                    }
                    Op::Stop(reply) => {
                        w.mine.clear();
                        w.retry.clear();
                        if let Err(e) =
                            sqlx::query("delete from relay_hub where hub_epoch = $1::uuid")
                                .bind(&*w.epoch)
                                .execute(&w.pool)
                                .await
                        {
                            (w.on_error)("hub_stop", &e);
                        }
                        let _ = reply.send(());
                        return;
                    }
                }
            }
        });
        let ticker = tx.clone();
        let every = opts.beat;
        tokio::spawn(async move {
            let mut tick = tokio::time::interval(every);
            tick.tick().await;
            loop {
                tick.tick().await;
                if ticker.send(Op::Beat(None)).is_err() {
                    return;
                }
            }
        });
        Ok(Self { epoch, tx })
    }

    pub fn epoch(&self) -> &str {
        &self.epoch
    }

    pub fn started(&self, operator_id: &str, agent: &str, session: &Value) {
        if let Some(r) = live_row(session) {
            let _ = self
                .tx
                .send(Op::Started(operator_id.to_owned(), agent.to_owned(), r));
        }
    }

    pub fn ended(&self, agent: &str, session_id: &str) {
        let _ = self
            .tx
            .send(Op::Ended(agent.to_owned(), session_id.to_owned()));
    }

    /// announce — 그 에이전트의 목록을 통째로 바꾼다. 틀린 모양의 세션은 목록에서 빠진다(TS 와 같음).
    pub fn replaced(&self, operator_id: &str, agent: &str, sessions: &[Value]) {
        let rows = sessions.iter().filter_map(live_row).collect();
        let _ = self
            .tx
            .send(Op::Replaced(operator_id.to_owned(), agent.to_owned(), rows));
    }

    pub fn runner_gone(&self, operator_id: &str, agent: &str) {
        let _ = self
            .tx
            .send(Op::RunnerGone(operator_id.to_owned(), agent.to_owned()));
    }

    /// 쌓인 쓰기가 끝날 때까지(시험·종료용).
    pub async fn flush(&self) {
        let (tx, rx) = oneshot::channel();
        if self.tx.send(Op::Flush(tx)).is_ok() {
            let _ = rx.await;
        }
    }

    /// 박동 한 번(시험용). 줄이 쓸려 나갔다 다시 넣었으면 Ok(true).
    pub async fn beat_once(&self) -> Result<bool, String> {
        let (tx, rx) = oneshot::channel();
        self.tx
            .send(Op::Beat(Some(tx)))
            .map_err(|_| "stopped".to_owned())?;
        rx.await.map_err(|_| "stopped".to_owned())?
    }

    /// 박동을 멈추고 자기 허브 줄을 지운다(행은 cascade).
    pub async fn stop(&self) {
        let (tx, rx) = oneshot::channel();
        if self.tx.send(Op::Stop(tx)).is_ok() {
            let _ = rx.await;
        }
    }
}

/// 에이전트 presence 쓰기(TS `persistAgentPresence` + `mark` 의 묶음). 판정·만료는 DB 시계 하나다(`expires_at > now()`).
pub struct PresenceMark {
    pool: PgPool,
    ttl: Duration,
    every: Duration,
    last: Mutex<HashMap<String, Instant>>,
    /// 이 프로세스가 online 으로 본 에이전트 — 스윕이 만료를 찾을 대상(TS `byAgent` 의 키).
    watched: Mutex<std::collections::HashSet<String>>,
    /// 만료돼 있던(또는 처음 보는) 에이전트가 다시 살아났을 때 `(agent, true)`, 스윕이 만료를 찾았을 때 `(agent, false)`.
    on_online: Option<OnlineHook>,
    on_error: ErrorHook,
}

impl PresenceMark {
    pub fn new(pool: PgPool, on_online: Option<OnlineHook>, on_error: ErrorHook) -> Arc<Self> {
        Self::with_timing(
            pool,
            PRESENCE_TTL,
            PRESENCE_PERSIST_EVERY,
            on_online,
            on_error,
        )
    }

    pub fn with_timing(
        pool: PgPool,
        ttl: Duration,
        every: Duration,
        on_online: Option<OnlineHook>,
        on_error: ErrorHook,
    ) -> Arc<Self> {
        Arc::new(Self {
            pool,
            ttl,
            every,
            last: Mutex::new(HashMap::new()),
            watched: Mutex::new(Default::default()),
            on_online,
            on_error,
        })
    }

    /// 이번 mark 를 DB 에 쓸 차례인가(같은 에이전트는 `every` 에 한 번).
    fn due(&self, agent: &str) -> bool {
        let now = Instant::now();
        let mut last = self.last.lock().unwrap_or_else(|e| e.into_inner());
        if last
            .get(agent)
            .is_some_and(|t| now.duration_since(*t) < self.every)
        {
            return false;
        }
        last.insert(agent.to_owned(), now);
        true
    }

    /// 프레임이 왔다 = 이 에이전트가 살아 있다. 기다리지 않는다(쓰기는 띄운다).
    pub fn mark(self: &Arc<Self>, agent: &str) {
        if !is_uuid(agent) || !self.due(agent) {
            return;
        }
        let me = self.clone();
        let agent = agent.to_owned();
        tokio::spawn(async move {
            match me.write(&agent).await {
                Ok(true) => {
                    if let Some(h) = &me.on_online {
                        h(&agent, true);
                    }
                }
                Ok(false) => {}
                Err(e) => {
                    // 다음 프레임에 다시 쓰도록 표시를 지운다(TS 와 같음).
                    me.last
                        .lock()
                        .unwrap_or_else(|e| e.into_inner())
                        .remove(&agent);
                    (me.on_error)("presence_write", &e);
                }
            }
        });
    }

    /// 한 줄 쓴다. 만료돼 있었거나 줄이 없었으면 true(다시 온라인이 됐다).
    pub async fn write(&self, agent: &str) -> Result<bool, sqlx::Error> {
        self.watched
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .insert(agent.to_owned());
        sqlx::query_scalar(
            "with prev as (select expires_at from agent_presence where account_id = $1::uuid)
             insert into agent_presence (account_id, expires_at, updated_at)
             values ($1::uuid, now() + make_interval(secs => $2), now())
             on conflict (account_id) do update set expires_at = excluded.expires_at, updated_at = now()
             returning coalesce((select expires_at <= now() from prev), true)",
        )
        .bind(agent)
        .bind(self.ttl.as_secs_f64())
        .fetch_one(&self.pool)
        .await
    }

    /// 스윕 한 번(TS `sweep`): 이 프로세스가 본 에이전트 중 DB 에서 만료된 것을 찾아 `(agent, false)` 를 낸다.
    /// 판정은 DB 시계 하나다 — 다른 서버(TS 폴)가 그사이 늘려 놨으면 만료가 아니다. 낸 에이전트는 대상에서 빼고
    /// 묶음 표시도 지운다(다음 프레임은 곧바로 쓰고 online 을 다시 낸다). 줄이 없어진 에이전트도 만료로 본다.
    pub async fn sweep_once(&self) -> Result<Vec<String>, sqlx::Error> {
        let ids: Vec<String> = self
            .watched
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .iter()
            .cloned()
            .collect();
        if ids.is_empty() {
            return Ok(vec![]);
        }
        let expired: Vec<String> = sqlx::query_scalar(
            "select w.id::text from unnest($1::uuid[]) as w(id)
             where not exists (select 1 from agent_presence p where p.account_id = w.id and p.expires_at > now())",
        )
        .bind(&ids)
        .fetch_all(&self.pool)
        .await?;
        {
            let mut w = self.watched.lock().unwrap_or_else(|e| e.into_inner());
            let mut last = self.last.lock().unwrap_or_else(|e| e.into_inner());
            for a in &expired {
                w.remove(a);
                last.remove(a);
            }
        }
        if let Some(h) = &self.on_online {
            for a in &expired {
                h(a, false);
            }
        }
        Ok(expired)
    }

    /// 스윕 시계(TS `startSweep`, TTL/2 마다). 실패는 `on_error` 로만 알리고 다음 회차에 다시 본다.
    pub fn start_sweep(self: &Arc<Self>) -> tokio::task::JoinHandle<()> {
        let me = self.clone();
        tokio::spawn(async move {
            let mut tick = tokio::time::interval(me.ttl / 2);
            tick.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Delay);
            tick.tick().await;
            loop {
                tick.tick().await;
                if let Err(e) = me.sweep_once().await {
                    (me.on_error)("presence_sweep", &e);
                }
            }
        })
    }
}

/// 릴레이 링크에 붙일 훅 — presence 와 세션 사본. 주인 agent 는 링크의 것이다(프레임 본문의 agentAccountId 는 보지 않는다).
pub fn link_hooks(live: Option<SessionLive>, presence: Option<Arc<PresenceMark>>) -> LinkHooks {
    let live_g = live.clone();
    let on_frame: FrameHook = Arc::new(move |op: &str, agent: &str, f: &Map<String, Value>| {
        if let Some(p) = &presence {
            p.mark(agent);
        }
        let Some(live) = &live else { return };
        match f.get("type").and_then(Value::as_str) {
            Some("announce") => {
                if let Some(Value::Array(ss)) = f.get("sessions") {
                    live.replaced(op, agent, ss);
                }
            }
            Some("session.started") => {
                if let Some(s) = f.get("session").filter(|s| !s.is_null()) {
                    live.started(op, agent, s);
                }
            }
            Some("session.ended") => {
                if let Some(sid) = f.get("sessionId").and_then(Value::as_str) {
                    live.ended(agent, sid);
                }
            }
            _ => {}
        }
    });
    let on_gone: GoneHook = Arc::new(move |op: &str, agent: &str| {
        if let Some(live) = &live_g {
            live.runner_gone(op, agent);
        }
    });
    LinkHooks {
        on_frame: Some(on_frame),
        on_gone: Some(on_gone),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    const C: &str = "11111111-1111-4111-8111-111111111111";

    #[test]
    fn live_row_keeps_only_allowlisted_fields() {
        let r = live_row(&json!({
            "sessionId": "s1", "channelId": C, "threadRootId": "nope", "harness": "claude",
            "mode": "mention", "startedAt": "2026-11-16T04:00:00.123Z",
            "claudePoolRank": 2, "claudeAccountRank": 100,
            "claudePoolName": "Some Person", "claudeAccountName": "Some Person", "viewKey": "k",
        }))
        .unwrap();
        assert_eq!(
            r,
            LiveRow {
                session_id: "s1".into(),
                channel_id: C.into(),
                thread_root_id: None,
                harness: "claude".into(),
                mode: Some("mention"),
                started_at: Some("2026-11-16T04:00:00.123Z".into()),
                pool_rank: Some(2),
                account_rank: None,
            }
        );
        assert!(!format!("{r:?}").contains("Some Person"));
    }

    #[test]
    fn live_row_rejects_bad_shapes() {
        let base = json!({ "sessionId": "s", "channelId": C, "harness": "h" });
        assert!(live_row(&base).is_some());
        for (k, v) in [
            ("sessionId", json!("")),
            ("sessionId", json!("x".repeat(129))),
            ("channelId", json!("c")),
            ("harness", json!("")),
            ("harness", json!("h".repeat(33))),
        ] {
            let mut b = base.clone();
            b[k] = v;
            assert!(live_row(&b).is_none(), "{k}");
        }
        assert!(live_row(&json!(null)).is_none());
    }

    #[test]
    fn iso_instant_is_strict() {
        assert!(iso_instant("2026-11-16T04:00:00Z").is_some());
        assert!(iso_instant("2026-11-16T04:00:00.5+09:00").is_some());
        assert!(iso_instant("2024-02-29T00:00:00Z").is_some());
        for bad in [
            "2026-02-30T00:00:00Z",
            "2026-11-16 04:00:00Z",
            "2026-11-16T24:00:00Z",
            "2026-11-16T04:00:00",
            "2026-11-16T04:00:00.Z",
            "yesterday",
            "2026-11-16T04:00:00Z; drop",
        ] {
            assert!(iso_instant(bad).is_none(), "{bad}");
        }
    }
}
