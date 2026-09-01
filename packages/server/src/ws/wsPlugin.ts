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
    case 'message.updated':
    case 'message.deleted':
      return e.audience === 'all' || e.audience.includes(accountId);
    case 'inbox.updated':
      return e.accountId === accountId;
    case 'presence.changed':
      return true;
    default:
      return true;
  }
}

export interface WsOptions {
  /** null 이면 Origin 을 검사하지 않는다. */
  allowedOrigins?: string[] | null;
  /** 소켓 뒤 자격증명 재검증 주기. */
  revalidateMs?: number;
}

export async function registerWs(app: FastifyInstance, pool: Pool, opts: WsOptions = {}): Promise<void> {
  await app.register(websocket);
  const connections = new Map<string, number>(); // accountId → live socket count
  const tickets = createTicketStore();
  const allowedOrigins = opts.allowedOrigins ?? null;
  // 소켓을 연 자격증명을 들고 있어야, 그게 죽었을 때 소켓도 닫을 수 있다.
  const live = new Set<{ socket: { close(code: number, reason: string): void }; credentialHash: string }>();

  // WebSocket 핸드셰이크는 CORS 의 보호를 받지 않는다 — 브라우저는 교차 출처로도 연결을 맺는다.
  // 다만 Origin 은 브라우저만 보낸다. 에이전트·CLI 는 보내지 않으므로 부재는 허용해야 한다.
  const originAllowed = (origin: string | undefined): boolean =>
    !allowedOrigins || !origin || allowedOrigins.includes(origin);

  // 토큰을 연결 시점에만 검증하면, 만료 직전에 열린 소켓이 만료 후에도 이벤트를 계속 받는다.
  // 판정은 살아 있는 해시 전체에 대해 **한 번의 질의**로 한다. 소켓마다 왕복하면 비용이
  // N배인 것도 있지만, 더 나쁜 건 같은 자격증명의 소켓들이 서로 다른 순간에 판정돼
  // "어떤 탭은 끊기고 어떤 탭은 사는" 상태가 생기는 것이다. 해시 집합 하나로 보면 운명이 같다.
  const sweep = setInterval(() => {
    void (async () => {
      if (!live.size) return;
      const invalid = await findInvalidCredentials(pool, [...new Set([...live].map((e) => e.credentialHash))]);
      if (!invalid.size) return;
      for (const entry of [...live]) {
        if (invalid.has(entry.credentialHash)) {
          live.delete(entry);
          entry.socket.close(4401, 'credential no longer valid');
        }
      }
    })();
  }, opts.revalidateMs ?? 60_000);
  // 테스트는 서버를 여럿 만든다 — 해제하지 않으면 이벤트 루프가 살아남아 러너가 끝나지 않는다.
  app.addHook('onClose', async () => { clearInterval(sweep); });

  // 브라우저의 WebSocket 생성자는 헤더를 붙일 수 없다. 그래서 자격증명은 URL 로 갈 수밖에
  // 없는데, URL 은 앞단 프록시 로그에 남는다 — 장기 토큰 대신 여기서 받은 단기 1회용
  // 티켓을 싣는다. 이 엔드포인트는 Authorization 헤더로 인증한다.
  app.post('/ws-ticket', { preHandler: app.requireAccount }, async (req) => ({
    ticket: tickets.issue(req.account!.id, req.credentialHash!),
  }));

  app.get('/ws', { websocket: true }, (socket, req) => {
    // 티켓 소비는 인메모리 동기 조회다 — 핸드셰이크와 구독 사이에 await 가 없으므로 그 창에
    // 발행된 이벤트가 유실되는 경합이 존재하지 않는다. 이 경로에 await 를 들이면 그 창이
    // 다시 생기고, 그때는 연결 중 끊김을 처리하는 가드가 필요해진다.
    if (!originAllowed(req.headers.origin)) { socket.close(4403, 'origin not allowed'); return; }

    const ticket = (req.query as Record<string, string>).ticket;
    const claim = ticket ? tickets.consume(ticket) : null;
    if (!claim) { socket.close(4401, 'unauthorized'); return; }
    const { accountId, credentialHash } = claim;

    const entry = { socket, credentialHash };
    live.add(entry);

    const off = onEvent((e) => {
      if (visibleTo(e, accountId)) socket.send(JSON.stringify(e));
    });

    const count = (connections.get(accountId) ?? 0) + 1;
    connections.set(accountId, count);
    if (count === 1) emitEvent({ type: 'presence.changed', accountId, online: true });
    const snapshot: WsServerEvent = { type: 'presence.snapshot', online: [...connections.keys()] };
    socket.send(JSON.stringify(snapshot));

    socket.on('close', () => {
      live.delete(entry);
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
