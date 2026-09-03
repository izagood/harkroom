import type { FastifyInstance } from 'fastify';
import type { Pool } from 'pg';
import { z } from 'zod';
import { normalizePreviewUrl } from '@murmur/shared';
import { getLinkPreviewByUrl } from '../services/linkPreviewDb.js';

export async function registerLinkPreviewRoutes(app: FastifyInstance, pool: Pool): Promise<void> {
  /**
   * 미리보기 카드 조회(#215).
   *
   * **로그인이 필요하다.** 이 캐시는 워크스페이스 안에서 오간 링크의 목록이나 마찬가지다 —
   * 인증 없이 열면 누구나 "이 워크스페이스가 어떤 주소를 봤는가"를 하나씩 찔러 볼 수 있다.
   * 채널 가시성까지 따지지는 않는다: 캐시 키는 URL 이고 어느 채널에서 왔는지를 담지 않는다.
   *
   * **키를 여기서 정규화한다.** 클라이언트가 본문에서 집은 글자와 서버가 저장할 때 쓴 키가
   * 한 글자라도 다르면 카드는 영원히 404 다. 양쪽 다 `normalizePreviewUrl`(shared)을 쓰고,
   * 이 라우트가 마지막 관문이다.
   */
  app.get('/link-previews', { preHandler: app.requireAccount }, async (req, reply) => {
    const parsed = z.object({ url: z.string().min(1) }).safeParse(req.query);
    if (!parsed.success) {
      return reply.code(400).send({ error: { code: 'bad_request', message: 'url is required' } });
    }
    const url = normalizePreviewUrl(parsed.data.url);
    if (!url) {
      // 미리보기 대상이 아닌 URL(다른 스킴·자격증명 포함)은 400 이다. 404 로 답하면
      // "아직 안 왔다"와 "애초에 올 수 없다"가 한 응답으로 뭉개진다.
      return reply.code(400).send({ error: { code: 'bad_request', message: 'not a previewable url' } });
    }
    const preview = await getLinkPreviewByUrl(pool, url);
    if (!preview) {
      return reply.code(404).send({ error: { code: 'not_found', message: 'link preview not found' } });
    }
    return preview;
  });
}
