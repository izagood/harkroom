import { mkdtemp, readdir, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { RUNNER_LINK_ENV, RUNNER_TURN_KEY_ENV } from '@harkroom/shared/runnerLink';
import { buildTurnCommand, turnKeyDelivery } from '../src/turn.js';
import { turnKeyDeliveryOf } from '../src/adapters/index.js';
import { ensureOmpHome, ensureOmpThread, ompDirs, writeOmpSessionHeader } from '../src/ompHome.js';

const keys = { bridge: 'b'.repeat(64), shell: 'c'.repeat(64) };

describe('omp 턴 열쇠 — env 로 다리에 준다', () => {
  const saved = { ...process.env };
  beforeEach(() => {
    process.env[RUNNER_LINK_ENV.secret] = 'LINK-SECRET';
    process.env[RUNNER_LINK_ENV.socketPath] = '/s/op.sock';
    process.env[RUNNER_LINK_ENV.runnerId] = 'runner-1';
  });
  afterEach(() => { process.env = { ...saved }; });

  it('omp 는 env-vars 전달이다', () => {
    expect(turnKeyDeliveryOf('omp')).toBe('env-vars');
    expect(turnKeyDelivery('omp')).toBe(true);
  });

  it('열쇠 턴: omp 자식 env 에 링크 열쇠가 없고 다리·셸 열쇠가 있다 · argv 에 값이 없다 · HOME 은 러너 omp 홈', async () => {
    const root = await mkdtemp(join(tmpdir(), 'omp-keys-'));
    const ompHome = join(root, 'omp-home');
    const p = buildTurnCommand({
      harness: 'omp', mode: 'mention', isFirstTurn: true, sessionId: '11111111-2222-4333-8444-555555555555',
      systemPrompt: 'SYS', promptCtx: 'CTX', model: null, effort: null, mentionPermission: 'auto',
      mcpConfigPath: '/mcp.json', operatorBin: '/opt/harkroom/harkroom-operator', codexHome: '/state/codex-home',
      systemPromptFile: '/state/system-prompt.txt', stdinFile: null, claudeConfigDir: null,
      ompHome, ompThread: { cwd: join(root, 'cwd'), agentDir: join(root, 'agent') }, workspaceDir: join(root, 'ws'),
      turnKeys: keys,
    } as never);
    expect(p.env[RUNNER_LINK_ENV.secret]).toBeUndefined();
    expect(Object.values(p.env)).not.toContain('LINK-SECRET');
    expect(p.env[RUNNER_TURN_KEY_ENV.bridge]).toBe(keys.bridge);
    expect(p.env[RUNNER_TURN_KEY_ENV.shell]).toBe(keys.shell);
    expect(p.env.HOME).toBe(ompDirs(ompHome).home);
    expect(p.args.join(' ')).not.toContain(keys.bridge);
  });
});

describe('omp 홈에 쓰는 파일에는 열쇠가 없다(security o1 조건 3)', () => {
  it('ensureOmpHome·ensureOmpThread·세션 헤더가 쓴 파일 어디에도 열쇠 이름·값이 없다', async () => {
    const root = await mkdtemp(join(tmpdir(), 'omp-files-'));
    const ompHome = join(root, 'omp-home');
    process.env[RUNNER_TURN_KEY_ENV.bridge] = keys.bridge;
    process.env[RUNNER_LINK_ENV.secret] = 'LINK-SECRET';
    try {
      await ensureOmpHome({ ompHome, mcpServers: { harkroom: { type: 'stdio', command: '/opt/harkroom/harkroom-operator', args: ['mcp-bridge'] } } });
      const t = await ensureOmpThread(ompHome, 'ch/thread');
      await writeOmpSessionHeader(ompDirs(ompHome).sessionsDir, '11111111-2222-4333-8444-555555555555', t.cwd);
    } finally {
      delete process.env[RUNNER_TURN_KEY_ENV.bridge];
      delete process.env[RUNNER_LINK_ENV.secret];
    }
    const files: string[] = [];
    const walk = async (d: string): Promise<void> => {
      for (const e of await readdir(d, { withFileTypes: true })) {
        const p = join(d, e.name);
        if (e.isDirectory()) { if (e.name !== '.git') await walk(p); } else if (e.isFile()) files.push(p);
      }
    };
    await walk(ompHome);
    expect(files.length).toBeGreaterThan(2);
    for (const f of files) {
      const body = await readFile(f, 'utf8');
      for (const needle of [keys.bridge, 'LINK-SECRET', RUNNER_TURN_KEY_ENV.bridge, RUNNER_LINK_ENV.secret]) expect(body, f).not.toContain(needle);
    }
  });
});
