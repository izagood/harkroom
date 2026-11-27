//! 위임 다시 부르기(DA) — 담당 턴이 「말없이 끝남」([`Verdict::Silent`])이면 서버가 담당을 다시 부른다.
//!
//! - 자리: 턴 끝 판정([`super::turn_end_judge::turn_ended`])이 판정을 적은 **뒤**. 판정 자체와 뿌리 작업 닫기는 건드리지 않는다.
//! - 대상: 그 스레드에서 그 에이전트가 **담당**인 열린 위임 항목(자기 조각은 뺀다). 여럿이면 가장 최근 위임 하나.
//! - 다시 부르지 않는 경우([`decide`]): 판정이 `Silent` 가 아니다(보고·실패·취소·열린 카드·예약·하위 위임 — 판정이 이미 가른다) ·
//!   열린 PR 감시가 있다 · 그 스레드에서 그 에이전트의 다른 턴이 돌고 있다(그 턴이 끝날 때 다시 판정한다) · 이미 막힘으로 표시했다.
//! - 다시 부르기: [`RECALL_DELAY_SEC`] 뒤로 **예약 깨움 한 줄**을 담당 이름으로 세운다(대기 줄 + `agent_wake` 행). 전달은 기존
//!   예약 루프(`loops::wake`)가 한다. 그 줄에는 원인 사슬이 없다 — 다시 부른 턴은 사람의 권한(머지 등)을 물려받지 않는다.
//! - [`RECALL_MAX`] 번 다시 부른 뒤에도 말없이 끝나면 **막힘**: 항목에 `recall_blocked_at` 을 찍고, 옛 멈춤 알림이 아직 안 갔으면
//!   (`stalled_notified_at is null`) 같은 알림(위임자 inbox `delegation_update` 한 줄)을 보낸다. **위임은 닫지 않는다.**
//! - 횟수는 먼저 자기 트랜잭션에서 올린다(항목 행 잠금) — 서버가 둘이어도 한 번의 침묵에 한 번만 부른다. 그 뒤 줄 세우기가
//!   실패하면 그 한 번은 잃는다(로그·측정에 남는다). 옛 침묵 기한(`loops::delegation_deadline`)은 그대로 돌아 그런 위임을 받친다.
//! - 스위치 [`SWITCH_ENV`](`off`(기본) | `shadow` | `on`). `shadow` 는 「불렀을 것」을 측정 한 줄로만 남긴다(횟수를 올리지 않으므로
//!   늘 첫 번째로 적힌다). 턴 끝 판정이 꺼져 있으면 이 스위치도 닿지 않는다.
//!
//! ## 못 잡힌 위임 감시(DB)
//! 턴 끝 판정을 지나지 않는 두 경우를 기한 루프(`loops::delegation_deadline`, 15초마다·문지기 아래)가 [`sweep_unjudged`] 로 훑는다:
//! - `no_turn` — 위임(또는 마지막 다시 부르기) 뒤 [`UNCLAIMED_SEC`] 가 지나도록 그 스레드에서 담당의 턴 임대가 하나도 서지 않았다.
//! - `lease_expired` — 담당의 마지막 임대가 끝내기 없이 만료된 지 [`EXPIRED_GRACE_SEC`] 가 지났다(판정 자리를 지나지 않았다).
//!
//! 둘 다 말없이 끝난 턴과 **같은 사다리**([`decide`])를 탄다 — 다시 부르기 [`RECALL_MAX`] 번, 그 뒤 막힘 + 위임자 알림. 위임은 닫지 않는다.
//! 기다림 근거(열린 카드·걸린 예약·열린 하위 위임·열린 PR 감시·도는 턴)가 있거나 만든 지 [`UNJUDGED_MAX_AGE_SEC`] 가 넘은 위임은 보지 않는다.
//! 다시 부르면 `recalled_at` 이 지금으로 옮겨 가 다음 훑기는 그 뒤 [`UNCLAIMED_SEC`] 를 다시 기다린다. `shadow` 는 항목마다 한 번만 적는다.
//! 판정을 지난 턴(끝내기가 찍힌 임대) 뒤에 생긴 일 — 예컨대 카드 답으로 깨웠는데 턴이 안 선 경우 — 은 여기서 보지 않는다(옛 침묵 기한 몫).
use super::measure;
use super::msg_post::{
    Origin, Outcome, PostBody, PostState, channel_is_dm, iso_ms, now_ms, post_in_tx,
};
use super::turn_end_judge::Judged;
use super::wake_preempt::{Preempted, announce};
use super::work_shadow::Verdict;
use crate::core::audience::audience_for;
use serde_json::{Map, Value, json};
use sqlx::PgPool;
use std::collections::HashSet;
use std::sync::{Mutex, OnceLock};

