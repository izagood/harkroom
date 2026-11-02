// 하네스마다 다른 CLI 를 명령 한 줄로 접는 표. 러너는 하네스의 출력을 해석하지 않는다 —
// 프로세스를 띄우고 끝날 때까지 기다릴 뿐이다(spec §2). 그래서 하네스 차이는 전부
// 데이터가 돼야 한다: `PRESETS` 가 그 표이고, `buildTurnCommand` 는 opts 를 보고
// `PRESETS[harness]` 를 찾아 조립만 한다. 여기서 harness 이름으로 분기하고 싶어지면
// 표에 필드가 빠진 것이다 — 필드를 더한다(claudeCode.ts 는 어댑터였고, 이건 표다).
//
// 값은 spec(`docs/specs/2026-09-01-runner-sessions-pty-design.md` §4)의 확정 표를 그대로
// 옮긴 것이다 — 스파이크(task-1)가 실측으로 확정했고, 초판의 추정 네 곳을 여기서 뒤집는다:
// codex 에 `-a` 가 없다(sandbox 단독), codex MCP 는 파일이 아니라 턴별 `-c` 오버라이드,
// claude 는 `--strict-mcp-config` 를 항상 받는다, gemini 는 이번 범위에서 미지원.
import { CODEX_LANE_BASE_URL_ENV, codexLaneArgs, LANE_TEST_HOME_ENV, PROVIDER_LANE_ARGV_ONLY_KEYS, PROVIDER_LANE_FIXED_ENV, providerLaneKeys } from './providerLane.js';
import { encodeLaneHookRules } from '@harkroom/shared/providerLane';
import { chmod, mkdir, readFile, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { delimiter, join } from 'node:path';
import {
  RUNNABLE_HARNESSES,
  harnessFallbackBinDirs,
  type AgentHarness,
  type MentionPermission,
} from '@harkroom/shared';
import { RUNNER_LINK_ENV, RUNNER_LINK_ENV_KEYS, RUNNER_TURN_CAUSE_ENV, RUNNER_TURN_ID_ENV, RUNNER_TURN_KEY_ENV } from '@harkroom/shared/runnerLink';
import type { TurnKeys } from './turnKeys.js';
import { validateToolRule } from '@harkroom/shared';

import { executionModelFor, readonlyToolsFor, turnKeyDeliveryOf, usesOmpHome, usesPiHome, usesXdgHome } from './adapters/index.js';
import { piSessionsDir } from './piHome.js';
import { ompDirs } from './ompHome.js';
import { OPENCODE_LANE_AGENT, OPENCODE_READONLY_AGENT, opencodeDirs, opencodeLaneHome } from './opencodeHome.js';

/**
 * 하네스가 harkroom MCP 에 닿는 길은 `harkroom-operator mcp-bridge` 하나다(스펙 2026-09-20 §5).
 * URL 도 토큰도 없다 — 브릿지가 러너 env(오퍼레이터 소켓·러너 id·secret)를 상속해 오퍼레이터에
 * 붙고, 오퍼레이터가 서버에 전달한다. claude(`writeMcpConfigOnce`)와 codex(`CODEX_PRESET.mcp`)
 * 양쪽이 **같은 명령**을 굽는다 — 옛 `mcpUrl()` 이 두 곳의 URL 정규화를 한 자리에 모았던 것과
 * 같은 이유다.
 */
export const MCP_BRIDGE_ARGS = ['mcp-bridge'] as const;

export type TurnMode = 'mention' | 'interactive';

export interface TurnPlan {
  command: string;
  args: string[];
  env: Record<string, string>;
  /** stdin 리다이렉션용 파일 경로. null 이면 PTY stdin 을 그대로 쓴다(인터랙티브·resume). */
  stdinFile: string | null;
  /**
   * 하네스를 띄울 cwd 가 작업 폴더가 아닐 때만 채운다(omp — 저장소 밖 빈 폴더, security B4). 부르는 쪽은
   * `plan.cwd ?? <작업 폴더>` 로 띄운다.
   */
  cwd?: string;
}

export interface BuildTurnCommandOptions {
  harness: AgentHarness;
  mode: TurnMode;
  /**
   * null 은 "아직 첫 턴을 못 돌렸다"다(sessions.ts 의 SessionRecord 와 같은 뜻). codex 의
   * 첫 멘션 턴에서만 유효한다 — codex 는 세션 id 를 사전 할당할 수 없어 첫 턴 후에야 안다.
   * claude 는 첫 턴도 러너가 미리 uuid 를 발급해 넘기므로 null 이 오면 호출자 결함이다.
   */
  sessionId: string | null;
  isFirstTurn: boolean;
  /** 매 턴 재주입되는 지시문(spec §3 — UI 수정이 세션 무효화 없이 다음 턴부터 반영되는 이유). */
  systemPrompt: string;
  /** 멘션 모드 전용. 인터랙티브엔 쓰지 않는다 — 사람이 터미널에서 직접 입력한다. */
  promptCtx: string;
  model: string | null;
  effort: string | null;
  mentionPermission: MentionPermission;
  mcpConfigPath: string;
  /**
   * `mcpConfigPath` 파일의 harkroom·avcs 를 뺀 나머지(`readExtraMcpServers`). claude 는 파일로 다
   * 받으므로 안 쓰고, codex 만 `-c mcp_servers.<name>.*` 로 받는다. 없으면 추가 항목 없음.
   */
  extraMcpServers?: Record<string, McpServerEntry>;
  /** systemPrompt 를 파일로 전달할 때 그 경로. null 이면 argv 에 직접 전달(하위 호환). */
  systemPromptFile?: string | null;
  /** stdin 리다이렉션용 파일 경로. null 이면 PTY stdin 을 그대로 쓴다(인터랙티브·resume). */
  stdinFile?: string | null;
  /**
   * `harkroom-operator` 실행 파일(스펙 2026-09-20 §5). 하네스의 harkroom MCP 항목이 이 명령의
   * `mcp-bridge` 갈래다 — claude 는 `mcp.json` 에, codex 는 `-c mcp_servers.harkroom.*` 에 굽는다.
   *
   * **필수다 — 선택 인자로 두지 않는다.** 에이전트가 답하는 유일한 경로가 harkroom MCP 의
   * `message.post` 다(prompt.ts 의 시스템 프롬프트가 그렇게 지시한다). harkroom MCP 없이 뜬 턴은
   * 에러 없이 그냥 돌다가 답을 못 하고, 러너는 "답 없이 턴을 끝냈습니다"만 남긴다 — 원인 단서가
   * 어디에도 안 남는 조용한 실패다. 그래서 이 값을 생략해 조용히 넘어가는 경로 자체를 두지
   * 않는다: 호출자가 안 채우면 타입 에러로, 넘겼는데 비어 있으면 즉시 예외로 죽는다.
   */
  operatorBin: string;
  /** 서버가 이 에이전트에 머지를 허락한 저장소(`GET /agent/merge-grants`). 비면 allow 규칙을 안 준다. */
  mergeRepos?: readonly string[];
  /** 소유자가 이 채널에 승인한 Claude Code allow 규칙(권한 요청 스레드 f61af808). auto 멘션 턴의 `--allowedTools` 에 붙는다. */
  toolAllows?: readonly string[];
  /** 「정확한 명령」 PreToolUse hook 을 인라인 `--settings` 로 단다(H③b, 기본 false). */
  commandHook?: boolean;
  /**
   * 턴 도중 사람이 앵커 스레드에 새로 쓴 글을 도구 호출마다 싣는 PostToolUse hook(`postToolHookEntry`)을 단다 — 값은 턴이 시작할 때
   * 본 마지막 seq(그 뒤 글만 싣는다). null·생략이면 달지 않는다. hook 을 내는 하네스(claude)만 쓰고 나머지는 무시한다.
   */
  postToolSinceSeq?: number | null;
  /**
   * Claude in Chrome 을 이 턴에 붙이는가(스레드 e8c8365d). `true` 일 때만 열고, 생략·false 는 **명시적으로 닫는다**
   * (`chromeTurnFor` 가 에이전트 값·머신 값을 합친다). 하네스 표의 `chrome` 이 없는 하네스는 무시한다.
   */
  chrome?: boolean;
  /** 서버가 이 에이전트에 api.call 을 허락한 연결(`GET /agent/api-grants`). 비면 allow 규칙을 안 준다. */
  apiConnectors?: readonly string[];
  /** 그중 다시 줄 수 있는 연결(`GET /agent/api-grants` 의 `delegatable`). 있으면 `grant.delegate` MCP 도구를 allow 한다. */
  apiDelegatable?: readonly string[];
  /** 개인 config.toml/MCP 를 상속하지 않는 Harkroom 전용 Codex 상태 루트. */
  codexHome: string;
  /**
   * opencode 의 러너 전용 XDG 루트(`opencodeHome.ts`). codex 의 `codexHome` 과 같은 자리이고
   * 같은 이유다 — 사람의 설정·세션과 갈라 두지 않으면 개인 MCP 가 에이전트 턴에 붙는다.
   */
  opencodeHome?: string;
  /** pi 의 러너 전용 상태 루트(`piHome.ts`, `PI_CODING_AGENT_DIR`). 같은 자리·같은 이유다. */
  piHome?: string;
  /**
   * 읽기 전용 멘션 턴의 **허용 도구 목록**(`piHome.ts::readonlyToolList`) — 어댑터의 `readonlyTools`
   * 가 있는 하네스(pi)에만 쓴다. 그 하네스의 읽기 전용 턴에 이 값이 없으면 **조립을 거절한다**:
   * pi 에는 다른 권한 장치가 없어, 목록 없이 뜨면 쓰기·셸이 다 열린 채 돈다.
   */
  readonlyToolList?: string | null;
  /** omp 의 러너 전용 상태 루트(`ompHome.ts`). */
  ompHome?: string;
  /** omp 턴의 cwd·agentDir — 스레드마다 고정한 자리(`ompHome.ts::ompThreadDirs`, B4·G1). */
  ompThread?: { cwd: string; agentDir: string };
  /** omp 가 `--add-dir` 로 붙일 작업 폴더. omp 는 cwd 가 작업 폴더가 아니라서 따로 받는다. */
  workspaceDir?: string;
  /**
   * 이 턴을 돌릴 claude 계정의 `CLAUDE_CONFIG_DIR`(`claudeAccounts.ts`). **`null` 은 '계정
   * 지정 없음'** 이고, 그때 자식은 시스템 기본(`~/.claude`)을 쓴다 — 계정 풀을 안 만든
   * 러너의 정상 경로다.
   *
   * `codexHome` 과 대칭이지만 타입이 다른 이유: `codexHome` 은 러너가 언제나 만들어 두므로
   * 빈 문자열이 곧 결함이지만(아래 검사가 그것을 던진다), 계정은 **없는 것이 정상**이다.
   */
  claudeConfigDir: string | null;
  /**
   * 이 턴을 띄운 메시지 id — 멘션 턴이면 그 멘션(`MentionTarget.mentionId`). 하네스 env 의
   * `RUNNER_TURN_CAUSE_ENV` 로 심어 브릿지가 서버까지 싣는다. 서버는 여기서 연쇄 깊이를
   * 물려받는다(사람이 다른 채널에서 시킨 일도 "사람이 시작한 사슬"로 센다).
   *
   * 없으면(대화형 턴) **빈 문자열로 덮는다** — 러너 env 에 옛 값이 남아 있으면 그것을 물려받아
   * 엉뚱한 메시지를 원인으로 대게 되고, 키를 아예 빼면 codex `env_vars` 가 없는 이름을 보게 된다.
   */
  causeMessageId?: string | null;
  /**
   * 이 턴의 id(`RUNNER_TURN_ID_ENV`, 2026-10-12). 러너가 턴마다 새로 만든다 — 서버가 이 턴의 발화에 `meta.turnId` 로 적고,
   * 러너가 그것으로 「이 턴이 쓴 글」을 가른다(`prompt.ts::ownedByTurn`). 없으면 원인과 같은 이유로 빈 문자열로 덮는다.
   */
  turnId?: string | null;
  /**
   * 전용 제공사 경로(`providerLane.ts`)의 그 턴 env — base URL 과 키. **그 하네스의 허용 목록 키만** 받는다
   * (`PROVIDER_LANE_ENV_KEYS`, security ⓑ). 목록 밖 키가 오면 조립을 거절한다. 부모 env 의 denylist 는 그대로 지운 **뒤에**
   * 얹는다 — 부모에서 오는 키는 여전히 막히고, 이 턴이 받은 값만 든다.
   */
  /** opencode API 키 연결 턴이 고를 채널별 lane 에이전트(`opencodeLaneAgentName`). 없으면 셸 없는 기본 lane 에이전트다. */
  laneAgent?: string | null;
  providerEnv?: Record<string, string> | null;
  /**
   * 이 턴의 턴 열쇠(`turnKeys.ts`). 있으면 하네스 env 에서 러너 링크 secret 을 빼고 셸 열쇠를 넣는다. 다리 열쇠는 셸에 안 보이는
   * 자리로만 간다 — claude 는 호출자가 쓴 턴 MCP 설정(`mcpConfigPath`)의 `env` 칸, codex 는 `env_vars` 이름 + 셸 거르기.
   * `turnKeyDelivery` 가 false 인 하네스에는 주지 않는다(옛 자격 그대로).
   */
  turnKeys?: TurnKeys | null;
  /** opencode 턴 열쇠 턴의 턴 설정 파일(`writeOpencodeTurnMcpConfig`) — 하네스 env 의 `OPENCODE_CONFIG` 가 된다. */
  opencodeTurnConfig?: string | null;
  /** 승인 명령 규칙의 턴 hook 이 읽는 env(`codexRules.ts::prepareCodexRules`). 값은 규칙뿐이라 비밀이 아니다. */
  commandRuleEnv?: Record<string, string> | null;
}

/**
 * 이 하네스에 다리 열쇠를 셸 밖으로 줄 길이 있는가. 없는 하네스는 턴 열쇠 없이 옛 자격(러너 링크 secret)으로 돈다.
 * - claude-code: MCP 설정 파일 항목의 `env` 칸(호출자가 턴마다 쓴다, `writeTurnMcpConfig`).
 * - codex: `mcp_servers.harkroom.env_vars` 에 이름만 + `shell_environment_policy.exclude`.
 */
export function turnKeyDelivery(harness: AgentHarness): boolean {
  return turnKeyDeliveryOf(harness) !== null;
}

/** 멘션 턴(화면 앞에 사람이 없다)의 권한 매핑. 인터랙티브 턴은 아예 플래그를 안 준다(spec §6). */
interface HarnessPreset {
  command: string;
  /**
   * 세션 지정 + 서브커맨드 조각. claude 는 플래그(`-p`/`-r`/`--session-id`)로, codex 는
   * 서브커맨드+위치인자(`exec`/`resume`)로 표현해 문법이 근본적으로 다르다 — 그래서
   * 문자열 표로는 못 담고 함수로 둔다. 그래도 `buildTurnCommand` 는 이 함수를 harness 를
   * 보지 않고 그냥 호출만 한다(표 조회 자체가 분기다).
   */
  session(sessionId: string | null, isFirstTurn: boolean, mode: TurnMode): string[];
  /**
   * "세션 id 를 사전 할당할 수 없는가"는 harness 차이다 — 그래서 하드코드된 harness 이름
   * 비교가 아니라 표의 필드로 둔다(`assertValidSession` 이 이 필드만 읽는다). claude 는
   * false(러너가 첫 턴도 미리 uuid 를 발급), codex 는 true(첫 턴은 id 없이 시작해 종료 후
   * 발견한다). 네 번째 harness 가 이 성질을 가지면 이 필드만 채우면 된다 — 함수를 안 고친다.
   */
  allowsNullSessionOnFirstTurn: boolean;
  /** mentionPermission → 멘션 턴 전용 권한 플래그. 인터랙티브에선 아예 쓰지 않는다. */
  permission: Record<MentionPermission, string[]>;
  /**
   * 전용 제공사 경로(`providerEnv` 가 있는 턴)에서 `permission` 대신 쓸 값. 없는 칸은 `permission` 을 그대로 쓴다.
   * claude 와 opencode(kilo)가 채운다 — 이유는 CLAUDE_PRESET·OPENCODE_PRESET 의 `lanePermission` 주석.
   */
  lanePermission?: Partial<Record<MentionPermission, string[]>>;
  /**
   * API 키 연결 턴에만 붙는 인자 — 그 턴이 받은 값(`providerEnv`)으로 짓는다. codex 가 채운다(provider·셸 env 걷기, `codexLaneArgs`).
   * 값을 argv 에 싣지 않는다 — 키는 env 이름만, 주소는 비밀이 아니라 싣는다.
   */
  laneArgs?(providerEnv: Record<string, string>): string[];
  /** API 키 연결 auto 턴이 채널별 lane 에이전트를 고르는 argv(opencode). 있으면 `lanePermission.auto` 대신 쓴다. */
  laneAgentArgs?: (agent: string) => string[];
  mcp(args: { mcpConfigPath: string; operatorBin: string; extraMcpServers: Record<string, McpServerEntry>; turnKeys: boolean }): string[];
  /**
   * `mcp` 가 이름만 적은 비밀값을 자식 env 로 준다(2026-09-30). argv 는 `ps` 에 뜨므로 토큰은 여기로만.
   * 파일로 MCP 를 받는 하네스(claude·opencode)는 없다.
   */
  mcpEnv?(extraMcpServers: Record<string, McpServerEntry>): Record<string, string>;
  model(model: string | null): string[];
  effort(effort: string | null): string[];
  /**
   * 지시문 + 사용자 프롬프트 조립. claude 는 `--append-system-prompt` 플래그와 위치인자
   * 프롬프트가 분리돼 있지만, codex 는 지시문 주입 플래그 자체가 없어 프롬프트 앞에
   * 접두하는 방식뿐이다(실측, spec §4) — 그래서 반환 형태가 하네스마다 다르다.
   *
   * claude 는 지시문을 argv 로 직접 전달하면 다른 사용자에게 노출되므로 ( spec §7 ),
   * systemPromptFile 이 있으면 `--append-system-prompt-file <path>` 로 파일을 전달한다.
   * 파일 퍼미션 0600 으로 world-readable 이 아니다.
   */
  prompt(systemPrompt: string, promptCtx: string, mode: TurnMode, systemPromptFile: string | null): string[];
  /**
   * 세션·권한·MCP 어디에도 안 붙는, 그 harness 라서 늘 필요한 인자. `mode` 를 받는 이유는
   * codex 가 멘션 턴(`codex exec`)과 인터랙티브 턴(`codex resume`)에서 **서로 다른
   * 서브커맨드**라 받는 플래그 집합이 다르기 때문이다 — 이 비대칭은 이 파일이 이미 한 번
   * 실물로 깨져 본 자리다(`-s` 가 `codex exec` 에만 있고 `codex exec resume` 에는 없던 건,
   * CODEX_PRESET.permission 주석 참고). mode 없이 항상 붙이면 그 사고를 반복한다.
   */
  alwaysArgs(mode: TurnMode): string[];
  /**
   * 권한 규칙 주입(에이전트 머지 권한, 스레드 3deac356). 멘션 `auto` 턴에만 — readonly(plan)·인터랙티브는
   * argv 를 그대로 둔다. 파일(계정 config·워크스페이스 settings)에는 아무것도 쓰지 않는다: 파일에 쓰면
   * 같은 계정 풀을 쓰는 **모든** 에이전트에 퍼진다(09-30 결정). argv 는 이 턴, 이 에이전트뿐이다.
   * deny/allow 문법이 없는 하네스는 생략한다 — 그쪽은 프롬프트의 "머지는 래퍼로만" 한 줄뿐이다(한계, docs/agent-merge.md).
   */
  /**
   * Claude in Chrome 플래그(스레드 e8c8365d). 없는 하네스는 붙일 것이 없다. **꺼짐도 플래그로 말한다** — 이유는
   * CLAUDE_PRESET 주석.
   */
  chrome?(enabled: boolean): string[];
  permissionRules?(args: { mode: TurnMode; mentionPermission: MentionPermission; operatorBin: string; mergeRepos: readonly string[]; apiConnectors?: readonly string[]; apiDelegatable?: readonly string[]; toolAllows?: readonly string[]; claudeConfigDir?: string | null; commandHook?: boolean; providerLane?: boolean; postToolSinceSeq?: number | null }): string[];
}

const CLAUDE_PRESET: HarnessPreset = {
  command: 'claude',
  session(sessionId, isFirstTurn, _mode) {
    // `buildTurnCommand` 가 이 함수를 부르기 전에 `assertValidSession` 이 이미 non-null 을
    // 보장했다(claude 의 `allowsNullSessionOnFirstTurn` 은 false) — 그 불변식을 여기서
    // 다시 검사하지 않는다(같은 규칙을 두 곳에서 지키면 나중에 한쪽만 고치는 사고가 난다).
    // 아래 캐스트는 순수하게 TypeScript 타입 좁히기다.
    const id = sessionId as string;
    // **`mode` 를 보지 않는다(2026-09-08 실행 모델 교체).** 멘션 턴도 TUI 로 돈다.
    //
    // `-p` 를 붙이면 프롬프트를 stdin 파일로 줘야 하고(#117 — argv 는 `ps` 에 샌다),
    // 그 순간 `composeSpawn` 이 `sh -c '... < 파일'` 로 감싸 자식의 fd 0 이 PTY 가 아니게
    // 된다. 그러면 `acceptsPtyInput` 이 거짓이 되어 서버가 writer 차례를 안 주고, 사람은
    // 진행 중인 그 턴에 칠 수 없다(스펙 §5-3). 터미널을 보여 주는 이유가 개입인데 그
    // 제약을 받아들일 근거가 없다 — 프롬프트는 PTY 에 주입한다(스펙 §5-4 실측).
    //
    // 첫 턴은 resume 이 아니다: `--session-id <uuid>` 로 뜨고, 첫 메시지가 들어가면 그
    // uuid 의 세션 파일이 생겨 이후 `-r` 이 성립한다. 여기서 `-r` 로 조립하면 존재한 적
    // 없는 세션을 이어받으려다 "No conversation found" 로 죽는다.
    return isFirstTurn ? ['--session-id', id] : ['-r', id];
  },
  allowsNullSessionOnFirstTurn: false,
  permission: {
    /**
     * **`auto` 는 claude 의 `auto` 다**(2026-09-09 정정). 예전에는 `bypassPermissions` 로
     * 번역했는데, 그것은 harkroom 의 `auto` 가 뜻하는 것과 다르다:
     *
     * - `auto`: *"위험으로 판정된 것은 차단되고 Claude 가 다른 방법을 시도한다. 장시간
     *   작업에 이상적"* — 판단이 필요하면 사람에게 묻는다.
     * - `bypassPermissions`: *"harmful commands to run … only use in isolated
     *   environments"* — 아무것도 묻지 않는다.
     *
     * harkroom 는 사람이 개입할 자리를 이미 갖고 있다(`message.ask` 의 선택 카드, 앱의
     * 터미널 패널). 그 자리를 두고 아무것도 안 묻는 모드로 도는 것은 설계와 어긋난다.
     *
     * **덤으로 관문 하나가 사라진다**: `bypassPermissions` 는 TUI 로 뜰 때마다 계정이
     * 수락한 적 없으면 경고 화면을 띄우고, 기본 선택이 `No, exit` 라 러너가 답을 못 하면
     * 1초 만에 죽었다(2026-09-08 프로덕션 사고). `auto` 에는 그 화면이 없다(실측).
     */
    auto: ['--permission-mode', 'auto'],
    /**
     * **`readonly` 는 `dontAsk` + 허용 목록이다**(2026-10-25, e2e R2 — 옛 값 `plan`). `plan` 은 「계획을 세우고 사람 승인을
     * 받는」 모드라 harkroom 의 읽기 전용 턴과 맞지 않았다: 발화(`message_post`)마다 확인 창이 떴고, 허용 규칙을 줘도
     * 모델이 계획서를 쓰고 ExitPlanMode 창에서 멈췄다(실측 claude 2.1.310). 그 턴은 아무도 답하지 않은 채 30분을 썼다.
     * `dontAsk` 는 묻지 않는다 — 허용 목록(`READONLY_ALLOW`)만 돌고 나머지는 거절된다. 셸·웹은 deny 로 막는다(`READONLY_DENY`).
     */
    readonly: ['--permission-mode', 'dontAsk'],
  },
  /**
   * **API 키 연결(전용 제공사 경로) 턴은 auto 를 못 쓴다**(2026-10-23 실측, claude 2.1.309, 가짜 gateway).
   *
   * - Anthropic 이 아닌 gateway 로 도는 auto 턴은 첫 도구 호출에서 「auto mode classifier billing」 안내
   *   (`Enter to continue · Esc to cancel`)를 띄우고 사람을 기다린다. lane 러너는 터미널을 열지 않으므로(security F1)
   *   누를 사람이 없다.
   * - 그 화면을 지나도 classifier 는 Claude 모델을 **같은 gateway** 로 부른다. gateway 에 그 모델이 없으면
   *   Bash·MCP 도구가 모두 「denied by auto mode · Classifier unavailable」로 거절된다.
   *
   * 그래서 `dontAsk` 로 띄운다 — 미리 허락한 도구(`LANE_BASE_ALLOW` + 소유자가 승인한 규칙)만 돌고 나머지는
   * 묻지 않고 거절된다. classifier 요청도, 안내 화면도 없다(실측).
   */
  lanePermission: { auto: ['--permission-mode', 'dontAsk'] },
  // `--strict-mcp-config` 를 항상 함께 준다 — 없으면 운영자의 전역 MCP 목록(Slack·Gmail·
  // Drive 등, task-1 스파이크 실측)을 그대로 상속해, 채널에서 멘션할 수 있는 사람이면
  // 누구나 운영자 개인 계정에 도달한다(spec §7). 멘션·인터랙티브 어느 쪽도 예외가 아니다.
  mcp: ({ mcpConfigPath }) => ['--mcp-config', mcpConfigPath, '--strict-mcp-config'],
  model: (model) => (model ? ['--model', model] : []),
  effort: (effort) => (effort ? ['--effort', effort] : []),
  // 지시문은 **파일로만** 넘긴다. 경로는 호출자가 미리 `writeSystemPromptFile()` 로 써 두고
  // 넘긴다(0600). argv 폴백을 남기지 않는 이유는 `harkroomUrl` 과 같다 — 조용히 넘어가는 경로를
  // 두면 그 경로가 결국 쓰이고, 여기서는 그게 곧 대화 내용이 `ps` 로 새는 것이다(#92).
  //
  // **대화 본문(promptCtx)도 stdin 파일로 이동한다(#117).** argv 에 있으면 같은 머신의 다른
  // 로컬 사용자가 `ps -ef` 로 스레드 내용을 그대로 읽는다. 이 수정은 #92 에서 이미 확인한
  // PTY + stdin 리다이렉션이 실제로 동작한다는 실측 결과에 기반한다(claude/codex 모두 exec
  // 모드에서 stdin 에 TTY 를 요구하지 않음). systemPromptFile 과 stdin 파일은 별도로, 각각
  // writeSystemPromptFile() 과 writePromptFile() 로 호출자가 써서 넘긴다.
  prompt: (systemPrompt, _promptCtx, _mode, systemPromptFile) => {
    if (systemPrompt && !systemPromptFile) {
      throw new Error(
        'buildTurnCommand: claude 는 지시문을 파일로만 받는다 — systemPromptFile 이 비어 있다 ' +
          '(turn.ts::writeSystemPromptFile 로 먼저 쓰고 그 경로를 넘겨라). argv 로 넘기면 ' +
          '`ps` 로 다른 로컬 사용자에게 노출된다(#92, spec §7).',
      );
    }
    const flags: string[] = [];
    if (systemPromptFile) flags.push('--append-system-prompt-file', systemPromptFile);
    // promptCtx 는 argv 로 전달하지 않는다 — stdin 파일로 가므로(위 설명).
    return flags;
  },
  // claude 는 멘션·인터랙티브 모두 같은 `claude` 커맨드라 모드별 차이가 없고, 붙일 것도 없다.
  alwaysArgs: () => [],
  /**
   * 실측 2026-10-14(claude 2.1.299 바이너리, 스레드 e8c8365d): `--chrome` 은 내장 `claude-in-chrome` MCP 를 **동적 MCP
   * 목록**에 합치므로 `--strict-mcp-config` 와 함께 붙는다. 플래그가 없을 때는 claude 가 스스로 켤 수 있다 — 서버 기능
   * 플래그(`tengu_chrome_auto_enable`)가 켜졌고 계정의 `.claude.json` 이 확장 설치를 기억하면(`cachedChromeExtensionInstalled`)
   * **모든** 에이전트가 사람의 Chrome 에 닿는다. 그래서 꺼짐을 `--no-chrome` 으로 **명시한다**. 계정 config(같은 풀의 모든
   * 에이전트가 공유한다)에는 아무것도 쓰지 않는다 — argv 는 이 턴, 이 에이전트뿐이다.
   */
  chrome: (enabled) => (enabled ? ['--chrome'] : ['--no-chrome']),
  /**
   * 실측 2026-10-02(claude 2.1.287, 스레드 3deac356 T1~T4): allow 규칙에 걸린 명령은 auto 분류기를 **거치지
   * 않고** 실행되고, deny 규칙은 분류기보다 먼저·allow 보다 우선해 결정적으로 막는다. `:*` 는 단어 경계를 본다
   * (`…/harkroom-operator merge:*` 는 `mergeall` 에 안 걸린다).
   *
   * - deny 는 **모든** auto 멘션 턴에: 권한 있는 에이전트도 `gh pr merge` 를 직접 못 부르고 래퍼로만 간다(D4).
   *   `gh api` 는 PUT 접두만 막는다 — `.mergeable` 같은 읽기 조회는 그대로 된다(T3). 가운데 와일드카드는 안 맞는다(P2).
   * - 래퍼 allow 는 auto 멘션 턴마다, 래퍼의 **절대 경로 + 서브커맨드** 접두로(T1c). grant 유무와 상관없다(스레드 1b75d7a0 —
   *   거절 기록을 받아야 1회 승인 카드가 선다). 저장소 범위는 규칙이 아니라 서버·래퍼가 가른다.
   */
  permissionRules: ({ mode, mentionPermission, operatorBin, mergeRepos, apiConnectors = [], apiDelegatable = [], toolAllows = [], claudeConfigDir = null, commandHook = false, providerLane = false, postToolSinceSeq = null }) => {
    // 읽기 전용 멘션 턴(`dontAsk`)의 규칙은 고정이다 — 소유자 승인 규칙(`toolAllows`)·머지 래퍼도 싣지 않는다.
    if (mode === 'mention' && mentionPermission === 'readonly') return [...READONLY_RULES];
    if (mode !== 'mention' || mentionPermission !== 'auto') return [];
    // api 래퍼(C안 P3)도 머지와 같은 모양이다: 절대 경로 + 서브커맨드 접두. 연결·메서드·경로 범위는 규칙이 아니라 서버가 가른다.
    // `;`·`&&` 로 묶은 명령은 claude 가 조각마다 따로 판정하므로 이 규칙 하나로는 통과하지 않는다(프롬프트가 금지한다).
    const allow = [
      // 머지 래퍼는 auto 멘션 턴마다 연다(security, 스레드 1b75d7a0) — grant 가 없어도 래퍼가 서버에 물어 거절 기록(denialId)을 받아야
      // 소유자 앞 [이번 한 번 머지] 카드가 선다. 판정은 서버가 하고, 승인이 없으면 래퍼는 GitHub 에 닿지 않는다(turnMerge.ts).
      // 여기서 여는 것은 `merge:*` 하나뿐이다 — `api:*` 는 아래처럼 연결이 있을 때만.
      `Bash(${operatorBin} merge:*)`,
      ...(apiConnectors.length ? [`Bash(${operatorBin} api:*)`] : []),
      // 실측 2026-10-05(claude 2.1.28x, 스레드 b56c02a1): auto 분류기는 `grant.delegate` MCP 호출을 `[Permission Grant]` 로
      // 막는다 — 서버가 거절할 호출(권한 없음)이어도 호출 자체가 막힌다. 판정(범위 ⊆·depth·루트 사람 확인·하루 상한)은 서버
      // `apiDelegation.ts` 가 하므로, 다시 줄 수 있는 연결이 **있을 때만** 이 한 도구를 연다. `grant.revoke` 는 좁히는 쪽이라 두지 않는다.
      ...(apiDelegatable.length ? [GRANT_DELEGATE_TOOL] : []),
      // 권한 요청 도구는 **늘** 연다(H①, 스레드 8769dbf7): 요청은 아무것도 열지 않고 소유자 사람 세션의 승인만 연다 — 그런데
      // `grant.delegate` 처럼 분류기가 `[Permission Grant]` 로 호출 자체를 막으면 막힌 에이전트가 청할 길이 없다.
      PERMISSION_REQUEST_TOOL,
      // 발화 도구 넷은 분류기를 거치지 않는다(2026-10-25 security 조건부 OK): 분류기가 일시 장애로 판정을 못 내면(「no verdict
      // (error)」) 턴이 답을 하나도 못 올렸다(qa 재점검). 본문 비밀 검사·채널 권한은 서버가 한다. 그 밖의 harkroom 쓰기 도구는 분류기에 남긴다.
      ...POST_TOOLS,
      // 권한 요청(스레드 f61af808): 소유자가 카드에서 승인한 규칙. 분류기를 끄지 않고 이 규칙만 정확히 더한다. deny(머지·설정
      // 파일)가 allow 보다 앞서므로 승인된 규칙이 그 둘을 덮지 못한다.
      ...safeToolAllows(toolAllows),
      // API 키 연결 턴은 `dontAsk` 라 여기 없는 도구는 모두 거절된다(`lanePermission` 주석). 기본으로 여는 것은 도구 찾기·
      // 작업 폴더 안 쓰기·스킬과 서버가 판정하는 MCP 둘이다 — Bash·웹은 소유자가 권한 요청 카드로 승인한 규칙(`toolAllows`)으로만 열린다.
      ...(providerLane ? LANE_BASE_ALLOW : []),
    ];
    return [
      '--disallowedTools', ...MERGE_DENY_RULES, ...SETTINGS_SELF_EDIT_DENY_RULES, ...configSettingsDenyRules(claudeConfigDir),
      ...(providerLane ? LANE_DENY : []),
      ...(allow.length ? ['--allowedTools', ...allow] : []),
      // 「정확한 명령」 hook(H③b) — **인라인 JSON** 이라 에이전트가 고칠 파일이 없다. 켜졌을 때만.
      // API 키 연결 턴은 셸·웹을 hook 으로 판정한다(D1, `laneHookSettings`) — 「정확한 명령」 판정도 그 안에서 한다.
      // 턴 도중 새 글 hook 은 같은 `--settings` 한 장에 합친다(`withPostToolHook`) — 둘로 주면 어느 쪽이 이기는지 판본마다 다를 수 있다.
      ...settingsArgs(
        providerLane ? laneHookSettings(operatorBin, allow) : commandHook ? commandHookSettings(operatorBin) : null,
        operatorBin, postToolSinceSeq,
      ),
    ];
  },
};

/**
 * 읽기 전용(`dontAsk`) 멘션 턴에 여는 도구(security 판단, 2026-10-25). 지연 MCP 도구를 불러오는 `ToolSearch` 와 **이름으로 고른**
 * harkroom 도구 — 발화·읽기·기억 읽기·예약·첨부뿐이다. 비밀·권한 위임·권한 요청·자동화·스킬 제안·위임은 열지 않는다(상태를
 * 바꾸는 도구다). avcs 는 넣지 않는다.
 *
 * 읽기 내장 도구(`Read`·`Grep`·`Glob`)는 넣지 않는다 — `dontAsk` 는 규칙 없이도 작업 폴더 안 읽기를 열고, 맨 이름을 넣으면
 * 그 밖까지 열린다(`LANE_BASE_ALLOW` 주석, security F1).
 */
export const READONLY_ALLOW: readonly string[] = [
  'ToolSearch',
  ...['message_post', 'message_report', 'message_fail', 'message_ask', 'message_progress', 'message_react', 'message_unreact',
    'message_read', 'message_search', 'thread_note', 'thread_note_list', 'memory_get', 'memory_list', 'memory_search', 'turn_wake',
    'attachment_fetch', 'attachment_upload', 'account_me', 'account_list', 'channel_list', 'channel_doc', 'workspace_guide',
  ].map((t) => `mcp__harkroom__${t}`),
];

/**
 * 읽기 전용 멘션 턴에서 막는 것. **셸은 통째로 막는다**: `dontAsk` 도 claude 가 읽기 전용으로 판정한 셸 명령(`ls` 등)은
 * 규칙 없이 돌린다(실측 2.1.310) — 그 판정은 판마다 바뀌고, 같은 uid 의 자격으로 읽는 명령이 열릴 수 있다. 웹도 막는다.
 */
export const READONLY_DENY: readonly string[] = ['Bash', 'WebFetch', 'WebSearch'];

/**
 * 읽기 전용 턴이 **볼 수 있는** 내장 도구(security F1, 2026-10-25). `dontAsk` 는 「미리 허락된 것」을 돌리는데, 거기에는
 * `--allowedTools` 말고도 설정 층의 allow 규칙(계정 config 의 settings.json — 같은 풀이 공유 — 와 cwd 의 `.claude/settings*.json`)이
 * 든다. 거기 `Write` 한 줄이 생기면 readonly 가 조용히 쓰기를 얻는다. 그래서 목록 자체를 못박는다 — Edit·Write·NotebookEdit·
 * Bash·Agent 는 도구로 없다. 백그라운드 조립의 `--tools ToolSearch` 와 같은 이유다(`bgExecutor.ts`).
 */
export const READONLY_TOOLS: readonly string[] = ['ToolSearch', 'Read', 'Grep', 'Glob'];

/**
 * 읽기 전용 턴의 규칙 argv. 값은 **쉼표로 이은 한 토큰**이다 — `--allowedTools`·`--disallowedTools` 는 가변 인자라, 한 토큰이어야
 * 백그라운드 조립(`bgExecutor.ts`)이 정확히 떼어 낼 수 있다(실측: claude 는 쉼표 목록을 받는다).
 */
export const READONLY_RULES: readonly string[] = [
  '--disallowedTools', READONLY_DENY.join(','),
  '--allowedTools', READONLY_ALLOW.join(','),
  '--tools', READONLY_TOOLS.join(','),
];

/**
 * API 키 연결(`dontAsk`) 턴에 기본으로 여는 도구(소유자 결정 C안, 10-23 — 구독형 에이전트와 같은 일을 하게). 지연 MCP 도구를
 * 불러오는 `ToolSearch`, 할 일 목록, **작업 폴더 안** 쓰기(`Edit(./**)`·`Write(./**)`), 하위 에이전트(`Agent`)·스킬(`Skill`),
 * 그리고 **서버가 판정하는** MCP 두 개(harkroom·avcs) — 각 MCP 호출의 권한은 서버가 계정으로 가른다.
 *
 * **쓰기는 경로 규칙으로만 연다**(2026-10-23 실측 claude 2.1.309, 가짜 gateway): `./**` 는 턴의 작업 폴더 기준이라 그 안의
 * Write·Edit 는 돌고, 홈·`<작업 폴더>/../` 는 묻지 않고 거절된다. 규칙이 없으면 작업 폴더 안 Write 도 거절이다. 맨 이름
 * `Edit`·`Write` 는 밖까지 연다 — 넣지 마라. `Agent`·`Skill` 은 이 판에서 규칙 없이도 돌지만 판이 바뀌어도 열려 있게 적어 둔다.
 * 하위 에이전트의 셸·웹은 `laneHookSettings` 가 판정한다(D1).
 * Bash·`WebFetch`·`WebSearch` 는 넣지 않는다 — 셸과 밖으로 나가는 길은 소유자가 카드로 승인한 규칙만 연다(security, C안).
 *
 * **읽기 도구는 넣지 않는다**(security F1, 2026-10-23 실측 claude 2.1.309): dontAsk 는 규칙이 없어도 작업 디렉터리
 * 안의 `Read` 를 열고, 밖(같은 uid 의 홈·오퍼레이터 비밀)은 묻지 않고 거절한다. 맨 이름 `Read` 를 넣으면 그 밖까지
 * classifier 없이 열린다. `Glob`·`Grep` 은 이 판에 도구로 없다.
 */
export const LANE_BASE_ALLOW: readonly string[] = ['ToolSearch', 'TodoWrite', 'Edit(./**)', 'Write(./**)', 'Agent', 'Skill', 'mcp__harkroom', 'mcp__avcs'];

/**
 * API 키 연결 턴에서 막는 것(security, 2026-10-23 실측 claude 2.1.309 dontAsk). deny 는 allow·승인 규칙보다 앞선다.
 *
 * - 하위 에이전트(`Agent`)는 여기 없다(D1): 하위 에이전트도 이 턴의 dontAsk·허용 목록을 따르고, PreToolUse hook
 *   (`laneHookSettings`)과 이 deny 도 하위 에이전트에 걸린다(실측, 쓰기 명령으로 잼).
 * - 작업 폴더의 `.claude/**`(스킬·에이전트·명령 정의)·`CLAUDE.md`·`CLAUDE.local.md`·`.mcp.json`: 다음 턴의 도구·지시·MCP 를 바꾸는 파일이다.
 *   `Edit(./**)`·`Write(./**)` 를 열어도 이 셋은 못 쓴다. Edit deny 는 Write 도 막지만 둘 다 적어 둔다.
 */
export const LANE_DENY: readonly string[] = [
  'Edit(./.claude/**)', 'Write(./.claude/**)',
  'Edit(./CLAUDE.md)', 'Write(./CLAUDE.md)',
  'Edit(./CLAUDE.local.md)', 'Write(./CLAUDE.local.md)',
  'Edit(./.mcp.json)', 'Write(./.mcp.json)',
];

/** claude 가 보는 harkroom MCP 의 `grant.delegate` 도구 이름(서버 이름 `harkroom`, 점은 밑줄로). */
export const GRANT_DELEGATE_TOOL = 'mcp__harkroom__grant_delegate';

/** claude 가 보는 harkroom MCP 의 `permission.request` 도구 이름. 서버가 판정하고 소유자 승인 전에는 아무것도 열지 않는다. */
export const PERMISSION_REQUEST_TOOL = 'mcp__harkroom__permission_request';

/**
 * 구독형 auto 멘션 턴에서 분류기 없이 여는 harkroom 발화 도구 — **정확한 이름 넷만**(security 조건 ①, 2026-10-25).
 * `mcp__harkroom` 통째·ask·delegate·react·첨부·아티팩트·비밀·자동화는 분류기에 남긴다.
 */
export const POST_TOOLS: readonly string[] = ['message_post', 'message_report', 'message_fail', 'message_progress']
  .map((t) => `mcp__harkroom__${t}`);

/**
 * 「정확한 명령」 PreToolUse hook 설정(H③b, 실측 2026-10-07 claude 2.1.292: hook 의 `permissionDecision: "allow"` 는 auto 분류기를
 * 건너뛰고, `--disallowedTools` deny 는 hook allow 보다 이긴다). Bash 에만 건다. hook 은 승인된 정확한 명령일 때만 allow 를 내고
 * 그 밖·오류·시간 초과는 **무출력**(= 판단하지 않음 → 분류기).
 */
export function commandHookSettings(operatorBin: string): string {
  const command = `${JSON.stringify(operatorBin)} hook pretool`;
  return JSON.stringify({ hooks: { PreToolUse: [{ matcher: 'Bash', hooks: [{ type: 'command', command, timeout: 15 }] }] } });
}

/**
 * API 키 연결 턴의 PreToolUse hook(D1, security S1·S2, 2026-10-23 실측 claude 2.1.309 dontAsk): **모든 도구**(matcher `*`)를
 * 오퍼레이터 `hook pretool --lane` 이 본다. hook 은 allow 를 내지 않는다 — 기본 허용 목록·승인 규칙에 맞으면 결정 없음(하네스가
 * 판정), 아니면 **deny**(이유는 모델에 간다 — 무엇을 청하면 열리는지 알려 준다). hook 은 하위 에이전트에도 걸린다(실측). hook 이
 * 실패하거나 시한을 넘겨도 dontAsk 판정은 그대로라 넓어지지 않는다(실측). 규칙은 base64url 로 실어 셸 글자가 섞이지 않는다.
 */
export function laneHookSettings(operatorBin: string, allowRules: readonly string[]): string {
  // hook 이 죽으면(0 이 아닌 종료) 차단 종료 코드 2 로 끝낸다 — 그냥 두면 하네스가 비차단 오류로 넘기고 읽기 명령은 하네스 판정으로 돈다(실측).
  const command = `${JSON.stringify(operatorBin)} hook pretool --lane ${encodeLaneHookRules(allowRules)} || exit 2`;
  return JSON.stringify({ hooks: { PreToolUse: [{ matcher: '*', hooks: [{ type: 'command', command, timeout: 15 }] }] } });
}

/**
 * 턴 도중 새 글 PostToolUse hook(스레드 f1460447, 실측 2026-10-29 claude 2.1.312 dontAsk — `-p`·TUI 모두): hook 이 stdout 에
 * `hookSpecificOutput.additionalContext` 를 내면 그 글이 도구 결과 뒤에 모델에 실린다. 사람이 「멈춰」라고 쓰면 돌던 턴이 다음 도구
 * 경계에서 그것을 읽는다 — 그 전에는 같은 스레드의 새 멘션이 앞 턴이 끝날 때까지 inbox 에서 기다리기만 했다(`mentionScheduler.ts` 의 blocked).
 *
 * **권한 판정이 아니다.** hook 은 allow·deny 를 내지 않고 글만 싣는다 — 실패·시간 초과·무출력이면 아무 일도 없다(fail-open). 읽는
 * 범위는 오퍼레이터가 그 턴의 임대에서 정한 앵커 스레드 하나다(`turnPeek.ts`) — 이 seq 는 어디부터 실을지만 정한다.
 */
export function postToolHookEntry(operatorBin: string, sinceSeq: number): { matcher: string; hooks: { type: 'command'; command: string; timeout: number }[] } {
  const since = Number.isSafeInteger(sinceSeq) && sinceSeq >= 0 ? sinceSeq : 0;
  return { matcher: '*', hooks: [{ type: 'command', command: `${JSON.stringify(operatorBin)} hook posttool --since ${since}`, timeout: 15 }] };
}

/** PreToolUse 설정 JSON(없으면 null)에 턴 도중 새 글 hook 을 합친다. 둘 다 없으면 빈 배열. */
export function settingsArgs(preSettings: string | null, operatorBin: string, postToolSinceSeq: number | null): string[] {
  if (postToolSinceSeq === null || postToolSinceSeq === undefined) return preSettings ? ['--settings', preSettings] : [];
  return ['--settings', withPostToolHook(preSettings, operatorBin, postToolSinceSeq)];
}

export function withPostToolHook(preSettings: string | null, operatorBin: string, sinceSeq: number): string {
  const base = (preSettings ? JSON.parse(preSettings) : {}) as { hooks?: Record<string, unknown> };
  return JSON.stringify({ ...base, hooks: { ...(base.hooks ?? {}), PostToolUse: [postToolHookEntry(operatorBin, sinceSeq)] } });
}

const CODEX_PRESET: HarnessPreset = {
  command: 'codex',
  session(sessionId, isFirstTurn, mode) {
    // **모드가 아니라 실행 방식으로 갈린다(2026-09-11).** 멘션 턴이 TUI 로 올라가면
    // 그 턴의 argv 도 TUI 의 것이어야 한다 — `codex exec` 가 아니라 `codex`/`codex resume`.
    // 스위치가 꺼져 있으면 `executionModelFor` 가 옛 답('exec')을 주므로 아래 분기는
    // 지금까지와 똑같이 돈다.
    if (executionModelFor('codex', mode) === 'tui') {
      // 실제 codex-cli 0.153.2 에서 첫 턴은 맨 `codex`, 이후 턴은 `codex resume <id>` 다.
      // 개인 config 격리는 지원되지 않는 --ignore-user-config 대신 CODEX_HOME 으로 보장한다.
      return sessionId === null ? [] : ['resume', sessionId];
    }
    if (sessionId === null) {
      // codex 는 세션 id 를 사전 할당할 수 없다 — 첫 턴은 id 없이 그냥 `exec` 로 시작하고,
      // 종료 후 러너가 rollout 파일에서 id 를 발견해 저장한다(spec §3, Task 8).
      return ['exec'];
    }
    return ['exec', 'resume', sessionId];
  },
  allowsNullSessionOnFirstTurn: true,
  // `message.post` 는 쓰기 MCP라 Codex 기본 도구 승인 모드에서는 승인 요청이 난다.
  // 멘션 턴은 비대화형이고 approval policy가 never라 그 요청을 받을 사람이 없어, 답을
  // 모두 만든 뒤에도 발화만 실패한다(#404 실물 재현). auto 권한에서는 **harkroom 서버만**
  // 승인 없이 실행한다. 공식 Codex 설정 키는 서버별 `default_tools_approval_mode` 이고,
  // `approve` 가 이 서버의 도구를 사전 승인한다. `approval_mode="never"` 는 서버 설정 키가
  // 아니므로 조용히 무시된다(#404 실앱 재검증). 전체 sandbox/승인을 우회하는
  // `--dangerously-bypass-approvals-and-sandbox` 와 달리 workspace-write 경계는 그대로고,
  // 운영자 개인 MCP도 `--ignore-user-config` 로 여전히 빠진다.
  //
  // **`-s` 플래그가 아니라 `-c sandbox_mode="…"` 다.** 리뷰가 실물 CLI(`codex-cli 0.148.0`)로
  // 깨뜨렸다: `codex exec resume <id> -s workspace-write` → `error: unexpected argument
  // '-s' found`. `-s` 는 비-resume `codex exec` 에만 있고 `codex exec resume --help` 의
  // 옵션 목록(`-c`, `-m`, `--last`, `--all` 등)에는 없다 — "새 세션" 행과 "권한" 행이 codex
  // 에서는 직교하지 않았다(첫 턴에 통하는 플래그가 resume 에서 파싱 오류). `sandbox_mode` 는
  // codex 자신의 마이그레이션 문서가 쓰는 실제 설정 키이고 `-c` 는 exec·resume 양쪽에 있어,
  // 두 턴이 같은 기전 하나를 쓰면 이 비대칭이 애초에 생기지 않는다(spec §4, 수정 커밋 9a1c852).
  permission: {
    auto: [
      '-c', 'sandbox_mode="workspace-write"',
      '-c', 'mcp_servers.harkroom.default_tools_approval_mode="approve"',
    ],
    readonly: ['-c', 'sandbox_mode="read-only"'],
  },
  mcpEnv: (extraMcpServers) => codexBearerEnv(extraMcpServers),
  mcp: ({ operatorBin, extraMcpServers, turnKeys }) => [
    // avcs 는 항상 등록한다(실측 shape: stdio, command 'avcs', args ['mcp'], env 없음).
    //
    // **`transport` 를 반드시 적는다(2026-09-15 실측).** codex 0.154 는 이 갈래 표시가 없는
    // stdio 항목을 거절하는데, 그 거절이 그 항목 하나로 끝나지 않는다 — **MCP 설정 전체가
    // 로드에 실패해 harkroom 서버까지 함께 사라진다**:
    //
    //   failed to load configuration: invalid transport in `mcp_servers.avcs` (code -32600)
    //
    // 그 상태의 codex 는 에러를 화면에 띄우지 않고 그냥 도구가 없는 채로 돈다. 물어보면
    // "message.post 도구가 제공되지 않아 호출하지 못했다"고 답한다 — 그리고 러너에게는
    // "답 없이 턴을 끝냈습니다" 만 남는다. codex-dev 가 이 워크스페이스에서 **한 번도**
    // 말하지 못한 이유가 이것이었다.
    //
    // 실물 확인: 이 한 줄을 넣으면 avcs 를 등록한 채로 codex 가 harkroom MCP 로 스레드에
    // 글을 올린다(같은 조건에서 이 줄만 빼면 못 올린다).
    '-c', 'mcp_servers.avcs.transport="stdio"',
    '-c', 'mcp_servers.avcs.command="avcs"',
    '-c', 'mcp_servers.avcs.args=["mcp"]',
    // harkroom 도 항상 등록한다 — 이게 빠지면 에이전트가 답할 방법이 없다. **stdio 브릿지다**
    // (스펙 2026-09-20 §5): URL 도 토큰도 없다. 브릿지는 하네스의 env(러너 env 를 상속)에서
    // 오퍼레이터 소켓·러너 id·secret 을 읽어 오퍼레이터에 붙고, 오퍼레이터가 서버에 전달한다.
    // 앞 판본은 `url` + `bearer_token_env_var="HARKROOM_PAT"` 였다 — 그 두 줄이 사라진 것이
    // 러너 env 에서 PAT 이 사라진 것과 같은 사건이다.
    '-c', 'mcp_servers.harkroom.transport="stdio"',
    '-c', `mcp_servers.harkroom.command=${JSON.stringify(operatorBin)}`,
    '-c', `mcp_servers.harkroom.args=${JSON.stringify([...MCP_BRIDGE_ARGS])}`,
    // **링크 env 셋을 이름으로 달라고 해야 한다**(2026-09-29 실측, beta-team 커뮤니티). codex 는
    // stdio MCP 자식에게 자기 env 를 통째로 넘기지 않는다 — 기본 목록(PATH·HOME 등)과 항목의
    // `env`·`env_vars` 에 적힌 것만 넘긴다. 이 줄이 없던 동안(09-20 브릿지 전환 이후) 브릿지는
    // `… 이 필요하다` 를 찍고 exit 2, codex 는 `handshaking with MCP server failed` 를 로그에만
    // 남기고 harkroom 도구 없이 돌았다 — 답할 수단이 없는 턴이다. 러너 env 에는 셋이 다 있었다.
    //
    // **`env` 가 아니라 `env_vars` 다.** `env` 는 값을 argv 에 굽는다 — secret 이 `ps` 에 뜬다.
    // `env_vars` 는 이름만 적고 값은 codex 가 자기 env 에서 꺼내 넘긴다.
    // 턴의 원인(`RUNNER_TURN_CAUSE_ENV`)·턴 id(`RUNNER_TURN_ID_ENV`)도 같은 이유로 이름을 댄다 — 빠지면 codex 턴만 옛 셈으로 간다.
    '-c', `mcp_servers.harkroom.env_vars=${JSON.stringify([...RUNNER_LINK_ENV_KEYS, RUNNER_TURN_CAUSE_ENV, RUNNER_TURN_ID_ENV, ...(turnKeys ? [RUNNER_TURN_KEY_ENV.bridge] : [])])}`,
    // 턴 열쇠 턴: 다리 열쇠는 브릿지에만 가고 셸에는 안 가게 거른다. lane 턴은 `codexLaneArgs` 가 같은 칸을 뒤에서 다시 쓰므로
    // 거기에도 이 이름이 들어 있다(`-c` 는 같은 칸이면 뒤의 것이 이긴다).
    ...(turnKeys ? ['-c', `shell_environment_policy.exclude=${JSON.stringify([RUNNER_TURN_KEY_ENV.bridge])}`] : []),
    // 셸 스냅숏·로그인 셸은 이 거르기를 지나 하네스 env 를 셸에 되살린다(실물 회귀 G2, codex 0.154 구독형 턴) — 열쇠 턴은 둘 다 끈다.
    // lane 턴은 `codexLaneArgs` 가 같은 칸을 이미 끈다.
    // 코드 모드 호스트는 codex 본체 env(다리 열쇠 포함)를 물려받는다 — 기본값이 바뀌어도 모델 코드가 그 자리에서 돌지 않게 끈 채로 고정한다.
    // tty 실행 세션도 끈다 — 셸 명령은 한 번에 하나씩 턴 hook 판정을 지나게 한다(codex 0.154).
    ...(turnKeys ? ['-c', 'features.shell_snapshot=false', '-c', 'allow_login_shell=false', '-c', 'features.code_mode=false', '-c', 'features.unified_exec_tty=false'] : []),
    // 에이전트의 mcpServers(스펙 §6) — 오퍼레이터가 이 머신의 정의로 합쳐 파일에 넣은 것을 codex 문법으로.
    ...Object.entries(extraMcpServers).flatMap(([name, entry]) => codexMcpFlags(name, entry)),
  ],
  model: (model) => (model ? ['--model', model] : []),
  // 주소가 없으면 조립을 거절한다 — provider 덮어쓰기 없이 뜨면 이 홈의 기본 provider 로 돈다.
  laneArgs: (env) => {
    const baseUrl = env[CODEX_LANE_BASE_URL_ENV];
    if (!baseUrl) throw new Error('buildTurnCommand: codex API 키 연결 턴에 주소가 없다');
    return codexLaneArgs(baseUrl);
  },
  // codex 에 `--effort` 플래그는 없다 — spec §4 표에도 이 항목은 없다(측정 대상 밖). 키
  // `model_reasoning_effort` 자체는 **실재를 확인했다**: 이 머신의 실제
  // `~/.codex/config.toml:2` 에 `model_reasoning_effort = "xhigh"` 가 그대로 들어있다(사용자가
  // 직접 쓰던 키). 그래서 MCP 와 같은 턴별 `-c` 오버라이드로 그 키를 재사용한다.
  // **절반만 확인됐다: 키는 실측, 값 집합은 미확인.** harkroom 의 effort 값은
  // `low|medium|high|xhigh|max` 다섯인데 codex 가 그 다섯을 다 받는지는 `xhigh` 하나만
  // 실물로 봤을 뿐 나머지는 모른다. 값이 틀려도 조용하지 않다 — codex 가 알 수 없는 값이면
  // 턴 시작 자체가 크게 실패하므로(무시된 채 다른 값으로 도는 조용한 오동작이 아니다) 이
  // 미확인은 감수 가능하다고 판단했다.
  // **값을 TOML 문자열로 인용한다**(security #968 ③). `"${effort}"` 로 끼우면 따옴표·개행이 든 값이
  // 오버라이드를 깨고 다른 키를 심는다 — 스레드 지정(079)으로 채널의 사람이 넣는 값이 여기로 온다.
  // JSON 문자열은 TOML 기본 문자열과 이스케이프가 같다.
  effort: (effort) => (effort ? ['-c', `model_reasoning_effort=${JSON.stringify(effort)}`] : []),
  // avcs workspace 는 git 저장소가 아니다 — codex 가 cwd 를 "신뢰되지 않은 디렉터리"
  // ("Not inside a trusted directory and --skip-git-repo-check was not specified.")로
  // 거부한다. `avcs workspace project` 가 만드는 격리 경로가 정확히 이 경우고, 그건 폴백이
  // 아니라 spec §3 이 의도한 정상 경로다(기층이 git 이 아니라 avcs).
  //
  // **멘션 턴에만 붙인다.** 실물 확인(codex-cli 0.148.0):
  //   codex exec --help        → --skip-git-repo-check 있음
  //   codex exec resume --help → --skip-git-repo-check 있음
  //   codex resume --help      → **없음**. 실제로 넘기면
  //     `error: unexpected argument '--skip-git-repo-check' found` 로 파싱이 깨진다.
  // 인터랙티브 턴은 `codex resume`(위 session() 참고)이라 이 플래그를 못 받는다 — 모드 구분
  // 없이 항상 붙이면 인터랙티브 턴이 통째로 안 뜬다. 인터랙티브는 화면 앞에 사람이 있어
  // codex 자신의 신뢰 프롬프트로 해결할 수 있으므로, 여기서 대신 처리하지 않는다.
  //
  // **--ignore-user-config**: claude 의 --strict-mcp-config 와 같은 목적으로 운영자
  // ~/.codex/config.toml 의 MCP(Slack·Gmail·Drive 등)를 무시한다. 없으면 채널에서
  // 멘션할 수 있는 사람이 운영자 개인 계정에 도달한다(spec §7).
  //
  // ⚠️ 이 플래그는 --strict-mcp-config 보다 **넓다.** --strict-mcp-config 는 MCP 목록만
  // 무시하지만 --ignore-user-config 는 config.toml 전체를 무시한다 — 운영자가 거기 적어 둔
  // 모델·프로바이더 설정도 함께 무시된다. 멘션 턴은 model·effort·sandbox·MCP 를 전부 -c 로
  // 직접 넘기므로 정상 동작하지만, 커스텀 프로바이더를 config.toml 로만 설정한 운영자는
  // 멘션 턴이 기본 프로바이더로 도는 것을 보게 된다. auth 는 영향받지 않는다(--help 명시).
  //
  // 인터랙티브 턴(codex resume)은 이 플래그를 못 받는다. 대신 자식 프로세스의 CODEX_HOME 을
  // 러너 상태 디렉터리로 격리하므로 개인 config.toml 을 상속하지 않는다.
  //
  // **실행 방식으로 갈린다 — 모드가 아니다.** 이 두 플래그는 `exec` 계열에만 있다(실측,
  // codex-cli 0.153.0: `codex --help` · `codex resume --help` 에 둘 다 없다). 모드로
  // 판단하면 멘션 턴을 TUI 로 올리는 순간 그대로 붙어 `unexpected argument` 로 죽는다.
  //
  // TUI 에서 두 플래그가 하던 일은 다른 수단이 이미 대신한다 — git 저장소 아님은
  // `trustForCodex` 가 적는 `trust_level = "trusted"` 가, 개인 config 격리는 러너별
  // `CODEX_HOME` 이 한다. 근거 전문은 `adapters/codex.ts` 의 `executionModel` 주석에 있다.
  alwaysArgs: (mode) =>
    (executionModelFor('codex', mode) === 'exec' ? ['--skip-git-repo-check', '--ignore-user-config'] : []),
  // codex 도 stdin 파일을 통해 프롬프트를 받는다(#117). 원래는 PTY stdin 리다이렉션이
  // 불가능하다고 생각했으나 실측 결과 두 하네스 모두 exec/print 모드에서 stdin 에 TTY 를
  // 요구하지 않음이 확인됐다. 그래서 argv 로 나가던 지시문+본문을 stdin 파일로 옮기고,
  // systemPromptFile 은 무시한다(codex 가 읽는 수단이 없음 — 이것은 #92 수정 당시부터
  // 같았고, 이 수정에서 바뀐 것은 argv 에 있는 프롬프트를 stdin 으로 옮긴 것뿐이다).
  prompt: (_systemPrompt, _promptCtx, mode, _systemPromptFile) => {
    // 인터랙티브 턴은 사람이 직접 입력하므로 프롬프트 위치인자가 없다.
    if (mode !== 'mention') return [];
    // 프롬프트 내용은 stdin 파일로 가므로 argv 에는 nothing.
    return [];
  },
};

/**
 * opencode (1.18.31 실측, 2026-09-22 — 세 번째 하네스).
 *
 * 앞의 둘과 다른 점이 셋이다:
 *
 * 1. **TUI 가 기본 커맨드**다(`opencode [project]`). 서브커맨드를 고를 것이 없어 세션이
 *    순수 플래그(`-s <id>`)로 끝난다 — codex 의 `exec`/`resume` 비대칭이 여기엔 없다.
 * 2. **MCP 를 argv 로 못 넘긴다.** 등록 수단이 설정 파일뿐이라 러너 전용 루트에 미리
 *    적어 둔다(`opencodeHome.ts`). 그래서 `mcp()` 가 빈 배열이다 — **비어 있다는 것이
 *    "안 붙인다"는 뜻이 아니다.** 브릿지는 그 파일에 `type: local` 로 들어간다.
 * 3. **권한이 플래그가 아니라 에이전트**다. `--auto` 는 자동 승인이지만 읽기 전용에
 *    해당하는 플래그가 없어, 설정에 권한을 `deny` 로 박은 에이전트를 정의해 두고
 *    `--agent` 로 고른다(실측: 쓰기를 시켰더니 파일이 안 생겼다).
 *
 * 프롬프트를 argv 로 넘기는 길(`--prompt "<본문>"`)이 실제로 있고 돌아간다 — **쓰지 않는다.**
 * 대화 본문이 argv 에 오르면 같은 기계의 다른 로컬 사용자가 `ps` 로 그대로 읽는다(#117).
 * 붙여넣기 주입이 실물로 되는 것을 확인했으므로 그 길로 간다.
 */
const OPENCODE_PRESET: HarnessPreset = {
  command: 'opencode',
  session: (sessionId) => (sessionId === null ? [] : ['-s', sessionId]),
  allowsNullSessionOnFirstTurn: true,
  permission: {
    // "explicitly denied 가 아닌 권한을 자동 승인한다"(실측 `--help`). 멘션 턴은 사람이
    // 화면 앞에 없으므로 이것이 없으면 첫 도구에서 멈춘다.
    auto: ['--auto'],
    // 권한을 `deny` 로 박아 둔 에이전트를 고른다(`opencodeHome.ts` 가 설정에 적는다).
    // `--auto` 를 함께 주지 않는다 — 자동 승인과 읽기 전용은 같이 갈 수 없다.
    readonly: ['--agent', OPENCODE_READONLY_AGENT],
  },
  // API 키 연결 턴은 `--auto` 를 쓰지 않는다 — 권한 표를 박은 lane 에이전트만 고른다(`OPENCODE_LANE_PERMISSION`).
  // 읽기 전용 lane 턴은 위 `readonly` 를 그대로 쓴다.
  lanePermission: { auto: ['--agent', OPENCODE_LANE_AGENT] },
  // 채널별 lane 에이전트(그 채널의 승인된 명령 전체 규칙만 셸이 열린 칸, `opencodeHome.ts`). 러너가 그 턴의 채널 id 로 이름을 정한다(U3).
  laneAgentArgs: (agent) => ['--agent', agent],
  mcp: () => [],
  model: (model) => (model ? ['-m', model] : []),
  // `--variant`(provider-specific reasoning effort). harkroom 의 값과 어떻게 맞물리는지는
  // 미측정이라 있을 때만 그대로 넘긴다(codex 의 `model_reasoning_effort` 와 같은 상태).
  effort: (effort) => (effort ? ['--variant', effort] : []),
  alwaysArgs: () => [],
  // 지시문도 본문도 argv 에 오르지 않는다 — 둘 다 PTY 주입으로 간다(`prefixesSystemPrompt`).
  prompt: () => [],
};

/**
 * Kilo Code CLI (7.8.1 실측, 2026-10-01) — opencode 포크라 **실행 파일 이름만** 다르다.
 * 플래그(`-s`·`--auto`·`--agent`·`-m`·`--variant`)가 그대로이고, 설정·로그인 자리는 표의
 * `xdgApp` 이 가른다(`adapters/kilo.ts`).
 *
 * **`--auto` 와 읽기 전용 에이전트를 같이 주지 않는 것이 여기서는 보안 경계다**(실측): Kilo 는
 * 둘을 같이 받으면 deny 된 bash 를 그대로 실행했다. opencode 프리셋도 둘을 따로 주므로
 * 그 규칙을 그대로 물려받는다 — 회귀선 `test/turn.test.ts` 의 kilo readonly 줄.
 */
const KILO_PRESET: HarnessPreset = { ...OPENCODE_PRESET, command: 'kilo' };

/**
 * pi (0.99.2 실측, 2026-10-01). 앞의 하네스들과 다른 점:
 *
 * 1. **세션 인자가 하나다.** `--session-id <uuid>` 가 "있으면 이어 가고 없으면 만든다" — 첫 턴과
 *    이후 턴이 같은 인자다(claude 는 `--session-id`/`-r` 로 갈린다). 그래도 러너가 첫 턴에 uuid 를
 *    미리 발급하므로 `allowsNullSessionOnFirstTurn` 은 거짓이다.
 * 2. **권한 플래그가 없다.** auto 는 아무것도 안 붙이는 것이고(원래 묻지 않는다), 읽기 전용은
 *    `buildTurnCommand` 가 `--tools <readonlyToolList>` 를 붙인다 — 목록이 턴마다 하네스에게 물어
 *    얻는 값이라(MCP 도구 이름) 이 표에 정적으로 못 둔다.
 * 3. **`--no-approve`** — 워크스페이스의 `.pi/`(확장·설정)를 들이지 않는다. 확장은 pi 프로세스 안에서
 *    도는 코드라 저장소가 심어 둔 것을 실행하게 되고, 들일지 묻는 화면이 뜨면 주입이 그 모달에 들어간다.
 */
const PI_PRESET: HarnessPreset = {
  command: 'pi',
  session: (sessionId) => ['--session-id', sessionId as string],
  allowsNullSessionOnFirstTurn: false,
  permission: { auto: [], readonly: [] },
  mcp: () => [],
  model: (model) => (model ? ['--model', model] : []),
  effort: (effort) => (effort ? ['--thinking', effort] : []),
  alwaysArgs: () => ['--no-approve'],
  // API 키 연결 턴은 context 파일(`AGENTS.md`·`CLAUDE.md`)을 읽지 않는다 — 지시는 러너가 준 `--append-system-prompt` 하나다.
  // 회귀선 `test/piLaneProjectConfig.real.test.ts`.
  laneArgs: () => ['--no-context-files'],
  // 지시문은 파일 경로로 — `--append-system-prompt` 는 경로를 받으면 **파일 내용을** 붙인다(실측).
  // 본문은 PTY 주입으로 간다(argv 로 넘기면 `ps` 에 샌다, #117).
  prompt: (systemPrompt, _promptCtx, _mode, systemPromptFile) => {
    if (systemPrompt && !systemPromptFile) {
      throw new Error('buildTurnCommand: pi 는 지시문을 파일로만 받는다 — systemPromptFile 이 비어 있다(#92)');
    }
    return systemPromptFile ? ['--append-system-prompt', systemPromptFile] : [];
  },
};

/**
 * omp (oh-my-pi 18.12.6 실측, 2026-10-24) — pi 포크. pi 와 다른 점:
 *
 * 1. **`--session-id` 가 없다.** 러너가 첫 턴 전에 헤더 한 줄 파일을 `--session-dir` 에 써 두고
 *    (`ompHome.ts::writeOmpSessionHeader`) 첫 턴부터 `--resume <uuid>` 로 띄운다 — 첫 턴과 이후 턴이 같은 인자다.
 * 2. **cwd 가 작업 폴더가 아니다.** 저장소의 `.omp/`·`.mcp.json`·`.env` 를 신뢰를 묻지 않고 읽어서, cwd 는
 *    빈 폴더로 옮기고 작업 폴더는 `--add-dir` 로 붙인다(security B4). 그 인자·`--config` 오버레이(C4)·
 *    `--session-dir` 은 `buildTurnCommand` 가 상태 루트로 짓는다 — 이 표에는 정적인 것만 둔다.
 * 3. **`--no-extensions`** — 확장은 omp 프로세스 안에서 도는 코드다. 홈을 격리했지만 발견 자체를 끈다.
 *    `--no-title` — 제목을 짓는 모델 호출 한 번을 아낀다.
 */
const OMP_PRESET: HarnessPreset = {
  command: 'omp',
  session: (sessionId) => ['--resume', sessionId as string],
  allowsNullSessionOnFirstTurn: false,
  permission: { auto: [], readonly: [] },
  mcp: () => [],
  model: (model) => (model ? ['--model', model] : []),
  effort: (effort) => (effort ? ['--thinking', effort] : []),
  alwaysArgs: () => ['--no-extensions', '--no-title'],
  prompt: (systemPrompt, _promptCtx, _mode, systemPromptFile) => {
    if (systemPrompt && !systemPromptFile) {
      throw new Error('buildTurnCommand: omp 는 지시문을 파일로만 받는다 — systemPromptFile 이 비어 있다(#92)');
    }
    return systemPromptFile ? ['--append-system-prompt', systemPromptFile] : [];
  },
};

const PRESETS: Record<AgentHarness, HarnessPreset | 'unsupported'> = {
  'claude-code': CLAUDE_PRESET,
  codex: CODEX_PRESET,
  // 실물로 재고 열었다(2026-09-22): 브릿지 MCP · 붙여넣기 주입 · readonly 에이전트 · 세션 발견.
  opencode: OPENCODE_PRESET,
  kilo: KILO_PRESET,
  pi: PI_PRESET,
  omp: OMP_PRESET,
  gemini: 'unsupported',
};

/**
 * sessionId 가 null 인 조합 중 유효한 것은 "`allowsNullSessionOnFirstTurn` 인 harness 의
 * **첫 턴**"뿐이다. 그 밖의 조합(resume 인데 id 가 없다, claude 인데 id 가 없다)은
 * 호출자가 세션을 먼저 확보하지 않은 결함이다 — 조용히 삼켜 이상한 명령을 조립하느니
 * 여기서 크게 던진다(design.md 의 "없는 것을 있다고 표시하지 않는다"와 같은 결).
 *
 * 초판은 인터랙티브를 통째로 걸렀다("인터랙티브인데 이어받을 게 없다") — 그때는 사람이
 * 여는 경로 자체가 없어 인터랙티브가 항상 resume 이었기 때문이다. #337 이 "세션 없는
 * 스레드에서 [터미널 열기]"를 열면서 인터랙티브에도 첫 턴이 생겼으므로, 조건을 모드가
 * 아니라 **isFirstTurn** 으로 완화한다. Codex도 첫 대화형 턴을 세션 id 없이 시작하고,
 * 종료 뒤 rollout 파일에서 id를 발견한다.
 *
 * harness 이름은 여기서 보지 않는다 — preset 의 표 필드만 읽는다(그래야 네 번째 harness
 * 를 붙일 때 이 함수가 아니라 표만 고치면 된다).
 */
function assertValidSession(
  opts: Pick<BuildTurnCommandOptions, 'harness' | 'mode' | 'sessionId' | 'isFirstTurn'>,
  preset: HarnessPreset,
): void {
  if (opts.sessionId !== null) return;
  const allowed = preset.allowsNullSessionOnFirstTurn && opts.isFirstTurn;
  if (allowed) return;
  throw new Error(
    `buildTurnCommand: sessionId 가 null 이다 (harness=${opts.harness}, mode=${opts.mode}, ` +
      `isFirstTurn=${opts.isFirstTurn}) — 이 harness/모드 조합에서는 호출자가 세션 id 를 ` +
      '먼저 확보했어야 한다 (sessions.ts::SessionRecord 참고)',
  );
}

/**
 * 새 SessionRecord 를 만들 때 sessionId 를 러너가 미리 발급해야 하는 harness 인가
 * (main.ts::runMentionTurn). harness 이름을 main.ts 에서 직접 비교하면 이 표(PRESETS)와
 * 진실 원천이 둘로 갈린다 — `allowsNullSessionOnFirstTurn` 하나로 양쪽을 다 결정한다.
 */
export function preassignsSessionId(harness: AgentHarness): boolean {
  const preset = PRESETS[harness];
  if (preset === 'unsupported') {
    throw new Error(`preassignsSessionId: harness '${harness}' 는 러너가 아직 지원하지 않는다`);
  }
  return !preset.allowsNullSessionOnFirstTurn;
}

/** 이 턴에 턴 도중 새 글 hook 이 실제로 붙는가 — 프롬프트가 그 글을 안내할지 정한다. 판정은 `attachesCommandHook` 처럼 프리셋에 묻는다. */
export function attachesPostToolHook(harness: AgentHarness, mentionPermission: MentionPermission): boolean {
  const preset = PRESETS[harness];
  if (preset === 'unsupported') return false;
  const args = preset.permissionRules?.({ mode: 'mention', mentionPermission, operatorBin: '/x', mergeRepos: [], postToolSinceSeq: 0 }) ?? [];
  const i = args.indexOf('--settings');
  return i >= 0 && (args[i + 1] ?? '').includes('PostToolUse');
}

/**
 * 이 턴에 「정확한 명령」 hook(H③b)이 실제로 붙는가 — 프롬프트가 kind command 를 권할지 정한다(security n3).
 * 하네스 이름을 비교하지 않고 그 하네스의 `permissionRules` 가 `--settings` 를 내는지를 그대로 묻는다 — 판정이 한 곳에 산다.
 */
export function attachesCommandHook(harness: AgentHarness, mentionPermission: MentionPermission, commandHook: boolean): boolean {
  if (!commandHook) return false;
  const preset = PRESETS[harness];
  if (preset === 'unsupported') return false;
  return (preset.permissionRules?.({ mode: 'mention', mentionPermission, operatorBin: '/x', mergeRepos: [], commandHook: true }) ?? []).includes('--settings');
}

/**
 * RUNNABLE_HARNESSES 계약 검사. main.ts 가 기동할 때 이 함수를 불러서,
 * 설정된 실행 가능 목록의 모든 harness 가 실제로 구현돼 있는지 확인한다.
 * 반대 방향(PRESETS 에 있지만 RUNNABLE 에 없는) 은 검사하지 않는다 —
 * "구현은 됐지만 아직 열지 않았다"는 정당한 상태다.
 *
 * @param runnableHarnesses 검사할 harness 목록. 생략하면 shared 의 RUNNABLE_HARNESSES 를 쓴다.
 */
export function assertHarnessContract(runnableHarnesses?: readonly AgentHarness[]): void {
  const harnesses = runnableHarnesses ?? RUNNABLE_HARNESSES;
  for (const name of harnesses) {
    if (PRESETS[name] === 'unsupported') {
      throw new Error(
        `harness 계약 불일치: RUNNABLE_HARNESSES 에 '${name}' 이(가) 있지만 PRESETS 에는 구현이 없다. ` +
          '실행하려면 PRESETS 에 실제 구현을 추가하거나, RUNNABLE_HARNESSES 에서 제거해야 한다.',
      );
    }
  }
}

/**
 * 에이전트가 직접 main 을 바꾸는 길(실수 방지). 우회가 쉬운 가드레일이다 — 경계는 아니다.
 *
 * **규칙 문법은 접두(`:*` = 접두 + 단어 경계) 아니면 정확 일치뿐이다**(실측 2026-10-02 P2, claude 2.1.287):
 * `Bash(git push:* main)`·`Bash(gh api:*pulls/…/merge*)` 같은 **가운데 와일드카드는 아무것도 맞추지 않는다** —
 * 그 명령은 규칙이 아니라 분류기가 막았고(`git push origin main` 은 아예 실행됐다), 정확 일치 `Bash(git push origin
 * main)` 은 "has been denied" 로 결정적으로 막았다. 그래서 여기엔 실제로 맞는 모양만 둔다:
 * - `gh pr merge:*` 접두(T2) · `gh api -X PUT:*`/`--method PUT:*` 접두(머지 엔드포인트는 PUT 이다 — 읽기 `gh api` 는
 *   그대로 된다, T3) · main 으로의 흔한 push 정확 일치 넷.
 * - `gh api graphql …mergePullRequest` 와 그 밖의 push 모양(`--force-with-lease`, `-u`, 다른 리모트 이름)은 규칙으로
 *   표현할 수 없어 **분류기에 남는다**. 넓은 `git push:*` 로 막으면 PR 올리기가 죽는다.
 */
export const MERGE_DENY_RULES: readonly string[] = [
  'Bash(gh pr merge:*)',
  'Bash(gh api -X PUT:*)',
  'Bash(gh api --method PUT:*)',
  'Bash(git push origin main)',
  'Bash(git push origin HEAD:main)',
  'Bash(git push -u origin main)',
  'Bash(git push --force origin main)',
];

/**
 * 에이전트가 작업 폴더의 Claude Code 설정을 고쳐 **스스로 allow 를 넣는 길**을 막는다(권한 요청 스레드 f61af808). 권한은 서버
 * grant → argv 로만 들어온다. 프로젝트(`.claude/settings.json`)·로컬(`.claude/settings.local.json`) 둘 다, 어느 깊이든.
 * Bash 로 파일을 쓰는 길은 이 규칙이 닫지 못한다 — 그쪽은 분류기와 security 검토 항목이다.
 */
export const SETTINGS_SELF_EDIT_DENY_RULES: readonly string[] = [
  'Edit(**/.claude/settings.json)',
  'Edit(**/.claude/settings.local.json)',
];

/**
 * 계정 config 의 settings.json(security R2) — `CLAUDE_CONFIG_DIR` 는 그 **풀의 모든 에이전트**가 함께 쓰므로 cwd 기준 규칙으로는
 * 안 덮인다. 절대 경로는 `//` 로 시작한다(claude 문법). config dir 을 주입하지 않는 턴(시스템 기본)은 `~/.claude`.
 * Edit 규칙은 Write(새로 만들기)도 막는다 — 실측 2026-10-07(claude 2.1.292, 스레드 f61af808): 같은 프롬프트로 deny 없이는
 * 「permissions to write … haven't granted」, deny 를 주면 「denied by your permission settings」.
 */
export function configSettingsDenyRules(claudeConfigDir: string | null): string[] {
  if (claudeConfigDir === null) return ['Edit(~/.claude/settings.json)', 'Edit(~/.claude/settings.local.json)'];
  const abs = claudeConfigDir.replace(/\/+$/, '');
  return [`Edit(/${abs}/settings.json)`, `Edit(/${abs}/settings.local.json)`];
}

/**
 * 서버가 준 allow 규칙을 argv 에 넣기 전에 한 번 더 판정한다(서버 판정이 정본이고 이것은 마지막 울타리다).
 */
export function safeToolAllows(rules: readonly string[]): string[] {
  // security R1: 서버와 **같은** 판정(shared `validateToolRule`)을 쓴다 — 정규형 그대로인 것만. 서버 판정을 고치면 러너도 따라온다.
  return rules.filter((r) => {
    const v = validateToolRule(r);
    return v.ok && v.rule === r;
  });
}

/**
 * 이 턴에 Claude in Chrome 을 여는가(스레드 e8c8365d). **둘 다 참일 때만** 연다 — 에이전트 소유자가 켰고(`chromeEnabled`,
 * 서버 값·옛 서버는 싣지 않으니 없음=꺼짐), 이 머신이 열 수 있다(`chromeHost`: 앱이 띄운 로컬 오퍼레이터 + native host).
 * 원격 오퍼레이터에서는 사람의 브라우저가 거기 없으므로 설정값과 상관없이 닫힌다. 읽기 전용 에이전트도 닫힌다.
 */
export function chromeTurnFor(def: { chromeEnabled?: boolean; mentionPermission?: MentionPermission }, chromeHost: boolean | undefined): boolean {
  // 읽기 전용 에이전트는 닫는다(security n1): plan 모드가 페이지 클릭·폼 입력처럼 **바깥 웹에 쓰는** 동작을 어디까지
  // 막는지 재지 않았다. 열어 두면 「읽기 전용」이 사람의 로그인된 사이트에서 쓰기를 할 수 있는 길이 된다.
  if (def.mentionPermission === 'readonly') return false;
  return def.chromeEnabled === true && chromeHost === true;
}

export function buildTurnCommand(opts: BuildTurnCommandOptions): TurnPlan {
  const preset = PRESETS[opts.harness];
  if (preset === 'unsupported') {
    throw new Error(
      `buildTurnCommand: harness '${opts.harness}' 는 러너가 아직 지원하지 않는다 — ` +
        'RUNNABLE_HARNESSES 에 없어야 정상이므로, 여기 도달했다면 상위 호출부의 결함이다',
    );
  }
  assertValidSession(opts, preset);
  if (!opts.operatorBin) {
    // 타입은 필수(string)로 강제하지만, 빈 문자열은 타입 체크를 통과하고도 같은 조용한
    // 실패(harkroom MCP 미등록 → 답 못 함 → "답 없이 턴을 끝냈습니다")로 이어진다 — 여기서 막는다.
    throw new Error('buildTurnCommand: operatorBin 이 비어 있다 — harkroom MCP(mcp-bridge) 없이는 에이전트가 답할 방법이 없다');
  }
  // 이름이 아니라 표에 묻는다(`usesXdgHome`) — 이름 비교의 예산은 어댑터 표가 대신 진다.
  if (usesXdgHome(opts.harness) && !opts.opencodeHome) {
    throw new Error('buildTurnCommand: opencodeHome 이 비어 있다 — 개인 opencode 설정·MCP 를 격리할 수 없다');
  }
  if (usesPiHome(opts.harness) && !opts.piHome) {
    throw new Error('buildTurnCommand: piHome 이 비어 있다 — 개인 pi 설정·확장·MCP 를 격리할 수 없다');
  }
  const omp = usesOmpHome(opts.harness);
  if (omp && (!opts.ompHome || !opts.ompThread?.cwd || !opts.ompThread.agentDir || !opts.workspaceDir)) {
    throw new Error('buildTurnCommand: omp 의 ompHome·ompThread·workspaceDir 중 빈 것이 있다 — 저장소 설정을 막을 수 없다(security B4)');
  }
  if (omp && `${opts.ompThread!.cwd}/`.startsWith(`${opts.workspaceDir as string}/`)) {
    throw new Error('buildTurnCommand: omp 의 cwd 가 작업 폴더 안에 있다 — 저장소 설정이 실린다(security B4·C2)');
  }
  const allowlist = readonlyToolsFor(opts.harness);
  const readonlyByList = allowlist !== null && opts.mode === 'mention' && opts.mentionPermission === 'readonly';
  if (readonlyByList && !opts.readonlyToolList) {
    throw new Error(
      `buildTurnCommand: ${opts.harness} 의 읽기 전용 턴에 허용 도구 목록이 없다 — 그대로 뜨면 쓰기·셸이 열린다`,
    );
  }
  if (opts.harness === 'codex' && !opts.codexHome) {
    throw new Error('buildTurnCommand: codexHome 이 비어 있다 — 개인 Codex 설정을 격리할 수 없다');
  }

  // 전용 제공사 경로의 턴인가 — env 를 받는 것과 같은 조건(`providerEnv`)으로 가른다. 권한 플래그가 다르다(`lanePermission`).
  const providerLane = opts.providerEnv != null;
  if (opts.turnKeys && !turnKeyDelivery(opts.harness)) {
    throw new Error(`buildTurnCommand: ${opts.harness} 에는 다리 열쇠를 셸 밖으로 줄 길이 없다 — 턴 열쇠를 주지 마라`);
  }
  // opencode 는 다리 열쇠가 턴 설정 파일에만 있다 — 그 파일 없이 열쇠를 주면 셸 열쇠만 있고 다리는 붙지 못한다.
  if (opts.turnKeys && turnKeyDeliveryOf(opts.harness) === 'turn-config-env' && !opts.opencodeTurnConfig) {
    throw new Error(`buildTurnCommand: ${opts.harness} 턴 열쇠에는 턴 설정 파일이 있어야 한다`);
  }
  const turnKeys = opts.turnKeys ?? null;
  const args: string[] = [
    ...preset.session(opts.sessionId, opts.isFirstTurn, opts.mode),
    ...preset.alwaysArgs(opts.mode),
    ...(opts.mode === 'mention'
      ? (providerLane && opts.mentionPermission === 'auto' && opts.laneAgent && preset.laneAgentArgs ? preset.laneAgentArgs(opts.laneAgent) : undefined)
        ?? (providerLane ? preset.lanePermission?.[opts.mentionPermission] : undefined) ?? preset.permission[opts.mentionPermission]
      : []),
    ...(preset.permissionRules?.({ mode: opts.mode, mentionPermission: opts.mentionPermission, operatorBin: opts.operatorBin, mergeRepos: opts.mergeRepos ?? [], apiConnectors: opts.apiConnectors ?? [], apiDelegatable: opts.apiDelegatable ?? [], toolAllows: opts.toolAllows ?? [], claudeConfigDir: opts.claudeConfigDir ?? null, commandHook: opts.commandHook === true, providerLane, postToolSinceSeq: opts.postToolSinceSeq ?? null }) ?? []),
    ...(readonlyByList ? ['--tools', opts.readonlyToolList as string] : []),
    ...(preset.chrome?.(opts.chrome === true) ?? []),
    // pi 의 세션 자리는 **저장소가 정할 수 있다**(`.pi/settings.json` 의 `sessionDir`, 신뢰 판정 전) —
    // CLI 인자로 러너 루트에 못박는다(`piHome.ts::piSessionsDir`, security U1).
    ...(usesPiHome(opts.harness) ? ['--session-dir', piSessionsDir(opts.piHome as string)] : []),
    // omp: 세션 자리·오버레이·작업 폴더를 상태 루트로 못박는다(`ompHome.ts`, security B4·C4).
    ...(omp ? [
      '--session-dir', ompDirs(opts.ompHome as string).sessionsDir,
      '--config', ompDirs(opts.ompHome as string).overlay,
      '--cwd', opts.ompThread!.cwd,
      '--add-dir', opts.workspaceDir as string,
    ] : []),
    ...preset.mcp({ mcpConfigPath: opts.mcpConfigPath, operatorBin: opts.operatorBin, extraMcpServers: opts.extraMcpServers ?? {}, turnKeys: turnKeys !== null }),
    ...(opts.providerEnv ? preset.laneArgs?.(opts.providerEnv) ?? [] : []),
    ...preset.model(opts.model),
    ...preset.effort(opts.effort),
    ...preset.prompt(opts.systemPrompt, opts.mode === 'mention' ? opts.promptCtx : '', opts.mode, opts.systemPromptFile ?? null),
  ];

  // PAT 는 절대 argv 에 올리지 않는다 — 자식 프로세스 env 로만 준다. `ps` 로 argv 는 다른
  // 사용자에게도 보이지만 env 는 보이지 않는다(spec §7, task-1 실측 확인).
  // stdinFile 도 argv 에서 빼는 이유와 같다(#117). null 이면 PTY stdin 을 그대로 쓴다.
  return {
    command: preset.command,
    args,
    env: {
      ...childEnv({
      harness: opts.harness,
      codexHome: opts.harness === 'codex' ? opts.codexHome : null,
      opencodeHome: usesXdgHome(opts.harness) ? (opts.opencodeHome ?? null) : null,
      piHome: usesPiHome(opts.harness) ? (opts.piHome ?? null) : null,
      ompHome: omp ? (opts.ompHome ?? null) : null,
      ompAgentDir: omp ? opts.ompThread!.agentDir : null,
      claudeConfigDir: opts.harness === 'claude-code' ? opts.claudeConfigDir : null,
      causeMessageId: opts.causeMessageId ?? null,
      turnId: opts.turnId ?? null,
      providerEnv: opts.providerEnv ?? null,
      ghConfigDir: laneGhConfigDir(opts.harness, opts.providerEnv != null, opts.toolAllows ?? []),
      turnKeys,
      opencodeTurnConfig: opts.opencodeTurnConfig ?? null,
      }),
      ...(preset.mcpEnv?.(opts.extraMcpServers ?? {}) ?? {}),
      ...(opts.commandRuleEnv ?? {}),
    },
    stdinFile: opts.stdinFile ?? null,
    ...(omp ? { cwd: opts.ompThread!.cwd } : {}),
  };
}

/**
 * 자식 하네스에 물려주지 **않는** env 키(#374). 부모 env 전체 상속(아래 `childEnv`)의 유일한
 * 예외이고, 목록은 **실측된 것만** 담는다.
 *
 * `CLAUDE_CODE_CHILD_SESSION` — Claude Code 가 자기 안에서 뜬 자식 프로세스를 표시하려고
 * 넣는 마커다. 이 마커를 물려받은 `claude` 는 대화 전사 저장을 끄고("Transcript saving is
 * off"), 그러면 `~/.claude/projects/<cwd>/<uuid>.jsonl` 이 안 생긴다(#348 스파이크 §2 실측).
 * 세션 파일이 없으면 다음 턴의 `-r <uuid>` resume 이 "No conversation found" 로 죽는다 —
 * 즉 이 마커 하나가 러너의 **턴 이어가기 전체**를 조용히 무너뜨린다.
 *
 * **왜 프로덕션 경로에도 해당하는가.** "러너는 사람의 로그인 셸에서 도니 무관하다"는 것이
 * 스파이크 기록의 판단이었는데, 코드는 그것을 보장하지 않는다: 러너는 데스크탑 앱이 띄우고
 * (#250 `runnerLauncher.ts`), 그 앱이 어디서 떴는지에 따라 env 가 다르다(#305 가 Dock 앱의
 * env 상속이 경로마다 다르다는 것을 이미 실측했다). 도그푸딩 중에는 러너가 Claude Code 세션
 * 안에서 뜨고, 그 셸에는 이 마커가 실제로 들어 있다(2026-09-04 실측). 러너 env 가 무엇인지
 * 우리가 고를 수 없으므로, 자식에게 넘기지 않는 쪽을 이 함수가 보장한다.
 *
 * 앱 경로도 막히지 않는다: `runnerLauncher.ts::tauriSpawner` 는 러너에 `HARKROOM_PAT`·
 * `HARKROOM_URL`·`PATH` 만 넘기지만, `@tauri-apps/plugin-shell` 의 `env` 는 **덮어쓰기가
 * 아니라 추가**다(`index.d.ts`: "Environment variables. set to `null` to clear the process
 * env" — `null` 을 줘야 지워진다). 즉 앱의 env 가 러너에 그대로 상속되고, 앱을 터미널에서
 * 띄웠다면 그 터미널의 마커가 앱 → 러너 → 하네스까지 3단으로 흘러간다.
 *
 * **해악의 범위는 #348 기록보다 좁다는 것도 함께 적어 둔다.** 멘션 턴이 쓰는 `-p` 경로는
 * 마커가 살아 있어도 세션 파일이 생겼다(2026-09-04 실측: 마커가 있는 셸에서
 * `claude -p --session-id <uuid>` → 그 uuid 의 `.jsonl` 생성 확인). #348 이 본 "저장하지
 * 않는다"는 인터랙티브 TUI 경로의 관찰이고, 그 경로는 #374 에서 **재현하지 못했다**(반증이
 * 아니라 미확인이다). 그래도 벗기는 이유: 상속된다는 사실은 확정이고 벗기는 비용이 없다.
 *
 * **`CLAUDE*` 를 통째로 지우지 않는 이유.** 같은 셸에 `CLAUDE_CODE_ENTRYPOINT`·`CLAUDECODE`·
 * `CLAUDE_CODE_SESSION_ID` 등이 함께 있지만(같은 실측), 그것들이 전사 저장을 끈다는 근거는
 * 없다. 근거 없이 지우면 하네스가 정상 동작에 쓰는 것을 뺏을 수 있다 — 전체 상속을 택한
 * `childEnv` 주석의 논리가 여기에도 그대로 적용된다. 새로 넣을 키는 실측을 먼저 하라.
 */
/**
 * **인증 주입 키 넷(2026-09-07).** `ANTHROPIC_API_KEY`·`ANTHROPIC_AUTH_TOKEN`·
 * `CLAUDE_CODE_OAUTH_TOKEN`·`AWS_BEARER_TOKEN_BEDROCK` 는 claude 가 자격증명 저장소보다
 * **먼저** 보는 입력이다. 하나라도 부모 env 에 있으면 아래 `CLAUDE_CONFIG_DIR` 계정 격리가
 * **조용히** 무력해진다 — 계정을 바꿨는데 안 바뀌는 이번 결함의 다른 얼굴이다.
 *
 * 러너는 데몬 env 전체를 상속하고(`desktop/src/lib/runnerLauncher.ts` 의
 * `daemon_spawn_runner` 는 `HARKROOM_PAT`·`HARKROOM_URL`·`PATH` 만 넘긴다) 데몬은 자기를 띄운
 * 셸의 env 를 상속한다 — 즉 이 키가 어디서 들어올지 우리가 통제할 수 없다. 그래서 상속을
 * 막는 쪽이 맞다.
 *
 * 실측 근거: Orca 도 claude 를 계정별 `CLAUDE_CONFIG_DIR` 로 띄우면서 정확히 이 넷을
 * 지운다(`stripAuthEnv`). 같은 목적에 같은 목록이 필요하다는 독립 확인이다.
 *
 * **API 키로 러너를 돌리던 사람에게는 파괴적 변경이다.** 그러나 `config.ts` 가 이미
 * "claude-code harness 는 claude CLI 의 자격증명을 쓰므로 API 키도 필요 없다"고 적어 뒀다 —
 * 지원한 적 없는 경로다.
 */
export const HARNESS_ENV_DENYLIST = [
  'CLAUDE_CODE_CHILD_SESSION',
  'ANTHROPIC_API_KEY',
  'ANTHROPIC_AUTH_TOKEN',
  'CLAUDE_CODE_OAUTH_TOKEN',
  'AWS_BEARER_TOKEN_BEDROCK',
] as const;

/**
 * API 키 연결 턴의 하네스 env 는 **물려받지 않고 허용 목록으로 짓는다**(security W2, L1b). 사람 셸에서 온 자격 정보(`GITHUB_TOKEN`·
 * 클라우드 키·다른 제공사 키 등)가 새 이름으로 생겨도 기본이 닫힌 쪽이다. lane 하네스는 사람 로그인(Keychain)을 쓰지 않으므로
 * 구독형 턴이 전체를 물려받는 까닭(아래 `buildChildEnv` 주석)이 여기에는 없다. 그 턴의 키·하네스 홈·턴 id 는 이 목록 **뒤에** 얹는다.
 */
export const LANE_ENV_ALLOW: ReadonlySet<string> = new Set([
  'PATH', 'HOME', 'USER', 'LOGNAME', 'SHELL', 'TERM', 'COLORTERM', 'LANG', 'TMPDIR', 'TZ',
  // 회사망 프록시·사설 인증서 — gateway 에 닿는 데 필요할 수 있다(값은 비밀이 아니다).
  'HTTP_PROXY', 'HTTPS_PROXY', 'NO_PROXY', 'ALL_PROXY', 'http_proxy', 'https_proxy', 'no_proxy', 'all_proxy',
  'NODE_EXTRA_CA_CERTS', 'SSL_CERT_FILE', 'SSL_CERT_DIR',
  // harkroom 브릿지(`mcp-bridge`)가 오퍼레이터에 붙는 데 쓰는 이름 — 하네스가 MCP 자식에 물려준다.
  'HARKROOM_OPERATOR_SOCKET', 'HARKROOM_RUNNER_ID', 'HARKROOM_RUNNER_SECRET', 'HARKROOM_MCP_READY_FILE', 'HARKROOM_OPERATOR_VERSION',
]);
const LANE_ENV_ALLOW_PREFIXES = ['LC_', 'XDG_'] as const;

export function laneEnvAllowed(key: string): boolean {
  return LANE_ENV_ALLOW.has(key) || LANE_ENV_ALLOW_PREFIXES.some((p) => key.startsWith(p));
}

export const GH_CONFIG_DIR_ENV = 'GH_CONFIG_DIR';

/**
 * API 키 연결 opencode 턴의 gh 설정 자리. 격리 홈이 `XDG_CONFIG_HOME` 을 바꾸므로 gh 가 이 맥의 로그인을 찾게 원래 자리를 준다.
 * 그 턴의 승인 규칙에 `gh` 로 시작하는 셸 명령이 있을 때만 준다 — 없으면 null(gh 는 로그인 없이 돈다). 값은 경로 하나이고
 * 토큰은 싣지 않는다(gh 가 그 자리의 설정대로 자격을 꺼낸다). 자리는 러너 env 의 원래 `XDG_CONFIG_HOME`(없으면 홈 기본)/gh 다.
 */
/** gh 설정 자리를 돌려줄 하네스(격리 홈이 `XDG_CONFIG_HOME` 을 바꾸는 lane 하네스 중 잰 것, security H5). */
const LANE_GH_CONFIG_HARNESSES: Partial<Record<AgentHarness, true>> = { opencode: true };

export function laneGhConfigDir(harness: AgentHarness, providerLane: boolean, toolAllows: readonly string[], env: NodeJS.ProcessEnv = process.env): string | null {
  if (!LANE_GH_CONFIG_HARNESSES[harness] || !providerLane) return null;
  if (!toolAllows.some((rule) => /^Bash\(gh(\s|:\*\)$|\)$)/.test(rule))) return null;
  const base = env.XDG_CONFIG_HOME && env.XDG_CONFIG_HOME.startsWith('/') ? env.XDG_CONFIG_HOME : join(homedir(), '.config');
  return join(base, 'gh');
}

