import type { MessageRow } from '@murmur/shared';

/**
 * 목록의 한 자리. 보통 메시지 하나이거나, **접힌 진행 묶음**이다.
 *
 * 판정을 컴포넌트 안에 두지 않고 순수 함수로 뽑는 이유는 `threadState` 와 같다 —
 * 채널과 스레드 두 곳이 같은 묶음을 그려야 하고, 컴포넌트 안에 두면 두 곳이 조용히 갈라진다.
 */
export type Slot =
  | { kind: 'message'; message: MessageRow }
  | { kind: 'progress'; messages: MessageRow[] };

/**
 * 연속된 `kind='progress'` 를 **저자별로** 한 묶음으로 접는다(#144, 규칙 02).
 *
 * `message.progress` 는 이미 서버에 있고 러너가 부르는데 데스크탑이 특별히 그리지 않아
 * 일반 발화로 흘렀다 — "도구를 서른 번 부른 과정"이 그대로 대화가 되던 자리다.
 * 화면이 늘려야 할 것은 말의 품질이고 줄여야 할 것은 과정의 노출이다.
 *
 * **묶음이 끊기는 조건**은 두 가지다:
 * - progress 가 아닌 메시지가 끼면 끊긴다 — 사람의 발화나 에이전트의 결론이 사이에
 *   있으면 그 앞뒤는 다른 구간이다.
 * - **저자가 바뀌면 끊긴다** — 둘이 동시에 일할 때 한 줄로 접으면 누가 무엇을 하는지가
 *   사라진다. "작업 중"은 누구의 상태인지가 있어야 뜻이 있다.
 *
 * 저장 구조는 건드리지 않는다 — 표시 단계의 판정일 뿐이다.
 */
export function groupProgress(messages: MessageRow[]): Slot[] {
  const slots: Slot[] = [];
  for (const m of messages) {
    if (m.kind !== 'progress') {
      slots.push({ kind: 'message', message: m });
      continue;
    }
    const last = slots[slots.length - 1];
    if (last?.kind === 'progress' && last.messages[0]!.authorId === m.authorId) {
      last.messages.push(m);
    } else {
      slots.push({ kind: 'progress', messages: [m] });
    }
  }
  return slots;
}

/**
 * 경과를 사람이 읽는 한 마디로. **묶음의 첫 progress 를 기준으로 잰다** — 마지막을 쓰면
 * 30초마다 갱신하는 러너의 "3분째"가 영원히 "0분째"로 보인다(그 러너가 3분째 돌고 있다는
 * 것이 이 줄이 말해야 하는 유일한 사실이다).
 *
 * `now` 를 인자로 받는 이유: 시간을 읽는 함수는 테스트가 시간을 정할 수 있어야 한다.
 */
export function elapsedLabel(startedAt: string, now: number): string | null {
  const ms = now - new Date(startedAt).getTime();
  // 갓 시작한 것에 "0분째"를 붙이면 숫자가 정보가 아니라 잡음이다.
  if (!Number.isFinite(ms) || ms < 60_000) return null;
  const minutes = Math.floor(ms / 60_000);
  if (minutes < 60) return `${minutes}분째`;
  return `${Math.floor(minutes / 60)}시간째`;
}
