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
    expect(await run({ a: {} })).toEqual([{ type: 'gh.report', report: { logins: ['me'], byScope: {}, defaultGhUser: null, reach: [] } }]);
  });
});
