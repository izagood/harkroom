import { randomUUID } from 'node:crypto';
import type { Pool, PoolClient } from 'pg';
import { z } from 'zod';
import type { AutomationRunView, AutomationSchedule, AutomationTrigger, AutomationView } from '@harkroom/shared';
import { postMessage } from './messages.js';
import { getMentionPolicy } from './mentionPolicy.js';
import { channelPostGate } from './channels.js';

/**
 * 자동화(마이그레이션 064). 트리거가 **회차(run)를 만들고**, 발송 단계가 그 회차를
 * 만든 사람 이름의 글로 내보낸다. 두 단계로 나눈 이유는 `automation_run` 주석에 있다 —
 * 발송 중에 죽어도 `pending` 이 남아 이어 보낸다.
 */

export const SWEEP_INTERVAL_MS = 15_000;
export const SWEEP_BATCH_SIZE = 20;
/**
 * 한 자동화가 한 시간에 만들 수 있는 회차. 넘으면 **일시정지**한다. 반복 작업은 한 번
 * 어긋나면 조용히 수십 번 돈다(에이전트가 머지한 것이 다시 머지 트리거를 부르는 식) —
 * 사람이 알아채기 전에 멈추는 것이 이 상한의 몫이다.
 */
export const RATE_LIMIT_PER_HOUR = 20;
/** 이보다 오래 `pending` 인 회차는 보내지 않고 실패로 닫는다 — 한참 늦은 "지금 해 줘"는 틀린 요청이다. */
export const PENDING_EXPIRY_MS = 60 * 60 * 1000;
/**
 * 에이전트가 돌리는 "지금 한 번"(082)의 상한 — 같은 자동화에 10분 1회·시간 3회. 넘으면 **거절만**
 * 한다. 시간당 상한(`RATE_LIMIT_PER_HOUR`)처럼 일시정지하면 에이전트의 되풀이 호출이 사람의
 * 자동화를 꺼 버린다.
 */
export const AGENT_RUN_MIN_GAP_MS = 10 * 60 * 1000;
export const AGENT_RUNS_PER_HOUR = 3;
/** `automation.list` 가 주는 본문 앞부분 — 무엇을 돌리는지 고를 만큼만. */
export const AGENT_LIST_BODY_CHARS = 200;

const HHMM = /^([01]\d|2[0-3]):[0-5]\d$/;

function isTimeZone(tz: string): boolean {
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}

const tzSchema = z.string().min(1).max(64).refine(isTimeZone, 'unknown time zone');

const scheduleSchema = z.discriminatedUnion('freq', [
  z.object({ kind: z.literal('schedule'), freq: z.literal('daily'), time: z.string().regex(HHMM), tz: tzSchema }),
  z.object({
    kind: z.literal('schedule'), freq: z.literal('weekly'),
    weekdays: z.array(z.number().int().min(0).max(6)).min(1).max(7)
      .transform((d) => [...new Set(d)].sort((a, b) => a - b)),
    time: z.string().regex(HHMM), tz: tzSchema,
  }),
  z.object({
    kind: z.literal('schedule'), freq: z.literal('monthly'),
    monthDay: z.number().int().min(1).max(31), time: z.string().regex(HHMM), tz: tzSchema,
  }),
]);

const githubSchema = z.object({
  kind: z.literal('github'),
  repo: z.string().regex(/^[\w.-]+\/[\w.-]+$/, 'owner/name'),
  event: z.enum(['push', 'pull_request.merged', 'release.published', 'workflow_run.completed']),
  branch: z.string().min(1).max(200).optional(),
  paths: z.array(z.string().min(1).max(300)).max(20).optional(),
  change: z.enum(['any', 'added', 'modified', 'removed']).optional(),
});

/**
 * 트리거는 `kind` 로 먼저 가르고, schedule 은 그 안에서 `freq` 로 또 가른다. zod 의
 * discriminatedUnion 은 한 칸만 보므로 바깥은 일반 union 이다.
 */
export const triggerSchema: z.ZodType<AutomationTrigger> = z.union([
  scheduleSchema, githubSchema, z.object({ kind: z.literal('webhook') }),
]) as unknown as z.ZodType<AutomationTrigger>;

// ── 시간 계산 ──────────────────────────────────────────────────────────────
//
// 의존성 없이 `Intl` 로 tz 벽시계를 푼다. 서버는 UTC 로 돌고 사람은 "월요일 9시(서울)"를
// 말하므로, 저장은 규칙 그대로 두고 **다음 회차만** 절대 시각으로 계산해 둔다.

interface WallClock { y: number; m: number; d: number; h: number; mi: number }

function wallClock(at: Date, tz: string): WallClock {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: tz, hourCycle: 'h23',
    year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit',
  }).formatToParts(at);
  const get = (t: string) => Number(parts.find((p) => p.type === t)!.value);
  return { y: get('year'), m: get('month'), d: get('day'), h: get('hour'), mi: get('minute') };
}

function offsetMs(at: Date, tz: string): number {
  const w = wallClock(at, tz);
  const asUtc = Date.UTC(w.y, w.m - 1, w.d, w.h, w.mi);
  return asUtc - Math.floor(at.getTime() / 60_000) * 60_000;
}

