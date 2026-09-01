import { mkdtemp, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { SessionStore } from '../src/sessions.js';

// node:fs/promises 는 ESM 내장 모듈이라 export 를 직접 vi.spyOn 할 수 없다("module namespace
// is not configurable"). readFile 만 vi.fn 으로 감싸 기본 동작은 실제 구현으로 통과시키고,
// 권한 실패 테스트에서만 그 한 번을 mockRejectedValueOnce 로 대체한다.
vi.mock('node:fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs/promises')>();
  return { ...actual, readFile: vi.fn(actual.readFile) };
});

describe('SessionStore', () => {
  const rec = { workspaceDir: '/w', sessionId: 'abc', harness: 'claude-code' as const, lastFedSeq: 7 };

  it('threadKey 는 채널 최상위를 _root 로 구분한다', () => {
    expect(SessionStore.threadKey('ch1', null)).toBe('ch1/_root');
    expect(SessionStore.threadKey('ch1', 'm9')).toBe('ch1/m9');
  });

  it('put 한 것을 새 인스턴스의 load 가 읽는다 — 러너 재시작 무손실 (spec §1)', async () => {
    const file = join(await mkdtemp(join(tmpdir(), 'sess-')), 'sessions.json');
    const a = new SessionStore(file);
    await a.load();
    await a.put('ch1/m9', rec);
    const b = new SessionStore(file);
    await b.load();
    expect(b.get('ch1/m9')).toEqual(rec);
  });

  it('파일이 없으면 빈 상태로 시작한다', async () => {
    const s = new SessionStore(join(await mkdtemp(join(tmpdir(), 'sess-')), 'none.json'));
    await s.load();
    expect(s.get('x/_root')).toBeUndefined();
  });

  it('깨진 파일은 빈 상태 + 백업으로 시작한다 — 세션을 잃어도 죽지는 않는다', async () => {
    const file = join(await mkdtemp(join(tmpdir(), 'sess-')), 'sessions.json');
    await (await import('node:fs/promises')).writeFile(file, '{broken');
    const s = new SessionStore(file);
    await s.load();                        // throw 하지 않는다
    expect(s.get('x/_root')).toBeUndefined();
  });

  // load 는 러너 기동 경로에 있다 — ENOENT 가 아닌 에러(권한 등)를 그대로 던지면 러너가
  // 아예 안 뜬다. 실제 권한 파일로 재현하면 root 로 도는 CI 에서는 권한이 무시돼 통과하지
  // 않을 수 있어, readFile 자체를 스텁해 결정적으로 재현한다.
  it('ENOENT 가 아닌 읽기 실패(권한 등)에도 load 는 죽지 않고 빈 상태가 된다', async () => {
    const file = join(await mkdtemp(join(tmpdir(), 'sess-')), 'sessions.json');
    vi.mocked(readFile).mockRejectedValueOnce(
      Object.assign(new Error('permission denied'), { code: 'EACCES' }),
    );

    const s = new SessionStore(file);
    await expect(s.load()).resolves.toBeUndefined();
    expect(s.get('x/_root')).toBeUndefined();
  });

  // 유효한 JSON 이지만 세션 맵(객체) 모양이 아니면 Object.entries 가 예외 없이 통과해서
  // 쓰레기 키('0','1',…)로 조용히 채워질 수 있다 — 파싱 실패와 같은 손상으로 보고 같은
  // 경로(백업 + 빈 상태)로 보내야 한다.
  it.each([['[1,2,3]'], ['"문자열"']])('비객체 JSON %s 은 빈 상태 + 백업으로 시작한다', async (json) => {
    const file = join(await mkdtemp(join(tmpdir(), 'sess-')), 'sessions.json');
    await (await import('node:fs/promises')).writeFile(file, json);

    const s = new SessionStore(file);
    await s.load();

    expect(s.get('x/_root')).toBeUndefined();
  });

  // 레코드 하나만 모양이 깨졌다고 스레드 전체의 세션을 잃을 이유는 없다 — 그 레코드만
  // 버리고 나머지는 살아남는다.
  it('레코드 하나만 SessionRecord 모양이 아니면 그것만 버리고 나머지는 살아남는다', async () => {
    const file = join(await mkdtemp(join(tmpdir(), 'sess-')), 'sessions.json');
    await (await import('node:fs/promises')).writeFile(
      file,
      JSON.stringify({
        'ch1/m9': rec,
        'ch1/broken': { workspaceDir: '/w', harness: 'not-a-real-harness', lastFedSeq: 'seven' },
      }),
    );

    const s = new SessionStore(file);
    await s.load();

    expect(s.get('ch1/m9')).toEqual(rec);
    expect(s.get('ch1/broken')).toBeUndefined();
  });

  // put 은 스레드마다 독립적으로 호출된다 — 한 프로세스 안에서 두 스레드가 동시에 답장하면
  // flush 도 두 번 겹친다. tmp 경로가 고정이었던 첫 구현은 먼저 끝난 rename 이 tmp 파일을
  // 치워버려서 나중 rename 이 ENOENT 로 죽었다(스냅샷 역전이 아니라 파일 경합) — 유일한
  // tmp 이름 + 쓰기 큐로 막는다.
  it('동시에 put 두 번이 들어와도 죽지 않고 둘 다 남는다 — tmp 파일명 충돌로 인한 rename ENOENT 회귀', async () => {
    const file = join(await mkdtemp(join(tmpdir(), 'sess-')), 'sessions.json');
    const a = new SessionStore(file);
    await a.load();

    await Promise.all([
      a.put('ch1/m1', { ...rec, lastFedSeq: 1 }),
      a.put('ch1/m2', { ...rec, lastFedSeq: 2 }),
    ]);

    const b = new SessionStore(file);
    await b.load();
    expect(b.get('ch1/m1')).toEqual({ ...rec, lastFedSeq: 1 });
    expect(b.get('ch1/m2')).toEqual({ ...rec, lastFedSeq: 2 });
  });
});
