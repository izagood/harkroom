// 화면으로 끝을 아는 하네스에서 **마지막 말을 기록에서 읽는다**(2026-11-04 소유자 결정).
//
// API 키 연결 모델은 답을 최종 메시지로만 쓰고 끝내는 일이 잦다. 러너는 그 답을 대신 올리는데, 화면에서 옮기면 터미널 높이를 넘는 부분이
// 빠지고 테두리·줄바꿈 찌꺼기가 남는다. 그래서 끝말만 원문으로 읽어 claude 와 같은 길(`proxyRecordAnswerBody`)로 옮긴다.
//
// **끝 판정에는 쓰지 않는다.** 어댑터 `transcript.parsed` 는 false 그대로다 — 그 값이 참이면 정지·API 에러 탐침이 켜지고, 틀린 「읽었다」 신호가
// 끝을 감지하는 다른 장치를 가린다(`adapters/codex.ts`). 여기서 못 읽으면 `null` 이고 호출자는 화면 답으로 돌아간다.
import { execFile } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { promisify } from 'node:util';
import { lastSaidRecordOf } from './adapters/index.js';
import type { AgentHarness } from '@harkroom/shared';
import { codexRolloutFileFor } from './codexSessions.js';
import { findOpencodeSessionId } from './opencodeSessions.js';

const run = promisify(execFile);

/**
 * rollout 의 마지막 assistant 글(`response_item` · `message`). 그 뒤에 도구 호출이 있으면 끝말이 아니다 — 호출 앞의 혼잣말을 답으로 옮기지 않는다.
 * `sinceMs` 앞의 기록은 이 턴의 것이 아니다(되살린 세션은 앞 턴의 말로 끝나 있다).
 */
export function lastSaidFromCodexRollout(text: string, sinceMs: number): string | null {
  const lines = text.split('\n');
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i]!.trim();
    if (!line) continue;
    let rec: { type?: unknown; timestamp?: unknown; payload?: { type?: unknown; role?: unknown; content?: unknown } };
    try {
      rec = JSON.parse(line) as typeof rec;
    } catch {
      continue;
    }
    if (rec.type !== 'response_item') continue;
    const at = typeof rec.timestamp === 'string' ? Date.parse(rec.timestamp) : Number.NaN;
    if (!Number.isFinite(at) || at < sinceMs) return null;
    const kind = rec.payload?.type;
    if (kind === 'function_call' || kind === 'custom_tool_call') return null;
    if (kind !== 'message' || rec.payload?.role !== 'assistant' || !Array.isArray(rec.payload.content)) continue;
    const said = (rec.payload.content as { type?: unknown; text?: unknown }[])
      .filter((c) => c.type === 'output_text' && typeof c.text === 'string')
      .map((c) => c.text as string).join('\n').trim();
    return said || null;
  }
  return null;
}

interface ExportedMessage {
  info?: { role?: unknown; time?: { created?: unknown; completed?: unknown }; finish?: unknown };
  parts?: { type?: unknown; text?: unknown }[];
}

/** `opencode export` 의 마지막 메시지가 이 턴에 끝난 assistant 면 그 글(`opencodeTurnState.ts` 와 같은 판정). 아니면 `null`. */
export function lastSaidFromOpencodeExport(json: string, sinceMs: number): string | null {
  let messages: unknown;
  try {
    messages = (JSON.parse(json) as { messages?: unknown }).messages;
  } catch {
    return null;
  }
  if (!Array.isArray(messages) || messages.length === 0) return null;
  const last = messages[messages.length - 1] as ExportedMessage | null;
  const info = last?.info;
  if (!info || info.role !== 'assistant') return null;
  if (typeof info.time?.created !== 'number' || info.time.created < sinceMs) return null;
  if (typeof info.time.completed !== 'number') return null;
  if (typeof info.finish !== 'string' || info.finish === 'tool-calls') return null;
  if (!Array.isArray(last?.parts)) return null;
  const said = last.parts
    .filter((p) => p.type === 'text' && typeof p.text === 'string')
    .map((p) => p.text as string).join('\n').trim();
  return said || null;
}

export interface HarnessLastSaidOpts {
  sessionId: string | null;
  sinceMs: number;
  codexSessionsDir: string;
  opencode: { command: string; env: Record<string, string>; cwd: string };
}

/** 이 턴의 마지막 말. **던지지 않는다** — 읽을 수 없으면 `null` 이고 호출자는 화면 답으로 돌아간다. */
export async function readHarnessLastSaid(harness: AgentHarness, opts: HarnessLastSaidOpts): Promise<string | null> {
  try {
    const source = lastSaidRecordOf(harness);
    if (source === 'codex-rollout') {
      if (!opts.sessionId) return null;
      const file = await codexRolloutFileFor(opts.codexSessionsDir, opts.sessionId);
      return file ? lastSaidFromCodexRollout(await readFile(file, 'utf8'), opts.sinceMs) : null;
    }
    if (source === 'opencode-export') {
      const { command, env, cwd } = opts.opencode;
      const id = opts.sessionId ?? await findOpencodeSessionId({ command, env, cwd, sinceMs: opts.sinceMs });
      if (!id) return null;
      const res = await run(command, ['export', id], { env, cwd, timeout: 20_000, maxBuffer: 32 * 1024 * 1024 });
      return lastSaidFromOpencodeExport(res.stdout, opts.sinceMs);
    }
    return null;
  } catch {
    return null;
  }
}
