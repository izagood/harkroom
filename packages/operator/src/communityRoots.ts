/**
 * 커뮤니티별 오퍼레이터 뿌리의 색인 `<앱 데이터>/operators.json` 을 읽고 쓰고, 스위치를 판정한다(격리 C안 P1).
 *
 * 규칙(뿌리 계산·소켓 길이·충돌)은 `@harkroom/shared/operatorRoots` 에 있고 여기는 파일과 env 만 다룬다.
 * **스위치 `HARKROOM_OPERATOR_PER_COMMUNITY` 가 정확히 `1` 일 때만** 커뮤니티별 뿌리를 쓴다. 꺼져 있으면
 * `operatorDataRoot` 는 받은 앱 데이터 디렉터리를 그대로 돌려준다 — 지금 동작과 같다.
 */
import { chmod, lstat, mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import {
  EMPTY_OPERATOR_ROOTS_INDEX,
  OPERATOR_ROOTS_INDEX_FILE,
  communityRootKey,
  duplicateRoot,
  OPERATOR_COMMUNITY_ENV,
  PER_COMMUNITY_ENV,
  perCommunityEnabled,
  sameRoot,
  resolveCommunityRoot,
  type CommunityRootResolution,
  type OperatorRootEntry,
  type OperatorRootsIndex,
} from '@harkroom/shared/operatorRoots';

/** 스위치는 정확히 `1` 일 때만 켜진다(빈 값·`true`·`0` 은 꺼짐). 규칙은 shared 하나에 있다. */
export { PER_COMMUNITY_ENV, perCommunityEnabled };

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
  const index: OperatorRootsIndex = { version: 1, communities: out };
  // 두 커뮤니티가 한 뿌리를 쓰는 색인은 믿지 않는다 — 그 뿌리의 오퍼레이터가 두 커뮤니티를 함께 들게 된다(security P1-n1).
  const dup = duplicateRoot(index);
  if (dup) throw new Error(`오퍼레이터 색인에서 두 커뮤니티가 한 뿌리를 쓴다(${dup}): ${path}`);
  return index;
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
  const key = communityRootKey(baseUrl);
  const owner = Object.entries(index.communities).find(([k, e]) => k !== key && sameRoot(e.root, entry.root))?.[0];
  if (owner) throw new Error(`그 뿌리는 이미 다른 커뮤니티(${owner})의 것이다: ${entry.root}`);
  const next: OperatorRootsIndex = { version: 1, communities: { ...index.communities, [key]: entry } };
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

/**
 * 커뮤니티 뿌리 디렉터리를 쓸 수 있게 한다(security P1-n2). 토큰·소켓이 그 아래에 들어가므로:
 * - 새 뿌리는 0700 으로 만들고, 이미 있는데 그보다 넓으면 0700 으로 좁힌다.
 * - 이미 있으면 **심링크가 아니고 디렉터리이며 내 소유**여야 한다. 아니면 던진다 — 남이 미리 만들어 둔 자리나
 *   다른 곳을 가리키는 링크에 토큰을 쓰지 않는다.
 * - 옛 단일 오퍼레이터 자리(D5, `legacy`)는 앱 데이터 디렉터리라 만들지도 권한을 바꾸지도 않고, 같은 기준(심링크
 *   아님·디렉터리·내 소유)만 확인한다.
 */
export async function ensureCommunityRootDir(root: string, opts: { legacy?: boolean; uid?: number | null } = {}): Promise<void> {
  const uid = opts.uid === undefined ? (process.getuid?.() ?? null) : opts.uid;
  if (!opts.legacy) await mkdir(root, { recursive: true, mode: 0o700 });
  const st = await lstat(root);
  if (st.isSymbolicLink()) throw new Error(`오퍼레이터 뿌리가 심링크다: ${root}`);
  if (!st.isDirectory()) throw new Error(`오퍼레이터 뿌리가 디렉터리가 아니다: ${root}`);
  if (uid !== null && st.uid !== uid) throw new Error(`오퍼레이터 뿌리의 주인이 내가 아니다(uid ${st.uid}): ${root}`);
  if (!opts.legacy && (st.mode & 0o077) !== 0) await chmod(root, 0o700);
}

/**
 * 커뮤니티마다 프로세스 모드에서 `operator.json` 은 **커뮤니티 하나**만 든다 — 다른 커뮤니티 칸을 넣으려 하면
 * 쓰기를 거절한다(다른 커뮤니티의 오퍼레이터를 연결할 수 없다는 것을 파일이 보장한다). 스위치가 꺼져 있으면 아무 일도 없다.
 */
export function assertSingleCommunity(communities: Record<string, unknown>, env: NodeJS.ProcessEnv): void {
  if (!perCommunityEnabled(env)) return;
  const keys = Object.keys(communities);
  if (keys.length > 1) throw new Error(`커뮤니티마다 오퍼레이터 모드에서 operator.json 에 커뮤니티가 둘 이상이다: ${keys.join(', ')}`);
  // 칸 수만 세면, 빈 A 뿌리에 B 칸이 처음 들어올 때 통과한다(security P2a-n1). 이 프로세스가 맡은 커뮤니티와 같아야 한다.
  const mine = env[OPERATOR_COMMUNITY_ENV];
  if (!mine) throw new Error(`커뮤니티마다 오퍼레이터 모드인데 ${OPERATOR_COMMUNITY_ENV} 가 없다 — 어느 커뮤니티의 뿌리인지 모른다`);
  const key = keys[0];
  if (key !== undefined && communityRootKey(key) !== communityRootKey(mine)) {
    throw new Error(`이 뿌리는 ${communityRootKey(mine)} 의 것이다 — 다른 커뮤니티(${key})를 넣을 수 없다`);
  }
}
