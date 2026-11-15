/**
 * S5.3 C1c-1 — 글 승인 넓은 체(`mayBeChatApproval`)가 판정(`parseChatApproval`·`parseAskPick` 의 카드 지목)을 **빠짐없이 덮는가**.
 * Rust 코어는 이 체에 걸리지 않은 글만 맡는다 — 체가 좁으면 승인이 될 글을 Rust 가 승인 없이 올린다.
 */
import { describe, expect, it } from 'vitest';
import { CHAT_APPROVAL_GUARD_WORDS, mayBeChatApproval, parseAskPick, parseChatApproval } from '../src/services/chatApproval.js';

const LINK = 'harkroom://message/0b6f8d2e-3c1a-4f5e-9a7b-1c2d3e4f5a6b';
const SEEDS = [
  '승인', '승인합니다', '허락해', '머지해', '머지했어', '진행해', '진행하세요', '진행 시켜', 'approve', 'approved', 'approves',
  '거절', '거절합니다', 'deny', 'denied', 'denies', '바이패스', 'bypass', 'bypass it', 'ok approve this', 'APPROVE', 'Deny',
  `[카드](${LINK}) 승인`, `${LINK}`, `${LINK} 1번`, `[x](${LINK})`, `HARKROOM://MESSAGE/0B6F8D2E-3C1A-4F5E-9A7B-1C2D3E4F5A6B 승인`,
  '미승인', '승인 요청', '승인?', '승인 안 해', '1번', 'A', '추천대로', '좋아요', '네', '`승인`', '> 승인', '```\n승인\n```',
];
const PADS = ['', ' ', '그럼 ', '네 ', '. ', '!', ' 해 주세요', '\n', '했습니다', ' it'];

describe('글 승인 넓은 체 — 판정이 볼 글은 모두 체에 걸린다', () => {
  it('씨앗 × 앞뒤 덧붙임', () => {
    let judged = 0;
    for (const seed of SEEDS) {
      for (const pre of PADS) {
        for (const post of PADS) {
          const body = `${pre}${seed}${post}`;
          const parsed = parseChatApproval(body);
          const pick = parseAskPick(body);
          const sees = parsed !== null || (pick?.cardIds.length ?? 0) > 0;
          if (sees) {
            judged += 1;
            expect(mayBeChatApproval(body), body).toBe(true);
          }
        }
      }
    }
    expect(judged, '판정이 잡는 글이 실제로 있어야 이 시험이 뜻이 있다').toBeGreaterThan(100);
  });

  it('평범한 글은 체에 안 걸린다(Rust 가 맡을 몫이 남는다)', () => {
    for (const body of ['안녕하세요', '오늘 회의 몇 시?', 'see you at 3', '1번', '좋아요']) {
      expect(mayBeChatApproval(body), body).toBe(false);
    }
  });

  it('낱말 목록은 모두 소문자다(체는 소문자 본문에 견준다)', () => {
    for (const w of CHAT_APPROVAL_GUARD_WORDS) expect(w).toBe(w.toLowerCase());
  });
});
