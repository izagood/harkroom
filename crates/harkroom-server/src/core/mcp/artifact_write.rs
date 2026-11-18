//! MCP `artifact.publish` 의 버전 걸기(TS `services/artifacts.ts` `attachArtifactVersion`) — **새 안(v1)만**. `postMessage` 의
//! `beforeCommit` 자리([`crate::core::msg_post::BeforeCommit`])에서 글과 같은 tx 로 `artifact`·`artifact_version` 행을 넣는다.
//! 거절이면 msg_post 가 롤백한다(글도 첨부 연결도 남지 않는다).
//!
//! 이 판이 맡는 모양: `html` 글자로 받은 페이지, `artifactId` 없음(새 안), 표지 없음. 고쳐 올리기(`artifactId`, 행 잠금·
//! 채널·만든 이 판정·제목 갱신)와 표지(`coverAttachmentId`)는 TS 몫이다. 라우트([`super::artifact_publish`])가
//! 앞단(저장소 쓰기·업로드 행)을 맡고 이 훅을 건다([`super::artifact_publish::publish`]). 권한은 [`ARTIFACT_PUBLISH_PRIVILEGES`].
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

/// TS `ArtifactVersionRejection` 중 새 안(표지 없음)에서 나올 수 있는 것.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum Reject {
    NotHtml,
    TooLarge,
}

impl Reject {
    pub(crate) fn code(self) -> &'static str {
        match self {
            Reject::NotHtml => "not_html",
            Reject::TooLarge => "too_large",
        }
    }

    /// TS `ARTIFACT_REJECTION_MESSAGES` 글자 그대로.
    pub(crate) fn message(self) -> &'static str {
        match self {
            Reject::NotHtml => "the page must be an html file (text/html)",
            Reject::TooLarge => "the page exceeds 5MB",
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

const HTML_SQL: &str =
    "select content_type, size_bytes::bigint from attachment where id = $1::uuid";
const ARTIFACT_SQL: &str = "insert into artifact (channel_id, title, created_by) \
     values ($1::uuid, $2, $3::uuid) returning id::text";
/// 새 안이라 버전은 1 이다(TS 의 `coalesce(max(version), 0) + 1` 이 막 만든 안에서 내는 값) — `artifact_version` SELECT 가 필요 없다.
const VERSION_SQL: &str = "insert into artifact_version (artifact_id, version, attachment_id, summary, title) \
     values ($1::uuid, 1, $2::uuid, $3, $4)";

/// 새 안 하나를 거는 훅. `title`·`summary` 는 zod `trim()` 을 지난 값이다. 지나면 [`NewArtifact::published`] 가 `(artifactId, 1)`.
#[derive(Debug)]
pub(crate) struct NewArtifact {
    pub(crate) channel_id: String,
    pub(crate) actor_id: String,
    pub(crate) title: String,
    pub(crate) html_attachment_id: String,
    pub(crate) summary: Option<String>,
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
            out: Mutex::new(None),
        }
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
    ) -> BeforeCommitFuture<'a> {
        Box::pin(async move {
            let row: Option<(String, i64)> = sqlx::query_as(HTML_SQL)
                .bind(&self.html_attachment_id)
                .fetch_optional(&mut **tx)
                .await?;
            if let Some(r) = check_html(row.as_ref().map(|(c, s)| (c.as_str(), *s))) {
                return Ok(Some(r.rejection()));
            }
            let (id,): (String,) = sqlx::query_as(ARTIFACT_SQL)
                .bind(&self.channel_id)
                .bind(&self.title)
                .bind(&self.actor_id)
                .fetch_one(&mut **tx)
                .await?;
            sqlx::query(VERSION_SQL)
                .bind(&id)
                .bind(&self.html_attachment_id)
                .bind(self.summary.as_deref())
                .bind(&self.title)
                .execute(&mut **tx)
                .await?;
            if let Ok(mut g) = self.out.lock() {
                *g = Some((id, 1));
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
            assert!(VERSION_SQL.contains(col));
        }
        assert!(ARTIFACT_PUBLISH_PRIVILEGES.contains(&("artifact.id", "SELECT")));
        // 새 안만 — 행 잠금·갱신·max(version) 은 TS 몫이라 쓰지 않는다.
        assert!(!VERSION_SQL.contains("max("));
        assert!(
            ARTIFACT_PUBLISH_PRIVILEGES
                .iter()
                .all(|(_, p)| *p != "UPDATE")
        );
    }
}
