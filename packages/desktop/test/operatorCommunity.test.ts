/**
 * 격리 C P6 — 오퍼레이터 명령의 `community` 가 **부르는 그 순간**의 커뮤니티로 정해지는가(security P6-F1).
 * 커뮤니티 둘이 다 붙은 뒤 전환해도, 화면 호출은 활성 커뮤니티로, 컨트롤러에 묶인 호출은 자기 커뮤니티로 간다.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { setActiveCommunityResolver, withCommunity } from '../src/lib/operatorCommunity';
import { listLocalAgents, setLocalAgent } from '../src/lib/operatorLocal';
import { RunnerLauncher, tauriDaemonObserver } from '../src/lib/runnerLauncher';

const A = 'https://a.example.com';
const B = 'https://b.example.com';
let active: string | null = null;
let invoke: ReturnType<typeof vi.fn>;

beforeEach(() => {
  active = null;
  setActiveCommunityResolver(() => active);
  invoke = vi.fn(async (cmd: string) => (cmd === 'daemon_list_runners' ? { daemonPid: 1, attached: true, runners: [] } : { communities: [] }));
  (globalThis as { __TAURI_INTERNALS__?: unknown }).__TAURI_INTERNALS__ = { invoke };
});
afterEach(() => {
  delete (globalThis as { __TAURI_INTERNALS__?: unknown }).__TAURI_INTERNALS__;
  setActiveCommunityResolver(() => null);
});

const sent = (cmd: string) => invoke.mock.calls.filter(([c]) => c === cmd).map(([, args]) => (args as { community?: string } | undefined)?.community);

describe('withCommunity', () => {
  it('직접 준 값 > 인자의 baseUrl > 활성 커뮤니티 순이고, 모두 모르면 싣지 않는다', () => {
    active = A;
    expect(withCommunity({ community: B, baseUrl: A })).toMatchObject({ community: B });
    expect(withCommunity({ baseUrl: B })).toMatchObject({ community: B });
    expect(withCommunity({ x: 1 })).toEqual({ x: 1, community: A });
    active = null;
    expect(withCommunity({ x: 1 })).toEqual({ x: 1 });
    expect(withCommunity()).toBeUndefined();
  });
});

describe('커뮤니티 둘이 붙은 뒤 전환(security P6-F1)', () => {
  it('화면 호출은 그 순간의 활성 커뮤니티로 간다 — 마지막으로 붙은 커뮤니티가 아니다', async () => {
    // A 다음 B 가 붙었고(마지막 = B), 사람이 A 로 전환했다.
    active = B;
    active = A;
    await listLocalAgents();
    active = B;
    await listLocalAgents();
    expect(sent('operator_agents_list')).toEqual([A, B]);
  });

  it('커뮤니티를 고치는 명령은 활성 커뮤니티와 무관하게 그 커뮤니티의 오퍼레이터로 간다', async () => {
    active = A;
    await setLocalAgent(B, 'agent-1', {});
    expect(sent('operator_agent_set')).toEqual([B]);
  });

  it('컨트롤러에 묶인 러너 관측은 자기 커뮤니티로 간다', async () => {
    active = A;
    const launcherB = new RunnerLauncher(tauriDaemonObserver, { read: async () => null }, () => B);
    await launcherB.ensureOperator();
    expect(sent('daemon_list_runners')).toEqual([B]);
    expect(await listLocalAgents(B)).toBeTruthy();
    expect(sent('operator_agents_list')).toEqual([B]);
  });
});
