// 하네스가 **자기 입으로** 낸 API 에러를 디스크에서 읽는다.
//
// **왜 tail 이 아닌가.** 지금 실패 분류(`policy.ts`)는 PTY 출력의 끝 2KB 링(tail) 문자열을
// 본다. 그 재료에는 결함이 둘 있다:
//   ① 앞이 잘린다 — 2026-09-07 19:03 사건에서 세션 파일에는 `resets 10:50pm (Asia/Seoul)` 이
//      있었는데 tail 판정은 "풀림: 알 수 없음"을 찍었다(`policy.ts::isQuotaExhausted` 주석).
//   ② 사람이 넣은 프롬프트가 섞일 수 있다 — PTY 는 입력을 그대로 에코한다(#380 2단계 실측,
//      `pty.ts::composeSpawn` 주석). 그러면 본문에 `authentication_error` 를 적어 넣은 사람이
//      그 러너를 78 로 물러나게 할 수 있고, 그 러너가 맡은 모든 스레드가 함께 죽는다.
// 세션 JSONL 의 레코드에는 `isApiErrorMessage: true` 라는 **명시적 플래그**가 붙고 내용은
// 하네스 자신의 문구라, 결함 둘이 다 없다.
//
// **이것은 하네스 출력 파싱이 아니다.** `claudeSessions.ts`(세션 파일 실재)·`codexSessions.ts`
// (rollout 발견)가 세운 것과 같은 "디스크의 사실 관측"이고, 그 파일들이 적어 둔 것과 같은
// 이유로 러너의 파싱 금지 원칙에 어긋나지 않는다.
import { readFile, stat } from 'node:fs/promises';
import type { AgentHarness } from '@harkroom/shared';

import { readsSessionTranscript } from './adapters/index.js';
import { claudeSessionFilePath } from './claudeSessions.js';

export interface HarnessApiError {
  /** 하네스가 낸 에러 문구 원문. 여기서 해석하지 않는다 — 판정은 `policy.ts` 가 한다. */
  text: string;
}

/** 레코드 하나에서 사람이 읽는 텍스트를 뽑는다. `content` 는 배열이거나 문자열이다. */
function textOf(record: { message?: { content?: unknown } }): string | null {
  const content = record.message?.content;
  if (typeof content === 'string') return content.trim() || null;
  if (!Array.isArray(content)) return null;
  const joined = content
    .map((part) => (part && typeof part === 'object' && typeof (part as { text?: unknown }).text === 'string'
      ? (part as { text: string }).text
      : ''))
    .join('')
    .trim();
  return joined || null;
}

/**
 * 이 세션에서 하네스가 **마지막으로** 낸 API 에러. 없으면 `null`.
 *
 * 마지막을 고르는 이유: 세션 파일은 그 스레드의 전체 이력이라 앞 턴의 에러도 남아 있다.
 * 지금 실패한 턴의 사실은 그중 가장 뒤에 있다.
 *
 * **던지지 않는다.** 이 값은 실패 분류를 더 좋게 만드는 재료이지 턴의 성패가 아니다 —
 * 파일을 못 읽었다고 예외를 올리면 원래 하려던 실패 처리(통지·재시도 회계)까지 함께
 * 무너진다. 못 읽으면 호출자는 기존 tail 판정으로 그대로 간다.
 */
export async function readLastApiError(
  harness: AgentHarness,
  sessionId: string | null,
  opts: {
    projectsDir?: string;
    configDir?: string | null;
    /**
     * 이 시각(ms) **이후**의 에러만 읽는다(2026-09-09). 없으면 지금까지처럼 마지막을 읽는다.
     *
     * **턴이 도는 동안** 이 파일을 볼 때 필요하다: 세션 파일은 그 스레드의 전체 이력이라
     * 앞 턴의 한도 에러가 그대로 남아 있고, 그것을 지금 턴의 것으로 읽으면 멀쩡한 계정을
     * 버리고 축을 헛돈다. 시각을 모르는 레코드(타임스탬프 없음)는 **세지 않는다** —
     * 없는 것을 있다고 읽지 않는다.
     */
    sinceMs?: number;
  } = {},
): Promise<HarnessApiError | null> {
  // 기록을 읽을 줄 모르는 하네스는 여기서 멈춘다. 억지로 읽으면 "읽었다"는 거짓 신호가
  // 생기고, 그것이 아직 정상 동작하는 tail 폴백을 가린다. 판단은 어댑터가 한다.
  if (!readsSessionTranscript(harness)) return null;
  if (!sessionId) return null;

  const path = await claudeSessionFilePath(sessionId, opts);
  if (!path) return null;

  let raw: string;
  try {
    raw = await readFile(path, 'utf8');
  } catch {
    return null;
  }

  let last: string | null = null;
  for (const line of raw.split('\n')) {
    // 값싼 사전 거르기 — 세션 파일은 수 MB 가 되기도 하고 그 대부분은 이 필드가 없다.
    if (!line.includes('isApiErrorMessage')) continue;
    let record: { isApiErrorMessage?: unknown; timestamp?: unknown; message?: { content?: unknown } };
    try {
      record = JSON.parse(line);
    } catch {
      continue; // 깨진 줄 하나가 나머지 탐색을 막지 않는다
    }
    if (record.isApiErrorMessage !== true) continue;
    if (opts.sinceMs !== undefined) {
      const at = typeof record.timestamp === 'string' ? Date.parse(record.timestamp) : NaN;
      if (!Number.isFinite(at) || at < opts.sinceMs) continue;
    }
    const text = textOf(record);
    if (text) last = text;
  }
  return last === null ? null : { text: last };
}


