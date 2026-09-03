/**
 * 링크를 **OS 로 넘기는** 단일 표면. `notify.ts` 와 같은 이유로 인터페이스 뒤에 둔다:
 * Tauri 플러그인은 브라우저 dev 모드와 테스트에 없고, 테스트는 이 자리를 스텁으로 갈아
 * 끼워 "정말 열렸는가"를 확인해야 한다.
 *
 * **여기까지 온 URL 은 이미 허용 목록을 통과한 것이다**(`classifyLink`). 이 모듈은 스킴을
 * 다시 판정하지 않는다 — 판정이 두 곳에 있으면 언젠가 갈라지고, 갈라진 쪽이 뚫린다.
 */
export interface ExternalOpener {
  /** 실패하면 **던진다.** 부르는 쪽이 사람에게 보여야 하기 때문이다(#178). */
  open(url: string): Promise<void>;
}

type TauriShellPlugin = { open(path: string): Promise<void> };

/**
 * Tauri 플러그인이 있으면 그것으로, 없으면 `window.open` 으로 물러난다.
 *
 * `window.open` 의 반환값을 보는 이유: 팝업이 막히면 예외 대신 **null** 을 준다. 안 보면
 * 실패가 조용히 사라지고, 사람은 앱이 멈춘 줄 알고 같은 링크를 계속 누른다.
 */
export function createExternalOpener(): ExternalOpener {
  let plugin: TauriShellPlugin | null | undefined;

  return {
    async open(url) {
      if (plugin === undefined) {
        try {
          plugin = (await import('@tauri-apps/plugin-shell')) as unknown as TauriShellPlugin;
        } catch {
          // 플러그인 부재(브라우저 dev). 다시 시도하지 않는다 — 매번 실패할 import 다.
          plugin = null;
        }
      }
      if (plugin) {
        await plugin.open(url);
        return;
      }
      if (!window.open(url, '_blank', 'noopener,noreferrer')) {
        throw new Error('browser blocked opening the link');
      }
    },
  };
}

let current: ExternalOpener | null = null;

/** 테스트가 여는 자리를 갈아끼운다. null 이면 다음 사용 때 실제 표면을 다시 만든다. */
export function setExternalOpener(o: ExternalOpener | null): void { current = o; }

export function getExternalOpener(): ExternalOpener {
  return (current ??= createExternalOpener());
}
