// opencode 의 **러너 전용 상태 루트**(1.18.31 실측, 2026-09-22).
//
// ## 왜 파일 하나가 아니라 세 디렉터리인가
//
// codex 는 `CODEX_HOME` 하나가 config·auth·sessions 를 다 옮긴다. opencode 는 XDG 규약을
// 따라 **셋으로 갈려 있다** — `XDG_CONFIG_HOME`(설정) · `XDG_DATA_HOME`(자격증명·세션 DB) ·
// `XDG_STATE_HOME`(상태). **셋을 함께 줘야** 옮겨지고, 하나를 빼먹으면 자격증명만 갈리고
// 세션은 사람 것과 공유되는 **반쪽 격리**가 된다. 그 상태는 조용해서 더 나쁘다.
// (`OPENCODE_CONFIG_DIR` 은 이름만 있고 아무것도 안 옮긴다 — 이름을 보고 고르면 안 된다.)
//
// ## 무엇을 물려받고 무엇을 안 받는가 — 이 파일의 핵심 판단
//
// **`provider` 와 `model` 은 물려받는다.** 사람의 설정에 자체 게이트웨이 같은 커스텀
// provider 가 있을 수 있고, 그것을 못 보면 opencode 는 무료 티어로 떨어져 거절당한다
// (실측: `Error from provider (Console): OpenCode's free tier can only be used from within
// OpenCode`). 모델을 못 고르는 러너는 아무 일도 못 한다.
//
// **`mcp` 는 절대 물려받지 않는다.** 물려받으면 운영자 개인의 MCP 목록(메일·드라이브 …)이
// 에이전트 턴에 그대로 붙어, 채널에서 멘션할 수 있는 사람이면 누구나 그 계정에 닿는다.
// claude 에 `--strict-mcp-config` 를 늘 붙이는 것과 **같은 자리**다(스펙 §7). opencode 에는
// 그런 플래그가 없으므로 **격리 홈을 우리가 쓰는 것**이 그 역할을 한다.
//
// ## MCP 는 설정 파일로만 등록된다
//
// 턴별로 넘기는 수단이 없다(`adapters/opencode.ts::mcpRegistration`). 그래서 오퍼레이터가
// 만들어 준 표(claude 형식 `mcpServers`)를 opencode 모양으로 **번역해** 이 루트에 적는다.
// harkroom 항목은 stdio 브릿지(`harkroom-operator mcp-bridge`)이고, 실측으로 그대로 붙는다
// (`opencode mcp list` → `✓ connected`).
import { chmod, lstat, mkdir, readFile, readlink, symlink, unlink, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import type { XdgApp } from './adapters/contract.js';

/**
 * opencode 자신의 이름표. Kilo(포크)는 `adapters/kilo.ts` 의 `xdgApp` 을 넘긴다 — 모양은 같고
 * XDG 아래 하위 디렉터리·파일 이름만 다르다. 기본값이 opencode 인 것은 옛 호출부를 그대로 두려는 것이다.
 */
const OPENCODE_APP: XdgApp = {
  dir: 'opencode',
  configFile: 'opencode.jsonc',
  schema: 'https://opencode.ai/config.json',
  userConfigFiles: ['opencode.json'],
};

/** 읽기 전용 멘션 턴이 고르는 에이전트 이름. `OPENCODE_PRESET.permission.readonly` 와 짝이다. */
export const OPENCODE_READONLY_AGENT = 'harkroom-readonly';

/**
 * API 키 연결(provider lane) 멘션 턴이 고르는 에이전트 이름. `OPENCODE_PRESET.lanePermission.auto` 와 짝이다.
 * lane 턴은 `--auto`(명시적 deny 밖은 모두 자동 허용)를 쓰지 않고 이 에이전트의 권한 표로만 돈다 — claude lane 의
 * `dontAsk` + `LANE_BASE_ALLOW` 와 같은 기준이다(security, C안).
 */
export const OPENCODE_LANE_AGENT = 'harkroom-lane';

/**
 * lane 에이전트의 권한 표(opencode 1.18.32 실측). 규칙은 **뒤에 적힌 것이 이긴다** — 맨 앞의 `"*": "deny"` 가 기본
 * 에이전트의 `ask`(작업 폴더 밖·doom_loop 등)까지 덮어서, 사람이 없는 턴이 묻는 창에 서지 않고 거절된다.
 *
 * - 읽기·찾기·할 일·스킬·서버가 판정하는 MCP 둘(`harkroom_*`·`avcs_*`)을 연다. `.env` 류 읽기는 닫는다.
 * - 쓰기는 작업 폴더 안만: `external_directory` 가 deny 라 밖은 못 쓴다. 다음 턴의 도구·지시·MCP 를 바꾸는 파일
 *   (`.claude/**`·`.opencode/**`·`CLAUDE.md`·`AGENTS.md`·`.mcp.json`·`opencode.json[c]`)은 안이어도 닫는다.
 * - 셸·웹·하위 에이전트(`task`)는 닫는다 — claude lane 처럼 소유자가 카드로 연 규칙을 잇는 것은 D 계열에서 한다.
 */
/** lane 턴이 작업 폴더 안이어도 못 쓰는 자리 — 다음 턴의 도구·지시·MCP 를 바꾼다(claude 의 `LANE_DENY` 와 같은 결). */
const LANE_PROTECTED_PATHS = ['.claude/*', '.opencode/*', 'CLAUDE.md', 'AGENTS.md', '.mcp.json', 'opencode.json', 'opencode.jsonc'] as const;

export const OPENCODE_LANE_PERMISSION: Readonly<Record<string, unknown>> = {
  '*': 'deny',
  read: { '*': 'allow', '*.env': 'deny', '*.env.*': 'deny' },
  glob: 'allow',
  grep: 'allow',
  list: 'allow',
  todowrite: 'allow',
  skill: 'allow',
  // 쓰기 판정의 경로는 작업 폴더가 아니라 **git 뿌리** 기준이다 — 저장소가 아니면 `/` 부터의 경로가 온다(실측: `.claude/*` 만
  // 적었더니 저장소 밖 작업 폴더의 `.claude/skills/x/SKILL.md` 가 쓰였다). 그래서 앞에 무엇이 붙어도 맞게 `*/` 꼴도 같이 둔다.
  // `*` 는 `/` 도 넘는다. 하위 폴더의 같은 이름 파일도 닫힌다(하네스가 그것도 읽는다).
  edit: {
    '*': 'allow',
    ...Object.fromEntries(LANE_PROTECTED_PATHS.flatMap((x) => [[x, 'deny'], [`*/${x}`, 'deny']])),
  },
  'harkroom_*': 'allow',
  'avcs_*': 'allow',
};

/** 사람이 쓰는 opencode 설정 파일(provider 정의가 여기 있다). */
export function sourceOpencodeConfig(
  env: NodeJS.ProcessEnv = process.env, home = homedir(), app: XdgApp = OPENCODE_APP,
): string {
  return join(env.XDG_CONFIG_HOME ?? join(home, '.config'), app.dir, app.userConfigFiles[0] ?? app.configFile);
}

/** 사람이 쓰는 opencode data 루트. 로그인(`auth.json`)이 그 아래 `opencode/` 에 있다. */
export function sourceOpencodeData(
  env: NodeJS.ProcessEnv = process.env, home = homedir(), app: XdgApp = OPENCODE_APP,
): string {
  return join(env.XDG_DATA_HOME ?? join(home, '.local', 'share'), app.dir);
}

/** 러너 전용 루트 안의 세 XDG 디렉터리. 이 셋이 곧 자식에게 줄 env 다. */
export function opencodeDirs(opencodeHome: string): {
  XDG_CONFIG_HOME: string; XDG_DATA_HOME: string; XDG_STATE_HOME: string;
} {
  return {
    XDG_CONFIG_HOME: join(opencodeHome, 'config'),
    XDG_DATA_HOME: join(opencodeHome, 'data'),
    XDG_STATE_HOME: join(opencodeHome, 'state'),
  };
}

/** 이 루트에서 opencode 가 읽는 설정 파일(실측: `mcp add` 도 이 자리에 쓴다). */
export function opencodeConfigFile(opencodeHome: string, app: XdgApp = OPENCODE_APP): string {
  return join(opencodeDirs(opencodeHome).XDG_CONFIG_HOME, app.dir, app.configFile);
}

interface ClaudeStyleStdio { type?: 'stdio'; command: string; args?: string[]; env?: Record<string, string> }
interface ClaudeStyleRemote { type: 'http' | 'sse'; url: string; headers?: Record<string, string> }
type ClaudeStyleServer = ClaudeStyleStdio | ClaudeStyleRemote;

/**
 * 오퍼레이터가 만든 표(claude 형식)를 opencode 모양으로 옮긴다.
 *
 * opencode 는 갈래 이름이 다르다 — stdio 가 `local`(명령이 **배열 하나**다), http/sse 가
 * `remote`. 값의 뜻은 같으므로 번역만 하고 **아무것도 지어내지 않는다**: 모르는 갈래는
 * 버린다(빠진 도구는 에이전트가 "못 하겠다"고 말하지만, 잘못 만든 항목은 설정 전체를
 * 거절시켜 **모든** 도구를 잃게 한다 — codex 의 `invalid transport` 사고가 그것이었다).
 */
export function toOpencodeMcp(
  servers: Record<string, ClaudeStyleServer>,
): Record<string, Record<string, unknown>> {
  const out: Record<string, Record<string, unknown>> = {};
  for (const [name, def] of Object.entries(servers)) {
    if ('url' in def && typeof def.url === 'string') {
      out[name] = { type: 'remote', url: def.url, enabled: true, ...(def.headers ? { headers: def.headers } : {}) };
      continue;
    }
    if ('command' in def && typeof def.command === 'string') {
      out[name] = {
        type: 'local',
        command: [def.command, ...(def.args ?? [])],
        enabled: true,
        ...(def.env ? { environment: def.env } : {}),
      };
    }
  }
  return out;
}

/** 사람 설정에서 **물려받을 키만** 고른다. 목록을 늘릴 때는 위 머리말의 판단을 다시 읽어라. */
const INHERITED_KEYS = ['provider', 'model', 'small_model'] as const;

/**
 * 전용 제공사 경로(provider lane, `providerLane.ts`)의 provider 이름. 에이전트 모델은 `harkroom-lane/<모델 id>` 로 적는다.
 * 내장 `anthropic` 이 아니라 새 이름이어야 한다 — 내장 provider 는 지운 `ANTHROPIC_API_KEY` 를 찾는다.
 */
export const PROVIDER_LANE_OPENCODE_PROVIDER = 'harkroom-lane';
/**
 * lane 턴의 홈 표지 자리(`OPENCODE_TEST_HOME`). opencode 는 `~/.claude`·`~/.agents`·`~/.opencode` 의 지시·스킬·설정을 싣는데,
 * 이 이름이 그 `~` 를 바꾼다 — 비워 둔 이 폴더를 주면 사람 홈의 것이 lane 턴에 안 실린다(1.18.32 실측). 셸의 `HOME` 은 그대로다.
 */
export function opencodeLaneHome(opencodeHome: string): string {
  return join(opencodeHome, 'lane-home');
}
/**
 * 모델 id 문법. opencode 는 설정 **본문 전체**에서 `{env:…}`·`{file:…}` 를 바꿔 넣으므로, 서버에서 온 모델 이름에
 * 중괄호가 섞이면 키나 아무 파일이 모델 이름 자리로 gateway 에 실려 간다. 그래서 글자를 좁힌다.
 */
const LANE_MODEL_ID = /^(?=.{1,128}$)[A-Za-z0-9][A-Za-z0-9._:-]*(?:\/[A-Za-z0-9._:-]+)*$/;
// `/` 는 마디 사이에만 받는다(2026-10-23): gateway 모델 id 는 `ExampleOrg/example-model` 처럼 조직 이름을 앞에 단다. `/` 를
// 막으면 그런 모델은 lane 목록이 비어 opencode 가 「Connect a provider」 창을 띄우고 선다. 중괄호는 여전히 못 들어온다.

/** `harkroom-lane/<id>` 에서 id 를 꺼낸다. 아니면 null — 그 턴은 모델을 못 찾고 실패한다(다른 provider 로 안 떨어진다). */
export function providerLaneModelId(model: string | null | undefined): string | null {
  const prefix = `${PROVIDER_LANE_OPENCODE_PROVIDER}/`;
  if (!model?.startsWith(prefix)) return null;
  const id = model.slice(prefix.length);
  return LANE_MODEL_ID.test(id) ? id : null;
}

/**
 * opencode lane 턴의 모델이 lane 모양(`harkroom-lane/<id>`)이 아니어서 **띄워 봐야 서는가**. 참이면 러너는 키를 받기 전에
 * `bad_model` 로 실패한다 — 띄우면 lane 목록이 비어 opencode 가 「Connect a provider」 창에서 선다(2026-10-23 watcher).
 */
export function opencodeLaneModelMissing(lane: boolean, xdgHome: boolean, model: string | null | undefined): boolean {
  // 하네스 이름이 아니라 표의 성질(`usesXdgHome` — 이 설정 파일로 모델을 고르는 하네스)로 가른다.
  return lane && xdgHome && providerLaneModelId(model) === null;
}

/**
 * lane 에이전트의 provider 블록(security ⓕ). 사람 설정의 provider 는 **물리지 않고** 이 블록 하나만 연다.
 * 주소·키는 이 공유 파일에 없다 — 그 턴의 파일(`OPENCODE_CONFIG`)이 키 파일 경로를 `{file:…}` 로 가리킨다(ⓐ).
 * `enabled_providers` 로 다른 provider(무료 티어·사람 로그인)를 닫아, 값을 못 받으면 다른 길로 돌지 않고 실패한다.
 */
/** lane 블록에 남겨 둘 모델 수(n6). 넘치면 오래된 것부터 뺀다 — 이번 턴 모델은 늘 남는다. */
export const PROVIDER_LANE_MODEL_KEEP = 16;

/**
 * 지난번 이 파일에 적힌 lane 모델 id 들(n6). 설정 파일은 에이전트당 하나라, 같은 에이전트의 동시 턴이 서로 다른 모델이면
 * 나중 턴이 앞 턴의 모델을 목록에서 지워 앞 턴이 `Model not found` 로 죽는다 — 그래서 **덮지 않고 쌓는다**. 각 턴은
 * argv `-m` 으로 제 모델을 고르므로 목록에 있기만 하면 된다. 이름 문법은 다시 잰다(손으로 고친 파일도 지난다).
 */
async function previousLaneModels(file: string): Promise<string[]> {
  try {
    const doc = JSON.parse(await readFile(file, 'utf8')) as { provider?: Record<string, { models?: Record<string, unknown> }> };
    const models = doc.provider?.[PROVIDER_LANE_OPENCODE_PROVIDER]?.models;
    return models && typeof models === 'object' ? Object.keys(models).filter((id) => LANE_MODEL_ID.test(id)) : [];
  } catch {
    return [];
  }
}

function providerLaneConfig(model: string | null, previous: readonly string[] = []): Record<string, unknown> {
  const id = providerLaneModelId(model);
  const name = PROVIDER_LANE_OPENCODE_PROVIDER;
  const ids = [...previous.filter((x) => x !== id), ...(id ? [id] : [])].slice(-PROVIDER_LANE_MODEL_KEEP);
  return {
    provider: {
      [name]: {
        npm: '@ai-sdk/anthropic',
        name: 'Harkroom provider lane',
        // 주소·키(`options`)는 여기 두지 않는다 — 턴마다 `OPENCODE_CONFIG` 의 턴 파일이 준다(`writeOpencodeLaneTurnConfig`).
        // 목록에 없는 모델은 opencode 가 거절한다(1.18.32 실측 `Model not found`) — 이 턴의 모델에 지난 턴들의 모델을 더해 둔다(n6).
        models: Object.fromEntries(ids.map((x) => [x, { name: x }])),
      },
    },
    enabled_providers: [name],
    ...(id ? { model: `${name}/${id}`, small_model: `${name}/${id}` } : {}),
  };
}

/**
 * JSONC(주석·끝 쉼표)를 JSON 으로. Kilo 의 사람 설정은 `kilo.jsonc` 이다(실측 — 처음 뜰 때
 * 그 이름으로 만든다). 문자열 안의 `//`(URL)는 건드리지 않는다.
 */
export function stripJsonc(text: string): string {
  let out = '';
  for (let i = 0; i < text.length; i++) {
    const c = text[i]!;
    if (c === '"') {
      let j = i + 1;
      while (j < text.length && text[j] !== '"') j += text[j] === '\\' ? 2 : 1;
      out += text.slice(i, j + 1);
      i = j;
    } else if (c === '/' && text[i + 1] === '/') {
      while (i < text.length && text[i] !== '\n') i++;
      out += '\n';
    } else if (c === '/' && text[i + 1] === '*') {
      i += 2;
      while (i < text.length && !(text[i] === '*' && text[i + 1] === '/')) i++;
      i++;
    } else {
      out += c;
    }
  }
  return out.replace(/,(\s*[}\]])/g, '$1');
}

