// 워크스페이스 신뢰 기록의 회귀선(2026-09-08 프로덕션 사고).
//
// 이것이 없으면 TUI 턴은 신뢰 대화상자를 만나고, 러너는 답할 수 없어 무발화 한도까지
// 매달린다. `-p` 는 이 대화상자를 묻지 않았으므로 실행 모델 교체가 새로 만든 요구다.
import { mkdtemp, readFile, stat, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { ensureDangerousModeAccepted, ensureWorkspaceTrusted } from '../src/workspaceTrust.js';

const WS = '/Users/someone/.murmur-agent/agent-x/workspaces/murmur-forge-abc';

describe('ensureWorkspaceTrusted — claude', () => {
  it('.claude.json 의 projects 에 신뢰를 적는다', async () => {
    const configDir = await mkdtemp(join(tmpdir(), 'trust-claude-'));
    await ensureWorkspaceTrusted({ harness: 'claude-code', workspaceDir: WS, claudeConfigDir: configDir, codexHome: '/unused' });

    const doc = JSON.parse(await readFile(join(configDir, '.claude.json'), 'utf8'));
    expect(doc.projects[WS].hasTrustDialogAccepted).toBe(true);
  });

  it('기존 문서의 다른 내용을 지우지 않는다 — 하네스가 담아 둔 상태가 함께 산다', async () => {
    const configDir = await mkdtemp(join(tmpdir(), 'trust-claude-'));
    await writeFile(join(configDir, '.claude.json'), JSON.stringify({
      numStartups: 7,
      projects: { '/other/dir': { hasTrustDialogAccepted: true, lastCost: 1.5 } },
    }));

    await ensureWorkspaceTrusted({ harness: 'claude-code', workspaceDir: WS, claudeConfigDir: configDir, codexHome: '/unused' });

    const doc = JSON.parse(await readFile(join(configDir, '.claude.json'), 'utf8'));
    expect(doc.numStartups).toBe(7);
    expect(doc.projects['/other/dir'].lastCost).toBe(1.5);
    expect(doc.projects[WS].hasTrustDialogAccepted).toBe(true);
  });

  it('그 워크스페이스의 다른 필드를 보존한다', async () => {
    const configDir = await mkdtemp(join(tmpdir(), 'trust-claude-'));
    await writeFile(join(configDir, '.claude.json'), JSON.stringify({
      projects: { [WS]: { lastCost: 2.5, hasTrustDialogAccepted: false } },
    }));

    await ensureWorkspaceTrusted({ harness: 'claude-code', workspaceDir: WS, claudeConfigDir: configDir, codexHome: '/unused' });

    const doc = JSON.parse(await readFile(join(configDir, '.claude.json'), 'utf8'));
    expect(doc.projects[WS].lastCost).toBe(2.5);
    expect(doc.projects[WS].hasTrustDialogAccepted).toBe(true);
  });

  it('깨진 파일은 최소 문서로 갈음한다 — 신뢰를 못 적으면 턴이 통째로 죽는다', async () => {
    const configDir = await mkdtemp(join(tmpdir(), 'trust-claude-'));
    await writeFile(join(configDir, '.claude.json'), '{ 깨진 json');

    await ensureWorkspaceTrusted({ harness: 'claude-code', workspaceDir: WS, claudeConfigDir: configDir, codexHome: '/unused' });

    const doc = JSON.parse(await readFile(join(configDir, '.claude.json'), 'utf8'));
    expect(doc.projects[WS].hasTrustDialogAccepted).toBe(true);
  });

  it('이미 적혀 있으면 다시 쓰지 않는다 — 매 턴 쓰면 하네스와 경합한다', async () => {
    const configDir = await mkdtemp(join(tmpdir(), 'trust-claude-'));
    const path = join(configDir, '.claude.json');
    await writeFile(path, JSON.stringify({ projects: { [WS]: { hasTrustDialogAccepted: true } } }));
    const before = await readFile(path, 'utf8');

    await ensureWorkspaceTrusted({ harness: 'claude-code', workspaceDir: WS, claudeConfigDir: configDir, codexHome: '/unused' });

    expect(await readFile(path, 'utf8')).toBe(before);
  });
});

describe('ensureWorkspaceTrusted — codex', () => {
  it('config.toml 에 projects 절을 덧붙인다', async () => {
    const codexHome = await mkdtemp(join(tmpdir(), 'trust-codex-'));
    await ensureWorkspaceTrusted({ harness: 'codex', workspaceDir: WS, claudeConfigDir: null, codexHome });

    const toml = await readFile(join(codexHome, 'config.toml'), 'utf8');
    expect(toml).toContain(`[projects."${WS}"]`);
    expect(toml).toContain('trust_level = "trusted"');
  });

  it('기존 내용을 지우지 않는다', async () => {
    const codexHome = await mkdtemp(join(tmpdir(), 'trust-codex-'));
    await writeFile(join(codexHome, 'config.toml'), '[tui]\nsomething = 1\n');

    await ensureWorkspaceTrusted({ harness: 'codex', workspaceDir: WS, claudeConfigDir: null, codexHome });

    const toml = await readFile(join(codexHome, 'config.toml'), 'utf8');
    expect(toml).toContain('[tui]');
    expect(toml).toContain(`[projects."${WS}"]`);
  });

  it('이미 있으면 다시 덧붙이지 않는다 — 같은 절이 쌓이면 파일이 자란다', async () => {
    const codexHome = await mkdtemp(join(tmpdir(), 'trust-codex-'));
    await ensureWorkspaceTrusted({ harness: 'codex', workspaceDir: WS, claudeConfigDir: null, codexHome });
    const once = await readFile(join(codexHome, 'config.toml'), 'utf8');
    await ensureWorkspaceTrusted({ harness: 'codex', workspaceDir: WS, claudeConfigDir: null, codexHome });

    expect(await readFile(join(codexHome, 'config.toml'), 'utf8')).toBe(once);
  });
});

describe('ensureWorkspaceTrusted — 실패해도 던지지 않는다', () => {
  /**
   * 쓸 수 없는 경로를 **파일을 부모로 삼아** 만든다. `/proc/...` 같은 플랫폼 특수 경로를
   * 쓰면 OS 마다 다르게 동작한다 — CI(Linux)에서는 그 쓰기가 매달려 테스트가 시간 초과로
   * 죽었다(2026-09-08). 파일 아래 경로는 어디서나 즉시 ENOTDIR 이다.
   */
  async function unwritableDir(): Promise<string> {
    const base = await mkdtemp(join(tmpdir(), 'trust-unwritable-'));
    const asFile = join(base, 'not-a-dir');
    await writeFile(asFile, 'x');
    return join(asFile, 'child');
  }

  it('claude: 쓸 수 없는 경로여도 예외를 올리지 않는다 — 준비 대기 상한이 그 사실을 말한다', async () => {
    await expect(ensureWorkspaceTrusted({
      harness: 'claude-code', workspaceDir: WS,
      claudeConfigDir: await unwritableDir(), codexHome: '/unused',
    })).resolves.toBeUndefined();
  });

  it('codex: 쓸 수 없는 경로여도 예외를 올리지 않는다', async () => {
    await expect(ensureWorkspaceTrusted({
      harness: 'codex', workspaceDir: WS,
      claudeConfigDir: null, codexHome: await unwritableDir(),
    })).resolves.toBeUndefined();
  });
});

// ── 관문 ③: bypassPermissions 수락(2026-09-08 실측)
//
// **이것이 없으면 기본 설정의 모든 첫 턴이 1초 만에 죽는다.** `turn.ts:156` 이 murmur 의
// `auto` 를 `--permission-mode bypassPermissions` 로 번역하고, TUI 는 그 모드로 뜰 때마다
// 계정이 한 번도 수락한 적 없으면 경고 화면을 띄운다 — 기본 선택이 `❯ No, exit` 라서
// 러너가 답을 못 하면 그 선택으로 끝난다(실측: exitCode 1, 경과 ~1초).
describe('ensureDangerousModeAccepted — claude', () => {
  it('settings.json 에 수락을 적는다', async () => {
    const configDir = await mkdtemp(join(tmpdir(), 'danger-claude-'));
    await ensureDangerousModeAccepted({ harness: 'claude-code', claudeConfigDir: configDir });

    const doc = JSON.parse(await readFile(join(configDir, 'settings.json'), 'utf8'));
    expect(doc.skipDangerousModePermissionPrompt).toBe(true);
  });

  it('기존 설정을 지우지 않는다 — 테마·tui 가 함께 산다', async () => {
    const configDir = await mkdtemp(join(tmpdir(), 'danger-claude-'));
    await writeFile(join(configDir, 'settings.json'), JSON.stringify({ theme: 'dark', tui: 'fullscreen' }));

    await ensureDangerousModeAccepted({ harness: 'claude-code', claudeConfigDir: configDir });

    const doc = JSON.parse(await readFile(join(configDir, 'settings.json'), 'utf8'));
    expect(doc.theme).toBe('dark');
    expect(doc.tui).toBe('fullscreen');
    expect(doc.skipDangerousModePermissionPrompt).toBe(true);
  });

  it('이미 적혀 있으면 다시 쓰지 않는다 — 하네스와 같은 파일을 놓고 경합하지 않는다', async () => {
    const configDir = await mkdtemp(join(tmpdir(), 'danger-claude-'));
    const path = join(configDir, 'settings.json');
    await writeFile(path, JSON.stringify({ skipDangerousModePermissionPrompt: true }));
    const before = (await stat(path)).mtimeMs;

    await ensureDangerousModeAccepted({ harness: 'claude-code', claudeConfigDir: configDir });

    expect((await stat(path)).mtimeMs).toBe(before);
  });

  it('codex 는 이 관문이 없다 — 아무 파일도 만들지 않는다', async () => {
    const configDir = await mkdtemp(join(tmpdir(), 'danger-codex-'));
    await ensureDangerousModeAccepted({ harness: 'codex', claudeConfigDir: configDir });
    expect(existsSync(join(configDir, 'settings.json'))).toBe(false);
  });

  it('못 써도 던지지 않는다 — 그 실패로 턴을 죽이지 않는다', async () => {
    // 파일을 디렉터리의 부모로 쓰면 어느 플랫폼에서든 ENOTDIR 이다.
    const base = await mkdtemp(join(tmpdir(), 'danger-bad-'));
    const blocker = join(base, 'blocker');
    await writeFile(blocker, 'not a directory');
    await expect(ensureDangerousModeAccepted({
      harness: 'claude-code', claudeConfigDir: join(blocker, 'nope'),
    })).resolves.toBeUndefined();
  });
});
