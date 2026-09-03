import websocket from '@fastify/websocket';
import type { FastifyInstance } from 'fastify';
import type { Pool } from 'pg';
import type { WsServerEvent } from '@murmur/shared';

import { emitEvent, onEvent, type WorkspaceEvent } from '../events.js';
import { createTicketStore } from './tickets.js';
import { createTypingRegistry } from './typing.js';
import { assertChannelVisible, audienceFor } from '../services/channels.js';
import { createCredentialSweep, DEFAULT_REVALIDATE_MS, originAllowed as isOriginAllowed } from './socketLifetime.js';
import { createHeartbeat } from './heartbeat.js';
import type { AgentPresence } from '../mcp/presence.js';

function visibleTo(e: WorkspaceEvent, accountId: string): boolean {
  switch (e.type) {
    case 'message.created':
    case 'message.updated':
    case 'message.deleted':
    case 'typing.changed':
    case 'channel.created':
    case 'channel.updated':
    case 'channel.deleted':
      return e.audience === 'all' || e.audience.includes(accountId);
    case 'inbox.updated':
    case 'saved.changed':
      return e.accountId === accountId;
    case 'presence.changed':
    // 상태도 presence 와 같은 범위로 간다 — 전원. 문구는 임의 텍스트지만 이 워크스페이스는
    // 단일 스코프라 계정 디렉터리 자체가 이미 전원에게 열려 있다(directoryRoutes 의 /accounts).
    case 'status.changed':
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
  /** ping/pong 주기. 이 주기 안에 pong 이 없으면 다음 주기에 끊는다. 기본 30초. */
  heartbeatMs?: number;
  /**
   * 살아 있는 소켓 수를 읽어갈 수 있게 수집기를 넘겨준다. ws 층이 관측 층을 import 하지
   * 않도록 방향을 뒤집었다 — 여기서는 "세는 법"만 주고, 무엇을 하든 호출부가 정한다.
   */
  onSocketCount?: (read: () => number) => void;
  /**
   * 입력 중 상태의 수명. 기본 6초 — 클라이언트가 3초마다 갱신 신호를 보내면 한 번 놓쳐도
   * 유지되고, 탭이 죽으면 6초 안에 사라진다.
   */
  typingTtlMs?: number;
  /**
   * 에이전트 presence 레지스트리. presence.snapshot 에 에이전트를 합집합으로 얹는다.
   * 옵셔널이 아니다 — 빠뜨리면 에이전트가 스냅샷에서 조용히 사라진다.
   */
  agentPresence: AgentPresence;
}

export async function registerWs(app: FastifyInstance, pool: Pool, opts: WsOptions): Promise<void> {
  await app.register(websocket);
  const connections = new Map<string, number>(); // accountId → live socket count
  const tickets = createTicketStore();
  const typing = createTypingRegistry({ ttlMs: opts.typingTtlMs ?? 6_000 });
  const allowedOrigins = opts.allowedOrigins ?? null;
  // Origin 판정과 자격증명 재검증은 `socketLifetime.ts` 하나가 갖는다 — 터미널 뷰어
  // 소켓(`/agent-attach`, #141)도 같은 것을 쓴다. 사본을 두면 한쪽만 고쳐지고, 수명에서
  // 그것은 조용히 열려 있는 쪽으로 어긋난다(더 민감한 쪽이 느슨해진 사고가 실제로 났다).
  const sweep = createCredentialSweep(pool, opts.revalidateMs ?? DEFAULT_REVALIDATE_MS);
  const originAllowed = (origin: string | undefined): boolean =>
    isOriginAllowed(allowedOrigins, origin);
  // 테스트는 서버를 여럿 만든다 — 해제하지 않으면 이벤트 루프가 살아남아 러너가 끝나지 않는다.
  app.addHook('onClose', async () => { sweep.stop(); });

  // 하트비트. design.md §4 는 presence 를 "WS 연결 + 하트비트 기준"이라고 적었지만 ping/pong 이
  // 없어서, 케이블이 뽑히거나 피어가 wedge 되면 **close 이벤트가 오지 않아** 죽은 연결이 online
  // 으로 남았다. 사람은 그걸 "저 에이전트가 살아 있다"로 읽는다. 판정은 heartbeat.ts 가 하고
  // (직전 ping 에 pong 이 없으면 끊는다) 여기서는 주기만 돌린다. 끊으면 close 핸들러가 돌아
  // presence 가 정리된다.
  // 소켓 수는 accountId 별 refcount 의 합이다(한 계정이 여러 탭을 열 수 있다).
  opts.onSocketCount?.(() => [...connections.values()].reduce((a, b) => a + b, 0));

  const heartbeat = createHeartbeat();
  const beat = setInterval(() => heartbeat.tick(), opts.heartbeatMs ?? 30_000);
  beat.unref?.(); // 이 타이머가 프로세스 종료를 붙잡지 않게 한다
  app.addHook('onClose', async () => { clearInterval(beat); });

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

    const untrack = sweep.track(socket, credentialHash);
    // 정상 ws 클라이언트는 ping 에 자동으로 pong 한다. 서버는 그 답을 기록만 한다.
    heartbeat.track(socket);
    socket.on('pong', () => heartbeat.pong(socket));

    /**
     * 이 채널에서 입력 중인 사람들을 알린다. 받는 사람마다 자기를 뺀 목록이어야 하므로
     * 수신자별로 한 번씩 보낸다 — 클라이언트가 자기를 거르게 하면 거르는 곳이 두 군데로
     * 갈라지고, 한쪽만 고쳐지는 버그가 된다.
     */
    const announceTyping = async (channelId: string) => {
      const ch = await pool.query(`select 1 from channel where id = $1`, [channelId]);
      if (!ch.rowCount) return;
      // 수신자 계산은 `audienceFor` 하나만 쓴다. 여기에 있던 인라인 사본이 바로 그 함수의
      // 주석이 경고하는 종류의 복사본이었다 — private 채널이 생긴 뒤에는 이 사본이
      // 'standard 면 전원' 으로 남아 비멤버에게 입력 중 표시를 뿌린다(누가 그 채널에 있는지가 샌다).
      const members = await audienceFor(pool, channelId);
      const who = typing.who(channelId);
      const recipients = members === 'all' ? [...connections.keys()] : members;
      for (const recipient of recipients) {
        emitEvent({
          type: 'typing.changed',
          channelId,
          accountIds: who.filter((id) => id !== recipient),
          audience: [recipient],
        });
      }
    };

    /**
     * 소켓으로 들어오는 유일한 메시지 종류다. 아무 것이나 보낼 수 있으므로 파싱 실패와
     * 모르는 타입에 서버가 죽지 않아야 한다.
     */
    socket.on('message', (raw) => {
      void (async () => {
        let parsed: unknown;
        // 아래 .catch 가 있으니 이 try 없이도 소켓은 죽지 않는다(테스트로 둘을 구분할 수
        // 없다). 그래도 남겨 두는 이유는 의도가 다르기 때문이다: 파싱 실패는 **예상된**
        // 입력이고, 바깥 catch 는 예상 못한 실패용이다. 바깥이 나중에 좁혀지면 이것이 남는다.
        try { parsed = JSON.parse(String(raw)); } catch { return; }
        if (typeof parsed !== 'object' || parsed === null) return;
        const msg = parsed as { type?: unknown; channelId?: unknown };
        if (typeof msg.channelId !== 'string') return;
        if (msg.type !== 'typing' && msg.type !== 'typing.stop') return;

        // 볼 수 없는 채널에 입력 상태를 넣으면, 채널의 존재와 멤버 활동이 새어 나간다.
        if (!(await assertChannelVisible(pool, msg.channelId, accountId))) return;

        if (msg.type === 'typing') typing.mark(msg.channelId, accountId);
        else typing.clear(msg.channelId, accountId);
        await announceTyping(msg.channelId);
      })().catch(() => { /* 인바운드 처리 실패로 소켓을 죽이지 않는다 */ });
    });

    const off = onEvent((e) => {
      if (visibleTo(e, accountId)) socket.send(JSON.stringify(e));
    });

    const count = (connections.get(accountId) ?? 0) + 1;
    connections.set(accountId, count);
    if (count === 1) emitEvent({ type: 'presence.changed', accountId, online: true });
    // 에이전트 presence 와 사람 presence (소켓 카운트) 를 합집합으로 낸다.
    // 사람 presence 를 건드리지 않고 에이전트만 얹으므로, 소켓이 닫혀도 에이전트는
    // presence.snapshot 에서 사라지지 않는다 (에이전트의 TTL 이 따로 적용됨).
    const onlineAgents = opts.agentPresence.online();
    const online = [...new Set([...connections.keys(), ...onlineAgents])];
    const snapshot: WsServerEvent = { type: 'presence.snapshot', online };
    socket.send(JSON.stringify(snapshot));

    socket.on('close', () => {
      untrack();
      heartbeat.untrack(socket);
      off();
      // 소켓이 닫히면 stop 이 오지 않는다 — 그래도 '입력 중'이 남으면 안 된다.
      // 어느 채널에 남아 있었는지 모르므로 전부 지우고, 남아 있던 채널에만 다시 알린다.
      const staleChannels = typing.channelsOf(accountId);
      typing.forget(accountId);
      for (const channelId of staleChannels) void announceTyping(channelId).catch(() => {});
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
