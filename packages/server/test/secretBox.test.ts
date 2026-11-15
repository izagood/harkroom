import { createCipheriv, createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { createSecretBox } from '../src/services/secretBox.js';

// 시험용 키 — 실제 값과 무관하다.
const RAW = ['test', 'box', 'key'].join('-');

/** seal 과 같은 식으로, iv·tag 길이만 골라 봉인한다. */
function sealWith(plain: string, ivLen: number, tagLen: number): string {
  const key = createHash('sha256').update(RAW, 'utf8').digest();
  const iv = Buffer.alloc(ivLen, 7);
  const c = createCipheriv('aes-256-gcm', key, iv, { authTagLength: tagLen });
  const ct = Buffer.concat([c.update(plain, 'utf8'), c.final()]);
  return ['v1', iv.toString('base64'), c.getAuthTag().toString('base64'), ct.toString('base64')].join('.');
}

describe('secret box v1', () => {
  const box = createSecretBox(RAW)!;

  it('seal 한 봉투는 그대로 열린다', () => {
    const sealed = box.seal('webhook-shared-value');
    const [, iv, tag] = sealed.split('.');
    expect([Buffer.from(iv!, 'base64').length, Buffer.from(tag!, 'base64').length]).toEqual([12, 16]);
    expect(box.open(sealed)).toBe('webhook-shared-value');
    expect(box.open(sealWith('same-shape', 12, 16))).toBe('same-shape');
  });

  it('iv·tag 길이가 seal 과 다르면 열리지 않는다(iv 12·tag 16바이트)', () => {
    const sealed = box.seal('webhook-shared-value');
    const withTag = (n: number) => {
      const p = sealed.split('.');
      p[2] = Buffer.from(p[2]!, 'base64').subarray(0, n).toString('base64');
      return p.join('.');
    };
    expect(box.open(withTag(12))).toBeNull();
    expect(box.open(withTag(4))).toBeNull();
    expect(box.open(sealWith('other-shape', 16, 16))).toBeNull();
    expect(box.open(sealWith('other-shape', 8, 16))).toBeNull();
    expect(box.open(sealWith('other-shape', 12, 12))).toBeNull();
  });
});
