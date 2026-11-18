//! MCP `artifact.publish` 의 버전 걸기(TS `services/artifacts.ts` `attachArtifactVersion`). `postMessage` 의 `beforeCommit`
//! 자리([`crate::core::msg_post::BeforeCommit`])에서 글과 같은 tx 로 `artifact`·`artifact_version` 행을 넣는다.
//! 거절이면 msg_post 가 롤백한다(글도 첨부 연결도 남지 않는다).
//!
//! TS 순서 그대로: html 첨부 판정(`not_html`·`too_large`) → 표지 판정(`bad_cover`) → `artifactId` 가 있으면 행 잠금(`for update`)·
//! 채널·만든 이 판정·제목 갱신, 없으면 새 안 → 버전 행(새 안은 1, 고쳐 올리기는 같은 tx 의 `max(version)+1`).
//! 기본 권한은 [`ARTIFACT_PUBLISH_PRIVILEGES`], 고쳐 올리기는 [`ARTIFACT_REVISE_PRIVILEGES`], 표지는 [`ARTIFACT_COVER_PRIVILEGES`]
//! 가 더 든다 — 라우트([`super::artifact_publish`])가 없는 모양은 TS 로 넘긴다.
use crate::core::msg_post::{BeforeCommit, BeforeCommitFuture, Rejection};
use std::sync::Mutex;

/// TS `ARTIFACT_HTML_MAX_BYTES`(`artifactPreview.ts`) — 미리보기로 여는 페이지 상한.
pub(crate) const ARTIFACT_HTML_MAX_BYTES: i64 = 5 * 1024 * 1024;

/// 이 훅이 쓰는 칸. 시작할 때 쓰기 풀에서 다 확인돼야 켠다(없으면 TS 로 넘긴다).
pub const ARTIFACT_PUBLISH_PRIVILEGES: &[(&str, &str)] = &[
    ("attachment.id", "SELECT"),
    ("attachment.content_type", "SELECT"),
    ("attachment.size_bytes", "SELECT"),
    ("artifact.id", "SELECT"),
    ("artifact.channel_id", "INSERT"),
    ("artifact.title", "INSERT"),
    ("artifact.created_by", "INSERT"),
    ("artifact_version.artifact_id", "INSERT"),
    ("artifact_version.version", "INSERT"),
    ("artifact_version.attachment_id", "INSERT"),
    ("artifact_version.summary", "INSERT"),
    ("artifact_version.title", "INSERT"),
];

/// 고쳐 올리기(`artifactId`)에 더 드는 칸 — 행 잠금(`for update` 는 UPDATE 권한 하나가 있어야 한다)·채널·만든 이 판정·제목 갱신·
/// `max(version)`. 시작할 때 다 있어야 켠다(없으면 `artifactId` 모양만 TS 로 넘긴다).
pub const ARTIFACT_REVISE_PRIVILEGES: &[(&str, &str)] = &[
    ("artifact.channel_id", "SELECT"),
    ("artifact.created_by", "SELECT"),
    ("artifact.title", "UPDATE"),
    ("artifact_version.artifact_id", "SELECT"),
    ("artifact_version.version", "SELECT"),
];

/// 표지(`coverAttachmentId`)에 더 드는 칸. 없으면 표지 모양만 TS 로 넘긴다.
pub const ARTIFACT_COVER_PRIVILEGES: &[(&str, &str)] =
    &[("artifact_version.cover_attachment_id", "INSERT")];

/// TS `ARTIFACT_COVER_MAX_BYTES`.
pub(crate) const ARTIFACT_COVER_MAX_BYTES: i64 = 1024 * 1024;
/// TS `COVER_TYPES`.
const COVER_TYPES: &[&str] = &["image/png", "image/jpeg", "image/webp"];

/// TS `ArtifactVersionRejection`.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum Reject {
    NotHtml,
    TooLarge,
    BadCover,
    NotFound,
    OtherChannel,
    NotYours,
}

impl Reject {
    pub(crate) fn code(self) -> &'static str {
        match self {
            Reject::NotHtml => "not_html",
            Reject::TooLarge => "too_large",
            Reject::BadCover => "bad_cover",
            Reject::NotFound => "artifact_not_found",
            Reject::OtherChannel => "artifact_other_channel",
            Reject::NotYours => "artifact_not_yours",
        }
    }

    /// TS `ARTIFACT_REJECTION_MESSAGES` 글자 그대로.
    pub(crate) fn message(self) -> &'static str {
        match self {
            Reject::NotHtml => "the page must be an html file (text/html)",
            Reject::TooLarge => "the page exceeds 5MB",
            Reject::BadCover => "the cover must be a png/jpeg/webp image of at most 1MB",
            Reject::NotFound => "no such artifact — omit artifactId to start a new one",
            Reject::OtherChannel => {
                "that artifact lives in another channel — omit artifactId to start a new one here"
            }
            Reject::NotYours => {
                "that artifact was made by someone else — omit artifactId to start your own"
            }
        }
    }

    /// TS 라우트: `{ status: 400, code, message: ARTIFACT_REJECTION_MESSAGES[code] }`.
    pub(crate) fn rejection(self) -> Rejection {
        Rejection {
            status: 400,
            code: self.code().into(),
            message: self.message().into(),
        }
    }
}

