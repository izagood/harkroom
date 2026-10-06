/**
 * 첨부를 **사람이 고른 자리에** 저장하는 단일 표면(2026-10-06, jaebin 결정 95ab9c9b).
 *
 * 전에는 objectURL 에 `download` 앵커를 달아 눌렀고, Tauri(WKWebView)는 그것을 **묻지 않고** 기본 위치에 썼다.
 * 이제 Tauri 에서는 Rust `save_attachment`(`src-tauri/src/attachment_save.rs`)가 macOS 저장 창을 띄우고,
 * 사람이 고른 경로에 직접 쓴다. [취소]가 곧 "저장하지 않는다"이다.
 *
 * `openExternal.ts` 와 같은 이유로 인터페이스 뒤에 둔다 — Tauri 는 브라우저 dev 와 시험에 없고, 시험은 이 자리를
 * 갈아 끼워 "저장 창을 거쳤는가"를 본다. Tauri 가 없으면 앵커로 물러난다: 브라우저는 자기 설정("저장 위치 묻기")을
 * 따르고, 어디에 썼는지 앱이 알 수 없으므로 `folder` 가 `null` 이다(토스트를 띄우지 않는다).
 *
 * **경로는 웹뷰로 오지 않는다.** Rust 가 돌려주는 것은 폴더 이름(문구용)과 표(`token`)뿐이고, [Finder에서 보기]는
 * 그 표로만 부른다.
 */
export type SaveResult =
  | { kind: 'saved'; name: string; folder: string | null; token: number | null }
  | { kind: 'canceled' };

export interface FileSaver {
  /** 실패하면 **던진다.** 부르는 쪽이 사람에게 보여야 한다. 취소는 실패가 아니다. */
  save(blob: Blob, filename: string): Promise<SaveResult>;
  /** `save` 가 돌려준 표의 파일을 Finder 에서 집어 보여 준다. 실패하면 던진다. */
  reveal(token: number): Promise<void>;
}

/** Rust 가 헤더에서 이름 제안을 읽는다(`attachment_save::FILENAME_HEADER`). */
export const SAVE_FILENAME_HEADER = 'x-harkroom-filename';

type Invoke = (cmd: string, args?: unknown, options?: { headers?: Record<string, string> }) => Promise<unknown>;

function tauriInvoke(): Invoke | null {
  const invoke = (globalThis as { __TAURI_INTERNALS__?: { invoke?: Invoke } }).__TAURI_INTERNALS__?.invoke;
  return typeof invoke === 'function' ? invoke : null;
}

type RustSaved = { token: number; name: string; folder: string } | null;

/** Tauri 저장 창. 바이트는 raw 본문으로 보낸다 — JSON 숫자 배열로 보내면 수 MB 가 수십 MB 가 된다. */
export function createTauriFileSaver(invoke: Invoke): FileSaver {
  return {
    async save(blob, filename) {
      const bytes = new Uint8Array(await blob.arrayBuffer());
      const saved = await invoke('save_attachment', bytes, {
        headers: { [SAVE_FILENAME_HEADER]: encodeURIComponent(filename) },
      }) as RustSaved;
      if (!saved) return { kind: 'canceled' };
      return { kind: 'saved', name: saved.name, folder: saved.folder, token: saved.token };
    },
    async reveal(token) {
      await invoke('reveal_saved_attachment', { token });
    },
  };
}

/** 브라우저(dev·시험)용. 묻는지는 브라우저 설정이 정한다. */
export function createAnchorFileSaver(): FileSaver {
  return {
    async save(blob, filename) {
      const url = URL.createObjectURL(blob);
      try {
        const a = document.createElement('a');
        a.href = url;
        a.download = filename;
        a.click();
      } finally {
        // 즉시 revoke 하면 브라우저가 저장을 시작하기 전에 사라질 수 있다.
        setTimeout(() => URL.revokeObjectURL(url), 10_000);
      }
      return { kind: 'saved', name: filename, folder: null, token: null };
    },
    async reveal() {
      throw new Error('이 빌드에는 Finder 표면이 없다');
    },
  };
}

let current: FileSaver | null = null;

/** 시험이 저장 자리를 갈아 끼운다. null 이면 다음 사용 때 실제 표면을 다시 만든다. */
export function setFileSaver(s: FileSaver | null): void { current = s; }

export function getFileSaver(): FileSaver {
  if (current) return current;
  const invoke = tauriInvoke();
  return (current = invoke ? createTauriFileSaver(invoke) : createAnchorFileSaver());
}
