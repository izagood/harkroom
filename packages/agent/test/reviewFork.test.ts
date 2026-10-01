import { EventEmitter } from 'node:events';
import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PassThrough } from 'node:stream';

import { describe, expect, it } from 'vitest';

import {
  REVIEW_ALLOWED_TOOLS, REVIEW_DISALLOWED_TOOLS, REVIEW_FORK_ENV, REVIEW_FORK_EVERY_TURNS, REVIEW_FORK_ON_FILE,
  REVIEW_PROMPT, ReviewFork, parseForkResult, reviewForkArgs, reviewForkEnabled, type ReviewForkTurn,
} from '../src/reviewFork.js';
import { supportsReviewFork } from '../src/adapters/index.js';

const AGENT = '653bcd95-ff98-452a-bb36-a55deac4b35e';

const TURN_ARGS = [
  '-r', 'sess-1', '--permission-mode', 'auto',
  '--mcp-config', '/tmp/mcp.json', '--strict-mcp-config',
  '--model', 'claude-opus-5-5', '--effort', 'high',
  '--append-system-prompt-file', '/state/system-prompt.md',
];

const RESULT_JSON = JSON.stringify({
  type: 'result', is_error: false, num_turns: 3, result: 'mem/x 를 고쳤다',
  session_id: 'fork-1',
  usage: { input_tokens: 2, cache_creation_input_tokens: 73, cache_read_input_tokens: 18913, output_tokens: 40 },
});

/** 가짜 자식 — stdin 으로 받은 것을 남기고, 정해 둔 stdout 을 낸 뒤 닫힌다. */
function fakeChild(stdout: string, opts: { hang?: boolean } = {}) {
  const ee = new EventEmitter();
  const out = new PassThrough();
  const input = new PassThrough();
  let stdinText = '';
  input.on('data', (c) => { stdinText += c.toString(); });
  const killed: string[] = [];
  const child = {
    stdout: out, stdin: input,
    on: (ev: string, cb: (...a: unknown[]) => void) => { ee.on(ev, cb); return child; },
    kill: (sig?: string) => { killed.push(sig ?? 'SIGTERM'); ee.emit('close', null); return true; },
  };
  if (!opts.hang) {
    setTimeout(() => { out.end(stdout); setTimeout(() => ee.emit('close', 0), 5); }, 5);
  }
  return { child, stdin: () => stdinText, killed };
}

async function setup(opts: { on?: boolean; env?: NodeJS.ProcessEnv } = {}) {
  const stateDir = await mkdtemp(join(tmpdir(), 'rfork-'));
  await writeFile(join(stateDir, 'system-prompt.md'), 'SYSTEM', 'utf8');
  if (opts.on !== false) await writeFile(join(stateDir, REVIEW_FORK_ON_FILE), '', 'utf8');
  const spawns: { command: string; args: string[]; cwd: string; env: Record<string, string> }[] = [];
  const logs: string[] = [];
  let last: ReturnType<typeof fakeChild> | null = null;
  let hang = false;
  const rf = new ReviewFork({
    stateDir,
    env: opts.env ?? {},
    spawn: (command, args, o) => {
      spawns.push({ command, args, ...o });
      last = fakeChild(RESULT_JSON, { hang });
      return last.child as never;
    },
    log: (l) => logs.push(l),
    readToolNames: async () => ['mcp__harkroom__memory_get', 'mcp__harkroom__memory_set'],
    timeoutMs: 200,
  });
  const turn = (over: Partial<ReviewForkTurn> = {}): ReviewForkTurn => ({
    agentId: AGENT, harness: 'claude-code', sessionId: 'sess-1', cwd: '/ws',
    plan: { command: 'claude', args: [...TURN_ARGS.slice(0, -1), join(stateDir, 'system-prompt.md')], env: { CLAUDE_CONFIG_DIR: '/acct' }, stdinFile: null },
    claudeConfigDir: '/acct', skip: false, ...over,
  });
  return { stateDir, rf, spawns, logs, turn, child: () => last, setHang: (v: boolean) => { hang = v; } };
}

