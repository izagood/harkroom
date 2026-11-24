//! C4b B1a — Rust 가 답하는 **기억 쓰기** 도구(본문 검사가 없는 것): `memory.get`(읽은 횟수) · `memory.recalled` · `memory.lease` ·
//! `memory.archive` · `memory.unarchive`. TS `mcpPlugin.ts` 의 같은 이름 도구 + `services/memory.ts`·`memoryCurate.ts` 의 문장을 따른다.
//!
//! 약속(읽기 도구와 같고, 쓰기라 하나 더):
//! - 인자는 zod 가 그대로 받는 모양만 받는다. 모양이 다르면 `None` — TS 가 검증 오류를 낸다.
//! - 쓰기 **전** DB 오류는 `None`(TS 가 같은 요청을 처음부터 돈다). 쓰기를 시작한 뒤의 오류는 TS 로 넘기지 않고 고정 문장의
//!   `internal` 도구 오류로 끝낸다(security W1 — 넘기면 TS 가 같은 쓰기를 한 번 더 한다).
//! - 쓰기 풀은 [`MEMORY_WRITE_PRIVILEGES`] 가 다 있을 때만 있다(`main.rs`). 없으면 이 도구들은 TS 가 답한다.
//! - 백그라운드 회차의 기억 쓰기(`memory.archive`)는 TS `/mcp/admit` 이 받지 않는다(상한 예약·변경 기록이 도구 안에 있다) — 입장
//!   확인이 `Unknown` 이 되어 TS 가 답한다. 회차 밖 호출만 여기까지 온다.
//! - 쓰기 출처(`writeOrigin`: 회차·턴)는 이 다섯이 남기는 이전 판에 적히지 않는다 — TS 도 보관 넘침(`pruneArchived`)의 이전 판에
//!   run_id·turn_id 를 싣지 않는다.
use super::reads2::valid_slug;
use super::respond::text_result;
use super::tools::err;
use crate::auth::Account;
use serde_json::Value;
use sqlx::PgPool;

/// 이 묶음에서 Rust 가 답하는 도구.
pub const SERVED: &[&str] = &[
    "memory.get",
    "memory.recalled",
    "memory.lease",
    "memory.archive",
    "memory.unarchive",
    "memory.search",
];

/// 쓰기 역할에 필요한 권한(표·칸, 권한). 칸 권한은 코드가 실제로 고치는 칸만이다. `select … for update` 는 그 표의 칸 하나에
/// UPDATE 가 있으면 된다.
pub const MEMORY_WRITE_PRIVILEGES: &[(&str, &str)] = &[
    ("agent_memory.read_count", "UPDATE"),
    ("agent_memory.last_read_at", "UPDATE"),
    ("agent_memory.recall_count", "UPDATE"),
    ("agent_memory.last_recalled_at", "UPDATE"),
    ("agent_memory.archived_at", "UPDATE"),
    ("agent_memory.updated_at", "UPDATE"),
    // 보관 넘침(`pruneArchived`) — 가장 오래 보관된 것을 이전 판으로 옮기며 지운다.
    ("agent_memory", "DELETE"),
    ("agent_memory_revision", "INSERT"),
    ("memory_lease", "INSERT"),
    ("memory_lease", "UPDATE"),
    ("memory_lease", "DELETE"),
];
pub const MEMORY_WRITE_SEQUENCE_PRIVILEGES: &[(&str, &str)] =
    &[("agent_memory_revision_id_seq", "USAGE")];

/// shared `MAX_MEMORY_ITEMS_PER_ACCOUNT`.
const MAX_ITEMS: i64 = 200;
/// `memoryCurate.ts::MAX_ARCHIVED_MEMORIES_PER_ACCOUNT`.
const MAX_ARCHIVED: i64 = 300;
/// `MEMORY_LEASE_DEFAULT_MINUTES` · `MEMORY_LEASE_MAX_MINUTES`.
const LEASE_DEFAULT_MINUTES: i64 = 60;
const LEASE_MAX_MINUTES: i64 = 180;

