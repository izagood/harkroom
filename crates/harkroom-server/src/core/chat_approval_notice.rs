//! P3b-2d — 글 승인의 확인·안내 줄(TS `services/chatApproval.ts` `confirm`·`refuse`·`notice`·`post`).
//!
//! 줄은 글쓴이(사람) 이름의 시스템 줄로 그 글의 스레드에 단다 — 부르지 않는다(`noMentions`, 규칙 원문·채널 이름이 섞인다).

use serde_json::{Map, Value, json};

use super::chat_approval_decide::DecideResult;
use super::chat_approval_pick::{PostedMsg, Refusal};
use super::msg_post::{Origin, Outcome, PostBody, PostState, channel_is_dm, post_in_tx};

/// TS `REASON_KO`(권한 승인 쪽 + P5 가 넘기는 `askCard`).
pub fn reason_ko(r: Refusal) -> &'static str {
    match r.key() {
        "negated" => "부정·보류하는 말이 있어 아무것도 정하지 않았다.",
        "question" => "물음으로 읽혀 정하지 않았다. 승인하려면 「승인해」처럼 끝맺어 다시 쓴다.",
        "bypass" => "「바이패스」는 글로 승인하지 않는다. 카드에서 정한다.",
        "conflict" => "승인과 거절 낱말이 함께 있어 정하지 않았다.",
        "notFinal" => "승인 낱말 뒤에 말이 더 있어 정하지 않았다. 「승인해」처럼 끝맺어 다시 쓴다.",
        "denyNotFinal" => "거절 낱말 뒤에 말이 더 있어 정하지 않았다. 「거절」로 끝맺어 다시 쓴다.",
        "denyNeedsLink" => "글로 거절하려면 카드 링크를 붙인다.",
        "needsExplicit" => {
            "카드 링크 없이 쓴 글은 「승인」·「허락」으로 끝맺을 때만 승인한다. 「승인」으로 다시 쓰거나 카드 링크를 붙인다."
        }
        "noWord" => "카드 링크는 있지만 승인 낱말(승인·허락·머지해·진행해·approve)이 없다.",
        "tooMany" => "한 글로는 카드를 5장까지만 정한다. 나눠서 다시 쓴다.",
        "noCard" => "링크한 글 중에 정할 수 있는 카드가 없다.",
        "askCard" => {
            "선택 카드는 번호(「1번」)·선택지 이름·「추천대로」로 답한다. 카드에서 골라도 된다."
        }
        "askMany" => {
            "기다리는 선택 카드가 여럿이라 어느 것인지 모른다. 카드 링크 하나를 붙여 다시 쓴다."
        }
        "askNoMatch" => "맞는 선택지가 없다. 번호(「1번」)나 선택지 이름으로 다시 쓴다.",
        "askNoRecommended" => {
            "이 카드에는 추천 선택지가 하나로 정해져 있지 않다. 번호나 선택지 이름으로 다시 쓴다."
        }
        "askIrreversible" => {
            "되돌릴 수 없는 일을 묻는 카드라 「추천대로」나 링크 없는 번호로는 고르지 않는다. 선택지 이름 그대로나 카드 링크와 번호로 다시 쓴다."
        }
        "askAnswered" => "이미 답한 카드다.",
        "hidden" => "볼 수 없는 채널의 카드다.",
        "headChanged" => "카드가 선 뒤 PR head 가 바뀌었다. 카드를 다시 확인하고 정한다.",
        "ciWord" => "CI 실패를 무시하는 카드는 글에 「CI 무시」(ignore CI)가 있어야 승인한다.",
        "settled" => {
            "이 스레드의 카드는 이미 정해졌거나 만료됐다. 다른 카드는 링크를 붙여 다시 쓴다."
        }
        "noRequest" => "이 글보다 먼저 온 기다리는 요청이 없다. 카드 링크를 붙여 다시 쓴다.",
        "notBefore" => "카드가 이 글보다 나중에 섰다. 카드에서 정하거나 링크를 붙여 다시 쓴다.",
        "decided" => "이미 정해진 카드다.",
        "expired" => "만료된 카드다.",
        "onceOnCard" => "이 머지 카드는 카드 스레드에서 쓰거나 링크를 붙여 정한다.",
        "mergeNoMandate" => {
            "이 스레드에는 위임장을 세울 수 없어 머지를 7일로 승인하지 않는다. 머지 거절 카드에서 「이번 한 번」으로 정하거나, 내가 연 스레드에서 카드 링크를 붙여 승인한다."
        }
        _ => "결정하지 못했다. 카드에서 다시 시도한다.",
    }
}

