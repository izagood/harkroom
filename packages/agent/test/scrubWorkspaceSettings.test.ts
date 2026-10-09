import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { scrubWorkspaceSettings } from '../src/mentionTurn.js';

// 권한 요청(스레드 f61af808, security R2): 지난 턴이 Bash 로 써 둔 작업 폴더 설정은 다음 턴 전에 지운다. 스킬은 남긴다.
describe('scrubWorkspaceSettings', () => {
  let dir = '';
  afterEach(async () => { if (dir) await rm(dir, { recursive: true, force: true }); });

  it('settings.json·settings.local.json 만 지우고 skills 는 그대로 둔다', async () => {
    dir = await mkdtemp(join(tmpdir(), 'scrub-'));
    await mkdir(join(dir, '.claude', 'skills', 'x'), { recursive: true });
    await writeFile(join(dir, '.claude', 'skills', 'x', 'SKILL.md'), 'x');
    await writeFile(join(dir, '.claude', 'settings.json'), '{"permissions":{"allow":["Bash"]}}');
    await writeFile(join(dir, '.claude', 'settings.local.json'), '{}');
    const removed = await scrubWorkspaceSettings(dir);
    expect(removed).toHaveLength(2);
    expect(existsSync(join(dir, '.claude', 'settings.json'))).toBe(false);
    expect(existsSync(join(dir, '.claude', 'settings.local.json'))).toBe(false);
    expect(existsSync(join(dir, '.claude', 'skills', 'x', 'SKILL.md'))).toBe(true);
  });

  it('.claude 가 링크면 링크만 지우고 너머의 settings 는 남긴다(n1)', async () => {
    dir = await mkdtemp(join(tmpdir(), 'scrub-'));
    const target = join(dir, 'human-claude');
    await mkdir(target);
    await writeFile(join(target, 'settings.json'), '{}');
    const ws = join(dir, 'ws');
    await mkdir(ws);
    await symlink(target, join(ws, '.claude'));
    expect(await scrubWorkspaceSettings(ws)).toEqual([join(ws, '.claude')]);
    expect(existsSync(join(target, 'settings.json'))).toBe(true);
    expect(existsSync(join(ws, '.claude'))).toBe(false);
  });

  it('settings.json 이 디렉터리여도 던지지 않는다(n2)', async () => {
    dir = await mkdtemp(join(tmpdir(), 'scrub-'));
    await mkdir(join(dir, '.claude', 'settings.json'), { recursive: true });
    expect(await scrubWorkspaceSettings(dir)).toHaveLength(1);
    expect(existsSync(join(dir, '.claude', 'settings.json'))).toBe(false);
  });

  it('없으면 아무것도 안 한다', async () => {
    dir = await mkdtemp(join(tmpdir(), 'scrub-'));
    expect(await scrubWorkspaceSettings(dir)).toEqual([]);
  });
});
