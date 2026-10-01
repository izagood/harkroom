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
import { open, readFile, stat } from 'node:fs/promises';
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
 * 이 턴에서 하네스가 **자기 차례를 끝냈는가**(2026-09-30). 기록 꼬리의 사실을 돌려준다.
 *
 * - `'ended'` — `sinceMs` 이후의 마지막 대화 레코드가 `stop_reason: end_turn` 인 어시스턴트 말이다.
 *   claude 는 그 뒤에 `system/turn_duration`·`cost-state`·`last-prompt` 를 붙이는데, 대화 레코드
 *   (user·assistant)가 아니므로 건너뛴다.
 * - `'working'` — 마지막 대화 레코드가 도구 호출(`tool_use`)·도구 결과·새 입력이다. 긴 셸
 *   명령을 기다리는 턴이 여기 걸린다 — 기록은 멈췄지만 차례는 안 끝났다.
 * - `null` — 판정할 수 없다(기록을 못 읽는 하네스·파일 없음·꼬리에 대화 레코드가 없음).
 *
 * **왜 필요한가.** 러너가 "턴이 끝났다"고 보는 신호가 발화(`end.spoke`) 하나뿐이었다. 그래서
 * 두 방향으로 틀렸다 — 발화 없이 `end_turn` 한 턴(깨움만 걸고 끝난 턴)은 끝난 줄 몰라 10분
 * 정지로 접었고(c0853e6f), 발화한 뒤 기다리던 턴(OAuth 콜백·CI)은 60초 만에 죽였다(ebb97c7b).
 *
 * `sinceMs` 이전 레코드는 세지 않는다: 되살린 세션(`-r`)은 앞 턴의 `end_turn` 으로 끝나 있어,
 * 프롬프트가 들어가기 전에 읽으면 "이미 끝났다"가 된다. API 에러 레코드(`isApiErrorMessage`)는
 * 끝으로 치지 않는다 — 그것은 실패이고 `readLastApiError` 가 따로 잡는다.
 *
 * 꼬리 256KB 만 읽는다 — 기록은 수 MB 가 되고 이 함수는 몇 초마다 돈다. **던지지 않는다.**
 */
export async function readTranscriptTurnState(
  harness: AgentHarness,
  sessionId: string | null,
  opts: { projectsDir?: string; configDir?: string | null; sinceMs?: number } = {},
): Promise<'ended' | 'working' | null> {
  if (!readsSessionTranscript(harness)) return null;
  if (!sessionId) return null;
  const text = await readTranscriptTail(sessionId, opts);
  if (text === null) return null;
  const lines = text.split('\n');
  for (let i = lines.length - 1; i >= 0; i -= 1) {
    const line = lines[i];
    if (!line) continue;
    let record: {
      type?: unknown; isSidechain?: unknown; isApiErrorMessage?: unknown; timestamp?: unknown;
      message?: { stop_reason?: unknown };
    };
    try { record = JSON.parse(line); } catch { continue; }
    if (record.type !== 'user' && record.type !== 'assistant') continue;
    if (record.isSidechain === true) continue;
    if (opts.sinceMs !== undefined) {
      const at = typeof record.timestamp === 'string' ? Date.parse(record.timestamp) : NaN;
      // 이 턴 이전의 말이다 — 이 턴의 대화는 아직 시작되지 않았다.
      if (!Number.isFinite(at) || at < opts.sinceMs) return 'working';
    }
    if (record.type === 'assistant' && record.isApiErrorMessage !== true && record.message?.stop_reason === 'end_turn') return 'ended';
    return 'working';
  }
  return null;
}

const TAIL_BYTES = 256 * 1024;

/** 기록 파일의 꼬리 `TAIL_BYTES` 를 읽는다. 잘린 첫 줄(반쪽 JSON)은 버린다. **던지지 않는다.** */
export async function readTranscriptTail(
  sessionId: string,
  opts: { projectsDir?: string; configDir?: string | null },
): Promise<string | null> {
  try {
    const path = await claudeSessionFilePath(sessionId, opts);
    if (path === null) return null;
    const fh = await open(path, 'r');
    try {
      const { size } = await fh.stat();
      const len = Math.min(size, TAIL_BYTES);
      const buf = Buffer.alloc(len);
      await fh.read(buf, 0, len, size - len);
      const text = buf.toString('utf8');
      return len < size ? text.slice(text.indexOf('\n') + 1) : text;
    } finally {
      await fh.close();
    }
  } catch {
    return null;
  }
}

export type TranscriptRecord = {
  type?: unknown; isSidechain?: unknown; isApiErrorMessage?: unknown; timestamp?: unknown;
  message?: { stop_reason?: unknown; content?: unknown };
};

