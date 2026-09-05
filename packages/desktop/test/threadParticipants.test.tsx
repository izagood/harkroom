// Task 8 Step 3·4 — 참여자 줄과 터미널 선택자.
//
// 세션은 **(에이전트, 스레드)당 하나**이므로 문은 스레드에 달리고, 여럿이 일하면 문도
// 여럿이라 손잡이는 버튼이 아니라 선택자여야 한다. 소유자가 아닌 에이전트는 그 목록에
// **아예 없다** — 비활성이 아니라 부재다(규칙 06).
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { render, screen, cleanup, fireEvent } from '@testing-library/react';
import { useActiveStore as useAppStore } from '../src/state/communities';
import { ThreadParticipants } from '../src/components/ThreadParticipants';
import { acc, msg } from './helpers/fakeApi';

const ME = 'u-me';
const MINE = 'a-mine';      // 내가 소유자 — 터미널을 열 수 있다
const THEIRS = 'a-theirs';  // 남이 소유자 — 목록에 없어야 한다

const thread = [
  msg('m1', 'c1', 1, '부탁', ME),
  msg('m2', 'c1', 2, '맡는다', MINE),
  msg('m3', 'c1', 3, '나도', THEIRS),
  msg('m4', 'c1', 4, '끝났다', MINE),
];

const setup = (isAdmin = false) => {
  useAppStore.getState().reset();
  useAppStore.getState().set({
    me: acc(ME, 'jaebin', 'human', isAdmin),
    accounts: {
      [ME]: acc(ME, 'jaebin'),
      [MINE]: acc(MINE, 'mine', 'agent', false, { ownerAccountId: ME }),
      [THEIRS]: acc(THEIRS, 'theirs', 'agent', false, { ownerAccountId: 'someone-else' }),
    },
  });
};

beforeEach(() => setup());
afterEach(() => cleanup());

describe('ThreadParticipants — 참여자 줄', () => {
  it('사람은 빼고 에이전트만, 등장 순서대로 선다', () => {
    render(<ThreadParticipants messages={thread} live={new Set([MINE, THEIRS])} />);
    expect(screen.getByTestId('participant-mine')).toBeTruthy();
    expect(screen.getByTestId('participant-theirs')).toBeTruthy();
    expect(screen.queryByTestId('participant-jaebin')).toBeNull();
  });

  it('응답 없는 에이전트는 흐리다', () => {
    render(<ThreadParticipants messages={thread} live={new Set([MINE])} />);
    expect(screen.getByTestId('participant-mine').dataset.alive).toBe('true');
    expect(screen.getByTestId('participant-theirs').dataset.alive).toBe('false');
  });

  it('생존을 모르면 흐리게 하지 않는다 — 모른다는 이유로 죽은 것처럼 보이면 안 된다', () => {
    render(<ThreadParticipants messages={thread} live={null} />);
    for (const h of ['mine', 'theirs']) {
      expect(screen.getByTestId(`participant-${h}`).dataset.alive).toBe('unknown');
    }
  });

  it('에이전트가 없으면 줄 자체가 없다', () => {
    render(<ThreadParticipants messages={[msg('m1', 'c1', 1, '혼잣말', ME)]} live={null} />);
    expect(screen.queryByTestId('thread-participants')).toBeNull();
  });
});

describe('ThreadParticipants — 터미널 선택자', () => {
  it('내가 소유자인 에이전트만 목록에 든다 — 남의 것은 부재다', () => {
    render(<ThreadParticipants messages={thread} live={null} />);
    fireEvent.click(screen.getByTestId('terminal-picker'));
    expect(screen.getByTestId('terminal-open-mine')).toBeTruthy();
    // 남의 러너 셸이 여기 있다는 사실 자체가 새면 안 된다.
    expect(screen.queryByTestId('terminal-open-theirs')).toBeNull();
  });

  it('admin 은 남의 것도 연다 — 서버의 checkOwnerOrAdmin 과 같은 판정이다', () => {
    setup(true);
    render(<ThreadParticipants messages={thread} live={null} />);
    fireEvent.click(screen.getByTestId('terminal-picker'));
    expect(screen.getByTestId('terminal-open-theirs')).toBeTruthy();
  });

  it('고를 것이 하나도 없으면 손잡이 자체가 없다 — 0 은 자리를 차지하지 않는다', () => {
    render(
      <ThreadParticipants
        messages={[msg('m1', 'c1', 1, 'a', THEIRS)]}
        live={null}
      />,
    );
    expect(screen.getByTestId('thread-participants')).toBeTruthy();
    expect(screen.queryByTestId('terminal-picker')).toBeNull();
  });

  it('고르면 그 에이전트의 마지막 메시지로 세션 키를 낸다', () => {
    render(<ThreadParticipants messages={thread} live={null} />);
    fireEvent.click(screen.getByTestId('terminal-picker'));
    fireEvent.click(screen.getByTestId('terminal-open-mine'));
    // #98 앵커식: threadRootId 가 null 인 채널 최상위 메시지는 그 자신이 루트다.
    expect(useAppStore.getState().terminalTarget).toEqual({
      agentAccountId: MINE, channelId: 'c1', threadRootId: 'm4',
    });
  });
});
