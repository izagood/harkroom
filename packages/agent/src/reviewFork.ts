// 턴 뒤 리뷰 포크(D1 실험, 2026-10-01 — Hermes 자기 개선 검토, jaebin "추천대로").
//
// ## 무엇을 하나
//
// 성공한 턴 몇 번마다, 그 턴의 claude 세션을 **포크**(`--resume <id> --fork-session`)해 같은 대화를
// 다시 읽히고 "남길 교정·선호·절차가 있었나"를 묻는다. 있으면 포크가 `memory.set` 으로 남기고,
// 다른 에이전트도 쓸 절차면 `skill.propose` 로 **제안만** 한다(D2). 원 세션은 그대로다 — 포크는
// 새 session id 를 받는다(2026-10-01 실측: `-p --resume X --fork-session` → 새 id, 앞 대화 기억,
// cache_read 18,913 / creation 73 = 99.6%).
//
// Hermes Agent 의 `agent/background_review.py` 가 원형이다: 답을 낸 **뒤** 부모와 같은 캐시를 쓰는
// 포크가 메모리·스킬 도구만 들고 돈다. 다른 점 둘:
// - **스킬은 제안만 한다.** harkroom 의 스킬은 모든 에이전트가 공유하고 사람이 승인해야 깔린다.
// - **문턱을 낮추지 않는다.** Hermes 의 스킬 리뷰는 "대부분 세션은 스킬 갱신을 낳는다"고 몰아세운다.
//   여기 포크는 남길 것이 없으면 아무것도 안 하는 것이 흔한 정답이라고 듣는다 — 제안 하나마다
//   사람의 승인 시간이 들고, 기억의 잡음은 recall 을 망친다.
//
// ## 왜 실험 스위치 뒤에 있나
//
// 비용과 잡음을 아직 모른다. 실험(claude-dev, 대본 20개)이 잴 것: ① 포크가 원 턴의 캐시를 정말
// 같이 쓰는가 — 원 턴은 TUI 이고 포크는 `-p` 라 시스템 프롬프트가 다를 수 있다(미확인) ② 리뷰 1회의
// 토큰 ③ 쓸데없는 기억의 비율 ④ 발화 0. 그래서 **켠 에이전트만** 돈다:
// - env `HARKROOM_REVIEW_FORK_AGENTS`(에이전트 id, 쉼표) — 러너는 오퍼레이터 env 를 통째로
//   물려받는다(`operator/src/runners.ts::withUserEnv`). 오퍼레이터를 그 env 로 띄워야 한다.
// - 또는 러너 상태 디렉터리의 `review-fork.on` 파일 — 턴마다 본다. 재기동 없이 켜고 끈다.
//
// ## 안전
//
// 포크는 `--permission-mode dontAsk`(미리 허락한 것 말고는 묻지 않고 거절) + `--allowedTools` 로
// 기억 도구만 허락하고, `--disallowedTools` 로 발화·inbox·예약·자동화·비밀·셸·편집을 막는다.
// 쓰기는 서버의 쓰기 검사(#971 contentScan)를 그대로 지난다. 5분 넘으면 죽인다.
import { spawn as nodeSpawn } from 'node:child_process';
import { copyFile, chmod, readFile, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import type { AgentHarness } from '@harkroom/shared';

import { supportsReviewFork } from './adapters/index.js';
import { readTranscriptTail, recordsSince } from './harnessErrors.js';
import type { TurnPlan } from './turn.js';

/** 이만큼 성공한(세는) 턴마다 한 번 리뷰한다. Hermes 는 10 — harkroom 세션이 짧아(세션당 ~1.7턴) 5. */
export const REVIEW_FORK_EVERY_TURNS = 5;
/** 포크 프로세스 상한. 넘으면 죽인다. */
export const REVIEW_FORK_TIMEOUT_MS = 5 * 60_000;
export const REVIEW_FORK_ENV = 'HARKROOM_REVIEW_FORK_AGENTS';
/** 러너 상태 디렉터리에 이 파일이 있으면 켜진다. */
export const REVIEW_FORK_ON_FILE = 'review-fork.on';
const STATE_FILE = 'review-fork.json';
const SYSTEM_PROMPT_COPY = 'review-fork-system-prompt.md';

/** 포크가 묻지 않고 부를 수 있는 도구. MCP 도구 이름은 `mcp__<서버>__<도구의 . 을 _ 로>` 다(실측). */
export const REVIEW_ALLOWED_TOOLS = [
  'mcp__harkroom__memory_get',
  'mcp__harkroom__memory_search',
  'mcp__harkroom__memory_list',
  'mcp__harkroom__memory_set',
  'mcp__harkroom__skill_propose',
  // MCP 도구가 지연 로드되는 판에서는 이것으로 스키마를 받아야 부를 수 있다.
  'ToolSearch',
] as const;

/** 아예 못 쓰게 하는 도구. `dontAsk` 로도 거절되지만 이름으로 한 번 더 막는다. */
export const REVIEW_DISALLOWED_TOOLS = [
  'Bash', 'Edit', 'Write', 'NotebookEdit', 'WebFetch', 'WebSearch', 'Task', 'Agent',
  'mcp__harkroom__message_post', 'mcp__harkroom__message_progress', 'mcp__harkroom__message_report',
  'mcp__harkroom__message_fail', 'mcp__harkroom__message_ask', 'mcp__harkroom__message_askBundle',
  'mcp__harkroom__message_askBundleResolve', 'mcp__harkroom__message_delegate',
  'mcp__harkroom__message_react', 'mcp__harkroom__message_unreact',
  'mcp__harkroom__inbox_poll', 'mcp__harkroom__inbox_read', 'mcp__harkroom__turn_wake',
  'mcp__harkroom__automation_propose', 'mcp__harkroom__automation_run',
  'mcp__harkroom__secret_mount',
] as const;

export const REVIEW_PROMPT = [
  '[harkroom 리뷰] 이것은 사람에게 가는 턴이 아니다. 방금 대화를 돌아보고 **다음 턴의 네가 알아야 할 것**만 기억에 남겨라.',
  '',
  '남길 것(있을 때만):',
  '- 사람이 너를 **교정**했거나 선호를 말했다(말투·절차·하지 말 것). 1급 신호다.',
  '- 이 대화에서 처음 알아낸, 되풀이해 쓸 사실(저장소·도구·환경의 규칙)과 그 이유.',
  '',
  '쓰는 법:',
  '- 먼저 memory.list·memory.search·memory.get 으로 이미 있는 항목을 찾는다. 있으면 그것을 고친다(ifUpdatedAt). 새 slug 를 늘리지 않는다.',
  '- 사건 서술·PR 번호·날짜별 경위는 쓰지 않는다. 일반 규칙과 **왜 그런지**를 쓴다.',
  '- core 에는 포인터 한 줄만. 주제는 mem/<이름> 에, 언제 열어 볼지 알 수 있는 description 과 함께.',
  '- 스킬(skill.propose)은 같은 절차를 세 번쯤 되풀이했고 **다른 에이전트도 그대로 따라 할 수 있을 때만** 제안한다. 확실하지 않으면 제안하지 않는다.',
  '',
  '**남길 것이 없으면 아무 도구도 부르지 말고 끝내라 — 그것이 가장 흔한 정답이다.**',
  '발화(message.*)·예약·셸·파일 편집은 하지 않는다. 끝낼 때 무엇을 남겼는지 한 줄로만 적는다.',
].join('\n');

/** 리뷰 포크가 받는 재료 — 방금 끝난 턴의 사실들. */
export interface ReviewForkTurn {
  agentId: string;
  harness: AgentHarness;
  sessionId: string | null;
  /** 원 턴의 cwd. claude 세션 기록은 cwd 로 찾으므로 같아야 이어진다. */
  cwd: string;
  /** 원 턴의 plan — 모델·MCP 설정·지시문 파일·env 를 그대로 물려받는다. */
  plan: TurnPlan;
  claudeConfigDir: string | null;
  /** 예약으로 깨어난 턴·넘긴 일의 결말로 깨어난 턴·자동화가 띄운 턴. 세지도 돌리지도 않는다. */
  skip: boolean;
}

export interface ReviewForkChild {
  stdout: NodeJS.ReadableStream | null;
  stdin: NodeJS.WritableStream | null;
  on(event: 'close', cb: (code: number | null) => void): unknown;
  on(event: 'error', cb: (err: Error) => void): unknown;
  kill(signal?: NodeJS.Signals): unknown;
}

export interface ReviewForkDeps {
  /** 러너 상태 디렉터리(카운터·켜기 파일·지시문 사본). */
  stateDir: string;
  env?: NodeJS.ProcessEnv;
  spawn?: (command: string, args: string[], opts: { cwd: string; env: Record<string, string> }) => ReviewForkChild;
  log?: (line: string) => void;
  now?: () => number;
  timeoutMs?: number;
  /** 포크 기록에서 부른 도구 이름을 읽는다(기본: claude jsonl). */
  readToolNames?: (forkSessionId: string, configDir: string | null, sinceMs: number) => Promise<string[]>;
}

export interface ReviewUsage {
  forkSessionId: string | null;
  sourceSessionId: string;
  durationMs: number;
  exitCode: number | null;
  timedOut: boolean;
  usage: { input: number; cacheRead: number; cacheCreation: number; output: number } | null;
  /** 입력 중 캐시 읽기 비율(실험 기준 1). 입력이 0 이면 null. */
  cacheReadRatio: number | null;
  numTurns: number | null;
  isError: boolean | null;
  tools: string[];
  result: string | null;
}

/** 원 턴의 argv 에서 세션·권한 인자를 빼고 리뷰 포크의 argv 를 만든다. 순수 함수다. */
/** 원 턴 argv 의 `--permission-mode` 값(`--permission-mode x`·`--permission-mode=x` 둘 다). 없으면 null. */
export function originalPermissionMode(args: readonly string[]): string | null {
  for (let i = 0; i < args.length; i++) {
    const a = args[i]!;
    if (a === '--permission-mode') return args[i + 1] ?? null;
    if (a.startsWith('--permission-mode=')) return a.slice('--permission-mode='.length);
  }
  return null;
}

export function reviewForkArgs(turnArgs: readonly string[], sessionId: string, systemPromptCopy: string | null): string[] {
  const drop = new Set(['--session-id', '-r', '--resume', '--permission-mode']);
  const kept: string[] = [];
  for (let i = 0; i < turnArgs.length; i++) {
    const a = turnArgs[i]!;
    if (drop.has(a)) { i++; continue; }
    if (a === '--append-system-prompt-file' && systemPromptCopy) {
      kept.push(a, systemPromptCopy); i++; continue;
    }
    kept.push(a);
  }
  // 프롬프트는 stdin 으로 준다 — `--disallowedTools <tools...>` 가 가변 인자라 뒤의 위치 인자를
  // 도구 이름으로 먹는다. stdin 이면 argv(`ps`)에도 안 뜬다.
  return [
    '-p', '--resume', sessionId, '--fork-session', '--output-format', 'json',
    ...kept,
    '--permission-mode', 'dontAsk',
    '--allowedTools', REVIEW_ALLOWED_TOOLS.join(','),
    '--disallowedTools', REVIEW_DISALLOWED_TOOLS.join(','),
  ];
}

/** `--output-format json` 의 결과 한 덩어리를 읽는다. 못 읽으면 null 칸으로 채운다. 순수 함수다. */
export function parseForkResult(stdout: string): Pick<ReviewUsage, 'forkSessionId' | 'usage' | 'cacheReadRatio' | 'numTurns' | 'isError' | 'result'> {
  let j: Record<string, unknown> | null = null;
  const trimmed = stdout.trim();
  try {
    j = JSON.parse(trimmed) as Record<string, unknown>;
  } catch {
    // 앞에 다른 줄이 섞였으면 마지막 줄을 본다.
    const last = trimmed.split('\n').pop() ?? '';
    try { j = JSON.parse(last) as Record<string, unknown>; } catch { j = null; }
  }
  if (!j) return { forkSessionId: null, usage: null, cacheReadRatio: null, numTurns: null, isError: null, result: null };
  const u = (j.usage ?? null) as Record<string, unknown> | null;
  const n = (v: unknown) => (typeof v === 'number' ? v : 0);
  const usage = u ? {
    input: n(u.input_tokens), cacheRead: n(u.cache_read_input_tokens),
    cacheCreation: n(u.cache_creation_input_tokens), output: n(u.output_tokens),
  } : null;
  const totalIn = usage ? usage.input + usage.cacheRead + usage.cacheCreation : 0;
  return {
    forkSessionId: typeof j.session_id === 'string' ? j.session_id : null,
    usage,
    cacheReadRatio: usage && totalIn > 0 ? Math.round((usage.cacheRead / totalIn) * 1000) / 1000 : null,
    numTurns: typeof j.num_turns === 'number' ? j.num_turns : null,
    isError: typeof j.is_error === 'boolean' ? j.is_error : null,
    result: typeof j.result === 'string' ? j.result.slice(0, 500) : null,
  };
}

/** 이 에이전트에서 켜졌는가 — env 목록 또는 상태 디렉터리의 켜기 파일. */
export async function reviewForkEnabled(agentId: string, stateDir: string, env: NodeJS.ProcessEnv = process.env): Promise<boolean> {
  const list = (env[REVIEW_FORK_ENV] ?? '').split(',').map((s) => s.trim()).filter(Boolean);
  if (list.includes(agentId)) return true;
  return stat(join(stateDir, REVIEW_FORK_ON_FILE)).then(() => true, () => false);
}

async function defaultReadToolNames(forkSessionId: string, configDir: string | null, sinceMs: number): Promise<string[]> {
  const text = await readTranscriptTail(forkSessionId, { configDir });
  if (text === null) return [];
  const names: string[] = [];
  for (const r of recordsSince(text, sinceMs)) {
    if (r.type !== 'assistant') continue;
    const content = r.message?.content;
    if (!Array.isArray(content)) continue;
    for (const part of content as Array<Record<string, unknown>>) {
      if (part && part.type === 'tool_use' && typeof part.name === 'string') names.push(part.name);
    }
  }
  return names;
}

function defaultSpawn(command: string, args: string[], opts: { cwd: string; env: Record<string, string> }): ReviewForkChild {
  return nodeSpawn(command, args, { cwd: opts.cwd, env: opts.env, stdio: ['pipe', 'pipe', 'ignore'] });
}

/**
 * 러너 하나(=에이전트 하나)에 하나. `afterTurn` 은 **기다리지 않는다** — 세고, 때가 되면 포크를
 * 띄우고 바로 돌아온다. 포크는 러너 프로세스 안에서 끝까지 돈다(동시에 하나만, 5분 상한).
 */
export class ReviewFork {
  private inFlight: Promise<ReviewUsage | null> | null = null;
  private readonly log: (line: string) => void;

  constructor(private readonly deps: ReviewForkDeps) {
    this.log = deps.log ?? ((line) => console.log(line));
  }

  /** 지금 돌고 있는 포크(테스트·종료 대기용). 없으면 null. */
  get running(): Promise<ReviewUsage | null> | null {
    return this.inFlight;
  }

  /**
   * 성공한 턴 하나를 센다. 때가 되면 포크를 띄운다. 띄웠으면 `{ done }`(그 포크의 결말)을, 아니면
   * null 을 돌려준다. 결말을 **감싸서** 주는 이유: async 함수가 프라미스를 그대로 돌려주면 JS 가
   * 풀어 버려, 세기만 기다리려던 호출자가 포크가 끝날 때까지(최대 5분) 묶인다.
   */
  async afterTurn(turn: ReviewForkTurn): Promise<{ done: Promise<ReviewUsage | null> } | null> {
    if (turn.skip) return null;
    if (!supportsReviewFork(turn.harness)) return null;
    if (!turn.sessionId) return null;
    // 포크는 권한 모드를 dontAsk 로 **바꾼다**(reviewForkArgs). 원 턴이 readonly(`plan`)였다면 포크가
    // 원래 없던 memory.set 권한을 얻는다(security 검토, #1009 참고 1). 그래서 원 턴이 `auto` 일 때만 —
    // 이미 묻지 않고 기억을 쓸 수 있던 턴만 — 돌아본다. 모드를 모르면(인자가 없으면) 띄우지 않는다.
    const mode = originalPermissionMode(turn.plan.args);
    if (mode !== 'auto') {
      this.log(`[reviewFork] 건너뜀 — 원 턴 권한 모드가 ${mode ?? '(없음)'} 이라 포크가 권한을 넓힐 수 있다`);
      return null;
    }
    if (!(await reviewForkEnabled(turn.agentId, this.deps.stateDir, this.deps.env))) return null;

    const state = await this.readState();
    const count = state.count + 1;
    // 앞 포크가 아직 돌면 이번엔 띄우지 않는다 — 세기는 계속하고, 다음 턴에 다시 본다.
    if (count < REVIEW_FORK_EVERY_TURNS || this.inFlight) {
      await this.writeState({ ...state, count });
      return null;
    }
    await this.writeState({ count: 0, lastReviewAt: new Date(this.now()).toISOString() });
    const run = this.run(turn as ReviewForkTurn & { sessionId: string })
      .catch((err: unknown) => {
        this.log(`[reviewFork] 실패(턴과 무관) — ${err instanceof Error ? err.message : String(err)}`);
        return null;
      })
      .finally(() => { this.inFlight = null; });
    this.inFlight = run;
    return { done: run };
  }

  private now(): number {
    return this.deps.now?.() ?? Date.now();
  }

  private async readState(): Promise<{ count: number; lastReviewAt: string | null }> {
    try {
      const j = JSON.parse(await readFile(join(this.deps.stateDir, STATE_FILE), 'utf8')) as { count?: unknown; lastReviewAt?: unknown };
      return { count: typeof j.count === 'number' ? j.count : 0, lastReviewAt: typeof j.lastReviewAt === 'string' ? j.lastReviewAt : null };
    } catch {
      return { count: 0, lastReviewAt: null };
    }
  }

  private async writeState(s: { count: number; lastReviewAt: string | null }): Promise<void> {
    await writeFile(join(this.deps.stateDir, STATE_FILE), JSON.stringify(s), 'utf8');
  }

  /**
   * 지시문 파일은 **사본**을 넘긴다. 원본은 다음 턴(다른 스레드)이 곧바로 덮어쓸 수 있다 —
   * 포크가 엉뚱한 지시문으로 뜨면 캐시도 깨지고 판단도 달라진다.
   */
  private async copySystemPrompt(args: readonly string[]): Promise<string | null> {
    const i = args.indexOf('--append-system-prompt-file');
    if (i < 0 || !args[i + 1]) return null;
    const dest = join(this.deps.stateDir, SYSTEM_PROMPT_COPY);
    await copyFile(args[i + 1]!, dest);
    await chmod(dest, 0o600);
    return dest;
  }

  private async run(turn: ReviewForkTurn & { sessionId: string }): Promise<ReviewUsage> {
    const startedAt = this.now();
    const promptCopy = await this.copySystemPrompt(turn.plan.args);
    const args = reviewForkArgs(turn.plan.args, turn.sessionId, promptCopy);
    const spawn = this.deps.spawn ?? defaultSpawn;
    const child = spawn(turn.plan.command, args, { cwd: turn.cwd, env: turn.plan.env });

    let stdout = '';
    child.stdout?.setEncoding?.('utf8');
    child.stdout?.on('data', (chunk: string | Buffer) => { stdout += chunk.toString(); });
    child.stdin?.end(REVIEW_PROMPT);

    let timedOut = false;
    const timeoutMs = this.deps.timeoutMs ?? REVIEW_FORK_TIMEOUT_MS;
    const exitCode = await new Promise<number | null>((resolve) => {
      const timer = setTimeout(() => { timedOut = true; child.kill('SIGKILL'); }, timeoutMs);
      child.on('error', (err) => { clearTimeout(timer); this.log(`[reviewFork] 띄우기 실패 — ${err.message}`); resolve(null); });
      child.on('close', (code) => { clearTimeout(timer); resolve(code); });
    });

    const parsed = parseForkResult(stdout);
    const tools = parsed.forkSessionId
      ? await (this.deps.readToolNames ?? defaultReadToolNames)(parsed.forkSessionId, turn.claudeConfigDir, startedAt).catch(() => [])
      : [];
    const usage: ReviewUsage = {
      ...parsed,
      sourceSessionId: turn.sessionId,
      durationMs: this.now() - startedAt,
      exitCode,
      timedOut,
      tools,
    };
    // 실험이 이 줄을 모은다 — 한 줄 JSON 이어야 grep 한 번으로 표가 된다.
    this.log(`[reviewFork] review.usage ${JSON.stringify(usage)}`);
    return usage;
  }
}
