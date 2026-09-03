import type { Pool } from 'pg';
import { emitEvent } from '../events.js';
import { postMessage } from './messages.js';

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

const RETURNING = `returning slug, body, proposed_by as "proposedBy", proposed_at as "proposedAt",
  approved_by as "approvedBy", approved_at as "approvedAt", disabled_at as "disabledAt"`;

/**
 * 에이전트가 스킬을 제안한다(#140). **제안만** 한다 — 승인은 admin 의 일이다.
 *
 * 같은 slug 를 다시 제안하면 본문을 덮고 **승인 상태를 버린다**(`approved_*` 를 null 로).
 * 승인된 스킬은 모두의 시스템 프롬프트가 되므로, 본문이 바뀌었는데 승인 도장이 남아 있으면
 * 사람이 읽어 본 적 없는 문장이 승인된 것으로 통한다 — 스킬은 가장 레버리지가 큰
 * 프롬프트 인젝션 표면이다. `disabled_at` 도 함께 비운다: 재제안은 새 제안이다.
 *
 * 채널 알림은 **여기서 await 로 남긴다.** 이벤트 리스너로 미루면 도구가 알림보다 먼저
 * 반환하고, 알림 실패는 아무도 보지 못하는 rejection 이 된다. 승인 게이트의 값은 사람이
 * 제안을 본다는 것 하나에 있으므로, 알림이 실패하면 제안도 실패해야 한다(호출자가 재시도한다 —
 * upsert 라 재시도는 같은 행을 덮는다).
 */
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
     ${RETURNING}`,
    [input.slug, input.body, input.proposedBy],
  );

  const skill = res.rows[0] as WorkspaceSkill;

  // 제안한 에이전트를 author 로 둔다 — 누가 제안했는지가 승인 판단의 절반이다.
  // kind='system' 이라 대화 발화로 세지 않는다.
  //
  // `meta.skillSlug` 는 **화면이 이 알림에서 승인 절로 가는 버튼을 그리는 표시**다(#311).
  // 본문 글자를 정규식으로 더듬게 두면 문구를 한 글자 다듬는 순간 그 진입점이 조용히
  // 사라진다 — 어느 스킬인지는 데이터로 남긴다.
  await postMessage(pool, {
    channelId: input.channelId,
    authorId: skill.proposedBy,
    body: `스킬이 제안되었습니다: **${skill.slug}** — 승인을 기다리고 있습니다.`,
    kind: 'system',
    meta: { skillSlug: skill.slug },
  });

  emitEvent({ type: 'skill.proposed', skill, channelId: input.channelId });

  return { ok: skill };
}

/** 승인(#140). **admin 전용** — 라우트가 `requireAdmin` 으로 막는다. */
export async function approveSkill(
  pool: Pool,
  input: { slug: string; approvedBy: string },
): Promise<{ ok: WorkspaceSkill } | { error: { code: string; message: string } }> {
  const res = await pool.query(
    `update workspace_skill set approved_by = $2, approved_at = now()
     where slug = $1 and approved_at is null
     ${RETURNING}`,
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

/**
 * 비활성(#140). **admin 전용.** 거부와 비활성이 같은 경로다 — 미승인 스킬을 비활성하면
 * 그것이 거부이고, 승인된 스킬을 비활성하면 러너가 다음 턴에 파일과 링크를 지운다.
 * 행은 남긴다(누가 무엇을 제안했는지가 기록이다).
 */
export async function disableSkill(
  pool: Pool,
  input: { slug: string },
): Promise<{ ok: WorkspaceSkill } | { error: { code: string; message: string } }> {
  const res = await pool.query(
    `update workspace_skill set disabled_at = now()
     where slug = $1 and disabled_at is null
     ${RETURNING}`,
    [input.slug],
  );

  if (!res.rowCount) {
    const existing = await pool.query(
      `select slug from workspace_skill where slug = $1`,
      [input.slug],
    );
    if (!existing.rowCount) {
      return { error: { code: 'not_found', message: 'skill not found' } };
    }
    return { error: { code: 'already_disabled', message: 'skill already disabled' } };
  }

  const skill = res.rows[0] as WorkspaceSkill;

  emitEvent({ type: 'skill.disabled', skill });

  return { ok: skill };
}

/**
 * 스킬 목록. `approved: true` 는 러너가 턴마다 읽는 것 — 승인됐고 비활성되지 않은 것만이다.
 * 미승인 스킬이 여기 섞이면 승인 게이트가 없는 것과 같다.
 */
export async function listSkills(
  pool: Pool,
  options: { approved?: boolean },
): Promise<WorkspaceSkill[]> {
  let query = `select slug, body, proposed_by as "proposedBy", proposed_at as "proposedAt",
    approved_by as "approvedBy", approved_at as "approvedAt", disabled_at as "disabledAt"
    from workspace_skill`;

  if (options.approved) {
    query += ` where approved_at is not null and disabled_at is null`;
  }

  query += ` order by approved_at desc, proposed_at desc`;

  const res = await pool.query(query);
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
