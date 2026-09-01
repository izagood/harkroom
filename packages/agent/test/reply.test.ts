import { describe, it, expect } from 'vitest';
import type { MessageRow } from '@murmur/shared';
import { buildReplyRequest, extractReply, BODY_LIMIT } from '../src/reply.js';

const msg = (id: string, body: string, authorId: string, extra: Partial<MessageRow> = {}): MessageRow => ({
  id, seq: 1, channelId: 'c1', threadRootId: null, authorId, body,
  kind: 'user', meta: {}, createdAt: '2026-09-01T00:00:00.000Z', editedAt: null, reactions: [], attachments: [], ...extra,
});

const ctx = {
  me: { id: 'agent-1', handle: 'rusalka' },
  guide: '워크스페이스 규칙: 읽기 전용 요청은 채팅으로만 끝낸다.',
  channelName: 'general',
  mention: msg('m2', '@rusalka 이 함수 왜 느린지 봐줄래?', 'human-1'),
  thread: [
    msg('m1', '캐시를 붙였는데 여전히 느려', 'human-1'),
    msg('m2', '@rusalka 이 함수 왜 느린지 봐줄래?', 'human-1'),
  ],
  handles: { 'human-1': 'jaebin', 'agent-1': 'rusalka' },
};

describe('buildReplyRequest', () => {
  it('tells the model who it is and where it is speaking', () => {
    const req = buildReplyRequest(ctx);

    expect(req.system).toContain('rusalka');
    expect(req.system).toContain('general');
  });

  // 서버가 스스로 규칙을 들고 있다(workspace.guide) — 러너가 그걸 그대로 맥락으로 넘긴다.
  it('carries the workspace guide into the system prompt', () => {
    const req = buildReplyRequest(ctx);

    expect(req.system).toContain('읽기 전용 요청은 채팅으로만 끝낸다');
  });

  // 서버는 본문을 8000자로 제한한다. 모델이 그걸 넘기면 발화 자체가 실패한다.
  it('states the length limit the server enforces', () => {
    const req = buildReplyRequest(ctx);

    expect(req.system).toContain(String(BODY_LIMIT));
  });

  it('renders the thread as turns attributed by handle', () => {
    const req = buildReplyRequest(ctx);
    const text = JSON.stringify(req.messages);

    expect(text).toContain('jaebin');
    expect(text).toContain('캐시를 붙였는데 여전히 느려');
    expect(text).toContain('이 함수 왜 느린지 봐줄래?');
  });

  // 자기 발화는 assistant 턴이어야 한다 — user 로 넘기면 모델이 자기 말을 남의 말로 읽는다.
  it('attributes its own past messages to the assistant role', () => {
    const req = buildReplyRequest({
      ...ctx,
      thread: [
        msg('m1', '로그 좀 봐줘', 'human-1'),
        msg('m2', '어느 구간을 볼까?', 'agent-1'),
        msg('m3', '@rusalka 전체', 'human-1'),
      ],
    });

    expect(req.messages.map((m) => m.role)).toEqual(['user', 'assistant', 'user']);
  });

  // 첫 턴은 user 여야 한다는 API 규칙 — 에이전트 발화로 시작하는 스레드도 있다.
  it('never starts the conversation with an assistant turn', () => {
    const req = buildReplyRequest({
      ...ctx,
      thread: [msg('m1', '내가 먼저 말했다', 'agent-1'), msg('m2', '@rusalka 답해', 'human-1')],
    });

    expect(req.messages[0]!.role).toBe('user');
  });

  // 첫 턴 규칙을 지키려고 앞선 자기 발화를 버리면 에이전트가 자기 말을 잊는다 —
  // 턴에서 빼되 맥락으로는 남겨야 한다.
  it('keeps the leading agent turns as context instead of dropping them', () => {
    const req = buildReplyRequest({
      ...ctx,
      thread: [
        msg('m1', '캐시 계층을 먼저 보겠다', 'agent-1'),
        msg('m2', '@rusalka 결과 알려줘', 'human-1'),
      ],
    });

    expect(req.messages[0]!.role).toBe('user');
    expect(req.system).toContain('캐시 계층을 먼저 보겠다');
  });
});

describe('extractReply', () => {
  it('joins the text blocks and drops thinking blocks', () => {
    const reply = extractReply({
      content: [
        { type: 'thinking', thinking: '내부 추론은 채널에 나가면 안 된다' },
        { type: 'text', text: '느린 이유는 N+1 조회입니다.' },
      ],
      stop_reason: 'end_turn',
    });

    expect(reply).toBe('느린 이유는 N+1 조회입니다.');
  });

  // 서버가 8000자를 거절하므로 여기서 잘라야 한다 — 안 자르면 발화가 통째로 실패한다.
  it('truncates a reply that would exceed the server body limit', () => {
    const reply = extractReply({
      content: [{ type: 'text', text: 'x'.repeat(BODY_LIMIT + 500) }],
      stop_reason: 'end_turn',
    });

    expect(reply).not.toBeNull();
    expect(reply!.length).toBeLessThanOrEqual(BODY_LIMIT);
    expect(reply!.endsWith('…')).toBe(true);
  });

  // 안전 거부는 침묵이 아니라 사람이 읽을 수 있는 사실로 남아야 한다.
  it('reports a refusal instead of posting an empty message', () => {
    const reply = extractReply({
      content: [],
      stop_reason: 'refusal',
      stop_details: { type: 'refusal', category: 'cyber', explanation: null },
    });

    expect(reply).not.toBeNull();
    expect(reply!.length).toBeGreaterThan(0);
    expect(reply).toContain('cyber');
  });

  it('returns null when the model produced nothing to say', () => {
    expect(extractReply({ content: [], stop_reason: 'end_turn' })).toBeNull();
  });
});
