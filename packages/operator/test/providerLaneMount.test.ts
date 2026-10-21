import { describe, expect, it } from 'vitest';
import { PROVIDER_LANE_MOUNT_PATH } from '@harkroom/shared/providerLane';
import type { RunnerLinkRequest } from '@harkroom/shared/runnerLink';
import { createProviderLaneMount, createProviderLaneStatusBook } from '../src/providerLaneMount.js';

const req = (body: unknown, path = PROVIDER_LANE_MOUNT_PATH): RunnerLinkRequest =>
  ({ type: 'http.forward', id: 'r1', method: 'POST', path, body: JSON.stringify(body), contentType: 'application/json' });
const lane = { baseUrl: 'https://gateway.example', secretName: 'gw-key' };

function make(opts: { lane?: unknown; mount?: { ok: true; path: string } | { ok: false; code: string } } = {}) {
  const calls: string[] = [];
  const m = createProviderLaneMount({
    laneOf: async () => (opts.lane === undefined ? lane : opts.lane) as never,
    turnSecrets: {
      mountFor: async (runnerId, cause, name) => { calls.push(`${runnerId}|${cause}|${name}`); return opts.mount ?? { ok: true, path: '/data/turn-secrets/l1/s1' }; },
    },
    log: () => {},
  });
  return { m, calls };
}

describe('providerLaneMount', () => {
  it('다른 경로·메서드는 넘긴다', async () => {
    const { m } = make();
    expect(await m.maybeHandle('run-1', 'a-1', req({ cause: 'm1' }, '/agent/turn-slots'), 'relay')).toBeNull();
  });

  it('relay 가 아니면 403 — 브릿지(모델이 띄운 것)는 부를 수 없다', async () => {
    const { m, calls } = make();
    const res = await m.maybeHandle('run-1', 'a-1', req({ cause: 'm1' }), 'bridge');
    expect(res).toMatchObject({ status: 403 });
    expect(calls).toEqual([]);
  });

  it('설정의 비밀 이름으로 그 러너·그 턴의 임대에 마운트하고 경로만 준다', async () => {
    const { m, calls } = make();
    const res = await m.maybeHandle('run-1', 'a-1', req({ cause: 'm1', secretName: 'other' }), 'relay');
    // 요청 본문의 이름은 읽지 않는다(security ⓓ) — 설정의 이름만.
    expect(calls).toEqual(['run-1|m1|gw-key']);
    expect(res).toMatchObject({ status: 200 });
    expect(JSON.parse((res as { body: string }).body)).toEqual({ lane: { baseUrl: 'https://gateway.example', path: '/data/turn-secrets/l1/s1' } });
  });

  it('설정이 없거나 틀리면 lane null', async () => {
    for (const bad of [null, { baseUrl: 'http://gateway.example', secretName: 'gw-key' }]) {
      const { m, calls } = make({ lane: bad });
      const res = await m.maybeHandle('run-1', 'a-1', req({ cause: 'm1' }), 'relay');
      expect(JSON.parse((res as { body: string }).body)).toEqual({ lane: null });
      expect(calls).toEqual([]);
    }
  });

  it('임대가 없으면 409, 서버 거절은 502 + 코드', async () => {
    expect(await make({ mount: { ok: false, code: 'no_lease' } }).m.maybeHandle('run-1', 'a-1', req({ cause: 'm1' }), 'relay')).toMatchObject({ status: 409 });
    const res = await make({ mount: { ok: false, code: 'not_granted' } }).m.maybeHandle('run-1', 'a-1', req({ cause: 'm1' }), 'relay');
    expect(res).toMatchObject({ status: 502 });
    expect(JSON.parse((res as { body: string }).body)).toEqual({ error: { code: 'not_granted' } });
  });

  it('cause 가 없으면 400', async () => {
    expect(await make().m.maybeHandle('run-1', 'a-1', req({}), 'relay')).toMatchObject({ status: 400 });
  });
});

describe('마지막 키 받기 장부(2a)', () => {
  it('에이전트마다 마지막 결과 하나 — 성공은 코드 없이, 목록 밖 코드는 unknown', () => {
    let t = Date.parse('2026-10-21T00:00:00Z');
    const book = createProviderLaneStatusBook(() => t);
    book.note('a-1', false, 'no_lease');
    t += 1000;
    book.note('a-2', false, 'weird' as never);
    book.note('a-1', true);
    expect(book.snapshot()).toEqual({
      'a-1': { at: '2026-10-21T00:00:01.000Z', ok: true },
      'a-2': { at: '2026-10-21T00:00:01.000Z', ok: false, code: 'unknown' },
    });
  });

  it('마운트 실패도 적는다 — 러너가 통지를 못 보내고 죽는 경우', async () => {
    const status = createProviderLaneStatusBook();
    const m = createProviderLaneMount({
      laneOf: async () => lane,
      turnSecrets: { mountFor: async () => ({ ok: false, code: 'not_granted' }) },
      status,
      log: () => {},
    });
    await m.maybeHandle('run-1', 'a-1', req({ cause: 'm1' }), 'relay');
    expect(status.snapshot()['a-1']).toMatchObject({ ok: false, code: 'not_granted' });
  });
});
