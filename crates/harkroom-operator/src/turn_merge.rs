//! 에이전트 머지 손잡이(`repo.merge`) — TS `turnMerge.ts` 의 `createTurnMerge`(maybeHandle) 이식.
//! 관문 판정은 `pr_gate` 에 있다. 여기에는 부작용만 둔다: 서버 판정(`/agent/merge-checks`)·1회 승인 엿보기·
//! `gh pr merge --squash --match-head-commit`·merge queue 넣기·결과 보고(`/agent/merge-results`·`/agent/merge-closed`).
//!
//! 순서는 TS 와 같다: ① 인자 ② 턴 임대 ②′ 1회 승인 사전 확인(읽기 전용, 막히면 승인이 남는다) ③ 서버 판정(fail-closed)
//! ④ 관문(`PrGate::inspect`) ⑤ squash 또는 큐 넣기 ⑥ 보고. 활성 gh 계정으로 넘어가는 길은 없다(`GhTokens`).
use crate::local_merge::gh_env;
use crate::merge::{MERGE_TOOL, parse_merge_args};
use crate::pr_gate::{
    ENQUEUE_MUTATION, GateVerdict, GhToken, GhTokens, PrGate, PrInspection, PrView, QueueEntry,
    QueueInfo, ViewError, entry_of, ignored_list, is_already_queued_error, is_repo_access_error,
    is_sha,
};
use crate::turn_leases::TurnLease;
use harkroom_proto::p1::{RunnerLinkRequest, RunnerLinkResponse};
use serde_json::{Map, Value, json};

/// 에이전트 자격 JSON POST(경로, 본문) → (상태, 본문). Err 는 닿지 못한 것(TS `forward` 실패·status 0).
pub type Post<'a> = &'a dyn Fn(&str, String) -> Result<(u16, String), String>;

const USED: &str = " — the one-time approval was used; ask the owner to approve again (a new card)";

fn cut(s: &str, n: usize) -> String {
    s.chars().take(n).collect()
}

fn is_uuid(s: &str) -> bool {
    let b = s.as_bytes();
    b.len() == 36
        && b.iter().enumerate().all(|(i, c)| match i {
            8 | 13 | 18 | 23 => *c == b'-',
            _ => c.is_ascii_hexdigit(),
        })
}

fn is_login(s: &str) -> bool {
    (1..=39).contains(&s.len()) && s.bytes().all(|c| c.is_ascii_alphanumeric() || c == b'-')
}

fn no_repo_access(login: &str) -> String {
    format!(
        "the gh account {login} cannot access or merge this repository — granting more permission will not help; pick another account for this permission row, or a person merges it"
    )
}

fn names_of(names: &[String]) -> String {
    cut(&names.join(", "), 200)
}

fn fail(code: &str, message: &str) -> Outcome {
    Err(json!({"error": {"code": code, "message": message}}))
}

fn fail_with(code: &str, message: &str, extra: Value) -> Outcome {
    let mut v = json!({"error": {"code": code, "message": message}});
    if let (Some(o), Value::Object(e)) = (v.as_object_mut(), extra) {
        for (k, x) in e {
            o.insert(k, x);
        }
    }
    Err(v)
}

fn pr_info(pr: &PrView) -> Value {
    json!({"pr": {"state": pr.state, "headRefOid": pr.head_ref_oid, "mergeStateStatus": pr.merge_state_status}})
}

fn entry_json(e: Option<&QueueEntry>) -> Value {
    match e {
        Some(e) => json!({"position": e.position, "state": e.state}),
        None => Value::Null,
    }
}

type Outcome = Result<Value, Value>;

fn tool_call(payload: &Value) -> Option<&Value> {
    (payload.get("method").and_then(Value::as_str) == Some("tools/call")
        && payload.get("params").is_some_and(Value::is_object))
    .then_some(payload)
}

/// TS `isMergeCall`.
pub fn is_merge_call(req: &RunnerLinkRequest) -> bool {
    let RunnerLinkRequest::McpRequest { payload, .. } = req else {
        return false;
    };
    tool_call(payload)
        .and_then(|p| p.pointer("/params/name"))
        .and_then(Value::as_str)
        == Some(MERGE_TOOL)
}

/// TS `argsOf` — 셸에서 온 `arguments` 를 다시 잰다. 모르는 키가 있으면 거절.
fn args_of(payload: &Value) -> Result<(String, u64, String), String> {
    let Some(a) = payload
        .pointer("/params/arguments")
        .and_then(Value::as_object)
    else {
        return Err("arguments 가 없다".into());
    };
    let extra: Vec<&str> = a
        .keys()
        .map(String::as_str)
        .filter(|k| !matches!(*k, "repo" | "number" | "headSha"))
        .collect();
    if !extra.is_empty() {
        return Err(format!("받지 않는 인자: {}", extra.join(", ")));
    }
    // TS `String(x ?? '')` — 숫자는 그 글자, 문자열은 그대로, 없으면 빈 글자.
    let s = |k: &str| match a.get(k) {
        None | Some(Value::Null) => String::new(),
        Some(Value::String(s)) => s.clone(),
        Some(v) => v.to_string(),
    };
    let m = parse_merge_args(&[s("repo"), s("number"), "--head".into(), s("headSha")])?;
    Ok((m.repo, m.number, m.head_sha))
}

fn tool_result(id: Value, value: &Value, is_error: bool) -> Value {
    let mut result = json!({"content": [{"type": "text", "text": value.to_string()}]});
    if is_error {
        result["isError"] = Value::Bool(true);
    }
    json!({"jsonrpc": "2.0", "id": id, "result": result})
}

/// 1회 승인(서버 `/agent/merge-approvals/peek` 이 고를 바로 그것).
#[derive(Debug, Clone, PartialEq, Eq)]
struct Approval {
    id: String,
    gh_user: Option<String>,
    relax_checks: bool,
}

/// 사전 확인을 지난 1회 승인의 토큰.
struct ApprovedTok {
    tok: GhToken,
    approval_id: String,
    approval_gh_user: Option<String>,
    pr_head: Option<String>,
    ignored: Vec<String>,
}

/// TS `createTurnMerge` 의 deps 중 이 손잡이가 쓰는 것. `gate.first_seen` 은 `pr.status` 와 같은 것을 받는다.
#[derive(Clone)]
pub struct TurnMerge {
    pub gate: PrGate,
    pub tokens: GhTokens,
    pub home: String,
}

