// gh 계정 보고(D1) — 이름·줄만, 커뮤니티별로 거른다.
import { describe, it, expect } from 'vitest';
import { parseGhReport } from '@harkroom/shared/operatorProtocol';
import { buildGhReport, createGhLedger } from '../src/ghReport.js';
import { createCommunity } from '../src/community.js';
import type { AssignmentReconciler } from '../src/assignments.js';
import type { LinkDialer } from '../src/serverLink.js';

const reconciler = {
  announce: () => [], onAssign: async () => 'started', onUnassign: async () => {}, onRunnerExit: () => {},
  restart: () => false, setLocal: () => {}, laneMismatch: () => false, noteRunnerLane: () => {}, lanePending: () => [],
} as unknown as AssignmentReconciler;

const merge = {
  ghUser: 'legacy-user',
  byScope: { 'work-org/*': 'work-bot', 'work-org/app': 'work-admin', 'me/notes': 'me', 'other-co/secret': 'other-bot' },
  token: 'ghp_SHOULD_NOT_LEAK',
} as never;

describe('buildGhReport', () => {
  it('이 커뮤니티가 머지로 물은 저장소에 맞는 줄만 · 토큰/이메일 칸은 없다', () => {
    const ledger = createGhLedger();
    ledger.noteRepo('https://work.example.com', 'Work-Org/App');
    ledger.noteRepo('https://me.example.com', 'me/notes');
    ledger.noteReach('https://work.example.com', 'work-org/app', 'work-admin', true);
    ledger.noteReach('https://me.example.com', 'me/notes', 'me', true);
    const work = buildGhReport({ merge, logins: ['work-admin', 'me', 'bad login!'], repos: ledger.repos('https://work.example.com'), reach: ledger.reach('https://work.example.com') });
    expect(work).toEqual({
      logins: ['me', 'work-admin'],
      byScope: { 'work-org/*': 'work-bot', 'work-org/app': 'work-admin' },
      defaultGhUser: 'legacy-user',
      reach: [{ scope: 'work-org/app', login: 'work-admin', reachable: true }],
    });
    const json = JSON.stringify(work);
    expect(json).not.toMatch(/ghp_|token|email|@/i);
    expect(json).not.toContain('other-co');
    expect(json).not.toContain('me/notes');
    // 서버 파서를 지나도 같은 값이다.
    expect(parseGhReport(JSON.parse(json))).toEqual(work);
    const me = buildGhReport({ merge, logins: [], repos: ledger.repos('https://me.example.com'), reach: ledger.reach('https://me.example.com') });
    expect(me.byScope).toEqual({ 'me/notes': 'me' });
  });

  it('머지로 물은 저장소가 없으면 줄은 비어 있다', () => {
    expect(buildGhReport({ merge, logins: ['me'], repos: new Set(), reach: new Map() }).byScope).toEqual({});
  });

  it('parseGhReport 는 모르는 칸(토큰 등)을 버린다', () => {
    const r = parseGhReport({ logins: ['a', 'x y'], byScope: { 'o/r': 'a', BAD: 'a' }, token: 'ghp_x', email: 'a@example.com', reach: [{ scope: 'o/r', login: 'a', reachable: 'maybe' }] });
    expect(r).toEqual({ logins: ['a'], byScope: { 'o/r': 'a' }, defaultGhUser: null, reach: [] });
    expect(parseGhReport({ byScope: {} })).toBeNull();
  });
});

