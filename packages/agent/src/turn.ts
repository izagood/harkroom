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

/**
 * `murmurUrl` 은 서버 베이스 URL(`http://localhost:3400`)이고, MCP 엔드포인트는 `/mcp` 다.
 * claude(`writeMcpConfigOnce`)와 codex(`CODEX_PRESET.mcp`) 양쪽이 이 정규화를 거쳐야 한다 —
 * 한쪽만 하고 다른 쪽을 murmurUrl 그대로 쓰면 그쪽 harness 는 베이스 URL 에 `POST /` 를
 * 때려 `404 route not found` 로 MCP 연결 자체가 안 된다(실물 검증에서 codex 가 이렇게
 * 실패했다 — 아래 CODEX_PRESET.mcp 참고).
 *
 * export 하는 이유: `murmur.ts::MurmurAgentClient` 도 같은 `/mcp` 엔드포인트에 붙는데, 그
 * 파일이 이 정규화를 따로(`new URL(\`${baseUrl}/mcp\`)`) 다시 구현하면 값이 두 곳에서
 * 유도되는 모양이 된다 — 그 자체가 이 함수를 만든 계기(claude/codex 사이 이중 구현)와
 * 같은 종류의 결함이라 리뷰에서 지적됐다. 진실 원천을 여기 하나로 둔다.
 */
export function mcpUrl(murmurUrl: string): string {
  return `${murmurUrl.replace(/\/$/, '')}/mcp`;
}

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
  /**
   * 세션·권한·MCP 어디에도 안 붙는, 그 harness 라서 늘 필요한 인자. `mode` 를 받는 이유는
   * codex 가 멘션 턴(`codex exec`)과 인터랙티브 턴(`codex resume`)에서 **서로 다른
   * 서브커맨드**라 받는 플래그 집합이 다르기 때문이다 — 이 비대칭은 이 파일이 이미 한 번
   * 실물로 깨져 본 자리다(`-s` 가 `codex exec` 에만 있고 `codex exec resume` 에는 없던 건,
   * CODEX_PRESET.permission 주석 참고). mode 없이 항상 붙이면 그 사고를 반복한다.
   */
  alwaysArgs(mode: TurnMode): string[];
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
  // claude 는 멘션·인터랙티브 모두 같은 `claude` 커맨드라 모드별 차이가 없고, 붙일 것도 없다.
  alwaysArgs: () => [],
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
    //
    // **`/mcp` 를 붙여야 한다 — 실물 검증에서 드러난 회귀다.** `murmurUrl` 은 서버 베이스
    // URL(`http://localhost:3400`)이지 MCP 엔드포인트가 아니다. claude 쪽은
    // `writeMcpConfigOnce` 가 `${murmurUrl}/mcp` 로 정규화해서 파일에 굽는데, 여기는 그 정규화
    // 없이 murmurUrl 을 그대로 썼다 — codex 가 `POST /`(베이스 URL)를 때려 서버가
    // `404 route not found: POST /` 를 던지고, MCP 자체가 안 붙어 murmur 도구가 하나도 안
    // 보였다. 실제 실패 증상은 조용했다: codex 는 exit 0 으로 끝났지만 message.post 를 못 불러
    // "(답 없이 턴을 끝냈습니다)" 만 남았다 — 원인이 이 URL 하나였다는 단서가 로그 어디에도
    // 없었다. 단위 테스트가 못 잡은 이유도 같은 패턴이다: `test/turn.test.ts` 의 fixture 가
    // `murmurUrl: 'http://localhost:3401/mcp'` 로 **이미 `/mcp` 가 붙은 값을 직접 줘서** 이
    // 함수가 값을 그대로 돌려주기만 해도 통과했다 — 프로덕션(main.ts→config.murmurUrl)이
    // 실제로 주는 값(베이스 URL, `/mcp` 없음)과 다른 입력으로 검증한 것이다. `mcpUrl()` 로
    // claude 와 정규화 지점을 하나로 합쳐, 다음에 엔드포인트 경로가 바뀌어도 한 곳만 고치면
    // 되게 한다.
    '-c', `mcp_servers.murmur.url="${mcpUrl(murmurUrl)}"`,
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
  // 인터랙티브 턴(codex resume) 은 이 플래그를 못 받으므로 이 한계가 그대로 노출된다 —
  // 사람이 화면 앞에 있는 턴이라 성격이 다르다.
  alwaysArgs: (mode) => (mode === 'mention' ? ['--skip-git-repo-check', '--ignore-user-config'] : []),
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

/**
 * 새 SessionRecord 를 만들 때 sessionId 를 러너가 미리 발급해야 하는 harness 인가
 * (main.ts::runMentionTurn). harness 이름을 main.ts 에서 직접 비교하면 이 표(PRESETS)와
 * 진실 원천이 둘로 갈린다 — `allowsNullSessionOnFirstMention` 하나로 양쪽을 다 결정한다.
 */
export function preassignsSessionId(harness: AgentHarness): boolean {
  const preset = PRESETS[harness];
  if (preset === 'unsupported') {
    throw new Error(`preassignsSessionId: harness '${harness}' 는 러너가 아직 지원하지 않는다`);
  }
  return !preset.allowsNullSessionOnFirstMention;
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
    ...preset.alwaysArgs(opts.mode),
    ...(opts.mode === 'mention' ? preset.permission[opts.mentionPermission] : []),
    ...preset.mcp({ mcpConfigPath: opts.mcpConfigPath, murmurUrl: opts.murmurUrl }),
    ...preset.model(opts.model),
    ...preset.effort(opts.effort),
    ...preset.prompt(opts.systemPrompt, opts.mode === 'mention' ? opts.promptCtx : '', opts.mode),
  ];

  // PAT 는 절대 argv 에 올리지 않는다 — 자식 프로세스 env 로만 준다. `ps` 로 argv 는 다른
  // 사용자에게도 보이지만 env 는 보이지 않는다(spec §7, task-1 실측 확인).
  return { command: preset.command, args, env: childEnv(opts.pat) };
}

/**
 * PTY 자식에 넘길 env. 부모(러너) 전체를 물려주고 `MURMUR_PAT` 만 덮어쓴다.
 *
 * **실물 검증에서 발견된 회귀다.** `pty.spawn` 은 `env` 를 넘기면 부모 env 와 **병합하지
 * 않고 그 값으로 완전히 대체한다**(node-pty `unixTerminal.js`: `opt.env = opt.env ||
 * process.env` — 넘겼다 하면 그걸로 끝, 상속은 opt.env 를 아예 안 줬을 때뿐이다). 이 함수가
 * 전에는 `{ MURMUR_PAT: opts.pat }` 하나만 돌려줬는데, 그 결과 자식은 `PATH`·`HOME` 이 통째로
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
 */
function childEnv(pat: string): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (value !== undefined) env[key] = value;
  }
  env.MURMUR_PAT = pat;
  return env;
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
        url: mcpUrl(murmurUrl),
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
