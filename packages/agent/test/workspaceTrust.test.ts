// 워크스페이스 신뢰 기록의 회귀선(2026-09-08 프로덕션 사고).
//
// 이것이 없으면 TUI 턴은 신뢰 대화상자를 만나고, 러너는 답할 수 없어 무발화 한도까지
// 매달린다. `-p` 는 이 대화상자를 묻지 않았으므로 실행 모델 교체가 새로 만든 요구다.
import { lstat, mkdir, mkdtemp, readdir, readFile, stat, symlink, unlink, writeFile } from 'node:fs/promises';
import { existsSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { editPersonJson, ensureDangerousModeAccepted, ensureWorkspaceTrusted } from '../src/workspaceTrust.js';

const WS = '/Users/someone/.harkroom-agent/agent-x/workspaces/harkroom-forge-abc';

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
// **이것이 없으면 기본 설정의 모든 첫 턴이 1초 만에 죽는다.** `turn.ts:156` 이 harkroom 의
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

// 첫 실행 테마 선택·auto mode 안내 창(2026-10-01). 규칙 자체는 shared `claudeGates.test.ts` 가
// 재고, 여기서는 **러너가 그것을 부르는 자리와 범위**를 잰다.
describe('ensureDangerousModeAccepted — 계정 관문(첫 실행·auto mode 안내)', () => {
  it('풀 계정의 .claude.json 에 두 키를 적는다 — 하네스가 담아 둔 값은 그대로', async () => {
    const configDir = await mkdtemp(join(tmpdir(), 'gates-claude-'));
    await writeFile(join(configDir, '.claude.json'), JSON.stringify({
      numStartups: 3, autoModeEnvSetup: { denials: 5 }, projects: { [WS]: { hasTrustDialogAccepted: true } },
    }));
    await ensureDangerousModeAccepted({ harness: 'claude-code', claudeConfigDir: configDir });

    const doc = JSON.parse(await readFile(join(configDir, '.claude.json'), 'utf8'));
    expect(doc).toMatchObject({
      numStartups: 3,
      hasCompletedOnboarding: true,
      autoModeEnvSetup: { denials: 5, dismissed: true },
      projects: { [WS]: { hasTrustDialogAccepted: true } },
    });
  });

  it('codex 에는 적지 않는다', async () => {
    const configDir = await mkdtemp(join(tmpdir(), 'gates-codex-'));
    await ensureDangerousModeAccepted({ harness: 'codex', claudeConfigDir: configDir });
    expect(existsSync(join(configDir, '.claude.json'))).toBe(false);
  });

  it('깨진 .claude.json 은 건드리지 않는다 — 던지지도 않는다', async () => {
    const configDir = await mkdtemp(join(tmpdir(), 'gates-broken-'));
    await writeFile(join(configDir, '.claude.json'), '{ broken');
    await expect(ensureDangerousModeAccepted({ harness: 'claude-code', claudeConfigDir: configDir }))
      .resolves.toBeUndefined();
    expect(await readFile(join(configDir, '.claude.json'), 'utf8')).toBe('{ broken');
  });
});


// ── T2(2026-11-14): 기본 로그인 = 사람의 실제 `~/.claude.json`
//
// claude 는 config dir 이 없으면 `~/.claude/.claude.json` 이 아니라 `~/.claude.json` 을 읽는다(탐침·번들 확인).
// 그 파일은 하네스가 쉬지 않고 고치는 사람의 파일이라 엄격한 길(`editPersonJson`)로만 적는다.
describe('ensureWorkspaceTrusted — 기본 로그인(사람의 ~/.claude.json)', () => {
  const PERSON_DOC = JSON.stringify({
    numStartups: 7,
    zKey: { b: 1, a: 2 },
    mcpServers: { m: { command: 'x' } },
    projects: { '/old': { allowedTools: ['Bash'], hasTrustDialogAccepted: true } },
    aKey: 'last',
  }, null, 2);

  it('그 폴더 한 칸만 더한다 — 나머지는 키 순서까지 같고 ~/.claude/.claude.json 은 만들지 않는다', async () => {
    const home = await mkdtemp(join(tmpdir(), 'trust-person-'));
    const file = join(home, '.claude.json');
    await writeFile(file, PERSON_DOC);
    await ensureWorkspaceTrusted({ harness: 'claude-code', workspaceDir: '/w/new', claudeConfigDir: null, codexHome: '/unused', home });
    const after = JSON.parse(await readFile(file, 'utf8'));
    expect(after.projects['/w/new']).toEqual({ hasTrustDialogAccepted: true });
    delete after.projects['/w/new'];
    expect(JSON.stringify(after)).toBe(JSON.stringify(JSON.parse(PERSON_DOC)));
    expect(existsSync(join(home, '.claude', '.claude.json'))).toBe(false);
    // 이미 있으면 다시 쓰지 않는다 · 임시 파일이 남지 않는다
    const m1 = (await stat(file)).mtimeMs;
    await new Promise((r) => setTimeout(r, 20));
    await ensureWorkspaceTrusted({ harness: 'claude-code', workspaceDir: '/w/new', claudeConfigDir: null, codexHome: '/unused', home });
    expect((await stat(file)).mtimeMs).toBe(m1);
    expect(await readdir(home)).toEqual(['.claude.json']);
  });

  it('깨진 파일·객체 아닌 문서는 바이트 그대로 남긴다 — 던지지도 않는다', async () => {
    const home = await mkdtemp(join(tmpdir(), 'trust-person-broken-'));
    const file = join(home, '.claude.json');
    for (const body of ['{"numStartups": 7, "projects": {', '[1,2]', '']) {
      await writeFile(file, body);
      await ensureWorkspaceTrusted({ harness: 'claude-code', workspaceDir: '/w/new', claudeConfigDir: null, codexHome: '/unused', home });
      expect(await readFile(file, 'utf8')).toBe(body);
    }
  });

  it('링크면 쓰지 않는다 — 링크는 링크로, 너머는 그대로', async () => {
    const home = await mkdtemp(join(tmpdir(), 'trust-person-link-'));
    const real = join(home, 'real.json');
    await writeFile(real, PERSON_DOC);
    await symlink(real, join(home, '.claude.json'));
    await ensureWorkspaceTrusted({ harness: 'claude-code', workspaceDir: '/w/new', claudeConfigDir: null, codexHome: '/unused', home });
    expect((await lstat(join(home, '.claude.json'))).isSymbolicLink()).toBe(true);
    expect(await readFile(real, 'utf8')).toBe(PERSON_DOC);
  });

  it('읽은 뒤 하네스가 고치면 다시 읽고 그 위에 고친다 · 매번 고치면 쓰지 않는다', async () => {
    const home = await mkdtemp(join(tmpdir(), 'trust-person-race-'));
    const file = join(home, '.claude.json');
    await writeFile(file, '{"a": 1}');
    let first = true;
    const r = await editPersonJson(file, (doc) => {
      if (first) { first = false; writeFileSync(file, '{"a": 1, "harness": "wrote"}'); }
      doc.mine = true;
      return true;
    });
    expect(r).toBe('written');
    const v = JSON.parse(await readFile(file, 'utf8'));
    expect(v.harness).toBe('wrote');
    expect(v.mine).toBe(true);
    let n = 0;
    const r2 = await editPersonJson(file, (doc) => {
      n += 1;
      writeFileSync(file, JSON.stringify({ a: 1, n: 'x'.repeat(n) }));
      doc.mine2 = true;
      return true;
    });
    expect(typeof r2).toBe('object');
    expect(JSON.parse(await readFile(file, 'utf8')).mine2).toBeUndefined();
    expect(await readdir(home)).toEqual(['.claude.json']);
  });

  it('bypass: 사람의 ~/.claude/settings.json 이 깨졌거나 링크면 쓰지 않는다', async () => {
    const home = await mkdtemp(join(tmpdir(), 'bypass-person-'));
    await mkdir(join(home, '.claude'));
    const settings = join(home, '.claude', 'settings.json');
    await writeFile(settings, '{"theme": "dark", ');
    await ensureDangerousModeAccepted({ harness: 'claude-code', claudeConfigDir: null, home });
    expect(await readFile(settings, 'utf8')).toBe('{"theme": "dark", ');
    await unlink(settings);
    const real = join(home, 'real-settings.json');
    await writeFile(real, '{"theme": "dark"}');
    await symlink(real, settings);
    await ensureDangerousModeAccepted({ harness: 'claude-code', claudeConfigDir: null, home });
    expect(await readFile(real, 'utf8')).toBe('{"theme": "dark"}');
    expect((await lstat(settings)).isSymbolicLink()).toBe(true);
    // 정상 파일이면 키 하나만 더한다
    await unlink(settings);
    await writeFile(settings, '{"theme": "dark"}');
    await ensureDangerousModeAccepted({ harness: 'claude-code', claudeConfigDir: null, home });
    expect(JSON.parse(await readFile(settings, 'utf8'))).toEqual({ theme: 'dark', skipDangerousModePermissionPrompt: true });
  });
});
