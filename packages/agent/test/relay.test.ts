// #141 Phase 2 — 러너 쪽 릴레이 회귀선. 소켓 없이 검증한다(dialer 주입) — 재접속 순서와
// 백오프 곡선은 네트워크를 태우면 "느리다"로만 보이고 무엇이 깨졌는지 알려 주지 않는다.
import { describe, it, expect } from 'vitest';
import type { RelayRunnerFrame } from '@murmur/shared';
import { createRelayClient, relayUrl, RING_CAP_BYTES, type RelayHandlers, type RelayTransport } from '../src/relay.js';
import { nextBackoffMs } from '../src/policy.js';

/**
 * 가짜 dialer. dial 마다 핸들러를 붙잡아 두고, 테스트가 `open()`/`drop()` 으로 소켓의
 * 생애를 직접 돌린다.
 */
function fakeDialer() {
  const dials: { url: string; pat: string; handlers: RelayHandlers }[] = [];
  const sent: RelayRunnerFrame[] = [];
  let closedCount = 0;

  const dial = (url: string, pat: string, handlers: RelayHandlers) => {
    dials.push({ url, pat, handlers });
  };

  const open = (index = dials.length - 1): RelayTransport => {
    const transport: RelayTransport = {
      send: (data) => sent.push(JSON.parse(data) as RelayRunnerFrame),
      close: () => { closedCount += 1; },
    };
    dials[index]!.handlers.onOpen(transport);
    return transport;
  };

  const drop = (index = dials.length - 1) => dials[index]!.handlers.onClose();
  const deliver = (frame: unknown, index = dials.length - 1) =>
    dials[index]!.handlers.onMessage(JSON.stringify(frame));

  return { dial, dials, sent, open, drop, deliver, closedCount: () => closedCount };
}

/**
 * 재접속 예약을 붙잡아 두고 테스트가 직접 터뜨린다.
 *
 * 예약된 지연을 **터뜨린 것까지 전부** 누적해 둔다(`pending` 과 별도) — 큐에 남은 것만
 * 보면 곡선을 확인할 수 없고, "몇 번 예약됐는가"도 못 센다(이중 예약 결함이 그 모양이다).
 */
function fakeSchedule() {
  const pending: { fn: () => void; ms: number }[] = [];
  const all: number[] = [];
  return {
    schedule: (fn: () => void, ms: number) => { pending.push({ fn, ms }); all.push(ms); },
    /** 이 클라이언트가 예약한 모든 지연, 예약 순서대로. */
    delays: () => [...all],
    fire: () => { const next = pending.shift(); next?.fn(); },
  };
}

const SESSION = { agentAccountId: 'a1', channelId: 'c1', threadRootId: 'm1', harness: 'claude-code' } as const;

/** ANSI + 잘린 UTF-8. 어디서든 문자열로 뜨면 U+FFFD 로 치환돼 되돌릴 수 없다. */
const RAW = Buffer.concat([Buffer.from('\x1b[31mERR\x1b[0m', 'binary'), Buffer.from([0xed, 0x95])]);

describe('relayUrl', () => {
  it('http(s) 를 ws(s) 로 바꾸고 /agent-relay 를 붙인다', () => {
    expect(relayUrl('http://localhost:3400')).toBe('ws://localhost:3400/agent-relay');
    expect(relayUrl('https://murmur.example/')).toBe('wss://murmur.example/agent-relay');
  });
});

