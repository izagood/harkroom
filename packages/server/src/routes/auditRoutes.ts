import type { FastifyInstance } from 'fastify';
import type { Pool } from 'pg';
import { z } from 'zod';
import { listAudit } from '../audit.js';

export async function registerAuditRoutes(app: FastifyInstance, pool: Pool): Promise<void> {
  // admin 전용. 감사 로그는 "누가 무엇을 바꿨나"이므로 일반 참여자에게는 다른 사람의 행적이다.
  // 조회 표면이 없으면 확인 방법이 psql 뿐이고, 그러면 "사후에 알 방법이 없다"가 절반만 해소된다.
  app.get('/audit', { preHandler: app.requireAdmin }, async (req) => {
    const q = z.object({
      limit: z.coerce.number().int().min(1).max(500).optional(),
      // id 기반 커서. 시각이 아니라 id 로 페이지네이션한다 — 같은 밀리초에 여러 건이 들어오면
      // 시각 커서는 항목을 건너뛰거나 반복한다.
      before: z.string().regex(/^\d+$/).optional(),
      action: z.string().max(64).optional(),
    }).parse(req.query);
    return { entries: await listAudit(pool, q) };
  });
}
