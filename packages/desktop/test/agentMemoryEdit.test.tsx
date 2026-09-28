/**
 * 기억 **고치기**(메모리 고도화 M5). 전에는 보기와 지우기뿐이라, 에이전트가 틀리게 적은 것을
 * 사람이 바로잡을 길이 지우는 것밖에 없었다. 여기서 재는 것:
 * - 요약·종류·읽은 횟수가 줄과 펼친 자리에 선다
 * - 저장은 **연 판(updatedAt)** 을 함께 보낸다 — 그 사이 에이전트가 고쳤으면 덮지 않는다
 * - 이전 판을 보고 되돌린다
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { render, screen, fireEvent, cleanup, waitFor } from '@testing-library/react';
import type { AgentDefaults, AgentView, PatView } from '@harkroom/shared';
import { useActiveStore as useAppStore } from '../src/state/communities';
import { usePrefsStore } from '../src/state/prefsStore';
import { setController, type Controller } from '../src/state/controller';
import { ApiError } from '../src/lib/api';
import { AgentsSettings } from '../src/components/settings/AgentsSettings';
import type { MemoryEntry, MemoryRevision } from '../src/lib/memoryList';
import { acc } from './helpers/fakeApi';

const agent = (handle: string): AgentView => ({
  id: `id-${handle}`, handle, displayName: handle, kind: 'agent', isAdmin: false, role: 'member', assignment: null, invokeScope: 'community', credentialScope: 'none', invokers: [], mcpServers: [],
  instructions: '', harness: 'claude-code', model: null, effort: null, workingDir: null,
  mentionPermission: 'auto', ownerAccountId: null, disabled: false, deleted: false, runnerVersion: null,
  claudeLane: null,
  stopRequestedAt: null, stopAckedAt: null, lastTurnAt: null,
  status: 'available', statusText: null, avatarAttachmentId: null,
});

const UPDATED = new Date(Date.UTC(2026, 8, 3)).toISOString();

const fakeController = (memories: MemoryEntry[], revisions: MemoryRevision[] = []) => {
  const c = {
    listAgents: vi.fn(async (): Promise<AgentView[]> => [agent('rusalka')]),
    listPats: vi.fn(async (): Promise<PatView[]> => []),
    agentDefaults: vi.fn(async (): Promise<AgentDefaults> => ({ harness: 'claude-code', model: null, effort: null })),
    agentMemory: vi.fn(async () => memories),
    deleteAgentMemory: vi.fn(async (): Promise<void> => undefined),
    putAgentMemory: vi.fn(async (): Promise<{ ok: true }> => ({ ok: true })),
    agentMemoryRevisions: vi.fn(async () => revisions),
    fetchAvatar: vi.fn(async (): Promise<Blob> => new Blob(['png'])),
  };
  setController(c as unknown as Controller);
  return c;
};

beforeEach(() => {
  usePrefsStore.getState().setLocale('ko');
  useAppStore.getState().reset();
  useAppStore.getState().set({ me: acc('u1', 'admin', 'human', true) });
});
afterEach(() => { cleanup(); usePrefsStore.getState().setLocale('system'); });

const openRow = async (slug: string) => {
  render(<AgentsSettings />);
  fireEvent.click(await screen.findByTestId('agent-card-rusalka'));
  fireEvent.click(await screen.findByRole('button', { name: `${slug} 펼치기` }));
};

describe('기억 고치기 (M5)', () => {
  it('줄에 요약과 종류가, 펼치면 읽은 횟수가 선다', async () => {
    fakeController([{
      slug: 'mem/deploy', value: '# 배포\n1. 빌드', updatedAt: UPDATED,
      description: '배포 절차', kind: 'procedure', readCount: 4, lastReadAt: UPDATED,
    }]);
    render(<AgentsSettings />);
    fireEvent.click(await screen.findByTestId('agent-card-rusalka'));
    const row = await screen.findByTestId('memory-row-mem/deploy');
    expect(row.textContent).toContain('배포 절차');
    expect(row.textContent).toContain('절차');
    fireEvent.click(screen.getByRole('button', { name: 'mem/deploy 펼치기' }));
    expect(screen.getByTestId('memory-reads').textContent).toContain('4번 열림');
  });

  it('저장은 본문·요약·종류와 함께 연 판을 보낸다', async () => {
    const c = fakeController([{ slug: 'mem/a', value: 'v1', updatedAt: UPDATED }]);
    await openRow('mem/a');
    fireEvent.click(screen.getByTestId('memory-edit-start'));
    fireEvent.change(screen.getByTestId('memory-edit-value'), { target: { value: 'v2' } });
    fireEvent.change(screen.getByTestId('memory-edit-description'), { target: { value: '요약' } });
    fireEvent.change(screen.getByTestId('memory-edit-kind'), { target: { value: 'journal' } });
    fireEvent.click(screen.getByTestId('memory-edit-save'));
    await waitFor(() => expect(c.putAgentMemory).toHaveBeenCalledWith('id-rusalka', 'mem/a', {
      value: 'v2', description: '요약', kind: 'journal', ifUpdatedAt: UPDATED,
    }));
    // 저장 뒤 목록을 다시 읽는다.
    await waitFor(() => expect(c.agentMemory).toHaveBeenCalledTimes(2));
  });

  // 연 뒤에 에이전트가 고쳤으면 덮지 않고 말한다.
  it('409 면 덮지 않고 다시 불러오라고 말한다', async () => {
    const c = fakeController([{ slug: 'mem/a', value: 'v1', updatedAt: UPDATED }]);
    c.putAgentMemory.mockRejectedValueOnce(new ApiError(409, 'conflict', 'conflict', {}));
    await openRow('mem/a');
    fireEvent.click(screen.getByTestId('memory-edit-start'));
    fireEvent.click(screen.getByTestId('memory-edit-save'));
    expect((await screen.findByRole('alert')).textContent).toContain('다시 불러와');
    // 편집 상자는 그대로다 — 쓴 것을 잃지 않는다.
    expect(screen.getByTestId('memory-edit-value')).toBeTruthy();
  });

  it('core 에는 종류 고르기가 없다', async () => {
    fakeController([{ slug: 'core', value: '핵심', updatedAt: UPDATED }]);
    await openRow('core');
    fireEvent.click(screen.getByTestId('memory-edit-start'));
    expect(screen.queryByTestId('memory-edit-kind')).toBeNull();
  });

  it('이전 판을 펼쳐 한 판으로 되돌린다(되돌리기도 연 판을 함께 보낸다)', async () => {
    const c = fakeController(
      [{ slug: 'mem/a', value: 'now', updatedAt: UPDATED }],
      [{ value: 'before', description: '옛 요약', updatedAt: UPDATED, replacedAt: UPDATED }],
    );
    await openRow('mem/a');
    fireEvent.click(screen.getByTestId('memory-revisions-toggle'));
    expect((await screen.findByTestId('memory-revision')).textContent).toContain('before');
    fireEvent.click(screen.getByTestId('memory-revision-restore'));
    await waitFor(() => expect(c.putAgentMemory).toHaveBeenCalledWith('id-rusalka', 'mem/a', {
      value: 'before', description: '옛 요약', ifUpdatedAt: UPDATED,
    }));
  });
});
