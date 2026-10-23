// 오퍼레이터 박동(원격 호스트 관리 P3a) — 무엇을 싣고 무엇을 싣지 않나, 언제 보내나.
import { describe, it, expect, vi } from 'vitest';
import { parseOperatorStatus } from '@harkroom/shared/operatorProtocol';
import { clientIdFingerprint, collectMcpStatus, collectStatus, readMachineDigest } from '../src/heartbeat.js';
import { createCommunity } from '../src/community.js';
import type { AssignmentReconciler } from '../src/assignments.js';
import type { LinkDialer } from '../src/serverLink.js';

const reconciler: AssignmentReconciler = {
  onAssign: async () => 'spawned', onUnassign: async () => {}, restart: () => true, onRunnerExit: () => {}, announce: () => [], setLocal: () => 'none' as const, noteRunnerLane: () => {}, laneMismatch: () => false, laneMismatchOfRunner: () => false, lanePending: () => ({}),
};

describe('collectStatus', () => {
  it('턴 수·상한·에이전트별 턴을 싣고, 자격 증명 칸은 싣지 않는다. 서버 화이트리스트를 그대로 통과한다', async () => {
    const status = await collectStatus({
      startedAt: new Date('2026-10-06T00:00:00Z'),
      turns: () => ({ running: 3, max: 16 }),
      turnsByRunner: () => new Map([['r1', 2], ['r2', 1]]),
      runners: () => [{ runnerId: 'r1', agentId: 'a' }, { runnerId: 'r2', agentId: 'a' }, { runnerId: 'r3', agentId: 'b' }],
      dataDir: process.cwd(),
    });
    expect(status.turns).toEqual({ running: 3, max: 16 });
    expect(status.runners).toEqual([{ agentId: 'a', turns: 3 }, { agentId: 'b', turns: 0 }]);
    expect(status.memory!.totalBytes).toBeGreaterThan(0);
    expect(status.disk!.totalBytes).toBeGreaterThan(0);
    expect('credentials' in status).toBe(false);
    expect(parseOperatorStatus(JSON.parse(JSON.stringify(status)))).toEqual(status);
  });
});

describe('readMachineDigest', () => {
  it('원래 값이 아니라 sha256 hex 를 낸다 — 리눅스는 /etc/machine-id, 맥은 IOPlatformUUID', async () => {
    const linux = await readMachineDigest('linux', async () => 'abc123\n');
    expect(linux).toMatch(/^[0-9a-f]{64}$/);
    expect(linux).not.toContain('abc123');
    const mac = await readMachineDigest('darwin', async () => '', async () => '  "IOPlatformUUID" = "ABC123"\n');
    expect(mac).toMatch(/^[0-9a-f]{64}$/);
    expect(mac).not.toBe(linux);
  });
  it('못 읽으면 null', async () => {
    expect(await readMachineDigest('linux', async () => { throw new Error('ENOENT'); })).toBeNull();
    expect(await readMachineDigest('win32')).toBeNull();
  });
});

