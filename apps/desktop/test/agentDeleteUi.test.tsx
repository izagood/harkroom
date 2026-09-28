import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { render, screen, fireEvent, cleanup, waitFor } from '@testing-library/react';
import type { AgentDefaults, AgentView, PatView } from '@harkroom/shared';
import { useActiveStore as useAppStore } from '../src/state/communities';
import { usePrefsStore } from '../src/state/prefsStore';
import { Controller, setController } from '../src/state/controller';
import { AgentsSettings } from '../src/components/settings/AgentsSettings';
import { acc } from './helpers/fakeApi';

/**
 * #836 삭제 UI. 이 화면에는 **되돌릴 수 있는 위험**(비활성화)과 **되돌릴 수 없는 위험**
 * (삭제)이 나란히 있다. 그래서 이 파일이 지키는 것은 버튼이 있는가가 아니라 **둘이 구분
 * 되는가**다: 삭제는 handle 을 그대로 쳐야 서고, 확인 전에는 요청이 나가지 않는다.
 */
const agent = (handle: string, extra: Partial<AgentView> = {}): AgentView => ({
  id: `id-${handle}`, handle, displayName: handle, kind: 'agent', isAdmin: false, role: 'member', assignment: null, invokeScope: 'community', credentialScope: 'none', invokers: [], mcpServers: [],
  instructions: '', harness: 'claude-code', model: null, effort: null, workingDir: null,
  mentionPermission: 'auto', ownerAccountId: null, disabled: false, deleted: false, runnerVersion: null,
  claudeLane: null,
  stopRequestedAt: null, stopAckedAt: null, lastTurnAt: null,
  status: 'available', statusText: null, avatarAttachmentId: null, ...extra,
});

const fakeController = (agents: AgentView[]) => {
  const c = {
    listAgents: vi.fn(async (): Promise<AgentView[]> => agents),
    listPats: vi.fn(async (): Promise<PatView[]> => []),
    agentDefaults: vi.fn(async (): Promise<AgentDefaults> => (
      { harness: 'claude-code', model: null, effort: null }
    )),
    agentMemory: vi.fn(async (): Promise<{ slug: string; value: string; updatedAt: string }[]> => []),
    deleteAgent: vi.fn(async (): Promise<void> => undefined),
    refreshAccounts: vi.fn(async (): Promise<void> => undefined),
  };
  setController(c as unknown as Controller);
  return c;
};

// 한국어로 고정하는 이유는 `agentDisableUi.test.tsx` 와 같다.
beforeEach(() => {
  usePrefsStore.getState().setLocale('ko');
  useAppStore.getState().reset();
  useAppStore.getState().set({ me: acc('u1', 'admin', 'human', true) });
});
afterEach(() => { cleanup(); usePrefsStore.getState().setLocale('system'); });

const openDetail = async (handle: string) => {
  render(<AgentsSettings />);
  fireEvent.click(await screen.findByTestId(`agent-card-${handle}`));
};

describe('#836 삭제 컨트롤', () => {
  // 비활성화와 같은 문(admin)을 쓴다. 눌러도 403 인 버튼은 거짓 신호이므로 **부재**여야 한다.
  it('admin 이 아니면 아예 렌더되지 않는다', async () => {
    useAppStore.getState().set({ me: acc('u1', 'someone', 'human', false) });
    fakeController([agent('rusalka')]);
    await openDetail('rusalka');

    expect(screen.queryByTestId('agent-delete')).toBeNull();
  });

  it('첫 클릭은 요청을 보내지 않고 확인 단계를 띄운다', async () => {
    const c = fakeController([agent('rusalka')]);
    await openDetail('rusalka');

    fireEvent.click(screen.getByTestId('agent-delete'));

    expect(c.deleteAgent).not.toHaveBeenCalled();
    // 확인 단계는 **두 사실**을 다 말해야 한다: 되돌릴 수 없다는 것과, 그래도 메시지는
    // 남는다는 것. 뒤엣것이 없으면 지워야 할 때 못 지운다.
    const box = screen.getByTestId('agent-delete-confirm').closest('div')!.parentElement!;
    expect(box.textContent).toContain('되돌릴 수 없다');
    expect(box.textContent).toContain('메시지는 채널에 그대로 남는다');
  });

  /** 이 화면의 다른 위험(비활성화)은 버튼 하나 더 누르면 된다. 삭제는 그래서는 안 된다. */
  it('handle 을 그대로 쳐야 확인 버튼이 선다', async () => {
    const c = fakeController([agent('rusalka')]);
    await openDetail('rusalka');
    fireEvent.click(screen.getByTestId('agent-delete'));

    const confirm = screen.getByTestId('agent-delete-confirm') as HTMLButtonElement;
    expect(confirm.disabled).toBe(true);

    fireEvent.change(screen.getByTestId('agent-delete-confirm-input'), { target: { value: 'rusalk' } });
    expect((screen.getByTestId('agent-delete-confirm') as HTMLButtonElement).disabled).toBe(true);

    fireEvent.change(screen.getByTestId('agent-delete-confirm-input'), { target: { value: 'rusalka' } });
    expect((screen.getByTestId('agent-delete-confirm') as HTMLButtonElement).disabled).toBe(false);

    fireEvent.click(screen.getByTestId('agent-delete-confirm'));
    await waitFor(() => expect(c.deleteAgent).toHaveBeenCalledWith('id-rusalka'));
  });

  /** 지운 뒤 상세에 남으면, 거기서 누른 저장이 404 로 죽는다 — 사람은 지운 것을 잊는다. */
  it('지우면 격자로 돌아가고 목록에서 사라진다', async () => {
    fakeController([agent('rusalka'), agent('other')]);
    await openDetail('rusalka');
    fireEvent.click(screen.getByTestId('agent-delete'));
    fireEvent.change(screen.getByTestId('agent-delete-confirm-input'), { target: { value: 'rusalka' } });
    fireEvent.click(screen.getByTestId('agent-delete-confirm'));

    await waitFor(() => expect(screen.queryByTestId('agent-card-rusalka')).toBeNull());
    expect(screen.getByTestId('agent-card-other')).toBeTruthy();
  });
});