struct Call<'a> {
    tm: &'a TurnMerge,
    lease: &'a TurnLease,
    agent_id: &'a str,
    repo: String,
    number: u64,
    head_sha: String,
    post: Post<'a>,
    log: &'a dyn Fn(&str),
    used_login: Option<String>,
    no_pr_checks: bool,
    granted_by: Value,
}

#[derive(Default)]
struct Extra {
    ci_refusal: Option<Value>,
    ignored: Vec<String>,
    no_pr_checks: bool,
}

impl Call<'_> {
    fn env(&self, token: &str) -> Vec<(String, String)> {
        gh_env(&self.tm.home, Some(token))
    }

    fn body(&self, more: Value) -> String {
        let mut o = Map::new();
        o.insert("leaseId".into(), Value::String(self.lease.lease_id.clone()));
        o.insert("token".into(), Value::String(self.lease.token.clone()));
        o.insert("repo".into(), Value::String(self.repo.clone()));
        o.insert("number".into(), json!(self.number));
        if let Value::Object(m) = more {
            o.extend(m);
        }
        Value::Object(o).to_string()
    }

    fn already_queued(
        &self,
        entry: Option<&QueueEntry>,
        pr_head: Option<&str>,
        note: &str,
    ) -> Outcome {
        let differs = match pr_head {
            Some(h) if h != self.head_sha => {
                format!(" (the PR head is {h}, not the --head you passed)")
            }
            _ => String::new(),
        };
        Ok(json!({
            "merged": false, "queued": true, "alreadyQueued": true, "repo": self.repo, "number": self.number,
            "headSha": self.head_sha, "prHeadRefOid": pr_head, "queue": entry_json(entry),
            "note": format!("already in the merge queue — nothing was done{note}{differs}. Call the same command again later to check: already_queued while it waits, not_open with pr.state MERGED once the queue merged it."),
        }))
    }

    /// PR 이 이미 MERGED·CLOSED — 이 에이전트의 기다리는 머지 카드를 닫는다. 닿지 않아도 판정과 무관.
    fn report_closed(&self, state: Option<&str>) {
        let Some(state @ ("MERGED" | "CLOSED")) = state else {
            return;
        };
        if let Ok((200, _)) = (self.post)("/agent/merge-closed", self.body(json!({"state": state})))
        {
            (self.log)(&format!(
                "merge: {}#{} 이 이미 {state} — 기다리던 머지 카드를 닫았다 agent={}",
                self.repo, self.number, self.agent_id
            ));
        }
    }

    /// 결과 보고. CI 거절이면 서버가 카드용 `denialId` 를 돌려준다(uuid 모양일 때만).
    fn report(
        &self,
        result: &str,
        merge_sha: Option<&str>,
        error: Option<&str>,
        x: &Extra,
    ) -> Option<String> {
        let mut b = json!({"headSha": self.head_sha, "result": result, "mergeSha": merge_sha, "error": error});
        if let Some(u) = &self.used_login {
            b["ghUserUsed"] = json!(u);
        }
        if let Some(c) = &x.ci_refusal {
            b["ciRefusal"] = c.clone();
        }
        if !x.ignored.is_empty() {
            b["ignoredChecks"] = json!(ignored_list(&x.ignored));
        }
        if x.no_pr_checks {
            b["noPrChecks"] = Value::Bool(true);
        }
        match (self.post)("/agent/merge-results", self.body(b)) {
            Ok((201, text)) => serde_json::from_str::<Value>(&text)
                .ok()
                .and_then(|v| {
                    v.get("denialId")
                        .and_then(Value::as_str)
                        .map(str::to_string)
                })
                .filter(|d| is_uuid(d)),
            other => {
                let s = match other {
                    Ok((s, _)) => s.to_string(),
                    Err(_) => "no response".into(),
                };
                (self.log)(&format!(
                    "merge: {}#{} {result} 보고가 서버에 닿지 않았다({s})",
                    self.repo, self.number
                ));
                None
            }
        }
    }

    fn open_approval(&self) -> Result<Option<Approval>, ()> {
        let (200, text) = (self.post)(
            "/agent/merge-approvals/peek",
            self.body(json!({"headSha": self.head_sha})),
        )
        .map_err(|_| ())?
        else {
            return Err(());
        };
        let v: Value = serde_json::from_str(&text).map_err(|_| ())?;
        match v.get("approval") {
            None | Some(Value::Null) => Ok(None),
            Some(a) => {
                let id = a.get("id").and_then(Value::as_str).ok_or(())?;
                let gh_user = match a.get("ghUser") {
                    Some(Value::String(s)) => Some(s.clone()),
                    Some(Value::Null) => None,
                    _ => return Err(()),
                };
                Ok(Some(Approval {
                    id: id.into(),
                    gh_user,
                    relax_checks: a.get("relaxChecks") == Some(&Value::Bool(true)),
                }))
            }
        }
    }

    fn ci_refusal_of(v: &GateVerdict, pr: &PrView) -> Option<Value> {
        let why = v.why.as_ref()?;
        let ci = why.code == "ci_not_green"
            || (why.code == "not_mergeable"
                && pr.merge_state_status.as_deref() == Some("UNSTABLE"));
        ci.then(|| {
            let checks: Vec<String> = v.failing.iter().take(20).map(|n| cut(n, 80)).collect();
            json!({"code": why.code, "mergeState": pr.merge_state_status, "checks": checks})
        })
    }

    fn run(&mut self) -> Outcome {
        let tm = self.tm;
        let unavailable = "the server could not be reached — merge refused (fail-closed)";

        // ②′ 1회 승인 사전 확인 — 서버 판정(③)이 승인을 소모하므로 그 전에 읽기 전용으로 본다. 막히면 ③ 을 부르지 않는다.
        let pending = match self.open_approval() {
            Ok(p) => p,
            Err(()) => return fail("unavailable", unavailable),
        };
        let mut approved: Option<ApprovedTok> = None;
        if let Some(p) = &pending {
            let tok = match &p.gh_user {
                Some(u) => tm
                    .tokens
                    .token_for_login(u, "chosen in the one-time approval"),
                None => tm.tokens.token_for(&self.repo),
            };
            let tok = match tok {
                Ok(t) => t,
                Err(f) => {
                    return fail(
                        f.code,
                        &format!("{} — the one-time approval was not used", f.message),
                    );
                }
            };
            let not_used = " — the one-time approval was not used";
            match tm.gate.inspect(
                &self.repo,
                self.number,
                &self.env(&tok.token),
                Some(&self.head_sha),
                p.relax_checks,
            ) {
                PrInspection::ViewFailed(e) => {
                    let error = match e {
                        ViewError::Stderr(s) => cut(s.trim(), 300),
                        ViewError::Unparseable => "gh pr view returned no JSON".into(),
                    };
                    if is_repo_access_error(&error) {
                        return fail(
                            "no_repo_access",
                            &format!("{}{not_used}", no_repo_access(&tok.login)),
                        );
                    }
                    return fail(
                        "pr_not_found",
                        &format!("gh pr view failed: {error}{not_used}"),
                    );
                }
                PrInspection::Ok {
                    pr,
                    queue,
                    verdict: None,
                    ..
                } => {
                    let entry = queue.as_ref().and_then(|q| q.entry.as_ref());
                    return self.already_queued(
                        entry,
                        pr.head_ref_oid.as_deref(),
                        " (the one-time approval was not used)",
                    );
                }
                PrInspection::Ok {
                    pr,
                    verdict: Some(v),
                    no_pr_checks,
                    ..
                } => {
                    self.no_pr_checks = no_pr_checks;
                    if let Some(why) = &v.why {
                        if why.code == "not_open" {
                            self.report_closed(pr.state.as_deref());
                        }
                        return fail_with(
                            &why.code,
                            &format!("{}{not_used}", why.message),
                            pr_info(&pr),
                        );
                    }
                    approved = Some(ApprovedTok {
                        tok,
                        approval_id: p.id.clone(),
                        approval_gh_user: p.gh_user.clone(),
                        pr_head: pr.head_ref_oid.clone(),
                        ignored: v.ignored,
                    });
                }
            }
        }

        // ③ 서버 판정. 머지에 쓸 계정 이름을 싣는다(위임 줄 `limits.ghUser` 와 맞춘다).
        let intended: Option<(String, String)> = match &approved {
            Some(a) => Some((
                a.tok.login.clone(),
                "chosen in the one-time approval".into(),
            )),
            None => (tm.tokens.gh_user_for)(&self.repo)
                .filter(|(l, _)| is_login(l))
                .map(|(l, scope)| (l, format!("set for {scope}"))),
        };
        let mut cb = json!({"headSha": self.head_sha});
        if let Some((l, _)) = &intended {
            cb["ghUser"] = json!(l);
        }
        let (status, text) = match (self.post)("/agent/merge-checks", self.body(cb)) {
            Ok((0, _)) | Err(_) => return fail("unavailable", unavailable),
            Ok(r) => r,
        };
        if status != 200 {
            let e = serde_json::from_str::<Value>(&text)
                .ok()
                .and_then(|v| v.get("error").cloned());
            let code = e
                .as_ref()
                .and_then(|e| e.get("code"))
                .and_then(Value::as_str)
                .map(str::to_string)
                .unwrap_or_else(|| format!("http_{status}"));
            let denial = e
                .as_ref()
                .and_then(|e| e.get("denialId"))
                .and_then(Value::as_str)
                .filter(|d| is_uuid(d))
                .map(str::to_string);
            if code == "not_granted" || code == "cause_not_human" {
                // 이미 머지·닫혔으면 카드를 세울 일이 아니다(Q3). 이미 큐에 있어도 그렇다. 읽기 전용.
                if let Ok(tok) = tm.tokens.token_for(&self.repo) {
                    let env = self.env(&tok.token);
                    if let Ok(pr) = tm.gate.view_pr(&self.repo, self.number, &env) {
                        let state = pr.state.as_deref();
                        if matches!(state, Some("MERGED" | "CLOSED")) {
                            self.report_closed(state);
                            let s = state.unwrap_or_default();
                            return fail_with(
                                "not_open",
                                &format!("PR is {s} — nothing to merge and no card is needed"),
                                json!({"pr": {"state": s}}),
                            );
                        }
                        if state == Some("OPEN")
                            && let Some(q) = tm.gate.queue_info(&self.repo, self.number, &env)
                            && q.in_queue
                        {
                            return self.already_queued(
                                q.entry.as_ref(),
                                pr.head_ref_oid.as_deref(),
                                "",
                            );
                        }
                    }
                }
            }
            if let Some(d) = denial {
                return Err(json!({"error": {
                    "code": code,
                    "message": format!("merge not allowed: {code} — ask the owner with message.ask and mergeDenialId"),
                    "denialId": d,
                }}));
            }
            return fail(&code, &format!("merge not allowed: {code}"));
        }
        let granted: Value = serde_json::from_str(&text).unwrap_or(Value::Null);
        self.granted_by = granted
            .get("grantedBy")
            .cloned()
            .filter(Value::is_string)
            .unwrap_or(Value::Null);

        // 위임 줄에 계정이 박혀 있는데 쓸 계정과 다르면 머지하지 않는다(security n11). 로그인은 대소문자 무시.
        let using = approved
            .as_ref()
            .map(|a| a.tok.login.clone())
            .or(intended.as_ref().map(|i| i.0.clone()));
        if let Some(line) = granted
            .pointer("/mandateLine/ghUser")
            .and_then(Value::as_str)
            && Some(line.to_lowercase()) != using.as_ref().map(|u| u.to_lowercase())
        {
            self.report(
                "failed",
                None,
                Some("mandate_gh_user_mismatch: the mandate line names a different GitHub account"),
                &Extra::default(),
            );
            let would = intended
                .as_ref()
                .map(|i| i.0.as_str())
                .unwrap_or("(no account)");
            return fail(
                "mandate_gh_user_mismatch",
                &format!(
                    "the mandate line allows merging only as {}, but this device would merge as {would} — nothing was merged",
                    cut(line, 39)
                ),
            );
        }

        // ③′ 승인이 소모됐다 — 사전 확인한 바로 그 승인(id·계정)이어야 한다(security F2).
        if let Some(ga) = granted.get("approval").filter(|a| a.is_object()) {
            let g_user = ga.get("ghUser").and_then(Value::as_str);
            let ok = approved.as_ref().is_some_and(|a| {
                let same_account = match &a.approval_gh_user {
                    Some(_) => g_user == Some(a.tok.login.as_str()),
                    None => g_user.is_none(),
                };
                ga.get("id").and_then(Value::as_str) == Some(a.approval_id.as_str()) && same_account
            });
            let Some(a) = approved.filter(|_| ok) else {
                self.report("failed", None, Some("approval_mismatch: the approval used by the server is not the one pre-checked"), &Extra::default());
                return fail(
                    "approval_mismatch",
                    "the server used a one-time approval this wrapper did not pre-check — nothing was merged; ask the owner to approve again",
                );
            };
            return self.merge_now(&a.tok, true, None, a.pr_head.as_deref(), &a.ignored);
        }

        // ④ 머지 전 확인 — 서버에 알린 바로 그 계정의 토큰만 쓴다.
        let tok = match &intended {
            Some((l, why)) => tm.tokens.token_for_login(l, why),
            None => tm.tokens.token_for(&self.repo),
        };
        let tok = match tok {
            Ok(t) => t,
            Err(f) => {
                self.report(
                    "failed",
                    None,
                    Some(&format!("{}: {}", f.code, f.message)),
                    &Extra::default(),
                );
                return fail(f.code, &f.message);
            }
        };
        let env = self.env(&tok.token);
        let (pr, queue, verdict, no_pr_checks) =
            match tm
                .gate
                .inspect(&self.repo, self.number, &env, Some(&self.head_sha), false)
            {
                PrInspection::ViewFailed(ViewError::Unparseable) => {
                    self.report(
                        "failed",
                        None,
                        Some("gh pr view: unparseable"),
                        &Extra::default(),
                    );
                    return fail("pr_not_found", "gh pr view returned no JSON");
                }
                PrInspection::ViewFailed(ViewError::Stderr(stderr)) => {
                    let e = cut(stderr.trim(), 300);
                    self.report(
                        "failed",
                        None,
                        Some(&format!("gh pr view (as {}): {e}", tok.login)),
                        &Extra::default(),
                    );
                    if is_repo_access_error(&stderr) {
                        return fail("no_repo_access", &no_repo_access(&tok.login));
                    }
                    return fail("pr_not_found", &format!("gh pr view failed: {e}"));
                }
                PrInspection::Ok {
                    pr,
                    queue,
                    verdict,
                    no_pr_checks,
                } => (pr, queue, verdict, no_pr_checks),
            };
        // 이미 큐에 있으면 다시 넣지 않는다(관문보다 먼저 — 아무것도 하지 않는 길이다).
        let Some(verdict) = verdict else {
            let entry = queue.as_ref().and_then(|q| q.entry.as_ref());
            return self.already_queued(entry, pr.head_ref_oid.as_deref(), "");
        };
        self.no_pr_checks = no_pr_checks;
        if let Some(why) = &verdict.why {
            if why.code == "not_open" {
                // 큐가 머지한 PR 에 「머지 실패」 줄을 남기지 않는다 — 카드만 닫는다.
                self.report_closed(pr.state.as_deref());
                return fail_with(&why.code, &why.message, pr_info(&pr));
            }
            // 유예 중은 실패가 아니라 기다림이다 — 보고하지 않는다(security n3).
            if why.code == "ci_pending" {
                return fail_with(&why.code, &why.message, pr_info(&pr));
            }
            let ci_refusal = Self::ci_refusal_of(&verdict, &pr);
            let denial = self.report(
                "failed",
                None,
                Some(&format!("{}: {}", why.code, why.message)),
                &Extra {
                    ci_refusal: ci_refusal.clone(),
                    ..Extra::default()
                },
            );
            if let (Some(d), Some(_)) = (denial, ci_refusal) {
                let mut v = json!({"error": {
                    "code": why.code,
                    "message": format!("{} — the owner can approve this one merge ignoring CI: post message.ask with mergeDenialId", why.message),
                    "denialId": d,
                }});
                v["pr"] = pr_info(&pr)["pr"].clone();
                return Err(v);
            }
            return fail_with(&why.code, &why.message, pr_info(&pr));
        }
        self.merge_now(
            &tok,
            false,
            queue,
            pr.head_ref_oid.as_deref(),
            &verdict.ignored,
        )
    }

    fn ignored_of(ignored: &[String], v: &mut Value) {
        if !ignored.is_empty() {
            v["ignoredChecks"] = json!(ignored_list(ignored));
        }
    }

    /// ⑤ squash 로만, head 를 못박고. 대상 브랜치가 merge queue 를 쓰면 대신 큐에 넣는다.
    fn merge_now(
        &mut self,
        t: &GhToken,
        via_approval: bool,
        known: Option<QueueInfo>,
        pr_head: Option<&str>,
        ignored: &[String],
    ) -> Outcome {
        let env = self.env(&t.token);
        self.used_login = Some(t.login.clone());
        let used_note = if via_approval {
            " (the one-time approval was used)"
        } else {
            ""
        };
        let q = known.or_else(|| self.tm.gate.queue_info(&self.repo, self.number, &env));
        if let Some(q) = &q {
            if q.in_queue {
                return self.already_queued(q.entry.as_ref(), pr_head, used_note);
            }
            if q.enabled {
                return self.enqueue_now(t, via_approval, q, &env, pr_head, used_note, ignored);
            }
        }
        let gh = &self.tm.gate.gh;
        let n = self.number.to_string();
        let args: Vec<String> = [
            "pr",
            "merge",
            &n,
            "-R",
            &self.repo,
            "--squash",
            "--match-head-commit",
            &self.head_sha,
        ]
        .iter()
        .map(|s| s.to_string())
        .collect();
        let merge = gh(&args, &env);
        let used = if via_approval { USED } else { "" };
        if merge.code != 0 {
            let e = cut(merge.stderr.trim(), 300);
            self.report("failed", None, Some(&e), &Extra::default());
            if is_repo_access_error(&merge.stderr) {
                return fail(
                    "no_repo_access",
                    &format!("{}{used}", no_repo_access(&t.login)),
                );
            }
            return fail("merge_failed", &format!("gh pr merge failed: {e}{used}"));
        }
        let after: Vec<String> = ["pr", "view", &n, "-R", &self.repo, "--json", "mergeCommit"]
            .iter()
            .map(|s| s.to_string())
            .collect();
        let after = gh(&after, &env);
        let merge_sha = serde_json::from_str::<Value>(&after.stdout)
            .ok()
            .and_then(|v| {
                v.pointer("/mergeCommit/oid")
                    .and_then(Value::as_str)
                    .map(str::to_string)
            })
            .filter(|s| is_sha(s));
        self.report(
            "merged",
            merge_sha.as_deref(),
            None,
            &Extra {
                ignored: ignored.to_vec(),
                no_pr_checks: self.no_pr_checks,
                ..Extra::default()
            },
        );
        (self.log)(&format!(
            "merge: {}#{} 머지됨 {} agent={}{}{}",
            self.repo,
            self.number,
            merge_sha.as_deref().unwrap_or("(sha 모름)"),
            self.agent_id,
            if via_approval { " (1회 승인)" } else { "" },
            if ignored.is_empty() {
                String::new()
            } else {
                format!(" 비필수 체크 무시: {}", names_of(ignored))
            },
        ));
        let mut v = json!({
            "merged": true, "queued": false, "repo": self.repo, "number": self.number, "headSha": self.head_sha,
            "mergeSha": merge_sha, "grantedBy": self.granted_by, "viaApproval": via_approval, "ghUser": t.login,
            "note": if self.no_pr_checks { "merged with no checks: this repository defines no CI for pull requests — reported to the thread as a system line" } else { "reported to the thread as a system line" },
        });
        Self::ignored_of(ignored, &mut v);
        if self.no_pr_checks {
            v["noPrChecks"] = Value::Bool(true);
        }
        Ok(v)
    }

    /// ⑤′ merge queue — 큐에 넣고 끝낸다(기다리지 않는다).
    #[allow(clippy::too_many_arguments)]
    fn enqueue_now(
        &mut self,
        t: &GhToken,
        via_approval: bool,
        q: &QueueInfo,
        env: &[(String, String)],
        pr_head: Option<&str>,
        used_note: &str,
        ignored: &[String],
    ) -> Outcome {
        let args: Vec<String> = vec![
            "api".into(),
            "graphql".into(),
            "-f".into(),
            format!("query={ENQUEUE_MUTATION}"),
            "-f".into(),
            format!("id={}", q.id),
            "-f".into(),
            format!("head={}", self.head_sha),
        ];
        let r = (self.tm.gate.gh)(&args, env);
        let mut entry: Option<QueueEntry> = None;
        let mut gql_error: Option<String> = None;
        if r.code == 0 {
            match serde_json::from_str::<Value>(&r.stdout) {
                Ok(d) => match d
                    .get("errors")
                    .and_then(Value::as_array)
                    .filter(|e| !e.is_empty())
                {
                    Some(errs) => {
                        gql_error = Some(
                            errs.iter()
                                .map(|e| {
                                    e.get("message").and_then(Value::as_str).unwrap_or_default()
                                })
                                .collect::<Vec<_>>()
                                .join("; "),
                        )
                    }
                    None => entry = entry_of(d.pointer("/data/enqueuePullRequest/mergeQueueEntry")),
                },
                Err(_) => gql_error = Some("enqueuePullRequest returned no JSON".into()),
            }
        }
        let err_raw = if r.code != 0 {
            r.stderr.clone()
        } else if let Some(g) = gql_error {
            g
        } else if entry.is_none() {
            "enqueuePullRequest returned no queue entry".into()
        } else {
            String::new()
        };
        let err = cut(err_raw.trim(), 300);
        if !err.is_empty() {
            // 문구만 믿지 않는다(security n1) — 다시 읽어 정말 큐에 있을 때만 alreadyQueued.
            if is_already_queued_error(&err)
                && let Some(now) = self.tm.gate.queue_info(&self.repo, self.number, env)
                && now.in_queue
            {
                return self.already_queued(now.entry.as_ref(), pr_head, used_note);
            }
            self.report(
                "failed",
                None,
                Some(&format!("enqueue: {err}")),
                &Extra::default(),
            );
            let used = if via_approval { USED } else { "" };
            if is_repo_access_error(&err) {
                return fail(
                    "no_repo_access",
                    &format!("{}{used}", no_repo_access(&t.login)),
                );
            }
            return fail(
                "enqueue_failed",
                &format!("enqueuePullRequest failed: {err}{used}"),
            );
        }
        self.report(
            "queued",
            None,
            None,
            &Extra {
                ignored: ignored.to_vec(),
                no_pr_checks: self.no_pr_checks,
                ..Extra::default()
            },
        );
        (self.log)(&format!(
            "merge: {}#{} 머지 큐에 넣음 위치={} agent={}{}{}",
            self.repo,
            self.number,
            entry
                .as_ref()
                .and_then(|e| e.position)
                .map(|p| p.to_string())
                .unwrap_or_else(|| "?".into()),
            self.agent_id,
            if via_approval { " (1회 승인)" } else { "" },
            if ignored.is_empty() {
                String::new()
            } else {
                format!(" 비필수 체크 무시: {}", names_of(ignored))
            },
        ));
        let mut v = json!({
            "merged": false, "queued": true, "alreadyQueued": false, "repo": self.repo, "number": self.number,
            "headSha": self.head_sha, "queue": entry_json(entry.as_ref()), "grantedBy": self.granted_by,
            "viaApproval": via_approval, "ghUser": t.login,
            "note": "added to the merge queue and reported to the thread as a system line — the queue merges it later. Call the same command again to check: already_queued while it waits, not_open with pr.state MERGED once merged.",
        });
        Self::ignored_of(ignored, &mut v);
        if self.no_pr_checks {
            v["noPrChecks"] = Value::Bool(true);
        }
        Ok(v)
    }
}

