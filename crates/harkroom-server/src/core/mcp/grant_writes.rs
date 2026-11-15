//! C4b ⑥ G1 — Rust 가 답하는 **좁히기만 하는** 권한 쓰기 도구: `grant.revoke`(TS `revokeDelegation`)·
//! `permission.revoke`(TS `releaseGrant`).
//!
//! `permission.revoke` kind=tool 은 TS 가 규칙을 `validateToolRule` 로 정규화한 글자도 같이 지운다. 그 판정(표 수백 줄)은
//! 옮기지 않고, **이미 정규형인 글자**(ASCII·낱말 사이 공백 하나)만 Rust 가 받는다 — 그때는 정규화 결과가 원문과 같아
//! 지울 대상이 원문 하나로 TS 와 같다. 그 밖(공백이 겹치거나 ASCII 밖 글자)은 TS 가 답한다.
//!
//! 약속은 [`super::writes`] 와 같다 — TS 와 같은 글자, zod 가 그대로 받는 인자만, 쓰기 전 DB 오류는 TS 로(`None`),
//! 쓰기를 시작한 뒤의 오류는 고정 문장의 `internal`(security W1 — TS 로 넘기면 같은 쓰기를 한 번 더 한다).
//! 쓰기 풀은 [`GRANT_REVOKE_PRIVILEGES`] 가 다 있을 때만 붙는다(`main.rs`). 없으면 TS 가 답한다.
use super::tools::{err, uuid_arg};
use crate::auth::Account;
use crate::write::{AuditEntry, emit_event, record_audit};
use serde_json::{Value, json};
use sqlx::PgPool;

/// 이 묶음에서 Rust 가 답하는 쓰기 도구.
pub const SERVED: &[&str] = &["grant.revoke", "permission.revoke"];

/// 이 줄이 쓰는 권한(표·칸, 권한) — homelab GRANT 와 같아야 한다. `delete … where … returning` 은 그 칸의 SELECT 도 든다.
/// 아래로 준 줄(`parent_grant_id … on delete cascade`)은 FK 동작이라 표 소유자 권한으로 지워진다.
pub const GRANT_REVOKE_PRIVILEGES: &[(&str, &str)] = &[
    ("account_grant", "DELETE"),
    ("account_grant.id", "SELECT"),
    ("account_grant.granted_by", "SELECT"),
    ("account_grant.parent_grant_id", "SELECT"),
    ("account_grant.account_id", "SELECT"),
    ("account_grant.capability", "SELECT"),
    ("account_grant.scope", "SELECT"),
    // permission.revoke — 위임 줄 닫기(TS `revokeLinesForGrant`·`revokeTurnLines`).
    ("mandate_line", "UPDATE"),
    ("mandate_line", "SELECT"),
    ("permission_request", "SELECT"),
    ("audit_log", "INSERT"),
    ("event_outbox", "INSERT"),
];
pub const GRANT_REVOKE_SEQUENCE_PRIVILEGES: &[(&str, &str)] = &[("event_outbox_id_seq", "USAGE")];

/// TS `revokeDelegation` 의 지우기 — 내가 **다시 준** 줄만(`parent_grant_id is not null`). 사람이 준 뿌리 줄은 못 지운다.
pub const REVOKE_DELEGATION_SQL: &str = "delete from account_grant where id = $1::uuid and granted_by = $2::uuid \
     and parent_grant_id is not null returning account_id::text";

fn internal() -> String {
    err("internal", "the write failed; it was not retried")
}

pub async fn answer(
    read: &PgPool,
    write: Option<&PgPool>,
    me: &Account,
    tool: &str,
    args: &Value,
) -> Option<Option<String>> {
    if !SERVED.contains(&tool) {
        return None;
    }
    let Some(write) = write else {
        return Some(None);
    };
    Some(match tool {
        "grant.revoke" => grant_revoke(write, me, args).await,
        _ => permission_revoke(read, write, me, args).await,
    })
}