describe('#141 러너 릴레이 — 접속과 announce', () => {
  it('PAT 를 dialer 에 넘긴다 — URL 이 아니라 헤더로 가야 한다', () => {
    const d = fakeDialer();
    createRelayClient({ murmurUrl: 'http://x', pat: 'murp_secret', dial: d.dial }).start();
    expect(d.dials).toHaveLength(1);
    expect(d.dials[0]!.pat).toBe('murp_secret');
    // PAT 가 URL 에 실리면 앞단 프록시 로그에 남는다 — 그래서 URL 에는 없어야 한다.
    expect(d.dials[0]!.url).not.toContain('murp_secret');
  });

  it('접속하면 진행 중인 세션을 announce 한다', () => {
    const d = fakeDialer();
    const client = createRelayClient({ murmurUrl: 'http://x', pat: 'p', dial: d.dial });
    client.start();
    d.open();
    // 접속 시점에 세션이 없으면 빈 announce 다 — 안 보내면 서버가 "아직 못 받았다"와
    // "세션이 없다"를 구분할 수 없다.
    // caps 도 함께 간다(#346): 선언이 없으면 서버는 이 러너를 구버전(입력·인터랙티브
    // 불가)으로 읽고, 뷰어에 writer 차례를 주지 않는다 — 선언이 곧 기능의 존재 증명이다.
    expect(d.sent[0]).toEqual({ type: 'announce', sessions: [], caps: ['input', 'interactive'] });

    const session = client.openSession({ ...SESSION });
    expect(d.sent[1]).toMatchObject({ type: 'session.started' });
    expect((d.sent[1] as { session: { sessionId: string } }).session.sessionId).toBe(session.sessionId);
  });

  it('릴레이가 끊겨 있어도 세션은 열리고 ring 은 계속 쌓인다', () => {
    const d = fakeDialer();
    const client = createRelayClient({ murmurUrl: 'http://x', pat: 'p', dial: d.dial, schedule: () => {} });
    client.start();
    // open 을 안 부른다 — 아직 붙지 못한 상태다.
    const session = client.openSession({ ...SESSION });
    session.push(RAW);
    expect(client.connected()).toBe(false);
    expect(d.sent).toHaveLength(0);

    // 그 뒤에 붙으면 재생 요청에 **끊긴 구간까지** 답한다 — 여기서 ring 을 안 채웠으면
    // 재접속 뒤 attach 한 사람은 그 구간을 영구히 못 본다.
    d.open();
    d.deliver({ type: 'replay.request', sessionId: session.sessionId });
    const replay = d.sent.find((f) => f.type === 'replay') as { data: string };
    expect(Buffer.from(replay.data, 'base64').equals(RAW)).toBe(true);
  });
});

describe('#141-2 러너는 바이트를 변형하지 않는다', () => {
  it('output 프레임의 base64 가 원본 바이트와 정확히 같다', () => {
    const d = fakeDialer();
    const client = createRelayClient({ murmurUrl: 'http://x', pat: 'p', dial: d.dial });
    client.start();
    d.open();
    const session = client.openSession({ ...SESSION });
    session.push(RAW);

    const out = d.sent.find((f) => f.type === 'output') as { data: string };
    const back = Buffer.from(out.data, 'base64');
    expect(back.equals(RAW)).toBe(true);
    expect(back.includes(Buffer.from([0xef, 0xbf, 0xbd]))).toBe(false);
  });

  it('ring 은 256KB 를 넘으면 앞을 버리고 뒤를 남긴다', () => {
    const d = fakeDialer();
    const client = createRelayClient({ murmurUrl: 'http://x', pat: 'p', dial: d.dial });
    client.start();
    d.open();
    const session = client.openSession({ ...SESSION });
    // 용량보다 크게 밀어 넣고, 남은 것이 **끝**인지 본다 — "tail" 이라는 이름이 실제로
    // 끝을 가리키려면 잘라내는 방향이 이래야 한다(pty.ts RingBuffer).
    session.push(Buffer.alloc(RING_CAP_BYTES, 0x41));
    session.push(Buffer.from('END'));
    d.deliver({ type: 'replay.request', sessionId: session.sessionId });
    const replay = d.sent.find((f) => f.type === 'replay') as { data: string };
    const bytes = Buffer.from(replay.data, 'base64');
    expect(bytes).toHaveLength(RING_CAP_BYTES);
    expect(bytes.subarray(bytes.length - 3).toString()).toBe('END');
  });

  it('모르는 세션의 재생 요청에는 답하지 않는다', () => {
    const d = fakeDialer();
    const client = createRelayClient({ murmurUrl: 'http://x', pat: 'p', dial: d.dial });
    client.start();
    d.open();
    d.deliver({ type: 'replay.request', sessionId: 'nope' });
    // 빈 재생으로 답하면 "끝난 세션"과 "아직 출력이 없는 세션"이 뷰어에게 같아진다.
    expect(d.sent.filter((f) => f.type === 'replay')).toHaveLength(0);
  });
});

