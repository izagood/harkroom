import { useState } from 'react';
import { useActiveStore } from '../state/communities';
import { useLocale, useT } from '../i18n/useT';
import type { MessageKey } from '../i18n';
import { stampLabel } from '../lib/day';
import { elapsedMs } from '../lib/progressGroup';
import { runningLabel, waitLabel } from '../lib/time';
import type { DrawerGroup, DrawerItem } from '../lib/threadWork';

/**
 * 작업 서랍(R2-b) — 진행 띠가 수로 말한 것을 **누가·무엇을·얼마나** 로 편다.
 *
 * 띠와 같은 다섯 묶음을 같은 순서로 세운다. 빈 묶음은 그리지 않고, 「오늘 끝」은 접어 둔다(시안 D5).
 * 줄을 고르는 일은 `lib/threadWork` 가 한다 — 여기는 그리기만 한다. 띠의 수와 줄 수가 갈라지지 않게 하려는 것이다.
 *
 * 넓은 폭에서만 선다(부모의 컨테이너 폭 700px 부터 — 스레드 패널의 기본 폭 711px 에서 서도록 잡았다). 좁으면 띠만 남는다.
 */
const ORDER: readonly DrawerGroup[] = ['myTurn', 'blocked', 'running', 'waiting', 'doneToday'];

const GROUP_LABEL: Record<DrawerGroup, MessageKey> = {
  myTurn: 'thread.progress.myTurn',
  blocked: 'thread.progress.blocked',
  running: 'thread.progress.running',
  waiting: 'thread.progress.waiting',
  doneToday: 'thread.progress.doneToday',
};

const GROUP_TONE: Record<DrawerGroup, string> = {
  myTurn: 'text-state-turn',
  blocked: 'text-state-stuck',
  running: 'text-fg-agent',
  waiting: 'text-fg-muted',
  doneToday: 'text-fg-subtle',
};

const GROUP_DOT: Record<DrawerGroup, string> = {
  myTurn: 'bg-state-turn',
  blocked: 'bg-state-stuck',
  running: 'bg-state-running',
  waiting: 'bg-state-waiting',
  doneToday: 'bg-state-done',
};

const EDGE: Record<DrawerGroup, string> = {
  myTurn: 'border-state-turn',
  blocked: 'border-state-stuck',
  running: 'border-state-running',
  waiting: 'border-transparent',
  doneToday: 'border-transparent',
};

/** 모르는 것을 말하는 줄 — 수에 넣지 않고 점선으로 그린다. */
const isUnknown = (item: DrawerItem): boolean => item.detail.kind === 'turnUnknown' || item.detail.kind === 'wakeUnknown';