/// TS:
/// ```ts
/// if (account.kind !== 'agent') return jsonResult({ error: { code: 'not_agent', message: 'only agents use this' } });
/// const r = await revokeDelegation(pool, { agentId: account.id, grantId });
/// return jsonResult(r.ok ? { revoked: true } : { error: { code: r.code ?? 'not_found', message: 'no such grant given by you' } });
/// ```
async fn grant_revoke(write: &PgPool, me: &Account, args: &Value) -> Option<String> {
    // zod 는 모르는 칸을 버리고 받는다 — `grantId` 만 본다. 꼴이 틀리면 TS 가 zod 오류로 답한다.
    let grant = uuid_arg(args, "grantId")?;
    if me.kind != "agent" {
        return Some(err("not_agent", "only agents use this"));
    }
    // 지우기와 이벤트는 한 트랜잭션(이벤트가 실패하면 지우기도 되돌아간다 — 「거뒀는데 화면은 모른다」가 없게).
    let r: Result<Option<String>, sqlx::Error> = async {
        let mut tx = write.begin().await?;
        let target: Option<String> = sqlx::query_scalar(REVOKE_DELEGATION_SQL)
            .bind(grant)
            .bind(&me.id)
            .fetch_optional(&mut *tx)
            .await?;
        let Some(target) = target else {
            tx.rollback().await?;
            return Ok(None);
        };
        emit_event(
            &mut tx,
            &json!({ "type": "grant.changed", "accountId": target, "audience": "all" }),
        )
        .await?;
        tx.commit().await?;
        Ok(Some(target))
    }
    .await;
    let target = match r {
        Ok(Some(t)) => t,
        Ok(None) => return Some(err("not_found", "no such grant given by you")),
        Err(_) => return Some(internal()),
    };
    record_audit(
        write,
        AuditEntry {
            action: "grant.delegate.revoked",
            actor_id: Some(&me.id),
            actor_handle: None,
            target: Some(&target),
            ip: None,
            detail: json!({ "grantId": grant }),
        },
    )
    .await;
    Some(super::respond::text_result("{\"revoked\":true}"))
}

// ── permission.revoke (TS `releaseGrant`) ─────────────────────────────────────────────────────────

/// TS `RELEASE_NOT_FOUND_MESSAGE` 그대로(글자 대조는 시험).
const NOT_FOUND: &[(&str, &str)] = &[
    (
        "request_pending",
        "your request is still waiting for the owner — nothing was granted yet",
    ),
    (
        "request_denied",
        "your request was denied — nothing was granted",
    ),
    (
        "request_expired",
        "your request expired without a decision — nothing was granted",
    ),
    (
        "request_closed",
        "your request was closed before a decision — nothing was granted",
    ),
    (
        "approved_once",
        "this was approved for one use only — there is no standing grant to release",
    ),
    (
        "mandate_line",
        "this was approved as a line on a mandate, not as a grant — the owner removes it from that mandate",
    ),
    (
        "grant_gone",
        "this was granted earlier but is no longer held — it expired or was already released",
    ),
    (
        "other_agent",
        "another agent holds or asked for this rule — only that agent or the owner can release it",
    ),
    ("none", "no grant or request for this on this agent"),
];

pub const RELEASE_DELETE_SQL: &str = "delete from account_grant where account_id = $1::uuid and capability = $2 \
     and scope = any($3::text[]) returning scope";

/// TS `revokeTurnLines` — 이 에이전트가 이 채널에서 낸 tool 요청에서 온, 이 에이전트 하나에만 걸린 살아 있는 「이번 턴만」 줄.
pub const REVOKE_TURN_LINES_SQL: &str = "update mandate_line l set revoked_at = now() \
       from permission_request r \
      where r.id = l.request_id and r.agent_id = $1::uuid and r.channel_id = $2::uuid and r.kind = 'tool' \
        and l.revoked_at is null and l.cap = 'tool' and l.scope = any($3::text[]) \
        and l.agent_ids = array[$1::uuid] \
        and l.limits ? 'turnCause' and (l.limits->>'until')::timestamptz > now() \
      returning l.id::text, l.mandate_id::text, l.scope, l.via::text, l.request_id::text";

/// TS `revokeLinesForGrant` — 거둔 grant 와 함께 적힌 위임 줄(W4).
pub const REVOKE_LINES_FOR_GRANT_SQL: &str = "update mandate_line l set revoked_at = now() \
      where l.revoked_at is null and l.cap = $2 and l.scope = $3 \
        and ((l.agent_ids is not null and $1::uuid = any(l.agent_ids)) \
          or exists (select 1 from permission_request r \
                      where r.id = l.request_id and r.agent_id = $1::uuid and ($4::text is null or r.channel_id::text = $4)))";

