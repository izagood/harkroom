/**
 * **릴레이가 조용히 죽지 않는다.**
 *
 * 이 회귀선이 왜 있는가: 배포된 러너에서 릴레이가 한 번도 붙지 않았는데 **몇 달간 아무도
 * 몰랐다.** 번들이 `ws` 를 로드하지 못해(ESM 산출물에 `require` 가 없었다) dial 이 매번
 * 모듈 초기화에서 던졌고, `nodeWsDialer` 의 `.catch(() => handlers.onClose())` 가 그 예외를
 * 통째로 삼켰다. 러너 로그에도, 서버 로그에도 흔적이 없었다 — 재시도만 영원히 돌았다.
 *
 * 번들은 `sidecar.mjs` 의 배너가 고쳤다. 여기서 닫는 것은 **그것을 숨긴 쪽**이다:
 * 붙지 못하는 릴레이는 사람이 볼 수 있는 말을 한 번 남겨야 한다.
 *
 * ## 왜 "한 번"인가
 *
 * 재시도마다 찍으면 서버가 며칠 내려간 러너의 로그가 같은 줄로 가득 차고, 그러면 그
 * 줄은 다시 안 읽히는 말이 된다 — 삼키는 것과 실질이 같아진다. 그래서 **한 번의 장애에
 * 한 줄**이다: 붙지 못하기 시작할 때 찍고, 다시 붙을 때까지 조용하다.
 *
 * ## 왜 '못 붙었다'와 '붙었다 끊겼다'를 가르는가
 *
 * 둘 다 재접속 대상이라는 점은 같지만(그래서 `onClose` 하나로 받는다) **사람이 할 일이
 * 다르다.** 끊긴 것은 대개 서버 재시작이고 곧 돌아온다. 애초에 못 붙는 것은 배선이
 * 틀렸다는 뜻이고, 이 결함이 정확히 그것이었다.
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
import { createRelayClient, type RelayHandlers, type RelayTransport } from '../src/relay.js';

/** dial 마다 핸들러를 붙잡아 두고 테스트가 소켓의 생애를 직접 돌린다. */
function fakeDialer() {
  const dials: { handlers: RelayHandlers }[] = [];
  return {
    dial: (_url: string, _pat: string, handlers: RelayHandlers) => { dials.push({ handlers }); },
    dials,
    open: (index = dials.length - 1): RelayTransport => {
      const transport: RelayTransport = { send: () => {}, close: () => {} };
      dials[index]!.handlers.onOpen(transport);
      return transport;
    },
    fail: (reason?: string, index = dials.length - 1) => dials[index]!.handlers.onClose(reason),
  };
}

afterEach(() => { vi.restoreAllMocks(); });

describe('붙지 못하는 릴레이', () => {
  it('첫 실패를 이유와 함께 알린다', () => {
    const err = vi.spyOn(console, 'error').mockImplementation(() => {});
    const d = fakeDialer();
    createRelayClient({
      murmurUrl: 'http://x', pat: 'p', dial: d.dial, schedule: () => {},
    }).start();

    d.fail('Dynamic require of "events" is not supported');

    expect(err).toHaveBeenCalledTimes(1);
    expect(err.mock.calls[0]!.join(' ')).toContain('Dynamic require of "events"');
  });

  it('재시도마다 같은 말을 반복하지 않는다', () => {
    const err = vi.spyOn(console, 'error').mockImplementation(() => {});
    const d = fakeDialer();
    // 예약을 즉시 터뜨려 재시도가 실제로 여러 번 돌게 한다.
    createRelayClient({
      murmurUrl: 'http://x', pat: 'p', dial: d.dial, schedule: (fn) => { fn(); },
    }).start();

    d.fail('boom', 0);
    const afterFirst = err.mock.calls.length;
    d.fail('boom');
    d.fail('boom');

    expect(afterFirst).toBe(1);
    expect(err).toHaveBeenCalledTimes(1);
  });

  it('붙었다 끊긴 것은 못 붙은 것과 다르게 다룬다 — 다시 붙지 못하면 새 장애다', () => {
    const err = vi.spyOn(console, 'error').mockImplementation(() => {});
    const d = fakeDialer();
    createRelayClient({
      murmurUrl: 'http://x', pat: 'p', dial: d.dial, schedule: () => {},
    }).start();

    d.open();          // 한 번 붙었다
    d.fail('dropped'); // 끊겼다 — 서버 재시작이면 흔한 일이라 장애로 외치지 않는다
    expect(err).not.toHaveBeenCalled();

    d.fail('still down'); // 그런데 다시 붙지도 못한다 — 이제는 사람이 알아야 한다
    expect(err).toHaveBeenCalledTimes(1);
    expect(err.mock.calls[0]!.join(' ')).toContain('still down');
  });
});
