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
    accounts: { u1: acc('u1', 'me'), a2: acc('a2', 'privy', 'agent') },
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