const REASON_REQUEST_SQL: &str = "select status::text, expires_at <= now() from permission_request \
      where agent_id = $1::uuid and kind::text = $2::text and target = any($3::text[]) and status <> 'superseded' \
        and ($2::text <> 'tool' or channel_id = $4::uuid) \
      order by (status = 'pending' and expires_at > now()) desc, created_at desc limit 1";
const REASON_MERGE_LINE_SQL: &str = "select 1 from mandate_line l join permission_request q on q.id = l.request_id \
      where q.agent_id = $1::uuid and l.cap = 'merge' and l.scope = any($2::text[]) and l.revoked_at is null \
        and (l.limits->>'until' is null or (l.limits->>'until')::timestamptz > now()) \
        and not (l.limits ? 'uses') limit 1";
const REASON_OTHER_SQL: &str = "select 1 from account_grant where account_id <> $1::uuid and capability = 'tool.allow' \
        and scope = any($2::text[]) and (expires_at is null or expires_at > now()) \
     union all \
     select 1 from permission_request where agent_id <> $1::uuid and kind = 'tool' and channel_id = $4::uuid \
        and target = any($3::text[]) and status = 'pending' and expires_at > now() \
     limit 1";

/// 인쇄 가능한 ASCII 와 공백만 — JS `trim`·`\s`·`toLowerCase`·UTF-16 길이가 Rust 와 같은 글자.
fn plain_ascii(s: &str) -> bool {
    s.bytes().all(|b| (0x20..=0x7e).contains(&b))
}

/// kind=tool 의 지울 대상이 TS 와 같게 원문 하나로 정해지는가. `Bash(…)` 꼴이면 `validateToolRule` 의 정규형
/// (`Bash(<낱말 공백 하나로>[:*])`)이 원문과 같을 때만 — 그러면 판정이 통과하든 아니든 TS 대상도 `[원문]` 이다.
/// `Bash(` 꼴이 아니면 TS 판정은 mcp 도구(정규형 = 원문)거나 거절이라 역시 `[원문]`.
fn rule_is_canonical(raw: &str) -> bool {
    let Some(inner) = raw.strip_prefix("Bash(").and_then(|r| r.strip_suffix(')')) else {
        return true;
    };
    let mut body = inner.trim();
    let prefix = body.ends_with(":*");
    if prefix {
        body = body[..body.len() - 2].trim();
    }
    let words: Vec<&str> = body.split(' ').filter(|w| !w.is_empty()).collect();
    let canon = format!(
        "Bash({}{})",
        words.join(" "),
        if prefix { ":*" } else { "" }
    );
    canon == raw
}

/// TS `repoGrantScope` — `repo:<owner>/<name>` 또는 `repo:<owner>/*`(입력은 [`plain_ascii`] 를 지난 것).
fn repo_grant_scope(repo: &str) -> Option<String> {
    let s = repo.trim_matches(' ').to_ascii_lowercase();
    let (owner, name) = s.split_once('/')?;
    let tail =
        |c: u8| c.is_ascii_lowercase() || c.is_ascii_digit() || matches!(c, b'.' | b'_' | b'-');
    let ob = owner.as_bytes();
    let owner_ok = (1..=100).contains(&ob.len())
        && (ob[0].is_ascii_lowercase() || ob[0].is_ascii_digit())
        && ob.iter().all(|&c| tail(c));
    let name_ok = name == "*" || ((1..=100).contains(&name.len()) && name.bytes().all(tail));
    (owner_ok && name_ok).then(|| format!("repo:{s}"))
}

/// TS `parseToolScope` 의 채널 자리 — 소문자 uuid 만(`[0-9a-f]`).
fn lower_uuid(s: &str) -> bool {
    crate::core::channels::is_uuid(s) && !s.bytes().any(|b| b.is_ascii_uppercase())
}

struct TurnLine {
    id: String,
    mandate: String,
    scope: String,
    via: String,
    request: String,
}

