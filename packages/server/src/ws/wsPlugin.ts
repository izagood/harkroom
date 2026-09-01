import websocket from '@fastify/websocket';
import type { FastifyInstance } from 'fastify';
import type { Pool } from 'pg';
import type { WsServerEvent } from '@murmur/shared';

import { emitEvent, onEvent, type WorkspaceEvent } from '../events.js';
import { createTicketStore } from './tickets.js';
import { findInvalidCredentials } from './credentials.js';

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

/** 열린 소켓의 자격증명을 다시 확인하는 주기. */
const DEFAULT_REVALIDATE_MS = 15_000;

export async function registerWs(
  app: FastifyInstance, pool: Pool, opts: { revalidateMs?: number } = {},
): Promise<void> {
  await app.register(websocket);
  const connections = new Map<string, number>(); // accountId → live socket count
  const tickets = createTicketStore();
  // 소켓 → 그 소켓을 연 토큰의 해시. 토큰은 핸드셰이크 때 한 번만 검증되므로, 이 대장이
  // 없으면 폐기·만료된 자격증명이 소켓 수명만큼 계속 이벤트를 받는다.
  const live = new Map<{ close(code: number, reason: string): void }, string>();

  // 브라우저의 WebSocket 생성자는 헤더를 붙일 수 없다. 그래서 자격증명은 URL 로 갈 수밖에
  // 없는데, URL 은 앞단 프록시 로그에 남는다 — 장기 토큰 대신 여기서 받은 단기 1회용
  // 티켓을 싣는다. 이 엔드포인트는 Authorization 헤더로 인증한다.
  app.post('/ws-ticket', { preHandler: app.requireAccount }, async (req) => ({
    ticket: tickets.issue({ accountId: req.account!.id, tokenHash: req.tokenHash! }),
  }));

  app.get('/ws', { websocket: true }, (socket, req) => {
    // 티켓 소비는 인메모리 동기 조회다 — 핸드셰이크와 구독 사이에 await 가 없으므로 그 창에
    // 발행된 이벤트가 유실되는 경합이 존재하지 않는다. 이 경로에 await 를 들이면 그 창이
    // 다시 생기고, 그때는 연결 중 끊김을 처리하는 가드가 필요해진다.
    const ticket = (req.query as Record<string, string>).ticket;
    const holder = ticket ? tickets.consume(ticket) : null;
    if (!holder) { socket.close(4401, 'unauthorized'); return; }
    const { accountId } = holder;
    live.set(socket, holder.tokenHash);

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
      live.delete(socket);
      const left = (connections.get(accountId) ?? 1) - 1;
      if (left <= 0) {
        connections.delete(accountId);
        emitEvent({ type: 'presence.changed', accountId, online: false });
      } else {
        connections.set(accountId, left);
      }
    });
  });

  // 자격증명 재검증 sweep. 소켓 하나에 타이머 하나가 아니라, 주기마다 살아 있는 해시 전체를
  // 한 번의 질의로 확인한다. 판정은 credentials.ts 가 하고(DB 실패 시 fail-open) 여기서는
  // 끊기만 한다. 끊긴 클라이언트는 4401 을 보고 백오프 재연결을 시도하며, 자격증명이 정말
  // 죽었으면 티켓 발급(POST /ws-ticket)이 401 로 막혀 로그인 화면으로 떨어진다.
  const revalidateMs = opts.revalidateMs ?? DEFAULT_REVALIDATE_MS;
  const sweep = async (): Promise<void> => {
    if (!live.size) return;
    const invalid = await findInvalidCredentials(pool, [...new Set(live.values())]);
    if (!invalid.size) return;
    for (const [socket, hash] of live) {
      if (invalid.has(hash)) socket.close(4401, 'credential revoked');
    }
  };
  const timer = setInterval(() => void sweep(), revalidateMs);
  timer.unref?.(); // 이 타이머가 프로세스 종료를 붙잡지 않게 한다
  app.addHook('onClose', async () => clearInterval(timer));
}
