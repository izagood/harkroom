import { homedir } from 'node:os';
import { join } from 'node:path';
import { RUNNER_LINK_ENV, RUNNER_LINK_ENV_KEYS } from '@harkroom/shared/runnerLink';
import { agentStateBaseDir } from '@harkroom/shared/agentStateRoot';

/**
 * 인스턴스 ID 문법(#174). 소문자·숫자·하이픈 1~32자.
 *
 * 이 값은 **경로 세그먼트가 된다**(stateDir.ts). 그래서 `..` 나 `/` 가 들어올 여지를
 * 문법에서 끊는다 — 경로 조립부에 방어를 두면 도달 불가능한 분기가 되거나, 더 나쁘게는
 * 운영자가 준 이름과 다른 디렉터리를 조용히 만들어 사람이 찾을 수 없게 된다.
 */
const INSTANCE_PATTERN = /^[a-z0-9-]{1,32}$/;

/**
 * **조용히 무시하지 않는다 — 기동을 실패시킨다.** 오타를 무시하면 인스턴스 B 라고 믿고
 * 띄운 러너가 실제로는 기본 경로를 쓰면서 A 의 세션 파일을 밟는다. 그 사고는 화면에
 * 아무 흔적을 남기지 않으므로, 유일하게 안전한 반응은 뜨지 않는 것이다.
 */
function validateInstance(instance: string | undefined): string | undefined {
  if (!instance) return undefined;
  if (!INSTANCE_PATTERN.test(instance)) {
    throw new Error(
      `HARKROOM_AGENT_INSTANCE 가 유효하지 않다: "${instance}". ` +
      `문자 집합은 [a-z0-9-]{1,32} 이다.`,
    );
  }
  return instance;
}

/**
 * 기동 로그에 적는 러너 이름(#174). 운영자가 `ps` 로 어느 프로세스가 누구인지 알아야 한다.
 *
 * 인스턴스가 없어도 **`[default]` 를 적는다.** 없을 때 대괄호를 통째로 빼면 "인스턴스를
 * 안 준 러너"와 "이 빌드가 인스턴스를 모르는 러너"가 로그에서 같아 보인다 — 운영자가
 * 격리가 걸렸는지 확인할 방법이 사라진다.
 */
export function runnerLabel(handle: string, instance: string | undefined): string {
  return `@${handle}[${instance ?? 'default'}]`;
}

/** 러너 자체의 설정. 모델·effort·지시문은 서버의 에이전트 정의에 있다(harkroom UI 로 바꾼다). */
export interface RunnerConfig {
  /**
   * 오퍼레이터 링크(스펙 2026-09-20 §5). 오퍼레이터가 spawn 때 셋을 함께 심는다. **필수다** —
   * 러너는 서버를 모르므로 이것 없이는 아무것도 할 수 없다(옛 `HARKROOM_URL`·`HARKROOM_PAT`
   * 경로는 단계 4 에서 사라졌다).
   */
  operatorLink: { socketPath: string; runnerId: string; secret: string };
  /** `harkroom-operator` 실행 파일 — codex 의 `-c mcp_servers.harkroom.*` 에 `mcp-bridge` 명령으로 굽는다. */
  operatorBin: string;
  /** 「정확한 명령」 PreToolUse hook 을 claude 멘션 턴에 다는가(H③b, 기본 false). */
  commandHook: boolean;
  /**
   * 이 머신에서 Claude in Chrome 을 열 수 있는가(스레드 e8c8365d) — 오퍼레이터가 **앱이 띄운 로컬
   * 오퍼레이터이고** 확장 native host 가 깔려 있을 때만 `HARKROOM_CHROME_HOST=1` 을 준다. 이것이 거짓이면
   * 에이전트의 `chromeEnabled` 가 켜져 있어도 `--no-chrome` 으로 뜬다.
   */
  chromeHost: boolean;
  /**
   * 오퍼레이터가 spawn 전에 써 둔 하네스 MCP 설정 파일(스펙 2026-09-20 §6). harkroom 브릿지·avcs·
   * 에이전트의 mcpServers 가 합쳐져 있다. 러너는 만들지 않고 이 경로를 그대로 쓴다.
   */
  mcpConfigPath: string;
  pollTimeoutMs: number;
  /**
   * 폴마다 쥔 항목을 서버에 알려 다시 받지 않는다(inbox 임대, 2026-10-12 설계 B). 기본 켜짐 — `AGENT_INBOX_LEASE=0`
   * 이면 옛 경로(쥔 항목도 폴마다 다시 받고 5초 쉰다)로 돈다. 옛 서버는 이 인자를 무시하므로 켜 둬도 전과 같다.
   */
  inboxLease: boolean;
  /** 한 턴(PTY 실행)의 최대 대기 시간. 코딩 에이전트는 도구 호출을 여러 번 거치므로 넉넉히 잡는다. */
  turnTimeoutMs: number;
  /**
   * 하네스 기록이 이만큼 자라지 않으면 **멈춘 것으로 보고 턴을 접는다**(2026-09-09).
   * `turnTimeoutMs` 와 다른 사실을 잰다 — 그쪽은 "답이 없다", 이쪽은 "일하지 않는다".
   * 자세한 근거는 `mentionTurn.ts` 의 `harnessStallMs` 주석에 있다.
   */
  harnessStallMs: number;
  /** 세션 파일(sessions.json)·MCP 설정·avcs 워크스페이스가 사는 곳. 러너 재시작·재배포에도
   * 살아남아야 하는 것들이라 임시 디렉터리(mkdtemp)가 아니라 고정 경로를 쓴다. */
  stateDir: string;
  /** 에이전트 인스턴스 ID. 같은 에이전트를 여러 개 돌릴 때 구분한다 (#174). */
  agentInstance: string | undefined;
  /**
   * 인터랙티브 턴의 고아 유예(#337, 스펙 §5-2 결정 5): 프로세스가 안 끝났는데 viewer 가
   * 0 이 된 뒤 이 시간이 지나면 SIGTERM 으로 회수한다. 패널 닫힘·소켓 단절·앱 강제종료가
   * 전부 "viewer 소멸" 하나로 수렴하고, 세션은 디스크라 kill 로 잃는 것이 없다.
   */
  interactiveOrphanMs: number;
}

