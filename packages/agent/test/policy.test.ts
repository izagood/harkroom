import { describe, it, expect } from 'vitest';
import { isCredentialFailure, nextBackoffMs, MAX_ATTEMPTS, exhausted } from '../src/policy.js';

describe('isCredentialFailure', () => {
  // 자격증명 오류는 재시도로 낫지 않는다 — 운영자가 키를 넣어야 한다. 무한 재시도로 감추면
  // 로그만 쌓이고 원인이 묻힌다.
  it('recognises a missing credential as an operator problem', () => {
    const err = new Error(
      'Could not resolve authentication method. Expected one of apiKey, authToken, credentials, config, or profile to be set.',
    );

    expect(isCredentialFailure(err)).toBe(true);
  });

  it('recognises a rejected key as an operator problem', () => {
    expect(isCredentialFailure(Object.assign(new Error('invalid x-api-key'), { status: 401 }))).toBe(true);
  });

  // 일시적 실패는 재시도로 낫는다 — 여기서 죽으면 네트워크가 흔들릴 때마다 러너가 멈춘다.
  it('treats a rate limit as transient', () => {
    expect(isCredentialFailure(Object.assign(new Error('rate limited'), { status: 429 }))).toBe(false);
  });

  it('treats a server error as transient', () => {
    expect(isCredentialFailure(Object.assign(new Error('overloaded'), { status: 529 }))).toBe(false);
  });

  it('treats an unrelated failure as transient', () => {
    expect(isCredentialFailure(new Error('socket hang up'))).toBe(false);
  });
});

describe('nextBackoffMs', () => {
  // inbox.poll 은 미읽음이 있으면 즉시 반환한다(park 는 비어 있을 때만). 답변이 실패하면
  // 읽음 처리를 안 하므로, 백오프가 없으면 같은 항목으로 타이트 루프가 돈다.
  it('grows on repeated failure', () => {
    expect(nextBackoffMs(1_000)).toBeGreaterThan(1_000);
  });

  it('stops growing at a ceiling so recovery stays possible', () => {
    let ms = 1_000;
    for (let i = 0; i < 20; i += 1) ms = nextBackoffMs(ms);

    expect(ms).toBeLessThanOrEqual(60_000);
  });
});

describe('exhausted', () => {
  // 영원히 실패하는 한 건이 나머지 멘션을 영구히 가로막아선 안 된다.
  it('gives up on an entry after a bounded number of attempts', () => {
    expect(exhausted(MAX_ATTEMPTS - 1)).toBe(false);
    expect(exhausted(MAX_ATTEMPTS)).toBe(true);
  });
});