/// `memory.ts::MEMORY_SLUG_HINT`.
pub(crate) const SLUG_HINT: &str = "slug must be \"core\" or \"mem/<name>\" (segments of [a-z0-9][a-z0-9_-]* joined by \"/\", e.g. \"mem/deploy\" or \"mem/people/alex\"; no dots, no uppercase, and the \"mem/\" prefix is required)";

/// `Date#toISOString()` 꼴 글자 — sqlx 는 `&'static str` 문장만 받으므로 문장째 `concat!` 으로 짓는다.
macro_rules! iso {
    ($c:literal) => {
        concat!(
            "to_char(",
            $c,
            " at time zone 'UTC', 'YYYY-MM-DD\"T\"HH24:MI:SS.MS\"Z\"')"
        )
    };
}

/// 쓰기를 시작한 뒤의 DB 오류(security W1). 사유를 되비추지 않는 고정 문장이다.
pub(super) fn internal() -> String {
    err("internal", "the write failed; it was not retried")
}

fn ok_text(v: &str) -> String {
    text_result(v)
}

/// `z.string().min(1)` 인 slug. 없거나 문자열이 아니거나 비면 `None`(→ TS). 꼴이 틀리면 `Some(Err(거절 글자))`.
fn slug_arg<'a>(args: &'a Value, key: &str) -> Option<Result<&'a str, String>> {
    let s = args.get(key)?.as_str().filter(|s| !s.is_empty())?;
    Some(if valid_slug(s) {
        Ok(s)
    } else {
        Err(err("invalid_slug", SLUG_HINT))
    })
}

/// zod 3 `z.string().datetime({ offset: true })` 의 **부분집합**(이 꼴이면 zod 도 받는다). 아니면 `None` → TS 가 판정한다.
pub(crate) fn datetime_ok(s: &str) -> bool {
    static R: std::sync::OnceLock<regex::Regex> = std::sync::OnceLock::new();
    R.get_or_init(|| {
        regex::Regex::new(
            r"^\d{4}-(0[1-9]|1[0-2])-(0[1-9]|[12]\d|3[01])T([01]\d|2[0-3]):[0-5]\d:[0-5]\d(\.\d{1,9})?(Z|[+-]([01]\d|2[0-3]):[0-5]\d)$",
        )
        .expect("datetime re")
    })
    .is_match(s)
}

/// `ifUpdatedAt: z.string().datetime({offset:true}).nullable().optional()` — 없음 `Some(None)` · null `Some(Some(None))` ·
/// 문자열 `Some(Some(Some(s)))` · 그 밖 `None`.
#[allow(clippy::option_option)]
pub(super) fn if_updated_at(args: &Value) -> Option<Option<Option<&str>>> {
    match args.get("ifUpdatedAt") {
        None => Some(None),
        Some(Value::Null) => Some(Some(None)),
        Some(Value::String(s)) if datetime_ok(s) => Some(Some(Some(s.as_str()))),
        Some(_) => None,
    }
}

/// TS `conflictError(slug, now)`.
pub(super) fn conflict(slug: &str, now: Option<&str>) -> String {
    let message = match now {
        Some(at) => format!(
            "그 사이 다른 턴이 {slug} 를 고쳤다(지금 판 {at}). memory.get 으로 다시 읽고 그 updatedAt 으로 다시 해라."
        ),
        None => format!("{slug} 가 그 사이 지워졌거나 아직 없다."),
    };
    text_result(&format!(
        "{{\"error\":{{\"code\":\"conflict\",\"slug\":{},\"updatedAt\":{},\"message\":{}}}}}",
        Value::from(slug),
        now.map_or(Value::Null, Value::from),
        Value::from(message)
    ))
}

fn utf16_len(s: &str) -> usize {
    s.encode_utf16().count()
}

