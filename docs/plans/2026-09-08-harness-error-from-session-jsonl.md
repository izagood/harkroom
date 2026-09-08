# P1 — 하네스 실패 판정을 세션 JSONL 로 옮긴다

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 하네스가 낸 API 에러(사용량 한도 등)를 PTY tail 문자열이 아니라 **세션 JSONL 의 구조화된 레코드**에서 읽는다.

**Architecture:** 세션 파일에는 `isApiErrorMessage: true` 가 붙은 `assistant` 레코드가 있고 그 내용이 하네스 자신의 에러 문구다. 실패한 턴이 그 레코드를 읽어 던지는 에러에 **구조화 필드로 실어** 보내고, `policy.ts` 의 판정이 그 필드를 먼저 본다. tail 폴백은 P1 에서 **남긴다**(§범위 참고).

**Tech Stack:** TypeScript (ESM, `type: module`), Node ≥22, vitest 3.

**Spec:** `docs/specs/2026-09-08-tui-execution-model-design.md` §3-4

## Global Constraints

- 대상은 `packages/agent` 뿐이다.
- **murmur PAT 판정은 건드리지 않는다.** `policy.ts::isCredentialFailure` 의 `status === 401 || 403` 경로는 이미 구조적이고 이 작업과 무관하다.
- **tail 폴백을 지우지 않는다.** P1 이 도는 동안 러너는 아직 `claude -p` 를 쓰고, 그 경로에서 tail 판정은 정상 동작한다. 폴백 제거는 TUI 가 들어오는 P2 의 일이다.
- **프리플라이트(미로그인 사전 확인)는 이 계획에 없다.** 설계 §3-4 가 P1 에 묶어 뒀지만, 그 값은 TUI 로 무발화 30분을 기다리게 될 때 생긴다. `-p` 에서는 미로그인이 2초 만에 실패하고 계정 축이 넘어가므로 지금 옮길 이유가 없다. P2 로 미룬다.
- 주석은 한국어로, 저장소의 기존 톤을 따른다: **무엇을 하는지가 아니라 왜 그래야 하는지, 그러지 않으면 무엇이 깨지는지**.
- 테스트: `pnpm --filter @murmur/agent exec vitest run <파일>`. 전체는 `pnpm --filter @murmur/agent test`.

## File Structure

| 파일 | 책임 |
|---|---|
| `packages/agent/src/claudeSessions.ts` (수정) | 세션 파일의 **경로**를 돌려주는 함수를 더한다. 기존 존재 확인이 그 위에 다시 선다 |
| `packages/agent/src/harnessErrors.ts` (신규) | 세션 JSONL 에서 하네스가 낸 마지막 API 에러를 읽는다 |
| `packages/agent/test/harnessErrors.test.ts` (신규) | 위의 단위 테스트 |
| `packages/agent/src/policy.ts` (수정) | 한도 파싱을 텍스트 함수로 분리하고, 판정이 구조화 필드를 먼저 본다 |
| `packages/agent/src/mentionTurn.ts` (수정) | 실패 시 JSONL 을 읽어 던지는 에러에 싣는다 |

---

### Task 1: 세션 파일 경로를 돌려주는 함수

**Files:**
- Modify: `packages/agent/src/claudeSessions.ts`
- Test: `packages/agent/test/claudeSessions.test.ts`

**Interfaces:**
- Consumes: 없음.
- Produces: `claudeSessionFilePath(sessionId: string, opts?: { projectsDir?: string; configDir?: string | null }): Promise<string | null>` — 세션 `.jsonl` 의 절대 경로, 없으면 `null`.

- [ ] **Step 1: 실패하는 테스트를 쓴다**

`packages/agent/test/claudeSessions.test.ts` 의 기존 `describe` 안에 추가:

