// 오퍼레이터 박동(원격 호스트 관리 P3a) — 무엇을 싣고 무엇을 싣지 않나, 언제 보내나.
import { describe, it, expect, vi } from 'vitest';
import { parseOperatorStatus } from '@harkroom/shared/operatorProtocol';
import { collectStatus, readMachineDigest } from '../src/heartbeat.js';
import { createCommunity } from '../src/community.js';
import type { AssignmentReconciler } from '../src/assignments.js';
import type { LinkDialer } from '../src/serverLink.js';

const reconciler: AssignmentReconciler = {
  onAssign: async () => 'spawned', onUnassign: async () => {}, restart: () => true, onRunnerExit: () => {}, announce: () => [],
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
