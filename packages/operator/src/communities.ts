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
import { operatorVersion } from './version.js';
import { communityKey, readConfig, rememberOperatorId } from './config.js';
import { createForwarder } from './forward.js';
import { detectHarnesses, HARNESS_BINARIES } from './harnesses.js';
import { listHarnessModels } from './harnessModels.js';
import type { HarnessModel, OperatorCapabilities } from '@harkroom/shared';
import { readLoginPath } from './loginPath.js';
import type { RunnerLinkServer } from './runnerLink.js';
import type { RunnerRegistry, RunnerHost } from './runners.js';
import { fileSecrets, type OperatorSecrets } from './secrets.js';
import { buildMcpConfig, claudeConfigPath, readLocalMcpDefinitions, writeAgentMcpConfig } from './mcpConfig.js';
import type { McpOAuth } from './mcpOAuth.js';
import { access } from 'node:fs/promises';
import { homedir } from 'node:os';
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
  /** 원격 MCP 의 OAuth 토큰(`mcpOAuth.ts`). 없으면 토큰을 굽지 않는다 — 하네스가 제 손으로 인증한다(옛 동작). */
  mcpOAuth?: McpOAuth;
}

export interface CommunityRuntime {
  /** 살아 있는 인스턴스들. `startOne` 이 같은 배열에 더한다 — run.ts 가 이 참조를 든다. */
  communities: CommunityInstance[];
  /**
   * 설정·토큰을 다시 읽어 그 커뮤니티를 띄운다(앱의 `operatorRegister` 뒤). 이미 떠 있으면 그것,
   * 토큰이 없으면 null. 오퍼레이터를 다시 띄우지 않고 등록을 반영하는 유일한 길이다.
   */
  startOne(baseUrl: string): Promise<CommunityInstance | null>;
}

/**
 * hello 의 announce — 서버가 "이 오퍼레이터에 어떤 러너가 살아 있나"를 아는 표. 살아 있는
 * 러너에 더해 **회수 중인 옛 세대 러너**도 싣는다(#838): 그 러너는 SIGTERM 을 받고 진행 중인
 * 턴을 끝내는 중이고, 그 턴의 프레임과 답이 이 오퍼레이터를 지난다. announce 에 없으면
 * 서버가 그 프레임을 버린다. 죽으면 registry 가 exit 통지를 내고 서버가 지운다.
 */
export function announceOf(registry: Pick<RunnerRegistry, 'listRunners' | 'retiringRunners'>): { agentId: string; runnerId: string; pid: number }[] {
  return [
    ...registry.listRunners().filter((r) => r.alive).map((r) => ({ agentId: r.agentId, runnerId: r.incarnationId, pid: r.pid })),
    ...registry.retiringRunners().map((r) => ({ agentId: r.agentId, runnerId: r.incarnationId, pid: r.pid })),
  ];
}

