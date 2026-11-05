// 화면으로 끝을 아는 하네스에서 **차례가 정말 끝났는지 기록으로 확정한다**(2026-11-05 소유자 결정).
//
// codex 는 모델이 글을 낸 뒤 다음 응답을 기다리는 동안 일하는 중 표지를 지운다(0.154.0 실측: 턴 도중 3초 넘게 입력창만 보였다).
// 화면만 믿으면 일하는 턴을 거둔다. 화면은 언제 물어볼지만 정하고, 끝은 기록이 정한다. 못 읽으면 `null` — 호출자는 화면 판정으로 돌아간다.
//
// 어댑터 `transcript.parsed` 는 false 그대로다 — 이 파일은 차례 표지만 읽고, 정지·API 에러 탐침을 켜지 않는다(`adapters/codex.ts`).
import { open, stat } from 'node:fs/promises';
import type { AgentHarness } from '@harkroom/shared';
import { turnEndRecordOf } from './adapters/index.js';
import { codexRolloutFileFor, findCodexSessionId } from './codexSessions.js';

export type RecordedTurnEnd = 'working' | 'ended';

/** 긴 턴의 기록은 크다. 차례 표지는 끝쪽에 있으므로 이만큼만 읽는다. 못 찾으면 `null` 이고 화면 판정으로 돌아간다. */
const ROLLOUT_TAIL_BYTES = 1024 * 1024;

/**
 * rollout 의 마지막 차례 표지. `task_started` 뒤에 `task_complete`·`turn_aborted` 가 없으면 아직 일하는 중이다.
 * `sinceMs` 앞의 표지는 이 차례의 것이 아니다(되살린 세션은 앞 턴의 끝으로 끝나 있다) — `null`.
 */
export function turnEndFromCodexRollout(text: string, sinceMs: number): RecordedTurnEnd | null {
  const lines = text.split('\n');
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i]!.trim();
    if (!line) continue;
    let rec: { type?: unknown; timestamp?: unknown; payload?: { type?: unknown } };
    try {
      rec = JSON.parse(line) as typeof rec;
    } catch {
      continue;
    }
    if (rec.type !== 'event_msg') continue;
    const kind = rec.payload?.type;
    if (kind !== 'task_started' && kind !== 'task_complete' && kind !== 'turn_aborted') continue;
    const at = typeof rec.timestamp === 'string' ? Date.parse(rec.timestamp) : Number.NaN;
    if (!Number.isFinite(at) || at < sinceMs) return null;
    return kind === 'task_started' ? 'working' : 'ended';
  }
  return null;
}

async function readTail(path: string): Promise<string> {
  const { size } = await stat(path);
  const handle = await open(path, 'r');
  try {
    const length = Math.min(size, ROLLOUT_TAIL_BYTES);
    const buffer = Buffer.alloc(length);
    await handle.read(buffer, 0, length, size - length);
    return buffer.toString('utf8');
  } finally {
    await handle.close();
  }
}

export interface HarnessTurnEndOpts {
  /** 첫 턴은 아직 모른다 — `cwd` 로 찾는다(`findCodexSessionId`). */
  sessionId: string | null;
  cwd: string;
  sinceMs: number;
  codexSessionsDir: string;
}

/** 기록이 말하는 차례 상태. **던지지 않는다** — 읽을 기록이 없거나 못 읽으면 `null`. */
export async function readHarnessTurnEnd(harness: AgentHarness, opts: HarnessTurnEndOpts): Promise<RecordedTurnEnd | null> {
  try {
    if (turnEndRecordOf(harness) !== 'codex-rollout') return null;
    const id = opts.sessionId ?? await findCodexSessionId(opts.codexSessionsDir, { cwd: opts.cwd, sinceMs: opts.sinceMs });
    if (!id) return null;
    const file = await codexRolloutFileFor(opts.codexSessionsDir, id);
    return file ? turnEndFromCodexRollout(await readTail(file), opts.sinceMs) : null;
  } catch {
    return null;
  }
}
