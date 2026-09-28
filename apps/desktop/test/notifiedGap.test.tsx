import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { render, screen, cleanup } from '@testing-library/react';
import { NOTIFIED_COUNT_HEADER, NOTIFIED_HEADER } from '@harkroom/shared';
import { useActiveStore as useAppStore } from '../src/state/communities';
import { usePrefsStore } from '../src/state/prefsStore';
import { Controller, setController, type Controller as ControllerType } from '../src/state/controller';
import { ApiClient } from '../src/lib/api';
import { readNotifiedHeaders, calledGroups, expectedWakes, notifiedSummary, type CalledGroup, type NotifiedResult } from '../src/lib/notified';
import { bodyRecipients } from '../src/lib/mention';
import { NotifiedGapRow } from '../src/components/NotifiedGapRow';
import { MessageItem } from '../src/components/MessageItem';
import { acc, accountsResult, fakeApi, fakeWsFactory, grp, msg, tm } from './helpers/fakeApi';

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

beforeEach(() => {
  usePrefsStore.getState().setLocale('ko');
  useAppStore.getState().reset();
});
// **언어를 고정한다**(이 묶음의 문구가 사전을 지나면서 기본이 영어가 됐다). 이 파일이
// 재는 것은 언어가 아니라 **그 언어로 표현된 규율**이다 — 언어를 재는 자리는
// `i18n.test.tsx` 하나이고, 두 곳에서 재면 문구를 고칠 때 한쪽만 고쳐진다
// (`gallery.test.tsx`·`skillsSettings.test.tsx`·`agentGrid.test.tsx` 와 같은 규약).
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  usePrefsStore.getState().setLocale('system');
});

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

/**
 * ## 팀도 센다(#172)
 *
 * **이 절이 없으면 `#230` 의 유보가 되살아난다.** 그 이슈가 팀 멘션을 막은 사유는
 * *"턴 셋이 동시에 시작되고" 조용히 실패한다* 였고, 그 조용한 실패를 말하는 장치가 이
 * 모듈이다. 멘션만 열고 이 장치가 팀을 못 세면 팀은 부를 수 있으면서 덜 깬 것을 아무도
 * 말하지 않는 상태가 된다 — 정확히 그 유보가 걱정한 상태다.
 */
