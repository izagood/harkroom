//! S5.4 통합 — MCP `skill.propose`. TS `mcpPlugin.ts` 의 같은 도구와 `services/skills.ts::proposeSkill` 을 옮긴다:
//! 인자(zod) → slug 꼴 → 채널 가시성 → 쓰기 검사(`scan_write`, 걸려도 거절하지 않고 표시만) → 예약 slug → upsert(같은 slug 면
//! 본문을 덮고 승인·비활성을 버린다) → 시스템 글(제안한 에이전트 이름, `meta.skillSlug`·`meta.i18n`) → `skill.proposed` 이벤트.
//!
//! - upsert 문장은 TS 정본을 골든(`skill_propose_upsert`)으로 받는다. Rust 는 **제안 행만** 쓴다 — 승인·깔기 길은 없다.
//! - **TS 로 넘기는 것**(`None`): zod 가 받지 않을 인자 · upsert 전 DB 오류. upsert 뒤에 글을 못 세우면 TS 로 넘긴다 — TS 는 같은
//!   행을 다시 덮고(upsert) 글을 세운다(TS 의 「알림이 실패하면 호출자가 재시도」와 같은 결과).
//! - 답 글자는 TS `jsonResult` 와 **키 순서까지** 같게 직접 쓴다(값은 `Value` 로 이스케이프한다).
use super::tools::err;
use crate::auth::Account;
use crate::core::audience::audience_for;
use crate::core::content_scan::scan_write;
use crate::core::msg_edit::MAX_MESSAGE_BODY_CHARS;
use crate::core::msg_post::{self, Origin, Outcome, PostBody, PostState};
use crate::core::msg_read::{channel_visible, is_uuid};
use serde_json::{Map, Value, json};
use sqlx::Row;
use std::sync::OnceLock;

/// TS `BUILTIN_SKILL_PREFIX`.
const BUILTIN_SKILL_PREFIX: &str = "harkroom-";
/// TS `SYSTEM_I18N_MAX_ARG_LENGTH`.
const I18N_MAX_ARG: usize = 200;

/// 쓰기 풀에 이 권한이 다 있을 때만 Rust 가 답한다(`main.rs`). 운영 GRANT: `grant select, insert on workspace_skill` ·
/// `grant update (body, proposed_by, proposed_at, approved_by, approved_at, disabled_at, flagged_at, flag_reason) on workspace_skill`
/// (글·outbox 칸은 `message.post` 묶음에서 이미 받았다).
pub const SKILL_PROPOSE_PRIVILEGES: &[(&str, &str)] = &[
    ("workspace_skill", "SELECT"),
    ("workspace_skill", "INSERT"),
    ("workspace_skill.body", "UPDATE"),
    ("workspace_skill.proposed_by", "UPDATE"),
    ("workspace_skill.proposed_at", "UPDATE"),
    ("workspace_skill.approved_by", "UPDATE"),
    ("workspace_skill.approved_at", "UPDATE"),
    ("workspace_skill.disabled_at", "UPDATE"),
    ("workspace_skill.flagged_at", "UPDATE"),
    ("workspace_skill.flag_reason", "UPDATE"),
];

fn upsert_sql() -> &'static str {
    static S: OnceLock<String> = OnceLock::new();
    S.get_or_init(|| {
        let v: Value = serde_json::from_str(include_str!("../../../golden/sql_fragments.json"))
            .expect("golden/sql_fragments.json");
        let frag = v["skill_propose_upsert"]
            .as_str()
            .expect("golden fragment skill_propose_upsert");
        // 시각은 ms 로 받는다(node-pg `Date` 처럼 μs 는 버린다) — 문장 자체는 정본 그대로.
        format!(
            "with r as ({frag} returning *) select r.slug, r.body, r.proposed_by::text as proposed_by, \
             floor(extract(epoch from r.proposed_at) * 1000)::bigint as proposed_ms, \
             floor(extract(epoch from r.flagged_at) * 1000)::bigint as flagged_ms, r.flag_reason from r"
        )
    })
}

