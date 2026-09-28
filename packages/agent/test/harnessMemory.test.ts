import { describe, it, expect, beforeEach } from 'vitest';
import { mkdir, mkdtemp, utimes, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { claudeMemoryDir, claudeProjectDirName, planHarnessMemoryNotice, scanHarnessMemory } from '../src/harnessMemory.js';

let stateDir: string;
let memDir: string;
const KEY = 'ch/thread';

beforeEach(async () => {
  stateDir = await mkdtemp(join(tmpdir(), 'hm-state-'));
  memDir = join(await mkdtemp(join(tmpdir(), 'hm-mem-')), 'memory');
  await mkdir(memDir, { recursive: true });
});

const note = (name: string, description: string) =>
  writeFile(join(memDir, name), `---\nname: ${name}\ndescription: ${description}\n---\n본문\n`);

async function turn() {
  const plan = await planHarnessMemoryNotice({ stateDir, key: KEY, files: await scanHarnessMemory(memDir) });
  await plan.commit();
  return plan.lines.join('\n');
}

describe('harnessMemory — 스레드에 갇힌 파일 메모리를 알린다', () => {
  // 2026-09-28 실측: `/Users/jaebin/.harkroom-agent/...` → `-Users-jaebin--harkroom-agent-...`
  it('cwd 를 Claude Code 프로젝트 디렉터리 이름으로 바꾼다', () => {
    expect(claudeProjectDirName('/Users/jaebin/.harkroom-agent/m-1/workspaces/h-2'))
      .toBe('-Users-jaebin--harkroom-agent-m-1-workspaces-h-2');
    expect(claudeMemoryDir('/cfg', '/a/b')).toBe(join('/cfg', 'projects', '-a-b', 'memory'));
  });

  it('새 파일을 설명과 함께 싣고, MEMORY.md 는 뺀다', async () => {
    await note('niccli-trap.md', 'NVM 범위 함정');
    await writeFile(join(memDir, 'MEMORY.md'), '- [x](niccli-trap.md)');
    const text = await turn();
    expect(text).toContain('<harness-memory>');
    expect(text).toContain('- niccli-trap.md — NVM 범위 함정');
    expect(text).not.toContain('MEMORY.md');
    expect(text).toContain('memory.set');
  });

  it('한 번 알린 것은 다시 안 싣고, 바뀌면 다시 싣는다', async () => {
    await note('a.md', '하나');
    await turn();
    expect(await turn()).toBe('');
    await note('a.md', '하나 고침');
    await utimes(join(memDir, 'a.md'), new Date(), new Date(Date.now() + 5000));
    expect(await turn()).toContain('하나 고침');
  });

  it('commit 하지 않은(실패한) 턴의 알림은 다시 나온다', async () => {
    await note('a.md', '하나');
    await planHarnessMemoryNotice({ stateDir, key: KEY, files: await scanHarnessMemory(memDir) });
    expect(await turn()).toContain('a.md');
  });

  it('디렉터리가 없으면 조용히 아무것도 안 한다', async () => {
    expect(await scanHarnessMemory(join(memDir, 'nope'))).toEqual([]);
  });

  it('많으면 목록을 줄인다', async () => {
    for (let i = 0; i < 13; i++) await note(`n${String(i).padStart(2, '0')}.md`, `메모 ${i}`);
    expect(await turn()).toContain('그 밖에 3개');
  });
});
