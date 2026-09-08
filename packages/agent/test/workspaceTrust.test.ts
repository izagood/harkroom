// 워크스페이스 신뢰 기록의 회귀선(2026-09-08 프로덕션 사고).
//
// 이것이 없으면 TUI 턴은 신뢰 대화상자를 만나고, 러너는 답할 수 없어 무발화 한도까지
// 매달린다. `-p` 는 이 대화상자를 묻지 않았으므로 실행 모델 교체가 새로 만든 요구다.
import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { ensureWorkspaceTrusted } from '../src/workspaceTrust.js';

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
  it('쓸 수 없는 경로여도 예외를 올리지 않는다 — 준비 대기 상한이 그 사실을 말한다', async () => {
    await expect(ensureWorkspaceTrusted({
      harness: 'claude-code', workspaceDir: WS,
      claudeConfigDir: '/proc/nonexistent/nope', codexHome: '/unused',
    })).resolves.toBeUndefined();
  });
});