pub async fn answer(
    read: &PgPool,
    write: Option<&PgPool>,
    me: &Account,
    tool: &str,
    args: &Value,
) -> Option<Option<String>> {
    if !SERVED.contains(&tool) {
        return None;
    }
    let Some(write) = write else {
        return Some(None);
    };
    Some(match tool {
        "memory.get" => get(read, write, me, args).await,
        "memory.recalled" => recalled(write, me, args).await,
        "memory.lease" => lease(write, me, args).await,
        "memory.archive" => archive(write, me, args).await,
        "memory.unarchive" => unarchive(write, me, args).await,
        "memory.search" => super::mem_recall::search(read, write, me, args).await,
        _ => None,
    })
}

/// `memory.get` — `readMemoryCounted`(읽은 횟수를 세며 읽기) + 걸린 판이면 `lastCleanRevision`.
async fn get(read: &PgPool, write: &PgPool, me: &Account, args: &Value) -> Option<String> {
    let slug = match slug_arg(args, "slug")? {
        Ok(s) => s,
        Err(t) => return Some(t),
    };
    type R = (
        String,
        String,
        String,
        Option<String>,
        Option<String>,
        Option<String>,
        Option<String>,
        Option<String>,
    );
    const SQL: &str = concat!(
        "update agent_memory set read_count = read_count + 1, last_read_at = now() \
         where account_id = $1::uuid and slug = $2 returning slug, value, ",
        iso!("updated_at"),
        ", description, ",
        iso!("flagged_at"),
        ", flag_reason, ",
        iso!("archived_at"),
        ", when_hint"
    );
    // 여기부터 쓰기다(W1).
    let row: Option<R> = match sqlx::query_as(SQL)
        .bind(&me.id)
        .bind(slug)
        .fetch_optional(write)
        .await
    {
        Ok(r) => r,
        Err(_) => return Some(internal()),
    };
    let Some((slug, value, updated, description, flagged_at, flag_reason, archived_at, when)) = row
    else {
        return Some(err("not_found", "memory not found"));
    };
    let desc = description.filter(|d| !d.is_empty());
    if let Some(at) = flagged_at {
        let clean: Option<(String, Option<String>)> = match sqlx::query_as(
            "select value, description from agent_memory_revision \
             where account_id = $1::uuid and slug = $2 and not flagged \
             order by replaced_at desc, id desc limit 1",
        )
        .bind(&me.id)
        .bind(&slug)
        .fetch_optional(read)
        .await
        {
            Ok(r) => r,
            Err(_) => return Some(internal()),
        };
        let mut out = format!(
            "{{\"slug\":{},\"updatedAt\":{}",
            Value::from(slug.as_str()),
            Value::from(updated)
        );
        if let Some((v, d)) = &clean {
            out.push_str(&format!(",\"value\":{}", Value::from(v.as_str())));
            if let Some(d) = d.as_deref().filter(|d| !d.is_empty()) {
                out.push_str(&format!(",\"description\":{}", Value::from(d)));
            }
        }
        let notice = format!(
            "지금 판은 쓰기 검사에 걸려 사람의 확인을 기다린다 — 본문을 싣지 않는다. {}지시문·비밀 값 없이 다시 쓰면 표시가 풀린다.",
            if clean.is_some() {
                "value 는 걸리기 전 마지막 판이다. "
            } else {
                "걸리기 전 판이 없다. "
            }
        );
        out.push_str(&format!(
            ",\"flagged\":{{\"reason\":{},\"at\":{}}},\"notice\":{}}}",
            flag_reason.map_or(Value::Null, Value::from),
            Value::from(at),
            Value::from(notice)
        ));
        return Some(ok_text(&out));
    }
    let mut out = format!(
        "{{\"slug\":{},\"value\":{},\"updatedAt\":{}",
        Value::from(slug),
        Value::from(value),
        Value::from(updated)
    );
    if let Some(d) = desc {
        out.push_str(&format!(",\"description\":{}", Value::from(d)));
    }
    if let Some(w) = when.filter(|w| !w.is_empty()) {
        out.push_str(&format!(",\"when\":{}", Value::from(w)));
    }
    if let Some(a) = archived_at {
        out.push_str(&format!(
            ",\"archived\":true,\"archivedAt\":{}",
            Value::from(a)
        ));
    }
    out.push('}');
    Some(ok_text(&out))
}

