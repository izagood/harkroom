/**
 * 같은 기계의 여러 오퍼레이터 프로세스가 **한 파일**을 고칠 때 쓰는 배타 잠금(격리 C안 P3).
 *
 * 커뮤니티마다 프로세스를 두면(C안) 기계에 하나로 남는 파일(claude 계정의 `usage.json`, D2)에 writer 가
 * 여럿이 된다. 지금처럼 「메모리의 값으로 파일 전체를 바꿔 끼우기」만 하면 마지막 writer 가 남의 값을 지운다.
 * 그래서 잠금 안에서 **읽고 → 합치고 → 쓴다.**
 *
 * 방식은 `open(<파일>.lock, 'wx')`(O_EXCL) 하나다 — 외부 의존 없이 macOS·리눅스에서 원자적이다. 잠금 파일에
 * pid·시각을 적고, 주인이 죽었거나(`kill(pid, 0)` ESRCH) `staleMs` 를 넘긴 잠금은 치우고 다시 잡는다. 기다리다
 * `timeoutMs` 를 넘기면 던진다 — 호출자는 이번 쓰기를 건너뛰고 다음 주기에 다시 한다.
 */
import { open, readFile, rm } from 'node:fs/promises';

export interface FileLockOptions {
  /** 이보다 오래된 잠금은 주인이 살아 있어도 버려진 것으로 본다. */
  staleMs?: number;
  /** 잠금을 이만큼 기다려도 못 잡으면 던진다. */
  timeoutMs?: number;
  /** 재시도 간격. */
  retryMs?: number;
  now?: () => number;
  /** pid 가 살아 있는가. 테스트가 바꿔 끼운다. */
  isAlive?: (pid: number) => boolean;
}

export const FILE_LOCK_STALE_MS = 30_000;
export const FILE_LOCK_TIMEOUT_MS = 5_000;

function processAlive(pid: number): boolean {
  try { process.kill(pid, 0); return true; } catch (e) { return (e as NodeJS.ErrnoException).code === 'EPERM'; }
}

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

async function isStale(lockPath: string, now: number, staleMs: number, isAlive: (pid: number) => boolean): Promise<boolean> {
  let text: string;
  try { text = await readFile(lockPath, 'utf8'); } catch { return false; }
  const [pidText, atText] = text.trim().split(' ');
  const pid = Number(pidText);
  const at = Number(atText);
  // 쓰다 만 잠금(내용이 비었거나 깨짐)은 주인을 모른다 — 시각으로만 판단할 수 없으니 오래됐을 때만 치운다.
  if (!Number.isInteger(pid) || pid <= 0 || !Number.isFinite(at)) return false;
  return !isAlive(pid) || now - at > staleMs;
}

/** `lockPath` 를 잡고 `fn` 을 돌린 뒤 놓는다. `fn` 이 던져도 놓는다. */
export async function withFileLock<T>(lockPath: string, fn: () => Promise<T>, opts: FileLockOptions = {}): Promise<T> {
  const now = opts.now ?? Date.now;
  const staleMs = opts.staleMs ?? FILE_LOCK_STALE_MS;
  const timeoutMs = opts.timeoutMs ?? FILE_LOCK_TIMEOUT_MS;
  const retryMs = opts.retryMs ?? 50;
  const isAlive = opts.isAlive ?? processAlive;
  const deadline = now() + timeoutMs;
  for (;;) {
    try {
      const handle = await open(lockPath, 'wx', 0o600);
      try { await handle.writeFile(`${process.pid} ${now()}\n`); } finally { await handle.close(); }
      break;
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== 'EEXIST') throw e;
      if (await isStale(lockPath, now(), staleMs, isAlive)) { await rm(lockPath, { force: true }); continue; }
      if (now() >= deadline) throw new Error(`잠금을 못 잡았다(${timeoutMs}ms): ${lockPath}`);
      await sleep(retryMs);
    }
  }
  try {
    return await fn();
  } finally {
    await rm(lockPath, { force: true });
  }
}
