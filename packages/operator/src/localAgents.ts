/**
 * 오퍼레이터 로컬 설정의 에이전트 항목 — 앱이 소켓으로 넣고 뺀다(스펙 2026-09-20 §3 능력).
 *
 * `operator.json` 의 writer 는 오퍼레이터 하나다(`config.ts` 머리 주석). 앱이 파일을 직접 고치면
 * 두 writer 가 되고, 게다가 도는 중인 오퍼레이터는 그 변화를 모른다 — 그래서 `register` CLI 와
 * 이 포트가 같은 함수(`readConfig`/`writeConfig`)로 쓰고, 바뀐 커뮤니티에는 **능력을 다시
 * 낸다**(`onChanged`) — 서버가 그것을 봐야 배정이 409 가 아니다.
 */
import type { OperatorAgentsListResult, OperatorLocalAgent, OperatorRegisterResult } from '@harkroom/shared/daemonProtocol';
import { register as claimAndSave } from './cli.js';
import { communityKey, readConfig, writeConfig, type LocalAgentConfig } from './config.js';
import type { OperatorSecrets } from './secrets.js';

export interface LocalAgentsPort {
  /**
   * 등록(스펙 §3) — 앱이 발급한 코드로 claim 해 토큰·설정을 두고, 도는 오퍼레이터가 곧바로
   * 그 커뮤니티에 붙는다(`onRegistered`). CLI `register` 와 같은 함수를 쓴다.
   */
  register(baseUrl: string, code: string, name?: string): Promise<OperatorRegisterResult>;
  list(): Promise<OperatorAgentsListResult>;
  set(baseUrl: string, agentId: string, config: OperatorLocalAgent): Promise<void>;
  remove(baseUrl: string, agentId: string): Promise<void>;
}

export function createLocalAgentsPort(deps: {
  configPath: string;
  secrets: OperatorSecrets;
  /** 그 커뮤니티의 새 에이전트 표 — 도는 커뮤니티가 능력을 다시 내게. */
  onChanged: (baseUrl: string, agents: Record<string, LocalAgentConfig>) => void;
  /** 등록이 끝났다 — 그 커뮤니티를 지금 띄운다(`CommunityRuntime.startOne`). */
  onRegistered: (baseUrl: string) => Promise<void>;
  /** claim 요청에 쓴다. 테스트가 바꿔 끼운다. */
  fetchImpl?: typeof fetch;
  dataDir: string;
}): LocalAgentsPort {
  return {
    async register(baseUrl, code, name) {
      const out = await claimAndSave({ baseUrl, code, ...(name ? { name } : {}) }, { dataDir: deps.dataDir, fetchImpl: deps.fetchImpl, secrets: deps.secrets });
      await deps.onRegistered(out.baseUrl);
      return out;
    },
    async list() {
      const config = await readConfig(deps.configPath);
      const communities: OperatorAgentsListResult['communities'] = [];
      for (const [rawUrl, section] of Object.entries(config.communities)) {
        const baseUrl = communityKey(rawUrl);
        communities.push({ baseUrl, registered: (await deps.secrets.getToken(baseUrl)) !== null, agents: section.agents });
      }
      return { communities };
    },
    async set(rawUrl, agentId, cfg) {
      const baseUrl = communityKey(rawUrl);
      const config = await readConfig(deps.configPath);
      // 등록 전이라도 자리를 만든다 — `register` 가 토큰을 채우면 그대로 능력이 된다.
      const section = (config.communities[baseUrl] ??= { agents: {} });
      section.agents[agentId] = { ...(cfg.workingDir ? { workingDir: cfg.workingDir } : {}), ...(cfg.claudePool ? { claudePool: cfg.claudePool } : {}) };
      await writeConfig(deps.configPath, config);
      deps.onChanged(baseUrl, section.agents);
    },
    async remove(rawUrl, agentId) {
      const baseUrl = communityKey(rawUrl);
      const config = await readConfig(deps.configPath);
      const section = config.communities[baseUrl];
      if (!section || !(agentId in section.agents)) return;
      delete section.agents[agentId];
      await writeConfig(deps.configPath, config);
      deps.onChanged(baseUrl, section.agents);
    },
  };
}
