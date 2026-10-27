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
import { randomUUID } from 'node:crypto';
import { link, open, readFile, rename, rm, stat } from 'node:fs/promises';

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

/**
 * 버려진 잠금이면 그 **내용**을 돌려준다(치울 때 같은 잠금인지 대조한다). 아니면 null.
 *
 * 쓰다 만 잠금(`open` 과 `writeFile` 사이에 죽어 비었거나 깨짐)은 주인을 모른다 — 파일 mtime 이 `staleMs` 를
 * 넘었을 때만 버려진 것으로 본다. 그러지 않으면 그 잠금이 영영 남아 그 파일은 다시 쓰이지 않는다(security P3-n2).
 */
async function staleContent(lockPath: string, now: number, staleMs: number, isAlive: (pid: number) => boolean): Promise<string | null> {
  let text: string;
  let mtimeMs: number;
  try {
    [text, { mtimeMs }] = await Promise.all([readFile(lockPath, 'utf8'), stat(lockPath)]);
  } catch {
    return null;
  }
  const [pidText, atText] = text.trim().split(' ');
  const pid = Number(pidText);
  const at = Number(atText);
  if (!Number.isInteger(pid) || pid <= 0 || !Number.isFinite(at)) return now - mtimeMs > staleMs ? text : null;
  return !isAlive(pid) || now - at > staleMs ? text : null;
}

/**
 * 잠금 파일이 **아직 `expected` 그대로일 때만** 지운다(security P3-n1). 읽고 지우는 사이에 남이 치우고 새로 잡았으면
 * 그 새 잠금을 지우면 안 된다 — 그래서 먼저 옆 이름으로 rename 해 떼어 낸 뒤 내용을 대조한다. 다르면(남의 새 잠금을
 * 떼어 냈으면) `link` 로 제자리에 되돌린다. 그 사이 또 다른 잠금이 섰으면(EEXIST) 되돌리지 못한다 — 떼어 낸 쪽 주인은
 * 놓을 때 자기 내용이 없음을 보고 아무것도 지우지 않는다. 지웠으면 true.
 */
export async function removeIfSame(lockPath: string, expected: string): Promise<boolean> {
  const aside = `${lockPath}.${process.pid}.${randomUUID()}.reap`;
  try { await rename(lockPath, aside); } catch { return false; }
  let text = '';
  try { text = await readFile(aside, 'utf8'); } catch { /* 떼어 낸 파일을 못 읽음 — 다른 것으로 친다 */ }
  if (text === expected) { await rm(aside, { force: true }); return true; }
  try { await link(aside, lockPath); } catch { /* 그 사이 새 잠금이 섰다 */ }
  await rm(aside, { force: true });
  return false;
}

/** `lockPath` 를 잡고 `fn` 을 돌린 뒤 놓는다. `fn` 이 던져도 놓는다. */
export async function withFileLock<T>(lockPath: string, fn: () => Promise<T>, opts: FileLockOptions = {}): Promise<T> {
  const now = opts.now ?? Date.now;
  const staleMs = opts.staleMs ?? FILE_LOCK_STALE_MS;
  const timeoutMs = opts.timeoutMs ?? FILE_LOCK_TIMEOUT_MS;
  const retryMs = opts.retryMs ?? 50;
  const isAlive = opts.isAlive ?? processAlive;
  const deadline = now() + timeoutMs;
  // 내 잠금의 내용. 같은 pid 의 두 호출도 갈리게 무작위 값을 붙인다 — 놓을 때 이 값으로 내 것인지 본다.
  let mine = '';
  for (;;) {
    try {
      const handle = await open(lockPath, 'wx', 0o600);
      mine = `${process.pid} ${now()} ${randomUUID()}\n`;
      try { await handle.writeFile(mine); } finally { await handle.close(); }
      break;
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== 'EEXIST') throw e;
      const stale = await staleContent(lockPath, now(), staleMs, isAlive);
      if (stale !== null) { await removeIfSame(lockPath, stale); continue; }
      if (now() >= deadline) throw new Error(`잠금을 못 잡았다(${timeoutMs}ms): ${lockPath}`);
      await sleep(retryMs);
    }
  }
  try {
    return await fn();
  } finally {
    // 내 것일 때만 놓는다 — 시한을 넘겨 남이 치우고 새로 잡았으면 그 잠금은 그대로 둔다.
    await removeIfSame(lockPath, mine);
  }
}
