// 다른 기기에서 고친 gh 줄(D3) — `gh.lines.set` 을 받아 localMerge.set 으로 적고, 답하고, 보고를 다시 낸다.
import { mkdtemp, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { parseGhLinesResult, parseGhLinesSet, parseServerFrame } from '@harkroom/shared/operatorProtocol';
import { createCommunity, type CommunityDeps } from '../src/community.js';
import { createLocalMergePort, pickMergeGhUser } from '../src/localMerge.js';
import { readConfig } from '../src/config.js';
import type { AssignmentReconciler } from '../src/assignments.js';
import type { LinkHandlers, LinkDialer } from '../src/serverLink.js';
import type { Exec } from '../src/turnMerge.js';

const reconciler = {
  announce: () => [], onAssign: async () => 'started', onUnassign: async () => {}, onRunnerExit: () => {},
  restart: () => false, setLocal: () => {}, laneMismatch: () => false, noteRunnerLane: () => {}, lanePending: () => [],
} as unknown as AssignmentReconciler;

const STATUS = JSON.stringify({ hosts: { 'github.com': [{ login: 'work-admin', active: true }, { login: 'me', active: false }] } });

async function setup(opts: { agents?: Record<string, object>; ghLines?: CommunityDeps['ghLines'] | 'none'; ledger?: string[] } = {}) {
  const dir = await mkdtemp(join(tmpdir(), 'gh-lines-'));
  const configPath = join(dir, 'operator.json');
  const exec: Exec = async () => ({ code: 0, stdout: STATUS, stderr: '' });
  const port = createLocalMergePort({ configPath, ghPath: '/opt/gh', home: '/home/me', exec, host: 'mac-1' });
  const sent: Record<string, unknown>[] = [];
  let handlers: LinkHandlers | null = null;
  const dial: LinkDialer = (_u, _t, h) => { handlers = h; h.onOpen({ send: (d) => sent.push(JSON.parse(d)), close: () => {} }); };
  let reports = 0;
  const ghLines: CommunityDeps['ghLines'] = opts.ghLines === 'none' ? undefined
    : opts.ghLines ?? (async (p) => {
      const r = await port.set(p);
      const change = r.changes.find((x) => x.scope === p.scope);
      return { previous: change ? change.from : p.ghUser };
    });
  const ledgers: string[] = [];
  const c = createCommunity({
    baseUrl: 'https://work.example.com', token: 'hkop_x', agents: opts.agents ?? { a: {} }, reconciler, dial, schedule: () => {}, log: () => {},
    heartbeatMs: 60_000,
    heartbeat: {
      status: async () => ({ turns: { running: 0, max: null } }), machine: async () => null,
      gh: async () => {
        reports += 1;
        const merge = (await readConfig(configPath)).merge;
        return { logins: ['work-admin', 'me'], byScope: (merge?.byScope as Record<string, string> | undefined) ?? {}, defaultGhUser: null, reach: [] };
      },
    },
    ...(ghLines ? { ghLines } : {}),
    ghRepos: (baseUrl) => { ledgers.push(baseUrl); return new Set(opts.ledger ?? ['acme/app']); },
  });
  c.start();
  // 정해 둔 ms 만큼 자고 보면 느린 CI 에서 프레임이 아직 안 나갔다 — 그 프레임이 나갈 때까지 기다린다.
  if (Object.keys(opts.agents ?? { a: {} }).length > 0) await vi.waitFor(() => expect(sent.some((f) => f.type === 'gh.report')).toBe(true));
  else await new Promise((r) => setTimeout(r, 10));
  /** 답(`gh.lines.result`)이 올 프레임이면 그 requestId 의 답이 나갈 때까지, 답이 없을 프레임(`answered: false`)이면 잠깐 기다린다. */
  const deliver = async (frame: { type: string; requestId?: string; [k: string]: unknown }, o: { answered?: boolean } = {}) => {
    handlers!.onMessage(JSON.stringify(frame));
    if (o.answered === false) { await new Promise((r) => setTimeout(r, 30)); return; }
    await vi.waitFor(() => expect(sent.some((f) => f.type === 'gh.lines.result' && f.requestId === frame.requestId)).toBe(true));
  };
  return { c, sent, deliver, configPath, reportsSent: () => sent.filter((f) => f.type === 'gh.report'), results: () => sent.filter((f) => f.type === 'gh.lines.result'), reports: () => reports, ledgers };
}

describe('gh.lines.set (D3)', () => {
  it('파서 — 범위는 소문자로, 틀린 모양·requestId 는 버린다 · 결과의 모르는 code 는 failed', () => {
    expect(parseServerFrame(JSON.stringify({ type: 'gh.lines.set', requestId: 'r1', scope: 'Acme/App', ghUser: 'me' }))).not.toBeNull();
    expect(parseGhLinesSet({ requestId: 'r1', scope: 'Acme/App', ghUser: 'me' })).toEqual({ requestId: 'r1', scope: 'acme/app', ghUser: 'me' });
    expect(parseGhLinesSet({ requestId: 'r1', scope: 'acme/*', ghUser: null })).toEqual({ requestId: 'r1', scope: 'acme/*', ghUser: null });
    expect(parseGhLinesSet({ requestId: 'r1', scope: '*', ghUser: 'me' })).toBeNull();
    expect(parseGhLinesSet({ requestId: 'r1', scope: 'acme/ab*', ghUser: 'me' })).toBeNull();
    expect(parseGhLinesSet({ requestId: 'r1', scope: 'acme/app', ghUser: 'bad name' })).toBeNull();
    expect(parseGhLinesSet({ requestId: 'r 1', scope: 'acme/app', ghUser: 'me' })).toBeNull();
    expect(parseGhLinesResult({ requestId: 'r1', ok: false, code: 'weird' })).toEqual({ requestId: 'r1', ok: false, code: 'failed' });
    expect(parseGhLinesResult({ requestId: 'r1', ok: true })).toEqual({ requestId: 'r1', ok: true });
  });

  it('로그인된 이름이면 operator.json 의 byScope 에 적고 ok 로 답하고, 바뀐 보고를 다시 낸다 · 머지 계정 고르기가 새 줄을 본다', async () => {
    const t = await setup();
    expect(t.reportsSent()).toHaveLength(1);
    await t.deliver({ type: 'gh.lines.set', requestId: 'r1', scope: 'Acme/App', ghUser: 'work-admin' });
    expect(t.results()).toEqual([{ type: 'gh.lines.result', requestId: 'r1', ok: true }]);
    const merge = (await readConfig(t.configPath)).merge;
    expect(merge?.byScope).toEqual({ 'acme/app': 'work-admin' });
    expect(pickMergeGhUser(merge, 'acme/app')).toEqual({ login: 'work-admin', scope: 'acme/app' });
    // 다시 내는 보고는 답 뒤에 따로 읽어 만든다 — 그것도 나갈 때까지 기다린다.
    await vi.waitFor(() => expect(t.reportsSent()).toHaveLength(2));
    expect(t.reportsSent().at(-1)).toMatchObject({ report: { byScope: { 'acme/app': 'work-admin' } } });

    await t.deliver({ type: 'gh.lines.set', requestId: 'r2', scope: 'acme/app', ghUser: null });
    expect(t.results().at(-1)).toEqual({ type: 'gh.lines.result', requestId: 'r2', ok: true, previous: 'work-admin' });
    expect((await readConfig(t.configPath)).merge?.byScope).toEqual({});
    t.c.stop();
  });

  it('이 머신에 로그인되지 않은 이름은 unknown_login 으로 거절하고 파일을 건드리지 않는다', async () => {
    const t = await setup();
    await t.deliver({ type: 'gh.lines.set', requestId: 'r1', scope: 'acme/app', ghUser: 'stranger' });
    expect(t.results()).toEqual([{ type: 'gh.lines.result', requestId: 'r1', ok: false, code: 'unknown_login' }]);
    await expect(readFile(t.configPath, 'utf8')).rejects.toThrow();
    expect(t.reportsSent()).toHaveLength(1);
    t.c.stop();
  });

  it('이 커뮤니티에 로컬 에이전트가 없으면 no_agent · ghLines 가 없으면 unsupported · gh 실패는 failed', async () => {
    const none = await setup({ agents: {} });
    await none.deliver({ type: 'gh.lines.set', requestId: 'r1', scope: 'acme/app', ghUser: 'me' });
    expect(none.results()).toEqual([{ type: 'gh.lines.result', requestId: 'r1', ok: false, code: 'no_agent' }]);
    none.c.stop();
    const unsupported = await setup({ ghLines: 'none' });
    await unsupported.deliver({ type: 'gh.lines.set', requestId: 'r2', scope: 'acme/app', ghUser: 'me' });
    expect(unsupported.results()).toEqual([{ type: 'gh.lines.result', requestId: 'r2', ok: false, code: 'unsupported' }]);
    unsupported.c.stop();
    const broken = await setup({ ghLines: async () => { throw new Error('gh auth status failed: boom'); } });
    await broken.deliver({ type: 'gh.lines.set', requestId: 'r3', scope: 'acme/app', ghUser: 'me' });
    expect(broken.results()).toEqual([{ type: 'gh.lines.result', requestId: 'r3', ok: false, code: 'failed' }]);
    broken.c.stop();
  });

  it('이 커뮤니티 장부 밖의 범위는 out_of_community — 장부의 저장소와 그 owner 의 owner/* 만 받는다', async () => {
    let called = 0;
    const t = await setup({ ledger: ['acme/app'], ghLines: async () => { called += 1; return { previous: null }; } });
    await t.deliver({ type: 'gh.lines.set', requestId: 'r1', scope: 'other/app', ghUser: 'me' });
    await t.deliver({ type: 'gh.lines.set', requestId: 'r2', scope: 'other/*', ghUser: 'me' });
    await t.deliver({ type: 'gh.lines.set', requestId: 'r3', scope: 'acme/other', ghUser: 'me' });
    expect(t.results()).toEqual(['r1', 'r2', 'r3'].map((requestId) => ({ type: 'gh.lines.result', requestId, ok: false, code: 'out_of_community' })));
    expect(called).toBe(0);
    await t.deliver({ type: 'gh.lines.set', requestId: 'r4', scope: 'acme/app', ghUser: 'me' });
    await t.deliver({ type: 'gh.lines.set', requestId: 'r5', scope: 'acme/*', ghUser: 'me' });
    expect(t.results().slice(3)).toEqual([{ type: 'gh.lines.result', requestId: 'r4', ok: true }, { type: 'gh.lines.result', requestId: 'r5', ok: true }]);
    expect(called).toBe(2);
    expect(new Set(t.ledgers)).toEqual(new Set(['https://work.example.com']));
    t.c.stop();
    // 장부가 비면(이 커뮤니티가 아직 머지하지 않았다) 아무 범위도 받지 않는다.
    const empty = await setup({ ledger: [] });
    await empty.deliver({ type: 'gh.lines.set', requestId: 'r6', scope: 'acme/*', ghUser: 'me' });
    expect(empty.results()).toEqual([{ type: 'gh.lines.result', requestId: 'r6', ok: false, code: 'out_of_community' }]);
    empty.c.stop();
  });

  it('로컬 값을 덮어쓰면 previous 로 이전 값을 알린다', async () => {
    const t = await setup();
    await t.deliver({ type: 'gh.lines.set', requestId: 'r1', scope: 'acme/app', ghUser: 'me' });
    await t.deliver({ type: 'gh.lines.set', requestId: 'r2', scope: 'acme/app', ghUser: 'work-admin' });
    expect(t.results()).toEqual([
      { type: 'gh.lines.result', requestId: 'r1', ok: true },
      { type: 'gh.lines.result', requestId: 'r2', ok: true, previous: 'me' },
    ]);
    expect(parseGhLinesResult(t.results()[1]!)).toEqual({ requestId: 'r2', ok: true, previous: 'me' });
    expect(parseGhLinesResult({ requestId: 'r', ok: true, previous: 'bad name' })).toEqual({ requestId: 'r', ok: true });
    t.c.stop();
  });

  it('모양이 틀린 프레임에는 답하지 않는다(어느 요청인지 모른다) · 틀린 범위는 적지 않는다', async () => {
    let called = 0;
    const t = await setup({ ghLines: async () => { called += 1; } });
    await t.deliver({ type: 'gh.lines.set', requestId: 'r1', scope: '../etc', ghUser: 'me' }, { answered: false });
    expect(t.results()).toEqual([]);
    expect(called).toBe(0);
    t.c.stop();
  });
});
