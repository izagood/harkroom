// omp 실물 — 100줄이 넘는 프롬프트도 러너의 주입(runPtyTurn)으로 제출된다(2026-10-25 qa-omp-lane 10분 정지).
// omp 는 기본 100줄(`paste.largeMenuThreshold`)이 넘는 붙여넣기에 「어떻게 붙일까」 메뉴를 띄우고, 러너의 Enter 한 번이 그 메뉴
// 고르기로 쓰여 프롬프트가 입력창에 남았다. 오버레이가 메뉴를 끈다(`ompHome.ts`). `HARKROOM_OMP_BIN` 이 있을 때만 돈다.
import { createServer } from 'node:http';
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { injectionFactsFor } from '../src/adapters/index.js';
import { ensureOmpHome, ensureOmpThread, newOmpSessionId, ompDirs, writeOmpLaneModels, writeOmpSessionHeader } from '../src/ompHome.js';
import { runPtyTurn } from '../src/pty.js';
import { buildTurnCommand } from '../src/turn.js';

const BIN = process.env.HARKROOM_OMP_BIN;

describe.skipIf(!BIN)('omp 실물 — 큰 붙여넣기 제출', () => {
  it.each([1, 150, 400])('%i줄 프롬프트가 모델에 전문으로 간다', async (lines) => {
    const root = await mkdtemp(join(tmpdir(), 'omp-paste-'));
    const bodies: string[] = [];
    const paths: string[] = [];
    const srv = createServer((req, res) => {
      let b = '';
      req.on('data', (d) => (b += d));
      req.on('end', () => {
        bodies.push(b);
        paths.push(req.url ?? '');
        const c = (d: unknown, f: string | null) => `data: ${JSON.stringify({ id: 'c', object: 'chat.completion.chunk', created: 1, model: 'm', choices: [{ index: 0, delta: d, finish_reason: f }] })}\n\n`;
        res.writeHead(200, { 'content-type': 'text/event-stream' });
        res.end(`${c({ role: 'assistant', content: 'DONE' }, null)}${c({}, 'stop')}data: [DONE]\n\n`);
      });
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
      const text = Array.from({ length: lines }, (_, i) => `줄 ${i} — 채널 스레드 설명을 채운다`).join('\n');
      const env = { PATH: `${dirname(BIN as string)}:/usr/bin:/bin`, TERM: 'xterm-256color', HOME: built.env.HOME as string, PI_CODING_AGENT_DIR: built.env.PI_CODING_AGENT_DIR as string };
      // 턴은 끝나지 않는다(TUI) — 답이 올 시간만 주고 거둔다.
      void runPtyTurn({ command: BIN as string, args: built.args, env, stdinFile: null }, {
        cwd: built.cwd ?? thread.cwd, timeoutMs: 20_000, injectPrompt: { text, ...injectionFactsFor('omp') },
      } as Parameters<typeof runPtyTurn>[1]);
      for (let i = 0; i < 150 && !bodies.some((b) => b.includes(`줄 ${lines - 1} —`)); i++) await new Promise((r) => setTimeout(r, 100));
      const sessions = (await readdir(ompDirs(ompHome).sessionsDir)).filter((n) => n.endsWith('.jsonl'));
      const record = await readFile(join(ompDirs(ompHome).sessionsDir, sessions[0]!), 'utf8');
      expect(bodies.some((b) => b.includes(`줄 ${lines - 1} —`))).toBe(true); // 마지막 줄까지 모델에 갔다
      expect(record).toContain('"role":"user"'); // 입력창에 남지 않고 제출됐다
      // 러너가 넘기는 lane 주소는 뿌리다 — omp 는 그 위 `/v1/chat/completions` 를 불러야 한다(2026-10-25 404).
      expect(new Set(paths)).toEqual(new Set(['/v1/chat/completions']));
    } finally {
      srv.close();
      await rm(root, { recursive: true, force: true });
    }
  }, 60_000);
});
