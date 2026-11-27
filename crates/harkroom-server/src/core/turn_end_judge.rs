//! 턴 끝 판정을 턴 끝 자리에 잇는다(I2c). `shadow` 는 기록만, `on` 은 판정대로 **뿌리 작업을 닫는다**.
//!
//! - 턴 끝 자리는 턴 임대 끝내기(`POST /agent/turn-leases/{id}/end`, [`super::turn_lease_routes::end`])다. 임대가 끝난 뒤
//!   [`turn_ended`] 가 요청 밖에서 그 턴의 사실([`Facts`])을 읽고 [`judge`] 로 판정해, 그 턴이 맡았던 작업에
//!   [`EVENT_TURN_JUDGED`] 사건 한 줄을 남긴다. 뿌리 작업이면 「닫을 것」([`would_close`])도 같이 싣는다.
//! - **닫는 것은 뿌리 작업뿐이다**([`Mode::On`], [`close_root`]). 위임이 낳은 하위 작업은 위임 쪽(`work_shadow`)이 닫는다 — 여기서는
//!   건드리지 않는다. 뿌리도 아래 가운데 하나라도 있으면 닫지 않고 까닭을 사건에 적는다([`Skip`]):
//!   그 뿌리 아래 안 끝난 작업 · 그 스레드에서 그 에이전트의 살아 있는 임대(뒤 턴이 돌고 있다) · 그 작업으로 라우팅됐는데 아직
//!   안 읽힌 글(턴이 곧 뜬다). 닫기는 라우팅과 같은 (스레드, 에이전트) 잠금 아래에서 한다 — 닫는 사이에 글이 그 작업으로 가지 않는다.
//! - **닫힌 뿌리는 다시 열지 않는다.** 닫힌 뒤 그 스레드에 온 글은 라우팅이 새 뿌리를 세우고(`work_route` 는 열린 작업만 찾는다),
//!   새 위임도 위임 쪽이 새 뿌리를 세워 그 밑에 하위 작업을 둔다. 한 스레드에 뿌리가 차례로 여럿 생긴다 — 뿌리 하나는 「한 번의
//!   부름에서 끝맺음까지」다. 작업을 못 찾은 판정(`work=none`)은 닫을 것이 없고, 사건도 작업 행도 만들지 않는다.
//! - 임대·위임·예약은 고치지 않는다. 쓰는 것은 `work_event` 줄, 측정 줄, 그리고 `on` 일 때 `work` 의 상태 칸뿐이다.
//! - 사실은 「그 에이전트 × 그 스레드 × 임대가 선 뒤」 창으로 읽는다 — 턴마다 가르는 열쇠가 글에 없어, 같은 스레드에서 같은
//!   에이전트의 턴이 겹치면 서로의 글을 같이 본다(근삿값). 겹쳤는지는 판정마다 적는다(`overlap`) — 오판 비율의 윗값이다.
//! - 취소는 감사 줄(`agent.turn.canceled`)로 읽는다. 스레드가 적힌 줄은 그 스레드의 턴만 취소로 읽고, 스레드가 없는 옛 줄은
//!   채널까지만 가른다. 감사 줄이 임대 끝보다 늦게 적힐 수 있어 판정을 [`SETTLE_DELAY`] 만큼 늦춘다. 새 부름이 밀어낸 턴은 적힌 곳이 없다.
//! - 임대가 끝내기 없이 만료되거나 다시 주기로 접힌 턴은 이 자리를 지나지 않는다(판정 없음) — 그렇게 남은 뿌리는 [`sweep`] 이 접는다.
//! - 기다리는 판정은 [`QUEUE_MAX`] 개까지다. 넘으면 그 판정은 버리고 측정 한 줄을 남긴다(작업은 열린 채 남아 [`sweep`] 몫이 된다).
//! - 켬: 위임 그림자와 같은 스위치(`HARKROOM_TURN_END_JUDGE`, `off` 가 아니면)이고 [`TURN_JUDGE_PRIVILEGES`] 가 다 있을 때.
//!   `on` 이고 [`TURN_CLOSE_PRIVILEGES`] 까지 있으면 닫는다. 없으면 `shadow` 로 돈다.
//! - 옛 뿌리 정리 [`sweep`]: `on` 일 때 기동 때와 그 뒤 [`SWEEP_EVERY`] 마다, [`SWEEP_AGE`] 넘게 고쳐지지 않았고 움직임이 없는
//!   (살아 있는 임대·열린 카드·예약·열린 하위 위임·안 끝난 하위 작업이 하나도 없는) 뿌리를 `canceled` 로 접고 `root.swept` 사건을 남긴다.
use super::work;
pub use super::work_shadow::{Facts, Verdict, judge};
use serde_json::{Value, json};
use sqlx::PgPool;
use std::sync::atomic::{AtomicBool, AtomicU64, AtomicUsize, Ordering};
use std::sync::{Mutex, OnceLock};
use std::time::{Duration, Instant};

