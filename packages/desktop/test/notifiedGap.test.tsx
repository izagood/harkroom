import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { render, screen, cleanup } from '@testing-library/react';
import { NOTIFIED_COUNT_HEADER, NOTIFIED_HEADER } from '@murmur/shared';
import { useActiveStore as useAppStore } from '../src/state/communities';
import { Controller, setController, type Controller as ControllerType } from '../src/state/controller';
import { ApiClient } from '../src/lib/api';
import { readNotifiedHeaders, calledGroups, expectedWakes, notifiedSummary, type NotifiedResult } from '../src/lib/notified';
import { bodyRecipients } from '../src/lib/mention';
import { NotifiedGapRow } from '../src/components/NotifiedGapRow';
import { MessageItem } from '../src/components/MessageItem';
import { acc, accountsResult, fakeApi, fakeWsFactory, grp, msg } from './helpers/fakeApi';

/**
 * **집합 호출의 결과를 화면이 말한다** — 정본 문서 `docs/desktop-design-directions.html`.
 *
 * 진단: *"집합 호출의 결과가 안 보인다. 셋을 불러 둘만 깨어나도 화면은 아무 말도 하지
 * 않는다."*
 *
 * 이 회귀선이 지키는 것은 문구가 아니라 **판정**이다:
 * - 덜 깼을 때만 말한다(셋이 다 깨면 조용하다)
 * - '모른다'(헤더 없음)를 '없다'(0)로 읽지 않는다
 * - 명단이 잘려도 **수**로 말한다
 * - 서버가 정말 헤더를 싣는다(목이 아니라 배선을 재는 자리가 하나 있어야 한다)
 */

beforeEach(() => useAppStore.getState().reset());
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

const headers = (h: Record<string, string>) => new Headers(h);

describe('두 헤더를 읽는다 — 모른다와 없다는 다르다', () => {
  it('수 헤더가 없으면 null 이다 — 재생·옛 서버는 모른다', () => {
    expect(readNotifiedHeaders(headers({}))).toBeNull();
    // 명단만 있고 수가 없는 응답도 '모른다'로 읽는다 — 수가 정본이다.
    expect(readNotifiedHeaders(headers({ [NOTIFIED_HEADER]: 'u1,u2' }))).toBeNull();
  });

  it('아무도 안 불렀으면 count 0 이고 명단은 빈 배열이다', () => {
    const r = readNotifiedHeaders(headers({ [NOTIFIED_COUNT_HEADER]: '0' }));
    expect(r).toEqual({ count: 0, ids: [], truncated: false });
  });

  /**
   * 빈 문자열을 나누면 `['']` 가 되어 **없는 사람이 하나 생긴다**. 서버는 빈 헤더를 싣지
   * 않지만(테스트가 그것을 지킨다) 여기서도 막아 둔다 — 이 함수는 헤더의 출처를 모른다.
   */
  it('빈 명단 헤더에서 없는 사람을 만들지 않는다', () => {
    const r = readNotifiedHeaders(headers({ [NOTIFIED_COUNT_HEADER]: '0', [NOTIFIED_HEADER]: '' }));
    expect(r!.ids).toEqual([]);
  });

  /**
   * **명단이 잘려도 수는 정확하다** — 이것이 두 헤더의 분업이다
   * (`NOTIFIED_COUNT_HEADER` 주석: *"잘린 명단만 있으면 화면이 조용히 적은 수를 말한다"*).
   */
  it('명단이 총수보다 짧으면 잘린 것으로 표시한다', () => {
    const r = readNotifiedHeaders(headers({
      [NOTIFIED_COUNT_HEADER]: '120', [NOTIFIED_HEADER]: 'u1,u2,u3',
    }));
    expect(r).toEqual({ count: 120, ids: ['u1', 'u2', 'u3'], truncated: true });
  });

  it('망가진 수 헤더는 아는 척하지 않는다', () => {
    expect(readNotifiedHeaders(headers({ [NOTIFIED_COUNT_HEADER]: 'many' }))).toBeNull();
    expect(readNotifiedHeaders(headers({ [NOTIFIED_COUNT_HEADER]: '-1' }))).toBeNull();
  });
});

