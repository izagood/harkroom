// message 를 가리키는 외래키는 모두 앞자리 색인을 가져야 한다(2026-10-13 쿼리 개선 Q5, 마이그레이션 123).
//
// 메시지를 지울 때(채널 삭제는 그 채널의 메시지 전부) 외래키마다 「아직 가리키는 행이 있나」를 확인한다. 색인이 없으면
// 그 확인이 지우는 메시지 한 줄마다 그 표를 통째로 훑는다 — 로컬 운영 크기에서 메시지 22,608개 채널 삭제가 14초,
// 그중 message.cause_message_id 하나가 11.4초였다(30초 statement_timeout 에 큰 채널은 지워지지 않는다).
//
// 새 표가 message 를 가리키면서 색인을 빠뜨리면 이 시험이 빨개진다 — 같은 마이그레이션에 색인을 더하라.
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import type { Pool } from 'pg';
import { startTestDb } from './helpers/testDb.js';

let pool: Pool; let stop: () => Promise<void>;
beforeAll(async () => { ({ pool, stop } = await startTestDb()); });
afterAll(async () => stop());

describe('message 외래키 색인', () => {
  it('message 를 가리키는 외래키 열마다 그 열로 시작하는 유효한 색인이 있다', async () => {
    const res = await pool.query<{ fk: string }>(
      `select c.conrelid::regclass::text || '.' || a.attname as fk
         from pg_constraint c
         join pg_attribute a on a.attrelid = c.conrelid and a.attnum = c.conkey[1]
        where c.contype = 'f' and c.confrelid = 'message'::regclass
          and not exists (
            select 1 from pg_index i
             where i.indrelid = c.conrelid and i.indkey[0] = c.conkey[1] and i.indisvalid)
        order by 1`);
    expect(res.rows.map((r) => r.fk)).toEqual([]);
  });
});