export function ThreadWorkDrawer({ items, work, onOpenMessage, onClose }: {
  items: readonly DrawerItem[];
  /** 작업 행 읽기의 형편. `off` 는 그 길이 없는 서버, `unknown` 은 못 읽음 — 맨 위 한 줄로 말하고 나머지로 계속 그린다. */
  work: 'ok' | 'off' | 'unknown';
  onOpenMessage: (messageId: string) => void;
  onClose: () => void;
}) {
  const t = useT();
  const locale = useLocale();
  const accounts = useActiveStore((s) => s.accounts);
  const [doneOpen, setDoneOpen] = useState(false);
  const now = Date.now();
  const name = (id: string | null): string => (id === null ? t('common.someone') : accounts[id]?.handle ?? '…');

  const meta = (item: DrawerItem): string => {
    const d = item.detail;
    switch (d.kind) {
      case 'ask':
        return item.group === 'myTurn'
          ? t('thread.work.askedBy', { handle: name(item.actorId) })
          : d.awaitingId === null ? t('thread.work.awaitingAnyone') : t('thread.work.awaiting', { handle: name(d.awaitingId) });
      case 'gate': return t('thread.work.gate');
      case 'failure': return t('thread.work.failure');
      case 'planBlocked': return t('thread.work.planBlocked', { count: d.count });
      case 'turn': return t('thread.work.turn');
      case 'turnUnknown': return t('thread.work.turnUnknown');
      case 'wake': return t('thread.work.wake');
      case 'wakeUnknown': return t('thread.work.wakeUnknown');
      case 'work': return d.openChildren > 0 ? t('thread.work.workWaitingOn', { count: d.openChildren }) : t('thread.work.workWaiting');
      case 'report': return t('thread.work.report');
    }
  };

  /** 오른쪽 끝의 시간 — 도는 것·기다린 것은 「n분째」, 예약은 「n분 뒤」, 끝난 것은 시각. */
  const when = (item: DrawerItem): string | null => {
    if (item.at === null) return null;
    if (item.detail.kind === 'wake') return waitLabel(Date.parse(item.at) - now, locale, t);
    if (item.group === 'doneToday') return stampLabel(item.at, locale);
    const ms = elapsedMs(item.at, now);
    return ms === null ? null : runningLabel(ms, locale, t);
  };

  return (
    <aside
      data-testid="thread-work-drawer"
      aria-label={t('thread.work.title')}
      className="hidden w-[340px] shrink-0 flex-col overflow-y-auto border-l border-border pb-3 text-meta @[700px]:flex"
    >
      <div className="flex items-center gap-2 px-3 py-2">
        <span className="font-semibold text-fg">{t('thread.work.title')}</span>
        <span className="text-fg-subtle">{t('thread.work.scope')}</span>
        <button
          type="button"
          data-testid="thread-work-close"
          aria-label={t('thread.work.close')}
          title={t('thread.work.close')}
          onClick={onClose}
          className="ml-auto rounded-row px-1.5 text-fg-subtle hover:bg-surface-sunken"
        >
          ×
        </button>
      </div>
      {work !== 'ok' && (
        <p data-testid="thread-work-notice" data-reason={work} className="mx-3 mb-1 rounded-row border border-dashed border-border px-2 py-1 text-fg-muted">
          {t(work === 'off' ? 'thread.work.off' : 'thread.work.unreadable')}
        </p>
      )}
      {ORDER.map((group) => {
        const rows = items.filter((i) => i.group === group);
        if (rows.length === 0) return null;
        const count = rows.filter((i) => !isUnknown(i)).reduce((n, i) => n + (i.detail.kind === 'planBlocked' ? i.detail.count : 1), 0);
        const folded = group === 'doneToday' && !doneOpen;
        const head = (
          <>
            <span aria-hidden="true" className={`h-1.5 w-1.5 ${group === 'myTurn' || group === 'blocked' ? 'rounded-sm' : 'rounded-full'} ${GROUP_DOT[group]}`} />
            {/* 모름 줄만 있는 묶음은 수 대신 「모름」이라 적는다 — 띠의 점선 칸과 같은 말이다. */}
            {count > 0
              ? t(GROUP_LABEL[group], { n: count })
              : t(group === 'running' ? 'thread.progress.runningUnknown' : 'thread.progress.waitingUnknown')}
          </>
        );
        return (
          <section key={group} data-testid={`thread-work-group-${group}`} data-count={count}>
            {group === 'doneToday' ? (
              <button
                type="button"
                data-testid="thread-work-done-toggle"
                aria-expanded={doneOpen}
                onClick={() => setDoneOpen((v) => !v)}
                className={`flex w-full items-center gap-1.5 px-3 pb-0.5 pt-2 text-left font-semibold ${GROUP_TONE[group]}`}
              >
                {head}
                <span aria-hidden="true" className="ml-1 font-normal">{doneOpen ? '▾' : '▸'}</span>
              </button>
            ) : (
              <h3 className={`flex items-center gap-1.5 px-3 pb-0.5 pt-2 font-semibold ${GROUP_TONE[group]}`}>{head}</h3>
            )}
            {!folded && rows.map((item) => {
              const unknown = isUnknown(item);
              const stamp = when(item);
              const body = (
                <>
                  <span className="min-w-0 flex-1">
                    {!unknown && (
                      <span className="line-clamp-2 font-medium text-fg">{item.title ?? name(item.actorId)}</span>
                    )}
                    <span className="block text-fg-muted">
                      {/* 내 차례 카드는 뒤 문장이 이미 누가 물었는지 말한다 — 이름을 두 번 적지 않는다. */}
                      {!unknown && item.title !== null && item.actorId !== null && !(item.detail.kind === 'ask' && item.group === 'myTurn') && `${name(item.actorId)} · `}
                      {meta(item)}
                    </span>
                    {item.group === 'myTurn' && item.messageId !== null && (
                      <span className="mt-0.5 inline-block rounded-row bg-accent-surface px-1.5 font-medium text-state-turn">
                        {t('thread.work.goCard')}
                      </span>
                    )}
                  </span>
                  {stamp && <span className="shrink-0 tabular-nums text-fg-subtle">{stamp}</span>}
                </>
              );
              // 모름 줄의 점선 막대는 서랍 경계선에 붙으면 실선에 묻힌다 — 한 칸 안으로 들인다.
              const cls = `flex w-full items-start gap-2 border-l-2 px-3 py-1.5 text-left ${unknown ? 'ml-1 border-dashed border-border' : EDGE[group]}`;
              return item.messageId !== null ? (
                <button
                  key={item.key}
                  type="button"
                  data-testid="thread-work-row"
                  data-kind={item.detail.kind}
                  onClick={() => onOpenMessage(item.messageId!)}
                  className={`${cls} hover:bg-surface-sunken`}
                >
                  {body}
                </button>
              ) : (
                <div key={item.key} data-testid="thread-work-row" data-kind={item.detail.kind} {...(unknown ? { 'data-unknown': true } : {})} className={cls}>
                  {body}
                </div>
              );
            })}
          </section>
        );
      })}
    </aside>
  );
}
