import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'node:crypto';

/**
 * 서버가 **원문을 다시 읽어야 하는** 비밀을 DB 에 둘 때 쓰는 봉투(065).
 *
 * 해시로 끝나는 비밀(PAT·범용 hook 키)은 이것을 쓰지 않는다 — 원문을 되찾을 길이 없는 편이
 * 언제나 낫다. 이것이 필요한 것은 GitHub webhook 처럼 **서명을 검증하려면 공유 비밀 원문이
 * 있어야 하는** 경우뿐이다.
 *
 * 키는 `HARKROOM_SECRET_KEY` 한 줄이다. 길이 제약을 두지 않으려고 sha256 으로 32바이트로
 * 늘린다(사람이 넣는 값이 base64 32바이트인지 검사하면 배포가 그 검사에서 더 자주 막힌다).
 * 형식: `v1.<iv b64>.<tag b64>.<ciphertext b64>` — 앞의 `v1` 은 키를 바꿀 때 갈래를 둘 자리다.
 */
export interface SecretBox {
  seal(plain: string): string;
  open(sealed: string): string | null;
}

export function createSecretBox(rawKey: string | null | undefined): SecretBox | null {
  const trimmed = rawKey?.trim();
  if (!trimmed) return null;
  const key = createHash('sha256').update(trimmed, 'utf8').digest();
  return {
    seal(plain) {
      const iv = randomBytes(12);
      const c = createCipheriv('aes-256-gcm', key, iv);
      const ct = Buffer.concat([c.update(plain, 'utf8'), c.final()]);
      return ['v1', iv.toString('base64'), c.getAuthTag().toString('base64'), ct.toString('base64')].join('.');
    },
    open(sealed) {
      const [v, iv, tag, ct] = sealed.split('.');
      if (v !== 'v1' || !iv || !tag || !ct) return null;
      try {
        const d = createDecipheriv('aes-256-gcm', key, Buffer.from(iv, 'base64'));
        d.setAuthTag(Buffer.from(tag, 'base64'));
        return Buffer.concat([d.update(Buffer.from(ct, 'base64')), d.final()]).toString('utf8');
      } catch {
        // 키가 바뀌었거나 값이 망가졌다. 던지지 않는다 — 호출부는 "검증 불가"로 거절한다.
        return null;
      }
    },
  };
}