/**
 * tz 의 벽시계 → 절대 시각. 오프셋을 두 번 구하는 이유: 처음 추정한 시각과 실제 시각이
 * DST 경계 양쪽에 걸리면 첫 오프셋이 틀린다. 두 번째 것으로 고치면 된다. 봄에 건너뛰는
 * 시각(존재하지 않는 02:30)은 그 뒤 시각으로 밀린다.
 */
export function zonedToUtc(w: WallClock, tz: string): Date {
  const guess = Date.UTC(w.y, w.m - 1, w.d, w.h, w.mi);
  const o1 = offsetMs(new Date(guess), tz);
  let t = guess - o1;
  const o2 = offsetMs(new Date(t), tz);
  if (o2 !== o1) t = guess - o2;
  return new Date(t);
}

function daysInMonth(y: number, m: number): number {
  return new Date(Date.UTC(y, m, 0)).getUTCDate();
}

/** `after` 보다 **뒤의** 첫 회차. 규칙이 400일 안에 한 번도 맞지 않으면 null(그럴 수 없지만 무한 루프는 막는다). */
export function nextOccurrence(trigger: AutomationSchedule, after: Date): Date | null {
  const [hh, mm] = trigger.time.split(':').map(Number) as [number, number];
  const start = wallClock(after, trigger.tz);
  for (let i = 0; i <= 400; i++) {
    const day = new Date(Date.UTC(start.y, start.m - 1, start.d + i));
    const y = day.getUTCFullYear();
    const m = day.getUTCMonth() + 1;
    const d = day.getUTCDate();
    let match = false;
    if (trigger.freq === 'daily') match = true;
    else if (trigger.freq === 'weekly') match = trigger.weekdays.includes(day.getUTCDay());
    else match = d === Math.min(trigger.monthDay, daysInMonth(y, m));
    if (!match) continue;
    const at = zonedToUtc({ y, m, d, h: hh, mi: mm }, trigger.tz);
    if (at.getTime() > after.getTime()) return at;
  }
  return null;
}

// ── 템플릿 ────────────────────────────────────────────────────────────────

const pad = (n: number) => String(n).padStart(2, '0');

/**
 * 시간 변수. "지난주"를 에이전트가 턴 시각으로 추측하게 두지 않고 **글에 날짜를 박는다** —
 * 월요일 새벽에 밀린 회차가 화요일에 나가도 가리키는 주가 같다.
 */
export function timeVars(firedFor: Date, tz: string): Record<string, string> {
  const w = wallClock(firedFor, tz);
  const base = Date.UTC(w.y, w.m - 1, w.d);
  const dow = new Date(base).getUTCDay();
  const day = (offset: number) => new Date(base + offset * 86_400_000);
  const ymd = (x: Date) => `${x.getUTCFullYear()}-${pad(x.getUTCMonth() + 1)}-${pad(x.getUTCDate())}`;
  // 주는 월요일에 시작한다(회사 달력). 지난주 = 이번 주 월요일 7일 전 ~ 그 일요일.
  const sinceMonday = (dow + 6) % 7;
  const lastMon = day(-sinceMonday - 7);
  const lastSun = day(-sinceMonday - 1);
  return {
    date: ymd(day(0)),
    yesterday: ymd(day(-1)),
    'lastWeek.start': ymd(lastMon),
    'lastWeek.end': ymd(lastSun),
    lastWeek: `${ymd(lastMon)} ~ ${ymd(lastSun)}`,
  };
}

/** `{{name}}` 치환. 모르는 이름은 **그대로 둔다** — 지우면 오타가 조용히 빈 글이 된다. */
export function renderBody(template: string, vars: Record<string, string>): string {
  return template.replace(/\{\{\s*([\w.]+)\s*\}\}/g, (whole, name: string) =>
    Object.prototype.hasOwnProperty.call(vars, name) ? vars[name]! : whole);
}

// ── 저장소 ────────────────────────────────────────────────────────────────

const COLS = `id, owner_id as "ownerId", channel_id as "channelId", name, body, trigger,
  enabled, next_at as "nextAt", paused_reason as "pausedReason",
  consecutive_failures as "consecutiveFailures", ingress_enabled_at as "ingressEnabledAt",
  debounce_sec as "debounceSec", proposed_by as "proposedBy", approved_at as "approvedAt", created_at as "createdAt", updated_at as "updatedAt"`;

const RUN_COLS = `id, automation_id as "automationId", event_key as "eventKey",
  trigger_kind as "triggerKind", status, message_id as "messageId", error,
  created_at as "createdAt", finished_at as "finishedAt",
  initiated_by as "initiatedBy", cause_message_id as "causeMessageId"`;

function initialNextAt(trigger: AutomationTrigger, now: Date): Date | null {
  return trigger.kind === 'schedule' ? nextOccurrence(trigger, now) : null;
}

