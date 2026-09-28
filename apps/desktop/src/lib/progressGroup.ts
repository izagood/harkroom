import type { MessageRow } from '@harkroom/shared';

/**
 * 목록의 한 자리. 보통 메시지 하나이거나, **접힌 진행 묶음**이다.
 *
 * 판정을 컴포넌트 안에 두지 않고 순수 함수로 뽑는 이유는 `threadState` 와 같다 —
 * 채널과 스레드 두 곳이 같은 묶음을 그려야 하고, 컴포넌트 안에 두면 두 곳이 조용히 갈라진다.
 */
export type Slot =
  | { kind: 'message'; message: MessageRow }
  | {
      kind: 'progress';
      messages: MessageRow[];
      /**
       * 이 진행이 **끝난 시각**. 아직 도는 중이면 `null`(2026-09-07 후속).
       *
       * 왜 필요한가: 없을 때 `ProgressRow` 는 경과를 `Date.now()` 로 재서, **끝난 묶음도
       * 영구히 "작업 중 · N분째" 로 그리고 그 숫자가 볼 때마다 커졌다.** 2026-09-07 15:15
       * 에 사용자가 화면을 보고 물은 것이 "죽었나 도나?" 였다 — 15:08 에 끝난 턴의 진행
       * 줄이 "11분째" 였기 때문이다.
       *
       * **같은 저자의 다음 발화**가 그 끝이다: 러너가 결과를 올렸거나(또는
       * `NO_REPLY_NOTICE` 를 남겼거나) 대기 줄을 세운 시점이 그 진행이 멈춘 시점이다.
       * 사람의 발화로는 끝나지 않는다 — 러너는 그 사이에도 계속 돌고 있고, 여기서
       * 끝났다고 그리면 반대 방향의 거짓이 된다.
       */
      endedAt: string | null;
    };

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
      // 이 발화가 **바로 앞 진행 묶음을 끝내는가**. 저자가 같아야 한다(`endedAt` 주석).
      // 한 번만 찍는다 — 두 번째 발화가 시각을 덮으면 진행이 나중까지 이어진 것처럼 보인다.
      const prev = slots[slots.length - 1];
      if (prev?.kind === 'progress' && prev.endedAt === null
          && prev.messages[0]!.authorId === m.authorId) {
        prev.endedAt = m.createdAt;
      }
      slots.push({ kind: 'message', message: m });
      continue;
    }
    const last = slots[slots.length - 1];
    if (last?.kind === 'progress' && last.messages[0]!.authorId === m.authorId) {
      last.messages.push(m);
    } else {
      slots.push({ kind: 'progress', messages: [m], endedAt: null });
    }
  }
  return slots;
}

/**
 * 이 묶음의 경과가 **말할 만한가**. `null` 이면 아무 말도 안 한다.
 *
 * ## 서식이 아니라 정책만 남았다(`#619` 후속)
 *
 * 여기 있던 `elapsedLabel(startedAt, now)` 이 `daemonFacts.ts` 의 같은 이름 함수와
 * **두 벌**이었다(시그니처만 달랐다). 둘의 공통은 "ms 를 단위로 갈라 그 언어의 말로
 * 적는다" 하나였고 그것을 `lib/time.ts::durationLabel` 로 합쳤다 — 갈래를 만들던 셋은
 * 전부 **부르는 쪽의 정책**이었기 때문이다(그 함수 주석의 표).
 *
 * 이 자리의 정책이 이 함수다: **1분 미만이면 자리를 비운다.** 갓 시작한 것에 "0분째"를
 * 붙이면 숫자가 정보가 아니라 잡음이고, 그것은 규칙 06 이 말하는 0 을 그리는 짓이다.
 * (`daemonFacts` 쪽은 반대다 — 그쪽은 행이 서야 하므로 `방금` 이라고 **말한다**.)
 *
 * **묶음의 첫 progress 를 기준으로 잰다** — 마지막을 쓰면 30초마다 갱신하는 러너의
 * "3분째"가 영원히 "0분째"로 보인다(그 러너가 3분째 돌고 있다는 것이 이 줄이 말해야
 * 하는 유일한 사실이다).
 *
 * `now` 를 인자로 받는 이유: 시간을 읽는 함수는 테스트가 시간을 정할 수 있어야 한다.
 */
export function elapsedMs(startedAt: string, now: number): number | null {
  const ms = now - new Date(startedAt).getTime();
  if (!Number.isFinite(ms) || ms < 60_000) return null;
  return ms;
}
