/**
 * 앱 없는 머신의 길 — 스펙 2026-09-20 §3(등록)·단계 6(헤드리스).
 *
 * | 명령 | 하는 일 |
 * |---|---|
 * | `harkroom-operator register <baseUrl> <code> [--name n]` | 등록 코드(설정 › Operators 가 발급, 5분·1회)를 `POST /operators/claim` 으로 토큰과 바꿔 이 머신의 secrets 에 두고, `operator.json` 에 그 커뮤니티의 자리를 만든다 |
 * | `harkroom-operator run [--data-dir d]` | 앱이 넘기던 daemon 인자를 데이터 디렉터리에서 **같은 규칙**(`daemonEndpointPaths`)으로 조립해 상주한다 — 앱이 나중에 같은 머신에 떠도 같은 소켓을 보고 "이미 서비스 중"으로 물러난다 |
 * | `harkroom-operator mcp-bridge` | 하네스가 띄우는 stdio MCP 브릿지(`mcpBridge.ts`) |
 * | 그 밖 | 앱이 넘기는 `--socket …` 인자 그대로(`args.ts`) |
 *
 * 등록이 CLI 인 이유: 코드는 화면에서 사람이 읽어 그 머신의 터미널에 붙여 넣는다 — 서버가
 * 오퍼레이터 머신을 먼저 알 방법이 없고, 앱이 없는 머신은 그 길밖에 없다.
 */
import { hostname as osHostname, homedir } from 'node:os';
import { join } from 'node:path';
import { daemonEndpointPaths } from '@harkroom/shared/daemonEndpoint';
import type { DaemonArgs } from './args.js';
import { communityKey, readConfig, writeConfig } from './config.js';
import { fileSecrets, type OperatorSecrets } from './secrets.js';

/** 앱(Tauri)의 identifier — 데이터 디렉터리 이름이다. 앱과 같은 자리를 써야 소켓·설정·토큰이 하나다. */
export const APP_IDENTIFIER = 'app.harkroom.desktop';

export type CliCommand =
  | { command: 'register'; baseUrl: string; code: string; name?: string }
  | { command: 'run'; dataDir: string | undefined }
  | { command: 'mcp-bridge' }
  | { command: 'daemon'; argv: string[] };

function flagValue(argv: readonly string[], flag: string): string | undefined {
  const i = argv.indexOf(flag);
  if (i < 0) return undefined;
  const v = argv[i + 1];
  if (v === undefined) throw new Error(`${flag} 에 값이 없다`);
  return v;
}

export function parseCliArgs(argv: readonly string[]): CliCommand {
  switch (argv[0]) {
    case 'register': {
      const [, baseUrl, code] = argv;
      if (!baseUrl || !code) throw new Error('사용법: harkroom-operator register <baseUrl> <code> [--name <이름>]');
      let parsed: URL;
      try { parsed = new URL(baseUrl); } catch { throw new Error(`baseUrl 이 URL 이 아니다: ${baseUrl}`); }
      if (!/^https?:$/.test(parsed.protocol)) throw new Error(`baseUrl 은 http(s) 여야 한다: ${baseUrl}`);
      return { command: 'register', baseUrl: communityKey(baseUrl), code, name: flagValue(argv.slice(3), '--name') };
    }
    case 'run':
      return { command: 'run', dataDir: flagValue(argv.slice(1), '--data-dir') };
    case 'mcp-bridge':
      return { command: 'mcp-bridge' };
    default:
      return { command: 'daemon', argv: [...argv] };
  }
}

/**
 * 앱이 쓰는 데이터 디렉터리와 같은 자리(Tauri `app_data_dir`). `HARKROOM_DATA_DIR` 이 있으면
 * 그것 — 한 머신에 오퍼레이터를 둘 두는 실험이나 다른 자리에 둔 앱을 위한 손잡이다.
 */
