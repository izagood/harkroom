import websocket from '@fastify/websocket';
import type { FastifyInstance } from 'fastify';
import type { Pool } from 'pg';
import type { WsServerEvent } from '@murmur/shared';
import { emitEvent, onEvent, type WorkspaceEvent } from '../events.js';
import { createTicketStore } from './tickets.js';

function visibleTo(e: WorkspaceEvent, accountId: string): boolean {
  switch (e.type) {
    case 'message.created':
      return e.audience === 'all' || e.audience.includes(accountId);
    case 'inbox.updated':
      return e.accountId === accountId;
    case 'presence.changed':
      return true;
    default:
      return true;
  }
}

export async function registerWs(app: FastifyInstance, _pool: Pool): Promise<void> {
  await app.register(websocket);
  const connections = new Map<string, number>(); // accountId → live socket count
  const tickets = createTicketStore();

  // 브라우저의 WebSocket 생성자는 헤더를 붙일 수 없다. 그래서 자격증명은 URL 로 갈 수밖에
  // 없는데, URL 은 앞단 프록시 로그에 남는다 — 장기 토큰 대신 여기서 받은 단기 1회용
  // 티켓을 싣는다. 이 엔드포인트는 Authorization 헤더로 인증한다.
  app.post('/ws-ticket', { preHandler: app.requireAccount }, async (req) => ({
    ticket: tickets.issue(req.account!.id),
  }));

  app.get('/ws', { websocket: true }, (socket, req) => {
    // 티켓 소비는 인메모리 동기 조회다 — 핸드셰이크와 구독 사이에 await 가 없으므로 그 창에
    // 발행된 이벤트가 유실되는 경합이 존재하지 않는다. 이 경로에 await 를 들이면 그 창이
    // 다시 생기고, 그때는 연결 중 끊김을 처리하는 가드가 필요해진다.
    const ticket = (req.query as Record<string, string>).ticket;
    const accountId = ticket ? tickets.consume(ticket) : null;
    if (!accountId) { socket.close(4401, 'unauthorized'); return; }

    const off = onEvent((e) => {
      if (visibleTo(e, accountId)) socket.send(JSON.stringify(e));
    });

    const count = (connections.get(accountId) ?? 0) + 1;
    connections.set(accountId, count);
    if (count === 1) emitEvent({ type: 'presence.changed', accountId, online: true });
    const snapshot: WsServerEvent = { type: 'presence.snapshot', online: [...connections.keys()] };
    socket.send(JSON.stringify(snapshot));

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