/// TS `mediaType` — `;` 앞을 다듬어 소문자로.
pub(crate) fn media_type(content_type: &str) -> String {
    content_type
        .split(';')
        .next()
        .unwrap_or("")
        .trim()
        .to_lowercase()
}

/// TS 의 html 첨부 판정 — 행이 없거나(`None`) `text/html` 이 아니면 `not_html`, 크면 `too_large`.
pub(crate) fn check_html(row: Option<(&str, i64)>) -> Option<Reject> {
    match row {
        Some((ct, _)) if media_type(ct) != "text/html" => Some(Reject::NotHtml),
        None => Some(Reject::NotHtml),
        Some((_, size)) if size > ARTIFACT_HTML_MAX_BYTES => Some(Reject::TooLarge),
        Some(_) => None,
    }
}

/// TS 의 표지 판정 — 행이 없거나 png/jpeg/webp 가 아니거나 1MB 넘으면 `bad_cover`.
pub(crate) fn check_cover(row: Option<(&str, i64)>) -> Option<Reject> {
    match row {
        Some((ct, size))
            if COVER_TYPES.contains(&media_type(ct).as_str())
                && size <= ARTIFACT_COVER_MAX_BYTES =>
        {
            None
        }
        _ => Some(Reject::BadCover),
    }
}

/// TS 의 고쳐 올리기 판정 — 잠근 행 `(channel_id, created_by)` 를 보고 없으면 `artifact_not_found`, 채널이 다르면
/// `artifact_other_channel`, 만든 이가 다르면 `artifact_not_yours`.
pub(crate) fn check_owner(row: Option<(&str, &str)>, channel: &str, actor: &str) -> Option<Reject> {
    match row {
        None => Some(Reject::NotFound),
        Some((c, _)) if c != channel => Some(Reject::OtherChannel),
        Some((_, a)) if a != actor => Some(Reject::NotYours),
        Some(_) => None,
    }
}

const LOCK_SQL: &str =
    "select channel_id::text, created_by::text from artifact where id = $1::uuid for update";
const RETITLE_SQL: &str = "update artifact set title = $2 where id = $1::uuid";

/// 버전 행 넣기. 새 안이면 버전 1(SELECT 없이), 고쳐 올리기면 TS 그대로 `coalesce(max(version), 0) + 1` — 같은 tx 의 행 잠금 뒤라
/// 겹치지 않는다. 표지가 있을 때만 `cover_attachment_id` 칸을 쓴다(없으면 그 칸 권한이 필요 없다).
fn version_sql(next: bool, cover: bool) -> String {
    let version = if next {
        "coalesce((select max(version) from artifact_version where artifact_id = $1::uuid), 0) + 1"
    } else {
        "1"
    };
    let (col, val) = if cover {
        (", cover_attachment_id", ", $5::uuid")
    } else {
        ("", "")
    };
    // 새 안은 `returning` 없이 1 — `artifact_version.version` SELECT 가 필요 없게.
    let ret = if next { " returning version" } else { "" };
    format!(
        "insert into artifact_version (artifact_id, version, attachment_id, summary, title{col}) \
         values ($1::uuid, {version}, $2::uuid, $3, $4{val}){ret}"
    )
}

const HTML_SQL: &str =
    "select content_type, size_bytes::bigint from attachment where id = $1::uuid";
const ARTIFACT_SQL: &str = "insert into artifact (channel_id, title, created_by) \
     values ($1::uuid, $2, $3::uuid) returning id::text";
/// 새 안 하나를 거는 훅. `title`·`summary` 는 zod `trim()` 을 지난 값이다. 지나면 [`NewArtifact::published`] 가 `(artifactId, 1)`.
#[derive(Debug)]
pub(crate) struct NewArtifact {
    pub(crate) channel_id: String,
    pub(crate) actor_id: String,
    pub(crate) title: String,
    pub(crate) html_attachment_id: String,
    pub(crate) summary: Option<String>,
    /// 고쳐 올릴 안(TS `artifactId`). 있으면 행을 잠그고 판정한 뒤 다음 버전을 단다.
    pub(crate) artifact_id: Option<String>,
    /// 표지 첨부(TS `coverAttachmentId`).
    pub(crate) cover_attachment_id: Option<String>,
    out: Mutex<Option<(String, i32)>>,
}

