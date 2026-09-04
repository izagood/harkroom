import { tmpdir } from 'node:os';
import { chmod, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import { basename, delimiter, join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { composeSpawn, RingBuffer, resolveExecutable, runPtyTurn, type PtyWriter } from '../src/pty.js';
import { ExecutableNotFoundError } from '../src/policy.js';

const fake = join(dirname(fileURLToPath(import.meta.url)), 'helpers/fake-harness.mjs');
// **부모 env 를 펼치지 않는다 — 프로덕션 plan 의 실제 모양과 같아야 한다.** 예전엔
// `{ ...process.env, FAKE_MODE: mode }` 로 이 테스트가 직접 부모 env 를 물려줬는데, 그
// 우회가 `buildTurnCommand`(turn.ts)의 실제 반환값(한때 `{ MURMUR_PAT }` 하나뿐이라 PATH·
// HOME 이 없었다)과 이 계약 테스트 사이의 간극을 가려 실물 검증에서야 드러난 회귀를 놓쳤다
// (turn.ts::childEnv 참고). `process.execPath` 는 절대경로라 PATH 없이도 그대로 실행되고,
// 가짜 하네스(fake-harness.mjs)는 FAKE_MODE 말고 다른 env 를 읽지 않는다 — 이 시나리오에서
// PATH 없이도 통과한다는 것 자체가 이 테스트가 이제 프로덕션 plan 의 실제 모양을 검증한다는
// 증거다.
const plan = (mode: string) => ({ command: process.execPath, args: [fake], env: { FAKE_MODE: mode } as Record<string, string>, stdinFile: null });

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
    // pid 는 ring 이 아니라 **파일**에서 읽는다. stdout 은 PTY 를 거치므로 SIGKILL 로 pty 가
    // 닫히면 `pid=` 줄이 ring 에 도달하기 전에 유실될 수 있고, CI 부하에서 실제로 그렇게
    // 실패했다(`expected null not to be null`). 그건 PID 재사용이 아니라 **출력 경쟁**이었다 —
    // 그래서 단언을 지우는 게 아니라 pid 를 얻는 경로를 경쟁 없는 것으로 바꾼다.
    const dir = await mkdtemp(join(tmpdir(), 'pty-pid-'));
    const pidFile = join(dir, 'pid');
    const termFile = join(dir, 'term-seen');
    try {
      const p = plan('hang-ignore-sigterm');
      p.env.FAKE_PID_FILE = pidFile;
      p.env.FAKE_SIGTERM_FILE = termFile;
      // 하네스가 **준비됐는지**를 기다린다 — 시간이 아니라 상태다(#391).
      //
      // **이 대기가 동기라는 것이 핵심이다.** 타임아웃 타이머의 콜백은 이 스레드가 이벤트
      // 루프로 돌아와야 발화하는데, 여기서 스레드를 막고 있는 동안은 돌아가지 않는다 —
      // 그래서 `timeoutMs` 를 한 ms 도 늘리지 않으면서 "준비된 하네스에게서 200ms" 를
      // 만든다. 부하가 더 커지면 준비를 더 기다릴 뿐이라 다시 새지 않는다.
      //
      // **이 대기를 `await` 로 바꾸지 마라** — 비동기가 되는 순간 이벤트 루프가 돌아 시계가
      // 흐르고, 이 대기가 조용히 무력해진다. (타이머를 `onSpawn` **앞뒤** 어디에 등록하든
      // 결과는 같다 — 통제 실험 4/4 초록. 등록 순서가 아니라 동기성이 이것을 성립시킨다.)
      //
      // 재우면서 기다리는 이유(`Atomics.wait`): busy loop 으로 돌면 이 스레드가 자식과 CPU 를
      // 다투어 준비를 **더** 늦춘다 — 부하가 원인인 결함에 부하를 더 얹는 대기는 쓸 수 없다.
      let ready = false;
      const idle = new Int32Array(new SharedArrayBuffer(4));
      const r = await runPtyTurn(p, {
        cwd: process.cwd(), timeoutMs: 200, killGraceMs: 200,
        onSpawn: () => {
          const until = Date.now() + 15_000;
          while (!existsSync(pidFile)) {
            // 영영 안 생기면 여기서 매달리지 않는다 — 그때는 아래 단언이 원인을 말해 준다.
            if (Date.now() > until) return;
            Atomics.wait(idle, 0, 0, 10);
          }
          ready = true;
        },
      });
      // 준비 확인이 **먼저다.** 이것이 거짓이면 아래 단언들은 승격 경로가 아니라 다른 사건을
      // 재고 있다(#391 실측: 하네스가 SIGTERM 기본 처분으로 죽고 승격이 안 탔다).
      expect(ready).toBe(true);
      expect(r.timedOut).toBe(true);
      // 하네스가 SIGTERM 을 **받고도 살아남았다**는 증거다. 이 단언이 없으면 하네스가
      // SIGTERM 에 그냥 죽은 경우도 (pid 파일이 있고 프로세스가 사라졌으니) 초록이 되어,
      // 승격 경로를 한 번도 안 태우고 통과한다 — #391 이 실제로 그 상태였다.
      expect(existsSync(termFile)).toBe(true);

      const pid = Number(await readFile(pidFile, 'utf8'));
      expect(Number.isInteger(pid)).toBe(true);

      // 좀비는 부모가 거둬가기 전까지 프로세스 테이블에 남아 `kill(pid, 0)` 이 여전히
      // 성공한다. ESRCH 가 떠야 "죽었다"가 아니라 **실제로 거둬졌다**는 증거다. 거두기는
      // exit 관측 직후 몇 ms 안에 끝나지만, 부하에서 그 순간이 밀릴 수 있으므로 시간을
      // 재는 대신 **그 사건이 오기를** 짧게 기다린다.
      const reaped = async (): Promise<boolean> => {
        try { process.kill(pid, 0); return false; } catch { return true; }
      };
      const until = Date.now() + 5_000;
      while (!(await reaped())) {
        if (Date.now() > until) throw new Error(`pid ${pid} 가 5초 안에 거둬지지 않았다`);
        await new Promise((r2) => setTimeout(r2, 20));
      }
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  }, 20_000);
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

describe('#315 runPtyTurn — attach 한 사람의 입력이 PTY stdin 에 닿는다', () => {
  it('onSpawn 이 준 통로로 넣은 바이트가 하네스의 stdin 에 그대로 도착한다', async () => {
    const ring = new RingBuffer(256 * 1024);
    // 제어 바이트(위 화살표)를 섞는다 — 글자만 보내는 테스트는 문자열 왕복으로도 통과해
    // "바이트 그대로"를 지키지 못한다.
    const typed = Buffer.from('\x1b[Ayes\r', 'binary');

    const r = await runPtyTurn(plan('stdin-live'), {
      cwd: process.cwd(), timeoutMs: 10_000, ring,
      onSpawn: (writer) => writer.write(typed),
    });

    // 하네스가 stdin 에서 읽은 것을 hex 로 되뱉는다. 개행은 PTY 의 라인 디서플린이
    // \r → \n 으로 바꾸므로 마지막 바이트는 비교에서 뺀다 — 그 변환은 터미널의 정상
    // 동작이고, 이 테스트가 지키는 것은 **그 앞의 바이트가 하나도 안 변했다**는 것이다.
    expect(r.exitCode).toBe(0);
    const echoed = ring.snapshot().toString('utf8');
    expect(echoed).toContain('got:');
    expect(echoed).toContain(Buffer.from('\x1b[Ayes', 'binary').toString('hex'));
  });
});

describe('#337 runPtyTurn — 인터랙티브 턴의 재료(무기한·resize·kill)', () => {
  // `timeoutMs: 0` 을 setTimeout 에 그대로 넣으면 타이머가 **즉시** 발화한다 — 인터랙티브
  // 턴이 뜨자마자 SIGTERM 을 맞는 정확히 그 결함이다(#337 선행 블로커). 0 이면 타이머를
  // 아예 걸지 않아야 하고, 그 턴의 끝은 exit(여기서는 사람의 "exit" 입력 흉내)뿐이다.
  it('timeoutMs 0 은 무기한이다 — 타이머가 즉시 발화해 턴을 죽이지 않는다', async () => {
    const ring = new RingBuffer(256 * 1024);
    const r = await runPtyTurn(plan('echo-stdin-live'), {
      cwd: process.cwd(), timeoutMs: 0, ring,
      onSpawn: (controls) => {
        // 하네스가 뜬 뒤(0 타이머가 있었다면 이미 SIGTERM 을 맞았을 시점보다 뒤)에
        // 사람이 종료를 치는 상황 — 1초를 살아남는 것 자체가 "타이머가 없다"의 증거다.
        setTimeout(() => controls.write(Buffer.from('exit\r')), 1_000);
      },
    });
    expect(r.exitCode).toBe(0);
    expect(r.timedOut).toBe(false);
    expect(ring.snapshot().toString()).toContain('interactive-ready');
  }, 15_000);

  it('resize 가 자식에 SIGWINCH 로 닿고 새 크기가 보인다 (스파이크 §3 고정)', async () => {
    const ring = new RingBuffer(256 * 1024);
    const r = await runPtyTurn(plan('report-winch'), {
      cwd: process.cwd(), timeoutMs: 0, cols: 80, rows: 24, ring,
      onSpawn: (controls) => { setTimeout(() => controls.resize(100, 50), 300); },
    });
    expect(r.exitCode).toBe(0);
    const out = ring.snapshot().toString();
    expect(out).toContain('ready 80x24');
    expect(out).toContain('winch 100x50');
  }, 15_000);

  it('kill 이 무기한 턴을 끝낸다 — 고아 회수(viewer 0 → 유예 → SIGTERM)의 손잡이', async () => {
    const r = await runPtyTurn(plan('echo-stdin-live'), {
      cwd: process.cwd(), timeoutMs: 0,
      onSpawn: (controls) => { setTimeout(() => controls.kill('SIGTERM'), 300); },
    });
    // SIGTERM 으로 죽은 프로세스는 exit 0 이 아니다 — 무엇이든 좋다, 끝났다는 사실이 계약이다.
    expect(r.timedOut).toBe(false);
  }, 15_000);

  it('exit 후의 write·resize·kill 은 조용한 no-op 이다 — 마지막 화면에서의 조작은 오류가 아니다', async () => {
    let controls: import('../src/pty.js').PtyControls | null = null;
    await runPtyTurn(plan('ok'), {
      cwd: process.cwd(), timeoutMs: 10_000,
      onSpawn: (c) => { controls = c; },
    });
    const c = controls!;
    expect(() => { c.write(Buffer.from('x')); c.resize(10, 10); c.kill('SIGKILL'); }).not.toThrow();
  });
});

describe('#335-1 runPtyTurn — writer 패널 크기가 PTY 창 크기가 된다', () => {
  let writer: PtyWriter | null = null;
  beforeEach(() => { writer = null; });

  it('onSpawn 통로의 resize 가 하네스에 SIGWINCH 와 새 크기로 도착한다', async () => {
    const ring = new RingBuffer(256 * 1024);

    const r = await runPtyTurn(plan('winsize'), {
      cwd: process.cwd(), timeoutMs: 10_000, ring,
      // spawn 직후에 바로 부르면 하네스가 아직 SIGWINCH 핸들러를 걸기 전이다 —
      // 시그널을 놓치고 8초 뒤 12 로 죽는다. 첫 출력('start:')을 보고 나서 부른다.
      onData: (chunk) => {
        if (chunk.toString('utf8').includes('start:')) writer?.resize(100, 30);
      },
      onSpawn: (w) => { writer = w; },
    });

    // **프레임을 센 것이 아니라 하네스가 스스로 말한 크기다.** 숫자가 러너까지 왔다는
    // 것과 PTY 크기가 바뀌었다는 것은 다른 사실이고, 여기서 보는 것은 뒤쪽이다.
    expect(r.exitCode).toBe(0);
    const printed = ring.snapshot().toString('utf8');
    // spawn 기본값(120x40)과 **다른** 값으로 바꿨다는 것까지 본다 — 같은 값으로 확인하면
    // resize 를 아예 안 불러도 통과한다.
    expect(printed).toContain('start:120x40');
    expect(printed).toContain('winch:100x30');
  }, 15_000);
});

describe('runPtyTurn — stdin 파일 리다이렉션(#117)', () => {
  let dir: string;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'stdin-test-'));
  });

  afterEach(async () => {
    if (dir) await rm(dir, { recursive: true, force: true });
  });

  // stdinFile 이 없으면 PTY stdin 을 그대로 쓴다(인터랙티브·resume 경로 보존).
  it('stdinFile 이 null 이면 sh -c 로 감싸지 않는다 — 기존 동작 유지', async () => {
    const p = { command: process.execPath, args: [fake], env: { FAKE_MODE: 'ok' } as Record<string, string>, stdinFile: null };
    const r = await runPtyTurn(p, { cwd: process.cwd(), timeoutMs: 10_000 });
    expect(r.exitCode).toBe(0);
  });

  // stdinFile 이 있으면 sh -c 'exec ... < 파일' 로 감싸고, 그 파일 내용이 stdin 으로 간다.
  it('stdinFile 이 있으면 sh -c 로 감싸고 stdin 리다이렉션이 동작한다', async () => {
    const stdinFile = join(dir, 'prompt.txt');
    await writeFile(stdinFile, 'Hello from stdin', { encoding: 'utf8' });
    const p = { command: process.execPath, args: [fake], env: { FAKE_MODE: 'stdin-echo' } as Record<string, string>, stdinFile };
    const r = await runPtyTurn(p, { cwd: process.cwd(), timeoutMs: 10_000 });
    expect(r.exitCode).toBe(0);
    expect(r.tail).toContain('stdin-received: Hello from stdin');
  });

  // 공백이 포함된 경로·인자가 셸 인용을 통과한다.
  it('공백 포함 경로가 셸 인용을 통과한다', async () => {
    const stdinFile = join(dir, 'prompt with spaces.txt');
    await writeFile(stdinFile, 'test content', { encoding: 'utf8' });
    const p = { command: process.execPath, args: [fake], env: { FAKE_MODE: 'stdin-echo' } as Record<string, string>, stdinFile };
    const r = await runPtyTurn(p, { cwd: process.cwd(), timeoutMs: 10_000 });
    expect(r.exitCode).toBe(0);
    expect(r.tail).toContain('test content');
  });
});

