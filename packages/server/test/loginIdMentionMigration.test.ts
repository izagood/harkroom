// #271 회귀선 — 마이그레이션 두 개가 **기존 데이터에 실제로 무엇을 하는가**.
//
//   033: 사람 계정의 `login_id` 를 handle 로 백필한다(요구 1).
//   034: 기존 본문의 `@handle` 을 `<@id>` 로 한 번 바꾼다(요구 7).
//
// **되돌린 뒤 다시 돌린다.** 이미 마이그레이션이 끝난 DB 에 행을 넣으면 033 은 컬럼이
// 이미 있어 아무것도 하지 않고, 034 는 이미 지나가 버린 뒤다 — 그러면 백필 절과 치환 절을
// 통과시키지 않은 채로 초록이 된다. 024 회귀선(`channelNotifyLevelMigration.test.ts`)이
// 같은 이유로 같은 방법을 쓴다.
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import type { Pool } from 'pg';
import { startTestDb } from './helpers/testDb.js';
import { runMigrations } from '../src/db/migrate.js';

const M033 = '033_account_login_id.sql';
const M034 = '034_mention_tokens.sql';

let pool: Pool;
let stop: () => Promise<void>;

beforeAll(async () => {
  ({ pool, stop } = await startTestDb());
});
afterAll(async () => { await stop(); });

/** 033·034 를 적용 전 상태로 되돌린다. */
async function rewind(): Promise<void> {
  await pool.query('alter table account drop constraint if exists account_login_id_not_null');
  await pool.query('drop index if exists account_login_id_unique');
  await pool.query('alter table account drop column if exists login_id');
  await pool.query('delete from schema_migrations where name = any($1)', [[M033, M034]]);
}

describe('033 — 로그인 ID 백필', () => {
  it('기존 사람 계정의 login_id 가 handle 이 된다 — 아무도 로그인을 잃지 않는다', async () => {
    await rewind();
    // 033 이전의 계정: login_id 컬럼 자체가 없다.
    await pool.query(
      `insert into account (handle, display_name, kind, password_hash) values ('oldtimer', 'Old', 'human', 'x')`,
    );
    // 에이전트도 함께 둔다 — 백필이 이쪽까지 채우면 체크 제약의 의도("에이전트는 null 이
    // 정상")가 무너지고, 나중에 에이전트가 로그인 가능한 계정처럼 보인다.
    await pool.query(
      `insert into account (handle, display_name, kind) values ('oldbot', 'Bot', 'agent')`,
    );

    await runMigrations(pool);

    const res = await pool.query<{ handle: string; login_id: string | null }>(
      `select handle, login_id from account where handle in ('oldtimer', 'oldbot')`,
    );
    const byHandle = Object.fromEntries(res.rows.map((r) => [r.handle, r.login_id]));
    expect(byHandle.oldtimer).toBe('oldtimer');
    expect(byHandle.oldbot).toBeNull();
  });

  it('login_id 는 대소문자를 무시하고 유일하다', async () => {
    await expect(pool.query(
      `insert into account (handle, login_id, display_name, kind, password_hash)
       values ('other', 'OLDTIMER', 'Other', 'human', 'x')`,
    )).rejects.toThrow();
  });

  it('사람 계정은 login_id 없이 만들어지지 않는다', async () => {
    await expect(pool.query(
      `insert into account (handle, display_name, kind, password_hash)
       values ('nologin', 'No Login', 'human', 'x')`,
    )).rejects.toThrow();
  });
});

describe('034 — 기존 본문의 멘션 형식 전환', () => {
  it('@handle 을 <@id> 로 바꾸고, 다른 이름의 접두(@handlex)는 건드리지 않는다', async () => {
    await rewind();

    const fizz = (await pool.query<{ id: string }>(
      `insert into account (handle, display_name, kind, password_hash)
       values ('fizz', 'Fizz', 'human', 'x') returning id`,
    )).rows[0]!.id;
    // 에이전트도 바뀌어야 한다 — 사람만 바꾸면 `@forge` 가 옛 형식으로 남아 한 워크스페이스에
    // 두 형식이 공존한다.
    const forge = (await pool.query<{ id: string }>(
      `insert into account (handle, display_name, kind) values ('forge', 'Forge', 'agent') returning id`,
    )).rows[0]!.id;
    const channel = (await pool.query<{ id: string }>(
      `insert into channel (kind, name) values ('standard', 'old-talk') returning id`,
    )).rows[0]!.id;

    const bodies = [
      '@fizz 안녕',                       // 평범한 멘션
      '@fizzx 는 다른 사람이다',            // **접두일 뿐** — 바뀌면 안 된다
      'a@fizz 는 이메일 꼬리다',            // 선행 문자가 있으면 멘션이 아니다
      '@forge 도 봐줘',                    // 에이전트
      '@nobody 는 계정이 아니다',           // 없는 handle 은 글자 그대로
      '@fizz 와 @forge 를 같이',            // 한 본문에 둘
    ];
    const ids: string[] = [];
    for (const body of bodies) {
      const r = await pool.query<{ id: string }>(
        `insert into message (channel_id, author_id, body, kind) values ($1, $2, $3, 'user') returning id`,
        [channel, fizz, body],
      );
      ids.push(r.rows[0]!.id);
    }
    await pool.query(
      `insert into channel_doc (channel_id, body, updated_by) values ($1, $2, $3)`,
      [channel, '문서에서도 @fizz 를 부른다', fizz],
    );

    await runMigrations(pool);

    const got = await pool.query<{ id: string; body: string }>(
      `select id, body from message where id = any($1)`, [ids],
    );
    const byId = Object.fromEntries(got.rows.map((r) => [r.id, r.body]));
    expect(byId[ids[0]!]).toBe(`<@${fizz}> 안녕`);
    // 경계 검사가 없으면 `<@id>x 는 다른 사람이다` 가 되고, 그것은 되돌릴 수 없다.
    expect(byId[ids[1]!]).toBe('@fizzx 는 다른 사람이다');
    expect(byId[ids[2]!]).toBe('a@fizz 는 이메일 꼬리다');
    expect(byId[ids[3]!]).toBe(`<@${forge}> 도 봐줘`);
    expect(byId[ids[4]!]).toBe('@nobody 는 계정이 아니다');
    expect(byId[ids[5]!]).toBe(`<@${fizz}> 와 <@${forge}> 를 같이`);

    const doc = await pool.query<{ body: string }>(
      `select body from channel_doc where channel_id = $1`, [channel],
    );
    expect(doc.rows[0]!.body).toBe(`문서에서도 <@${fizz}> 를 부른다`);
  });
});
