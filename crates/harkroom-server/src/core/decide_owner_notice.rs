//! P3 B4e — 소유자가 아닌 사람이 권한 요청을 승인했다는 것을 소유자에게 알린다. TS `permissionRequests.ts`
//! `notifyOwnerOfUserDecision` 을 옮긴다(security 2 — 소유자의 gh·오퍼레이터로 열리는 일을 소유자가 안다).
//!
//! - 자리: 결정 커밋·카드 답 **뒤**(TS 와 같음). 실패해도 결정은 되돌리지 않는다(로그만).
//! - 카드가 선 스레드에 에이전트 이름의 시스템 줄(`serverNotice`)을 세우고 끝에 `@소유자` 로 부른다 — 부름이라 소유자 인박스·푸시가
//!   평범한 멘션과 같은 관문으로 간다(`agent_secret_create::notify_owner` 와 같은 꼴).
//! - security F2: 소유자가 그 채널을 못 보면 카드 스레드 줄은 멘션을 떼고 기록으로만 남기고, 소유자↔에이전트 DM 에 같은 줄을 따로 세운다
//!   (DM 이 없으면 만든다 — TS `getOrCreateDm`). 본문은 서버 값뿐이다(handle·요청 종류·대상·기한) — 채널 이름·글 내용은 싣지 않는다.
//! - 권한은 [`OWNER_NOTICE_PRIVILEGES`](DM 찾기·만들기) + 글 쓰기 칸(`PostState` 가 있다는 것). 없으면 소유자가 아닌 사람의 쓰기는
//!   TS 가 맡는다(main.rs 가 [`set_owner_notice_core`] 로 정한다).
use super::msg_post::{Origin, Outcome, PostBody, PostState, channel_is_dm, post_in_tx};
use serde_json::{Map, Value, json};
use std::sync::atomic::{AtomicBool, Ordering};

/// 알림이 더 쓰는 칸 — DM 찾기·잠금·만들기(`dm_open` 의 만들기 칸)와 소유자·handle 읽기. 글 쓰기 칸은 `PostState` 쪽 검사가 본다.
pub const OWNER_NOTICE_PRIVILEGES: &[(&str, &str)] = &[
    ("channel", "SELECT"),
    ("channel.kind", "INSERT"),
    ("channel.topic", "INSERT"),
    ("channel_member", "SELECT"),
    ("channel_member", "INSERT"),
    ("account", "SELECT"),
    ("agent_config", "SELECT"),
];

static OWNER_NOTICE_CORE: AtomicBool = AtomicBool::new(false);

/// 소유자 알림을 Rust 가 쓸 수 있는가 — 기동 때 [`set_owner_notice_core`] 가 정한다.
pub fn owner_notice_core_on() -> bool {
    OWNER_NOTICE_CORE.load(Ordering::Relaxed)
}

/// 기동 때 한 번 — 글 쓰기 풀이 있고 [`OWNER_NOTICE_PRIVILEGES`] 가 다 있을 때만 켠다(fail-closed).
pub fn set_owner_notice_core(on: bool) {
    OWNER_NOTICE_CORE.store(on, Ordering::Relaxed);
}

/// 커밋된 승인 하나의 알림 거리 — 소유자가 아닌 사람의 승인에서만 생긴다(TS `asOwner === false && decision !== 'deny'`).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct OwnerNotice {
    pub request_id: String,
    pub agent_id: String,
    pub actor_id: String,
    pub kind: String,
    pub target: String,
    pub channel_id: String,
    pub thread_root_id: String,
    /// TS `status` — `granted` 또는 `approved_once`.
    pub status: &'static str,
    /// TS `approval?.expiresAt ?? grantExpiresAt` 의 ISO(`…Z`).
    pub expires_at: Option<String>,
}

/// TS `who` — 에이전트·승인한 사람·소유자 handle 과 소유자 id. 소유자가 없으면 알리지 않는다.
const WHO_SQL: &str = "select a.handle, p.handle, o.handle, c.owner_account_id::text \
     from account a join agent_config c on c.account_id = a.id join account p on p.id = $2::uuid \
     left join account o on o.id = c.owner_account_id where a.id = $1::uuid";

/// TS `SYSTEM_I18N_MAX_ARG_LENGTH`.
const I18N_MAX_ARG: usize = 200;