/// TS `plain` — 본문에 넣는 이름의 `@`·백틱을 무력화한다.
fn plain(s: &str) -> String {
    s.replace('@', "＠").replace('`', "'")
}

/// TS `refuse` 의 본문·meta.
pub fn refuse_line(msg_id: &str, why: Refusal) -> (String, Map<String, Value>) {
    let key = why.key();
    let head = match key {
        "denyNeedsLink" | "denyNotFinal" => "거절 안 됨",
        "askCard" | "askMany" | "askNoMatch" | "askNoRecommended" | "askIrreversible"
        | "askAnswered" => "답 안 됨",
        _ => "승인 안 됨",
    };
    let mut meta = Map::new();
    meta.insert(
        "chatApproval".into(),
        json!({ "messageId": msg_id, "results": [], "reason": key }),
    );
    meta.insert(
        "i18n".into(),
        json!({ "key": format!("system.chatApproval.{key}"), "args": {} }),
    );
    (format!("⚠️ {head}: {}", reason_ko(why)), meta)
}

/// TS `notice` — 후보 링크만 싣는다(security F2).
pub fn notice_line(msg_id: &str, text: &str, ids: &[String]) -> (String, Map<String, Value>) {
    let list: String = ids
        .iter()
        .take(10)
        .map(|id| format!("\n- harkroom://message/{id}"))
        .collect();
    let more = if ids.len() > 10 {
        format!("\n- …그 밖 {}개", ids.len() - 10)
    } else {
        String::new()
    };
    let shown: Vec<&String> = ids.iter().take(10).collect();
    let mut meta = Map::new();
    meta.insert(
        "chatApproval".into(),
        json!({ "messageId": msg_id, "results": [], "candidates": shown }),
    );
    (format!("⚠️ {text}{list}{more}"), meta)
}

/// TS `notice` 의 머리 — 스레드 안 카드 여럿(T2) 또는 소유자 요청 여럿(T3).
pub fn ambiguous_text(in_thread: bool, count: usize) -> String {
    if in_thread {
        format!(
            "승인 안 됨: 이 스레드에 기다리는 카드가 {count}장이라 어느 것인지 모른다. 정할 카드의 링크를 붙여 다시 쓴다:"
        )
    } else {
        format!(
            "승인 안 됨: 기다리는 권한 요청이 {count}개라 어느 것인지 모른다. 정할 카드의 링크를 붙여 다시 쓴다:"
        )
    }
}

