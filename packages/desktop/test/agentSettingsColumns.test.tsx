import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { render, screen, fireEvent, cleanup, waitFor } from '@testing-library/react';
import type { AgentDefaults, AgentView } from '@harkroom/shared';
import { useActiveStore as useAppStore } from '../src/state/communities';
import { usePrefsStore } from '../src/state/prefsStore';
import { Controller, setController } from '../src/state/controller';
import { AgentsSettings } from '../src/components/settings/AgentsSettings';
import { acc } from './helpers/fakeApi';

/**
 * 설정 폭 PR 2b — 개요 「한눈에」·실행 두 칸·권한 두 칸. 칸은 옮기기만 했으니 **어느 칸에 서는지**만 잰다
 * (칸이 몇 단으로 보이는지는 컨테이너 쿼리라 jsdom 이 못 잰다 — 캡처가 잰다).
 */

const agent = (handle: string, extra: Partial<AgentView> = {}): AgentView => ({
  id: `id-${handle}`, handle, displayName: handle, kind: 'agent', isAdmin: false, role: 'member', assignment: null, invokeScope: 'community', credentialScope: 'none', invokers: [], delegates: [], mcpServers: [],
  instructions: '', harness: 'claude-code', model: 'claude-opus-5-5', effort: 'high', workingDir: null,
  mentionPermission: 'auto', ownerAccountId: null, disabled: false, deleted: false, runnerVersion: null,
  claudeLane: null,
  stopRequestedAt: null, stopAckedAt: null, lastTurnAt: null,
  status: 'available', statusText: null, avatarAttachmentId: null, ...extra,
});

beforeEach(() => {
  usePrefsStore.getState().setLocale('ko');
  useAppStore.getState().reset();
  useAppStore.getState().set({ me: acc('u1', 'admin', 'human', true) });
  setController({
    listAgents: vi.fn(async () => [agent('rusalka')]),
    listPats: vi.fn(async () => []),
    listGrants: vi.fn(async () => []),
    agentDefaults: vi.fn(async (): Promise<AgentDefaults> => ({ harness: 'claude-code', model: null, effort: null })),
    agentMemory: vi.fn(async () => []),
    refreshAccounts: vi.fn(async () => undefined),
  } as unknown as Controller);
});
afterEach(() => { cleanup(); usePrefsStore.getState().setLocale('system'); });

const col = (el: HTMLElement) => el.closest('[data-settings-col]')?.getAttribute('data-settings-col');

describe('설정 폭 2b — 에이전트 편집 칸', () => {
  it('개요: 「한눈에」가 둘째 칸에 서고, 누르면 그 탭으로 간다', async () => {
    render(<AgentsSettings />);
    fireEvent.click(await screen.findByTestId('agent-card-rusalka'));
    const glance = await screen.findByTestId('agent-glance');
    expect(col(glance)).toBe('secondary');
    expect(screen.getByTestId('agent-glance-run').textContent).toContain('claude-opus-5-5 · high · 배정 없음');
    // 기억 칸은 이미 불러 둔 목록의 개수다(designer #1263 nit 2) — 불러오기 전이면 「—」. 「한눈에」가 따로 부르지 않는다.
    await waitFor(() => expect(screen.getByTestId('agent-glance-memory').textContent).toContain('항목 0개'));
    fireEvent.click(screen.getByTestId('agent-glance-run'));
    expect(screen.getByTestId('agent-tab-run').getAttribute('aria-selected')).toBe('true');
  });

  it('실행: 무엇으로(주 칸) | 어디서 — 배정(둘째 칸)', async () => {
    render(<AgentsSettings />);
    fireEvent.click(await screen.findByTestId('agent-card-rusalka'));
    const run = await screen.findByTestId('agent-run-columns');
    expect(col(screen.getByTestId('agent-assignment-current'))).toBe('secondary');
    expect(run.querySelector('[data-settings-col="main"]')!.textContent).toContain('AI 설정');
  });

  it('권한: 권한 폼(주 칸) | 누가 부를 수 있나(둘째 칸)', async () => {
    render(<AgentsSettings />);
    fireEvent.click(await screen.findByTestId('agent-card-rusalka'));
    const perm = await screen.findByTestId('agent-permissions-columns');
    expect(perm.querySelector('[data-settings-col="main"]')!.textContent).toContain('멘션 권한');
    expect(perm.querySelector('[data-settings-col="secondary"]')!.textContent).toContain('누가 부를 수 있고');
  });
});