export function defaultDataDir(platform: NodeJS.Platform, env: NodeJS.ProcessEnv, home: string): string {
  if (env.HARKROOM_DATA_DIR) return env.HARKROOM_DATA_DIR;
  if (platform === 'darwin') return join(home, 'Library', 'Application Support', APP_IDENTIFIER);
  if (platform === 'win32') return join(env.APPDATA ?? join(home, 'AppData', 'Roaming'), APP_IDENTIFIER);
  return join(env.XDG_DATA_HOME ?? join(home, '.local', 'share'), APP_IDENTIFIER);
}

/**
 * unix 소켓 경로의 커널 상한(macOS 104바이트, 리눅스 108). 넘으면 `bind` 가 `EINVAL` 로 실패하고
 * 그 뒤의 `link` 가 `ENOENT` 로 죽는데, 그 두 이름만으로는 원인을 알 수 없다(실측 2026-09-21:
 * 긴 임시 디렉터리를 `HARKROOM_DATA_DIR` 로 줬다가 `ENOENT … link` 만 보았다). 여기서 먼저 말한다.
 */
export const MAX_SOCKET_PATH_BYTES = 100;

/** `run` 의 daemon 인자. `launchNonce` 는 없다 — 그것은 "내가 방금 띄운 것인가"를 앱이 가리는 값이다. */
export function runArgs(dataDir: string, entryPath: string, appVersion?: string): DaemonArgs {
  const paths = daemonEndpointPaths(dataDir);
  if (Buffer.byteLength(paths.socketPath) > MAX_SOCKET_PATH_BYTES) {
    throw new Error(
      `소켓 경로가 너무 길다(${Buffer.byteLength(paths.socketPath)}바이트 > ${MAX_SOCKET_PATH_BYTES}): ${paths.socketPath} — `
      + 'unix 소켓 경로의 커널 상한이다. HARKROOM_DATA_DIR(또는 --data-dir)을 짧은 경로로 잡아라',
    );
  }
  return {
    socket: paths.socketPath,
    token: paths.tokenPath,
    pidRecord: paths.pidPath,
    entryPath,
    ...(appVersion === undefined ? {} : { appVersion }),
    unknown: [],
  };
}

export interface RegisterDeps {
  dataDir: string;
  fetchImpl?: typeof fetch;
  secrets?: OperatorSecrets;
  hostname?: () => string;
}

export async function register(
  input: { baseUrl: string; code: string; name?: string },
  deps: RegisterDeps,
): Promise<{ operatorId: string; name: string; baseUrl: string }> {
  const baseUrl = communityKey(input.baseUrl);
  const name = input.name ?? (deps.hostname ?? osHostname)();
  const fetchImpl = deps.fetchImpl ?? fetch;
  const res = await fetchImpl(`${baseUrl}/operators/claim`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ code: input.code, name }),
  });
  const body = (await res.json().catch(() => null)) as
    | { operator?: { id: string; name: string }; token?: string; error?: { code: string; message: string } } | null;
  if (!res.ok || !body?.operator || !body.token) {
    throw new Error(`등록 실패(${res.status}): ${body?.error?.message ?? '서버가 토큰을 주지 않았다'}`);
  }
  // 토큰이 먼저다 — 설정만 있고 토큰이 없는 커뮤니티는 기동 때 "등록이 필요하다"로 건너뛴다(communities.ts).
  const secrets = deps.secrets ?? fileSecrets(join(deps.dataDir, 'operator', 'secrets'));
  await secrets.setToken(baseUrl, body.token);
  const configPath = join(deps.dataDir, 'operator', 'operator.json');
  const config = await readConfig(configPath);
  // 이미 있는 자리의 로컬 설정(agents)은 그대로 — 재등록은 토큰을 바꾸는 일이지 머신 설정을 지우는 일이 아니다.
  config.communities[baseUrl] ??= { agents: {} };
  await writeConfig(configPath, config);
  return { operatorId: body.operator.id, name: body.operator.name, baseUrl };
}

export function resolveDataDir(explicit: string | undefined): string {
  return explicit ?? defaultDataDir(process.platform, process.env, homedir());
}
