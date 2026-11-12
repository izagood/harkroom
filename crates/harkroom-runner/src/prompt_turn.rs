//! 정본 `prompt.ts` 의 `buildTurnPrompt` — 턴 프롬프트 조립(B4-2d3).
//! 부품(`render_line`·`fit_delta`·`line_note`·`omitted_line`·`turn_clock_line`·`prompt_sections`)은 앞 조각에 있고,
//! 여기서는 그 순서와 빈-프롬프트 가드만 옮긴다. 메시지·인박스 조각은 서버 JSON 그대로(`serde_json::Value`).

use std::collections::{HashMap, HashSet};

use serde_json::Value;

use crate::prompt::{
    ANCHOR_LINE_NOTE, FitDeltaOpts, LineNoteCtx, NON_UTTERANCE_KINDS, THREAD_CONTEXT_NOTE,
    WATCH_ORIGIN_LINE_NOTE, YOUR_TASK_TAIL, attachment_how_to, fit_delta, line_note,
    neutralize_for_prompt, omitted_line, render_line, turn_clock_line,
};
use crate::prompt_sections::{
    DELEGATION_FOLLOWUP_NOTE, DELEGATION_UPDATE_NOTE, WATCH_DUTY_LINE, after_cancel_lines,
    canceled_wake_lines, delegation_section, delegations_block, fresh_wake_lines, handed_section,
    report_to_lines, started_in_lines, team_section,
};

/// 이 턴을 시작한 시각(`turn_clock_line` 인자). TS 의 `now?: Date` + 표시 시간대.
#[derive(Debug, Clone)]
pub struct TurnClock {
    pub now_ms: i64,
    pub time_zone: String,
    pub utc_offset_minutes: i32,
}

/// 카드에 직접 쓴 답(`wake.written`).
#[derive(Debug, Clone, Default)]
pub struct WakeWritten {
    pub by: Option<String>,
    pub text: String,
}

/// 정본 `opts.wake`. `origin` 은 조립에 쓰이지 않아 받지 않는다(`watch_origin` 으로 이미 읽힌 글이 온다).
#[derive(Debug, Clone, Default)]
pub struct TurnWake {
    pub reason: String,
    pub report_to: Option<Value>,
    pub watch: bool,
    pub written: Option<WakeWritten>,
    pub already_reported: Option<String>,
}

/// 정본 `buildTurnPrompt` 의 `opts`. 선택 칸은 `None`/빈 값이 TS 의 `undefined` 다.
#[derive(Debug, Clone)]
pub struct TurnPromptInput<'a> {
    pub messages: &'a [Value],
    pub last_fed_seq: i64,
    pub me_id: &'a str,
    pub handles: &'a HashMap<String, String>,
    pub channel_id: &'a str,
    pub thread_root_id: Option<&'a str>,
    pub now: Option<TurnClock>,
    pub wake: Option<TurnWake>,
    pub watch_origin: Option<&'a Value>,
    pub canceled_wakes: Option<&'a [Value]>,
    pub started_in: Option<&'a Value>,
    pub team: Option<&'a Value>,
    pub delegation: Option<&'a Value>,
    pub delegation_followup: Option<&'a Value>,
    pub delegation_update: Option<&'a Value>,
    pub delegations: Option<&'a [Value]>,
    pub delegated_by: Option<&'a Value>,
    pub edited_mention: Option<&'a Value>,
    pub fresh_wake: bool,
    pub unseen_own_after_seq: Option<i64>,
    pub bundled_ids: Option<&'a [String]>,
    pub mention_id: Option<&'a str>,
    pub gap_after_seq: Option<i64>,
    pub after_cancel_by: Option<&'a str>,
}

/// 정본 `buildTurnPrompt` 의 결과. `prompt` 가 비면 하네스를 돌리지 않는다(그래도 `fed_seq` 는 전진한 값이다).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct TurnPrompt {
    pub prompt: String,
    pub fed_seq: i64,
}

fn s<'a>(m: &'a Value, key: &str) -> Option<&'a str> {
    m.get(key).and_then(Value::as_str)
}

fn seq(m: &Value) -> i64 {
    m.get("seq")
        .and_then(|v| v.as_i64().or_else(|| v.as_f64().map(|f| f as i64)))
        .unwrap_or(0)
}