/** 꼬리의 줄들 중 `sinceMs` 이후의 주 대화(곁가지 아님) 레코드만, 앞에서부터. */
export function recordsSince(text: string, sinceMs: number | undefined): TranscriptRecord[] {
  const out: TranscriptRecord[] = [];
  for (const line of text.split('\n')) {
    if (!line) continue;
    let record: TranscriptRecord;
    try { record = JSON.parse(line); } catch { continue; }
    if (record.type !== 'user' && record.type !== 'assistant') continue;
    if (record.isSidechain === true) continue;
    if (sinceMs !== undefined) {
      const at = typeof record.timestamp === 'string' ? Date.parse(record.timestamp) : NaN;
      if (!Number.isFinite(at) || at < sinceMs) continue;
    }
    out.push(record);
  }
  return out;
}

/**
 * 이 턴에서 하네스가 **자기 차례를 끝내며 남긴 마지막 말**(2026-09-30). 없으면 `null`.
 *
 * **왜 필요한가.** 예약으로 깨어난 턴이 발화 없이 끝나면 그 이유는 하네스의 마지막 말에만
 * 있었다 — "새 소식이 없어서 글을 쓰지 않았어", "05:01Z 에 이미 보고해서 다시 올리지 않았어"
 * (#task e3ecfdf7, 09-30). 그 말은 터미널에만 남고 스레드에는 안 갔다. PTY 꼬리(`result.tail`)
 * 로도 볼 수 있지만 그쪽은 TUI 가 그린 화면이라 줄바꿈·테두리·모달이 섞인다. 기록의 말은 원문이다.
 *
 * `end_turn` 어시스턴트 레코드의 텍스트만 본다 — 도구 호출 사이의 혼잣말은 끝의 이유가 아니다.
 */
export async function readLastAssistantText(
  harness: AgentHarness,
  sessionId: string | null,
  opts: { projectsDir?: string; configDir?: string | null; sinceMs?: number } = {},
): Promise<string | null> {
  if (!readsSessionTranscript(harness)) return null;
  if (!sessionId) return null;
  const text = await readTranscriptTail(sessionId, opts);
  if (text === null) return null;
  const records = recordsSince(text, opts.sinceMs);
  for (const r of [...records].reverse()) {
    if (r.type !== 'assistant' || r.isApiErrorMessage === true || r.message?.stop_reason !== 'end_turn') continue;
    const said = textOf(r);
    if (said) return said;
  }
  return null;
}

/** 권한 분류기가 거부한 도구 호출 하나. */
export interface PermissionDenial {
  /** 짝 맞춤과 중복 제거의 열쇠. */
  toolUseId: string;
  /** 도구 이름(`Bash`, `mcp__harkroom__message_read` …). */
  tool: string;
  /** 무엇을 하려 했는가 — Bash 는 명령, 그 밖은 입력의 앞부분. 원문이며 가리기는 호출자가 한다. */
  input: string;
  /** 분류기가 댄 이유(`[Merge Without Review]` 등). 원문 그대로. */
  reason: string;
}

/**
 * claude 가 auto mode 분류기 거부를 도구 결과에 적는 문구의 머리(2026-09-30 실측).
 * 로컬 분류기(`Reason: [Merge Without Review].`)와 서버 쪽 분류기(`Reason: The server-side
 * auto mode classifier judged this action dangerous (it gave no explanation).`)가 같은 머리를 쓴다.
 */
const DENIAL_HEAD = 'Permission for this action was denied by the Claude Code auto mode classifier.';
const DENIAL_REASON = /Reason: (.+?)\. If you /s;

/**
 * 이 턴에 **권한 분류기가 거부한** 도구 호출들(2026-09-30). 앞에서부터, 없으면 빈 배열.
 *
 * **왜 필요한가.** 거부는 턴을 죽이지 않는다 — 하네스는 다른 길을 찾거나, 거부 문구가 시키는
 * 대로 "같은 결과를 다른 도구로도 좇지 마라"를 지키다가 뒤따르는 읽기·발화까지 거부당한 채
 * 말없이 끝난다(09-30: #945 머지 직후 `message_read` 가 같은 이유로 거부되고 기록이 끊겼다).
 * 사람은 그 사실을 기록을 열어야만 알았다.
 *
 * 도구 결과(`tool_result`) 원문의 머리로만 판정한다 — 에이전트가 말 속에 같은 문장을 인용해도
 * 그것은 어시스턴트 텍스트라 걸리지 않는다. 짝이 되는 `tool_use` 가 꼬리 밖이면 도구·입력은 모른다.
 */
