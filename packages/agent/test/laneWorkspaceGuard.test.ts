import { describe, expect, it } from 'vitest';
import { mkdir, mkdtemp, realpath, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { laneParentViolations, laneWorkspaceViolations } from '../src/laneWorkspaceGuard.js';

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

  it('지시로 읽히는 다른 이름(CLAUDE.local.md·CONTEXT.md)도 잡는다', async () => {
    const { ws, skills } = await dirs();
    await writeFile(join(ws, 'CLAUDE.local.md'), 'x');
    await writeFile(join(ws, 'CONTEXT.md'), 'x');
    expect(await laneWorkspaceViolations(ws, skills)).toEqual(['CLAUDE.local.md', 'CONTEXT.md']);
  });

  // security F2: 링크 대상은 `syncSkills` 가 만드는 꼴과 정확히 같을 때만 우리 것이다.
  it('앞머리만 같은 형제 폴더·`..` 가 섞인 대상은 잡는다', async () => {
    const a = await dirs();
    await mkdir(`${a.skills}-x/plain`, { recursive: true });
    await mkdir(join(a.ws, '.claude', 'skills'), { recursive: true });
    await symlink(`${a.skills}-x/plain`, join(a.ws, '.claude', 'skills', 'plain'));
    expect(await laneWorkspaceViolations(a.ws, a.skills)).toEqual(['.claude']);

    const b = await dirs();
    await mkdir(join(b.ws, '.agents', 'skills'), { recursive: true });
    await symlink(`${b.skills}/../../ws`, join(b.ws, '.agents', 'skills', 'plain'));
    expect(await laneWorkspaceViolations(b.ws, b.skills)).toEqual(['.agents']);
  });

  it('작업 폴더를 못 읽으면 걸린 것으로 본다', async () => {
    const { ws, skills } = await dirs();
    expect(await laneWorkspaceViolations(join(ws, 'missing'), skills)).toEqual(['(unreadable)']);
  });

  it('CLAUDE.md·AGENTS.md 는 글자 그대로도 잡는다', async () => {
    const { ws, skills } = await dirs();
    await writeFile(join(ws, 'CLAUDE.md'), 'x');
    expect(await laneWorkspaceViolations(ws, skills)).toEqual(['CLAUDE.md']);
  });

  // security F1: codex 프로젝트 설정 폴더도 보호 이름이다.
  it('.codex 는 무엇이 들었든 잡는다 — 러너는 거기 아무것도 깔지 않는다', async () => {
    for (const make of [
      async (ws: string) => { await mkdir(join(ws, '.codex'), { recursive: true }); await writeFile(join(ws, '.codex', 'config.toml'), '[mcp_servers.x]\n'); },
      async (ws: string) => { await mkdir(join(ws, '.Codex'), { recursive: true }); },
      async (ws: string) => { await mkdir(join(ws, '.codex', 'skills'), { recursive: true }); },
    ]) {
      const { ws, skills } = await dirs();
      await make(ws);
      expect((await laneWorkspaceViolations(ws, skills)).map((n) => n.toLowerCase())).toEqual(['.codex']);
    }
  });

  it('kilo 프로젝트 설정·지시 이름도 잡는다', async () => {
    for (const [name, dir] of [['kilo.json', false], ['kilo.jsonc', false], ['Kilo.JSON', false], ['.kilo', true], ['.kilocode', true], ['.kilocoderules', false], ['.KiloCodeRules', false]] as const) {
      const { ws, skills } = await dirs();
      if (dir) await mkdir(join(ws, name), { recursive: true }); else await writeFile(join(ws, name), '{}');
      expect(await laneWorkspaceViolations(ws, skills)).toEqual([name]);
    }
  });

  it('kilo 지시 폴더(`.kilo/rules`·`.kilocode/rules`)가 있으면 잡는다', async () => {
    for (const d of ['.kilo', '.kilocode']) {
      const { ws, skills } = await dirs();
      await mkdir(join(ws, d, 'rules'), { recursive: true });
      await writeFile(join(ws, d, 'rules', 'x.md'), 'x');
      expect(await laneWorkspaceViolations(ws, skills)).toEqual([d]);
    }
  });
});

// security G3(2026-10-25): 하네스 판과 무관하게 부모 사슬도 본다 — 사람 홈 자리에서는 프로젝트 설정 파일 이름만.
describe('laneParentViolations', () => {
  async function tree() {
    const home = await realpath(await mkdtemp(join(tmpdir(), 'lane-parent-')));
    const ws = join(home, '.harkroom-agent', 'agent-1', 'workspaces', 'w');
    await mkdir(ws, { recursive: true });
    return { home, ws };
  }

  it('평소(부모가 비었음)에는 아무것도 없다 — 사람 홈의 전역 자리(.claude·.agents·.codex)는 걸지 않는다', async () => {
    const { home, ws } = await tree();
    for (const d of ['.claude', '.agents', '.codex', '.opencode']) await mkdir(join(home, d));
    expect(await laneParentViolations(ws, home)).toEqual([]);
  });

  it('작업 폴더 위 폴더의 보호 이름과 사람 홈의 프로젝트 설정 파일을 잡는다(대소문자 무시)', async () => {
    const { home, ws } = await tree();
    await mkdir(join(home, '.harkroom-agent', 'agent-1', '.opencode'));
    await writeFile(join(home, '.harkroom-agent', 'Kilo.JSON'), '{}');
    await writeFile(join(home, 'opencode.json'), '{}');
    expect(await laneParentViolations(ws, home)).toEqual([
      join('.harkroom-agent', 'Kilo.JSON'), join('.harkroom-agent', 'agent-1', '.opencode'), join('~', 'opencode.json'),
    ].sort());
  });

  it('홈 밖 작업 폴더는 보지 않고, 심볼릭 링크 폴더를 만나면 멈춘다', async () => {
    const { home, ws } = await tree();
    expect(await laneParentViolations('/somewhere/else/ws', home)).toEqual([]);
    const real = join(home, 'real');
    await mkdir(join(real, 'inner'), { recursive: true });
    await mkdir(join(home, '.opencode-planted'), { recursive: true });
    await writeFile(join(home, 'kilo.jsonc'), '{}');
    await symlink(real, join(home, 'link'));
    // 링크 폴더(home/link)에서 멈추므로 위의 홈 파일까지 가지 않는다.
    expect(await laneParentViolations(join(home, 'link', 'inner', 'ws'), home)).toEqual([]);
    expect(await laneParentViolations(ws, home)).toEqual([join('~', 'kilo.jsonc')]);
  });
});
