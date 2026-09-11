// 하네스 어댑터 계약 — **러너가 하네스에 대해 아는 사실 전부**를 한 표로 모은다.
//
// ## 왜 이 파일이 있는가
//
// murmur 는 하네스의 **출력을 파싱하지 않는다.** 발화·진행·중단·질문은 에이전트가 murmur
// MCP 도구로 직접 한다. 그래서 하네스에 요구할 것은 넷뿐이다: TUI 로 뜬다 / 준비 신호를
// 화면에 낸다 / bracketed paste 로 프롬프트를 받는다 / MCP 서버 하나를 붙일 수 있다.
// 그 넷이 이 계약의 T0 이고, 나머지(관측·계정·부가)는 **없어도 도는** 층이다.
//
// 지금 그 사실들은 `turn.ts` 의 `HarnessPreset`(argv 부분)에만 표로 있고, 나머지는
// `harness === 'claude-code'` **이름 비교로 일곱 파일에 흩어져 있다**(mentionTurn·pty·
// workspaceTrust·harnessErrors·policy·interactiveTurn·claudeAccounts). 하네스가 셋째로
// 늘어나는 순간 그 일곱 곳을 매번 다시 찾아야 한다 — 이 표는 그 탐색을 없애기 위한 것이다.
//
// ## 이 파일은 **로직을 갖지 않는다**
//
// 담는 것은 값(정규식·환경변수 이름·파일 이름·갈래 태그)뿐이다. 판정 함수는 지금 있는
// 자리(`pty.ts::looksReadyForPrompt`, `workspaceTrust.ts` 등)에 그대로 두고, 이 표는 그
// 함수들이 **무엇을 재료로 쓰는지**만 선언한다. 로직을 여기로 복사하면 같은 규칙이 두
// 벌이 되고, 그 순간 나중에 한쪽만 고치는 사고가 난다 — 이 저장소가 이미 여러 번 지목한
// 실패 모양이다(`claudeSessions.ts` 의 "같은 탐색 규칙이 두 벌이 되면" 주석).
//
// ## 검증 전략 — 옛 경로를 남긴다
//
// 이 표는 **아직 아무 호출부도 읽지 않는다.** 대신 `test/adapterParity.test.ts` 가 표의 각
// 값이 지금 프로덕션이 쓰는 값과 **같은 답을 내는지** 하네스×모드 전수로 대조한다. 그래서
// 이 파일이 들어와도 claude 경로는 글자 하나 바뀌지 않는다. 호출부를 옮기는 것은 다음
// 조각이고, 그때도 `harnessAdaptersEnabled()`(index.ts) 뒤에서 켠다.
import type { AgentHarness, MentionPermission } from '@murmur/shared';

/**
 * 하네스를 **어떤 모드로 띄우는가**. 하네스의 성질이 아니라 실행 방식이다 — 같은 codex 가
 * 멘션 턴에서는 `codex exec`, 인터랙티브 턴에서는 `codex` TUI 로 뜬다.
 *
 * - `'tui'` — 대화형 화면으로 띄우고 프롬프트를 **PTY 에 주입**한다(bracketed paste).
 *   자식의 fd 0 이 PTY 라서 **사람이 그 턴에 끼어들 수 있다**(`pty.ts::acceptsPtyInput`).
 * - `'exec'` — 프롬프트를 stdin 파일로 주고 `sh -c '… < 파일'` 로 감싼다. 그 순간 fd 0 이
 *   일반 파일이 되어 사람이 칠 수 없다(관찰 전용). **본선이 아니다** — TUI 캡슐화가
 *   murmur 의 전제이고, 이 갈래는 준비 신호를 아직 측정하지 못한 하네스의 임시 발판이다.
 */
export type ExecutionModel = 'tui' | 'exec';

/**
 * 하네스가 이 워크스페이스를 신뢰하도록 **미리 적어 두는 장부**. 묻게 두면 러너는 답할
 * 수 없고 그 대화상자가 준비 표시를 가려 프롬프트가 모달에 타이핑된다(`workspaceTrust.ts`).
 *
 * `root` 가 계정 축과 맞물린다: claude 의 장부는 `CLAUDE_CONFIG_DIR` 를 따라가므로 계정마다
 * 따로 적어야 하고, codex 의 장부는 러너별 격리 `CODEX_HOME` 안에 있다.
 */
export interface TrustLedger {
  kind: 'claude-json' | 'codex-toml';
  /** 장부가 사는 뿌리. `'account-config-dir'` 는 계정마다 따로, `'codex-home'` 은 러너마다 따로. */
  root: 'account-config-dir' | 'codex-home';
  /** 뿌리 아래의 파일 이름. */
  file: string;
}

