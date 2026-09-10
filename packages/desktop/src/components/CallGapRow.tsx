import { useEffect, useMemo, useState } from 'react';
import type { MessageRow } from '@murmur/shared';
import { useActiveStore } from '../state/communities';
import { callGap, type CallGapDetail } from '../lib/callGap';
import type { MessageKey } from '../i18n';
import { useT } from '../i18n/useT';

/**
 * **불렀는데 아무 일도 안 일어난다** — 부른 자리 바로 아래의 한 줄.
 *
 * 판정은 전부 `lib/callGap.ts` 에 있고(왜 이 자리인지, 왜 상태바도 팝업도 아닌지 포함),
 * 여기서는 그리는 일만 한다. `NotifiedGapRow` 와 같은 결의 줄이다 — 말풍선이 아니라
 * **상태 한 줄**(규칙 02)이라 리액션·툴바·스레드 컨트롤을 달지 않는다.
 */

/**
 * 이 줄이 서기까지의 침묵. **30초**인 이유는 양쪽 실패의 값이 다르기 때문이다: 짧으면
 * 멀쩡한 러너의 착수 지연까지 붙잡아 모든 멘션이 이 줄을 켰다 끄고(그 깜빡임이 곧 무시되는
 * 신호가 된다), 길면 사람이 그 전에 이미 "왜 안 하지?" 를 지나 다시 부른다 — 실측된 그
 * 되부름이 이 줄이 막으려는 것이다.
 */
export const CALL_GAP_QUIET_MS = 30_000;

/**
 * **표는 남기고 값은 사전 키로**(`NotifiedGapRow::LABEL` 의 선례). 상수가 문구를 들면
 * 모듈이 로드될 때 그 언어로 굳어 `useT` 가 닿지 못한다.
 *
 * 네 문구가 전부 **"그래서 어떻게 되는가"로 끝난다**. 상태만 말하면 이 줄은 놀라게만 하고
 * 끝나고(규칙 05 — 개입 비용), 사람이 다음에 하는 일은 여전히 **다시 부르기**다. 부름이
 * 인박스에 남아 있다는 사실을 말해 주는 것이 이 줄의 실질이다.
 */
const LABEL: Record<CallGapDetail, MessageKey> = {
  restarting: 'message.callGap.restarting',
  stopped: 'message.callGap.stopped',
  attention: 'message.callGap.attention',
  offline: 'message.callGap.offline',
};

export function CallGapRow({ message }: { message: MessageRow }) {
  const t = useT();
  const accounts = useActiveStore((s) => s.accounts);
  const runnerStates = useActiveStore((s) => s.runnerStates);
  const channelMessages = useActiveStore((s) => s.messages[message.channelId]);
  // 생존 판정의 두 축 — `connected` 가 false 면 `online` 은 '아무도 없다'가 아니라 '모른다'다.
  const online = useActiveStore((s) => s.online);
  const connected = useActiveStore((s) => s.connected);

  /**
   * 침묵을 재려면 **시계가 한 번은 돌아야 한다.** 스토어만 구독하면 러너 상태가 바뀔 때는
   * 다시 그리지만 "30초가 지났다" 는 아무도 알려 주지 않아, 조용한 부름의 줄이 다음 발화가
   * 올 때까지 안 선다 — 그 다음 발화가 없는 것이 정확히 이 줄이 말하려는 상황이다.
   *
   * 그래서 **남은 시간만큼 한 번** 깨운다. 주기 타이머가 아닌 이유: 이 줄은 한 번 서면
   * 지워질 때까지 문구가 안 바뀌므로(경과 시간을 세지 않는다) 그 뒤의 tick 은 전부 낭비다.
   */
  const [now, setNow] = useState(() => Date.now());
  const sentAt = new Date(message.createdAt).getTime();
  useEffect(() => {
    const remaining = sentAt + CALL_GAP_QUIET_MS - Date.now();
    if (remaining <= 0) return;
    const timer = setTimeout(() => setNow(Date.now()), remaining);
    return () => clearTimeout(timer);
  }, [sentAt]);

  const gap = useMemo(() => callGap({
    message,
    accounts,
    channelMessages: channelMessages ?? [],
    runnerStates,
    live: connected ? new Set(online) : null,
    now: Math.max(now, Date.now()),
    quietMs: CALL_GAP_QUIET_MS,
  }), [message, accounts, channelMessages, runnerStates, connected, online, now]);

  if (!gap) return null;

  return (
    <div
      data-testid="call-gap"
      data-detail={gap.detail}
      /*
       * **강조색을 쓰지 않는다**(규칙 04, `test/accentBudget`). 강조는 나를 막는 것에만
       * 준다 — 이것은 내 차례가 아니고, 내가 답해야 풀리는 것도 아니다. `warning` 인 것은
       * `RunnerStatus.tsx::TONE` 이 이미 적은 판단과 같다: "러너 쪽에 사정이 있고 사람이
       * 알아야 한다." `state-stuck`(실패 축)도 아니다 — 에이전트가 못 끝낸 것이 아니라
       * 아직 시작을 안 했다.
       */
      className="mt-0.5 text-meta text-warning"
      role="status"
    >
      {t(LABEL[gap.detail], { handle: gap.handle })}
    </div>
  );
}

/*
 * **버튼이 없다 — 없는 문은 그리지 않는다**(규칙 06).
 *
 * "다시 부르기" 를 달고 싶어지는 자리다. 달면 안 된다: 부름은 이미 인박스에 있고, 한 번
 * 더 부르면 러너가 돌아왔을 때 **같은 일을 두 턴이** 한다. 이 줄의 목적이 바로 그 되부름을
 * 막는 것이므로, 그것을 버튼으로 세우면 줄이 스스로를 무효로 만든다.
 *
 * `attention` 만은 사람이 할 일이 있는데(설정 › 에이전트), 그 문은 문구가 가리킨다.
 * 여기서 버튼으로 세우지 않는 것은 네 갈래 중 하나에만 서는 컨트롤이 나머지 셋에서
 * 빈자리로 남아, 줄의 높이가 상태마다 달라지기 때문이다.
 */
