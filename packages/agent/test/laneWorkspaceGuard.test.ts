import { describe, expect, it } from 'vitest';
import { mkdir, mkdtemp, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { laneWorkspaceViolations } from '../src/laneWorkspaceGuard.js';

// API 키 연결 턴의 작업 폴더 검사(security, 2026-10-23) — 다음 턴을 바꾸는 이름이 대소문자를 가리지 않고 우리 것이 아닌 꼴로
// 있으면 그 턴을 띄우지 않는다.
async function dirs(): Promise<{ ws: string; skills: string }> {
  const root = await mkdtemp(join(tmpdir(), 'lane-guard-'));
  const ws = join(root, 'ws');
  const skills = join(root, 'state', 'skills');
  await mkdir(ws, { recursive: true });
  await mkdir(join(skills, 'plain'), { recursive: true });
  return { ws, skills };
}

describe('laneWorkspaceViolations', () => {
  it('보통 파일만 있으면 비어 있다', async () => {
    const { ws, skills } = await dirs();
    await writeFile(join(ws, 'README.md'), 'x');
    await mkdir(join(ws, 'src'));
    expect(await laneWorkspaceViolations(ws, skills)).toEqual([]);
  });

  it('러너가 깐 스킬 링크만 든 .claude·.agents 는 우리 것이다', async () => {
    const { ws, skills } = await dirs();
    for (const d of ['.claude', '.agents']) {
      await mkdir(join(ws, d, 'skills'), { recursive: true });
      await symlink(join(skills, 'plain'), join(ws, d, 'skills', 'plain'));
    }
    expect(await laneWorkspaceViolations(ws, skills)).toEqual([]);
  });

  it('대소문자만 바꾼 이름도 잡는다', async () => {
    const { ws, skills } = await dirs();
    await writeFile(join(ws, 'agents.md'), 'x');
    await mkdir(join(ws, '.Opencode', 'plugin'), { recursive: true });
    await writeFile(join(ws, '.MCP.json'), '{}');
    await writeFile(join(ws, 'Opencode.json'), '{}');
    expect(await laneWorkspaceViolations(ws, skills)).toEqual(['.MCP.json', '.Opencode', 'Opencode.json', 'agents.md']);
  });

  it('우리 링크가 아닌 정의·다른 하위 폴더·우리 밖을 가리키는 링크는 잡는다', async () => {
    const a = await dirs();
    await mkdir(join(a.ws, '.claude', 'skills', 'x'), { recursive: true });
    expect(await laneWorkspaceViolations(a.ws, a.skills)).toEqual(['.claude']);

    const b = await dirs();
    await mkdir(join(b.ws, '.claude', 'agents'), { recursive: true });
    expect(await laneWorkspaceViolations(b.ws, b.skills)).toEqual(['.claude']);

    const c = await dirs();
    const elsewhere = await mkdtemp(join(tmpdir(), 'lane-guard-other-'));
    await mkdir(join(c.ws, '.agents', 'skills'), { recursive: true });
    await symlink(elsewhere, join(c.ws, '.agents', 'skills', 'other'));
    expect(await laneWorkspaceViolations(c.ws, c.skills)).toEqual(['.agents']);
  });

  it('CLAUDE.md·AGENTS.md 는 글자 그대로도 잡는다', async () => {
    const { ws, skills } = await dirs();
    await writeFile(join(ws, 'CLAUDE.md'), 'x');
    expect(await laneWorkspaceViolations(ws, skills)).toEqual(['CLAUDE.md']);
  });
});
