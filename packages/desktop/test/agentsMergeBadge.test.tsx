/**
 * 설정 › 에이전트의 「PR 머지」 배선(스레드 febe9ff8 P1) — 목록 카드 「머지 N」 은 **내가 소유한 에이전트만** 세고,
 * 상세에서는 그 절이 「실행」(하네스·모델) 바로 아래, 「권한」 위에 선다.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen, waitFor, fireEvent } from '@testing-library/react';
import type { AccountView, AgentView, GrantRow } from '@harkroom/shared';
import { AgentsSettings } from '../src/components/settings/AgentsSettings';
import { setController, type Controller } from '../src/state/controller';
import { resetCommunityRegistry, useActiveStore } from '../src/state/communities';
import { usePrefsStore } from '../src/state/prefsStore';

const ME_ID = 'owner-1';
const ME: AccountView = {
  id: ME_ID, handle: 'owner', displayName: 'owner', kind: 'human', isAdmin: true, role: 'admin',
  ownerAccountId: null, disabled: false, deleted: false, status: 'available', statusText: null, avatarAttachmentId: null,
};
const agent = (id: string, handle: string, ownerAccountId: string | null): AgentView => ({
  id, handle, displayName: handle, kind: 'agent', isAdmin: false, ownerAccountId, disabled: false, deleted: false,
  instructions: '', harness: 'claude-code', model: null, effort: null, workingDir: null, mentionPermission: 'auto',
  runnerVersion: null, stopRequestedAt: null, stopAckedAt: null, lastTurnAt: null, assignment: null,
} as unknown as AgentView);
const grant = (scope: string, expiresAt: string | null = null): GrantRow => ({
  accountId: 'a-mine', capability: 'repo.merge', scope, grantedBy: ME_ID, grantedAt: '2026-10-02T00:00:00Z', expiresAt, allowAgentCause: false,
});

beforeEach(() => {
  usePrefsStore.getState().setLocale('ko');
  resetCommunityRegistry();
  useActiveStore.setState({ me: ME, accounts: { [ME_ID]: ME } });
});
afterEach(() => { cleanup(); setController(null); usePrefsStore.getState().setLocale('system'); });

describe('설정 › 에이전트 — PR 머지 배선', () => {
  it('내 에이전트만 grant 를 읽어 「머지 N」 을 단다(만료된 것은 안 센다). 상세에서는 「실행」 아래·「권한」 위에 선다', async () => {
    const listGrants = vi.fn(async (id: string) => (id === 'a-mine'
      ? [grant('repo:izagood/harkroom'), grant('repo:izagood/harkroom-gate'), grant('repo:izagood/old', '2026-01-01T00:00:00Z')]
      : []));
    setController({
      listAgents: vi.fn(async () => [agent('a-mine', 'mine', ME_ID), agent('a-other', 'other', 'someone-else')]),
      listGrants,
      listPats: vi.fn(async () => []),
      agentMemory: vi.fn(async () => []),
      agentDefaults: vi.fn(async () => ({ harness: 'claude-code', model: null, effort: null })),
      operators: vi.fn(async () => []),
    } as unknown as Controller);

    render(<AgentsSettings />);
    expect((await screen.findByTestId('agent-merge-count-mine')).textContent).toBe('저장소 2개');
    expect(screen.queryByTestId('agent-merge-count-other')).toBeNull();
    expect(listGrants.mock.calls.map((c) => c[0])).toEqual(['a-mine']);

    fireEvent.click(screen.getByTestId('agent-card-mine'));
    const section = await screen.findByTestId('agent-grants');
    const run = screen.getByRole('heading', { name: '실행' });
    const perms = screen.getByRole('heading', { name: '권한' });
    expect(run.compareDocumentPosition(section) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(section.compareDocumentPosition(perms) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });
});
