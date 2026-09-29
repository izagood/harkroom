// 공급자 API 를 **직접** 불러 읽는 계정별 한도 사용률(2026-09-28, 2단계). CLI 경로(`cliUsage.ts`)가
// 실패했을 때 받쳐 주는 자리다(`usageChain.ts`). `claudeUsage.ts` 의 로컬 추정과 따로 둔다 — 저것은
// 트랜스크립트를 세는 관측이고, 이것은 공급자가 스스로 말하는 % 다.
//
// ## 엔드포인트 — CLI 가 안에서 부르는 바로 그것이다
//
// - Claude: `GET https://api.anthropic.com/api/oauth/usage` (OAuth 토큰, `anthropic-beta: oauth-2025-04-20`)
//   → `five_hour`·`seven_day`·`seven_day_opus`·`seven_day_sonnet` 마다 `utilization`(0–100)·`resets_at`.
// - Codex: `GET https://chatgpt.com/backend-api/wham/usage` (`auth.json` 의 access_token + account id)
//   → `rate_limit.primary_window`(세션)·`secondary_window`(주간) 마다 `used_percent`·`reset_at`.
//
// 둘 다 공급자의 1st-party 엔드포인트다 — `claude` 의 `/usage` 와 codex 의 `account/rateLimits/read` 가
// 각각 이것을 부른다(근거는 `usageChain.ts` 머리 표). CodexBar(github.com/steipete/CodexBar)도 같은 경로를
// 쓴다. 서드파티용 문서가 없어 응답 모양이 바뀔 수 있으므로, 바뀌면 던지지 않고 그 계정에 `error` 를 싣는다.
//
// Keychain 단서(2026-09-28): 토큰 파일이 없으면 macOS Keychain 을 `security` 로 읽는다. 이때 허용 창이
// 뜨는지는 **실측하지 못했다.** 실사용에서 뜨면 Claude 폴백을 `.credentials.json` 파일로 한정한다.
//
// ## 토큰을 다루는 규율
//
// - **읽기만 한다.** 만료된 토큰을 갱신하지 않는다 — 갱신은 refresh 토큰을 소비하고 새 토큰을
//   파일/Keychain 에 **써야** 하는데, 그 파일의 주인은 CLI 다. 두 writer 가 같은 refresh 토큰을
//   쓰면 한쪽이 무효가 된다. 만료면 "다음 턴이 갱신한다"는 사실만 싣는다.
// - 토큰은 이 파일의 함수 인자 밖으로 나가지 않는다. 결과·에러 문자열·로그에 싣지 않는다.
import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';

import type { ProviderAccountUsage, ProviderUsageWindow } from '@harkroom/shared/daemonProtocol';

export const CLAUDE_OAUTH_USAGE_URL = 'https://api.anthropic.com/api/oauth/usage';
export const CODEX_WHAM_USAGE_URL = 'https://chatgpt.com/backend-api/wham/usage';

/** 요청 하나의 상한. 화면이 폴링하므로 매달리면 다음 폴과 겹친다. */
const FETCH_TIMEOUT_MS = 10_000;

export type FetchLike = (url: string, init: { headers: Record<string, string>; signal?: AbortSignal }) =>
  Promise<{ ok: boolean; status: number; json(): Promise<unknown> }>;

const obj = (v: unknown): Record<string, unknown> | null =>
  typeof v === 'object' && v !== null ? (v as Record<string, unknown>) : null;
const num = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) ? v : null);

function clampPercent(p: number): number {
  return Math.max(0, Math.min(100, p));
}

async function getJson(fetchImpl: FetchLike, url: string, headers: Record<string, string>): Promise<unknown> {
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), FETCH_TIMEOUT_MS);
  try {
    const res = await fetchImpl(url, { headers, signal: ctl.signal });
    // 상태 코드만 싣는다 — 본문에는 무엇이 들어 있을지 모른다.
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return await res.json();
  } finally {
    clearTimeout(timer);
  }
}

