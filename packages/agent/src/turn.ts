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
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { AgentHarness, MentionPermission } from '@murmur/shared';

export type TurnMode = 'mention' | 'interactive';

export interface TurnPlan {
  command: string;
  args: string[];
  env: Record<string, string>;
}

export interface BuildTurnCommandOptions {
  harness: AgentHarness;
  mode: TurnMode;
  /**
   * null 은 "아직 첫 턴을 못 돌렸다"다(sessions.ts 의 SessionRecord 와 같은 뜻). codex 의
   * 첫 멘션 턴에서만 유효하다 — codex 는 세션 id 를 사전 할당할 수 없어 첫 턴 후에야 안다.
   * claude 는 첫 턴도 러너가 미리 uuid 를 발급해 넘기므로 null 이 오면 호출자 결함이다.
   */
  sessionId: string | null;
  isFirstTurn: boolean;
  /** 매 턴 재주입되는 지시문(spec §3 — UI 수정이 세션 무효화 없이 다음 턴부터 반영되는 이유). */
  systemPrompt: string;
  /** 멘션 모드 전용. 인터랙티브에선 쓰지 않는다 — 사람이 터미널에서 직접 입력한다. */
  promptCtx: string;
  model: string | null;
  effort: string | null;
  mentionPermission: MentionPermission;
  mcpConfigPath: string;
  pat: string;
  /**
   * codex 의 `-c mcp_servers.murmur.url=...` 오버라이드에 필요한 실제 murmur URL. claude 는
   * 이 값을 쓰지 않는다 — `writeMcpConfigOnce` 가 이미 `mcpConfigPath` 파일 안에 실제 URL 을
   * 구워 넣었고 claude 는 그 경로만 넘기면 된다. 반면 codex 는 그 파일을 읽지 않고 턴마다
   * `-c` 로 값을 직접 준다(spec §4·§6 — `codex mcp add` 는 영구 기록이라 금지).
   *
   * **필수다 — 선택 인자로 두지 않는다.** 러너는 더 이상 하네스 출력을 파싱하지 않으므로
   * 에이전트가 답하는 유일한 경로가 murmur MCP 의 `message.post` 다(prompt.ts 의 시스템
   * 프롬프트가 그렇게 지시한다). murmur MCP 없이 뜬 codex 턴은 에러 없이 그냥 돌다가 답을
   * 못 하고, 러너는 "답 없이 턴을 끝냈습니다"만 남긴다 — 원인이 "MCP 가 안 붙었다"라는
   * 단서가 어디에도 안 남는 조용한 실패다. 그래서 이 값을 생략해 조용히 넘어가는 경로 자체를
   * 두지 않는다: 호출자가 안 채우면 여기서 타입 에러로, 넘겼는데 비어 있으면 즉시 예외로 죽는다.
   */
  murmurUrl: string;
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
  allowsNullSessionOnFirstMention: boolean;
  /** mentionPermission → 멘션 턴 전용 권한 플래그. 인터랙티브에선 아예 쓰지 않는다. */
  permission: Record<MentionPermission, string[]>;
  mcp(args: { mcpConfigPath: string; murmurUrl: string }): string[];
  model(model: string | null): string[];
  effort(effort: string | null): string[];
  /**
   * 지시문 + 사용자 프롬프트 조립. claude 는 `--append-system-prompt` 플래그와 위치인자
   * 프롬프트가 분리돼 있지만, codex 는 지시문 주입 플래그 자체가 없어 프롬프트 앞에
   * 접두하는 방식뿐이다(실측, spec §4) — 그래서 반환 형태가 하네스마다 다르다.
   */
  prompt(systemPrompt: string, promptCtx: string, mode: TurnMode): string[];
}

