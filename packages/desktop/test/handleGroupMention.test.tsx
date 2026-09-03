import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { render, screen, cleanup } from '@testing-library/react';
import { useAppStore } from '../src/state/appStore';
import { Controller, setController } from '../src/state/controller';
import { MessageItem } from '../src/components/MessageItem';
import { splitMentions } from '../src/lib/mention';
import { acc, chan, fakeApi, fakeWsFactory, grp, msg, accountsResult } from './helpers/fakeApi';

/**
 * #230 회귀선 9: 집합 멘션이 **사람 멘션과 구분돼 보인다.**
 *
 * 왜 필요한가는 두 방향이다. `splitMentions` 는 "존재하는 handle 만 칠한다" — 집합을 그
 * 목록에 넣지 않으면 집합 멘션이 평범한 글자로 보이고, 사람은 알림이 안 갔다고 믿는다
 * (`MessageBody` 주석이 그 반대의 거짓말을 이미 경고한다). 그리고 칠하되 사람과 똑같이
 * 칠하면 이번엔 반대로 한 사람을 부른 줄 알고 쓴 말이 여러 사람에게 간다.
 */

const show = (body: string) =>
  render(<MessageItem message={msg('m1', 'c1', 1, body, 'u2')} />);

beforeEach(() => {
  useAppStore.getState().reset();
  useAppStore.getState().set({
    me: acc('u1', 'me'),
    accounts: {
      u1: acc('u1', 'me'),
      u2: acc('u2', 'someone'),
      a1: acc('a1', 'fizz', 'agent'),
    },
    groups: [grp('g1', 'oncall', 'On-call')],
  });
});
afterEach(() => { cleanup(); setController(null as unknown as Controller); });

describe('집합 멘션 표시 (#230)', () => {
  it('집합 handle 을 칠한다 — 존재하는 이름이므로', () => {
    show('@oncall 서버가 죽었다');

    const mention = screen.getByTestId('mention-oncall');
    expect(mention.textContent).toBe('@oncall');
    // 색만으로 구분하지 않는다 — 배경과 굵기를 함께 쓴다.
    expect(mention.className).toMatch(/font-medium/);
  });

  it('집합 멘션에는 집합임을 나타내는 표시가 붙는다', () => {
    show('@oncall 서버가 죽었다');

    expect(screen.getByTestId('mention-oncall').getAttribute('data-group')).toBe('true');
  });

  it('사람 멘션에는 그 표시가 붙지 않고, 배경도 다르다', () => {
    show('@fizz 이거 봐줘');

    const person = screen.getByTestId('mention-fizz');
    expect(person.getAttribute('data-group')).toBe('false');

    cleanup();
    useAppStore.getState().set({ groups: [grp('g1', 'oncall', 'On-call')] });
    show('@oncall 이거 봐줘');
    const group = screen.getByTestId('mention-oncall');

    // 같은 자리에서 사람과 집합이 **같은 클래스**면 사람은 한 명을 부른 줄 안다.
    expect(group.className).not.toBe(person.className);
  });

  it('집합에 없는 이름은 칠하지 않는다 — 오타가 멘션처럼 보이면 안 된다', () => {
    show('@notagroup 안녕');

    expect(screen.queryByTestId('mention-notagroup')).toBeNull();
  });

  it('본문은 그대로 남는다 — 치환하지 않는다', () => {
    show('@oncall 서버가 죽었다');

    expect(screen.getByTestId('message-body').textContent).toBe('@oncall 서버가 죽었다');
  });

  // `splitMentions` 자체의 계약. 컴포넌트를 지나지 않고 규칙만 확인한다.
  it('splitMentions 가 집합만 isGroup 으로 표시한다', () => {
    const parts = splitMentions('@fizz 랑 @oncall 둘 다', ['fizz'], undefined, ['oncall']);
    const mentions = parts.filter((p) => p.kind === 'mention');

    expect(mentions.map((m) => [m.handle, m.isGroup === true]))
      .toEqual([['fizz', false], ['oncall', true]]);
  });
});

/**
 * 배선 확인. 위 테스트들은 스토어에 집합을 손으로 심으므로 "집합 목록이 서버에서 화면까지
 * 오는가"에 닿지 않는다 — 그 자리는 컨트롤러다. `GET /accounts` 가 계정과 집합을 함께
 * 주는 모양(#230)을 진짜 `Controller` 로 확인한다.
 */
describe('집합 목록 배선 (#230)', () => {
  it('start() 가 서버의 집합 목록을 스토어에 넣는다', async () => {
    useAppStore.getState().reset();
    const api = fakeApi({
      accounts: () => Promise.resolve(accountsResult(
        [acc('u1', 'me')], [grp('g1', 'oncall', 'On-call'), grp('g2', 'release', 'Release')],
      )),
      channels: () => Promise.resolve([chan('c1', 'general')]),
    });
    const c = new Controller(api, fakeWsFactory().makeWs);
    setController(c);

    await c.start();

    expect(useAppStore.getState().groups.map((g) => g.handle)).toEqual(['oncall', 'release']);
  });

  it('refreshAccounts 가 집합 목록도 갱신한다', async () => {
    useAppStore.getState().reset();
    // 처음에는 집합이 없다 — 그 뒤 서버에 하나 생긴다.
    let groups = [grp('g1', 'oncall', 'On-call')];
    const api = fakeApi({
      accounts: () => Promise.resolve(accountsResult([acc('u1', 'me')], groups)),
    });
    const c = new Controller(api, fakeWsFactory().makeWs);
    setController(c);

    await c.refreshAccounts({ force: true });
    expect(useAppStore.getState().groups.map((g) => g.handle)).toEqual(['oncall']);

    groups = [grp('g1', 'oncall', 'On-call'), grp('g2', 'release', 'Release')];
    await c.refreshAccounts({ force: true });
    expect(useAppStore.getState().groups.map((g) => g.handle)).toEqual(['oncall', 'release']);
  });
});
