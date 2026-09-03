import type { FastifyInstance } from 'fastify';
import type { Pool } from 'pg';
import { z } from 'zod';
import { assertChannelVisible } from '../services/channels.js';
import { findDownloadTarget, listChannelFiles, recordUpload } from '../services/attachments.js';
import { StorageLimitError, AttachmentMissingError, type StorageBackend } from '../storage/local.js';

/**
 * 절대 inline 으로 내주지 않는 타입. SVG 는 `<script>` 를 담을 수 있어 이미지처럼 보이지만
 * 이미지가 아니다. 그래서 이 라우트는 **모든** 첨부를 `attachment` 로 내려준다 — 예외를 하나
 * 두면 그 예외가 XSS 통로가 된다. 이미지 미리보기는 클라이언트가 받은 바이트로 그린다.
 */
const NEVER_INLINE = ['image/svg+xml', 'text/html', 'application/xhtml+xml'];

/** 헤더에 넣을 파일명. ASCII 로 좁힌 것과 UTF-8 원본을 함께 준다(RFC 6266). */
function dispositionFor(filename: string): string {
  const ascii = filename.replace(/[^\x20-\x7e]/g, '_').replace(/["\\]/g, '_');
  return `attachment; filename="${ascii}"; filename*=UTF-8''${encodeURIComponent(filename)}`;
}

export async function registerAttachmentRoutes(
  app: FastifyInstance, pool: Pool, storage: StorageBackend,
): Promise<void> {
  app.post('/uploads', { preHandler: app.requireAccount }, async (req, reply) => {
    const part = await req.file();
    if (!part) {
      return reply.code(400).send({ error: { code: 'bad_request', message: 'expected a file part' } });
    }

    let stored: { key: string; bytes: number };
    try {
      // 파일을 먼저 쓰고 DB 행을 나중에 만든다. 실패하면 남는 것이 고아 파일(GC 로 치울 수
      // 있다)이고, 반대 순서는 가리키는 파일이 없는 행을 남긴다 — 그건 '깨진 첨부'다.
      stored = await storage.write(part.file);
    } catch (err) {
      if (err instanceof StorageLimitError) {
        return reply.code(413).send({
          error: { code: 'too_large', message: err.message },
        });
      }
      throw err;
    }

    // multipart 파서가 자체 제한에 걸리면 스트림을 **조용히 잘라내고** 정상 종료시킨다.
    // 그것을 성공으로 저장하면 사용자는 온전한 파일이 올라갔다고 믿는다 — 제한이 없는 것보다
    // 나쁘다. 그래서 스토리지가 끊지 못한 경우까지 여기서 확인한다.
    if (part.file.truncated) {
      await storage.remove(stored.key).catch(() => {});
      return reply.code(413).send({
        error: { code: 'too_large', message: 'file exceeds the size limit' },
      });
    }

    try {
      const row = await recordUpload(pool, {
        uploaderId: req.account!.id,
        filename: part.filename,
        // 클라이언트가 보낸 타입은 신뢰하지 않는다 — 저장만 하고 내려줄 때 무력화한다.
        contentType: part.mimetype || 'application/octet-stream',
        sizeBytes: stored.bytes,
        storageKey: stored.key,
      });
      return reply.code(201).send({
        id: row.id, filename: row.filename, contentType: row.contentType, sizeBytes: row.sizeBytes,
      });
    } catch (err) {
      // 행을 만들지 못했으면 파일은 아무도 가리키지 않는다 — 지금 지운다.
      await storage.remove(stored.key).catch(() => {});
      throw err;
    }
  });

  /**
   * 채널에 오간 파일 목록(#232). 채널 경로지만 **여기** 있는 이유: 이 응답이 답하는 질문은
   * 첨부에 대한 것이고, 가시성 판정과 첨부 조회를 같은 파일에 두면 둘 중 하나만 고쳐서
   * 갈리는 일이 없다.
   *
   * 가시성은 이 채널의 규칙을 **그대로** 따른다 — `assertChannelVisible` 을 부르고 여기서
   * 규칙을 다시 쓰지 않는다(`channels.ts` 의 `audienceFor` 주석이 그 사고를 기록한다).
   * 그리고 판정이 먼저다: 파일명은 그 자체로 내용이므로 볼 수 없는 채널이면 개수도
   * 파일명도 나가면 안 된다.
   */
  app.get('/channels/:id/files', { preHandler: app.requireAccount }, async (req, reply) => {
    const { id } = z.object({ id: z.string().uuid() }).parse(req.params);
    const q = z.object({
      before: z.coerce.number().int().min(0).optional(),
      limit: z.coerce.number().int().min(1).max(200).optional(),
    }).parse(req.query);

    if (!(await assertChannelVisible(pool, id, req.account!.id))) {
      return reply.code(403).send({ error: { code: 'forbidden', message: 'not a member of this dm channel' } });
    }
    return await listChannelFiles(pool, id, { before: q.before, limit: q.limit });
  });

  app.get('/attachments/:id', { preHandler: app.requireAccount }, async (req, reply) => {
    const { id } = z.object({ id: z.string().uuid() }).parse(req.params);

    const target = await findDownloadTarget(pool, id);
    if (!target) {
      return reply.code(404).send({ error: { code: 'not_found', message: 'no such attachment' } });
    }

    if (target.channelId === null) {
      // 아직 메시지에 붙지 않은 업로드는 올린 사람만 볼 수 있다 — 남이 id 를 맞혔을 때
      // 열리면, 게시 전 초안이 새는 경로가 된다.
      if (target.attachment.uploaderId !== req.account!.id) {
        return reply.code(403).send({ error: { code: 'forbidden', message: 'not your upload' } });
      }
    } else if (!(await assertChannelVisible(pool, target.channelId, req.account!.id))) {
      return reply.code(403).send({ error: { code: 'forbidden', message: 'not a member of this dm channel' } });
    }

    try {
      const body = await storage.read(target.attachment.storageKey);
      const type = NEVER_INLINE.includes(target.attachment.contentType)
        ? 'application/octet-stream'
        : target.attachment.contentType;
      return reply
        // nosniff 없이는 브라우저가 내용을 보고 타입을 다시 판정해 스크립트로 실행할 수 있다.
        .header('x-content-type-options', 'nosniff')
        .header('content-disposition', dispositionFor(target.attachment.filename))
        .header('content-length', String(target.attachment.sizeBytes))
        .type(type)
        .send(body);
    } catch (err) {
      if (err instanceof AttachmentMissingError) {
        /**
         * 행은 있는데 바이트가 없다(#257). **500 이 아니다** — 500 은 "서버가 고장났다"고
         * 말하지만 실제 사실은 "이 첨부의 파일이 없다"이고, 그 둘은 대처가 다르다(전자는
         * 재시도, 후자는 운영 조치).
         *
         * 찾은 경로는 **로그에만** 남긴다. 응답에 실으면 서버 파일시스템의 절대경로를
         * 아무 로그인 사용자에게나 알려 주는 셈이고, 사람이 이 화면에서 할 수 있는 일은
         * 경로를 알아도 달라지지 않는다.
         */
        req.log.warn(`attachment ${target.attachment.id} row exists but file is missing at ${err.path}`);
        return reply.code(404).send({
          error: { code: 'attachment_missing', message: 'attachment file not found on the server' },
        });
      }
      throw err;
    }
  });
}
