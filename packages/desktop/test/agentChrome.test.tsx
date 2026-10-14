/**
 * 에이전트별 Claude in Chrome 스위치(스레드 e8c8365d). 판정은 서버(켜기는 사람 세션만)·러너(읽기 전용 닫힘)·
 * 오퍼레이터 기계(`OperatorCapabilities.chrome`)가 한다 — 여기서 재는 것은 켜기 전에 경고를 한 번 읽히는가,
 * 막힌 까닭이 보이고 켜기만 막히는가(끄기는 늘 된다), 서버 거절이 사람 말로 보이는가다.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { render, screen, fireEvent, cleanup, waitFor } from '@testing-library/react';
import type { AgentView } from '@harkroom/shared';
import { AgentChromeSection } from '../src/components/settings/AgentChromeSection';
import { setController, type Controller } from '../src/state/controller';
import { usePrefsStore } from '../src/state/prefsStore';
import { ApiError } from '../src/lib/api';
import { acc } from './helpers/fakeApi';

const agent = (overrides: Partial<AgentView> = {}): AgentView => ({
  ...(acc('agent-1', 'qa', 'agent', false, { ownerAccountId: 'owner-1' }) as unknown as AgentView),
  instructions: '', harness: 'claude-code', model: null, effort: null, workingDir: null,
  mentionPermission: 'auto', runnerVersion: null, stopRequestedAt: null, stopAckedAt: null,
  lastTurnAt: null, claudeLane: null, assignment: null, chromeEnabled: false, ...overrides,
});

function setup(updateAgent = vi.fn(async (_id: string, patch: Record<string, unknown>) => agent(patch as Partial<AgentView>))) {
  setController({ updateAgent } as unknown as Controller);
  return updateAgent;
}

beforeEach(() => { usePrefsStore.getState().setLocale('ko'); });
afterEach(() => { usePrefsStore.getState().setLocale('system'); cleanup(); });

const toggle = () => screen.getByTestId('agent-chrome-toggle') as HTMLInputElement;

describe('AgentChromeSection', () => {
  it('켜기는 바로 저장하지 않고 경고 셋(로그인된 사이트·프롬프트 주입·사람 부재)을 먼저 보인다', async () => {
    const update = setup();
    const onUpdated = vi.fn();
    render(<AgentChromeSection agent={agent()} machine="available" onUpdated={onUpdated} />);
    fireEvent.click(toggle());
    expect(update).not.toHaveBeenCalled();
    const warning = screen.getByTestId('agent-chrome-warning');
    expect(warning.textContent).toContain('로그인된 모든 사이트');
    expect(warning.textContent).toContain('프롬프트 주입');
    expect(warning.textContent).toContain('사람이 자리에 없어도');
    fireEvent.click(screen.getByTestId('agent-chrome-confirm'));
    await waitFor(() => expect(update).toHaveBeenCalledWith('agent-1', { chromeEnabled: true }));
    await waitFor(() => expect(onUpdated).toHaveBeenCalled());
    expect(screen.queryByTestId('agent-chrome-warning')).toBeNull();
  });

  it('경고에서 취소하면 저장하지 않고 꺼진 채다', () => {
    const update = setup();
    render(<AgentChromeSection agent={agent()} machine="available" onUpdated={vi.fn()} />);
    fireEvent.click(toggle());
    fireEvent.click(screen.getByTestId('agent-chrome-cancel'));
    expect(update).not.toHaveBeenCalled();
    expect(toggle().checked).toBe(false);
  });

  it('끄기는 경고 없이 바로 저장한다', async () => {
    const update = setup();
    render(<AgentChromeSection agent={agent({ chromeEnabled: true })} machine="available" onUpdated={vi.fn()} />);
    fireEvent.click(toggle());
    await waitFor(() => expect(update).toHaveBeenCalledWith('agent-1', { chromeEnabled: false }));
  });

  it.each([
    ['remote', {}, '원격 오퍼레이터'],
    ['no_extension', {}, '확장이 없다'],
    ['available', { mentionPermission: 'readonly' }, '읽기 전용'],
  ] as const)('막힌 까닭(%s)이 있으면 꺼진 스위치를 켤 수 없고 까닭을 말한다', (machine, over, text) => {
    setup();
    render(<AgentChromeSection agent={agent(over as Partial<AgentView>)} machine={machine} onUpdated={vi.fn()} />);
    expect(toggle().disabled).toBe(true);
    expect(screen.getByTestId('agent-chrome-status').textContent).toContain(text);
  });

  it('켜진 채 막혔으면 「켜져 있지만 붙지 않는다」를 말하고 끌 수는 있다', async () => {
    const update = setup();
    render(<AgentChromeSection agent={agent({ chromeEnabled: true })} machine="remote" onUpdated={vi.fn()} />);
    expect(screen.getByTestId('agent-chrome-status').textContent).toContain('켜져 있지만 지금은 붙지 않는다');
    expect(toggle().disabled).toBe(false);
    fireEvent.click(toggle());
    await waitFor(() => expect(update).toHaveBeenCalledWith('agent-1', { chromeEnabled: false }));
  });

  it('기계 상태를 모르면(옛 오퍼레이터·오프라인) 막지 않고 그렇다고 말한다', () => {
    setup();
    render(<AgentChromeSection agent={agent()} machine={undefined} onUpdated={vi.fn()} />);
    expect(toggle().disabled).toBe(false);
    expect(screen.getByTestId('agent-chrome-status').textContent).toContain('읽지 못했다');
  });

  it('서버가 사람 세션이 아니라고 거절하면(403 human_session_required) 그 까닭을 보인다', async () => {
    setup(vi.fn(async () => { throw new ApiError(403, 'human_session_required', 'only a signed-in human can enable Chrome control'); }));
    render(<AgentChromeSection agent={agent()} machine="available" onUpdated={vi.fn()} />);
    fireEvent.click(toggle());
    fireEvent.click(screen.getByTestId('agent-chrome-confirm'));
    expect(await screen.findByText('Chrome 연동은 로그인한 사람만 켤 수 있다.')).toBeTruthy();
  });
});
