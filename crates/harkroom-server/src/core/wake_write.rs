//! 깨움 행 같이 쓰기(EA) — 에이전트 `inbox` 줄을 넣는 자리가 **같은 트랜잭션**에서 `wake` 행(181)도 쓴다.
//!
//! - 스위치 `HARKROOM_WAKE_WRITE`(`off`(기본) | `on`). 꺼져 있으면 이 모듈은 아무 문장도 돌지 않는다. 정본은 여전히 `inbox` 이고
//!   `wake` 를 읽어 판단하는 경로는 없다 — 켜도 턴·알림·판정은 달라지지 않는다.
//! - 행 모양과 중복 방지 키는 거울 루프([`crate::loops::wake_mirror`])와 같다: inbox 행 하나 = `wake.inbox_id` 하나
//!   (`on conflict (inbox_id) do nothing`). 여기서 먼저 쓴 줄은 거울이 다시 넣지 않고, 여기서 빠뜨린 줄은 거울이 뒤늦게 채운다.
//!   거울과 다른 점은 `work_id` 하나다 — 그 스레드에서 그 에이전트가 맡은 열린 작업 가운데 가장 새것을 적는다(없으면 빈다).
//! - 열쇠는 (글, 계정들)이다. inbox 줄을 어떤 문장으로 넣었든(골든 문장 포함) 그 뒤에 [`along`] 한 번이면 된다 —
//!   그 글·그 계정의 inbox 줄 가운데 아직 깨움이 없는 것을 모두 옮기고, 사유가 바뀐 줄(위임 줄 바꿔 적기)은 사유를 맞춘다.
//! - **부른 쪽 트랜잭션을 깨지 않는다.** savepoint 안에서 돌고, 실패하면 그 savepoint 만 되돌린 뒤 오류 종류만 적는다
//!   (inbox 줄은 그대로 남는다 — 거울이 채운다). 트랜잭션 밖에서 불리면 savepoint 가 거절되어 아무것도 쓰지 않는다.
//! - 읽음: inbox 줄을 읽음으로 바꾸는 자리는 [`READ_CLOSE_SQL`] 한 문장으로 깨움도 같이 닫는다([`mark_read`]).
//!   실패하면 옛 문장으로 다시 한다 — 읽음 처리는 스위치 때문에 실패하지 않는다.
use sqlx::{PgConnection, PgPool};
use std::sync::atomic::{AtomicBool, Ordering};

/// 스위치 환경 변수.
pub const SWITCH_ENV: &str = "HARKROOM_WAKE_WRITE";

/// 같이 쓰기가 쓰는 권한(표, 권한) — 없으면 `main.rs` 가 켜지 않는다.
pub const WAKE_WRITE_PRIVILEGES: &[(&str, &str)] = &[
    ("wake", "SELECT"),
    ("wake", "INSERT"),
    ("wake", "UPDATE"),
    ("inbox", "SELECT"),
    ("account", "SELECT"),
    ("message", "SELECT"),
    ("work", "SELECT"),
];

static ON: AtomicBool = AtomicBool::new(false);

/// 스위치 글자를 읽는다 — `on` 만 켬이다. 없거나 모르는 값이면 꺼짐(기본). 앞뒤 공백·대소문자는 가리지 않는다.
pub fn parse_switch(raw: Option<&str>) -> bool {
    raw.map(|v| v.trim().to_ascii_lowercase()).as_deref() == Some("on")
}

/// 환경 변수 [`SWITCH_ENV`] 에서 읽는다.
pub fn switch_from_env() -> bool {
    parse_switch(std::env::var(SWITCH_ENV).ok().as_deref())
}

/// 같이 쓰기를 켠다(프로세스에 한 번, `main.rs` 가 권한을 본 뒤).
pub fn enable() {
    ON.store(true, Ordering::Relaxed);
}

/// 켜져 있나.
pub fn enabled() -> bool {
    ON.load(Ordering::Relaxed)
}

