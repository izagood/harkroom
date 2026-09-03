import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import type { FastifyInstance } from 'fastify';
import type { Pool } from 'pg';
import { z } from 'zod';
import type { AccountView } from '@murmur/shared';
import { denormalizeMentions } from '@murmur/shared';
import { emitEvent, onEvent } from '../events.js';
import type { Lifecycle } from '../lifecycle.js';
import { assertChannelVisible, audienceFor, getChannelDoc, listChannels } from '../services/channels.js';
import { listInbox, listMessages, markInboxRead, postMessage, searchMessages } from '../services/messages.js';
import { addReaction, isEmoji, MAX_REACTIONS_PER_ACTOR, removeReaction } from '../services/reactions.js';
import { getMemory, listMemory, MAX_MEMORY_ITEMS_PER_ACCOUNT, MAX_MEMORY_VALUE_LENGTH, setMemory } from '../services/memory.js';
import { proposeSkill, isValidSkillSlug } from '../services/skills.js';
import { GUIDE } from './guide.js';
import { recordRunnerVersion } from '../services/runnerVersion.js';

const MEMORY_SLUG_REGEX = /^core$|^mem\/[a-z0-9][a-z0-9_-]{0,63}((\/[a-z0-9][a-z0-9_-]{0,63})*)$/;

function isValidSlug(slug: string): boolean {
  return slug.length > 0 && slug.length <= 255 && MEMORY_SLUG_REGEX.test(slug);
}
import type { AgentPresence } from './presence.js';

function jsonResult(value: unknown) {
  return { content: [{ type: 'text' as const, text: JSON.stringify(value) }] };
}

