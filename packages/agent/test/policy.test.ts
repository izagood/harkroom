import { describe, it, expect } from 'vitest';
import { isCredentialFailure, nextBackoffMs, MAX_ATTEMPTS, exhausted } from '../src/policy.js';
import { MURMUR_ERROR_MARKER } from '../src/murmur.js';

describe('isCredentialFailure', () => {
  // 자격증명 오류는 재시도로 낫지 않는다 — 운영자가 키를 넣어야 한다. 무한 재시도로 감추면
  // 로그만 쌓이고 원인이 묻힌다.
  it('recognises a missing credential as an operator problem', () => {
    const err = new Error(
      'Could not resolve authentication method. Expected one of apiKey, authToken, credentials, config, or profile to be set.',
    );

    expect(isCredentialFailure(err)).toBe('harness-credential');
  });

  it('recognises a rejected key as an operator problem', () => {
    expect(isCredentialFailure(Object.assign(new Error('invalid x-api-key'), { status: 401 }))).toBe('harness-credential');
  });

  // #87 테스트: PTY 120컬럼 줄바꿈에 대한 내성
  // PTY 가 120컬럼에서 줄을 바꾸면 정규식이 깨질 수 있다
  describe('줄바꿈에 강건한 매칭 (#87 수정)', () => {
    // 120컬럼에서 "authentication" 이 잘리도록 문자열을 수동으로组装
    // "Could not resolve" (19자) + 101자 공백 = 120자, 그 뒤에 "authentication" 시작
    const line1 = 'Could not resolve authentication'.slice(0, 17); // 17자
    const line2 = 'authentication method. Expected one of'; // 35자
    // 전체가 120자에서 줄바꿈되었다고 가정: 첫 줄 103자, 두 번째 줄부터
    const foldedError = `${line1}${' '.repeat(120 - line1.length - 4)}\n${line2}`;

    it('줄바꿈된 자격증명 문구도 harness 실패로 감지한다', () => {
      const err = new Error(`harness 종료 1: ${foldedError}`);
      expect(isCredentialFailure(err)).toBe('harness-credential');
    });

    // x-api-key 가 줄바꿈된 경우 (예: "invalid x-api" 에서 줄바꿈 -> "key header")
    it('줄바꿈된 x-api-key 도 감지한다', () => {
      const xApiKeyFolded = 'invalid x-api\n-key header';
      const err = new Error(`harness 종료 1: ${xApiKeyFolded}`);
      expect(isCredentialFailure(err)).toBe('harness-credential');
    });
  });

  // #87 테스트: 출처 구분 - harness vs murmur
  describe('출처 구분 (#87 수정)', () => {
    it('murmur 클라이언트의 401 은 murmur 자격증명 실패다', () => {
      // murmur.ts 가 실제로 던지는 형식: "methodName: errorCode errorMessage"
      // MURMUR_ERROR_MARKER 로 출처 태그를 붙여야 한다 (murmur.ts 가 실제로那样做)
      const err = Object.assign(new Error('message.read: 401 Unauthorized'), { source: MURMUR_ERROR_MARKER });
      expect(isCredentialFailure(err)).toBe('murmur-credential');
    });

    it('murmur 클라이언트의 403 도 murmur 자격증명 실패다', () => {
      const err = Object.assign(new Error('message.post: 403 Forbidden'), { source: MURMUR_ERROR_MARKER });
      expect(isCredentialFailure(err)).toBe('murmur-credential');
    });

    it('harness tail 의 401/자격증명 문구는 harness 실패다', () => {
      // mentionTurn.ts 가 만드는 에러 형식: "harness 종료 code: tail"
      const harnessErr = new Error('harness 종료 1: Could not resolve authentication method');
      expect(isCredentialFailure(harnessErr)).toBe('harness-credential');
    });

    it('일반 하네스 실패는 Neither 다', () => {
      const err = new Error('harness 종료 1: some other error');
      expect(isCredentialFailure(err)).toBe('other');
    });

    it('네트워크 끊김 등은 other 다', () => {
      const err = new Error('socket hang up');
      expect(isCredentialFailure(err)).toBe('other');
    });
  });

  // 일시적 실패는 재시도로 낫는다 — 여기서 죽으면 네트워크가 흔들릴 때마다 러너가 멈춘다.
  it('treats a rate limit as transient', () => {
    expect(isCredentialFailure(Object.assign(new Error('rate limited'), { status: 429 }))).toBe('other');
  });

  it('treats a server error as transient', () => {
    expect(isCredentialFailure(Object.assign(new Error('overloaded'), { status: 529 }))).toBe('other');
  });

  it('treats an unrelated failure as transient', () => {
    expect(isCredentialFailure(new Error('socket hang up'))).toBe('other');
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