/// TS 본문(멘션 포함)과 meta. `via_dm` 이면 meta 에 `via: 'dm'` 을 더한다.
pub fn notice_line(
    n: &OwnerNotice,
    agent_h: &str,
    actor_h: &str,
    owner_h: &str,
    owner_id: &str,
    via_dm: bool,
) -> (String, Map<String, Value>) {
    use super::api_results::js_slice;
    // TS `${d.toISOString().slice(0, 16).replace('T', ' ')}Z 까지`.
    let until = n
        .expires_at
        .as_deref()
        .map(|e| format!(" · {}Z 까지", js_slice(e, 16).replacen('T', " ", 1)))
        .unwrap_or_default();
    // TS `plainNoticeText` — 에이전트가 쓴 대상의 `@` 만 무력화한다(소유자 부름은 일부러 남긴다).
    let body = format!(
        "🔓 {actor_h} 가 {agent_h} 의 권한 요청을 승인했다(소유자 아님) · {} {}{until} · 설정 › 에이전트에서 거둘 수 있다 @{owner_h}",
        n.kind,
        n.target.replace('@', "＠"),
    );
    let mut d = json!({
        "requestId": n.request_id, "agentId": n.agent_id, "actorId": n.actor_id, "ownerAccountId": owner_id,
        "kind": n.kind, "target": n.target, "status": n.status,
    });
    if let Some(e) = &n.expires_at {
        d["expiresAt"] = json!(e);
    }
    if via_dm {
        d["via"] = json!("dm");
    }
    let clip = |s: &str| Value::String(js_slice(s, I18N_MAX_ARG));
    let mut meta = Map::new();
    meta.insert("permissionUserDecision".into(), d);
    meta.insert(
        "i18n".into(),
        json!({ "key": "system.permission.approvedByUser", "args": {
            "actorId": clip(&n.actor_id), "agentId": clip(&n.agent_id), "kind": clip(&n.kind),
            "target": clip(&n.target), "ownerId": clip(owner_id) } }),
    );
    (body, meta)
}

/// TS `body.slice(0, body.lastIndexOf(' @'))` — 끝 부름을 뗀 줄(소유자가 그 채널을 못 볼 때).
pub fn without_mention(body: &str) -> &str {
    match body.rfind(" @") {
        Some(i) => &body[..i],
        // TS `lastIndexOf` 가 -1 이면 `slice(0, -1)` — 끝 한 글자를 뗀다. 본문은 늘 ` @` 로 끝나므로 닿지 않는다.
        None => body,
    }
}

/// TS `getOrCreateDm(pool, [agent, owner])` — 이미 있으면 그 id, 없으면 묶음을 잠그고 한 번 더 찾은 뒤 만든다(`dm_open` 과 같은 문장).
pub async fn get_or_create_dm(write: &sqlx::PgPool, a: &str, b: &str) -> sqlx::Result<String> {
    use super::channels::{dml_rows_sql, frag};
    let mut members = vec![a.to_owned(), b.to_owned()];
    members.sort();
    members.dedup();
    static FIND: std::sync::OnceLock<String> = std::sync::OnceLock::new();
    static CREATE: std::sync::OnceLock<String> = std::sync::OnceLock::new();
    let find: &'static str =
        FIND.get_or_init(|| format!("select f.id::text from ({}) f", frag("find_dm")));
    if let Some(id) = sqlx::query_scalar::<_, String>(find)
        .bind(&members)
        .fetch_optional(write)
        .await?
    {
        return Ok(id);
    }
    let mut tx = write.begin().await?;
    sqlx::query(frag("lock_dm"))
        .bind(&members)
        .execute(&mut *tx)
        .await?;
    if let Some(id) = sqlx::query_scalar::<_, String>(find)
        .bind(&members)
        .fetch_optional(&mut *tx)
        .await?
    {
        tx.commit().await?;
        return Ok(id);
    }
    let create: &'static str =
        CREATE.get_or_init(|| dml_rows_sql(frag("create_dm"), &["archivedAt", "createdAt"]));
    let rows: String = sqlx::query_scalar(create).fetch_one(&mut *tx).await?;
    let id = serde_json::from_str::<Value>(&rows)
        .ok()
        .and_then(|v| match v {
            Value::Array(a) => a.into_iter().next(),
            v => Some(v),
        })
        .and_then(|v| v.get("id").and_then(Value::as_str).map(str::to_owned))
        .ok_or_else(|| sqlx::Error::Protocol("create_dm returned no id".into()))?;
    for m in &members {
        sqlx::query(frag("add_channel_member"))
            .bind(&id)
            .bind(m)
            .execute(&mut *tx)
            .await?;
    }
    tx.commit().await?;
    Ok(id)
}

async fn post_line(
    post: &PostState,
    channel: &str,
    thread_root: Option<&str>,
    author: &str,
    body: String,
    meta: Map<String, Value>,
) -> sqlx::Result<bool> {
    let audience = super::audience::audience_for(&post.write, channel)
        .await?
        .to_json();
    let is_dm = channel_is_dm(&post.write, channel).await?;
    let input = PostBody {
        body,
        attachment_ids: Vec::new(),
        thread_root: thread_root.map(str::to_owned),
        also_in_channel: false,
    };
    let origin = Origin {
        meta,
        system: true,
        server_notice: true,
        ..Origin::default()
    };
    let out = post_in_tx(
        post, channel, author, true, &input, None, &audience, is_dm, &origin,
    )
    .await?;
    Ok(matches!(out, Outcome::Posted { .. }))
}