export async function createAutomation(pool: Pool, input: {
  ownerId: string; channelId: string; name: string; body: string;
  trigger: AutomationTrigger; debounceSec?: number | null; now?: Date;
}): Promise<AutomationView> {
  const nextAt = initialNextAt(input.trigger, input.now ?? new Date());
  const res = await pool.query(
    `insert into automation (owner_id, channel_id, name, body, trigger, next_at, debounce_sec)
     values ($1, $2, $3, $4, $5, $6, $7) returning ${COLS}`,
    [input.ownerId, input.channelId, input.name, input.body, JSON.stringify(input.trigger), nextAt?.toISOString() ?? null,
      input.debounceSec ?? null],
  );
  return res.rows[0];
}

/**
 * 에이전트의 제안(072). `enabled=false`·`approved_at=null` 로 들어가 시계도 입구도 돌지 않는다.
 * 소유자는 **승인할 사람**이다 — 승인하면 글이 그 사람 이름으로 나간다.
 */
export async function proposeAutomation(pool: Pool, input: {
  ownerId: string; proposedBy: string; channelId: string; name: string; body: string;
  trigger: AutomationTrigger; debounceSec?: number | null;
}): Promise<AutomationView> {
  const res = await pool.query(
    `insert into automation (owner_id, proposed_by, approved_at, enabled, channel_id, name, body, trigger, debounce_sec)
     values ($1, $2, null, false, $3, $4, $5, $6, $7) returning ${COLS}`,
    [input.ownerId, input.proposedBy, input.channelId, input.name, input.body, JSON.stringify(input.trigger),
      input.debounceSec ?? null],
  );
  return res.rows[0];
}

/** 제안 승인. 켜고 다음 회차를 잡는다. 이미 승인된 것은 false. */
export async function approveAutomation(pool: Pool, id: string, ownerId: string, now = new Date()): Promise<AutomationView | null> {
  const cur = await getAutomation(pool, id, ownerId);
  if (!cur || cur.approvedAt) return null;
  const nextAt = initialNextAt(cur.trigger, now);
  const res = await pool.query(
    `update automation set approved_at = now(), enabled = true, next_at = $3, updated_at = now()
     where id = $1 and owner_id = $2 and approved_at is null and deleted_at is null returning ${COLS}`,
    [id, ownerId, nextAt?.toISOString() ?? null],
  );
  return res.rows[0] ?? null;
}

/** 만든 사람 것만 보인다 — 예약 메시지(#222)와 같은 이유로, 소유자 조건을 호출부로 올리지 않는다. */
export async function listAutomations(pool: Pool, ownerId: string): Promise<AutomationView[]> {
  const res = await pool.query(
    `select ${COLS} from automation where owner_id = $1 and deleted_at is null order by created_at`,
    [ownerId],
  );
  return res.rows;
}

export async function getAutomation(pool: Pool, id: string, ownerId: string): Promise<AutomationView | null> {
  const res = await pool.query(
    `select ${COLS} from automation where id = $1 and owner_id = $2 and deleted_at is null`,
    [id, ownerId],
  );
  return res.rows[0] ?? null;
}

/**
 * 수정. 트리거가 바뀌거나 **다시 켜지면** 다음 회차를 지금 기준으로 새로 잡는다 — 꺼져 있던
 * 동안의 회차를 몰아서 보내지 않는다. 다시 켜면 자동 일시정지 사유와 실패 횟수도 비운다.
 */
export async function updateAutomation(pool: Pool, id: string, ownerId: string, patch: {
  name?: string; body?: string; channelId?: string; trigger?: AutomationTrigger; enabled?: boolean;
  /** `null` 은 끈다. `undefined` 는 그대로 둔다. */
  debounceSec?: number | null;
  now?: Date;
}): Promise<AutomationView | null> {
  const cur = await getAutomation(pool, id, ownerId);
  if (!cur) return null;
  const trigger = patch.trigger ?? cur.trigger;
  const enabled = patch.enabled ?? cur.enabled;
  const reschedule = patch.trigger !== undefined || (patch.enabled === true && !cur.enabled);
  const nextAt = reschedule ? initialNextAt(trigger, patch.now ?? new Date()) : null;
  const res = await pool.query(
    `update automation set
       name = coalesce($3, name), body = coalesce($4, body), channel_id = coalesce($5, channel_id),
       trigger = $6, enabled = $7,
       next_at = case when $8 then $9::timestamptz else next_at end,
       paused_reason = case when $10 then null else paused_reason end,
       consecutive_failures = case when $10 then 0 else consecutive_failures end,
       -- 시간 트리거로 바뀌면 외부 입구를 닫는다(065). 열어 두면 범용 hook 이 schedule 을 두드린다.
       ingress_enabled_at = case when $6::jsonb->>'kind' = 'schedule' then null else ingress_enabled_at end,
       ingress_token_hash = case when $6::jsonb->>'kind' = 'schedule' then null else ingress_token_hash end,
       ingress_secret_enc = case when $6::jsonb->>'kind' = 'schedule' then null else ingress_secret_enc end,
       debounce_sec = case when $11 then $12::int else debounce_sec end,
       updated_at = now()
     where id = $1 and owner_id = $2 and deleted_at is null
     returning ${COLS}`,
    [id, ownerId, patch.name ?? null, patch.body ?? null, patch.channelId ?? null,
      JSON.stringify(trigger), enabled, reschedule, nextAt?.toISOString() ?? null,
      patch.enabled === true, patch.debounceSec !== undefined, patch.debounceSec ?? null],
  );
  return res.rows[0] ?? null;
}