describe('몇 명을 불렀는가 — 팀도 센다', () => {
  const groups = [grp('g1', 'oncall', 'On-call', 2)];
  const teams = [tm('t1', 'release', 4), tm('t2', 'infra', 2)];
  // 팀 이름도 `groupHandles` 로 넘어간다 — 그 두 함수가 이 목록으로 하는 판정은
  // "한 사람이 아니다" 하나이고, 팀에도 그것이 맞다(`Composer.tsx::groupHandleList`).
  const called = (body: string) => calledGroups(
    bodyRecipients(body, ['forge', 'jaebin'], ['oncall', 'release', 'infra'], 'jaebin'),
    groups, teams,
  );

  it('팀을 부르면 팀원 수를 센다', () => {
    expect(called('@release 배포해라')).toEqual([
      { handle: 'release', memberCount: 4, includesMe: false, kind: 'team' },
    ]);
    expect(expectedWakes(called('@release 배포해라'))).toBe(4);
  });

  it('팀 둘을 부르면 수를 더한다', () => {
    expect(expectedWakes(called('@release @infra 둘 다'))).toBe(6);
  });

  /**
   * **팀장이 있는 팀은 하나만 깬다**(047) — 기대치도 1 이어야 한다.
   *
   * 이것을 안 고치면 이 모듈이 **거짓 경고를 단정한다**: 다섯 명 팀에서 팀장 하나가
   * 깨는 것이 정상인데 화면이 *"넷이 안 깼다"* 고 말한다. 그 거짓 경고는 아무 경고도 없는
   * 것보다 나쁘다 — 그때부터 사람은 이 줄을 믿지 않고, 진짜 조용한 실패도 함께 묻힌다.
   */
  it('팀장이 있는 팀은 기대치가 1 이다 — 하나만 깨는 것이 정상이다', () => {
    const led = [tm('t3', 'lednow', 5, 'a-lead')];
    const recipients = bodyRecipients('@lednow 배포해라', ['forge'], ['lednow'], null);
    expect(calledGroups(recipients, [], led)).toEqual([
      { handle: 'lednow', memberCount: 1, includesMe: false, kind: 'team' },
    ]);
    expect(expectedWakes(calledGroups(recipients, [], led))).toBe(1);
  });

  /**
   * 서버는 팀장이 **비활성**이면 전원으로 폴백한다. 그 판정을 화면이 흉내내지 않는다 —
   * 팀 행에 `disabled` 가 없으므로 알 수 없고, 안다 해도 같은 판정을 두 곳에서 하는 것이다.
   *
   * 그 어긋남이 **안전한 방향**이라는 것이 이 시험이 고정하는 사실이다: 기대치 1 인데
   * 다섯이 깨면 `woke > called` 라 요약은 `null` — 화면이 조용하다. 반대 방향(기대치를
   * 높게 잡아 거짓 경고)이 이 판정에서 유일하게 나쁜 쪽이다.
   */
  it('기대치보다 많이 깨면 조용하다 — 폴백을 화면이 흉내내지 않는 대가', () => {
    const led = [tm('t3', 'lednow', 5, 'a-lead')];
    const recipients = bodyRecipients('@lednow 배포해라', ['forge'], ['lednow'], null);
    const called5 = calledGroups(recipients, [], led);
    expect(notifiedSummary({ count: 5, ids: [], truncated: false }, called5)).toBeNull();
  });

  it('집합과 팀을 섞어 부르면 함께 센다', () => {
    expect(expectedWakes(called('@oncall @release 섞었다'))).toBe(6);
  });

  /**
   * `teams` 를 안 넘기면 팀 수를 세지 않는다 — 옛 서버(`teams` 없음)의 경로다. 0 으로
   * 세지 않는 것이 요점이다: 0 으로 세면 팀을 부른 모든 발화가 조용한 실패로 보인다.
   */
  it('팀 목록이 없으면 세지 않는다 — 0 으로 세지 않는다', () => {
    const recipients = bodyRecipients('@release 배포해라', ['forge'], ['release'], null);
    expect(expectedWakes(calledGroups(recipients, groups))).toBeNull();
  });

  /**
   * **이름이 겹치면 집합이 이긴다** — 서버의 해석 순서와 같아야 한다
   * (`services/messages.ts`: 계정 → 집합 → 팀). 세 네임스페이스가 배타가 아니라는 것을
   * 서버 테스트가 고정했으므로(`teamMention.test.ts`) 이 순서는 실제로 결과를 바꾼다.
   *
   * 여기서 팀을 이기게 두면 화면은 서버가 펼치지 않은 명단의 수와 견주게 되고, 그러면
   * 정상 발화가 조용한 실패로 보인다.
   */
  it('집합과 팀의 이름이 겹치면 집합의 수를 쓴다', () => {
    const clash = [grp('g9', 'release', 'Release 사람들', 2)];
    const recipients = bodyRecipients('@release 겹쳤다', ['forge'], ['release'], null);
    expect(calledGroups(recipients, clash, teams)).toEqual([
      { handle: 'release', memberCount: 2, includesMe: false, kind: 'group' },
    ]);
  });

  /**
   * **팀에서 `includesMe` 는 확실히 `false` 다** — 팀에는 에이전트만 들어가므로
   * (서버가 사람 계정을 `not_an_agent` 400 으로 거절한다) 사람인 내가 구성원일 수 없다.
   * 집합에서는 그 값이 "모르니까 이쪽으로 틀린다"였다 — 계산이 같아도 뜻이 다르다.
   */
  it('팀을 부른 사람은 그 팀의 구성원일 수 없다', () => {
    expect(called('@release 배포해라')[0]!.includesMe).toBe(false);
    // 그래서 팀원 수가 그대로 기대치다 — 자기 자신을 빼지 않는다.
    expect(expectedWakes(called('@release 배포해라'))).toBe(4);
  });
});

/**
 * 부른 명단 하나. `CalledGroup` 으로 못 박는 이유: 리터럴만 쓰면 `kind` 가 `string` 으로
 * 넓어져 함수 인자에 들어가지 않는다. 기본이 `'group'` 인 것은 이 파일 대부분이 집합의
 * 사실을 재기 때문이고, 팀은 그것을 명시한다.
 */
