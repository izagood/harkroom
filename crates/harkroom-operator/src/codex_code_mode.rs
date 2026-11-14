//! codex code mode 기록에서 지금 도는 셸 호출을 꺼낸다 — TS `packages/operator/src/codexCodeMode.ts` 와 같은 판정.
//!
//! code mode(모델의 `tool_mode: code_mode_only`)에서 셸 명령은 `custom_tool_call`(name `exec`)의 JS 코드 안
//! `tools.exec_command({...})` 로 돈다. hook 이 받는 `tool_use_id`(`exec-…`)는 명령이 끝난 뒤에야 기록에 남으므로,
//! **이 턴에서 출력이 아직 없는 exec 셀 하나**를 지금 호출로 본다. 코드는 아래 꼴과 정확히 맞을 때만 읽고 그 밖은 모두 거절한다:
//!
//! - `[await ]tools.exec_command({ … })` 또는 `text(await tools.exec_command({ … }))`, 앞뒤 공백과 끝 `;` 하나만.
//! - `{ … }` 안은 `cmd`(필수, 비지 않음)와 `workdir`(선택) — 맨 이름이나 큰따옴표 이름, 값은 큰따옴표 문자열만, 같은 키 두 번은 거절.
//! - 문자열은 JSON 규칙으로 푼다(`\uXXXX` 포함). JSON 에 없는 이스케이프·날 제어문자는 거절. 공백은 ASCII 공백·탭·CR·LF 만.

use serde_json::Value;

/// 꺼낸 호출.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ExecCall {
    pub cmd: String,
    pub workdir: Option<String>,
}

struct P<'a> {
    s: &'a [u8],
    i: usize,
}

impl P<'_> {
    fn ws(&mut self) {
        while let Some(b' ' | b'\t' | b'\n' | b'\r') = self.s.get(self.i) {
            self.i += 1;
        }
    }
    fn lit(&mut self, t: &str) -> bool {
        if self.s[self.i..].starts_with(t.as_bytes()) {
            self.i += t.len();
            true
        } else {
            false
        }
    }
    /// 낱말 뒤에 이름 글자가 붙지 않아야 한다(`awaitx` 를 `await` 로 읽지 않게).
    fn word(&mut self, t: &str) -> bool {
        let save = self.i;
        if self.lit(t)
            && !self
                .s
                .get(self.i)
                .is_some_and(|b| b.is_ascii_alphanumeric() || *b == b'_' || *b == b'$')
        {
            return true;
        }
        self.i = save;
        false
    }
    /// JSON 문자열(큰따옴표). 원문 그대로 serde_json 으로 푼다 — JSON 규칙 밖이면 실패.
    fn string(&mut self) -> Option<String> {
        if self.s.get(self.i) != Some(&b'"') {
            return None;
        }
        let start = self.i;
        self.i += 1;
        loop {
            match *self.s.get(self.i)? {
                b'"' => {
                    self.i += 1;
                    break;
                }
                b'\\' => self.i += 2,
                _ => self.i += 1,
            }
        }
        let raw = std::str::from_utf8(self.s.get(start..self.i)?).ok()?;
        match serde_json::from_str::<Value>(raw).ok()? {
            Value::String(s) => Some(s),
            _ => None,
        }
    }
    fn key(&mut self) -> Option<&'static str> {
        for k in ["cmd", "workdir"] {
            if self.word(k) {
                return Some(k);
            }
        }
        let save = self.i;
        match self.string().as_deref() {
            Some("cmd") => Some("cmd"),
            Some("workdir") => Some("workdir"),
            _ => {
                self.i = save;
                None
            }
        }
    }
    fn object(&mut self) -> Option<ExecCall> {
        if !self.lit("{") {
            return None;
        }
        let (mut cmd, mut workdir) = (None, None);
        loop {
            self.ws();
            if self.lit("}") {
                break;
            }
            let k = self.key()?;
            self.ws();
            if !self.lit(":") {
                return None;
            }
            self.ws();
            let v = self.string()?;
            let slot = if k == "cmd" { &mut cmd } else { &mut workdir };
            if slot.is_some() {
                return None; // 같은 키 두 번 — JS 는 마지막 값을 쓴다.
            }
            *slot = Some(v);
            self.ws();
            if self.lit(",") {
                continue;
            }
            self.ws();
            if !self.lit("}") {
                return None;
            }
            break;
        }
        let cmd = cmd.filter(|c| !c.is_empty())?;
        Some(ExecCall { cmd, workdir })
    }
    fn call(&mut self) -> Option<ExecCall> {
        if !self.lit("tools.exec_command") {
            return None;
        }
        self.ws();
        if !self.lit("(") {
            return None;
        }
        self.ws();
        let c = self.object()?;
        self.ws();
        if !self.lit(")") {
            return None;
        }
        Some(c)
    }
}

