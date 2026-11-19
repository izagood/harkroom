//! Rust 전환 P3 — REST 글 올리기(`POST /channels/{id}/messages`)의 `agentModels`(작성창 칩으로 고른 에이전트별 모델).
//! TS `routes/messageRoutes.ts` 의 그 갈래를 옮긴다.
//!
//! - 거절(글을 올리기 **전**, TS 와 같은 순서): 사람만(403 `human_only`) → 머리가 이 채널의 최상위 글(404 `not_a_root`) →
//!   고른 줄마다 `cleanAxis`·`axisValid`(400 `bad_model_value`) → `checkOffered`(400 `model_not_offered`·`effort_not_offered`).
//!   두 축이 다 빈 줄은 「그 스레드의 지정 풀기」라 고를 값 검사를 건너뛴다.
//! - 쓰기: TS 는 커밋 **뒤** `inbox.updated` **앞**에 지정을 쓴다(러너가 그 알림으로 턴을 띄우며 지정을 읽는다). Rust 는 `inbox.updated` 를
//!   글과 같은 tx 의 outbox 로 내므로, 지정은 [`RestPicks`] 훅으로 같은 tx 커밋 앞에 쓴다 — 「알림보다 먼저」가 그대로 지켜진다.
//!   TS `setThreadAgentModel` 이 거르는 것(없는 에이전트·에이전트 아님)은 TS 처럼 조용히 건너뛴다(글은 올라간다).
//! - 시스템 줄(`announceChange`)·`thread.agent_model.changed` 는 커밋 뒤 바뀐 줄마다. TS 는 이 둘을 본 글의 `message.created` **앞**에
//!   내지만 Rust 는 뒤에 낸다(seq 순서는 같다 — 본 글이 먼저 들어간다).
//! - 재시도 키 재생이면 훅이 돌지 않는다(TS `!replayed`).
use super::agent_model_picks::Change;
use super::msg_post::{BeforeCommit, BeforeCommitFuture, PostState};
use super::thread_model_set::{
    AGENT_SQL, CLEAR_SQL, EFFORT_MAX, MODEL_ID_MAX, ROOT_SQL, UPSERT_SQL, announce_pick,
    axis_valid, check_offered, clean_axis,
};
use crate::directory::json_err;
use axum::http::StatusCode;
use axum::response::Response;
use serde_json::{Map, Value};
use std::collections::HashSet;

/// 다듬은 한 줄 — (에이전트, model, effort). 두 축이 다 `None` 이면 풀기.
pub(crate) type Pick = (String, Option<String>, Option<String>);

/// zod `z.array(agentModelInput.extend({ agentId: uuid })).max(8).optional()` — 키가 없으면 `Some(빈 목록)`, 틀린 꼴이면 `None`(400).
/// 값은 [`clean_axis`] 로 다듬어 돌려준다(TS 가 zod 뒤 바로 `cleanAxis` 한다).
pub(crate) fn parse(body: &Map<String, Value>) -> Option<Vec<Pick>> {
    let a = match body.get("agentModels") {
        None => return Some(Vec::new()),
        Some(Value::Array(a)) if a.len() <= 8 => a,
        _ => return None,
    };
    let axis = |o: &Map<String, Value>, k: &str, max: usize| -> Option<Option<String>> {
        match o.get(k) {
            None | Some(Value::Null) => Some(None),
            Some(Value::String(s)) if s.encode_utf16().count() <= max => Some(Some(s.clone())),
            _ => None,
        }
    };
    a.iter()
        .map(|p| {
            let o = p.as_object()?;
            let id = o
                .get("agentId")?
                .as_str()
                .filter(|s| crate::lists::is_zod_uuid(s))?
                .to_owned();
            let model = axis(o, "model", MODEL_ID_MAX)?;
            let effort = axis(o, "effort", EFFORT_MAX)?;
            Some((
                id,
                clean_axis(model.as_deref(), MODEL_ID_MAX),
                clean_axis(effort.as_deref(), EFFORT_MAX),
            ))
        })
        .collect()
}

/// 글을 올리기 전의 거절 — `Ok(None)` 이면 지났다.
pub(crate) async fn refuse(
    st: &PostState,
    me_kind: &str,
    channel: &str,
    root: Option<&str>,
    picks: &[Pick],
) -> sqlx::Result<Option<Response>> {
    if me_kind != "human" {
        return Ok(Some(json_err(
            StatusCode::FORBIDDEN,
            "human_only",
            "모델 지정은 사람만 바꾼다",
        )));
    }
    if let Some(r) = root {
        let ok = sqlx::query_scalar::<_, i32>(ROOT_SQL)
            .bind(r)
            .bind(channel)
            .fetch_optional(&st.write)
            .await?
            .is_some();
        if !ok {
            return Ok(Some(json_err(
                StatusCode::NOT_FOUND,
                "not_a_root",
                "그 채널의 최상위 글이 아니다",
            )));
        }
    }
    for (agent, model, effort) in picks {
        if !axis_valid(model.as_deref()) || !axis_valid(effort.as_deref()) {
            return Ok(Some(json_err(
                StatusCode::BAD_REQUEST,
                "bad_model_value",
                "모델·effort 는 영숫자로 시작하고 영숫자·._:/[]- 만 쓴다",
            )));
        }
        if let Err((code, msg)) =
            check_offered(&st.write, agent, model.as_deref(), effort.as_deref()).await?
        {
            return Ok(Some(json_err(StatusCode::BAD_REQUEST, code, &msg)));
        }
    }
    Ok(None)
}

