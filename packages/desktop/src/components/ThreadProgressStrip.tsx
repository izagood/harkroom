import { isIdle, type ThreadProgress } from '../lib/threadProgress';
import { useT } from '../i18n/useT';
import type { MessageKey } from '../i18n';

/**
 * 스레드 진행 띠(R2) — 「무엇이 돌고 · 막혔고 · 끝났는지」를 칸마다 수로 보인다.
 *
 * 순서는 사람이 먼저 할 것부터다(내 차례 → 막힘 → 도는 중 → 기다림 → 오늘 끝). 0 인 칸은 그리지 않는다.
 * 「도는 중」을 모르면(`running === null`) 수 대신 점선 칸으로 「모름」이라 적는다 — 0 으로 말하지 않는다.
 * 강조는 내 차례와 막힘만 받는다(머리 배지와 같은 규칙) — 띠가 서면 머리 배지는 물러난다.
 */
type Slot = 'myTurn' | 'blocked' | 'running' | 'waiting' | 'doneToday';

const ORDER: readonly Slot[] = ['myTurn', 'blocked', 'running', 'waiting', 'doneToday'];

const LABEL: Record<Slot, MessageKey> = {
  myTurn: 'thread.progress.myTurn',
  blocked: 'thread.progress.blocked',
  running: 'thread.progress.running',
  waiting: 'thread.progress.waiting',
  doneToday: 'thread.progress.doneToday',
};

const TONE: Record<Slot, string> = {
  myTurn: 'bg-accent-surface text-state-turn',
  blocked: 'bg-danger-surface text-state-stuck',
  running: 'text-fg-agent',
  waiting: 'text-fg-muted',
  doneToday: 'text-fg-subtle',
};

const DOT: Record<Slot, string> = {
  myTurn: 'bg-state-turn',
  blocked: 'bg-state-stuck',
  running: 'bg-state-running',
  waiting: 'bg-state-waiting',
  doneToday: 'bg-state-done',
};

export function ThreadProgressStrip({ progress, plan }: {
  progress: ThreadProgress;
  /** 계획판이 있으면 끝에 「계획 n/N」을 붙인다. 없으면 `null`. */
  plan: { done: number; total: number } | null;
}) {
  const t = useT();
  const idle = isIdle(progress);
  return (
    <div
      data-testid="thread-progress"
      data-idle={idle}
      role="status"
      className="flex flex-wrap items-center gap-x-2 gap-y-1 border-b border-border px-4 py-1 text-meta"
    >
      {idle && <span data-testid="thread-progress-idle" className="text-fg-subtle">{t('thread.progress.idle')}</span>}
      {!idle && ORDER.map((slot) => {
        const n = progress[slot];
        if (n === 0) return null;
        if (n === null) {
          return (
            <span
              key={slot}
              data-testid={`thread-progress-${slot}`}
              data-unknown
              className="inline-flex items-center gap-1 rounded-row border border-dashed border-border px-1.5 text-fg-subtle"
            >
              {t('thread.progress.runningUnknown')}
            </span>
          );
        }
        return (
          <span
            key={slot}
            data-testid={`thread-progress-${slot}`}
            data-count={n}
            className={`inline-flex items-center gap-1 rounded-row px-1.5 font-medium ${TONE[slot]}`}
          >
            {/* 색만으로 가르지 않는다(시안) — 사람을 부르는 둘(내 차례·막힘)은 네모, 나머지는 동그라미. */}
            <span aria-hidden="true" className={`h-1.5 w-1.5 ${slot === 'myTurn' || slot === 'blocked' ? 'rounded-sm' : 'rounded-full'} ${DOT[slot]}`} />
            {t(LABEL[slot], { n })}
          </span>
        );
      })}
      {plan && plan.total > 0 && (
        <span data-testid="thread-progress-plan" className="text-fg-subtle">
          {t('thread.progress.plan', { done: plan.done, total: plan.total })}
        </span>
      )}
    </div>
  );
}
