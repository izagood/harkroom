//! 정본 `threadModel.ts` — 이 턴이 쓸 모델·effort(스레드 × 에이전트 지정, 서버 079)를 에이전트 설정 위에 얹는다.
//!
//! 서버가 계산한 실효값(`GET /agent/thread-model`)을 그대로 쓴다 — 서버가 같은 값으로 발화의 모델 어긋남을
//! 판정하므로 여기서 다시 합치지 않는다. 옛 서버(404)·링크 오류·모양이 틀린 응답이면 정의(`def`)로 물러나고
//! 턴을 막지 않는다(로그만 남긴다).

use std::sync::LazyLock;

use regex::Regex;
use serde::Deserialize;
use serde_json::Value;

/// 축이 어디서 왔나 — 실패 통지가 "스레드 지정 모델이 거절됐다" 를 가르는 재료다.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum AxisSource {
    Thread,
    Agent,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Deserialize)]
pub struct TurnModelSource {
    pub model: AxisSource,
    pub effort: AxisSource,
}

#[derive(Debug, Clone, PartialEq, Eq, Deserialize)]
pub struct TurnModel {
    pub model: Option<String>,
    pub effort: Option<String>,
    pub source: TurnModelSource,
}

/// 서버 `AXIS_PATTERN` 과 같은 모양(영숫자 시작, 영숫자·`._:/[]-`).
static AXIS_PATTERN: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"^[A-Za-z0-9][A-Za-z0-9._:/\[\]-]*$").expect("axis pattern"));

/// null 은 "지정 없음" 이라 통과.
fn safe_axis(v: Option<&str>) -> bool {
    v.is_none_or(|s| AXIS_PATTERN.is_match(s))
}

/// 정본 `resolveTurnModel`. `fetch` 는 `HarkroomRest::thread_model` 자리(없으면 `None` — 옛 링크).
pub fn resolve_turn_model<F, E>(
    fetch: Option<F>,
    def_model: Option<&str>,
    def_effort: Option<&str>,
    message_id: Option<&str>,
    log: &mut dyn FnMut(String),
) -> TurnModel
where
    F: FnOnce(&str) -> Result<Value, E>,
    E: std::fmt::Display,
{
    let from_def = TurnModel {
        model: def_model.map(str::to_owned),
        effort: def_effort.map(str::to_owned),
        source: TurnModelSource {
            model: AxisSource::Agent,
            effort: AxisSource::Agent,
        },
    };
    let (Some(id), Some(fetch)) = (message_id.filter(|s| !s.is_empty()), fetch) else {
        return from_def;
    };
    let got = match fetch(id).map_err(|e| e.to_string()).and_then(|v| {
        serde_json::from_value::<TurnModel>(v).map_err(|e| format!("응답 모양이 틀림: {e}"))
    }) {
        Ok(g) => g,
        Err(e) => {
            log(format!(
                "[threadModel] {id}: 스레드 모델 지정을 못 읽어 에이전트 설정으로 돈다 — {e}"
            ));
            return from_def;
        }
    };
    // 러너도 모양을 본다(security #967 ② 의 한 겹 더) — 이 값은 argv 로 가므로 `-` 시작은 다른 플래그가 된다.
    let model = if got.source.model == AxisSource::Thread && !safe_axis(got.model.as_deref()) {
        from_def.model.clone()
    } else {
        got.model.clone()
    };
    let effort = if got.source.effort == AxisSource::Thread && !safe_axis(got.effort.as_deref()) {
        from_def.effort.clone()
    } else {
        got.effort.clone()
    };
    if model != got.model || effort != got.effort {
        log(format!(
            "[threadModel] {id}: 스레드 지정 값의 모양이 틀려 그 축은 에이전트 설정으로 돈다"
        ));
        return TurnModel {
            source: TurnModelSource {
                model: if model == got.model {
                    got.source.model
                } else {
                    AxisSource::Agent
                },
                effort: if effort == got.effort {
                    got.source.effort
                } else {
                    AxisSource::Agent
                },
            },
            model,
            effort,
        };
    }
    got
}

/// 정본 `usesThreadModel` — 스레드에 지정된 축이 하나라도 있나.
pub fn uses_thread_model(m: Option<&TurnModel>) -> bool {
    m.is_some_and(|m| m.source.model == AxisSource::Thread || m.source.effort == AxisSource::Thread)
}

/// 정본 `rootFromThreadKey` — 세션 키(`${channelId}/${root|_root}`)에서 스레드 루트. 채널 최상위면 `None`.
pub fn root_from_thread_key(key: &str) -> Option<&str> {
    // 정본은 `indexOf('/') + 1` — '/' 가 없으면 키 전체가 루트다.
    let root = match key.find('/') {
        Some(i) => &key[i + 1..],
        None => key,
    };
    (!root.is_empty() && root != "_root").then_some(root)
}

#[cfg(test)]
#[path = "thread_model_tests.rs"]
mod tests;