/// 스위치 환경 변수.
pub const SWITCH_ENV: &str = "HARKROOM_DELEGATION_RECALL";
/// 말없이 끝난 뒤 다시 부르기까지.
pub const RECALL_DELAY_SEC: i64 = 120;
/// 다시 부르는 횟수 상한 — 이만큼 부른 뒤 또 말없이 끝나면 막힘.
pub const RECALL_MAX: i32 = 2;
/// 측정 종류 — `detail.step`(`recall`·`block`·`skip`)·`detail.attempt`·`detail.why`·`detail.mode`. `ref_id` 는 위임 id.
pub const KIND_DELEGATION_RECALL: &str = "delegation.recall";
/// 감시(DB): 위임(또는 마지막 다시 부르기) 뒤 이만큼 턴이 안 서면 못 잡힌 것으로 본다.
pub const UNCLAIMED_SEC: i32 = 10 * 60;
/// 감시(DB): 임대가 끝내기 없이 만료된 뒤 이만큼 지나야 본다(러너의 늦은 끝내기를 기다린다).
pub const EXPIRED_GRACE_SEC: i32 = 120;
/// 감시(DB): 만든 지 이보다 오래된 위임은 보지 않는다(기한 루프의 나이 닫힘 몫).
pub const UNJUDGED_MAX_AGE_SEC: i32 = 24 * 60 * 60;
/// 감시(DB): 한 번 훑을 때 보는 항목 수 상한.
pub const UNJUDGED_BATCH: i64 = 20;

/// 읽기(그림자)에 드는 권한. 새 칸 줄은 마이그레이션 200 이 안 깔린 DB 를 거른다. 임대 표는 읽는 칸만(토큰 해시는 읽지 않는다).
pub const RECALL_PRIVILEGES: &[(&str, &str)] = &[
    ("team_delegation", "SELECT"),
    ("team_delegation_item", "SELECT"),
    ("team_delegation_item.recall_count", "SELECT"),
    ("team_delegation_item.recall_blocked_at", "SELECT"),
    ("pr_watch", "SELECT"),
    ("pr_watch_subscriber", "SELECT"),
    ("secret_turn_lease.agent_id", "SELECT"),
    ("secret_turn_lease.thread_root_id", "SELECT"),
    ("secret_turn_lease.ended_at", "SELECT"),
    ("secret_turn_lease.expires_at", "SELECT"),
];

/// 감시(DB)가 더 읽는 것 — 없으면 감시만 빠지고 다시 부르기는 그대로 돈다. 임대 표는 읽는 칸만.
pub const UNJUDGED_PRIVILEGES: &[(&str, &str)] = &[
    ("team_delegation_item.recalled_at", "SELECT"),
    ("secret_turn_lease.created_at", "SELECT"),
    ("message", "SELECT"),
    ("agent_wake", "SELECT"),
];

/// 켬(`on`)에 더 드는 권한 — 글 올리기(`msg_post::MESSAGE_POST_PRIVILEGES`) 위에. 없으면 `shadow` 로 돈다.
pub const RECALL_ON_PRIVILEGES: &[(&str, &str)] = &[
    ("team_delegation_item.recall_count", "UPDATE"),
    ("team_delegation_item.recalled_at", "UPDATE"),
    ("team_delegation_item.recall_blocked_at", "UPDATE"),
    ("team_delegation_item.stalled_notified_at", "UPDATE"),
    ("agent_wake", "INSERT"),
    ("inbox", "SELECT"),
    ("inbox", "INSERT"),
    ("event_outbox", "INSERT"),
];
pub const RECALL_ON_SEQUENCE_PRIVILEGES: &[(&str, &str)] = &[("event_outbox_id_seq", "USAGE")];

/// 스위치 값.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Switch {
    Off,
    Shadow,
    On,
}

/// 스위치 글자를 읽는다 — 없거나 모르는 값이면 `Off`(기본). 앞뒤 공백·대소문자는 가리지 않는다.
pub fn parse_switch(raw: Option<&str>) -> Switch {
    match raw.map(|v| v.trim().to_ascii_lowercase()).as_deref() {
        Some("shadow") => Switch::Shadow,
        Some("on") => Switch::On,
        _ => Switch::Off,
    }
}

/// 환경에서 읽은 스위치.
pub fn switch_from_env() -> Switch {
    parse_switch(std::env::var(SWITCH_ENV).ok().as_deref())
}

