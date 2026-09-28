/**
 * **연쇄 깊이 상한에 막힌 호출은 화면에 남는다**(Agents 관제 4단계).
 *
 * 서버가 상한을 걸면 그 발화는 아무 일도 일어나지 않은 것처럼 보인다 — 부른 이름은 본문에
 * 그대로 있고, 아무도 오지 않는다. 그 사실을 적지 않으면 사람은 러너나 네트워크를 의심하게
 * 된다. 그래서 이 줄은 **판정이 아니라 표시의 회귀선**이다: 서버가 `meta` 로 말한 것을
 * 화면이 잃지 않는지.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { render, screen, cleanup } from '@testing-library/react';
import type { MessageRow } from '@harkroom/shared';
import { useActiveStore as useAppStore } from '../src/state/communities';
import { usePrefsStore } from '../src/state/prefsStore';
import { MessageItem } from '../src/components/MessageItem';
import { acc } from './helpers/fakeApi';

const msg = (meta: Record<string, unknown>): MessageRow => ({
  id: 'm1', seq: 1, channelId: 'c1', threadRootId: null, authorId: 'a1',
  body: '<@a2> 이어서', kind: 'user', meta, createdAt: new Date().toISOString(), editedAt: null,
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
    accounts: { u1: acc('u1', 'me'), a1: acc('a1', 'dee', 'agent'), a2: acc('a2', 'eve', 'agent') },
  });
});

afterEach(() => {
  usePrefsStore.getState().setLocale('system');
  cleanup();
});

describe('막힌 호출 표시', () => {
  it('막힌 이름과 상한값을 함께 적는다 — "왜 아무도 안 왔나"의 답이 여기다', () => {
    render(<MessageItem message={msg({ mentionChainCapped: ['eve'], mentionChainLimit: 4 })} />);
    const row = screen.getByTestId('mention-chain-capped');
    expect(row.textContent).toContain('@eve');
    expect(row.textContent).toContain('4');
  });

  it('막힌 것이 없으면 줄이 없다 — 평범한 발화에 장식을 붙이지 않는다', () => {
    render(<MessageItem message={msg({})} />);
    expect(screen.queryByTestId('mention-chain-capped')).toBeNull();
  });

  it('상한값을 서버가 말하지 않아도 이름은 적는다 — 사실의 절반이라도 잃지 않는다', () => {
    render(<MessageItem message={msg({ mentionChainCapped: ['eve'] })} />);
    expect(screen.getByTestId('mention-chain-capped').textContent).toContain('@eve');
  });
});
