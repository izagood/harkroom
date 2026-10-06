import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomBytes, randomUUID } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import type { Pool } from 'pg';
import { startTestDb } from './helpers/testDb.js';
import { buildServer } from '../src/buildServer.js';
import { bootstrapAdmin } from './helpers/fixtures.js';
import { createSecretKeyring, keyCheckValue } from '../src/services/secretKeyring.js';
import { verifySecretKeys } from '../src/services/secretKeyCheck.js';

const auth = (t: string) => ({ authorization: `Bearer ${t}` });
const keyA = randomBytes(32);
const keyB = randomBytes(32);
const keyC = randomBytes(32);
const one = (kid: string, key: Buffer) => ({ keys: new Map([[kid, key]]), activeKid: kid });

describe('키 확인값(104) — 한 kid 에 두 키가 섞이지 않는다', () => {
  let db: Awaited<ReturnType<typeof startTestDb>>;
  let pool: Pool;
  let off: FastifyInstance;
  let admin: { token: string; accountId: string };

  /** kid 로 봉인한 비밀 하나를 DB 에 직접 넣는다. */
  const sealedSecret = async (kid: string, key: Buffer): Promise<string> => {
    const id = randomUUID();
    await pool.query(`insert into secret (id, name, kind, owner_account_id) values ($1, $2, 'text', $3)`,
      [id, `s-${id.slice(0, 8)}`, admin.accountId]);
    const sealed = createSecretKeyring(new Map([[kid, key]]), kid)
      .seal(Buffer.from('value'), { secretId: id, version: 1, kind: 'text' });
    await pool.query(`insert into secret_version (secret_id, version, sealed, size_bytes) values ($1, 1, $2, 5)`, [id, sealed]);
    return id;
  };
  const stored = async (kid: string) =>
    (await pool.query<{ kcv: Buffer }>('select kcv from secret_key_check where kid = $1', [kid])).rows[0]?.kcv ?? null;

  beforeAll(async () => {
    db = await startTestDb();
    pool = db.pool;
    off = await buildServer({ pool, secretKeyring: null });
    admin = await bootstrapAdmin(off);
  });
  afterAll(async () => {
    await off.close();
    await db.stop();
  });

  it('값이 없는 새 kid 는 그냥 받아 확인값을 남기고, 같은 키는 다음에도 맞는다', async () => {
    const first = await verifySecretKeys(pool, one('fresh', keyA));
    expect(first.mismatch).toBe(false);
    expect(first.keyring?.activeKid).toBe('fresh');
    expect(await stored('fresh')).toEqual(keyCheckValue(keyA));
    expect((await verifySecretKeys(pool, one('fresh', keyA))).keyring).not.toBeNull();
  });

  it('같은 kid 에 다른 키가 걸리면 그 kid 를 막고(봉인·풀기 둘 다) 확인값은 고쳐 쓰지 않는다', async () => {
    await verifySecretKeys(pool, one('swap', keyA));
    const v = await verifySecretKeys(pool, one('swap', keyB));
    expect(v.keyring).toBeNull();
    expect(v.mismatch).toBe(true);
    expect(v.rejectedKids).toEqual(['swap']);
    expect(await stored('swap')).toEqual(keyCheckValue(keyA));
  });

  it('활성이 아닌 kid 가 어긋나면 그 kid 만 빠지고 보관소는 켜진 채다', async () => {
    await verifySecretKeys(pool, one('old1', keyA));
    const v = await verifySecretKeys(pool, { keys: new Map([['old1', keyB], ['new1', keyC]]), activeKid: 'new1' });
    expect(v.mismatch).toBe(false);
    expect(v.keyring?.kids).toEqual(['new1']);
    expect(v.rejectedKids).toEqual(['old1']);
  });

  it('확인값이 없는데 그 kid 로 봉인된 값이 있으면, 실제로 풀려야만 확인값을 남긴다', async () => {
    await sealedSecret('legacy_1', keyA);
    const wrong = await verifySecretKeys(pool, one('legacy_1', keyB));
    expect(wrong.mismatch).toBe(true);
    expect(await stored('legacy_1')).toBeNull();
    const right = await verifySecretKeys(pool, one('legacy_1', keyA));
    expect(right.mismatch).toBe(false);
    expect(await stored('legacy_1')).toEqual(keyCheckValue(keyA));
  });

  it('kid 의 `_` 를 like 와일드카드로 읽지 않는다 — 다른 kid 의 값으로 확인하지 않는다', async () => {
    await sealedSecret('wx1', keyA);
    // 'w_1' 이 like 였다면 'wx1' 의 값을 집어 keyB 로 못 풀어 거절했을 것이다.
    expect((await verifySecretKeys(pool, one('w_1', keyB))).mismatch).toBe(false);
  });

  it('두 서버가 같은 새 kid 를 다른 키로 동시에 넣어도 하나만 이긴다', async () => {
    const [a, b] = await Promise.all([
      verifySecretKeys(pool, one('race', keyA)),
      verifySecretKeys(pool, one('race', keyB)),
    ]);
    expect([a.mismatch, b.mismatch].filter(Boolean)).toHaveLength(1);
    const winner = a.mismatch ? keyB : keyA;
    expect(await stored('race')).toEqual(keyCheckValue(winner));
  });

  it('목록은 키링에 없는 kid 로 봉인된 값을 keyLost 로 알리고, kid 이름은 내보내지 않는다', async () => {
    const lostId = await sealedSecret('gone', keyA);
    const keptId = await sealedSecret('here', keyB);
    const app = await buildServer({ pool, secretKeyring: createSecretKeyring(new Map([['here', keyB]]), 'here') });
    try {
      const r = await app.inject({ method: 'GET', url: '/secrets', headers: auth(admin.token) });
      expect(r.statusCode).toBe(200);
      const body = r.json() as { keyMismatch: boolean; secrets: Record<string, unknown>[] };
      expect(body.keyMismatch).toBe(false);
      const byId = new Map(body.secrets.map((s) => [s.id, s]));
      expect(byId.get(lostId)?.keyLost).toBe(true);
      expect(byId.get(keptId)?.keyLost).toBe(false);
      expect(r.body).not.toContain('gone');
      expect(r.body).not.toContain('sealedKid');
    } finally {
      await app.close();
    }
  });

  it('기동 때 활성 kid 가 어긋나면 보관소를 secret_key_mismatch 로 끈다', async () => {
    await verifySecretKeys(pool, one('boot', keyA));
    const dir = mkdtempSync(join(tmpdir(), 'hk-kcv-'));
    writeFileSync(join(dir, 'boot'), keyB.toString('base64'));
    const prev = { dir: process.env.HARKROOM_SECRET_KEYS_DIR, kid: process.env.HARKROOM_SECRET_KEY_ID };
    process.env.HARKROOM_SECRET_KEYS_DIR = dir;
    delete process.env.HARKROOM_SECRET_KEY_ID;
    let app: FastifyInstance | undefined;
    try {
      app = await buildServer({ pool });
      const list = await app.inject({ method: 'GET', url: '/secrets', headers: auth(admin.token) });
      expect(list.json()).toMatchObject({ enabled: false, keyMismatch: true });
      const create = await app.inject({
        method: 'POST', url: '/secrets', headers: auth(admin.token),
        payload: { name: 'blocked', kind: 'text', value: 'v' },
      });
      expect(create.statusCode).toBe(409);
      expect(create.json().error.code).toBe('secret_key_mismatch');
      expect(create.body).not.toContain('boot');
    } finally {
      await app?.close();
      if (prev.dir === undefined) delete process.env.HARKROOM_SECRET_KEYS_DIR; else process.env.HARKROOM_SECRET_KEYS_DIR = prev.dir;
      if (prev.kid !== undefined) process.env.HARKROOM_SECRET_KEY_ID = prev.kid;
    }
  });
});
