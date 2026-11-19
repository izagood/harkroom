import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { isExplicitApproval, matchAskPick, parseAskPick, parseChatApproval } from '../src/services/chatApproval.js';

// P3b-1b 골든 대조 — 이 픽스처가 지금 TS 판정과 같은지 지킨다. Rust(core::chat_approval_parse)도 같은 파일을 읽어 대조한다.
// TS 판정을 고쳤으면 이 파일의 want·match 를 TS 출력으로 다시 만든다.
type Gold = {
  askOptions: { id: string; label: string; recommended?: boolean }[];
  chatApproval: { body: string; want: unknown; explicit: boolean }[];
  askPick: { body: string; want: unknown; match: string | null }[];
};
const gold = JSON.parse(readFileSync(fileURLToPath(new URL('./fixtures/chat-parse-golden.json', import.meta.url)), 'utf8')) as Gold;

describe('chat-parse-golden.json 이 TS 판정과 같다', () => {
  it.each(gold.chatApproval.map((c) => [c.body, c] as const))('approval %j', (body, c) => {
    expect(parseChatApproval(body)).toEqual(c.want);
    expect(isExplicitApproval(body)).toBe(c.explicit);
  });
  it.each(gold.askPick.map((c) => [c.body, c] as const))('askPick %j', (body, c) => {
    const p = parseAskPick(body);
    expect(p).toEqual(c.want);
    const m = p ? matchAskPick(gold.askOptions, p.pick) : null;
    expect(m ? (m.ok ? m.id : m.why) : null).toBe(c.match);
  });
});
