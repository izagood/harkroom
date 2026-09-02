import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { startTestDb } from './helpers/testDb.js';
import { buildServer } from '../src/buildServer.js';
import { bootstrapAdmin, createAgent } from './helpers/fixtures.js';

let app: FastifyInstance;
let stop: () => Promise<void>;
let adminToken: string;
let channelId: string;
let fizzPat: string;

beforeAll(async () => {
  const db = await startTestDb();
  stop = db.stop;
  app = await buildServer({ pool: db.pool });
  ({ token: adminToken } = await bootstrapAdmin(app));
  ({ pat: fizzPat } = await createAgent(app, adminToken, 'fizz'));
  const ch = await app.inject({
    method: 'POST', url: '/channels', headers: { authorization: `Bearer ${adminToken}` },
    payload: { name: 'mentions' },
  });
  channelId = ch.json().id;
});
afterAll(async () => { await app.close(); await stop(); });

const say = (body: string) =>
  app.inject({
    method: 'POST', url: `/channels/${channelId}/messages`,
    headers: { authorization: `Bearer ${adminToken}` }, payload: { body },
  });

/** fizz 가 받은 멘션 알림 개수. 데스크탑이 강조한 것과 같아야 한다. */
const mentionsForFizz = async () => {
  const res = await app.inject({
    method: 'GET', url: '/inbox', headers: { authorization: `Bearer ${fizzPat}` },
  });
  return (res.json().entries as Array<{ reason: string }>).filter((e) => e.reason === 'mention').length;
};

describe('what counts as a mention', () => {
  it('notifies on a plain mention', async () => {
    const before = await mentionsForFizz();

    await say('@fizz 이거 봐줘');

    expect(await mentionsForFizz()).toBe(before + 1);
  });

  // 데스크탑은 이메일 안의 @ 를 멘션으로 강조하지 않는다. 서버가 알림을 보내면 강조되지
  // 않은 것이 몰래 알림을 보내는 셈이고, 작성자는 자기가 누군가를 불렀다는 것을 모른다.
  it('does not read an email address as a mention', async () => {
    const before = await mentionsForFizz();

    await say('연락은 me@fizz.com 으로');

    expect(await mentionsForFizz()).toBe(before);
  });

  it('does not read an @ glued to the end of a word as a mention', async () => {
    const before = await mentionsForFizz();

    await say('경로는 users@fizz 입니다');

    expect(await mentionsForFizz()).toBe(before);
  });

  // 반대 방향의 불일치: 데스크탑은 @Fizz 를 강조한다. 서버가 알림을 보내지 않으면 UI 가
  // 지키지 못할 약속을 한 것이 된다.
  it('notifies even when the handle is typed with capitals', async () => {
    const before = await mentionsForFizz();

    await say('@Fizz 대문자로 불렀다');

    expect(await mentionsForFizz()).toBe(before + 1);
  });

  it('still notifies at the start of a line', async () => {
    const before = await mentionsForFizz();

    await say('첫 줄\n@fizz 둘째 줄');

    expect(await mentionsForFizz()).toBe(before + 1);
  });

  it('notifies after punctuation', async () => {
    const before = await mentionsForFizz();

    await say('(@fizz) 괄호 안');

    expect(await mentionsForFizz()).toBe(before + 1);
  });

  it('counts one mention once even if repeated', async () => {
    const before = await mentionsForFizz();

    await say('@fizz @fizz @fizz');

    expect(await mentionsForFizz()).toBe(before + 1);
  });
});