describe('#141-6 러너 재접속 (백오프 경로)', () => {
  it('끊기면 백오프로 재접속하고, 붙으면 진행 중인 세션을 다시 announce 한다', () => {
    const d = fakeDialer();
    const s = fakeSchedule();
    const client = createRelayClient({
      murmurUrl: 'http://x', pat: 'p', dial: d.dial, schedule: s.schedule, initialBackoffMs: 1_000,
    });
    client.start();
    d.open();
    const session = client.openSession({ ...SESSION });
    session.push(RAW);

    // 서버가 재시작해 소켓이 끊긴다.
    d.drop();
    expect(client.connected()).toBe(false);
    expect(s.delays()).toEqual([1_000]);

    // 백오프가 만료돼 다시 붙는다.
    s.fire();
    expect(d.dials).toHaveLength(2);
    d.open();

    // **진행 중인 세션이 다시 announce 돼야 한다.** 서버는 소켓이 끊기면 그 러너의 세션
    // 레지스트리를 버리므로, 이 announce 가 없으면 진행 중인 턴에 다시 붙을 방법이 없다.
    const announces = d.sent.filter((f) => f.type === 'announce') as { sessions: { sessionId: string }[] }[];
    expect(announces).toHaveLength(2);
    expect(announces[1]!.sessions.map((x) => x.sessionId)).toEqual([session.sessionId]);
  });

  it('백오프는 policy.ts 의 곡선을 따르고, 붙으면 초기값으로 되돌아간다', () => {
    const d = fakeDialer();
    const s = fakeSchedule();
    const client = createRelayClient({
      murmurUrl: 'http://x', pat: 'p', dial: d.dial, schedule: s.schedule, initialBackoffMs: 1_000,
    });
    client.start();

    // 세 번 연속 실패 — 곡선은 poll 루프와 **같은 함수**를 써야 한다. 릴레이만의 곡선을
    // 두면 러너 한 프로세스가 서버 재시작에 두 속도로 반응하고, 둘이 갈라진다.
    d.drop(); s.fire();
    d.drop(); s.fire();
    d.drop();
    expect(s.delays()).toEqual([1_000, nextBackoffMs(1_000), nextBackoffMs(nextBackoffMs(1_000))]);

    // 붙으면 초기화된다 — 안 하면 한 번 오래 끊긴 뒤 짧은 끊김에도 1분씩 기다린다.
    s.fire();
    d.open();
    d.drop();
    expect(s.delays().at(-1)).toBe(1_000);
  });

  it('종료 뒤에는 재접속하지 않는다', () => {
    const d = fakeDialer();
    const s = fakeSchedule();
    const client = createRelayClient({ murmurUrl: 'http://x', pat: 'p', dial: d.dial, schedule: s.schedule });
    client.start();
    d.open();
    client.stop();
    d.drop();
    // 러너가 물러나는 중에 재접속을 예약하면 프로세스가 끝나지 않는다.
    expect(s.delays()).toEqual([]);
    expect(d.closedCount()).toBe(1);
  });
});

describe('#141 세션의 끝', () => {
  it('세션을 닫으면 서버에 알리고, 그 뒤 재생 요청에는 답하지 않는다', () => {
    const d = fakeDialer();
    const client = createRelayClient({ murmurUrl: 'http://x', pat: 'p', dial: d.dial });
    client.start();
    d.open();
    const session = client.openSession({ ...SESSION });
    session.close();
    expect(d.sent.at(-1)).toEqual({ type: 'session.ended', sessionId: session.sessionId });

    d.deliver({ type: 'replay.request', sessionId: session.sessionId });
    expect(d.sent.filter((f) => f.type === 'replay')).toHaveLength(0);
  });

  it('닫힌 세션은 재접속 announce 에도 실리지 않는다', () => {
    const d = fakeDialer();
    const s = fakeSchedule();
    const client = createRelayClient({ murmurUrl: 'http://x', pat: 'p', dial: d.dial, schedule: s.schedule });
    client.start();
    d.open();
    client.openSession({ ...SESSION }).close();
    d.drop();
    s.fire();
    d.open();
    const announces = d.sent.filter((f) => f.type === 'announce') as { sessions: unknown[] }[];
    expect(announces.at(-1)!.sessions).toEqual([]);
  });
});

