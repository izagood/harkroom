// opencode 어댑터 (`opencode 1.18.31` 실측, 2026-09-22 — 2차).
//
// 1차(2026-09-11)에는 표만 있고 러너가 안 돌렸다. 이번에 실물로 재고 `RUNNABLE_HARNESSES`
// 에 넣었다 — MCP 연결(스디오 브릿지) · 붙여넣기 주입 · 읽기 전용 에이전트 · 세션 발견.
//
// **1차의 MCP 측정은 폐기됐다.** 그때는 원격 URL + Bearer 토큰으로 붙였는데, 오퍼레이터
// 설계(2026-09-20) 이후 하네스는 서버 주소도 토큰도 모른다 — 지금 길은 stdio 브릿지뿐이다.
//
// 아직 못 잰 것은 그대로 남긴다(`parsed` 를 켰지만 `interactiveHandoff` 는 거짓이다).
//
// 측정 전문과 아직 안 잰 목록: `docs/specs/2026-09-11-opencode-measurement.md`
import { GATE_PATTERN } from './gate.js';
import type { HarnessAdapter } from './contract.js';

export const OPENCODE_ADAPTER: HarnessAdapter = {
  harness: 'opencode',
  command: 'opencode',

  // **TUI 가 기본 커맨드다** — `opencode [project]` 가 곧 TUI 이고, `run` 이 오히려 별
  // 서브커맨드다. harkroom 의 전제(TUI 캡슐화)에 셋 중 가장 잘 맞는다.
  executionModel: { mention: 'tui', interactive: 'tui' },

  screen: {
    // 입력 자리표시자 `Ask anything…`(U+2026). fixture: `test/fixtures/opencode-tui-ready.txt`.
    //
    // **현재 `DEFAULT_READY_PATTERN` 에는 안 걸린다** — claude 의 `❯`+U+00A0 도 codex 의
    // `Ask … to do anything` 도 아니다. 화면 계약을 하네스별로 갈라야 하는 실물 근거이고,
    // 그 회귀선이 `test/adapterParity.test.ts` 에 있다.
    // 실측 2.5~2.7초에 뜬다(1차의 "30초"는 옛 판본이었다). 말줄임표는 판본에 따라 U+2026
    // 이기도 `...` 이기도 해서 **문구만** 본다.
    ready: /Ask anything/,
    gate: GATE_PATTERN,
    gateMeasured: false,
  },

  // **신뢰 관문이 없다**(실측): `git init` 한 빈 임시 디렉터리에서 묻지 않고 바로 입력창까지
  // 갔다. codex 처럼 적어 둘 장부가 없으므로 `null` 이다 — 없는 파일을 만들지 않는다.
  // (git 저장소가 아닌 디렉터리는 아직 안 재 봤다. `certify` 의 일이다.)
  trust: null,

  // 턴별로 넘기는 수단이 없다 — 설정 파일뿐이다. 그래서 러너 전용 XDG 루트를 만들고 거기에
  // 적는다(`opencodeHome.ts`). 그 격리가 claude 의 `--strict-mcp-config` 자리를 대신한다.
  mcpRegistration: 'account-config',

  // 지시문 전용 플래그를 `--help` 에서 못 찾았다. TUI 에 주입하는 이상 프롬프트 앞에 붙이는
  // 길은 언제나 있으므로 그것으로 적는다 — `--agent` 나 config 의 instructions 로 더 나은
  // 길이 있는지는 미측정이다.
  systemPromptDelivery: 'prompt-prefix',

  // `opencode session` 에 `list`·`delete` 만 있고 `create` 가 없다 → 첫 턴은 id 없이 시작하고
  // 끝난 뒤 발견해야 한다(codex 와 같은 갈래).
  allowsNullSessionOnFirstTurn: true,

  /**
   * **`auto` 만 적는다 — `readonly` 의 수단을 아직 못 쟀다.**
   *
   * `--auto` 는 실물로 확인했다("auto-approve permissions that are not explicitly denied").
   * 읽기 전용에 해당하는 것은 `--agent` 로 고르는 에이전트일 수도, config 의 permission
   * 키일 수도 있는데 어느 쪽인지 모른다.
   *
   * **이 목록이 불완전한 것이 지금 opencode 가 `RUNNABLE_HARNESSES` 에 없는 이유 중 하나다** —
   * `mentionPermission: 'readonly'` 로 만든 에이전트를 돌릴 수 없으면 그 하네스는 harkroom 의
   * 권한 모델을 절반만 만족한다.
   */
  supportedMentionPermissions: ['auto', 'readonly'],

  /**
   * 세션이 **SQLite** 에 있다(`<data>/opencode.db`). 파일 경로로 표현할 수 없어 CLI 갈래를
   * 쓴다 — 이 갈래가 생긴 이유 자체가 이 하네스다(`contract.ts::TranscriptSource`).
   *
   * `parsed: false` — **대화 기록을 읽지 않는다는 뜻이다.** `--format json` 으로 세션
   * **목록**은 읽어 턴 뒤 id 를 찾지만(`opencodeSessions.ts`), 그것은 기록의 내용이 아니라
   * 목차다. 이 필드가 참이면 `readLastApiError` 가 그 하네스의 기록에서 API 에러를 읽어
   * 낸다는 뜻이고, opencode 에서는 그 길이 없다 — 그래서 정지 판정도 화면 바이트로 선다.
   */
  transcript: {
    kind: 'cli',
    list: ['session', 'list', '--format', 'json'],
    export: ['export', '<id>'],
    stats: ['stats'],
    parsed: false,
  },

  /**
   * **셋을 함께 줘야 움직인다**(실측). 하나만 주면 자격증명은 갈리는데 세션은 공유되는
   * 반쪽 격리가 되고, 그 상태는 조용하다. `OPENCODE_CONFIG_DIR` 는 이름이 있지만 이 경로들을
   * 바꾸지 않는다(실측) — 이름만 보고 고르면 안 되는 자리다.
   *
   * auth 는 `<data>/auth.json` 0600 으로, codex 의 `auth.json` 과 같은 모양이다. 그래서
   * `ensureCodexHome` 의 "로그인만 링크로 재사용" 수법이 그대로 옮겨진다 — 풀을 만들 때
   * (T2) 이 사실이 지름길이 된다.
   */
  account: {
    configDirEnv: ['XDG_CONFIG_HOME', 'XDG_DATA_HOME', 'XDG_STATE_HOME'],
    pooled: false,
  },

  // `--variant`("provider-specific reasoning effort, e.g. high, max, minimal"). harkroom 의
  // 다섯 값과 어떻게 맞물리는지는 미측정 — codex 의 `model_reasoning_effort` 와 같은 상태다.
  effort: { via: 'flag', flag: '--variant' },
  // `opencode debug skill` 로 목록은 보이지만 **링크할 자리를 아직 못 쟀다**. 빈 목록은
  // "스킬을 안 붙인다"는 뜻이고, 지금으로서는 그것이 사실이다.
  skillDirs: [],
  // 미측정. 이어받기는 실물 왕복을 본 뒤에야 참이라고 말할 수 있다.
  interactiveHandoff: false,
};
