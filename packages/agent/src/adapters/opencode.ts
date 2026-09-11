// opencode 어댑터 (`opencode 1.18.24` 실측, 2026-09-11).
//
// **아직 `RUNNABLE_HARNESSES` 에 없다.** 표에 있는 것과 러너가 돌리는 것은 다른 문제이고,
// 그 둘을 가르는 기준은 이 저장소가 이미 정해 뒀다 — *"실물 CLI 로 첫 턴 + resume 왕복이
// 도는 것을 봤는가"*(`shared/src/index.ts::RUNNABLE_HARNESSES`). 그 왕복을 아직 안 봤다.
//
// 못 본 것을 아래에 그대로 남겼다(`null`·좁은 목록·`parsed: false`). 지어내면 그 값이
// 러너의 판단이 되고, 틀렸을 때 원인이 이 파일이라는 단서가 어디에도 안 남는다.
//
// 측정 전문과 아직 안 잰 목록: `docs/specs/2026-09-11-opencode-measurement.md`
import { GATE_PATTERN } from './gate.js';
import type { HarnessAdapter } from './contract.js';

export const OPENCODE_ADAPTER: HarnessAdapter = {
  harness: 'opencode',
  command: 'opencode',

  // **TUI 가 기본 커맨드다** — `opencode [project]` 가 곧 TUI 이고, `run` 이 오히려 별
  // 서브커맨드다. murmur 의 전제(TUI 캡슐화)에 셋 중 가장 잘 맞는다.
  executionModel: { mention: 'tui', interactive: 'tui' },

  screen: {
    // 입력 자리표시자 `Ask anything…`(U+2026). fixture: `test/fixtures/opencode-tui-ready.txt`.
    //
    // **현재 `DEFAULT_READY_PATTERN` 에는 안 걸린다** — claude 의 `❯`+U+00A0 도 codex 의
    // `Ask … to do anything` 도 아니다. 화면 계약을 하네스별로 갈라야 하는 실물 근거이고,
    // 그 회귀선이 `test/adapterParity.test.ts` 에 있다.
    ready: /Ask anything…/,
    gate: GATE_PATTERN,
    gateMeasured: false,
  },

  // **신뢰 관문이 없다**(실측): `git init` 한 빈 임시 디렉터리에서 묻지 않고 바로 입력창까지
  // 갔다. codex 처럼 적어 둘 장부가 없으므로 `null` 이다 — 없는 파일을 만들지 않는다.
  // (git 저장소가 아닌 디렉터리는 아직 안 재 봤다. `certify` 의 일이다.)
  trust: null,

  // `opencode mcp add` 가 `~/.config/opencode/opencode.json` 에 쓴다. **턴별로 넘기는 수단을
  // 아직 못 찾았다** — 그래서 `'account-config'` 다. 이 갈래의 성질과 그로부터 생기는 격리
  // 숙제는 `contract.ts` 의 `mcpRegistration` 주석에 적었다.
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
   * `mentionPermission: 'readonly'` 로 만든 에이전트를 돌릴 수 없으면 그 하네스는 murmur 의
   * 권한 모델을 절반만 만족한다.
   */
  supportedMentionPermissions: ['auto'],

  /**
   * 세션이 **SQLite** 에 있다(`<data>/opencode.db`). 파일 경로로 표현할 수 없어 CLI 갈래를
   * 쓴다 — 이 갈래가 생긴 이유 자체가 이 하네스다(`contract.ts::TranscriptSource`).
   *
   * `parsed: false` — 명령이 있다는 것만 확인했고 출력 형식을 읽는 코드는 없다.
   */
  transcript: {
    kind: 'cli',
    list: ['session', 'list'],
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

  // `--variant`("provider-specific reasoning effort, e.g. high, max, minimal"). murmur 의
  // 다섯 값과 어떻게 맞물리는지는 미측정 — codex 의 `model_reasoning_effort` 와 같은 상태다.
  effort: { via: 'flag', flag: '--variant' },
  // `opencode debug skill` 로 목록은 보이지만 **링크할 자리를 아직 못 쟀다**. 빈 목록은
  // "스킬을 안 붙인다"는 뜻이고, 지금으로서는 그것이 사실이다.
  skillDirs: [],
  // 미측정. 이어받기는 실물 왕복을 본 뒤에야 참이라고 말할 수 있다.
  interactiveHandoff: false,
};
