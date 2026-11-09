import type { CardDelegation, DelegationLabel as Label } from '../lib/delegationDisplay';
import { useT } from '../i18n/useT';

/** 라벨 색 — 새 색 없이 앱 토큰만(designer 시안 v1): 진행=에이전트 · 결과=끝남 · 막힘=위험 · 멈춤=내 차례(주황). */
const TONE: Record<Label, string> = {
  update: 'bg-surface-agent text-fg-agent',
  reported: 'bg-success-surface text-state-done',
  failed: 'bg-danger-surface text-danger',
  stalled: 'bg-accent-surface text-accent',
};
const DOT: Record<Label, string> = {
  update: 'bg-state-running',
  reported: 'bg-state-done',
  failed: 'bg-danger',
  stalled: 'bg-accent',
};

/**
 * 인박스 카드 요약 **앞**의 위임 라벨(위임 재설계 v1 P6). 같은 줄에 붙고, 진행 소식이 여럿이면 뒤에 「소식 n」을 단다 —
 * 그 수는 요약 뒤에 오므로 따로 `DelegationUpdates` 로 그린다.
 */
export function DelegationLabel({ delegation, testId }: { delegation: CardDelegation; testId?: string }) {
  const t = useT();
  const { label } = delegation;
  const text = label === 'update' ? t('inbox.delegation.update')
    : label === 'reported' ? t('inbox.delegation.reported')
      : label === 'failed' ? t('inbox.delegation.failed')
        : t('inbox.delegation.stalled', { hours: delegation.quietHours ?? 0 });
  return (
    <span
      data-testid={testId}
      data-label={label}
      className={`mr-1.5 inline-flex shrink-0 items-center gap-1 whitespace-nowrap rounded-row px-1.5 align-[1px] text-meta font-semibold ${TONE[label]}`}
    >
      <span aria-hidden="true" className={`h-1.5 w-1.5 rounded-full ${DOT[label]}`} />
      {text}
    </span>
  );
}

/** 「소식 n」 — 한 스레드에 진행 소식이 둘 이상 묶였을 때만. */
export function DelegationUpdates({ delegation, testId }: { delegation: CardDelegation; testId?: string }) {
  const t = useT();
  if (delegation.updates < 2) return null;
  return (
    <span data-testid={testId} className="ml-1.5 shrink-0 rounded-full bg-surface-sunken px-1.5 text-meta text-fg-muted">
      {t('inbox.delegation.updates', { count: delegation.updates })}
    </span>
  );
}
