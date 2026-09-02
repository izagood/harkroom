#!/usr/bin/env tsx
/**
 * 잠긴 사람 계정의 비밀번호를 재설정한다 — **서버 호스트에서 운영자가 직접 돌리는 도구다.**
 *
 * 왜 API 가 아니라 도구인가: `POST /auth/password` 는 로그인한 사람만 구제한다. 실제 사고는
 * "관리자 1명이 잠겼다"였고 그건 API 로 풀 수 없다 — 풀 수 있으면 그게 취약점이다.
 * `account` 에 이메일 컬럼이 설계상 없어(#110) 이메일 기반 self-serve 복구도 불가능하다.
 *
 * 비밀번호를 **argv 로 받지 않는다**: `ps` 로 다른 로컬 사용자에게 보인다. 이 저장소가 PAT 에
 * 대해 세운 경계와 같다(spec §7 — argv 는 보이고 env 는 보이지 않는다).
 */
import pg from 'pg';
import argon2 from 'argon2';
import { z } from 'zod';
import { recordAudit } from '../src/audit.js';

const { Pool } = pg;

/** 서버의 비밀번호 규칙과 **같은 것**을 쓴다 — 여기서 8..128 을 다시 적으면 두 곳이 갈린다. */
const passwordRule = z.string().min(8).max(128);

const USAGE = [
  '사용법: MURMUR_NEW_PASSWORD=<새 비밀번호> DATABASE_URL=<...> tsx packages/server/scripts/reset-password.ts <handle>',
  '',
  '비밀번호는 argv 가 아니라 환경변수로 받는다 — argv 는 `ps` 로 다른 로컬 사용자에게 보인다.',
].join('\n');

async function main(): Promise<void> {
  const handle = process.argv[2];
  const newPassword = process.env.MURMUR_NEW_PASSWORD;
  const databaseUrl = process.env.DATABASE_URL;

  if (!handle || !newPassword || !databaseUrl) {
    console.error(USAGE);
    if (!handle) console.error('\n오류: handle 인자가 없다.');
    if (!newPassword) console.error('\n오류: MURMUR_NEW_PASSWORD 가 비어 있다.');
    if (!databaseUrl) console.error('\n오류: DATABASE_URL 이 비어 있다.');
    process.exit(1);
  }

  const parsed = passwordRule.safeParse(newPassword);
  if (!parsed.success) {
    console.error('오류: 비밀번호가 서버의 규칙(8~128자)을 만족하지 않는다.');
    process.exit(1);
  }

  const pool = new Pool({ connectionString: databaseUrl });
  try {
    const found = await pool.query(
      `select id from account where handle = $1 and kind = 'human'`, [handle],
    );
    if (!found.rowCount) {
      console.error(`오류: '${handle}' 라는 사람 계정이 없다.`);
      process.exit(1);
    }
    const accountId = found.rows[0].id as string;
    const hash = await argon2.hash(newPassword);

    // 비밀번호 교체와 세션 삭제는 **한 트랜잭션**이어야 한다. `pool.query('begin')` 은
    // 매 호출이 다른 커넥션을 집을 수 있어 트랜잭션이 성립하지 않고, 게다가 'begin' 을
    // 받은 커넥션이 열린 트랜잭션째로 풀에 반납된다. 그래서 커넥션을 직접 잡는다.
    const client = await pool.connect();
    try {
      await client.query('begin');
      await client.query(`update account set password_hash = $1 where id = $2`, [hash, accountId]);
      // 잠긴 상황을 푸는 도구다 — 옛 세션이 살아 있으면 안 된다.
      await client.query(`delete from session where account_id = $1`, [accountId]);
      await client.query('commit');
    } catch (err) {
      await client.query('rollback').catch(() => {});
      throw err;
    } finally {
      client.release();
    }

    // 감사는 커밋 뒤에 남긴다(롤백된 일을 기록하면 감사 추적이 거짓을 말한다). SQL 을 새로
    // 쓰지 않고 서버와 같은 `recordAudit` 을 쓴다 — 컬럼이 늘 때 두 곳이 갈리지 않게.
    // actor 는 null 이다: 이 도구를 누가 돌렸는지 서버는 알 수 없고, 모르는 것을 아는 척
    // 하지 않는다(ip 도 마찬가지 — 요청이 아니라 셸이다).
    await recordAudit(pool, {
      action: 'password.changed',
      target: accountId,
      detail: { via: 'operational_tool', note: '서버 호스트에서 운영자가 직접 실행했다 — actor 는 기록되지 않는다' },
    });

    console.log(`'${handle}' 의 비밀번호를 재설정했다. 그 계정의 모든 세션을 지웠다 — 다시 로그인해야 한다.`);
  } finally {
    await pool.end();
  }
}

await main();
