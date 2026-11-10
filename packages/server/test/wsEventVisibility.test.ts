// WS 이벤트를 누가 받는가 — 종류마다 정한 판정(`EVENT_VISIBILITY`)이 빠짐없이 있고, 모르는 종류는 아무에게도 안 가며,
// 받는 사람을 계산해 싣는 이벤트는 그 사람에게만 간다.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import WebSocket from 'ws';
import { buildServer } from '../src/buildServer.js';
import type { WorkspaceEvent } from '../src/events.js';
import { EVENT_VISIBILITY, visibleTo } from '../src/ws/wsPlugin.js';
import { bootstrapAdmin, createAgent } from './helpers/fixtures.js';
import { startTestDb } from './helpers/testDb.js';

const EVENTS_SRC = readFileSync(join(import.meta.dirname, '..', 'src', 'events.ts'), 'utf8');

/** `events.ts` 의 유니온에서 종류 이름과, 그 종류가 `audience` 필드를 싣는지를 읽는다. */
function declaredTypes(): Map<string, boolean> {
  const out = new Map<string, boolean>();
  const parts = EVENTS_SRC.split(/\n\s*\|\s*(?=\{\s*type:)/);
  for (const part of parts) {
    const m = part.match(/^\s*\{\s*type:\s*'([A-Za-z_.]+)'/);
    if (!m) continue;
    const body = part.slice(0, part.indexOf('}') >= 0 ? part.lastIndexOf('}') + 1 : part.length);
    out.set(m[1]!, /\baudience\??:/.test(body));
  }
  return out;
}

describe('EVENT_VISIBILITY — 판정 표', () => {
  it('events.ts 의 모든 종류가 표에 있다(빠지면 그 이벤트는 아무에게도 안 간다)', () => {
    expect(Object.keys(EVENT_VISIBILITY).sort()).toEqual([...declaredTypes().keys()].sort());
  });

  it('받는 사람(audience)을 싣는 종류는 전부 audience 로 거른다', () => {
    const withAudience = [...declaredTypes()].filter(([, a]) => a).map(([t]) => t).sort();
    expect(withAudience.length).toBeGreaterThan(10);
    for (const t of withAudience) expect([t, EVENT_VISIBILITY[t as WorkspaceEvent['type']]]).toEqual([t, 'audience']);
  });

  it('모르는 종류·받는 사람이 빠진 이벤트는 아무에게도 보내지 않는다', () => {
    expect(visibleTo({ type: 'nope' } as unknown as WorkspaceEvent, 'a')).toBe(false);
    expect(visibleTo({ type: 'reaction.added', channelId: 'c', messageId: 'm', emoji: 'x', accountId: 'b' } as unknown as WorkspaceEvent, 'a')).toBe(false);
    expect(visibleTo({ type: 'reaction.added', channelId: 'c', messageId: 'm', emoji: 'x', accountId: 'b', audience: ['b'] }, 'a')).toBe(false);
    expect(visibleTo({ type: 'reaction.added', channelId: 'c', messageId: 'm', emoji: 'x', accountId: 'b', audience: ['a'] }, 'a')).toBe(true);
    expect(visibleTo({ type: 'presence.changed', accountId: 'b', online: true }, 'a')).toBe(true);
    expect(visibleTo({ type: 'inbox.updated', accountId: 'b' }, 'a')).toBe(false);
  });
});

describe('비공개 채널의 리액션', () => {
  let app: FastifyInstance;
  let stop: () => Promise<void>;
  let adminToken: string;
  let bystanderPat: string;
  let baseUrl: string;

  beforeAll(async () => {
    const db = await startTestDb();
    stop = db.stop;
    app = await buildServer({ pool: db.pool });
    ({ token: adminToken } = await bootstrapAdmin(app));
    ({ pat: bystanderPat } = await createAgent(app, adminToken, 'bystander'));
    await app.listen({ port: 0, host: '127.0.0.1' });
    const addr = app.server.address();
    baseUrl = typeof addr === 'object' && addr ? `127.0.0.1:${addr.port}` : '';
  });
  afterAll(async () => { await app.close(); await stop(); });

  const auth = (t: string) => ({ authorization: `Bearer ${t}` });
  async function collect(token: string): Promise<{ events: { type: string; messageId?: string }[]; close(): void }> {
    const ticket = (await app.inject({ method: 'POST', url: '/ws-ticket', headers: auth(token) })).json().ticket as string;
    const events: { type: string; messageId?: string }[] = [];
    const ws = new WebSocket(`ws://${baseUrl}/ws?ticket=${ticket}`);
    await new Promise<void>((resolve, reject) => {
      ws.on('error', reject);
      ws.on('message', (d) => {
        const e = JSON.parse(String(d)) as { type: string; messageId?: string };
        events.push(e);
        if (e.type === 'presence.snapshot') resolve();
      });
    });
    return { events, close: () => ws.close() };
  }
  const waitFor = async (pred: () => boolean) => {
    for (let i = 0; i < 200 && !pred(); i += 1) await new Promise((r) => setTimeout(r, 25));
  };

  it('채널 밖 계정은 그 채널 메시지의 리액션을 받지 않고, 볼 수 있는 계정은 받는다', async () => {
    const ch = await app.inject({ method: 'POST', url: '/channels', headers: auth(adminToken), payload: { name: 'reaction-private', visibility: 'private' } });
    expect(ch.statusCode).toBe(201);
    const channelId = ch.json().id as string;
    const msg = await app.inject({ method: 'POST', url: `/channels/${channelId}/messages`, headers: auth(adminToken), payload: { body: 'hi' } });
    expect(msg.statusCode).toBe(201);
    const messageId = msg.json().id as string;

    const admin = await collect(adminToken);
    const bystander = await collect(bystanderPat);
    for (const method of ['PUT', 'DELETE'] as const) {
      const r = await app.inject({ method, url: `/channels/${channelId}/messages/${messageId}/reactions/%F0%9F%91%8D`, headers: auth(adminToken) });
      expect(r.statusCode).toBeLessThan(300);
    }
    const seen = (s: { events: { type: string; messageId?: string }[] }, type: string) => s.events.some((e) => e.type === type && e.messageId === messageId);
    await waitFor(() => seen(admin, 'reaction.added') && seen(admin, 'reaction.removed'));
    expect(seen(admin, 'reaction.added')).toBe(true);
    expect(seen(admin, 'reaction.removed')).toBe(true);
    await new Promise((r) => setTimeout(r, 200));
    expect(seen(bystander, 'reaction.added')).toBe(false);
    expect(seen(bystander, 'reaction.removed')).toBe(false);
    admin.close(); bystander.close();
  });
});
