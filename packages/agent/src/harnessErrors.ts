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
import { readFile } from 'node:fs/promises';
import type { AgentHarness } from '@murmur/shared';
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
  opts: { projectsDir?: string; configDir?: string | null } = {},
): Promise<HarnessApiError | null> {
  // codex 의 rollout 은 형식이 다르다 — P5 에서 다룬다. 지금 억지로 읽으면 "읽었다"는 거짓
  // 신호가 생기고, 그것이 아직 정상 동작하는 tail 폴백을 가린다.
  if (harness !== 'claude-code') return null;
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
    let record: { isApiErrorMessage?: unknown; message?: { content?: unknown } };
    try {
      record = JSON.parse(line);
    } catch {
      continue; // 깨진 줄 하나가 나머지 탐색을 막지 않는다
    }
    if (record.isApiErrorMessage !== true) continue;
    const text = textOf(record);
    if (text) last = text;
  }
  return last === null ? null : { text: last };
}
