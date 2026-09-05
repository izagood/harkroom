import { THREAD_STATE_LABEL, isBlocking, type ThreadState } from '../lib/threadState';

/**
 * 스레드 상태 한 조각. 화면 여러 곳이 **같은 어휘와 같은 색**을 쓰도록 한 자리에서 낸다
 * (`threadState` 를 순수 함수로 뽑은 것과 같은 이유 — 세 곳에 흩으면 조용히 갈라진다).
 *
 * ## 강조는 둘뿐이고, 그 둘도 색이 다르다
 *
 * `my-turn` 은 `state-turn`(주황), `stuck` 은 `state-stuck`(빨강)이다. 둘 다 사람을 부르지만
 * **사람이 할 일이 다르다** — "답하면 풀린다"와 "손을 대야 한다".
 *
 * 나머지 셋(`waiting`·`running`·`done`)은 무채색이다. 강조가 다섯에 고르게 뿌려지는 순간
 * "내 차례"라는 신호가 죽는다(규칙 03).
 */
export function ThreadStateBadge({ state, className = '' }: { state: ThreadState; className?: string }) {
  return (
    <span
      data-testid="thread-state"
      data-state={state}
      data-blocking={isBlocking(state)}
      className={`inline-flex items-center gap-1 rounded px-1.5 text-[11px] font-medium ${TONE[state]} ${className}`}
    >
      <span aria-hidden="true" className={`h-1.5 w-1.5 rounded-full ${DOT[state]}`} />
      {THREAD_STATE_LABEL[state]}
    </span>
  );
}

/** 글자·면. `done` 은 아무 면도 받지 않는다 — 끝난 것은 배경이다. */
const TONE: Record<ThreadState, string> = {
  'my-turn': 'bg-accent-surface text-state-turn',
  stuck: 'bg-danger-surface text-state-stuck',
  waiting: 'text-fg-muted',
  running: 'text-fg-agent',
  done: 'text-fg-subtle',
};

const DOT: Record<ThreadState, string> = {
  'my-turn': 'bg-state-turn',
  stuck: 'bg-state-stuck',
  waiting: 'bg-state-waiting',
  running: 'bg-state-running',
  done: 'bg-state-done',
};
