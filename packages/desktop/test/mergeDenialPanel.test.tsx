/**
 * 머지 거절 카드의 권한 칸(머지 UX P5, 스레드 febe9ff8). 판정은 전부 서버다. 여기서 재는 것:
 * [7일 주기]는 소유자 사람에게만 서고 몸체 없이 거절 기록 id 로만 부르는가 · 배포 저장소면 버튼 대신 설정 길만 두는가 ·
 * 저장소 이름을 전부 보이고 PR 링크는 서버 기록으로만 만드는가(security L1) · 준 뒤에는 기한을 보이는가.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { render, screen, fireEvent, cleanup, waitFor } from '@testing-library/react';
import type { MessageRow } from '@harkroom/shared';
import { MergeDenialPanel, prUrlOf } from '../src/components/MergeDenialPanel';
import { setController, type Controller } from '../src/state/controller';
import { resetCommunityRegistry, useActiveStore } from '../src/state/communities';
import { usePrefsStore } from '../src/state/prefsStore';
import { acc } from './helpers/fakeApi';

const ME = 'owner-1';
const DENIAL = '0f0e0d0c-0b0a-4908-8706-050403020100';
const card = (over: Record<string, unknown> = {}): MessageRow => ({
  id: 'm1', seq: 1, channelId: 'c1', threadRootId: 't1', authorId: 'agent-1', body: '<a href="https://evil.example/pull/1">PR</a>',
  kind: 'user', createdAt: '', editedAt: null, reactions: [], attachments: [],
  meta: {
    kind: 'ask', ask: { options: [{ id: 'retry', label: '다시 머지' }, { id: 'later', label: '나중에' }], to: { kind: 'human' } },
    mergeDenial: { key: 'k', denialId: DENIAL, agentId: 'agent-1', ownerAccountId: ME, repo: 'example-org/service-api', number: 42, deployRepo: false, count: 2, firstAt: '', lastAt: '2026-10-05T10:00:00Z', ...over },
  },
} as unknown as MessageRow);

function setup(over: Record<string, unknown> = {}) {
  const c = { grantFromMergeDenial: vi.fn(async () => ({ repo: 'example-org/service-api', expiresAt: '2026-10-12T10:00:00Z', cardMessageId: 'm1' })), ...over };
  setController(c as unknown as Controller);
  return c;
}

beforeEach(() => {
  usePrefsStore.getState().setLocale('ko');
  resetCommunityRegistry();
  useActiveStore.getState().reset();
  useActiveStore.getState().set({
    me: acc(ME, 'owner'),
    accounts: { [ME]: acc(ME, 'owner'), 'agent-1': acc('agent-1', 'alpha', 'agent', false, { ownerAccountId: ME }), other: acc('other', 'carol') },
  });
});
afterEach(() => { usePrefsStore.getState().setLocale('system'); cleanup(); });

describe('MergeDenialPanel', () => {
  it('저장소 owner/name 을 전부 보이고, PR 링크는 서버 기록으로만 만든다 — 본문의 링크는 쓰지 않는다(L1)', () => {
    setup();
    render(<MergeDenialPanel message={card()} />);
    expect(screen.getByTestId('merge-denial-repo').textContent).toBe('example-org/service-api');
    expect(screen.getByTestId('merge-denial-pr').getAttribute('href')).toBe('https://github.com/example-org/service-api/pull/42');
    expect(document.body.innerHTML).not.toContain('evil.example');
  });

  it('모양이 어긋난 저장소·번호면 링크를 걸지 않는다', () => {
    expect(prUrlOf({ repo: 'a/b', number: 3 })).toBe('https://github.com/a/b/pull/3');
    expect(prUrlOf({ repo: 'evil.example/x/y', number: 3 })).toBeNull();
    expect(prUrlOf({ repo: 'a/b?x=1', number: 3 })).toBeNull();
    expect(prUrlOf({ repo: 'a/b', number: 0 })).toBeNull();
    expect(prUrlOf({ repo: 'a/b', number: 1.5 })).toBeNull();
  });

  it('[7일 주기]는 소유자 사람에게만 — 에이전트 id 와 거절 기록 id 로만 부르고, 준 뒤 기한을 보인다', async () => {
    const c = setup();
    render(<MergeDenialPanel message={card()} />);
    fireEvent.click(screen.getByTestId('merge-denial-give'));
    await waitFor(() => expect(screen.getByTestId('merge-denial-granted')).toBeTruthy());
    expect(c.grantFromMergeDenial).toHaveBeenCalledWith('agent-1', DENIAL);
    expect(screen.queryByTestId('merge-denial-give')).toBeNull();
  });

  it('소유자가 아니면 버튼이 없고 「소유자만」만 보인다', () => {
    setup();
    useActiveStore.getState().set({ me: acc('other', 'carol') });
    render(<MergeDenialPanel message={card()} />);
    expect(screen.queryByTestId('merge-denial-give')).toBeNull();
    expect(screen.getByTestId('merge-denial-owner-only').textContent).toContain('@owner');
  });

  it('배포 저장소면 버튼 대신 설정 길만 둔다(C6)', () => {
    setup();
    const open = vi.fn();
    render(<MergeDenialPanel message={card({ deployRepo: true })} onOpenSettings={open} />);
    expect(screen.queryByTestId('merge-denial-give')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: '설정에서 보기' }));
    expect(open).toHaveBeenCalledWith('agents', 'agent-1');
  });

  it('이미 준 카드(meta.granted)는 버튼 없이 기한을 보인다', () => {
    setup();
    render(<MergeDenialPanel message={card({ granted: { by: ME, at: '', expiresAt: '2026-10-12T10:00:00Z' } })} />);
    expect(screen.getByTestId('merge-denial-granted')).toBeTruthy();
    expect(screen.queryByTestId('merge-denial-give')).toBeNull();
  });

  it('서버가 거절하면 이유를 보이고 버튼은 다시 누를 수 있다', async () => {
    setup({ grantFromMergeDenial: vi.fn(async () => { throw new Error('denial_used'); }) });
    render(<MergeDenialPanel message={card()} />);
    fireEvent.click(screen.getByTestId('merge-denial-give'));
    await waitFor(() => expect(screen.getByTestId('merge-denial-error').textContent).toContain('denial_used'));
    expect((screen.getByTestId('merge-denial-give') as HTMLButtonElement).disabled).toBe(false);
  });
});
