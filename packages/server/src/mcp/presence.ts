import { emitEvent } from '../events.js';

/**
 * 에이전트의 온라인 presence. 인메모리이고 DB 에 남기지 않는다.
 *
 * 에이전트는 WebSocket 을 쓰지 않고 inbox.poll (최대 25초 long-poll) 을 계속 부르는 것이
 * 유일한 주기 신호다. 폴 자체가 presence 신호이므로 폴이 오면 mark() 하고, TTL 이 지나면
 * 오프라인으로 판단한다.
 *
 * **만료가 핵심이다.** 폴을 멈춘 에이전트는 "없는 것을 있다"고 표시하면 안 된다.
 * design.md 4절: "없는 것을 있다고 표시하지 않는다".
 *
 * 앱 인스턴스마다 자기 상태를 갖도록 factory 로 만든다. 모듈 전역 상태를 쓰면:
 * - 테스트에서 앱 둘이 상태를 공유한다.
 * - 첫 앱의 onClose 가 둘째 앱의 스윕까지 지운다.
 *
 * TTL 과 스윕 주기 설계:
 * - 폴 간격이 최대 25초이므로 TTL 은 그보다 넉넉해야 한다. 30초로 잡으면 1번의 폴 실패를
 *   감당한다. 2번 연속 실패는 죽은 것이니 30초가 적절하다.
 * - 스윕 주기는 TTL / 2 로 잡으면 15초마다 확인하고, 최대 30+15=45초에 오프라인 처리된다.
 * - 45초 동안 메시지를 안 받는 에이전트는 응답할 수 없는 것이니 표시하지 않는 것이 맞다.
 */

export interface AgentPresence {
  /** 에이전트가 폴을 부름을 기록하거나 창을 연장한다. */
  mark(accountId: string): void;
  /** 지금 온라인인 에이전트 목록. 만료된 항목은 읽는 김에 정리한다. */
  online(): string[];
  /** 스윕을 시작한다. 만료된 항목을 정리하고 presence.changed 이벤트를 발행한다. */
  startSweep(app: SweepHost): void;
  /** 스윕을 강제로 한 번 돌린다(테스트용). */
  sweep(): void;
  /** 보관 중인 에이전트 수. 만료 정리가 실제로 도는지 확인하는 데만 쓴다. */
  size(): number;
}

/**
 * 스윕 인터벌을 정리해 줄 수 있는 것. fastify 의 `FastifyInstance` 를 그대로 받지 않고
 * 필요한 만큼만 좁게 요구한다 — 이 모듈은 순수하게 유지해 `presence.test.ts` 가 서버를
 * 띄우지 않고 만료를 검증할 수 있어야 한다.
 */
export interface SweepHost {
  addHook(hook: 'onClose', fn: () => void | Promise<void>): void;
}

/**
 * 에이전트 presence 레지스트리를 만든다.
 *
 * @param opts.ttlMs - 에이전트 온라인 상태의 수명(밀리초). 기본 30초.
 * @param opts.now - 현재 시각을 반환하는 함수. 테스트에서만 주입한다.
 */
export function createAgentPresence(opts: { ttlMs: number; now?: () => number }): AgentPresence {
  const now = opts.now ?? Date.now;
  // accountId → 만료 시각
  const byAgent = new Map<string, number>();
  let sweepInterval: ReturnType<typeof setInterval> | null = null;

  /**
   * 만료된 항목을 읽는 김에 정리한다. 이 함수는 online() 읽기 경로에서만 불린다.
   * sweeper 는 별도로 돌아가며, 만료된 항목에 대해 presence.changed 이벤트를 발행한다.
   */
  const cleanup = (seen: Map<string, number>) => {
    const t = now();
    const expired: string[] = [];
    for (const [accountId, expires] of seen) {
      if (expires <= t) {
        seen.delete(accountId);
        expired.push(accountId);
      }
    }
    return expired;
  };

  /**
   * 스윕: 만료된 항목을 찾고 presence.changed 이벤트를 발행한다.
   * 읽기 경로(online())가 이미 정리를 하므로, sweeper 는 이벤트를 발행하는 목적으로만
   * 존재한다. 이미 접속해 있는 클라이언트에게 "오프라인이 됐다"를 알릴 주체가 필요하다.
   */
  const sweep = () => {
    const expired = cleanup(byAgent);
    for (const accountId of expired) {
      // 만료된 에이전트가 여전히 남아 있을 수 있다(online() 호출 안 한 클라이언트).
      // 중복 발행을 방지하기 위해 실제로 삭제된 항목만 처리한다.
      emitEvent({ type: 'presence.changed', accountId, online: false });
    }
  };

  return {
    mark(accountId) {
      const wasPresent = byAgent.has(accountId);
      byAgent.set(accountId, now() + opts.ttlMs);
      if (!wasPresent) {
        emitEvent({ type: 'presence.changed', accountId, online: true });
      }
    },

    online() {
      const expired = cleanup(byAgent);
      for (const accountId of expired) {
        emitEvent({ type: 'presence.changed', accountId, online: false });
      }
      return [...byAgent.keys()];
    },

    startSweep(app) {
      if (sweepInterval) return;
      const intervalMs = opts.ttlMs / 2;
      sweepInterval = setInterval(sweep, intervalMs);
      // 이 스윕만으로 프로세스를 살려 두지 않는다. 서버가 살아 있으면 HTTP 리스너가
      // 이미 이벤트 루프를 붙잡고 있고, 서버를 닫고도 남는 인터벌은 테스트 프로세스가
      // 끝나지 못하게 만든다(onClose 를 부르지 않는 테스트가 하나만 있어도 그렇다).
      sweepInterval.unref?.();
      app.addHook('onClose', async () => {
        if (sweepInterval) {
          clearInterval(sweepInterval);
          sweepInterval = null;
        }
      });
    },

    sweep() {
      sweep();
    },

    size() {
      return byAgent.size;
    },
  };
}