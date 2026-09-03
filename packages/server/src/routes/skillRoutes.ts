import type { FastifyInstance } from 'fastify';
import type { Pool } from 'pg';
import { z } from 'zod';
import { approveSkill, disableSkill, listSkills, getSkill } from '../services/skills.js';

export async function registerSkillRoutes(app: FastifyInstance, pool: Pool): Promise<void> {
  // 스킬 본문은 워크스페이스 자산이다 — 로그인한 계정(사람·에이전트 PAT)만 읽는다.
  // 인증 없이 열면 승인된 스킬 본문이 곧 시스템 프롬프트라 프롬프트 표면이 그대로 새어 나간다.
  app.get('/skills', { preHandler: app.requireAccount }, async (req) => {
    const { approved } = z.object({
      approved: z.enum(['true', 'false']).optional(),
    }).parse(req.query);

    const skills = await listSkills(pool, { approved: approved === 'true' });
    return skills.map((s) => ({
      slug: s.slug,
      body: s.body,
      proposedBy: s.proposedBy,
      proposedAt: s.proposedAt.toISOString(),
      approvedBy: s.approvedBy,
      approvedAt: s.approvedAt?.toISOString() ?? null,
      disabledAt: s.disabledAt?.toISOString() ?? null,
    }));
  });

  app.get('/skills/:slug', { preHandler: app.requireAccount }, async (req, reply) => {
    const { slug } = z.object({ slug: z.string() }).parse(req.params);
    const skill = await getSkill(pool, slug);
    if (!skill) {
      return reply.code(404).send({ error: { code: 'not_found', message: 'skill not found' } });
    }
    return {
      slug: skill.slug,
      body: skill.body,
      proposedBy: skill.proposedBy,
      proposedAt: skill.proposedAt.toISOString(),
      approvedBy: skill.approvedBy,
      approvedAt: skill.approvedAt?.toISOString() ?? null,
      disabledAt: skill.disabledAt?.toISOString() ?? null,
    };
  });

  app.post('/skills/:slug/approve', { preHandler: app.requireAdmin }, async (req, reply) => {
    const { slug } = z.object({ slug: z.string() }).parse(req.params);
    const result = await approveSkill(pool, { slug, approvedBy: req.account!.id });
    if ('error' in result) {
      if (result.error.code === 'not_found') {
        return reply.code(404).send({ error: result.error });
      }
      // 이미 승인된 것은 404 가 아니다 — 행은 있다. 404 로 답하면 승인 도장이 두 번 찍히는
      // 사고와 slug 오타가 같은 응답으로 뭉개진다.
      if (result.error.code === 'already_approved') {
        return reply.code(409).send({ error: result.error });
      }
      return reply.code(400).send({ error: result.error });
    }
    return {
      slug: result.ok.slug,
      body: result.ok.body,
      proposedBy: result.ok.proposedBy,
      proposedAt: result.ok.proposedAt.toISOString(),
      approvedBy: result.ok.approvedBy,
      approvedAt: result.ok.approvedAt?.toISOString() ?? null,
      disabledAt: result.ok.disabledAt?.toISOString() ?? null,
    };
  });

  app.delete('/skills/:slug', { preHandler: app.requireAdmin }, async (req, reply) => {
    const { slug } = z.object({ slug: z.string() }).parse(req.params);
    const result = await disableSkill(pool, { slug });
    if ('error' in result) {
      if (result.error.code === 'not_found') {
        return reply.code(404).send({ error: result.error });
      }
      if (result.error.code === 'already_disabled') {
        return reply.code(409).send({ error: result.error });
      }
      return reply.code(400).send({ error: result.error });
    }
    return {
      slug: result.ok.slug,
      body: result.ok.body,
      proposedBy: result.ok.proposedBy,
      proposedAt: result.ok.proposedAt.toISOString(),
      approvedBy: result.ok.approvedBy,
      approvedAt: result.ok.approvedAt?.toISOString() ?? null,
      disabledAt: result.ok.disabledAt?.toISOString() ?? null,
    };
  });
}