describe('몇 명을 불렀는가 — 집합만 센다', () => {
  const groups = [grp('g1', 'release', 'Release', 3), grp('g2', 'oncall', 'On-call', 2)];
  const called = (body: string) =>
    calledGroups(bodyRecipients(body, ['forge', 'jaebin'], ['release', 'oncall'], 'jaebin'), groups);

  it('집합을 부르면 그 구성원 수를 센다', () => {
    expect(expectedWakes(called('@release 훑어 줘'))).toBe(3);
  });

  it('집합을 안 부르면 null 이다 — 견줄 기준이 없다', () => {
    expect(expectedWakes(called('@forge 이것 좀 봐'))).toBeNull();
    expect(expectedWakes(called('혼잣말'))).toBeNull();
  });

  /**
   * `@channel` 은 **상한이 없다** — "그 채널을 볼 수 있는 계정 전부"이고 화면은 그 수를
   * 모른다. 모르는 수와 견주면 화면이 아는 척하게 된다.
   *
   * **`channel` 이라는 이름의 집합이 있는 경우로 잰다.** 그런 집합이 없으면 `calledGroups`
   * 가 `byHandle` 조회에서 어차피 걸러서, `kind` 판정을 통째로 지워도 초록이다 — RED 확인에서
   * 실제로 그렇게 새어 나갔다. 이 fixture 에서는 집합 조회가 성공하므로 **`kind` 판정만이**
   * `@channel` 을 막는다. (서버도 같은 순서로 갈린다: 계정이 이기고, 그다음 집합이다.)
   */
  it('@channel 은 세지 않는다 — 수를 모른다', () => {
    const withChannelGroup = [...groups, grp('g3', 'channel', 'Channel', 9)];
    const recipients = bodyRecipients('@channel 모두 보세요', ['forge', 'jaebin'], ['release', 'oncall'], 'jaebin');
    // `bodyRecipients` 가 이것을 `channel` 로 판정했다는 것부터 확인한다 — 그것이 전제다.
    expect(recipients.map((r) => r.kind)).toEqual(['channel']);
    expect(calledGroups(recipients, withChannelGroup)).toEqual([]);
    expect(expectedWakes(calledGroups(recipients, withChannelGroup))).toBeNull();
  });

  it('후보에 없는 집합 handle 은 0 으로 세지 않는다', () => {
    // `groups` 에 없는 handle 은 `bodyRecipients` 가 group 으로도 판정하지 않는다.
    expect(expectedWakes(called('@ghost 있나'))).toBeNull();
  });

  it('집합 둘을 부르면 수를 더한다', () => {
    expect(expectedWakes(called('@release @oncall 둘 다'))).toBe(5);
  });
});

describe('언제 말하는가 — 조용한 실패만', () => {
  const one = [{ handle: 'release', memberCount: 3, includesMe: false }];

  /**
   * **이 파일의 핵심 단언.** 문서: *"셋을 불렀는데 둘만 깨어난 것은 조용한 실패이고,
   * 지금 화면은 그것을 말할 자리가 없다."* 실패만 자리를 받는다.
   */
  it('셋을 불러 셋이 깨면 아무 말도 하지 않는다', () => {
    expect(notifiedSummary({ count: 3, ids: ['a', 'b', 'c'], truncated: false }, one)).toBeNull();
  });

  it('셋을 불러 둘만 깨면 그것을 말한다', () => {
    expect(notifiedSummary({ count: 2, ids: ['a', 'b'], truncated: false }, one))
      .toEqual({ called: 3, woke: 2, groupHandle: 'release' });
  });

  /**
   * 서버는 `thread_reply`·`dm` 으로 깬 사람도 같은 `notified` 에 담는다
   * (`services/messages.ts::postMessage`). 그래서 `woke > called` 는 흔한 정상이고
   * 실패가 아니다 — 그 방향으로 줄을 세우면 평범한 스레드 답글마다 줄이 뜬다.
   */
  it('부른 수보다 많이 깨도 말하지 않는다 — 다른 사유로 깬 사람이 있다', () => {
    expect(notifiedSummary({ count: 5, ids: [], truncated: false }, one)).toBeNull();
  });

  it('모르면 말하지 않는다 — 재생·옛 서버를 아무도 안 깼다고 읽지 않는다', () => {
    expect(notifiedSummary(null, one)).toBeNull();
  });

  it('집합을 안 불렀으면 말하지 않는다', () => {
    expect(notifiedSummary({ count: 0, ids: [], truncated: false }, [])).toBeNull();
  });

  /** 빈 집합을 부른 것은 조용한 실패가 아니다 — 부를 사람이 애초에 없었다. */
  it('빈 집합은 말하지 않는다', () => {
    expect(notifiedSummary({ count: 0, ids: [], truncated: false },
      [{ handle: 'empty', memberCount: 0, includesMe: false }])).toBeNull();
  });

  /**
   * 집합 둘을 부르면 **어느 집합에서 빠졌는지 모른다** — 화면은 명단을 받지 못한다.
   * 이름을 하나 골라 말하면 그것이 거짓일 수 있으므로 수만 말한다.
   */
  it('집합 둘을 부르면 이름을 말하지 않는다', () => {
    const two = [
      { handle: 'release', memberCount: 3, includesMe: false },
      { handle: 'oncall', memberCount: 2, includesMe: false },
    ];
    expect(notifiedSummary({ count: 4, ids: [], truncated: false }, two))
      .toEqual({ called: 5, woke: 4, groupHandle: null });
  });

  /**
   * 명단이 잘려도 **수로** 판정한다. `ids.length` 로 재면 100 명 넘는 집합을 부를 때마다
   * 조용한 실패가 뜬다 — 헤더가 자른 것을 실패로 읽는 것이다.
   */
  it('명단이 잘려도 수로 판정한다', () => {
    const big = [{ handle: 'everyone', memberCount: 120, includesMe: false }];
    expect(notifiedSummary({ count: 120, ids: ['a', 'b'], truncated: true }, big)).toBeNull();
  });
});