async function readJson(path: string): Promise<Record<string, unknown> | null> {
  return readFile(path, 'utf8').then(
    (text) => JSON.parse(stripJsonc(text)) as Record<string, unknown>,
    () => null,
  );
}

/** 사람 설정을 `userConfigFiles` 순서로 찾는다. 하나도 못 읽으면 빈 표다. */
async function readUserConfig(app: XdgApp, sourceConfig?: string): Promise<Record<string, unknown>> {
  if (sourceConfig) return (await readJson(sourceConfig)) ?? {};
  const dir = join(process.env.XDG_CONFIG_HOME ?? join(homedir(), '.config'), app.dir);
  for (const file of app.userConfigFiles) {
    const found = await readJson(join(dir, file));
    if (found) return found;
  }
  return {};
}

/**
 * 러너 전용 opencode 루트를 만들고(없으면) 로그인을 링크하고 설정을 쓴다.
 * 매 턴 불러도 되게 **멱등**이다 — 설정은 늘 새로 쓰고(오퍼레이터의 표가 바뀔 수 있다),
 * 링크는 이미 맞으면 두고, 엉뚱한 곳을 가리키면 크게 실패한다.
 */
export async function ensureOpencodeHome(opts: {
  opencodeHome: string;
  /** 오퍼레이터가 만든 claude 형식 MCP 표. `harkroom` 브릿지가 여기 들어 있다. */
  mcpServers: Record<string, ClaudeStyleServer>;
  sourceConfig?: string;
  sourceData?: string;
  /** 어느 하네스의 이름표로 쓰나(어댑터의 `xdgApp`). 없으면 opencode. */
  app?: XdgApp;
  /**
   * 전용 제공사 경로로 뜬 러너면 그 턴의 모델(`harkroom-lane/<id>`, 모르면 null). 주면 사람 설정의 provider·모델을
   * 물리지 않고 lane 블록만 쓰며, 사람 로그인(`auth.json`)도 링크하지 않는다(security ⓒ·ⓕ).
   */
  providerLane?: { model: string | null };
}): Promise<string> {
  const { opencodeHome } = opts;
  const app = opts.app ?? OPENCODE_APP;
  const dirs = opencodeDirs(opencodeHome);
  await mkdir(opencodeHome, { recursive: true, mode: 0o700 });
  await chmod(opencodeHome, 0o700);
  for (const dir of Object.values(dirs)) await mkdir(dir, { recursive: true, mode: 0o700 });

  const inherited: Record<string, unknown> = {};
  if (opts.providerLane) {
    Object.assign(inherited, providerLaneConfig(opts.providerLane.model, await previousLaneModels(opencodeConfigFile(opencodeHome, app))));
  } else {
    const user = await readUserConfig(app, opts.sourceConfig);
    for (const key of INHERITED_KEYS) if (user[key] !== undefined) inherited[key] = user[key];
  }

  const config = {
    $schema: app.schema,
    ...inherited,
    mcp: toOpencodeMcp(opts.mcpServers),
    agent: {
      /**
       * 읽기 전용 멘션 턴이 고르는 에이전트. **보증은 이 설정이 한다** — 실측에서 모델은
       * 쓰기가 막힌 뒤에도 "파일이 생성되었습니다" 라고 말했고, 디렉터리는 비어 있었다.
       * 사람이 읽는 문장이 아니라 이 권한 표가 사실이다.
       */
      [OPENCODE_READONLY_AGENT]: {
        mode: 'primary',
        permission: { edit: 'deny', bash: 'deny', webfetch: 'deny' },
        // 모델을 안 적으면 그 에이전트만 기본(무료 티어)으로 떨어진다(실측).
        ...(typeof inherited.model === 'string' ? { model: inherited.model } : {}),
      },
      // lane 턴만 고른다. lane 이 아닌 러너에는 적지 않는다(사람 provider 로 돌 에이전트가 아니다).
      ...(opts.providerLane ? {
        [OPENCODE_LANE_AGENT]: {
          mode: 'primary',
          permission: OPENCODE_LANE_PERMISSION,
          ...(typeof inherited.model === 'string' ? { model: inherited.model } : {}),
        },
      } : {}),
    },
  };
  await mkdir(join(dirs.XDG_CONFIG_HOME, app.dir), { recursive: true });
  await writeFile(opencodeConfigFile(opencodeHome, app), `${JSON.stringify(config, null, 2)}\n`, { mode: 0o600 });

  // 로그인은 링크로 재사용한다. **자리가 한 단계 깊다** — `<data>/opencode/auth.json` 이다.
  const sourceAuth = join(opts.sourceData ?? sourceOpencodeData(process.env, homedir(), app), 'auth.json');
  const targetDir = join(dirs.XDG_DATA_HOME, app.dir);
  const targetAuth = join(targetDir, 'auth.json');
  if (opts.providerLane) {
    // 홈 표지 자리는 비워 둔 채로 있어야 한다 — 만들기만 하고 안을 채우지 않는다.
    await mkdir(opencodeLaneHome(opencodeHome), { recursive: true, mode: 0o700 });
    // lane 에는 사람 로그인을 붙이지 않는다 — 한 자식에 로그인과 lane 키가 같이 들면 #374 가 막던 상황이다(ⓒ).
    // 전에 lane 이 아니던 에이전트라 링크가 남아 있으면 **링크만** 뗀다(사람 파일은 안 건드린다).
    const stat = await lstat(targetAuth).catch(() => null);
    if (stat?.isSymbolicLink()) await unlink(targetAuth);
    return opencodeHome;
  }
  if (!(await lstat(sourceAuth).catch(() => null))) return opencodeHome;
  await mkdir(targetDir, { recursive: true, mode: 0o700 });

  const targetStat = await lstat(targetAuth).catch(() => null);
  if (!targetStat) {
    await symlink(sourceAuth, targetAuth);
    return opencodeHome;
  }
  // codex 와 같은 규율: 러너 전용 로그인이 이미 있으면 보존하고, 엉뚱한 곳을 가리키는
  // 링크만 크게 실패시킨다 — 자동 교체는 사람이 로그인한 파일을 지울 수 있다.
  if (targetStat.isSymbolicLink()) {
    const target = await readlink(targetAuth);
    if (resolve(targetDir, target) !== resolve(sourceAuth)) {
      throw new Error(
        `Harkroom ${app.dir} auth 링크가 예상과 다르다: ${targetAuth} -> ${target}. `
          + `예상 대상은 ${sourceAuth} 이다. 파일을 확인한 뒤 러너를 다시 시작해라.`,
      );
    }
  }
  return opencodeHome;
}