describe('community gh.report', () => {
  const run = async (agents: Record<string, object>) => {
    const sent: string[] = [];
    const dial: LinkDialer = (_u, _t, h) => { h.onOpen({ send: (d) => sent.push(d), close: () => {} }); };
    const report = { logins: ['me'], byScope: {}, defaultGhUser: null, reach: [] };
    const c = createCommunity({
      baseUrl: 'https://work.example.com', token: 'hkop_x', agents, reconciler, dial, schedule: () => {}, log: () => {},
      heartbeatMs: 1000,
      heartbeat: { status: async () => ({ turns: { running: 0, max: null } }), machine: async () => null, gh: async () => report },
    });
    c.start();
    await new Promise((r) => setTimeout(r, 0));
    c.stop();
    return sent.map((d) => JSON.parse(d)).filter((f) => f.type === 'gh.report');
  };

  it('이 커뮤니티에 에이전트가 붙어 있을 때만 보낸다', async () => {
    expect(await run({})).toEqual([]);
    // 배정이 아직 없으면 주인이 같은 에이전트도 없다 — 머신 값(로그인 목록)은 빼고 보낸다(아래 n7).
    expect(await run({ a: {} })).toEqual([{ type: 'gh.report', report: { logins: [], byScope: {}, defaultGhUser: null, reach: [] } }]);
  });

  // n7 결정 A — 로그인 목록·옛 기본값(머신 값)은 이 오퍼레이터 주인의 에이전트가 이 커뮤니티에 붙어 있을 때만 싣는다.
  const runOwned = async (selfOwner: string | null, agentOwners: (string | null)[]) => {
    const sent: string[] = [];
    let open: ((frame: string) => void) | null = null;
    const dial: LinkDialer = (_u, _t, h) => {
      h.onOpen({ send: (d) => sent.push(d), close: () => {} });
      open = (d) => h.onMessage(d);
    };
    const report = {
      logins: ['me', 'work-bot'], byScope: { 'work-org/app': 'work-bot' }, defaultGhUser: 'legacy-user',
      reach: [{ scope: 'work-org/app', login: 'work-bot', reachable: true as const }],
    };
    const fetchImpl = (async () => new Response(JSON.stringify({ id: 'op1', ownerAccountId: selfOwner }), { status: 200 })) as typeof fetch;
    const agents = { local: {}, ...Object.fromEntries(agentOwners.map((_, i) => [`a${i}`, {}])) };
    const c = createCommunity({
      baseUrl: 'https://work.example.com', token: 'hkop_x', agents, reconciler, dial, schedule: () => {}, log: () => {},
      fetchImpl, heartbeatMs: 60_000,
      heartbeat: { status: async () => ({ turns: { running: 0, max: null } }), machine: async () => null, gh: async () => report },
    });
    c.start();
    await new Promise((r) => setTimeout(r, 0));
    agentOwners.forEach((owner, i) => open!(JSON.stringify({ type: 'assign', agentId: `a${i}`, definition: { agentId: `a${i}`, ownerAccountId: owner, mcpServers: [] } })));
    await new Promise((r) => setTimeout(r, 10));
    c.stop();
    const frames = sent.map((d) => JSON.parse(d)).filter((f) => f.type === 'gh.report');
    return frames.at(-1)?.report;
  };
  const machineless = { byScope: { 'work-org/app': 'work-bot' }, reach: [{ scope: 'work-org/app', login: 'work-bot', reachable: true }] };

  it('주인이 같은 에이전트가 붙어 있으면 로그인 목록·옛 기본값을 싣는다', async () => {
    expect(await runOwned('acc-me', ['acc-me'])).toEqual({ ...machineless, logins: ['me', 'work-bot'], defaultGhUser: 'legacy-user' });
    // 남의 에이전트와 함께 붙어 있어도 하나가 주인 것이면 싣는다.
    expect(await runOwned('acc-me', ['acc-other', 'acc-me'])).toEqual({ ...machineless, logins: ['me', 'work-bot'], defaultGhUser: 'legacy-user' });
  });

  it('주인이 다른 에이전트만 붙어 있으면 로그인 목록·옛 기본값은 빼고 줄·닿음은 그대로 보낸다', async () => {
    expect(await runOwned('acc-me', ['acc-other'])).toEqual({ ...machineless, logins: [], defaultGhUser: null });
    expect(await runOwned('acc-me', [null])).toEqual({ ...machineless, logins: [], defaultGhUser: null });
  });

  it('오퍼레이터 주인을 못 읽거나 배정이 없으면 로그인 목록을 싣지 않는다', async () => {
    expect(await runOwned(null, ['acc-me'])).toEqual({ ...machineless, logins: [], defaultGhUser: null });
    expect(await runOwned('acc-me', [])).toEqual({ ...machineless, logins: [], defaultGhUser: null });
  });
});