// #380 1단계 실측 — pty.write() 로 프롬프트를 보내는 접근이 왜 3·4단계(sh -c 래핑 제거)로
// 진행되지 않았는지의 증거. 실측(macOS, claude 2.1.237 -p, codex-cli 0.153.2 exec, 둘 다
// 실제 CLI 로 직접 확인): 두 하네스 모두 stdin 이 tty(PTY) 면 프롬프트 위치인자 없이는
// **stdin 을 읽지 않고 즉시 실패한다** — spawn 직후 동기적으로 write() 해도 결과가 같아서
// race 가 아니라 `isatty(0)` 판정이다. 즉 stdinFile 을 없애고 `pty.write()` 로 프롬프트를
// 보내는 순간, 프로덕션이 실제로 쓰는 claude -p·codex exec 양쪽에서 턴이 통째로 실패한다.
// 이 블록은 그 실제 동작을 흉내낸 가짜 하네스(`isatty-reject` 모드)로 고정한다 — 이
// 테스트가 초록인 한, "stdinFile 을 제거해도 된다"는 전제가 성립하지 않는다는 뜻이다.
describe('#380 1단계 실측 — PTY stdin 이 tty 인 하네스는 write() 로 보낸 프롬프트를 못 받는다', () => {
  it('stdinFile 없이(PTY stdin 그대로) write() 로 보낸 프롬프트는 하네스에 닿지 못하고 즉시 실패한다', async () => {
    const ring = new RingBuffer(64 * 1024);
    const r = await runPtyTurn(
      { command: process.execPath, args: [fake], env: { FAKE_MODE: 'isatty-reject' } as Record<string, string>, stdinFile: null },
      {
        cwd: process.cwd(), timeoutMs: 10_000, ring,
        onSpawn: (writer) => writer.write(Buffer.from('MY_SECRET_PROMPT_MARKER_XYZ\n')),
      },
    );
    // 하네스는 프롬프트를 받지 못하고 tty 판정만으로 즉시 실패한다.
    expect(r.exitCode).toBe(1);
    const out = ring.snapshot().toString('utf8');
    expect(out).toContain('Input must be provided either through stdin');
    expect(out).not.toContain('prompt-received:');
    // **그런데 write() 로 보낸 프롬프트 자체는 PTY 가 그대로 에코한다** — 이것이 이슈가
    // 우려한 "tail 에 프롬프트가 섞인다"는 결함이 실제로 재현되는 지점이다. 하네스가 실패해서
    // 프롬프트를 못 쓰는 것과, 그 프롬프트가 tail 에 남는 것은 별개의 사실이다.
    expect(out).toContain('MY_SECRET_PROMPT_MARKER_XYZ');
  });
});