/// 판정 그림자가 쓰는 권한 — 읽기와 `work_event` 한 줄 넣기. 시퀀스는 `work::WORK_SEQUENCE_PRIVILEGES`.
/// 임대 표는 읽는 칸만 적는다(토큰 해시는 읽지 않는다). 없으면 `main.rs` 가 켜지 않는다(나머지는 그대로 돈다).
pub const TURN_JUDGE_PRIVILEGES: &[(&str, &str)] = &[
    ("secret_turn_lease.id", "SELECT"),
    ("secret_turn_lease.agent_id", "SELECT"),
    ("secret_turn_lease.channel_id", "SELECT"),
    ("secret_turn_lease.thread_root_id", "SELECT"),
    ("secret_turn_lease.cause_message_id", "SELECT"),
    ("secret_turn_lease.created_at", "SELECT"),
    ("secret_turn_lease.ended_at", "SELECT"),
    ("secret_turn_lease.expires_at", "SELECT"),
    ("message", "SELECT"),
    ("agent_wake", "SELECT"),
    ("team_delegation", "SELECT"),
    ("team_delegation_item", "SELECT"),
    ("audit_log.action", "SELECT"),
    ("audit_log.target", "SELECT"),
    ("audit_log.at", "SELECT"),
    ("audit_log.detail", "SELECT"),
    ("work", "SELECT"),
    ("work_event", "SELECT"),
    ("work_event", "INSERT"),
];

/// 닫기([`Mode::On`])에 더 드는 권한 — 작업 상태 칸 고치기와 「아직 안 읽힌 글」 읽기. 없으면 `shadow` 로 돈다.
pub const TURN_CLOSE_PRIVILEGES: &[(&str, &str)] = &[
    ("work", "UPDATE"),
    ("inbox.account_id", "SELECT"),
    ("inbox.message_id", "SELECT"),
    ("inbox.read_at", "SELECT"),
];

/// 턴 끝 판정을 남기는 사건 종류.
pub const EVENT_TURN_JUDGED: &str = "turn.judged";
/// 임대가 끝난 뒤 사실을 읽기까지 기다리는 시간 — 취소의 감사 줄·정리가 임대 끝보다 늦게 적힐 수 있다.
pub const SETTLE_DELAY: Duration = Duration::from_secs(3);
/// 옛 뿌리를 접을 때 남기는 사건 종류.
pub const EVENT_ROOT_SWEPT: &str = "root.swept";
/// 기다리는 판정 수 상한 — 판정은 하나씩 돌고([`GATE`]) 나머지는 여기까지만 줄을 선다.
pub const QUEUE_MAX: usize = 256;
/// 이만큼 고쳐지지 않은 뿌리부터 접는다.
pub const SWEEP_AGE: Duration = Duration::from_secs(24 * 60 * 60);
/// 정리 간격.
pub const SWEEP_EVERY: Duration = Duration::from_secs(60 * 60);
/// 한 번에 접는 뿌리 수 상한.
pub const SWEEP_MAX: i64 = 500;

/// 사람에게 건 열린 카드(답도 닫힘도 없는 것) — 지워진 글·권한 카드는 뺀다(`loops::plan_progress::ASKING_SQL` 과 같은 규칙).
macro_rules! open_ask {
    ($agent:literal, $thread:literal) => {
        concat!(
            "exists (select 1 from message q where q.thread_root_id = ",
            $thread,
            " and q.author_id = ",
            $agent,
            " and q.deleted_at is null and q.meta ? 'ask' and not (q.meta ? 'permissionRequest') \
               and q.meta->'ask'->>'answeredWith' is null and q.meta->'ask'->>'closedAt' is null)"
        )
    };
}

/// 걸려 있는 예약 — 그 스레드에 걸었거나 그 스레드로 보고하기로 한 것(`loops::delegation_deadline` 과 같은 규칙).
macro_rules! pending_wake {
    ($agent:literal, $thread:literal) => {
        concat!(
            "exists (select 1 from agent_wake k join message km on km.id = k.message_id where k.account_id = ",
            $agent,
            " and k.fired_at is null and k.canceled_at is null and (coalesce(km.thread_root_id, km.id) = ",
            $thread,
            " or lower(km.meta->'wake'->'reportTo'->>'threadRootId') = ",
            $thread,
            "::text))"
        )
    };
}

/// 자기가 넘긴 열린 위임 — 자기 조각(담당 = 위임자)은 하위 위임이 아니다.
macro_rules! open_sub_delegation {
    ($agent:literal, $thread:literal) => {
        concat!(
            "exists (select 1 from team_delegation sd join team_delegation_item si on si.delegation_id = sd.id \
              where sd.lead_account_id = ",
            $agent,
            " and sd.thread_root_id = ",
            $thread,
            " and si.outcome is null and si.delegate_account_id <> sd.lead_account_id)"
        )
    };
}

/// 끝난 임대 하나의 사실 — `$1` 임대, `$2` 에이전트. 임대가 없거나 남의 것이거나 아직 안 끝났으면 0줄.
/// 돌려주는 칸: 채널·스레드·원인 글, [`Facts`] 의 일곱 칸(보고·실패·열린 카드·예약·하위 위임·글·취소), 그리고 겹친 턴이 있었는가
/// (같은 에이전트·같은 스레드의 다른 임대가 이 임대의 창과 겹친다).
pub const FACTS_SQL: &str = concat!(
    "with l as ( \
       select id, agent_id, channel_id, thread_root_id, cause_message_id, created_at, ended_at from secret_turn_lease \
        where id = $1::uuid and agent_id = $2::uuid and ended_at is not null \
     ), mine as ( \
       select m.meta from message m join l on m.author_id = l.agent_id \
        where (m.thread_root_id = l.thread_root_id or m.id = l.thread_root_id) \
          and m.created_at >= l.created_at and m.deleted_at is null and m.kind = 'user' \
     ) \
     select l.channel_id::text, l.thread_root_id::text, l.cause_message_id::text, \
       exists (select 1 from mine where meta->>'kind' = 'report'), \
       exists (select 1 from mine where meta->>'kind' = 'failure'), ",
    open_ask!("l.agent_id", "l.thread_root_id"),
    ", ",
    pending_wake!("l.agent_id", "l.thread_root_id"),
    ", ",
    open_sub_delegation!("l.agent_id", "l.thread_root_id"),
    ", exists (select 1 from mine), \
       exists (select 1 from audit_log a where a.action = 'agent.turn.canceled' and a.target = l.agent_id::text \
                 and a.at >= l.created_at and a.detail->>'channelId' = l.channel_id::text \
                 and coalesce(a.detail->>'threadRootId', l.thread_root_id::text) = l.thread_root_id::text), \
       exists (select 1 from secret_turn_lease o where o.agent_id = l.agent_id and o.thread_root_id = l.thread_root_id \
                 and o.id <> l.id and o.created_at < l.ended_at and coalesce(o.ended_at, o.expires_at) > l.created_at) \
     from l"
);