function required(env: NodeJS.ProcessEnv, key: string): string {
  const v = env[key];
  if (!v) throw new Error(`${key} 가 필요하다`);
  return v;
}

/** 셋이 다 있어야 한다. 하나라도 없으면 오퍼레이터의 spawn 이 깨진 것이라 기동을 막는다. */
function operatorLink(env: NodeJS.ProcessEnv): RunnerConfig['operatorLink'] {
  const socketPath = env[RUNNER_LINK_ENV.socketPath];
  const runnerId = env[RUNNER_LINK_ENV.runnerId];
  const secret = env[RUNNER_LINK_ENV.secret];
  if (!socketPath || !runnerId || !secret) {
    throw new Error(
      `${RUNNER_LINK_ENV_KEYS.join('·')} 이 필요하다 — 러너는 오퍼레이터가 띄운다 `
      + '(설정 › Operators 에서 등록하고 에이전트를 배정하라)',
    );
  }
  return { socketPath, runnerId, secret };
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): RunnerConfig {
  // 모델·effort 는 여기 없다 — 서버 정의에 있어야 UI 수정이 반영된다.
  // claude-code harness 는 claude CLI 의 자격증명을 쓰므로 API 키도 필요 없다.
  return {
    operatorLink: operatorLink(env),
    operatorBin: required(env, 'HARKROOM_OPERATOR_BIN'),
    // 「정확한 명령」 hook(H③b) — 오퍼레이터가 `operator.json` 의 commandHook 로 켤 때만 '1'. 기본 꺼짐.
    commandHook: env.HARKROOM_COMMAND_HOOK === '1',
    // Claude in Chrome — 오퍼레이터가 '1' 을 줄 때만. 없으면 꺼짐(사람 브라우저를 조작하는 권한이라 닫힌 쪽이 기본).
    chromeHost: env.HARKROOM_CHROME_HOST === '1',
    mcpConfigPath: required(env, 'HARKROOM_MCP_CONFIG'),
    // 서버의 inbox.poll 상한은 25초다.
    pollTimeoutMs: Number(env.AGENT_POLL_TIMEOUT_MS ?? 25_000),
    inboxLease: env.AGENT_INBOX_LEASE !== '0',
    // 코딩 에이전트 한 턴은 도구 호출을 여러 번 거칠 수 있다 — 30분을 기본값으로 둔다.
    turnTimeoutMs: Number(env.AGENT_TURN_TIMEOUT_MS ?? 30 * 60_000),
    // 10분 — 멀쩡히 도는 세션들의 기록 간격 최대치(390초)보다 넉넉히 위이고, 실측된
    // 정지(30분 내내 한 줄도 안 자랐다)와는 멀리 떨어져 있다. 0 이면 재지 않는다.
    harnessStallMs: Number(env.AGENT_HARNESS_STALL_MS ?? 10 * 60_000),
    // 커뮤니티마다 오퍼레이터면 그 커뮤니티 뿌리 아래(`@harkroom/shared/agentStateRoot`, 격리 C P4). 꺼져 있으면 지금 그대로.
    stateDir: env.AGENT_STATE_DIR
      ?? agentStateBaseDir(join(homedir(), '.harkroom-agent'), env),
    agentInstance: validateInstance(env.HARKROOM_AGENT_INSTANCE),
    // 60초 — 사람이 티켓을 받고 attach 하기까지, 또는 잠깐 끊긴 소켓이 재-attach 하기까지의
    // 여유다. 더 짧으면 네트워크 순단이 곧 턴 종료가 되고, 더 길면 닫은 터미널이 그만큼 산다.
    interactiveOrphanMs: Number(env.AGENT_INTERACTIVE_ORPHAN_MS ?? 60_000),
  };
}
