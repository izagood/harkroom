import { isIdle, type ThreadProgress } from '../lib/threadProgress';
import { useLocale, useT } from '../i18n/useT';
import { stampLabel } from '../lib/day';
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
  // 면을 받는 칸만 안쪽 여백을 갖는다. 면이 없는 칸에 여백을 주면 띠 첫 글자가 머리 제목보다 안쪽에서 시작한다.
  myTurn: 'px-1.5 bg-accent-surface text-state-turn',
  blocked: 'px-1.5 bg-danger-surface text-state-stuck',
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

export function ThreadProgressStrip({ progress, plan, onMyTurn, drawer }: {
  progress: ThreadProgress;
  /** 계획판이 있으면 끝에 「계획 n/N」을 붙인다. 없으면 `null`. */
  plan: { done: number; total: number } | null;
  /** 「내 차례」 칸을 누르면 그 카드로 간다. 갈 곳이 없으면 안 준다 — 그때 칸은 글자다. */
  onMyTurn?: () => void;
  /** 작업 서랍 여닫이. 서랍이 없는 자리(좁은 폭·빈 띠)는 안 준다. */
  drawer?: { open: boolean; onToggle: () => void } | null;
}) {
  const t = useT();
  const locale = useLocale();
  const idle = isIdle(progress);
  // 빈 띠는 「언제 끝났는지」를 함께 말한다 — 완료 보고가 없던 스레드는 마지막 답의 시각으로 대신한다.
  const last = progress.lastDoneAt != null
    ? t('thread.progress.lastDone', { time: stampLabel(progress.lastDoneAt, locale) })
    : progress.lastReplyAt != null
      ? t('thread.progress.lastReply', { time: stampLabel(progress.lastReplyAt, locale) })
      : null;
  return (
    <div
      data-testid="thread-progress"
      data-idle={idle}
      role="status"
      // 턴이 뜨고 질 때마다 수가 바뀐다. 그때마다 읽어 주면 화면 낭독이 대화를 끊는다 — 찾아가면 읽히는 자리로 둔다.
      aria-live="off"
      className="flex flex-wrap items-center gap-x-3 gap-y-1 border-b border-border px-4 py-1 text-meta"
    >
      {idle && (
        <span data-testid="thread-progress-idle" className="text-fg-subtle">
          {t('thread.progress.idle')}{last && ` · ${last}`}
        </span>
      )}
      {!idle && ORDER.map((slot) => {
        const n = progress[slot];
        // 예약 목록을 못 읽었다 — 읽힌 것만 센 수 바로 옆에 「모름」을 세운다. 0 으로 말하지 않는다.
        const waitingUnknown = slot === 'waiting' && progress.waitingUnknown && (
          <span
            key="waitingUnknown"
            data-testid="thread-progress-waitingUnknown"
            data-unknown
            className="inline-flex items-center gap-1 rounded-row border border-dashed border-border px-1.5 text-fg-subtle"
          >
            {t('thread.progress.waitingUnknown')}
          </span>
        );
        if (n === 0) return waitingUnknown || null;
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
        const cell = (
          <>
            {/* 색만으로 가르지 않는다(시안) — 사람을 부르는 둘(내 차례·막힘)은 네모, 나머지는 동그라미. */}
            <span aria-hidden="true" className={`h-1.5 w-1.5 ${slot === 'myTurn' || slot === 'blocked' ? 'rounded-sm' : 'rounded-full'} ${DOT[slot]}`} />
            {t(LABEL[slot], { n })}
          </>
        );
        const tone = `inline-flex items-center gap-1 rounded-row font-medium ${TONE[slot]}`;
        // 내 차례는 사람이 눌러야 풀린다 — 칸이 곧 그 카드로 가는 길이다.
        if (slot === 'myTurn' && onMyTurn) {
          return (
            <button
              key={slot}
              type="button"
              data-testid={`thread-progress-${slot}`}
              data-count={n}
              title={t('thread.progress.myTurnJump')}
              onClick={onMyTurn}
              className={`${tone} hover:underline`}
            >
              {cell}
            </button>
          );
        }
        return [
          <span key={slot} data-testid={`thread-progress-${slot}`} data-count={n} className={tone}>
            {cell}
          </span>,
          waitingUnknown || null,
        ];
      })}
      {plan && plan.total > 0 && (
        <span data-testid="thread-progress-plan" className="text-fg-subtle">
          {t('thread.progress.plan', { done: plan.done, total: plan.total })}
        </span>
      )}
      {/* 서랍 여닫이는 넓은 폭에서만 선다 — 좁으면 띠만 남는다(시안 D1). */}
      {drawer && !idle && (
        <button
          type="button"
          data-testid="thread-work-toggle"
          aria-expanded={drawer.open}
          onClick={drawer.onToggle}
          className="ml-auto hidden text-accent-text hover:underline @[700px]:inline"
        >
          {t(drawer.open ? 'thread.work.close' : 'thread.work.open')}
        </button>
      )}
    </div>
  );
}