/// `memory.recalled` — `slugs: z.array(z.string().min(1).max(300)).min(1).max(5)` · `recordRecall`.
async fn recalled(write: &PgPool, me: &Account, args: &Value) -> Option<String> {
    // 어느 턴에 무엇 때문에 실렸나(사건 표). 턴 id 가 없으면(옛 러너) 수만 센다.
    let turn = super::tools::opt_uuid(args, "turnId")?;
    let trigger = match args.get("trigger") {
        None => "turn_start",
        Some(Value::String(t)) if (1..=64).contains(&utf16_len(t)) => t.as_str(),
        Some(_) => return None,
    };
    let arr = args.get("slugs")?.as_array()?;
    if arr.is_empty() || arr.len() > 5 {
        return None;
    }
    let mut slugs: Vec<String> = vec![];
    for k in arr {
        let k = k.as_str()?;
        let n = utf16_len(k);
        if !(1..=300).contains(&n) {
            return None;
        }
        // TS `k.replace(/@[^@]*$/, '')` — 마지막 `@` 부터 끝까지(그 뒤에 `@` 가 없을 때)를 뗀다.
        let s = match k.rfind('@') {
            Some(i) => &k[..i],
            None => k,
        };
        if !s.is_empty() && s != "core" && !slugs.iter().any(|x| x == s) {
            slugs.push(s.to_owned());
        }
    }
    if !slugs.is_empty()
        && sqlx::query(
            "update agent_memory set recall_count = recall_count + 1, last_recalled_at = now() \
             where account_id = $1::uuid and slug = any($2::text[])",
        )
        .bind(&me.id)
        .bind(&slugs)
        .execute(write)
        .await
        .is_err()
    {
        return Some(internal());
    }
    if let Some(turn) = turn
        && let Err(e) = record_events(write, me, &turn, trigger, &slugs).await
    {
        // 사건은 지표다 — 못 적어도 센 수와 답은 그대로다.
        eprintln!("[memory.recalled] 사건 기록 실패: {e}");
    }
    Some(ok_text("{\"ok\":true}"))
}

/// 실린 사건(턴·기억·계기·순위) — 순위는 러너가 실은 차례다. 같은 턴의 되풀이 보고는 한 줄로 남는다.
async fn record_events(
    write: &PgPool,
    me: &Account,
    turn: &str,
    trigger: &str,
    slugs: &[String],
) -> Result<(), sqlx::Error> {
    if slugs.is_empty() {
        return Ok(());
    }
    sqlx::query(
        "insert into memory_recall_event (account_id, turn_id, slug, trigger, rank) \
         select $1::uuid, $2::uuid, m.slug, $3, t.n::smallint \
         from unnest($4::text[]) with ordinality as t(slug, n) \
         join agent_memory m on m.account_id = $1::uuid and m.slug = t.slug \
         on conflict do nothing",
    )
    .bind(&me.id)
    .bind(turn)
    .bind(trigger)
    .bind(slugs)
    .execute(write)
    .await?;
    sqlx::query(
        "delete from memory_recall_event where account_id = $1::uuid and created_at < now() - interval '90 days'",
    )
    .bind(&me.id)
    .execute(write)
    .await?;
    Ok(())
}

/// `{acquiredAt, expiresAt}`(TS `view`).
fn lease_view(l: &(String, String, String)) -> String {
    format!(
        "{{\"acquiredAt\":{},\"expiresAt\":{}}}",
        Value::from(l.1.as_str()),
        Value::from(l.2.as_str())
    )
}

