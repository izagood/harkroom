//! 이 턴의 발화를 센다(정본 `prompt.ts` 의 `countOwnPostsSince`·`messageTurnId`·`ownedByTurn`).
//!
//! 세는 규칙은 여기 하나다 — 「발화가 있었나」(> 0: 침묵 통지·커서 전진)와 「여러 번 했나」(> 1: 중복 발화 관측)를 같은 셈에서 묻는다.
//! 메시지 줄은 서버 JSON 그대로(`serde_json::Value`, camelCase 필드)다.

use serde_json::Value;

use crate::prompt::{MESSAGE_KIND_WAKE, NON_UTTERANCE_KINDS};

/// 정본 `ownedByTurn` 의 `use` — 턴 id 가 안 적힌 글을 어떻게 볼지는 틀렸을 때의 해가 달라 묻는 쪽마다 다르다.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum TurnOwnership {
    /// 발화 셈·대기 줄 — 턴 id 가 없는 글은 **이 턴 것으로 친다**(옛 서버가 턴을 안 적는 동안 침묵 통지가 쏟아지지 않게).
    Count,
    /// 앵커 밖 링크 — 턴 id 가 없는 글은 **남의 것으로 친다**(「답은 저기 올렸다」고 단정하는 문구라 모르는 글은 싣지 않는다).
    Link,
}

fn seq(m: &Value) -> i64 {
    m.get("seq")
        .and_then(|v| v.as_i64().or_else(|| v.as_f64().map(|f| f as i64)))
        .unwrap_or(0)
}

/// 정본 `messageTurnId` — 서버가 에이전트 발화에 남기는 `meta.turnId`. 없거나 빈 문자열이면 `None`.
pub fn message_turn_id(m: &Value) -> Option<&str> {
    m.get("meta")
        .and_then(|meta| meta.get("turnId"))
        .and_then(Value::as_str)
        .filter(|t| !t.is_empty())
}

/// 정본 `ownedByTurn` — 이 글이 이 턴의 것인가. `turn_id` 가 없으면(옛 호출자·대화형 턴) 가르지 않는다.
pub fn owned_by_turn(m: &Value, turn_id: Option<&str>, how: TurnOwnership) -> bool {
    let Some(turn_id) = turn_id.filter(|t| !t.is_empty()) else {
        return how == TurnOwnership::Count;
    };
    match message_turn_id(m) {
        None => how == TurnOwnership::Count,
        Some(t) => t == turn_id,
    }
}

/// 정본 `countOwnPostsSince` — 턴 시작 seq 뒤의 자기 발화 수. 기준선이 턴 시작 seq 인 까닭: 시작 전 자기 글까지 세면 아무것도
/// 안 한 턴도 「발화했다」가 된다. progress·wake 는 결과 발화로 세지 않는다(끄는 인자를 두지 않는다 — 잘못 넘어올 길만 생긴다).
pub fn count_own_posts_since(
    messages: &[Value],
    me_id: &str,
    since_seq: i64,
    turn_id: Option<&str>,
) -> usize {
    messages
        .iter()
        .filter(|m| {
            m.get("authorId").and_then(Value::as_str) == Some(me_id)
                && seq(m) > since_seq
                && !m
                    .get("kind")
                    .and_then(Value::as_str)
                    .is_some_and(|k| NON_UTTERANCE_KINDS.contains(&k))
                && owned_by_turn(m, turn_id, TurnOwnership::Count)
        })
        .count()
}

/// 정본 `hasOwnWakeSince` — 턴 시작 seq 뒤에 이 턴이 깨움 예약(대기 줄)을 걸었나. 대기 줄도 턴으로 가른다 — 같은 스레드를 다른 턴이
/// 함께 볼 때 그 턴의 예약으로 내 침묵을 덮지 않게.
pub fn has_own_wake_since(
    messages: &[Value],
    me_id: &str,
    since_seq: i64,
    turn_id: Option<&str>,
) -> bool {
    messages.iter().any(|m| {
        m.get("authorId").and_then(Value::as_str) == Some(me_id)
            && seq(m) > since_seq
            && m.get("kind").and_then(Value::as_str) == Some(MESSAGE_KIND_WAKE)
            && owned_by_turn(m, turn_id, TurnOwnership::Count)
    })
}

#[cfg(test)]
#[path = "turn_posts_tests.rs"]
mod tests;