/// 담당의 열린 위임 항목 하나 — `$1` 스레드, `$2` 에이전트. 가장 최근 위임. 자기 조각(담당 = 위임자)은 뺀다.
/// 돌려주는 칸: 위임 id, 채널, 위임자, 위임 글, 다시 부른 횟수, 막힘 표시가 있는가, 멈춤 알림이 이미 갔는가,
/// 열린 PR 감시가 있는가, 그 스레드에서 그 에이전트의 살아 있는 임대가 있는가.
macro_rules! candidate_sql {
    () => {
        "select d.id::text, d.channel_id::text, d.lead_account_id::text, d.message_id::text, \
       i.recall_count, i.recall_blocked_at is not null, i.stalled_notified_at is not null, \
       exists (select 1 from pr_watch_subscriber s join pr_watch w on w.id = s.watch_id \
                where w.state = 'open' and s.account_id = i.delegate_account_id and s.thread_root_id = d.thread_root_id), \
       exists (select 1 from secret_turn_lease tl \
                where tl.agent_id = i.delegate_account_id and tl.thread_root_id = d.thread_root_id \
                  and tl.ended_at is null and tl.expires_at > now()) \
     from team_delegation_item i join team_delegation d on d.id = i.delegation_id \
    where d.thread_root_id = $1::uuid and i.delegate_account_id = $2::uuid and i.outcome is null \
      and i.delegate_account_id <> d.lead_account_id \
    order by d.created_at desc, d.id desc limit 1"
    };
}
pub const CANDIDATE_SQL: &str = candidate_sql!();

/// [`CANDIDATE_SQL`] 에 항목 행 잠금을 붙인 것 — 횟수를 올리거나 막힘을 찍는 트랜잭션에서 쓴다.
pub const CANDIDATE_LOCKED_SQL: &str = concat!(candidate_sql!(), " for update of i");

/// 횟수 올리기 — `$1` 위임, `$2` 담당.
pub const CLAIM_SQL: &str = "update team_delegation_item set recall_count = recall_count + 1, recalled_at = now() \
    where delegation_id = $1::uuid and delegate_account_id = $2::uuid and outcome is null";

/// 막힘 찍기 — `$1` 위임, `$2` 담당. 멈춤 알림 표시도 같이 찍는다(옛 기한 루프가 같은 알림을 또 보내지 않게).
pub const BLOCK_SQL: &str = "update team_delegation_item \
      set recall_blocked_at = now(), stalled_notified_at = coalesce(stalled_notified_at, now()) \
    where delegation_id = $1::uuid and delegate_account_id = $2::uuid and outcome is null and recall_blocked_at is null";

/// 위임자에게 이미 안 읽은 알림이 있는가 — `$1` 위임자, `$2` 위임 글(`loops::delegation_deadline` 의 멈춤 알림과 같은 검사).
pub const NOTICE_EXISTS_SQL: &str = "select exists (select 1 from inbox where account_id = $1::uuid and message_id = $2::uuid \
       and reason = 'delegation_update' and read_at is null)";

/// [`NOTICE_EXISTS_SQL`] 에서 깨움 행 판을 만들 때 쓰는 자리 — 「안 읽음」 조건.
pub const NOTICE_UNREAD: &str = "read_at is null";

/// 알림 중복 검사 문장 — 나머지 읽는 곳이 깨움 행을 볼 때([`super::wake_source::readers`])는 위임자가 에이전트면 그 줄의 깨움이
/// 열려 있을 때만 「이미 있다」로 본다. 위임자가 사람이면 그대로다(사람은 깨움 행이 없다).
pub fn notice_exists_sql() -> &'static str {
    static S: std::sync::OnceLock<String> = std::sync::OnceLock::new();
    S.get_or_init(|| {
        if super::wake_source::readers() {
            super::wake_source::with_open_for_agents(
                NOTICE_EXISTS_SQL,
                NOTICE_UNREAD,
                "inbox.id",
                "inbox.account_id",
                "nw",
            )
        } else {
            NOTICE_EXISTS_SQL.to_owned()
        }
    })
}

/// 위임자 알림 한 줄(`loops::delegation_deadline` 의 멈춤 알림과 같은 줄).
pub const NOTICE_SQL: &str = "insert into inbox (account_id, message_id, reason) values ($1::uuid, $2::uuid, 'delegation_update')";

/// 예약 행 — `$1` 담당, `$2` 채널, `$3` 대기 줄, `$4` 깨울 시각(대기 줄 meta 의 `wakeAt` 과 같은 값).
pub const WAKE_SQL: &str = "insert into agent_wake (account_id, channel_id, message_id, wake_at) \
    values ($1::uuid, $2::uuid, $3::uuid, $4::timestamptz)";