describe('컨트롤러가 부름의 결과를 스토어에 남긴다', () => {
  const withGroup = (notified: NotifiedResult) => fakeApi({
    accounts: vi.fn(async () => accountsResult(
      [acc('u1', 'admin'), acc('a1', 'forge', 'agent'), acc('a2', 'codex', 'agent')],
      [grp('g1', 'release', 'Release', 3)],
    )),
    postMessage: vi.fn(async () => ({ message: msg('m-post', 'c1', 99, '@release 훑어 줘', 'u1'), notified })),
  });

  it('덜 깬 발화에 한 줄을 남긴다', async () => {
    const c = new Controller(withGroup({ count: 2, ids: ['a1', 'a2'], truncated: false }), fakeWsFactory().makeWs);
    await c.start();
    await c.openChannel('c1');
    await c.send('@release 훑어 줘');

    expect(useAppStore.getState().notifiedGaps['m-post'])
      .toEqual({ called: 3, woke: 2, groupHandle: 'release' });
  });

  it('셋이 다 깨면 키를 만들지 않는다 — 화면은 조용하다', async () => {
    const c = new Controller(withGroup({ count: 3, ids: ['a1', 'a2', 'a3'], truncated: false }), fakeWsFactory().makeWs);
    await c.start();
    await c.openChannel('c1');
    await c.send('@release 훑어 줘');

    expect(useAppStore.getState().notifiedGaps).toEqual({});
  });

  it('헤더가 없으면(재생) 키를 만들지 않는다', async () => {
    const c = new Controller(withGroup(null), fakeWsFactory().makeWs);
    await c.start();
    await c.openChannel('c1');
    await c.send('@release 훑어 줘');

    expect(useAppStore.getState().notifiedGaps).toEqual({});
  });

  /** 스레드 답글도 집합을 부를 수 있다 — 채널 최상위만 재면 그 실패가 삼켜진다. */
  it('스레드 답글의 집합 호출도 잰다', async () => {
    const api = withGroup({ count: 1, ids: ['a1'], truncated: false });
    const c = new Controller(api, fakeWsFactory().makeWs);
    await c.start();
    await c.openChannel('c1');
    await c.reply('@release 훑어 줘', [], 'c1', 'root-1');

    expect(useAppStore.getState().notifiedGaps['m-post'])
      .toEqual({ called: 3, woke: 1, groupHandle: 'release' });
  });
});

