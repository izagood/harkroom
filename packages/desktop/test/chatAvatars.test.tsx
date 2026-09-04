import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { render, screen, cleanup } from '@testing-library/react';
import type { MessageRow } from '@murmur/shared';
import { useActiveStore as useAppStore } from '../src/state/communities';
import { setController, type Controller } from '../src/state/controller';
import { MessageItem } from '../src/components/MessageItem';
import { acc, msg } from './helpers/fakeApi';

const fakeController = () => {
  const c = {
    toggleReaction: vi.fn(async () => undefined),
    openThread: vi.fn(async () => undefined),
    editMessage: vi.fn(async () => undefined),
    deleteMessage: vi.fn(async () => undefined),
  };
  setController(c as unknown as Controller);
  return c;
};

beforeEach(() => {
  useAppStore.getState().reset();
  useAppStore.getState().set({
    me: acc('u1', 'me'),
    accounts: {
      u1: acc('u1', 'me'),
      u2: acc('u2', 'alice'),
      u3: acc('u3', 'bob'),
      u4: acc('u4', 'charlie'),
      u5: acc('u5', 'dave'),
      u6: acc('u6', 'eve'),
      u7: acc('u7', 'frank'),
    },
    messages: { c1: [] },
  });
});
afterEach(() => cleanup());

describe('#161 2단계 작성자 아바타 거터', () => {
  it('거터에 작성자 아바타가 Identity 를 통과해 표시된다', () => {
    fakeController();
    render(<MessageItem message={msg('m1', 'c1', 1, '안녕', 'u2')} />);

    const gutterAvatar = document.querySelector('.flex.h-8.w-8');
    expect(gutterAvatar).toBeTruthy();
    // 거터 아바타도 sr-only 텍스트로 접근성 이름을 갖는다.
    // #365 전에는 이름 옆 badge 가 같은 아바타를 한 번 더 그려 3개였다. 사람 badge 가
    // 아무것도 그리지 않게 되어 **이름줄의 handle + 거터 아바타의 sr-only = 2개**다.
    expect(screen.getAllByText('alice')).toHaveLength(2);
  });

  it('에이전트는 거터에서도 글리프로 표시된다', () => {
    // 에이전트 계정을 여기서 만든다
    useAppStore.getState().set({
      accounts: {
        u2: acc('u2', 'bot', 'agent'),
      },
    });
    fakeController();
    render(<MessageItem message={msg('m1', 'c1', 1, '안녕', 'u2')} />);

    // 거터와 작성자 옆 두 곳에서 에이전트 표시
    expect(screen.getAllByText('에이전트')).toHaveLength(2);
  });

  it('#181: 에이전트에 소유자가 있으면 소유자 표시가 나온다', () => {
    useAppStore.getState().set({
      accounts: {
        u1: acc('u1', 'owner'),
        a1: { ...acc('a1', 'bot', 'agent'), ownerAccountId: 'u1' },
      },
    });
    fakeController();
    render(<MessageItem message={msg('m1', 'c1', 1, '안녕', 'a1')} />);

    // 거터(variant=avatar)와 작성자 옆(variant=badge) 두 곳에서 에이전트 표시
    expect(screen.getAllByText('에이전트')).toHaveLength(2);
    // #277: 소유자 표시가 이름 줄(badge)에서만 보인다 — 거터(avatar)에서는 넘침 방지
    expect(screen.getAllByText('@owner')).toHaveLength(1);
  });

  it('#181: 에이전트에 소유자가 없으면 소유자 표시가 안 나온다', () => {
    useAppStore.getState().set({
      accounts: {
        a1: { ...acc('a1', 'bot', 'agent'), ownerAccountId: null },
      },
    });
    fakeController();
    render(<MessageItem message={msg('m1', 'c1', 1, '안녕', 'a1')} />);

    // 에이전트 표시만 있고 소유자 표시가 없다
    expect(screen.getAllByText('에이전트')).toHaveLength(2);
    expect(screen.queryByText('@owner')).toBeNull();
    expect(screen.queryByText(/소유자/)).toBeNull();
  });

  it('#181: 사람 계정에는 소유자 표시가 안 나온다', () => {
    useAppStore.getState().set({
      accounts: {
        u1: acc('u1', 'alice'),
      },
    });
    fakeController();
    render(<MessageItem message={msg('m1', 'c1', 1, '안녕', 'u1')} />);

    // 사람 계정이므로 에이전트 표시도 없고 소유자 표시도 없다
    expect(screen.queryByText('에이전트')).toBeNull();
    expect(screen.queryByText('@owner')).toBeNull();
  });

  it('알 수 없는 계정은 거터에서도 명시적 표시를 한다', () => {
    fakeController();
    render(<MessageItem message={msg('m1', 'c1', 1, '안녕', 'unknown')} />);

    // 거터와 작성자 옆 두 곳에서 "알 수 없는 계정"이 표시된다.
    expect(screen.getAllByText('알 수 없는 계정')).toHaveLength(2);
  });
});

