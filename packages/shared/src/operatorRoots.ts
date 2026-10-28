/**
 * 커뮤니티마다 오퍼레이터를 따로 두는 구조(격리 C안, 설계 harkroom 스레드 456a56ce · architect seq 35548)의
 * **뿌리 해석 규칙**. 커뮤니티 하나 = 뿌리 하나 = 오퍼레이터 프로세스 하나다.
 *
 * ```text
 * ~/.harkroom-agent/c/<baseUrl 해시 앞 8자>/operator/operator-v1.sock   (D1)
 * ```
 *
 * 뿌리 아래의 조립은 지금과 같다(`daemonEndpointPaths(root)`) — 바뀌는 것은 그 위의 절대 위치뿐이라
 * `appDataDirFromSocket`(두 단계 위)도 그대로 성립한다. 색인 `operators.json`(앱 데이터 디렉터리)은
 * baseUrl → 뿌리를 적어 두는 곳이다. 옛 단일 오퍼레이터의 자리를 그 커뮤니티의 뿌리로 그대로 쓰는 경우(D5,
 * 이동 0)는 해시로 계산되지 않으므로 색인이 유일한 근거다.
 *
 * 이 파일은 규칙만 갖는다(읽고 쓰는 것은 오퍼레이터 `communityRoots.ts`). 앱(Rust)도 같은 규칙으로 계산한다.
 */
import { createHash } from 'node:crypto';
import { join, resolve } from 'node:path';
import { daemonEndpointPaths } from './daemonEndpoint.js';

/** 앱 데이터 디렉터리 아래 색인 파일 이름. */
export const OPERATOR_ROOTS_INDEX_FILE = 'operators.json';

/**
 * unix 소켓 경로 상한(바이트). 커널 상한은 macOS 104·리눅스 108 이고 여유를 둔다. 넘으면 오퍼레이터가
 * `bind` 에서 조용히 죽는다 — 뿌리를 정할 때 먼저 잰다.
 */
export const SOCKET_PATH_LIMIT_BYTES = 100;

/** 해시 앞 몇 자를 뿌리 이름으로 쓰나(D1). 소켓 경로를 짧게 두려는 값이다. */
export const COMMUNITY_ROOT_HASH_LENGTH = 8;
/**
 * 8자 뿌리를 다른 커뮤니티가 이미 쓰고 있을 때(해시 앞 8자 충돌) 대신 쓰는 길이. 16자도 소켓 상한 안에 든다
 * (`~/.harkroom-agent/c/<16자>/operator/operator-v1.sock` ≈ 68바이트 + 홈 경로). 16자까지 겹치면 거절한다.
 */
export const COMMUNITY_ROOT_HASH_FALLBACK_LENGTH = 16;

export interface OperatorRootEntry {
  /** 그 커뮤니티 오퍼레이터의 뿌리(절대 경로). 그 아래 `operator/`·`agents/` 가 있다. */
  root: string;
  /** 서버가 준 이 기계의 오퍼레이터 id. 등록 전이면 없다. */
  operatorId?: string | null;
  /** 옛 단일 오퍼레이터 자리를 그대로 쓰는 커뮤니티인가(D5). 해시로 다시 계산하면 안 된다. */
  legacy?: boolean;
}

export interface OperatorRootsIndex {
  version: 1;
  /** 키는 `communityRootKey(baseUrl)`. */
  communities: Record<string, OperatorRootEntry>;
}

export const EMPTY_OPERATOR_ROOTS_INDEX: OperatorRootsIndex = { version: 1, communities: {} };

/** baseUrl 의 키 — 오퍼레이터 `config.ts::communityKey` 와 같은 규칙(끝 슬래시만 뗀다). */
export function communityRootKey(baseUrl: string): string {
  return baseUrl.replace(/\/+$/, '');
}

export function communityRootHash(baseUrl: string, length: number = COMMUNITY_ROOT_HASH_LENGTH): string {
  return createHash('sha256').update(communityRootKey(baseUrl)).digest('hex').slice(0, length);
}

/** 해시로 계산한 뿌리들이 모이는 자리 `<home>/.harkroom-agent/c`. CLI `run --all` 이 이 아래를 훑는다. */
export function communityRootsParent(home: string): string {
  return join(home, '.harkroom-agent', 'c');
}

/** 색인에 없을 때 쓰는 뿌리 — `<home>/.harkroom-agent/c/<해시 8자>`(충돌하면 16자). */
export function computedCommunityRoot(home: string, baseUrl: string, length: number = COMMUNITY_ROOT_HASH_LENGTH): string {
  return join(communityRootsParent(home), communityRootHash(baseUrl, length));
}

/** 뿌리 비교는 정규화한 경로로 한다 — `/x/a` 와 `/x/a/` 를 다른 뿌리로 치지 않는다(security P2a-n2). */
export function sameRoot(a: string, b: string): boolean {
  return resolve(a) === resolve(b);
}