const CLAUDE_PRESET: HarnessPreset = {
  command: 'claude',
  session(sessionId, isFirstTurn, mode) {
    // `buildTurnCommand` 가 이 함수를 부르기 전에 `assertValidSession` 이 이미 non-null 을
    // 보장했다(claude 의 `allowsNullSessionOnFirstMention` 은 false) — 그 불변식을 여기서
    // 다시 검사하지 않는다(같은 규칙을 두 곳에서 지키면 나중에 한쪽만 고치는 사고가 난다).
    // 아래 캐스트는 순수하게 TypeScript 타입 좁히기다.
    const id = sessionId as string;
    if (mode === 'interactive') return ['-r', id];
    return isFirstTurn ? ['-p', '--session-id', id] : ['-p', '-r', id];
  },
  allowsNullSessionOnFirstMention: false,
  permission: {
    auto: ['--permission-mode', 'bypassPermissions'],
    readonly: ['--permission-mode', 'plan'],
  },
  // `--strict-mcp-config` 를 항상 함께 준다 — 없으면 운영자의 전역 MCP 목록(Slack·Gmail·
  // Drive 등, task-1 스파이크 실측)을 그대로 상속해, 채널에서 멘션할 수 있는 사람이면
  // 누구나 운영자 개인 계정에 도달한다(spec §7). 멘션·인터랙티브 어느 쪽도 예외가 아니다.
  mcp: ({ mcpConfigPath }) => ['--mcp-config', mcpConfigPath, '--strict-mcp-config'],
  model: (model) => (model ? ['--model', model] : []),
  effort: (effort) => (effort ? ['--effort', effort] : []),
  prompt: (systemPrompt, promptCtx, mode) => {
    const flags = systemPrompt ? ['--append-system-prompt', systemPrompt] : [];
    // 빈 문자열을 그대로 위치인자로 넘기면 일부 CLI 가 그걸 진짜 값으로 읽는다 — 있을 때만 싣는다.
    if (mode === 'mention' && promptCtx) flags.push(promptCtx);
    return flags;
  },
};

