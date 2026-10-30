/**
 * 호출 범위 밖이라 막힌 부름의 **표시**(스펙 2026-09-20 §6). 판정은 서버가 하고 `meta.mentionDenied`
 * 로 적는다 — 이 줄은 `mentionChainCapped.test.tsx` 와 같은 종류의 표시 회귀선이다: 서버가
 * 말한 것을 화면이 그대로 읽는가, 없으면 그리지 않는가.
 */
import { describe, it, expect, afterEach, beforeEach } from 'vitest';
import { render, screen, cleanup } from '@testing-library/react';
import type { MessageRow } from '@harkroom/shared';
import { useActiveStore as useAppStore } from '../src/state/communities';
import { usePrefsStore } from '../src/state/prefsStore';
import { MessageItem } from '../src/components/MessageItem';
import { acc } from './helpers/fakeApi';

const msg = (meta: Record<string, unknown>): MessageRow => ({
  id: 'm1', seq: 1, channelId: 'c1', threadRootId: null, authorId: 'u1',
  body: '<@a2> 이거 봐 줘', kind: 'user', meta, createdAt: new Date().toISOString(), editedAt: null,
  reactions: [], attachments: [], replyCount: null, lastReplyAt: null, participantIds: null,
  openAskHumanCount: null, openAskAccountIds: null, openAskLinks: null,
  failureCount: null, unresolvedFailureCount: null, lastKind: null, lastAuthorId: null,
  alsoInChannel: false, deletedAt: null,
} as unknown as MessageRow);

beforeEach(() => {
  usePrefsStore.getState().setLocale('ko');
  useAppStore.getState().reset();
  useAppStore.getState().set({
    me: acc('u1', 'me'),
    accounts: { u1: acc('u1', 'me'), a2: acc('a2', 'privy', 'agent'), p1: acc('p1', 'boss'), a3: acc('a3', 'helper', 'agent') },
  });
});
afterEach(() => { usePrefsStore.getState().setLocale('system'); cleanup(); });

describe('mentionDenied', () => {
  it('서버가 막았다고 적은 이름을 그 메시지 아래에 보인다', () => {
    render(<MessageItem message={msg({ mentionDenied: ['privy'] })} />);
    const line = screen.getByTestId('mention-denied');
    expect(line.textContent).toContain('@privy');
    expect(line.textContent).toContain('부르지 않았다');
  });
  it('meta 에 없으면 그리지 않는다 — 없는 것을 있다고 표시하지 않는다', () => {
    render(<MessageItem message={msg({})} />);
    expect(screen.queryByTestId('mention-denied')).toBeNull();
  });
});

/**
 * 요청자 권한 줄(호출 권한 재설계 4단계). 서버 meta `invokedAsPrincipal`·`mentionDeniedPrincipal` 만 읽는다 —
 * 본문·작성자에서 짐작하지 않고, 막힌 줄에는 요청자 이름을 싣지 않는다.
 */
describe('invokedAsPrincipal · mentionDeniedPrincipal', () => {
  it('통과한 부름은 누구 권한인지 이름으로 보인다', () => {
    render(<MessageItem message={msg({ invokedAsPrincipal: { principalId: 'p1', handles: ['helper'], ids: ['a3'] } })} />);
    const line = screen.getByTestId('mention-as-principal');
    expect(line.textContent).toBe('@helper — boss 권한으로 불렀다');
  });
  it('보는 사람이 요청자면 「내 권한으로」', () => {
    render(<MessageItem message={msg({ invokedAsPrincipal: { principalId: 'u1', handles: ['helper'], ids: ['a3'] } })} />);
    expect(screen.getByTestId('mention-as-principal').textContent).toBe('@helper — 내 권한으로 불렀다');
  });
  it('모르는 요청자는 공용 이름표, 꼴이 어긋나면 그리지 않는다', () => {
    render(<MessageItem message={msg({ invokedAsPrincipal: { principalId: 'gone', handles: ['helper'] } })} />);
    expect(screen.getByTestId('mention-as-principal').textContent).not.toContain('gone');
    cleanup();
    render(<MessageItem message={msg({ invokedAsPrincipal: { principalId: 'p1', handles: [] } })} />);
    expect(screen.queryByTestId('mention-as-principal')).toBeNull();
    cleanup();
    render(<MessageItem message={msg({ invokedAsPrincipal: 'p1' })} />);
    expect(screen.queryByTestId('mention-as-principal')).toBeNull();
  });
  it.each([
    ['none', '사람이 직접 부른다'],
    ['capped', '사람이 직접 부른다'],
    ['denied', '소유자에게 물어라'],
  ])('막힌 이유 %s 는 할 일을 다르게 말하고 요청자 이름은 넣지 않는다', (reason, tail) => {
    render(<MessageItem message={msg({ mentionDenied: ['privy'], mentionDeniedPrincipal: reason })} />);
    const line = screen.getByTestId('mention-denied').textContent ?? '';
    expect(line.startsWith('@privy — 부르지 않았다.')).toBe(true);
    expect(line).toContain(tail);
    expect(line).not.toContain('boss');
    expect(line).not.toContain('200');
  });
  it('이유가 없거나 모르는 값이면 옛 문구(어순만 맞춤)', () => {
    render(<MessageItem message={msg({ mentionDenied: ['privy'], mentionDeniedPrincipal: 'weird' })} />);
    expect(screen.getByTestId('mention-denied').textContent).toBe('@privy — 부르지 않았다. 부를 수 있는 범위 밖이다. 그 에이전트의 소유자에게 물어라.');
  });
  it('섞인 경우 통과 줄이 막힌 줄보다 위다', () => {
    render(<MessageItem message={msg({
      invokedAsPrincipal: { principalId: 'p1', handles: ['helper'], ids: ['a3'] },
      mentionDenied: ['privy'], mentionDeniedPrincipal: 'denied',
    })} />);
    const as = screen.getByTestId('mention-as-principal');
    const denied = screen.getByTestId('mention-denied');
    expect(as.compareDocumentPosition(denied) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });
});
