/**
 * 오퍼레이터 박동(원격 호스트 관리 P3a, 스레드 3b0f0255) — 서버 `status` 프레임의 본문을 만든다.
 *
 * 서버는 받은 것을 화이트리스트로 다시 고른다(`parseOperatorStatus`). 그래도 여기서부터 **값을 싣지 않는다**:
 * 자격 증명 칸은 이 PR 에서 보내지 않는다(이름을 무엇으로 채울지는 원격 로그인 P6 에서 정한다, security n3).
 *
 * 머신 값은 `/etc/machine-id`(리눅스) · IOPlatformUUID(맥)의 sha256 hex 다. **원래 값은 보내지 않는다** —
 * 서버가 이것을 소유자 id 와 다시 섞어 저장한다(`operator.machine_id`).
 */
import { createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import { readFile, statfs } from 'node:fs/promises';
import { freemem, platform, totalmem } from 'node:os';
import type { OperatorMcpStatusEntry, OperatorPlatform, OperatorStatus } from '@harkroom/shared';
import type { OperatorMcpAuthState } from '@harkroom/shared/daemonProtocol';
import { MAX_STATUS_MCP } from '@harkroom/shared/operatorProtocol';
import type { McpServerDefinition } from './mcpConfig.js';

/** 박동 주기. 서버는 이보다 촘촘한 박동을 거른다(`STATUS_MIN_INTERVAL_MS`). */
export const HEARTBEAT_INTERVAL_MS = 30_000;

export interface HeartbeatSources {
  startedAt: Date;
  /** 지금 쥔 턴 자리와 상한(`turnSlots`). 상한이 없으면 max null. */
  turns(): { running: number; max: number | null };
  /** runnerId → 그 러너가 쥔 턴 자리 수. */
  turnsByRunner(): Map<string, number>;
  /** 살아 있는 러너의 runnerId → agentId. */
  runners(): { runnerId: string; agentId: string }[];
  /** 디스크 여유를 잴 경로(오퍼레이터 데이터 디렉터리). */
  dataDir: string;
}

const PLATFORMS = new Set<string>(['darwin', 'linux', 'win32']);

export async function collectStatus(src: HeartbeatSources): Promise<OperatorStatus> {
  const status: OperatorStatus = {
    startedAt: src.startedAt.toISOString(),
    turns: src.turns(),
    memory: { totalBytes: totalmem(), freeBytes: Math.min(freemem(), totalmem()) },
  };
  const os = platform();
  if (PLATFORMS.has(os)) status.platform = os as OperatorPlatform;
  try {
    const fs = await statfs(src.dataDir);
    const total = fs.blocks * fs.bsize;
    const free = Math.min(fs.bavail * fs.bsize, total);
    if (Number.isSafeInteger(total) && Number.isSafeInteger(free)) status.disk = { totalBytes: total, freeBytes: free };
  } catch { /* 못 재면 칸을 뺀다 — 서버도 화면도 "모름"으로 그린다 */ }
  const byRunner = src.turnsByRunner();
  const perAgent = new Map<string, number>();
  for (const r of src.runners()) perAgent.set(r.agentId, (perAgent.get(r.agentId) ?? 0) + (byRunner.get(r.runnerId) ?? 0));
  status.runners = [...perAgent].map(([agentId, turns]) => ({ agentId, turns }));
  return status;
}

/** 머신 고유값을 읽어 sha256 hex 로. 못 읽으면 null(박동은 머신 값 없이 간다). */
export async function readMachineDigest(
  os: string = platform(),
  read: (path: string) => Promise<string> = (p) => readFile(p, 'utf8'),
  ioreg: () => Promise<string> = () => new Promise((resolve, reject) =>
    execFile('/usr/sbin/ioreg', ['-rd1', '-c', 'IOPlatformExpertDevice'], { timeout: 5_000 }, (err, out) => (err ? reject(err) : resolve(out)))),
): Promise<string | null> {
  let raw: string | null = null;
  try {
    if (os === 'linux') {
      raw = (await read('/etc/machine-id').catch(() => read('/var/lib/dbus/machine-id'))).trim();
    } else if (os === 'darwin') {
      raw = /"IOPlatformUUID"\s*=\s*"([^"]+)"/.exec(await ioreg())?.[1] ?? null;
    }
  } catch { raw = null; }
  if (!raw) return null;
  // 접두를 섞는다 — 같은 machine-id 를 다른 용도로 해시한 값과 겹치지 않게.
  return createHash('sha256').update(`harkroom-operator-machine:${raw}`).digest('hex');
}