fn non_utterance(m: &Value) -> bool {
    s(m, "kind").is_some_and(|k| NON_UTTERANCE_KINDS.contains(&k))
}

fn has_attachments(m: &Value) -> bool {
    m.get("attachments")
        .and_then(Value::as_array)
        .is_some_and(|a| !a.is_empty())
}

/// 정본 `buildTurnPrompt`.
pub fn build_turn_prompt(o: &TurnPromptInput<'_>) -> TurnPrompt {
    let handles = o.handles;
    let me_id = o.me_id;
    let wake = o.wake.as_ref();
    let fresh_wake = o.fresh_wake && wake.is_some();
    let is_first_turn = o.last_fed_seq == 0;

    let new_messages: Vec<&Value> = o
        .messages
        .iter()
        .filter(|m| seq(m) > o.last_fed_seq)
        .collect();
    let fed_seq = new_messages
        .iter()
        .map(|m| seq(m))
        .fold(o.last_fed_seq, i64::max);

    let unseen_own =
        |m: &Value| o.unseen_own_after_seq.is_some_and(|after| seq(m) > after) && !non_utterance(m);
    let to_show: Vec<&Value> = new_messages
        .iter()
        .copied()
        .filter(|m| {
            (is_first_turn && !fresh_wake) || s(m, "authorId") != Some(me_id) || unseen_own(m)
        })
        .collect();

    let mention_row = o
        .mention_id
        .and_then(|id| o.messages.iter().find(|m| s(m, "id") == Some(id)));
    let edited_id = o.edited_mention.and_then(|m| s(m, "id"));
    let stale_mention = o.mention_id.is_some()
        && edited_id != o.mention_id
        && match mention_row {
            Some(r) => seq(r) <= o.last_fed_seq && s(r, "authorId") != Some(me_id),
            None => to_show.is_empty(),
        };
    if to_show.is_empty()
        && !stale_mention
        && wake.is_none()
        && o.delegation.is_none()
        && o.delegation_followup.is_none()
        && o.delegation_update.is_none()
        && o.edited_mention.is_none()
    {
        return TurnPrompt {
            prompt: String::new(),
            fed_seq,
        };
    }

    let mut head = vec![
        format!("channelId: {}", o.channel_id),
        format!(
            "threadRootId: {}",
            o.thread_root_id.unwrap_or("채널 최상위(없음)")
        ),
    ];
    if let Some(c) = &o.now {
        head.push(turn_clock_line(
            c.now_ms,
            &c.time_zone,
            c.utc_offset_minutes,
        ));
    }
    let head = head.join("\n");

    let bundled: Vec<&Value> = o
        .bundled_ids
        .unwrap_or(&[])
        .iter()
        .flat_map(|id| {
            o.messages
                .iter()
                .filter(move |m| s(m, "id") == Some(id.as_str()))
        })
        .collect();
    let bundled_set: HashSet<&str> = bundled.iter().filter_map(|m| s(m, "id")).collect();
    let in_bundle = |m: &Value| s(m, "id").is_some_and(|id| bundled_set.contains(id));
    let delta: Vec<Value> = to_show
        .iter()
        .filter(|m| !in_bundle(m))
        .map(|m| (*m).clone())
        .collect();
    let fit = fit_delta(
        &delta,
        handles,
        &FitDeltaOpts {
            mention_id: o.mention_id,
            gap_after_seq: o.gap_after_seq,
            ..Default::default()
        },
    );
    let shown = &fit.shown;
    let shown_ids: HashSet<Option<&str>> = shown.iter().map(|m| s(m, "id")).collect();
    let first_omitted = to_show
        .iter()
        .find(|m| !shown_ids.contains(&s(m, "id")) && !in_bundle(m));
    let omitted_since = if fit.omitted_at_least {
        Some(o.last_fed_seq)
    } else {
        first_omitted.map(|m| seq(m) - 1)
    };
    let mut omitted_lines: Vec<String> = Vec::new();
    if fit.omitted > 0 || fit.omitted_at_least {
        omitted_lines.push(omitted_line(
            fit.omitted,
            fit.omitted_at_least,
            omitted_since,
        ));
    }
    if let Some(mid) = o.mention_id
        && edited_id != Some(mid)
        && !o.messages.iter().any(|m| s(m, "id") == Some(mid))
    {
        omitted_lines.push(format!(
                "(이 턴을 띄운 글 harkroom://message/{mid} 은 위 범위 밖이라 싣지 못했다 — `message.read` 로 먼저 읽어라. since 뒤의 글만 주니 since 를 {} 보다 앞으로 잡는다)",
                o.last_fed_seq
            ));
    }

    let my_later_seqs = |after: i64| -> Vec<i64> {
        o.messages
            .iter()
            .filter(|m| s(m, "authorId") == Some(me_id) && seq(m) > after && !non_utterance(m))
            .map(seq)
            .collect()
    };
    let after_mine = |after: i64| -> String {
        let later = my_later_seqs(after);
        match later.as_slice() {
            [] => String::new(),
            [first] => format!(" · 이 글 뒤 네 글: seq {first}"),
            [first, rest @ ..] => format!(" · 이 글 뒤 네 글: seq {first} 외 {}개", rest.len()),
        }
    };
    let mention_has_later = mention_row.is_some_and(|r| !my_later_seqs(seq(r)).is_empty());
    let mut stale_lines: Vec<String> = Vec::new();
    if stale_mention {
        stale_lines.push(if mention_has_later {
            "(너를 부른 글은 앞 턴에 맥락으로 이미 보였고, 그 뒤에 네 글이 있다 — 이미 끝낸 일이면 다시 하지 말고 끝났다고 한 줄만 답하고, 아니면 지금 처리하라)"
        } else {
            "(너를 부른 글은 앞 턴에 맥락으로 이미 보였지만 아직 어느 턴도 처리하지 않았다 — 이 턴이 지금 처리하라)"
        }.to_owned());
        if let Some(r) = mention_row {
            stale_lines.push(render_line(r, handles, Some(ANCHOR_LINE_NOTE)));
        }
        if !shown.is_empty() {
            stale_lines.push(String::new());
        }
    }
    let me_handle = handles.get(me_id).map(String::as_str);
    let note_ctx = LineNoteCtx {
        mention_id: o.mention_id,
        thread_root_id: o.thread_root_id,
        me_handle,
    };
    let anchor_lines: Vec<String> = mention_row
        .map(|r| {
            vec![format!(
                "(너를 부른 글: harkroom://message/{} · seq {}{})",
                s(r, "id").unwrap_or(""),
                seq(r),
                after_mine(seq(r))
            )]
        })
        .unwrap_or_default();
    let mut bundled_lines: Vec<String> = Vec::new();
    if !bundled.is_empty() {
        bundled_lines.push(format!(
            "(같이 처리할 앞 부름 {}개 — 오래된 순이다. 뒤 글이 앞 글을 바꿨으면 뒤 글을 따른다. 이미 끝낸 일이면 다시 하지 말고 끝났다고 한 줄만 답하고, 아니면 지금 처리하라)",
            bundled.len()
        ));
        for m in &bundled {
            let note = format!("앞 부름 · seq {}{}", seq(m), after_mine(seq(m)));
            bundled_lines.push(neutralize_for_prompt(&render_line(m, handles, Some(&note))));
        }
        bundled_lines.push(String::new());
    }
    let mut lines = omitted_lines;
    lines.extend(stale_lines);
    for m in shown {
        let note = line_note(m, &note_ctx);
        lines.push(render_line(m, handles, note.as_deref()));
    }

    let mut wake_lines: Vec<String> = Vec::new();
    if let Some(w) = wake {
        wake_lines.push(format!("(예약된 후속 턴 — 사유: {})", w.reason));
        if let Some(wr) = &w.written {
            let by = wr
                .by
                .as_deref()
                .and_then(|b| handles.get(b))
                .filter(|h| !h.is_empty())
                .map_or("알 수 없는 사용자", String::as_str);
            wake_lines.push(format!(
                "{by} (← 카드에 직접 쓴 답): {}",
                neutralize_for_prompt(&wr.text)
            ));
        }
        if let Some(r) = &w.report_to {
            wake_lines.extend(report_to_lines(r, w.already_reported.as_deref()));
        }
        if w.watch {
            wake_lines.push(WATCH_DUTY_LINE.to_owned());
            if let Some(wo) = o.watch_origin {
                wake_lines.push(neutralize_for_prompt(&render_line(
                    wo,
                    handles,
                    Some(WATCH_ORIGIN_LINE_NOTE),
                )));
            }
        }
        if fresh_wake {
            wake_lines.extend(fresh_wake_lines());
        }
        wake_lines.push(String::new());
    }
    let canceled_lines = o
        .canceled_wakes
        .filter(|l| !l.is_empty())
        .map(canceled_wake_lines)
        .unwrap_or_default();
    let report_root = wake
        .and_then(|w| w.report_to.as_ref())
        .and_then(|r| s(r, "threadRootId"));
    let started_lines = match o.started_in {
        Some(si) if report_root != s(si, "threadRootId") => started_in_lines(si),
        _ => Vec::new(),
    };
    let cancel_lines = o
        .after_cancel_by
        .map(after_cancel_lines)
        .unwrap_or_default();
    let team_lines = o
        .team
        .map(|t| team_section(t, me_id, handles))
        .unwrap_or_default();
    let mut delegation_lines: Vec<String> =
        o.delegation.map(delegation_section).unwrap_or_default();
    if let Some(f) = o.delegation_followup {
        delegation_lines.push(DELEGATION_FOLLOWUP_NOTE.to_owned());
        delegation_lines.push(neutralize_for_prompt(&render_line(f, handles, None)));
        delegation_lines.push(String::new());
    }
    if let Some(u) = o.delegation_update {
        delegation_lines.push(DELEGATION_UPDATE_NOTE.to_owned());
        delegation_lines.push(neutralize_for_prompt(&render_line(u, handles, None)));
        delegation_lines.push(String::new());
    }
    let delegations_lines = o
        .delegations
        .filter(|d| !d.is_empty())
        .map(|d| delegations_block(d, me_handle))
        .unwrap_or_default();
    let handed_lines = o.delegated_by.map(handed_section).unwrap_or_default();
    let mut edit_lines: Vec<String> = Vec::new();
    if let Some(em) = o.edited_mention {
        edit_lines.push("(수정으로 추가된 멘션 — 앞서 올라온 글이 고쳐지면서 너를 불렀다. 고친 뒤의 본문을 다시 읽어라)".to_owned());
        if !shown.iter().any(|m| s(m, "id") == edited_id) {
            edit_lines.push(neutralize_for_prompt(&render_line(em, handles, None)));
        }
        edit_lines.push(String::new());
    }
    let how_to: Vec<String> = if shown.iter().any(has_attachments) {
        attachment_how_to().into_iter().map(str::to_owned).collect()
    } else {
        Vec::new()
    };

    let task = mention_row;
    let task_in_shown = task.is_some_and(|t| shown.iter().any(|m| s(m, "id") == s(t, "id")));
    let has_context = task.is_some() && lines.len() > usize::from(task_in_shown);
    let safe_lines: Vec<String> = lines.iter().map(|l| neutralize_for_prompt(l)).collect();
    let mut task_lines: Vec<String> = Vec::new();
    if let Some(t) = task {
        task_lines.push("<your-task>".to_owned());
        task_lines.extend(bundled_lines);
        task_lines.push(neutralize_for_prompt(&render_line(t, handles, None)));
        task_lines.push("</your-task>".to_owned());
        task_lines.extend(anchor_lines);
        task_lines.push(String::new());
    }
    let context_lines: Vec<String> = if has_context {
        let mut v = vec![
            "<thread-context>".to_owned(),
            THREAD_CONTEXT_NOTE.to_owned(),
        ];
        v.extend(safe_lines);
        v.extend([
            "</thread-context>".to_owned(),
            String::new(),
            YOUR_TASK_TAIL.to_owned(),
        ]);
        v
    } else {
        safe_lines
    };

    let mut parts: Vec<String> = vec![head, String::new()];
    for block in [
        task_lines,
        wake_lines,
        started_lines,
        cancel_lines,
        canceled_lines,
        team_lines,
        delegation_lines,
        delegations_lines,
        handed_lines,
        edit_lines,
        context_lines,
        how_to,
    ] {
        parts.extend(block);
    }
    TurnPrompt {
        prompt: parts.join("\n"),
        fed_seq,
    }
}

#[cfg(test)]
#[path = "prompt_turn_tests.rs"]
mod tests;
