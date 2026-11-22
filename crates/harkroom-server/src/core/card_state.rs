//! 권한 카드 상태의 한 정본 — `permission_request.status` 칸.
//!
//! 카드 글 `meta.permissionRequest.status`·`meta.ask.closedReason` 은 그 칸을 따라 쓰는 사본이다(읽어서 판정하지 않는다).
//! 결정 길(승인·거절·카드·거울·대화 승인)은 요청 줄을 잠근 뒤 이 모듈의 [`terminal_refusal`] 하나로 「끝난 상태 → 호출자에게
//! 돌려줄 거절」을 정한다. 누가 먼저 끝냈는지(만료 sweep 이 먼저 돌았나, 결정이 만료를 만났나)에 따라 답이 달라지지 않게 한다.
//!
//! 사본을 끝난 상태로 옮기는 쓰기도 여기 [`close_card_copy`] 하나다(만료 sweep·대체·머지 닫힘이 같이 쓴다). 사본은 열린
//! 상태에서만 끝난 상태로 간다 — 먼저 쓴 쪽이 남고, 다시 불러도 바뀌지 않는다. 예외는 하나다: 만료된 사본은 대체가
//! 덮는다(에이전트가 다시 청했으면 옛 카드는 새 카드를 가리킨다 — 만료 sweep 과 대체 중 누가 먼저 돌았든 같은 끝).
//!
//! 이 모듈은 누가 결정할 수 있는지 보지 않는다 — 끝난 카드는 언제나 거절(409)이다.
use serde_json::{Value, json};
use sqlx::PgConnection;

/// TS `request_expired` 문구(골든).
pub const REQUEST_EXPIRED_MESSAGE: &str = "this request expired — the agent has to ask again";

/// 끝난 카드에 대한 거절 한 줄.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Terminal {
    pub status: u16,
    pub code: &'static str,
    pub message: String,
}

fn terminal(code: &'static str, message: impl Into<String>) -> Terminal {
    Terminal {
        status: 409,
        code,
        message: message.into(),
    }
}

/// 정본 상태(`permission_request.status`) → 결정 요청에 돌려줄 거절. `pending` 이면 `None`(아직 정할 수 있다 — 시한은 호출자가 본다).
///
/// - `expired` 는 `request_expired` 다. 시한이 지난 `pending` 을 결정이 만났을 때와 같은 답이다(sweep 이 먼저 돌았어도 같다).
/// - 모르는 상태는 정할 수 없는 쪽으로 닫는다(`already_decided`).
pub fn terminal_refusal(status: &str) -> Option<Terminal> {
    Some(match status {
        "pending" => return None,
        "obsolete" => terminal(
            "pr_closed",
            "that pull request was already merged or closed — this card is closed",
        ),
        "superseded" => terminal(
            "superseded",
            "the agent asked again — decide on the newer card",
        ),
        "expired" => terminal("request_expired", REQUEST_EXPIRED_MESSAGE),
        s => terminal("already_decided", format!("this request is already {s}")),
    })
}

/// 카드·거울 길이 바깥에 내는 코드. 원본 카드 길은 `already_decided`·`request_expired` 를, 거울 길은 TS `messageRoutes.ts`
/// 대로 `already_decided` 만 `already_answered` 로 바꾼다.
pub fn card_route_code(via_mirror: bool, code: &str) -> &str {
    match code {
        "already_decided" => "already_answered",
        "request_expired" if !via_mirror => "already_answered",
        c => c,
    }
}

/// 요청 줄의 상태 → 「왜 지금 권한이 없나」의 이유 코드(`grant` 읽기 쪽 답). 요청 상태로 정해지지 않으면 `None`
/// (승인된 뒤의 사정은 호출자가 본다). `past_deadline` 은 시한이 지난 `pending` 인지 — `expired` 와 같은 답이다.
pub fn request_reason(status: &str, past_deadline: bool) -> Option<&'static str> {
    Some(match status {
        "pending" if past_deadline => "request_expired",
        "pending" => "request_pending",
        "denied" => "request_denied",
        "expired" => "request_expired",
        "obsolete" => "request_closed",
        "approved_once" => "approved_once",
        _ => return None,
    })
}

