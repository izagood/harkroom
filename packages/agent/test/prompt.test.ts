import { describe, expect, it } from 'vitest';
import { BODY_LIMIT, buildSystemPrompt, buildTurnPrompt, hasOwnPostSince } from '../src/prompt.js';

const msg = (seq: number, authorId: string, body: string, extra: Record<string, unknown> = {}) =>
  ({
    seq, authorId, body, id: `m${seq}`, channelId: 'c', threadRootId: null, kind: 'user',
    meta: {}, createdAt: '', editedAt: null, reactions: [], attachments: [], ...extra,
  }) as never;

describe('buildTurnPrompt', () => {
  const handles = { u1: 'jaebin', a1: 'forge', a2: 'scout' };

  it('첫 턴(lastFedSeq 0)은 자기 발화 포함 전체를 넘긴다', () => {
    const r = buildTurnPrompt({ messages: [msg(1, 'u1', '안녕'), msg(2, 'a1', '넵')], lastFedSeq: 0, meId: 'a1', handles });
    expect(r.prompt).toContain('jaebin: 안녕');
    expect(r.prompt).toContain('forge: 넵'); // 세션 이전 역사는 자기 것도 알려준다
    expect(r.fedSeq).toBe(2);
  });

  it('resume 턴은 경계 이후만, 자기 발화는 뺀다 — 세션이 이미 아는 말', () => {
    const r = buildTurnPrompt({
      messages: [msg(1, 'u1', '옛말'), msg(2, 'a1', '내 답'), msg(3, 'a2', '동료가 한 일'), msg(4, 'u1', '@forge 이어서')],
      lastFedSeq: 1, meId: 'a1', handles,
    });
    expect(r.prompt).not.toContain('옛말');
    expect(r.prompt).not.toContain('내 답');
    expect(r.prompt).toContain('scout: 동료가 한 일'); // 다중 에이전트 협업의 핵심 (spec §4)
    expect(r.fedSeq).toBe(4);
  });

  it('넘길 게 없으면(새 메시지가 전부 자기 발화) 빈 prompt — 그래도 fedSeq 는 전진한다', () => {
    const r = buildTurnPrompt({ messages: [msg(2, 'a1', '내 답')], lastFedSeq: 1, meId: 'a1', handles });
    expect(r.prompt).toBe('');
    expect(r.fedSeq).toBe(2);
  });

  // 브리프의 세 번째 케이스와 겉보기엔 같은 결과(빈 prompt)지만 원인이 다르다: 위 케이스는
  // "새 메시지가 있었는데 전부 걸러졌다"이고, 이건 "애초에 새 메시지 자체가 없었다"다. 둘을
  // 구분하지 않으면 fedSeq 전진 규칙(넘길 게 없어도 전진 vs 볼 게 없으니 그대로)을 같은
  // 코드 경로로 잘못 합쳐 놓고도 테스트가 통과해 버릴 수 있다.
  it('애초에 새 메시지가 없으면 fedSeq 는 그대로다 — 볼 것 자체가 없었으니 전진할 근거가 없다', () => {
    const r = buildTurnPrompt({ messages: [msg(1, 'u1', '예전 메시지')], lastFedSeq: 5, meId: 'a1', handles });
    expect(r.prompt).toBe('');
    expect(r.fedSeq).toBe(5);
  });

  // reply.ts 의 기존 정책(핸들 맵에 없는 작성자는 '알 수 없는 사용자')을 그대로 계승했는지
  // 확인한다 — avcs 투영이 만드는 system 메시지의 작성자가 handles 에 없을 수 있다.
  it('handles 맵에 없는 작성자는 "알 수 없는 사용자" 로 표시한다', () => {
    const r = buildTurnPrompt({ messages: [msg(1, 'ghost', '누구세요')], lastFedSeq: 0, meId: 'a1', handles });
    expect(r.prompt).toContain('알 수 없는 사용자: 누구세요');
  });

  // 첨부는 URL 도 미리보기도 없이 파일명만 있어도, 그 존재 자체를 모르는 것보다는 낫다 —
  // 에이전트가 "스크린샷을 첨부하셨는데 내용은 볼 수 없다"고 사실대로 답할 여지를 준다.
  it('첨부가 있는 메시지는 파일명을 함께 표시한다', () => {
    const withAttachment = msg(1, 'u1', '이거 봐줘', {
      attachments: [{ id: 'att1', filename: 'error.png', contentType: 'image/png', sizeBytes: 100 }],
    });
    const r = buildTurnPrompt({ messages: [withAttachment], lastFedSeq: 0, meId: 'a1', handles });
    expect(r.prompt).toContain('error.png');
  });
});

describe('hasOwnPostSince', () => {
  it('턴 시작 이후의 자기 발화만 인정한다', () => {
    const ms = [msg(5, 'a1', '옛 답'), msg(9, 'u1', '질문'), msg(10, 'a1', '새 답')];
    expect(hasOwnPostSince(ms, 'a1', 9)).toBe(true);
    expect(hasOwnPostSince(ms, 'a1', 10)).toBe(false);
  });
});

describe('buildSystemPrompt', () => {
  it('지시문과 guide 를 싣고 8000자 규칙을 명시한다', () => {
    const s = buildSystemPrompt({ handle: 'forge', channelName: 'dev', instructions: '친절하게', guide: 'G규칙' });
    expect(s).toContain('@forge');
    expect(s).toContain('친절하게');
    expect(s).toContain('G규칙');
    expect(s).toMatch(new RegExp(String(BODY_LIMIT)));
  });

  // 발화가 자율이 됐으므로, "어디에 쓸지"(murmur MCP message.post)를 지시문이 명시하지
  // 않으면 턴이 조용히 끝난다 — 회귀를 막는 핵심 문구.
  it('message.post 로 스스로 발화하라고 지시한다', () => {
    const s = buildSystemPrompt({ handle: 'forge', channelName: 'dev', instructions: '', guide: '' });
    expect(s).toContain('message.post');
  });
});
