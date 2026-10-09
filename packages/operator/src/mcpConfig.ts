/**
 * 하네스 MCP 설정 — **오퍼레이터가 쓴다**(스펙 2026-09-20 §6). 서버는 `mcp_server` 레지스트리에
 * 이름과 자격증명 종류만 두고, 정의(명령·인자·env 의 토큰)는 이 머신에만 있다. 러너는 완성된
 * 파일의 경로(`HARKROOM_MCP_CONFIG`)만 받는다 — 옛 `turn.ts::writeMcpConfigOnce` 가 러너 안에서
 * harkroom+avcs 둘만 굽던 것을 여기로 옮기고 이름 합치기를 더했다.
 *
 * 정의를 찾는 순서: `<appDataDir>/operator/mcp-servers.json`(오퍼레이터 자신의 표) → claude 의
 * `~/.claude.json`(`CLAUDE_CONFIG_DIR` 아래면 그곳)의 `mcpServers`. 앞이 이긴다 — 사람이 이
 * 오퍼레이터를 위해 따로 적은 정의가 개인 claude 설정보다 의도에 가깝다.
 *
 * 이름이 이 머신에 없으면 **빼고 띄우지 않는다.** 도구 하나 없이 뜬 에이전트는 에러 없이 돌다가
 * 못 하겠다고만 답한다(codex 의 `invalid transport` 사고와 같은 종류의 조용한 실패). `missing`
 * 으로 돌려주고 조정기가 배정을 거절한다 — 사람이 정의를 적거나 에이전트에서 그 이름을 뺀다.
 */
import { mkdir, readdir, readFile, rename, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

export interface McpStdioServer {
  type?: 'stdio'; command: string; args?: string[]; env?: Record<string, string>;
  /**
   * claude 전용(2.1.x): 참이면 이 서버의 도구를 **지연 로딩(tool search) 뒤로 미루지 않는다.**
   * 다른 하네스는 이 키를 읽지 않는다 — codex 는 harkroom 항목을 `-c` 로 따로 굽고(`turn.ts`), opencode·pi 는
   * 아는 필드만 골라 번역한다(`opencodeHome.ts::toOpencodeMcp`).
   */
  alwaysLoad?: boolean;
}
export interface McpRemoteServer { type: 'http' | 'sse'; url: string; headers?: Record<string, string>; oauth?: { clientId?: string; callbackPort?: number } }
export type McpServerDefinition = McpStdioServer | McpRemoteServer;

/** 항상 들어가고 정의로 덮어쓸 수 없는 둘 — harkroom 없이는 에이전트가 답할 길이 없다. */
export const RESERVED_MCP_NAMES = ['harkroom', 'avcs'] as const;
export const MCP_BRIDGE_ARGS = ['mcp-bridge'] as const;

export function buildMcpConfig(input: {
  operatorBin: string;
  names: readonly string[];
  definitions: Record<string, McpServerDefinition>;
  /**
   * 오퍼레이터가 든 OAuth 토큰(`mcpOAuth.ts::tokensFor`). 있으면 `Authorization` 헤더로 굽고 `oauth`
   * 는 뺀다 — 하네스가 제 손으로 인증하지 않게(계정 디렉터리마다 따로 남는 토큰, 2026-09-30).
   */
  tokens?: Record<string, string>;
  /** refresh 가 거절돼 쓸 수 없는 이름 — `needsAuth` 에 싣는다. */
  expired?: readonly string[];
}): { mcpServers: Record<string, McpServerDefinition>; missing: string[]; needsAuth: string[] } {
  const mcpServers: Record<string, McpServerDefinition> = {
    // stdio 브릿지(스펙 §5). 인증 재료는 하네스 env 에서 브릿지가 읽는다 — 이 항목엔 명령만 있다.
    //
    // `alwaysLoad` 를 **켜지 않는다**(2026-10-09, 2026-10-02 에 켰던 것을 되돌림). 켜면 harkroom 도구가 지연
    // 목록이 아니라 도구 배열에 바로 실린다. 그런데 claude 는 `-r` 로 뜬 턴의 첫 API 호출을 이 서버가 붙기
    // 전에 보낼 수 있다(연결을 시한까지만 기다린다) — 그러면 붙는 순간 도구 배열이 바뀌어 **이어받은 문맥의
    // 프롬프트 캐시가 통째로 깨진다**(고정 접두부만 읽고 나머지를 다시 쓴다). 실험(-r 10턴씩): 켬+늦게 붙음
    // 2/2 깨짐, 끔+늦게 붙음 0/4 깨짐 — 지연 목록으로 늦게 붙는 것은 캐시를 건드리지 않는다. 대가는 턴마다
    // `ToolSearch` 1회지만, 늦게 붙는 턴은 켜 둬도 어차피 ToolSearch 를 불렀다.
    harkroom: { type: 'stdio', command: input.operatorBin, args: [...MCP_BRIDGE_ARGS] },
    avcs: { type: 'stdio', command: 'avcs', args: ['mcp'] },
  };
  const missing: string[] = [];
  const needsAuth: string[] = [];
  for (const name of input.names) {
    if ((RESERVED_MCP_NAMES as readonly string[]).includes(name)) continue;
    const def = input.definitions[name];
    if (!def) { missing.push(name); continue; }
    // claude 의 표는 stdio 항목에 type 을 안 적기도 한다 — codex 는 transport 가 없으면 설정 전체를 거절한다.
    if ('url' in def) {
      const token = input.tokens?.[name];
      if (token) {
        const { oauth: _oauth, ...rest } = def;
        mcpServers[name] = { ...rest, headers: { ...(def.headers ?? {}), Authorization: `Bearer ${token}` } };
        continue;
      }
      // 토큰이 없다. 정의에 `oauth` 가 있거나(인증을 요구한다고 적혀 있다) refresh 가 거절된 것은
      // "인증 필요"다. **정의는 그대로 둔다** — 하네스가 제 계정에 든 옛 토큰으로라도 붙게(전과 같은 동작).
      if (def.oauth || input.expired?.includes(name)) needsAuth.push(name);
      mcpServers[name] = def;
      continue;
    }
    mcpServers[name] = { type: 'stdio', ...def };
  }
  return { mcpServers, missing, needsAuth };
}

export function claudeConfigPath(env: NodeJS.ProcessEnv, home: string): string {
  return join(env.CLAUDE_CONFIG_DIR || home, '.claude.json');
}

async function readJsonIfExists(path: string): Promise<unknown | undefined> {
  let raw: string;
  try { raw = await readFile(path, 'utf8'); } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
    throw err;
  }
  try { return JSON.parse(raw) as unknown; } catch (err) {
    throw new Error(`${path} 을 읽을 수 없다: ${err instanceof Error ? err.message : String(err)}`);
  }
}

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);

