import { mkdtemp, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { SessionStore } from '../src/sessions.js';

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

  // put 은 스레드마다 독립적으로 호출된다 — 한 프로세스 안에서 두 스레드가 동시에 답장하면
  // put 두 번이 겹친다. 직렬화 없이 스냅샷을 각자 tmp 에 썼다가 rename 하면, 먼저 시작한
  // 쓰기가 나중에 끝나면서 최신 상태를 옛 스냅샷으로 덮어써 한쪽 세션이 사라질 수 있다.
  it('동시에 put 두 번이 들어와도 둘 다 남는다 — 느리게 끝난 쓰기가 최신 상태를 덮어쓰지 않는다', async () => {
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