/// 그 턴이 맡았던 작업 — `$1` 스레드, `$2` 에이전트, `$3` 원인 글. 앞선 줄이 이긴다:
/// ① 원인 글이 라우팅된 작업(`message.routed`) ② 원인 글이 낳은 작업(위임 글의 하위 작업) ③ 그 스레드에서 맡은 열린 작업 가운데 가장 최근 것.
/// 돌려주는 칸: 작업 id, 뿌리인가(부모도 위임도 없다), 찾은 길(`routed`·`source`·`thread`).
pub const WORK_SQL: &str = "select w.id::text, (w.parent_id is null and w.delegation_id is null), x.via from ( \
       (select e.work_id, 'routed' as via, 1 as ord from work_event e join work rw on rw.id = e.work_id \
         where rw.thread_root_id = $1::uuid and rw.assignee_account_id = $2::uuid \
           and e.kind = 'message.routed' and e.payload->>'messageId' = $3::uuid::text \
         order by e.id desc limit 1) \
       union all \
       (select sw.id, 'source', 2 from work sw \
         where sw.source_message_id = $3::uuid and sw.assignee_account_id = $2::uuid and sw.thread_root_id = $1::uuid \
         order by sw.created_at desc, sw.id desc limit 1) \
       union all \
       (select tw.id, 'thread', 3 from work tw \
         where tw.thread_root_id = $1::uuid and tw.assignee_account_id = $2::uuid and tw.closed_at is null \
         order by tw.updated_at desc, tw.created_at desc, tw.id desc limit 1) \
     ) x join work w on w.id = x.work_id order by x.ord limit 1";

/// 닫히지 않은 뿌리 작업 세기(읽기뿐) — 전체, 하루 넘은 것, 「움직임이 없는 것」(담당의 살아 있는 임대·열린 카드·예약·열린 하위
/// 위임이 하나도 없다). 마지막 수가 정리 대상의 어림이다. 아무것도 닫지 않는다.
pub const OPEN_ROOTS_SQL: &str = concat!(
    "select count(*)::int8, \
       (count(*) filter (where w.created_at < now() - interval '1 day'))::int8, \
       (count(*) filter (where not exists ( \
              select 1 from secret_turn_lease tl \
               where tl.agent_id = w.assignee_account_id and tl.thread_root_id = w.thread_root_id \
                 and tl.ended_at is null and tl.expires_at > now()) \
          and not ",
    open_ask!("w.assignee_account_id", "w.thread_root_id"),
    " and not ",
    pending_wake!("w.assignee_account_id", "w.thread_root_id"),
    " and not ",
    open_sub_delegation!("w.assignee_account_id", "w.thread_root_id"),
    "))::int8 \
     from work w where w.parent_id is null and w.delegation_id is null and w.closed_at is null"
);

/// 닫기 전에 보는 것 — `$1` 작업, `$2` 에이전트. 뿌리이고 그 에이전트가 맡은 작업일 때만 한 줄(그 행을 잠근다).
/// 돌려주는 칸: 지금 상태, 닫혔는가, 아래에 안 끝난 작업이 있는가, 살아 있는 임대가 있는가, 라우팅됐는데 안 읽힌 글이 있는가.
pub const CLOSE_CHECK_SQL: &str = "select w.state, w.closed_at is not null, \
       exists (select 1 from work c where c.root_id = w.id and c.id <> w.id and c.closed_at is null), \
       exists (select 1 from secret_turn_lease tl \
                where tl.agent_id = w.assignee_account_id and tl.thread_root_id = w.thread_root_id \
                  and tl.ended_at is null and tl.expires_at > now()), \
       exists (select 1 from work_event e join inbox i on i.message_id::text = e.payload->>'messageId' \
                where e.work_id = w.id and e.kind = 'message.routed' \
                  and i.account_id = w.assignee_account_id and i.read_at is null) \
     from work w \
    where w.id = $1::uuid and w.assignee_account_id = $2::uuid and w.parent_id is null and w.delegation_id is null \
      for update of w";

/// 뿌리 작업 닫기 — `$1` 작업, `$2` 끝난 상태. 뿌리이고 아직 안 닫혔을 때만 닿는다.
pub const CLOSE_SQL: &str = "update work set state = $2, updated_at = now(), closed_at = now() \
    where id = $1::uuid and parent_id is null and delegation_id is null and closed_at is null";

