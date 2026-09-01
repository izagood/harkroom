/** 러너 자체의 설정. 모델·effort·지시문은 서버의 에이전트 정의에 있다(murmur UI 로 바꾼다). */
export interface RunnerConfig {
  murmurUrl: string;
  murmurPat: string;
  pollTimeoutMs: number;
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
  };
}
