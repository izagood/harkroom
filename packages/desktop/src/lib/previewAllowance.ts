/**
 * 미리보기 iframe 의 첫 로드를 Tauri 내비게이션 훅에 **한 번** 허용해 둔다(#1069 A′, jaebin 결정 1c3401f3).
 *
 * wry 는 하위 프레임의 이동까지 앱의 외부 링크 훅(`src-tauri/src/external_link.rs`)으로 보낸다. 그대로 두면
 * iframe 의 `https://<서버>/preview/<토큰>` 이 "앱 밖"으로 판정돼 **토큰 URL 이 시스템 브라우저로 나가고 패널은
 * 빈다.** 그래서 src 를 넣기 **전에** 그 URL 하나를 Rust 쪽 `allow_preview_once` 에 쥐여 준다(90초, 한 번).
 *
 * Tauri 밖(웹·vitest)에는 그 훅도 없으므로 아무것도 하지 않는다. Tauri 안에서 실패하면 **던진다** — 호출부는
 * src 를 넣지 않아야 한다(넣으면 훅이 그 URL 을 브라우저로 넘긴다).
 */
interface TauriInternals { invoke: (cmd: string, args?: Record<string, unknown>) => Promise<unknown> }

export async function allowPreviewOnce(url: string): Promise<void> {
  const invoke = (globalThis as unknown as { __TAURI_INTERNALS__?: TauriInternals }).__TAURI_INTERNALS__?.invoke;
  if (typeof invoke !== 'function') return;
  await invoke('allow_preview_once', { url });
}
