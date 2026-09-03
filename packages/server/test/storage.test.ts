import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, rm, readdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import { createLocalStorage, StorageLimitError, AttachmentMissingError } from '../src/storage/local.js';

let root: string;
let storage: ReturnType<typeof createLocalStorage>;

const stream = (chunks: string[]) => Readable.from(chunks.map((c) => Buffer.from(c)));

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'murmur-storage-'));
  storage = createLocalStorage({ root, maxBytes: 1024 });
});
afterEach(async () => { await rm(root, { recursive: true, force: true }); });

const collect = async (key: string) => {
  const chunks: Buffer[] = [];
  for await (const c of await storage.read(key)) chunks.push(c as Buffer);
  return Buffer.concat(chunks).toString();
};

describe('writing a file', () => {
  it('reads back exactly what was written', async () => {
    const { key, bytes } = await storage.write(stream(['hello ', 'world']));

    expect(bytes).toBe(11);
    expect(await collect(key)).toBe('hello world');
  });

  // 키를 서버가 만드는 이유: 사용자 파일명이 경로가 되는 자리를 없앤다.
  it('gives every write its own key', async () => {
    const a = await storage.write(stream(['a']));
    const b = await storage.write(stream(['b']));

    expect(a.key).not.toBe(b.key);
  });

  it('makes keys that cannot escape the root', async () => {
    const { key } = await storage.write(stream(['x']));

    expect(key).toMatch(/^[a-z0-9/-]+$/);
    expect(key).not.toContain('..');
  });
});

describe('the size limit', () => {
  // 끝까지 받아 놓고 거절하면 제한이 제한이 아니다 — 디스크는 이미 찼다.
  it('refuses a stream that grows past the limit', async () => {
    const tooBig = stream([...Array(20)].map(() => 'x'.repeat(100)));

    await expect(storage.write(tooBig)).rejects.toThrow(StorageLimitError);
  });

  it('leaves nothing behind when it refuses', async () => {
    const tooBig = stream([...Array(20)].map(() => 'x'.repeat(100)));

    await storage.write(tooBig).catch(() => {});

    const files = await readdir(root, { recursive: true, withFileTypes: true });
    expect(files.filter((f) => f.isFile())).toHaveLength(0);
  });

  it('accepts a stream exactly at the limit', async () => {
    const exact = stream(['x'.repeat(1024)]);

    const { bytes } = await storage.write(exact);

    expect(bytes).toBe(1024);
  });
});

describe('reading a key that is not there', () => {
  it('throws AttachmentMissingError with key and path', async () => {
    const key = 'no/such/key';
    try {
      await storage.read(key);
      expect.fail('should have thrown');
    } catch (err) {
      expect(err).toBeInstanceOf(AttachmentMissingError);
      const e = err as AttachmentMissingError;
      expect(e.key).toBe(key);
      expect(e.path).toContain(root);
    }
  });

  // 키가 경로로 해석되면 스토리지 밖의 파일을 읽는 통로가 된다.
  it('refuses a key that tries to climb out of the root', async () => {
    await writeFile(join(root, '..', 'murmur-secret.txt'), 'secret');

    await expect(storage.read('../murmur-secret.txt')).rejects.toThrow();

    await rm(join(root, '..', 'murmur-secret.txt'), { force: true });
  });

  it('refuses an absolute key', async () => {
    await expect(storage.read('/etc/hosts')).rejects.toThrow();
  });
});

describe('removing a file', () => {
  it('makes it unreadable', async () => {
    const { key } = await storage.write(stream(['bye']));

    await storage.remove(key);

    await expect(storage.read(key)).rejects.toThrow();
  });

  // GC 가 이미 지워진 것을 또 지우려 할 수 있다 — 그때 터지면 GC 가 멈춘다.
  it('is fine removing something that is already gone', async () => {
    await expect(storage.remove('gone/already')).resolves.toBeUndefined();
  });
});