/** 세션 기록(transcript/rollout)에서 무엇을 읽을 수 있는가. `null` 은 **모른다**이지 "없다"가 아니다. */
export interface TranscriptSource {
  /** 기록 뿌리가 계정 config 디렉터리 아래 어디인가(예: `projects`). */
  dirUnderConfig: string;
  /**
   * 뿌리 아래 배치. `'flat'` 은 한 겹(claude 의 프로젝트 디렉터리), `'by-date'` 는 날짜로
   * 중첩된다(codex 의 `<yyyy>/<mm>/<dd>/`). 찾는 코드가 재귀로 훑어야 하는지가 여기서 갈린다.
   */
  layout: 'flat' | 'by-date';
  /** 한 세션의 파일 이름 규칙. `<id>` 가 세션 id 자리다. 값 자체를 쓰지 않고 사람이 읽는다. */
  fileName: string;
  /**
   * 이 형식을 **읽는 코드가 있는가**. claude 의 JSONL 은 `harnessErrors.ts` 가 해석하지만
   * codex 의 rollout 은 형식이 달라 아직 해석하지 않는다 — 그때는 `false` 다.
   *
   * 거짓이면 정지·API 에러 탐침이 돌지 않고 화면은 "모른다"로 그린다. **없는 것을 있다고
   * 표시하지 않는다**(design.md §4)가 이 필드의 근거다.
   */
  parsed: boolean;
}

/** 계정 축. 계정 하나 = 이 환경변수가 가리키는 디렉터리 하나다. `null` 은 계정 축이 없다는 뜻. */
export interface AccountAxis {
  /** 자격증명·세션·설정을 한꺼번에 바꾸는 환경변수. */
  configDirEnv: 'CLAUDE_CONFIG_DIR' | 'CODEX_HOME';
  /**
   * 계정 풀을 **관리하는 표면이 있는가**(목록·로그인·사용량·페일오버). claude 만 참이다 —
   * codex 는 `ensureCodexHome` 이 `~/.codex/auth.json` 을 링크해 **계정 하나**로 돈다.
   *
   * 거짓인 하네스에 풀 선택을 그리면 화면이 거짓말을 한다: 사람은 배정했고 화면은 배정됐다고
   * 말하는데 러너는 그 값을 버린다(`mentionTurn.ts` 의 `claudeAccount` 분기).
   */
  pooled: boolean;
}

/**
 * 하네스 하나에 대해 러너가 아는 사실 전부. **T0 만 필수**다 — 나머지가 `null` 이어도
 * 그 하네스는 돈다(관측이 없으면 "모른다"로 그리고, 계정 축이 없으면 계정 하나로 돈다).
 */
export interface HarnessAdapter {
  readonly harness: AgentHarness;

  // ── T0: 없으면 못 붙인다 ──────────────────────────────────────────────────────

  /** 실행 파일 이름. 하네스 값과 다를 수 있다 — `'claude-code'` 의 실행 파일은 `claude` 다. */
  readonly command: string;
  /** 모드별 실행 방식. **본선은 둘 다 `'tui'`** 다(§ExecutionModel). */
  readonly executionModel: Readonly<Record<'mention' | 'interactive', ExecutionModel>>;
  /** 화면 계약. `pty.ts` 의 판정 함수가 재료로 쓰는 정규식이다. */
  readonly screen: {
    /** 채팅 입력창에만 있는 **긍정** 신호. 이것을 봐야 프롬프트를 넣는다. */
    readonly ready: RegExp;
    /** 턴 도중 사람에게 묻는 화면. */
    readonly gate: RegExp;
    /**
     * `gate` 를 **이 하네스의 실물 화면으로 재 봤는가**. codex 는 거짓이다(스펙
     * `2026-09-08-tui-attention-design.md` §"codex 의 관문"). 지금 동작은 두 하네스가 같은
     * 패턴을 쓰는 것이고, 이 필드는 그중 어느 쪽이 **측정된 사실**인지를 가른다.
     */
    readonly gateMeasured: boolean;
  };
  /** 신뢰 장부. */
  readonly trust: TrustLedger;
  /** MCP 를 등록하는 수단. `'config-file'` 은 파일 경로 하나, `'cli-overrides'` 는 `-c` 키들. */
  readonly mcpRegistration: 'config-file' | 'cli-overrides';
  /**
   * 지시문 전달 수단. `'flag-file'` 은 전용 플래그로 파일을 준다(claude 의
   * `--append-system-prompt-file`), `'prompt-prefix'` 는 그런 플래그가 없어 프롬프트 앞에
   * 접두하는 것뿐이다(codex, 실측).
   */
  readonly systemPromptDelivery: 'flag-file' | 'prompt-prefix';
  /** 세션 id 를 사전 할당할 수 없는가. 참이면 첫 턴은 id 없이 시작하고 끝난 뒤 발견한다. */
  readonly allowsNullSessionOnFirstTurn: boolean;
  /** 멘션 권한 갈래를 이 하네스의 플래그로 옮길 수 있는가. 전 갈래를 지원해야 T0 을 만족한다. */
  readonly supportedMentionPermissions: readonly MentionPermission[];

  // ── T1: 없으면 "모른다"로 그린다 ──────────────────────────────────────────────

  readonly transcript: TranscriptSource | null;

  // ── T2: 없으면 계정 하나로 돈다 ──────────────────────────────────────────────

  readonly account: AccountAxis | null;

  // ── T3: 없으면 기본값으로 돈다 ───────────────────────────────────────────────

  /** effort 를 넘기는 수단. `null` 은 그 하네스에 해당 개념이 없다는 뜻. */
  readonly effort: { via: 'flag'; flag: string } | { via: 'config-override'; key: string } | null;
  /** 스킬을 링크할 워크스페이스 상대 경로들. 하네스가 실제로 스캔하는 자리만 적는다. */
  readonly skillDirs: readonly string[];
  /** 인터랙티브 이어받기가 열려 있는가. 거짓이면 그 사유가 사람에게 간다. */
  readonly interactiveHandoff: boolean;
}
