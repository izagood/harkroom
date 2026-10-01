import type { FastifyInstance } from 'fastify';
import type { Pool } from 'pg';
import { z } from 'zod';
import { resolveAttachmentFor } from '../services/attachments.js';
import {
  ARTIFACT_HTML_MAX_BYTES, PREVIEW_CSP, PREVIEW_TOKEN_TTL_MS,
  artifactVersionForAttachment, createPreviewKeyReader, signPreviewToken, verifyPreviewToken,
} from '../services/artifactPreview.js';
import { AttachmentMissingError, type StorageBackend } from '../storage/local.js';

/**
 * 미리보기(아티팩트) 열람 — 앱 안에서 에이전트가 만든 HTML 을 바로 본다(2026-10-02).
 *
 * 두 단계인 이유: 인증은 `Authorization: Bearer` 하나뿐인데 `<iframe src>`·WebView 는 그 헤더를
 * 싣지 못한다. 그래서 앱이 Bearer 로 **짧은 서명 URL** 을 받고(`POST`), 그 URL 을 프레임에
 * 띄운다(`GET`, 인증 헤더 없음). 토큰을 쥔 WebView 는 없다.
 *
 * `GET /attachments/:id` 의 "절대 inline 으로 내주지 않는다" 규칙은 그대로다. HTML 을 문서로
 * 내주는 길은 **여기 하나**이고, 그 길은 언제나 CSP `sandbox` 를 단다.
 */
export async function registerPreviewRoutes(
  app: FastifyInstance, pool: Pool, storage: StorageBackend,
  opts: { now?: () => number } = {},
): Promise<void> {
  const now = opts.now ?? Date.now;
  const previewKey = createPreviewKeyReader(pool);

  app.post('/attachments/:id/preview', { preHandler: app.requireAccount }, async (req, reply) => {
    const { id } = z.object({ id: z.string().uuid() }).parse(req.params);

    // 가시성은 첨부와 **같은 함수**다 — 채널 멤버만, 지운 메시지는 없는 것으로.
    const resolved = await resolveAttachmentFor(pool, id, req.account!.id);
    if (!resolved.ok) {
      if (resolved.denial === 'not_found') {
        return reply.code(404).send({ error: { code: 'not_found', message: 'no such attachment' } });
      }
      return reply.code(403).send({ error: { code: 'forbidden', message: 'you cannot see this attachment' } });
    }
    const ref = await artifactVersionForAttachment(pool, id);
    if (!ref || !isHtml(resolved.attachment.contentType)) {
      return reply.code(404).send({ error: { code: 'not_a_preview', message: 'this attachment is not a preview' } });
    }
    // 카드가 "너무 큼 — 파일로 받기"를 말할 수 있게 열기 전에 거절한다.
    if (resolved.attachment.sizeBytes > ARTIFACT_HTML_MAX_BYTES) {
      return reply.code(413).send({ error: { code: 'too_large', message: 'this preview is too large to open' } });
    }

    const issuedAt = now();
    const token = signPreviewToken(await previewKey(), id, req.account!.id, issuedAt);
    // 절대 URL 이 아니라 경로를 준다 — 서버는 프록시 뒤에서 자기 공개 주소를 모른다. 앱은
    // 이미 자기 서버 주소를 안다.
    return reply.code(201).send({
      path: `/preview/${token}`,
      expiresAt: new Date(issuedAt + PREVIEW_TOKEN_TTL_MS).toISOString(),
      artifactId: ref.artifactId,
      version: ref.version,
      latestVersion: ref.latestVersion,
      title: ref.title,
    });
  });

  /**
   * 인증 헤더 없이 연다 — 토큰이 자격이다. 그래도 **열 때 가시성을 다시 판정한다**: 토큰을 받은
   * 뒤 60초 안에 메시지가 지워졌거나 그 사람이 채널에서 빠졌으면 열리면 안 된다.
   *
   * 실패는 전부 같은 404 다. 서명이 틀렸는지·만료됐는지·권한이 없는지를 가르면 토큰을 맞혀
   * 보는 쪽에 신호를 준다. 앱은 열 때마다 새 토큰을 받으므로 구분이 필요 없다.
   */
  app.get('/preview/:token', async (req, reply) => {
    const { token } = z.object({ token: z.string().min(1).max(1024) }).parse(req.params);
    const notFound = () => reply
      .code(404)
      .header('cache-control', 'no-store')
      .send({ error: { code: 'not_found', message: 'no such preview' } });

    const claim = verifyPreviewToken(await previewKey(), token, now());
    if (!claim) return notFound();
    const resolved = await resolveAttachmentFor(pool, claim.attachmentId, claim.accountId);
    if (!resolved.ok) return notFound();
    const attachment = resolved.attachment;
    if (!isHtml(attachment.contentType) || attachment.sizeBytes > ARTIFACT_HTML_MAX_BYTES) return notFound();
    if (!(await artifactVersionForAttachment(pool, attachment.id))) return notFound();

    try {
      const body = await storage.read(attachment.storageKey);
      return reply
        .header('content-security-policy', PREVIEW_CSP)
        .header('x-content-type-options', 'nosniff')
        // URL 에 토큰이 있다 — 페이지 안 링크를 눌러도 밖으로 새지 않게.
        .header('referrer-policy', 'no-referrer')
        .header('cache-control', 'no-store')
        .header('permissions-policy', 'camera=(), microphone=(), geolocation=(), clipboard-read=()')
        .header('content-length', String(attachment.sizeBytes))
        .type('text/html; charset=utf-8')
        .send(body);
    } catch (err) {
      if (err instanceof AttachmentMissingError) {
        req.log.warn(`preview ${attachment.id} row exists but file is missing at ${err.path}`);
        return notFound();
      }
      throw err;
    }
  });
}

function isHtml(contentType: string): boolean {
  return contentType.split(';')[0]!.trim().toLowerCase() === 'text/html';
}