/// `memory.lease` — `acquireMemoryLease`·`memoryLeaseStatus`·`releaseMemoryLease`.
async fn lease(write: &PgPool, me: &Account, args: &Value) -> Option<String> {
    let o = args.as_object()?;
    let action = match o.get("action")?.as_str()? {
        a @ ("acquire" | "release" | "status") => a,
        _ => return None,
    };
    let token = match o.get("token") {
        None => None,
        Some(Value::String(t)) if (8..=80).contains(&utf16_len(t)) => Some(t.as_str()),
        Some(_) => return None,
    };
    let minutes = super::tools::opt_int(args, "minutes", 1, LEASE_MAX_MINUTES)?;
    const STATUS_SQL: &str = concat!(
        "select holder, ",
        iso!("acquired_at"),
        ", ",
        iso!("expires_at"),
        " from memory_lease where account_id = $1::uuid and expires_at >= now()"
    );
    if action == "status" {
        let cur: Option<(String, String, String)> = sqlx::query_as(STATUS_SQL)
            .bind(&me.id)
            .fetch_optional(write)
            .await
            .ok()?;
        return Some(ok_text(&format!(
            "{{\"lease\":{}}}",
            cur.as_ref().map_or("null".to_owned(), lease_view)
        )));
    }
    if action == "release" {
        let Some(t) = token else {
            return Some(err(
                "token_required",
                "release 에는 acquire 가 준 token 이 필요하다",
            ));
        };
        return Some(
            match sqlx::query(
                "delete from memory_lease where account_id = $1::uuid and holder = $2",
            )
            .bind(&me.id)
            .bind(t)
            .execute(write)
            .await
            {
                Ok(r) => ok_text(&format!(
                    "{{\"ok\":true,\"released\":{}}}",
                    r.rows_affected() > 0
                )),
                Err(_) => internal(),
            },
        );
    }
    // TS `token ?? randomUUID()` — v4 uuid 글자.
    let t = match token {
        Some(t) => t.to_owned(),
        None => match sqlx::query_scalar::<_, String>("select gen_random_uuid()::text")
            .fetch_one(write)
            .await
        {
            Ok(t) => t,
            Err(_) => return None,
        },
    };
    let minutes = minutes.unwrap_or(LEASE_DEFAULT_MINUTES);
    const ACQUIRE_SQL: &str = concat!(
        "insert into memory_lease (account_id, holder, acquired_at, expires_at) \
         values ($1::uuid, $2, now(), now() + make_interval(mins => $3::int)) \
         on conflict (account_id) do update set \
           holder = excluded.holder, acquired_at = now(), expires_at = excluded.expires_at \
           where memory_lease.expires_at < now() or memory_lease.holder = excluded.holder \
         returning holder, ",
        iso!("acquired_at"),
        ", ",
        iso!("expires_at")
    );
    // TS 는 잡기와 조회 사이에 놓였으면 다시 잡는다(재귀). 같은 뜻의 고리 — 경합이 끝없이 이어지지 않게 횟수를 둔다.
    for _ in 0..8 {
        let got: Option<(String, String, String)> = match sqlx::query_as(ACQUIRE_SQL)
            .bind(&me.id)
            .bind(&t)
            .bind(minutes as i32)
            .fetch_optional(write)
            .await
        {
            Ok(r) => r,
            Err(_) => return Some(internal()),
        };
        if let Some(l) = got {
            return Some(ok_text(&format!(
                "{{\"acquired\":true,\"token\":{},\"lease\":{}}}",
                Value::from(t.as_str()),
                lease_view(&l)
            )));
        }
        let cur: Option<(String, String, String)> = match sqlx::query_as(STATUS_SQL)
            .bind(&me.id)
            .fetch_optional(write)
            .await
        {
            Ok(r) => r,
            Err(_) => return Some(internal()),
        };
        if let Some(c) = cur {
            return Some(ok_text(&format!(
                "{{\"acquired\":false,\"heldBy\":{},\"notice\":{}}}",
                lease_view(&c),
                Value::from(
                    "다른 턴이 이 계정의 기억을 정리하고 있다 — 만료 뒤에 다시 하거나 물러나라."
                )
            )));
        }
    }
    Some(internal())
}

