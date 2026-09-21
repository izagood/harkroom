/**
 * 이 머신의 오퍼레이터 로컬 설정(스펙 2026-09-20 §3 능력). 재는 것은 셋이다: Tauri 표면이 없으면
 * 절 자체가 없다, 있으면 현재 항목을 읽어 그리고 체크·저장이 Rust 커맨드에 **이름·URL·문자열만**
 * 넘긴다, 등록 안 된 커뮤니티는 그렇다고 말한다.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { render, screen, fireEvent, cleanup, waitFor } from '@testing-library/react';
import { LocalOperatorRow } from '../src/components/settings/LocalOperatorRow';
import { setController, type Controller } from '../src/state/controller';
import { usePrefsStore } from '../src/state/prefsStore';

const BASE = 'https://example.com';
beforeEach(() => {
  usePrefsStore.getState().setLocale('ko');
  setController({ api: { baseUrl: BASE } } as unknown as Controller);
});
afterEach(() => {
  usePrefsStore.getState().setLocale('system');
  cleanup();
  delete (globalThis as Record<string, unknown>).__TAURI_INTERNALS__;
});

function fakeTauri(list: unknown) {
  const invoke = vi.fn(async (cmd: string) => (cmd === 'operator_agents_list' ? list : {}));
  (globalThis as Record<string, unknown>).__TAURI_INTERNALS__ = { invoke, metadata: { currentWindow: { label: 'main' } } };
  return invoke;
}

describe('LocalOperatorRow', () => {
  it('Tauri 표면이 없으면 아무것도 그리지 않는다 — 그 머신에는 오퍼레이터가 없다', () => {
    render(<LocalOperatorRow agentId="a-1" />);
    expect(screen.queryByTestId('agent-local-operator')).toBeNull();
  });

  it('항목이 있으면 체크된 채 작업 디렉터리를 보이고, 저장은 URL·id·문자열만 넘긴다', async () => {
    const invoke = fakeTauri({ communities: [{ baseUrl: BASE, registered: true, agents: { 'a-1': { workingDir: '~/x' } } }] });
    render(<LocalOperatorRow agentId="a-1" />);
    const box = await screen.findByLabelText('이 머신의 오퍼레이터가 이 에이전트를 돌릴 수 있게') as HTMLInputElement;
    expect(box.checked).toBe(true);
    const dir = screen.getByLabelText('이 머신에서의 작업 디렉터리') as HTMLInputElement;
    expect(dir.value).toBe('~/x');
    expect(screen.queryByTestId('agent-local-unregistered')).toBeNull();
    fireEvent.change(dir, { target: { value: '~/y' } });
    fireEvent.click(screen.getByText('저장'));
    await waitFor(() => expect(invoke).toHaveBeenCalledWith('operator_agent_set', { baseUrl: BASE, agentId: 'a-1', config: { workingDir: '~/y' } }));
    expect((await screen.findByTestId('agent-local-notice')).textContent).toContain('저장했다');
  });

  it('체크를 끄면 remove, 켜면 set — 등록 안 된 커뮤니티면 그렇다고 말한다', async () => {
    const invoke = fakeTauri({ communities: [{ baseUrl: BASE, registered: false, agents: {} }] });
    render(<LocalOperatorRow agentId="a-2" />);
    const box = await screen.findByLabelText('이 머신의 오퍼레이터가 이 에이전트를 돌릴 수 있게') as HTMLInputElement;
    expect(box.checked).toBe(false);
    expect(screen.getByTestId('agent-local-unregistered')).toBeTruthy();
    fireEvent.click(box);
    await waitFor(() => expect(invoke).toHaveBeenCalledWith('operator_agent_set', { baseUrl: BASE, agentId: 'a-2', config: { workingDir: '' } }));
  });

  it('다른 커뮤니티의 항목은 이 커뮤니티의 것이 아니다', async () => {
    fakeTauri({ communities: [{ baseUrl: 'https://other.example.com', registered: true, agents: { 'a-1': {} } }] });
    render(<LocalOperatorRow agentId="a-1" />);
    const box = await screen.findByLabelText('이 머신의 오퍼레이터가 이 에이전트를 돌릴 수 있게') as HTMLInputElement;
    expect(box.checked).toBe(false);
  });
});