/**
 * PTY 자식에 넘길 env. 부모(러너) 전체를 물려주고 `HARKROOM_PAT` 만 덮어쓴다.
 *
 * **실물 검증에서 발견된 회귀다.** `pty.spawn` 은 `env` 를 넘기면 부모 env 와 **병합하지
 * 않고 그 값으로 완전히 대체한다**(node-pty `unixTerminal.js`: `opt.env = opt.env ||
 * process.env` — 넘겼다 하면 그걸로 끝, 상속은 opt.env 를 아예 안 줬을 때뿐이다). 이 함수가
 * 전에는 `{ HARKROOM_PAT: opts.pat }` 하나만 돌려줬는데, 그 결과 자식은 `PATH`·`HOME` 이 통째로
 * 없는 채로 떴다 — `claude`/`codex` 실행 파일을 못 찾거나(PATH), Keychain·`~/.codex/auth.json`
 * 같은 로그인 자격증명을 못 읽어(HOME) 모든 실물 턴이 즉시 실패했다(`harness 종료 1`, 출력
 * 없음). 단위 테스트는 이걸 못 잡았다 — `test/pty.test.ts` 가 가짜 plan 을 만들 때
 * `{ ...process.env, FAKE_MODE }` 로 **직접 부모 env 를 펼쳐서** 이 함수를 우회했기 때문이다
 * (그 우회 자체도 이번에 없앴다). 옛 `child_process.spawn('claude', args)` 시절엔 env 를
 * 아예 안 넘겨 기본적으로 상속됐으므로 이 결함은 PTY 전환이 새로 만든 회귀다.
 *
 * 화이트리스트(PATH·HOME만)가 아니라 전체 상속인 이유: 하네스가 정확히 무엇을 읽는지 우리가
 * 다 알 수 없다 — claude 는 Keychain, codex 는 `~/.codex/auth.json`, 둘 다 XDG_*·TMPDIR·
 * 프록시·로케일 변수에 기댈 수 있다. 옛 동작(전체 상속)으로 되돌리는 것이 회귀 없는 복원이고,
 * 좁히려면 각 하네스가 실제로 무엇을 쓰는지 먼저 측정해야 하는데 그건 이 결함 수정의 범위가
 * 아니다. `process.env` 의 값 타입은 `string | undefined` 라 `TurnPlan.env`(`Record<string,
 * string>`)에 맞추려면 undefined 를 걸러야 한다.
 *
 * **전체 상속에는 예외가 하나 있다(#374)**: `HARNESS_ENV_DENYLIST` 의 키는 넘기지 않는다.
 * 그 목록과 각 키를 빼는 근거는 위 상수의 주석에 있다 — 지우려거든 거기부터 읽어라.
 */
