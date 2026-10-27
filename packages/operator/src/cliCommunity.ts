/**
 * 앱 없는 머신에서 커뮤니티마다 오퍼레이터를 띄우는 CLI 의 절반(격리 C안 P5). `cli.ts` 의 `register`·`run` 이 쓴다.
 *
 * | 명령 | 뿌리 |
 * |---|---|
 * | `register <url> <code>` | 스위치가 켜져 있으면 url 로 뿌리를 정해 그 아래에 토큰·`operator.json` 을 둔다 |
 * | `run --community <url>` | 그 뿌리의 소켓으로 커뮤니티 하나만 든 오퍼레이터를 이 프로세스로 띄운다 |
 * | `run --all` | 이 기계의 커뮤니티마다 `run --community` 자식을 하나씩 띄우고, 죽으면 백오프 뒤 다시 띄운다 |
 *
 * 뿌리 규칙은 앱과 같다(`resolveCommunityRoot`): 색인 `operators.json` 에 칸이 있으면 그것(옛 자리 `legacy` 포함),
 * 없으면 해시로 계산한다. **CLI 는 색인을 쓰지 않는다** — 색인의 writer 는 앱 하나다. 앱이 없는 기계는 색인이 없어도
 * 해시로 같은 자리를 찾는다. 프로세스에 주는 env 는 앱의 `community_env`(Rust)와 같은 넷이다.
 */
import { readdir } from 'node:fs/promises';
import { join } from 'node:path';
import {
  OPERATOR_COMMUNITY_ENV,
  OPERATOR_ROOT_ENV,
  PER_COMMUNITY_ENV,
  communityRootKey,
  communityRootsParent,
  perCommunityEnabled,
  resolveCommunityRoot,
  sameRoot,
} from '@harkroom/shared/operatorRoots';
import { OPERATOR_LEGACY_ENV } from '@harkroom/shared/agentStateRoot';
import { readConfig } from './config.js';
import { readRootsIndex } from './communityRoots.js';

export interface CommunityRunTarget {
  /** `communityRootKey(baseUrl)`. */
  key: string;
  root: string;
  /** 옛 단일 오퍼레이터 자리(D5) — 색인 칸이 `legacy` 일 때만. */
  legacy: boolean;
}

/** 스위치가 꺼져 있으면 `--community`·`--all` 을 받지 않는다 — 앱과 CLI 가 다른 자리를 보게 되므로 조용히 물러서지 않는다. */
export function assertPerCommunitySwitch(env: NodeJS.ProcessEnv, what: string): void {
  if (!perCommunityEnabled(env)) {
    throw new Error(`${what} 는 커뮤니티마다 오퍼레이터 모드에서만 쓴다 — ${PER_COMMUNITY_ENV}=1 을 주고 다시 실행하라`);
  }
}

/** url 의 뿌리. 소켓 경로가 상한을 넘거나 뿌리를 다른 커뮤니티가 쓰면 사유와 함께 던진다. */
export async function communityRunTarget(appDataDir: string, home: string, baseUrl: string): Promise<CommunityRunTarget> {
  const key = communityRootKey(baseUrl);
  const index = await readRootsIndex(appDataDir);
  const r = resolveCommunityRoot(home, key, index);
  if (!r.ok) {
    if (r.reason === 'socket_path_too_long') {
      throw new Error(`소켓 경로가 너무 길다(${r.bytes}바이트): ${r.socketPath} — 홈 경로가 길면 뿌리를 둘 수 없다`);
    }
    throw new Error(`${key} 의 뿌리(${r.root})를 다른 커뮤니티(${r.takenBy})가 이미 쓴다`);
  }
  return { key, root: r.root, legacy: index.communities[key]?.legacy === true };
}

/** 그 커뮤니티 오퍼레이터에 줄 env. `undefined` 는 지운다(물려받은 값이 새지 않게) — 앱의 `community_env` 와 같다. */
export function communityProcessEnv(t: CommunityRunTarget): Record<string, string | undefined> {
  return {
    [PER_COMMUNITY_ENV]: '1',
    [OPERATOR_ROOT_ENV]: t.root,
    [OPERATOR_COMMUNITY_ENV]: t.key,
    [OPERATOR_LEGACY_ENV]: t.legacy ? '1' : undefined,
  };
}

export function applyCommunityEnv(env: NodeJS.ProcessEnv, t: CommunityRunTarget): void {
  for (const [name, value] of Object.entries(communityProcessEnv(t))) {
    if (value === undefined) delete env[name];
    else env[name] = value;
  }
}

/**
 * 이 기계의 커뮤니티들 — 색인의 칸과 `<home>/.harkroom-agent/c/*` 아래 `operator.json` 이 든 커뮤니티의 합집합이다.
 * 뿌리 자리에서 찾은 커뮤니티가 지금 규칙으로는 **다른 뿌리**로 풀리면(색인이 옛 자리를 가리킴 등) 띄우지 않고 `skipped` 에
 * 남긴다 — 한 커뮤니티를 두 뿌리에서 띄우지 않는다.
 */
