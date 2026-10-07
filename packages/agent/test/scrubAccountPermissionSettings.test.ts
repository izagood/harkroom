import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

import { ensureDangerousModeAccepted, scrubAccountPermissionSettings } from '../src/workspaceTrust.js';

// 권한 요청 H①(스레드 8769dbf7): 풀 계정 config 의 settings 에 Bash 로 써 둔 allow·hook 이 다음 턴부터 사는 길을 끊는다.
describe('scrubAccountPermissionSettings', () => {
  it('permissions·hooks 만 지우고 테마·관문 기록은 남긴다 — settings.local.json 도', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'acct-'));
    await writeFile(join(dir, 'settings.json'), JSON.stringify({
      theme: 'dark', skipDangerousModePermissionPrompt: true,
      permissions: { allow: ['Bash(*)'] },
      hooks: { PreToolUse: [{ matcher: 'Bash', hooks: [{ type: 'command', command: '/tmp/x' }] }] },
    }));
    await writeFile(join(dir, 'settings.local.json'), JSON.stringify({ permissions: { defaultMode: 'bypassPermissions' } }));
    const removed = await scrubAccountPermissionSettings(dir);
    expect(removed).toHaveLength(3);
    expect(JSON.parse(await readFile(join(dir, 'settings.json'), 'utf8'))).toEqual({ theme: 'dark', skipDangerousModePermissionPrompt: true });
    expect(JSON.parse(await readFile(join(dir, 'settings.local.json'), 'utf8'))).toEqual({});
  });

  it('지울 것이 없으면 파일을 다시 쓰지 않는다 — 깨진 파일·없는 파일도 턴을 죽이지 않는다', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'acct-'));
    const text = '{"theme":"dark"}';
    await writeFile(join(dir, 'settings.json'), text);
    await writeFile(join(dir, 'settings.local.json'), '{not json');
    expect(await scrubAccountPermissionSettings(dir)).toEqual([]);
    expect(await readFile(join(dir, 'settings.json'), 'utf8')).toBe(text);
  });

  it('턴 준비(ensureDangerousModeAccepted)가 풀 계정에서 부른다 — 시스템 기본(null)은 건드리지 않는다', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'acct-'));
    await writeFile(join(dir, 'settings.json'), JSON.stringify({ permissions: { allow: ['Bash(rm:*)'] } }));
    await ensureDangerousModeAccepted({ harness: 'claude-code', claudeConfigDir: dir });
    const doc = JSON.parse(await readFile(join(dir, 'settings.json'), 'utf8'));
    expect(doc.permissions).toBeUndefined();
    expect(doc.skipDangerousModePermissionPrompt).toBe(true);
  });
});
