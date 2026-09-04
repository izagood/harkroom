// #329 회귀선 (데스크탑) — 시스템 메시지가 meta.accountId 로 현재 handle 를 찾아 그린다.
//
// 요구:
// 1. 입장 시스템 메시지의 meta 에 대상 accountId 가 있다 (서버 테스트에서 함)
// 2. handle 을 바꾸면 과거 입·퇴장 메시지가 새 이름으로 그려진다
// 3. 그 메시지가 여전히 멘션 알림을 만들지 않는다 (서버 테스트에서 함)
// 4. 퇴장·내보냄 메시지도 같다
// 5. meta.accountId 가 없는 옛 메시지도 화면이 깨지지 않는다
// 6. 감사 detail 에 본문·이름이 새지 않는다 (서버 테스트에서 함)
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { render, screen, cleanup } from '@testing-library/react';
import { useActiveStore as useAppStore } from '../src/state/communities';
import { MessageItem } from '../src/components/MessageItem';
import { acc, msg } from './helpers/fakeApi';

const TARGET_ID = '33333333-3333-4333-8333-333333333333';

function seed(accounts: Record<string, ReturnType<typeof acc>>): void {
  useAppStore.getState().reset();
  useAppStore.getState().set({
    me: acc('u1', 'admin'),
    accounts,
  });
}

function showSystemMessage(accountId: string | null): void {
  const message = msg('sys1', 'c1', 1, '계정이 채널에 추가되었습니다.', 'u1', {
    kind: 'system',
    meta: accountId ? { accountId } : {},
  });
  render(<MessageItem message={message} />);
}

beforeEach(() => seed({ u1: acc('u1', 'admin'), [TARGET_ID]: acc(TARGET_ID, 'targetuser') }));
afterEach(() => cleanup());

describe('#329 시스템 메시지가 현재 handle 로 그려진다', () => {
  it('1. meta.accountId 로 대상의 현재 handle 가 표시된다', () => {
    showSystemMessage(TARGET_ID);
    // 이름줄에 대상의 handle 이 표시된다.
    expect(screen.getByText('targetuser')).toBeTruthy();
  });

  it('2. handle 을 바꾸면 같은 메시지가 새 이름으로 그려진다', () => {
    showSystemMessage(TARGET_ID);
    expect(screen.getByText('targetuser')).toBeTruthy();

    cleanup();

    // handle 을 'newtarget'으로 변경한 뒤 다시 렌더
    seed({ u1: acc('u1', 'admin'), [TARGET_ID]: acc(TARGET_ID, 'newtarget') });
    showSystemMessage(TARGET_ID);
    expect(screen.getByText('newtarget')).toBeTruthy();
  });

  it('3. meta.accountId 가 없는 옛 메시지는 author handle 로 표시된다 (하위 호환)', () => {
    // meta.accountId 없이 system kind 만 있는 메시지
    showSystemMessage(null);
    // author 의 handle 이 표시된다 — 첫 번째 것은 author gutter 에 있다
    const handles = screen.getAllByText('admin');
    expect(handles.length).toBeGreaterThan(0);
  });

  it('4. 퇴장 메시지도 같은 방식으로 handle 을 표시한다', () => {
    const leaveMessage = msg('sys2', 'c1', 2, '계정이 채널에서 나갔습니다.', 'u1', {
      kind: 'system',
      meta: { accountId: TARGET_ID },
    });
    render(<MessageItem message={leaveMessage} />);
    expect(screen.getByText('targetuser')).toBeTruthy();
  });

  it('5. 내보냄 메시지도 같은 방식으로 handle 을 표시한다', () => {
    const removeMessage = msg('sys3', 'c1', 3, '계정이 채널에서 제거되었습니다.', 'u1', {
      kind: 'system',
      meta: { accountId: TARGET_ID },
    });
    render(<MessageItem message={removeMessage} />);
    expect(screen.getByText('targetuser')).toBeTruthy();
  });
});