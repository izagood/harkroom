//! S5.3 C1b-1a — 메시지 읽기. 지금은 `GET /messages/{id}`(링크가 가리키는 메시지 하나, TS `messageRoutes.ts`)만 옮긴다.
//! `GET /channels/{id}/messages`(목록·계획판 진행률)는 C1b-1b 몫이다.
//!
//! - 문장은 TS 정본 `MESSAGE_BY_ID_SQL`(`services/messages.ts`) 그대로 — `golden/sql_fragments.json` 의 `message_by_id` 를 읽는다.
//!   TS 가 칸을 고치면 `rustSqlFragments.test.ts` 가 골든 갱신을 요구하므로 Rust 만 옛 칸을 내는 일이 없다.
//! - 응답 JSON 은 Postgres 가 만든다(`row_to_json`, 칸 순서 = 열 순서). node-pg 가 `Date` 로 읽어 `toISOString()` 으로 내는 것은
//!   **맨 겉의 timestamptz 열**(`createdAt`·`editedAt`·`deletedAt`)뿐이라 그 셋만 [`crate::iso!`] 꼴로 바꾼다. 리액션·첨부·상태 리액션
//!   안의 시각과 `::text` 열(`lastReplyAt`)은 json 값이라 TS 도 PG 꼴 그대로 낸다.
//! - 순서가 규칙이다(TS 와 같다): 인증(401) → id 검사(400) → 읽기(지운 것·없는 것 404) → 그 채널을 볼 수 있는지(403, 본문 없음).
use crate::auth::RequireAccount;
use crate::directory::{internal, json_err, json_ok};
use axum::extract::{Path, State};
use axum::http::StatusCode;
use axum::response::Response;
use serde_json::Value;
use sqlx::PgPool;
use std::sync::{Arc, OnceLock};

struct Sql {
    by_id: String,
    visible: String,
}

fn sql() -> &'static Sql {
    static S: OnceLock<Sql> = OnceLock::new();
    S.get_or_init(|| {
        let v: Value = serde_json::from_str(include_str!("../../golden/sql_fragments.json"))
            .expect("golden/sql_fragments.json");
        let frag = |k: &str| {
            v[k].as_str()
                .unwrap_or_else(|| panic!("golden fragment {k}"))
                .to_string()
        };
        // 맨 겉 키만 순서대로 다시 모은다(json_each 는 json 의 순서를 지킨다). 시각 셋만 toISOString 꼴로.
        let by_id = format!(
            "with t as ({}) select json_object_agg(e.key, case e.key \
               when 'createdAt' then to_json({}) \
               when 'editedAt' then to_json({}) \
               when 'deletedAt' then to_json({}) \
               else e.value end order by e.ord)::text \
             from t, json_each(row_to_json(t)) with ordinality as e(key, value, ord) group by t.id",
            frag("message_by_id"),
            crate::iso!("t.\"createdAt\""),
            crate::iso!("t.\"editedAt\""),
            crate::iso!("t.\"deletedAt\""),
        );
        // TS `assertChannelVisible` — 술어는 TS 골든(`channelVisibleSql('c', '$1::uuid')`).
        let visible = format!(
            "select {} as visible from channel c where c.id = $2::uuid",
            frag("channel_visible_c_p1uuid")
        );
        Sql { by_id, visible }
    })
}

/// zod `z.string().uuid()`(3.x) 와 같은 판정 — 8-4-4-4-12 의 16진수, 대소문자 무관.
fn is_uuid(s: &str) -> bool {
    let b = s.as_bytes();
    b.len() == 36
        && b.iter().enumerate().all(|(i, c)| match i {
            8 | 13 | 18 | 23 => *c == b'-',
            _ => c.is_ascii_hexdigit(),
        })
}

/// `GET /messages/{id}`.
pub async fn get_message(
    State(pool): State<Arc<PgPool>>,
    RequireAccount(me, _): RequireAccount,
    Path(id): Path<String>,
) -> Response {
    if !is_uuid(&id) {
        // 문구는 TS(zod 오류 JSON)와 다르다 — 대조는 상태·코드만 본다(`lists.rs` 와 같은 약속).
        return json_err(
            StatusCode::BAD_REQUEST,
            "invalid_request",
            "id: invalid uuid",
        );
    }
    let s = sql();
    let row: Option<String> = match sqlx::query_scalar(s.by_id.as_str())
        .bind(&id)
        .fetch_optional(pool.as_ref())
        .await
    {
        Ok(r) => r,
        Err(e) => return internal(e),
    };
    // 지워진 메시지도 404 — 문장이 `deleted_at is null` 로 거른다. 본문을 주면 삭제가 삭제가 아니다.
    let Some(body) = row else {
        return json_err(StatusCode::NOT_FOUND, "not_found", "no such message");
    };
    let channel: String = match serde_json::from_str::<Value>(&body)
        .ok()
        .and_then(|v| v["channelId"].as_str().map(str::to_string))
    {
        Some(c) => c,
        None => {
            return json_err(
                StatusCode::INTERNAL_SERVER_ERROR,
                "internal",
                "internal error",
            );
        }
    };
    // 없는 채널은 막지 않는다(TS 와 같다) — 메시지의 채널은 FK 라 실제로는 늘 있다.
    let visible: Option<bool> = match sqlx::query_scalar(s.visible.as_str())
        .bind(&me.id)
        .bind(&channel)
        .fetch_optional(pool.as_ref())
        .await
    {
        Ok(v) => v,
        Err(e) => return internal(e),
    };
    if visible == Some(false) {
        return json_err(
            StatusCode::FORBIDDEN,
            "forbidden",
            "not a member of this dm channel",
        );
    }
    json_ok(body)
}

/// 코어 라우터에 합칠 줄(`route_table.rs`). 인증 층은 메서드 안(`route_layer`), CORS 는 바깥(`layer`) — `ws.rs` 와 같은 길.
pub fn routes(
    pool: PgPool,
    auth: crate::auth::AuthPools,
    cors: Arc<crate::cors::Cors>,
) -> crate::route_table::Routes<()> {
    use crate::route_table::Table;
    let t = Table::<Arc<PgPool>>::new()
        .get("/messages/{id}", get_message)
        .map(|r| {
            r.route_layer(axum::middleware::from_fn_with_state(
                auth,
                crate::auth::layer,
            ))
            .layer(axum::middleware::from_fn_with_state(
                cors,
                crate::cors::layer,
            ))
        })
        .finish();
    crate::route_table::Routes {
        router: t.router.with_state(Arc::new(pool)),
        http: t.http,
        sockets: t.sockets,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn golden_sql_loads() {
        let s = sql();
        assert!(
            s.by_id
                .contains("from message where id = $1::uuid and deleted_at is null")
        );
        assert!(s.visible.contains("cm_vis.account_id = $1::uuid"));
    }

    #[test]
    fn uuid_like_zod() {
        assert!(is_uuid("0f8fad5b-d9cb-469f-a165-70867728950e"));
        assert!(is_uuid("0F8FAD5B-D9CB-469F-A165-70867728950E"));
        assert!(!is_uuid("0f8fad5bd9cb469fa16570867728950e"));
        assert!(!is_uuid("not-a-uuid"));
    }
}
