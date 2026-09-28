import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { render, screen, cleanup, fireEvent, act } from '@testing-library/react';
import { useActiveStore as useAppStore } from '../src/state/communities';
import { Controller, setController } from '../src/state/controller';
import { MessageItem } from '../src/components/MessageItem';
import { ApiError } from '../src/lib/api';
import { acc, fakeApi, fakeWsFactory, grp, msg, tm } from './helpers/fakeApi';

/**
 * 팀·집합 멘션에 마우스를 올리면 명단 카드가 뜬다(`MentionCard`).
 * 사람이 묻는 것은 둘이다: **누가 들어 있나**, **누가 팀장인가**. 그리고 못 받은 명단을
 * "없다"로 그리지 않는다.
 */

const show = (body: string) =>
  render(<MessageItem message={msg('m1', 'c1', 1, body, 'u1')} />);

const hover = async (handle: string) => {
  vi.useFakeTimers();
  fireEvent.mouseEnter(screen.getByTestId(`mention-${handle}`).parentElement!);
  await act(async () => { vi.advanceTimersByTime(400); });
  vi.useRealTimers();
  await act(async () => { await Promise.resolve(); });
};

beforeEach(() => {
  useAppStore.getState().reset();
  useAppStore.getState().set({
    me: acc('u1', 'me'),
    accounts: {
      u1: acc('u1', 'me'),
      a1: acc('a1', 'fizz', 'agent'),
      a2: acc('a2', 'buzz', 'agent'),
    },
    groups: [grp('g1', 'oncall', 'On-call')],
    teams: [tm('t1', 'udc-team', 2, 'a2')],
  });
});
afterEach(() => { cleanup(); vi.useRealTimers(); setController(null as unknown as Controller); });

describe('멘션 호버 카드', () => {
  it('팀 멘션에 올리면 팀원과 팀장을 보여 준다 — 팀장이 맨 위', async () => {
    const team = vi.fn(async () => ({
      team: tm('t1', 'udc-team', 2, 'a2'),
      members: [
        { accountId: 'a1', handle: 'fizz', disabled: true },
        { accountId: 'a2', handle: 'buzz', disabled: false },
      ],
    }));
    setController(new Controller(fakeApi({ team }), fakeWsFactory().makeWs));
    show('@udc-team 계속 진행해');

    expect(screen.queryByTestId('hovercard')).toBeNull();
    await hover('udc-team');

    expect(team).toHaveBeenCalledWith('t1');
    const card = await screen.findByTestId('hovercard');
    expect(card.getAttribute('data-kind')).toBe('team');
    const rows = card.querySelectorAll('li');
    expect(rows[0]!.getAttribute('data-testid')).toBe('hovercard-member-buzz');
    expect(rows[0]!.getAttribute('data-lead')).toBe('true');
    expect(screen.getByTestId('hovercard-member-fizz').getAttribute('data-disabled')).toBe('true');
  });

  it('마우스를 떼면 닫힌다', async () => {
    setController(new Controller(fakeApi({
      team: vi.fn(async () => ({ team: tm('t1', 'udc-team', 0), members: [] })),
    }), fakeWsFactory().makeWs));
    show('@udc-team 봐');
    await hover('udc-team');
    await screen.findByTestId('hovercard');

    vi.useFakeTimers();
    fireEvent.mouseLeave(screen.getByTestId('mention-udc-team').parentElement!);
    await act(async () => { vi.advanceTimersByTime(300); });
    vi.useRealTimers();
    expect(screen.queryByTestId('hovercard')).toBeNull();
  });

  it('집합 명단이 403 이면 "없다" 가 아니라 볼 수 없다고 말한다', async () => {
    const getHandleGroup = vi.fn(async () => { throw new ApiError(403, 'forbidden', 'no'); });
    setController(new Controller(fakeApi({ getHandleGroup }), fakeWsFactory().makeWs));
    show('@oncall 서버가 죽었다');
    await hover('oncall');

    const card = await screen.findByTestId('hovercard');
    expect(card.getAttribute('data-kind')).toBe('group');
    expect(card.querySelectorAll('li').length).toBe(0);
    expect(card.textContent).not.toMatch(/No members|팀원 없음/);
  });

  it('사람 멘션에는 카드가 없다', () => {
    show('@fizz 봐줘');
    expect(screen.getByTestId('mention-fizz').parentElement!.getAttribute('data-testid')).not.toBe('hovercard-trigger');
  });
});