describe('#335 서버가 보낸 resize 를 그 세션의 PTY 창 크기로 넣는다', () => {
  it('resize 프레임의 숫자가 bindInput 으로 이어 붙인 통로에 그대로 간다', () => {
    const d = fakeDialer();
    const client = createRelayClient({ murmurUrl: 'http://x', pat: 'p', dial: d.dial });
    client.start();
    d.open();
    const session = client.openSession(SESSION);
    const resized: [number, number][] = [];
    session.bindInput({ write: () => {}, resize: (cols, rows) => { resized.push([cols, rows]); } });

    // 서버가 보내는 것과 **같은 모양**의 프레임이다(server/src/ws/relay.ts::sendResize).
    d.deliver({ type: 'resize', sessionId: session.sessionId, cols: 100, rows: 30 });

    expect(resized).toEqual([[100, 30]]);
  });

  it('모르는 세션의 resize 는 어느 통로에도 가지 않는다', () => {
    const d = fakeDialer();
    const client = createRelayClient({ murmurUrl: 'http://x', pat: 'p', dial: d.dial });
    client.start();
    d.open();
    const session = client.openSession(SESSION);
    const resized: [number, number][] = [];
    session.bindInput({ write: () => {}, resize: (cols, rows) => { resized.push([cols, rows]); } });

    d.deliver({ type: 'resize', sessionId: 'someone-elses-session', cols: 100, rows: 30 });

    expect(resized).toEqual([]);
  });

  it('아직 spawn 전이라 통로가 없으면 버린다 — 던지지 않는다', () => {
    const d = fakeDialer();
    const client = createRelayClient({ murmurUrl: 'http://x', pat: 'p', dial: d.dial });
    client.start();
    d.open();
    const session = client.openSession(SESSION);

    // 큐에 담지 않는 것이 의도다(relay.ts 의 resize 분기 주석): 담아 두면 다음 턴의
    // PTY 가 지난 턴의 창 크기로 열린다.
    expect(() => d.deliver({ type: 'resize', sessionId: session.sessionId, cols: 80, rows: 24 })).not.toThrow();
  });
});

describe('#315 서버가 보낸 input 을 그 세션의 PTY 로 넣는다', () => {
  it('input 프레임의 바이트가 bindInput 으로 이어 붙인 통로에 그대로 간다', () => {
    const d = fakeDialer();
    const client = createRelayClient({ murmurUrl: 'http://x', pat: 'p', dial: d.dial });
    client.start();
    d.open();
    const session = client.openSession(SESSION);
    const written: Buffer[] = [];
    session.bindInput({ write: (chunk) => { written.push(chunk); }, resize: () => {} });

    // 서버가 보내는 것과 **같은 모양**의 프레임이다(server/src/ws/relay.ts::sendInput).
    d.deliver({ type: 'input', sessionId: session.sessionId, data: RAW.toString('base64') });

    expect(written).toHaveLength(1);
    // 바이트 비교다 — 문자열로 비교하면 잘린 UTF-8 이 U+FFFD 로 같아져 통과한다.
    expect(written[0]!.equals(RAW)).toBe(true);
  });

  it('아직 spawn 전이라 통로가 없으면 버린다 — 던지지 않는다', () => {
    const d = fakeDialer();
    const client = createRelayClient({ murmurUrl: 'http://x', pat: 'p', dial: d.dial });
    client.start();
    d.open();
    const session = client.openSession(SESSION);

    // 큐에 담지 않는 것이 의도다: 프롬프트가 뜨기 전에 친 것을 나중에 흘려 넣으면
    // 엉뚱한 프롬프트의 답이 된다(relay.ts::LiveSession.writer 주석).
    expect(() => d.deliver({ type: 'input', sessionId: session.sessionId, data: 'aGk=' })).not.toThrow();
  });

  it('모르는 세션의 input 은 어느 통로에도 가지 않는다', () => {
    const d = fakeDialer();
    const client = createRelayClient({ murmurUrl: 'http://x', pat: 'p', dial: d.dial });
    client.start();
    d.open();
    const session = client.openSession(SESSION);
    const written: Buffer[] = [];
    session.bindInput({ write: (chunk) => { written.push(chunk); }, resize: () => {} });

    d.deliver({ type: 'input', sessionId: 'someone-elses-session', data: 'aGk=' });

    expect(written).toEqual([]);
  });
});