function childEnv(
  homes: {
    harness: AgentHarness;
    codexHome: string | null;
    claudeConfigDir: string | null;
    opencodeHome: string | null;
    piHome?: string | null;
    ompHome?: string | null;
    ompAgentDir?: string | null;
    causeMessageId: string | null;
    turnId?: string | null;
    providerEnv?: Record<string, string> | null;
    ghConfigDir?: string | null;
    turnKeys?: TurnKeys | null;
    opencodeTurnConfig?: string | null;
  },
): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (value !== undefined) env[key] = value;
  }
  // 부모에 있어도 자식에는 없어야 하는 키를 뺀다(#374). 복사 뒤에 지우는 이유: 복사 루프에
  // 조건을 섞으면 '전체 상속'이라는 규칙과 그 예외가 한 줄에 엉켜 둘 다 읽기 어려워진다.
  for (const key of HARNESS_ENV_DENYLIST) delete env[key];
  // API 키 연결 턴은 허용 목록 밖을 걷는다(`LANE_ENV_ALLOW`) — 그 턴의 값은 아래에서 얹는다.
  if (homes.providerEnv) {
    for (const key of Object.keys(env)) if (!laneEnvAllowed(key)) delete env[key];
  }
  // 전용 제공사 경로(security ⓑ): 지운 **뒤에** 이 턴이 받은 값만 얹는다. 허용 목록 밖 키는 조립을 거절한다 —
  // 조용히 버리면 lane 에이전트가 계정 로그인으로 돈다.
  if (homes.providerEnv) {
    const allowed = new Set(providerLaneKeys(homes.harness) ?? []);
    for (const [key, value] of Object.entries(homes.providerEnv)) {
      if (!allowed.has(key)) throw new Error(`buildTurnCommand: 전용 제공사 경로가 ${homes.harness} 에 허용되지 않은 env 를 넣으려 했다: ${key}`);
      env[key] = value;
    }
    // argv 조립에만 쓰는 이름은 하네스 env 에서 뺀다(`PROVIDER_LANE_ARGV_ONLY_KEYS`).
    for (const key of PROVIDER_LANE_ARGV_ONLY_KEYS[homes.harness] ?? []) delete env[key];
    // 고정 스위치는 그 턴이 받은 값 **뒤에** 얹는다 — 부모 env 의 같은 이름이 남아 있어도 이 값이 이긴다.
    Object.assign(env, PROVIDER_LANE_FIXED_ENV[homes.harness] ?? {});
  }
  // PAT 을 덮어쓰던 자리였다. 이제 하네스가 서버에 닿는 길은 `mcp-bridge` 뿐이고, 브릿지가 읽는
  // 것은 러너 env 의 오퍼레이터 소켓·러너 id·secret 이다 — 여기서는 전체 상속으로 하네스까지 간다.
  // **하네스 → 브릿지 한 단은 하네스 몫이다.** claude·opencode 는 MCP 자식에 env 를 물려주지만
  // codex 는 안 물려준다 — 그래서 codex 는 MCP 항목에 `env_vars` 로 셋을 이름 대어 둔다
  // (CODEX_PRESET.mcp). 여기서 넣어 두는 것만으로 브릿지까지 간다고 믿지 마라.
  if (homes.codexHome !== null) env.CODEX_HOME = homes.codexHome;
  // opencode 는 한 변수가 아니라 **XDG 셋**이다. 하나라도 빼면 자격증명만 갈리고 세션은
  // 사람 것과 공유되는 반쪽 격리가 된다(`opencodeHome.ts` 머리말).
  if (homes.opencodeHome !== null) Object.assign(env, opencodeDirs(homes.opencodeHome));
  // lane 턴은 사람 홈의 `~/.opencode` 를 싣지 않게 비워 둔 홈 표지 자리를 준다(`opencodeLaneHome`). 셸의 `HOME` 은 그대로다.
  if (homes.opencodeHome !== null && homes.providerEnv) {
    const testHome = LANE_TEST_HOME_ENV[homes.harness];
    if (!testHome) throw new Error(`buildTurnCommand: ${homes.harness} lane 턴의 홈 표지 이름을 모른다 — 사람 홈 설정이 실린다`);
    env[testHome] = opencodeLaneHome(homes.opencodeHome);
  }
  // gh 설정 자리(`laneGhConfigDir`, API 키 연결 턴만). 부모 env 의 같은 이름은 위 허용 목록이 이미 걷었다 — 러너가 정한 경로 하나만 얹는다.
  if (homes.ghConfigDir) env[GH_CONFIG_DIR_ENV] = homes.ghConfigDir;
  // pi 는 한 변수지만 세션 자리는 따로 바꿀 수 있다(`PI_CODING_AGENT_SESSION_DIR`). 부모 env 의 그
  // 값은 지운다 — 세션 자리는 argv 의 `--session-dir` 하나가 정한다(위 buildTurnCommand, security U1).
  if (homes.piHome) {
    env.PI_CODING_AGENT_DIR = homes.piHome;
    delete env.PI_CODING_AGENT_SESSION_DIR;
  }
  // omp 는 `HOME` 까지 옮긴다(C3) — 로그·natives 캐시가 `$HOME/.omp` 에 남고 natives 는 실행 코드로 실린다.
  // 프로필(`OMP_PROFILE`)은 홈 안의 다른 자리를 고르므로 지운다.
  if (homes.ompHome) {
    env.HOME = ompDirs(homes.ompHome).home;
    env.PI_CODING_AGENT_DIR = homes.ompAgentDir ?? ompDirs(homes.ompHome).agentDir;
    delete env.PI_CODING_AGENT_SESSION_DIR;
    delete env.OMP_PROFILE;
  }
  // **`null` 이면 키 자체를 넣지 않는다.** 빈 문자열을 넣으면 claude 가 그것을 경로로 읽어
  // 엉뚱한 자리에 설정을 만든다 — "계정 지정 없음"은 부재로 표현해야 시스템 기본으로 떨어진다.
  // 계정 풀을 안 만든 러너의 하위 호환이 이 한 줄에 걸려 있다(`claudeAccounts.ts`).
  if (homes.claudeConfigDir !== null) env.CLAUDE_CONFIG_DIR = homes.claudeConfigDir;
  // 턴의 원인 — 없으면 빈 값으로 **덮는다**(옵션 주석). 브릿지는 빈 값을 "없음"으로 읽는다.
  env[RUNNER_TURN_CAUSE_ENV] = homes.causeMessageId ?? '';
  // 턴 id 도 같은 규칙 — 러너 env 의 옛 값을 물려받으면 남의 턴 id 로 글이 적힌다.
  env[RUNNER_TURN_ID_ENV] = homes.turnId ?? '';
  // 턴 자격(`turnKeys.ts`). 러너 env 에 남은 같은 이름은 먼저 지운다 — 남의 턴 열쇠를 물려주지 않게.
  delete env[RUNNER_TURN_KEY_ENV.shell];
  delete env[RUNNER_TURN_KEY_ENV.bridge];
  if (homes.turnKeys) {
    // 턴 자격을 받은 턴은 러너 링크 secret 을 하네스에 넘기지 않는다 — 다리·셸 모두 턴 열쇠로 붙는다.
    delete env[RUNNER_LINK_ENV.secret];
    env[RUNNER_TURN_KEY_ENV.shell] = homes.turnKeys.shell;
    // codex 는 MCP 자식에 `env_vars` 로 이름 댄 것만 넘기므로 다리 열쇠도 하네스 env 에 둔다(셸에서는 `shell_environment_policy` 로 거른다).
    // claude 는 MCP 자식에 env 를 통째로 물려주므로 여기 두면 셸에도 보인다 — 턴 MCP 설정의 `env` 칸으로만 준다.
    if (turnKeyDeliveryOf(homes.harness) === 'env-vars') env[RUNNER_TURN_KEY_ENV.bridge] = homes.turnKeys.bridge;
    // opencode 는 턴 설정 파일의 harkroom 항목 `environment` 로 다리에만 준다 — 그 파일을 이 턴의 설정으로 얹는다.
    if (turnKeyDeliveryOf(homes.harness) === 'turn-config-env' && homes.opencodeTurnConfig) env.OPENCODE_CONFIG = homes.opencodeTurnConfig;
  }
  // **PATH 밖에 설치되는 하네스의 자리를 뒤에 붙인다**(`harnessFallbackBinDirs`).
  // opencode 는 `~/.opencode/bin` 에 깔리고 PATH 는 사람의 셸 rc 에만 들어간다 — 러너는
  // 그 rc 를 안 거치므로 PTY 가 `opencode` 를 못 찾고 죽었다(실측 2026-09-22, 앱 0.3.3).
  // 오퍼레이터는 같은 표를 보고 "설치됨" 이라 말하던 터라 증상이 "설치했는데 왜 안 되지" 로만
  // 보였다. **앞이 아니라 뒤**인 이유: 사람이 PATH 에 둔 것이 있으면 그쪽이 이겨야 한다.
  const path = harnessPath(homes.harness, env.PATH);
  if (path.length > 0) env.PATH = path;
  return env;
}