impl NewArtifact {
    pub(crate) fn new(
        channel_id: String,
        actor_id: String,
        title: String,
        html_attachment_id: String,
        summary: Option<String>,
    ) -> Self {
        Self {
            channel_id,
            actor_id,
            title,
            html_attachment_id,
            summary,
            artifact_id: None,
            cover_attachment_id: None,
            out: Mutex::new(None),
        }
    }

    /// 고쳐 올릴 안과 표지를 단다.
    pub(crate) fn with(mut self, artifact_id: Option<String>, cover: Option<String>) -> Self {
        self.artifact_id = artifact_id;
        self.cover_attachment_id = cover;
        self
    }

    /// TS `published` — 훅이 지났으면 `{ artifactId, version }`.
    pub(crate) fn published(&self) -> Option<(String, i32)> {
        self.out.lock().ok()?.clone()
    }
}

impl BeforeCommit for NewArtifact {
    fn run<'a>(
        &'a self,
        tx: &'a mut sqlx::Transaction<'static, sqlx::Postgres>,
        _message_id: &'a str,
        _notified: &'a std::collections::HashSet<String>,
    ) -> BeforeCommitFuture<'a> {
        Box::pin(async move {
            let row: Option<(String, i64)> = sqlx::query_as(HTML_SQL)
                .bind(&self.html_attachment_id)
                .fetch_optional(&mut **tx)
                .await?;
            if let Some(r) = check_html(row.as_ref().map(|(c, s)| (c.as_str(), *s))) {
                return Ok(Some(r.rejection()));
            }
            if let Some(cover) = &self.cover_attachment_id {
                let row: Option<(String, i64)> = sqlx::query_as(HTML_SQL)
                    .bind(cover)
                    .fetch_optional(&mut **tx)
                    .await?;
                if let Some(r) = check_cover(row.as_ref().map(|(c, s)| (c.as_str(), *s))) {
                    return Ok(Some(r.rejection()));
                }
            }
            let id = match &self.artifact_id {
                Some(id) => {
                    let row: Option<(String, String)> = sqlx::query_as(LOCK_SQL)
                        .bind(id)
                        .fetch_optional(&mut **tx)
                        .await?;
                    if let Some(r) = check_owner(
                        row.as_ref().map(|(c, a)| (c.as_str(), a.as_str())),
                        &self.channel_id,
                        &self.actor_id,
                    ) {
                        return Ok(Some(r.rejection()));
                    }
                    sqlx::query(RETITLE_SQL)
                        .bind(id)
                        .bind(&self.title)
                        .execute(&mut **tx)
                        .await?;
                    id.clone()
                }
                None => {
                    let (id,): (String,) = sqlx::query_as(ARTIFACT_SQL)
                        .bind(&self.channel_id)
                        .bind(&self.title)
                        .bind(&self.actor_id)
                        .fetch_one(&mut **tx)
                        .await?;
                    id
                }
            };
            let sql = version_sql(
                self.artifact_id.is_some(),
                self.cover_attachment_id.is_some(),
            );
            // 조각은 모두 이 파일의 고정 글자다(값은 바인드).
            let mut q = sqlx::query(sqlx::AssertSqlSafe(sql))
                .bind(&id)
                .bind(&self.html_attachment_id)
                .bind(self.summary.as_deref())
                .bind(&self.title);
            if let Some(cover) = &self.cover_attachment_id {
                q = q.bind(cover);
            }
            let version: i32 = if self.artifact_id.is_some() {
                use sqlx::Row;
                q.fetch_one(&mut **tx).await?.try_get(0)?
            } else {
                q.execute(&mut **tx).await?;
                1
            };
            let id = (id, version);
            if let Ok(mut g) = self.out.lock() {
                *g = Some(id);
            }
            Ok(None)
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn media_type_like_ts() {
        assert_eq!(media_type("text/html; charset=utf-8"), "text/html");
        assert_eq!(media_type("  TEXT/HTML "), "text/html");
        assert_eq!(media_type(""), "");
    }

    #[test]
    fn html_check_order_like_ts() {
        assert_eq!(check_html(None), Some(Reject::NotHtml));
        assert_eq!(check_html(Some(("image/png", 1))), Some(Reject::NotHtml));
        // not_html 이 too_large 보다 먼저다.
        assert_eq!(
            check_html(Some(("image/png", i64::MAX))),
            Some(Reject::NotHtml)
        );
        assert_eq!(
            check_html(Some(("text/html", ARTIFACT_HTML_MAX_BYTES + 1))),
            Some(Reject::TooLarge)
        );
        assert_eq!(
            check_html(Some(("text/html;charset=utf-8", ARTIFACT_HTML_MAX_BYTES))),
            None
        );
    }

    #[test]
    fn rejection_is_ts_shape() {
        let r = Reject::NotHtml.rejection();
        assert_eq!((r.status, r.code.as_str()), (400, "not_html"));
        assert_eq!(r.message, "the page must be an html file (text/html)");
        let r = Reject::TooLarge.rejection();
        assert_eq!(
            (r.code.as_str(), r.message.as_str()),
            ("too_large", "the page exceeds 5MB")
        );
    }

    #[test]
    fn hook_starts_unpublished_and_is_a_before_commit() {
        let h = NewArtifact::new("c".into(), "a".into(), "t".into(), "h".into(), None);
        assert!(h.published().is_none());
        let _: &dyn BeforeCommit = &h;
    }

    #[test]
    fn privileges_cover_every_written_column() {
        for col in ["channel_id", "title", "created_by"] {
            assert!(
                ARTIFACT_PUBLISH_PRIVILEGES
                    .contains(&(&format!("artifact.{col}") as &str, "INSERT"))
            );
        }
        for col in [
            "artifact_id",
            "version",
            "attachment_id",
            "summary",
            "title",
        ] {
            assert!(
                ARTIFACT_PUBLISH_PRIVILEGES
                    .contains(&(&format!("artifact_version.{col}") as &str, "INSERT")),
                "{col}"
            );
            assert!(version_sql(false, false).contains(col));
        }
        assert!(ARTIFACT_PUBLISH_PRIVILEGES.contains(&("artifact.id", "SELECT")));
        // 새 안만 — 행 잠금·갱신·max(version) 은 TS 몫이라 쓰지 않는다.
        assert!(!version_sql(false, false).contains("max("));
        assert!(
            ARTIFACT_PUBLISH_PRIVILEGES
                .iter()
                .all(|(_, p)| *p != "UPDATE")
        );
    }

    #[test]
    fn version_sql_needs_only_its_grants() {
        // 새 안·표지 없음: 버전 칸 SELECT(`returning`·`max`)도 표지 칸도 안 쓴다.
        let v1 = version_sql(false, false);
        assert!(!v1.contains("returning") && !v1.contains("cover_attachment_id"));
        assert!(v1.contains("$4)"));
        // 고쳐 올리기: TS 처럼 같은 tx 안 max+1, 버전을 돌려받는다.
        let next = version_sql(true, false);
        assert!(next.contains("coalesce((select max(version) from artifact_version where artifact_id = $1::uuid), 0) + 1"));
        assert!(next.ends_with("returning version"));
        let cov = version_sql(true, true);
        assert!(cov.contains("title, cover_attachment_id)") && cov.contains("$4, $5::uuid)"));
        assert!(version_sql(false, true).contains("cover_attachment_id"));
        assert!(ARTIFACT_REVISE_PRIVILEGES.contains(&("artifact_version.version", "SELECT")));
        assert!(ARTIFACT_REVISE_PRIVILEGES.contains(&("artifact.title", "UPDATE")));
        assert!(LOCK_SQL.ends_with("for update") && RETITLE_SQL.contains("set title"));
        assert_eq!(
            ARTIFACT_COVER_PRIVILEGES,
            &[("artifact_version.cover_attachment_id", "INSERT")]
        );
    }

    #[test]
    fn cover_check_like_ts() {
        assert_eq!(check_cover(None), Some(Reject::BadCover));
        assert_eq!(check_cover(Some(("image/gif", 1))), Some(Reject::BadCover));
        assert_eq!(
            check_cover(Some(("image/png", ARTIFACT_COVER_MAX_BYTES + 1))),
            Some(Reject::BadCover)
        );
        assert_eq!(
            check_cover(Some(("IMAGE/WEBP; x=y", ARTIFACT_COVER_MAX_BYTES))),
            None
        );
        assert_eq!(check_cover(Some(("image/jpeg", 0))), None);
        assert_eq!(
            Reject::BadCover.message(),
            "the cover must be a png/jpeg/webp image of at most 1MB"
        );
    }

    #[test]
    fn owner_check_order_like_ts() {
        assert_eq!(check_owner(None, "c", "a"), Some(Reject::NotFound));
        // 채널이 만든 이보다 먼저다.
        assert_eq!(
            check_owner(Some(("x", "y")), "c", "a"),
            Some(Reject::OtherChannel)
        );
        assert_eq!(
            check_owner(Some(("c", "y")), "c", "a"),
            Some(Reject::NotYours)
        );
        assert_eq!(check_owner(Some(("c", "a")), "c", "a"), None);
        assert_eq!(Reject::NotFound.code(), "artifact_not_found");
        assert_eq!(Reject::OtherChannel.code(), "artifact_other_channel");
        assert_eq!(Reject::NotYours.code(), "artifact_not_yours");
        assert_eq!(
            Reject::NotYours.message(),
            "that artifact was made by someone else — omit artifactId to start your own"
        );
    }
}