export async function listCommunityTargets(
  appDataDir: string,
  home: string,
): Promise<{ targets: CommunityRunTarget[]; skipped: { root: string; reason: string }[] }> {
  const index = await readRootsIndex(appDataDir);
  const found = new Map<string, string | null>();
  for (const key of Object.keys(index.communities)) found.set(key, null);
  const skipped: { root: string; reason: string }[] = [];
  const base = communityRootsParent(home);
  let names: string[] = [];
  try { names = await readdir(base); } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e;
  }
  for (const name of names.sort()) {
    const root = join(base, name);
    let keys: string[];
    try { keys = Object.keys((await readConfig(join(root, 'operator', 'operator.json'))).communities); } catch (e) {
      skipped.push({ root, reason: `operator.json 을 읽지 못했다: ${(e as Error).message}` });
      continue;
    }
    if (keys.length === 0) continue;
    if (keys.length > 1) { skipped.push({ root, reason: `커뮤니티가 둘 이상이다: ${keys.join(', ')}` }); continue; }
    const key = communityRootKey(keys[0]!);
    if (!found.has(key)) found.set(key, root);
  }
  const targets: CommunityRunTarget[] = [];
  for (const [key, scannedRoot] of found) {
    let t: CommunityRunTarget;
    try { t = await communityRunTarget(appDataDir, home, key); } catch (e) {
      skipped.push({ root: scannedRoot ?? key, reason: (e as Error).message });
      continue;
    }
    if (scannedRoot !== null && !sameRoot(scannedRoot, t.root)) {
      skipped.push({ root: scannedRoot, reason: `${key} 의 뿌리는 ${t.root} 다 — 이 자리는 띄우지 않는다` });
      continue;
    }
    targets.push(t);
  }
  targets.sort((a, b) => a.key.localeCompare(b.key));
  return { targets, skipped };
}

/** `run --all` 이 띄운 자식 하나. 시험에서 바꿔 끼울 수 있게 필요한 것만 받는다. */
export interface SupervisedChild {
  readonly pid?: number | undefined;
  once(event: 'exit', listener: (code: number | null, signal: NodeJS.Signals | null) => void): unknown;
  kill(signal?: NodeJS.Signals): boolean;
}

export interface SuperviseOptions {
  spawn: (t: CommunityRunTarget) => SupervisedChild;
  log?: (line: string) => void;
  now?: () => number;
  setTimer?: (fn: () => void, ms: number) => unknown;
  clearTimer?: (handle: unknown) => void;
}

/** 다시 띄우기 전 기다림 — 1초에서 두 배씩 30초까지. 1분 넘게 살았던 자식은 처음부터 센다. */
export const RESTART_BASE_MS = 1_000;
export const RESTART_MAX_MS = 30_000;
export const RESTART_RESET_AFTER_MS = 60_000;

/**
 * 커뮤니티마다 자식 하나를 띄우고 죽으면 백오프 뒤 다시 띄운다. `stop(signal)` 은 자식 모두에 신호를 보내고 다 끝나면
 * 풀린다 — systemd 의 `KillMode=process` 는 이 프로세스에만 신호를 주므로 자식에게는 여기서 넘긴다(러너는 detached 라
 * 데려가지 않는다).
 */
export function superviseCommunities(targets: readonly CommunityRunTarget[], opts: SuperviseOptions): {
  stop: (signal?: NodeJS.Signals) => Promise<void>;
} {
  const log = opts.log ?? ((line: string) => console.log(line));
  const now = opts.now ?? Date.now;
  const setTimer = opts.setTimer ?? ((fn: () => void, ms: number) => setTimeout(fn, ms));
  const clearTimer = opts.clearTimer ?? ((h: unknown) => clearTimeout(h as NodeJS.Timeout));
  let stopping = false;
  const live = new Map<string, SupervisedChild>();
  const timers = new Map<string, unknown>();
  const failures = new Map<string, number>();
  let onAllExited: (() => void) | null = null;

  const start = (t: CommunityRunTarget): void => {
    if (stopping) return;
    const startedAt = now();
    const child = opts.spawn(t);
    live.set(t.key, child);
    log(`커뮤니티 오퍼레이터 기동: ${t.key} (${t.root}) pid=${child.pid ?? '?'}`);
    child.once('exit', (code, signal) => {
      live.delete(t.key);
      if (stopping) {
        if (live.size === 0) onAllExited?.();
        return;
      }
      const n = now() - startedAt >= RESTART_RESET_AFTER_MS ? 0 : (failures.get(t.key) ?? 0);
      failures.set(t.key, n + 1);
      const delay = Math.min(RESTART_MAX_MS, RESTART_BASE_MS * 2 ** n);
      log(`커뮤니티 오퍼레이터 종료: ${t.key} (code=${code} signal=${signal}) — ${delay}ms 뒤 다시 띄운다`);
      timers.set(t.key, setTimer(() => { timers.delete(t.key); start(t); }, delay));
    });
  };
  for (const t of targets) start(t);

  return {
    stop: (signal = 'SIGTERM') => {
      stopping = true;
      for (const h of timers.values()) clearTimer(h);
      timers.clear();
      if (live.size === 0) return Promise.resolve();
      const done = new Promise<void>((resolve) => { onAllExited = resolve; });
      for (const child of live.values()) child.kill(signal);
      return done;
    },
  };
}