/// 판정을 지나지 않은 열린 위임 항목(DB) — `$1` 턴이 안 선 채 기다린 초, `$2` 만료 뒤 기다린 초, `$3` 위임 나이 상한(초), `$4` 줄 수.
/// 돌려주는 칸: 스레드, 담당, 까닭(`no_turn` | `lease_expired`). 그 (스레드, 담당)의 가장 최근 열린 위임만 본다([`CANDIDATE_SQL`] 과 같은 줄).
/// 기준 시각(`anchor`)은 위임을 만든 때와 마지막으로 다시 부른 때 가운데 늦은 쪽이다.
/// 빼는 것: 이미 막힘 · 자기 조각 · 살아 있는 임대 · 열린 카드(권한 카드 제외) · 걸린 예약 · 자기가 넘긴 열린 위임
/// (`turn_end_judge` 의 기다림 근거와 같은 규칙). 열린 PR 감시는 [`decide`] 가 가른다.
pub const UNJUDGED_SQL: &str = "with open as ( \
       select d.thread_root_id as thread, i.delegate_account_id as agent, \
              greatest(d.created_at, coalesce(i.recalled_at, d.created_at)) as anchor \
         from team_delegation_item i join team_delegation d on d.id = i.delegation_id \
        where i.outcome is null and i.recall_blocked_at is null \
          and i.delegate_account_id <> d.lead_account_id and d.thread_root_id is not null \
          and d.created_at > now() - ($3::int * interval '1 second') \
          and not exists (select 1 from team_delegation_item i2 join team_delegation d2 on d2.id = i2.delegation_id \
                           where d2.thread_root_id = d.thread_root_id and i2.delegate_account_id = i.delegate_account_id \
                             and i2.outcome is null and i2.delegate_account_id <> d2.lead_account_id \
                             and (d2.created_at, d2.id) > (d.created_at, d.id)) \
     ), seen as ( \
       select o.thread, o.agent, o.anchor, \
              exists (select 1 from secret_turn_lease tl where tl.agent_id = o.agent and tl.thread_root_id = o.thread \
                        and coalesce(tl.ended_at, tl.expires_at) >= o.anchor) as any_turn, \
              coalesce((select tl.ended_at is null and tl.expires_at <= now() - ($2::int * interval '1 second') \
                          from secret_turn_lease tl where tl.agent_id = o.agent and tl.thread_root_id = o.thread \
                         order by tl.created_at desc limit 1), false) as last_expired \
         from open o \
        where not exists (select 1 from secret_turn_lease tl where tl.agent_id = o.agent and tl.thread_root_id = o.thread \
                            and tl.ended_at is null and tl.expires_at > now()) \
          and not exists (select 1 from message q where q.thread_root_id = o.thread and q.author_id = o.agent \
                            and q.deleted_at is null and q.meta ? 'ask' and not (q.meta ? 'permissionRequest') \
                            and q.meta->'ask'->>'answeredWith' is null and q.meta->'ask'->>'closedAt' is null) \
          and not exists (select 1 from agent_wake k join message km on km.id = k.message_id \
                           where k.account_id = o.agent and k.fired_at is null and k.canceled_at is null \
                             and (coalesce(km.thread_root_id, km.id) = o.thread \
                               or lower(km.meta->'wake'->'reportTo'->>'threadRootId') = o.thread::text)) \
          and not exists (select 1 from team_delegation sd join team_delegation_item si on si.delegation_id = sd.id \
                           where sd.lead_account_id = o.agent and sd.thread_root_id = o.thread \
                             and si.outcome is null and si.delegate_account_id <> sd.lead_account_id) \
     ) \
     select s.thread::text, s.agent::text, case when s.any_turn then 'lease_expired' else 'no_turn' end \
       from seen s \
      where (not s.any_turn and s.anchor < now() - ($1::int * interval '1 second')) or (s.any_turn and s.last_expired) \
      order by s.anchor limit $4";

/// 열린 위임 항목에 대해 읽은 것.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Candidate {
    pub delegation_id: String,
    pub channel_id: String,
    pub lead_id: String,
    pub message_id: String,
    pub recall_count: i32,
    pub blocked: bool,
    pub stall_notified: bool,
    pub pr_watch: bool,
    pub live_turn: bool,
}

type CandidateRow = (String, String, String, String, i32, bool, bool, bool, bool);

fn candidate(r: CandidateRow) -> Candidate {
    Candidate {
        delegation_id: r.0,
        channel_id: r.1,
        lead_id: r.2,
        message_id: r.3,
        recall_count: r.4,
        blocked: r.5,
        stall_notified: r.6,
        pr_watch: r.7,
        live_turn: r.8,
    }
}

/// 무엇을 할 것인가.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Step {
    /// 다시 부른다 — 몇 번째인가(1부터).
    Recall(i32),
    /// 막힘으로 표시하고 위임자를 깨운다.
    Block,
    /// 하지 않는다 — 까닭.
    Skip(&'static str),
}

impl Step {
    fn name(self) -> &'static str {
        match self {
            Step::Recall(_) => "recall",
            Step::Block => "block",
            Step::Skip(_) => "skip",
        }
    }
}

/// 판정 + 읽은 것 → 할 일(순수). 앞선 줄이 이긴다:
/// 1. 판정이 `Silent` 가 아니다 → 하지 않는다(매듭지었거나 카드·예약·하위 위임을 기다린다).
/// 2. 열린 PR 감시 → 하지 않는다(바깥 일을 기다린다).
/// 3. 다른 턴이 돌고 있다 → 하지 않는다(그 턴이 끝날 때 다시 본다).
/// 4. 이미 막힘 → 하지 않는다.
/// 5. 다시 부른 횟수가 [`RECALL_MAX`] 미만 → 다시 부른다. 아니면 막힘.
pub fn decide(verdict: Verdict, c: &Candidate) -> Step {
    if verdict != Verdict::Silent {
        Step::Skip("not_silent")
    } else if c.pr_watch {
        Step::Skip("pr_watch")
    } else if c.live_turn {
        Step::Skip("live_turn")
    } else if c.blocked {
        Step::Skip("blocked")
    } else if c.recall_count < RECALL_MAX {
        Step::Recall(c.recall_count + 1)
    } else {
        Step::Block
    }
}

