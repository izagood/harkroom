// murmur 가 직접 띄우는 avcs 서버(`repo.mode = 'hosted'`). 이 시험이 지키는 것은 **수명**이다:
// 하나만 뜨고, 안 쓰면 안 뜨고, 닫은 뒤에는 다시 안 뜬다.
import { describe, it, expect } from 'vitest';
import { startAvcsServer } from '@izagood/avcs-server';
import { AvcsHost } from '../src/avcs/host.js';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

async function dataDir(): Promise<string> {
  return mkdtemp(join(tmpdir(), 'murmur-host-'));
}

describe('AvcsHost', () => {
  it('부르지 않으면 뜨지 않는다 — 쓰지도 않는 상태를 백업 대상에 올리지 않는다', async () => {
    const host = new AvcsHost({ dataDir: await dataDir() });
    expect(host.url()).toBeNull();
    await host.stop();
  });

  it('동시에 불러도 서버는 하나다', async () => {
    const dir = await dataDir();
    let started = 0;
    const host = new AvcsHost({
      dataDir: dir,
      start: async (opts) => {
        started += 1;
        return startAvcsServer(opts);
      },
    });
    try {
      const urls = await Promise.all([host.ensure(), host.ensure(), host.ensure()]);

      expect(started).toBe(1);
      expect(new Set(urls).size).toBe(1);
      expect(urls[0]).toBe(host.url());
    } finally {
      await host.stop();
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('닫은 뒤에 온 ensure 는 새 서버를 세우지 않는다 — 아무도 정지시키지 않을 서버가 남는다', async () => {
    const host = new AvcsHost({ dataDir: await dataDir() });
    await host.ensure();
    await host.stop();

    expect(await host.ensure()).toBeNull();
    expect(host.url()).toBeNull();
  });

  it('기동에 실패하면 null 을 주고 사유를 들고 있는다 — 던지면 목록 전체가 사라진다', async () => {
    const host = new AvcsHost({
      dataDir: '/dev/null/nope',
      start: () => Promise.reject(new Error('EACCES: data root')),
    });

    expect(await host.ensure()).toBeNull();
    expect((host.startError() as Error).message).toContain('EACCES');
    await host.stop();
  });
});