/// 옛 뿌리 접기 — `$1` 나이(초), `$2` 한 번에 접는 수. 고쳐진 지 오래됐고 움직임이 없는 뿌리만 `canceled` 로 접고,
/// 접은 행마다 [`EVENT_ROOT_SWEPT`] 사건(앞 상태를 싣는다 — 되돌릴 근거)을 남긴다. 접은 수를 돌려준다.
pub const SWEEP_SQL: &str = concat!(
    "with stale as ( \
       select w.id, w.state from work w \
        where w.parent_id is null and w.delegation_id is null and w.closed_at is null \
          and w.updated_at < now() - make_interval(secs => $1::int) \
          and not exists (select 1 from work c where c.root_id = w.id and c.id <> w.id and c.closed_at is null) \
          and not exists ( \
              select 1 from secret_turn_lease tl \
               where tl.agent_id = w.assignee_account_id and tl.thread_root_id = w.thread_root_id \
                 and tl.ended_at is null and tl.expires_at > now()) \
          and not ",
    open_ask!("w.assignee_account_id", "w.thread_root_id"),
    " and not ",
    pending_wake!("w.assignee_account_id", "w.thread_root_id"),
    " and not ",
    open_sub_delegation!("w.assignee_account_id", "w.thread_root_id"),
    " order by w.created_at, w.id limit $2 for update of w skip locked \
     ), closed as ( \
       update work w set state = 'canceled', updated_at = now(), closed_at = now() \
         from stale s where w.id = s.id returning w.id, s.state as from_state \
     ), noted as ( \
       insert into work_event (work_id, kind, actor_account_id, payload) \
       select id, 'root.swept', null::uuid, jsonb_build_object('from', from_state, 'to', 'canceled', 'reason', 'stale') \
         from closed returning 1 \
     ) select count(*)::int8 from noted"
);

static POOL: OnceLock<PgPool> = OnceLock::new();
/// 닫는가([`Mode::On`]). [`enable`] 이 정한다.
static CLOSING: AtomicBool = AtomicBool::new(false);
/// 줄 선 판정 수(도는 것 포함).
static PENDING: AtomicUsize = AtomicUsize::new(0);
/// 버린 판정 수(아직 측정에 안 적은 것)와 마지막으로 적은 때.
static DROPPED: AtomicU64 = AtomicU64::new(0);
static DROP_NOTED: Mutex<Option<Instant>> = Mutex::new(None);
/// 버린 판정을 측정에 적는 간격.
const DROP_NOTE_EVERY: Duration = Duration::from_secs(60);

/// 판정을 어디까지 하는가.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Mode {
    /// 기록만 — 작업 행은 그대로다.
    Shadow,
    /// 판정대로 뿌리 작업을 닫는다.
    On,
}

/// 닫을 판정인데 닫지 않은 까닭. [`Skip::as_str`] 가 사건에 싣는 이름이다.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Skip {
    /// 뿌리 작업이 아니거나 그 에이전트의 작업이 아니다(행을 못 찾았다).
    NotRoot,
    /// 이미 닫혀 있다.
    Closed,
    /// 그 뿌리 아래 안 끝난 작업이 있다.
    OpenChild,
    /// 그 스레드에서 그 에이전트의 다른 턴이 돌고 있다.
    LiveTurn,
    /// 그 작업으로 라우팅된 글이 아직 안 읽혔다 — 턴이 곧 뜬다.
    PendingMessage,
}

impl Skip {
    pub fn as_str(self) -> &'static str {
        match self {
            Skip::NotRoot => "not_root",
            Skip::Closed => "closed",
            Skip::OpenChild => "open_child",
            Skip::LiveTurn => "live_turn",
            Skip::PendingMessage => "pending_message",
        }
    }
}

/// 닫기 전 확인(순수) — 앞선 줄이 이긴다. `None` 이면 닫는다.
pub fn close_guard(closed: bool, open_child: bool, live_turn: bool, pending: bool) -> Option<Skip> {
    if closed {
        Some(Skip::Closed)
    } else if open_child {
        Some(Skip::OpenChild)
    } else if live_turn {
        Some(Skip::LiveTurn)
    } else if pending {
        Some(Skip::PendingMessage)
    } else {
        None
    }
}
/// 한 번에 도는 판정 수 — 요청과 나눠 쓰는 쓰기 풀에서 연결을 많아야 하나 쓴다.
static GATE: tokio::sync::Semaphore = tokio::sync::Semaphore::const_new(1);

/// 판정을 켠다(프로세스에 한 번). 두 번째 부름은 무시한다. `mode` 가 [`Mode::On`] 이면 판정대로 뿌리 작업을 닫는다.
pub fn enable(pool: PgPool, mode: Mode) {
    if POOL.set(pool).is_ok() {
        CLOSING.store(mode == Mode::On, Ordering::Relaxed);
    }
}

fn mode() -> Mode {
    if CLOSING.load(Ordering::Relaxed) {
        Mode::On
    } else {
        Mode::Shadow
    }
}

/// 닫았을 것 — 무엇 때문에(`by`), 어느 상태로(`state`).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Close {
    /// `report` | `fail` | `canceled` | `answered`.
    pub by: &'static str,
    /// `work.state` 의 끝난 값.
    pub state: &'static str,
}

/// 판정 → 뿌리 작업을 닫았을 것인가(순수). 기다리는 판정(사람·예약·하위 위임)은 닫지 않는다.
///
/// | 판정 | 사실 | 닫았을 것 |
/// |---|---|---|
/// | `Settled` | 실패를 알렸다 | `fail` → `failed` |
/// | `Settled` | 보고를 냈다 | `report` → `done` |
/// | `Settled` | 취소뿐이다 | `canceled` → `canceled` |
/// | `Silent` | 글을 냈다(보통의 답) | `answered` → `done` |
/// | `Silent` | 글도 없다 | 닫지 않는다 |
pub fn would_close(f: Facts, v: Verdict) -> Option<Close> {
    let close = |by, state| Some(Close { by, state });
    match v {
        Verdict::Settled if f.posted_fail => close("fail", "failed"),
        Verdict::Settled if f.posted_report => close("report", "done"),
        Verdict::Settled => close("canceled", "canceled"),
        Verdict::Silent if f.posted_any => close("answered", "done"),
        _ => None,
    }
}