/** 지우지 않고 `deleted_at` 을 찍는다 — 회차 기록(무엇이 언제 나갔나)은 남긴다. */
export async function deleteAutomation(pool: Pool, id: string, ownerId: string): Promise<boolean> {
  const res = await pool.query(
    `update automation set deleted_at = now(), enabled = false, next_at = null
     where id = $1 and owner_id = $2 and deleted_at is null returning id`,
    [id, ownerId],
  );
  return (res.rowCount ?? 0) > 0;
}

export async function listRuns(pool: Pool, automationId: string, limit = 50): Promise<AutomationRunView[]> {
  const res = await pool.query(
    `select ${RUN_COLS} from automation_run where automation_id = $1 order by created_at desc limit $2`,
    [automationId, limit],
  );
  return res.rows;
}

// ── 회차 만들기 ────────────────────────────────────────────────────────────

export type EnqueueResult =
  | { status: 'queued'; run: AutomationRunView }
  /** 디바운스(071): 모으는 중인 회차에 붙었다. 새 회차는 없다. */
  | { status: 'merged'; run: AutomationRunView }
  | { status: 'duplicate' }
  | { status: 'rate_limited' }
  | { status: 'inactive' };

/**
 * 트리거가 부르는 단 하나의 입구. 중복(`event_key`)과 속도 상한을 **여기서만** 본다 —
 * 트리거마다 따로 보면 새 트리거가 하나를 빠뜨린다.
 *
 * `vars` 는 본문 치환에 쓸 값이다. 회차에 저장해 두므로 발송이 재시도돼도 같은 글이 나간다.
 */
export async function enqueueRun(db: Pool | PoolClient, input: {
  automationId: string; eventKey: string; triggerKind: string; vars: Record<string, string>;
  /** 사람이 "지금 한 번" 누른 것은 꺼진 자동화도 돌린다(시험용이다). */
  ignoreEnabled?: boolean;
  /** 에이전트가 돌린 회차(082): 실행한 에이전트·그 턴의 원인·물려줄 연쇄 깊이. */
  initiatedBy?: string | null;
  causeMessageId?: string | null;
  chainDepth?: number | null;
}): Promise<EnqueueResult> {
  const a = await db.query<{ enabled: boolean; debounce_sec: number | null }>(
    `select enabled, debounce_sec from automation where id = $1 and deleted_at is null`, [input.automationId],
  );
  const row = a.rows[0];
  if (!row || (!row.enabled && !input.ignoreEnabled)) return { status: 'inactive' };

  // 디바운스(071). 사람이 누른 "지금 한 번"과 schedule 은 모으지 않는다 — 기다리게 할 이유가 없다.
  if (row.debounce_sec && input.triggerKind !== 'manual' && input.triggerKind !== 'schedule') {
    const merged = await mergeIntoGathering(db, input);
    if (merged) return merged;
  }

  const recent = await db.query<{ n: number }>(
    `select count(*)::int as n from automation_run
     where automation_id = $1 and created_at > now() - interval '1 hour'`,
    [input.automationId],
  );
  if (recent.rows[0]!.n >= RATE_LIMIT_PER_HOUR) {
    await db.query(
      `update automation set enabled = false, paused_reason = 'rate_limited', next_at = null, updated_at = now()
       where id = $1`,
      [input.automationId],
    );
    return { status: 'rate_limited' };
  }

  const ins = await db.query(
    `insert into automation_run (automation_id, event_key, trigger_kind, payload, not_before,
                                 initiated_by, cause_message_id, chain_depth)
     values ($1, $2, $3, $4, $5, $6, $7, $8)
     on conflict (automation_id, event_key) do nothing
     returning ${RUN_COLS}`,
    [input.automationId, input.eventKey, input.triggerKind,
      JSON.stringify({ vars: input.vars, events: [{ key: input.eventKey, summary: eventSummary(input.vars, input.eventKey) }] }),
      row.debounce_sec && input.triggerKind !== 'manual' && input.triggerKind !== 'schedule'
        ? new Date(Date.now() + row.debounce_sec * 1000).toISOString() : null,
      input.initiatedBy ?? null, input.causeMessageId ?? null, input.chainDepth ?? null],
  );
  if (!ins.rows[0]) return { status: 'duplicate' };
  return { status: 'queued', run: ins.rows[0] };
}

/**
 * "지금 한 번" — 사람 버튼(`POST /automations/:id/run`)과 에이전트 도구(`automation.run`)가 **함께**
 * 부르는 입구. 꺼진 자동화도 돌린다(켜기 전에 본문이 어떻게 나가는지 보는 것이 쓸모다).
 * 회차로만 만들고 발송은 sweeper 가 한다.
 */