/// 다시 부르기가 켜져(`on`) 실제로 부르는 중인가 — 임대 발급 답이 러너에 알린다(DC). `shadow`·꺼짐은 `false`.
pub fn recalling() -> bool {
    CONFIG.get().is_some_and(|c| c.post.is_some())
}

/// 임대 발급 답에 싣는 칸 이름(DC) — 참일 때만 싣는다. 러너는 이 칸이 참이면 담당 쪽 대리 실패 줄을 건너뛴다.
pub const LEASE_FIELD: &str = "delegationRecall";

/// 대기 줄 본문. 멘션은 풀리지 않는다(`no_mentions`). 줄 주인이 담당으로 그려지므로 「서버가」를 앞머리에 둔다(좁은 폭에서 잘려도 남게).
pub fn recall_body(attempt: i32) -> String {
    format!(
        "보고 없이 끝나 서버가 다시 부름({attempt}/{RECALL_MAX}) — 끝났으면 message.report, 막혔으면 message.fail, \
         기다릴 것이 있으면 turn.wake 나 message.ask 로 남긴다"
    )
}

/// 대기 줄 meta — 보통의 예약 줄(`kind: wake`)에 `recall` 조각을 더한 것. 화면은 예약 대기 줄로 그린다.
pub fn recall_meta(
    delegation_id: &str,
    attempt: i32,
    body: &str,
    wake_at: &str,
) -> Map<String, Value> {
    let mut meta = Map::new();
    meta.insert("kind".into(), Value::from("wake"));
    meta.insert(
        "wake".into(),
        json!({
            "wakeAt": wake_at,
            "reason": body,
            "recall": { "delegationId": delegation_id, "attempt": attempt, "max": RECALL_MAX },
        }),
    );
    meta
}

struct Config {
    pool: PgPool,
    /// `on` 일 때만 — 대기 줄을 올릴 글 쓰기 상태.
    post: Option<PostState>,
    /// 못 잡힌 위임 감시(DB)를 도는가 — [`UNJUDGED_PRIVILEGES`] 가 다 있을 때만.
    sweep: bool,
}

static CONFIG: OnceLock<Config> = OnceLock::new();
/// `shadow` 감시가 이미 적은 (스레드, 담당) — 횟수가 오르지 않아 같은 항목이 훑을 때마다 잡히므로 한 번만 적는다.
static SHADOW_SEEN: Mutex<Option<HashSet<(String, String)>>> = Mutex::new(None);
/// [`SHADOW_SEEN`] 상한 — 넘으면 비우고 다시 센다.
const SHADOW_SEEN_MAX: usize = 4096;

/// 켠다(프로세스에 한 번). `post` 가 있으면 `on`, 없으면 `shadow`. `sweep` 이면 못 잡힌 위임 감시(DB)도 돈다.
pub fn enable(pool: PgPool, post: Option<PostState>, sweep: bool) {
    let _ = CONFIG.set(Config { pool, post, sweep });
}

/// 감시가 내는 까닭 글자를 고정 낱말로 — 모르는 값은 `None`.
pub fn unjudged_case(raw: &str) -> Option<&'static str> {
    match raw {
        "no_turn" => Some("no_turn"),
        "lease_expired" => Some("lease_expired"),
        _ => None,
    }
}

/// 판정을 지나지 않은 열린 위임 항목 — (스레드, 담당, 까닭). 읽기만.
pub async fn unjudged(
    pool: &PgPool,
    unclaimed_sec: i32,
    expired_grace_sec: i32,
) -> sqlx::Result<Vec<(String, String, String)>> {
    sqlx::query_as(UNJUDGED_SQL)
        .bind(unclaimed_sec)
        .bind(expired_grace_sec)
        .bind(UNJUDGED_MAX_AGE_SEC)
        .bind(UNJUDGED_BATCH)
        .fetch_all(pool)
        .await
}

/// `shadow` 감시가 이 항목을 처음 보는가(처음이면 적어 둔다).
fn shadow_first(thread: &str, agent: &str) -> bool {
    let mut seen = SHADOW_SEEN.lock().unwrap_or_else(|e| e.into_inner());
    let set = seen.get_or_insert_with(HashSet::new);
    if set.len() >= SHADOW_SEEN_MAX {
        set.clear();
    }
    set.insert((thread.to_owned(), agent.to_owned()))
}

