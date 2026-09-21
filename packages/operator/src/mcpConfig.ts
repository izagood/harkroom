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
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

export interface McpStdioServer { type?: 'stdio'; command: string; args?: string[]; env?: Record<string, string> }
export interface McpRemoteServer { type: 'http' | 'sse'; url: string; headers?: Record<string, string> }
export type McpServerDefinition = McpStdioServer | McpRemoteServer;

/** 항상 들어가고 정의로 덮어쓸 수 없는 둘 — harkroom 없이는 에이전트가 답할 길이 없다. */
export const RESERVED_MCP_NAMES = ['harkroom', 'avcs'] as const;
export const MCP_BRIDGE_ARGS = ['mcp-bridge'] as const;

export function buildMcpConfig(input: {
  operatorBin: string;
  names: readonly string[];
  definitions: Record<string, McpServerDefinition>;
}): { mcpServers: Record<string, McpServerDefinition>; missing: string[] } {
  const mcpServers: Record<string, McpServerDefinition> = {
    // stdio 브릿지(스펙 §5). 인증 재료는 하네스 env 에서 브릿지가 읽는다 — 이 항목엔 명령만 있다.
    harkroom: { type: 'stdio', command: input.operatorBin, args: [...MCP_BRIDGE_ARGS] },
    avcs: { type: 'stdio', command: 'avcs', args: ['mcp'] },
  };
  const missing: string[] = [];
  for (const name of input.names) {
    if ((RESERVED_MCP_NAMES as readonly string[]).includes(name)) continue;
    const def = input.definitions[name];
    if (!def) { missing.push(name); continue; }
    // claude 의 표는 stdio 항목에 type 을 안 적기도 한다 — codex 는 transport 가 없으면 설정 전체를 거절한다.
    mcpServers[name] = 'url' in def ? def : { type: 'stdio', ...def };
  }
  return { mcpServers, missing };
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
