// omp 실물 — API 오류를 받으면 서는 화면이 어댑터의 `apiErrorBanner` 에 맞는다(2026-10-25 qa: 404 띠 뒤 10분 정지).
// 가짜 gateway 가 404 를 돌려주고, 러너 경로(buildTurnCommand·runPtyTurn)로 띄운 화면을 러너와 같은 가림(`harnessTailNotice`)
// 뒤에 맞춘다. `HARKROOM_OMP_BIN` 이 있을 때만 돈다.
import { createServer } from 'node:http';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { apiErrorBannerFor, injectionFactsFor } from '../src/adapters/index.js';
import { ensureOmpHome, ensureOmpThread, newOmpSessionId, ompDirs, writeOmpLaneModels, writeOmpSessionHeader } from '../src/ompHome.js';
import { harnessTailNotice } from '../src/prompt.js';
import { runPtyTurn } from '../src/pty.js';
import { buildTurnCommand } from '../src/turn.js';

const BIN = process.env.HARKROOM_OMP_BIN;

describe.skipIf(!BIN)('omp 실물 — API 오류 띠', () => {
  it('404 를 받은 화면이 apiErrorBanner 에 맞고, 첫 묶음이 그 오류 줄이다', async () => {
    const root = await mkdtemp(join(tmpdir(), 'omp-404-'));
    const srv = createServer((req, res) => {
      req.resume();
      req.on('end', () => { res.writeHead(404, { 'content-type': 'application/json' }); res.end('{"detail":"Not Found"}'); });
    });
    try {
      await new Promise<void>((r) => srv.listen(0, '127.0.0.1', () => r()));
      const port = (srv.address() as { port: number }).port;
      const ompHome = join(root, 'state', 'omp');
      await ensureOmpHome({ ompHome, mcpServers: {} });
      const thread = await ensureOmpThread(ompHome, 'thread-1');
      const repo = join(root, 'repo');
      await mkdir(repo, { recursive: true });
      const sessionId = newOmpSessionId();
      await writeOmpSessionHeader(ompDirs(ompHome).sessionsDir, sessionId, thread.cwd);
      const sys = join(root, 'sys.md');
      await writeFile(sys, 'You are a test agent.');
      const keyPath = join(root, 'key');
      await writeFile(keyPath, 'sk-test', { mode: 0o600 });
      await writeOmpLaneModels(thread.agentDir, { baseUrl: `http://127.0.0.1:${port}`, keyPath, models: ['Org/m'] });
      const built = buildTurnCommand({
        harness: 'omp', mode: 'mention', sessionId, isFirstTurn: true, systemPrompt: 'SYS', systemPromptFile: sys, promptCtx: '',
        model: 'harkroom-lane/Org/m', effort: null, mentionPermission: 'auto', mcpConfigPath: join(root, 'mcp.json'), operatorBin: '/bin/false',
        codexHome: join(root, 'codex'), claudeConfigDir: null, ompHome, ompThread: thread, workspaceDir: repo, stdinFile: null,
      } as Parameters<typeof buildTurnCommand>[0]);
      const env = { PATH: `${dirname(BIN as string)}:/usr/bin:/bin`, TERM: 'xterm-256color', HOME: built.env.HOME as string, PI_CODING_AGENT_DIR: built.env.PI_CODING_AGENT_DIR as string };
      let screen = '';
      const decoder = new TextDecoder();
      void runPtyTurn({ command: BIN as string, args: built.args, env, stdinFile: null }, {
        cwd: built.cwd ?? thread.cwd, timeoutMs: 20_000, injectPrompt: { text: 'hello', ...injectionFactsFor('omp') },
        onData: (chunk: Buffer) => { screen = (screen + decoder.decode(chunk, { stream: true })).slice(-4_000); },
      } as Parameters<typeof runPtyTurn>[1]);
      const banner = apiErrorBannerFor('omp')!;
      let hit: RegExpExecArray | null = null;
      for (let i = 0; i < 150 && !hit; i++) {
        await new Promise((r) => setTimeout(r, 100));
        hit = banner.exec(harnessTailNotice(screen, '') ?? '');
      }
      expect(hit?.[1]?.trim()).toBe('404 {"detail":"Not Found"}');
    } finally {
      srv.close();
      await rm(root, { recursive: true, force: true });
    }
  }, 60_000);
});
