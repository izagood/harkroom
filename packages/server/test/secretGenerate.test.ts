import { describe, it, expect } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { causeByOwner, generateValue, sshEd25519 } from '../src/services/secretCreate.js';

// 에이전트가 만든 비밀의 값 만들기(102) — DB 없는 부분. 스레드 1a08d0cf.
const hasSshKeygen = (() => { try { execFileSync('ssh-keygen', ['-?'], { stdio: 'ignore' }); return true; } catch (e) { return (e as { status?: number }).status !== undefined; } })();

describe('generateValue', () => {
  it('password: 기본 32자, 16~128 밖은 bad_length, 두 번 만들면 다르다', () => {
    const a = generateValue({ type: 'password' }, 'x');
    const b = generateValue({ type: 'password' }, 'x');
    expect(a.ok && b.ok).toBe(true);
    if (!a.ok || !b.ok) return;
    expect(a.kind).toBe('text');
    expect(a.value.length).toBe(32);
    expect(a.value.equals(b.value)).toBe(false);
    expect(generateValue({ type: 'password', length: 15 }, 'x')).toEqual({ ok: false, code: 'bad_length' });
    expect(generateValue({ type: 'password', length: 129 }, 'x')).toEqual({ ok: false, code: 'bad_length' });
    const long = generateValue({ type: 'password', length: 128 }, 'x');
    expect(long.ok && long.value.length).toBe(128);
  });

  it('token_hex·token_base64url: 길이는 바이트 수다', () => {
    const h = generateValue({ type: 'token_hex', length: 20 }, 'x');
    expect(h.ok && h.value.toString()).toMatch(/^[0-9a-f]{40}$/);
    const u = generateValue({ type: 'token_base64url' }, 'x');
    expect(u.ok && u.value.toString()).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(generateValue({ type: 'token_hex', length: 8 }, 'x')).toEqual({ ok: false, code: 'bad_length' });
  });

  it('ssh_ed25519: 파일 비밀이고 공개키만 따로 돌려준다, 길이는 받지 않는다', () => {
    const k = generateValue({ type: 'ssh_ed25519' }, 'deploy');
    expect(k.ok).toBe(true);
    if (!k.ok) return;
    expect(k).toMatchObject({ kind: 'file', filename: 'id_ed25519' });
    expect(k.value.toString()).toMatch(/^-----BEGIN OPENSSH PRIVATE KEY-----\n[\s\S]+\n-----END OPENSSH PRIVATE KEY-----\n$/);
    expect(k.publicKey).toMatch(/^ssh-ed25519 AAAAC3NzaC1lZDI1NTE5[A-Za-z0-9+/=]+ harkroom:deploy$/);
    // 공개키 줄에 개인키 조각이 섞이지 않는다.
    expect(k.value.toString()).not.toContain(k.publicKey!);
    expect(generateValue({ type: 'ssh_ed25519', length: 32 }, 'x')).toEqual({ ok: false, code: 'bad_length' });
  });

  it.runIf(hasSshKeygen)('ssh_ed25519: ssh-keygen 이 개인키를 읽고 같은 공개키를 낸다', () => {
    const k = sshEd25519('harkroom:t');
    const dir = mkdtempSync(join(tmpdir(), 'hk-ssh-'));
    try {
      const f = join(dir, 'id');
      writeFileSync(f, k.privateKey, { mode: 0o600 });
      const pub = execFileSync('ssh-keygen', ['-y', '-f', f]).toString().trim();
      expect(pub.split(' ').slice(0, 2).join(' ')).toBe(k.publicKey.split(' ').slice(0, 2).join(' '));
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('causeByOwner (F2)', () => {
  const base = { agentId: 'ag', ownerId: 'own', causeAskAuthorId: null, askAnsweredBy: null, askAnswererKind: null };
  it('소유자 사람 글만, 채널의 다른 사람·에이전트 글은 아니다', () => {
    expect(causeByOwner({ ...base, causeAuthorId: 'own', causeKind: 'human' })).toBe(true);
    expect(causeByOwner({ ...base, causeAuthorId: 'bob', causeKind: 'human' })).toBe(false);
    expect(causeByOwner({ ...base, causeAuthorId: 'own', causeKind: 'agent' })).toBe(false);
    expect(causeByOwner({ ...base, ownerId: null, causeAuthorId: 'own', causeKind: 'human' })).toBe(false);
  });
  it('이 에이전트 자신의 카드에 소유자가 답한 턴은 된다 — 남의 카드·다른 사람의 답은 아니다', () => {
    const ask = { ...base, causeAuthorId: 'ag', causeKind: 'agent', causeAskAuthorId: 'ag', askAnswererKind: 'human' };
    expect(causeByOwner({ ...ask, askAnsweredBy: 'own' })).toBe(true);
    expect(causeByOwner({ ...ask, askAnsweredBy: 'bob' })).toBe(false);
    expect(causeByOwner({ ...ask, causeAskAuthorId: 'other', askAnsweredBy: 'own' })).toBe(false);
  });
});