/**
 * 이 하네스를 **부를 수 있는** PATH — 주어진 PATH 뒤에 설치 관례 자리를 붙인 것.
 *
 * **왜 함수 하나로 모으나**(2026-09-23 실측). `#857` 이 이 규칙을 PTY 자식 env 에만
 * 넣었더니, 턴이 끝난 뒤 세션을 찾는 `execFile`(`opencodeSessions.ts`)이 그대로 남았다 —
 * 그쪽은 러너의 `process.env` 를 쓰는데 거기엔 `~/.opencode/bin` 이 없다. 그래서 **턴은
 * 성공하는데 세션 발견은 매번 실패**했고(ENOENT 를 "세션 없음"으로 삼켰다), opencode
 * 에이전트는 턴마다 맥락을 잃었다. 하네스를 부르는 자리는 전부 이 함수를 지나야 한다.
 *
 * 붙이는 자리가 **뒤**인 이유는 `childEnv` 주석과 같다 — 사람이 PATH 에 둔 것이 이긴다.
 */
export function harnessPath(harness: AgentHarness, basePath: string | undefined): string {
  const fallback = harnessFallbackBinDirs(harness).map((dir) => join(homedir(), ...dir.split('/')));
  if (fallback.length === 0) return basePath ?? '';
  return [...(basePath ? [basePath] : []), ...fallback].join(delimiter);
}

