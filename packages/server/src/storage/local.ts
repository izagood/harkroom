import { createReadStream, createWriteStream } from 'node:fs';
import { mkdir, rm, stat } from 'node:fs/promises';
import { dirname, join, resolve, sep } from 'node:path';
import { pipeline } from 'node:stream/promises';
import { randomUUID } from 'node:crypto';
import type { Readable } from 'node:stream';

/** 제한을 넘었다. 라우트가 413 으로 바꿔 응답한다. */
export class StorageLimitError extends Error {
  constructor(public readonly maxBytes: number) {
    super(`file exceeds ${maxBytes} bytes`);
    this.name = 'StorageLimitError';
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

      try {
        await pipeline(limited(), createWriteStream(dest));
      } catch (err) {
        // 거절하면서 반쯤 쓴 파일을 남기면 디스크가 조용히 찬다.
        await rm(dest, { force: true });
        throw err;
      }
      return { key, bytes };
    },

    async read(key) {
      const src = pathFor(root, key);
      // 없는 키에 빈 스트림을 돌려주면 호출부가 '내용이 빈 파일'과 구분할 수 없다.
      await stat(src);
      return createReadStream(src);
    },

    async remove(key) {
      await rm(pathFor(root, key), { force: true });
    },
  };
}