/// 잠근 한 줄 — `lockRows` 의 `updated_at`(ISO)·`archived_at is not null`. ifUpdatedAt 비교는 ms 로 자른 값끼리(`sameMs`).
async fn lock_row(
    c: &mut sqlx::PgConnection,
    owner: &str,
    slug: &str,
    expect: Option<Option<&str>>,
) -> Result<Option<(String, bool, bool)>, sqlx::Error> {
    const SQL: &str = concat!(
        "select ",
        iso!("updated_at"),
        ", archived_at is not null, \
           coalesce(date_trunc('milliseconds', updated_at) = date_trunc('milliseconds', $3::timestamptz), $3::text is null) \
         from agent_memory where account_id = $1::uuid and slug = $2 for update"
    );
    sqlx::query_as(SQL)
        .bind(owner)
        .bind(slug)
        .bind(expect.flatten())
        .fetch_optional(&mut *c)
        .await
}

/// `memory.archive` — `archiveMemory`(+ `pruneArchived`).
async fn archive(write: &PgPool, me: &Account, args: &Value) -> Option<String> {
    let slug = match slug_arg(args, "slug")? {
        Ok(s) => s,
        Err(t) => return Some(t),
    };
    let expect = if_updated_at(args)?;
    // 시각 꼴이 Postgres 에서 안 읽히면(zod 부분집합을 지나도 날짜가 없는 날 등) 쓰기 전에 TS 로 넘긴다.
    if let Some(Some(at)) = expect {
        sqlx::query("select $1::timestamptz")
            .bind(at)
            .execute(write)
            .await
            .ok()?;
    }
    if slug == "core" {
        return Some(err(
            "core_not_archivable",
            "core 는 매 턴 실리는 자리라 보관할 수 없다 — 줄여 써라",
        ));
    }
    // 바뀌는 것은 커밋뿐이다 — 그 전 오류는 롤백되어 TS 가 다시 돌아도 같은 쓰기를 두 번 하지 않는다. 그래도 W1 대로 고정 오류로 끝낸다.
    Some(match archive_one(write, &me.id, slug, expect).await {
        Ok(Archived::Ok) => ok_text("{\"ok\":true}"),
        Ok(Archived::NotFound) => err("not_found", "memory not found"),
        Ok(Archived::Conflict(now)) => conflict(slug, Some(&now)),
        Err(_) => internal(),
    })
}

/// [`archive_one`] 의 결말 — TS `archiveMemory` 의 `'ok' | 'not_found' | { conflict }`.
pub(crate) enum Archived {
    Ok,
    NotFound,
    Conflict(String),
}

/// `archiveMemory`(+ `pruneArchived`) 한 건 — MCP `memory.archive` 와 REST `POST …/memory/archive` 가 같이 탄다.
#[allow(clippy::option_option)]
pub(crate) async fn archive_one(
    write: &PgPool,
    owner: &str,
    slug: &str,
    expect: Option<Option<&str>>,
) -> Result<Archived, sqlx::Error> {
    let mut tx = write.begin().await?;
    let Some((updated, archived, same)) = lock_row(&mut tx, owner, slug, expect).await? else {
        tx.rollback().await?;
        return Ok(Archived::NotFound);
    };
    // `expect === undefined` 면 비교하지 않는다. null 이면 「없어야 한다」 — 있으니 충돌.
    if expect.is_some() && !(same && expect.flatten().is_some()) {
        tx.rollback().await?;
        return Ok(Archived::Conflict(updated));
    }
    if !archived {
        sqlx::query(
            "update agent_memory set archived_at = now(), updated_at = now() \
             where account_id = $1::uuid and slug = $2",
        )
        .bind(owner)
        .bind(slug)
        .execute(&mut *tx)
        .await?;
        sqlx::query(
            "with d as ( \
               delete from agent_memory where account_id = $1::uuid and archived_at is not null and slug in ( \
                 select slug from agent_memory where account_id = $1::uuid and archived_at is not null \
                 order by archived_at desc, slug offset $2) \
               returning slug, value, description, updated_at, flagged_at, kind) \
             insert into agent_memory_revision (account_id, slug, value, description, updated_at, flagged, kind) \
             select $1::uuid, slug, value, description, updated_at, flagged_at is not null, kind from d",
        )
        .bind(owner)
        .bind(MAX_ARCHIVED)
        .execute(&mut *tx)
        .await?;
    }
    tx.commit().await?;
    Ok(Archived::Ok)
}

