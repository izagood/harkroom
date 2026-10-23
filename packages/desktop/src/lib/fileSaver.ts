/**
 * 첨부를 **사람이 고른 자리에** 저장하는 단일 표면(2026-10-23, 소유자 결정 92bf2dea — #1212 를 대체한다).
 *
 * 전에는 objectURL 에 `download` 앵커를 달아 눌렀고, Tauri(WKWebView)는 그것을 **묻지 않고** 기본 위치에 썼다.
 * 이제 순서가 둘이다:
 * ① `pick` — Rust `pick_save_target`(`src-tauri/src/attachment_save.rs`)가 macOS 저장 창을 띄운다. [취소]면
 *    `null` 이고, 부르는 쪽은 바이트를 받지도 않는다.
 * ② `write` — 받은 바이트를 Rust `write_saved_attachment` 가 ①에서 고른 자리에 쓴다. 표마다 한 번만.
 * 저장 창이 **먼저**인 이유: 다 받은 뒤 창을 띄우면 큰 파일은 기다린 끝에야 취소할 수 있고, 받는 동안의
 * 진행률(P2)을 보일 자리도 없다.
 *
 * `openExternal.ts` 와 같은 이유로 인터페이스 뒤에 둔다 — Tauri 는 브라우저 dev 와 시험에 없고, 시험은 이 자리를
 * 갈아 끼운다. Tauri 가 없으면 앵커로 물러난다: 브라우저는 자기 설정("저장 위치 묻기")을 따르고, 어디에 썼는지
 * 앱이 알 수 없으므로 `folder` 가 `null` 이다(토스트를 띄우지 않는다).
 *
 * **경로는 웹뷰로 오지 않는다.** Rust 가 돌려주는 것은 표·이름·폴더 이름뿐이다.
 */
export type SaveTarget = { token: number | null; name: string; folder: string | null };

export interface FileSaver {
  /** 저장 창을 띄운다. 취소면 `null`. 실패하면 던진다. */
  pick(filename: string): Promise<SaveTarget | null>;
  /** `pick` 이 돌려준 자리에 쓴다. 실패하면 던진다. */
  write(target: SaveTarget, blob: Blob): Promise<void>;
  /** 쓴 파일을 Finder 에서 집어 보여 준다. 실패하면 던진다. */
  reveal(token: number): Promise<void>;
}

/** Rust 가 ② 에서 표를 읽는 헤더(`attachment_save::TOKEN_HEADER`). */
export const SAVE_TOKEN_HEADER = 'x-harkroom-save-token';

type Invoke = (cmd: string, args?: unknown, options?: { headers?: Record<string, string> }) => Promise<unknown>;

function tauriInvoke(): Invoke | null {
  const invoke = (globalThis as { __TAURI_INTERNALS__?: { invoke?: Invoke } }).__TAURI_INTERNALS__?.invoke;
  return typeof invoke === 'function' ? invoke : null;
}

type RustPicked = { token: number; name: string; folder: string } | null;

/** Tauri 저장 창. 바이트는 raw 본문으로 보낸다 — JSON 숫자 배열로 보내면 수 MB 가 수십 MB 가 된다. */
export function createTauriFileSaver(invoke: Invoke): FileSaver {
  return {
    async pick(filename) {
      const picked = await invoke('pick_save_target', { filename }) as RustPicked;
      return picked ? { token: picked.token, name: picked.name, folder: picked.folder } : null;
    },
    async write(target, blob) {
      if (target.token === null) throw new Error('저장 표가 없다');
      const bytes = new Uint8Array(await blob.arrayBuffer());
      await invoke('write_saved_attachment', bytes, { headers: { [SAVE_TOKEN_HEADER]: String(target.token) } });
    },
    async reveal(token) {
      await invoke('reveal_saved_attachment', { token });
    },
  };
}

/** 브라우저(dev·시험)용. 묻는지는 브라우저 설정이 정한다. */
export function createAnchorFileSaver(): FileSaver {
  return {
    async pick(filename) {
      return { token: null, name: filename, folder: null };
    },
    async write(target, blob) {
      const url = URL.createObjectURL(blob);
      try {
        const a = document.createElement('a');
        a.href = url;
        a.download = target.name;
        a.click();
      } finally {
        // 즉시 revoke 하면 브라우저가 저장을 시작하기 전에 사라질 수 있다.
        setTimeout(() => URL.revokeObjectURL(url), 10_000);
      }
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