fn kind_of(e: &sqlx::Error) -> &'static str {
    e.as_database_error().map_or("io", |_| "db")
}

fn note(
    agent: &str,
    thread: &str,
    c: &Candidate,
    step: Step,
    on: bool,
    posted: Option<bool>,
    case: Option<&'static str>,
) {
    let (attempt, why) = match step {
        Step::Recall(n) => (Some(n), None),
        Step::Block => (None, None),
        Step::Skip(w) => (None, Some(w)),
    };
    measure::record(measure::Event {
        kind: KIND_DELEGATION_RECALL,
        account_id: Some(agent.to_owned()),
        channel_id: Some(c.channel_id.clone()),
        thread_root_id: Some(thread.to_owned()),
        ref_id: Some(c.delegation_id.clone()),
        value: Some(i64::from(matches!(step, Step::Recall(_) | Step::Block))),
        detail: Some(json!({
            "step": step.name(), "attempt": attempt, "why": why,
            "mode": if on { "on" } else { "shadow" }, "posted": posted, "case": case,
        })),
    });
}

/// 읽기만 — 그 스레드·그 에이전트의 열린 위임 항목과 할 일. 항목이 없으면 `None`.
pub async fn peek(
    pool: &PgPool,
    thread: &str,
    agent: &str,
    verdict: Verdict,
) -> sqlx::Result<Option<(Candidate, Step)>> {
    let row: Option<CandidateRow> = sqlx::query_as(CANDIDATE_SQL)
        .bind(thread)
        .bind(agent)
        .fetch_optional(pool)
        .await?;
    Ok(row.map(candidate).map(|c| {
        let step = decide(verdict, &c);
        (c, step)
    }))
}

/// 잠금 아래 다시 읽고, 할 일이 그대로면 적는다 — 다시 부르기는 횟수를 올리고, 막힘은 표시를 찍고 위임자에게 알린다(신호는 outbox).
/// 돌려주는 것은 실제로 적은 일(다른 서버가 먼저 했으면 `Skip`).
pub async fn commit_step(
    pool: &PgPool,
    thread: &str,
    agent: &str,
    verdict: Verdict,
) -> sqlx::Result<Option<(Candidate, Step)>> {
    let mut tx = pool.begin().await?;
    let row: Option<CandidateRow> = sqlx::query_as(CANDIDATE_LOCKED_SQL)
        .bind(thread)
        .bind(agent)
        .fetch_optional(&mut *tx)
        .await?;
    let Some(c) = row.map(candidate) else {
        return Ok(None);
    };
    let step = decide(verdict, &c);
    match step {
        Step::Recall(_) => {
            sqlx::query(CLAIM_SQL)
                .bind(&c.delegation_id)
                .bind(agent)
                .execute(&mut *tx)
                .await?;
        }
        Step::Block => {
            let marked = sqlx::query(BLOCK_SQL)
                .bind(&c.delegation_id)
                .bind(agent)
                .execute(&mut *tx)
                .await?;
            if marked.rows_affected() > 0 && !c.stall_notified {
                let exists: bool = sqlx::query_scalar(notice_exists_sql())
                    .bind(&c.lead_id)
                    .bind(&c.message_id)
                    .fetch_one(&mut *tx)
                    .await?;
                if !exists {
                    sqlx::query(NOTICE_SQL)
                        .bind(&c.lead_id)
                        .bind(&c.message_id)
                        .execute(&mut *tx)
                        .await?;
                    let out = Preempted {
                        woke: vec![c.lead_id.clone()],
                        ..Preempted::default()
                    };
                    announce(&mut tx, &out).await?;
                }
            }
        }
        Step::Skip(_) => return Ok(Some((c, step))),
    }
    tx.commit().await?;
    Ok(Some((c, step)))
}

/// 대기 줄 + 예약 행. 줄이 올라갔으면 `true`.
pub async fn schedule(
    st: &PostState,
    thread: &str,
    agent: &str,
    c: &Candidate,
    attempt: i32,
) -> sqlx::Result<bool> {
    let body = recall_body(attempt);
    let wake_at = iso_ms(now_ms() + RECALL_DELAY_SEC * 1_000);
    let audience = audience_for(&st.write, &c.channel_id).await?.to_json();
    let is_dm = channel_is_dm(&st.write, &c.channel_id).await?;
    let input = PostBody {
        body: body.clone(),
        attachment_ids: Vec::new(),
        thread_root: Some(thread.to_owned()),
        also_in_channel: false,
    };
    let origin = Origin {
        meta: recall_meta(&c.delegation_id, attempt, &body, &wake_at),
        wake: true,
        server_notice: true,
        no_mentions: true,
        ..Origin::default()
    };
    let posted = post_in_tx(
        st,
        &c.channel_id,
        agent,
        // 작성자는 담당 에이전트다 — 사람 글 갈래(남의 열린 예약 깨우기·사람 위임 키 잇기)를 타지 않는다.
        true,
        &input,
        None,
        &audience,
        is_dm,
        &origin,
    )
    .await?;
    let Outcome::Posted { row, .. } = posted else {
        return Ok(false);
    };
    let Some(message) = serde_json::from_str::<Value>(&row)
        .ok()
        .and_then(|m| m.get("id").and_then(Value::as_str).map(str::to_owned))
    else {
        return Ok(false);
    };
    sqlx::query(WAKE_SQL)
        .bind(agent)
        .bind(&c.channel_id)
        .bind(&message)
        .bind(&wake_at)
        .execute(&st.write)
        .await?;
    Ok(true)
}

