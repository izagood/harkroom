import type { PlanProgress } from '@harkroom/shared';
import { planTone } from '../lib/threadPlan';
import { useT } from '../i18n/useT';

/**
 * 계획 진행 칩(P5·D2·W10) — 「계획 n/N · 막힘 n」 + 미니 막대. **막힘만 빨강**이다(`ThreadStateBadge` 의 강조 규칙과 같다 —
 * 진행률은 「현재 상태」라 강조색을 받지 않고, 사람이 손을 대야 하는 막힘만 받는다).
 * 값은 서버가 센 청중 기준 진행률을 그대로 쓴다. 단계가 하나도 없으면 그리지 않는다.
 */
export function PlanChip({ progress, className = '' }: { progress: PlanProgress | null | undefined; className?: string }) {
  const t = useT();
  const tone = planTone(progress);
  if (!progress || tone === 'empty') return null;
  const pct = Math.round((progress.done / progress.total) * 100);
  return (
    <span
      data-testid="plan-chip"
      data-tone={tone}
      className={`inline-flex items-center gap-1 rounded-row px-1.5 text-meta font-medium ${TONE[tone]} ${className}`}
    >
      {t('plan.chip', { done: progress.done, total: progress.total })}
      {tone === 'blocked' && <span data-testid="plan-chip-blocked">{t('plan.chip.blocked', { n: progress.blocked })}</span>}
      <span aria-hidden="true" className="relative h-1 w-8 overflow-hidden rounded-full bg-surface-sunken">
        <span className={`absolute inset-y-0 left-0 ${BAR[tone]}`} style={{ width: `${pct}%` }} />
      </span>
    </span>
  );
}

const TONE: Record<'blocked' | 'done' | 'active', string> = {
  blocked: 'bg-danger-surface text-state-stuck',
  active: 'text-fg-muted',
  done: 'text-fg-subtle',
};
const BAR: Record<'blocked' | 'done' | 'active', string> = {
  blocked: 'bg-state-stuck',
  active: 'bg-state-running',
  done: 'bg-state-done',
};