const CODEX_PRESET: HarnessPreset = {
  command: 'codex',
  session(sessionId, isFirstTurn, mode) {
    if (mode === 'interactive') {
      // 인터랙티브는 언제나 기존 세션을 이어받는다(spec §2 — PTY 가 존재하는 세 경우 중
      // "사람이 [▶ 터미널]"은 항상 resume 이다). sessionId 가 없으면 이어받을 게 없다 —
      // `assertValidSession` 이 이미 이 조합을 걸렀다(claude 쪽과 같은 이유로 재검사 안 함).
      const id = sessionId as string;
      return ['resume', id];
    }
    if (sessionId === null) {
      // codex 는 세션 id 를 사전 할당할 수 없다 — 첫 턴은 id 없이 그냥 `exec` 로 시작하고,
      // 종료 후 러너가 rollout 파일에서 id 를 발견해 저장한다(spec §3, Task 8).
      return ['exec'];
    }
    return ['exec', 'resume', sessionId];
  },
  allowsNullSessionOnFirstMention: true,
  // `-a`/`--ask-for-approval` 은 `codex exec`/`codex exec resume` 어디에도 없다(실측,
  // task-1 스파이크) — sandbox 만으로 권한을 조정한다. `danger-full-access` 는 어느 쪽에도
  // 매핑하지 않는다: 멘션 턴은 사람이 안 보는 턴이라 workspace 경계를 넘길 이유가 없고,
  // 그 경계가 avcs workspace 격리와 정확히 겹친다(spec §4).
  //
  // **`-s` 플래그가 아니라 `-c sandbox_mode="…"` 다.** 리뷰가 실물 CLI(`codex-cli 0.148.0`)로
  // 깨뜨렸다: `codex exec resume <id> -s workspace-write` → `error: unexpected argument
  // '-s' found`. `-s` 는 비-resume `codex exec` 에만 있고 `codex exec resume --help` 의
  // 옵션 목록(`-c`, `-m`, `--last`, `--all` 등)에는 없다 — "새 세션" 행과 "권한" 행이 codex
  // 에서는 직교하지 않았다(첫 턴에 통하는 플래그가 resume 에서 파싱 오류). `sandbox_mode` 는
  // codex 자신의 마이그레이션 문서가 쓰는 실제 설정 키이고 `-c` 는 exec·resume 양쪽에 있어,
  // 두 턴이 같은 기전 하나를 쓰면 이 비대칭이 애초에 생기지 않는다(spec §4, 수정 커밋 9a1c852).
  permission: {
    auto: ['-c', 'sandbox_mode="workspace-write"'],
    readonly: ['-c', 'sandbox_mode="read-only"'],
  },
  mcp: ({ murmurUrl }) => [
    // avcs 는 항상 등록한다(실측 shape: stdio, command 'avcs', args ['mcp'], env 없음).
    '-c', 'mcp_servers.avcs.command="avcs"',
    '-c', 'mcp_servers.avcs.args=["mcp"]',
    // murmur 도 항상 등록한다 — 이게 빠지면 에이전트가 답할 방법이 없다(위 murmurUrl 주석).
    // `bearer_token_env_var` 는 env 변수 "이름"만 담는다 — PAT 값 자체는 절대 argv 에 오르지
    // 않는다(spec §7, task-1 실측: `-c mcp_servers.murmur.bearer_token_env_var="MURMUR_PAT"`).
    // 실값은 buildTurnCommand 가 돌려주는 env.MURMUR_PAT 로만 간다.
    '-c', `mcp_servers.murmur.url="${murmurUrl}"`,
    '-c', 'mcp_servers.murmur.bearer_token_env_var="MURMUR_PAT"',
  ],
  model: (model) => (model ? ['--model', model] : []),
  // codex 에 `--effort` 플래그는 없다 — spec §4 표에도 이 항목은 없다(측정 대상 밖). 키
  // `model_reasoning_effort` 자체는 **실재를 확인했다**: 이 머신의 실제
  // `~/.codex/config.toml:2` 에 `model_reasoning_effort = "xhigh"` 가 그대로 들어있다(사용자가
  // 직접 쓰던 키). 그래서 MCP 와 같은 턴별 `-c` 오버라이드로 그 키를 재사용한다.
  // **절반만 확인됐다: 키는 실측, 값 집합은 미확인.** murmur 의 effort 값은
  // `low|medium|high|xhigh|max` 다섯인데 codex 가 그 다섯을 다 받는지는 `xhigh` 하나만
  // 실물로 봤을 뿐 나머지는 모른다. 값이 틀려도 조용하지 않다 — codex 가 알 수 없는 값이면
  // 턴 시작 자체가 크게 실패하므로(무시된 채 다른 값으로 도는 조용한 오동작이 아니다) 이
  // 미확인은 감수 가능하다고 판단했다.
  effort: (effort) => (effort ? ['-c', `model_reasoning_effort="${effort}"`] : []),
  prompt: (systemPrompt, promptCtx, mode) => {
    // codex 에는 `--append-system-prompt` 에 해당하는 플래그가 없다(실측) — 지시문은
    // 프롬프트 앞에 접두하는 것으로만 전달한다. 인터랙티브 턴은 애초에 프롬프트 위치인자가
    // 없다(사람이 직접 입력) — 그래서 codex 인터랙티브 턴은 지시문 재주입 수단이 없다는
    // 것이 이 하네스의 실측 한계다(§3의 "매 턴 재주입" 보장이 codex 인터랙티브에는 못 미친다).
    if (mode !== 'mention') return [];
    const combined = [systemPrompt, promptCtx].filter((s) => s.length > 0).join('\n\n');
    return combined ? [combined] : [];
  },
};

const PRESETS: Record<AgentHarness, HarnessPreset | 'unsupported'> = {
  'claude-code': CLAUDE_PRESET,
  codex: CODEX_PRESET,
  // `-r` 이 UUID 가 아니라 "latest"/인덱스만 받아 `--session-id` 와 짝을 이루지 못한다
  // (실측, task-1). `AGENT_HARNESSES`(스키마)에는 남기되 `RUNNABLE_HARNESSES`(실행 가능
  // 목록, Task 2)에서 이미 빠져 있다 — 여기 도달했다면 상위 호출부가 그 목록을 확인하지
  // 않은 결함이라는 뜻이다.
  gemini: 'unsupported',
};

/**
 * sessionId 가 null 인 조합 중 유일하게 유효한 것은 "`allowsNullSessionOnFirstMention` 인
 * harness 의 첫 멘션 턴"뿐이다. 그 밖의 조합(resume 인데 id 가 없다, claude 인데 id 가
 * 없다, 인터랙티브인데 이어받을 게 없다)은 호출자가 세션을 먼저 확보하지 않은 결함이다 —
 * 조용히 삼켜 이상한 명령을 조립하느니 여기서 크게 던진다(design.md 의 "없는 것을 있다고
 * 표시하지 않는다"와 같은 결). harness 이름은 여기서 보지 않는다 — preset 의 표 필드만
 * 읽는다(그래야 네 번째 harness 를 붙일 때 이 함수가 아니라 표만 고치면 된다).
 */
