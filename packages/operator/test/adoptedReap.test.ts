// 배정에 없는 채택 러너 회수(s21c-2c-1b-2) — security c2b-3 ①b 조건 1~5.
import { describe, it, expect } from 'vitest';
import { keepUnion, reapUnassignedAdopted, type ReapDeps, type AdoptedRunnerRow } from '../src/adoptedReap.js';

function deps(over: Partial<ReapDeps> & { rows?: AdoptedRunnerRow[]; boot?: Record<number, number | null> } = {}) {
  const killed: string[] = [];
  const rows = over.rows ?? [
    { agentId: 'keep', incarnationId: 'i-k', pid: 11, bootTimeSec: 100 },
    { agentId: 'gone', incarnationId: 'i-g', pid: 22, bootTimeSec: 200 },
  ];
  const boot = over.boot ?? { 11: 100, 22: 200 };
  const d: ReapDeps = {
    allStarted: () => true,
    keeps: () => [new Set(['keep'])],
    adopted: () => rows,
    currentIncarnation: (agentId) => rows.find((r) => r.agentId === agentId)?.incarnationId ?? null,
    probe: { bootTimeSec: async (pid) => boot[pid] ?? null },
    kill: (agentId) => { killed.push(agentId); return true; },
    log: () => {},
    ...over,
  };
  return { d, killed };
}

describe('채택 러너 회수', () => {
  it('모든 커뮤니티가 받았고 시작 시각이 같으면 배정에 없는 채택 러너만 SIGTERM', async () => {
    const { d, killed } = deps();
    expect(await reapUnassignedAdopted(d)).toEqual(['gone']);
    expect(killed).toEqual(['gone']);
  });
  it('한 커뮤니티라도 못 받았으면(옛 서버·끊김) 아무것도 안 죽인다', async () => {
    const { d, killed } = deps({ keeps: () => [new Set(['keep']), null] });
    expect(await reapUnassignedAdopted(d)).toEqual([]);
    expect(killed).toEqual([]);
  });
  it('맡은 커뮤니티가 다 안 떠 있으면(토큰 없음 등) 안 죽인다', async () => {
    const { d, killed } = deps({ allStarted: () => false });
    await reapUnassignedAdopted(d);
    expect(killed).toEqual([]);
  });
  it('커뮤니티가 하나도 없으면 안 죽인다', () => {
    expect(keepUnion({ allStarted: () => true, keeps: () => [] })).toBeNull();
  });
  it('남길 것은 합집합 — 다른 커뮤니티가 남기면 안 죽인다', async () => {
    const { d, killed } = deps({ keeps: () => [new Set(['keep']), new Set(['gone'])] });
    await reapUnassignedAdopted(d);
    expect(killed).toEqual([]);
  });
  it('시작 시각이 장부와 다르거나 못 읽거나 장부에 없으면 안 보낸다(pid 재사용)', async () => {
    for (const boot of [{ 11: 100, 22: 201 }, { 11: 100, 22: null }]) {
      const { d, killed } = deps({ boot });
      await reapUnassignedAdopted(d);
      expect(killed).toEqual([]);
    }
    const { d, killed } = deps({ rows: [{ agentId: 'gone', incarnationId: 'i-g', pid: 22, bootTimeSec: null }] });
    await reapUnassignedAdopted(d);
    expect(killed).toEqual([]);
  });
  it('ps 를 기다리는 사이 다시 붙었거나 배정이 오면 안 죽인다', async () => {
    let keeps: (Set<string> | null)[] = [new Set(['keep'])];
    const { d, killed } = deps({
      keeps: () => keeps,
      probe: { bootTimeSec: async (pid) => { keeps = [null]; return pid === 22 ? 200 : 100; } },
    });
    await reapUnassignedAdopted(d);
    expect(killed).toEqual([]);
    keeps = [new Set(['keep'])];
    const second = deps({
      keeps: () => keeps,
      probe: { bootTimeSec: async (pid) => { keeps = [new Set(['keep', 'gone'])]; return pid === 22 ? 200 : 100; } },
    });
    await reapUnassignedAdopted(second.d);
    expect(second.killed).toEqual([]);
  });
  it('그 사이 같은 자리에 다른 세대가 섰으면 건드리지 않는다', async () => {
    const { d, killed } = deps({ currentIncarnation: () => 'i-new' });
    await reapUnassignedAdopted(d);
    expect(killed).toEqual([]);
  });
});
