#!/usr/bin/env tsx
import pg from 'pg';
import argon2 from 'argon2';

const { Pool } = pg;

async function main() {
  const handle = process.argv[2];
  if (!handle) {
    console.error('사용법: reset-password <handle>');
    console.error('비밀번호는 MORPH_PASSWORD 환경변수로 전달하세요.');
    console.error('예: MORPH_PASSWORD=새비밀번호 tsx scripts/reset-password jaebin');
    process.exit(1);
  }

  const newPassword = process.env.MORPH_PASSWORD;
  if (!newPassword) {
    console.error('오류: MORPH_PASSWORD 환경변수가 필요합니다.');
    console.error('ps 명령으로 다른 사용자에게 비밀번호가 보이지 않도록 stdin 대신 env를 사용합니다.');
    process.exit(1);
  }

  if (newPassword.length < 8 || newPassword.length > 128) {
    console.error('오류: 비밀번호는 8자 이상 128자 이하여야 합니다.');
    process.exit(1);
  }

  const databaseUrl = process.env.DATABASE_URL;
  if (!databaseUrl) {
    console.error('오류: DATABASE_URL 환경변수가 필요합니다.');
    process.exit(1);
  }

  const pool = new Pool({ connectionString: databaseUrl });

  try {
    const accountRes = await pool.query(
      `select id, handle from account where handle = $1 and kind = 'human'`,
      [handle],
    );

    if (!accountRes.rowCount) {
      console.error(`오류: "${handle}"라는 사람 계정이 없습니다.`);
      process.exit(1);
    }

    const account = accountRes.rows[0];
    const hash = await argon2.hash(newPassword);

    await pool.query('begin');
    await pool.query(`update account set password_hash = $1 where id = $2`, [hash, account.id]);
    await pool.query(`delete from session where account_id = $1`, [account.id]);

    await pool.query(
      `insert into audit_log (action, actor_id, actor_handle, target, ip, detail)
       values ($1, $2, $3, $4, $5, $6)`,
      [
        'password.changed',
        null,
        null,
        account.id,
        '127.0.0.1',
        JSON.stringify({ via: 'operational_tool', actorHandledBy: 'operator' }),
      ],
    );

    await pool.query('commit');

    console.log(`성공: "${handle}"의 비밀번호를 재설정했습니다.`);
    console.log(`모든 세션이 무효화되었으며 감사 로그에 기록되었습니다.`);
  } catch (err) {
    await pool.query('rollback').catch(() => {});
    console.error('오류:', err);
    process.exit(1);
  } finally {
    await pool.end();
  }
}

main();