import websocket from '@fastify/websocket';
import type { FastifyInstance } from 'fastify';
import type { Pool } from 'pg';
import { hashToken } from '../auth/tokens.js';
import { emitEvent, onEvent, type WorkspaceEvent } from '../events.js';

async function resolveAccountId(pool: Pool, token: string): Promise<string | null> {
  const hash = hashToken(token);
  const s = await pool.query(`select account_id from session where token_hash = $1 and expires_at > now()`, [hash]);
  if (s.rowCount) return s.rows[0].account_id;
  const p = await pool.query(`select account_id from pat where token_hash = $1 and revoked_at is null`, [hash]);
  return p.rowCount ? p.rows[0].account_id : null;
}

function visibleTo(e: WorkspaceEvent, accountId: string): boolean {
  switch (e.type) {
    case 'message.created':
      return e.audience === 'all' || e.audience.includes(accountId);
    case 'inbox.updated':
      return e.accountId === accountId;
    case 'presence.snapshot':
      return true;
    case 'presence.changed':
      return true;
    default:
      return true;
  }
}

export async function registerWs(app: FastifyInstance, pool: Pool): Promise<void> {
  await app.register(websocket);
  const connections = new Map<string, number>(); // accountId → live socket count

  app.get('/ws', { websocket: true }, async (socket, req) => {
    // Registered before the auth await so a disconnect during resolveAccountId is observed even
    // though it arrives before we'd otherwise attach the real cleanup listener below — closing the
    // race where a client disconnects mid-auth, leaving a subscription (or a close(4401) on an
    // already-dead socket) with nothing left to ever unsubscribe it.
    let closedDuringAuth = false;
    socket.on('close', () => { closedDuringAuth = true; });

    const token = (req.query as Record<string, string>).token;
    const accountId = token ? await resolveAccountId(pool, token) : null;
    if (!accountId) { if (!closedDuringAuth) socket.close(4401, 'unauthorized'); return; }
    if (closedDuringAuth) return; // client vanished mid-auth; never subscribed, nothing to clean up

    const off = onEvent((e) => {
      if (visibleTo(e, accountId)) socket.send(JSON.stringify(e));
    });

    const count = (connections.get(accountId) ?? 0) + 1;
    connections.set(accountId, count);
    if (count === 1) emitEvent({ type: 'presence.changed', accountId, online: true });
    socket.send(JSON.stringify({ type: 'presence.snapshot', online: [...connections.keys()] }));

    socket.on('close', () => {
      off();
      const left = (connections.get(accountId) ?? 1) - 1;
      if (left <= 0) {
        connections.delete(accountId);
        emitEvent({ type: 'presence.changed', accountId, online: false });
      } else {
        connections.set(accountId, left);
      }
    });
  });
}
