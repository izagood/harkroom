/**
 * 이름이 바뀐 저장 키를 **읽을 때만** 옛 이름까지 본다(`murmur.*` → `harkroom.*`).
 *
 * ## 왜 규칙으로 두나 — 키가 열두 개다
 *
 * 키마다 "옛 이름" 상수를 하나씩 더 두면 짝이 어긋나는 자리가 열두 군데 생긴다. 접두사만
 * 바뀌었으므로 **규칙 하나**로 유도한다 — 새 키를 고칠 때 옛 키를 같이 고칠 일이 없다.
 *
 * ## 읽기만 폴백한다
 *
 * 쓰기는 **늘 새 이름**이다. 옛 이름에도 같이 쓰면 두 자리가 갈라지고, 어느 쪽이 정본인지
 * 코드에서 안 보이게 된다. 대신 **지우기는 둘 다** 지운다 — 로그아웃이 옛 자리를 남겨 두면
 * 그것은 지운 것이 아니다.
 *
 * 이 폴백은 **한 릴리즈용**이다. 사람들이 새 앱을 한 번 돌고 나면 `5d` 에서 걷어낸다.
 */
const NEW_PREFIX = 'harkroom.';
const OLD_PREFIX = 'murmur.';

/** 이 키의 옛 이름. 새 접두사가 아니면 `null`(폴백할 자리가 없다). */
export function legacyKey(key: string): string | null {
  return key.startsWith(NEW_PREFIX) ? OLD_PREFIX + key.slice(NEW_PREFIX.length) : null;
}

/** `localStorage` 에서 새 이름으로 읽고, 없으면 옛 이름으로 읽는다. */
export function getRenamedLocal(key: string): string | null {
  const found = localStorage.getItem(key);
  if (found !== null) return found;
  const old = legacyKey(key);
  return old ? localStorage.getItem(old) : null;
}

/** `localStorage` 에서 새 이름과 옛 이름을 **둘 다** 지운다. */
export function removeRenamedLocal(key: string): void {
  localStorage.removeItem(key);
  const old = legacyKey(key);
  if (old) localStorage.removeItem(old);
}

type Invoke = (cmd: string, args?: Record<string, unknown>) => Promise<unknown>;

/** OS 키체인에서 새 이름으로 읽고, 없으면 옛 이름으로 읽는다. */
export async function getRenamedSecret(invoke: Invoke, key: string): Promise<unknown> {
  const found = await invoke('secret_get', { key });
  if (found != null && found !== '') return found;
  const old = legacyKey(key);
  return old ? invoke('secret_get', { key: old }) : null;
}

/**
 * OS 키체인에서 새 이름과 옛 이름을 **둘 다** 지운다.
 *
 * 옛 이름 삭제는 실패해도 삼킨다 — 애초에 없을 수 있고(대부분 그렇다), 그 실패 때문에
 * 로그아웃이 실패하면 사람은 **새 이름이 지워졌다는 사실까지** 못 믿게 된다.
 */
export async function deleteRenamedSecret(invoke: Invoke, key: string): Promise<void> {
  await invoke('secret_delete', { key });
  const old = legacyKey(key);
  if (old) { try { await invoke('secret_delete', { key: old }); } catch { /* 없을 수 있다 */ } }
}