/// 카드 사본을 어느 끝난 상태로 닫는가.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum CardClose<'a> {
    /// 시한이 지났다(만료 sweep).
    Expired,
    /// 에이전트가 다시 물었다 — 새 요청·새 카드로 대체.
    Superseded {
        new_request: &'a str,
        new_card: &'a str,
    },
    /// 그 PR 이 이미 머지·닫힘(`reason`). `actor` 가 닫았다.
    Obsolete { reason: &'a str, actor: &'a str },
}

impl CardClose<'_> {
    /// 정본 상태 이름(`permission_request.status`).
    pub fn status(&self) -> &'static str {
        match self {
            CardClose::Expired => "expired",
            CardClose::Superseded { .. } => "superseded",
            CardClose::Obsolete { .. } => "obsolete",
        }
    }

    /// `meta.permissionRequest` 에 덧붙일 조각.
    pub fn status_patch(&self, at: &str) -> Value {
        match self {
            CardClose::Expired => json!({ "status": "expired", "decidedAt": at }),
            CardClose::Superseded { new_request, .. } => {
                json!({ "status": "superseded", "supersededBy": new_request, "decidedAt": at })
            }
            CardClose::Obsolete { reason, .. } => {
                json!({ "status": "obsolete", "obsoleteReason": reason, "decidedAt": at })
            }
        }
    }

    /// `meta.ask` 에 덧붙일 조각.
    pub fn ask_patch(&self, at: &str) -> Value {
        match self {
            CardClose::Expired => json!({ "closedAt": at, "closedReason": "expired" }),
            CardClose::Superseded { new_card, .. } => {
                json!({ "closedAt": at, "closedReason": "superseded", "supersededBy": new_card })
            }
            CardClose::Obsolete { actor, .. } => json!({ "closedAt": at, "closedBy": actor }),
        }
    }
}

impl CardClose<'_> {
    /// 사본 상태 칸을 옮기는 문장.
    fn status_sql(&self) -> &'static str {
        match self {
            CardClose::Superseded { .. } => SUPERSEDE_STATUS_COPY_SQL,
            _ => CLOSE_STATUS_COPY_SQL,
        }
    }

    /// 선택 카드를 닫는 문장.
    fn ask_sql(&self) -> &'static str {
        match self {
            CardClose::Superseded { .. } => SUPERSEDE_ASK_COPY_SQL,
            _ => CLOSE_ASK_COPY_SQL,
        }
    }
}

/// [`close_card_copy`] 가 실제로 바꾼 것.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
pub struct CardClosed {
    /// `meta.permissionRequest.status` 를 열린 상태에서 끝난 상태로 옮겼다.
    pub status_written: bool,
    /// 열린(답·닫힘 없는) 선택 카드를 닫았다.
    pub ask_closed: bool,
}

impl CardClosed {
    pub fn changed(&self) -> bool {
        self.status_written || self.ask_closed
    }
}

/// 사본 상태 칸 — 아직 열린(`pending` 이거나 칸이 없는) 사본만 옮긴다.
pub const CLOSE_STATUS_COPY_SQL: &str = "update message set meta = jsonb_set(meta, '{permissionRequest}', (meta->'permissionRequest') || $2::jsonb)      where id = $1::uuid and meta ? 'permissionRequest'        and coalesce(meta->'permissionRequest'->>'status', 'pending') = 'pending'";

/// 선택 카드 닫기 — 답도 닫힘도 없는 카드만.
pub const CLOSE_ASK_COPY_SQL: &str = "update message set meta = jsonb_set(meta, '{ask}', (meta->'ask') || $2::jsonb)      where id = $1::uuid and meta ? 'ask' and meta->'ask'->>'closedAt' is null and meta->'ask'->'answeredWith' is null";

