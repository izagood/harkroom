import { createReadStream, createWriteStream } from 'node:fs';
import { mkdir, rm, stat } from 'node:fs/promises';
import { dirname, join, resolve, sep } from 'node:path';
import { pipeline } from 'node:stream/promises';
import { randomUUID } from 'node:crypto';
import type { Readable, Writable } from 'node:stream';

/** 제한을 넘었다. 라우트가 413 으로 바꿔 응답한다. */
export class StorageLimitError extends Error {
  constructor(public readonly maxBytes: number) {
    super(`file exceeds ${maxBytes} bytes`);
    this.name = 'StorageLimitError';
  }
}

/** 파일이 스토어에 없음. 라우트가 404 로 바꿔 응답한다. */
export class AttachmentMissingError extends Error {
  constructor(public readonly key: string, public readonly path: string) {
    super(`attachment not found: ${key} at ${path}`);
    this.name = 'AttachmentMissingError';
  }
}

export interface StorageBackend {
  /** 스트림을 저장하고 키와 실제 바이트 수를 돌려준다. */
  write(source: Readable): Promise<{ key: string; bytes: number }>;
  read(key: string): Promise<Readable>;
  /** 없는 것을 지우는 것도 성공이다 — GC 가 이미 지워진 것을 또 지우려 할 수 있다. */
  remove(key: string): Promise<void>;
}

/**
 * 키를 실제 경로로 바꾼다. **키가 루트를 벗어나면 거절한다** — 키가 경로로 해석되면
 * 스토리지 밖의 파일을 읽는 통로가 된다. 서버가 만든 키만 들어오는 것이 정상이지만,
 * 그 가정이 언젠가 깨질 때 마지막으로 서는 것이 이 검사다.
 */
function pathFor(root: string, key: string): string {
  const full = resolve(root, key);
  const base = resolve(root);
  if (full !== base && !full.startsWith(base + sep)) {
    throw new Error(`storage key escapes the root: ${key}`);
  }
  return full;
}

/**
 * 스트림이 완전히 닫힐 때까지 기다린다. **'error' 로는 reject 하지 않는다** — 이 함수를
 * 부르는 곳은 이미 원래 오류를 손에 들고 있고, 정리 도중의 두 번째 오류로 그것을
 * 덮어써서는 안 된다. 기다리는 것은 fd 가 닫혔다는 사실 하나다.
 */
function closedFor(stream: Writable): Promise<void> {
  if (stream.closed) return Promise.resolve();
  stream.destroy();
  if (stream.closed) return Promise.resolve();
  return new Promise((done) => stream.once('close', () => done()));
}

/**
 * 로컬 볼륨 스토리지. S3 호환으로 바꿀 때는 이 파일만 갈아 끼운다 —
 * 나머지 코드는 `StorageBackend` 만 본다.
 */
export function createLocalStorage(opts: { root: string; maxBytes: number }): StorageBackend {
  const { root, maxBytes } = opts;

  return {
    async write(source) {
      // 사용자 파일명은 키에 넣지 않는다. 서버가 만드는 uuid 라서 경로 순회가 불가능하고,
      // 앞 두 글자로 디렉터리를 나눠 한 디렉터리에 파일이 수만 개 쌓이지 않게 한다.
      const id = randomUUID();
      const key = `${id.slice(0, 2)}/${id}`;
      const dest = pathFor(root, key);
      await mkdir(dirname(dest), { recursive: true });

      let bytes = 0;
      // 다 받아 놓고 거절하면 제한이 제한이 아니다 — 흐르는 중에 끊는다.
      async function* limited() {
        for await (const chunk of source) {
          bytes += (chunk as Buffer).length;
          if (bytes > maxBytes) throw new StorageLimitError(maxBytes);
          yield chunk as Buffer;
        }
      }

      const out = createWriteStream(dest);
      try {
        await pipeline(limited(), out);
      } catch (err) {
        // 거절하면서 반쯤 쓴 파일을 남기면 디스크가 조용히 찬다.
        //
        // 지우기 전에 destination 이 닫히기를 기다린다: pipeline 은 소스가 던지는 순간
        // reject 하고, 그때 dest 의 open 은 아직 진행 중일 수 있다. 그대로 rm 하면
        // 뒤늦게 끝난 open('w') 이 방금 지운 파일을 0 바이트로 되살리고, 그 파일은
        // 아무도 지우지 않는다 — 용량을 초과한 업로드가 디스크에 쓰레기를 남긴다(#370).
        await closedFor(out);
        await rm(dest, { force: true });
        throw err;
      }
      return { key, bytes };
    },

    async read(key) {
      const src = pathFor(root, key);
      try {
        await stat(src);
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
          throw new AttachmentMissingError(key, src);
        }
        throw err;
      }
      return createReadStream(src);
    },

    async remove(key) {
      await rm(pathFor(root, key), { force: true });
    },
  };
}