```ts
  it('세션 파일의 경로를 돌려준다 — 존재 확인과 같은 탐색을 쓴다', async () => {
    const root = await mkdtemp(join(tmpdir(), 'murmur-sessions-'));
    const proj = join(root, 'projects', '-Users-someone-work');
    await mkdir(proj, { recursive: true });
    const sid = '11111111-2222-3333-4444-555555555555';
    await writeFile(join(proj, `${sid}.jsonl`), '{}\n');

    const found = await claudeSessionFilePath(sid, { projectsDir: join(root, 'projects') });
    expect(found).toBe(join(proj, `${sid}.jsonl`));

    const missing = await claudeSessionFilePath('99999999-2222-3333-4444-555555555555', {
      projectsDir: join(root, 'projects'),
    });
    expect(missing).toBeNull();
  });
```

파일 상단 import 에 `claudeSessionFilePath` 를 더한다. `mkdtemp`·`mkdir`·`writeFile`·`join`·`tmpdir` 가 이미 import 돼 있지 않으면 더한다:

```ts
import { mkdtemp, mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
```

- [ ] **Step 2: 테스트가 실패하는지 확인한다**

Run: `pnpm --filter @murmur/agent exec vitest run test/claudeSessions.test.ts`
Expected: FAIL — `claudeSessionFilePath` is not exported

- [ ] **Step 3: 최소 구현을 쓴다**

`claudeSessions.ts` 의 `claudeSessionFileExists` 를 다음으로 **교체**한다(탐색 규칙이 두 벌이 되지 않게 한쪽이 다른 쪽 위에 선다):

```ts
/**
 * 세션 `.jsonl` 의 **경로**. 없으면 `null`.
 *
 * `claudeSessionFileExists` 가 이 위에 선다 — 같은 탐색 규칙이 두 벌이 되면 나중에 한쪽만
 * 고치는 사고가 난다(이 파일이 이미 겪은 종류의 사고다: 경로가 `CLAUDE_CONFIG_DIR` 를
 * 따라간다는 사실을 한 곳에서만 반영하면 다른 쪽이 "세션 없음"으로 읽는다).
 *
 * 경로 우선순위는 존재 확인과 같다: `projectsDir`(직접 지정) → `configDir`(계정) → 시스템 기본.
 */
export async function claudeSessionFilePath(
  sessionId: string,
  opts: { projectsDir?: string; configDir?: string | null } = {},
): Promise<string | null> {
  const root = opts.projectsDir
    ?? (opts.configDir ? join(opts.configDir, 'projects') : join(homedir(), '.claude', 'projects'));
  let projects;
  try {
    projects = await readdir(root, { withFileTypes: true });
  } catch {
    // 디렉터리가 없다 = claude 세션이 하나도 없다 — "없음"의 정상 경로이지 에러가 아니다.
    return null;
  }
  const wanted = `${sessionId}.jsonl`;
  for (const entry of projects) {
    if (!entry.isDirectory()) continue;
    try {
      const files = await readdir(join(root, entry.name));
      if (files.includes(wanted)) return join(root, entry.name, wanted);
    } catch { /* 프로젝트 하나를 못 읽는 것이 나머지 탐색을 막지 않는다 */ }
  }
  return null;
}

/**
 * **경로는 `CLAUDE_CONFIG_DIR` 를 따라간다(2026-09-07).** 계정별 config 디렉터리로 claude 를
 * 띄우면 세션 파일도 `<configDir>/projects` 아래로 옮겨간다(실측). 이 판정이 계속 홈만 보면
 * 계정 디렉터리의 세션을 "없음"으로 읽고, 다음 턴이 첫 턴으로 조립돼 claude 가 이미 쓰인
 * 세션 id 를 `--session-id` 로 다시 받아 즉사한다 — 위 모듈 주석이 적은 바로 그 함정이다.
 */
export async function claudeSessionFileExists(
  sessionId: string,
  opts: { projectsDir?: string; configDir?: string | null } = {},
): Promise<boolean> {
  return (await claudeSessionFilePath(sessionId, opts)) !== null;
}
```

- [ ] **Step 4: 테스트가 통과하는지 확인한다**

Run: `pnpm --filter @murmur/agent exec vitest run test/claudeSessions.test.ts`
Expected: PASS — 기존 케이스도 전부 초록(존재 확인이 새 함수 위에 서므로 회귀가 여기서 잡힌다)