describe('한 줄이 무엇을 말하는가', () => {
  beforeEach(() => {
    setController({ openThread: vi.fn(async () => undefined) } as unknown as ControllerType);
    useAppStore.getState().set({ me: acc('u1', 'admin'), accounts: { u1: acc('u1', 'admin') } });
  });

  it('덜 깼을 때 수를 말한다', () => {
    useAppStore.getState().set({
      notifiedGaps: { m1: { called: 3, woke: 2, groupHandle: 'release' } },
    });
    render(<NotifiedGapRow messageId="m1" />);

    const row = screen.getByTestId('notified-gap');
    expect(row.dataset.called).toBe('3');
    expect(row.dataset.woke).toBe('2');
    expect(row.textContent).toContain('@release');
    expect(row.textContent).toContain('3명을 불렀는데 2명만 깼다');
  });

  /** 사유를 함께 말한다 — 수만 말하면 놀라게만 하고 다음 수를 알려 주지 않는다(규칙 05). */
  it('왜 안 깼는지 말한다', () => {
    useAppStore.getState().set({
      notifiedGaps: { m1: { called: 3, woke: 2, groupHandle: 'release' } },
    });
    render(<NotifiedGapRow messageId="m1" />);
    expect(screen.getByTestId('notified-gap').textContent).toContain('채널을 볼 수 없다');
  });

  it('키가 없으면 아무것도 그리지 않는다', () => {
    render(<NotifiedGapRow messageId="m1" />);
    expect(screen.queryByTestId('notified-gap')).toBeNull();
  });

  it('집합을 둘 이상 불렀으면 이름 없이 수만 말한다', () => {
    useAppStore.getState().set({
      notifiedGaps: { m1: { called: 5, woke: 4, groupHandle: null } },
    });
    render(<NotifiedGapRow messageId="m1" />);
    const row = screen.getByTestId('notified-gap');
    expect(row.textContent).toContain('5명을 불렀는데 4명만 깼다');
    expect(row.textContent).not.toContain('@');
  });

  /**
   * **강조색을 받지 않는다**(규칙 04, `accentBudget.test.tsx` 가 예산을 잰다). 덜 깬 부름은
   * 나를 막지 않는다 — 깬 사람들은 이미 일하고 있고, 내 차례가 된 것도 아니다.
   * 실패 축(`state-stuck`)도 아니다: 못 끝낸 것이 아니라 일부가 빠진 것이다.
   */
  it('강조색도 실패색도 쓰지 않는다', () => {
    useAppStore.getState().set({
      notifiedGaps: { m1: { called: 3, woke: 2, groupHandle: 'release' } },
    });
    render(<NotifiedGapRow messageId="m1" />);
    const cls = screen.getByTestId('notified-gap').className;
    expect(cls).not.toContain('accent');
    expect(cls).not.toContain('stuck');
    expect(cls).not.toContain('danger');
  });

  /**
   * **부른 자리 바로 아래**다(문서의 목업). 헤더나 전역 띠에 두면 답을 기다리며 보는 곳에서
   * 눈이 닿지 않고, 연달아 두 집합을 부르면 뒤의 것이 앞의 것을 덮는다.
   */
  it('내가 보낸 메시지 아래에 붙는다', () => {
    useAppStore.getState().set({
      notifiedGaps: { m1: { called: 3, woke: 2, groupHandle: 'release' } },
    });
    render(<MessageItem message={msg('m1', 'c1', 1, '@release 훑어 줘', 'u1')} />);
    expect(screen.getByTestId('notified-gap')).not.toBeNull();
  });

  it('다른 메시지에는 붙지 않는다', () => {
    useAppStore.getState().set({
      notifiedGaps: { m1: { called: 3, woke: 2, groupHandle: 'release' } },
    });
    render(<MessageItem message={msg('m2', 'c1', 2, '평범한 말', 'u1')} />);
    expect(screen.queryByTestId('notified-gap')).toBeNull();
  });
});

/**
 * **배선을 잰다.** 위의 전부는 `readNotifiedHeaders` 를 직접 부르거나 `postMessage` 를 목으로
 * 바꾼다 — 그러면 `ApiClient` 가 헤더를 실제로 읽는지는 한 줄도 지키지 않는다. `api.test.ts`
 * 가 같은 태도를 적어 뒀다(*"화면 테스트는 목으로 바꾸므로 이 배선을 하나도 지키지 않는다"*).
 */
describe('ApiClient 가 응답 헤더를 실제로 읽는다', () => {
  const row = { id: 'm1', seq: 1, channelId: 'c1', threadRootId: null, authorId: 'u1', body: 'hi', kind: 'user', meta: {}, createdAt: 'now' };

  it('두 헤더를 봉투에 실어 낸다', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify(row), {
      status: 201,
      headers: {
        'content-type': 'application/json',
        [NOTIFIED_COUNT_HEADER]: '2',
        [NOTIFIED_HEADER]: 'a1,a2',
      },
    })));

    const res = await new ApiClient('http://x:3400', 'tok').postMessage('c1', '@release 훑어 줘');
    expect(res.message.id).toBe('m1');
    expect(res.notified).toEqual({ count: 2, ids: ['a1', 'a2'], truncated: false });
  });

  it('헤더가 없는 응답은 null 로 낸다 — 본문은 그대로 온다', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify(row), {
      status: 200, headers: { 'content-type': 'application/json' },
    })));

    const res = await new ApiClient('http://x:3400', 'tok').postMessage('c1', 'hi');
    expect(res.message.id).toBe('m1');
    expect(res.notified).toBeNull();
  });
});
