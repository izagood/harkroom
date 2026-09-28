import { describe, it, expect, beforeEach } from 'vitest';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { planMemory } from '../src/memoryPin.js';
import { buildSystemPrompt, type MemoryContext } from '../src/prompt.js';

let stateDir: string;
const KEY = 'ch/thread';
const SID = 'session-1';

beforeEach(async () => {
  stateDir = await mkdtemp(join(tmpdir(), 'mempin-'));
});

const sys = (memory: MemoryContext) => buildSystemPrompt({
  handle: 'forge', channelName: 'general', instructions: '', guide: '', memory,
});

/** 한 턴: 계획 → (성공했다고 치고) 저장. */
async function turn(memory: MemoryContext, isFirstTurn: boolean, sessionId: string | null = SID) {
  const plan = await planMemory({ stateDir, key: KEY, sessionId, isFirstTurn, memory });
  await plan.commit(sessionId);
  return { system: sys(plan.system), turn: plan.turnLines.join('\n') };
}

describe('memoryPin — 시스템 프롬프트를 세션 동안 고정한다', () => {
  it('첫 턴: core 는 시스템 프롬프트, 목록 전체는 턴 프롬프트', async () => {
    const t = await turn({ core: 'C1', slugs: ['mem/a', 'mem/b'] }, true);
    expect(t.system).toContain('C1');
    expect(t.system).not.toContain('mem/a');
    expect(t.turn).toContain('<memory-index>');
    expect(t.turn).toContain('- mem/a');
    expect(t.turn).toContain('- mem/b');
  });

  // 이 PR 의 핵심 회귀선: 세션 도중 기억이 바뀌어도 시스템 프롬프트는 바이트 단위로 같다.
  it('core·목록이 바뀌어도 이어받은 세션의 시스템 프롬프트는 그대로다', async () => {
    const first = await turn({ core: 'C1', slugs: ['mem/a'] }, true);
    const second = await turn({ core: 'C2', slugs: ['mem/a', 'mem/b'] }, false);
    expect(second.system).toBe(first.system);
  });

  it('바뀐 core 는 전문을 한 번, 새/지운 slug 는 차이만 턴 프롬프트에 싣는다', async () => {
    await turn({ core: 'C1', slugs: ['mem/a', 'mem/old'] }, true);
    const t = await turn({ core: 'C2', slugs: ['mem/a', 'mem/new'] }, false);
    expect(t.turn).toContain('<memory-update>');
    expect(t.turn).toContain('C2');
    expect(t.turn).toContain('새로 생긴 기억:\n- mem/new');
    expect(t.turn).toContain('지워진 기억:\n- mem/old');
    expect(t.turn).not.toContain('- mem/a'); // 그대로인 것은 다시 안 싣는다
  });

  it('알린 뒤에는 다시 싣지 않는다 — 대화 기록에 쌓이지 않게', async () => {
    await turn({ core: 'C1', slugs: ['mem/a'] }, true);
    await turn({ core: 'C2', slugs: ['mem/a', 'mem/b'] }, false);
    const third = await turn({ core: 'C2', slugs: ['mem/a', 'mem/b'] }, false);
    expect(third.turn).toBe('');
  });

  // 실패한 턴의 알림은 하네스에 닿았는지 모른다 — 저장하지 않았으니 다음 시도가 다시 알린다.
  it('commit 하지 않은(실패한) 턴의 알림은 다음 턴에 다시 나온다', async () => {
    await turn({ core: 'C1', slugs: [] }, true);
    await planMemory({ stateDir, key: KEY, sessionId: SID, isFirstTurn: false, memory: { core: 'C2', slugs: [] } });
    const retry = await turn({ core: 'C2', slugs: [] }, false);
    expect(retry.turn).toContain('C2');
  });

  it('새 세션(isFirstTurn)은 지금 값으로 다시 고정한다', async () => {
    await turn({ core: 'C1', slugs: ['mem/a'] }, true);
    const fresh = await turn({ core: 'C2', slugs: ['mem/a'] }, true, 'session-2');
    expect(fresh.system).toContain('C2');
    expect(fresh.turn).toContain('<memory-index>');
  });

  it('세션 id 가 다르면 고정을 버린다', async () => {
    await turn({ core: 'C1', slugs: [] }, true);
    const other = await turn({ core: 'C2', slugs: [] }, false, 'session-2');
    expect(other.system).toContain('C2');
  });

  // codex 는 첫 턴 뒤에야 id 를 안다 — 첫 고정이 null 로 저장돼도 이어서 쓴다.
  it('id 없이 만든 고정은 commit 때 받은 id 로 이어진다', async () => {
    const plan = await planMemory({ stateDir, key: KEY, sessionId: null, isFirstTurn: true, memory: { core: 'C1', slugs: [] } });
    await plan.commit('codex-1');
    const next = await turn({ core: 'C2', slugs: [] }, false, 'codex-1');
    expect(next.system).toContain('C1');
    expect(next.turn).toContain('C2');
  });

  it('사본 경고는 턴 프롬프트로 간다', async () => {
    const t = await turn({ core: 'C1', slugs: [], stale: { fetchedAt: '2026-09-28T00:00:00.000Z' } }, true);
    expect(t.turn).toContain('받아 둔 사본');
    expect(t.system).not.toContain('받아 둔 사본');
  });

  it('못 읽었고 사본도 없으면 아무것도 싣지 않는다(#139)', async () => {
    const plan = await planMemory({ stateDir, key: KEY, sessionId: SID, isFirstTurn: true, memory: 'unavailable' });
    expect(plan.system).toBe('unavailable');
    expect(plan.turnLines).toEqual([]);
  });

  // core 가 없다가 생기면 시스템 프롬프트의 온보딩("기억이 아직 없다")과 부딪친다 — 다시 고정한다.
  it('core 가 없음→있음으로 바뀌면 다시 고정한다', async () => {
    await turn({ core: null, slugs: [] }, true);
    const t = await turn({ core: 'C1', slugs: [] }, false);
    expect(t.system).toContain('C1');
    expect(t.system).not.toContain('기억이 아직 없다');
  });

  it('slug 와 core 를 이스케이프한다', async () => {
    await turn({ core: 'x', slugs: [] }, true);
    const t = await turn({ core: 'a < b', slugs: ['mem/<script>'] }, false);
    expect(t.turn).toContain('a &lt; b');
    expect(t.turn).toContain('mem/&lt;script>');
  });
});
