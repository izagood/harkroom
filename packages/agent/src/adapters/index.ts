// 어댑터 등록부와 **전환 스위치**.
//
// ## 옛 경로를 남긴다 (2026-09-10 결정)
//
// **이 표가 유일한 경로다**(2026-09-18). 하네스 이름으로 갈리던 옛 분기도, 그것을 켜고 끄던
// 스위치(`harnessAdaptersEnabled` · `HARKROOM_HARNESS_ADAPTERS` · 에이전트별 `executionPath`)도
// 이 릴리스에서 지웠다.
//
// 그 이설은 세 걸음이었다: ① 표를 만들고 패리티 테스트로 값을 대조 ② 호출부를 스위치 뒤로
// 옮기고 에이전트 하나씩 실물로 확인 ③ 기본값 전환 → 며칠 → 옛 분기 삭제. 그 순서를 지킨
// 이유와 각 걸음에서 데인 것은 스킬 `runner-harness-work` 에 적혀 있다.
//
// 새 하네스를 붙이는 사람에게 남기는 말: **이름으로 갈리는 분기를 다시 심지 마라.** 그 예산은
// `test/adapterParity.test.ts` 가 파일별로 세고 있고, 늘어나면 거기서 걸린다.
import type { AgentHarness } from '@harkroom/shared';


import { CLAUDE_CODE_ADAPTER } from './claudeCode.js';
import { CODEX_ADAPTER } from './codex.js';
import { OPENCODE_ADAPTER } from './opencode.js';
import type { ExecutionModel, HarnessAdapter } from './contract.js';

export type { HarnessAdapter, ExecutionModel, TrustLedger, TranscriptSource, AccountAxis } from './contract.js';
export { GATE_PATTERN } from './gate.js';

/**
 * 하네스별 어댑터. `'unsupported'` 는 **이름은 스키마에 있으나 구현이 없다**는 뜻이고,
 * `turn.ts::PRESETS` 의 같은 값과 짝을 이룬다 — 두 표가 어긋나면 패리티 테스트가 잡는다.
 */
export const ADAPTERS: Record<AgentHarness, HarnessAdapter | 'unsupported'> = {
  'claude-code': CLAUDE_CODE_ADAPTER,
  codex: CODEX_ADAPTER,
  // 표에는 있고 `RUNNABLE_HARNESSES` 에는 없다 — 그 둘은 다른 질문이다(어댑터 머리 주석).
  opencode: OPENCODE_ADAPTER,
  // `-r` 이 UUID 를 받지 못해 `--session-id` 와 짝을 이루지 못한다(실측, task-1).
  gemini: 'unsupported',
};

/**
 * **이 하네스의 세션 기록을 우리가 읽을 수 있는가.**
 *
 * 네 자리(`readLastApiError` · `sessionTranscriptMtimeMs` · `sessionTranscriptGrewSince` ·
 * `sessionMaterialized`)가 각자 `harness !== 'claude-code'` 로 묻던 **같은 질문 하나**다.
 * 넷이 따로 물으면 네 번째 하네스가 올 때 네 곳을 다 찾아야 하고, 그중 하나를 놓치면
 * "읽었다"는 거짓 신호가 생겨 아직 정상 동작하는 폴백을 가린다.
 *
 * ## 이설 중이다 — 옛 답을 그대로 돌려준다
 *
 * 스위치가 꺼져 있으면 **옛 비교를 그대로** 한다(`harness === 'claude-code'`). 켜면 표를
 * 읽는다: 기록이 파일이고(`kind: 'files'`) 그 형식을 **해석하는 코드가 있을 때**(`parsed`)만
 * 참이다. 두 답이 같다는 것은 `test/harnessErrorsParity.test.ts` 가 양쪽을 실제로 돌려
 * 지킨다. 옛 비교는 스위치가 기본 켜짐이 되고 한 판 돌려 본 뒤에 지운다.
 *
 * `'cli'` 갈래(opencode)가 거짓인 이유: 명령이 있다는 것만 알고 출력 형식을 읽는 코드는
 * 없다. 물어볼 수 있다는 것과 읽을 줄 안다는 것은 다른 사실이다.
 */
export function readsSessionTranscript(harness: AgentHarness): boolean {
  const transcript = ADAPTERS[harness] === 'unsupported' ? null : adapterFor(harness).transcript;
  return transcript !== null && transcript.kind === 'files' && transcript.parsed;
}

