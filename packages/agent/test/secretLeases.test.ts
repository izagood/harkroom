import { describe, it, expect } from 'vitest';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createSecretLeases } from '../src/secretLeases.js';

// 비밀 보관소 PR 3 — 러너의 턴 임대(R1)와 놓기 전 기록 가리기(D7). 스레드 bc98df3a.
const VALUE = `ghp_${'e'.repeat(36)}`;

function harness(issueResult: { id: string; token: string; expiresAt: string } | null | 'throw', turnSecretsDir: string | null = null) {
  const log: string[] = [];
  let issued = 0;
  const leases = createSecretLeases({
    issue: async (cause) => {
      issued++;
      log.push(`issue:${cause}`);
      if (issueResult === 'throw') throw new Error('link down');
      return issueResult;
    },
    notifyLease: (cause, lease) => log.push(`lease:${cause}:${lease.id}`),
    notifyEnded: (cause) => log.push(`ended:${cause}`),
    turnSecretsDir,
    log: () => {},
  });
  return { leases, log, issued: () => issued };
}

describe('secretLeases', () => {
  const L = { id: 'l1', token: 't1', expiresAt: '2026-10-01T00:35:00Z' };

  it('멘션마다 한 번만 받는다 — 계정 전환·재시도는 받은 임대를 다시 쓴다(R1)', async () => {
    const h = harness(L);
    await h.leases.acquire('m1');
    await h.leases.acquire('m1');
    await h.leases.acquire('m1');
    expect(h.issued()).toBe(1);
    expect(h.log).toEqual(['issue:m1', 'lease:m1:l1']);
    await h.leases.release('m1');
    expect(h.log.at(-1)).toBe('ended:m1');
  });

  it('받지 못했으면(409·실패) 맡기지도 놓지도 않는다 — 비밀 없이 돈다(fail-closed)', async () => {
    for (const r of [null, 'throw'] as const) {
      const h = harness(r);
      await h.leases.acquire('m1');
      await h.leases.acquire('m1');
      expect(h.issued()).toBe(1);
      await h.leases.release('m1');
      expect(h.log).toEqual(['issue:m1']);
    }
  });

  it('놓은 뒤 같은 멘션을 다시 집으면 다시 묻는다(서버가 409 로 거절한다)', async () => {
    const h = harness(L);
    await h.leases.acquire('m1');
    await h.leases.release('m1');
    await h.leases.acquire('m1');
    expect(h.issued()).toBe(2);
  });

  it('D7: 놓기 전에 그 멘션의 기록에서 마운트한 값을 가리고, 그 뒤에 끝 통지를 보낸다', async () => {
    const root = mkdtempSync(join(tmpdir(), 'hk-lease-'));
    const dir = join(root, 'turn-secrets');
    mkdirSync(join(dir, 'l1'), { recursive: true });
    writeFileSync(join(dir, 'l1', 'secret-id'), VALUE);
    const t1 = join(root, 'a.jsonl');
    const t2 = join(root, 'b.jsonl');
    writeFileSync(t1, `${JSON.stringify({ out: VALUE })}\n`);
    writeFileSync(t2, `${JSON.stringify({ out: Buffer.from(VALUE).toString('base64') })}\n`);
    const h = harness(L, dir);
    await h.leases.acquire('m1');
    h.leases.noteTranscript('m1', t1);
    h.leases.noteTranscript('m1', t2);     // 같은 멘션의 재시도가 남긴 두 번째 기록
    h.leases.noteTranscript('other', t1);  // 장부에 없는 멘션은 무시
    const sessDir = join(root, 'sess', 'tool-results');
    mkdirSync(sessDir, { recursive: true });
    writeFileSync(join(sessDir, 'x.txt'), VALUE);
    h.leases.noteTranscript('m1', join(root, 'sess'));   // 디렉터리도 받는다(T1)
    await h.leases.release('m1');
    expect(readFileSync(t1, 'utf8')).not.toContain(VALUE);
    expect(readFileSync(t2, 'utf8')).not.toContain(Buffer.from(VALUE).toString('base64'));
    expect(readFileSync(join(sessDir, 'x.txt'), 'utf8')).toBe('***');
    expect(h.log.at(-1)).toBe('ended:m1');
  });

  it('D7: 루트를 모르면(옛 오퍼레이터) 가리지 않고 놓기만 한다', async () => {
    const root = mkdtempSync(join(tmpdir(), 'hk-lease-'));
    const t1 = join(root, 'a.jsonl');
    writeFileSync(t1, VALUE);
    const h = harness(L, null);
    await h.leases.acquire('m1');
    h.leases.noteTranscript('m1', t1);
    await h.leases.release('m1');
    expect(readFileSync(t1, 'utf8')).toBe(VALUE);
    expect(h.log.at(-1)).toBe('ended:m1');
  });

  it('needles: 그 멘션에 마운트된 값의 바늘을 준다 — 임대가 없거나 놓았으면 빈 목록', async () => {
    const root = mkdtempSync(join(tmpdir(), 'hk-lease-'));
    const dir = join(root, 'turn-secrets');
    mkdirSync(join(dir, 'l1'), { recursive: true });
    writeFileSync(join(dir, 'l1', 'sid'), VALUE);
    const h = harness(L, dir);
    expect(await h.leases.needles('m1')).toEqual([]);
    await h.leases.acquire('m1');
    expect(await h.leases.needles('m1')).toContain(VALUE);
    await h.leases.release('m1');
    expect(await h.leases.needles('m1')).toEqual([]);
  });

  it('drain: 진행 중인 놓기(가리기 → 끝 통지)를 기다린다', async () => {
    const ended: string[] = [];
    const slow = createSecretLeases({
      issue: async () => L,
      notifyLease: () => {},
      notifyEnded: (c) => ended.push(c),
      turnSecretsDir: null,
      log: () => {},
    });
    await slow.acquire('m1');
    const p = slow.release('m1');
    await slow.drain(1000);
    expect(ended).toEqual(['m1']);
    await p;
    await slow.drain(10);              // 진행 중인 것이 없으면 곧바로 돌아온다
  });
});
