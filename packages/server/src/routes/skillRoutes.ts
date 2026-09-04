import type { FastifyInstance } from 'fastify';
import type { Pool } from 'pg';
import { z } from 'zod';
import { approveSkill, disableSkill, listSkills, getSkill } from '../services/skills.js';

export async function registerSkillRoutes(app: FastifyInstance, pool: Pool): Promise<void> {
  // 스킬 본문은 워크스페이스 자산이다 — 로그인한 계정(사람·에이전트 PAT)만 읽는다.
  // 인증 없이 열면 승인된 스킬 본문이 곧 시스템 프롬프트라 프롬프트 표면이 그대로 새어 나간다.
  // `state` 가 없으면 전부다(#325). 세 상태를 한 화면에 나눠 그리는 #311 이 그 호출자다.
  //
  // **`.strict()` 인 이유:** #325 는 옛 `?approved=` 를 별칭으로 남기지 않기로 했다.
  // zod 는 기본으로 모르는 키를 **말없이 버리므로**, strict 가 없으면 `?approved=true` 가
  // "필터 없음"이 되어 미승인 스킬까지 200 으로 돌아간다 — 이름을 믿은 호출자가 받는 것이
  // 정확히 #325 가 신고한 그 사고다. 조용히 넘기는 대신 400 으로 깨뜨려 호출부를 고치게 한다.
  app.get('/skills', { preHandler: app.requireAccount }, async (req) => {
    const { state } = z.object({
      state: z.enum(['pending', 'approved', 'disabled']).optional(),
    }).strict().parse(req.query);

    const skills = await listSkills(pool, { state: state ?? null });
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