async fn not_found_reason(
    read: &PgPool,
    me: &str,
    kind: &str,
    targets: &[String],
    scopes: &[String],
    channel: &str,
) -> Result<&'static str, sqlx::Error> {
    if kind == "read" {
        return Ok("none");
    }
    let r: Option<(String, bool)> = sqlx::query_as(REASON_REQUEST_SQL)
        .bind(me)
        .bind(kind)
        .bind(targets)
        .bind(channel)
        .fetch_optional(read)
        .await?;
    if let Some((status, expired)) = r {
        return Ok(match status.as_str() {
            "pending" if expired => "request_expired",
            "pending" => "request_pending",
            "denied" => "request_denied",
            "expired" => "request_expired",
            "obsolete" => "request_closed",
            "approved_once" => "approved_once",
            _ => {
                if kind == "merge"
                    && sqlx::query_scalar::<_, i32>(REASON_MERGE_LINE_SQL)
                        .bind(me)
                        .bind(targets)
                        .fetch_optional(read)
                        .await?
                        .is_some()
                {
                    "mandate_line"
                } else {
                    "grant_gone"
                }
            }
        });
    }
    if kind == "tool"
        && crate::core::channels::visible(read, me, channel).await?
        && sqlx::query_scalar::<_, i32>(REASON_OTHER_SQL)
            .bind(me)
            .bind(scopes)
            .bind(targets)
            .bind(channel)
            .fetch_optional(read)
            .await?
            .is_some()
    {
        return Ok("other_agent");
    }
    Ok("none")
}