describe('#337 viewer.count — 인터랙티브 고아 회수의 신호', () => {
  it('세션을 연 쪽이 넘긴 콜백으로 count 가 도착한다', () => {
    const d = fakeDialer();
    const client = createRelayClient({ murmurUrl: 'http://x', pat: 'p', dial: d.dial });
    client.start();
    d.open();
    const counts: number[] = [];
    const session = client.openSession({ ...SESSION, mode: 'interactive', onViewerCount: (n) => counts.push(n) });

    d.deliver({ type: 'viewer.count', sessionId: session.sessionId, count: 2 });
    d.deliver({ type: 'viewer.count', sessionId: session.sessionId, count: 0 });
    expect(counts).toEqual([2, 0]);
    // 모르는 세션의 count 는 어디에도 안 간다.
    d.deliver({ type: 'viewer.count', sessionId: 'nope', count: 9 });
    expect(counts).toEqual([2, 0]);
  });

  it('콜백이 던져도 릴레이는 산다 — 관찰이 답을 죽이지 않는다', () => {
    const d = fakeDialer();
    const client = createRelayClient({ murmurUrl: 'http://x', pat: 'p', dial: d.dial });
    client.start();
    d.open();
    const session = client.openSession({ ...SESSION, mode: 'interactive', onViewerCount: () => { throw new Error('boom'); } });
    expect(() => d.deliver({ type: 'viewer.count', sessionId: session.sessionId, count: 0 })).not.toThrow();
  });

  it('인터랙티브로 연 세션은 announce·started 에 mode 가 실린다 — 데스크탑이 조종 중을 구분한다', () => {
    const d = fakeDialer();
    const client = createRelayClient({ murmurUrl: 'http://x', pat: 'p', dial: d.dial });
    client.start();
    d.open();
    client.openSession({ ...SESSION, mode: 'interactive' });
    const started = d.sent.find((f) => f.type === 'session.started') as { session: { mode?: string } };
    expect(started.session.mode).toBe('interactive');
    // 기존 호출부(멘션 턴)는 mode 를 안 넘긴다 — 그때는 mention 으로 채운다.
    client.openSession(SESSION);
    const all = d.sent.filter((f) => f.type === 'session.started') as { session: { mode?: string } }[];
    expect(all[1]!.session.mode).toBe('mention');
  });
});

describe('#337 interactive.open 왕복', () => {
  const OPEN = {
    type: 'interactive.open', requestId: 'req-1',
    channelId: 'c1', threadRootId: 'm1', openedByHandle: 'jaebin', cols: 100, rows: 30,
  };

  const flush = () => new Promise((r) => setTimeout(r, 0));

  it('훅의 성공이 interactive.opened 로 서버에 돌아간다', async () => {
    const d = fakeDialer();
    const client = createRelayClient({
      murmurUrl: 'http://x', pat: 'p', dial: d.dial,
      onInteractiveOpen: async (req) => {
        expect(req).toEqual({ channelId: 'c1', threadRootId: 'm1', openedByHandle: 'jaebin', cols: 100, rows: 30 });
        return { sessionId: 'sess-i', created: true };
      },
    });
    client.start();
    d.open();
    d.deliver(OPEN);
    await flush();
    expect(d.sent).toContainEqual({ type: 'interactive.opened', requestId: 'req-1', sessionId: 'sess-i', created: true });
  });

  it('훅이 던지면 그 메시지가 interactive.error 로 간다 — codex 거절 문구가 사람에게 닿는 경로', async () => {
    const d = fakeDialer();
    const client = createRelayClient({
      murmurUrl: 'http://x', pat: 'p', dial: d.dial,
      onInteractiveOpen: async () => { throw new Error('codex 인터랙티브 턴은 지원하지 않는다'); },
    });
    client.start();
    d.open();
    d.deliver(OPEN);
    await flush();
    expect(d.sent).toContainEqual({
      type: 'interactive.error', requestId: 'req-1', message: 'codex 인터랙티브 턴은 지원하지 않는다',
    });
  });

  it('훅이 배선되지 않았으면 조용히 버리지 않고 에러로 응답한다 — 침묵이 곧 서버 타임아웃이다', async () => {
    const d = fakeDialer();
    const client = createRelayClient({ murmurUrl: 'http://x', pat: 'p', dial: d.dial });
    client.start();
    d.open();
    d.deliver(OPEN);
    await flush();
    const errors = d.sent.filter((f) => f.type === 'interactive.error') as { requestId: string }[];
    expect(errors).toHaveLength(1);
    expect(errors[0]!.requestId).toBe('req-1');
  });
});
