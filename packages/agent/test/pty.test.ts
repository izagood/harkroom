import { tmpdir } from 'node:os';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { composeSpawn, RingBuffer, runPtyTurn } from '../src/pty.js';

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
    try {
      const p = plan('hang-ignore-sigterm');
      p.env.FAKE_PID_FILE = pidFile;
      const r = await runPtyTurn(p, { cwd: process.cwd(), timeoutMs: 200, killGraceMs: 200 });
      expect(r.timedOut).toBe(true);

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