/// TS `notifyOwnerOfUserDecision` — 실패해도 결정을 되돌리지 않는다(로그만).
pub async fn notify_owner(post: &PostState, n: &OwnerNotice) {
    let r: sqlx::Result<()> = async {
        let who: Option<(String, String, Option<String>, Option<String>)> = sqlx::query_as(WHO_SQL)
            .bind(&n.agent_id)
            .bind(&n.actor_id)
            .fetch_optional(&post.write)
            .await?;
        let Some((agent_h, actor_h, Some(owner_h), Some(owner_id))) = who else {
            return Ok(());
        };
        let (body, meta) = notice_line(n, &agent_h, &actor_h, &owner_h, &owner_id, false);
        // security F2: 볼 수 없는 채널을 가리키는 인박스가 생기지 않게 — 못 보면 멘션을 뗀 기록 줄만.
        let owner_sees =
            super::msg_read::channel_visible(&post.write, &owner_id, &n.channel_id).await?;
        let line = if owner_sees {
            body.clone()
        } else {
            without_mention(&body).to_owned()
        };
        if !post_line(
            post,
            &n.channel_id,
            Some(&n.thread_root_id),
            &n.agent_id,
            line,
            meta,
        )
        .await?
        {
            eprintln!(
                "[permissionRequests] 소유자 알림 실패: not_posted requestId={}",
                n.request_id
            );
        }
        if !owner_sees {
            let dm = get_or_create_dm(&post.write, &n.agent_id, &owner_id).await?;
            let (body, meta) = notice_line(n, &agent_h, &actor_h, &owner_h, &owner_id, true);
            if !post_line(post, &dm, None, &n.agent_id, body, meta).await? {
                eprintln!(
                    "[permissionRequests] 소유자 DM 알림 실패: not_posted requestId={}",
                    n.request_id
                );
            }
        }
        Ok(())
    }
    .await;
    if let Err(e) = r {
        eprintln!(
            "[permissionRequests] 소유자 알림 실패: requestId={} ({})",
            n.request_id,
            e.as_database_error().map_or("io", |_| "db")
        );
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn n(expires: Option<&str>) -> OwnerNotice {
        OwnerNotice {
            request_id: "r1".into(),
            agent_id: "ag".into(),
            actor_id: "ac".into(),
            kind: "tool".into(),
            target: "Bash(git push @x:*)".into(),
            channel_id: "ch".into(),
            thread_root_id: "th".into(),
            status: "granted",
            expires_at: expires.map(str::to_owned),
        }
    }

    #[test]
    fn body_matches_ts() {
        let (body, meta) = notice_line(
            &n(Some("2026-11-26T06:05:12.345Z")),
            "bot",
            "lee",
            "kim",
            "ow",
            false,
        );
        assert_eq!(
            body,
            "🔓 lee 가 bot 의 권한 요청을 승인했다(소유자 아님) · tool Bash(git push ＠x:*) · 2026-11-26 06:05Z 까지 · 설정 › 에이전트에서 거둘 수 있다 @kim"
        );
        assert_eq!(
            meta["permissionUserDecision"]["expiresAt"],
            "2026-11-26T06:05:12.345Z"
        );
        assert_eq!(
            meta["permissionUserDecision"]["target"],
            "Bash(git push @x:*)"
        );
        assert!(meta["permissionUserDecision"].get("via").is_none());
        assert_eq!(meta["i18n"]["key"], "system.permission.approvedByUser");
        assert_eq!(meta["i18n"]["args"]["ownerId"], "ow");
        assert_eq!(
            without_mention(&body),
            "🔓 lee 가 bot 의 권한 요청을 승인했다(소유자 아님) · tool Bash(git push ＠x:*) · 2026-11-26 06:05Z 까지 · 설정 › 에이전트에서 거둘 수 있다"
        );
    }

    #[test]
    fn no_expiry_and_dm_via() {
        let (body, meta) = notice_line(&n(None), "bot", "lee", "kim", "ow", true);
        assert!(body.contains("tool Bash(git push ＠x:*) · 설정"));
        assert!(meta["permissionUserDecision"].get("expiresAt").is_none());
        assert_eq!(meta["permissionUserDecision"]["via"], "dm");
    }

    #[test]
    fn i18n_args_clipped_like_ts() {
        let mut long = n(None);
        long.target = "x".repeat(300);
        let (_, meta) = notice_line(&long, "bot", "lee", "kim", "ow", false);
        assert_eq!(
            meta["i18n"]["args"]["target"].as_str().map(str::len),
            Some(200)
        );
        assert_eq!(
            meta["permissionUserDecision"]["target"]
                .as_str()
                .map(str::len),
            Some(300)
        );
    }
}