/** 오퍼레이터가 쓴 MCP 설정 파일의 항목 하나(`operator/mcpConfig.ts` 와 같은 모양). */
export type McpServerEntry =
  | { type?: 'stdio'; command: string; args?: string[]; env?: Record<string, string> }
  | { type: 'http' | 'sse'; url: string; headers?: Record<string, string> };

/**
 * `HARKROOM_MCP_CONFIG` 파일에서 **codex 에 `-c` 로 넘길 추가 항목**을 읽는다(스펙 2026-09-20 §6).
 * claude 는 파일을 `--mcp-config` 로 통째로 받으므로 이 함수가 필요 없다. harkroom·avcs 는 codex
 * 프리셋이 이미 굽는다 — 둘을 빼고 돌려준다.
 *
 * 파일이 없거나 깨졌으면 **던진다.** 도구 없이 뜬 에이전트는 에러 없이 돌다가 "못 하겠다"고만
 * 답한다(codex `invalid transport` 사고와 같은 종류) — 기동에서 죽는 편이 낫다.
 */
/**
 * 오퍼레이터가 쓴 표를 **통째로** 읽는다(`harkroom`·`avcs` 포함). opencode 는 이 표 전체를
 * 제 설정 파일로 번역해 써야 하므로(`opencodeHome.ts`) 걸러낸 목록으로는 부족하다 —
 * 브릿지 항목이 빠지면 그 하네스는 답할 길을 잃는다.
 */
