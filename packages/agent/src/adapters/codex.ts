// codex 어댑터. `claudeCode.ts` 와 같은 규율 — **지금 프로덕션이 쓰는 값을 옮긴 것**이고
// 동일성은 `test/adapterParity.test.ts` 가 지킨다.
import { GATE_PATTERN } from './gate.js';
import type { HarnessAdapter } from './contract.js';

export const CODEX_ADAPTER: HarnessAdapter = {
  harness: 'codex',
  command: 'codex',

  /**
   * **멘션 턴도 TUI 다(2026-09-11).** 이것이 이 이설의 "추가" 이고, 전환의 기준이다 —
   * TUI 캡슐화가 murmur 의 전제이고 `exec` 는 개발 과정의 산물이었다.
   *
   * `exec` 로 뜬 턴은 `sh -c '… < 파일'` 로 감싸여 fd 0 이 일반 파일이 된다. 그러면
   * `acceptsPtyInput` 이 거짓이라 **사람이 그 턴에 끼어들 수 없다**(관찰 전용). 터미널을
   * 보여 주는 이유가 개입인데 그 제약을 받아들일 근거가 없다.
   *
   * 이 한 줄이 바뀌면 턴의 네 가지가 함께 바뀐다(`usesTuiForMention` 을 읽는 자리들):
   * 프롬프트가 stdin 파일이 아니라 **PTY 주입**이 되고, 사람이 칠 수 있게 되고, 시간 한도를
   * **무발화**로 재고(프로세스 수명이 아니라), 정지·에러 탐침이 돌기 시작한다.
   *
   * **argv 도 함께 바뀐다 — 그쪽이 실제 일이었다.** `turn.ts` 의 이 프리셋은 모드가 아니라
   * `executionModelFor` 를 읽어 argv 를 조립한다: TUI 는 `codex` / `codex resume <id>` 이고
   * `--skip-git-repo-check`·`--ignore-user-config` 를 **못 받는다**(실측, 0.153.0 —
   * `codex --help` 와 `codex resume --help` 둘 다에 그 두 플래그가 없다).
   *
   * 그 둘이 하던 일은 다른 수단이 이미 대신한다:
   * - git 저장소 아님 → `workspaceTrust.ts::trustForCodex` 가 격리 홈의 `config.toml` 에
   *   `[projects."<경로>"] trust_level = "trusted"` 를 적는다. codex 가 거부하던 문구가
   *   *"Not inside a trusted directory and --skip-git-repo-check was not specified"* 였으니
   *   **신뢰가 적혀 있으면 그 조건이 이미 만족된다.**
   * - 운영자 개인 config 격리 → 러너별 `CODEX_HOME`(`ensureCodexHome`)이 한다.
   *
   * **아직 못 잰 것**: `codex exec` 가 만든 세션을 TUI `codex resume <id>` 가 이어받는지.
   * `--include-non-interactive` 는 "resume 피커와 `--last` 선택에 비대화형 세션을 포함"
   * 이라 명시돼 있어(실측) **명시적 id 로 이어받는 길과는 다른 축**으로 보이지만, 확인한
   * 것은 아니다. 스위치를 켠 첫 codex 턴이 **이미 exec 세션을 가진 스레드**일 때가 그
   * 위험이 드러나는 자리다 — 기본값이 꺼짐인 이유가 여기에도 있다.
   */
  executionModel: { mention: 'tui', interactive: 'tui' },

  screen: {
    // `Ask <이름> to do anything` 자리표시자. fixture: `test/fixtures/codex-tui-ready.txt`.
    ready: /Ask\s+\S+\s+to\s+do\s+anything/,
    gate: GATE_PATTERN,
    // **재 보지 않았다.** 같은 구조가 적용될 것으로 보지만 실물 화면이 없다
    // (`docs/specs/2026-09-08-tui-attention-design.md` §"codex 의 관문").
    gateMeasured: false,
  },

  // `<CODEX_HOME>/config.toml` 의 `[projects."<경로>"] trust_level = "trusted"`.
  // **러너별 격리 홈** 안이라 계정이 아니라 러너 단위다(claude 와 뿌리가 다른 이유).
  trust: { kind: 'codex-toml', root: 'codex-home', file: 'config.toml' },

  // `-c mcp_servers.<이름>.…` 오버라이드로 넣는다. 파일 경로를 받는 수단이 없다.
  mcpRegistration: 'cli-overrides',
  // 지시문 주입 플래그가 **없다**(실측) — 프롬프트 앞에 접두하는 방법뿐이다.
  systemPromptDelivery: 'prompt-prefix',
  // 세션 id 를 사전 할당할 수 없다. 첫 턴은 id 없이 시작하고 끝난 뒤 rollout 에서 발견한다.
  allowsNullSessionOnFirstTurn: true,
  supportedMentionPermissions: ['auto', 'readonly'],

  /**
   * `<CODEX_HOME>/sessions/<yyyy>/<mm>/<dd>/rollout-<ts>-<uuid>.jsonl`.
   *
   * **`parsed: false`** — `codexSessions.ts` 는 이 파일에서 세션 id 와 cwd 만 읽고, 내용
   * 형식(레코드 갈래)은 해석하지 않는다. 그래서 `harnessErrors.ts` 가 codex 에 대해 `null`
   * 을 주고, codex 턴에는 정지·API 에러 탐침이 돌지 않는다. 억지로 읽으면 "읽었다"는 거짓
   * 신호가 생겨 아직 정상 동작하는 tail 폴백을 가린다.
   */
  transcript: { kind: 'files', dirUnderConfig: 'sessions', layout: 'by-date', fileName: 'rollout-<ts>-<id>.jsonl', parsed: false },

  /**
   * 축은 있다 — `CODEX_HOME` 은 config·auth·sessions 를 한꺼번에 바꾸므로 claude 의
   * `CLAUDE_CONFIG_DIR` 과 **같은 성질**이다. 없는 것은 그 위의 **풀 관리 표면**이다:
   * 목록·로그인·사용량·페일오버가 claude 전용으로 지어져 있고, `ensureCodexHome` 은
   * `~/.codex/auth.json` 을 링크해 계정 하나로 돈다.
   *
   * `pooled: false` 가 화면에 곧바로 뜻이 있다: 이 값이 거짓인 하네스에 계정 풀 선택을
   * 그리면 사람은 배정했다고 믿고 러너는 그 값을 버린다(현재 `AgentsSettings.tsx` 가
   * 하네스를 보지 않아 정확히 그렇다).
   */
  account: { configDirEnv: ['CODEX_HOME'], pooled: false },

  // `--effort` 플래그가 없다. `-c model_reasoning_effort="…"` 로 넘긴다 — 키는 실측했지만
  // 받는 값 집합은 `xhigh` 하나만 봤다(`turn.ts` 의 "절반만 확인됐다").
  effort: { via: 'config-override', key: 'model_reasoning_effort' },
  // Codex 공식 repo-scope 경로. `.codex/skills` 는 스캔 대상이 아니다(`syncSkills` 가 예전
  // 구현이 만든 그 경로의 링크를 걷어낸다).
  skillDirs: ['.agents/skills'],
  // 멘션 턴(`codex exec`)이 만든 세션을 대화형 `codex resume` 이 이어받는지 실측되지 않았다.
  interactiveHandoff: false,
};