/// 턴 끝 판정 뒤에 부른다. 꺼져 있으면 아무것도 하지 않는다. 실패는 로그 한 줄로 삼킨다.
pub async fn after_judged(agent: &str, j: &Judged) {
    let Some(cfg) = CONFIG.get() else { return };
    if j.verdict != Verdict::Silent {
        return;
    }
    silent(cfg, j.thread_root_id.as_str(), agent, None).await;
}

/// 못 잡힌 위임 감시(DB) — 기한 루프가 문지기 아래에서 부른다. 꺼져 있으면 아무것도 하지 않는다. 본 항목 수.
pub async fn sweep_unjudged() -> usize {
    let Some(cfg) = CONFIG.get() else { return 0 };
    if !cfg.sweep {
        return 0;
    }
    let rows = match unjudged(&cfg.pool, UNCLAIMED_SEC, EXPIRED_GRACE_SEC).await {
        Ok(rows) => rows,
        Err(e) => {
            eprintln!("delegation recall: sweep failed ({})", kind_of(&e));
            return 0;
        }
    };
    let mut n = 0;
    for (thread, agent, case) in rows {
        let Some(case) = unjudged_case(&case) else {
            continue;
        };
        if cfg.post.is_none() && !shadow_first(&thread, &agent) {
            continue;
        }
        silent(cfg, &thread, &agent, Some(case)).await;
        n += 1;
    }
    n
}