export async function readMcpServers(path: string): Promise<Record<string, McpServerEntry>> {
  try {
    const parsed = JSON.parse(await readFile(path, 'utf8')) as { mcpServers?: Record<string, McpServerEntry> };
    return parsed.mcpServers ?? {};
  } catch (err) {
    throw new Error(`HARKROOM_MCP_CONFIG 를 읽을 수 없다(${path}): ${err instanceof Error ? err.message : String(err)} — 오퍼레이터가 spawn 전에 쓰는 파일이다`);
  }
}

export async function readExtraMcpServers(path: string): Promise<Record<string, McpServerEntry>> {
  let parsed: { mcpServers?: Record<string, McpServerEntry> };
  try {
    parsed = JSON.parse(await readFile(path, 'utf8')) as { mcpServers?: Record<string, McpServerEntry> };
  } catch (err) {
    throw new Error(`HARKROOM_MCP_CONFIG 를 읽을 수 없다(${path}): ${err instanceof Error ? err.message : String(err)} — 오퍼레이터가 spawn 전에 쓰는 파일이다`);
  }
  const out: Record<string, McpServerEntry> = {};
  for (const [name, entry] of Object.entries(parsed.mcpServers ?? {})) {
    if (name === 'harkroom' || name === 'avcs') continue;
    out[name] = entry;
  }
  return out;
}