/**
 * **이 하네스의 멘션 턴을 TUI 로 띄우는가.**
 *
 * 이 한 줄에서 턴의 네 가지가 갈린다(`mentionTurn.ts`): 프롬프트가 주입이냐 stdin 파일이냐,
 * 사람이 그 턴에 칠 수 있느냐, 시간 한도를 무발화로 재느냐 프로세스 수명으로 재느냐,
 * 정지·에러 탐침을 도느냐. 그래서 이름 비교로 남겨 두면 안 되는 자리다.
 *
 * ## 이설 중이다 — 지금은 옛 답과 **같다**
 *
 * 스위치가 꺼져 있으면 옛 비교를 그대로 한다. 켜면 표를 읽는데, `CODEX_ADAPTER` 의
 * `executionModel.mention` 이 아직 `'exec'` 이므로 **두 답이 일치한다.** 그것이 이 조각의
 * 요구다 — 새 경로는 먼저 "같아야" 하고, codex 를 TUI 로 바꾸는 것은 그다음 결정이다.
 * 바꾸는 날 고칠 곳은 어댑터 표 한 줄이고, 그때 이 함수는 안 고친다.
 */
export function usesTuiForMention(harness: AgentHarness): boolean {
  return executionModelFor(harness, 'mention') === 'tui';
}

/**
 * **이 하네스는 지시문을 프롬프트 앞에 붙여야만 받는가.**
 *
 * `systemPromptDelivery` 는 처음부터 표에 있었고 `adapterParity.test.ts` 가 실제 argv 와
 * 대조까지 하고 있었는데, **그 값을 읽어 무엇을 보낼지 정하는 곳이 없었다.** 그 구멍이
 * 프로덕션에서 값을 치렀다(2026-09-14 실측, `codex-dev`): codex 를 TUI 로 올린 뒤
 * `mentionTurn` 은 주입 텍스트에 본문만 실었고 — 지시문은 `--append-system-prompt-file`
 * 이 있는 claude 만 받는 길이었다 — codex 턴은 **지시문 없이** 돌았다. 요청한 파일은
 * 만들어 놓고 `message.post` 는 부르지 않아 "답 없이 턴을 끝냈습니다"만 남았다.
 * 도구가 없어서가 아니다: 그 턴의 codex 로그에 harkroom MCP 가 정상 등록돼 있다.
 * 발화해야 한다는 것도, channelId·threadRootId 도 전부 지시문에 있었을 뿐이다.
 *
 * **실행 방식과 무관한 사실이다.** exec 이든 TUI 든 codex 는 지시문을 받을 플래그가 없다 —
 * 달라지는 것은 접두한 본문이 stdin 파일로 가느냐 PTY 로 주입되느냐뿐이다. 그래서
 * `usesTuiForMention` 과 갈라 둔다: 둘을 한 조건으로 묶으면 codex 를 exec 으로 되돌리는
 * 날 지시문이 다시 사라진다.
 *
 * 스위치를 보지 않는 이유는 `executionModelFor` 와 같다 — 여기에는 보존할 "옛 답"이 없다.
 * 옛 답이 곧 위의 버그다.
 */
export function prefixesSystemPrompt(harness: AgentHarness): boolean {
  return adapterFor(harness).systemPromptDelivery === 'prompt-prefix';
}

/**
 * **이 하네스를 이 모드에서 어떤 실행 방식으로 띄우는가.**
 *
 * `usesTuiForMention` 이 이것의 멘션 전용 얼굴이다. 갈라 둔 이유는 **argv 의 모양이 모드가
 * 아니라 실행 방식을 따라야** 하기 때문이다 — `turn.ts` 의 codex 프리셋이 그것을 읽는다.
 * 같은 codex 가 `codex exec` 로 뜰 때와 `codex`(TUI)로 뜰 때 **받는 플래그 집합이 다르다**
 * (실측, codex-cli 0.153.0): `--skip-git-repo-check` 와 `--ignore-user-config` 는 `exec`
 * 계열에만 있고 TUI(`codex`·`codex resume`)에는 **없다**. 모드로 판단하면 멘션 턴을 TUI 로
 * 올리는 순간 그 플래그들이 그대로 붙어 `unexpected argument` 로 죽는다.
 *
 * 스위치가 꺼져 있으면 **옛 답을 그대로** 준다(claude 는 양쪽 TUI, codex 는 멘션만 exec).
 * 켜면 표를 읽는다 — 그리고 표에서 codex 의 멘션이 이제 `'tui'` 다. **이것이 이 이설의
 * "추가" 다**: 새 경로는 claude 에 대해 옛 경로와 같고, codex 에 대해 TUI 로 올라간다.
 */
