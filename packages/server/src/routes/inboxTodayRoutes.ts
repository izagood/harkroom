/**
 * 인박스 「오늘」(C안 P1) — `/inbox/today/*`. 옛 `/inbox`·`/inbox/board` 는 건드리지 않는다.
 * 계정은 언제나 부른 사람이다 — 몸통·질의로 받지 않는다.
 */
import { createHash } from 'node:crypto';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import type { Pool } from 'pg';
import { z } from 'zod';
import { emitEvent } from '../events.js';
import { decodeCursor, doneVersion, listTodayDone, listTodayOpen, markSeen, openVersion, TODAY_DONE_MAX } from '../services/inboxToday.js';

/**
 * 버전 태그 → ETag. `/inbox/board` 처럼 **계정 id 를 섞은** 해시라 두 사람의 판이 같아도 태그가 갈린다.
 * 같으면 본문 질의 없이 304 — 태그를 먼저 구하는 것이 이 엔드포인트들의 뜻이다(S5).
 */
function etagFor(accountId: string, version: string): string {
  return `"${createHash('sha256').update(accountId).update('\0').update(version).digest('base64url').slice(0, 32)}"`;
}
function notModified(req: FastifyRequest, reply: FastifyReply, etag: string): boolean {
  void reply.header('etag', etag).header('cache-control', 'private, no-cache');
  const inm = req.headers['if-none-match'];
  return typeof inm === 'string' && inm.split(',').some((t) => t.trim() === etag);
}

export async function registerInboxTodayRoutes(app: FastifyInstance, pool: Pool): Promise<void> {
  app.put('/inbox/today/seen', { preHandler: app.requireAccount }, async (req) => {
    const body = z.object({ upTo: z.string().datetime({ offset: true }) }).parse(req.body);
    const accountId = req.account!.id;
    const { seenAt, changed } = await markSeen(pool, accountId, new Date(body.upTo));
    // 내 다른 기기의 「오늘」도 따라오게 한다(새 줄 표시가 바뀐다).
    if (changed) emitEvent({ type: 'inbox.updated', accountId });
    return { seenAt: seenAt.toISOString() };
  });

  app.get('/inbox/today/open', { preHandler: app.requireAccount }, async (req, reply) => {
    const accountId = req.account!.id;
    const human = req.account!.kind === 'human';
    const etag = etagFor(accountId, await openVersion(pool, accountId, human));
    if (notModified(req, reply, etag)) return reply.code(304).send();
    return await listTodayOpen(pool, accountId, human);
  });

  app.get('/inbox/today/done', { preHandler: app.requireAccount }, async (req, reply) => {
    const q = z.object({
      since: z.string().max(200).optional(),
      limit: z.coerce.number().int().min(1).max(TODAY_DONE_MAX).optional(),
    }).parse(req.query);
    const since = q.since === undefined ? undefined : decodeCursor(q.since);
    if (since === null) return reply.code(400).send({ error: { code: 'bad_cursor', message: 'since is not a cursor from this endpoint' } });
    const limit = q.limit ?? TODAY_DONE_MAX;
    const accountId = req.account!.id;
    const etag = etagFor(accountId, `${await doneVersion(pool, accountId)}|${q.since ?? ''}|${limit}`);
    if (notModified(req, reply, etag)) return reply.code(304).send();
    return await listTodayDone(pool, accountId, { since, limit });
  });
}