/// 글 `$1` 로 계정들 `$2` 에게 간 에이전트 inbox 줄 가운데 아직 깨움이 없는 것을 옮긴다. 거울 문장과 같은 모양 + `work_id`.
pub const ALONG_SQL: &str = "insert into wake (account_id, message_id, channel_id, thread_root_id, work_id, reason, inbox_id, created_at) \
     select i.account_id, i.message_id, m.channel_id, coalesce(m.thread_root_id, m.id), \
            (select k.id from work k \
              where k.thread_root_id = coalesce(m.thread_root_id, m.id) \
                and k.assignee_account_id = i.account_id and k.closed_at is null \
              order by k.created_at desc, k.id desc limit 1), \
            i.reason, i.id, i.created_at \
       from inbox i \
       join account a on a.id = i.account_id and a.kind = 'agent' \
       join message m on m.id = i.message_id \
      where i.message_id = $1::uuid and i.account_id = any($2::uuid[]) \
        and not exists (select 1 from wake w where w.inbox_id = i.id) \
     on conflict (inbox_id) do nothing";

/// 같은 열쇠의 inbox 줄이 사유를 바꿨으면(위임 줄 바꿔 적기) 열린 깨움의 사유를 맞춘다.
pub const REASON_SQL: &str = "update wake w set reason = i.reason \
       from inbox i \
      where i.id = w.inbox_id and i.message_id = $1::uuid and i.account_id = any($2::uuid[]) \
        and w.reason <> i.reason and w.state in ('pending', 'delivered')";

/// 읽음 + 닫기 한 문장 — 계정 `$1` 의 inbox 줄 `$2` 를 읽음으로 바꾸고, 그 줄의 열린 깨움을 `done` 으로 닫는다.
/// 돌려주는 수는 읽음으로 바뀐 inbox 줄 수다(옛 문장의 `rows_affected` 와 같다).
pub const READ_CLOSE_SQL: &str = "with r as (\
       update inbox set read_at = now() \
        where account_id = $1::uuid and id = any($2::bigint[]) and read_at is null \
       returning id, read_at), \
     c as (\
       update wake w set state = 'done', closed_at = r.read_at \
         from r where w.inbox_id = r.id and w.state in ('pending', 'delivered') \
       returning 1) \
     select (select count(*) from r)::int8, (select count(*) from c)::int8";

/// 옛 읽음 문장(스위치가 꺼져 있을 때, 그리고 [`READ_CLOSE_SQL`] 이 실패했을 때).
pub const READ_SQL: &str = "update inbox set read_at = now() where account_id = $1::uuid and id = any($2::bigint[]) and read_at is null";

async fn along_inner(
    conn: &mut PgConnection,
    message_id: &str,
    accounts: &[String],
) -> Result<(), sqlx::Error> {
    sqlx::query(ALONG_SQL)
        .bind(message_id)
        .bind(accounts)
        .execute(&mut *conn)
        .await?;
    sqlx::query(REASON_SQL)
        .bind(message_id)
        .bind(accounts)
        .execute(&mut *conn)
        .await?;
    Ok(())
}

/// inbox 줄을 넣은(또는 사유를 바꿔 적은) 직후, 같은 트랜잭션에서 부른다. 꺼져 있으면 아무것도 하지 않는다. 던지지 않는다.
pub async fn along(conn: &mut PgConnection, message_id: &str, accounts: &[String]) {
    if !enabled() || accounts.is_empty() {
        return;
    }
    write_now(conn, message_id, accounts).await;
}

/// [`along`] 의 몸 — 스위치를 보지 않는다(시험이 직접 부른다).
pub async fn write_now(conn: &mut PgConnection, message_id: &str, accounts: &[String]) {
    if let Err(e) = sqlx::query("savepoint wake_write")
        .execute(&mut *conn)
        .await
    {
        eprintln!("wake_write: skipped ({})", kind_of(&e));
        return;
    }
    if let Err(e) = along_inner(conn, message_id, accounts).await {
        eprintln!("wake_write: failed ({})", kind_of(&e));
        if sqlx::query("rollback to savepoint wake_write")
            .execute(&mut *conn)
            .await
            .is_err()
        {
            return;
        }
    }
    let _ = sqlx::query("release savepoint wake_write")
        .execute(&mut *conn)
        .await;
}

/// [`along`] 의 계정 하나짜리.
pub async fn along_one(conn: &mut PgConnection, message_id: &str, account: &str) {
    if !enabled() {
        return;
    }
    write_now(conn, message_id, &[account.to_owned()]).await;
}

