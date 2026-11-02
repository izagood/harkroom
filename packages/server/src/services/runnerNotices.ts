import type { SystemI18n } from '@harkroom/shared';
import { systemI18n } from './systemI18n.js';

/**
 * 러너가 스레드에 남기는 **알림 줄**(2026-11-02). 앞 턴 대기·임대 잃음·조종 대기 셋이다.
 *
 * ## 왜 서버가 문장을 쥐나
 *
 * 러너는 이 줄들을 일반 `message.post` 로 올렸고, 그러면 줄이 `kind: 'user'`·에이전트 author 로 저장된다 —
 * 사람에게는 에이전트가 직접 한 말로 보이고, 서버는 그것을 **에이전트의 결과**로 센다(회신권을 닫고, 열린 위임을
 * 「답 왔음」으로 닫고, 스레드의 「마지막 말」·참여자가 된다). 시스템 줄은 서버만 세우므로(`guardMetaI18n` 주석),
 * 러너는 **키만** 고르고 본문·번역 표지는 여기서 만든다. 자유 본문을 받지 않는 것이 요점이다 — 받으면 에이전트가
 * 아무 글이나 시스템 줄로 세울 수 있다.
 *
 * `serverNotice` 로 올린다: 회신권·위임 의무를 닫지 않는다(`postMessage` 의 `isResult`).
 */
export const RUNNER_NOTICE_KEYS = ['blocked_by_turn', 'fenced', 'controlled'] as const;
export type RunnerNoticeKey = (typeof RUNNER_NOTICE_KEYS)[number];

/** 조종 중인 사람의 handle. 러너가 주는 값이라 모양을 좁힌다 — 어긋나면 `controlledByOwner` 키로 물러난다. */
const HANDLE_RE = /^[A-Za-z0-9_.-]{1,64}$/;
/** 대기 건수 상한. 넘으면 상한으로 자른다(문장만 바뀐다). */
export const RUNNER_NOTICE_MAX_PENDING = 9999;

export interface RunnerNoticeArgs {
  /** `controlled` 만 — 조종을 연 사람의 handle. */
  handle?: string;
  /** `controlled` 만 — 이 멘션이 대기 몇 건째인지. */
  pending?: number;
}

/**
 * 본문(한국어 — 옛 앱·검색·푸시·에이전트가 읽는다)과 번역 표지를 **한 자리에서** 만든다(security C8).
 * 본문 문구는 러너가 올리던 옛 문구(`packages/agent/src/prompt.ts`·`mentionScheduler.ts`)와 같은 말이다.
 */
export function runnerNotice(
  key: RunnerNoticeKey, agentId: string, args: RunnerNoticeArgs = {},
): { body: string; i18n: SystemI18n } {
  switch (key) {
    case 'blocked_by_turn':
      return {
        body: '(이 스레드에서 앞 턴이 아직 돌고 있습니다 — 이 글은 그 턴이 끝나면 읽습니다. '
          + '바로 멈추려면 도는 턴 목록이나 그 턴의 터미널 창에서 「멈추기」를 누르세요)',
        i18n: systemI18n('system.runner.blockedByTurn', { agentId }),
      };
    case 'fenced':
      return {
        body: '(다른 러너가 이 스레드를 넘겨받아 이 턴을 접었다 — 이 러너가 서버와 끊긴 사이 스레드 임대가 만료됐다.'
          + ' 남은 일은 넘겨받은 쪽이 잇는다)',
        i18n: systemI18n('system.runner.fenced', { agentId }),
      };
    case 'controlled': {
      const handle = args.handle && HANDLE_RE.test(args.handle) ? args.handle : null;
      const pending = Math.min(Math.max(1, Math.trunc(args.pending ?? 1)), RUNNER_NOTICE_MAX_PENDING);
      return {
        body: `(지금 ${handle ?? '소유자'} 이(가) 직접 조종 중입니다 — 이 멘션은 대기 ${pending}건째입니다. `
          + '조종이 끝나면 처리합니다: 터미널에서 하네스를 종료하거나, Agents 탭에서 「조종 끝내기」)',
        // handle 을 모르면 따로 키를 둔다 — 「소유자/the owner」는 사전이 고른다(인자에 한 언어의 낱말을 넣지 않는다).
        i18n: handle
          ? systemI18n('system.runner.controlled', { agentId, handle, pending })
          : systemI18n('system.runner.controlledByOwner', { agentId, pending }),
      };
    }
  }
}
