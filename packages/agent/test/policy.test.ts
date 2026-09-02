import { describe, it, expect } from 'vitest';
import { isCredentialFailure, nextBackoffMs, MAX_ATTEMPTS, exhausted } from '../src/policy.js';
import { MURMUR_ERROR_SOURCE } from '../src/policy.js';
import { MurmurAgentClient } from '../src/murmur.js';

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

  // #87: PTY 는 cols 120 으로 스폰되고(pty.ts), isCredentialFailure 가 보는 것은 그 출력의
  // tail 이다. 소프트 랩은 **어느 자리에서든** 개행을 끼워 넣고, 원문의 공백을 먹는 경우와
  // 남기는 경우가 둘 다 있다. 그래서 한두 자리만 흉내내는 대신 **모든 자리**를 돌린다 —
  // 예전 구현은 그중 일부에서만 통했다(개행만 지우면 공백을 먹은 랩을 놓친다).
  describe('줄바꿈 위치와 무관하게 감지한다 (#87)', () => {
    const phrase = 'Could not resolve authentication method';

    it('문구 안 모든 위치에서 줄바꿈돼도 harness 자격증명 실패로 감지한다', () => {
      for (let i = 1; i < phrase.length; i += 1) {
        // 공백을 남기는 랩과 먹는 랩을 둘 다 만든다.
        const keepsSpace = `harness 종료 1: ${phrase.slice(0, i)}\n${phrase.slice(i)} (tail)`;
        const eatsSpace = `harness 종료 1: ${phrase.slice(0, i).trimEnd()}\n${phrase.slice(i).trimStart()} (tail)`;
        expect(isCredentialFailure(new Error(keepsSpace)), `공백 유지 랩 @${i}`).toBe('harness-credential');
        expect(isCredentialFailure(new Error(eatsSpace)), `공백 소비 랩 @${i}`).toBe('harness-credential');
      }
    });

    it('x-api-key 가 하이픈 자리에서 접혀도 감지한다', () => {
      expect(isCredentialFailure(new Error('harness 종료 1: invalid x-api-\nkey header'))).toBe('harness-credential');
      expect(isCredentialFailure(new Error('harness 종료 1: invalid x-api\n-key header'))).toBe('harness-credential');
    });

    // `authentication_error` 는 밑줄이 있는 API 에러 코드다 — 밑줄을 공백으로 오인해
    // `authentication\s+error` 로 바꾸면 이 신호를 통째로 잃는다(실제로 그 실수를 했다).
    it('authentication_error 코드를 여전히 감지한다 (밑줄이 공백이 아니다)', () => {
      expect(isCredentialFailure(new Error('harness 종료 1: {"type":"authentication_error"}'))).toBe('harness-credential');
      expect(isCredentialFailure(new Error('harness 종료 1: {"type":"authentication_\nerror"}'))).toBe('harness-credential');
    });
  });

  // #87: 이 함수는 main.ts 에서 턴 **전체**를 감싸는 catch 에 쓰이므로 murmur 호출 실패도
  // 같은 자리로 들어온다. 출처를 못 가리면 murmur PAT 만료를 "claude CLI 로 로그인해라"로
  // 안내한다 — 운영자가 엉뚱한 곳을 확인하러 간다.
  describe('출처 구분 (#87)', () => {
    it('murmur 클라이언트의 401 은 murmur 자격증명 실패다', () => {
      const err = Object.assign(new Error('accounts 실패: 401'), { source: MURMUR_ERROR_SOURCE, status: 401 });
      expect(isCredentialFailure(err)).toBe('murmur-credential');
    });

    it('murmur 클라이언트의 403 도 murmur 자격증명 실패다', () => {
      const err = Object.assign(new Error('accounts 실패: 403'), { source: MURMUR_ERROR_SOURCE, status: 403 });
      expect(isCredentialFailure(err)).toBe('murmur-credential');
    });

    // 판정은 status 로만 한다 — 문구에 "401" 이 우연히 들어간 murmur 에러를 자격증명
    // 실패로 오인하면 러너가 멀쩡한 상황에서 멈춘다.
    it('murmur 에러 문구에 401 이 있어도 status 가 없으면 자격증명 실패가 아니다', () => {
      const err = Object.assign(new Error('message.post: bad_request 401 은 본문에 있을 뿐'), { source: MURMUR_ERROR_SOURCE });
      expect(isCredentialFailure(err)).toBe('other');
    });

    it('harness tail 의 자격증명 문구는 harness 실패다', () => {
      expect(isCredentialFailure(new Error('harness 종료 1: Could not resolve authentication method'))).toBe('harness-credential');
    });

    it('일반 하네스 실패와 네트워크 끊김은 other 다', () => {
      expect(isCredentialFailure(new Error('harness 종료 1: some other error'))).toBe('other');
      expect(isCredentialFailure(new Error('socket hang up'))).toBe('other');
    });

    // 태그를 손으로 붙인 객체가 아니라 **프로덕션 클라이언트가 실제로 던지는 에러**를 태운다.
    // 손으로 만들면 murmur.ts 가 태그·status 를 붙이는 것을 그만둬도 이 테스트가 초록이다.
    it('MurmurAgentClient 가 던지는 401 에러가 실제로 murmur 로 판정된다', async () => {
      const original = globalThis.fetch;
      globalThis.fetch = (async () => new Response('nope', { status: 401 })) as typeof fetch;
      try {
        const client = new MurmurAgentClient('http://localhost:3400', 'murp_dead');
        const err = await client.accounts().then(() => null, (e: unknown) => e);
        expect(err).toBeInstanceOf(Error);
        expect(isCredentialFailure(err)).toBe('murmur-credential');
      } finally {
        globalThis.fetch = original;
      }
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