/// exec 셀의 코드 전체가 허용한 꼴 하나일 때만 그 호출을 돌려준다.
pub fn parse_exec_cell(code: &str) -> Option<ExecCall> {
    let mut p = P {
        s: code.as_bytes(),
        i: 0,
    };
    p.ws();
    let call = if p.word("text") {
        p.ws();
        if !p.lit("(") {
            return None;
        }
        p.ws();
        if !p.word("await") {
            return None;
        }
        p.ws();
        let c = p.call()?;
        p.ws();
        if !p.lit(")") {
            return None;
        }
        c
    } else {
        if p.word("await") {
            p.ws();
        }
        p.call()?
    };
    p.ws();
    if p.lit(";") {
        p.ws();
    }
    (p.i == p.s.len()).then_some(call)
}

/// 기록 꼬리(줄들)에서 이 턴의 출력 없는 exec 셀 하나를 찾아 그 코드를 돌려준다. `tool_use_id` 가 이미 끝난 명령이면 `None`.
/// 이 턴의 시작은 꼬리 안 마지막 `turn_context`(또는 `task_started`)다 — 없으면 `None`.
pub fn pending_exec_code(lines: &[&str], tool_use_id: &str) -> Option<String> {
    let recs: Vec<Value> = lines
        .iter()
        .filter_map(|l| serde_json::from_str::<Value>(l).ok())
        .collect();
    let ty = |r: &Value| r.get("type").and_then(Value::as_str).map(str::to_string);
    let pty = |r: &Value| {
        r.get("payload")
            .and_then(|p| p.get("type"))
            .and_then(Value::as_str)
            .map(str::to_string)
    };
    // 이미 끝난 명령의 id 면 지금 호출이 아니다(꼬리 전체에서 본다).
    let done = recs.iter().any(|r| {
        pty(r).as_deref() == Some("item_completed")
            && r.pointer("/payload/item/id").and_then(Value::as_str) == Some(tool_use_id)
    });
    if done {
        return None;
    }
    let start = recs.iter().rposition(|r| {
        ty(r).as_deref() == Some("turn_context")
            || (ty(r).as_deref() == Some("event_msg") && pty(r).as_deref() == Some("task_started"))
    })?;
    let this_turn = &recs[start + 1..];
    let mut pending: Vec<(String, String)> = Vec::new();
    for r in this_turn {
        if ty(r).as_deref() != Some("response_item") {
            continue;
        }
        let p = r.get("payload")?;
        let id = p.get("call_id").and_then(Value::as_str);
        match pty(r).as_deref() {
            Some("custom_tool_call") if p.get("name").and_then(Value::as_str) == Some("exec") => {
                let code = p.get("input").and_then(Value::as_str)?;
                pending.push((id?.to_string(), code.to_string()));
            }
            Some("custom_tool_call_output") => {
                if let Some(id) = id {
                    pending.retain(|(c, _)| c != id);
                }
            }
            _ => {}
        }
    }
    match pending.as_slice() {
        [(_, code)] => Some(code.clone()),
        _ => None,
    }
}

#[cfg(test)]
#[path = "codex_code_mode_tests.rs"]
mod tests;