export async function runAutomationNow(
  db: Pool | PoolClient,
  automation: Pick<AutomationView, 'id' | 'trigger'>,
  by: { initiatedBy: string; causeMessageId: string; chainDepth: number } | null = null,
): Promise<EnqueueResult> {
  const vars = automation.trigger.kind === 'schedule' ? timeVars(new Date(), automation.trigger.tz) : {};
  return enqueueRun(db, {
    automationId: automation.id, eventKey: `manual:${randomUUID()}`, triggerKind: 'manual', vars, ignoreEnabled: true,
    ...(by ?? {}),
  });
}

// ── 에이전트가 돌리는 "지금 한 번"(082) ─────────────────────────────────────

export type AgentRunRefusal =
  | 'no_cause' | 'cause_not_human' | 'automation_reentry'
  | 'not_found' | 'not_approved' | 'agent_quota' | 'chain_capped' | 'rate_limited' | 'duplicate' | 'inactive';

/**
 * 에이전트가 돌린 회차의 연쇄 깊이. 원인이 사람(소유자)의 글이므로 이 에이전트의 발화는 사슬의
 * 첫 고리(`causeDepth` 의 사람 → 1)이고, 자동화 글은 그 발화를 대신하므로 같은 자리에 선다.
 */
const AGENT_RUN_CHAIN_DEPTH = 1;

/**
 * 이 턴을 **소유자가 시켰나.** 권한의 전부가 이 판정이다(jaebin 결정 2026-10-01):
 * 원인 메시지(`CAUSE_HEADER`)를 쓴 사람의 자동화만 돌릴 수 있다.
 *
 * - 헤더는 에이전트 쪽에서 오는 값이라 **그대로 믿지 않는다** — `causeDepth`(messages.ts)와 같이,
 *   그 메시지가 이 에이전트에게 실제로 inbox 를 만들었는지 본다. 아니면 아무 사람 메시지 id 를
 *   대서 남의 자동화를 돌릴 수 있다.
 * - 원인이 에이전트면 거절한다(#task 경유 위임 포함). 사람이 직접 부른 턴만이다.
 * - 원인이 **자동화가 낸 글**이면 거절한다. 그 글의 작성자는 소유자라 위 조건을 통과하므로,
 *   따로 막지 않으면 "자동화 → 에이전트 → 다시 실행" 고리가 돈다.
 */
async function agentRunOwner(
  db: Pool | PoolClient, agentId: string, causeMessageId: string | null,
): Promise<{ ownerId: string } | { refused: AgentRunRefusal }> {
  if (!causeMessageId) return { refused: 'no_cause' };
  const row = (await db.query<{ author_id: string; author_is_agent: boolean; from_automation: boolean }>(
    `select m.author_id, (a.kind = 'agent') as author_is_agent, (m.meta ? 'automation') as from_automation
       from message m join account a on a.id = m.author_id
      where m.id = $1 and m.deleted_at is null
        and exists (select 1 from inbox i
                     where i.message_id = m.id and i.account_id = $2
                       and i.reason in ('mention', 'dm', 'team_mention', 'team_delegated', 'thread_reply', 'ask_answered'))`,
    [causeMessageId, agentId],
  )).rows[0];
  if (!row) return { refused: 'no_cause' };
  if (row.author_is_agent) return { refused: 'cause_not_human' };
  if (row.from_automation) return { refused: 'automation_reentry' };
  return { ownerId: row.author_id };
}

export interface AgentAutomationItem {
  id: string; name: string; channelId: string; enabled: boolean; pausedReason: string | null;
  trigger: AutomationTrigger; bodyPreview: string;
  lastRun: { status: string; createdAt: string } | null;
}

/** `automation.list` — 이 턴을 시킨 소유자의 **승인된** 자동화. 돌릴 수 없는 것은 보이지 않는다. */
export async function listAutomationsForAgent(
  pool: Pool, input: { agentId: string; causeMessageId: string | null },
): Promise<{ ownerId: string; automations: AgentAutomationItem[] } | { refused: AgentRunRefusal }> {
  const who = await agentRunOwner(pool, input.agentId, input.causeMessageId);
  if ('refused' in who) return who;
  const res = await pool.query<{
    id: string; name: string; channelId: string; enabled: boolean; pausedReason: string | null;
    trigger: AutomationTrigger; body: string; lastStatus: string | null; lastAt: Date | null;
  }>(
    `select a.id, a.name, a.channel_id as "channelId", a.enabled, a.paused_reason as "pausedReason", a.trigger, a.body,
            r.status as "lastStatus", r.created_at as "lastAt"
       from automation a
       left join lateral (select status, created_at from automation_run
                           where automation_id = a.id order by created_at desc limit 1) r on true
      where a.owner_id = $1 and a.deleted_at is null and a.approved_at is not null
      order by a.created_at`,
    [who.ownerId],
  );
  return {
    ownerId: who.ownerId,
    automations: res.rows.map((r) => ({
      id: r.id, name: r.name, channelId: r.channelId, enabled: r.enabled, pausedReason: r.pausedReason,
      trigger: r.trigger,
      bodyPreview: r.body.length > AGENT_LIST_BODY_CHARS ? `${r.body.slice(0, AGENT_LIST_BODY_CHARS)}…` : r.body,
      lastRun: r.lastStatus && r.lastAt ? { status: r.lastStatus, createdAt: new Date(r.lastAt).toISOString() } : null,
    })),
  };
}

