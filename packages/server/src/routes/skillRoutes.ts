import type { FastifyInstance } from 'fastify';
import type { Pool } from 'pg';
import { z } from 'zod';
import { approveSkill, disableSkill, listSkills, getSkill } from '../services/skills.js';

export async function registerSkillRoutes(app: FastifyInstance, pool: Pool): Promise<void> {
  app.get('/skills', async (req) => {
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

  app.get('/skills/:slug', async (req, reply) => {
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
      if (result.error.code === 'not_found' || result.error.code === 'already_approved') {
        return reply.code(404).send({ error: result.error });
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
    const result = await disableSkill(pool, { slug, disabledBy: req.account!.id });
    if ('error' in result) {
      if (result.error.code === 'not_found') {
        return reply.code(404).send({ error: result.error });
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