/// TS `confirm`.
pub fn confirm_line(msg_id: &str, outcomes: &[DecideResult]) -> (String, Map<String, Value>) {
    use super::api_results::js_slice;
    let lines: Vec<String> = outcomes
        .iter()
        .map(|o| {
            if let Err(e) = &o.r
                && e.hidden
            {
                return format!("- ✗ {}", reason_ko(e.why));
            }
            let c = &o.c;
            let what = format!(
                "{} · {} `{}` · #{}",
                plain(&c.agent_handle),
                if c.kind == "merge" {
                    "머지"
                } else {
                    "명령"
                },
                plain(&c.target),
                plain(c.channel_name.as_deref().unwrap_or("?")),
            );
            match &o.r {
                Err(e) => format!("- ✗ {what} — {}", reason_ko(e.why)),
                Ok(d) if d.denied => format!("- ✕ {what} — 거절"),
                Ok(d) => {
                    let until = if d.grant_mode == Some("once") || c.denial_id.is_some() {
                        "이번 한 번".to_owned()
                    } else if let Some(g) = &d.grant_expires_at {
                        format!("{} UTC 까지", js_slice(g, 16).replacen('T', " ", 1))
                    } else {
                        String::new()
                    };
                    format!("- ✓ {what} — {until}")
                }
            }
        })
        .collect();
    let any_ok = outcomes.iter().any(|o| matches!(&o.r, Ok(d) if !d.denied));
    let any_done = outcomes.iter().any(|o| o.r.is_ok());
    let head = if any_done {
        if any_ok {
            "✅ 이 글로 권한 요청을 정했다(카드와 같은 효과)."
        } else {
            "이 글로 권한 요청을 거절했다(카드와 같은 효과)."
        }
    } else {
        "이 글로는 아무 권한 요청도 정하지 않았다."
    };
    let tail = if any_ok {
        "\n거두려면 설정 › 에이전트 › 할 수 있는 일에서 지우거나, 그 에이전트에게 「그 권한 거둬」라고 하라."
    } else {
        ""
    };
    let results: Vec<Value> = outcomes
        .iter()
        .map(|o| match &o.r {
            Err(e) if e.hidden => json!({ "ok": false, "why": e.why.key() }),
            Err(e) => json!({ "requestId": o.c.request_id, "cardMessageId": o.c.card_message_id, "ok": false, "why": e.why.key() }),
            Ok(_) => json!({ "requestId": o.c.request_id, "cardMessageId": o.c.card_message_id, "ok": true }),
        })
        .collect();
    let mut meta = Map::new();
    meta.insert(
        "chatApproval".into(),
        json!({ "messageId": msg_id, "results": results }),
    );
    (format!("{head}\n{}{tail}", lines.join("\n")), meta)
}

