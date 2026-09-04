// #329 회귀선(데스크탑) — 시스템 메시지가 `meta.accountId` 로 **지금의** handle 을 찾아
// 본문에 채운다.
//
// 서버 쪽 회귀선은 `server/test/memberSystemMessage.test.ts` 에 있다(본문에 이름이 없다,
// meta 에 대상이 실린다, 멘션 알림이 없다, 감사 detail 이 새지 않는다).
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { render, screen, cleanup } from '@testing-library/react';
import { SYSTEM_ACCOUNT_PLACEHOLDER } from '@murmur/shared';
import { useActiveStore as useAppStore } from '../src/state/communities';
import { MessageItem } from '../src/components/MessageItem';
import { acc, msg } from './helpers/fakeApi';

const TARGET_ID = '33333333-3333-4333-8333-333333333333';
const ADDED = `${SYSTEM_ACCOUNT_PLACEHOLDER}님이 채널에 추가되었습니다.`;
const LEFT = `${SYSTEM_ACCOUNT_PLACEHOLDER}님이 채널에서 나갔습니다.`;
const REMOVED = `${SYSTEM_ACCOUNT_PLACEHOLDER}님이 채널에서 제거되었습니다.`;

/** 작성자는 언제나 admin 이다 — 초대·내보내기를 **한 사람**이 시스템 메시지의 작성자다. */
function seed(targetHandle: string | null): void {
  useAppStore.getState().reset();
  useAppStore.getState().set({
    me: acc('u1', 'admin'),
    accounts: targetHandle
      ? { u1: acc('u1', 'admin'), [TARGET_ID]: acc(TARGET_ID, targetHandle) }
      : { u1: acc('u1', 'admin') },
  });
}

function show(body: string, accountId: string | null): void {
  render(<MessageItem message={msg('sys1', 'c1', 1, body, 'u1', {
    kind: 'system',
    meta: accountId ? { accountId } : {},
  })} />);
}

beforeEach(() => seed('targetuser'));
afterEach(() => cleanup());

describe('#329 시스템 메시지가 현재 handle 로 그려진다', () => {
  it('1. 자리표시자가 대상의 현재 handle 로 채워진다 — 자리표시자는 화면에 남지 않는다', () => {
    show(ADDED, TARGET_ID);

    expect(screen.getByText('targetuser님이 채널에 추가되었습니다.')).toBeTruthy();
    // 자리표시자가 그대로 나오면 사람은 `{account}` 라는 글자를 읽게 된다.
    expect(screen.queryByText(new RegExp(SYSTEM_ACCOUNT_PLACEHOLDER.replace(/[{}]/g, '\\$&')))).toBeNull();
  });

  it('2. handle 을 바꾸면 **같은 메시지**가 새 이름으로 그려진다', () => {
    show(ADDED, TARGET_ID);
    expect(screen.getByText('targetuser님이 채널에 추가되었습니다.')).toBeTruthy();

    cleanup();
    // 메시지 행은 손대지 않는다 — 바뀐 것은 스토어의 handle 뿐이다. 그것이 이 이슈다:
    // 본문을 다시 쓰지 않고도 과거 메시지가 새 이름을 말해야 한다.
    seed('newtarget');
    show(ADDED, TARGET_ID);

    expect(screen.getByText('newtarget님이 채널에 추가되었습니다.')).toBeTruthy();
    expect(screen.queryByText(/targetuser/)).toBeNull();
  });

  it('3. 이름줄은 **작성자**를 그린다 — 대상의 이름이 그 자리를 뺏지 않는다', () => {
    // 이름줄 옆의 아바타·배지·상태 표시는 전부 author 를 그린다. 이름만 대상으로 바꾸면
    // admin 이 내보낸 메시지가 내보내진 사람의 말처럼 보이고, 한 줄 안에서 이름과 아바타가
    // 서로 다른 사람을 가리킨다. 초판이 실제로 그랬다.
    show(REMOVED, TARGET_ID);

    expect(screen.getByTestId('author-name').textContent).toBe('admin');
    // 대상의 이름은 **본문에만** 있다.
    expect(screen.getByText('targetuser님이 채널에서 제거되었습니다.')).toBeTruthy();
  });

  it('4. 나감과 내보냄의 문구가 화면에서도 다르다', () => {
    show(LEFT, TARGET_ID);
    expect(screen.getByText('targetuser님이 채널에서 나갔습니다.')).toBeTruthy();
    expect(screen.queryByText(/제거되었습니다/)).toBeNull();

    cleanup();
    seed('targetuser');
    show(REMOVED, TARGET_ID);
    expect(screen.getByText('targetuser님이 채널에서 제거되었습니다.')).toBeTruthy();
    expect(screen.queryByText(/나갔습니다/)).toBeNull();
  });

  it('5. meta.accountId 가 없는 옛 메시지는 본문이 그대로 나온다 (#322 가 이미 만든 것)', () => {
    // `#322` 는 본문에 handle 을 박아 넣었고 meta 에 아무것도 싣지 않았다. 그 메시지를
    // 다시 쓰지 않는 것이 이 이슈의 결정이므로, 화면은 그것을 있는 그대로 그려야 한다.
    show('olduser님이 채널에 추가되었습니다.', null);

    expect(screen.getByText('olduser님이 채널에 추가되었습니다.')).toBeTruthy();
    expect(screen.getByTestId('author-name').textContent).toBe('admin');
  });

  it('6. 대상 계정을 스토어가 모르면 라벨로 대신한다 — 자리표시자가 새지 않는다', () => {
    // 계정 목록이 아직 안 왔거나 계정이 사라진 경우다. `<@id>` 를 그대로 그리지 않는
    // `#271` 의 결정과 같은 이유로, 사람에게 아무 뜻 없는 글자를 남기지 않는다.
    seed(null);
    show(ADDED, TARGET_ID);

    expect(screen.getByText('알 수 없음님이 채널에 추가되었습니다.')).toBeTruthy();
  });

  it('7. 채워진 이름은 멘션으로 칠해지지 않는다 — 알림이 간 것처럼 보이면 안 된다', () => {
    // 시스템 메시지는 부르지 않는다(#322). `@` 를 붙여 채우면 `splitMentions` 가 그것을
    // 멘션으로 칠하고, 화면은 알림이 갔다고 말하게 된다.
    const { container } = render(<MessageItem message={msg('sys1', 'c1', 1, ADDED, 'u1', {
      kind: 'system', meta: { accountId: TARGET_ID },
    })} />);

    // `MessageBody` 가 멘션 조각에만 붙이는 표식이다(`data-testid="mention-<handle>"`).
    expect(container.querySelector('[data-testid="mention-targetuser"]')).toBeNull();
    expect(screen.queryByText(/@targetuser/)).toBeNull();
  });
});
