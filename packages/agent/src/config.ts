import { homedir } from 'node:os';
import { join } from 'node:path';

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
      `MURMUR_AGENT_INSTANCE 가 유효하지 않다: "${instance}". ` +
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

/** 러너 자체의 설정. 모델·effort·지시문은 서버의 에이전트 정의에 있다(murmur UI 로 바꾼다). */
export interface RunnerConfig {
  murmurUrl: string;
  murmurPat: string;
  pollTimeoutMs: number;
  /** 한 턴(PTY 실행)의 최대 대기 시간. 코딩 에이전트는 도구 호출을 여러 번 거치므로 넉넉히 잡는다. */
  turnTimeoutMs: number;
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

export function loadConfig(env: NodeJS.ProcessEnv = process.env): RunnerConfig {
  // 모델·effort 는 여기 없다 — 서버 정의에 있어야 UI 수정이 반영된다.
  // claude-code harness 는 claude CLI 의 자격증명을 쓰므로 API 키도 필요 없다.
  return {
    murmurUrl: (env.MURMUR_URL ?? 'http://localhost:3400').replace(/\/$/, ''),
    murmurPat: required(env, 'MURMUR_PAT'),
    // 서버의 inbox.poll 상한은 25초다.
    pollTimeoutMs: Number(env.AGENT_POLL_TIMEOUT_MS ?? 25_000),
    // 코딩 에이전트 한 턴은 도구 호출을 여러 번 거칠 수 있다 — 30분을 기본값으로 둔다.
    turnTimeoutMs: Number(env.AGENT_TURN_TIMEOUT_MS ?? 30 * 60_000),
    stateDir: env.AGENT_STATE_DIR ?? join(homedir(), '.murmur-agent'),
    agentInstance: validateInstance(env.MURMUR_AGENT_INSTANCE),
    // 60초 — 사람이 티켓을 받고 attach 하기까지, 또는 잠깐 끊긴 소켓이 재-attach 하기까지의
    // 여유다. 더 짧으면 네트워크 순단이 곧 턴 종료가 되고, 더 길면 닫은 터미널이 그만큼 산다.
    interactiveOrphanMs: Number(env.AGENT_INTERACTIVE_ORPHAN_MS ?? 60_000),
  };
}