function buildMcpServer(
  pool: Pool,
  account: AccountView,
  lifecycle: Lifecycle,
  presence: AgentPresence,
): McpServer {
  const server = new McpServer({ name: 'murmur', version: '0.1.0' });

  server.registerTool('workspace.guide', { description: '워크스페이스 규칙(avcs 사용 경계 포함)' },
    async () => jsonResult({ guide: GUIDE }));

  server.registerTool('account.me', { description: '내 계정 정보' },
    async () => jsonResult(account));

  // 에이전트도 사람과 같은 가시성 규칙을 받는다 — private 채널은 멤버인 에이전트만 본다.
  // admin 예외는 주지 않는다: 이 목록은 곧 `message.read` 로 이어지는 경로이고, admin 이
  // 목록에서 이름을 보는 절충은 사람이 운영 화면에서 쓰라고 만든 것이다.
  server.registerTool('channel.list', { description: '채널 목록' },
    async () => jsonResult({ channels: await listChannels(pool, account.id) }));

// <@id> 토큰을 @handle 로 역정규화한다. 에이전트가 @handle 로 생각하게 하기 위함.
  async function denormalizeMessagesBody(messages: { body: string }[]): Promise<{ body: string }[]> {
    const accounts = await pool.query(`select id, handle from account where disabled = false`);
    const idToHandle = new Map<string, string>();
    for (const row of accounts.rows) {
      idToHandle.set(row.id, row.handle);
    }
    return messages.map((msg) => ({ ...msg, body: denormalizeMentions(msg.body, idToHandle) }));
  }

  /**
   * 채널 문서 읽기(#188). **에이전트에게는 읽기만 준다 — 짝이 되는 쓰기 도구가 없다.**
   *
   * 문서는 덮어쓰기다. 에이전트에게 쓰기를 열면 "누가 바꿨나"·버전·되돌리기가 곧바로
   * 요구사항으로 딸려 온다(사람은 자기가 지운 단락을 에이전트가 지운 것과 구별해야 한다).
   * 그것은 별개 결정이므로 v1 에서는 만들지 않는다.
   *
   * 읽기를 여는 이유는 이 기능의 존재 이유 자체다: 새 세션의 에이전트가 채널의 전제를
   * 재구성할 곳이 필요하다. 그 목적에는 읽기만으로 충분하다.
   *
   * 별도 도구인 이유: `channel.list` 에 본문을 실으면 채널 수만큼 문서 전문이 목록 응답에
   * 실려 컨텍스트를 먹는다. 문서는 필요할 때 하나만 읽는 것이다.
   */
  server.registerTool('channel.doc', {
    description: '채널 문서 조회(읽기 전용)',
    inputSchema: { channelId: z.string().uuid() },
  }, async ({ channelId }) => {
    if (!(await assertChannelVisible(pool, channelId, account.id))) {
      return jsonResult({ error: { code: 'forbidden', message: 'not a member of this channel' } });
    }
    return jsonResult(await getChannelDoc(pool, channelId));
  });

  server.registerTool('message.read', {
    description: '채널/스레드 메시지 읽기(seq 커서)',
    inputSchema: {
      channelId: z.string().uuid(),
      since: z.number().int().min(0).optional(),
      limit: z.number().int().min(1).max(500).optional(),
      threadRootId: z.string().uuid().optional(),
    },
  }, async ({ channelId, since, limit, threadRootId }) => {
    if (!(await assertChannelVisible(pool, channelId, account.id))) {
      return jsonResult({ error: { code: 'forbidden', message: 'not a member of this dm channel' } });
    }
    const messages = await listMessages(pool, channelId, { since, limit, threadRootId: threadRootId ?? null });
    const denormalized = await denormalizeMessagesBody(messages);
    return jsonResult({ messages: denormalized });
  });

  server.registerTool('message.search', {
    description: '메시지 전문 검색',
    inputSchema: { query: z.string().min(1).max(256) },
  }, async ({ query }) => {
    // 검색 쿼리의 @handle 도 <@id> 로 정규화해야 한다 — 이름을 바꾼 뒤 옛 검색이 안 맞으면 안 된다.
    const accounts = await pool.query(`select id, lower(handle) as handle from account where disabled = false`);
    const handleToId = new Map<string, string>();
    for (const row of accounts.rows) {
      handleToId.set(row.handle, row.id);
    }
    // 쿼리의 @handle 을 <@id> 로 정규화
    let normalizedQuery = query;
    for (const [handle, id] of handleToId) {
      const pattern = new RegExp(`(^|[^a-zA-Z0-9_-])@(${handle})(?![a-zA-Z0-9_-])`, 'gi');
      normalizedQuery = normalizedQuery.replace(pattern, `$1<@${id}>`);
    }
    const messages = await searchMessages(pool, account.id, normalizedQuery);
    const denormalized = await denormalizeMessagesBody(messages);
    return jsonResult({ messages: denormalized });
  });

  server.registerTool('message.post', {
    description: '채널 또는 스레드에 메시지 발화',
    inputSchema: {
      channelId: z.string().uuid(),
      body: z.string().min(1).max(8000),
      threadRootId: z.string().uuid().optional(),
      alsoInChannel: z.boolean().optional(),
    },
  }, async ({ channelId, body, threadRootId, alsoInChannel }) => {
    if (!(await assertChannelVisible(pool, channelId, account.id))) {
      return jsonResult({ error: { code: 'forbidden', message: 'not a member of this dm channel' } });
    }
    const posted = await postMessage(pool, {
      channelId, authorId: account.id, body, threadRootId: threadRootId ?? null, alsoInChannel,
    });
    // 에이전트는 첨부를 붙이지 않는다(도구에 그 입력이 없다). 그래도 합 타입이므로 확인해야
    // 하고, 확인 자체가 나중에 도구가 첨부를 받게 될 때의 자리를 남겨 둔다.
    if (posted.failure) {
      return jsonResult({ error: { code: 'bad_attachment', message: 'attachments must be your own, unused uploads' } });
    }
    const { message, notified, replayed } = posted;
    if (!replayed) {
      const audience = await audienceFor(pool, channelId);
      emitEvent({ type: 'message.created', message, audience });
      for (const accountId of notified) emitEvent({ type: 'inbox.updated', accountId });
    }
    return jsonResult({ message });
  });

  // #144: 진행 설명 메시지 — 결과 발화로 세지 않고, 사용자가 읽을 수 있어야 뜻이 있다.
  // kind='progress'로 저장되어 message.read 응답에서 구분할 수 있다.
  server.registerTool('message.progress', {
    description: '긴 작업 시작 시 진행 설명 메시지(결과 발화로 세지 않음)',
    inputSchema: {
      channelId: z.string().uuid(),
      body: z.string().min(1).max(8000),
      threadRootId: z.string().uuid().optional(),
    },
  }, async ({ channelId, body, threadRootId }) => {
    if (!(await assertChannelVisible(pool, channelId, account.id))) {
      return jsonResult({ error: { code: 'forbidden', message: 'not a member of this dm channel' } });
    }
    const posted = await postMessage(pool, {
      channelId, authorId: account.id, body, threadRootId: threadRootId ?? null, kind: 'progress',
    });
    if (posted.failure) {
      return jsonResult({ error: { code: 'bad_attachment', message: 'attachments must be your own, unused uploads' } });
    }
    const { message, notified, replayed } = posted;
    if (!replayed) {
      const audience = await audienceFor(pool, channelId);
      emitEvent({ type: 'message.created', message, audience });
      for (const accountId of notified) emitEvent({ type: 'inbox.updated', accountId });
    }
    return jsonResult({ message });
  });

  server.registerTool('message.react', {
    description: '메시지에 리액션 추가',
    inputSchema: {
      channelId: z.string().uuid(),
      messageId: z.string().uuid(),
      emoji: z.string().min(1).max(32),
    },
  }, async ({ channelId, messageId, emoji }) => {
    if (!isEmoji(emoji)) {
      return jsonResult({ error: { code: 'bad_request', message: 'a reaction must be a single emoji' } });
    }
    if (!(await assertChannelVisible(pool, channelId, account.id))) {
      return jsonResult({ error: { code: 'forbidden', message: 'not a member of this dm channel' } });
    }
    const result = await addReaction(pool, { channelId, messageId, accountId: account.id, emoji });
    if (result === 'not_found') {
      return jsonResult({ error: { code: 'not_found', message: 'no such message in this channel' } });
    }
    if (result === 'too_many') {
      return jsonResult({
        error: { code: 'too_many_reactions', message: `at most ${MAX_REACTIONS_PER_ACTOR} reactions per message` },
      });
    }
    // REST 라우트와 **똑같이** 이벤트를 낸다. 이게 없으면 리액션은 DB 에만 남고 붙어 있는
    // 데스크탑은 다시 조회할 때까지 못 본다 — 에이전트가 👀 를 다는 목적이 "사람이 지금
    // 본다"인데 그 목적이 사라진다(#99). 두 표면이 같은 규칙을 갖는다는 계약의 일부다.
    emitEvent({
      type: 'reaction.added', channelId, messageId, emoji,
      accountId: account.id, audience: await audienceFor(pool, channelId),
    });
    return jsonResult({ emoji });
  });

  server.registerTool('message.unreact', {
    description: '메시지에서 리액션 제거',
    inputSchema: {
      channelId: z.string().uuid(),
      messageId: z.string().uuid(),
      emoji: z.string().min(1).max(32),
    },
  }, async ({ channelId, messageId, emoji }) => {
    if (!(await assertChannelVisible(pool, channelId, account.id))) {
      return jsonResult({ error: { code: 'forbidden', message: 'not a member of this dm channel' } });
    }
    await removeReaction(pool, { messageId, accountId: account.id, emoji });
    // 제거도 REST 와 같이 이벤트를 낸다 — 없는 것을 떼는 것도 성공이라(REST 주석 참고)
    // 이벤트를 조건부로 내지 않는다. 결과 상태가 같으니 재시도가 안전해야 한다.
    emitEvent({
      type: 'reaction.removed', channelId, messageId, emoji,
      accountId: account.id, audience: await audienceFor(pool, channelId),
    });
    return jsonResult({ ok: true });
  });

  server.registerTool('inbox.poll', {
    description: '미읽음 inbox 조회. timeoutMs>0이면 새 항목이 올 때까지 long-poll',
    inputSchema: { timeoutMs: z.number().int().min(0).max(25_000).optional(), version: z.string().optional() },
  }, async ({ timeoutMs, version }) => {
    // 버전이 오면 기록한다 — 배포가 넣어 준 빌드 시점 값이다(#129). 값이 바뀔 때만
    // 실제로 쓰이므로 이 핫 패스에 쓰기 비용이 없다(services/runnerVersion.ts 주석).
    if (version) {
      await recordRunnerVersion(pool, account.id, version);
    }
    // inbox.poll 은 에이전트의 유일한 주기 신호다. 폴이 오면 온라인으로 표시한다.
    // presence 는 필수 인자다 — 옵셔널로 두면 배선이 끊겨도 컴파일이 통과하고
    // presence 가 조용히 no-op 이 된다.
    presence.mark(account.id);
    const fetchUnread = async () => {
      const entries = await listInbox(pool, account.id, { unreadOnly: true });
      if (!entries.length) return { entries, messages: [] };
      const ids = entries.map((e) => e.messageId);
      const msgs = await pool.query(
        `select id, seq::int as seq, channel_id as "channelId", thread_root_id as "threadRootId",
           author_id as "authorId", body, kind, meta, created_at as "createdAt",
           also_in_channel as "alsoInChannel"
         from message where id = any($1) order by seq`, [ids]);
      const denormalized = await denormalizeMessagesBody(msgs.rows);
      return { entries, messages: denormalized };
    };
    // Subscribe before the first fetch so an inbox.updated arriving during that DB round trip is
    // not lost in the gap between "query returned empty" and "we started listening" — it sets
    // `woken`, and we skip the wait and refetch immediately instead of blocking for timeoutMs.
    let woken = false;
    let notify: (() => void) | null = null;
    const off = onEvent((e) => {
      if (e.type === 'inbox.updated' && e.accountId === account.id) {
        woken = true;
        notify?.();
      }
    });
    // 종료가 시작되면 park를 걷어낸다. 이 응답은 hijack된 raw 소켓이라 Fastify close()가
    // 기다려 주지 않으므로, park를 유지하면 정상 타임아웃이 아니라 transport error로 절단된다.
    // draining 중에 도착한 poll은 애초에 park하지 않는다 — 종료 중 서버가 25초를 붙잡는 것도
    // 같은 절단이다. enterPoll은 그동안 종료가 이 응답을 기다리게 만든다.
    let draining = false;
    const offDrain = lifecycle.onDrain(() => {
      draining = true;
      notify?.();
    });
    const releasePoll = lifecycle.enterPoll();
    try {
      let result = await fetchUnread();
      let waited = false;
      if (!result.entries.length && !woken && !draining && (timeoutMs ?? 0) > 0) {
        await new Promise<void>((resolve) => {
          const timer = setTimeout(resolve, timeoutMs);
          notify = () => { clearTimeout(timer); resolve(); };
        });
        waited = true;
      }
      // Refetch whenever the first read was empty and either a wake fired (whether during the
      // initial DB round trip or during the wait) or we sat through the wait — the latter is a
      // safety net against a wake event that lands in a gap our flag-based tracking still misses.
      if (!result.entries.length && (woken || waited)) {
        result = await fetchUnread();
      }
      return jsonResult(result);
    } finally {
      off();
      offDrain();
      releasePoll();
    }
  });

  // inbox.poll 만 있으면 미읽음을 소비할 수 없어, MCP 로만 붙은 에이전트가 같은 멘션에 영원히
  // 반복 응답한다. 루프가 성립하려면 읽음 처리도 같은 표면에 있어야 한다.
  // messageId 가 아니라 inbox entry id 를 받는다 — entry 가 계정에 묶여 있고, 서비스가
  // account_id 로 스코프를 걸어 남의 inbox 는 소비되지 않는다.
  server.registerTool('inbox.read', {
    description: 'inbox 항목을 읽음 처리(자기 inbox 한정). ids 는 inbox.poll 이 준 entry id',
    inputSchema: { ids: z.array(z.number().int()).min(1).max(200) },
  }, async ({ ids }) => {
    const read = await markInboxRead(pool, account.id, ids);
    return jsonResult({ read });
  });

  server.registerTool('work.link', {
    description: 'intent를 기존 대화 스레드에 작업 스레드로 연결(명시 링크가 자동 개설을 이긴다)',
    inputSchema: {
      repo: z.string().min(1).max(128),
      intentOid: z.string().min(1).max(128),
      threadRootMessageId: z.string().uuid(),
    },
  }, async ({ repo, intentOid, threadRootMessageId }) => {
    const msg = await pool.query(`select channel_id from message where id = $1`, [threadRootMessageId]);
    if (!msg.rowCount) {
      return jsonResult({ error: { code: 'invalid_thread', message: 'thread root message does not exist' } });
    }
    // repo -> 채널 조회에 **가시성 술어를 넣지 않는다.** 이건 avcs 투영의 배선이고,
    // `listBoundRepos` 와 같은 판단이다: 투영은 사람이 아니라 서버가 하는 일이라 '보는
    // 계정'이 없다. 여기에 멤버십을 걸면 private 채널에 바인딩된 repo 만 조용히 work_thread
    // 연결을 잃는다. 결과가 새지 않는 이유는 그 다음 단계다 — 이 채널의 메시지를 실제로
    // 읽는 것은 `message.read` 이고, 거기에는 술어가 걸려 있다. 즉 투영은 되고, 보이는
    // 사람이 그 채널의 멤버로 제한된다.
    const boundChannel = await pool.query(
      `select id from channel where repo = $1 and kind = 'standard'`, [repo],
    );
    if (!boundChannel.rowCount || boundChannel.rows[0].id !== msg.rows[0].channel_id) {
      return jsonResult({
        error: { code: 'invalid_thread', message: 'thread root message does not belong to a channel bound to this repo' },
      });
    }
    await pool.query(
      `insert into work_thread (repo, intent_oid, thread_root_message_id) values ($1, $2, $3)
       on conflict (repo, intent_oid) do update set thread_root_message_id = excluded.thread_root_message_id`,
      [repo, intentOid, threadRootMessageId],
    );
    return jsonResult({ ok: true });
  });

  // memory.list — slug만 돌려주고 값은 주지 않는다(값이 새면 목록 조회가 곧 전체 주입이 된다).
  server.registerTool('memory.list', {
    description: '에이전트 메모리 slug 목록(값은 포함 안 함)',
  }, async () => {
    const slugs = await listMemory(pool, account.id);
    return jsonResult({ slugs });
  });

  server.registerTool('memory.get', {
    description: '메모리 조회',
    inputSchema: { slug: z.string().min(1) },
  }, async ({ slug }) => {
    if (!isValidSlug(slug)) {
      return jsonResult({ error: { code: 'invalid_slug', message: 'invalid slug format' } });
    }
    const memory = await getMemory(pool, account.id, slug);
    if (!memory) {
      return jsonResult({ error: { code: 'not_found', message: 'memory not found' } });
    }
    return jsonResult({ slug: memory.slug, value: memory.value, updatedAt: memory.updatedAt.toISOString() });
  });

  // value 가 null 이면 삭제 — 키 부재가 아니라 명시적 null 이 삭제다.
  // .nullable() 은 "값이 반드시 있고 null 일 수 있다"를 의미한다.
  server.registerTool('memory.set', {
    description: '메모리 저장 또는 삭제(value가 null이면 삭제)',
    inputSchema: { slug: z.string().min(1), value: z.string().max(MAX_MEMORY_VALUE_LENGTH).nullable() },
  }, async ({ slug, value }) => {
    if (!isValidSlug(slug)) {
      return jsonResult({ error: { code: 'invalid_slug', message: 'invalid slug format' } });
    }
    // 길이는 위 zod `.max()` 가 이미 거른다 — 여기서 또 재지 않는다.
    // 삭제는 멱등이라 '없는 것을 지웠다'는 오류가 아니다(services/memory.ts 주석).
    const result = await setMemory(pool, account.id, slug, value);
    if (result === 'too_many') {
      return jsonResult({
        error: { code: 'too_many', message: `at most ${MAX_MEMORY_ITEMS_PER_ACCOUNT} memories per account` },
      });
    }
    return jsonResult({ ok: true });
  });

  // skill.propose — 에이전트가 스킬을 제안한다. 미승인 상태로 들어가고 채널에 알림이 간다.
  server.registerTool('skill.propose', {
    description: '워크스페이스 스킬 제안(미승인 상태, 채널에 알림)',
    inputSchema: {
      slug: z.string().min(1).max(40),
      body: z.string().min(1).max(8000),
      channelId: z.string().uuid(),
    },
  }, async ({ slug, body, channelId }) => {
    if (!isValidSkillSlug(slug)) {
      return jsonResult({ error: { code: 'invalid_slug', message: 'slug must be [a-z0-9-]{2,40}' } });
    }
    if (!(await assertChannelVisible(pool, channelId, account.id))) {
      return jsonResult({ error: { code: 'forbidden', message: 'not a member of this channel' } });
    }
    const result = await proposeSkill(pool, { slug, body, proposedBy: account.id, channelId });
    return jsonResult(result);
  });

  return server;
}

export async function registerMcp(
  app: FastifyInstance,
  pool: Pool,
  lifecycle: Lifecycle,
  agentPresence: AgentPresence,
): Promise<void> {
  app.post('/mcp', async (req, reply) => {
    if (!req.account || req.account.kind !== 'agent') {
      return reply.code(req.account ? 403 : 401)
        .send({ error: { code: 'agent_only', message: 'MCP surface requires an agent PAT' } });
    }
    const server = buildMcpServer(pool, req.account, lifecycle, agentPresence);
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
    reply.hijack();
    reply.raw.on('close', () => {
      void transport.close().catch(() => {});
      void server.close().catch(() => {});
    });
    try {
      await server.connect(transport);
      await transport.handleRequest(req.raw, reply.raw, req.body);
    } catch {
      if (!reply.raw.headersSent) {
        reply.raw.writeHead(500, { 'content-type': 'application/json' });
        reply.raw.end(JSON.stringify({ error: { code: 'internal', message: 'mcp transport failure' } }));
      }
    }
  });
}