describe('#161 2단계 답글 컨트롤', () => {
  // 서버의 replyCount 를 쓴다 — 스토어에 답글을 넣지 않고 replyCount 만 준 루트가
  // 그 수를 보여준다. 클라이언트 계산 제거를 지키는 선이다.
  // 서버 값과 클라이언트 계산이 **어긋나는** 상황이어야 구분이 검사된다. 스토어에만
  // 답글을 넣고 replyCount 를 다르게 주면, 서버 값을 쓰는 구현은 51 을 보이고 예전
  // 클라이언트 계산은 2 를 보인다 — 그 차이가 이 작업의 존재 이유(히스토리 창 밖의
  // 오래된 답글)를 그대로 재현한다.
  //
  // replyCount 만 주고 스토어를 비워 두면 되돌려도 통과한다 — 실제로 그랬다.
  it('답글 수가 서버 값에서 온다 (스토어 계산이 아니다)', () => {
    fakeController();
    useAppStore.getState().set({
      messages: {
        c1: [
          msg('m1', 'c1', 1, 'root', 'u2', { replyCount: 51 }),
          msg('r1', 'c1', 2, 'reply', 'u1', { threadRootId: 'm1' }),
          msg('r2', 'c1', 3, 'reply', 'u1', { threadRootId: 'm1' }),
        ],
      },
    });
    render(<MessageItem message={msg('m1', 'c1', 1, 'root', 'u2', { replyCount: 51 })} />);

    expect(screen.getByRole('button', { name: /51 replies/ })).toBeTruthy();
    expect(screen.queryByRole('button', { name: /^2 replies/ })).toBeNull();
  });

  it('replyCount 가 null 이면 답글 컨트롤이 안 나온다', () => {
    fakeController();
    render(<MessageItem message={msg('m1', 'c1', 1, 'reply', 'u2', { replyCount: null, threadRootId: 'm0' })} />);

    // replyCount 가 null 이면 버튼이 안 보인다
    expect(screen.queryByRole('button', { name: /repl(y|ies)/ })).toBeNull();
  });

  it('마지막 답글 시각이 보인다', () => {
    fakeController();
    const lastReplyAt = new Date();
    lastReplyAt.setHours(20, 24);
    render(<MessageItem message={msg('m1', 'c1', 1, 'root', 'u2', {
      replyCount: 5,
      lastReplyAt: lastReplyAt.toISOString(),
    })} />);

    // 마지막 답글 시각이 버튼의 aria-label 에 포함된다 (12시간 형식)
    expect(screen.getByRole('button', { name: /08:24/ })).toBeTruthy();
  });

  // 참여자를 5명까지만 보여주고 나머지는 +N 으로 접는다
  it('참여자가 5명 이하이면 모두 보인다', () => {
    fakeController();
    render(<MessageItem message={msg('m1', 'c1', 1, 'root', 'u2', {
      replyCount: 3,
      participantIds: ['u2', 'u3', 'u4'],
    })} />);

    // 3명 모두 보여주고 +N 은 안 보인다
    expect(screen.queryByText(/\+[\d]/)).toBeNull();
  });

  it('참여자가 5명을 넘으면 5개만 보이고 +N 으로 접힌다', () => {
    fakeController();
    render(<MessageItem message={msg('m1', 'c1', 1, 'root', 'u2', {
      replyCount: 7,
      participantIds: ['u2', 'u3', 'u4', 'u5', 'u6', 'u7'],
    })} />);

    // 5개 아바타 + +1 표시 (텍스트가 분리되어 있을 수 있으므로 부분 일치)
    expect(screen.getByText((content) => content.includes('+1'))).toBeTruthy();
  });

  // 접근성: 참여자 얼굴은 장식이다 — 키보드·스크린리더 경로에 5개의 정지점을 만들지 않는다.
  // 버튼 하나에 접근 가능한 이름이 있다.
  it('참여자 얼굴들은 접근성 정지점이 아니다 — 버튼 하나에 이름이 있다', () => {
    fakeController();
    render(<MessageItem message={msg('m1', 'c1', 1, 'root', 'u2', {
      replyCount: 3,
      participantIds: ['u2', 'u3', 'u4'],
    })} />);

    const replyButton = screen.getByRole('button', { name: /3 replies/ });
    // 버튼 자체에 접근 가능한 이름이 있다.
    expect(replyButton).toBeTruthy();

    // 참여자 아바타들은 aria-hidden 이라 스크린리더가 읽지 않는다.
    // replyCount 버튼만 있고 "Reply in thread"는 안 보인다.
    const replyButtons = screen.getAllByRole('button', { name: /repl(y|ies)/ });
    expect(replyButtons).toHaveLength(1);
  });
});