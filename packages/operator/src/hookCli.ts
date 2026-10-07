/**
 * `harkroom-operator hook pretool` 의 판단 부분(H③b) — 프로세스·소켓 밖에서 시험할 수 있게 뗐다. `main.ts::hookMain` 이 부른다.
 *
 * 받는 것: claude PreToolUse hook 입력(stdin JSON — `tool_name`·`tool_input.command`·`tool_use_id`·`cwd`).
 * 내는 것: 승인된 정확한 명령이면 allow 결정 객체, 그 밖은 `null`(= 무출력 → claude 의 auto 분류기가 평소대로 판정).
 * 오퍼레이터에 묻기 전에 shared `validateExactCommand` 로 먼저 거른다 — 셸 이어 붙이기·허용 목록 밖이면 소켓도 열지 않는다.
 */
import type { Readable } from 'node:stream';
import { validateExactCommand } from '@harkroom/shared';
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
