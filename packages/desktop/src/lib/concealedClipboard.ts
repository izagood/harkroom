/**
 * 한 번만 보이는 비밀(복구 키)을 클립보드에 담는다 — Rust `clipboard_write_concealed`
 * (`src-tauri/src/concealed_clipboard.rs`)가 클립보드 기록 앱용 감춤 표지를 붙이고, 60초 뒤 그 사이
 * 클립보드가 바뀌지 않았으면(`changeCount`) 비운다.
 *
 * 웹뷰에서 하지 않는 이유: WKWebView 의 `readText()` 는 사용자 제스처를 요구해 60초 뒤 타이머에서
 * 거절된다 — "아직 그 값이면 지운다"를 웹 쪽에서 할 수 없다.
 *
 * 돌려주는 값: Rust 가 쓰고 비우기를 예약했으면 `true`. Tauri 가 없거나(웹·시험) macOS 밖이라 실패하면
 * `false` — 부르는 쪽이 일반 복사로 물러나고 "비운다"고 말하지 않는다.
 */
type Invoke = (cmd: string, args?: Record<string, unknown>) => Promise<unknown>;
let invokeOverride: Invoke | null = null;
/** 시험용: Tauri IPC 자리를 바꿔 끼운다. */
export function setConcealedClipboardInvoke(next: Invoke | null): void { invokeOverride = next; }

function tauriInvoke(): Invoke | null {
  if (invokeOverride) return invokeOverride;
  const invoke = (globalThis as { __TAURI_INTERNALS__?: { invoke?: Invoke } }).__TAURI_INTERNALS__?.invoke;
  return typeof invoke === 'function' ? invoke : null;
}

export async function writeConcealed(text: string): Promise<boolean> {
  const invoke = tauriInvoke();
  if (!invoke) return false;
  try {
    await invoke('clipboard_write_concealed', { text });
    return true;
  } catch {
    return false;
  }
}
