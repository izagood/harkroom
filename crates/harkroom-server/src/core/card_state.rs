//! 권한 카드 상태의 한 정본 — `permission_request.status` 칸.
//!
//! 카드 글 `meta.permissionRequest.status`·`meta.ask.closedReason` 은 그 칸을 따라 쓰는 사본이다(읽어서 판정하지 않는다).
//! 결정 길(승인·거절·카드·거울·대화 승인)은 요청 줄을 잠근 뒤 이 모듈의 [`terminal_refusal`] 하나로 「끝난 상태 → 호출자에게
//! 돌려줄 거절」을 정한다. 누가 먼저 끝냈는지(만료 sweep 이 먼저 돌았나, 결정이 만료를 만났나)에 따라 답이 달라지지 않게 한다.
//!
//! 이 모듈은 아무것도 쓰지 않고, 누가 결정할 수 있는지도 보지 않는다 — 끝난 카드는 언제나 거절(409)이다.

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