describe('community 박동', () => {
  it('hello 다음에 박동을 하나 내고, 주기마다 다시 낸다. stop 하면 멈춘다', async () => {
    vi.useFakeTimers();
    try {
      const sent: string[] = [];
      const dial: LinkDialer = (_u, _t, h) => { h.onOpen({ send: (d) => sent.push(d), close: () => {} }); };
      const c = createCommunity({
        baseUrl: 'https://example.com', token: 'hkop_x', agents: {}, reconciler, dial, schedule: () => {}, log: () => {},
        heartbeatMs: 1000,
        heartbeat: { status: async () => ({ turns: { running: 1, max: null } }), machine: async () => 'f'.repeat(64) },
      });
      c.start();
      await vi.advanceTimersByTimeAsync(0);
      const types = () => sent.map((d) => JSON.parse(d).type);
      expect(types()).toEqual(['hello', 'status']);
      const first = JSON.parse(sent[1]!);
      expect(first.status).toEqual({ turns: { running: 1, max: null } });
      expect(first.machine).toMatch(/^[0-9a-f]{64}$/);
      await vi.advanceTimersByTimeAsync(1000);
      expect(types().filter((t) => t === 'status')).toHaveLength(2);
      c.stop();
      await vi.advanceTimersByTimeAsync(5000);
      expect(types().filter((t) => t === 'status')).toHaveLength(2);
    } finally { vi.useRealTimers(); }
  });

  it('heartbeat 가 없으면 박동이 없다(옛 동작)', () => {
    const sent: string[] = [];
    const dial: LinkDialer = (_u, _t, h) => { h.onOpen({ send: (d) => sent.push(d), close: () => {} }); };
    createCommunity({ baseUrl: 'https://example.com', token: 'hkop_x', agents: {}, reconciler, dial, schedule: () => {}, log: () => {} }).start();
    expect(sent.map((d) => JSON.parse(d).type)).toEqual(['hello']);
  });
});

describe('박동의 커뮤니티 경계 — security #1203 F1·n7', () => {
  it('커뮤니티 둘에 러너가 하나씩 있으면 각 박동에 자기 에이전트만 실린다. 머신 값은 서버마다 다르다', async () => {
    const shared = {
      status: async () => ({ turns: { running: 2, max: 6 }, runners: [{ agentId: 'work-a', turns: 1 }, { agentId: 'home-b', turns: 1 }] }),
      machine: async () => 'e'.repeat(64),
    };
    const beatOf = async (baseUrl: string, agentId: string) => {
      const sent: string[] = [];
      const dial: LinkDialer = (_u, _t, h) => { h.onOpen({ send: (d) => sent.push(d), close: () => {} }); };
      createCommunity({ baseUrl, token: 'hkop_x', agents: { [agentId]: {} }, reconciler, dial, schedule: () => {}, log: () => {}, heartbeat: shared }).start();
      await new Promise((r) => setTimeout(r, 0));
      return JSON.parse(sent.find((d) => JSON.parse(d).type === 'status')!);
    };
    const work = await beatOf('https://work.example.com', 'work-a');
    const home = await beatOf('https://home.example.com', 'home-b');
    expect(work.status.runners).toEqual([{ agentId: 'work-a', turns: 1 }]);
    expect(home.status.runners).toEqual([{ agentId: 'home-b', turns: 1 }]);
    expect(JSON.stringify(work)).not.toContain('home-b');
    // 머신 전체 값은 그대로다.
    expect(work.status.turns).toEqual({ running: 2, max: 6 });
    expect(work.machine).not.toBe(home.machine);
    expect(work.machine).not.toBe('e'.repeat(64));
  });
});

