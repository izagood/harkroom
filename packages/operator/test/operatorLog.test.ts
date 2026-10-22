// 오퍼레이터 로그 상한·회전(2026-10-22). 앱이 stdout 을 이어 쓰기로 붙인 파일을 copy-truncate 로 민다.
import { describe, it, expect, afterEach } from 'vitest';
import { closeSync, mkdtempSync, openSync, readFileSync, rmSync, statSync, writeFileSync, writeSync, existsSync, symlinkSync, lstatSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createOperatorLog, operatorLogPathFromSocket, nodeOperatorLogFs, openExclusive, type OperatorLogFs } from '../src/operatorLog.js';

const dirs: string[] = [];
const fds: number[] = [];
afterEach(() => {
  for (const fd of fds.splice(0)) { try { closeSync(fd); } catch { /* 이미 닫힘 */ } }
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

/** 앱처럼 이어 쓰기로 연 파일 하나와, 그 fd 에 쓰는 write. */
function appendTarget() {
  const dir = mkdtempSync(join(tmpdir(), 'oplog-'));
  dirs.push(dir);
  const path = join(dir, 'operator-v1.log');
  const fd = openSync(path, 'a');
  fds.push(fd);
  const write = (line: string) => { writeSync(fd, `${line}\n`); };
  return { dir, path, fd, write };
}

describe('operatorLogPathFromSocket', () => {
  it('앱 규칙대로 .sock 옆의 .log 다 — 다른 꼴이면 모른다', () => {
    expect(operatorLogPathFromSocket('/x/operator/operator-v1.sock')).toBe('/x/operator/operator-v1.log');
    expect(operatorLogPathFromSocket('/x/operator/sock')).toBeNull();
  });
});

describe('오퍼레이터 로그 회전(copy-truncate)', () => {
  it('상한을 넘으면 꼬리를 .1 로 베끼고 같은 파일을 비운다 — 이어 쓰기 fd 는 0 바이트 자리부터 다시 쓴다', () => {
    const t = appendTarget();
    const op = createOperatorLog({ path: t.path, fd: t.fd, write: t.write, maxBytes: 1000, checkEveryBytes: 200 });
    for (let i = 0; i < 40; i += 1) op.log(`line-${String(i).padStart(3, '0')} ${'x'.repeat(40)}`);
    expect(existsSync(`${t.path}.1`)).toBe(true);
    // .1 에는 꼬리만(상한 이하), 본 파일은 상한 아래로 내려왔다.
    expect(statSync(`${t.path}.1`).size).toBeLessThanOrEqual(1000);
    expect(statSync(t.path).size).toBeLessThan(1000);
    const now = readFileSync(t.path, 'utf8');
    expect(now).toMatch(/상한 1000바이트를 넘어 꼬리를 \.1 로 밀고 비웠다/);
    expect(now).toContain('line-039');
  });

  it('두 번째 회전은 옛 .1 을 덮는다 — 보관은 하나뿐이다', () => {
    const t = appendTarget();
    const op = createOperatorLog({ path: t.path, fd: t.fd, write: t.write, maxBytes: 500, checkEveryBytes: 100 });
    for (let i = 0; i < 20; i += 1) op.log(`first-${i} ${'a'.repeat(40)}`);
    const firstOld = readFileSync(`${t.path}.1`, 'utf8');
    expect(firstOld).toContain('first-');
    for (let i = 0; i < 40; i += 1) op.log(`second-${i} ${'b'.repeat(40)}`);
    const secondOld = readFileSync(`${t.path}.1`, 'utf8');
    expect(secondOld).toContain('second-');
    expect(secondOld).not.toContain('first-0 ');
    expect(existsSync(`${t.path}.2`)).toBe(false);
  });

  it('기동 때 이미 큰 파일도 한 번에 민다 — .1 에는 꼬리 상한만큼만', () => {
    const t = appendTarget();
    writeFileSync(t.path, 'y'.repeat(5000));
    const op = createOperatorLog({ path: t.path, fd: t.fd, write: t.write, maxBytes: 1000 });
    op.rotateIfLarge();
    expect(statSync(`${t.path}.1`).size).toBe(1000);
    expect(statSync(t.path).size).toBeLessThan(200);
  });

  it('stdout 이 그 파일이 아니면(원격 호스트 등) 남의 파일을 자르지 않는다', () => {
    const t = appendTarget();
    const other = join(t.dir, 'other.log');
    writeFileSync(other, 'z'.repeat(5000));
    const op = createOperatorLog({ path: other, fd: t.fd, write: t.write, maxBytes: 100 });
    for (let i = 0; i < 10; i += 1) op.log('w'.repeat(50));
    op.rotateIfLarge();
    expect(statSync(other).size).toBe(5000);
    expect(existsSync(`${other}.1`)).toBe(false);
  });

  it('path 가 null 이면 회전하지 않고 쓰기만 한다', () => {
    const lines: string[] = [];
    const op = createOperatorLog({ path: null, write: (l) => lines.push(l), checkEveryBytes: 1 });
    op.log('a');
    op.log('b');
    expect(lines).toEqual(['a', 'b']);
  });
});

describe('회전 임시 파일은 O_EXCL 로 연다(security #1459 n1)', () => {
  it('같은 이름이 남의 파일을 가리키는 심링크여도 따라가 쓰지 않는다 — 링크만 지우고 새로 만든다', () => {
    const dir = mkdtempSync(join(tmpdir(), 'oplog-ex-'));
    try {
      const victim = join(dir, 'victim.txt');
      writeFileSync(victim, 'keep');
      const tmp = join(dir, 'x.log.1.tmp-1');
      symlinkSync(victim, tmp);
      const fd = openExclusive(tmp);
      writeSync(fd, 'new');
      closeSync(fd);
      expect(readFileSync(victim, 'utf8')).toBe('keep');
      expect(lstatSync(tmp).isSymbolicLink()).toBe(false);
      expect(readFileSync(tmp, 'utf8')).toBe('new');
      expect(statSync(tmp).mode & 0o777).toBe(0o600);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('실패해도 죽지 않는다', () => {
  const big = { size: 10_000, dev: 1, ino: 2, isFile: () => true };

  it('ENOSPC 로 베끼지 못하면 베끼지 않고 비운다 — 알림은 1분에 한 줄', () => {
    const truncated: number[] = [];
    const warns: string[] = [];
    let t = 0;
    const fs: OperatorLogFs = {
      fstat: () => big,
      stat: () => ({ size: big.size, dev: 1, ino: 2 }),
      copyTail: () => { throw Object.assign(new Error('no space'), { code: 'ENOSPC' }); },
      ftruncate: (_fd, len) => { truncated.push(len); },
    };
    const lines: string[] = [];
    const op = createOperatorLog({ path: '/p/operator-v1.log', write: (l) => lines.push(l), warn: (l) => warns.push(l), fs, maxBytes: 100, now: () => t });
    expect(() => op.rotateIfLarge()).not.toThrow();
    expect(truncated).toEqual([0]);
    expect(lines.at(-1)).toMatch(/비웠다\(\.1 사본 없음\)/);
    op.rotateIfLarge();
    t += 61_000;
    op.rotateIfLarge();
    expect(warns.filter((w) => w.includes('ENOSPC'))).toHaveLength(2);
  });

  it('쓰기가 던져도(ENOSPC) log 는 던지지 않고, 다음 줄은 다시 쓴다', () => {
    let fail = true;
    const lines: string[] = [];
    const warns: string[] = [];
    const op = createOperatorLog({
      path: null,
      write: (l) => { if (fail) throw Object.assign(new Error('full'), { code: 'ENOSPC' }); lines.push(l); },
      warn: (l) => warns.push(l),
    });
    expect(() => op.log('lost')).not.toThrow();
    fail = false;
    op.log('kept');
    expect(lines).toEqual(['kept']);
    expect(warns[0]).toMatch(/ENOSPC/);
  });

  it('fstat 자체가 실패해도 던지지 않는다', () => {
    const fs: OperatorLogFs = { ...nodeOperatorLogFs, fstat: () => { throw Object.assign(new Error('bad fd'), { code: 'EBADF' }); } };
    const warns: string[] = [];
    const op = createOperatorLog({ path: '/p/operator-v1.log', fd: 999, fs, warn: (l) => warns.push(l), write: () => {} });
    expect(() => op.rotateIfLarge()).not.toThrow();
    expect(warns[0]).toMatch(/EBADF/);
  });
});
