import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { readHarnessTurnEnd, turnEndFromCodexRollout } from '../src/harnessTurnEnd.js';

const T0 = Date.parse('2026-11-05T00:00:00.000Z');
const at = (s: number) => new Date(T0 + s * 1000).toISOString();
const ev = (s: number, type: string) => JSON.stringify({ timestamp: at(s), type: 'event_msg', payload: { type } });
const item = (s: number, type: string) => JSON.stringify({ timestamp: at(s), type: 'response_item', payload: { type } });

describe('turnEndFromCodexRollout', () => {
  it('시작 뒤 끝 표지가 없으면 일하는 중이다 — 마지막이 도구 결과여도, 글이어도', () => {
    expect(turnEndFromCodexRollout([ev(1, 'task_started'), item(2, 'message'), item(3, 'function_call_output')].join('\n'), T0)).toBe('working');
  });
  it('task_complete·turn_aborted 면 끝났다', () => {
    expect(turnEndFromCodexRollout([ev(1, 'task_started'), ev(2, 'task_complete')].join('\n'), T0)).toBe('ended');
    expect(turnEndFromCodexRollout([ev(1, 'task_started'), ev(2, 'turn_aborted')].join('\n'), T0)).toBe('ended');
  });
  it('되살린 세션: 앞 차례의 끝은 이 차례의 끝이 아니고, 새 시작이 있으면 일하는 중이다', () => {
    const old = [ev(1, 'task_started'), ev(2, 'task_complete')];
    expect(turnEndFromCodexRollout(old.join('\n'), T0 + 10_000)).toBeNull();
    expect(turnEndFromCodexRollout([...old, ev(11, 'task_started')].join('\n'), T0 + 10_000)).toBe('working');
  });
  it('표지가 없거나 줄이 잘렸으면 모른다 — 잘린 끝줄은 건너뛴다', () => {
    expect(turnEndFromCodexRollout(item(1, 'message'), T0)).toBeNull();
    expect(turnEndFromCodexRollout('', T0)).toBeNull();
    expect(turnEndFromCodexRollout(`${ev(1, 'task_started')}\n{"timestamp":"x","ty`, T0)).toBe('working');
  });
});

describe('readHarnessTurnEnd', () => {
  const ID = '01a1ab89-65e3-7c31-811e-82a8cbe143fc';
  async function sessions(body: string, cwd: string) {
    const dir = await mkdtemp(join(tmpdir(), 'turn-end-'));
    const day = join(dir, '2026', '11', '05');
    await mkdir(day, { recursive: true });
    const meta = JSON.stringify({ timestamp: at(0), type: 'session_meta', payload: { id: ID, cwd } });
    await writeFile(join(day, `rollout-2026-11-05T00-00-00-${ID}.jsonl`), `${meta}\n${body}\n`);
    return dir;
  }

  it('세션 id 로도, 첫 턴처럼 id 가 없을 때 cwd 로도 찾는다', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'turn-end-cwd-'));
    const dir = await sessions(ev(1, 'task_started'), cwd);
    const base = { cwd, sinceMs: T0, codexSessionsDir: dir };
    expect(await readHarnessTurnEnd('codex', { ...base, sessionId: ID })).toBe('working');
    expect(await readHarnessTurnEnd('codex', { ...base, sessionId: null })).toBe('working');
  });
  it('끝쪽만 읽어도 큰 기록의 표지를 찾는다', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'turn-end-cwd-'));
    const dir = await sessions([JSON.stringify({ timestamp: at(0), type: 'response_item', payload: { pad: 'x'.repeat(1_500_000) } }), ev(1, 'task_started'), ev(2, 'task_complete')].join('\n'), cwd);
    expect(await readHarnessTurnEnd('codex', { sessionId: ID, cwd, sinceMs: T0, codexSessionsDir: dir })).toBe('ended');
  });
  it('기록 표면이 없는 하네스·없는 세션은 모른다', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'turn-end-cwd-'));
    const dir = await sessions(ev(1, 'task_started'), cwd);
    for (const h of ['pi', 'omp', 'kilo', 'opencode', 'claude-code'] as const) {
      expect(await readHarnessTurnEnd(h, { sessionId: ID, cwd, sinceMs: T0, codexSessionsDir: dir }), h).toBeNull();
    }
    expect(await readHarnessTurnEnd('codex', { sessionId: 'ffffffff-ffff-4fff-8fff-ffffffffffff', cwd, sinceMs: T0, codexSessionsDir: dir })).toBeNull();
  });
});