#[derive(Debug, PartialEq)]
struct Args {
    slug: String,
    body: String,
    channel: String,
}

/// TS `SKILL_SLUG_REGEX` `^[a-z0-9-]{2,40}$`.
fn slug_ok(s: &str) -> bool {
    (2..=40).contains(&s.len())
        && s.bytes()
            .all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || c == b'-')
}

/// zod: `slug` 1..40(UTF-16)·`body` 1..MAX(UTF-16)·`channelId` uuid. 틀린 꼴은 `None`(→ TS 가 검증 오류).
fn parse(args: &Value) -> Option<Args> {
    let o = args.as_object()?;
    let slug = o.get("slug")?.as_str()?;
    let sn = slug.encode_utf16().count();
    if sn == 0 || sn > 40 {
        return None;
    }
    let body = o.get("body")?.as_str()?;
    let bn = body.encode_utf16().count();
    if bn == 0 || bn > MAX_MESSAGE_BODY_CHARS {
        return None;
    }
    let channel = o.get("channelId")?.as_str().filter(|s| is_uuid(s))?;
    Some(Args {
        slug: slug.to_owned(),
        body: body.to_owned(),
        channel: channel.to_owned(),
    })
}

/// TS `systemI18n` 의 글자 인자 자르기(UTF-16 200). 이유 글자는 규칙 라벨이라 ASCII 밖이 섞일 수 있어 UTF-16 으로 센다.
fn clip(s: &str) -> String {
    let mut out = String::new();
    let mut n = 0;
    for c in s.chars() {
        n += c.len_utf16();
        if n > I18N_MAX_ARG {
            break;
        }
        out.push(c);
    }
    out
}

/// TS `proposeSkill` 의 시스템 글 본문과 `meta`.
fn system_line(slug: &str, flag: Option<&str>) -> (String, Map<String, Value>) {
    let mut body = format!("스킬이 제안되었습니다: **{slug}** — 승인을 기다리고 있습니다.");
    let i18n = match flag {
        Some(r) => {
            body.push_str(&format!(
                "\n⚠️ 쓰기 검사에 걸렸습니다({r}). 승인 전에 본문을 확인하세요."
            ));
            json!({ "key": "system.skill.proposedFlagged", "args": { "slug": clip(slug), "reason": clip(r) } })
        }
        None => json!({ "key": "system.skill.proposed", "args": { "slug": clip(slug) } }),
    };
    let mut meta = Map::new();
    meta.insert("skillSlug".into(), Value::String(slug.to_owned()));
    meta.insert("i18n".into(), i18n);
    (body, meta)
}

struct Skill {
    slug: String,
    body: String,
    proposed_by: String,
    proposed_at: String,
    flagged_at: Option<String>,
    flag_reason: Option<String>,
}

impl Skill {
    /// TS `WorkspaceSkill` 을 `JSON.stringify` 한 글자(키 순서 그대로). 막 제안한 행이라 승인·비활성은 늘 null 이다.
    fn text(&self) -> String {
        let opt = |v: &Option<String>| v.as_deref().map_or(Value::Null, Value::from);
        format!(
            "{{\"slug\":{},\"body\":{},\"proposedBy\":{},\"proposedAt\":{},\"approvedBy\":null,\"approvedAt\":null,\"disabledAt\":null,\"flaggedAt\":{},\"flagReason\":{}}}",
            Value::from(self.slug.as_str()),
            Value::from(self.body.as_str()),
            Value::from(self.proposed_by.as_str()),
            Value::from(self.proposed_at.as_str()),
            opt(&self.flagged_at),
            opt(&self.flag_reason),
        )
    }