// ── Claude ─────────────────────────────────────────────────────────────────────

export interface ClaudeOAuthToken {
  accessToken: string;
  /** epoch ms. 없으면 모른다. */
  expiresAtMs: number | null;
}

function parseClaudeCredentials(raw: unknown): ClaudeOAuthToken | null {
  const o = obj(obj(raw)?.claudeAiOauth);
  const accessToken = o?.accessToken;
  if (typeof accessToken !== 'string' || accessToken.length === 0) return null;
  return { accessToken, expiresAtMs: num(o?.expiresAt) };
}

/** `claudeAccounts.ts::keychainService` 와 같은 규칙(실측): `Claude Code-credentials-<sha256(dir) 앞 8자>`. */
function claudeKeychainService(configDir: string): string {
  return `Claude Code-credentials-${createHash('sha256').update(configDir).digest('hex').slice(0, 8)}`;
}

/**
 * 기본 토큰 읽기. 파일(`.credentials.json`)이 먼저, 없으면 macOS Keychain.
 *
 * Keychain 항목은 claude CLI 가 `/usr/bin/security` 로 쓴 것이라 같은 도구로 읽는다. **값이
 * 이 프로세스를 지나는 유일한 자리**이고, 그래서 CLI 경로가 실패했을 때만 불린다(`usageChain.ts`).
 */
export async function nodeReadClaudeToken(configDir: string): Promise<ClaudeOAuthToken | null> {
  try {
    const t = parseClaudeCredentials(JSON.parse(await readFile(join(configDir, '.credentials.json'), 'utf8')));
    if (t) return t;
  } catch { /* 파일이 없다 — Keychain 으로 */ }
  if (process.platform !== 'darwin') return null;
  const out = await new Promise<string | null>((res) => {
    execFile(
      'security',
      ['find-generic-password', '-s', claudeKeychainService(configDir), '-a', process.env.USER ?? '', '-w'],
      { timeout: 10_000 },
      (err, stdout) => res(err ? null : String(stdout)),
    );
  });
  if (!out) return null;
  try {
    return parseClaudeCredentials(JSON.parse(out));
  } catch {
    return null;
  }
}

function claudeWindow(raw: unknown): ProviderUsageWindow | null {
  const o = obj(raw);
  const u = num(o?.utilization);
  if (!o || u === null) return null;
  const resets = typeof o.resets_at === 'string' ? Date.parse(o.resets_at) : NaN;
  return { usedPercent: clampPercent(u), resetsAtMs: Number.isFinite(resets) ? resets : null };
}

/** 응답을 우리 모양으로. 모르는 모양이면 `null` 창들이 된다(던지지 않는다). */
export function parseClaudeOAuthUsage(raw: unknown): Pick<ProviderAccountUsage, 'session' | 'weekly' | 'extra'> {
  const o = obj(raw) ?? {};
  const extra: NonNullable<ProviderAccountUsage['extra']> = [];
  for (const [key, label] of [['seven_day_opus', 'Opus weekly'], ['seven_day_sonnet', 'Sonnet weekly']] as const) {
    const w = claudeWindow(o[key]);
    if (w) extra.push({ label, window: w });
  }
  return { session: claudeWindow(o.five_hour), weekly: claudeWindow(o.seven_day), extra };
}

export async function fetchClaudeProviderUsage(opts: {
  configDir: string;
  now: number;
  fetchImpl: FetchLike;
  readToken?: (configDir: string) => Promise<ClaudeOAuthToken | null>;
}): Promise<Omit<ProviderAccountUsage, 'account' | 'pool'>> {
  const base = { fetchedAtMs: opts.now, session: null, weekly: null };
  const token = await (opts.readToken ?? nodeReadClaudeToken)(opts.configDir).catch(() => null);
  if (!token) return { ...base, error: 'no-credentials' };
  if (token.expiresAtMs !== null && token.expiresAtMs <= opts.now) return { ...base, error: 'token-expired' };
  try {
    const raw = await getJson(opts.fetchImpl, CLAUDE_OAUTH_USAGE_URL, {
      Authorization: `Bearer ${token.accessToken}`,
      'anthropic-beta': 'oauth-2025-04-20',
      Accept: 'application/json',
    });
    return { fetchedAtMs: opts.now, ...parseClaudeOAuthUsage(raw) };
  } catch (err) {
    return { ...base, error: errorLabel(err) };
  }
}

