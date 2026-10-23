/**
 * 오퍼레이터 로그(`<appDataDir>/operator/operator-v1.log`)의 크기 상한과 회전(2026-10-22).
 *
 * 이 파일은 오퍼레이터가 여는 것이 아니다 — 앱이 오퍼레이터를 띄울 때 stdout·stderr 를 이 파일에
 * **이어 쓰기(append)로** 붙인다(desktop `daemon_client.rs`). 그래서 러너 로그처럼 `rename` 으로
 * 밀면 안 된다: 오퍼레이터의 fd 는 밀린 파일을 계속 가리켜 새 파일이 영영 안 생긴다. 대신
 * **꼬리를 `.1` 로 베끼고 같은 파일을 0 으로 자른다**(copy-truncate). 이어 쓰기 fd 라 자른 뒤의
 * 쓰기는 0 바이트 자리부터 다시 붙는다.
 *
 * - 상한 `OPERATOR_LOG_MAX_BYTES`(50MB), 보관은 `.1` 하나 — `.1` 에도 꼬리 50MB 만 베낀다.
 *   그래서 디스크에는 많아야 100MB 남짓이다. 러너 로그(`runnerLog.ts`, 8MB·`.1`)와 같은 꼴이다.
 * - 매 줄 크기를 재지 않는다 — 쓴 바이트가 `checkEveryBytes` 를 넘을 때마다, 그리고 기동 때 한 번 잰다.
 * - **fd 1 이 그 파일일 때만** 돈다(같은 dev·ino). 원격 호스트처럼 stdout 이 journal·파이프면 아무것도 안 한다.
 * - **무엇이 실패해도 던지지 않는다.** 디스크가 가득 차(ENOSPC) 베끼지 못하면 베끼지 않고 자른다 —
 *   로그를 지키려다 오퍼레이터가 디스크를 못 써 장부를 잃는 쪽(그것이 고아 러너를 낳았다)이 더 나쁘다.
 *   쓰기 실패는 삼키고 stderr 에 1분에 한 줄만 알린다. 다음 쓰기에서 다시 해 본다.
 */
import {
  closeSync, fstatSync, ftruncateSync, openSync, readSync, renameSync, statSync, unlinkSync, writeSync,
} from 'node:fs';

export const OPERATOR_LOG_MAX_BYTES = 50 * 1024 * 1024;
/** 이만큼 쓸 때마다 크기를 잰다. 줄마다 fstat 하지 않으려는 것이다. */
export const OPERATOR_LOG_CHECK_BYTES = 256 * 1024;
const COPY_CHUNK_BYTES = 1024 * 1024;
const WARN_EVERY_MS = 60_000;

/** 앱이 정하는 이름 규칙(`operator-v1.sock` 옆의 `operator-v1.log`)을 소켓 경로에서 되짚는다. */
export function operatorLogPathFromSocket(socketPath: string): string | null {
  return /\.sock$/.test(socketPath) ? socketPath.replace(/\.sock$/, '.log') : null;
}

/** 회귀선이 바꿔 끼우는 파일 연산. 기본은 node:fs 동기 호출이다. */
export interface OperatorLogFs {
  fstat(fd: number): { size: number; dev: number; ino: number; isFile(): boolean };
  stat(path: string): { size: number; dev: number; ino: number };
  /** `src` 의 끝 `bytes` 를 `dst` 로 베낀다(덮어쓴다). */
  copyTail(src: string, dst: string, bytes: number): void;
  ftruncate(fd: number, len: number): void;
}

/**
 * 임시 파일은 O_EXCL(`'wx'`)로만 연다 — 앞 실행이 남긴 같은 이름이 심링크여도 따라가 쓰지 않는다(security #1459 n1).
 * 이미 있으면(EEXIST) 지우고 한 번 더 연다. 지우는 것은 그 이름이지 링크가 가리키는 곳이 아니다.
 */
export function openExclusive(path: string): number {
  try {
    return openSync(path, 'wx', 0o600);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'EEXIST') throw err;
    unlinkSync(path);
    return openSync(path, 'wx', 0o600);
  }
}