/// TS 등록부(`mcpPlugin.ts` `permission.revoke`) + `releaseGrant`.
async fn permission_revoke(
    read: &PgPool,
    write: &PgPool,
    me: &Account,
    args: &Value,
) -> Option<String> {
    // zod: kind enum · rule 1..300 · repo 3..201 · channelId uuid. 꼴이 틀리면 TS 가 zod 오류로 답한다.
    let o = args.as_object()?;
    let kind = match o.get("kind")?.as_str()? {
        k @ ("tool" | "merge" | "read") => k,
        _ => return None,
    };
    let channel = uuid_arg(args, "channelId")?;
    let opt_str = |k: &str, min: usize, max: usize| -> Option<Option<&str>> {
        match o.get(k) {
            None => Some(None),
            Some(v) => {
                let s = v.as_str()?;
                // ASCII 밖 글자는 UTF-16 길이·trim 이 갈릴 수 있다 — TS 로.
                (plain_ascii(s) && (min..=max).contains(&s.len())).then_some(Some(s))
            }
        }
    };
    let rule = opt_str("rule", 1, 300)?;
    let repo = opt_str("repo", 3, 201)?;
    if me.kind != "agent" {
        return Some(err(
            "not_agent",
            "only an agent can release its own permission",
        ));
    }
    if (kind == "tool") != rule.is_some() || (kind != "tool") != repo.is_some() {
        return Some(err(
            "bad_request",
            "kind \"tool\" takes `rule`, kinds \"merge\" and \"read\" take `repo` — exactly one",
        ));
    }
    let (capability, scopes, targets): (&str, Vec<String>, Vec<String>) = if kind == "tool" {
        let raw = rule.unwrap_or_default().trim_matches(' ');
        if !rule_is_canonical(raw) {
            return None;
        }
        (
            "tool.allow",
            vec![format!("tool:{channel}:{raw}")],
            vec![raw.to_string()],
        )
    } else {
        let Some(scope) = repo_grant_scope(repo.unwrap_or_default()) else {
            return Some(err(
                "bad_repo",
                "repo must be one <owner>/<name> or <owner>/*",
            ));
        };
        let cap = if kind == "read" {
            "repo.read"
        } else {
            "repo.merge"
        };
        (cap, vec![scope.clone()], vec![scope])
    };

    // W4: grant 지우기·줄 닫기·이벤트는 한 트랜잭션.
    let r: Result<Option<(String, Vec<TurnLine>)>, sqlx::Error> = async {
        let mut tx = write.begin().await?;
        let deleted: Vec<String> = sqlx::query_scalar(RELEASE_DELETE_SQL)
            .bind(&me.id)
            .bind(capability)
            .bind(&scopes)
            .fetch_all(&mut *tx)
            .await?;
        let scope = deleted.first().cloned().unwrap_or_default();
        let mut lines = Vec::new();
        if kind == "tool" {
            let rows: Vec<(String, String, String, String, String)> =
                sqlx::query_as(REVOKE_TURN_LINES_SQL)
                    .bind(&me.id)
                    .bind(channel)
                    .bind(&targets)
                    .fetch_all(&mut *tx)
                    .await?;
            lines = rows
                .into_iter()
                .map(|(id, mandate, scope, via, request)| TurnLine {
                    id,
                    mandate,
                    scope,
                    via,
                    request,
                })
                .collect();
        }
        if scope.is_empty() && lines.is_empty() {
            tx.rollback().await?;
            return Ok(None);
        }
        for d in &deleted {
            // TS `revokeLinesForGrant`: tool 은 scope 를 `tool:<소문자 uuid>:<규칙>` 으로 읽어 채널·규칙을 꺼낸다(못 읽으면 건너뜀).
            // 규칙은 정규형(위 판정)이라 `validateScope` 결과도 원문과 같다. merge 의 scope 는 이미 `repoGrantScope` 꼴. read 는 줄이 없다.
            let (cap, line_scope, ch): (&str, &str, Option<&str>) = match capability {
                "tool.allow" => {
                    let rule = &targets[0];
                    if !lower_uuid(channel) || rule.is_empty() {
                        continue;
                    }
                    ("tool", rule.as_str(), Some(channel))
                }
                "repo.merge" => ("merge", d.as_str(), None),
                _ => continue,
            };
            sqlx::query(REVOKE_LINES_FOR_GRANT_SQL)
                .bind(&me.id)
                .bind(cap)
                .bind(line_scope)
                .bind(ch)
                .execute(&mut *tx)
                .await?;
        }
        if !scope.is_empty() {
            emit_event(
                &mut tx,
                &json!({ "type": "grant.changed", "accountId": me.id, "audience": "all" }),
            )
            .await?;
        }
        tx.commit().await?;
        Ok(Some((scope, lines)))
    }
    .await;
    let (scope, lines) = match r {
        Ok(Some(v)) => v,
        Ok(None) => {
            // 아무것도 쓰지 않았다(되돌림) — 까닭 읽기가 실패하면 TS 가 처음부터 답해도 안전하다.
            let reason = not_found_reason(read, &me.id, kind, &targets, &scopes, channel)
                .await
                .ok()?;
            let msg = NOT_FOUND
                .iter()
                .find(|(k, _)| *k == reason)
                .map_or("", |(_, m)| m);
            return Some(super::respond::text_result(&format!(
                "{{\"error\":{{\"code\":\"not_found\",\"reason\":{},\"message\":{}}}}}",
                Value::from(reason),
                Value::from(format!("no such grant on this agent: {msg}"))
            )));
        }
        Err(_) => return Some(internal()),
    };
    let grant_removed = !scope.is_empty();
    if grant_removed {
        record_audit(
            write,
            AuditEntry {
                action: "grant.revoked",
                actor_id: Some(&me.id),
                actor_handle: None,
                target: Some(&me.id),
                ip: None,
                detail: json!({ "capability": capability, "scope": scope, "via": "permission.revoke" }),
            },
        )
        .await;
    }
    for l in &lines {
        record_audit(
            write,
            AuditEntry {
                action: "mandate.line.revoked",
                actor_id: Some(&me.id),
                actor_handle: None,
                target: Some(&l.mandate),
                ip: None,
                detail: json!({
                    "mandateId": l.mandate, "lineId": l.id, "cap": "tool", "scope": l.scope,
                    "via": l.via, "requestId": l.request, "revokedVia": "permission.revoke",
                }),
            },
        )
        .await;
    }
    let out_scope = if grant_removed {
        scope
    } else {
        format!("tool:{channel}:{}", lines[0].scope)
    };
    Some(super::respond::text_result(&format!(
        "{{\"revoked\":true,\"capability\":{},\"scope\":{},\"grantRemoved\":{},\"closedTurnLines\":{}}}",
        Value::from(capability),
        Value::from(out_scope),
        grant_removed,
        lines.len()
    )))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn served_are_writes_in_registry() {
        for n in SERVED {
            let s = super::super::find(n).expect(n);
            assert_eq!(s.access, super::super::Access::Write, "{n}");
        }
    }

    /// 거절 문구·답 모양·지우기 조건을 TS 원본과 맞춘다.
    #[test]
    fn texts_follow_ts_source() {
        let mcp = include_str!("../../../../../packages/server/src/mcp/mcpPlugin.ts");
        for want in [
            "inputSchema: { grantId: z.string().uuid() },",
            "if (account.kind !== 'agent') return jsonResult({ error: { code: 'not_agent', message: 'only agents use this' } });",
            "return jsonResult(r.ok ? { revoked: true } : { error: { code: r.code ?? 'not_found', message: 'no such grant given by you' } });",
        ] {
            assert!(mcp.contains(want), "{want}");
        }
        let svc = include_str!("../../../../../packages/server/src/services/apiDelegation.ts");
        for want in [
            "`delete from account_grant where id = $1 and granted_by = $2 and parent_grant_id is not null returning account_id as \"accountId\"`",
            "await recordAudit(pool, { action: 'grant.delegate.revoked', actorId: a.agentId, target: r.rows[0]!.accountId, detail: { grantId: a.grantId } });",
            "emitEvent({ type: 'grant.changed', accountId: r.rows[0]!.accountId, audience: 'all' });",
        ] {
            assert!(svc.contains(want), "{want}");
        }
    }

    #[test]
    fn canonical_rules_only() {
        for ok in [
            "Bash(kubectl --context a get pods:*)",
            "Bash(ls -la)",
            "mcp__x__y",
            "Read",
            "",
            "Bash()",
        ] {
            assert!(rule_is_canonical(ok), "{ok}");
        }
        for no in ["Bash(ls  -la)", "Bash( ls)", "Bash(ls :*)", "Bash(ls )"] {
            assert!(!rule_is_canonical(no), "{no}");
        }
    }

    #[test]
    fn repo_scope_follows_ts_regex() {
        assert_eq!(
            repo_grant_scope(" IzaGood/Harkroom ").as_deref(),
            Some("repo:izagood/harkroom")
        );
        assert_eq!(
            repo_grant_scope("izagood/*").as_deref(),
            Some("repo:izagood/*")
        );
        for no in ["izagood", "a/b/c", "-a/b", "a/", "*/b", "a/b*", "a b/c"] {
            assert_eq!(repo_grant_scope(no), None, "{no}");
        }
    }

    /// permission.revoke 의 문장·문구를 TS 원본과 맞춘다.
    #[test]
    fn permission_revoke_follows_ts_source() {
        let mcp = include_str!("../../../../../packages/server/src/mcp/mcpPlugin.ts");
        for want in [
            "kind: z.enum(['tool', 'merge', 'read']),",
            "rule: z.string().min(1).max(300).optional(),",
            "repo: z.string().min(3).max(201).optional(),",
            "if (account.kind !== 'agent') return jsonResult({ error: { code: 'not_agent', message: 'only an agent can release its own permission' } });",
            "return jsonResult({ error: { code: 'bad_request', message: 'kind \"tool\" takes `rule`, kinds \"merge\" and \"read\" take `repo` — exactly one' } });",
            "return jsonResult({ revoked: true, capability: r.capability, scope: r.scope, grantRemoved: r.grantRemoved, closedTurnLines: r.closedTurnLines });",
        ] {
            assert!(mcp.contains(want), "{want}");
        }
        let svc = include_str!("../../../../../packages/server/src/services/permissionRequests.ts");
        for (k, m) in NOT_FOUND {
            assert!(svc.contains(&format!("  {k}: '{m}',")), "{k}");
        }
        for want in [
            "`delete from account_grant where account_id = $1 and capability = $2 and scope = any($3::text[]) returning scope`",
            "if (!scope) return { ok: false, code: 'bad_repo', message: 'repo must be one <owner>/<name> or <owner>/*' };",
            "message: `no such grant on this agent: ${RELEASE_NOT_FOUND_MESSAGE[reason]}`",
            "await recordAudit(pool, { action: 'grant.revoked', actorId: args.agentId, target: args.agentId, detail: { capability, scope, via: 'permission.revoke' } });",
            "detail: { mandateId: l.mandateId, lineId: l.id, cap: 'tool', scope: l.scope, via: l.via, requestId: l.requestId, revokedVia: 'permission.revoke' },",
        ] {
            assert!(svc.contains(want), "{want}");
        }
        let lines = include_str!("../../../../../packages/server/src/services/mandateLines.ts");
        for want in [
            "and l.agent_ids = array[$1::uuid]",
            "and l.limits ? 'turnCause' and (l.limits->>'until')::timestamptz > $4",
            "or exists (select 1 from permission_request r",
        ] {
            assert!(lines.contains(want), "{want}");
        }
    }
}
