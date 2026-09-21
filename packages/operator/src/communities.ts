/**
 * 기동 시 커뮤니티 인스턴스를 세운다 — `operator.json` 의 커뮤니티마다, 토큰이 있는 것만.
 * 스펙 2026-09-20 §3. 토큰이 없는 커뮤니티는 아직 등록되지 않은 것이라 조용히 건너뛰고
 * 로그 한 줄만 남긴다(`harkroom-operator register` 가 그 자리를 채운다 — 단계 6).
 *
 * 이 파일이 `RunnerRegistry` 를 `AssignmentDeps` 로 감싼다. 조정기는 프로세스를 모르고
 * 레지스트리는 배정을 모른다 — 둘을 잇는 어댑터가 여기 하나다.
 */
import { createAssignmentReconciler, type AssignmentDeps } from './assignments.js';
import { createCommunity, type CommunityInstance } from './community.js';
import { communityKey, readConfig } from './config.js';
import { createForwarder } from './forward.js';
import { readLoginPath } from './loginPath.js';
import type { RunnerLinkServer } from './runnerLink.js';
import type { RunnerRegistry, RunnerHost } from './runners.js';
import { fileSecrets, type OperatorSecrets } from './secrets.js';
import { join } from 'node:path';

export interface StartCommunitiesDeps {
  appDataDir: string;
  registry: RunnerRegistry;
  host: RunnerHost;
  appVersion: string | null;
  log: (line: string) => void;
  /** 테스트가 바꿔 끼운다. 기본은 `<appDataDir>/operator/secrets/` 의 0600 파일. */
  secrets?: OperatorSecrets;
  fetchImpl?: typeof fetch;
  /** 러너 링크(스펙 §5)와 그 소켓 경로 — 러너가 붙는 곳. */
  runnerLink: RunnerLinkServer;
  socketPath: string;
  /** `harkroom-operator` 실행 파일 — 러너가 하네스에 `mcp-bridge` 명령으로 굽는다. */
  operatorBin: string;
}

export async function startCommunities(deps: StartCommunitiesDeps): Promise<CommunityInstance[]> {
  const config = await readConfig(join(deps.appDataDir, 'operator', 'operator.json'));
  const secrets = deps.secrets ?? fileSecrets(join(deps.appDataDir, 'operator', 'secrets'));
  const forwarder = createForwarder({ fetchImpl: deps.fetchImpl });
  const loginPath = await readLoginPath();
  if (!loginPath) deps.log('로그인 셸 PATH 를 못 읽었다 — 러너가 하네스를 못 찾을 수 있다');

  const runnerDeps = (community: { current: CommunityInstance | null }): AssignmentDeps => ({
    async spawn(agentId, env, runnerId) {
      const before = deps.registry.currentIncarnation(agentId);
      const record = await deps.registry.spawnRunner(agentId, env, runnerId);
      const spawned = before !== record.incarnationId;
      // 서버는 hello 의 announce 사이에 뜬 러너를 이것으로 안다 — 없으면 그 러너의 프레임을 버린다.
      if (spawned) community.current?.notifyRunnerStarted(agentId, record.incarnationId);
      return { spawned, pid: record.pid, runnerId: record.incarnationId };
    },
    signal(agentId, signal) {
      if (signal === 'SIGTERM') return deps.registry.killRunner(agentId) !== null;
      const info = deps.registry.listRunners().find((r) => r.agentId === agentId);
      return info ? deps.host.kill(info.pid, 'SIGKILL') : false;
    },
    isAlive: (agentId) => deps.registry.listRunners().some((r) => r.agentId === agentId && r.alive),
    listRunners: () => deps.registry.listRunners()
      .filter((r) => r.alive)
      .map((r) => ({ agentId: r.agentId, runnerId: r.incarnationId, pid: r.pid })),
    loginPath,
    appVersion: deps.appVersion,
    link: deps.runnerLink,
    socketPath: deps.socketPath,
    operatorBin: deps.operatorBin,
    schedule: (fn, ms) => { const t = setTimeout(fn, ms); t.unref?.(); return () => clearTimeout(t); },
    log: deps.log,
  });

  const started: CommunityInstance[] = [];
  for (const [rawUrl, section] of Object.entries(config.communities)) {
    const baseUrl = communityKey(rawUrl);
    const token = await secrets.getToken(baseUrl);
    if (!token) { deps.log(`커뮤니티 건너뜀(토큰 없음 — 등록이 필요하다): ${baseUrl}`); continue; }
    const ref: { current: CommunityInstance | null } = { current: null };
    const reconciler = createAssignmentReconciler(runnerDeps(ref));
    const community = createCommunity({
      baseUrl, token, agents: section.agents, reconciler, log: deps.log,
      runnerLink: deps.runnerLink, forwarder,
    });
    ref.current = community;
    community.start();
    started.push(community);
  }
  deps.log(`커뮤니티 ${started.length}곳에 붙는다`);
  return started;
}
