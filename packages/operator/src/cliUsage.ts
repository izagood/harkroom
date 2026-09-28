// 계정별 한도 사용률을 **각 하네스 CLI 의 공식 표면**으로 읽는다(2026-09-28). 공급자 API 로
// 직접 묻는 `providerUsage.ts`(비공식)보다 **먼저** 쓴다 — 순서는 `usageChain.ts`.
//
// ## 왜 CLI 인가
//
// 두 CLI 모두 자기 로그인으로 자기 한도를 보여 주는 명령을 **사용자에게 공개된 표면**으로 갖고
// 있다. 그 명령을 계정 디렉터리(`CLAUDE_CONFIG_DIR`·`CODEX_HOME`)로 돌리면 토큰을 우리가 읽을
// 일이 없다 — 토큰 갱신도 CLI 가 알아서 한다. CodexBar(github.com/steipete/CodexBar)의 CLI 경로와
// 같은 수법이다.
//
// - Claude: `claude -p /usage` (2.1.283 실측). 출력:
//   ```
//   Current session: 36% used · resets Sep 29 at 5:29am (Asia/Seoul)
//   Current week (all models): 21% used · resets Sep 30 at 6:59pm (Asia/Seoul)
//   Current week (Fable): 0% used · resets Sep 30 at 7pm (Asia/Seoul)
//   ```
//   `--no-session-persistence` 로 세션 파일을 남기지 않고, `--allowed-tools ""` 로 도구를 막는다.
// - Codex: `codex app-server` 의 JSON-RPC `account/rateLimits/read` (0.154 실측).
//   `result.rateLimits.primary|secondary = { usedPercent, windowDurationMins, resetsAt(epoch 초) }`.
//
// 텍스트 파싱은 CLI 판본이 바뀌면 깨질 수 있다. 깨지면 던지지 않고 `cli-unparsed` 를 싣고,
// 체인이 다음 단계로 넘어간다.
import { spawn } from 'node:child_process';
import { mkdir } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';

import type { ProviderAccountUsage, ProviderUsageWindow } from '@harkroom/shared/daemonProtocol';

export type UsageResult = Omit<ProviderAccountUsage, 'account' | 'pool' | 'source'>;

/** 프로브 하나의 상한. claude 는 node 앱이라 뜨는 데 몇 초가 걸린다. */
const PROBE_TIMEOUT_MS = 45_000;

/** 프로브의 작업 디렉터리. 사람의 프로젝트 안에서 돌리지 않는다(신뢰 대화상자·설정 상속). */
export function usageProbeDir(env: NodeJS.ProcessEnv = process.env): string {
  return join(env.HARKROOM_USAGE_PROBE_DIR ?? join(homedir(), '.harkroom-agent', 'usage-probe'));
}

// ── Claude `/usage` ─────────────────────────────────────────────────────────────

const MONTHS = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'];

/** 그 시간대의 벽시계 시각 → epoch ms. `Intl` 로 오프셋을 재서 한 번 보정한다(DST 경계 1시간 오차는 감수). */
function zonedToEpoch(y: number, mo: number, d: number, h: number, mi: number, tz: string): number | null {
  const guess = Date.UTC(y, mo, d, h, mi);
  let parts: Intl.DateTimeFormatPart[];
  try {
    parts = new Intl.DateTimeFormat('en-US', {
      timeZone: tz, hourCycle: 'h23', year: 'numeric', month: 'numeric', day: 'numeric', hour: 'numeric', minute: 'numeric',
    }).formatToParts(new Date(guess));
  } catch {
    return null; // 모르는 시간대
  }
  const get = (t: string): number => Number(parts.find((p) => p.type === t)?.value);
  const asUtc = Date.UTC(get('year'), get('month') - 1, get('day'), get('hour'), get('minute'));
  return guess - (asUtc - guess);
}

/**
 * `resets Sep 29 at 5:29am (Asia/Seoul)` · `resets 7pm (Asia/Seoul)` → epoch ms. 연도는 출력에 없으므로
 * **지금 이후로 가장 가까운** 해로 잡는다(12월에 1월 복귀를 말하는 경우).
 */