impl TurnMerge {
    /// `repo.merge` 면 답하고 아니면 None(TS `maybeHandle`). `lease` 는 `lookup_for(runner, agent, cause)` 결과.
    pub fn maybe_handle(
        &self,
        agent_id: &str,
        req: &RunnerLinkRequest,
        lease: Option<&TurnLease>,
        post: Post<'_>,
        log: &dyn Fn(&str),
    ) -> Option<RunnerLinkResponse> {
        if !is_merge_call(req) {
            return None;
        }
        let RunnerLinkRequest::McpRequest { id, payload, .. } = req else {
            return None;
        };
        let rpc_id = payload.get("id").cloned().unwrap_or(Value::Null);
        let reply = |r: Outcome| {
            let (v, is_error) = match r {
                Ok(v) => (v, false),
                Err(v) => (v, true),
            };
            RunnerLinkResponse::McpResponse {
                id: id.clone(),
                messages: vec![tool_result(rpc_id.clone(), &v, is_error)],
            }
        };
        let (repo, number, head_sha) = match args_of(payload) {
            Ok(a) => a,
            Err(e) => return Some(reply(fail("bad_request", &e))),
        };
        let Some(lease) = lease.filter(|l| l.agent_id == agent_id) else {
            return Some(reply(fail(
                "no_lease",
                "merge is not available in this turn (no turn lease)",
            )));
        };
        let mut call = Call {
            tm: self,
            lease,
            agent_id,
            repo,
            number,
            head_sha,
            post,
            log,
            used_login: None,
            no_pr_checks: false,
            granted_by: Value::Null,
        };
        // TS 는 예외를 merge_error 로 바꾼다 — Rust 쪽은 panic 만 그 자리에 해당한다.
        let r = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| call.run()));
        Some(reply(r.unwrap_or_else(|_| {
            log("merge: 실패 — 내부 오류(panic)");
            fail(
                "merge_error",
                "the merge wrapper hit an internal error; nothing was merged unless gh said so",
            )
        })))
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::local_merge::ExecResult;
    use std::cell::RefCell;
    use std::collections::HashMap;
    use std::sync::{Arc, Mutex};

    const AGENT: &str = "11111111-2222-4333-8444-555555555555";
    const H: &str = "0123456789abcdef0123456789abcdef01234567";
    const M: &str = "89abcdef0123456789abcdef0123456789abcdef";
    const DENIAL: &str = "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee";

    fn ok(s: &str) -> ExecResult {
        ExecResult {
            code: 0,
            stdout: s.into(),
            stderr: String::new(),
        }
    }

    type Calls = Arc<Mutex<Vec<String>>>;

    /// 글자 조각 → 응답. 먼저 맞는 것을 쓴다.
    fn tm(
        script: Vec<(&'static str, ExecResult)>,
        user: Option<&'static str>,
    ) -> (TurnMerge, Calls) {
        let calls: Calls = Arc::new(Mutex::new(Vec::new()));
        let c = calls.clone();
        let script = Arc::new(script);
        let s2 = script.clone();
        let pick = move |joined: String| {
            s2.iter()
                .find(|(k, _)| joined.contains(k))
                .map(|(_, r)| r.clone())
                .unwrap_or(ExecResult {
                    code: 1,
                    stdout: String::new(),
                    stderr: "unscripted".into(),
                })
        };
        let p2 = pick.clone();
        let gate = PrGate {
            gh: Arc::new(move |args: &[String], _e: &[(String, String)]| {
                let j = args.join(" ");
                c.lock().unwrap().push(j.clone());
                pick(j)
            }),
            now: Arc::new(|| 1_000),
            first_seen: Arc::new(Mutex::new(HashMap::new())),
        };
        let tokens = GhTokens {
            exec: Arc::new(move |_f: &str, args: &[String], _e: &[(String, String)]| {
                p2(args.join(" "))
            }),
            gh_path: "/usr/bin/gh".into(),
            home: "/h".into(),
            gh_user_for: Arc::new(move |_r: &str| user.map(|u| (u.to_string(), "o/*".to_string()))),
        };
        (
            TurnMerge {
                gate,
                tokens,
                home: "/h".into(),
            },
            calls,
        )
    }

    fn pr_json(state: &str, mss: &str) -> String {
        json!({"state": state, "isDraft": false, "headRefOid": H, "baseRefName": "main", "mergeStateStatus": mss,
            "statusCheckRollup": [{"status": "COMPLETED", "conclusion": "SUCCESS", "name": "ci", "workflowName": "w"}]})
        .to_string()
    }

    fn queue(enabled: bool, in_queue: bool) -> String {
        json!({"data": {"repository": {"pullRequest": {"id": "PR_1", "isMergeQueueEnabled": enabled, "isInMergeQueue": in_queue,
            "mergeQueueEntry": if in_queue { json!({"position": 2, "state": "QUEUED"}) } else { Value::Null }}}}})
        .to_string()
    }

    fn lease() -> TurnLease {
        TurnLease {
            lease_id: "L1".into(),
            token: "T1".into(),
            agent_id: AGENT.into(),
        }
    }

    fn req(args: Value) -> RunnerLinkRequest {
        RunnerLinkRequest::McpRequest {
            id: "r1".into(),
            payload: json!({"jsonrpc": "2.0", "id": 7, "method": "tools/call", "params": {"name": MERGE_TOOL, "arguments": args}}),
            cause: Some("c1".into()),
            cwd: None,
            turn_id: None,
            command_files: None,
        }
    }

    fn good() -> RunnerLinkRequest {
        req(json!({"repo": "o/r", "number": 5, "headSha": H}))
    }

    fn out(r: Option<RunnerLinkResponse>) -> (Value, bool) {
        let Some(RunnerLinkResponse::McpResponse { messages, .. }) = r else {
            panic!("응답 없음")
        };
        let res = &messages[0]["result"];
        (
            serde_json::from_str(res["content"][0]["text"].as_str().unwrap()).unwrap(),
            res.get("isError") == Some(&Value::Bool(true)),
        )
    }

    /// 서버 가짜: 경로 → (상태, 본문). 받은 (경로, 본문) 을 남긴다.
    struct Server {
        routes: HashMap<&'static str, (u16, String)>,
        seen: RefCell<Vec<(String, Value)>>,
    }
    impl Server {
        fn new(r: Vec<(&'static str, u16, Value)>) -> Self {
            Server {
                routes: r
                    .into_iter()
                    .map(|(p, s, b)| (p, (s, b.to_string())))
                    .collect(),
                seen: RefCell::new(vec![]),
            }
        }
        fn post(&self, p: &str, b: String) -> Result<(u16, String), String> {
            self.seen
                .borrow_mut()
                .push((p.into(), serde_json::from_str(&b).unwrap()));
            self.routes.get(p).cloned().ok_or_else(|| "down".into())
        }
        fn paths(&self) -> Vec<String> {
            self.seen.borrow().iter().map(|(p, _)| p.clone()).collect()
        }
        fn body(&self, p: &str) -> Value {
            self.seen
                .borrow()
                .iter()
                .rev()
                .find(|(x, _)| x == p)
                .map(|(_, b)| b.clone())
                .unwrap()
        }
    }

    fn run(
        t: &TurnMerge,
        s: &Server,
        r: &RunnerLinkRequest,
        l: Option<&TurnLease>,
    ) -> (Value, bool) {
        let post = |p: &str, b: String| s.post(p, b);
        out(t.maybe_handle(AGENT, r, l, &post, &|_| {}))
    }

    fn std_server(check: (u16, Value)) -> Server {
        Server::new(vec![
            (
                "/agent/merge-approvals/peek",
                200,
                json!({"approval": null}),
            ),
            ("/agent/merge-checks", check.0, check.1),
            ("/agent/merge-results", 201, json!({})),
            ("/agent/merge-closed", 200, json!({})),
        ])
    }

    #[test]
    fn not_merge_call_passes_through() {
        let (t, _) = tm(vec![], Some("bot"));
        let s = std_server((200, json!({})));
        let mut r = good();
        if let RunnerLinkRequest::McpRequest { payload, .. } = &mut r {
            payload["params"]["name"] = json!("secret.mount");
        }
        let post = |p: &str, b: String| s.post(p, b);
        assert!(
            t.maybe_handle(AGENT, &r, Some(&lease()), &post, &|_| {})
                .is_none()
        );
    }

    #[test]
    fn bad_args_and_no_lease() {
        let (t, _) = tm(vec![], Some("bot"));
        let s = std_server((200, json!({})));
        let (v, e) = run(
            &t,
            &s,
            &req(json!({"repo": "o/r", "number": 5, "headSha": H, "admin": true})),
            Some(&lease()),
        );
        assert!(e);
        assert_eq!(v["error"]["code"], "bad_request");
        let (v, _) = run(&t, &s, &good(), None);
        assert_eq!(v["error"]["code"], "no_lease");
        // 다른 에이전트의 임대도 no_lease
        let other = TurnLease {
            agent_id: "x".into(),
            ..lease()
        };
        let (v, _) = run(&t, &s, &good(), Some(&other));
        assert_eq!(v["error"]["code"], "no_lease");
        assert!(s.paths().is_empty());
    }

    #[test]
    fn happy_squash_merge_reports() {
        let (t, calls) = tm(
            vec![
                ("auth token -u bot", ok("tok-x")),
                (
                    "mergeCommit",
                    ok(&json!({"mergeCommit": {"oid": M}}).to_string()),
                ),
                ("statusCheckRollup", ok(&pr_json("OPEN", "CLEAN"))),
                ("isMergeQueueEnabled", ok(&queue(false, false))),
                ("pr merge", ok("")),
            ],
            Some("bot"),
        );
        let s = std_server((200, json!({"grantedBy": "grant"})));
        let (v, e) = run(&t, &s, &good(), Some(&lease()));
        assert!(!e, "{v}");
        assert_eq!(v["merged"], true);
        assert_eq!(v["mergeSha"], M);
        assert_eq!(v["ghUser"], "bot");
        assert_eq!(
            s.paths(),
            [
                "/agent/merge-approvals/peek",
                "/agent/merge-checks",
                "/agent/merge-results"
            ]
        );
        assert_eq!(s.body("/agent/merge-checks")["ghUser"], "bot");
        let rep = s.body("/agent/merge-results");
        assert_eq!(rep["result"], "merged");
        assert_eq!(rep["ghUserUsed"], "bot");
        assert_eq!(rep["leaseId"], "L1");
        let calls = calls.lock().unwrap();
        assert!(
            calls
                .iter()
                .any(|c| c == &format!("pr merge 5 -R o/r --squash --match-head-commit {H}"))
        );
        assert!(
            !calls
                .iter()
                .any(|c| c.contains("--admin") || c.contains("--auto"))
        );
    }

    #[test]
    fn server_unreachable_is_fail_closed() {
        let (t, calls) = tm(vec![], Some("bot"));
        let s = Server::new(vec![]);
        let (v, _) = run(&t, &s, &good(), Some(&lease()));
        assert_eq!(v["error"]["code"], "unavailable");
        assert!(calls.lock().unwrap().is_empty());
    }

    #[test]
    fn not_granted_passes_denial_id() {
        let (t, calls) = tm(
            vec![
                ("auth token", ok("tok")),
                ("statusCheckRollup", ok(&pr_json("OPEN", "CLEAN"))),
                ("isMergeQueueEnabled", ok(&queue(false, false))),
            ],
            Some("bot"),
        );
        let s = std_server((
            403,
            json!({"error": {"code": "not_granted", "denialId": DENIAL}}),
        ));
        let (v, e) = run(&t, &s, &good(), Some(&lease()));
        assert!(e);
        assert_eq!(v["error"]["code"], "not_granted");
        assert_eq!(v["error"]["denialId"], DENIAL);
        assert!(
            !calls
                .lock()
                .unwrap()
                .iter()
                .any(|c| c.starts_with("pr merge"))
        );
        // uuid 가 아닌 denialId 는 버린다
        let s = std_server((
            403,
            json!({"error": {"code": "not_granted", "denialId": "nope"}}),
        ));
        let (v, _) = run(&t, &s, &good(), Some(&lease()));
        assert!(v["error"].get("denialId").is_none());
    }

    #[test]
    fn not_granted_but_merged_closes_card() {
        let (t, _) = tm(
            vec![
                ("auth token", ok("tok")),
                ("statusCheckRollup", ok(&pr_json("MERGED", "UNKNOWN"))),
            ],
            Some("bot"),
        );
        let s = std_server((
            403,
            json!({"error": {"code": "not_granted", "denialId": DENIAL}}),
        ));
        let (v, _) = run(&t, &s, &good(), Some(&lease()));
        assert_eq!(v["error"]["code"], "not_open");
        assert!(v["error"].get("denialId").is_none());
        assert_eq!(s.body("/agent/merge-closed")["state"], "MERGED");
    }

    #[test]
    fn mandate_line_account_mismatch() {
        let (t, calls) = tm(vec![], Some("bot"));
        let s = std_server((200, json!({"mandateLine": {"ghUser": "someone-else"}})));
        let (v, _) = run(&t, &s, &good(), Some(&lease()));
        assert_eq!(v["error"]["code"], "mandate_gh_user_mismatch");
        assert_eq!(s.body("/agent/merge-results")["result"], "failed");
        assert!(calls.lock().unwrap().is_empty());
        // 대소문자는 가리지 않는다
        let (t, _) = tm(
            vec![
                ("auth token", ok("tok")),
                ("statusCheckRollup", ok(&pr_json("OPEN", "CLEAN"))),
                ("isMergeQueueEnabled", ok(&queue(false, false))),
                ("pr merge", ok("")),
            ],
            Some("Bot"),
        );
        let s = std_server((200, json!({"mandateLine": {"ghUser": "bot"}})));
        let (v, e) = run(&t, &s, &good(), Some(&lease()));
        assert!(!e, "{v}");
    }

    #[test]
    fn unexpected_approval_is_refused() {
        let (t, calls) = tm(vec![("auth token", ok("tok"))], Some("bot"));
        let s = std_server((200, json!({"approval": {"id": "A9", "ghUser": "bot"}})));
        let (v, _) = run(&t, &s, &good(), Some(&lease()));
        assert_eq!(v["error"]["code"], "approval_mismatch");
        assert!(
            !calls
                .lock()
                .unwrap()
                .iter()
                .any(|c| c.starts_with("pr merge"))
        );
    }

    #[test]
    fn approval_precheck_blocks_without_consuming() {
        // 사전 확인에서 head 가 다르면 merge-checks 를 부르지 않는다 — 승인이 남는다.
        let other = json!({"state": "OPEN", "isDraft": false, "headRefOid": M, "baseRefName": "main", "mergeStateStatus": "CLEAN", "statusCheckRollup": []}).to_string();
        let (t, _) = tm(
            vec![
                ("auth token", ok("tok")),
                ("statusCheckRollup", ok(&other)),
                ("isMergeQueueEnabled", ok(&queue(false, false))),
            ],
            Some("bot"),
        );
        let s = Server::new(vec![
            (
                "/agent/merge-approvals/peek",
                200,
                json!({"approval": {"id": "A1", "ghUser": "bot", "relaxChecks": false}}),
            ),
            ("/agent/merge-checks", 200, json!({})),
        ]);
        let (v, e) = run(&t, &s, &good(), Some(&lease()));
        assert!(e);
        assert!(
            v["error"]["message"]
                .as_str()
                .unwrap()
                .ends_with("the one-time approval was not used"),
            "{v}"
        );
        assert!(!s.paths().iter().any(|p| p == "/agent/merge-checks"));
    }

    #[test]
    fn approval_flow_merges_with_same_approval() {
        let (t, calls) = tm(
            vec![
                ("auth token -u bot", ok("tok")),
                (
                    "mergeCommit",
                    ok(&json!({"mergeCommit": {"oid": M}}).to_string()),
                ),
                ("statusCheckRollup", ok(&pr_json("OPEN", "CLEAN"))),
                ("isMergeQueueEnabled", ok(&queue(false, false))),
                ("pr merge", ok("")),
            ],
            None,
        );
        let s = Server::new(vec![
            (
                "/agent/merge-approvals/peek",
                200,
                json!({"approval": {"id": "A1", "ghUser": "bot"}}),
            ),
            (
                "/agent/merge-checks",
                200,
                json!({"approval": {"id": "A1", "ghUser": "bot"}}),
            ),
            ("/agent/merge-results", 201, json!({})),
        ]);
        let (v, e) = run(&t, &s, &good(), Some(&lease()));
        assert!(!e, "{v}");
        assert_eq!(v["viaApproval"], true);
        assert!(
            calls
                .lock()
                .unwrap()
                .iter()
                .any(|c| c.starts_with("pr merge"))
        );
    }

    #[test]
    fn queue_branch_enqueues_and_already_queued_is_noop() {
        let enq = json!({"data": {"enqueuePullRequest": {"mergeQueueEntry": {"position": 1, "state": "QUEUED"}}}}).to_string();
        let (t, calls) = tm(
            vec![
                ("auth token", ok("tok")),
                ("statusCheckRollup", ok(&pr_json("OPEN", "CLEAN"))),
                ("enqueuePullRequest", ok(&enq)),
                ("isMergeQueueEnabled", ok(&queue(true, false))),
            ],
            Some("bot"),
        );
        let s = std_server((200, json!({})));
        let (v, e) = run(&t, &s, &good(), Some(&lease()));
        assert!(!e, "{v}");
        assert_eq!(v["queued"], true);
        assert_eq!(v["queue"]["position"], 1);
        assert_eq!(s.body("/agent/merge-results")["result"], "queued");
        assert!(
            !calls
                .lock()
                .unwrap()
                .iter()
                .any(|c| c.starts_with("pr merge"))
        );

        let (t, _) = tm(
            vec![
                ("auth token", ok("tok")),
                ("statusCheckRollup", ok(&pr_json("OPEN", "CLEAN"))),
                ("isMergeQueueEnabled", ok(&queue(true, true))),
            ],
            Some("bot"),
        );
        let s = std_server((200, json!({})));
        let (v, e) = run(&t, &s, &good(), Some(&lease()));
        assert!(!e);
        assert_eq!(v["alreadyQueued"], true);
        assert!(!s.paths().iter().any(|p| p == "/agent/merge-results"));
    }

    #[test]
    fn ci_refusal_carries_denial_and_merged_pr_not_reported_failed() {
        let red = json!({"state": "OPEN", "isDraft": false, "headRefOid": H, "baseRefName": "main", "mergeStateStatus": "CLEAN",
            "statusCheckRollup": [{"status": "COMPLETED", "conclusion": "FAILURE", "name": "ci", "workflowName": "w"}]}).to_string();
        let (t, calls) = tm(
            vec![
                ("auth token", ok("tok")),
                ("statusCheckRollup", ok(&red)),
                ("isMergeQueueEnabled", ok(&queue(false, false))),
            ],
            Some("bot"),
        );
        let s = Server::new(vec![
            (
                "/agent/merge-approvals/peek",
                200,
                json!({"approval": null}),
            ),
            ("/agent/merge-checks", 200, json!({})),
            ("/agent/merge-results", 201, json!({"denialId": DENIAL})),
        ]);
        let (v, e) = run(&t, &s, &good(), Some(&lease()));
        assert!(e);
        assert_eq!(v["error"]["code"], "ci_not_green", "{v}");
        assert_eq!(v["error"]["denialId"], DENIAL);
        assert_eq!(v["pr"]["state"], "OPEN");
        assert_eq!(
            s.body("/agent/merge-results")["ciRefusal"]["checks"][0],
            "ci"
        );
        assert!(
            !calls
                .lock()
                .unwrap()
                .iter()
                .any(|c| c.starts_with("pr merge"))
        );

        let (t, _) = tm(
            vec![
                ("auth token", ok("tok")),
                ("statusCheckRollup", ok(&pr_json("MERGED", "UNKNOWN"))),
            ],
            Some("bot"),
        );
        let s = std_server((200, json!({})));
        let (v, _) = run(&t, &s, &good(), Some(&lease()));
        assert_eq!(v["error"]["code"], "not_open");
        assert!(!s.paths().iter().any(|p| p == "/agent/merge-results"));
        assert_eq!(s.body("/agent/merge-closed")["state"], "MERGED");
    }

    #[test]
    fn no_gh_user_reports_and_refuses() {
        let (t, calls) = tm(vec![], None);
        let s = std_server((200, json!({})));
        let (v, _) = run(&t, &s, &good(), Some(&lease()));
        assert_eq!(v["error"]["code"], "no_gh_user");
        assert!(s.body("/agent/merge-checks").get("ghUser").is_none());
        assert_eq!(s.body("/agent/merge-results")["result"], "failed");
        assert!(calls.lock().unwrap().is_empty());
    }
}
