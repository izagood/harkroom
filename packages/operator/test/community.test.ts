// 커뮤니티 인스턴스 — 스펙 2026-09-20 §3 격리. 오퍼레이터는 머신당 하나이고 커뮤니티(=서버)
// 여럿에 붙는다. 격리는 스코핑 조건이 아니라 **인스턴스**로 강제한다(데스크탑 communities.ts
// 와 같은 패턴): 커뮤니티마다 링크·배정·로컬 설정을 따로 든 객체 하나.
import { describe, it, expect } from 'vitest';
import type { ServerToOperatorFrame } from '@harkroom/shared/operatorProtocol';
import { createCommunity } from '../src/community.js';
import type { AssignmentReconciler } from '../src/assignments.js';
import type { LinkDialer } from '../src/serverLink.js';

function fakeReconciler() {
  const calls: string[] = [];
  const reconciler: AssignmentReconciler = {
    onAssign: async (baseUrl, def, local) => { calls.push(`assign ${baseUrl} ${def.agentId} ${local?.workingDir ?? '-'}`); return 'spawned'; },
    onUnassign: async (baseUrl, agentId, drain) => { calls.push(`unassign ${baseUrl} ${agentId} ${drain}`); },
    announce: () => [{ agentId: 'a-1', runnerId: 'r-1', pid: 7 }],
  };
  return { reconciler, calls };
}

describe('community', () => {
  it('hello 에 로컬 설정의 에이전트와 살아 있는 러너를 싣는다', () => {
    const sent: string[] = [];
    const dial: LinkDialer = (_u, _t, h) => { h.onOpen({ send: (d) => sent.push(d), close: () => {} }); };
    const { reconciler } = fakeReconciler();
    const c = createCommunity({
      baseUrl: 'https://example.com', token: 'hkop_x',
      agents: { 'a-1': { workingDir: '~/x' }, 'a-2': {} },
      reconciler, dial, schedule: () => {}, log: () => {},
    });
    c.start();
    const hello = JSON.parse(sent[0]!);
    expect(hello.type).toBe('hello');
    expect(hello.capabilities.agentIds.sort()).toEqual(['a-1', 'a-2']);
    expect(hello.runners).toEqual([{ agentId: 'a-1', runnerId: 'r-1', pid: 7 }]);
  });

  it('assign 은 로컬 설정과 함께 조정기로, unassign 도 조정기로 간다', async () => {
    let handlers: Parameters<LinkDialer>[2] | null = null;
    const dial: LinkDialer = (_u, _t, h) => { handlers = h; h.onOpen({ send: () => {}, close: () => {} }); };
    const { reconciler, calls } = fakeReconciler();
    const c = createCommunity({
      baseUrl: 'https://example.com', token: 'hkop_x', agents: { 'a-1': { workingDir: '~/x' } },
      reconciler, dial, schedule: () => {}, log: () => {},
    });
    c.start();
    const assign: ServerToOperatorFrame = { type: 'assign', agentId: 'a-1', definition: {
      agentId: 'a-1', handle: 'murmur', harness: 'claude-code', instructions: '', model: null, effort: null,
      mentionPermission: 'auto', workingDirDefault: null, credentialScope: 'none', ownerAccountId: null, mcpServers: [],
    } };
    handlers!.onMessage(JSON.stringify(assign));
    handlers!.onMessage(JSON.stringify({ type: 'unassign', agentId: 'a-1', drain: true }));
    await new Promise((r) => setTimeout(r, 0));
    expect(calls).toEqual(['assign https://example.com a-1 ~/x', 'unassign https://example.com a-1 true']);
    expect(c.assignments.has('a-1')).toBe(false);
  });

  it('로컬 설정에 없는 에이전트의 assign 은 거절한다 — 양쪽 동의', async () => {
    let handlers: Parameters<LinkDialer>[2] | null = null;
    const dial: LinkDialer = (_u, _t, h) => { handlers = h; h.onOpen({ send: () => {}, close: () => {} }); };
    const { reconciler, calls } = fakeReconciler();
    const lines: string[] = [];
    const c = createCommunity({
      baseUrl: 'https://example.com', token: 'hkop_x', agents: {},
      reconciler, dial, schedule: () => {}, log: (l) => lines.push(l),
    });
    c.start();
    handlers!.onMessage(JSON.stringify({ type: 'assign', agentId: 'stranger', definition: { agentId: 'stranger', handle: 's' } }));
    await new Promise((r) => setTimeout(r, 0));
    expect(calls).toEqual([]);
    expect(lines.some((l) => l.includes('stranger'))).toBe(true);
  });
});
