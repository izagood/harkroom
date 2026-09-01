export interface AgentConfig {
  murmurUrl: string;
  murmurPat: string;
  model: string;
  /** 답변 깊이. 채팅 응답은 낮게 두는 편이 낫다 — 필요하면 올린다. */
  effort: 'low' | 'medium' | 'high' | 'xhigh' | 'max';
  pollTimeoutMs: number;
}

function required(env: NodeJS.ProcessEnv, key: string): string {
  const v = env[key];
  if (!v) throw new Error(`${key} 가 필요하다`);
  return v;
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): AgentConfig {
  // ANTHROPIC_API_KEY 는 SDK 가 직접 읽는다(또는 `ant auth login` 프로필). 여기서 강제하지 않는다.
  return {
    murmurUrl: (env.MURMUR_URL ?? 'http://localhost:3400').replace(/\/$/, ''),
    murmurPat: required(env, 'MURMUR_PAT'),
    model: env.AGENT_MODEL ?? 'claude-opus-5',
    effort: (env.AGENT_EFFORT as AgentConfig['effort']) ?? 'medium',
    // 서버의 inbox.poll 상한은 25초다.
    pollTimeoutMs: Number(env.AGENT_POLL_TIMEOUT_MS ?? 25_000),
  };
}