/// 말없이 끝난 것으로 다룬다 — `case` 는 감시가 잡은 까닭(판정 자리에서 오면 `None`).
async fn silent(cfg: &Config, thread: &str, agent: &str, case: Option<&'static str>) {
    let Some(st) = &cfg.post else {
        match peek(&cfg.pool, thread, agent, Verdict::Silent).await {
            Ok(Some((c, step))) => note(agent, thread, &c, step, false, None, case),
            Ok(None) => {}
            Err(e) => eprintln!("delegation recall: peek failed ({})", kind_of(&e)),
        }
        return;
    };
    match commit_step(&st.write, thread, agent, Verdict::Silent).await {
        Ok(Some((c, step))) => {
            let posted = match step {
                Step::Recall(n) => match schedule(st, thread, agent, &c, n).await {
                    Ok(p) => Some(p),
                    Err(e) => {
                        eprintln!("delegation recall: schedule failed ({})", kind_of(&e));
                        Some(false)
                    }
                },
                _ => None,
            };
            note(agent, thread, &c, step, true, posted, case);
        }
        Ok(None) => {}
        Err(e) => eprintln!("delegation recall: step failed ({})", kind_of(&e)),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn notice_check_wake_statement_leaves_human_leads_alone() {
        let sql = crate::core::wake_source::with_open_for_agents(
            NOTICE_EXISTS_SQL,
            NOTICE_UNREAD,
            "inbox.id",
            "inbox.account_id",
            "nw",
        );
        assert!(sql.contains(
            "read_at is null and (exists (select 1 from wake nw where nw.inbox_id = inbox.id"
        ));
        assert!(sql.contains("or not exists (select 1 from account nw_k where nw_k.id = inbox.account_id and nw_k.kind = 'agent'))"));
        assert_eq!(notice_exists_sql(), NOTICE_EXISTS_SQL);
    }

    fn cand(count: i32) -> Candidate {
        Candidate {
            delegation_id: "d".into(),
            channel_id: "c".into(),
            lead_id: "l".into(),
            message_id: "m".into(),
            recall_count: count,
            blocked: false,
            stall_notified: false,
            pr_watch: false,
            live_turn: false,
        }
    }

    #[test]
    fn switch_is_off_unless_shadow_or_on() {
        assert_eq!(parse_switch(None), Switch::Off);
        assert_eq!(parse_switch(Some("")), Switch::Off);
        assert_eq!(parse_switch(Some("1")), Switch::Off);
        assert_eq!(parse_switch(Some(" Shadow ")), Switch::Shadow);
        assert_eq!(parse_switch(Some("ON")), Switch::On);
    }

    #[test]
    fn only_a_silent_turn_is_recalled() {
        for v in [
            Verdict::Settled,
            Verdict::WaitingOnHuman,
            Verdict::WaitingOnWake,
            Verdict::WaitingOnChild,
        ] {
            assert_eq!(decide(v, &cand(0)), Step::Skip("not_silent"), "{v:?}");
        }
        assert_eq!(decide(Verdict::Silent, &cand(0)), Step::Recall(1));
    }

    #[test]
    fn recalls_twice_then_blocks() {
        assert_eq!(decide(Verdict::Silent, &cand(0)), Step::Recall(1));
        assert_eq!(decide(Verdict::Silent, &cand(1)), Step::Recall(2));
        assert_eq!(decide(Verdict::Silent, &cand(RECALL_MAX)), Step::Block);
        assert_eq!(decide(Verdict::Silent, &cand(RECALL_MAX + 3)), Step::Block);
    }

    #[test]
    fn waiting_grounds_and_blocked_items_are_left_alone() {
        let mut c = cand(0);
        c.pr_watch = true;
        assert_eq!(decide(Verdict::Silent, &c), Step::Skip("pr_watch"));
        let mut c = cand(RECALL_MAX);
        c.live_turn = true;
        assert_eq!(decide(Verdict::Silent, &c), Step::Skip("live_turn"));
        let mut c = cand(RECALL_MAX);
        c.blocked = true;
        assert_eq!(decide(Verdict::Silent, &c), Step::Skip("blocked"));
    }

    #[test]
    fn wait_line_is_a_plain_wake_line_with_a_recall_piece() {
        let body = recall_body(2);
        assert!(body.contains("(2/2)"));
        assert!(body.starts_with("보고 없이 끝나 서버가 다시 부름"));
        assert!(!body.contains('@'));
        let meta = recall_meta("d1", 2, &body, "2026-01-01T00:02:00.000Z");
        assert_eq!(meta["kind"], "wake");
        assert_eq!(meta["wake"]["recall"]["delegationId"], "d1");
        assert_eq!(meta["wake"]["recall"]["attempt"], 2);
        assert_eq!(meta["wake"]["reason"], body.as_str());
        assert_eq!(meta["wake"]["wakeAt"], "2026-01-01T00:02:00.000Z");
    }

    #[test]
    fn sql_touches_only_open_items_and_never_closes_them() {
        assert!(CANDIDATE_SQL.contains("i.outcome is null"));
        assert!(CANDIDATE_SQL.contains("i.delegate_account_id <> d.lead_account_id"));
        for s in [CLAIM_SQL, BLOCK_SQL] {
            assert!(s.contains("outcome is null"), "{s}");
            assert!(!s.contains("set outcome"), "{s}");
            assert!(!s.contains("closed_at"), "{s}");
        }
        assert!(BLOCK_SQL.contains("recall_blocked_at is null"));
        assert!(CANDIDATE_LOCKED_SQL.ends_with("for update of i"));
        // 임대 표는 읽는 칸만 — 토큰 칸은 닿지 않는다.
        assert!(!CANDIDATE_SQL.contains("token"));
    }

    #[test]
    fn lease_signal_is_off_until_recall_is_enabled_with_a_post_state() {
        // 이 시험 프로세스는 켜지 않는다 — 꺼짐·shadow 는 알리지 않는다(러너가 대리 실패를 그대로 남긴다).
        assert!(!recalling());
        assert_eq!(LEASE_FIELD, "delegationRecall");
    }

    #[test]
    fn unjudged_sweep_skips_waiting_grounds_and_reads_no_token() {
        for needle in [
            "i.outcome is null and i.recall_blocked_at is null",
            "i.delegate_account_id <> d.lead_account_id",
            "tl.ended_at is null and tl.expires_at > now()",
            "q.meta ? 'ask' and not (q.meta ? 'permissionRequest')",
            "k.fired_at is null and k.canceled_at is null",
            "si.outcome is null and si.delegate_account_id <> sd.lead_account_id",
        ] {
            assert!(UNJUDGED_SQL.contains(needle), "{needle}");
        }
        assert!(!UNJUDGED_SQL.contains("token"));
        assert!(!UNJUDGED_SQL.contains("update "));
        assert!(UNJUDGED_PRIVILEGES.iter().all(|(_, p)| *p == "SELECT"));
        assert_eq!(unjudged_case("no_turn"), Some("no_turn"));
        assert_eq!(unjudged_case("lease_expired"), Some("lease_expired"));
        assert_eq!(unjudged_case("x"), None);
    }

    #[test]
    fn shadow_sweep_notes_an_item_once() {
        assert!(shadow_first("t-once", "a-once"));
        assert!(!shadow_first("t-once", "a-once"));
        assert!(shadow_first("t-once", "b-once"));
    }

    #[test]
    fn on_privileges_add_only_the_recall_columns_the_wake_row_and_the_notice() {
        assert!(RECALL_PRIVILEGES.iter().all(|(_, p)| *p == "SELECT"));
        assert!(
            RECALL_ON_PRIVILEGES
                .iter()
                .all(|(t, _)| !t.contains("outcome") && !t.contains("closed"))
        );
    }
}
