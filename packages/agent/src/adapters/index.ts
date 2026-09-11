// 어댑터 등록부와 **전환 스위치**.
//
// ## 옛 경로를 남긴다 (2026-09-10 결정)
//
// claude-code 가 안 돌면 murmur 앱 자체를 쓸 수 없다. 그래서 이 표를 들이는 것과 호출부를
// 이 표로 옮기는 것을 **분리한다**:
//
// 1. (이 커밋) 표를 만들고, 표의 값이 지금 프로덕션과 **같은 답을 내는지** 패리티 테스트로
//    대조한다. 호출부는 하나도 바뀌지 않는다 — claude 경로는 글자 하나 안 바뀐다.
// 2. (다음) 호출부를 하나씩 `harnessAdaptersEnabled()` 뒤로 옮긴다. 기본값이 꺼짐이므로
//    켜지 않은 러너는 계속 옛 경로로 돈다.
// 3. 실물 검증(멘션 턴 왕복·인터랙티브·중단·계정 전환)이 끝난 뒤 기본값을 켜고, 그다음
//    릴리스에서 옛 분기를 걷는다.
//
// **스위치를 1단계에 함께 넣는 이유**: 나중에 넣으면 그 커밋이 "표를 읽게 바꾸는 것"과
// "스위치를 만드는 것" 두 변경을 겹치게 되고, 문제가 났을 때 어느 쪽 탓인지 가릴 수 없다.
import type { AgentHarness } from '@murmur/shared';

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
  if (!harnessAdaptersEnabled()) return harness === 'claude-code';
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
  if (!harnessAdaptersEnabled()) return harness === 'claude-code';
  return adapterFor(harness).account?.pooled === true;
}

/**
 * **첫 턴을 세션 id 없이 시작하는가** — 참이면 턴이 끝난 뒤 러너가 id 를 **발견**해야 한다.
 *
 * `turn.ts::HarnessPreset.allowsNullSessionOnFirstTurn` 과 같은 사실이고, 표가 이미 그 값을
 * 갖고 있다. 옛 비교(`harness === 'codex'`)는 "codex 만 그렇다"를 하드코딩한 것이었다.
 */
export function discoversSessionIdAfterTurn(harness: AgentHarness): boolean {
  if (!harnessAdaptersEnabled()) return harness === 'codex';
  return adapterFor(harness).allowsNullSessionOnFirstTurn;
}

/**
 * 이 하네스의 어댑터. 구현이 없으면 **던진다** — 호출자가 `RUNNABLE_HARNESSES` 를 확인하지
 * 않은 결함이라는 뜻이고, 조용히 기본값을 지어내면 그 결함이 엉뚱한 자리에서 드러난다
 * (`turn.ts::buildTurnCommand` 가 같은 규율을 쓴다).
 */
export function adapterFor(harness: AgentHarness): HarnessAdapter {
  const adapter = ADAPTERS[harness];
  if (adapter === 'unsupported') {
    throw new Error(
      `adapterFor: ${harness} 는 어댑터가 없다 — 호출자가 RUNNABLE_HARNESSES 를 확인하지 않았다`,
    );
  }
  return adapter;
}

/**
 * 러너가 **어댑터 표를 읽어 동작할 것인가**. 기본값은 **꺼짐**이다.
 *
 * 켜는 방법은 `MURMUR_HARNESS_ADAPTERS=1`(러너 env). 데몬이 러너 env 를 통째로 상속시키므로
 * 운영자가 데몬 환경에 넣으면 그 기계의 모든 러너가 새 경로로 돈다 — 한 기계에서 먼저
 * 켜 보고 넘어가는 것이 이 설계가 의도한 검증 순서다.
 *
 * `'1'`·`'true'` 만 켜짐으로 읽는다. 오타로 켜지지 않게 하려는 것이다 — 이 스위치가
 * 실수로 켜지면 claude 경로가 통째로 바뀐다.
 */
export function harnessAdaptersEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  const raw = env.MURMUR_HARNESS_ADAPTERS;
  return raw === '1' || raw === 'true';
}