// composeSpawn 은 순수 함수라 조립된 문자열을 직접 단정할 수 있다. runPtyTurn 안에
// 갇혀 있었을 때는 테스트가 "종료 코드가 0이다" 로 갈음했고, 그건 exec 가 없어도
// 통과했다 — 아무것도 지키지 않는 테스트였다.
describe('composeSpawn — sh -c 조립(#117)', () => {
  const base = { command: '/bin/harness', args: ['-p', 'x'], env: {} as Record<string, string> };

  it('stdinFile 이 null 이면 감싸지 않는다', () => {
    const r = composeSpawn({ ...base, stdinFile: null });
    expect(r.command).toBe('/bin/harness');
    expect(r.args).toEqual(['-p', 'x']);
  });

  // exec 가 없으면 최종 프로세스가 sh 가 되어 시그널이 하네스에 닿지 않는다.
  it('exec 로 시작한다', () => {
    const r = composeSpawn({ ...base, stdinFile: '/tmp/p.txt' });
    expect(r.command).toBe('sh');
    expect(r.args[0]).toBe('-c');
    expect(r.args[1]!.startsWith('exec ')).toBe(true);
  });

  it('명령·인자·파일 경로를 모두 인용한다', () => {
    const r = composeSpawn({
      command: '/opt/my bin/harness', args: ['--flag', 'two words'], env: {},
      stdinFile: '/tmp/prompt with spaces.txt',
    });
    expect(r.args[1]).toBe(
      "exec '/opt/my bin/harness' '--flag' 'two words' < '/tmp/prompt with spaces.txt'",
    );
  });

  // 단일 인용부호가 든 값에서 셸 인용이 깨지면 임의 명령이 실행될 수 있다.
  it('단일 인용부호를 전치한다', () => {
    const r = composeSpawn({ ...base, args: ["it's"], stdinFile: '/tmp/p.txt' });
    // String.raw 로 쓴다 — 백슬래시와 인용부호가 섞이면 JS 이스케이프가 기대값을
    // 조용히 바꾼다(실제로 한 번 그렇게 틀렸다).
    expect(r.args[1]).toContain(String.raw`'it'\''s'`);
  });

  // 대화 본문이 argv 로 새지 않는다는 것이 이 이슈의 요구다 — 조립된 문자열에도
  // 본문이 없어야 하고, 경로만 있어야 한다.
  it('조립된 문자열에 파일 경로만 있고 본문은 없다', () => {
    const r = composeSpawn({ ...base, stdinFile: '/tmp/p.txt' });
    expect(r.args[1]).toContain('/tmp/p.txt');
    expect(r.args[1]).not.toContain('사람이 쓴 대화 본문');
  });
});