/**
 * `automation.run` — 에이전트가 돌리는 "지금 한 번". 버튼과 같은 회차(`runAutomationNow`)를 만들되
 * 실행자·원인·연쇄 깊이를 함께 적는다. 글은 여전히 **소유자 이름**으로 나간다(승인한 그 글이다).
 *
 * 상한 셈과 회차 넣기를 자동화 행 잠금 아래 한 트랜잭션에서 한다 — 동시에 두 번 불러도 둘 다
 * "아직 0회"를 보고 지나가지 못한다.
 */
export async function runAutomationForAgent(
  pool: Pool, input: { automationId: string; agentId: string; causeMessageId: string | null },
): Promise<{ status: 'queued'; run: AutomationRunView; automation: { id: string; name: string; channelId: string; ownerId: string } }
  | { refused: AgentRunRefusal }> {
  const who = await agentRunOwner(pool, input.agentId, input.causeMessageId);
  if ('refused' in who) return who;
  const automation = await getAutomation(pool, input.automationId, who.ownerId);
  if (!automation) return { refused: 'not_found' };
  if (!automation.approvedAt) return { refused: 'not_approved' };

  const { chainLimit } = await getMentionPolicy(pool);
  if (AGENT_RUN_CHAIN_DEPTH >= chainLimit) return { refused: 'chain_capped' };

  const client = await pool.connect();
  try {
    await client.query('begin');
    await client.query(`select 1 from automation where id = $1 for update`, [automation.id]);
    const recent = (await client.query<{ last: Date | null; n: number }>(
      `select max(created_at) as last, count(*)::int as n from automation_run
        where automation_id = $1 and initiated_by is not null and created_at > now() - interval '1 hour'`,
      [automation.id],
    )).rows[0]!;
    if (recent.n >= AGENT_RUNS_PER_HOUR
      || (recent.last && Date.now() - new Date(recent.last).getTime() < AGENT_RUN_MIN_GAP_MS)) {
      await client.query('rollback');
      return { refused: 'agent_quota' };
    }
    const result = await runAutomationNow(client, automation, {
      initiatedBy: input.agentId, causeMessageId: input.causeMessageId!, chainDepth: AGENT_RUN_CHAIN_DEPTH,
    });
    await client.query('commit');
    if (result.status !== 'queued') return { refused: result.status === 'merged' ? 'duplicate' : result.status };
    return {
      status: 'queued', run: result.run,
      automation: { id: automation.id, name: automation.name, channelId: automation.channelId, ownerId: automation.ownerId },
    };
  } catch (err) {
    await client.query('rollback').catch(() => {});
    throw err;
  } finally {
    client.release();
  }
}

/** 병합 목록의 한 줄. 사람이 알아볼 이름을 고르고, 없으면 이벤트 키로 둔다. 값은 이미 `neutralize` 를 지났다. */
export function eventSummary(vars: Record<string, string>, eventKey: string): string {
  const head = vars['pr.number'] ? `#${vars['pr.number']} ` : vars.sha ? `${vars.sha.slice(0, 7)} ` : '';
  const text = vars['pr.title'] ?? vars['commit.message'] ?? vars['release.tag'] ?? vars['workflow.name']
    ?? vars['payload.title'] ?? vars['payload.status'] ?? eventKey;
  return `${head}${text}`;
}

const MAX_MERGED_EVENTS = 50;

/**
 * 모으는 중인 회차(`pending` + `not_before` 가 아직 미래)가 있으면 이 이벤트를 거기 붙인다.
 * 없으면 null — 호출부가 새 회차를 연다(그 회차가 다음 모으기의 그릇이 된다).
 *
 * 두 이벤트가 동시에 와서 둘 다 "그릇 없음"을 보면 회차가 둘 생긴다. 막으려고 automation 행을
 * `for update` 로 잡는다 — 풀이면 트랜잭션을 열어야 락이 산다.
 */
async function mergeIntoGathering(
  db: Pool | PoolClient,
  input: { automationId: string; eventKey: string; vars: Record<string, string> },
): Promise<EnqueueResult | null> {
  const isPool = 'totalCount' in db;
  const client: PoolClient = isPool ? await (db as Pool).connect() : (db as PoolClient);
  try {
    if (isPool) await client.query('begin');
    await client.query(`select 1 from automation where id = $1 for update`, [input.automationId]);
    const open = await client.query<{ id: string; payload: { vars?: Record<string, string>; events?: Array<{ key: string; summary: string }> } }>(
      `select id, payload from automation_run
       where automation_id = $1 and status = 'pending' and not_before is not null and not_before > now()
       order by created_at desc limit 1 for update`,
      [input.automationId],
    );
    const run = open.rows[0];
    if (!run) {
      if (isPool) await client.query('commit');
      return null;
    }
    const events = run.payload.events ?? [];
    if (events.some((e) => e.key === input.eventKey)) {
      if (isPool) await client.query('commit');
      return { status: 'duplicate' };
    }
    const nextEvents = events.length >= MAX_MERGED_EVENTS
      ? events
      : [...events, { key: input.eventKey, summary: eventSummary(input.vars, input.eventKey) }];
    // 변수는 **가장 마지막 이벤트** 것으로 덮는다 — `{{sha}}` 는 최신 머리를 가리켜야 한다.
    // 창은 늘리지 않는다: 이벤트가 끝없이 오면 영영 안 나가는 것이 한 번 늦는 것보다 나쁘다.
    const updated = await client.query(
      `update automation_run set payload = $2 where id = $1 returning ${RUN_COLS}`,
      [run.id, JSON.stringify({ vars: input.vars, events: nextEvents })],
    );
    if (isPool) await client.query('commit');
    return { status: 'merged', run: updated.rows[0] };
  } catch (err) {
    if (isPool) await client.query('rollback').catch(() => {});
    throw err;
  } finally {
    if (isPool) client.release();
  }
}

