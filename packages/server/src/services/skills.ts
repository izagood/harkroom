import type { Pool } from 'pg';
import type { AccountView } from '@murmur/shared';
import { emitEvent } from '../events.js';

export const SKILL_SLUG_REGEX = /^[a-z0-9-]{2,40}$/;

export function isValidSkillSlug(slug: string): boolean {
  return SKILL_SLUG_REGEX.test(slug);
}

export interface WorkspaceSkill {
  slug: string;
  body: string;
  proposedBy: string;
  proposedAt: Date;
  approvedBy: string | null;
  approvedAt: Date | null;
  disabledAt: Date | null;
}

export async function proposeSkill(
  pool: Pool,
  input: { slug: string; body: string; proposedBy: string; channelId: string },
): Promise<{ ok: WorkspaceSkill } | { error: { code: string; message: string } }> {
  if (!isValidSkillSlug(input.slug)) {
    return { error: { code: 'invalid_slug', message: 'slug must be [a-z0-9-]{2,40}' } };
  }

  const res = await pool.query(
    `insert into workspace_skill (slug, body, proposed_by)
     values ($1, $2, $3)
     on conflict (slug) do update set body = excluded.body, proposed_by = excluded.proposed_by,
       proposed_at = now(), approved_by = null, approved_at = null, disabled_at = null
     returning slug, body, proposed_by as "proposedBy", proposed_at as "proposedAt",
       approved_by as "approvedBy", approved_at as "approvedAt", disabled_at as "disabledAt"`,
    [input.slug, input.body, input.proposedBy],
  );

  const skill = res.rows[0] as WorkspaceSkill;

  emitEvent({
    type: 'skill.proposed',
    skill,
    channelId: input.channelId,
  });

  return { ok: skill };
}

export async function approveSkill(
  pool: Pool,
  input: { slug: string; approvedBy: string },
): Promise<{ ok: WorkspaceSkill } | { error: { code: string; message: string } }> {
  const res = await pool.query(
    `update workspace_skill set approved_by = $2, approved_at = now()
     where slug = $1 and approved_at is null
     returning slug, body, proposed_by as "proposedBy", proposed_at as "proposedAt",
       approved_by as "approvedBy", approved_at as "approvedAt", disabled_at as "disabledAt"`,
    [input.slug, input.approvedBy],
  );

  if (!res.rowCount) {
    const existing = await pool.query(
      `select slug from workspace_skill where slug = $1`,
      [input.slug],
    );
    if (!existing.rowCount) {
      return { error: { code: 'not_found', message: 'skill not found' } };
    }
    return { error: { code: 'already_approved', message: 'skill already approved' } };
  }

  const skill = res.rows[0] as WorkspaceSkill;

  emitEvent({ type: 'skill.approved', skill });

  return { ok: skill };
}

export async function disableSkill(
  pool: Pool,
  input: { slug: string; disabledBy: string },
): Promise<{ ok: WorkspaceSkill } | { error: { code: string; message: string } }> {
  const res = await pool.query(
    `update workspace_skill set disabled_at = now()
     where slug = $1 and disabled_at is null
     returning slug, body, proposed_by as "proposedBy", proposed_at as "proposedAt",
       approved_by as "approvedBy", approved_at as "approvedAt", disabled_at as "disabledAt"`,
    [input.slug],
  );

  if (!res.rowCount) {
    const existing = await pool.query(
      `select slug, disabled_at as "disabledAt" from workspace_skill where slug = $1`,
      [input.slug],
    );
    if (!existing.rowCount) {
      return { error: { code: 'not_found', message: 'skill not found' } };
    }
    if (existing.rows[0].disabledAt) {
      return { error: { code: 'already_disabled', message: 'skill already disabled' } };
    }
    return { error: { code: 'not_approved', message: 'cannot disable unapproved skill' } };
  }

  const skill = res.rows[0] as WorkspaceSkill;

  emitEvent({ type: 'skill.disabled', skill });

  return { ok: skill };
}

export async function listSkills(
  pool: Pool,
  options: { approved?: boolean },
): Promise<WorkspaceSkill[]> {
  let query = `select slug, body, proposed_by as "proposedBy", proposed_at as "proposedAt",
    approved_by as "approvedBy", approved_at as "approvedAt", disabled_at as "disabledAt"
    from workspace_skill`;

  const params: unknown[] = [];
  if (options.approved) {
    query += ` where approved_at is not null and disabled_at is null`;
  }

  query += ` order by approved_at desc, proposed_at desc`;

  const res = await pool.query(query, params);
  return res.rows as WorkspaceSkill[];
}

export async function getSkill(
  pool: Pool,
  slug: string,
): Promise<WorkspaceSkill | null> {
  const res = await pool.query(
    `select slug, body, proposed_by as "proposedBy", proposed_at as "proposedAt",
      approved_by as "approvedBy", approved_at as "approvedAt", disabled_at as "disabledAt"
     from workspace_skill where slug = $1`,
    [slug],
  );
  if (!res.rowCount) return null;
  return res.rows[0] as WorkspaceSkill;
}