export const nodeOperatorLogFs: OperatorLogFs = {
  fstat: (fd) => fstatSync(fd),
  stat: (path) => statSync(path),
  copyTail(src, dst, bytes) {
    const tmp = `${dst}.tmp-${process.pid}`;
    const from = openSync(src, 'r');
    try {
      const size = fstatSync(from).size;
      let pos = Math.max(0, size - bytes);
      const to = openExclusive(tmp);
      try {
        const buf = Buffer.allocUnsafe(COPY_CHUNK_BYTES);
        while (pos < size) {
          const n = readSync(from, buf, 0, Math.min(COPY_CHUNK_BYTES, size - pos), pos);
          if (n <= 0) break;
          writeSync(to, buf, 0, n);
          pos += n;
        }
      } finally {
        closeSync(to);
      }
    } finally {
      closeSync(from);
    }
    renameSync(tmp, dst);
  },
  ftruncate: (fd, len) => ftruncateSync(fd, len),
};

export interface OperatorLogOptions {
  /** 로그 파일 경로. `null` 이면 회전하지 않는다(쓰기만 지킨다). */
  path: string | null;
  /** 그 파일에 붙은 fd. 기본 1(stdout). */
  fd?: number;
  maxBytes?: number;
  checkEveryBytes?: number;
  /** 한 줄 쓰기. 기본 `console.log`. */
  write?: (line: string) => void;
  /** 알림 한 줄(회전 실패 등). 기본 stderr. */
  warn?: (line: string) => void;
  fs?: OperatorLogFs;
  now?: () => number;
}

export interface OperatorLog {
  log(line: string): void;
  /** 지금 크기를 재서 넘었으면 민다. 던지지 않는다. */
  rotateIfLarge(): void;
}

export function createOperatorLog(opts: OperatorLogOptions): OperatorLog {
  const fd = opts.fd ?? 1;
  const maxBytes = opts.maxBytes ?? OPERATOR_LOG_MAX_BYTES;
  const checkEvery = opts.checkEveryBytes ?? OPERATOR_LOG_CHECK_BYTES;
  const write = opts.write ?? ((line: string) => console.log(line));
  const fs = opts.fs ?? nodeOperatorLogFs;
  const now = opts.now ?? Date.now;
  const warnRaw = opts.warn ?? ((line: string) => { process.stderr.write(`${line}\n`); });
  const lastWarn = new Map<string, number>();
  /** 같은 종류의 알림은 1분에 한 줄 — 가득 찬 디스크에 알림까지 쏟지 않는다. */
  const warn = (kind: string, line: string): void => {
    const t = now();
    const prev = lastWarn.get(kind);
    if (prev !== undefined && t - prev < WARN_EVERY_MS) return;
    lastWarn.set(kind, t);
    try { warnRaw(line); } catch { /* 알림도 못 쓰면 그대로 둔다 */ }
  };
  const code = (err: unknown): string => (err as NodeJS.ErrnoException | null)?.code ?? 'unknown';
  let sinceCheck = 0;

  const rotateIfLarge = (): void => {
    if (opts.path === null) return;
    const path = opts.path;
    try {
      const cur = fs.fstat(fd);
      if (!cur.isFile() || cur.size <= maxBytes) return;
      const onDisk = fs.stat(path);
      // stdout 이 그 파일이 아니면(원격 호스트·손으로 띄움) 남의 파일을 자르지 않는다.
      if (onDisk.dev !== cur.dev || onDisk.ino !== cur.ino) return;
      let copied = true;
      try {
        fs.copyTail(path, `${path}.1`, maxBytes);
      } catch (err) {
        copied = false;
        warn('copy', `오퍼레이터 로그를 .1 로 베끼지 못해(${code(err)}) 베끼지 않고 비운다`);
      }
      fs.ftruncate(fd, 0);
      try {
        write(`오퍼레이터 로그가 ${cur.size}바이트로 상한 ${maxBytes}바이트를 넘어 ${copied ? '꼬리를 .1 로 밀고 비웠다' : '비웠다(.1 사본 없음)'}`);
      } catch { /* 아래 log 와 같은 이유로 삼킨다 */ }
    } catch (err) {
      warn('rotate', `오퍼레이터 로그 회전 실패(${code(err)}) — 다음에 다시 한다`);
    }
  };

  return {
    rotateIfLarge,
    log(line) {
      try {
        write(line);
      } catch (err) {
        warn('write', `오퍼레이터 로그 쓰기 실패(${code(err)}) — 다음 줄에서 다시 쓴다`);
      }
      sinceCheck += Buffer.byteLength(line) + 1;
      if (sinceCheck >= checkEvery) {
        sinceCheck = 0;
        rotateIfLarge();
      }
    },
  };
}
