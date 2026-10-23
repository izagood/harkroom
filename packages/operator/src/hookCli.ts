/**
 * `harkroom-operator hook pretool` 의 판단 부분(H③b) — 프로세스·소켓 밖에서 시험할 수 있게 뗐다. `main.ts::hookMain` 이 부른다.
 *
 * 받는 것: claude PreToolUse hook 입력(stdin JSON — `tool_name`·`tool_input.command`·`tool_use_id`·`cwd`).
 * 내는 것: 승인된 정확한 명령이면 allow 결정 객체, 그 밖은 `null`(= 무출력 → claude 의 auto 분류기가 평소대로 판정).
 * 오퍼레이터에 묻기 전에 shared `validateExactCommand` 로 먼저 거른다 — 셸 이어 붙이기·허용 목록 밖이면 소켓도 열지 않는다.
 */
import type { Readable } from 'node:stream';
import { validateExactCommand } from '@harkroom/shared';
import { LANE_HOOK_TOOLS } from '@harkroom/shared/providerLane';
import { COMMAND_CHECK_TOOL } from './turnCommand.js';

export const HOOK_TIMEOUT_MS = 10_000;
export const HOOK_STDIN_MAX = 256 * 1024;

export type HookDecision = { hookSpecificOutput: { hookEventName: 'PreToolUse'; permissionDecision: 'allow'; permissionDecisionReason: string } };
type Ask = (name: string, args: Record<string, unknown>) => Promise<{ ok: boolean; text: string } | { ok: false; notInTurn: true }>;

export async function readStdinCapped(stream: Readable, max: number): Promise<string> {
  let size = 0;
  const chunks: Buffer[] = [];
  for await (const chunk of stream) {
    const b = Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk));
    size += b.length;
    if (size > max) throw new Error('hook input too large');
    chunks.push(b);
  }
  return Buffer.concat(chunks).toString('utf8');
}

export async function decideHook(raw: string, ask: Ask): Promise<HookDecision | null> {
  let input: { tool_name?: unknown; tool_input?: { command?: unknown }; tool_use_id?: unknown; cwd?: unknown };
  try { input = JSON.parse(raw) as typeof input; } catch { return null; }
  if (input.tool_name !== 'Bash' || typeof input.tool_input?.command !== 'string') return null;
  const v = validateExactCommand(input.tool_input.command);
  if (!v.ok) return null;
  const r = await ask(COMMAND_CHECK_TOOL, {
    command: v.command,
    ...(typeof input.cwd === 'string' ? { cwd: input.cwd } : {}),
    ...(typeof input.tool_use_id === 'string' ? { toolUseId: input.tool_use_id } : {}),
  }).catch(() => null);
  if (!r || !r.ok || 'notInTurn' in r) return null;
  let out: { allow?: unknown; grantId?: unknown };
  try { out = JSON.parse(r.text) as typeof out; } catch { return null; }
  if (out.allow !== true || typeof out.grantId !== 'string') return null;
  return { hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'allow', permissionDecisionReason: `harkroom: owner-approved exact command (grant ${out.grantId.slice(0, 8)})` } };
}

export type LaneDenyDecision = { hookSpecificOutput: { hookEventName: 'PreToolUse'; permissionDecision: 'deny'; permissionDecisionReason: string } };

/** 거절 이유 — 모델에 그대로 간다(실측). 무엇을 하면 열리는지 한 줄로 말한다. 규칙 예는 **명령 전체**다(security S4). */
export const LANE_HOOK_DENY_REASON =
  'harkroom: this API-key agent may only use owner-approved tools. Ask with the harkroom permission.request tool (kind "tool") for this exact use, e.g. Bash(<the exact full command>); once approved it opens from the next turn.';

export function laneDeny(reason = LANE_HOOK_DENY_REASON): LaneDenyDecision {
  return { hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'deny', permissionDecisionReason: reason } };
}

/** 셸이 명령을 이어 붙이거나 바꿔 넣는 글자. 하나라도 있으면 규칙과 맞춰 보지 않는다 — 규칙 판정보다 **좁게** 틀린다. */
const SHELL_META = /[;&|`$<>(){}\\\n\r]/;

/** dontAsk 가 규칙 없이 작업 폴더 안에서만 여는 읽기 도구 — hook 은 판정하지 않고 하네스에 맡긴다(밖은 하네스가 거절한다, 실측). */
const HARNESS_SCOPED = new Set(['Read']);

/**
 * 승인된 셸 규칙에 맞는가 — claude 의 판정보다 **좁다**. `Bash(<접두>:*)` 는 같은 명령이거나 접두 + 공백으로 시작할 때,
 * `Bash(<명령>)` 은 같을 때만. 셸 이어 붙이기·바꿔 넣기 글자가 있으면 맞지 않는다.
 */
export function laneBashAllowed(rules: readonly string[], command: unknown): boolean {
  const cmd = typeof command === 'string' ? command.trim() : '';
  if (!cmd || SHELL_META.test(cmd)) return false;
  for (const rule of rules) {
    const m = /^Bash\((.+)\)$/s.exec(rule);
    if (!m) continue;
    const inner = (m[1] ?? '').trim();
    if (inner.endsWith(':*')) {
      const prefix = inner.slice(0, -2).trim();
      if (prefix && (cmd === prefix || cmd.startsWith(`${prefix} `))) return true;
    } else if (cmd === inner) {
      return true;
    }
  }
  return false;
}

/** 셸이 아닌 도구가 허용 목록·승인 규칙에 이름으로 있는가. 웹 도구는 맨 이름 규칙만 받는다(범위가 붙은 규칙은 하위 에이전트에서 지켜지는지 모른다). */
export function laneToolListed(rules: readonly string[], tool: string): boolean {
  if (HARNESS_SCOPED.has(tool)) return true;
  if ((LANE_HOOK_TOOLS as readonly string[]).includes(tool)) return rules.includes(tool);
  for (const rule of rules) {
    const name = rule.replace(/\(.*$/s, '');
    if (name === tool) return true;
    if (name.startsWith('mcp__') && name.split('__').length === 2 && tool.startsWith(`${name}__`)) return true;
  }
  return false;
}

/**
 * API 키 연결 턴의 판정(D1, security S1·S2). matcher `*` 라 모든 도구가 온다. hook 은 **allow 를 내지 않는다** — 결정 없음(하네스의
 * `--allowedTools`·경로 규칙이 판정)이거나 deny 둘뿐이다. 그래서 hook 이 틀려도 하네스 판정에서 다시 막힌다.
 * - 셸: 승인 규칙에 (좁게) 맞으면 결정 없음, 아니면 deny
 * - 그 밖: 허용 목록·승인 규칙에 이름이 있으면 결정 없음, 없으면 deny(하네스의 dontAsk 판정과 겹으로 막는다)
 * - 입력을 못 읽으면 deny. LLM 판정은 없다.
 */
export function decideLaneHook(raw: string, rules: readonly string[]): LaneDenyDecision | null {
  let input: { tool_name?: unknown; tool_input?: { command?: unknown } };
  try { input = JSON.parse(raw) as typeof input; } catch { return laneDeny(); }
  const tool = typeof input.tool_name === 'string' ? input.tool_name : '';
  if (!tool) return laneDeny();
  if (tool === 'Bash') return laneBashAllowed(rules, input.tool_input?.command) ? null : laneDeny();
  return laneToolListed(rules, tool) ? null : laneDeny();
}