/// 글과 같은 tx 에서 지정을 쓰는 훅. 거절하지 않는다(TS 는 커밋 뒤라 거절할 수 없다).
#[derive(Debug)]
pub(crate) struct RestPicks {
    channel: String,
    root: Option<String>,
    actor: String,
    picks: Vec<Pick>,
    done: std::sync::Mutex<Option<(String, Vec<Change>)>>,
}

impl RestPicks {
    pub(crate) fn new(channel: &str, root: Option<&str>, actor: &str, picks: Vec<Pick>) -> Self {
        Self {
            channel: channel.to_owned(),
            root: root.map(str::to_owned),
            actor: actor.to_owned(),
            picks,
            done: std::sync::Mutex::new(None),
        }
    }

    /// 커밋 뒤 — 바뀐 줄마다 시스템 줄과 `thread.agent_model.changed`. 실패는 로그만(글은 이미 커밋됐다).
    pub(crate) async fn announce(&self, st: &PostState) {
        let Some((root, changes)) = self.done.lock().ok().and_then(|g| g.clone()) else {
            return;
        };
        for (agent, axes) in &changes {
            if let Err(e) = announce_pick(
                st,
                &self.channel,
                &root,
                &self.actor,
                agent,
                axes.as_ref(),
                false,
            )
            .await
            {
                eprintln!(
                    "[messagePost] agentModels announce failed ({})",
                    e.as_database_error().map_or("io", |_| "db")
                );
            }
        }
    }
}

/// TS `setThreadAgentModel`(사람) · `clearThreadAgentModel` 한 줄. 바뀌었으면 `Some`.
async fn write_one(
    tx: &mut sqlx::Transaction<'static, sqlx::Postgres>,
    channel: &str,
    root: &str,
    actor: &str,
    (agent, model, effort): &Pick,
) -> sqlx::Result<Option<Change>> {
    if model.is_none() && effort.is_none() {
        // 없던 것을 풀면 아무 줄도 남기지 않는다(TS 와 같다).
        let n = sqlx::query(CLEAR_SQL)
            .bind(root)
            .bind(agent)
            .execute(&mut **tx)
            .await?
            .rows_affected();
        return Ok((n > 0).then(|| (agent.clone(), None)));
    }
    let root_ok = sqlx::query_scalar::<_, i32>(ROOT_SQL)
        .bind(root)
        .bind(channel)
        .fetch_optional(&mut **tx)
        .await?
        .is_some();
    if !root_ok {
        return Ok(None);
    }
    let found: Option<(String, Option<String>)> = sqlx::query_as(AGENT_SQL)
        .bind(agent)
        .fetch_optional(&mut **tx)
        .await?;
    let harness = match found {
        Some((kind, h)) if kind == "agent" => h.unwrap_or_else(|| "claude-code".into()),
        _ => return Ok(None),
    };
    sqlx::query(UPSERT_SQL)
        .bind(root)
        .bind(agent)
        .bind(&harness)
        .bind(model)
        .bind(effort)
        .bind(actor)
        .execute(&mut **tx)
        .await?;
    Ok(Some((agent.clone(), Some((model.clone(), effort.clone())))))
}

impl BeforeCommit for RestPicks {
    fn run<'a>(
        &'a self,
        tx: &'a mut sqlx::Transaction<'static, sqlx::Postgres>,
        message_id: &'a str,
        _notified: &'a HashSet<String>,
    ) -> BeforeCommitFuture<'a> {
        Box::pin(async move {
            let root = self.root.clone().unwrap_or_else(|| message_id.to_owned());
            let mut changes = Vec::new();
            for p in &self.picks {
                if let Some(c) = write_one(tx, &self.channel, &root, &self.actor, p).await? {
                    changes.push(c);
                }
            }
            if let Ok(mut g) = self.done.lock() {
                *g = Some((root, changes));
            }
            Ok(None)
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    const A: &str = "11111111-1111-4111-8111-111111111111";

    fn obj(v: Value) -> Map<String, Value> {
        v.as_object().unwrap().clone()
    }

    #[test]
    fn parse_like_zod() {
        assert_eq!(parse(&obj(json!({ "body": "x" }))), Some(vec![]));
        assert_eq!(
            parse(&obj(
                json!({ "agentModels": [{ "agentId": A, "model": " m1 ", "effort": null }] })
            )),
            Some(vec![(A.into(), Some("m1".into()), None)])
        );
        // 빈 줄은 풀기(두 축 None).
        assert_eq!(
            parse(&obj(
                json!({ "agentModels": [{ "agentId": A, "model": "  " }] })
            )),
            Some(vec![(A.into(), None, None)])
        );
        for bad in [
            json!({ "agentModels": null }),
            json!({ "agentModels": {} }),
            json!({ "agentModels": [{ "agentId": "x" }] }),
            json!({ "agentModels": [{ "agentId": A, "model": 1 }] }),
            json!({ "agentModels": [{ "agentId": A, "effort": "e".repeat(EFFORT_MAX + 1) }] }),
            json!({ "agentModels": vec![json!({ "agentId": A }); 9] }),
        ] {
            assert_eq!(parse(&obj(bad.clone())), None, "{bad}");
        }
    }
}
