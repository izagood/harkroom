import type { PoolClient } from 'pg';
import { ARTIFACT_HTML_MAX_BYTES } from './artifactPreview.js';

/** `artifact.publish` 의 `html` 인자 상한(2026-10-02 결정: 인자 2MB). 큰 페이지는 파일로 올린다. */
export const ARTIFACT_PUBLISH_ARG_MAX_BYTES = 2 * 1024 * 1024;

/** 표지 그림 상한(2026-10-02 결정: 1MB). 카드 썸네일이라 이보다 클 이유가 없다. */
export const ARTIFACT_COVER_MAX_BYTES = 1024 * 1024;

const COVER_TYPES = ['image/png', 'image/jpeg', 'image/webp'];

export type ArtifactVersionRejection =
  | 'artifact_not_found'
  | 'artifact_other_channel'
  | 'artifact_not_yours'
  | 'not_html'
  | 'too_large'
  | 'bad_cover';

/**
 * 메시지에 막 붙은 첨부를 미리보기 버전으로 건다 — **`postMessage` 의 `beforeCommit` 안에서**
 * 부른다. 메시지·첨부 연결·버전 행이 한 트랜잭션이라, 거절이면 글도 첨부 연결도 남지 않는다.
 *
 * 고쳐 올리기(`artifactId`)는 **같은 채널·같은 만든 이**일 때만 받는다(security, #1045 뒤 조건).
 *  - 다른 채널에서 같은 id 로 올리면 옛 채널의 카드가 모르는 사이에 "최신 vN"을 가리키고,
 *    미리보기 발급 응답의 `title` 이 다른 채널의 것으로 나간다.
 *  - 남이 만든 안에 버전을 얹으면 그 사람 이름의 안이 바뀐 것처럼 보인다.
 * 버전 번호는 그 artifact 행을 잠그고 매긴다 — 동시에 두 번 고쳐 올려도 n 이 겹치지 않는다.
 */
export async function attachArtifactVersion(
  client: PoolClient,
  input: {
    channelId: string;
    actorId: string;
    title: string;
    htmlAttachmentId: string;
    coverAttachmentId?: string | null;
    summary?: string | null;
    artifactId?: string | null;
  },
): Promise<{ ok: true; artifactId: string; version: number } | { ok: false; code: ArtifactVersionRejection }> {
  const files = await client.query<{ id: string; contentType: string; sizeBytes: number }>(
    `select id, content_type as "contentType", size_bytes::int as "sizeBytes"
       from attachment where id = any($1::uuid[])`,
    [[input.htmlAttachmentId, ...(input.coverAttachmentId ? [input.coverAttachmentId] : [])]],
  );
  const html = files.rows.find((r) => r.id === input.htmlAttachmentId);
  if (!html || mediaType(html.contentType) !== 'text/html') return { ok: false, code: 'not_html' };
  if (html.sizeBytes > ARTIFACT_HTML_MAX_BYTES) return { ok: false, code: 'too_large' };
  if (input.coverAttachmentId) {
    const cover = files.rows.find((r) => r.id === input.coverAttachmentId);
    if (!cover || !COVER_TYPES.includes(mediaType(cover.contentType)) || cover.sizeBytes > ARTIFACT_COVER_MAX_BYTES) {
      return { ok: false, code: 'bad_cover' };
    }
  }

  let artifactId = input.artifactId ?? null;
  if (artifactId) {
    const found = await client.query<{ channelId: string; createdBy: string }>(
      `select channel_id as "channelId", created_by as "createdBy" from artifact where id = $1 for update`,
      [artifactId],
    );
    const row = found.rows[0];
    if (!row) return { ok: false, code: 'artifact_not_found' };
    if (row.channelId !== input.channelId) return { ok: false, code: 'artifact_other_channel' };
    if (row.createdBy !== input.actorId) return { ok: false, code: 'artifact_not_yours' };
    // 제목은 최신 버전의 것을 따른다 — 카드·패널 머리줄이 같은 이름을 보인다.
    await client.query(`update artifact set title = $2 where id = $1`, [artifactId, input.title]);
  } else {
    const created = await client.query<{ id: string }>(
      `insert into artifact (channel_id, title, created_by) values ($1, $2, $3) returning id`,
      [input.channelId, input.title, input.actorId],
    );
    artifactId = created.rows[0]!.id;
  }

  const version = await client.query<{ version: number }>(
    `insert into artifact_version (artifact_id, version, attachment_id, cover_attachment_id, summary)
     values ($1, coalesce((select max(version) from artifact_version where artifact_id = $1), 0) + 1, $2, $3, $4)
     returning version`,
    [artifactId, input.htmlAttachmentId, input.coverAttachmentId ?? null, input.summary ?? null],
  );
  return { ok: true, artifactId, version: version.rows[0]!.version };
}

/** 거절 사유를 에이전트가 다음 행동을 고를 수 있는 문장으로. */
export const ARTIFACT_REJECTION_MESSAGES: Record<ArtifactVersionRejection, string> = {
  artifact_not_found: 'no such artifact — omit artifactId to start a new one',
  artifact_other_channel: 'that artifact lives in another channel — omit artifactId to start a new one here',
  artifact_not_yours: 'that artifact was made by someone else — omit artifactId to start your own',
  not_html: 'the page must be an html file (text/html)',
  too_large: `the page exceeds ${ARTIFACT_HTML_MAX_BYTES / 1024 / 1024}MB`,
  bad_cover: `the cover must be a png/jpeg/webp image of at most ${ARTIFACT_COVER_MAX_BYTES / 1024 / 1024}MB`,
};

function mediaType(contentType: string): string {
  return contentType.split(';')[0]!.trim().toLowerCase();
}