/** n 턴을 센다. 띄운 포크가 있으면 그 프라미스를 **감싸서** 준다(async 반환은 프라미스를 풀어 버린다). */
async function turns(rf: ReviewFork, make: () => ReviewForkTurn, n: number): Promise<{ run: Promise<unknown> } | null> {
  let run: Promise<unknown> | null = null;
  for (let i = 0; i < n; i++) run = (await rf.afterTurn(make()))?.done ?? run;
  return run ? { run } : null;
}

describe('reviewForkArgs', () => {
  it('세션·권한 인자를 빼고 포크 인자와 도구 제한을 붙인다(지시문은 사본으로)', () => {
    const args = reviewForkArgs(TURN_ARGS, 'sess-1', '/state/review-fork-system-prompt.md');
    expect(args.slice(0, 6)).toEqual(['-p', '--resume', 'sess-1', '--fork-session', '--output-format', 'json']);
    expect(args).not.toContain('-r');
    expect(args.filter((a) => a === '--permission-mode')).toHaveLength(1);
    expect(args[args.indexOf('--permission-mode') + 1]).toBe('dontAsk');
    expect(args).toEqual(expect.arrayContaining(['--mcp-config', '/tmp/mcp.json', '--strict-mcp-config', '--model', 'claude-opus-5-5', '--effort', 'high']));
    expect(args[args.indexOf('--append-system-prompt-file') + 1]).toBe('/state/review-fork-system-prompt.md');
    expect(args[args.indexOf('--allowedTools') + 1]).toBe(REVIEW_ALLOWED_TOOLS.join(','));
    expect(args[args.indexOf('--disallowedTools') + 1]).toBe(REVIEW_DISALLOWED_TOOLS.join(','));
    // 가변 인자 뒤에 위치 인자(프롬프트)를 두지 않는다 — 프롬프트는 stdin 이다.
    expect(args.at(-2)).toBe('--disallowedTools');
  });

  it('첫 턴의 --session-id 도 뺀다', () => {
    const args = reviewForkArgs(['--session-id', 'abc', '--permission-mode', 'plan'], 'abc', null);
    expect(args).not.toContain('--session-id');
    expect(args).not.toContain('plan');
  });

  it('허락 목록은 기억 도구뿐이고 발화·예약은 막는다', () => {
    expect(REVIEW_ALLOWED_TOOLS.some((t) => /message|inbox|turn_wake|Bash/.test(t))).toBe(false);
    expect(REVIEW_DISALLOWED_TOOLS).toEqual(expect.arrayContaining(['mcp__harkroom__message_post', 'mcp__harkroom__turn_wake', 'Bash', 'Edit', 'Write']));
  });
});

describe('parseForkResult', () => {
  it('usage 와 캐시 읽기 비율을 읽는다', () => {
    const r = parseForkResult(RESULT_JSON);
    expect(r.forkSessionId).toBe('fork-1');
    expect(r.usage).toEqual({ input: 2, cacheRead: 18913, cacheCreation: 73, output: 40 });
    expect(r.cacheReadRatio).toBe(0.996);
    expect(r.numTurns).toBe(3);
  });

  it('앞에 다른 줄이 섞여도 마지막 줄을 읽고, 못 읽으면 null 칸', () => {
    expect(parseForkResult(`warn\n${RESULT_JSON}`).forkSessionId).toBe('fork-1');
    expect(parseForkResult('not json')).toMatchObject({ forkSessionId: null, usage: null, cacheReadRatio: null });
  });
});

describe('reviewForkEnabled', () => {
  it('env 목록 또는 켜기 파일', async () => {
    const off = await setup({ on: false });
    expect(await reviewForkEnabled(AGENT, off.stateDir, {})).toBe(false);
    expect(await reviewForkEnabled(AGENT, off.stateDir, { [REVIEW_FORK_ENV]: `x, ${AGENT}` })).toBe(true);
    const on = await setup();
    expect(await reviewForkEnabled(AGENT, on.stateDir, {})).toBe(true);
  });
});

