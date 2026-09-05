// Task 16 — 워크스페이스 기본값을 설정 목차의 별도 항목으로 분리한다.
//
// identity 문서 원칙 04: **개별 에이전트의 설정이 아니다.** 한 에이전트를 고치는 화면 안에
// 워크스페이스 전체에 걸리는 값이 앉아 있으면 지금 무엇을 고치고 있는지가 화면에서 사라진다
// ("이 화면 위계 혼란의 대부분이 여기서 나온다").
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { render, screen, cleanup, fireEvent, waitFor } from '@testing-library/react';
import type { AgentDefaults } from '@murmur/shared';
import { useActiveStore as useAppStore } from '../src/state/communities';
import { setController, type Controller } from '../src/state/controller';
import { AgentDefaultsSettings } from '../src/components/settings/AgentDefaultsSettings';
import { SETTINGS_GROUPS } from '../src/components/settings/sections';
import { acc } from './helpers/fakeApi';

const fakeController = () => {
  const c = {
    agentDefaults: vi.fn(async (): Promise<AgentDefaults> => (
      { harness: 'claude-code', model: 'sonnet-x', effort: 'high' }
    )),
    updateAgentDefaults: vi.fn(async (patch: Partial<AgentDefaults>): Promise<AgentDefaults> => (
      { harness: 'claude-code', model: null, effort: null, ...patch }
    )),
  };
  setController(c as unknown as Controller);
  return c;
};

const asAdmin = (isAdmin = true) => {
  useAppStore.getState().reset();
  useAppStore.getState().set({ me: acc('u1', 'jaebin', 'human', isAdmin) });
};

beforeEach(() => asAdmin());
afterEach(() => cleanup());

describe('Agent defaults — 목차의 별도 항목이다', () => {
  it('설정 목차에 서 있고 Agents 바로 뒤다', () => {
    const app = SETTINGS_GROUPS.find((g) => g.title === 'App')!;
    const ids = app.items.map((i) => i.id);
    expect(ids).toContain('agent-defaults');
    // 붙어 서야 둘의 관계가 읽힌다 — 하나는 개별, 하나는 워크스페이스 전체다.
    expect(ids.indexOf('agent-defaults')).toBe(ids.indexOf('agents') + 1);
  });
});

describe('AgentDefaultsSettings', () => {
  it('서버가 준 값으로 폼을 채운다', async () => {
    fakeController();
    render(<AgentDefaultsSettings />);
    expect((await screen.findByLabelText('기본 model') as HTMLInputElement).value).toBe('sonnet-x');
    expect((screen.getByLabelText('기본 effort') as HTMLSelectElement).value).toBe('high');
  });

  /**
   * **이 계약이 이 화면의 실질이다**(#171). `AgentsSettings` 에서 옮겨 온 회귀선이다.
   */
  it('기본 model 을 비우면 명시적 null 을 보낸다 — 키를 빼면 서버가 손대지 않는다', async () => {
    const c = fakeController();
    render(<AgentDefaultsSettings />);

    fireEvent.change(await screen.findByLabelText('기본 model'), { target: { value: '' } });
    fireEvent.click(screen.getByRole('button', { name: '기본값 저장' }));

    await waitFor(() => expect(c.updateAgentDefaults).toHaveBeenCalled());
    const patch = c.updateAgentDefaults.mock.calls[0]![0];
    // undefined 로 보내면 JSON.stringify 가 키를 통째로 버려 '손대지 않음'이 된다.
    expect(patch.model).toBeNull();
    expect('model' in patch).toBe(true);
  });

  it('저장하면 저장했다고 말한다 — 눌렀는데 아무 일이 없으면 또 누른다', async () => {
    fakeController();
    render(<AgentDefaultsSettings />);
    fireEvent.click(await screen.findByRole('button', { name: '기본값 저장' }));
    expect(await screen.findByText('저장했다')).toBeTruthy();
  });

  it('조회가 실패하면 오류를 보인다', async () => {
    const c = fakeController();
    c.agentDefaults.mockRejectedValue(new Error('boom'));
    render(<AgentDefaultsSettings />);
    expect((await screen.findByRole('alert')).textContent).toContain('기본값을 불러오지 못했다');
  });

  it('admin 이 아니면 폼이 없다 — 권한 없음은 오류가 아니다', async () => {
    asAdmin(false);
    const c = fakeController();
    render(<AgentDefaultsSettings />);

    expect(await screen.findByText(/admin 뿐이다/)).toBeTruthy();
    expect(screen.queryByLabelText('기본 harness')).toBeNull();
    // 403 이 날 것을 알면서 부르지 않는다 — 붉은 글이 아무 잘못 없이 뜬다.
    expect(c.agentDefaults).not.toHaveBeenCalled();
    expect(screen.queryByRole('alert')).toBeNull();
  });
});
