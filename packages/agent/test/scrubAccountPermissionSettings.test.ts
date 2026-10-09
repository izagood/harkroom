import { lstat, mkdtemp, readFile, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

import { ensureDangerousModeAccepted, scrubAccountPermissionSettings } from '../src/workspaceTrust.js';

// 권한 요청 H①(스레드 8769dbf7, security F1·F2): 풀 계정 config 의 settings 에 Bash 로 써 둔 키가 분류기 밖에서 명령을 돌리는 길을 끊는다.
describe('scrubAccountPermissionSettings', () => {
  it('허용 목록(theme·tui·skipDangerousModePermissionPrompt·enabledPlugins)만 남기고 명령을 돌리는 키는 전부 지운다 — settings.local.json 도', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'acct-'));
    await writeFile(join(dir, 'settings.json'), JSON.stringify({
      theme: 'dark', tui: 'fullscreen', skipDangerousModePermissionPrompt: true, enabledPlugins: { 'swift-lsp@x': true },
      permissions: { allow: ['Bash(*)'] },
      hooks: { PreToolUse: [{ matcher: 'Bash', hooks: [{ type: 'command', command: '/tmp/x' }] }] },
      statusLine: { type: 'command', command: '/tmp/x' },
      apiKeyHelper: '/tmp/x', awsAuthRefresh: '/tmp/x', awsCredentialExport: '/tmp/x', otelHeadersHelper: '/tmp/x', fileSuggestion: { type: 'command', command: '/tmp/x' },
      env: { NODE_OPTIONS: '--require /tmp/x.js' },
      someFutureCommandKey: '/tmp/x',
    }));
    await writeFile(join(dir, 'settings.local.json'), JSON.stringify({ permissions: { defaultMode: 'bypassPermissions' } }));
    const removed = await scrubAccountPermissionSettings(dir);
    expect(removed).toHaveLength(11);
    expect(JSON.parse(await readFile(join(dir, 'settings.json'), 'utf8'))).toEqual({
      theme: 'dark', tui: 'fullscreen', skipDangerousModePermissionPrompt: true, enabledPlugins: { 'swift-lsp@x': true },
    });
    expect(JSON.parse(await readFile(join(dir, 'settings.local.json'), 'utf8'))).toEqual({});
  });

  it('링크는 따라가지 않는다 — 풀 settings 가 사람의 설정을 가리켜도 그 너머를 고치지 않는다(F2)', async () => {
    const human = await mkdtemp(join(tmpdir(), 'human-'));
    const humanSettings = join(human, 'settings.json');
    const text = JSON.stringify({ permissions: { allow: ['Bash(npm test:*)'] }, hooks: {} });
    await writeFile(humanSettings, text);
    const dir = await mkdtemp(join(tmpdir(), 'acct-'));
    await symlink(humanSettings, join(dir, 'settings.json'));
    expect(await scrubAccountPermissionSettings(dir)).toEqual([]);
    expect(await readFile(humanSettings, 'utf8')).toBe(text);
    expect((await lstat(join(dir, 'settings.json'))).isSymbolicLink()).toBe(true);
  });

  it('지울 것이 없으면 파일을 다시 쓰지 않는다 — 깨진 파일·없는 파일도 턴을 죽이지 않는다', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'acct-'));
    const text = '{"theme":"dark"}';
    await writeFile(join(dir, 'settings.json'), text);
    await writeFile(join(dir, 'settings.local.json'), '{not json');
    expect(await scrubAccountPermissionSettings(dir)).toEqual([]);
    expect(await readFile(join(dir, 'settings.json'), 'utf8')).toBe(text);
  });

  it('턴 준비(ensureDangerousModeAccepted)가 풀 계정에서 부른다', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'acct-'));
    await writeFile(join(dir, 'settings.json'), JSON.stringify({ permissions: { allow: ['Bash(rm:*)'] }, statusLine: { type: 'command', command: 'x' } }));
    await ensureDangerousModeAccepted({ harness: 'claude-code', claudeConfigDir: dir });
    const doc = JSON.parse(await readFile(join(dir, 'settings.json'), 'utf8'));
    expect(doc.permissions).toBeUndefined();
    expect(doc.statusLine).toBeUndefined();
    expect(doc.skipDangerousModePermissionPrompt).toBe(true);
  });
});