describe('#340 하네스 실행 파일 부재 — spawn 전에 잡고 reject 한다', () => {
  // **왜 spawn 예외에 기대면 안 되는지가 이 블록의 전제다.** 실측(macOS, node-pty
  // 1.2.0-beta.15): 없는 실행 파일로 `pty.spawn` 을 불러도 던지지 않는다 — forkpty 는 성공하고
  // 자식의 execvp 가 실패해 출력 없이 exitCode 1 로 끝난다. 즉 "spawn 이 ENOENT 를 던진다"에만
  // 기댄 판본은 이 결함이 실제로 나는 macOS(=launchd) 에서 **한 번도 안 탄다**. 그래서 아래
  // 테스트들은 전부 `runPtyTurn` 을 진짜로 부른다 — 가짜 spawn 을 세워 두고 그것을 검사하면
  // 바로 그 간극을 다시 만든다.
  const opts = { cwd: process.cwd(), timeoutMs: 5_000 };

  it('없는 절대경로 하네스: ExecutableNotFoundError 로 reject 한다', async () => {
    const p = { command: '/nonexistent/bin/harness-xyz', args: [], env: {} as Record<string, string>, stdinFile: null };
    await expect(runPtyTurn(p, opts)).rejects.toBeInstanceOf(ExecutableNotFoundError);
  });

  // 이 이슈가 말하는 실제 사고다: 하네스 이름은 맞는데(`claude`) 자식에게 넘긴 PATH 에 그것이
  // 없다 — launchd 가 로그인 셸의 PATH 를 안 물려준 러너. 오류가 **자식의 PATH** 를 들고 와야
  // 운영자가 로그만 보고 원인을 안다(러너 자신의 PATH 를 찍으면 아무 도움이 안 된다).
  it('PATH 에 없는 이름: reject 하고, 실행 파일 이름과 **자식의** PATH 를 들고 온다', async () => {
    const childPath = '/nonexistent/dir-a:/nonexistent/dir-b';
    const p = { command: 'harness-not-on-path', args: [], env: { PATH: childPath }, stdinFile: null };
    const err = await runPtyTurn(p, opts).then(() => null, (e: unknown) => e);
    expect(err).toBeInstanceOf(ExecutableNotFoundError);
    expect((err as ExecutableNotFoundError).command).toBe('harness-not-on-path');
    expect((err as ExecutableNotFoundError).path).toBe(childPath);
  });

  // 프로덕션 턴은 stdinFile 이 있어 `sh -c 'exec <하네스> ... < 파일'` 로 감싸인다. 그러면
  // spawn 대상이 `sh` 라 **spawn 은 언제나 성공하고** 하네스 부재는 sh 의 127 뒤로 숨는다.
  // 검사가 감싸기 전 `plan.command` 를 보지 않으면 이 경로에서 결함이 통째로 샌다.
  it('stdinFile 로 sh 에 감싸여도 하네스 부재를 잡는다 — sh 의 127 뒤로 숨지 않는다', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'enoent-stdin-'));
    try {
      const stdinFile = join(dir, 'prompt.txt');
      await writeFile(stdinFile, 'hi', { encoding: 'utf8' });
      const p = { command: '/nonexistent/bin/harness-xyz', args: [], env: {} as Record<string, string>, stdinFile };
      await expect(runPtyTurn(p, opts)).rejects.toBeInstanceOf(ExecutableNotFoundError);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  // 거짓 양성 회귀선. 사전 검사가 항상 던지도록 깨지면 **모든 턴이** 러너를 죽인다 — 위
  // 세 단언만으로는 그 사고가 전부 초록이다.
  it('있는 하네스는 그대로 돈다 — 사전 검사가 정상 턴을 막지 않는다', async () => {
    const r = await runPtyTurn(plan('ok'), { cwd: process.cwd(), timeoutMs: 10_000 });
    expect(r.exitCode).toBe(0);
  });

  // 다른 실패는 이 이슈의 대상이 아니다 — 재시도로 나을 수 있으므로 결과값(exitCode)으로
  // 돌아와야 하고, reject 로 승격되면 안 된다.
  it('일반 프로세스 실패는 reject 가 아니라 exitCode 로 돌아온다 (재시도 보존)', async () => {
    const p = { command: process.execPath, args: ['-e', 'process.exit(1)'], env: {} as Record<string, string>, stdinFile: null };
    const r = await runPtyTurn(p, { cwd: process.cwd(), timeoutMs: 5_000 });
    expect(r.exitCode).toBe(1);
  });
});

