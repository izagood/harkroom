// codex 어댑터. `claudeCode.ts` 와 같은 규율 — **지금 프로덕션이 쓰는 값을 옮긴 것**이고
// 동일성은 `test/adapterParity.test.ts` 가 지킨다.
import { GATE_PATTERN } from './gate.js';
import type { HarnessAdapter } from './contract.js';

export const CODEX_ADAPTER: HarnessAdapter = {
  harness: 'codex',
  command: 'codex',

  /**
   * **`mention: 'exec'` 은 목표가 아니라 현재 상태다.**
   *
   * TUI 캡슐화가 murmur 의 전제이고 codex 의 exec 는 개발 과정의 산물이다. 이 값이 `'tui'`
   * 로 바뀌는 데 필요한 것은 이미 대체로 갖춰져 있다:
   * - 신뢰 대화상자 — `workspaceTrust.ts::trustForCodex` 가 격리된 `<CODEX_HOME>/config.toml`
   *   에 `trust_level = "trusted"` 를 적고, `ensureWorkspaceTrusted` 가 codex 에도 배선돼 있다.
   *   (이것이 없어서 P5 를 보류했다는 판단이 한때 있었는데, 그 사이 구현됐다.)
   * - 준비 신호 — 아래 `screen.ready` 가 실물 화면 fixture(`codex-tui-ready.txt`)로 고정돼 있다.
   *
   * 남은 것은 **실물 왕복 확인**뿐이다(부팅 → 준비 → 주입 → 발화 → resume → 중단). 그
   * 확인이 끝나기 전에 이 값을 바꾸면 안 된다 — 켜는 것은 이 표 한 줄이지만, 그 한 줄이
   * 프로덕션의 모든 codex 멘션 턴을 동시에 바꾼다.
   */
  executionModel: { mention: 'exec', interactive: 'tui' },

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