/**
 * `-c` 의 값은 **TOML** 이다. 문자열·배열은 JSON 표기와 겹치지만 표(env·headers)는 아니다 —
 * JSON 의 `{"K":"v"}` 는 TOML 인라인 표가 아니라 파싱 오류다(실측 2026-09-21: codex 0.15x 가
 * `in \`mcp_servers.timing.env\`` 로 거절). TOML 인라인 표는 `{ "K" = "v" }` 다.
 */
function tomlInlineTable(record: Record<string, string>): string {
  return `{ ${Object.entries(record).map(([k, v]) => `${JSON.stringify(k)} = ${JSON.stringify(v)}`).join(', ')} }`;
}

/** `Authorization: Bearer <t>` 를 떼어 낸다. 대소문자는 가리지 않는다(HTTP 헤더 이름). */
function splitBearer(headers: Record<string, string> | undefined): { bearer: string | null; rest: Record<string, string> } {
  const rest: Record<string, string> = {};
  let bearer: string | null = null;
  for (const [k, v] of Object.entries(headers ?? {})) {
    const m = k.toLowerCase() === 'authorization' ? /^Bearer\s+(.+)$/i.exec(v) : null;
    if (m) bearer = m[1]!; else rest[k] = v;
  }
  return { bearer, rest };
}

