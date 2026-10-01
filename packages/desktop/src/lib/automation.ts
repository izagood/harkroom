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