export function parseClaudeReset(text: string, now: number): number | null {
  const m = /^(?:([A-Za-z]{3})[a-z]*\.? (\d{1,2})(?:,? at)? )?(\d{1,2})(?::(\d{2}))?\s*(am|pm)\s*\(([^)]+)\)\s*$/i.exec(text.trim());
  if (!m) return null;
  let hour = Number(m[3]) % 12;
  if (m[5]!.toLowerCase() === 'pm') hour += 12;
  const minute = m[4] ? Number(m[4]) : 0;
  const tz = m[6]!;
  const nowParts = new Date(now);
  let year = nowParts.getUTCFullYear();
  let month: number;
  let day: number;
  if (m[1]) {
    month = MONTHS.indexOf(m[1].toLowerCase());
    if (month < 0) return null;
    day = Number(m[2]);
  } else {
    // 날짜가 없으면 "오늘" — 이미 지났으면 내일이다.
    month = nowParts.getUTCMonth();
    day = nowParts.getUTCDate();
  }
  let at = zonedToEpoch(year, month, day, hour, minute, tz);
  if (at === null) return null;
  if (!m[1] && at < now) at += 24 * 60 * 60 * 1000;
  if (m[1] && at < now - 24 * 60 * 60 * 1000) {
    year += 1;
    at = zonedToEpoch(year, month, day, hour, minute, tz);
  }
  return at;
}

export function parseClaudeUsageText(text: string, now: number): Pick<UsageResult, 'session' | 'weekly' | 'extra'> | null {
  let session: ProviderUsageWindow | null = null;
  let weekly: ProviderUsageWindow | null = null;
  const extra: NonNullable<UsageResult['extra']> = [];
  // ANSI 를 벗긴다 — `-p` 는 색이 없지만 판본에 따라 섞일 수 있다.
  const clean = text.replace(/\u001b\[[0-9;?]*[A-Za-z]/g, '');
  for (const line of clean.split(/\r?\n/)) {
    const m = /^\s*Current (session|week(?: \(([^)]+)\))?):\s*(\d+(?:\.\d+)?)% used(?:\s*[·•-]\s*resets\s+(.+))?\s*$/i.exec(line);
    if (!m) continue;
    const w: ProviderUsageWindow = {
      usedPercent: Math.max(0, Math.min(100, Number(m[3]))),
      resetsAtMs: m[4] ? parseClaudeReset(m[4], now) : null,
    };
    if (m[1]!.toLowerCase() === 'session') session = w;
    else if (!m[2] || /^all models$/i.test(m[2])) weekly = w;
    else extra.push({ label: `${m[2]} weekly`, window: w });
  }
  return session || weekly ? { session, weekly, extra } : null;
}

export type RunCommand = (cmd: string, args: string[], opts: { env: NodeJS.ProcessEnv; cwd: string; timeoutMs: number }) =>
  Promise<{ code: number | null; stdout: string }>;

/** 기본 실행기. stdout 만 모은다 — stderr 에는 무엇이 섞일지 모른다(결과에 싣지 않는다). */
export const nodeRunCommand: RunCommand = (cmd, args, opts) => new Promise((resolve) => {
  const child = spawn(cmd, args, { env: opts.env, cwd: opts.cwd, stdio: ['ignore', 'pipe', 'ignore'] });
  let out = '';
  child.stdout?.on('data', (c: Buffer) => { if (out.length < 256 * 1024) out += c.toString('utf8'); });
  const timer = setTimeout(() => { try { child.kill('SIGKILL'); } catch { /* 이미 끝났다 */ } }, opts.timeoutMs);
  child.on('error', () => { clearTimeout(timer); resolve({ code: null, stdout: out }); });
  child.on('exit', (code) => { clearTimeout(timer); resolve({ code, stdout: out }); });
});

export async function claudeCliUsage(opts: {
  configDir: string;
  now: number;
  run?: RunCommand;
  probeDir?: string;
}): Promise<UsageResult> {
  const base = { fetchedAtMs: opts.now, session: null, weekly: null };
  const cwd = opts.probeDir ?? usageProbeDir();
  await mkdir(cwd, { recursive: true, mode: 0o700 }).catch(() => undefined);
  const { code, stdout } = await (opts.run ?? nodeRunCommand)('claude', [
    '-p', '/usage',
    '--no-session-persistence',
    '--allowed-tools', '',
    // 프로브 프로세스에서만 Remote Control 기동을 끈다(CodexBar 와 같은 이유 — 저장된 설정은 그대로).
    '--settings', '{"remoteControlAtStartup":false}',
  ], { env: { ...process.env, CLAUDE_CONFIG_DIR: opts.configDir }, cwd, timeoutMs: PROBE_TIMEOUT_MS });
  if (code === null) return { ...base, error: 'cli-unavailable' };
  const parsed = parseClaudeUsageText(stdout, opts.now);
  if (!parsed) return { ...base, error: 'cli-unparsed' };
  return { fetchedAtMs: opts.now, ...parsed };
}

// ── Codex `app-server` ──────────────────────────────────────────────────────────

