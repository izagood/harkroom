/**
 * 커뮤니티별 오퍼레이터 뿌리의 색인 `<앱 데이터>/operators.json` 을 읽고 쓰고, 스위치를 판정한다(격리 C안 P1).
 *
 * 규칙(뿌리 계산·소켓 길이·충돌)은 `@harkroom/shared/operatorRoots` 에 있고 여기는 파일과 env 만 다룬다.
 * **스위치 `HARKROOM_OPERATOR_PER_COMMUNITY` 가 정확히 `1` 일 때만** 커뮤니티별 뿌리를 쓴다. 꺼져 있으면
 * `operatorDataRoot` 는 받은 앱 데이터 디렉터리를 그대로 돌려준다 — 지금 동작과 같다.
 */
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import {
  EMPTY_OPERATOR_ROOTS_INDEX,
  OPERATOR_ROOTS_INDEX_FILE,
  communityRootKey,
  resolveCommunityRoot,
  type CommunityRootResolution,
  type OperatorRootEntry,
  type OperatorRootsIndex,
} from '@harkroom/shared/operatorRoots';

export const PER_COMMUNITY_ENV = 'HARKROOM_OPERATOR_PER_COMMUNITY';

/** 스위치는 정확히 `1` 일 때만 켜진다(빈 값·`true`·`0` 은 꺼짐). */
export function perCommunityEnabled(env: NodeJS.ProcessEnv): boolean {
  return env[PER_COMMUNITY_ENV] === '1';
}

export function rootsIndexPath(appDataDir: string): string {
  return join(appDataDir, OPERATOR_ROOTS_INDEX_FILE);
}

function parseIndex(text: string, path: string): OperatorRootsIndex {
  const value: unknown = JSON.parse(text);
  const communities = (value as { communities?: unknown } | null)?.communities;
  if ((value as { version?: unknown } | null)?.version !== 1 || !communities || typeof communities !== 'object' || Array.isArray(communities)) {
    throw new Error(`오퍼레이터 색인의 모양이 다르다: ${path}`);
  }
  const out: Record<string, OperatorRootEntry> = {};
  for (const [key, raw] of Object.entries(communities as Record<string, unknown>)) {
    const e = raw as Partial<OperatorRootEntry> | null;
    if (!e || typeof e.root !== 'string' || !e.root.startsWith('/')) throw new Error(`오퍼레이터 색인의 칸이 틀렸다(${key}): ${path}`);
    out[communityRootKey(key)] = {
      root: e.root,
      ...(typeof e.operatorId === 'string' ? { operatorId: e.operatorId } : {}),
      ...(e.legacy === true ? { legacy: true } : {}),
    };
  }
  return { version: 1, communities: out };
}

/**
 * 색인을 읽는다. 파일이 없으면 빈 색인이다. **모양이 틀리면 던진다** — 모르는 채로 빈 색인으로 치면 옛 자리(D5)를
 * 잊고 새 뿌리를 만들어 같은 커뮤니티가 두 자리로 갈린다.
 */
export async function readRootsIndex(appDataDir: string): Promise<OperatorRootsIndex> {
  const path = rootsIndexPath(appDataDir);
  let text: string;
  try { text = await readFile(path, 'utf8'); } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'ENOENT') return { ...EMPTY_OPERATOR_ROOTS_INDEX, communities: {} };
    throw e;
  }
  return parseIndex(text, path);
}

/** 원자적으로 쓴다(임시 파일 → rename, 0600). */
export async function writeRootsIndex(appDataDir: string, index: OperatorRootsIndex): Promise<void> {
  const path = rootsIndexPath(appDataDir);
  await mkdir(appDataDir, { recursive: true, mode: 0o700 });
  const tmp = `${path}.${process.pid}.${Date.now()}.tmp`;
  await writeFile(tmp, `${JSON.stringify(index, null, 2)}\n`, { mode: 0o600 });
  await rename(tmp, path);
}

/** 한 커뮤니티의 칸을 넣거나 고친다. 다른 커뮤니티 칸은 건드리지 않는다. */
export async function recordCommunityRoot(appDataDir: string, baseUrl: string, entry: OperatorRootEntry): Promise<OperatorRootsIndex> {
  const index = await readRootsIndex(appDataDir);
  const next: OperatorRootsIndex = { version: 1, communities: { ...index.communities, [communityRootKey(baseUrl)]: entry } };
  await writeRootsIndex(appDataDir, next);
  return next;
}

export type OperatorDataRoot =
  | { mode: 'single'; root: string }
  | { mode: 'per-community'; resolution: CommunityRootResolution };

/**
 * 이 커뮤니티의 오퍼레이터가 쓸 데이터 뿌리. 스위치가 꺼져 있으면 **지금과 같이** 앱 데이터 디렉터리 하나다.
 */
export async function operatorDataRoot(
  env: NodeJS.ProcessEnv,
  appDataDir: string,
  home: string,
  baseUrl: string,
): Promise<OperatorDataRoot> {
  if (!perCommunityEnabled(env)) return { mode: 'single', root: appDataDir };
  return { mode: 'per-community', resolution: resolveCommunityRoot(home, baseUrl, await readRootsIndex(appDataDir)) };
}