/// `memory.unarchive` — `unarchiveMemory`.
async fn unarchive(write: &PgPool, me: &Account, args: &Value) -> Option<String> {
    let slug = match slug_arg(args, "slug")? {
        Ok(s) => s,
        Err(t) => return Some(t),
    };
    Some(match unarchive_one(write, &me.id, slug).await {
        Ok(Unarchived::Ok) => ok_text("{\"ok\":true}"),
        Ok(Unarchived::NotFound) => err("not_found", "memory not found"),
        Ok(Unarchived::TooMany) => err(
            "too_many",
            &format!("at most {MAX_ITEMS} active memories per account"),
        ),
        Err(_) => internal(),
    })
}

/// [`unarchive_one`] 의 결말 — TS `unarchiveMemory` 의 `'ok' | 'not_found' | 'too_many'`.
pub(crate) enum Unarchived {
    Ok,
    NotFound,
    TooMany,
}

/// `unarchiveMemory` 한 건 — MCP `memory.unarchive` 와 REST `POST …/memory/unarchive` 가 같이 탄다.
pub(crate) async fn unarchive_one(
    write: &PgPool,
    owner: &str,
    slug: &str,
) -> Result<Unarchived, sqlx::Error> {
    let mut tx = write.begin().await?;
    let Some((_, archived, _)) = lock_row(&mut tx, owner, slug, None).await? else {
        tx.rollback().await?;
        return Ok(Unarchived::NotFound);
    };
    if !archived {
        tx.rollback().await?;
        return Ok(Unarchived::Ok);
    }
    let n: i64 = sqlx::query_scalar(
        "select count(*) from agent_memory where account_id = $1::uuid and archived_at is null",
    )
    .bind(owner)
    .fetch_one(&mut *tx)
    .await?;
    if n >= MAX_ITEMS {
        tx.rollback().await?;
        return Ok(Unarchived::TooMany);
    }
    sqlx::query(
        "update agent_memory set archived_at = null, updated_at = now() \
         where account_id = $1::uuid and slug = $2",
    )
    .bind(owner)
    .bind(slug)
    .execute(&mut *tx)
    .await?;
    tx.commit().await?;
    Ok(Unarchived::Ok)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn served_are_in_registry() {
        for n in SERVED {
            assert!(super::super::find(n).is_some(), "{n}");
        }
    }

    #[test]
    fn datetime_subset() {
        for ok in [
            "2026-11-16T02:00:00Z",
            "2026-11-16T02:00:00.123Z",
            "2026-11-16T02:00:00.123456+09:00",
        ] {
            assert!(datetime_ok(ok), "{ok}");
        }
        for no in [
            "2026-11-16",
            "2026-11-16T02:00:00",
            "2026-13-16T02:00:00Z",
            "2026-11-16T24:00:00Z",
            "2026-11-16T02:00:00+0900",
            " 2026-11-16T02:00:00Z",
        ] {
            assert!(!datetime_ok(no), "{no}");
        }
    }

    /// 상수·문구를 TS 원본과 맞춘다.
    #[test]
    fn texts_follow_ts_source() {
        let shared = include_str!("../../../../../packages/shared/src/index.ts");
        assert!(SLUG_HINT.starts_with("slug must be \"core\" or \"mem/<name>\" (segments"));
        assert!(shared.contains("export const MAX_MEMORY_ITEMS_PER_ACCOUNT = 200;"));
    }
}