/** JSON-RPC 한 줄씩 주고받는 자식의 우리가 쓰는 표면(테스트가 가짜를 끼운다). */
export interface RpcChild {
  stdin: { write(s: string): unknown; end(): unknown } | null;
  stdout: { on(ev: 'data', cb: (chunk: Buffer) => void): unknown } | null;
  on(ev: 'exit' | 'error', cb: (...a: unknown[]) => void): unknown;
  kill(signal?: NodeJS.Signals | number): boolean;
}

export type SpawnRpc = (codexHome: string, cwd: string) => RpcChild;

const nodeSpawnRpc: SpawnRpc = (codexHome, cwd) =>
  spawn('codex', ['-s', 'read-only', '-a', 'never', 'app-server'], {
    env: { ...process.env, CODEX_HOME: codexHome },
    cwd,
    stdio: ['pipe', 'pipe', 'ignore'],
  }) as unknown as RpcChild;

function codexRpcWindow(raw: unknown): ProviderUsageWindow | null {
  const o = typeof raw === 'object' && raw !== null ? (raw as Record<string, unknown>) : null;
  const used = typeof o?.usedPercent === 'number' ? o.usedPercent : null;
  if (!o || used === null) return null;
  const at = typeof o.resetsAt === 'number' ? o.resetsAt * 1000 : null;
  const mins = typeof o.windowDurationMins === 'number' ? o.windowDurationMins : null;
  return {
    usedPercent: Math.max(0, Math.min(100, used)),
    resetsAtMs: at,
    ...(mins !== null ? { windowMinutes: mins } : {}),
  };
}

export function parseCodexRateLimits(result: unknown): Pick<UsageResult, 'session' | 'weekly' | 'plan'> | null {
  const rl = (result as { rateLimits?: Record<string, unknown> } | null)?.rateLimits;
  if (!rl) return null;
  const session = codexRpcWindow(rl.primary);
  const weekly = codexRpcWindow(rl.secondary);
  if (!session && !weekly) return null;
  return { session, weekly, ...(typeof rl.planType === 'string' ? { plan: rl.planType } : {}) };
}

export async function codexCliUsage(opts: {
  codexHome: string;
  now: number;
  spawnRpc?: SpawnRpc;
  probeDir?: string;
  timeoutMs?: number;
}): Promise<UsageResult> {
  const base = { fetchedAtMs: opts.now, session: null, weekly: null };
  const cwd = opts.probeDir ?? usageProbeDir();
  await mkdir(cwd, { recursive: true, mode: 0o700 }).catch(() => undefined);
  let child: RpcChild;
  try {
    child = (opts.spawnRpc ?? nodeSpawnRpc)(opts.codexHome, cwd);
  } catch {
    return { ...base, error: 'cli-unavailable' };
  }
  return new Promise<UsageResult>((resolve) => {
    let buf = '';
    let done = false;
    const finish = (r: UsageResult): void => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      try { child.stdin?.end(); } catch { /* 이미 닫혔다 */ }
      try { child.kill('SIGTERM'); } catch { /* 이미 끝났다 */ }
      resolve(r);
    };
    const timer = setTimeout(() => finish({ ...base, error: 'timeout' }), opts.timeoutMs ?? PROBE_TIMEOUT_MS);
    const send = (o: unknown): void => { try { child.stdin?.write(`${JSON.stringify(o)}\n`); } catch { /* exit 가 끝낸다 */ } };
    child.on('error', () => finish({ ...base, error: 'cli-unavailable' }));
    child.on('exit', () => finish({ ...base, error: 'cli-unavailable' }));
    child.stdout?.on('data', (chunk: Buffer) => {
      buf += chunk.toString('utf8');
      let nl: number;
      while ((nl = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, nl);
        buf = buf.slice(nl + 1);
        let msg: { id?: unknown; result?: unknown; error?: unknown };
        try { msg = JSON.parse(line); } catch { continue; }
        if (msg.id === 1) {
          send({ method: 'initialized' });
          send({ id: 2, method: 'account/rateLimits/read', params: null });
        } else if (msg.id === 2) {
          // 에러 본문은 싣지 않는다 — 무엇이 들어 있을지 모른다.
          if (msg.error) { finish({ ...base, error: 'cli-error' }); return; }
          const parsed = parseCodexRateLimits(msg.result);
          finish(parsed ? { fetchedAtMs: opts.now, ...parsed } : { ...base, error: 'cli-unparsed' });
        }
      }
    });
    send({ id: 1, method: 'initialize', params: { clientInfo: { name: 'harkroom', version: '0' } } });
  });
}