export function executionModelFor(harness: AgentHarness, mode: 'mention' | 'interactive'): ExecutionModel {
  /**
   * **스위치를 보지 않는다(2026-09-11, jaebin 의 순서).**
   *
   * 두 가지를 한 커밋에 겹치지 않기 위해서다:
   *   ① 기존 경로에서 codex 를 headless → TUI 로 올린다  ← 이 커밋
   *   ② 그다음 기존 경로 → 새 경로로 옮긴다(순수 리팩터)
   *
   * 앞 판본은 codex TUI 를 **새 경로에만** 넣었다. 그러면 스위치를 켜는 순간 *경로*와
   * *실행 방식*이 **동시에** 바뀌고, codex 턴이 깨졌을 때 어느 쪽 탓인지 가릴 수 없다.
   * 실행 방식을 스위치 밖으로 빼면 스위치는 **아무 동작도 바꾸지 않는 리팩터**가 되고,
   * 그 사실을 패리티 테스트가 증명할 수 있다.
   *
   * 그래서 이 함수에는 옛/새 갈림이 **없다.** 실행 방식은 하나뿐이고 표가 그것을 말한다 —
   * 다른 사실들(계정 풀·기록 판정·신뢰 장부)은 여전히 스위치 뒤에서 갈린다.
   */
  return adapterFor(harness).executionModel[mode];
}

/**
 * **이 하네스에 계정 풀 표면이 있는가** — 화면에 계정·풀 이름을 실을지의 판단.
 *
 * 없는 하네스에 이름을 실으면 화면이 **그 턴과 아무 상관 없는 계정**을 가리킨다. 생략은
 * "모른다"이고, 모르는 것으로 남기는 편이 틀린 것을 단언하는 것보다 낫다(릴레이 주석).
 */
export function hasAccountPool(harness: AgentHarness): boolean {
  return adapterFor(harness).account?.pooled === true;
}

/**
 * **첫 턴을 세션 id 없이 시작하는가** — 참이면 턴이 끝난 뒤 러너가 id 를 **발견**해야 한다.
 *
 * `turn.ts::HarnessPreset.allowsNullSessionOnFirstTurn` 과 같은 사실이고, 표가 이미 그 값을
 * 갖고 있다. 옛 비교(`harness === 'codex'`)는 "codex 만 그렇다"를 하드코딩한 것이었다.
 */
export function discoversSessionIdAfterTurn(harness: AgentHarness): boolean {
  return adapterFor(harness).allowsNullSessionOnFirstTurn;
}

/**
 * 이 하네스의 어댑터. 구현이 없으면 **던진다** — 호출자가 `RUNNABLE_HARNESSES` 를 확인하지
 * 않은 결함이라는 뜻이고, 조용히 기본값을 지어내면 그 결함이 엉뚱한 자리에서 드러난다
 * (`turn.ts::buildTurnCommand` 가 같은 규율을 쓴다).
 */
/**
 * 프롬프트를 **언제 넣고, 갔는지 어떻게 아는가** — 화면에 관한 두 사실(2026-09-14).
 *
 * `executionModelFor` 와 같은 규율으로 **스위치를 보지 않는다.** 이것은 경로의 차이가
 * 아니라 하네스의 성질이고(codex 는 어느 경로에서도 부팅 0.2초에 자리표시자를 그린다),
 * 실제로 옛 경로·새 경로가 같은 자리에서 똑같이 넘어졌다. 경로 뒤에 숨기면 한쪽만 고쳐진다.
 *
 * 표에 없으면 빈 값이다 — 그 하네스에는 이 그물을 치지 않는다는 뜻이고, claude 가 그렇다
 * (준비 표시가 실제 준비와 같고, 제출 확인은 세션 기록으로 이미 된다).
 */
export function injectionFactsFor(
  harness: AgentHarness,
): { readyMinMs?: number; unsentHint?: RegExp } {
  const { readyMinMs, unsentHint } = adapterFor(harness).screen;
  return { ...(readyMinMs ? { readyMinMs } : {}), ...(unsentHint ? { unsentHint } : {}) };
}

export function adapterFor(harness: AgentHarness): HarnessAdapter {
  const adapter = ADAPTERS[harness];
  if (adapter === 'unsupported') {
    throw new Error(
      `adapterFor: ${harness} 는 어댑터가 없다 — 호출자가 RUNNABLE_HARNESSES 를 확인하지 않았다`,
    );
  }
  return adapter;
}

