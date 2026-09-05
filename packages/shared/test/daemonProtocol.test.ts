/**
 * `#431` 2단계-b — IPC 프로토콜의 회귀선.
 *
 * 다섯 회귀선이 지키는 것은 각각 **조용히 깨지는 성질** 하나씩이다. 다섯 다 "기능이
 * 동작하는가"를 재지 않는다 — 기능은 다 동작하는 채로 깨질 수 있는 것들이기 때문이다:
 *
 * 1. 라인 상한 — 없어도 정상 트래픽은 멀쩡하다. 폭주할 때만 OOM 으로 나타난다
 * 2. 부분 수신 — 로컬 소켓은 작은 메시지를 대개 한 청크로 준다. 커질 때만 깨진다
 * 3. **상수시간 비교 — `===` 로 바꿔도 모든 인증이 정상 동작한다**
 * 4. 버전 불일치 — 버전이 갈리는 날에만 드러난다
 * 5. `incarnationId` — 재시작이 빠를 때만 드러난다
 *
 * **3번이 가장 중요하다.** 나머지 넷이 전부 통과하는 상태에서 `timingSafeEqual` 을
 * `===` 로 바꾸면 토큰이 맞으면 통과하고 틀리면 거절하는 동작이 **완전히 그대로**다.
 * 그래서 이 파일은 결과값이 아니라 **`timingSafeEqual` 호출 자체**를 잰다.
 */
import { describe, expect, it, vi } from 'vitest';

// **`timingSafeEqual` 호출 자체를 재기 위한 모듈 모킹.** 결과값만 재는 테스트로는
// `===` 로의 교체를 잡을 수 없다(위 파일 주석 참조). 원본을 그대로 통과시키는
// 스파이라 동작은 바뀌지 않고, 호출됐다는 사실만 관측 가능해진다.
const timingSafeEqualSpy = vi.hoisted(() => vi.fn());
vi.mock('node:crypto', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:crypto')>();
  timingSafeEqualSpy.mockImplementation(actual.timingSafeEqual);
  return { ...actual, timingSafeEqual: timingSafeEqualSpy };
});

import {
  acceptRunnerExit,
  checkHello,
  DAEMON_PROTOCOL_VERSION,
  encodeLine,
  LineTooLongError,
  MAX_LINE_BYTES,
  NdjsonDecoder,
  newIncarnationId,
  parseRequest,
  tokensMatch,
  type DaemonError,
  type DecodedLine,
  type RunnerExitEvent,
} from '../src/daemonProtocol.js';

/** 실패한 줄에서 에러를 꺼낸다. 성공이면 그 자리에서 테스트를 세운다. */
function errorOf(line: DecodedLine | undefined): DaemonError {
  expect(line).toBeDefined();
  if (line === undefined || line.ok) throw new Error('실패한 줄이어야 한다');
  return line.error;
}

