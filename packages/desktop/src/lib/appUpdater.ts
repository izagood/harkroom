/**
 * 앱 스스로 새 버전을 받아 설치하는 **단일 표면**.
 *
 * `notify.ts`·`openExternal.ts` 와 같은 이유로 인터페이스 뒤에 둔다: Tauri 플러그인은
 * 브라우저 dev 모드와 테스트에 없고, 테스트는 이 자리를 스텁으로 갈아 끼워
 * "정말 확인했는가 / 정말 설치했는가"를 재야 한다.
 *
 * ## 무엇을 검증하는가 — 여기서는 아무것도 안 한다
 *
 * 서명 검증은 **Rust 쪽 `tauri-plugin-updater` 가** 한다. `tauri.conf.json` 의
 * `plugins.updater.pubkey` 로 minisign 공개키를 박아 뒀고, 플러그인은 내려받은
 * `.app.tar.gz` 의 `.sig` 가 그 공개키로 검증될 때만 설치한다. 그러니 이 모듈이
 * 하는 일은 그 판정을 **화면으로 옮기는 것뿐**이다 — 여기서 검증을 흉내 내면
 * 판정이 두 곳이 되고, 갈라진 쪽이 뚫린다.
 *
 * ## 왜 실패를 삼키지 않는가
 *
 * `notify.ts` 는 플러그인이 없으면 조용히 넘긴다(알림은 부가 기능이다). 업데이트는
 * 다르다: 사람이 **버튼을 눌러 물어본 것**이고, 답이 없으면 사람은 앱이 멈춘 줄 안다.
 * 그래서 확인 실패는 `UpdateCheckFailed` 로 **던지고**, 화면이 그것을 실패라고 적는다.
 * **사유를 지어내지 않는다** — 네트워크가 끊겼는지 서명이 틀렸는지는 우리가 모르고,
 * 모르는 것을 아는 척하면 사람이 엉뚱한 곳을 고친다.
 */

/** 확인 결과. `null` 이 아니면 설치할 것이 있다는 뜻이다. */
export interface AvailableUpdate {
  /** 새 버전 문자열(예: `0.1.1`). 화면이 그대로 보여 준다. */
  version: string;
}

export interface AppUpdater {
  /**
   * 새 버전이 있는지 묻는다. 없으면 `null`.
   *
   * **실패하면 던진다** — 부르는 쪽이 사람에게 "확인하지 못했다"고 적어야 하기 때문이다.
   */
  check(): Promise<AvailableUpdate | null>;
  /**
   * 마지막 `check()` 가 찾은 것을 내려받아 설치하고 앱을 다시 띄운다.
   *
   * 성공하면 앱이 재시작되므로 **이 호출은 돌아오지 않는다.** 돌아왔다면 무언가
   * 어긋난 것이고, 그때는 던진 예외로 온다.
   */
  downloadAndInstall(): Promise<void>;
}

/** 업데이트 표면이 없는 환경(브라우저 dev·테스트)의 기본값. */
export const unavailableUpdater: AppUpdater = {
  async check() {
    throw new Error('this build has no update surface');
  },
  async downloadAndInstall() {
    throw new Error('this build has no update surface');
  },
};

/** 플러그인이 돌려주는 `Update` 핸들 중 우리가 쓰는 부분만. */
type TauriUpdate = {
  version: string;
  downloadAndInstall(): Promise<void>;
};

type TauriUpdaterPlugin = { check(): Promise<TauriUpdate | null> };
type TauriProcessPlugin = { relaunch(): Promise<void> };

/**
 * Tauri 플러그인을 쓰는 실제 표면.
 *
 * `check()` 가 찾은 핸들을 **모듈 안에 쥐고 있다가** `downloadAndInstall()` 에서 쓴다.
 * 플러그인의 `Update` 는 다운로드 URL 과 서명을 들고 있는 객체라 다시 만들 수 없다 —
 * 설치 시점에 `check()` 를 한 번 더 부르면 그 사이에 릴리즈가 바뀌었을 때 **사람이 본 것과
 * 다른 것이 설치된다**. 그래서 "사람이 화면에서 본 그 버전"을 그대로 설치한다.
 */
export function createAppUpdater(): AppUpdater {
  let pending: TauriUpdate | null = null;

  return {
    async check() {
      const plugin = (await import('@tauri-apps/plugin-updater')) as unknown as TauriUpdaterPlugin;
      const update = await plugin.check();
      pending = update;
      return update ? { version: update.version } : null;
    },

    async downloadAndInstall() {
      if (!pending) {
        // 확인 없이 설치를 부르는 것은 호출 순서가 틀린 것이다. 조용히 넘기면
        // 화면이 "설치했다"고 적으면서 아무 일도 안 일어난다.
        throw new Error('nothing to install — check for updates first');
      }
      await pending.downloadAndInstall();
      // 여기서부터는 새 바이너리가 디스크에 있고 돌고 있는 것은 옛것이다. 재시작해야
      // 둘이 다시 같아진다.
      const process = (await import('@tauri-apps/plugin-process')) as unknown as TauriProcessPlugin;
      await process.relaunch();
    },
  };
}

let current: AppUpdater | null = null;

/** 테스트가 업데이트 표면을 갈아끼운다. null 이면 다음 사용 때 실제 표면을 다시 만든다. */
export function setAppUpdater(u: AppUpdater | null): void { current = u; }

export function getAppUpdater(): AppUpdater {
  return (current ??= createAppUpdater());
}
