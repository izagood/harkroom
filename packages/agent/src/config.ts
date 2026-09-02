import { homedir } from 'node:os';
import { join } from 'node:path';

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
  };
}
