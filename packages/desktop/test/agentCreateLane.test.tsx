/**
 * 만들기 화면의 API 키 연결(n19, designer 시안 v1 · security G1~G5).
 *  - 컨트롤러 순서: lane 설정 → 배정 → 비밀 주기(비밀 화면과 같은 `putSecretGrant`, 이 맥에 묶음). 앞 단계가 실패하면 뒤를 하지 않는다.
 *    비밀 주기가 실패하면 배정을 되돌린다 — 「API 키로」 고른 에이전트가 허락 없이 붙어 있지 않게.
 *  - 화면: 내 비밀만·이름만 싣는다 · 고르면 Give 안내 · 「이 맥」 끄면 [API key] 잠금 · 못 쓰는 하네스는 잠금 · 실패 상자.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { render, screen, fireEvent, cleanup } from '@testing-library/react';
import type { AgentView } from '@harkroom/shared';
import { Controller } from '../src/state/controller';
import { resetCommunityRegistry, useActiveStore } from '../src/state/communities';
import { usePrefsStore } from '../src/state/prefsStore';
import { ApiError } from '../src/lib/api';
import { acc, fakeApi } from './helpers/fakeApi';
import { CreateLaneFailure, CreateModelConnectionField, createLaneSelection, type CreateLaneDraft } from '../src/components/settings/ModelConnectionField';

const order: string[] = [];
const setLocalAgent = vi.fn(async () => { order.push('local'); });
const setLocalAgentProviderLane = vi.fn(async () => { order.push('lane'); });
vi.mock('../src/lib/operatorLocal', () => ({
  hasOperatorLocalSurface: () => true,
  listLocalAgents: async () => ({ communities: [{ baseUrl: 'http://x', registered: true, operatorId: 'op-1', agents: {} }] }),
  setLocalAgent: (...args: unknown[]) => setLocalAgent(...(args as [])),
  setLocalAgentProviderLane: (...args: unknown[]) => setLocalAgentProviderLane(...(args as [])),
  removeLocalAgent: async () => undefined,
  onLocalAgentsChanged: () => () => {},
  registerLocalOperator: async () => ({ operatorId: 'op-1', name: 'n', baseUrl: 'http://x' }),
}));

const made = { id: 'agent-new' } as unknown as AgentView;
const LANE = { config: { baseUrl: 'https://gateway.example', secretName: 'example-key' }, secretId: 'sec-1' };
const TARGET = { baseUrl: 'http://x', operatorId: 'op-1' };

beforeEach(() => {
  usePrefsStore.getState().setLocale('ko');
  resetCommunityRegistry();
  useActiveStore.getState().reset();
  useActiveStore.getState().set({ me: acc('me-1', 'alice', 'human', false), connected: true, online: [] });
  order.length = 0;
  setLocalAgent.mockClear();
  setLocalAgentProviderLane.mockReset().mockImplementation(async () => { order.push('lane'); });
});
afterEach(() => { cleanup(); usePrefsStore.getState().setLocale('system'); });

function ctl(over: Record<string, unknown> = {}) {
  const api = fakeApi({
    createAgent: vi.fn(async () => made),
    assignAgent: vi.fn(async () => { order.push('assign'); return {} as never; }),
    unassignAgent: vi.fn(async () => { order.push('unassign'); }),
    putSecretGrant: vi.fn(async () => { order.push('give'); }),
    ...over,
  });
  return { api, c: new Controller(api, (() => ({ close: () => {} })) as never) };
}

describe('controller.createAgent — API 키 연결 단계', () => {
  it('lane 설정 → 배정 → 비밀 주기(비밀 화면과 같은 호출, 이 맥에 묶음) 순서다', async () => {
    const { api, c } = ctl();
    const out = await c.createAgent({ handle: 'newbie', displayName: 'newbie' }, { localOperator: TARGET, providerLane: LANE });
    expect(order).toEqual(['lane', 'local', 'assign', 'give']);
    expect(setLocalAgentProviderLane).toHaveBeenCalledWith('http://x', 'agent-new', LANE.config);
    expect((api as unknown as { putSecretGrant: ReturnType<typeof vi.fn> }).putSecretGrant)
      .toHaveBeenCalledWith('sec-1', { agentId: 'agent-new', channelId: null, operator: 'current' });
    expect(out.lane).toEqual({ saved: 'ok', given: 'ok', running: 'ok', reason: null });
  });

  it('lane 설정을 못 쓰면 배정도 주기도 하지 않는다(G3)', async () => {
    setLocalAgentProviderLane.mockImplementation(async () => { throw new Error('disk full'); });
    const { c } = ctl();
    const out = await c.createAgent({ handle: 'newbie', displayName: 'newbie' }, { localOperator: TARGET, providerLane: LANE });
    expect(order).toEqual([]);
    expect(out.lane).toMatchObject({ saved: 'fail', given: 'skip', running: 'skip' });
    expect(out.agent).toBe(made);
  });

  it('배정이 실패하면 주지 않는다', async () => {
    const { c } = ctl({ assignAgent: vi.fn(async () => { throw new ApiError(403, 'forbidden', 'no'); }) });
    const out = await c.createAgent({ handle: 'newbie', displayName: 'newbie' }, { localOperator: TARGET, providerLane: LANE });
    expect(order).toEqual(['lane', 'local']);
    expect(out.lane).toMatchObject({ saved: 'ok', given: 'skip', running: 'fail' });
  });

  it('주기가 실패하면 배정을 되돌린다 — 「아직 돌지 않는다」', async () => {
    const { c } = ctl({ putSecretGrant: vi.fn(async () => { throw new ApiError(409, 'secret_expired', 'expired'); }) });
    const out = await c.createAgent({ handle: 'newbie', displayName: 'newbie' }, { localOperator: TARGET, providerLane: LANE });
    expect(order).toEqual(['lane', 'local', 'assign', 'unassign']);
    expect(out.lane).toMatchObject({ saved: 'ok', given: 'fail', running: 'skip' });
    expect(out.lane?.reason).toBeTruthy();
  });

  it('API 키 없이 만들면 예전 그대로다(lane 단계 없음)', async () => {
    const { c } = ctl();
    const out = await c.createAgent({ handle: 'newbie', displayName: 'newbie' }, { localOperator: TARGET });
    expect(order).toEqual(['local', 'assign']);
    expect(out.lane).toBeUndefined();
  });
});

describe('만들기 화면 — 모델 연결', () => {
  const SECRETS = [{ id: 'sec-1', name: 'example-key', expired: false }, { id: 'sec-2', name: 'old-key', expired: true }];
  const field = (over: Partial<Parameters<typeof CreateModelConnectionField>[0]> = {}) => {
    const onChange = vi.fn();
    const value: CreateLaneDraft = { mode: 'apiKey', url: 'https://gateway.example', secretId: '' };
    render(<CreateModelConnectionField harness="claude-code" runHere value={value} onChange={onChange} pool={<span>POOL</span>}
      label="" secrets={SECRETS} handle="newbie" {...over} />);
    return onChange;
  };

  it('내 비밀만 이름으로 보이고, 만료된 것은 못 고른다 — 값 칸은 없다(G2)', () => {
    field();
    expect(screen.getByText('example-key')).toBeTruthy();
    const radios = [...screen.getByTestId('create-lane-secrets').querySelectorAll('[role=radio]')] as HTMLButtonElement[];
    expect(radios.map((r) => r.disabled)).toEqual([false, true]);
    expect(screen.getByTestId('create-lane-secrets').querySelector('input')).toBeNull();
    expect(screen.queryByTestId('create-lane-give')).toBeNull();
  });

  it('고르면 누구에게·어디서 주는지 안내가 뜬다(G4)', () => {
    field({ value: { mode: 'apiKey', url: 'https://gateway.example', secretId: 'sec-1' } });
    const give = screen.getByTestId('create-lane-give').textContent ?? '';
    expect(give).toContain('@newbie');
    expect(give).toContain('이 맥에서만');
    expect(give).toContain('모든 채널');
  });

  it('「이 맥」을 끄면 [API key] 가 잠기고 풀 칸으로 돌아간다', () => {
    const onChange = field({ runHere: false });
    expect(screen.getByTestId('create-lane-blocked')).toBeTruthy();
    expect(screen.queryByTestId('create-lane-form')).toBeNull();
    expect(screen.getByText('POOL')).toBeTruthy();
    fireEvent.click(screen.getAllByText(/API 키|API key/)[0]!);
    expect(onChange).not.toHaveBeenCalled();
  });

  it('API 키를 못 쓰는 하네스는 숨기지 않고 잠근다', () => {
    field({ harness: 'gemini' });
    expect(screen.getByTestId('create-model-connection')).toBeTruthy();
    expect(screen.getByTestId('create-lane-blocked').textContent).toMatch(/claude-code/);
  });

  it('내 비밀이 없으면 할 일 한 줄', () => {
    field({ secrets: [] });
    expect(screen.getByTestId('create-lane-no-secrets')).toBeTruthy();
  });

  it('createLaneSelection: 주소·내 비밀이 다 차야 하고 만료는 받지 않는다', () => {
    expect(createLaneSelection({ mode: 'apiKey', url: 'https://gateway.example/', secretId: 'sec-1' }, SECRETS))
      .toEqual({ config: { baseUrl: 'https://gateway.example', secretName: 'example-key' }, secretId: 'sec-1' });
    expect(createLaneSelection({ mode: 'apiKey', url: 'https://gateway.example', secretId: 'sec-2' }, SECRETS)).toBeNull();
    expect(createLaneSelection({ mode: 'apiKey', url: 'http://gateway.example', secretId: 'sec-1' }, SECRETS)).toBeNull();
    expect(createLaneSelection({ mode: 'pool', url: 'https://gateway.example', secretId: 'sec-1' }, SECRETS)).toBeNull();
  });

  it('실패 상자: 단계를 ✓/✕/– 로 보이고, 이미 준 허락은 거두는 곳을 쓴다(G5)', () => {
    render(<CreateLaneFailure handle="newbie" secretName="example-key"
      result={{ saved: 'ok', given: 'ok', running: 'fail', reason: 'offline' }} onOpenSecrets={() => {}} onOpenAgent={() => {}} />);
    const box = screen.getByTestId('create-lane-failure').textContent ?? '';
    expect(box).toContain('✕');
    expect(screen.getByTestId('create-lane-given-note')).toBeTruthy();
    cleanup();
    render(<CreateLaneFailure handle="newbie" secretName="example-key" result={{ saved: 'ok', given: 'fail', running: 'skip', reason: 'expired' }} />);
    expect(screen.queryByTestId('create-lane-given-note')).toBeNull();
    expect(screen.getByTestId('create-lane-failure').textContent).toContain('아직 돌지 않는다');
  });

  it('실패 상자 줄 순서는 단계 줄과 같다: 만듦 → 저장 → 띄우기 → 주기(designer 1)', () => {
    render(<CreateLaneFailure handle="newbie" secretName="example-key" result={{ saved: 'ok', given: 'fail', running: 'skip', reason: 'expired' }} />);
    const rows = [...screen.getByTestId('create-lane-failure').querySelectorAll('li')].map((li) => li.textContent ?? '');
    expect(rows[0]).toContain('만듦');
    expect(rows[1]).toContain('저장');
    expect(rows[2]).toContain('이 맥');
    expect(rows[3]).toContain('example-key');
    expect(rows.map((r) => r[0])).toEqual(['✓', '✓', '–', '✕']);
  });

  it('주기 실패 + 배정 되돌리기 실패면 붙은 채라는 줄이 뜬다(designer n3)', () => {
    render(<CreateLaneFailure handle="newbie" secretName="example-key" result={{ saved: 'ok', given: 'fail', running: 'ok', reason: 'expired' }} />);
    expect(screen.getByTestId('create-lane-stuck-note')).toBeTruthy();
  });
});
