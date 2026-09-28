/**
 * 이 머신의 MCP 정의 — 앱이 소켓으로 넣고 뺀다(스펙 2026-09-20 §6).
 *
 * 서버 레지스트리(`mcp_server`)에는 이름과 자격증명 종류만 있고, 정의(명령·url·env 의 토큰)는
 * `<appDataDir>/operator/mcp-servers.json` 에 있다. 그 파일의 writer 는 오퍼레이터 하나다 —
 * `operator.json` 과 같은 규율(`localAgents.ts`). 러너 config 는 러너를 띄울 때 이 파일을 다시
 * 읽어 만든다(`communities.ts::mcpConfig`)이므로 여기서 도는 러너에 알릴 것은 없다.
 *
 * 목록은 env·headers 의 **값을 돌려주지 않는다**(키만) — 웹뷰가 토큰을 되읽을 길을 만들지 않는다.
 * `~/.claude.json` 의 정의도 함께 보이지만(`source: 'claude'`) 여기서 고치지 않는다 — 그 파일은
 * 사람의 claude 설정이다. 같은 이름이면 오퍼레이터 표가 이긴다(`readLocalMcpDefinitions` 와 같은 순서).
 */
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import type { OperatorMcpEntry, OperatorMcpListResult, OperatorMcpRemoteDefinition } from '@harkroom/shared/daemonProtocol';

export interface LocalMcpPort {
  list(): Promise<OperatorMcpListResult>;
  /** http·sse 만 — stdio 는 소켓으로 받지 않는다(`readOperatorMcpSetPayload` 주석, #431). */
  set(name: string, definition: OperatorMcpRemoteDefinition): Promise<void>;
  remove(name: string): Promise<void>;
}

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);

async function readTable(path: string): Promise<Record<string, unknown>> {
  let raw: string;
  try { raw = await readFile(path, 'utf8'); } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return {};
    throw err;
  }
  // 깨진 파일을 빈 표로 읽고 덮어쓰면 사람이 적은 정의가 사라진다 — 던져서 사람에게 보인다.
  const parsed: unknown = JSON.parse(raw);
  if (!isRecord(parsed)) throw new Error(`${path} 는 객체여야 한다`);
  return parsed;
}

/** 임시 파일에 0600 으로 쓰고 rename 한다 — env·headers 에 토큰이 실린다. */
async function writeTable(path: string, table: Record<string, unknown>): Promise<void> {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  const tmp = `${path}.tmp-${process.pid}-${Date.now()}`;
  await writeFile(tmp, `${JSON.stringify(table, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 });
  await rename(tmp, path);
}

export function describeMcpDefinition(name: string, source: OperatorMcpEntry['source'], def: Record<string, unknown>): OperatorMcpEntry {
  const keys = (v: unknown) => (isRecord(v) ? Object.keys(v).sort() : []);
  if (typeof def.url === 'string') {
    return {
      name, source, transport: def.type === 'sse' ? 'sse' : 'http', target: def.url, args: [],
      envKeys: [], headerKeys: keys(def.headers), oauth: isRecord(def.oauth),
    };
  }
  return {
    name, source, transport: 'stdio', target: typeof def.command === 'string' ? def.command : '',
    args: Array.isArray(def.args) ? def.args.filter((a): a is string => typeof a === 'string') : [],
    envKeys: keys(def.env), headerKeys: [], oauth: false,
  };
}

export function createLocalMcpPort(deps: { registryPath: string; claudeConfigPath: string | null }): LocalMcpPort {
  return {
    async list() {
      const out = new Map<string, OperatorMcpEntry>();
      if (deps.claudeConfigPath) {
        let claude: unknown;
        try { claude = JSON.parse(await readFile(deps.claudeConfigPath, 'utf8')); } catch { claude = undefined; }
        if (isRecord(claude) && isRecord(claude.mcpServers)) {
          for (const [name, def] of Object.entries(claude.mcpServers)) if (isRecord(def)) out.set(name, describeMcpDefinition(name, 'claude', def));
        }
      }
      for (const [name, def] of Object.entries(await readTable(deps.registryPath))) {
        if (isRecord(def)) out.set(name, describeMcpDefinition(name, 'operator', def));
      }
      return { servers: [...out.values()].sort((a, b) => a.name.localeCompare(b.name)) };
    },
    async set(name, definition) {
      const table = await readTable(deps.registryPath);
      table[name] = definition;
      await writeTable(deps.registryPath, table);
    },
    async remove(name) {
      const table = await readTable(deps.registryPath);
      if (!(name in table)) return;
      delete table[name];
      await writeTable(deps.registryPath, table);
    },
  };
}
