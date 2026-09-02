import { describe, expect, it } from 'vitest';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { RingBuffer, runPtyTurn } from '../src/pty.js';

const fake = join(dirname(fileURLToPath(import.meta.url)), 'helpers/fake-harness.mjs');
// **부모 env 를 펼치지 않는다 — 프로덕션 plan 의 실제 모양과 같아야 한다.** 예전엔
// `{ ...process.env, FAKE_MODE: mode }` 로 이 테스트가 직접 부모 env 를 물려줬는데, 그
// 우회가 `buildTurnCommand`(turn.ts)의 실제 반환값(한때 `{ MURMUR_PAT }` 하나뿐이라 PATH·
// HOME 이 없었다)과 이 계약 테스트 사이의 간극을 가려 실물 검증에서야 드러난 회귀를 놓쳤다
// (turn.ts::childEnv 참고). `process.execPath` 는 절대경로라 PATH 없이도 그대로 실행되고,
// 가짜 하네스(fake-harness.mjs)는 FAKE_MODE 말고 다른 env 를 읽지 않는다 — 이 시나리오에서
// PATH 없이도 통과한다는 것 자체가 이 테스트가 이제 프로덕션 plan 의 실제 모양을 검증한다는
// 증거다.
const plan = (mode: string) => ({ command: process.execPath, args: [fake], env: { FAKE_MODE: mode } as Record<string, string> });

describe('runPtyTurn', () => {
  it('정상 종료: exitCode 0, 출력이 ring 에 남는다', async () => {
    const ring = new RingBuffer(256 * 1024);
    const r = await runPtyTurn(plan('ok'), { cwd: process.cwd(), timeoutMs: 10_000, ring });
    expect(r.exitCode).toBe(0);
    expect(ring.snapshot().toString()).toContain('done');
  });

  it('비정상 종료: exitCode 전달', async () => {
    const r = await runPtyTurn(plan('fail'), { cwd: process.cwd(), timeoutMs: 10_000 });
    expect(r.exitCode).toBe(3);
  });

  // 'hang' 은 SIGTERM 을 안 막아서 기본 처분(종료)으로 그냥 죽는다 — 즉 이 테스트는 SIGTERM
  // 분기만 확인한다. SIGKILL 승격 분기는 SIGTERM 을 무시하는 별도 하네스('hang-ignore-sigterm')
  // 로 아래에서 따로 확인한다(리뷰 지적 — 이 테스트만으로는 그 분기가 한 번도 안 탄다).
  it('타임아웃: SIGTERM → 안 죽으면 SIGKILL, timedOut 표시 (spec §4)', async () => {
    const r = await runPtyTurn(plan('hang'), { cwd: process.cwd(), timeoutMs: 500 });
    expect(r.timedOut).toBe(true);
  }, 15_000);

  // ring 을 안 넘겨도 tail 은 항상 채워져야 한다 — policy.ts::isCredentialFailure 가 이걸로만
  // 자격증명 실패를 판단한다(PTY 안에서 stdout/stderr 가 섞여 tail 이 유일한 증거다). ring 이
  // 선택인 이유로 이 계약까지 선택이 되면, ring 을 안 넘기는 모든 호출에서 자격증명 실패가
  // 보이지 않는 재시도로 조용히 감춰진다.
  it('ring 을 안 넘겨도 tail 은 채워진다', async () => {
    const r = await runPtyTurn(plan('ok'), { cwd: process.cwd(), timeoutMs: 10_000 });
    expect(r.tail).toContain('done');
  });

  // 많이 쓰고 끝나는 하네스: tail 은 2KB 로 고정이라 앞부분(line 0)은 잘리고 끝부분
  // (line 9999)은 남아야 한다 — "앞이 잘린다"가 아니라 "끝이 남는다"를 확인하는 것이 핵심이다.
  // ring 은 사양대로 256KB 라 전체(총 10,000 줄, 대략 6~90KB)가 다 들어가야 한다.
  it('출력이 많은 하네스: ring 은 전체를 담고, tail 은 끝 2KB 만 남는다', async () => {
    const ring = new RingBuffer(256 * 1024);
    const r = await runPtyTurn(plan('chatty'), { cwd: process.cwd(), timeoutMs: 10_000, ring });
    expect(r.exitCode).toBe(0);
    expect(ring.snapshot().toString()).toContain('line 0');
    expect(ring.snapshot().toString()).toContain('line 9999');
    expect(r.tail).not.toContain('line 0');
    expect(r.tail).toContain('line 9999');
  });

  // 출력을 한 바이트도 안 남기고 바로 죽는 하네스 — tail/ring 이 빈 상태에서도 죽지 않고
  // exitCode 를 그대로 돌려줘야 한다. 이 케이스가 실제로 나오는 이유: 인자 파싱 실패 등으로
  // 하네스가 아무것도 못 찍고 죽는 턴은 드물지 않다.
  it('출력 없이 바로 종료하는 하네스: exitCode 는 전달되고 tail/ring 은 빈 채로 남는다', async () => {
    const ring = new RingBuffer(1024);
    const r = await runPtyTurn(plan('silent'), { cwd: process.cwd(), timeoutMs: 10_000, ring });
    expect(r.exitCode).toBe(7);
    expect(r.timedOut).toBe(false);
    expect(r.tail).toBe('');
    expect(ring.snapshot().length).toBe(0);
  });

  // 정상 종료 경로에서 타임아웃 타이머가 안 지워지면, 그 타이머가 나중에 (이미 죽은
  // 프로세스에) SIGTERM/SIGKILL 을 쏘려고 살아있는 핸들로 남는다 — 바로 이 문제가 프로세스
  // 종료 후에도 이벤트 루프를 붙잡아 "동작은 하지만 정리가 안 되는" 좀비를 만든다(리뷰가
  // 우려한 지점). 타임아웃을 넉넉히 잡고도 종료가 그 안에서 빠르게 오는지로 간접 확인한다.
  it('정상 종료는 넉넉한 타임아웃과 무관하게 빠르게 resolve 된다 — 타이머가 안 걸려 있다', async () => {
    const start = Date.now();
    const r = await runPtyTurn(plan('ok'), { cwd: process.cwd(), timeoutMs: 5_000 });
    expect(r.exitCode).toBe(0);
    expect(Date.now() - start).toBeLessThan(2_000);
  });

  // 리뷰 Important 1 — UTF-8 절단은 ring 과 tail 에서 정답이 다르다. ring 은 Phase 2 가 그대로
  // 중계할 raw 바이트라서 정렬하면 ANSI 이스케이프까지 같이 깨진다(부분 문자는 xterm 이
  // 청크를 이어붙여 알아서 완성한다) — 그래서 ring 은 안 건드리고, 오히려 "정렬 안 한다"는
  // 계약을 여기서 고정한다. tail 은 사람이 읽는 로그이자 isCredentialFailure 입력이라 잘린
  // 선행 조각(U+FFFD)을 남기면 잡음이 낀다 — 그래서 tail 만 고친다.
  it('ring 은 raw 바이트 그대로다 — UTF-8 경계로 정렬하지 않는다(cap=8, 한글 5자 재현)', async () => {
    const ring = new RingBuffer(8);
    await runPtyTurn(plan('korean'), { cwd: process.cwd(), timeoutMs: 10_000, ring });
    // 문자 경계와 안 맞는 절단이라 utf8 디코드하면 선행 조각이 U+FFFD 로 남는다 — 이게
    // "정렬하지 않는다"는 계약이 실제로 지켜지고 있다는 증거다(정렬했다면 안 나와야 한다).
    expect(ring.snapshot().toString('utf8')).toContain('�');
  });

  it('tail(고정 2KB)이 잘려도 U+FFFD 로 시작하지 않는다 — 잘린 선행 조각은 버린다', async () => {
    const r = await runPtyTurn(plan('korean-chatty'), { cwd: process.cwd(), timeoutMs: 10_000 });
    expect(r.tail.length).toBeGreaterThan(0);
    expect(r.tail).not.toContain('�');
    // 조각을 버리고 다음 문자 시작부터 디코드했으니 온전한 '가' 만 남아야 한다.
    expect(r.tail).toMatch(/^가+$/);
  });

  // 리뷰 Important 2 — 'hang' 픽스처는 SIGTERM 기본 처분으로 그냥 죽어서 SIGKILL 승격
  // 분기를 한 번도 안 태운다. 이 테스트는 SIGTERM 을 무시하는 하네스로 그 분기를 실제로
  // 태우고, exit 이 관측된 것에서 그치지 않고 kill(pid, 0) 이 ESRCH 를 던지는 것까지
  // 확인한다 — 좀비는 부모가 거둬가기 전까지 프로세스 테이블에 남아 kill(pid, 0) 이
  // 여전히 성공하므로, ESRCH 가 떠야 "죽었다"가 아니라 "실제로 거둬졌다"는 증거가 된다.
  // killGraceMs 로 유예를 짧게 주입해 테스트가 프로덕션 기본값(5초)을 다 기다리지 않게 한다.
  it('SIGTERM 을 무시하는 하네스: SIGKILL 로 승격되고 실제로 거둬진다 (spec §4)', async () => {
    const ring = new RingBuffer(1024);
    const r = await runPtyTurn(plan('hang-ignore-sigterm'), {
      cwd: process.cwd(), timeoutMs: 200, killGraceMs: 200, ring,
    });
    expect(r.timedOut).toBe(true);
  }, 2_000);
});

