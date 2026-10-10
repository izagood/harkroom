import type { Pool } from 'pg';
import { emitEvent } from '../events.js';
import { postMessage } from './messages.js';
import { systemI18n } from './systemI18n.js';

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
  /** 쓰기 검사(080)에 걸린 제안이면 그 시각과 이유 — 승인하는 사람이 보라고 남긴다. */
  flaggedAt: Date | null;
  flagReason: string | null;
}

const RETURNING = `returning slug, body, proposed_by as "proposedBy", proposed_at as "proposedAt",
  approved_by as "approvedBy", approved_at as "approvedAt", disabled_at as "disabledAt",
  flagged_at as "flaggedAt", flag_reason as "flagReason"`;

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
  input: { slug: string; body: string; proposedBy: string; channelId: string; flagReason?: string | null },
): Promise<{ ok: WorkspaceSkill } | { error: { code: string; message: string } }> {
  if (!isValidSkillSlug(input.slug)) {
    return { error: { code: 'invalid_slug', message: 'slug must be [a-z0-9-]{2,40}' } };
  }

  const res = await pool.query(
    `insert into workspace_skill (slug, body, proposed_by, flagged_at, flag_reason)
     values ($1, $2, $3, case when $4::text is null then null else now() end, $4::text)
     on conflict (slug) do update set body = excluded.body, proposed_by = excluded.proposed_by,
       proposed_at = now(), approved_by = null, approved_at = null, disabled_at = null,
       flagged_at = excluded.flagged_at, flag_reason = excluded.flag_reason
     ${RETURNING}`,
    [input.slug, input.body, input.proposedBy, input.flagReason ?? null],
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
    body: `스킬이 제안되었습니다: **${skill.slug}** — 승인을 기다리고 있습니다.`
      + (skill.flagReason ? `\n⚠️ 쓰기 검사에 걸렸습니다(${skill.flagReason}). 승인 전에 본문을 확인하세요.` : ''),
    kind: 'system',
    meta: {
      skillSlug: skill.slug,
      // 번역 표지(i18n P5) — 본문과 같은 갈래(쓰기 검사에 걸렸나).
      i18n: skill.flagReason
        ? systemI18n('system.skill.proposedFlagged', { slug: skill.slug, reason: skill.flagReason })
        : systemI18n('system.skill.proposed', { slug: skill.slug }),
    },
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
 * 스킬 목록. `state='approved'` 는 러너가 턴마다 읽는 것 — 승인됐고 비활성되지 않은 것만이다.
 * 미승인 스킬이 여기 섞이면 승인 게이트가 없는 것과 같다.
 * `state: null` 은 필터 없음 — 전부를 반환한다(#325).
 *
 * **`state` 는 옵셔널이 아니라 필수다.** 옵셔널이면 넘기는 것을 잊은 호출부가 조용히
 * "전부"를 받는다 — 승인 게이트를 읽는 쪽에서 그 실수는 미승인 스킬이 시스템 프롬프트에
 * 섞이는 일이다. 필수로 두면 타입 검사기가 그 호출부를 즉시 짚는다.
 */
export async function listSkills(
  pool: Pool,
  options: { state: 'pending' | 'approved' | 'disabled' | null },
): Promise<WorkspaceSkill[]> {
  let query = `select slug, body, proposed_by as "proposedBy", proposed_at as "proposedAt",
    approved_by as "approvedBy", approved_at as "approvedAt", disabled_at as "disabledAt",
  flagged_at as "flaggedAt", flag_reason as "flagReason"
    from workspace_skill`;

  if (options.state === 'pending') {
    query += ` where approved_at is null and disabled_at is null`;
  } else if (options.state === 'approved') {
    query += ` where approved_at is not null and disabled_at is null`;
  } else if (options.state === 'disabled') {
    query += ` where disabled_at is not null`;
  }

  query += ` order by approved_at desc, proposed_at desc`;

  const res = await pool.query(query);
  return res.rows as WorkspaceSkill[];
}

/** 승인한 지 이만큼 지나지 않은 스킬은 후보로 보지 않는다 — 새 스킬은 쓰일 기회가 아직 없었다. */
export const SKILL_STALE_MIN_AGE_DAYS = 14;
/** 이 기간 동안 한 번도 안 쓰였으면 "안 쓰는 후보"다(Hermes Curator 의 결정적 단계와 같은 값). */
export const SKILL_STALE_UNUSED_DAYS = 30;
/** 한 번에 받는 slug 상한. 한 턴에 부르는 스킬은 몇 개뿐이다 — 넘는 것은 버린다. */
export const SKILL_USE_MAX_SLUGS = 20;

export interface SkillUsage {
  /** 지금까지 기록된 사용 횟수(턴 단위). 기록이 없으면 0. */
  useCount: number;
  lastUsedAt: Date | null;
  /**
   * 안 쓰는 후보(D3): 승인·활성이고, 승인한 지 `SKILL_STALE_MIN_AGE_DAYS` 일이 지났고,
   * 최근 `SKILL_STALE_UNUSED_DAYS` 일 동안 기록된 사용이 없다. **후보일 뿐이다** — 끄는 것은
   * 사람이다. 사용은 claude 하네스만 센다(codex·opencode 는 기록이 없다).
   */
  staleCandidate: boolean;
}

/**
 * 한 에이전트가 이번 턴에 부른 스킬을 기록한다(D3). **승인·활성 스킬만** 남긴다 — 하네스의
 * `Skill` 도구는 워크스페이스 스킬 말고도 하네스 자체·플러그인 스킬(`artifact-design`,
 * `plugin:x`)을 부르므로, 모르는 slug 는 조용히 버린다. 같은 턴에 같은 스킬을 여러 번 불러도
 * 한 번으로 센다(턴 단위 사용). 돌려주는 값은 실제로 남긴 slug 다.
 */
export async function recordSkillUse(
  pool: Pool,
  input: { accountId: string; slugs: string[] },
): Promise<string[]> {
  const slugs = [...new Set(input.slugs.filter(isValidSkillSlug))].slice(0, SKILL_USE_MAX_SLUGS);
  if (slugs.length === 0) return [];
  const res = await pool.query<{ slug: string }>(
    `insert into workspace_skill_usage (slug, account_id)
     select s.slug, $2 from workspace_skill s
     where s.slug = any($1::text[]) and s.approved_at is not null and s.disabled_at is null
     returning slug`,
    [slugs, input.accountId],
  );
  return res.rows.map((r) => r.slug);
}

/**
 * 스킬별 사용 통계(D3). `listSkills` 와 **따로 묻는다** — 스킬 행의 열 목록은 승인 게이트가
 * 읽는 자리라, 통계 때문에 그 질의를 넓히지 않는다. 행이 없는 스킬은 맵에 없다(호출자가
 * `skillUsageOf` 로 0/null 을 채운다).
 *
 * 후보 판정을 SQL 의 now() 로 하는 이유: 앱·러너의 시계가 아니라 기록을 찍은 시계(DB)와 같은
 * 시계로 재야 경계에서 갈라지지 않는다.
 */
export async function listSkillUsage(pool: Pool): Promise<Map<string, SkillUsage>> {
  const res = await pool.query<{ slug: string; useCount: number; lastUsedAt: Date | null; staleCandidate: boolean }>(
    `select s.slug, coalesce(u.use_count, 0)::int as "useCount", u.last_used_at as "lastUsedAt",
       (s.approved_at is not null and s.disabled_at is null
         and s.approved_at <= now() - make_interval(days => $1::int)
         and (u.last_used_at is null or u.last_used_at <= now() - make_interval(days => $2::int)))
         as "staleCandidate"
     from workspace_skill s
     left join (
       select slug, count(*) as use_count, max(used_at) as last_used_at
       from workspace_skill_usage group by slug
     ) u on u.slug = s.slug`,
    [SKILL_STALE_MIN_AGE_DAYS, SKILL_STALE_UNUSED_DAYS],
  );
  return new Map(res.rows.map((r) => [r.slug, { useCount: r.useCount, lastUsedAt: r.lastUsedAt, staleCandidate: r.staleCandidate }]));
}

/** 응답에 실을 꼴. 통계 행이 없으면 "기록 없음"(0·null·후보 아님)이다. */
export function skillUsageOf(usage: Map<string, SkillUsage>, slug: string): {
  useCount: number; lastUsedAt: string | null; staleCandidate: boolean;
} {
  const u = usage.get(slug);
  return { useCount: u?.useCount ?? 0, lastUsedAt: u?.lastUsedAt?.toISOString() ?? null, staleCandidate: u?.staleCandidate ?? false };
}

export async function getSkill(
  pool: Pool,
  slug: string,
): Promise<WorkspaceSkill | null> {
  const res = await pool.query(
    `select slug, body, proposed_by as "proposedBy", proposed_at as "proposedAt",
      approved_by as "approvedBy", approved_at as "approvedAt", disabled_at as "disabledAt",
  flagged_at as "flaggedAt", flag_reason as "flagReason"
     from workspace_skill where slug = $1`,
    [slug],
  );
  if (!res.rowCount) return null;
  return res.rows[0] as WorkspaceSkill;
}