/// TS `post` — 글쓴이 이름의 시스템 줄(부르지 않음). meta 맨 앞에 `accountId`.
pub async fn post_line(
    post: &PostState,
    msg: &PostedMsg,
    actor: &str,
    body: String,
    extra: Map<String, Value>,
) -> sqlx::Result<()> {
    let mut meta = Map::new();
    meta.insert("accountId".into(), json!(actor));
    meta.extend(extra);
    let audience = super::audience::audience_for(&post.write, &msg.channel_id)
        .await?
        .to_json();
    let is_dm = channel_is_dm(&post.write, &msg.channel_id).await?;
    let input = PostBody {
        body,
        attachment_ids: Vec::new(),
        thread_root: Some(msg.thread_root().to_owned()),
        also_in_channel: false,
    };
    let origin = Origin {
        meta,
        system: true,
        server_notice: true,
        no_mentions: true,
        ..Origin::default()
    };
    let out = post_in_tx(
        post,
        &msg.channel_id,
        actor,
        false,
        &input,
        None,
        &audience,
        is_dm,
        &origin,
    )
    .await?;
    if !matches!(out, Outcome::Posted { .. }) {
        eprintln!(
            "[chat_approval] 안내 줄을 올리지 못했다 messageId={}",
            msg.id
        );
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::core::chat_approval_decide::{Done, Refused};
    use crate::core::chat_approval_parse::ChatBlock;
    use crate::core::chat_approval_pick::Candidate;

    const TS: &str = include_str!("../../../../packages/server/src/services/chatApproval.ts");

    #[test]
    fn reasons_are_ts_text() {
        for r in [
            Refusal::Block(ChatBlock::Negated),
            Refusal::Block(ChatBlock::Question),
            Refusal::Block(ChatBlock::Bypass),
            Refusal::Block(ChatBlock::Conflict),
            Refusal::Block(ChatBlock::NotFinal),
            Refusal::Block(ChatBlock::DenyNotFinal),
            Refusal::DenyNeedsLink,
            Refusal::NeedsExplicit,
            Refusal::NoWord,
            Refusal::TooMany,
            Refusal::NoCard,
            Refusal::AskCard,
            Refusal::AskMany,
            Refusal::AskNoMatch,
            Refusal::AskNoRecommended,
            Refusal::AskIrreversible,
            Refusal::AskAnswered,
            Refusal::Hidden,
            Refusal::HeadChanged,
            Refusal::CiWord,
            Refusal::Settled,
            Refusal::NoRequest,
            Refusal::NotBefore,
            Refusal::Decided,
            Refusal::Expired,
            Refusal::OnceOnCard,
            Refusal::MergeNoMandate,
            Refusal::Failed,
        ] {
            let want = format!("  {}: '{}',", r.key(), reason_ko(r));
            assert!(TS.contains(&want), "TS REASON_KO 와 다르다: {want}");
        }
    }

    #[test]
    fn line_heads_are_ts_text() {
        for s in [
            "이 스레드에 기다리는 카드가 ${open.length}장이라 어느 것인지 모른다. 정할 카드의 링크를 붙여 다시 쓴다:",
            "기다리는 권한 요청이 ${mine.length}개라 어느 것인지 모른다. 정할 카드의 링크를 붙여 다시 쓴다:",
            "✅ 이 글로 권한 요청을 정했다(카드와 같은 효과).",
            "이 글로 권한 요청을 거절했다(카드와 같은 효과).",
            "이 글로는 아무 권한 요청도 정하지 않았다.",
            "거두려면 설정 › 에이전트 › 할 수 있는 일에서 지우거나, 그 에이전트에게 「그 권한 거둬」라고 하라.",
        ] {
            assert!(TS.contains(s), "TS 에 없다: {s}");
        }
        assert!(ambiguous_text(true, 2).contains("카드가 2장이라"));
        assert!(ambiguous_text(false, 3).contains("요청이 3개라"));
    }

    fn cand(kind: &str, denial: bool) -> Candidate {
        Candidate {
            card_message_id: "card".into(),
            request_id: "req".into(),
            agent_id: "ag".into(),
            agent_handle: "b@t".into(),
            kind: kind.into(),
            target: "git `push`".into(),
            channel_id: "ch".into(),
            channel_name: Some("dev".into()),
            status: "pending".into(),
            expired: false,
            denial_id: denial.then(|| "d".into()),
            owner_account_id: None,
            card_seq: 1,
            card_created_ms: 0,
            once: None,
            can_decide: true,
        }
    }

    #[test]
    fn confirm_like_ts() {
        let ok = DecideResult {
            c: cand("tool", false),
            r: Ok(Done {
                grant_expires_at: Some("2026-11-26T07:00:00.000Z".into()),
                grant_mode: None,
                denied: false,
            }),
        };
        let hidden = DecideResult {
            c: cand("merge", true),
            r: Err(Refused {
                why: Refusal::Hidden,
                hidden: true,
            }),
        };
        let (body, meta) = confirm_line("m", &[ok, hidden]);
        assert_eq!(
            body,
            "✅ 이 글로 권한 요청을 정했다(카드와 같은 효과).\n- ✓ b＠t · 명령 `git 'push'` · #dev — 2026-11-26 07:00 UTC 까지\n- ✗ 볼 수 없는 채널의 카드다.\n거두려면 설정 › 에이전트 › 할 수 있는 일에서 지우거나, 그 에이전트에게 「그 권한 거둬」라고 하라."
        );
        assert_eq!(
            meta["chatApproval"]["results"][1],
            json!({ "ok": false, "why": "hidden" })
        );
        let (body, meta) = refuse_line("m", Refusal::DenyNeedsLink);
        assert_eq!(body, "⚠️ 거절 안 됨: 글로 거절하려면 카드 링크를 붙인다.");
        assert_eq!(meta["i18n"]["key"], "system.chatApproval.denyNeedsLink");
        let ids: Vec<String> = (0..12).map(|i| format!("id{i}")).collect();
        let (body, meta) = notice_line("m", "x", &ids);
        assert!(body.ends_with("\n- harkroom://message/id9\n- …그 밖 2개"));
        assert_eq!(
            meta["chatApproval"]["candidates"].as_array().unwrap().len(),
            10
        );
    }
}
