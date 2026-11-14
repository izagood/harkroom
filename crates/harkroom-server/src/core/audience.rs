//! 받는 사람 계산 — **이벤트 수신자를 정하는 유일한 자리**(TS `services/channels.ts` 의 `audienceFor`·`channelListAudience`·
//! `channelListLostAudience`). S5.3 C1 의 쓰기·채널 라우트와 코어 `/ws` 의 입력 중 알림이 모두 이것만 부른다.
//!
//! 왜 한 곳: TS 에서 같은 계산이 REST·MCP·입력 중에 사본으로 흩어져 있었고, private 채널이 생긴 뒤 사본 하나가
//! 「standard 면 전원」으로 남아 비멤버에게 입력 중 표시를 뿌린 일이 있다(TS `wsPlugin.ts` 주석). Rust 로 옮기며 사본을
//! 다시 만들지 않으려고 여기 모은다.
//!
//! 두 질문은 다르다:
//! - [`audience_for`] — 채널의 **내용**(글·반응·입력 중)을 누가 받나. public standard 면 전원, 그 밖(DM·private)은 멤버만.
//!   admin 예외 없음(목록에서 보는 것과 내용을 읽는 것은 다른 권한).
//! - [`channel_list_audience`]·[`channel_list_lost_audience`] — **사이드바 목록**이 바뀌는 사람. 목록에는 admin 예외가 있다.
//!   술어는 TS `channelListVisibleSql` 의 출력 그대로(`golden/sql_fragments.json` 의 `channel_list_visible_c_aid_aadmin`,
//!   `packages/server/test/rustSqlFragments.test.ts` 가 TS 와 같은지 본다).
//!
//! TS 와 같은 답을 내는지는 `tests/audience.rs` 가 실제 스키마에서 공개·비공개·DM·탈퇴자·admin·없는 채널로 본다
//! (CI `bus-e2e` 의 `rustFrontDb.test.ts` 가 TS 함수의 답과 맞춰 본다). 멤버 목록의 **순서**는 TS 도 정하지 않으므로 비교하지 않는다.
use serde_json::{Value, json};
use sqlx::PgPool;
use std::sync::OnceLock;

/// TS `'all' | string[]`.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Audience {
    All,
    Accounts(Vec<String>),
}

impl Audience {
    /// 이벤트의 `audience` 칸 그대로.
    pub fn to_json(&self) -> Value {
        match self {
            Audience::All => json!("all"),
            Audience::Accounts(ids) => json!(ids),
        }
    }
}

fn fragment(key: &str) -> String {
    let v: Value = serde_json::from_str(include_str!("../../golden/sql_fragments.json"))
        .expect("golden/sql_fragments.json");
    v[key]
        .as_str()
        .unwrap_or_else(|| panic!("golden fragment {key}"))
        .to_owned()
}

/// (kind, visibility) — 없는 채널이면 None.
async fn channel_kind(pool: &PgPool, channel: &str) -> sqlx::Result<Option<(String, String)>> {
    sqlx::query_as("select kind, visibility from channel where id = $1::uuid")
        .bind(channel)
        .fetch_optional(pool)
        .await
}

/// TS `channelVisibleSql` 의 첫 절과 같은 조건 — 전원이 보는 채널인가.
fn is_public_standard(kind: &str, visibility: &str) -> bool {
    kind == "standard" && visibility == "public"
}

/// TS `audienceFor` — 없는 채널은 `All`(그런 채널의 이벤트는 애초에 생기지 않는다, TS 와 같음).
pub async fn audience_for(pool: &PgPool, channel: &str) -> sqlx::Result<Audience> {
    let Some((kind, visibility)) = channel_kind(pool, channel).await? else {
        return Ok(Audience::All);
    };
    if is_public_standard(&kind, &visibility) {
        return Ok(Audience::All);
    }
    let ids: Vec<String> = sqlx::query_scalar(
        "select account_id::text from channel_member where channel_id = $1::uuid",
    )
    .bind(channel)
    .fetch_all(pool)
    .await?;
    Ok(Audience::Accounts(ids))
}

fn list_sql(negate: bool) -> &'static str {
    static YES: OnceLock<String> = OnceLock::new();
    static NO: OnceLock<String> = OnceLock::new();
    let cell = if negate { &NO } else { &YES };
    cell.get_or_init(|| {
        format!(
            "select a.id::text from account a, channel c where c.id = $1::uuid and {}({})",
            if negate { "not " } else { "" },
            fragment("channel_list_visible_c_aid_aadmin")
        )
    })
}

/// TS `channelListAudience` — `channel.created`·`channel.updated`·멤버 들고 남(목록 이벤트)의 수신자.
pub async fn channel_list_audience(pool: &PgPool, channel: &str) -> sqlx::Result<Audience> {
    let Some((kind, visibility)) = channel_kind(pool, channel).await? else {
        return Ok(Audience::All);
    };
    if is_public_standard(&kind, &visibility) {
        return Ok(Audience::All);
    }
    let ids: Vec<String> = sqlx::query_scalar(list_sql(false))
        .bind(channel)
        .fetch_all(pool)
        .await?;
    Ok(Audience::Accounts(ids))
}

/// TS `channelListLostAudience` — 목록에서 **사라진** 계정(`channel.deleted` 수신자, public→private 전환).
pub async fn channel_list_lost_audience(pool: &PgPool, channel: &str) -> sqlx::Result<Vec<String>> {
    sqlx::query_scalar(list_sql(true))
        .bind(channel)
        .fetch_all(pool)
        .await
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn json_shape_matches_ts() {
        assert_eq!(Audience::All.to_json(), json!("all"));
        assert_eq!(Audience::Accounts(vec!["a".into()]).to_json(), json!(["a"]));
    }

    #[test]
    fn list_sql_uses_the_golden_predicate() {
        let yes = list_sql(false);
        let no = list_sql(true);
        assert!(yes.contains("a.is_admin") && yes.contains("cm_vis.account_id = a.id"));
        assert!(no.contains("and not (((c.kind"));
        assert!(!yes.contains("not ("));
    }

    #[test]
    fn public_standard_only() {
        assert!(is_public_standard("standard", "public"));
        assert!(!is_public_standard("standard", "private"));
        assert!(!is_public_standard("dm", "public"), "DM 은 멤버만");
    }
}
