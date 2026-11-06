type KeyLike = Pick<KeyboardEvent, 'key' | 'code' | 'metaKey' | 'ctrlKey' | 'shiftKey' | 'altKey'>;

/**
 * 뒤로(⌘[ / Ctrl+[)·앞으로(⌘] / Ctrl+]) 열쇠인가.
 *
 * `key` 를 먼저 본다 — 배열이 다른 자판에서는 `[` 가 다른 물리 키에 있다. 입력기가 조합 중이면 `key` 가 글자 대신
 * `Process` 같은 이름으로 올 수 있어, 그때만 물리 키(`code`)로 본다.
 *
 * ⌥ 가 함께면 받지 않는다 — Windows·Linux 의 AltGr 은 Ctrl+Alt 로 오므로, 독일어 자판 등에서 글자 `[` 를 치는 손이다.
 */
export function historyShortcut(e: KeyLike): 'back' | 'forward' | null {
  if (!(e.metaKey || e.ctrlKey) || e.altKey) return null;
  if (e.key === '[') return 'back';
  if (e.key === ']') return 'forward';
  if (e.key.length === 1 || e.shiftKey) return null;
  if (e.code === 'BracketLeft') return 'back';
  if (e.code === 'BracketRight') return 'forward';
  return null;
}