// ── Codex ──────────────────────────────────────────────────────────────────────

export interface CodexToken {
  accessToken: string;
  accountId: string | null;
}

export async function nodeReadCodexToken(codexHome: string): Promise<CodexToken | null> {
  try {
    const tokens = obj(obj(JSON.parse(await readFile(join(codexHome, 'auth.json'), 'utf8')))?.tokens);
    const accessToken = tokens?.access_token;
    if (typeof accessToken !== 'string' || accessToken.length === 0) return null;
    return { accessToken, accountId: typeof tokens?.account_id === 'string' ? tokens.account_id : null };
  } catch {
    return null;
  }
}

function codexWindow(raw: unknown, now: number): ProviderUsageWindow | null {
  const o = obj(raw);
  const used = num(o?.used_percent);
  if (!o || used === null) return null;
  // `reset_at`(epoch 초)이 먼저, 없으면 `reset_after_seconds`(지금부터). 판본마다 갈린다.
  const at = num(o.reset_at);
  const after = num(o.reset_after_seconds);
  const resetsAtMs = at !== null ? at * 1000 : after !== null ? now + after * 1000 : null;
  const secs = num(o.limit_window_seconds);
  return {
    usedPercent: clampPercent(used),
    resetsAtMs,
    ...(secs !== null ? { windowMinutes: Math.round(secs / 60) } : {}),
  };
}

export function parseCodexWhamUsage(raw: unknown, now: number): Pick<ProviderAccountUsage, 'session' | 'weekly' | 'plan'> {
  const o = obj(raw) ?? {};
  const rl = obj(o.rate_limit) ?? {};
  return {
    session: codexWindow(rl.primary_window, now),
    weekly: codexWindow(rl.secondary_window, now),
    ...(typeof o.plan_type === 'string' ? { plan: o.plan_type } : {}),
  };
}

export async function fetchCodexProviderUsage(opts: {
  codexHome: string;
  now: number;
  fetchImpl: FetchLike;
  readToken?: (codexHome: string) => Promise<CodexToken | null>;
}): Promise<Omit<ProviderAccountUsage, 'account' | 'pool'>> {
  const base = { fetchedAtMs: opts.now, session: null, weekly: null };
  const token = await (opts.readToken ?? nodeReadCodexToken)(opts.codexHome).catch(() => null);
  if (!token) return { ...base, error: 'no-credentials' };
  try {
    const raw = await getJson(opts.fetchImpl, CODEX_WHAM_USAGE_URL, {
      Authorization: `Bearer ${token.accessToken}`,
      ...(token.accountId ? { 'ChatGPT-Account-Id': token.accountId } : {}),
      Accept: 'application/json',
    });
    return { fetchedAtMs: opts.now, ...parseCodexWhamUsage(raw, opts.now) };
  } catch (err) {
    return { ...base, error: errorLabel(err) };
  }
}

/**
 * 에러를 **짧은 꼬리표**로. 메시지를 그대로 싣지 않는 이유: fetch 에러 문자열에는 URL·헤더가
 * 섞일 수 있고, 화면은 이 값을 i18n 키로 고른다.
 */
function errorLabel(err: unknown): string {
  const m = err instanceof Error ? err.message : '';
  if (/^HTTP 401|^HTTP 403/.test(m)) return 'unauthorized';
  if (/^HTTP \d+/.test(m)) return m.replace(/^HTTP /, 'http-');
  if (err instanceof Error && err.name === 'AbortError') return 'timeout';
  return 'network';
}