- [ ] **Step 5: 커밋**

```bash
git add packages/agent/src/claudeSessions.ts packages/agent/test/claudeSessions.test.ts
git commit -m "refactor(agent): 세션 파일 경로 해석을 함수로 뽑는다

존재 확인이 그 위에 선다 — 같은 탐색 규칙이 두 벌이 되면 나중에 한쪽만
고치는 사고가 난다."
```

---

### Task 2: 세션 JSONL 에서 마지막 API 에러를 읽는다

**Files:**
- Create: `packages/agent/src/harnessErrors.ts`
- Test: `packages/agent/test/harnessErrors.test.ts`

**Interfaces:**
- Consumes: Task 1 의 `claudeSessionFilePath`.
- Produces:
  - `interface HarnessApiError { text: string }`
  - `readLastApiError(harness: AgentHarness, sessionId: string | null, opts?: { projectsDir?: string; configDir?: string | null }): Promise<HarnessApiError | null>`

- [ ] **Step 1: 실패하는 테스트를 쓴다**

Create `packages/agent/test/harnessErrors.test.ts`:

```ts
// 세션 JSONL 에서 하네스가 낸 API 에러를 읽는 경로의 회귀선.
//
// 왜 이 판정이 tail 이 아니라 여기 있어야 하는가: tail 은 PTY 출력의 끝 2KB 링이라
// (1) 앞이 잘리고 (2) 사람이 넣은 프롬프트가 에코돼 섞인다. 2026-09-07 19:03 사건에서
// 세션 파일에는 `resets 10:50pm (Asia/Seoul)` 이 있었는데 tail 판정은 "풀림: 알 수 없음"을
// 찍었다. 이 파일이 그 자리를 대신한다.
import { describe, expect, it } from 'vitest';
import { mkdtemp, mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { readLastApiError } from '../src/harnessErrors.js';

const SID = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee';

/** `projects/<프로젝트>/<sid>.jsonl` 을 만들고 그 projects 뿌리를 돌려준다. */
async function seed(lines: unknown[]): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'murmur-harness-err-'));
  const projects = join(root, 'projects');
  const proj = join(projects, '-Users-someone-work');
  await mkdir(proj, { recursive: true });
  await writeFile(join(proj, `${SID}.jsonl`), lines.map((l) => JSON.stringify(l)).join('\n') + '\n');
  return projects;
}

/** 실물과 같은 모양의 에러 레코드(2026-09-08 로컬 세션 전수 조사에서 확인한 형태). */
const apiErrorRecord = (text: string) => ({
  type: 'assistant',
  isApiErrorMessage: true,
  message: { role: 'assistant', content: [{ type: 'text', text }] },
});

describe('readLastApiError', () => {
  it('isApiErrorMessage 레코드의 문구를 돌려준다', async () => {
    const projectsDir = await seed([
      { type: 'user', message: { role: 'user', content: [{ type: 'text', text: '안녕' }] } },
      apiErrorRecord("You've hit your session limit · resets 10:50pm (Asia/Seoul)"),
    ]);
    const found = await readLastApiError('claude-code', SID, { projectsDir });
    expect(found?.text).toBe("You've hit your session limit · resets 10:50pm (Asia/Seoul)");
  });

  it('에러가 여럿이면 **마지막** 것을 돌려준다 — 이번 턴의 사실이 앞 턴의 것보다 뒤에 있다', async () => {
    const projectsDir = await seed([
      apiErrorRecord('옛 에러'),
      { type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text: '정상 응답' }] } },
      apiErrorRecord('최신 에러'),
    ]);
    const found = await readLastApiError('claude-code', SID, { projectsDir });
    expect(found?.text).toBe('최신 에러');
  });

  it('에러가 없으면 null — 사용자 발화를 에러로 읽지 않는다', async () => {
    const projectsDir = await seed([
      { type: 'user', message: { role: 'user', content: [{ type: 'text', text: 'authentication_error 라는 문구' }] } },
      { type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text: '네' }] } },
    ]);
    expect(await readLastApiError('claude-code', SID, { projectsDir })).toBeNull();
  });

  it('세션 파일이 없으면 null — 예외로 턴을 죽이지 않는다', async () => {
    const root = await mkdtemp(join(tmpdir(), 'murmur-harness-err-'));
    expect(await readLastApiError('claude-code', SID, { projectsDir: join(root, 'projects') })).toBeNull();
  });

  it('sessionId 가 null 이면 null — 세션이 없는 턴은 읽을 것이 없다', async () => {
    expect(await readLastApiError('claude-code', null, {})).toBeNull();
  });

  it('깨진 줄이 있어도 나머지를 읽는다 — 한 줄이 전체를 막지 않는다', async () => {
    const root = await mkdtemp(join(tmpdir(), 'murmur-harness-err-'));
    const projects = join(root, 'projects');
    const proj = join(projects, '-p');
    await mkdir(proj, { recursive: true });
    await writeFile(
      join(proj, `${SID}.jsonl`),
      `{ 깨진 줄\n${JSON.stringify(apiErrorRecord('살아남은 에러'))}\n`,
    );
    const found = await readLastApiError('claude-code', SID, { projectsDir: projects });
    expect(found?.text).toBe('살아남은 에러');
  });

  it('codex 는 아직 null 이다 — rollout 형식은 P5 에서 다룬다', async () => {
    const projectsDir = await seed([apiErrorRecord('무엇이든')]);
    expect(await readLastApiError('codex', SID, { projectsDir })).toBeNull();
  });
});
```

- [ ] **Step 2: 테스트가 실패하는지 확인한다**

Run: `pnpm --filter @murmur/agent exec vitest run test/harnessErrors.test.ts`
Expected: FAIL — `Failed to resolve import "../src/harnessErrors.js"`

- [ ] **Step 3: 최소 구현을 쓴다**

Create `packages/agent/src/harnessErrors.ts`:

```ts
// 하네스가 **자기 입으로** 낸 API 에러를 디스크에서 읽는다.
//
// **왜 tail 이 아닌가.** 지금 실패 분류(`policy.ts`)는 PTY 출력의 끝 2KB 링(tail) 문자열을
// 본다. 그 재료에는 두 결함이 있다:
//   ① 앞이 잘린다 — 2026-09-07 19:03 사건에서 세션 파일에는 `resets 10:50pm (Asia/Seoul)` 이
//      있었는데 tail 판정은 "풀림: 알 수 없음"을 찍었다.
//   ② 사람이 넣은 프롬프트가 섞일 수 있다 — PTY 는 입력을 에코한다(#380 2단계 실측).
//      그러면 본문에 `authentication_error` 를 넣은 사람이 러너를 78 로 물러나게 할 수 있다.
// 세션 JSONL 의 레코드에는 `isApiErrorMessage: true` 라는 **명시적 플래그**가 붙고, 그 내용은
// 하네스 자신의 문구라 두 결함이 다 없다.
//
// **이것은 하네스 출력 파싱이 아니다.** `claudeSessions.ts`·`codexSessions.ts` 가 세운 것과
// 같은 "디스크의 사실 관측"이다 — 우리가 발급했거나 하네스가 확정한 값을 파일에서 읽는다.
import { readFile } from 'node:fs/promises';
import type { AgentHarness } from '@murmur/shared';
import { claudeSessionFilePath } from './claudeSessions.js';

export interface HarnessApiError {
  /** 하네스가 낸 에러 문구 원문. 해석하지 않는다 — 판정은 `policy.ts` 가 한다. */
  text: string;
}

/** 레코드 하나에서 사람이 읽는 텍스트를 뽑는다. content 는 배열이거나 문자열이다. */
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
 * 이 세션에서 하네스가 마지막으로 낸 API 에러. 없으면 `null`.
 *
 * **마지막**을 고르는 이유: 세션 파일은 스레드의 전체 이력이라 앞 턴의 에러가 남아 있다.
 * 지금 실패한 턴의 사실은 그중 가장 뒤에 있다.
 *
 * **던지지 않는다.** 이 값은 실패 분류를 **더 좋게** 만드는 재료이지 턴의 성패가 아니다 —
 * 파일을 못 읽었다고 예외를 올리면, 원래 하려던 실패 처리(통지·재시도 회계)까지 함께
 * 무너진다. 못 읽으면 호출자는 기존 tail 판정으로 그대로 간다.
 */
export async function readLastApiError(
  harness: AgentHarness,
  sessionId: string | null,
  opts: { projectsDir?: string; configDir?: string | null } = {},
): Promise<HarnessApiError | null> {
  // codex 의 rollout 은 형식이 다르다 — P5 에서 다룬다. 지금 억지로 읽으면 "읽었다"는
  // 거짓 신호가 생기고, 그것이 tail 폴백을 막는다.
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
    if (!line.includes('isApiErrorMessage')) continue;  // 값싼 사전 거르기
    let record: { isApiErrorMessage?: unknown; message?: { content?: unknown } };
    try {
      record = JSON.parse(line);
    } catch {
      continue;  // 깨진 줄 하나가 나머지 탐색을 막지 않는다
    }
    if (record.isApiErrorMessage !== true) continue;
    const text = textOf(record);
    if (text) last = text;
  }
  return last === null ? null : { text: last };
}
```

- [ ] **Step 4: 테스트가 통과하는지 확인한다**

Run: `pnpm --filter @murmur/agent exec vitest run test/harnessErrors.test.ts`
Expected: PASS — 7 tests

- [ ] **Step 5: 타입 검사**

Run: `pnpm --filter @murmur/agent typecheck`
Expected: 오류 없음

- [ ] **Step 6: 커밋**

```bash
git add packages/agent/src/harnessErrors.ts packages/agent/test/harnessErrors.test.ts
git commit -m "feat(agent): 세션 JSONL 에서 하네스 API 에러를 읽는다

tail 은 끝 2KB 링이라 앞이 잘리고, PTY 가 입력을 에코해 사람의 프롬프트가
섞인다. 세션 레코드에는 isApiErrorMessage 플래그가 붙고 내용이 하네스 자신의
문구라 두 결함이 다 없다."
```

---

### Task 3: 판정이 구조화 필드를 먼저 본다

**Files:**
- Modify: `packages/agent/src/policy.ts`
- Test: `packages/agent/test/policy.test.ts`

**Interfaces:**
- Consumes: 없음(문자열만 다룬다).
- Produces:
  - `quotaFromText(text: string): { resetsAt: string | null } | null` — 한도 문구 파싱.
  - `isQuotaExhausted(err: unknown)` 의 동작 변경: `err.harnessApiError`(문자열)를 **먼저** 보고, 없거나 안 맞으면 `err.message` 로 폴백.

- [ ] **Step 1: 실패하는 테스트를 쓴다**

`packages/agent/test/policy.test.ts` 의 한도 관련 `describe` 안에 추가:

```ts
  it('구조화 필드(harnessApiError)를 tail 보다 먼저 본다', () => {
    // tail 은 잘려 시각이 없고, 세션 JSONL 에서 온 문구에는 있다 — 2026-09-07 사건의 모양.
    const err = Object.assign(new Error('harness 종료 1: ...hit your session limit'), {
      harnessApiError: "You've hit your session limit · resets 10:50pm (Asia/Seoul)",
    });
    expect(isQuotaExhausted(err)).toEqual({ resetsAt: '10:50pm (Asia/Seoul)' });
  });

  it('구조화 필드가 없으면 기존 tail 판정으로 간다', () => {
    const err = new Error("harness 종료 1: You've hit your session limit · resets 4:10pm (Asia/Seoul)");
    expect(isQuotaExhausted(err)).toEqual({ resetsAt: '4:10pm (Asia/Seoul)' });
  });

  it('구조화 필드가 한도가 아니면 tail 로 폴백한다 — 다른 API 에러가 한도를 가리지 않는다', () => {
    const err = Object.assign(new Error("harness 종료 1: You've hit your session limit · resets 9:00pm"), {
      harnessApiError: 'API Error: overloaded_error',
    });
    expect(isQuotaExhausted(err)).toEqual({ resetsAt: '9:00pm' });
  });

  it('quotaFromText 는 한도가 아닌 문구에 null 을 준다', () => {
    expect(quotaFromText('그냥 실패했다')).toBeNull();
  });
```

파일 상단 import 에 `quotaFromText` 를 더한다.

- [ ] **Step 2: 테스트가 실패하는지 확인한다**

Run: `pnpm --filter @murmur/agent exec vitest run test/policy.test.ts`
Expected: FAIL — `quotaFromText` is not exported, 그리고 구조화 필드 케이스가 `resetsAt: null` 로 온다

- [ ] **Step 3: 최소 구현을 쓴다**

`policy.ts` 의 `isQuotaExhausted` 를 다음으로 **교체**한다(기존 함수 위의 긴 주석 블록은 그대로 두고 함수만 바꾼다):

```ts
/**
 * 한도 문구 파싱. **텍스트만 받는다** — 재료가 tail 이든 세션 JSONL 이든 규칙은 하나여야
 * 하고, 규칙이 두 벌이 되면 한쪽만 고치는 사고가 난다.
 */
export function quotaFromText(text: string): { resetsAt: string | null } | null {
  const squashed = text.replace(/\s+/g, '').toLowerCase();
  // `You've` 의 아포스트로피는 판본·터미널에 따라 `'` 와 `’` 가 다 나오므로 뺀 채로 본다.
  if (!/hityour(session|usage)limit/i.test(squashed.replace(/['’]/g, ''))) return null;
  // `[^\n\u001b]` — 줄 끝이나 ESC 에서 멈춘다. 한도에 걸린 claude 는 죽기 전에 화면을
  // 다시 그려 커서 복원 시퀀스가 문구 뒤에 붙는다(2026-09-07 실측). tail 재료에서만
  // 생기는 일이지만 규칙을 하나로 두려고 여기서 함께 막는다.
  const resets = /resets\s+([^\n\u001b]+)/i.exec(text);
  return { resetsAt: resets ? resets[1]!.trim() : null };
}

/**
 * **구조화 필드를 먼저 본다(2026-09-08).** `mentionTurn` 이 세션 JSONL 에서 읽은 하네스
 * 자신의 에러 문구를 `harnessApiError` 로 실어 준다. 그 재료가 tail 보다 나은 이유는
 * `harnessErrors.ts` 머리에 있다 — 앞이 안 잘리고, 사람의 프롬프트가 섞이지 않는다.
 *
 * 못 읽었으면(파일 부재·codex) 필드가 없고, 그때는 기존 tail 판정 그대로다. 구조화 필드가
 * **있는데 한도가 아닌** 경우에도 tail 로 폴백한다: 그 필드는 "마지막 API 에러"이지
 * "이 턴이 실패한 이유"라는 보장이 아니라서, 앞 턴의 다른 에러가 이번 한도를 가리면 안 된다.
 */
export function isQuotaExhausted(err: unknown): { resetsAt: string | null } | null {
  const structured = (err as { harnessApiError?: unknown } | null)?.harnessApiError;
  if (typeof structured === 'string') {
    const hit = quotaFromText(structured);
    if (hit) return hit;
  }
  return quotaFromText(err instanceof Error ? err.message : String(err ?? ''));
}
```

- [ ] **Step 4: 테스트가 통과하는지 확인한다**

Run: `pnpm --filter @murmur/agent exec vitest run test/policy.test.ts`
Expected: PASS — 새 4건과 기존 케이스 전부

- [ ] **Step 5: 커밋**

```bash
git add packages/agent/src/policy.ts packages/agent/test/policy.test.ts
git commit -m "feat(agent): 한도 판정이 구조화 필드를 tail 보다 먼저 본다

파싱 규칙은 quotaFromText 하나로 모은다 — 재료가 tail 이든 세션 JSONL 이든
규칙이 두 벌이 되면 한쪽만 고치는 사고가 난다."
```

---

### Task 4: 실패한 턴이 세션 JSONL 을 읽어 에러에 싣는다

**Files:**
- Modify: `packages/agent/src/mentionTurn.ts` (하네스 실패를 던지는 자리 — `harness 종료 ...` 를 만드는 곳)
- Test: `packages/agent/test/mentionTurn.test.ts`

**Interfaces:**
- Consumes: Task 2 의 `readLastApiError`, Task 3 의 `isQuotaExhausted`.
- Produces: 던지는 `Error` 에 `harnessApiError?: string` 필드가 붙는다.

- [ ] **Step 1: 실패하는 테스트를 쓴다**

`packages/agent/test/mentionTurn.test.ts` 에 추가(이 파일의 기존 헬퍼로 턴을 조립한다 — 실패 턴을 만드는 기존 케이스의 조립 방식을 그대로 따른다):

```ts
  it('하네스 실패 시 세션 JSONL 의 API 에러를 에러에 싣는다', async () => {
    // 하네스가 비정상 종료하고 **tail 에는 시각이 없다** — 2026-09-07 19:03 사건의 모양이다.
    const fake = new FakeMurmur(defOf());
    fake.seedFrom('human-1', '@forge 안녕');

    const configDir = await mkdtemp(join(tmpdir(), 'murmur-mt-jsonl-'));
    const { deps, runTurn } = await makeDeps(fake, { claudeConfigDir: configDir });
    runTurn.script = async () => ({ exitCode: 1, timedOut: false, tail: "...hit your session limit" });

    // 세션 id 는 러너가 첫 턴에 발급해 store 에 넣는다. 한 번 실패시켜 그 id 를 확정한 뒤
    // 같은 id 로 세션 파일을 심고 다시 돌린다 — 실물에서도 파일은 턴이 돈 뒤에 생긴다.
    await expect(runMentionTurn(deps, { channelId: CHANNEL, threadRootId: null, mentionId: MENTION }))
      .rejects.toThrow();
    const sid = deps.store.get(SessionStore.threadKey(CHANNEL, null))!.sessionId!;
    const proj = join(configDir, 'projects', '-p');
    await mkdir(proj, { recursive: true });
    await writeFile(join(proj, `${sid}.jsonl`), JSON.stringify({
      type: 'assistant',
      isApiErrorMessage: true,
      message: {
        role: 'assistant',
        content: [{ type: 'text', text: "You've hit your session limit \u00b7 resets 3:00am (Asia/Seoul)" }],
      },
    }) + '\n');

    const err = await runMentionTurn(deps, { channelId: CHANNEL, threadRootId: null, mentionId: MENTION })
      .then(() => null, (e: unknown) => e as Error & { harnessApiError?: string });

    expect(err).not.toBeNull();
    expect(err!.harnessApiError).toContain('resets 3:00am (Asia/Seoul)');
    // 그 필드가 실제로 판정을 낫게 만든다 — tail 만이었으면 resetsAt 이 null 이다.
    expect(isQuotaExhausted(err)).toEqual({ resetsAt: '3:00am (Asia/Seoul)' });
  });
```

이 파일이 아직 안 쓰는 import 를 더한다:

```ts
import { mkdtemp, mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { isQuotaExhausted } from '../src/policy.js';
```

`FakeMurmur`·`defOf`·`makeDeps`·`CHANNEL`·`MENTION`·`SessionStore` 는 이 테스트 파일이 이미
쓰는 헬퍼·상수다 — `makeDeps(fake, overrides)` 가 `{ deps, runTurn, … }` 를 준다. 하네스
결과를 `runTurn.script` 로 정하는 것도 이 파일의 기존 방식이다. 새로 만들지 않는다.

- [ ] **Step 2: 테스트가 실패하는지 확인한다**

Run: `pnpm --filter @murmur/agent exec vitest run test/mentionTurn.test.ts`
Expected: FAIL — `err.harnessApiError` 가 `undefined`

- [ ] **Step 3: 최소 구현을 쓴다**

`mentionTurn.ts` 의 import 에 더한다:

```ts
import { readLastApiError } from './harnessErrors.js';
```

하네스 실패를 던지는 자리(현재 `throw new Error(\`harness 종료 ...\`)`)를 다음으로 교체한다:

```ts
    // tail 을 반드시 포함한다 — PTY 안에서는 stdout/stderr 가 한 스트림으로 섞여 나오므로
    // policy.ts 의 tail 폴백이 볼 근거가 이것뿐이다.
    //
    // **그 위에 구조화된 사실을 얹는다(2026-09-08).** 세션 JSONL 의 `isApiErrorMessage`
    // 레코드는 앞이 안 잘리고 사람의 프롬프트가 섞이지 않는다(`harnessErrors.ts`). 읽기가
    // 실패해도 **던지지 않는다** — 이 값은 판정을 더 좋게 만드는 재료이지 턴의 성패가
    // 아니고, 여기서 예외를 올리면 원래 하려던 실패 처리까지 함께 무너진다.
    const apiError = await readLastApiError(def.harness, rec.sessionId, {
      configDir: deps.claudeConfigDir,
    }).catch(() => null);
    const failure = new Error(
      `harness 종료 ${result.exitCode}${result.timedOut ? ' (timeout)' : ''}: ${result.tail}`,
    ) as Error & { harnessApiError?: string };
    if (apiError) failure.harnessApiError = apiError.text;
    throw failure;
```

- [ ] **Step 4: 테스트가 통과하는지 확인한다**

Run: `pnpm --filter @murmur/agent exec vitest run test/mentionTurn.test.ts`
Expected: PASS

- [ ] **Step 5: 전체 테스트와 타입 검사**

Run: `pnpm --filter @murmur/agent typecheck && pnpm --filter @murmur/agent test`
Expected: 둘 다 통과, 회귀 없음

- [ ] **Step 6: 커밋**

```bash
git add packages/agent/src/mentionTurn.ts packages/agent/test/mentionTurn.test.ts
git commit -m "feat(agent): 실패한 턴이 세션 JSONL 의 API 에러를 함께 던진다

2026-09-07 19:03 사건에서 세션 파일에는 resets 시각이 있었는데 tail 판정은
'풀림: 알 수 없음' 만 남겼다. 이제 그 시각이 사람에게 간다.

읽기 실패는 삼킨다 — 이 값은 판정을 더 좋게 만드는 재료이지 턴의 성패가
아니고, 여기서 던지면 원래 하려던 실패 처리까지 함께 무너진다."
```

---

## 최종 확인

- [ ] `pnpm --filter @murmur/agent test` — 전부 통과
- [ ] `pnpm --filter @murmur/agent typecheck` — 오류 없음
- [ ] `pnpm -r test` — 다른 패키지 회귀 없음
- [ ] 실물 확인(한도가 실제로 걸렸을 때): 러너 로그의 `사용량 한도 — 재시도하지 않는다 (풀림: …)` 줄에 **시각이 찍히는지** 본다. 지금까지 그 자리는 "알 수 없음"이었다. 로그: `~/Library/Application Support/app.murmur.desktop/daemon/runner-<agentId>.log`

## 이 계획이 하지 않는 것

- **tail 판정 제거.** P1 동안 러너는 아직 `claude -p` 를 쓰고 그 경로에서 tail 은 정상 동작한다. 제거는 TUI 가 들어오는 P2 의 일이다.
- **미로그인 프리플라이트.** 설계 §3-4 가 P1 에 묶어 뒀지만 그 값은 TUI 에서 무발화 30분을 기다리게 될 때 생긴다. P2 로 미룬다.
- **`isCredentialFailure`·`isSessionIdConflict` 의 이설.** 같은 구조화 필드를 쓰도록 옮길 수 있지만, 한도와 달리 지금 오작동하고 있다는 증거가 없다. 필요해질 때(P2) 같은 자리에 얹는다 — `quotaFromText` 가 그 형태를 이미 보여 준다.
- **codex.** `readLastApiError` 가 `'claude-code'` 가 아니면 `null` 을 준다. rollout 형식은 P5 에서 다룬다.
