//! S5.4 A2a — `workitem.remove`(TS mcpPlugin.ts `workitem.remove` → services/workItems.ts `removeWorkItem`).
//!
//! 주인 판정·가시성 술어는 REST `DELETE /work-items/{id}`(`writes_misc.rs`)와 같은 것을 쓴다. 다른 것은 키뿐이다 — 여기는
//! `(source, externalKey)` 로 지운다. 범위 밖(남의 보드·주인이 아닌 쪽이 못 보는 스레드)은 없는 것과 같은 `removed: false` 다.
//! 지우면 같은 트랜잭션에서 주인에게 `inbox.updated` 를 낸다(TS 는 커밋 뒤 `emitEvent` — outbox 라 커밋된 뒤에만 보인다).
use super::tools::err;
use crate::auth::Account;
use crate::write::emit_event;
use crate::writes_misc::{NO_OWNER, WORK_ITEM_SOURCES, actor_sees, work_item_owner};
use serde_json::{Value, json};
use sqlx::PgPool;
use std::sync::OnceLock;

/// `workitem.remove` 쓰기 역할의 권한. 하나라도 없으면 `main.rs` 가 풀을 비워 TS 가 답한다.
pub const WORK_ITEM_REMOVE_PRIVILEGES: &[(&str, &str)] = &[
    ("work_item", "DELETE"),
    ("work_item", "SELECT"),
    ("event_outbox", "INSERT"),
];
pub const WORK_ITEM_REMOVE_SEQUENCES: &[(&str, &str)] = &[("event_outbox_id_seq", "USAGE")];

/// zod `externalKey: z.string().trim().min(1).max(300)`. JS `trim` 이 지우는 글자 가운데 Rust `trim` 이 안 지우는 것(U+FEFF)이
/// 끝에 있으면 같은 값을 낼 수 없으니 `None`(→ TS).
pub fn parse_remove(args: &Value) -> Option<(&str, &str)> {
    let source = args.get("source")?.as_str()?;
    if !WORK_ITEM_SOURCES.contains(&source) {
        return None;
    }
    let raw = args.get("externalKey")?.as_str()?;
    let key = raw.trim();
    if key.starts_with('\u{feff}') || key.ends_with('\u{feff}') {
        return None;
    }
    let n = key.encode_utf16().count();
    if !(1..=300).contains(&n) {
        return None;
    }
    Some((source, key))
}

fn remove_sql() -> &'static str {
    static S: OnceLock<String> = OnceLock::new();
    S.get_or_init(|| {
        format!(
            "delete from work_item w where w.owner_account_id = $1::uuid and w.source = $3::text \
               and w.external_key = $4::text and ($2::uuid = $1::uuid or {})",
            actor_sees()
        )
    })
}

/// 인자가 zod 를 못 지나면 `None`(TS 가 같은 검증 오류를 낸다). 쓰기 전 DB 오류도 `None`.
pub async fn remove(read: &PgPool, write: &PgPool, me: &Account, args: &Value) -> Option<String> {
    let (source, key) = parse_remove(args)?;
    let owner = match work_item_owner(read, me).await.ok()? {
        Some(o) => o,
        None => return Some(err("no_owner", NO_OWNER)),
    };
    let mut tx = write.begin().await.ok()?;
    let n = sqlx::query(remove_sql())
        .bind(&owner)
        .bind(&me.id)
        .bind(source)
        .bind(key)
        .execute(&mut *tx)
        .await
        .ok()?
        .rows_affected();
    if n > 0 {
        emit_event(
            &mut tx,
            &json!({ "type": "inbox.updated", "accountId": owner }),
        )
        .await
        .ok()?;
    }
    tx.commit().await.ok()?;
    Some(super::respond::text_result(&format!(
        "{{\"removed\":{}}}",
        n > 0
    )))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parse_remove_like_zod() {
        let ok = json!({"source": "github", "externalKey": "  acme/x#1 ", "extra": 1});
        assert_eq!(parse_remove(&ok), Some(("github", "acme/x#1")));
        assert_eq!(
            parse_remove(&json!({"source": "gitlab", "externalKey": "a"})),
            None
        );
        assert_eq!(
            parse_remove(&json!({"source": "jira", "externalKey": "   "})),
            None
        );
        assert_eq!(parse_remove(&json!({"source": "jira"})), None);
        assert_eq!(
            parse_remove(&json!({"source": "jira", "externalKey": "a".repeat(301)})),
            None
        );
        assert!(parse_remove(&json!({"source": "jira", "externalKey": "a".repeat(300)})).is_some());
        assert_eq!(
            parse_remove(&json!({"source": "jira", "externalKey": "\u{feff}a"})),
            None
        );
    }
}
