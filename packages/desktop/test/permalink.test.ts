import { describe, it, expect } from 'vitest';
import { MESSAGE_PERMALINK_PREFIX, messagePermalink, parseMessagePermalink } from '@murmur/shared';

// #178 — 링크 문자열의 형식. 만드는 쪽과 읽는 쪽이 같은 규칙을 봐야 자기가 만든 링크를
// 자기가 열 수 있다. `mention.test.ts` 가 같은 이유로 shared 의 멘션 규칙을 여기서 지킨다.

const ID = '3f1c8a24-9b2e-4d6f-8a71-2c5e0b9d4f13';

describe('messagePermalink', () => {
  it('round-trips an id through the link form', () => {
    expect(parseMessagePermalink(messagePermalink(ID))).toBe(ID);
  });

  it('uses the shared prefix rather than an assembled string', () => {
    expect(messagePermalink(ID)).toBe(`${MESSAGE_PERMALINK_PREFIX}${ID}`);
  });
});

describe('parseMessagePermalink', () => {
  // 접두사만 보고 통과시키면 사람이 붙여넣은 아무 문자열이 그대로 서버 질의가 된다.
  it('rejects anything that is not a uuid', () => {
    expect(parseMessagePermalink('murmur://message/not-a-uuid')).toBeNull();
    expect(parseMessagePermalink('murmur://message/')).toBeNull();
    expect(parseMessagePermalink(`murmur://message/${ID}extra`)).toBeNull();
    // 자릿수가 하나 모자란 uuid 도 uuid 가 아니다.
    expect(parseMessagePermalink('murmur://message/3f1c8a24-9b2e-4d6f-8a71-2c5e0b9d4f1')).toBeNull();
  });

  it('rejects text that is not a message link at all', () => {
    expect(parseMessagePermalink(ID)).toBeNull();
    expect(parseMessagePermalink('https://example.com/message/' + ID)).toBeNull();
    expect(parseMessagePermalink('')).toBeNull();
  });

  // 복사한 링크에는 줄바꿈이 붙어 오는 일이 흔하다 — 그것 때문에 형식이 틀렸다고 하면 거짓말이다.
  it('tolerates surrounding whitespace', () => {
    expect(parseMessagePermalink(`  ${messagePermalink(ID)}\n`)).toBe(ID);
  });
});