/** 두 파일을 합친 정의 표. 레지스트리(앞)가 claude 설정(뒤)을 이긴다. 없는 파일은 빈 표, 깨진 파일은 던진다. */
export async function readLocalMcpDefinitions(paths: { registryPath: string; claudeConfigPath: string | null }): Promise<Record<string, McpServerDefinition>> {
  const out: Record<string, McpServerDefinition> = {};
  if (paths.claudeConfigPath) {
    const claude = await readJsonIfExists(paths.claudeConfigPath);
    if (isRecord(claude) && isRecord(claude.mcpServers)) {
      for (const [name, def] of Object.entries(claude.mcpServers)) if (isRecord(def)) out[name] = def as unknown as McpServerDefinition;
    }
  }
  const registry = await readJsonIfExists(paths.registryPath);
  if (isRecord(registry)) {
    for (const [name, def] of Object.entries(registry)) if (isRecord(def)) out[name] = def as unknown as McpServerDefinition;
  }
  return out;
}

/** `<dir>/<agentId>.json` 을 0600 으로. env 에 토큰이 실릴 수 있어 파일도 비밀로 다룬다. */
export async function writeAgentMcpConfig(dir: string, agentId: string, mcpServers: Record<string, McpServerDefinition>): Promise<string> {
  await mkdir(dir, { recursive: true, mode: 0o700 });
  const path = join(dir, `${agentId}.json`);
  await writeFile(path, JSON.stringify({ mcpServers }, null, 2), { encoding: 'utf8', mode: 0o600 });
  return path;
}

/**
 * 이미 쓴 러너 설정들에 **새 토큰을 넣는다**(2026-09-30). refresh·새 인증 뒤 러너를 다시 띄우지
 * 않고 다음 턴부터 새 토큰이 가게 한다 — claude 는 턴마다 `--mcp-config` 를 읽고, codex·opencode
 * 도 턴마다 다시 읽는다(`agent/src/main.ts::readTurnMcp`).
 *
 * 이름과 **url 이 같은** 원격 항목만 고친다 — 같은 이름이 다른 서버를 가리키는 설정에 남의 토큰을
 * 넣지 않는다. 고친 파일 수를 돌려준다. 못 읽는 파일은 건너뛴다(다음 스폰이 새로 쓴다).
 */
export async function rewriteMcpConfigTokens(dir: string, updates: Record<string, { url: string; accessToken: string }>): Promise<number> {
  let files: string[];
  try { files = (await readdir(dir)).filter((f) => f.endsWith('.json')); } catch { return 0; }
  let changed = 0;
  for (const f of files) {
    const path = join(dir, f);
    let doc: { mcpServers?: Record<string, McpServerDefinition> };
    try { doc = JSON.parse(await readFile(path, 'utf8')) as typeof doc; } catch { continue; }
    let touched = false;
    for (const [name, u] of Object.entries(updates)) {
      const entry = doc.mcpServers?.[name];
      if (!entry || !('url' in entry) || entry.url !== u.url) continue;
      const { oauth: _oauth, ...rest } = entry;
      doc.mcpServers![name] = { ...rest, headers: { ...(entry.headers ?? {}), Authorization: `Bearer ${u.accessToken}` } };
      touched = true;
    }
    if (!touched) continue;
    const tmp = `${path}.tmp-${process.pid}-${Date.now()}`;
    await writeFile(tmp, JSON.stringify(doc, null, 2), { encoding: 'utf8', mode: 0o600 });
    await rename(tmp, path);
    changed += 1;
  }
  return changed;
}