// `resolveExecutable` 은 순수 함수라 규칙을 직접 단정할 수 있다. runPtyTurn 안에 갇혀 있으면
// "reject 했다" 로만 갈음하게 되고, 그건 검사가 통째로 "언제나 못 찾았다" 여도 통과한다.
describe('resolveExecutable — execvp 규칙(#340)', () => {
  it('`/` 가 든 이름은 PATH 를 안 뒤진다 — 그 경로만 본다', () => {
    // process.execPath 는 실행 가능한 절대경로다. PATH 를 비워도 찾아야 한다.
    expect(resolveExecutable(process.execPath, '')).toBe(process.execPath);
    expect(resolveExecutable('/nonexistent/bin/x', process.env.PATH)).toBeNull();
  });

  it('맨 이름은 PATH 를 순서대로 뒤진다', () => {
    const dir = dirname(process.execPath);
    const name = basename(process.execPath);
    expect(resolveExecutable(name, `/nonexistent/dir${delimiter}${dir}`)).toBe(join(dir, name));
  });

  it('PATH 가 비었거나 없으면 못 찾는다 — 빈 PATH 로 뜬 러너가 이 결함의 원인이다', () => {
    const name = basename(process.execPath);
    expect(resolveExecutable(name, '')).toBeNull();
    expect(resolveExecutable(name, undefined)).toBeNull();
  });

  // 실행 비트가 없는 파일은 "있지만 못 돌린다" — execvp 도 EACCES 로 실패한다. 존재만 보면
  // 이 경우를 놓치고, 러너는 잡을 수 있었던 설정 오류를 일반 실패로 흘린다.
  it('읽을 수는 있지만 실행 비트가 없는 파일은 못 찾은 것으로 본다', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'noexec-'));
    try {
      const f = join(dir, 'harness');
      await writeFile(f, '#!/bin/sh\n', { encoding: 'utf8', mode: 0o644 });
      expect(resolveExecutable('harness', dir)).toBeNull();
      await chmod(f, 0o755);
      expect(resolveExecutable('harness', dir)).toBe(f);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