// ── sweeper ───────────────────────────────────────────────────────────────

export interface SweepHost {
  addHook(hook: 'onClose', fn: () => void | Promise<void>): void;
}

interface DueSchedule { id: string; trigger: AutomationTrigger; next_at: Date }

interface PendingRun {
  id: string; automation_id: string; trigger_kind: string;
  payload: { vars?: Record<string, string>; events?: Array<{ key: string; summary: string }> };
  created_at: Date; not_before: Date | null; owner_id: string; channel_id: string; name: string; body: string;
  deleted_at: Date | null; initiated_by: string | null; chain_depth: number | null;
}

/**
 * 두 가지를 한 박자에 한다: (1) 시각이 된 schedule 을 회차로 만든다, (2) 대기 회차를 보낸다.
 * 모양은 `scheduledMessages.ts` 의 sweeper 와 같다 — 한 건씩 자기 트랜잭션, `skip locked`,
 * 프로세스 안 겹침은 `running` 깃발.
 */
export function createAutomationSweeper(pool: Pool, opts: { now?: () => Date } = {}): {
  startSweep(app: SweepHost): void;
  sweep(): Promise<void>;
} {
  const now = opts.now ?? (() => new Date());
  let sweepInterval: ReturnType<typeof setInterval> | null = null;
  let running = false;

  /**
   * 시각이 된 schedule 하나를 회차로 만든다. **밀린 회차를 따라잡지 않는다**: 서버가 3주
   * 꺼져 있었어도 한 번만 보내고, 다음 회차는 `now` 뒤의 첫 시각이다. 주간 요약 세 통이
   * 연달아 오는 것이 한 통 빠지는 것보다 나쁘다.
   */
  async function fireOneSchedule(skip: string[]): Promise<'done' | 'none'> {
    const client = await pool.connect();
    try {
      await client.query('begin');
      const due = await client.query<DueSchedule>(
        `select id, trigger, next_at from automation
         where enabled and deleted_at is null and next_at is not null and next_at <= $2
           and not (id = any($1::uuid[]))
         order by next_at limit 1
         for update skip locked`,
        [skip, now().toISOString()],
      );
      const row = due.rows[0];
      if (!row) { await client.query('commit'); return 'none'; }
      skip.push(row.id);

      const firedFor = new Date(row.next_at);
      const t = row.trigger;
      const result = await enqueueRun(client, {
        automationId: row.id,
        // 회차 키는 **예정 시각**이다 — 같은 회차를 두 프로세스가 집어도 하나만 남는다.
        eventKey: `schedule:${firedFor.toISOString()}`,
        triggerKind: 'schedule',
        vars: t.kind === 'schedule' ? timeVars(firedFor, t.tz) : {},
      });
      if (result.status !== 'rate_limited') {
        const next = t.kind === 'schedule' ? nextOccurrence(t, now()) : null;
        await client.query(`update automation set next_at = $2 where id = $1`, [row.id, next?.toISOString() ?? null]);
      }
      await client.query('commit');
      return 'done';
    } catch (err) {
      await client.query('rollback').catch(() => {});
      console.error('automation schedule sweep error:', err);
      return 'done';
    } finally {
      client.release();
    }
  }

  async function deliverOne(skip: string[]): Promise<'done' | 'none'> {
    const client = await pool.connect();
    try {
      await client.query('begin');
      const due = await client.query<PendingRun>(
        `select r.id, r.automation_id, r.trigger_kind, r.payload, r.created_at, r.not_before,
                r.initiated_by, r.chain_depth, a.owner_id, a.channel_id, a.name, a.body, a.deleted_at
         from automation_run r join automation a on a.id = r.automation_id
         where r.status = 'pending' and not (r.id = any($1::uuid[]))
           and (r.not_before is null or r.not_before <= $2)
         order by r.created_at limit 1
         for update of r skip locked`,
        [skip, now().toISOString()],
      );
      const run = due.rows[0];
      if (!run) { await client.query('commit'); return 'none'; }
      skip.push(run.id);

      const finish = async (status: 'sent' | 'failed' | 'skipped', error: string | null, messageId: string | null = null) => {
        await client.query(
          `update automation_run set status = $2, error = $3, message_id = $4, finished_at = now() where id = $1`,
          [run.id, status, error, messageId],
        );
      };

      if (run.deleted_at) { await finish('skipped', 'automation_deleted'); await client.query('commit'); return 'done'; }
      // 만료는 **보낼 수 있게 된 때**부터 잰다 — 모으는 창만큼 늦은 것은 늦은 것이 아니다.
      const readyAt = Math.max(new Date(run.created_at).getTime(), run.not_before ? new Date(run.not_before).getTime() : 0);
      if (now().getTime() - readyAt > PENDING_EXPIRY_MS) {
        await finish('failed', 'expired');
        await client.query('commit');
        return 'done';
      }

      const refused = await refuseReason(client, run);
      if (refused) {
        await finish('failed', refused);
        await pauseForRefusal(client, run.automation_id, refused);
        await client.query('commit');
        return 'done';
      }

      const result = await postMessage(pool, {
        channelId: run.channel_id,
        authorId: run.owner_id,
        body: renderBody(run.body, {
          ...(run.payload.vars ?? {}),
          // 병합 목록. 디바운스를 안 켰으면 한 줄이다 — 본문이 `{{events}}` 를 써도 늘 채워진다.
          events: (run.payload.events ?? []).map((e) => `- ${e.summary}`).join('\n'),
          'events.count': String((run.payload.events ?? []).length || 1),
        }),
        // 발송이 재시도돼도 같은 메시지를 돌려받는다(`scheduledMessages.ts` 와 같은 이유).
        idempotencyKey: `automation:${run.id}`,
        meta: {
          automation: {
            id: run.automation_id, name: run.name, trigger: run.trigger_kind, runId: run.id,
            ...(run.initiated_by ? { initiatedBy: run.initiated_by } : {}),
          },
        },
        // 에이전트가 돌린 회차는 그 에이전트의 사슬을 잇는다(082) — 사람 이름 글로 상한을 세탁하지 못하게.
        chainDepth: run.chain_depth,
      });
      if (result.message) {
        await finish('sent', null, result.message.id);
        await client.query(`update automation set consecutive_failures = 0 where id = $1`, [run.automation_id]);
      } else {
        const code = result.failure ?? 'unknown';
        await finish('failed', code);
        await pauseForRefusal(client, run.automation_id, code);
      }
      await client.query('commit');
      return 'done';
    } catch (err) {
      await client.query('rollback').catch(() => {});
      // 일시적 실패(DB 순간 장애 등)다. 회차는 `pending` 으로 남아 다음 sweep 이 다시 보낸다.
      console.error('automation deliver sweep error:', err);
      return 'done';
    } finally {
      client.release();
    }
  }

  const sweep = async () => {
    if (running) return;
    running = true;
    try {
      const skipA: string[] = [];
      for (let i = 0; i < SWEEP_BATCH_SIZE; i++) if ((await fireOneSchedule(skipA)) === 'none') break;
      const skipB: string[] = [];
      for (let i = 0; i < SWEEP_BATCH_SIZE; i++) if ((await deliverOne(skipB)) === 'none') break;
    } finally {
      running = false;
    }
  };

  return {
    startSweep(app) {
      if (sweepInterval) return;
      sweepInterval = setInterval(() => { void sweep(); }, SWEEP_INTERVAL_MS);
      sweepInterval.unref?.();
      app.addHook('onClose', async () => {
        if (sweepInterval) { clearInterval(sweepInterval); sweepInterval = null; }
      });
    },
    sweep,
  };
}