export async function readPermissionDenials(
  harness: AgentHarness,
  sessionId: string | null,
  opts: { projectsDir?: string; configDir?: string | null; sinceMs?: number } = {},
): Promise<PermissionDenial[]> {
  if (!readsSessionTranscript(harness)) return [];
  if (!sessionId) return [];
  const text = await readTranscriptTail(sessionId, opts);
  if (text === null) return [];
  const uses = new Map<string, { tool: string; input: string }>();
  const out: PermissionDenial[] = [];
  // 짝은 시각과 무관하게 모은다 — 거부 결과만 `sinceMs` 로 거른다.
  for (const r of recordsSince(text, undefined)) {
    const content = r.message?.content;
    if (!Array.isArray(content)) continue;
    const at = typeof r.timestamp === 'string' ? Date.parse(r.timestamp) : NaN;
    for (const part of content as Array<Record<string, unknown>>) {
      if (!part || typeof part !== 'object') continue;
      if (part.type === 'tool_use' && typeof part.id === 'string') {
        uses.set(part.id, { tool: String(part.name ?? '?'), input: describeInput(part.input) });
        continue;
      }
      if (part.type !== 'tool_result' || typeof part.tool_use_id !== 'string') continue;
      if (opts.sinceMs !== undefined && (!Number.isFinite(at) || at < opts.sinceMs)) continue;
      const body = typeof part.content === 'string' ? part.content : textOf({ message: { content: part.content } }) ?? '';
      if (!body.startsWith(DENIAL_HEAD)) continue;
      const use = uses.get(part.tool_use_id);
      out.push({
        toolUseId: part.tool_use_id,
        tool: use?.tool ?? '?',
        input: use?.input ?? '',
        reason: DENIAL_REASON.exec(body)?.[1]?.trim() ?? '(이유 없음)',
      });
    }
  }
  return out;
}

/**
 * claude 가 "헤더로 받은 토큰을 MCP 서버가 401 로 거절했다"에 붙이는 코드(2026-10-01 실측,
 * claude 2.1.286). 문구는 `Server rejected the configured Authorization header (HTTP 401) …
 * OAuth fallback is disabled when headers.Authorization is set.` 이다.
 */
const AUTH_HEADER_REJECTED = 'AUTH_HEADER_REJECTED';

/**
 * 이 턴에 **우리가 구운 `Authorization` 헤더를 거절당한** MCP 서버 이름들(2026-10-01). 중복 없이,
 * 처음 본 순서로. 없으면 빈 배열.
 *
 * **왜 필요한가.** 오퍼레이터가 OAuth 토큰을 들고 러너 설정에 `headers.Authorization` 으로 굽는다
 * (`operator/src/mcpConfig.ts`). 헤더가 있으면 claude 는 자기 OAuth 로 물러나지 않고 그 서버를 그냥
 * 못 붙인다. 오퍼레이터는 만료 시각으로만 refresh 하므로, 만료 전에 무효가 된 토큰은 그 시각까지
 * 매 턴 401 이었고 데스크톱은 "인증됨"이었다(10-01 slack: 12:08~14:51 KST, 사람이 다시 인증할 때까지).
 * 그 사실은 이 기록에만 있었다.
 *
 * claude 는 연결 실패를 `type: 'attachment'` 레코드의 `attachment.failedMcpServers[]`
 * (`{ name, errorCode, error }`)에 구조화해서 남긴다. **`errorCode` 로만** 판정한다 — 문구(`error`)는
 * MCP 서버가 돌려준 본문이 섞인 것이라 해석하지 않는다. 다른 실패(`CONNECTION_CLOSED` 등)는
 * 토큰 문제가 아니므로 세지 않는다.
 */
export async function readMcpAuthRejections(
  harness: AgentHarness,
  sessionId: string | null,
  opts: { projectsDir?: string; configDir?: string | null; sinceMs?: number } = {},
): Promise<string[]> {
  if (!readsSessionTranscript(harness)) return [];
  if (!sessionId) return [];
  const text = await readTranscriptTail(sessionId, opts);
  if (text === null) return [];
  const out: string[] = [];
  for (const line of text.split('\n')) {
    // 싸게 먼저 거른다 — 꼬리는 256KB 이고 대부분은 이 코드가 없다.
    if (!line.includes(AUTH_HEADER_REJECTED)) continue;
    let record: { type?: unknown; isSidechain?: unknown; timestamp?: unknown; attachment?: { failedMcpServers?: unknown } };
    try { record = JSON.parse(line); } catch { continue; }
    if (record.type !== 'attachment' || record.isSidechain === true) continue;
    if (opts.sinceMs !== undefined) {
      const at = typeof record.timestamp === 'string' ? Date.parse(record.timestamp) : NaN;
      if (!Number.isFinite(at) || at < opts.sinceMs) continue;
    }
    const failed = record.attachment?.failedMcpServers;
    if (!Array.isArray(failed)) continue;
    for (const f of failed as Array<Record<string, unknown>>) {
      if (!f || typeof f !== 'object' || f.errorCode !== AUTH_HEADER_REJECTED) continue;
      if (typeof f.name !== 'string' || !f.name || out.includes(f.name)) continue;
      out.push(f.name);
    }
  }
  return out;
}

/** 도구 입력을 한 줄로. Bash 는 명령 그 자체가 가장 읽기 좋다. */
function describeInput(input: unknown): string {
  if (input && typeof input === 'object' && typeof (input as { command?: unknown }).command === 'string') {
    return (input as { command: string }).command;
  }
  try { return JSON.stringify(input) ?? ''; } catch { return ''; }
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