/**
 * 이 세션의 기록 파일이 **마지막으로 자란 시각**(ms). 파일이 없으면 `null`.
 *
 * 무엇을 재는가: "하네스가 아직 살아서 일하는가". claude 는 어시스턴트 메시지·도구
 * 호출·도구 결과를 한 줄씩 이 파일에 덧붙이므로, 일하는 턴에서는 이 시각이 계속 앞으로
 * 간다. 멈춘 턴에서는 멈춘다.
 *
 * **왜 이 신호인가**(2026-09-09 실측). 한 턴이 첨부를 받은 직후 30분을 아무것도 안 하고
 * 서 있다가 무발화 한도에 걸려 죽었다. 그 세션의 회계가 원인을 못 박는다 —
 * `totalDuration 1,800,002ms` 인데 `totalAPIDuration` 은 **12,945ms**, 재시도는 0건.
 * 일하느라 조용했던 것이 아니라 아무 요청도 안 낸 채 서 있었다. 그런데 러너가 가진
 * 신호는 "답했는가" 하나뿐이라, 일하는 턴과 멈춘 턴이 30분 동안 똑같아 보였다.
 *
 * PTY 출력을 안 쓰는 이유는 `readLastApiError` 머리와 같다 — TUI 는 스피너만으로도
 * 바이트를 내므로 "살아 있음"의 증거가 되지 못하고, 사람이 친 입력이 그대로 에코된다.
 *
 * **던지지 않는다.** 이 값은 턴을 일찍 접기 위한 재료이지 턴의 성패가 아니다. 못 읽으면
 * `null` 이고, 호출자는 그때 판정을 **하지 않는다**(멈췄다고 단정하지 않는다).
 */
export async function sessionTranscriptMtimeMs(
  harness: AgentHarness,
  sessionId: string | null,
  opts: { projectsDir?: string; configDir?: string | null } = {},
): Promise<number | null> {
  // 판정할 수 없으면 재지 않는다(`readsSessionTranscript`).
  if (!readsSessionTranscript(harness)) return null;
  if (!sessionId) return null;
  try {
    const path = await claudeSessionFilePath(sessionId, opts);
    if (path === null) return null;
    return (await stat(path)).mtimeMs;
  } catch {
    return null;
  }
}

/**
 * 이 세션의 기록 파일이 `sinceMs` **이후에 자랐는가**(2026-09-09).
 *
 * `sessionTranscriptExists` 를 대신한다. 그쪽이 재던 것은 "기록 파일이 있는가" 이고,
 * 그것은 **첫 턴에서만** "이 턴의 대화가 시작됐다"와 같은 뜻이다 — 되살린 턴
 * (`claude -r`)에서는 그 파일이 앞 턴에 이미 생겨 있어 무조건 참이 된다.
 *
 * 그 비대칭이 프로덕션에서 값을 치렀다(2026-09-09 실측, forge `5e08f534`). 답을 올린
 * 턴이 회수된 뒤 같은 세션을 되살린 턴 둘이 연달아 프롬프트를 못 받았는데 — 기록에
 * 그 31분 동안 user 줄도 assistant 줄도 한 줄이 없다 — 주입 확인 창(15초)은 파일이
 * 있다는 이유로 통과했고, 사람은 아무 신호도 못 받았다. 결국 정지 시계(10분)가
 * 폴백으로 잡았고, 그 전에 계정 하나가 그만큼 묶였다.
 *
 * 그래서 판정을 **존재에서 성장으로** 옮긴다. `sinceMs` 를 턴 시작 시각으로 주면 두
 * 경우가 한 규칙으로 합쳐진다: 첫 턴은 파일이 없으니 거짓, 되살린 턴은 파일이 낡았으니
 * 거짓 — 둘 다 "이 턴의 대화는 아직 시작되지 않았다"다.
 *
 * **판정할 수 없으면 참이다.** codex 와 세션 미상은 `sessionTranscriptExists` 의 규칙을
 * 그대로 잇는다 — 여기서 거짓을 돌려주면 그 턴들이 매번 사람을 부른다.
 */
export async function sessionTranscriptGrewSince(
  harness: AgentHarness,
  sessionId: string | null,
  sinceMs: number,
  opts: { projectsDir?: string; configDir?: string | null } = {},
): Promise<boolean> {
  // 판정 불가 두 자리는 참이다(위 주석). `sessionTranscriptMtimeMs` 는 이 둘과
  // "파일이 없다"를 다 `null` 로 뭉치므로, 여기서 먼저 가른다.
  if (!readsSessionTranscript(harness)) return true;
  if (!sessionId) return true;
  const mtime = await sessionTranscriptMtimeMs(harness, sessionId, opts);
  return mtime !== null && mtime > sinceMs;
}