/**
 * 게시가 거부되면 **그 자리에서 멈춘다.** 채널이 보관됐거나 만든 사람이 비공개 채널을 떠난
 * 것은 다음 회차에도 그대로라, 계속 돌리면 실패 기록만 쌓이고 사람은 모른다. 다시 켜는
 * 것은 사람의 몫이다(`updateAutomation` 이 사유를 비운다).
 */
async function pauseForRefusal(client: PoolClient, automationId: string, code: string): Promise<void> {
  await client.query(
    `update automation set enabled = false, next_at = null, paused_reason = $2,
       consecutive_failures = consecutive_failures + 1, updated_at = now()
     where id = $1`,
    [automationId, `post_refused:${code}`],
  );
}

/** 지금 보내면 안 되는 이유(`scheduledMessages.ts::refuseReason` 과 같은 술어 + 작성자 상태). */
async function refuseReason(client: PoolClient, run: PendingRun): Promise<string | null> {
  const owner = await client.query<{ deleted_at: Date | null; disabled_at: Date | null }>(
    `select deleted_at, disabled_at from account where id = $1`, [run.owner_id],
  );
  const o = owner.rows[0];
  if (!o || o.deleted_at) return 'owner_deleted';
  if (o.disabled_at) return 'owner_disabled';
  const exists = await client.query(`select 1 from channel where id = $1`, [run.channel_id]);
  if (!exists.rowCount) return 'channel_deleted';
  const gate = await channelPostGate(client, run.channel_id, run.owner_id);
  if (gate === 'archived') return 'channel_archived';
  if (gate === 'forbidden') return 'forbidden';
  return null;
}