describe('NDJSON 프레이밍 — 라인 바이트 상한', () => {
  it('상한을 넘긴 줄을 line-too-long 으로 거절하고, 그것은 invalid-json 과 다르다', () => {
    // **이 구분이 회귀선의 요점이다.** 둘을 한 갈래로 뭉치면 "상대가 깨진 JSON 을
    // 보냈다"(버그 리포트)와 "상대가 우리를 터뜨리려 한다"(연결을 끊을 사건)가 같은
    // 로그로 남는다.
    const limit = 64;
    const decoder = new NdjsonDecoder(limit);

    const overflow = JSON.stringify({ type: 'ping', pad: 'x'.repeat(200) });
    expect(Buffer.byteLength(overflow, 'utf8')).toBeGreaterThan(limit);

    const results = decoder.push(`${overflow}\n`);
    expect(results).toHaveLength(1);
    expect(errorOf(results[0]).code).toBe('line-too-long');
    expect(errorOf(results[0]).code).not.toBe('invalid-json');

    // 대조 — 상한 안의 깨진 JSON 은 invalid-json 이다. 두 갈래가 실제로 갈린다.
    const broken = new NdjsonDecoder(limit).push('{"nope\n');
    expect(errorOf(broken[0]).code).toBe('invalid-json');
  });

  it('개행이 오기 전에 상한을 넘기면 그 자리에서 막고 버퍼를 비운다', () => {
    // 줄이 완성될 때까지 기다렸다 재면 이미 늦다 — 개행 없이 쏟아붓는 것이 바로
    // 이 상한이 막으려는 사고다.
    const decoder = new NdjsonDecoder(64);
    const results = decoder.push('x'.repeat(200)); // 개행이 아예 없다
    expect(results).toHaveLength(1);
    expect(errorOf(results[0]).code).toBe('line-too-long');
    expect(decoder.pendingBytes).toBe(0); // 넘긴 바이트를 들고 있지 않다
  });

  it('상한을 넘긴 줄의 꼬리를 다음 줄의 머리로 읽지 않는다', () => {
    const decoder = new NdjsonDecoder(64);
    decoder.push('x'.repeat(200));
    // 남은 꼬리 + 개행 + 멀쩡한 줄. 꼬리를 버려야 다음 줄이 온전히 읽힌다.
    const results = decoder.push(`yyy\n${JSON.stringify({ id: 'a', type: 'ping' })}\n`);
    expect(results).toHaveLength(1);
    expect(results[0]).toEqual({ ok: true, value: { id: 'a', type: 'ping' } });
  });

  it('보내는 쪽도 상한을 잰다 — 상대가 끊기 전에 내 자리에서 던진다', () => {
    expect(() => encodeLine({ pad: 'x'.repeat(200) }, 64)).toThrow(LineTooLongError);
    expect(MAX_LINE_BYTES).toBe(1024 * 1024);
  });
});

describe('NDJSON 프레이밍 — 부분 수신', () => {
  it('한 JSON 이 여러 청크로 쪼개져 와도 한 번만 디코드된다', () => {
    const decoder = new NdjsonDecoder();
    const message = { id: 'r1', type: 'spawnRunner', payload: { agentId: 'a', env: { A: '1' } } };
    const line = encodeLine(message);

    // 세 조각으로 자른다 — 청크 경계와 줄 경계는 무관하다는 것이 이 회귀선의 전제다.
    const cut1 = 7;
    const cut2 = line.length - 3;
    const out: unknown[] = [];
    for (const part of [line.slice(0, cut1), line.slice(cut1, cut2), line.slice(cut2)]) {
      for (const r of decoder.push(part)) {
        expect(r.ok).toBe(true);
        if (r.ok) out.push(r.value);
      }
    }

    expect(out).toEqual([message]); // 정확히 한 번. 앞 두 청크에서는 아무것도 안 나왔다
    expect(decoder.pendingBytes).toBe(0);
  });

  it('한 청크에 여러 줄이 붙어 와도 전부 나오고, 깨진 줄이 앞의 것을 삼키지 않는다', () => {
    const decoder = new NdjsonDecoder();
    const results = decoder.push(
      `${encodeLine({ id: '1', type: 'ping' })}${encodeLine({ id: '2', type: 'ping' })}{"broken\n`,
    );
    expect(results).toHaveLength(3);
    expect(results[0]).toEqual({ ok: true, value: { id: '1', type: 'ping' } });
    expect(results[1]).toEqual({ ok: true, value: { id: '2', type: 'ping' } });
    expect(errorOf(results[2]).code).toBe('invalid-json');
  });

  it('멀티바이트 문자가 청크 경계에서 잘려도 복원된다', () => {
    // 바이트로 자르므로 UTF-8 시퀀스 중간에서 끊길 수 있다. 문자열로 이어 붙이는
    // 디코더는 여기서 치환 문자를 만들고 JSON 이 깨진다.
    const decoder = new NdjsonDecoder();
    const bytes = Buffer.from(encodeLine({ id: '1', type: 'ping', payload: '한글메시지' }), 'utf8');
    const mid = bytes.indexOf(Buffer.from('한', 'utf8')) + 1; // '한' 의 첫 바이트 뒤
    const out = [
      ...decoder.push(bytes.subarray(0, mid)),
      ...decoder.push(bytes.subarray(mid)),
    ];
    expect(out).toHaveLength(1);
    expect(out[0]).toEqual({ ok: true, value: { id: '1', type: 'ping', payload: '한글메시지' } });
  });
});

