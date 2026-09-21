// 러너 ↔ 오퍼레이터 unix 링크(스펙 2026-09-20 §5). 실제 소켓 대신 **가짜 소켓 페어**로 잰다 —
// 여기서 지키는 것은 인증(secret)과 프레임의 왕복이고, 그것은 `net` 없이도 재야 다른 판에서
// 같은 결과를 낸다(`server.test.ts` 가 실제 소켓의 몫을 이미 진다).
import { describe, it, expect } from 'vitest';
import { EventEmitter } from 'node:events';
import { encodeLine, NdjsonDecoder } from '@harkroom/shared/daemonProtocol';
import type { RelayRunnerFrame, RelayServerFrame } from '@harkroom/shared';
import { createRunnerLinkServer, type LinkSocket } from '../src/runnerLink.js';

/** 러너 쪽 끝. `write` 는 오퍼레이터가 러너에게 보낸 줄, `feed` 는 러너가 보낸 줄. */
function fakeSocket() {
  const em = new EventEmitter();
  const written: string[] = [];
  let destroyed = false;
  const socket: LinkSocket = {
    write: (line) => { written.push(String(line)); return true; },
    destroy: () => { destroyed = true; em.emit('close'); },
    on: (ev, fn) => { em.on(ev, fn); return socket; },
    removeAllListeners: (ev) => { em.removeAllListeners(ev); return socket; },
  };
  const feed = (value: unknown) => em.emit('data', Buffer.from(encodeLine(value)));
  const lines = (): unknown[] => {
    const d = new NdjsonDecoder();
    return d.push(written.join('')).filter((l) => l.ok).map((l) => (l as { value: unknown }).value);
  };
  return { socket, feed, lines, destroyed: () => destroyed, close: () => em.emit('close') };
}

const hello = (runnerId: string, secret: string) => ({ type: 'hello', version: 1, role: 'runner', runnerId, secret });

describe('runnerLink 서버', () => {
  it('secret 이 맞으면 붙고, 이후 프레임이 onFrame 에 agentId 와 함께 온다', () => {
    const got: { runnerId: string; agentId: string; frame: RelayRunnerFrame }[] = [];
    const link = createRunnerLinkServer({ onFrame: (r, a, f) => got.push({ runnerId: r, agentId: a, frame: f }), log: () => {} });
    link.expect('r-1', 'agent-a', 'sec');
    const s = fakeSocket();
    expect(link.accept(s.socket, hello('r-1', 'sec'), [])).toBe(true);
    s.feed({ type: 'session.ended', sessionId: 's1' });
    expect(got).toEqual([{ runnerId: 'r-1', agentId: 'agent-a', frame: { type: 'session.ended', sessionId: 's1' } }]);
    expect(link.isLinked('r-1')).toBe(true);
  });

  it('secret 이 틀리거나 모르는 runnerId 면 거절하고 끊는다', () => {
    const link = createRunnerLinkServer({ onFrame: () => {}, log: () => {} });
    link.expect('r-1', 'agent-a', 'sec');
    const wrong = fakeSocket();
    expect(link.accept(wrong.socket, hello('r-1', 'nope'), [])).toBe(false);
    expect(wrong.destroyed()).toBe(true);
    const stranger = fakeSocket();
    expect(link.accept(stranger.socket, hello('r-9', 'sec'), [])).toBe(false);
    expect(stranger.destroyed()).toBe(true);
  });

  it('hello 와 같은 청크에 온 뒷줄도 잃지 않는다', () => {
    const got: RelayRunnerFrame[] = [];
    const link = createRunnerLinkServer({ onFrame: (_r, _a, f) => got.push(f), log: () => {} });
    link.expect('r-1', 'agent-a', 'sec');
    const s = fakeSocket();
    link.accept(s.socket, hello('r-1', 'sec'), [{ type: 'announce', sessions: [], caps: ['input'] }]);
    expect(got).toEqual([{ type: 'announce', sessions: [], caps: ['input'] }]);
  });

  it('send 는 붙어 있는 러너에게 한 줄을 쓰고, 없으면 false 다', () => {
    const link = createRunnerLinkServer({ onFrame: () => {}, log: () => {} });
    link.expect('r-1', 'agent-a', 'sec');
    const s = fakeSocket();
    link.accept(s.socket, hello('r-1', 'sec'), []);
    const frame: RelayServerFrame = { type: 'input', sessionId: 's1', data: 'AA==' };
    expect(link.send('r-1', frame)).toBe(true);
    expect(s.lines()).toEqual([frame]);
    expect(link.send('r-2', frame)).toBe(false);
  });

  it('소켓이 닫히면 onClose 가 오고 더는 보낼 수 없다 — 같은 runnerId 로 다시 붙을 수는 있다', () => {
    const closed: string[] = [];
    const link = createRunnerLinkServer({ onFrame: () => {}, onClose: (r) => closed.push(r), log: () => {} });
    link.expect('r-1', 'agent-a', 'sec');
    const s = fakeSocket();
    link.accept(s.socket, hello('r-1', 'sec'), []);
    s.close();
    expect(closed).toEqual(['r-1']);
    expect(link.send('r-1', { type: 'replay.request', sessionId: 's' })).toBe(false);
    // 재접속 — 러너 프로세스는 살아 있고 소켓만 끊긴 경우다. secret 은 프로세스 수명 동안 같다.
    const again = fakeSocket();
    expect(link.accept(again.socket, hello('r-1', 'sec'), [])).toBe(true);
  });

  it('forget 하면 그 runnerId 는 다시 붙을 수 없다 — 죽은 러너의 secret 을 남기지 않는다', () => {
    const link = createRunnerLinkServer({ onFrame: () => {}, log: () => {} });
    link.expect('r-1', 'agent-a', 'sec');
    link.forget('r-1');
    const s = fakeSocket();
    expect(link.accept(s.socket, hello('r-1', 'sec'), [])).toBe(false);
  });
});