const cg = (
  handle: string, memberCount: number, kind: CalledGroup['kind'] = 'group',
): CalledGroup => ({ handle, memberCount, includesMe: false, kind });

describe('언제 말하는가 — 조용한 실패만', () => {
  const one = [cg('release', 3)];

  /**
   * **이 파일의 핵심 단언.** 문서: *"셋을 불렀는데 둘만 깨어난 것은 조용한 실패이고,
   * 지금 화면은 그것을 말할 자리가 없다."* 실패만 자리를 받는다.
   */
  it('셋을 불러 셋이 깨면 아무 말도 하지 않는다', () => {
    expect(notifiedSummary({ count: 3, ids: ['a', 'b', 'c'], truncated: false }, one)).toBeNull();
  });

  it('셋을 불러 둘만 깨면 그것을 말한다', () => {
    expect(notifiedSummary({ count: 2, ids: ['a', 'b'], truncated: false }, one))
      .toEqual({ called: 3, woke: 2, groupHandle: 'release', kind: 'group' });
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
      [cg('empty', 0)])).toBeNull();
  });

  /**
   * 집합 둘을 부르면 **어느 집합에서 빠졌는지 모른다** — 화면은 명단을 받지 못한다.
   * 이름을 하나 골라 말하면 그것이 거짓일 수 있으므로 수만 말한다.
   */
  it('집합 둘을 부르면 이름을 말하지 않는다', () => {
    const two = [cg('release', 3), cg('oncall', 2)];
    expect(notifiedSummary({ count: 4, ids: [], truncated: false }, two))
      .toEqual({ called: 5, woke: 4, groupHandle: null, kind: 'group' });
  });

  /**
   * 명단이 잘려도 **수로** 판정한다. `ids.length` 로 재면 100 명 넘는 집합을 부를 때마다
   * 조용한 실패가 뜬다 — 헤더가 자른 것을 실패로 읽는 것이다.
   */
  it('명단이 잘려도 수로 판정한다', () => {
    const big = [cg('everyone', 120)];
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
      .toEqual({ called: 3, woke: 2, groupHandle: 'release', kind: 'group' });
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
      .toEqual({ called: 3, woke: 1, groupHandle: 'release', kind: 'group' });
  });

  /**
   * **팀 호출도 같은 자리에서 잰다**(#172). 이것이 `#230` 의 유보가 실제로 풀렸는지를
   * 재는 줄이다: 서버가 팀을 펼쳐 넷을 불렀는데 둘만 깼다면 화면이 그것을 말해야 한다.
   *
   * `withTeam` 이 팀을 **`GET /accounts` 응답에** 싣는 것이 요점이다 — 그것이 자동완성
   * 후보이면서 이 수의 출처이기도 하고, 두 자리가 같은 목록을 보는 것이 이 설계다.
   */
  const withTeam = (notified: NotifiedResult) => fakeApi({
    accounts: vi.fn(async () => accountsResult(
      [acc('u1', 'admin'), acc('a1', 'forge', 'agent'), acc('a2', 'codex', 'agent')],
      [],
      [tm('t1', 'release', 4)],
    )),
    postMessage: vi.fn(async () => ({ message: msg('m-post', 'c1', 99, '@release 배포해라', 'u1'), notified })),
  });

  it('팀을 불러 덜 깼으면 한 줄을 남긴다 — 종류가 team 이다', async () => {
    const c = new Controller(withTeam({ count: 2, ids: ['a1', 'a2'], truncated: false }), fakeWsFactory().makeWs);
    await c.start();
    await c.openChannel('c1');
    await c.send('@release 배포해라');

    expect(useAppStore.getState().notifiedGaps['m-post'])
      .toEqual({ called: 4, woke: 2, groupHandle: 'release', kind: 'team' });
  });

  it('팀원 전원이 깨면 키를 만들지 않는다', async () => {
    const c = new Controller(withTeam({ count: 4, ids: ['a1', 'a2', 'a3', 'a4'], truncated: false }), fakeWsFactory().makeWs);
    await c.start();
    await c.openChannel('c1');
    await c.send('@release 배포해라');

    expect(useAppStore.getState().notifiedGaps).toEqual({});
  });
});

