import type { AutomationMessageMeta, AutomationTrigger } from '@harkroom/shared';
import type { Translate } from '../i18n';

/**
 * 자동화가 쓴 메시지의 `meta.automation`(064). 모양이 어긋나면 null — 이름줄 칩은
 * 확실할 때만 선다(사람이 친 글에 ⚡ 가 붙으면 그 표시가 거짓말이 된다).
 */
export function readAutomationMeta(meta: Record<string, unknown>): AutomationMessageMeta | null {
  const a = meta.automation as Partial<AutomationMessageMeta> | undefined;
  if (!a || typeof a !== 'object' || typeof a.id !== 'string' || typeof a.name !== 'string') return null;
  return {
    id: a.id, name: a.name, trigger: typeof a.trigger === 'string' ? a.trigger : 'schedule', runId: String(a.runId ?? ''),
    // 에이전트가 `automation.run` 으로 돌린 회차(082). 옛 서버의 글에는 없다.
    ...(typeof a.initiatedBy === 'string' ? { initiatedBy: a.initiatedBy } : {}),
  };
}

/** 요일 이름은 `Intl` 이 푼다 — 사전에 일곱 낱말을 두 벌 적지 않는다. 2023-01-01 이 일요일이다. */
export function weekdayName(dow: number, locale: string): string {
  return new Date(Date.UTC(2023, 0, 1 + dow)).toLocaleDateString(locale || undefined, { weekday: 'short', timeZone: 'UTC' });
}

/** 트리거 한 줄 요약. "매주 월 09:00 (Asia/Seoul)" · "GitHub izagood/harkroom push → main". */
export function describeTrigger(trigger: AutomationTrigger, locale: string, t: Translate): string {
  if (trigger.kind === 'webhook') return t('automations.trigger.webhook');
  if (trigger.kind === 'github') {
    const branch = trigger.branch ? ` → ${trigger.branch}` : '';
    const paths = trigger.paths?.length ? ` · ${trigger.paths.join(', ')}` : '';
    const change = trigger.change && trigger.change !== 'any' ? ` (${trigger.change})` : '';
    return t('automations.trigger.github', { repo: trigger.repo, event: trigger.event, rest: `${branch}${paths}${change}` });
  }
  const tail = `${trigger.time} (${trigger.tz})`;
  if (trigger.freq === 'daily') return t('automations.trigger.daily', { at: tail });
  if (trigger.freq === 'weekly') {
    const days = trigger.weekdays.map((d) => weekdayName(d, locale)).join(', ');
    return t('automations.trigger.weekly', { days, at: tail });
  }
  return t('automations.trigger.monthly', { day: trigger.monthDay, at: tail });
}

/** 이 기기의 tz. 만들기 폼의 기본값이다. */
export function localTimeZone(): string {
  try { return Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC'; } catch { return 'UTC'; }
}

// ── 지금 한 번 돌리기(A안) ─────────────────────────────────────────────────

/** 이만큼 안에 다시 누르면 한 번 묻는다 — 반응이 없어 두 번 눌린 일(10-25)을 막는 선. */
export const RERUN_CONFIRM_MS = 10 * 60_000;

/**
 * 손으로 돌리면 서버는 이벤트 변수를 비워 둔다(`vars: {}`). 치환은 모르는 이름을 그대로
 * 남기므로 그 변수는 `{{release.tag}}` 글자 그대로 올라간다. 그런 이름을 돌려준다.
 * 일정 자동화는 손으로 돌려도 시각 변수를 지금 시각으로 채우고, `events`·`events.count` 는
 * 발송 때 늘 채워지므로 뺀다.
 */
export function unfilledManualVars(body: string, trigger: AutomationTrigger): string[] {
  if (trigger.kind === 'schedule') return [];
  const out = new Set<string>();
  for (const m of body.matchAll(/\{\{\s*([\w.]+)\s*\}\}/g)) {
    const name = m[1]!;
    if (name !== 'events' && name !== 'events.count') out.add(name);
  }
  return [...out];
}

/**
 * 회차 사유 코드 → 사람 말. **코드만 번역한다** — 서버가 준 글자를 그대로 그리지 않는다
 * (모르는 코드는 「알 수 없는 이유」). 자동 일시정지 사유 `post_refused:<code>` 도 받는다.
 */
export function runErrorText(code: string | null | undefined, t: Translate): string {
  const c = (code ?? '').replace(/^post_refused:/, '');
  switch (c) {
    case 'expired': return t('automations.err.expired');
    case 'automation_deleted': return t('automations.err.automationDeleted');
    case 'owner_deleted': return t('automations.err.ownerDeleted');
    case 'owner_disabled': return t('automations.err.ownerDisabled');
    case 'channel_deleted': return t('automations.err.channelDeleted');
    case 'channel_archived': return t('automations.err.channelArchived');
    case 'forbidden': return t('automations.err.forbidden');
    case 'rejected': return t('automations.err.rejected');
    case 'bad_thread': return t('automations.err.badThread');
    case 'rate_limited': return t('automations.err.rateLimited');
    case 'not_found': case 'not_yours': case 'already_attached': return t('automations.err.attachment');
    default: return t('automations.err.unknown');
  }
}

export function runStatusText(status: string, t: Translate): string {
  if (status === 'pending') return t('automations.status.pending');
  if (status === 'sent') return t('automations.status.sent');
  if (status === 'failed') return t('automations.status.failed');
  if (status === 'skipped') return t('automations.status.skipped');
  return status;
}

export function runTriggerText(kind: string, t: Translate): string {
  if (kind === 'manual') return t('automations.runTrigger.manual');
  if (kind === 'schedule') return t('automations.runTrigger.schedule');
  if (kind === 'github') return t('automations.runTrigger.github');
  if (kind === 'webhook') return t('automations.runTrigger.webhook');
  return kind;
}

/** 오늘이면 시:분, 다른 날이면 월-일 시:분(사용자 시간대). */
export function runTime(iso: string, locale: string, now: Date = new Date()): string {
  const d = new Date(iso);
  const loc = locale || undefined;
  const hm = d.toLocaleTimeString(loc, { hour: '2-digit', minute: '2-digit', hour12: false });
  if (d.toDateString() === now.toDateString()) return hm;
  return `${d.toLocaleDateString(loc, { month: '2-digit', day: '2-digit' })} ${hm}`;
}
