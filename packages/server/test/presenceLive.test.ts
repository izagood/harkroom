import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import type { FastifyInstance } from 'fastify';
import type { Pool } from 'pg';
import WebSocket from 'ws';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import type { WsServerEvent } from '@murmur/shared';
import { startTestDb } from './helpers/testDb.js';
import { buildServer } from '../src/buildServer.js';
import { bootstrapAdmin, createAgent } from './helpers/fixtures.js';
import { onEvent } from '../src/events.js';
import type { WorkspaceEvent } from '../src/events.js';

let app: FastifyInstance;
let stop: () => Promise<void>;
let pool: Pool;
let adminToken: string;
let adminId: string;
let agentPat: string;
let agentId: string;
let base: string;

beforeAll(async () => {
  const db = await startTestDb();
  stop = db.stop;
  pool = db.pool;
  app = await buildServer({ pool: db.pool });
  await app.listen({ port: 0, host: '127.0.0.1' });
  const addr = app.server.address();
  base = typeof addr === 'object' && addr ? `127.0.0.1:${addr.port}` : '127.0.0.1';
  ({ token: adminToken, accountId: adminId } = await bootstrapAdmin(app));
  ({ accountId: agentId, pat: agentPat } = await createAgent(app, adminToken, 'presence-agent'));
});
afterAll(async () => { await app.close(); await stop(); });

async function mcpClient(token: string): Promise<Client> {
  const client = new Client({ name: 'test', version: '0.0.0' });
  await client.connect(new StreamableHTTPClientTransport(new URL(`http://${base}/mcp`), {
    requestInit: { headers: { authorization: `Bearer ${token}` } },
  }));
  return client;
}

const ticketFor = async (token: string) => {
  const res = await app.inject({
    method: 'POST', url: '/ws-ticket', headers: { authorization: `Bearer ${token}` },
  });
  return res.json().ticket as string;
};

interface Collector {
  events: WsServerEvent[];
  ready: Promise<void>;
  send(payload: unknown): void;
  close(): void;
}

async function connect(token: string): Promise<Collector> {
  const ticket = await ticketFor(token);
  const ws = new WebSocket(`ws://${base}/ws?ticket=${encodeURIComponent(ticket)}`);
  const events: WsServerEvent[] = [];
  const ready = new Promise<void>((resolve) => {
    ws.on('message', (raw) => {
      const e = JSON.parse(String(raw)) as WsServerEvent;
      events.push(e);
      if (e.type === 'presence.snapshot') resolve();
    });
  });
  await new Promise<void>((resolve, reject) => {
    ws.on('open', () => resolve());
    ws.on('error', reject);
  });
  await ready;
  return {
    events,
    ready,
    send: (payload) => ws.send(JSON.stringify(payload)),
    close: () => ws.close(),
  };
}

const presenceChanged = (c: Collector) =>
  c.events.filter((e): e is Extract<WsServerEvent, { type: 'presence.changed' }> => e.type === 'presence.changed');

const waitFor = async (check: () => boolean, ms = 8000) => {
  const until = Date.now() + ms;
  while (Date.now() < until) {
    if (check()) return;
    await new Promise((r) => setTimeout(r, 20));
  }
  throw new Error('timed out waiting for condition');
};

describe('agent presence via inbox.poll', () => {
  it('emits presence.changed when agent polls inbox', async () => {
    const events: WorkspaceEvent[] = [];
    const off = onEvent((e) => events.push(e));
    const client = await mcpClient(agentPat);

    await client.callTool({ name: 'inbox.poll', arguments: { timeoutMs: 0 } });

    const presenceEvents = events.filter(
      (e): e is Extract<WorkspaceEvent, { type: 'presence.changed' }> =>
        e.type === 'presence.changed' && e.accountId === agentId,
    );
    expect(presenceEvents).toContainEqual(
      expect.objectContaining({ type: 'presence.changed', accountId: agentId, online: true }),
    );

    off();
    await client.close();
  });

  it('includes agent in presence.snapshot for newly connected client', async () => {
    // First, have the agent poll to mark it online
    const client = await mcpClient(agentPat);
    await client.callTool({ name: 'inbox.poll', arguments: { timeoutMs: 0 } });
    await client.close();

    // Now connect a human user via WS
    const human = await connect(adminToken);

    // The snapshot should include the agent
    const snapshot = human.events.find((e) => e.type === 'presence.snapshot') as
      Extract<WsServerEvent, { type: 'presence.snapshot' }> | undefined;
    expect(snapshot).toBeDefined();
    expect(snapshot!.online).toContain(agentId);

    human.close();
  });

  it('does not affect human presence when agent comes online', async () => {
    // Connect a human first
    const human = await connect(adminToken);

    // Verify the human is in the snapshot with their accountId
    const initialSnapshot = human.events.find((e) => e.type === 'presence.snapshot') as
      Extract<WsServerEvent, { type: 'presence.snapshot' }> | undefined;
    expect(initialSnapshot).toBeDefined();
    expect(initialSnapshot!.online).toContain(adminId);

    // Now have the agent poll
    const client = await mcpClient(agentPat);
    await client.callTool({ name: 'inbox.poll', arguments: { timeoutMs: 0 } });
    await client.close();

    // The human should still be online - check if presence.changed removed them
    const changedEvents = presenceChanged(human);
    const humanWentOffline = changedEvents.some((e) => e.accountId === adminId && e.online === false);
    expect(humanWentOffline).toBe(false);

    human.close();
  });

  it('agent appears online even when no human is connected', async () => {
    // Have the agent poll to mark it online
    const client = await mcpClient(agentPat);
    await client.callTool({ name: 'inbox.poll', arguments: { timeoutMs: 0 } });
    await client.close();

    // Connect a human - they should see the agent in snapshot
    const human = await connect(adminToken);

    const snapshot = human.events.find((e) => e.type === 'presence.snapshot') as
      Extract<WsServerEvent, { type: 'presence.snapshot' }> | undefined;
    expect(snapshot).toBeDefined();
    expect(snapshot!.online).toContain(agentId);

    // Human should also be there
    expect(snapshot!.online).toContain(adminId);

    human.close();
  });
});