describe('인증 — 상수시간 토큰 비교', () => {
  it('길이가 같은 토큰 비교는 timingSafeEqual 을 거친다', () => {
    // **`===` 로 바꾸면 여기가 RED 다.** 아래 두 expect 는 결과값이 아니라 **어떤
    // 방법으로 비교했는가**를 잰다 — `===` 는 결과가 동일하므로 결과만 재는 테스트로는
    // 절대 잡히지 않는다.
    timingSafeEqualSpy.mockClear();
    expect(tokensMatch('0123456789abcdef', '0123456789abcdef')).toBe(true);
    expect(timingSafeEqualSpy).toHaveBeenCalledTimes(1);

    timingSafeEqualSpy.mockClear();
    // 첫 바이트부터 다르다 — `===` 는 여기서 즉시 멈추고 아무것도 안 부른다.
    expect(tokensMatch('0123456789abcdef', 'z123456789abcdef')).toBe(false);
    expect(timingSafeEqualSpy).toHaveBeenCalledTimes(1);
  });

  it('길이가 다르면 timingSafeEqual 을 부르지 않고 거절한다 — 던지지 않는다', () => {
    // `timingSafeEqual` 은 길이가 다르면 던진다. 길이 검사를 빼면 인증 실패가
    // 예외가 되어 daemon 이 죽거나 잘못된 갈래로 샌다.
    timingSafeEqualSpy.mockClear();
    expect(() => tokensMatch('short', 'a-much-longer-token')).not.toThrow();
    expect(tokensMatch('short', 'a-much-longer-token')).toBe(false);
    expect(timingSafeEqualSpy).not.toHaveBeenCalled();
  });

  it('토큰이 문자열이 아니거나 비어 있으면 통과하지 않는다', () => {
    expect(tokensMatch('abc', undefined)).toBe(false);
    expect(tokensMatch('abc', 123)).toBe(false);
    expect(tokensMatch('', '')).toBe(false); // 빈 토큰은 어떤 경우에도 안 통과한다
  });

  it('hello 의 토큰 검사도 같은 함수를 거친다', () => {
    timingSafeEqualSpy.mockClear();
    const ok = checkHello(
      { type: 'hello', version: DAEMON_PROTOCOL_VERSION, token: 'tok-0000', role: 'app' },
      'tok-0000',
    );
    expect(ok).toEqual({ ok: true, role: 'app' });
    expect(timingSafeEqualSpy).toHaveBeenCalled();

    const bad = checkHello(
      { type: 'hello', version: DAEMON_PROTOCOL_VERSION, token: 'tok-9999', role: 'app' },
      'tok-0000',
    );
    expect(bad.ok).toBe(false);
    if (bad.ok) throw new Error('unreachable');
    expect(bad.error.code).toBe('unauthorized');
  });
});