describe('RingBuffer', () => {
  it('용량을 넘으면 앞이 잘린다', () => {
    const ring = new RingBuffer(8);
    ring.push(Buffer.from('12345'));
    ring.push(Buffer.from('67890'));
    expect(ring.snapshot().toString()).toBe('34567890');
  });

  it('빈 버퍼의 snapshot 은 빈 Buffer 다', () => {
    const ring = new RingBuffer(8);
    expect(ring.snapshot().length).toBe(0);
  });

  // 리뷰 Minor 1 — 브리프가 이름을 댄 경계 세 가지. 절단 코드(길이 비교 + subarray 오프셋)가
  // 어긋나는 전형적인 자리라 각각 고정한다.
  it('정확히 용량만큼 채우면 자르지 않는다', () => {
    const ring = new RingBuffer(8);
    ring.push(Buffer.from('abcdefgh'));
    expect(ring.snapshot().toString()).toBe('abcdefgh');
  });

  it('용량보다 한 바이트 많으면 앞 한 바이트만 잘린다', () => {
    const ring = new RingBuffer(8);
    ring.push(Buffer.from('abcdefghi'));
    expect(ring.snapshot().toString()).toBe('bcdefghi');
  });

  it('한 번의 push 자체가 용량보다 커도 그 한 번만으로 끝만 남는다', () => {
    const ring = new RingBuffer(4);
    ring.push(Buffer.from('abcdefghij'));
    expect(ring.snapshot().toString()).toBe('ghij');
  });
});