export async function startCommunities(deps: StartCommunitiesDeps): Promise<CommunityRuntime> {
  const configPath = join(deps.appDataDir, 'operator', 'operator.json');
  const config = await readConfig(configPath);
  const secrets = deps.secrets ?? fileSecrets(join(deps.appDataDir, 'operator', 'secrets'));
  const forwarder = createForwarder({ fetchImpl: deps.fetchImpl });
  const loginPath = await readLoginPath();
  if (!loginPath) deps.log('로그인 셸 PATH 를 못 읽었다 — 러너가 하네스를 못 찾을 수 있다');
  // 하네스 능력(스펙 §3). 기동 때 한 번 재고, 다시 붙을 때마다 새로 잰다 — 사람이 그 사이에
  // claude 를 설치했거나 로그인했을 수 있고, 그 사실은 다음 hello 에 실려야 배정이 통한다.
  const exists = (p: string) => access(p).then(() => true, () => false);
  const detect = () => detectHarnesses({ path: loginPath, env: process.env, home: homedir(), exists });
  let harnesses = await detect();
  deps.log(`하네스: ${Object.entries(harnesses).map(([k, v]) => `${k}=${v.installed ? (v.loggedIn ? '설치·로그인' : '설치') : '없음'}`).join(', ')}`);
  const refreshHarnesses = () => { void detect().then((h) => { harnesses = h; }); };

  // 하네스가 받는 모델 목록(`harnessModels.ts`). 하네스를 **실행해** 묻는 일이라(codex 는
  // 카탈로그를 네트워크로 받는다) 기동을 붙잡지 않는다 — hello 는 목록 없이 먼저 나가고,
  // 목록이 오면 붙은 커뮤니티마다 능력을 다시 낸다. 기동 때 한 번만 잰다 — 모델 카탈로그는
  // 하네스 업데이트로 바뀌고, 하네스 업데이트는 오퍼레이터 재시작과 같이 온다.
  let models: Partial<Record<keyof typeof HARNESS_BINARIES, HarnessModel[]>> = {};
  const withModels = (): OperatorCapabilities['harnesses'] => {
    const out: OperatorCapabilities['harnesses'] = {};
    for (const [k, v] of Object.entries(harnesses)) {
      const list = models[k as keyof typeof HARNESS_BINARIES];
      out[k] = list ? { ...v, models: list } : v;
    }
    return out;
  };

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
    listRunners: () => announceOf(deps.registry),
    loginPath,
    appVersion: deps.appVersion,
    link: deps.runnerLink,
    socketPath: deps.socketPath,
    operatorBin: deps.operatorBin,
    operatorOwnerId: () => community.current?.ownerAccountId() ?? Promise.resolve(null),
    async mcpConfig(definition) {
      const definitions = await readLocalMcpDefinitions({
        registryPath: join(deps.appDataDir, 'operator', 'mcp-servers.json'),
        claudeConfigPath: claudeConfigPath(process.env, homedir()),
      });
      // 이 에이전트가 고른 원격 정의의 토큰만 묻는다 — 만료가 가까우면 여기서 refresh 한다.
      const remote: Record<string, { url?: string }> = {};
      for (const n of definition.mcpServers) { const d = definitions[n]; if (d && 'url' in d) remote[n] = { url: d.url }; }
      const auth = deps.mcpOAuth
        ? await deps.mcpOAuth.tokensFor(remote).catch((err: unknown) => {
          deps.log(`MCP OAuth 토큰을 읽지 못했다(토큰 없이 띄운다): ${err instanceof Error ? err.message : String(err)}`);
          return { tokens: {}, expired: [] as string[] };
        })
        : { tokens: {}, expired: [] as string[] };
      const built = buildMcpConfig({ operatorBin: deps.operatorBin, names: definition.mcpServers, definitions, ...auth });
      if (built.missing.length) return { missing: built.missing };
      // **거절하지 않는다.** 인증이 없어도 에이전트의 나머지 일은 된다 — 그 MCP 만 "requires
      // authentication" 이고, 턴은 가이드대로 사람에게 넘긴다. 사람은 앱의 MCP 절에서 이 상태를 본다.
      if (built.needsAuth.length) deps.log(`MCP 인증 필요: agent=${definition.handle} — ${built.needsAuth.join(', ')} (데스크톱 › 에이전트 › MCP 에서 인증)`);
      return { path: await writeAgentMcpConfig(join(deps.appDataDir, 'operator', 'mcp'), definition.agentId, built.mcpServers) };
    },
    schedule: (fn, ms) => { const t = setTimeout(fn, ms); t.unref?.(); return () => clearTimeout(t); },
    log: deps.log,
  });

  const started: CommunityInstance[] = [];
  const startOne = async (rawUrl: string, section?: { agents: Record<string, import('./config.js').LocalAgentConfig> }): Promise<CommunityInstance | null> => {
    const baseUrl = communityKey(rawUrl);
    const existing = started.find((c) => c.baseUrl === baseUrl);
    if (existing) return existing;
    const agents = section?.agents ?? (await readConfig(configPath)).communities[baseUrl]?.agents ?? {};
    const token = await secrets.getToken(baseUrl);
    if (!token) { deps.log(`커뮤니티 건너뜀(토큰 없음 — 등록이 필요하다): ${baseUrl}`); return null; }
    const ref: { current: CommunityInstance | null } = { current: null };
    const reconciler = createAssignmentReconciler(runnerDeps(ref));
    const community = createCommunity({
      baseUrl, token, agents, reconciler, log: deps.log,
      version: operatorVersion(deps.appVersion),
      runnerLink: deps.runnerLink, forwarder, fetchImpl: deps.fetchImpl,
      harnesses: () => { refreshHarnesses(); return withModels(); },
      // 실패는 삼킨다 — 못 적어도 이 오퍼레이터는 그대로 돈다. 앱의 '이 기기' 기본값만 늦어진다.
      onSelf: (operatorId) => {
        void rememberOperatorId(configPath, baseUrl, operatorId)
          .catch((err: unknown) => deps.log(`오퍼레이터 id 를 적지 못했다: ${err instanceof Error ? err.message : String(err)}`));
      },
    });
    ref.current = community;
    community.start();
    started.push(community);
    return community;
  };
  // 붙은 커뮤니티에 다시 내므로 `started` 가 선 뒤에 띄운다.
  void (async () => {
    const measured: typeof models = {};
    await Promise.all((Object.keys(HARNESS_BINARIES) as (keyof typeof HARNESS_BINARIES)[])
      .filter((h) => harnesses[h]?.installed)
      .map(async (h) => {
        const list = await listHarnessModels(h, { path: loginPath, env: process.env, home: homedir() });
        if (list) measured[h] = list;
      }));
    models = measured;
    deps.log(`하네스 모델: ${Object.entries(measured).map(([k, v]) => `${k}=${v.length}`).join(', ') || '없음'}`);
    for (const c of started) c.announceCapabilities();
  })();
  for (const [rawUrl, section] of Object.entries(config.communities)) await startOne(rawUrl, section);
  deps.log(`커뮤니티 ${started.length}곳에 붙는다`);
  return { communities: started, startOne };
}