/** 색인에서 같은 뿌리를 쓰는 칸이 둘 이상이면 그 뿌리 하나를 돌려준다(없으면 null). */
export function duplicateRoot(index: OperatorRootsIndex): string | null {
  const seen = new Set<string>();
  for (const e of Object.values(index.communities)) {
    const r = resolve(e.root);
    if (seen.has(r)) return r;
    seen.add(r);
  }
  return null;
}

/** 스위치(`HARKROOM_OPERATOR_PER_COMMUNITY`)는 정확히 `1` 일 때만 켜진다. */
export const PER_COMMUNITY_ENV = 'HARKROOM_OPERATOR_PER_COMMUNITY';
/** 커뮤니티마다 프로세스 모드에서 이 오퍼레이터(와 그 러너)의 뿌리. 띄우는 쪽이 준다. */
export const OPERATOR_ROOT_ENV = 'HARKROOM_OPERATOR_ROOT';
/** 커뮤니티마다 프로세스 모드에서 이 오퍼레이터가 맡은 커뮤니티의 baseUrl. 띄우는 쪽이 준다. */
export const OPERATOR_COMMUNITY_ENV = 'HARKROOM_OPERATOR_COMMUNITY';

export function perCommunityEnabled(env: NodeJS.ProcessEnv): boolean {
  return env[PER_COMMUNITY_ENV] === '1';
}

/**
 * 스위치가 켜져 있으면 이 프로세스의 커뮤니티 뿌리(절대 경로), 꺼져 있으면 null. 켜져 있는데 뿌리를 모르면
 * **던진다** — 기계에 하나인 자리로 물러서면 커뮤니티끼리 계정 선택이 섞인다.
 */
export function perCommunityRootFromEnv(env: NodeJS.ProcessEnv): string | null {
  if (!perCommunityEnabled(env)) return null;
  const root = env[OPERATOR_ROOT_ENV];
  if (!root || !root.startsWith('/')) throw new Error(`${PER_COMMUNITY_ENV}=1 인데 ${OPERATOR_ROOT_ENV} 가 절대 경로가 아니다`);
  return resolve(root);
}

/**
 * claude 계정 **선택**(`pools.json`)의 자리. 자격(계정 디렉터리)은 기계에 하나로 두고(D2), 어느 계정을 쓸지는
 * 커뮤니티마다 고른다 — 스위치가 켜지면 커뮤니티 뿌리 아래 `claude-pools.json`. 오퍼레이터와 러너가 같은 함수를 쓴다.
 */
export function claudePoolsFilePath(accountsRoot: string, env: NodeJS.ProcessEnv): string {
  const root = perCommunityRootFromEnv(env);
  return root ? join(root, 'claude-pools.json') : join(accountsRoot, 'pools.json');
}

/** codex 활성 계정 선택(`active.json`)의 자리 — `pools.json` 과 같은 규칙(P3-n3 결정). */
export function codexActiveFilePath(codexRoot: string, env: NodeJS.ProcessEnv): string {
  const root = perCommunityRootFromEnv(env);
  return root ? join(root, 'codex-active.json') : join(codexRoot, 'active.json');
}

export type CommunityRootResolution =
  | { ok: true; root: string; socketPath: string; fromIndex: boolean }
  /** 소켓 경로가 상한을 넘는다 — 이 뿌리로는 오퍼레이터가 뜨지 못한다. */
  | { ok: false; reason: 'socket_path_too_long'; root: string; socketPath: string; bytes: number }
  /** 계산한 뿌리(8자, 그리고 대신 쓰는 16자까지)를 색인의 **다른** 커뮤니티가 이미 쓴다. 두 커뮤니티를 한 뿌리에 섞지 않는다. */
  | { ok: false; reason: 'root_taken'; root: string; takenBy: string };

/**
 * baseUrl 의 뿌리를 정한다. 색인에 있으면 그것(옛 자리 포함), 없으면 해시로 계산한다. 어느 쪽이든 소켓 경로가
 * 상한 안인지 재고, 계산한 뿌리가 다른 커뮤니티의 것이면 거절한다.
 */
export function resolveCommunityRoot(home: string, baseUrl: string, index: OperatorRootsIndex): CommunityRootResolution {
  const key = communityRootKey(baseUrl);
  const entry = index.communities[key];
  const ownerOf = (r: string): string | undefined => Object.entries(index.communities).find(([k, e]) => k !== key && sameRoot(e.root, r))?.[0];
  let root = entry?.root ?? computedCommunityRoot(home, key);
  if (!entry && ownerOf(root)) {
    // 해시 앞 8자 충돌 — 16자 뿌리로 비킨다. 그것까지 겹치면 거절한다.
    const longer = computedCommunityRoot(home, key, COMMUNITY_ROOT_HASH_FALLBACK_LENGTH);
    const takenBy = ownerOf(longer);
    if (takenBy) return { ok: false, reason: 'root_taken', root: longer, takenBy };
    root = longer;
  }
  const { socketPath } = daemonEndpointPaths(root);
  const bytes = Buffer.byteLength(socketPath);
  if (bytes > SOCKET_PATH_LIMIT_BYTES) return { ok: false, reason: 'socket_path_too_long', root, socketPath, bytes };
  return { ok: true, root, socketPath, fromIndex: Boolean(entry) };
}
