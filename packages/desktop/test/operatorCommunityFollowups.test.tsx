// 격리 C 후속(security #1640 n1·n2) — 커뮤니티를 바꿔도 오퍼레이터 명령이 엉뚱한 커뮤니티로 가지 않는가.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, renderHook, waitFor } from '@testing-library/react';
import { setController, type Controller } from '../src/state/controller';
import { useMcpSignIn } from '../src/components/settings/McpLocalAuth';
import { resetLocalLanesForTest, useLocalLanes } from '../src/lib/localLanes';

vi.mock('../src/lib/openExternal', () => ({ getExternalOpener: () => ({ open: async () => undefined }) }));

const A = 'https://a.example.com';
const B = 'https://b.example.com';
let calls: { cmd: string; args?: Record<string, unknown> }[];

beforeEach(() => {
  calls = [];
  (globalThis as unknown as { __TAURI_INTERNALS__?: unknown }).__TAURI_INTERNALS__ = {
    invoke: async (cmd: string, args?: Record<string, unknown>) => {
      calls.push({ cmd, args });
      if (cmd === 'operator_mcp_auth') return args?.action === 'start' ? { authUrl: 'https://auth.example.com' } : { state: 'pending' };
      if (cmd === 'operator_agents_list') return { communities: [], laneStatus: {} };
      throw new Error(cmd);
    },
  };
  resetLocalLanesForTest();
});
afterEach(() => {
  vi.useRealTimers();
  resetLocalLanesForTest();
  delete (globalThis as unknown as { __TAURI_INTERNALS__?: unknown }).__TAURI_INTERNALS__;
});

describe('MCP 로그인(security #1640 n1)', () => {
  it('로그인 중 다른 커뮤니티로 옮겨도 상태는 시작한 커뮤니티의 오퍼레이터에 묻는다', async () => {
    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] });
    setController({ api: { baseUrl: A } } as unknown as Controller);
    const { result } = renderHook(() => useMcpSignIn('jira', () => undefined, () => undefined));
    await act(async () => { result.current.signIn(); await Promise.resolve(); await Promise.resolve(); });
    await waitFor(() => expect(result.current.waiting).toBe(true));
    setController({ api: { baseUrl: B } } as unknown as Controller);
    await act(async () => { vi.advanceTimersByTime(1600); await Promise.resolve(); });
    const starts = calls.filter((c) => c.cmd === 'operator_mcp_auth' && c.args?.action === 'start');
    const polls = calls.filter((c) => c.cmd === 'operator_mcp_auth' && c.args?.action === 'status');
    expect(starts.map((c) => c.args?.community)).toEqual([A]);
    expect(polls.length).toBeGreaterThan(0);
    expect(polls.every((c) => c.args?.community === A)).toBe(true);
  });
});

describe('API 키 연결 표(security #1640 n2)', () => {
  it('커뮤니티를 바꾸면 다음 읽기에서 새 커뮤니티로 곧바로 다시 묻는다', async () => {
    setController({ api: { baseUrl: A } } as unknown as Controller);
    const { rerender } = renderHook(() => useLocalLanes());
    await waitFor(() => expect(calls.some((c) => c.cmd === 'operator_agents_list' && c.args?.community === A)).toBe(true));
    setController({ api: { baseUrl: B } } as unknown as Controller);
    rerender();
    await waitFor(() => expect(calls.some((c) => c.cmd === 'operator_agents_list' && c.args?.community === B)).toBe(true));
  });
});