/// 그 턴이 맡았던 작업.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Target {
    pub work_id: String,
    /// 뿌리 작업인가 — 위임이 낳은 하위 작업은 위임 그림자가 닫는다.
    pub root: bool,
    /// 찾은 길(`routed`·`source`·`thread`).
    pub via: String,
}

/// 판정 한 건.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Judged {
    pub channel_id: String,
    pub thread_root_id: String,
    pub cause_message_id: String,
    pub facts: Facts,
    pub verdict: Verdict,
    /// 작업을 못 찾았으면 `None`(라우팅 그림자가 꺼져 있었거나 그 글이 라우팅되지 않았다) — 사건은 남기지 않는다.
    pub target: Option<Target>,
    /// 뿌리 작업이고 닫을 판정일 때만.
    pub close: Option<Close>,
    /// 같은 에이전트·같은 스레드의 다른 턴이 이 턴과 겹쳤다 — 사실이 섞였을 수 있다.
    pub overlap: bool,
    /// 실제로 닫았다([`Mode::On`] 이고 막는 것이 없었다).
    pub closed: bool,
    /// 닫을 판정인데 닫지 않은 까닭([`Mode::On`] 에서만).
    pub skip: Option<Skip>,
}

/// 사건 payload — id·판정·사실뿐이다(본문은 싣지 않는다).
pub fn payload(lease_id: &str, j: &Judged) -> Value {
    let f = j.facts;
    json!({
        "leaseId": lease_id,
        "causeMessageId": j.cause_message_id,
        "verdict": j.verdict.as_str(),
        "facts": {
            "report": f.posted_report, "fail": f.posted_fail, "openAsk": f.open_ask, "wake": f.scheduled_wake,
            "subDelegation": f.sub_delegation_open, "posted": f.posted_any, "canceled": f.turn_canceled,
        },
        "root": j.target.as_ref().map(|t| t.root),
        "via": j.target.as_ref().map(|t| t.via.as_str()),
        "wouldClose": j.close.map(|c| c.state),
        "closeBy": j.close.map(|c| c.by),
        "overlap": j.overlap,
        "closed": j.closed,
        "closeSkipped": j.skip.map(Skip::as_str),
    })
}

fn kind_of(e: &sqlx::Error) -> &'static str {
    e.as_database_error().map_or("io", |_| "db")
}

/// 줄 선 판정 하나 — 떨어질 때 수를 돌려놓는다.
struct Queued;

impl Queued {
    /// 줄에 선다. [`QUEUE_MAX`] 를 넘으면 `None`.
    fn enter() -> Option<Queued> {
        if PENDING.fetch_add(1, Ordering::Relaxed) >= QUEUE_MAX {
            PENDING.fetch_sub(1, Ordering::Relaxed);
            return None;
        }
        Some(Queued)
    }
}

impl Drop for Queued {
    fn drop(&mut self) {
        PENDING.fetch_sub(1, Ordering::Relaxed);
    }
}

/// 버린 판정을 센다. [`DROP_NOTE_EVERY`] 에 한 번, 그동안 버린 수를 측정 한 줄과 로그 한 줄로 남긴다.
fn note_dropped() {
    DROPPED.fetch_add(1, Ordering::Relaxed);
    let now = Instant::now();
    let Ok(mut at) = DROP_NOTED.lock() else {
        return;
    };
    if at.is_some_and(|t| now.duration_since(t) < DROP_NOTE_EVERY) {
        return;
    }
    *at = Some(now);
    drop(at);
    let n = DROPPED.swap(0, Ordering::Relaxed);
    eprintln!("turn end judge: queue full ({QUEUE_MAX}) — dropped {n}");
    super::measure::record(super::measure::Event {
        kind: super::measure::KIND_TURN_JUDGE_DROPPED,
        value: Some(i64::try_from(n).unwrap_or(i64::MAX)),
        detail: Some(json!({ "queueMax": QUEUE_MAX })),
        ..Default::default()
    });
}

/// 임대 끝내기가 **성공한 뒤** 부른다 — 요청 밖에서 판정을 적는다(켜져 있으면 닫는다). 꺼져 있으면 아무것도 하지 않는다.
pub fn turn_ended(lease_id: &str, agent_id: &str) {
    let Some(pool) = POOL.get() else { return };
    let Ok(rt) = tokio::runtime::Handle::try_current() else {
        return;
    };
    let Some(queued) = Queued::enter() else {
        note_dropped();
        return;
    };
    let (lease, agent) = (lease_id.to_owned(), agent_id.to_owned());
    rt.spawn(async move {
        let _queued = queued;
        tokio::time::sleep(SETTLE_DELAY).await;
        let Ok(_one) = GATE.acquire().await else {
            return;
        };
        match judge_with(pool, &lease, &agent, mode()).await {
            Ok(Some(j)) => super::measure::record(super::measure::Event {
                kind: super::measure::KIND_TURN_JUDGED,
                account_id: Some(agent),
                channel_id: Some(j.channel_id.clone()),
                thread_root_id: Some(j.thread_root_id.clone()),
                ref_id: Some(lease),
                value: Some(i64::from(j.close.is_some())),
                detail: Some(json!({
                    "verdict": j.verdict.as_str(),
                    "work": j.target.as_ref().map_or("none", |t| t.via.as_str()),
                    "root": j.target.as_ref().map(|t| t.root),
                    "closeBy": j.close.map(|c| c.by),
                    "overlap": j.overlap,
                    "closed": j.closed,
                    "closeSkipped": j.skip.map(Skip::as_str),
                })),
            }),
            Ok(None) => {}
            Err(e) => eprintln!("turn end judge: turn.judged skipped ({})", kind_of(&e)),
        }
    });
}