describe('박동의 MCP 상태 — MCP 설정 v2 PR4', () => {
  const CLIENT = '1111111111.2222222222';
  const sources = {
    definitions: async () => ({
      operator: {
        slack: { type: 'http' as const, url: 'https://mcp.example.com/mcp', headers: { Authorization: 'Bearer SECRET-TOKEN' }, oauth: { clientId: CLIENT, callbackPort: 3118 } },
        local: { command: 'tool-mcp', args: ['--x'], env: { API_KEY: 'SECRET-ENV' } },
      },
      claude: { ctx: { type: 'sse' as const, url: 'https://ctx.example.com/sse' }, slack: { type: 'http' as const, url: 'https://other.example.com' } },
    }),
    auth: async (name: string) => (name === 'slack' ? { state: 'ok' as const, at: Date.UTC(2026, 9, 21, 8, 55), expiresAt: 1 } : { state: 'none' as const }),
  };

  it('이름마다 정의 유무·출처·transport·인증 상태·지문만 싣는다 — URL·헤더·env·토큰·Client ID 원문이 없다', async () => {
    const out = await collectMcpStatus(['slack', 'local', 'ctx', 'jira'], 'https://work.example.com', sources);
    expect(out).toEqual([
      { name: 'slack', defined: true, source: 'operator', transport: 'http', oauth: true, auth: 'ok', authAt: '2026-10-21T08:55:00.000Z', clientIdFp: clientIdFingerprint('https://work.example.com', CLIENT) },
      { name: 'local', defined: true, source: 'operator', transport: 'stdio' },
      { name: 'ctx', defined: true, source: 'claude', transport: 'sse', oauth: false, auth: 'none' },
      { name: 'jira', defined: false },
    ]);
    const json = JSON.stringify(out);
    for (const leak of ['SECRET', 'mcp.example.com', 'ctx.example.com', CLIENT, '1111111111', 'tool-mcp', 'API_KEY']) expect(json).not.toContain(leak);
    // 서버 화이트리스트를 그대로 통과한다.
    expect(parseOperatorStatus({ turns: { running: 0, max: null }, mcp: out })?.mcp).toEqual(out);
  });

  it('지문은 원문을 품지 않고, 같은 서버면 같고 서버가 다르면 다르다', () => {
    const a = clientIdFingerprint('https://work.example.com', CLIENT);
    expect(a).toMatch(/^[0-9a-f]{16}$/);
    expect(a).toBe(clientIdFingerprint('https://work.example.com', CLIENT));
    expect(a).not.toBe(clientIdFingerprint('https://home.example.com', CLIENT));
    expect(a).not.toBe(clientIdFingerprint('https://work.example.com', '9999999999.2222222222'));
  });

  it('커뮤니티 박동에는 그 커뮤니티가 배정한 에이전트가 켠 이름만 실린다 — 다른 커뮤니티 이름이 새지 않는다', async () => {
    const asked: string[][] = [];
    const shared = {
      status: async () => ({ turns: { running: 0, max: null } }),
      machine: async () => null,
      mcp: async (names: string[], baseUrl: string) => { asked.push(names); return collectMcpStatus(names, baseUrl, sources); },
    };
    const beatOf = async (baseUrl: string, agentId: string, mcpServers: string[]) => {
      const sent: string[] = [];
      const dial: LinkDialer = (_u, _t, h) => { h.onOpen({ send: (d) => sent.push(d), close: () => {} }); };
      const c = createCommunity({ baseUrl, token: 'hkop_x', agents: { [agentId]: {} }, reconciler, dial, schedule: () => {}, log: () => {}, heartbeat: shared });
      c.assignments.set(agentId, { agentId, mcpServers } as never);
      // 이 오퍼레이터의 로컬 설정에 없는 에이전트의 배정은 세지 않는다.
      c.assignments.set('ghost', { agentId: 'ghost', mcpServers: ['ghost-mcp'] } as never);
      c.start();
      await new Promise((r) => setTimeout(r, 0));
      return JSON.parse(sent.find((d) => JSON.parse(d).type === 'status')!);
    };
    const work = await beatOf('https://work.example.com', 'work-a', ['slack', 'jira']);
    const home = await beatOf('https://home.example.com', 'home-b', ['ctx']);
    expect(work.status.mcp.map((m: { name: string }) => m.name)).toEqual(['jira', 'slack']);
    expect(home.status.mcp.map((m: { name: string }) => m.name)).toEqual(['ctx']);
    expect(JSON.stringify(work)).not.toContain('ctx');
    expect(JSON.stringify(home)).not.toContain('slack');
    expect(asked.flat()).not.toContain('ghost-mcp');
  });

  it('MCP 상태를 못 만들면 고정 문구만 남긴다 — 깨진 ~/.claude.json 의 내용이 로그에 실리지 않는다(security #1451 n1)', async () => {
    const logs: string[] = [];
    const broken = '{"mcpServers":{"slack":{"headers":{"Authorization":"Bearer LEAKY-TOKEN"'; // 닫히지 않은 JSON
    const mcp = async () => { JSON.parse(broken); return []; };
    const c = createCommunity({
      baseUrl: 'https://work.example.com', token: 'hkop_x', agents: { a: {} }, reconciler,
      dial: (_u, _t, h) => { h.onOpen({ send: () => {}, close: () => {} }); }, schedule: () => {}, log: (l) => logs.push(l),
      heartbeat: { status: async () => ({ turns: { running: 0, max: null } }), machine: async () => null, mcp },
    });
    c.assignments.set('a', { agentId: 'a', mcpServers: ['slack'] } as never);
    c.start();
    await new Promise((r) => setTimeout(r, 0));
    const line = logs.find((l) => l.includes('박동의 MCP 상태'));
    expect(line).toBe('박동의 MCP 상태를 만들지 못했다(정의 파일을 읽지 못했거나 형식이 깨졌다)');
    expect(logs.join('\n')).not.toMatch(/LEAKY|Bearer|mcpServers/);
    // 파일 시스템 오류면 코드만 덧붙인다.
    const logs2: string[] = [];
    const c2 = createCommunity({
      baseUrl: 'https://work.example.com', token: 'hkop_x', agents: { a: {} }, reconciler,
      dial: (_u, _t, h) => { h.onOpen({ send: () => {}, close: () => {} }); }, schedule: () => {}, log: (l) => logs2.push(l),
      heartbeat: { status: async () => ({ turns: { running: 0, max: null } }), machine: async () => null,
        mcp: async () => { throw Object.assign(new Error('EACCES: permission denied, open /secret/path'), { code: 'EACCES' }); } },
    });
    c2.assignments.set('a', { agentId: 'a', mcpServers: ['slack'] } as never);
    c2.start();
    await new Promise((r) => setTimeout(r, 0));
    expect(logs2.find((l) => l.includes('박동의 MCP 상태'))).toBe('박동의 MCP 상태를 만들지 못했다(정의 파일을 읽지 못했거나 형식이 깨졌다) EACCES');
    expect(logs2.join('\n')).not.toContain('/secret/path');
    c.stop(); c2.stop();
  });

  it('켠 MCP 가 없으면 칸을 싣지 않는다 · MCP 상태를 못 만들어도 박동은 나간다', async () => {
    const sent: string[] = [];
    const dial: LinkDialer = (_u, _t, h) => { h.onOpen({ send: (d) => sent.push(d), close: () => {} }); };
    const mcp = vi.fn(async () => { throw new Error('boom'); });
    const c = createCommunity({
      baseUrl: 'https://work.example.com', token: 'hkop_x', agents: { a: {} }, reconciler, dial, schedule: () => {}, log: () => {},
      heartbeat: { status: async () => ({ turns: { running: 0, max: null } }), machine: async () => null, mcp },
    });
    c.start();
    await new Promise((r) => setTimeout(r, 0));
    expect(mcp).not.toHaveBeenCalled();
    expect(JSON.parse(sent.find((d) => JSON.parse(d).type === 'status')!).status).not.toHaveProperty('mcp');
    c.stop();
    const sent2: string[] = [];
    const c2 = createCommunity({
      baseUrl: 'https://work.example.com', token: 'hkop_x', agents: { a: {} }, reconciler,
      dial: (_u, _t, h) => { h.onOpen({ send: (d) => sent2.push(d), close: () => {} }); }, schedule: () => {}, log: () => {},
      heartbeat: { status: async () => ({ turns: { running: 0, max: null } }), machine: async () => null, mcp },
    });
    c2.assignments.set('a', { agentId: 'a', mcpServers: ['slack'] } as never);
    c2.start();
    await new Promise((r) => setTimeout(r, 0));
    expect(mcp).toHaveBeenCalledTimes(1);
    expect(JSON.parse(sent2.find((d) => JSON.parse(d).type === 'status')!).status).toEqual({ turns: { running: 0, max: null } });
    c2.stop();
  });
});