/// 대체의 사본 상태 칸 — 열린 사본과 만료된 사본을 옮긴다(다른 끝난 상태는 그대로).
pub const SUPERSEDE_STATUS_COPY_SQL: &str = "update message set meta = jsonb_set(meta, '{permissionRequest}', (meta->'permissionRequest') || $2::jsonb)      where id = $1::uuid and meta ? 'permissionRequest'        and coalesce(meta->'permissionRequest'->>'status', 'pending') in ('pending', 'expired')";

/// 대체의 선택 카드 닫기 — 답이 없고, 열려 있거나 만료로 닫힌 카드만(사람이 닫은 카드는 그대로).
pub const SUPERSEDE_ASK_COPY_SQL: &str = "update message set meta = jsonb_set(meta, '{ask}', (meta->'ask') || $2::jsonb)      where id = $1::uuid and meta ? 'ask' and meta->'ask'->'answeredWith' is null        and (meta->'ask'->>'closedAt' is null or meta->'ask'->>'closedReason' = 'expired')";

/// 카드 글의 사본을 끝난 상태로 닫는다. 요청 줄을 옮긴 쪽이 **같은 연결(tx)** 로 부른다 — 이 함수는 요청 줄을 건드리지 않는다.
///
/// - `copy_status` 가 참이면 `meta.permissionRequest` 에 상태를 적는다(요청 줄을 이 호출자가 그 상태로 옮겼을 때만 참으로 준다).
/// - 열린 선택 카드면 `meta.ask` 를 닫는다.
/// - 둘 다 열린 사본만 옮긴다 — 이미 끝난 사본은 그대로 두고 `false` 를 돌려준다(다시 불러도 같다).
///   [`CardClose::Superseded`] 만 만료된 사본도 옮긴다.
pub async fn close_card_copy(
    conn: &mut PgConnection,
    card_id: &str,
    close: CardClose<'_>,
    at: &str,
    copy_status: bool,
) -> sqlx::Result<CardClosed> {
    let mut out = CardClosed::default();
    if copy_status {
        out.status_written = sqlx::query(close.status_sql())
            .bind(card_id)
            .bind(close.status_patch(at).to_string())
            .execute(&mut *conn)
            .await?
            .rows_affected()
            > 0;
    }
    out.ask_closed = sqlx::query(close.ask_sql())
        .bind(card_id)
        .bind(close.ask_patch(at).to_string())
        .execute(&mut *conn)
        .await?
        .rows_affected()
        > 0;
    Ok(out)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn code(status: &str) -> Option<&'static str> {
        terminal_refusal(status).map(|t| t.code)
    }

    /// 끝난 상태마다 답이 하나로 박혀 있다.
    #[test]
    fn each_terminal_state_has_one_answer() {
        assert_eq!(code("pending"), None);
        assert_eq!(code("obsolete"), Some("pr_closed"));
        assert_eq!(code("superseded"), Some("superseded"));
        assert_eq!(code("expired"), Some("request_expired"));
        for s in ["granted", "approved_once", "denied"] {
            assert_eq!(code(s), Some("already_decided"), "{s}");
            assert_eq!(
                terminal_refusal(s).map(|t| t.message),
                Some(format!("this request is already {s}"))
            );
        }
        // 모르는 상태도 거절이다(열리지 않는다).
        assert_eq!(code("something_new"), Some("already_decided"));
        assert_eq!(code(""), Some("already_decided"));
    }

    /// 만료는 「이미 정해졌다」가 아니다 — sweep 이 먼저 돌았어도 결정이 만료를 만났을 때와 같은 코드·문구.
    #[test]
    fn expired_is_not_already_decided() {
        let t = terminal_refusal("expired").unwrap();
        assert_eq!(t.status, 409);
        assert_eq!(t.code, "request_expired");
        assert_eq!(t.message, REQUEST_EXPIRED_MESSAGE);
    }

    /// 끝난 상태는 모두 409 — 어느 것도 통과시키지 않는다.
    #[test]
    fn every_terminal_state_is_a_conflict() {
        for s in [
            "obsolete",
            "superseded",
            "expired",
            "granted",
            "approved_once",
            "denied",
            "x",
        ] {
            assert_eq!(terminal_refusal(s).map(|t| t.status), Some(409), "{s}");
        }
    }

    /// 닫기 문장은 열린 사본만 옮긴다.
    #[test]
    fn close_sql_only_moves_open_copies() {
        assert!(CLOSE_STATUS_COPY_SQL.contains("meta ? 'permissionRequest'"));
        assert!(CLOSE_STATUS_COPY_SQL.contains("= 'pending'"));
        assert!(CLOSE_ASK_COPY_SQL.contains("meta->'ask'->>'closedAt' is null"));
        assert!(CLOSE_ASK_COPY_SQL.contains("meta->'ask'->'answeredWith' is null"));
    }

    /// 대체만 만료된 사본을 덮는다 — 답이 달렸거나 사람이 닫은 카드, 다른 끝난 상태는 건드리지 않는다.
    #[test]
    fn supersede_sql_also_moves_expired_copies() {
        assert!(SUPERSEDE_STATUS_COPY_SQL.contains("in ('pending', 'expired')"));
        assert!(SUPERSEDE_ASK_COPY_SQL.contains("meta->'ask'->'answeredWith' is null"));
        assert!(SUPERSEDE_ASK_COPY_SQL.contains(
            "(meta->'ask'->>'closedAt' is null or meta->'ask'->>'closedReason' = 'expired')"
        ));
        let s = CardClose::Superseded {
            new_request: "r",
            new_card: "c",
        };
        assert_eq!(s.status_sql(), SUPERSEDE_STATUS_COPY_SQL);
        assert_eq!(s.ask_sql(), SUPERSEDE_ASK_COPY_SQL);
        for c in [
            CardClose::Expired,
            CardClose::Obsolete {
                reason: "merged",
                actor: "a",
            },
        ] {
            assert_eq!(c.status_sql(), CLOSE_STATUS_COPY_SQL);
            assert_eq!(c.ask_sql(), CLOSE_ASK_COPY_SQL);
        }
    }

    #[test]
    fn close_patches() {
        let s = CardClose::Superseded {
            new_request: "r",
            new_card: "c",
        };
        assert_eq!(s.status(), "superseded");
        assert_eq!(
            s.status_patch("t"),
            json!({ "status": "superseded", "supersededBy": "r", "decidedAt": "t" })
        );
        assert_eq!(
            s.ask_patch("t"),
            json!({ "closedAt": "t", "closedReason": "superseded", "supersededBy": "c" })
        );
        assert_eq!(
            CardClose::Expired.status_patch("t"),
            json!({ "status": "expired", "decidedAt": "t" })
        );
        assert_eq!(
            CardClose::Expired.ask_patch("t"),
            json!({ "closedAt": "t", "closedReason": "expired" })
        );
        let o = CardClose::Obsolete {
            reason: "merged",
            actor: "a",
        };
        assert_eq!(
            o.status_patch("t"),
            json!({ "status": "obsolete", "obsoleteReason": "merged", "decidedAt": "t" })
        );
        assert_eq!(
            o.ask_patch("t"),
            json!({ "closedAt": "t", "closedBy": "a" })
        );
    }

    #[test]
    fn request_reasons() {
        assert_eq!(request_reason("pending", true), Some("request_expired"));
        assert_eq!(request_reason("pending", false), Some("request_pending"));
        assert_eq!(request_reason("denied", false), Some("request_denied"));
        assert_eq!(request_reason("expired", false), Some("request_expired"));
        assert_eq!(request_reason("obsolete", false), Some("request_closed"));
        assert_eq!(
            request_reason("approved_once", false),
            Some("approved_once")
        );
        assert_eq!(request_reason("granted", false), None);
    }

    #[test]
    fn card_route_codes() {
        assert_eq!(
            card_route_code(false, "already_decided"),
            "already_answered"
        );
        assert_eq!(
            card_route_code(false, "request_expired"),
            "already_answered"
        );
        assert_eq!(card_route_code(true, "already_decided"), "already_answered");
        assert_eq!(card_route_code(true, "request_expired"), "request_expired");
        assert_eq!(card_route_code(true, "superseded"), "superseded");
        assert_eq!(card_route_code(false, "pr_closed"), "pr_closed");
    }
}