type FactsRow = (
    String,
    String,
    String,
    bool,
    bool,
    bool,
    bool,
    bool,
    bool,
    bool,
    bool,
);

/// 뿌리 작업 하나를 닫는다 — 라우팅과 같은 (스레드, 에이전트) 잠금 아래에서 막는 것이 없는지 보고, 없으면 상태를 옮기고
/// `state` 사건(앞 상태·까닭·임대)을 같은 트랜잭션에 남긴다. 닫았으면 `Ok(None)`, 안 닫았으면 그 까닭.
pub async fn close_root(
    pool: &PgPool,
    work_id: &str,
    agent_id: &str,
    thread_root_id: &str,
    lease_id: &str,
    close: Close,
) -> sqlx::Result<Option<Skip>> {
    let mut tx = pool.begin().await?;
    sqlx::query(super::work_route::LOCK_SQL)
        .bind(thread_root_id)
        .bind(agent_id)
        .execute(&mut *tx)
        .await?;
    let row: Option<(String, bool, bool, bool, bool)> = sqlx::query_as(CLOSE_CHECK_SQL)
        .bind(work_id)
        .bind(agent_id)
        .fetch_optional(&mut *tx)
        .await?;
    let Some((from, closed, open_child, live_turn, pending)) = row else {
        return Ok(Some(Skip::NotRoot));
    };
    if let Some(skip) = close_guard(closed, open_child, live_turn, pending) {
        return Ok(Some(skip));
    }
    let done = sqlx::query(CLOSE_SQL)
        .bind(work_id)
        .bind(close.state)
        .execute(&mut *tx)
        .await?;
    if done.rows_affected() == 0 {
        return Ok(Some(Skip::Closed));
    }
    let p = json!({ "from": from, "to": close.state, "by": close.by, "leaseId": lease_id });
    sqlx::query("insert into work_event (work_id, kind, actor_account_id, payload) values ($1::uuid, 'state', $2::uuid, $3::jsonb)")
        .bind(work_id)
        .bind(agent_id)
        .bind(p.to_string())
        .execute(&mut *tx)
        .await?;
    tx.commit().await?;
    Ok(None)
}

/// [`turn_ended`] 의 몸통. 임대가 없거나 남의 것이거나 아직 안 끝났으면 `None`. 작업을 찾았으면 그 작업에 사건 한 줄을 남긴다.
/// `mode` 가 [`Mode::On`] 이고 뿌리 작업을 닫을 판정이면 닫는다([`close_root`]) — 하위 작업은 어느 모드에서도 닫지 않는다.
pub async fn judge_with(
    pool: &PgPool,
    lease_id: &str,
    agent_id: &str,
    mode: Mode,
) -> sqlx::Result<Option<Judged>> {
    let row: Option<FactsRow> = sqlx::query_as(FACTS_SQL)
        .bind(lease_id)
        .bind(agent_id)
        .fetch_optional(pool)
        .await?;
    let Some((channel, thread, cause, report, fail, ask, wake, sub, posted, canceled, overlap)) =
        row
    else {
        return Ok(None);
    };
    let facts = Facts {
        posted_report: report,
        posted_fail: fail,
        open_ask: ask,
        scheduled_wake: wake,
        sub_delegation_open: sub,
        posted_any: posted,
        turn_canceled: canceled,
    };
    let verdict = judge(facts);
    let found: Option<(String, bool, String)> = sqlx::query_as(WORK_SQL)
        .bind(&thread)
        .bind(agent_id)
        .bind(&cause)
        .fetch_optional(pool)
        .await?;
    let target = found.map(|(work_id, root, via)| Target { work_id, root, via });
    let close = match &target {
        Some(t) if t.root => would_close(facts, verdict),
        _ => None,
    };
    let skip = match (mode, &target, close) {
        (Mode::On, Some(t), Some(c)) => {
            close_root(pool, &t.work_id, agent_id, &thread, lease_id, c).await?
        }
        _ => None,
    };
    let judged = Judged {
        channel_id: channel,
        thread_root_id: thread,
        cause_message_id: cause,
        facts,
        verdict,
        target,
        close,
        overlap,
        closed: mode == Mode::On && close.is_some() && skip.is_none(),
        skip,
    };
    if let Some(t) = &judged.target {
        let p = payload(lease_id, &judged);
        work::append_event(pool, &t.work_id, EVENT_TURN_JUDGED, Some(agent_id), &p).await?;
    }
    Ok(Some(judged))
}

/// 옛 뿌리 접기 한 번 — [`SWEEP_SQL`]. 접은 수를 돌려준다.
pub async fn sweep(pool: &PgPool, age: Duration, max: i64) -> sqlx::Result<i64> {
    sqlx::query_scalar(SWEEP_SQL)
        .bind(i32::try_from(age.as_secs()).unwrap_or(i32::MAX))
        .bind(max)
        .fetch_one(pool)
        .await
}

