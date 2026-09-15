// **옛 경로와 새 경로가 같은 답을 내는가** — 세션 기록 판정(이설 2/N, 2026-09-11).
//
// 네 함수(`readLastApiError` · `sessionTranscriptMtimeMs` · `sessionTranscriptGrewSince` ·
// `sessionMaterialized`)가 각자 `harness !== 'claude-code'` 로 묻던 **같은 질문**을
// `readsSessionTranscript` 하나로 모았다. 스위치가 꺼져 있으면 옛 비교를 그대로 하고,
// 켜면 어댑터 표를 읽는다. 이 파일이 그 둘이 같음을 지킨다.
//
// ## 잰 방법 — 반환값을 맞춘다
//
// 이 함수들은 파일을 읽고 값을 **돌려준다**. 그러니 재야 하는 것은 반환값이고, 같은
// 입력(같은 기록 파일·같은 시각)에 대해 두 경로가 같은 값을 내야 한다. 판정이 갈리는
// 자리가 하나뿐이므로 그 하나를 사이에 두고 양쪽을 돌리는 것이 가장 곧은 측정이다.
//
// ## 왜 "둘 다 null" 만으로는 부족한가
//
// 읽을 줄 아는 하네스(claude)에서 **실제로 읽히는** 것까지 확인해야 한다. 둘 다 못 읽어서
// 같은 답이 나오는 것은 같음의 증거가 아니다 — 그래서 claude 는 값이 있는 경우를 따로 잰다.
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { RUNNABLE_HARNESSES, type AgentHarness } from '@harkroom/shared';

import { readLastApiError, sessionTranscriptMtimeMs, sessionTranscriptGrewSince } from '../src/harnessErrors.js';
import { claudeSessionMaterialized } from '../src/claudeSessions.js';
import { readsSessionTranscript } from '../src/adapters/index.js';
import { runWithExecutionPath } from '../src/executionPath.js';

const RUNNABLE = RUNNABLE_HARNESSES as readonly AgentHarness[];
const SESSION_ID = '33333333-3333-4333-8333-333333333333';

let dir: string;
let projectsDir: string;
let savedFlag: string | undefined;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'he-parity-'));
  projectsDir = join(dir, 'projects');
  await mkdir(join(projectsDir, 'proj'), { recursive: true });
  // claude 형식의 기록을 **한 벌만** 둔다. 하네스로 갈리는지(형식으로가 아니라)를 재기 위해서다.
  await writeFile(
    join(projectsDir, 'proj', `${SESSION_ID}.jsonl`),
    `${JSON.stringify({ isApiErrorMessage: true, timestamp: new Date().toISOString(), message: { content: 'rate limit' } })}\n`,
  );
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

/**
 * 켬·끔을 **턴 컨텍스트로** 표현한다(2026-09-15). env 를 지우고 넣는 방법은 기본값이
 * 켜짐으로 바뀐 순간 **같은 경로를 두 번 재는 것**이 된다 — "지웠으니 옛 경로겠지" 가
 * 조용히 거짓이 되고, 패리티 테스트는 그대로 초록이다. `executionPath`(#790)는 그
 * 기본값이 무엇이든 두 경로를 **직접** 가리키므로 그 함정이 없다.
 */
const onPath = <T>(enabled: boolean, fn: () => T): T =>
  runWithExecutionPath(enabled ? 'adapters' : 'legacy', fn);

/** 네 함수의 답을 한 번에 모은다 — 하나만 맞추면 나머지가 갈려도 초록이다. */
async function snapshot(harness: AgentHarness, enabled: boolean) {
  return onPath(enabled, async () => ({
    reads: readsSessionTranscript(harness),
    apiError: await readLastApiError(harness, SESSION_ID, { projectsDir }),
    mtime: (await sessionTranscriptMtimeMs(harness, SESSION_ID, { projectsDir })) !== null,
    grew: await sessionTranscriptGrewSince(harness, SESSION_ID, 0, { projectsDir }),
    // 이 함수는 projectsDir 을 안 받고 configDir 을 받는다 — 없는 자리를 줘서 "못 찾음"을 만든다.
    materialized: await claudeSessionMaterialized(harness, SESSION_ID, join(dir, 'no-such-config')),
  }));
}

describe('세션 기록 판정 — 옛 경로와 새 경로가 같다', () => {
  for (const harness of RUNNABLE) {
    it(`${harness}: 네 함수의 답이 모두 같다`, async () => {
      const old = await snapshot(harness, false);
      const now = await snapshot(harness, true);
      expect(now).toEqual(old);
    });
  }

  it('claude 는 실제로 읽는다 — 둘 다 못 읽어서 같은 것이 아니다', async () => {
    for (const enabled of [false, true]) {
      const snap = await snapshot('claude-code', enabled);
      expect(snap.reads).toBe(true);
      expect(snap.apiError).toEqual({ text: 'rate limit' });
      expect(snap.mtime).toBe(true);
      expect(snap.grew).toBe(true);
    }
  });

  it('codex 는 같은 기록을 두고도 읽지 않는다 — 형식이 아니라 하네스로 갈린다', async () => {
    for (const enabled of [false, true]) {
      const snap = await snapshot('codex', enabled);
      expect(snap.reads).toBe(false);
      expect(snap.apiError).toBeNull();
      expect(snap.mtime).toBe(false);
      // **판정 불가는 참이다** — 거짓을 돌려주면 그 턴들이 매번 사람을 부른다.
      expect(snap.grew).toBe(true);
      expect(snap.materialized).toBe(true);
    }
  });

  it('opencode 는 CLI 갈래라 거짓이다 — 물어볼 수 있는 것과 읽을 줄 아는 것은 다르다', () => {
    // 새 경로에서만 뜻이 있는 값이다(옛 경로는 이름으로 갈라 역시 거짓). 둘 다 확인한다.
    expect(onPath(false, () => readsSessionTranscript('opencode'))).toBe(false);
    expect(onPath(true, () => readsSessionTranscript('opencode'))).toBe(false);
  });
});
