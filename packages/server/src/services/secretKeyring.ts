import { createCipheriv, createDecipheriv, hkdfSync, randomBytes } from 'node:crypto';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * 비밀 보관소(085)의 v2 봉투. `secretBox.ts`(v1, 자동화 웹훅 비밀)와 따로 둔다 — v1 은 키를
 * sha256 으로 늘리고 AAD 가 없다. 여기서 고친 것(보안 검토 M3·M4, 스레드 bc98df3a):
 *
 * - **키는 32바이트 난수만 받는다.** 사람이 고른 문자열을 sha256 으로 늘리면 그 문자열의 강도가
 *   곧 키의 강도다. base64(44자) 또는 hex(64자)로 적힌 정확히 32바이트가 아니면 기동하지 않는다.
 * - **판마다 키를 끌어낸다.** HKDF-SHA256(KEK, salt=판마다 16바이트 난수, info=AAD). 같은 KEK 로
 *   봉인한 암호문이 많아져도 GCM nonce 충돌 한도를 KEK 하나가 지지 않는다.
 * - **AAD 로 자리를 묶는다.** (secretId, version, kind, kid). DB 쓰기 권한만 있는 쪽이 비밀 X 의
 *   암호문을 grant 가 있는 Y 행에 옮겨 붙여도 풀리지 않는다.
 * - **키는 env 가 아니라 파일에서 읽는다.** `HARKROOM_SECRET_KEYS_DIR` 의 파일 하나가 키 하나이고
 *   파일 이름이 kid 다 — k8s Secret 을 볼륨으로 걸면 키 이름이 곧 파일 이름이라 그대로 맞는다.
 *   env 는 `/proc/<pid>/environ`·크래시 덤프·자식 프로세스로 새기 쉽다.
 *
 * 형식: `v2.<kid>.<salt b64>.<iv b64>.<tag b64>.<ciphertext b64>`.
 * kid 가 형식 안에 있으므로 키를 바꿀 때는 새 kid 를 넣고 활성 kid 만 옮기면 된다 — 옛 판은
 * 옛 kid 로 계속 풀린다(다시 감싸는 도구는 2차).
 */
export interface SecretAad {
  secretId: string;
  version: number;
  kind: 'text' | 'file';
}

export interface SecretKeyring {
  /** 새로 봉인할 때 쓰는 kid. */
  readonly activeKid: string;
  seal(plain: Buffer, aad: SecretAad): string;
  /** 키가 없거나 AAD 가 다르거나 값이 망가졌으면 null — 던지지 않는다. */
  open(sealed: string, aad: SecretAad): Buffer | null;
}

const KID = /^[a-z0-9][a-z0-9_-]{0,31}$/;

/** 키 파일 내용 → 32바이트. 아니면 null. 앞뒤 공백(줄바꿈)은 무시한다. */
export function parseKey(raw: string): Buffer | null {
  const t = raw.trim();
  if (/^[0-9a-fA-F]{64}$/.test(t)) return Buffer.from(t, 'hex');
  if (/^[A-Za-z0-9+/]{43}=$/.test(t)) {
    const b = Buffer.from(t, 'base64');
    return b.length === 32 ? b : null;
  }
  return null;
}

function aadBytes(kid: string, a: SecretAad): Buffer {
  // 구분자가 값 안에 나올 수 없다: secretId 는 uuid, kind 는 열거, kid 는 KID 정규식.
  return Buffer.from(`harkroom-secret-v2|${a.secretId}|${a.version}|${a.kind}|${kid}`, 'utf8');
}

function derive(kek: Buffer, salt: Buffer, aad: Buffer): Buffer {
  return Buffer.from(hkdfSync('sha256', kek, salt, aad, 32));
}

export function createSecretKeyring(keys: ReadonlyMap<string, Buffer>, activeKid: string): SecretKeyring {
  for (const [kid, key] of keys) {
    if (!KID.test(kid)) throw new Error(`secret keyring: kid '${kid}' 는 [a-z0-9_-] 32자 이내여야 한다`);
    if (key.length !== 32) throw new Error(`secret keyring: kid '${kid}' 의 키가 32바이트가 아니다`);
  }
  const active = keys.get(activeKid);
  if (!active) throw new Error(`secret keyring: 활성 kid '${activeKid}' 의 키가 없다`);

  return {
    activeKid,
    seal(plain, a) {
      const aad = aadBytes(activeKid, a);
      const salt = randomBytes(16);
      const iv = randomBytes(12);
      const c = createCipheriv('aes-256-gcm', derive(active, salt, aad), iv);
      c.setAAD(aad);
      const ct = Buffer.concat([c.update(plain), c.final()]);
      return ['v2', activeKid, salt.toString('base64'), iv.toString('base64'),
        c.getAuthTag().toString('base64'), ct.toString('base64')].join('.');
    },
    open(sealed, a) {
      const parts = sealed.split('.');
      if (parts.length !== 6 || parts[0] !== 'v2') return null;
      const [, kid, salt, iv, tag, ct] = parts as [string, string, string, string, string, string];
      const kek = keys.get(kid);
      if (!kek) return null;
      try {
        const aad = aadBytes(kid, a);
        const d = createDecipheriv('aes-256-gcm', derive(kek, Buffer.from(salt, 'base64'), aad), Buffer.from(iv, 'base64'));
        d.setAAD(aad);
        d.setAuthTag(Buffer.from(tag, 'base64'));
        return Buffer.concat([d.update(Buffer.from(ct, 'base64')), d.final()]);
      } catch {
        return null;
      }
    },
  };
}

/**
 * `HARKROOM_SECRET_KEYS_DIR` 에서 키를 읽는다. 디렉터리가 지정되지 않았으면 null(보관소 꺼짐 —
 * 라우트가 409 로 답한다). 지정됐는데 읽을 수 없거나 키가 잘못됐으면 **던진다**: 설정을 했는데
 * 조용히 꺼지면 사람은 왜 안 되는지 모른다.
 *
 * 활성 kid 는 `HARKROOM_SECRET_KEY_ID`. 없으면 키가 하나일 때만 그것을 쓴다 — 둘 이상인데
 * 고르지 않았으면 어느 것으로 봉인할지 추측하지 않는다.
 * 점으로 시작하는 파일(k8s 볼륨의 `..data` 심링크 등)은 건너뛴다.
 */
export function loadSecretKeyring(dir: string | undefined, activeKid: string | undefined): SecretKeyring | null {
  const d = dir?.trim();
  if (!d) return null;
  const keys = new Map<string, Buffer>();
  for (const name of readdirSync(d)) {
    if (name.startsWith('.')) continue;
    const key = parseKey(readFileSync(join(d, name), 'utf8'));
    if (!key) throw new Error(`HARKROOM_SECRET_KEYS_DIR/${name}: 32바이트 키(base64 44자 또는 hex 64자)가 아니다`);
    keys.set(name, key);
  }
  if (!keys.size) throw new Error(`HARKROOM_SECRET_KEYS_DIR(${d}) 에 키 파일이 없다`);
  const kid = activeKid?.trim() || (keys.size === 1 ? [...keys.keys()][0]! : '');
  if (!kid) throw new Error('키가 둘 이상이면 HARKROOM_SECRET_KEY_ID 로 활성 kid 를 정해야 한다');
  return createSecretKeyring(keys, kid);
}