describe('인증 — 프로토콜 버전', () => {
  it('버전이 다르면 토큰이 맞아도 즉시 거절한다', () => {
    const result = checkHello(
      { type: 'hello', version: DAEMON_PROTOCOL_VERSION + 1, token: 'tok', role: 'app' },
      'tok',
    );
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('unreachable');
    expect(result.error.code).toBe('version-mismatch');
    expect(result.error.code).not.toBe('unauthorized'); // 사유를 뭉개지 않는다
  });

  it('버전을 토큰보다 먼저 본다 — 토큰이 틀려도 사유는 version-mismatch 다', () => {
    // 인증에 성공했다고 알려 주고 첫 요청에서 깨지는 것보다, 무엇이 어긋났는지를
    // 첫 답에 담는 편이 사람이 고칠 수 있다(`#368`).
    const result = checkHello(
      { type: 'hello', version: 999, token: '틀린토큰', role: 'app' },
      'tok',
    );
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('unreachable');
    expect(result.error.code).toBe('version-mismatch');
  });

  it('hello 가 아닌 첫 메시지는 not-authenticated 다', () => {
    const result = checkHello({ id: '1', type: 'ping' }, 'tok');
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('unreachable');
    expect(result.error.code).toBe('not-authenticated');
  });

  it('프로토콜 버전 상수는 daemonEndpoint 의 것과 같은 값이다', async () => {
    // 파일명의 `v1` 과 hello 의 버전이 어긋나면 세대 격리가 반쪽만 선다.
    const endpoint = await import('../src/daemonEndpoint.js');
    expect(DAEMON_PROTOCOL_VERSION).toBe(endpoint.DAEMON_PROTOCOL_VERSION);
  });
});

describe('incarnationId — 늦게 온 exit 을 버린다', () => {
  const exitOf = (incarnationId: string): RunnerExitEvent => ({
    agentId: 'agent-1',
    incarnationId,
    code: 1,
    signal: null,
  });

  it('세대가 다른 exit 이벤트를 무시한다', () => {
    // 옛 러너의 exit 이 새 러너가 뜬 뒤 도착하는 경로다. 이것을 받아들이면 앱은
    // **살아 있는 새 러너를 죽은 것으로** 표시하고 또 하나를 띄운다 — 같은 에이전트에
    // 러너가 둘이면 멘션을 나눠 집어 간다.
    const older = newIncarnationId();
    const current = newIncarnationId();
    expect(older).not.toBe(current);

    expect(acceptRunnerExit(current, exitOf(older))).toBe(false);
    expect(acceptRunnerExit(current, exitOf(current))).toBe(true);
  });

  it('아는 러너가 없으면(null) 어떤 exit 도 받지 않는다', () => {
    // 이미 정리된 러너의 늦은 통지가 상태를 되살리면 안 된다.
    expect(acceptRunnerExit(null, exitOf(newIncarnationId()))).toBe(false);
  });

  it('세대 구분자는 매번 다르다', () => {
    const ids = new Set(Array.from({ length: 64 }, () => newIncarnationId()));
    expect(ids.size).toBe(64);
  });
});

describe('요청 종류 — 2단계-c 의 범위', () => {
  /** 2-c 가 `adoptRunner` 를 더해 다섯이다. 2-b 의 넷은 그대로 산다. */
  it('다섯 종류를 받는다 — adoptRunner 가 2-c 에서 더해졌다', () => {
    for (const type of ['spawnRunner', 'killRunner', 'listRunners', 'ping', 'adoptRunner']) {
      const parsed = parseRequest({ id: '1', type });
      expect(parsed).toMatchObject({ id: '1', type });
    }
  });

  it('shutdownIfIdle 은 아직 없다 — unknown-request 다', () => {
    // 2-d 의 것이다. 지금 받아 주면 그 계약이 정해지기 전에 앱이 의존한다.
    for (const type of ['shutdownIfIdle', 'getState']) {
      expect(parseRequest({ id: '1', type })).toMatchObject({ code: 'unknown-request' });
    }
  });

  it('id 가 없는 요청은 거절한다 — 응답을 어디로 보낼지 알 수 없다', () => {
    expect(parseRequest({ type: 'ping' })).toMatchObject({ code: 'bad-payload' });
    expect(parseRequest({ id: '', type: 'ping' })).toMatchObject({ code: 'bad-payload' });
  });
});
