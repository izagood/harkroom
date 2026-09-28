// PTY 출력이 **화면으로 가는 길**의 회귀선. `RingBuffer`(담기)와 `createOutputCoalescer`
// (내보내기)는 같은 경로의 앞뒤 절반이라 한 파일에 둔다.
//
// 왜 따로 재는가: 이 둘은 `runPtyTurn` 안에서만 쓰이고, 그 파일의 테스트는 실제 PTY 를
// 띄워 결과(exitCode·tail)를 본다 — 프레임을 **몇 번** 내보냈는지, 링이 감길 때 순서가
// 맞는지는 그 관찰로는 안 보인다. 비용이 성질인 코드라(청크당 복사량·프레임 수) 성질을
// 직접 재는 자리가 필요하다.
import { describe, it, expect } from 'vitest';
import { RingBuffer, createOutputCoalescer } from '../src/pty.js';

describe('RingBuffer 는 용량 안에서 감아 쓴다', () => {
  it('캡 미만이면 넣은 순서 그대로 준다', () => {
    const r = new RingBuffer(16);
    r.push(Buffer.from('ab'));
    r.push(Buffer.from('cd'));
    expect(r.snapshot().toString()).toBe('abcd');
  });

  it('캡을 넘으면 오래된 앞을 버리고 끝을 남긴다 — 감아 쓴 뒤에도 순서가 맞는다', () => {
    const r = new RingBuffer(4);
    for (const c of ['a', 'b', 'c', 'd', 'e', 'f']) r.push(Buffer.from(c));
    // 마지막 4바이트. 저장은 감겨 있지만 계약은 **도착 순서**다.
    expect(r.snapshot().toString()).toBe('cdef');
  });

  it('경계를 걸치는 청크도 이어 붙는다', () => {
    const r = new RingBuffer(5);
    r.push(Buffer.from('abcd'));
    // 남은 자리 1 + 앞으로 감아 2 — 두 조각으로 쪼개 쓰는 경로다.
    r.push(Buffer.from('efg'));
    expect(r.snapshot().toString()).toBe('cdefg');
  });

  it('한 청크가 캡보다 크면 그 청크의 끝만 남는다', () => {
    const r = new RingBuffer(3);
    r.push(Buffer.from('abcdefg'));
    expect(r.snapshot().toString()).toBe('efg');
  });

  it('절단은 바이트 단위다 — 문자 경계로 정렬하지 않는다(ANSI 를 쪼개지 않기 위한 계약)', () => {
    const r = new RingBuffer(8);
    r.push(Buffer.from('가나다라마', 'utf8'));
    const snap = r.snapshot();
    expect(snap).toHaveLength(8);
    // 앞이 잘려 나간 조각으로 시작한다(그 잡음은 `decodeTailText` 가 치운다).
    expect(snap.toString('utf8').startsWith('�')).toBe(true);
  });

  it('snapshot 은 복사본이다 — 호출자가 만져도 내부가 오염되지 않는다', () => {
    const r = new RingBuffer(4);
    r.push(Buffer.from('abcd'));
    r.snapshot().fill(0);
    expect(r.snapshot().toString()).toBe('abcd');
  });
});

/** 손으로 돌리는 시계. 창 하나를 정확히 한 번 만료시킨다. */
function fakeTimers() {
  let pending: (() => void) | null = null;
  let cleared = 0;
  return {
    setTimer: (fn: () => void): unknown => { pending = fn; return 1; },
    clearTimer: (): void => { cleared += 1; pending = null; },
    /** 창 끝. */
    fire(): void {
      const fn = pending;
      pending = null;
      fn?.();
    },
    get armed(): boolean { return pending !== null; },
    get clears(): number { return cleared; },
  };
}

describe('createOutputCoalescer 는 프레임을 창당 하나로 묶는다', () => {
  it('조용할 때의 첫 청크는 기다리지 않는다 — 타이핑 에코가 이 길로 돌아온다', () => {
    const out: string[] = [];
    const t = fakeTimers();
    const c = createOutputCoalescer({
      windowMs: 12, emit: (b) => out.push(b.toString()), setTimer: t.setTimer, clearTimer: t.clearTimer,
    });
    c.push(Buffer.from('a'));
    expect(out).toEqual(['a']);
    expect(t.armed).toBe(true);
  });

  it('창 안에 들어온 것들은 창 끝에 한 번으로 합쳐 나간다', () => {
    const out: string[] = [];
    const t = fakeTimers();
    const c = createOutputCoalescer({
      windowMs: 12, emit: (b) => out.push(b.toString()), setTimer: t.setTimer, clearTimer: t.clearTimer,
    });
    c.push(Buffer.from('1'));
    c.push(Buffer.from('2'));
    c.push(Buffer.from('3'));
    c.push(Buffer.from('4'));
    // 첫 것만 나갔고 나머지는 창 안에 있다.
    expect(out).toEqual(['1']);
    t.fire();
    expect(out).toEqual(['1', '234']);
  });

  it('창이 비면 조용한 상태로 돌아간다 — 다음 청크가 다시 즉시 나간다', () => {
    const out: string[] = [];
    const t = fakeTimers();
    const c = createOutputCoalescer({
      windowMs: 12, emit: (b) => out.push(b.toString()), setTimer: t.setTimer, clearTimer: t.clearTimer,
    });
    c.push(Buffer.from('a'));
    t.fire();                 // 창이 비어 있었다 → 조용한 상태
    expect(t.armed).toBe(false);
    c.push(Buffer.from('b'));
    expect(out).toEqual(['a', 'b']);
  });

  it('계속 쏟아지면 창을 이어 열어 프레임 수를 창당 하나로 유지한다', () => {
    const out: string[] = [];
    const t = fakeTimers();
    const c = createOutputCoalescer({
      windowMs: 12, emit: (b) => out.push(b.toString()), setTimer: t.setTimer, clearTimer: t.clearTimer,
    });
    c.push(Buffer.from('a'));
    c.push(Buffer.from('b'));
    t.fire();
    c.push(Buffer.from('c'));
    c.push(Buffer.from('d'));
    t.fire();
    expect(out).toEqual(['a', 'b', 'cd']);
  });

  it('stop 은 남은 것을 반드시 내보내고 타이머를 끈다 — 턴의 마지막 화면이 거기 있다', () => {
    const out: string[] = [];
    const t = fakeTimers();
    const c = createOutputCoalescer({
      windowMs: 12, emit: (b) => out.push(b.toString()), setTimer: t.setTimer, clearTimer: t.clearTimer,
    });
    c.push(Buffer.from('처음'));
    c.push(Buffer.from('마지막'));
    c.stop();
    expect(out).toEqual(['처음', '마지막']);
    expect(t.clears).toBe(1);
    expect(t.armed).toBe(false);
  });

  it('빈 청크는 아무것도 만들지 않는다', () => {
    const out: string[] = [];
    const t = fakeTimers();
    const c = createOutputCoalescer({
      windowMs: 12, emit: (b) => out.push(b.toString()), setTimer: t.setTimer, clearTimer: t.clearTimer,
    });
    c.push(Buffer.alloc(0));
    expect(out).toEqual([]);
    expect(t.armed).toBe(false);
  });
});
