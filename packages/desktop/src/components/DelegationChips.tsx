import { useEffect, useState } from 'react';
import { chipRow, type ChipState, type DelegationChip } from '../lib/delegationDisplay';
import type { InboxDelegationSummary } from '@harkroom/shared';
import { useT } from '../i18n/useT';

const STATE_TONE: Record<ChipState, string> = {
  open: 'text-state-running',
  reported: 'text-state-done',
  failed: 'text-danger',
  closed: 'text-fg-subtle',
};
const STATE_DOT: Record<ChipState, string> = {
  open: 'bg-state-running',
  reported: 'bg-state-done',
  failed: 'bg-danger',
  closed: 'border border-fg-subtle',
};

/**
 * 스레드 머리 아래 「맡긴 일」 칩 줄(위임 재설계 v1 P6, designer 시안 v1 A안). 칩 하나 = 위임 하나의 담당 하나,
 * PR 감시 칩은 그 위임 칩 바로 뒤. 위임이 없으면 아무것도 그리지 않는다 — 줄 자체가 없다.
 */
export function DelegationChips({ rootId, summaries, delegatorWho, onOpenMessage }: {
  rootId: string;
  summaries: InboxDelegationSummary[] | null;
  /** 닫힘 사유 「위임자가 닫음」에 넣을 이름. */
  delegatorWho?: string;
  onOpenMessage: (messageId: string) => void;
}) {
  const t = useT();
  const [expanded, setExpanded] = useState(false);
  // 스레드를 옮기면 접는다 — 앞 스레드에서 편 것이 다른 스레드로 따라가면 안 된다.
  useEffect(() => { setExpanded(false); }, [rootId]);
  const row = chipRow(summaries);
  if (!row) return null;

  const closedText = (c: Extract<DelegationChip, { kind: 'item' }>, who: string): string => {
    switch (c.closedReason) {
      case 'delegator_close': return t('thread.delegations.closedDelegator', { who });
      case 'superseded': return t('thread.delegations.closedSuperseded');
      case 'idle': return t('thread.delegations.closedIdle');
      case 'max_age': return t('thread.delegations.closedMaxAge');
      default: return t('thread.delegations.closed');
    }
  };
  const stateText = (c: Extract<DelegationChip, { kind: 'item' }>, who: string): string => {
    switch (c.state) {
      case 'open': return t('thread.delegations.open');
      case 'reported': return t('thread.delegations.reported');
      case 'failed': return t('thread.delegations.failed');
      case 'closed': return closedText(c, who);
    }
  };
  const whoOf = (id: string): string => summaries?.find((d) => d.id === id)?.delegatorHandle ?? delegatorWho ?? '';

  const chip = (c: DelegationChip) => {
    if (c.kind === 'pr') {
      const full = t('thread.delegations.watching', { number: c.watch.number });
      return (
        <li key={c.key} data-testid={`delegation-pr-${c.watch.number}`} title={`${c.watch.repo} · ${full}`}
          className="inline-flex max-w-full items-center gap-1.5 whitespace-nowrap rounded-full border border-border bg-state-active-surface px-2 text-meta text-link"
        >
          <span aria-hidden="true" className="h-1.5 w-1.5 rounded-full bg-link motion-safe:animate-pulse" />
          {/* 좁은 스레드 창(시안 360px)에서는 「#n CI」로 줄인다 — 전체 문구는 툴팁·스크린리더 이름에 남는다. */}
          <span className="hidden @sm:inline">{full}</span>
          <span className="@sm:hidden" aria-label={full}>{t('thread.delegations.watchingShort', { number: c.watch.number })}</span>
        </li>
      );
    }
    const text = stateText(c, whoOf(c.delegationId));
    return (
      <li key={c.key} className="max-w-full">
        <button
          type="button"
          data-testid={`delegation-chip-${c.handle}`}
          data-state={c.state}
          onClick={() => onOpenMessage(c.messageId)}
          className={`inline-flex max-w-full items-center gap-1.5 whitespace-nowrap rounded-full border px-2 text-meta text-fg hover:bg-surface-hover ${
            c.state === 'failed' ? 'border-danger-border bg-danger-surface' : 'border-border bg-surface-raised'} ${c.state === 'closed' ? 'opacity-75' : ''}`}
        >
          <span className="truncate font-semibold">{c.handle}</span>
          <span className={`inline-flex items-center gap-1 font-semibold ${STATE_TONE[c.state]}`}>
            <span aria-hidden="true" className={`h-1.5 w-1.5 rounded-full ${STATE_DOT[c.state]}`} />
            {text}
          </span>
          {c.planStepId && <span className="text-fg-subtle">· {t('thread.delegations.step', { step: c.planStepId })}</span>}
        </button>
      </li>
    );
  };

  const shown = expanded ? [...row.chips, ...row.hidden] : row.chips;
  const hiddenItems = row.hidden.filter((c) => c.kind === 'item').length;
  return (
    <div data-testid="delegation-chips" className="@container flex flex-wrap items-center gap-1.5 border-b border-border bg-surface px-4 py-1.5">
      <span className="mr-0.5 text-meta text-fg-subtle">
        {row.role === 'delegator'
          ? t('thread.delegations.handedOff')
          : t('thread.delegations.assignedBy', { who: row.delegatorHandle ?? '' })}
      </span>
      <ul className="contents">{shown.map(chip)}</ul>
      {hiddenItems > 0 && (
        <button
          type="button"
          data-testid="delegation-chips-more"
          aria-expanded={expanded}
          onClick={() => setExpanded((v) => !v)}
          className="rounded-full border border-border bg-surface-raised px-2 text-meta text-fg-muted hover:bg-surface-hover"
        >
          {expanded
            ? t('thread.delegations.less')
            : row.hiddenClosed > 0
              ? t('thread.delegations.more', { count: hiddenItems, closed: row.hiddenClosed })
              : t('thread.delegations.moreOpen', { count: hiddenItems })}
        </button>
      )}
    </div>
  );
}