/// 자기 inbox 줄을 읽음으로 — 켜져 있으면 깨움도 같은 문장에서 닫는다. 돌려주는 수는 읽음으로 바뀐 inbox 줄 수.
/// 같이 닫는 문장이 실패하면 옛 문장으로 다시 한다(한 문장이라 실패하면 아무것도 안 바뀐 상태다).
pub async fn mark_read(pool: &PgPool, account: &str, ids: &[i64]) -> Result<u64, sqlx::Error> {
    if enabled() {
        match read_close(pool, account, ids).await {
            Ok(n) => return Ok(n),
            Err(e) => eprintln!("wake_write: read close failed ({})", kind_of(&e)),
        }
    }
    Ok(sqlx::query(READ_SQL)
        .bind(account)
        .bind(ids)
        .execute(pool)
        .await?
        .rows_affected())
}

/// [`READ_CLOSE_SQL`] 을 돈다 — 스위치를 보지 않는다(시험이 직접 부른다).
pub async fn read_close(pool: &PgPool, account: &str, ids: &[i64]) -> Result<u64, sqlx::Error> {
    let (read, _closed): (i64, i64) = sqlx::query_as(READ_CLOSE_SQL)
        .bind(account)
        .bind(ids)
        .fetch_one(pool)
        .await?;
    Ok(u64::try_from(read).unwrap_or(0))
}

/// 오류 종류만(행 내용·문장 없음).
fn kind_of(e: &sqlx::Error) -> &'static str {
    if e.as_database_error().is_some() {
        "db"
    } else {
        "io"
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::loops::wake_mirror::MIRROR_SQL;

    #[test]
    fn switch_is_off_unless_on() {
        assert!(!parse_switch(None));
        assert!(!parse_switch(Some("")));
        assert!(!parse_switch(Some("off")));
        assert!(!parse_switch(Some("shadow")));
        assert!(!parse_switch(Some("1")));
        assert!(parse_switch(Some("on")));
        assert!(parse_switch(Some(" ON ")));
        // 프로세스 기본은 꺼짐이다(`enable` 을 부르는 곳은 `main.rs` 하나).
        assert!(!enabled());
    }

    #[test]
    fn same_shape_and_key_as_mirror() {
        // 거울과 같은 걸러내기·같은 중복 방지 키 — 한 inbox 줄은 어느 쪽이 먼저 쓰든 한 번만 들어간다.
        for part in [
            "join account a on a.id = i.account_id and a.kind = 'agent'",
            "join message m on m.id = i.message_id",
            "coalesce(m.thread_root_id, m.id)",
            "not exists (select 1 from wake w where w.inbox_id = i.id)",
            "on conflict (inbox_id) do nothing",
        ] {
            assert!(ALONG_SQL.contains(part), "{part}");
            assert!(MIRROR_SQL.contains(part), "{part}");
        }
        assert!(ALONG_SQL.ends_with("on conflict (inbox_id) do nothing"));
        assert!(ALONG_SQL.contains("i.reason, i.id, i.created_at"));
    }

    #[test]
    fn along_is_scoped_to_message_and_accounts() {
        assert!(ALONG_SQL.contains("i.message_id = $1::uuid and i.account_id = any($2::uuid[])"));
        assert!(REASON_SQL.contains("i.message_id = $1::uuid and i.account_id = any($2::uuid[])"));
        assert!(REASON_SQL.contains("w.state in ('pending', 'delivered')"));
        // 작업은 그 스레드에서 그 계정이 맡은 열린 것만.
        assert!(ALONG_SQL.contains("k.assignee_account_id = i.account_id and k.closed_at is null"));
    }

    #[test]
    fn read_close_keeps_old_read_semantics() {
        assert!(READ_CLOSE_SQL.contains(
            "where account_id = $1::uuid and id = any($2::bigint[]) and read_at is null"
        ));
        assert!(READ_SQL.ends_with(
            "where account_id = $1::uuid and id = any($2::bigint[]) and read_at is null"
        ));
        assert!(READ_CLOSE_SQL.contains("w.state in ('pending', 'delivered')"));
        assert!(READ_CLOSE_SQL.contains("closed_at = r.read_at"));
    }

    #[test]
    fn privileges_only_write_wake() {
        assert!(
            WAKE_WRITE_PRIVILEGES
                .iter()
                .all(|(t, p)| *t == "wake" || *p == "SELECT")
        );
        assert!(WAKE_WRITE_PRIVILEGES.contains(&("work", "SELECT")));
    }
}