/// 옛 뿌리 정리를 건다([`Mode::On`] 일 때만 부른다) — 지금 한 번, 그 뒤 [`SWEEP_EVERY`] 마다. 접은 것이 있으면 로그 한 줄.
pub fn spawn_sweep(pool: PgPool) {
    let Ok(rt) = tokio::runtime::Handle::try_current() else {
        return;
    };
    rt.spawn(async move {
        loop {
            match sweep(&pool, SWEEP_AGE, SWEEP_MAX).await {
                Ok(0) => {}
                Ok(n) => eprintln!("turn end judge: swept {n} stale root works"),
                Err(e) => eprintln!("turn end judge: sweep failed ({})", kind_of(&e)),
            }
            tokio::time::sleep(SWEEP_EVERY).await;
        }
    });
}

/// 닫히지 않은 뿌리 작업 수 — (전체, 하루 넘은 것, 움직임이 없는 것). 세기만 한다.
pub async fn open_roots(pool: &PgPool) -> sqlx::Result<(i64, i64, i64)> {
    sqlx::query_as(OPEN_ROOTS_SQL).fetch_one(pool).await
}

#[cfg(test)]
mod tests {
    use super::*;

    fn facts(bits: u8) -> Facts {
        let b = |i: u8| bits & (1 << i) != 0;
        Facts {
            posted_report: b(0),
            posted_fail: b(1),
            open_ask: b(2),
            scheduled_wake: b(3),
            sub_delegation_open: b(4),
            posted_any: b(5),
            turn_canceled: b(6),
        }
    }

    #[test]
    fn would_close_table() {
        let f = Facts::default();
        let cases = [
            (f, None),
            (
                Facts {
                    posted_any: true,
                    ..f
                },
                Some(("answered", "done")),
            ),
            (
                Facts {
                    posted_report: true,
                    posted_any: true,
                    ..f
                },
                Some(("report", "done")),
            ),
            (
                Facts {
                    posted_fail: true,
                    posted_report: true,
                    ..f
                },
                Some(("fail", "failed")),
            ),
            (
                Facts {
                    turn_canceled: true,
                    ..f
                },
                Some(("canceled", "canceled")),
            ),
            (
                Facts {
                    turn_canceled: true,
                    posted_report: true,
                    ..f
                },
                Some(("report", "done")),
            ),
            // 기다리는 판정은 글을 냈어도 닫지 않는다.
            (
                Facts {
                    open_ask: true,
                    posted_any: true,
                    ..f
                },
                None,
            ),
            (
                Facts {
                    scheduled_wake: true,
                    posted_any: true,
                    ..f
                },
                None,
            ),
            (
                Facts {
                    sub_delegation_open: true,
                    posted_any: true,
                    ..f
                },
                None,
            ),
        ];
        for (facts, want) in cases {
            let got = would_close(facts, judge(facts)).map(|c| (c.by, c.state));
            assert_eq!(got, want, "{facts:?}");
        }
    }

    /// 일곱 사실의 모든 조합에서 — 닫았을 상태는 끝난 상태이고, 기다리는 판정은 닫지 않는다.
    #[test]
    fn would_close_exhaustive_invariants() {
        for bits in 0u8..128 {
            let f = facts(bits);
            let v = judge(f);
            let c = would_close(f, v);
            if let Some(c) = c {
                assert!(work::is_closed(c.state), "{f:?}");
                assert!(matches!(v, Verdict::Settled | Verdict::Silent), "{f:?}");
            }
            let waiting = matches!(
                v,
                Verdict::WaitingOnHuman | Verdict::WaitingOnWake | Verdict::WaitingOnChild
            );
            if waiting {
                assert_eq!(c, None, "{f:?}");
            }
            assert_eq!(
                v == Verdict::Settled,
                c.is_some() && c.unwrap().by != "answered"
            );
        }
    }

    #[test]
    fn payload_carries_ids_verdict_and_facts_only() {
        let f = Facts {
            posted_report: true,
            posted_any: true,
            ..Facts::default()
        };
        let v = judge(f);
        let mut j = Judged {
            channel_id: "c".into(),
            thread_root_id: "t".into(),
            cause_message_id: "m".into(),
            facts: f,
            verdict: v,
            target: Some(Target {
                work_id: "w".into(),
                root: true,
                via: "routed".into(),
            }),
            close: would_close(f, v),
            overlap: false,
            closed: false,
            skip: None,
        };
        let p = payload("l", &j);
        assert_eq!(
            p,
            json!({
                "leaseId": "l", "causeMessageId": "m", "verdict": "settled",
                "facts": { "report": true, "fail": false, "openAsk": false, "wake": false,
                           "subDelegation": false, "posted": true, "canceled": false },
                "root": true, "via": "routed", "wouldClose": "done", "closeBy": "report",
                "overlap": false, "closed": false, "closeSkipped": null,
            })
        );
        j.overlap = true;
        j.skip = Some(Skip::OpenChild);
        let p = payload("l", &j);
        assert_eq!(
            (&p["overlap"], &p["closeSkipped"]),
            (&json!(true), &json!("open_child"))
        );
        j.target = None;
        j.close = None;
        let p = payload("l", &j);
        assert!(p["root"].is_null() && p["via"].is_null() && p["wouldClose"].is_null());
    }

    #[test]
    fn sql_only_reads() {
        for sql in [FACTS_SQL, WORK_SQL, OPEN_ROOTS_SQL] {
            let low = sql.to_ascii_lowercase();
            assert!(
                low.starts_with("with ") || low.starts_with("select "),
                "{sql}"
            );
            for w in [
                "insert ",
                "update ",
                "delete ",
                "for update",
                " body",
                "token",
            ] {
                assert!(!low.contains(w), "{w}: {sql}");
            }
        }
        // 임대는 끝난 것, 그 에이전트의 것만.
        assert!(FACTS_SQL.contains("agent_id = $2::uuid and ended_at is not null"));
        // 세는 것은 닫히지 않은 뿌리뿐이다.
        assert!(
            OPEN_ROOTS_SQL.contains(
                "w.parent_id is null and w.delegation_id is null and w.closed_at is null"
            )
        );
        assert_eq!(EVENT_TURN_JUDGED, "turn.judged");
    }