describe('ReviewFork.afterTurn', () => {
  it('claude 만 포크할 수 있다', () => {
    expect(supportsReviewFork('claude-code')).toBe(true);
    expect(supportsReviewFork('codex')).toBe(false);
    expect(supportsReviewFork('opencode')).toBe(false);
    expect(supportsReviewFork('gemini')).toBe(false);
  });

  it(`${REVIEW_FORK_EVERY_TURNS}번째 턴에 뜨고, 그 전엔 안 뜬다 — 카운터는 디스크에 남는다`, async () => {
    const s = await setup();
    for (let i = 1; i < REVIEW_FORK_EVERY_TURNS; i++) {
      expect(await s.rf.afterTurn(s.turn())).toBeNull();
    }
    expect(s.spawns).toHaveLength(0);
    expect(JSON.parse(await readFile(join(s.stateDir, 'review-fork.json'), 'utf8')).count).toBe(REVIEW_FORK_EVERY_TURNS - 1);

    const run = await s.rf.afterTurn(s.turn());
    expect(run).not.toBeNull();
    const usage = await run!.done;
    expect(s.spawns).toHaveLength(1);
    const sp = s.spawns[0]!;
    expect(sp.command).toBe('claude');
    expect(sp.cwd).toBe('/ws');
    expect(sp.env.CLAUDE_CONFIG_DIR).toBe('/acct');
    expect(sp.args.slice(0, 4)).toEqual(['-p', '--resume', 'sess-1', '--fork-session']);
    // 지시문은 사본으로 넘기고, 프롬프트는 stdin 으로 갔다.
    const copy = sp.args[sp.args.indexOf('--append-system-prompt-file') + 1]!;
    expect(copy).toBe(join(s.stateDir, 'review-fork-system-prompt.md'));
    expect(await readFile(copy, 'utf8')).toBe('SYSTEM');
    expect(s.child()!.stdin()).toBe(REVIEW_PROMPT);

    expect(usage).toMatchObject({ forkSessionId: 'fork-1', sourceSessionId: 'sess-1', exitCode: 0, timedOut: false, cacheReadRatio: 0.996 });
    expect(usage!.tools).toEqual(['mcp__harkroom__memory_get', 'mcp__harkroom__memory_set']);
    const line = s.logs.find((l) => l.startsWith('[reviewFork] review.usage '))!;
    expect(JSON.parse(line.slice('[reviewFork] review.usage '.length))).toMatchObject({ forkSessionId: 'fork-1' });
    expect(JSON.parse(await readFile(join(s.stateDir, 'review-fork.json'), 'utf8')).count).toBe(0);
  });

  it('켜지 않았으면·하네스가 못 하면·세션이 없으면·건너뛸 턴이면 세지도 띄우지도 않는다', async () => {
    const off = await setup({ on: false });
    expect(await turns(off.rf, () => off.turn(), REVIEW_FORK_EVERY_TURNS * 2)).toBeNull();
    const s = await setup();
    expect(await turns(s.rf, () => s.turn({ harness: 'codex' }), REVIEW_FORK_EVERY_TURNS * 2)).toBeNull();
    expect(await turns(s.rf, () => s.turn({ sessionId: null }), REVIEW_FORK_EVERY_TURNS * 2)).toBeNull();
    expect(await turns(s.rf, () => s.turn({ skip: true }), REVIEW_FORK_EVERY_TURNS * 2)).toBeNull();
    expect(off.spawns.length + s.spawns.length).toBe(0);
    // 건너뛴 턴은 세지 않았다 — 카운터 파일이 아직 없다.
    await expect(readFile(join(s.stateDir, 'review-fork.json'), 'utf8')).rejects.toThrow();
  });

  it('동시에 하나만 돈다 — 앞 포크가 돌면 이번엔 띄우지 않고 다음 턴에 다시 본다', async () => {
    const s = await setup();
    s.setHang(true);
    const first = await turns(s.rf, () => s.turn(), REVIEW_FORK_EVERY_TURNS);
    expect(first).not.toBeNull();
    expect(await turns(s.rf, () => s.turn(), REVIEW_FORK_EVERY_TURNS)).toBeNull();
    expect(s.spawns).toHaveLength(1);
    // 시한(200ms)에 죽는다.
    const usage = (await first!.run) as { timedOut: boolean };
    expect(usage.timedOut).toBe(true);
    expect(s.child()!.killed).toEqual(['SIGKILL']);
    // 앞 포크가 끝났으니 다음 턴에 바로 뜬다(밀린 카운트가 이미 찼다).
    s.setHang(false);
    const next = await s.rf.afterTurn(s.turn());
    expect(next).not.toBeNull();
    await next!.done;
    expect(s.spawns).toHaveLength(2);
  });
});
