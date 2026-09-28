// `requireAdmin` → `requireCap` 교체의 약속은 **동작 변화 0** 이다. 그것을 테스트가 말하게
// 한다: 아래 목록은 교체 전 `requireAdmin` 이 걸려 있던 라우트 전부이고, admin 은 403 이
// 아니고 member(grant 없음)는 403 이다. 교체 **전에** 초록이어야 기준선이고, 교체 뒤에도
// 초록이어야 약속이 지켜진 것이다.
//
// 페이로드는 비워 둔다 — admin 이 400·404 를 받는 것은 "403 이 아니다"에 포함된다.
// 이 파일이 재는 것은 인가 관문 하나뿐이다.
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import type { FastifyInstance } from 'fastify';
import type { Pool } from 'pg';
import { startTestDb } from './helpers/testDb.js';
import { buildServer } from '../src/buildServer.js';
import { bootstrapAdmin, createMember } from './helpers/fixtures.js';

let app: FastifyInstance; let stop: () => Promise<void>;
let adminToken: string; let memberToken: string;

beforeAll(async () => {
  const db = await startTestDb(); stop = db.stop;
  app = await buildServer({ pool: db.pool as Pool });
  ({ token: adminToken } = await bootstrapAdmin(app));
  ({ token: memberToken } = await createMember(app, adminToken, 'plain'));
});
afterAll(async () => { await app.close(); await stop(); });

const NIL = '00000000-0000-0000-0000-000000000000';
const ROUTES: [string, string][] = [
  ['POST', '/channels'], ['PATCH', `/channels/${NIL}`], ['DELETE', `/channels/${NIL}`],
  ['GET', `/channels/${NIL}/delete-info`],
  ['PUT', `/channels/${NIL}/auto-mentions/${NIL}`], ['DELETE', `/channels/${NIL}/auto-mentions/${NIL}`],
  ['POST', '/teams'], ['PATCH', `/teams/${NIL}`], ['DELETE', `/teams/${NIL}`],
  ['PUT', `/teams/${NIL}/lead`], ['PUT', `/teams/${NIL}/members/${NIL}`], ['DELETE', `/teams/${NIL}/members/${NIL}`],
  ['POST', '/accounts/agents'], ['POST', `/accounts/agents/${NIL}/stop`], ['POST', `/accounts/agents/${NIL}/stop/undo`],
  ['PATCH', `/accounts/${NIL}/handle`], ['POST', '/invites'],
  ['GET', '/handle-groups'], ['POST', '/handle-groups'], ['GET', `/handle-groups/${NIL}`],
  ['PATCH', `/handle-groups/${NIL}`], ['DELETE', `/handle-groups/${NIL}`],
  ['POST', `/handle-groups/${NIL}/members`], ['DELETE', `/handle-groups/${NIL}/members`],
  ['GET', '/settings/agent-defaults'], ['PUT', '/settings/agent-defaults'],
  // `/settings/projection` 은 `deps.projection` 없이는 등록되지 않는다(buildServer) — 404 라 관문을 잴 수 없다.
  ['GET', '/audit'],
  ['POST', '/skills/nope/approve'], ['DELETE', '/skills/nope'],
];

type Method = 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';

describe('requireCap 은 requireAdmin 과 같은 판정을 낸다', () => {
  for (const [method, url] of ROUTES) {
    it(`${method} ${url}: member 403`, async () => {
      const res = await app.inject({ method: method as Method, url, headers: { authorization: `Bearer ${memberToken}` }, payload: {} });
      expect(res.statusCode).toBe(403);
      expect(res.json().error.code).toBe('forbidden');
    });
    it(`${method} ${url}: admin 은 403 이 아니다`, async () => {
      const res = await app.inject({ method: method as Method, url, headers: { authorization: `Bearer ${adminToken}` }, payload: {} });
      expect(res.statusCode).not.toBe(403);
    });
  }
});