    #[test]
    fn privileges_insert_only_the_event_row() {
        for (t, p) in TURN_JUDGE_PRIVILEGES {
            assert!(matches!(*p, "SELECT" | "INSERT"), "{t} {p}");
            assert!(*p != "INSERT" || *t == "work_event", "{t}");
            // 토큰 해시 칸은 읽지 않는다 — 임대 표는 칸으로만 적는다.
            assert!(
                *t != "secret_turn_lease" && !t.ends_with("token_hash"),
                "{t}"
            );
        }
    }

    /// 닫기 전 확인의 모든 조합 — 하나라도 막으면 닫지 않고, 앞선 까닭이 이긴다.
    #[test]
    fn close_guard_blocks_on_any_reason() {
        for bits in 0u8..16 {
            let b = |i: u8| bits & (1 << i) != 0;
            let got = close_guard(b(0), b(1), b(2), b(3));
            assert_eq!(got.is_none(), bits == 0, "{bits}");
            let want = if b(0) {
                Some(Skip::Closed)
            } else if b(1) {
                Some(Skip::OpenChild)
            } else if b(2) {
                Some(Skip::LiveTurn)
            } else if b(3) {
                Some(Skip::PendingMessage)
            } else {
                None
            };
            assert_eq!(got, want, "{bits}");
        }
        let names: std::collections::HashSet<_> = [
            Skip::NotRoot,
            Skip::Closed,
            Skip::OpenChild,
            Skip::LiveTurn,
            Skip::PendingMessage,
        ]
        .iter()
        .map(|s| s.as_str())
        .collect();
        assert_eq!(names.len(), 5);
    }

    /// 닫는 문장은 뿌리에만 닿는다 — 하위 작업(부모·위임이 있는 행)은 조건에서 빠진다.
    #[test]
    fn close_and_sweep_touch_only_open_roots() {
        let root = "parent_id is null and delegation_id is null and closed_at is null";
        assert!(CLOSE_SQL.contains(root), "{CLOSE_SQL}");
        assert!(CLOSE_CHECK_SQL.contains("w.parent_id is null and w.delegation_id is null"));
        assert!(CLOSE_CHECK_SQL.contains("w.assignee_account_id = $2::uuid"));
        assert!(CLOSE_CHECK_SQL.ends_with("for update of w"));
        assert!(
            CLOSE_CHECK_SQL.contains("c.root_id = w.id and c.id <> w.id and c.closed_at is null")
        );
        assert!(CLOSE_CHECK_SQL.contains("i.read_at is null"));
        assert!(
            SWEEP_SQL.contains(
                "w.parent_id is null and w.delegation_id is null and w.closed_at is null"
            )
        );
        assert!(SWEEP_SQL.contains("c.root_id = w.id and c.id <> w.id and c.closed_at is null"));
        assert!(SWEEP_SQL.contains("w.updated_at < now() - make_interval(secs => $1::int)"));
        assert!(SWEEP_SQL.contains("skip locked"));
        assert!(SWEEP_SQL.contains("'canceled'") && SWEEP_SQL.contains("'root.swept'"));
        assert_eq!(EVENT_ROOT_SWEPT, "root.swept");
        for sql in [CLOSE_SQL, CLOSE_CHECK_SQL, SWEEP_SQL] {
            let low = sql.to_ascii_lowercase();
            for w in ["delete ", " body", "token"] {
                assert!(!low.contains(w), "{w}: {sql}");
            }
        }
        // 닫기에 더 드는 권한은 작업 상태 고치기와 인박스의 세 칸 읽기뿐이다.
        for (t, p) in TURN_CLOSE_PRIVILEGES {
            assert!(
                (*t == "work" && *p == "UPDATE") || (t.starts_with("inbox.") && *p == "SELECT"),
                "{t} {p}"
            );
        }
    }

    /// 사실 문장은 취소를 스레드까지 가르고(스레드 없는 옛 줄은 채널까지), 겹친 임대를 본다.
    #[test]
    fn facts_split_cancel_by_thread_and_see_overlap() {
        assert!(FACTS_SQL.contains(
            "coalesce(a.detail->>'threadRootId', l.thread_root_id::text) = l.thread_root_id::text"
        ));
        assert!(FACTS_SQL.contains("o.id <> l.id and o.created_at < l.ended_at"));
    }

    /// 줄은 [`QUEUE_MAX`] 까지다 — 넘으면 서지 못하고, 떨어지면 자리가 돌아온다.
    #[test]
    fn queue_is_bounded() {
        let mut held = Vec::new();
        while let Some(q) = Queued::enter() {
            held.push(q);
            assert!(held.len() <= QUEUE_MAX);
        }
        assert!(Queued::enter().is_none());
        held.pop();
        let again = Queued::enter();
        assert!(again.is_some());
        drop(again);
        drop(held);
        assert!(Queued::enter().is_some());
    }

    #[test]
    fn hook_is_a_noop_when_not_enabled() {
        // 풀이 없으면(켜지 않았으면) 런타임 밖에서도 그냥 돌아온다.
        turn_ended(
            "00000000-0000-4000-8000-000000000001",
            "00000000-0000-4000-8000-000000000002",
        );
    }
}