    fn event(&self, channel: &str) -> Value {
        json!({
            "type": "skill.proposed",
            "skill": {
                "slug": self.slug, "body": self.body, "proposedBy": self.proposed_by, "proposedAt": self.proposed_at,
                "approvedBy": null, "approvedAt": null, "disabledAt": null,
                "flaggedAt": self.flagged_at, "flagReason": self.flag_reason,
            },
            "channelId": channel,
        })
    }
}

/// TS `{ ok, flagged? }` 글자.
fn answer_text(skill: &Skill, hit: Option<(&str, &[&str])>) -> String {
    let flagged = match hit {
        Some((reason, rules)) => format!(
            ",\"flagged\":{{\"reason\":{},\"rules\":{}}}",
            Value::from(reason),
            Value::from(rules.to_vec())
        ),
        None => String::new(),
    };
    format!("{{\"ok\":{}{flagged}}}", skill.text())
}

/// `skill.propose` 하나의 답. `None` 이면 TS 가 답한다. `st.write` 는 [`SKILL_PROPOSE_PRIVILEGES`] 를 가진 풀이다.
pub async fn answer(st: &PostState, me: &Account, args: &Value) -> Option<String> {
    let a = parse(args)?;
    if !slug_ok(&a.slug) {
        return Some(err("invalid_slug", "slug must be [a-z0-9-]{2,40}"));
    }
    if !channel_visible(&st.read, &me.id, &a.channel).await.ok()? {
        return Some(err("forbidden", "not a member of this channel"));
    }
    let hit = scan_write(&[Some(a.body.as_str())]);
    if a.slug.starts_with(BUILTIN_SKILL_PREFIX) {
        return Some(err(
            "reserved_slug",
            &format!(
                "slugs starting with \"{BUILTIN_SKILL_PREFIX}\" are reserved for built-in skills — use another name"
            ),
        ));
    }
    let reason = hit.as_ref().map(|h| h.reason.as_str());
    let row = sqlx::query(upsert_sql())
        .bind(&a.slug)
        .bind(&a.body)
        .bind(&me.id)
        .bind(reason)
        .fetch_one(&st.write)
        .await
        .ok()?;
    let skill = Skill {
        slug: row.try_get("slug").ok()?,
        body: row.try_get("body").ok()?,
        proposed_by: row.try_get("proposed_by").ok()?,
        proposed_at: msg_post::iso_ms(row.try_get("proposed_ms").ok()?),
        flagged_at: row
            .try_get::<Option<i64>, _>("flagged_ms")
            .ok()?
            .map(msg_post::iso_ms),
        flag_reason: row.try_get("flag_reason").ok()?,
    };
    let (body, meta) = system_line(&skill.slug, skill.flag_reason.as_deref());
    let is_dm = msg_post::channel_is_dm(&st.read, &a.channel).await.ok()?;
    let audience = audience_for(&st.read, &a.channel).await.ok()?.to_json();
    let input = PostBody {
        body,
        attachment_ids: Vec::new(),
        thread_root: None,
        also_in_channel: false,
    };
    let origin = Origin {
        meta,
        system: true,
        ..Origin::default()
    };
    let out = msg_post::post_in_tx(
        st,
        &a.channel,
        &skill.proposed_by,
        me.kind == "agent",
        &input,
        None,
        &audience,
        is_dm,
        &origin,
    )
    .await
    .ok()?;
    if !matches!(out, Outcome::Posted { .. }) {
        return None;
    }
    // TS `emitEvent` 는 글 뒤에 따로 낸다(실패해도 답은 선다).
    if let Ok(mut conn) = st.write.acquire().await
        && let Err(e) = crate::write::emit_event(&mut conn, &skill.event(&a.channel)).await
    {
        eprintln!(
            "front: skill.proposed event failed: {}",
            e.as_database_error().map_or("io", |_| "db")
        );
    }
    let rules: Vec<&str> = hit.as_ref().map(|h| h.rules.clone()).unwrap_or_default();
    Some(super::respond::text_result(&answer_text(
        &skill,
        hit.as_ref().map(|h| (h.reason.as_str(), rules.as_slice())),
    )))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn ok() -> Value {
        json!({ "slug": "pr-recipe", "body": "do x", "channelId": "0b5c2a1e-7d34-4f6a-9e81-3c2d4b5a6f70" })
    }

    #[test]
    fn parses_like_zod() {
        assert_eq!(parse(&ok()).unwrap().slug, "pr-recipe");
        for (k, v) in [
            ("slug", json!("")),
            ("slug", json!("a".repeat(41))),
            ("body", json!("")),
            ("channelId", json!("nope")),
            ("slug", json!(1)),
        ] {
            let mut a = ok();
            a[k] = v.clone();
            assert!(parse(&a).is_none(), "{k}={v}");
        }
        // zod 는 통과, 꼴 검사(invalid_slug)는 Rust 가 답한다.
        let mut a = ok();
        a["slug"] = json!("A");
        assert!(parse(&a).is_some());
        assert!(!slug_ok("A") && !slug_ok("a") && slug_ok("ab") && !slug_ok("a_b"));
    }

    #[test]
    fn system_line_like_ts() {
        let (b, m) = system_line("pr-recipe", None);
        assert_eq!(
            b,
            "스킬이 제안되었습니다: **pr-recipe** — 승인을 기다리고 있습니다."
        );
        assert_eq!(
            m["i18n"],
            json!({ "key": "system.skill.proposed", "args": { "slug": "pr-recipe" } })
        );
        assert_eq!(m["skillSlug"], json!("pr-recipe"));
        let (b, m) = system_line("x1", Some("r1"));
        assert!(b.ends_with("\n⚠️ 쓰기 검사에 걸렸습니다(r1). 승인 전에 본문을 확인하세요."));
        assert_eq!(m["i18n"]["key"], json!("system.skill.proposedFlagged"));
        let svc = include_str!("../../../../../packages/server/src/services/skills.ts");
        assert!(svc.contains(
            "body: `스킬이 제안되었습니다: **${skill.slug}** — 승인을 기다리고 있습니다.`"
        ));
        assert!(svc.contains("(skill.flagReason ? `\\n⚠️ 쓰기 검사에 걸렸습니다(${skill.flagReason}). 승인 전에 본문을 확인하세요.` : '')"));
        assert!(svc.contains("export const BUILTIN_SKILL_PREFIX = 'harkroom-';"));
        assert!(
            svc.contains(
                "emitEvent({ type: 'skill.proposed', skill, channelId: input.channelId });"
            )
        );
    }

    #[test]
    fn answer_keeps_ts_key_order() {
        let s = Skill {
            slug: "ab".into(),
            body: "q\"x".into(),
            proposed_by: "u".into(),
            proposed_at: "t".into(),
            flagged_at: None,
            flag_reason: None,
        };
        assert_eq!(
            answer_text(&s, None),
            r#"{"ok":{"slug":"ab","body":"q\"x","proposedBy":"u","proposedAt":"t","approvedBy":null,"approvedAt":null,"disabledAt":null,"flaggedAt":null,"flagReason":null}}"#
        );
        assert!(
            answer_text(&s, Some(("r", &["a", "b"])))
                .ends_with(r#","flagged":{"reason":"r","rules":["a","b"]}}"#)
        );
        let src = include_str!("../../../../../packages/server/src/mcp/mcpPlugin.ts");
        assert!(src.contains(
            "return jsonResult({ ...result, flagged: { reason: flag.reason, rules: flag.rules } });"
        ));
        assert!(src.contains("return jsonResult({ error: { code: 'forbidden', message: 'not a member of this channel' } });"));
    }

    #[test]
    fn clip_counts_utf16() {
        assert_eq!(clip(&"a".repeat(250)).len(), 200);
        assert_eq!(clip(&"😀".repeat(150)).chars().count(), 100);
    }
}