/**
 * MCP 상태의 재료(MCP 설정 v2 PR4). 정의는 두 파일을 따로 읽고(`readLocalMcpSources`), 인증 상태는
 * 오퍼레이터의 OAuth 저장소에 묻는다. 둘 다 **값을 밖으로 내지 않는다** — 여기서 상태 낱말·지문으로 줄인다.
 */
export interface McpStatusSources {
  definitions(): Promise<{ operator: Record<string, McpServerDefinition>; claude: Record<string, McpServerDefinition> }>;
  auth?: (name: string, url: string, clientId?: string) => Promise<OperatorMcpAuthState>;
}

/**
 * Client ID 지문 — **원래 값을 싣지 않는다.** 서버 주소를 섞는다(머신 값의 n7 과 같은 판단): 같은 주인의 오퍼레이터는
 * 같은 서버에 붙으니 서로 견줄 수 있고, 서버가 다르면 값이 갈려 두 서버의 관리자가 대조하지 못한다.
 * Client ID 는 비밀이 아니라 공개 값이라(브라우저 주소에 실린다) HMAC 키까지는 두지 않는다 — 오퍼레이터는 서버
 * 비밀을 모르고, 지문의 쓰임은 「같은 앱인가」 대조뿐이다.
 */
export function clientIdFingerprint(baseUrl: string, clientId: string): string {
  return createHash('sha256').update(`harkroom-mcp-client:${baseUrl}\n${clientId}`).digest('hex').slice(0, 16);
}

/**
 * `names` 에 대한 MCP 상태. 이름은 **부르는 쪽이 고른다** — 커뮤니티마다 그 커뮤니티가 배정한 에이전트가 켠 이름만
 * 넘긴다(`community.ts` 의 박동). 여기서 이 머신의 다른 정의를 덧붙이지 않는다.
 */
export async function collectMcpStatus(names: readonly string[], baseUrl: string, src: McpStatusSources): Promise<OperatorMcpStatusEntry[]> {
  const { operator, claude } = await src.definitions();
  const out: OperatorMcpStatusEntry[] = [];
  for (const name of [...new Set(names)].slice(0, MAX_STATUS_MCP)) {
    const fromOperator = Object.hasOwn(operator, name);
    const def = fromOperator ? operator[name] : Object.hasOwn(claude, name) ? claude[name] : undefined;
    if (!def) { out.push({ name, defined: false }); continue; }
    const entry: OperatorMcpStatusEntry = { name, defined: true, source: fromOperator ? 'operator' : 'claude' };
    if ('url' in def && typeof def.url === 'string') {
      entry.transport = def.type === 'sse' ? 'sse' : 'http';
      const clientId = typeof def.oauth?.clientId === 'string' && def.oauth.clientId ? def.oauth.clientId : undefined;
      entry.oauth = def.oauth !== undefined && def.oauth !== null;
      if (clientId) entry.clientIdFp = clientIdFingerprint(baseUrl, clientId);
      if (src.auth) {
        const st = await src.auth(name, def.url, clientId).catch((): OperatorMcpAuthState => ({ state: 'error', reason: '' }));
        entry.auth = st.state;
        const at = st.state === 'ok' ? st.at : st.state === 'rejected' ? st.at : undefined;
        if (typeof at === 'number' && Number.isFinite(at)) entry.authAt = new Date(at).toISOString();
      }
    } else {
      entry.transport = 'stdio';
    }
    out.push(entry);
  }
  return out;
}
