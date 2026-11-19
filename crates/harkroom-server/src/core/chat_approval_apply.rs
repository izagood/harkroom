//! P3b-2 입구 — 사람이 앱에서 올린 글로 권한 요청을 정한다(TS `applyChatApproval` → `approveFromMessage`).
//!
//! 고르기([`super::chat_approval_pick::select`]) → 정하기([`super::chat_approval_decide::decide_one`]) → 줄
//! ([`super::chat_approval_notice`]). 글은 이미 커밋됐다 — 실패해도 던지지 않고 로그만 남긴다(TS 와 같다).
//!
//! 선택 카드 글 답(TS `answerAskFromMessage`, P5)을 먼저 본다([`super::chat_approval_ask`]) — 다뤘으면 권한 판정은 하지 않는다.
//! 카드 `replied` 닫기는 부르는 쪽이 이 판정 뒤에 [`close_after`] 로 한다.

use super::ask::AskState;
use super::chat_approval_decide::decide_one;
use super::chat_approval_notice::{
    ambiguous_text, confirm_line, notice_line, post_line, refuse_line,
};
use super::chat_approval_parse::{parse_ask_pick, parse_chat_approval};
use super::chat_approval_pick::{PostedMsg, Selection, select};
use super::msg_post::PostState;
use serde_json::Value;

/// 이 글이 선택 카드 답(TS `parseAskPick`)이 될 수 있는가(쓰기 전, 순수) — 되면 카드 닫기를 커밋 뒤 답 다음으로 미룬다.
pub fn wants_ask_pick(body: &str) -> bool {
    parse_ask_pick(body).is_some()
}

/// 커밋 뒤 TS `closeAsksByReply`(사람 글) — 카드 답을 먼저 적은 뒤에 부른다. 던지지 않는다.
pub async fn close_after(post: &PostState, row: &str, actor: &str) {
    let Some(msg) = posted_from_row(row) else {
        return;
    };
    let r: sqlx::Result<()> = async {
        let mut tx = post.write.begin().await?;
        super::ask_reply_close::close_by_reply(
            &mut tx,
            msg.thread_root(),
            &msg.channel_id,
            msg.seq,
            actor,
            &msg.id,
        )
        .await?;
        tx.commit().await
    }
    .await;
    if let Err(e) = r {
        eprintln!("[ask_replied] closing asks by reply failed (the reply is posted): {e}");
    }
}

/// 이 글을 글 승인 판정이 볼 것인가(쓰기 전, 순수) — 보면 `inbox.updated` 를 판정 뒤로 미룬다(TS security n2).
pub fn wants_chat_approval(body: &str) -> bool {
    parse_chat_approval(body).is_some()
}

/// 올라간 글 행(JSON)에서 판정에 쓸 칸.
pub fn posted_from_row(row: &str) -> Option<PostedMsg> {
    let v: Value = serde_json::from_str(row).ok()?;
    let created = v.get("createdAt")?.as_str()?;
    let created_ms = chrono::DateTime::parse_from_rfc3339(created)
        .ok()?
        .timestamp_millis();
    Some(PostedMsg {
        id: v.get("id")?.as_str()?.to_owned(),
        channel_id: v.get("channelId")?.as_str()?.to_owned(),
        thread_root_id: v
            .get("threadRootId")
            .and_then(Value::as_str)
            .map(str::to_owned),
        seq: v.get("seq")?.as_i64()?,
        created_ms,
    })
}

/// TS `applyChatApproval`. 부르는 쪽이 사람 세션 글임을 확인했다.
pub async fn apply(ask: &AskState, post: &PostState, msg: &PostedMsg, body: &str, actor: &str) {
    let parsed = parse_chat_approval(body);
    let pick = parse_ask_pick(body);
    let r: sqlx::Result<()> = async {
        // 선택 카드 답(P5)을 먼저 본다 — 가리킨 선택 카드가 없으면 권한 승인 판정으로 넘어간다.
        if let Some(p) = &pick
            && super::chat_approval_ask::answer_from_message(
                ask,
                post,
                msg,
                actor,
                p,
                parsed.as_ref(),
            )
            .await?
        {
            return Ok(());
        }
        let Some(parsed) = parsed else {
            return Ok(());
        };
        let sel = {
            let mut conn = ask.read.acquire().await?;
            select(&mut conn, msg, body, actor, &parsed).await?
        };
        match sel {
            Selection::Silent => Ok(()),
            Selection::Refuse(why) => {
                let (b, m) = refuse_line(&msg.id, why);
                post_line(post, msg, actor, b, m).await
            }
            Selection::Ambiguous {
                in_thread,
                count,
                card_ids,
            } => {
                let (b, m) = notice_line(&msg.id, &ambiguous_text(in_thread, count), &card_ids);
                post_line(post, msg, actor, b, m).await
            }
            Selection::Decide { targets, target } => {
                let mut outs = Vec::with_capacity(targets.len());
                for c in &targets {
                    outs.push(decide_one(ask, msg, actor, c, target, &parsed).await?);
                }
                let mine: Vec<_> = outs.into_iter().filter(|o| o.c.can_decide).collect();
                if mine.is_empty() {
                    return Ok(());
                }
                if mine.len() == 1
                    && let Err(e) = &mine[0].r
                {
                    let (b, m) = refuse_line(&msg.id, e.why);
                    return post_line(post, msg, actor, b, m).await;
                }
                let (b, m) = confirm_line(&msg.id, &mine);
                post_line(post, msg, actor, b, m).await
            }
        }
    }
    .await;
    if let Err(e) = r {
        eprintln!("[chat_approval] 글 승인 판정 실패(글은 올라갔다): {e}");
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn posted_row_fields() {
        let row = r#"{"id":"a","channelId":"c","threadRootId":null,"seq":42,"createdAt":"2026-11-19T07:00:00.123Z"}"#;
        let p = posted_from_row(row).unwrap();
        assert_eq!(p.thread_root(), "a");
        assert_eq!(p.seq, 42);
        assert_eq!(p.created_ms % 1000, 123);
    }

    #[test]
    fn wants_only_decision_words_or_links() {
        assert!(wants_chat_approval("승인"));
        assert!(wants_chat_approval(
            "harkroom://message/0b6f8d2e-3c1a-4f5e-9a7b-1c2d3e4f5a6b"
        ));
        assert!(!wants_chat_approval("점심 뭐 먹지"));
    }
}
