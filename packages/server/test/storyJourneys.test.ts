// 스토리보드(packages/e2e/stories)의 여정을 API 로 돈다 — e2e 구조 PR2. 러너는 helpers/storyRunner.ts.
// 페르소나마다 계정을 시드하고(역할·grant 까지), `runners` 에 `api` 가 있는 여정을 하나씩 새 상태에서 돈다.
import { describe, it, expect, afterEach, beforeEach } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { loadStoryboard } from '@harkroom/e2e';
import { startTestDb } from './helpers/testDb.js';
import { buildServer } from '../src/buildServer.js';
import { bootstrapAdmin, createMember } from './helpers/fixtures.js';
import { runJourney, seedable, type Actor } from './helpers/storyRunner.js';

const { personas, journeys } = loadStoryboard();
const apiJourneys = journeys.filter((j) => j.runners.includes('api'));

let app: FastifyInstance; let stop: () => Promise<void>;
let actors: Map<string, Actor>;
const auth = (t: string) => ({ authorization: `Bearer ${t}` });

// 여정끼리 grant·역할이 새지 않게 여정마다 DB 를 새로 띄운다(파일 하나라 템플릿 복제가 싸다).
beforeEach(async () => {
  const db = await startTestDb(); stop = db.stop;
  app = await buildServer({ pool: db.pool });
  const owner = await bootstrapAdmin(app);
  actors = new Map([['P1', { id: owner.accountId, token: owner.token, handle: 'admin' }]]);
  for (const p of seedable(personas)) {
    const m = await createMember(app, owner.token, p.handle);
    if (p.role !== 'member') {
      const r = await app.inject({ method: 'PUT', url: `/accounts/${m.accountId}/role`, headers: auth(owner.token), payload: { role: p.role } });
      expect(r.statusCode, `${p.id} 역할 ${p.role}`).toBe(200);
    }
    for (const capability of p.grants ?? []) {
      const g = await app.inject({ method: 'PUT', url: `/accounts/${m.accountId}/grants`, headers: auth(owner.token), payload: { capability } });
      expect(g.statusCode, `${p.id} grant ${capability}`).toBe(200);
    }
    actors.set(p.id, { id: m.accountId, token: m.token, handle: p.handle });
  }
});
afterEach(async () => { await app.close(); await stop(); });

describe('스토리보드 여정 — API', () => {
  it('api 러너를 단 여정이 있다', () => {
    expect(apiJourneys.length).toBeGreaterThan(0);
  });

  for (const journey of apiJourneys) {
    it(`${journey.id} ${journey.title}`, async () => {
      const results = await runJourney({ app, actors, password: 'pw123456' }, journey, personas);
      const failed = results.filter((r) => r.outcome === 'failed');
      expect(failed, JSON.stringify(results, null, 1)).toEqual([]);
      // 한 단계도 못 돈 여정에 api 를 달아 두면 "시험 있음"이 거짓이 된다.
      expect(results.some((r) => r.outcome === 'passed'), `${journey.id} 는 API 로 돈 단계가 없다 — runners 에서 api 를 빼거나 핸들러를 단다`).toBe(true);
    });
  }
});