/** codex 가 그 MCP 의 bearer 토큰을 읽을 env 이름. MCP 이름 문법은 `[a-z0-9-]` 다. */
export function codexBearerEnvName(name: string): string {
  return `HARKROOM_MCP_BEARER_${name.toUpperCase().replace(/[^A-Z0-9]/g, '_')}`;
}

/** codex 자식 env 에 얹을 bearer 토큰들 — `codexMcpFlags` 가 이름만 적은 값이다. */
export function codexBearerEnv(servers: Record<string, McpServerEntry>): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [name, entry] of Object.entries(servers)) {
    if (!('url' in entry)) continue;
    const { bearer } = splitBearer(entry.headers);
    if (bearer !== null) env[codexBearerEnvName(name)] = bearer;
  }
  return env;
}

/** codex 의 `-c mcp_servers.<name>.*` 조각. transport 를 반드시 적는다(프리셋 주석의 2026-09-15 실측). */
function codexMcpFlags(name: string, entry: McpServerEntry): string[] {
  const key = `mcp_servers.${name}`;
  if ('url' in entry) {
    // **Bearer 토큰은 argv 에 굽지 않는다**(2026-09-30). 오퍼레이터가 든 OAuth 토큰이 `Authorization`
    // 으로 오는데, `http_headers` 로 넘기면 `ps` 에 뜬다. codex 는 `bearer_token_env_var` 로 이름만
    // 받고 값은 제 env 에서 꺼낸다(0.154 바이너리에서 키 실재 확인) — 값은 `codexBearerEnv` 가 env 로 준다.
    const { bearer, rest } = splitBearer(entry.headers);
    return [
      '-c', `${key}.transport=${JSON.stringify(entry.type === 'sse' ? 'sse' : 'streamable_http')}`,
      '-c', `${key}.url=${JSON.stringify(entry.url)}`,
      ...(Object.keys(rest).length ? ['-c', `${key}.http_headers=${tomlInlineTable(rest)}`] : []),
      ...(bearer !== null ? ['-c', `${key}.bearer_token_env_var=${JSON.stringify(codexBearerEnvName(name))}`] : []),
    ];
  }
  return [
    '-c', `${key}.transport="stdio"`,
    '-c', `${key}.command=${JSON.stringify(entry.command)}`,
    '-c', `${key}.args=${JSON.stringify(entry.args ?? [])}`,
    ...(entry.env ? ['-c', `${key}.env=${tomlInlineTable(entry.env)}`] : []),
  ];
}

/**
 * 에이전트 지시문을 파일에 쓴다. 이 파일은 claude 에 `--append-system-prompt-file` 로 전달된다.
 *
 * **매 턴 최신 값으로 쓴다** — writeMcpConfigOnce 와 달리 "once" 가 아니다.
 * 이유는 spec §3: "매 턴 재주입"이 보장되어야 하기 때문이다.
 * UI 로 지시문을 바꾸면 다음 턴에 반영돼야 하고, 그렇게 하려면 턴마다 다시 써야 한다.
 *
 * 퍼미션 0600 으로 유지되어 world-readable 이 아니다 — argv 에서 뺀 이유가 이거다.
 * 지시문은 최대 8000자고, 파일 경로는 호출자가 이미 mkdir 로 디렉터리를 만들었다고 가정한다.
 */
/**
 * 상태 디렉터리가 **도는 중에 사라졌을 때** 사람에게 할 말(2026-09-14 실측).
 *
 * ## 무슨 일이 있었나
 *
 * `~/.murmur-agent` → `~/.harkroom-agent` 개명 중, 러너가 도는 채로 디렉터리를 옮겼다.
 * 로그에 남은 것은 이것뿐이었다:
 *
 *     답변 실패 (3/3): ENOENT: no such file or directory,
 *     open '/Users/…/.murmur-agent/forge-…/system-prompt.txt'
 *
 * 사람은 이걸 보고 **원인도 할 일도 알 수 없다.** 에이전트는 그냥 답을 안 한다.
 *
 * ## 왜 여기서 디렉터리를 다시 만들지 않나
 *
 * `mkdir -p` 한 줄이면 이 턴은 살아난다. 그런데 그러면 **옮겨 간 상태와 갈라진 빈
 * 디렉터리**가 옛 경로에 생기고, 러너는 세션 기록이 사라진 채로 계속 돈다 — 사람은
 * 그것을 한참 뒤에, 훨씬 이해하기 어려운 모양으로 발견한다. 조용히 반쯤 고치는 것보다
 * **무엇이 일어났는지 말하고 멈추는 것**이 낫다.
 *
 * ## 왜 폴백이 못 막나
 *
 * `pickRenamedDir` 은 러너가 **뜰 때 한 번** 돈다(`config.ts` 의 `loadConfig` 는
 * `main.ts` 모듈 최상위에서 불린다). 그 뒤에 경로를 옮기면 이미 도는 러너는 정해진
 * 경로를 그대로 붙잡는다 — 폴백이 고칠 수 있는 순간이 이미 지났다.
 */
function 상태디렉터리사라짐(dir: string): string {
  return [
    `상태 디렉터리가 사라졌다: ${dir}`,
    '러너는 뜰 때 이 경로를 한 번 정하고 사는 동안 그대로 쓴다. 도는 중에 그 디렉터리를',
    '옮기면(예: `mv ~/.murmur-agent ~/.harkroom-agent`) 이 러너는 없는 경로를 계속 붙잡는다.',
    '**앱을 재시작하면** 새 경로로 다시 잡는다.',
  ].join('\n');
}

export async function writeSystemPromptFile(dir: string, systemPrompt: string): Promise<string> {
  const filePath = join(dir, 'system-prompt.txt');
  // mode 와 chmod 를 **둘 다** 한다. `writeFile` 의 mode 는 파일을 새로 만들 때만 적용되므로
  // 두 번째 턴부터는(파일이 이미 있다) 아무 일도 하지 않는다 — 그때는 chmod 가 지킨다.
  // 반대로 chmod 만 하면 첫 생성과 chmod 사이에 umask 퍼미션으로 존재하는 창이 생긴다.
  try {
    await writeFile(filePath, systemPrompt, { encoding: 'utf8', mode: 0o600 });
    await chmod(filePath, 0o600);
  } catch (err) {
    if ((err as NodeJS.ErrnoException | null)?.code === 'ENOENT') throw new Error(상태디렉터리사라짐(dir));
    throw err;
  }
  return filePath;
}

/**
 * stdin 리다이렉션용 프롬프트 파일을 쓴다. PTY 에서 stdin 파일 리다이렉션(`< 파일`)을
 * 할 때 그 파일 내용을 다른 로컬 사용자가 `ps` 로 보면 안 되므로(#92), argv 와 같은
 * 방식으로 0600 권한으로 보호한다. 파일 경로는 호출자가 이미 mkdir 로 디렉터리를 만들었다고
 * 가정한다.
 */
export async function writePromptFile(dir: string, prompt: string): Promise<string> {
  const filePath = join(dir, 'stdin-prompt.txt');
  await writeFile(filePath, prompt, { encoding: 'utf8', mode: 0o600 });
  await chmod(filePath, 0o600);
  return filePath;
}
