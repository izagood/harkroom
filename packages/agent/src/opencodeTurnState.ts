// opencode 턴이 **끝났는가**(2026-10-25, e2e R1).
//
// claude 는 기록 파일 꼬리의 `end_turn` 으로 끝을 안다(`harnessErrors.ts::readTranscriptTurnState`).
// opencode 는 그 기록을 우리가 읽지 않는다(어댑터 `transcript.parsed: false`) — 그래서 끝 판정이
// 없었고, 모델이 말 없이 `stop` 한 턴은 화면이 10분 멈춘 뒤 「하네스 정지 — 사람이 터미널을
// 봐야 한다」로 접혔다. 하네스는 이미 끝났는데 사람을 엉뚱한 자리로 보냈다.
//
// 세션 발견(`opencodeSessions.ts`)과 같은 원칙으로 **SQLite 를 직접 열지 않고 opencode 가 주는
// 표면에 묻는다**: `opencode export <id>` 는 `{ info, messages: [{ info, parts }] }` 를 낸다
// (실측 1.18.32). 마지막 메시지가 이 턴의 assistant 이고 `time.completed` 가 찍혔고 `finish` 가
// 도구 호출 대기(`tool-calls`)가 아니면 opencode 의 루프는 끝났다.
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { findOpencodeSessionId } from './opencodeSessions.js';

const run = promisify(execFile);

interface ExportedMessage {
  info?: { role?: unknown; time?: { created?: unknown; completed?: unknown }; finish?: unknown };
}

/**
 * `export` 출력에서 이 턴의 상태를 읽는다. `null` 은 **모른다**(형식이 다르다·메시지가 없다) —
 * 호출자는 모를 때 끝으로 치지 않는다.
 *
 * `sinceMs` 이전 메시지는 이 턴의 것이 아니다: 되살린 세션(`-s`)은 앞 턴의 `stop` 으로 끝나 있어,
 * 프롬프트가 들어가기 전에 읽으면 "이미 끝났다"가 된다(claude 쪽과 같은 함정).
 */
export function opencodeTurnStateFromExport(json: string, sinceMs: number): 'ended' | 'working' | null {
  let messages: unknown;
  try {
    messages = (JSON.parse(json) as { messages?: unknown }).messages;
  } catch {
    return null;
  }
  if (!Array.isArray(messages) || messages.length === 0) return null;
  const last = (messages[messages.length - 1] as ExportedMessage | null)?.info;
  if (!last || typeof last !== 'object') return null;
  const created = last.time?.created;
  if (typeof created !== 'number' || created < sinceMs) return 'working';
  if (last.role !== 'assistant') return 'working';
  if (typeof last.time?.completed !== 'number') return 'working';
  // `tool-calls` 는 도구 결과를 받아 다음 걸음을 이어 간다는 뜻이다 — 끝이 아니다.
  if (typeof last.finish !== 'string' || last.finish === 'tool-calls') return 'working';
  return 'ended';
}

/**
 * 이 턴의 opencode 세션이 끝났는가. 세션 id 를 모르면(첫 턴) 워크스페이스로 찾는다. **던지지
 * 않는다** — 명령 실패·형식 불일치는 `null`(모른다)이다.
 */
export async function readOpencodeTurnState(
  opts: { command: string; env: Record<string, string>; cwd: string; sessionId: string | null; sinceMs: number },
): Promise<'ended' | 'working' | null> {
  const id = opts.sessionId ?? await findOpencodeSessionId({
    command: opts.command, env: opts.env, cwd: opts.cwd, sinceMs: opts.sinceMs,
  });
  if (!id) return null;
  try {
    const res = await run(opts.command, ['export', id], {
      env: opts.env,
      // 세션 목록과 같은 이유로 턴의 워크스페이스에서 묻는다(`opencodeSessions.ts` 머리말).
      cwd: opts.cwd,
      timeout: 20_000,
      maxBuffer: 32 * 1024 * 1024,
    });
    return opencodeTurnStateFromExport(res.stdout, opts.sinceMs);
  } catch {
    return null;
  }
}
