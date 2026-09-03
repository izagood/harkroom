import { describe, it, expect, beforeAll, afterAll, afterEach } from 'vitest';
import { Writable } from 'node:stream';
import { isAbsolute, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import type { Pool } from 'pg';
import { startTestDb } from './helpers/testDb.js';
import { buildServer } from '../src/buildServer.js';

/**
 * #257 회귀선(저장 루트). 첨부가 열리지 않은 원인의 절반이다.
 *
 * 기본 루트가 `'./.attachments'` 였다 — **어디서 기동했느냐**에 따라 다른 곳을 가리키는
 * 상대경로다. 그래서 업로드는 성공하는데 다른 디렉터리에서 기동한 서버가 그 첨부를 못
 * 찾았다. 여기서 확인하는 것은 "cwd 를 바꿔도 같은 곳"이다 — 절대경로인지만 보면
 * `resolve('./.attachments')` 도 절대경로라서 통과한다(그것이 정확히 결함이었다).
 */

let pool: Pool;
let stop: () => Promise<void>;
const originalCwd = process.cwd();
const originalEnvRoot = process.env.ATTACHMENT_ROOT;

/** 로그 라인을 모으는 싱크(`logging.test.ts` 와 같은 방식). */
function capture(): { stream: Writable; text(): string } {
  const lines: string[] = [];
  const stream = new Writable({
    write(chunk, _enc, cb) { lines.push(String(chunk)); cb(); },
  });
  return { stream, text: () => lines.join('') };
}

/**
 * 서버를 세워 **실제로 쓰는 저장 루트**를 로그에서 읽어 온다.
 *
 * 루트를 반환하는 API 는 없다. 그래서 로그를 읽는데, 그 자체가 요구사항이다 — 이 사고는
 * 로그만으로 알아낼 수 있어야 한다(요구 테스트 4). 즉 이 헬퍼가 동작하는 것이 그 회귀선이다.
 */
async function rootOf(): Promise<{ root: string; log: string }> {
  const log = capture();
  const app = await buildServer({ pool, logStream: log.stream, logLevel: 'info' });
  await app.close();
  const text = log.text();
  const found = /attachment storage root: ([^"\\]+)/.exec(text);
  expect(found, `기동 로그에 저장 루트가 없다: ${text}`).toBeTruthy();
  return { root: found![1]!, log: text };
}

beforeAll(async () => {
  const db = await startTestDb();
  pool = db.pool;
  stop = db.stop;
});
afterEach(() => {
  process.chdir(originalCwd);
  if (originalEnvRoot === undefined) delete process.env.ATTACHMENT_ROOT;
  else process.env.ATTACHMENT_ROOT = originalEnvRoot;
});
afterAll(async () => { await stop(); });

describe('#257 첨부 저장 루트', () => {
  it('1. ATTACHMENT_ROOT 가 없으면 루트는 절대경로이고 cwd 를 바꿔도 같다', async () => {
    delete process.env.ATTACHMENT_ROOT;

    const here = await rootOf();
    expect(isAbsolute(here.root)).toBe(true);

    // **cwd 를 실제로 바꾼다.** 이것 없이는 절대경로 단언만 남고, 그것은 결함이 있는
    // `resolve('./.attachments')` 도 통과시킨다.
    const elsewhere = await mkdtemp(join(tmpdir(), 'murmur-cwd-'));
    try {
      process.chdir(elsewhere);
      const there = await rootOf();
      expect(there.root).toBe(here.root);
      // 그리고 그 곳이 새 cwd 안이 아니어야 한다 — cwd 를 따라갔다는 뜻이 되므로.
      expect(there.root.startsWith(elsewhere)).toBe(false);
    } finally {
      process.chdir(originalCwd);
      await rm(elsewhere, { recursive: true, force: true });
    }
  });

  it('1b. 기본 루트는 packages/server 안의 .attachments 다', async () => {
    delete process.env.ATTACHMENT_ROOT;
    // 예전에 `packages/server` 에서 기동했을 때 상대경로가 가리켰던 곳과 같아야 한다 —
    // 그래야 이미 쌓인 파일이 그대로 보인다. `src/` 아래로 내려가면 사용자 데이터가
    // 소스 트리 안에 생기고, 옮겨진 만큼 기존 파일도 다시 사라진다.
    const packageRoot = fileURLToPath(new URL('..', import.meta.url)).replace(/\/$/, '');
    const { root } = await rootOf();
    expect(root).toBe(join(packageRoot, '.attachments'));
  });

  it('2. ATTACHMENT_ROOT 가 상대경로면 절대경로로 풀리고 로그에 그 사실이 남는다', async () => {
    process.env.ATTACHMENT_ROOT = './some-relative-store';
    const { root, log } = await rootOf();

    expect(isAbsolute(root)).toBe(true);
    expect(root).toBe(resolve('./some-relative-store'));
    // 사람이 "내가 준 값이 어디로 갔는지" 를 로그에서 볼 수 있어야 한다.
    expect(log).toContain('./some-relative-store');
  });

  it('2b. ATTACHMENT_ROOT 가 절대경로면 그대로 쓴다', async () => {
    const absolute = await mkdtemp(join(tmpdir(), 'murmur-absroot-'));
    try {
      process.env.ATTACHMENT_ROOT = absolute;
      const { root } = await rootOf();
      expect(root).toBe(absolute);
    } finally {
      await rm(absolute, { recursive: true, force: true });
    }
  });

  it('4. 기동 로그에 실제로 쓰는 절대경로가 한 줄 찍힌다', async () => {
    const absolute = await mkdtemp(join(tmpdir(), 'murmur-logroot-'));
    try {
      process.env.ATTACHMENT_ROOT = absolute;
      const log = capture();
      const app = await buildServer({ pool, logStream: log.stream, logLevel: 'info' });
      await app.close();
      expect(log.text()).toContain(absolute);
    } finally {
      await rm(absolute, { recursive: true, force: true });
    }
  });

  it('4b. deps.storage 가 주어지면 로그는 기본값이 아니라 그것을 가리킨다', async () => {
    // 로그가 "계산해 봤지만 쓰지 않는 경로" 를 가리키면 이 사고를 로그로 추적할 수 없다.
    const injected = await mkdtemp(join(tmpdir(), 'murmur-injected-'));
    try {
      delete process.env.ATTACHMENT_ROOT;
      const log = capture();
      const app = await buildServer({
        pool, logStream: log.stream, logLevel: 'info',
        storage: { root: injected, maxBytes: 1024 },
      });
      await app.close();
      expect(log.text()).toContain(`attachment storage root: ${injected}`);
      expect(log.text()).not.toContain('.attachments');
    } finally {
      await rm(injected, { recursive: true, force: true });
    }
  });
});