describe('한 줄이 무엇을 말하는가', () => {
  beforeEach(() => {
    setController({ openThread: vi.fn(async () => undefined) } as unknown as ControllerType);
    useAppStore.getState().set({ me: acc('u1', 'admin'), accounts: { u1: acc('u1', 'admin') } });
  });

  it('덜 깼을 때 수를 말한다', () => {
    useAppStore.getState().set({
      notifiedGaps: { m1: { called: 3, woke: 2, groupHandle: 'release', kind: 'group' } },
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
      notifiedGaps: { m1: { called: 3, woke: 2, groupHandle: 'release', kind: 'group' } },
    });
    render(<NotifiedGapRow messageId="m1" />);
    expect(screen.getByTestId('notified-gap').textContent).toContain('채널을 볼 수 없다');
  });

  /**
   * **팀에는 "팀" 이라고 말한다**(#172). 이름은 하나뿐이라 사람은 본문만 보고 그것이
   * 집합인지 팀인지 알 수 없고, 여기서 "집합" 이라고 부르면 팀 설정을 열어야 할 사람이
   * 집합 설정을 뒤진다.
   */
  it('팀을 불렀으면 팀이라고 말한다', () => {
    useAppStore.getState().set({
      notifiedGaps: { m1: { called: 4, woke: 2, groupHandle: 'release', kind: 'team' } },
    });
    render(<NotifiedGapRow messageId="m1" />);
    const row = screen.getByTestId('notified-gap');
    expect(row.dataset.kind).toBe('team');
    expect(row.textContent).toContain('팀 @release');
    expect(row.textContent).not.toContain('집합');
    expect(row.textContent).toContain('4명을 불렀는데 2명만 깼다');
  });

  /**
   * **팀의 사유는 둘이다** — 비활성이거나 채널을 못 본다. 집합의 문장을 그대로 쓰면
   * 꺼 둔 에이전트 때문에 뜬 줄이 "채널 멤버로 넣어야 한다"고 단정하고, 그러면 사람은
   * 이미 멤버인 계정을 다시 넣으려 한다(규칙 05 — 헛된 개입).
   */
  it('팀의 사유는 비활성도 말한다', () => {
    useAppStore.getState().set({
      notifiedGaps: { m1: { called: 4, woke: 2, groupHandle: 'release', kind: 'team' } },
    });
    render(<NotifiedGapRow messageId="m1" />);
    const text = screen.getByTestId('notified-gap').textContent ?? '';
    expect(text).toContain('비활성');
    expect(text).toContain('채널을 볼 수 없다');
  });

  /** 종류를 섞어 불렀으면 아무 쪽도 주장하지 않는다 — 이름도 사유도 단정할 수 없다. */
  it('집합과 팀을 섞어 불렀으면 종류를 주장하지 않는다', () => {
    useAppStore.getState().set({
      notifiedGaps: { m1: { called: 6, woke: 4, groupHandle: null, kind: null } },
    });
    render(<NotifiedGapRow messageId="m1" />);
    const text = screen.getByTestId('notified-gap').textContent ?? '';
    expect(text).toContain('6명을 불렀는데 4명만 깼다');
    expect(text).not.toContain('집합');
    expect(text).not.toContain('팀 ');
    expect(text).not.toContain('비활성');
  });

  it('키가 없으면 아무것도 그리지 않는다', () => {
    render(<NotifiedGapRow messageId="m1" />);
    expect(screen.queryByTestId('notified-gap')).toBeNull();
  });

  it('집합을 둘 이상 불렀으면 이름 없이 수만 말한다', () => {
    useAppStore.getState().set({
      notifiedGaps: { m1: { called: 5, woke: 4, groupHandle: null, kind: 'group' } },
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
      notifiedGaps: { m1: { called: 3, woke: 2, groupHandle: 'release', kind: 'group' } },
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
      notifiedGaps: { m1: { called: 3, woke: 2, groupHandle: 'release', kind: 'group' } },
    });
    render(<MessageItem message={msg('m1', 'c1', 1, '@release 훑어 줘', 'u1')} />);
    expect(screen.getByTestId('notified-gap')).not.toBeNull();
  });

  it('다른 메시지에는 붙지 않는다', () => {
    useAppStore.getState().set({
      notifiedGaps: { m1: { called: 3, woke: 2, groupHandle: 'release', kind: 'group' } },
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