function assertValidSession(
  opts: Pick<BuildTurnCommandOptions, 'harness' | 'mode' | 'sessionId' | 'isFirstTurn'>,
  preset: HarnessPreset,
): void {
  if (opts.sessionId !== null) return;
  const allowed = preset.allowsNullSessionOnFirstMention && opts.mode === 'mention' && opts.isFirstTurn;
  if (allowed) return;
  throw new Error(
    `buildTurnCommand: sessionId 가 null 이다 (harness=${opts.harness}, mode=${opts.mode}, ` +
      `isFirstTurn=${opts.isFirstTurn}) — 이 harness/모드 조합에서는 호출자가 세션 id 를 ` +
      '먼저 확보했어야 한다 (sessions.ts::SessionRecord 참고)',
  );
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
  if (!opts.murmurUrl) {
    // 타입은 필수(string)로 강제하지만, 빈 문자열은 타입 체크를 통과하고도 같은 조용한
    // 실패(murmur MCP 미등록 → 답 못 함 → "답 없이 턴을 끝냈습니다")로 이어진다 — 여기서 막는다.
    throw new Error('buildTurnCommand: murmurUrl 이 비어 있다 — murmur MCP 없이는 에이전트가 답할 방법이 없다');
  }

  const args: string[] = [
    ...preset.session(opts.sessionId, opts.isFirstTurn, opts.mode),
    ...(opts.mode === 'mention' ? preset.permission[opts.mentionPermission] : []),
    ...preset.mcp({ mcpConfigPath: opts.mcpConfigPath, murmurUrl: opts.murmurUrl }),
    ...preset.model(opts.model),
    ...preset.effort(opts.effort),
    ...preset.prompt(opts.systemPrompt, opts.mode === 'mention' ? opts.promptCtx : '', opts.mode),
  ];

  // PAT 는 절대 argv 에 올리지 않는다 — 자식 프로세스 env 로만 준다. `ps` 로 argv 는 다른
  // 사용자에게도 보이지만 env 는 보이지 않는다(spec §7, task-1 실측 확인).
  return { command: preset.command, args, env: { MURMUR_PAT: opts.pat } };
}

/**
 * murmur + avcs 만 담은 MCP 설정 파일을 dir 아래 고정 이름(`mcp.json`)으로 쓴다. PAT 는
 * 실값이 아니라 `${MURMUR_PAT}` 플레이스홀더 문자열로만 들어간다 — 그래서 파일 자체는
 * 비밀이 아니고(spec §7), claude 자식 프로세스가 이 플레이스홀더를 자기 env 의
 * MURMUR_PAT 로 확장해 읽는다(실측 확인: 리스너에 실제로 `Bearer <실값>` 헤더가 도착).
 *
 * 이름의 "once" 는 "세션 하나에 한 번만 쓰면 충분하다"는 뜻이지 "두 번 부르면 안 된다"가
 * 아니다 — 재시도 경로 등에서 두 번 불려도 같은 결과를 내고 에러 없이 그냥 덮어쓴다
 * (workspace.ts::ensureWorkspace 처럼 존재 검사로 건너뛰지는 않는다: murmurUrl 이 바뀌었는데
 * 옛 파일이 그대로 남는 사고를 피한다).
 */
export async function writeMcpConfigOnce(dir: string, murmurUrl: string): Promise<string> {
  const config = {
    mcpServers: {
      murmur: {
        type: 'http' as const,
        url: `${murmurUrl.replace(/\/$/, '')}/mcp`,
        headers: { Authorization: 'Bearer ${MURMUR_PAT}' },
      },
      avcs: { type: 'stdio' as const, command: 'avcs', args: ['mcp'] },
    },
  };
  await mkdir(dir, { recursive: true });
  const filePath = join(dir, 'mcp.json');
  await writeFile(filePath, JSON.stringify(config, null, 2), 'utf8');
  return filePath;
}
