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

import { updateChannelStorage, type UpdateChannel } from './updateChannel';

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
   *
   * `channel` 은 어느 매니페스트에 물을지다(`updateChannel.ts`). 엔드포인트는 Rust 가 정한다.
   */
  check(channel: UpdateChannel): Promise<AvailableUpdate | null>;
  /**
   * 화면이 본 `(channel, version)` 을 내려받아 설치하고 앱을 다시 띄운다. Rust 가 그 채널에서 쥔 판이
   * `version` 과 다르면(그 사이 늦은 답이 바꿨으면) 설치하지 않고 던진다 — 사람이 본 그 판만 설치한다.
   *
   * 성공하면 앱이 재시작되므로 **이 호출은 돌아오지 않는다.** 돌아왔다면 무언가
   * 어긋난 것이고, 그때는 던진 예외로 온다.
   */
  downloadAndInstall(channel: UpdateChannel, version: string): Promise<void>;
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

type TauriProcessPlugin = { relaunch(): Promise<void> };
type Invoke = (cmd: string, args?: Record<string, unknown>) => Promise<unknown>;

function invoke(cmd: string, args?: Record<string, unknown>): Promise<unknown> {
  const fn = (window as unknown as { __TAURI_INTERNALS__?: { invoke?: Invoke } }).__TAURI_INTERNALS__?.invoke;
  if (typeof fn !== 'function') return Promise.reject(new Error('this build has no update surface'));
  return fn(cmd, args);
}

/**
 * Tauri 를 쓰는 실제 표면. 확인·설치는 Rust 명령(`update_channel.rs`)이다 — 플러그인의 JS
 * `check()` 는 엔드포인트를 못 바꿔서 채널을 고를 수 없다.
 *
 * 확인이 찾은 판은 **Rust 가 채널마다 쥐고 있다가** 설치에서 쓴다. 설치 때 다시 물으면 그 사이에
 * 매니페스트가 바뀌었을 때 **사람이 본 것과 다른 것이 설치된다**. 그래서 설치는 화면이 본
 * `(channel, version)` 을 넘기고, Rust 가 쥔 것과 둘 다 맞을 때만 설치한다(`update_channel.rs`).
 * 여기는 상태를 쥐지 않는다 — 쥐면 채널을 바꾸는 사이 늦게 온 답이 그것을 덮는다.
 */
export function createAppUpdater(): AppUpdater {
  return {
    async check(channel) {
      const found = (await invoke('app_update_check', { channel })) as { version: string } | null;
      return found ? { version: found.version } : null;
    },

    async downloadAndInstall(channel, version) {
      await invoke('app_update_install', { channel, version });
      // 설치는 끝났다 — 다시 뜨기 전에 **어느 채널에서 받았는지** 적는다(재시작 뒤엔 모른다).
      updateChannelStorage.saveInstalled(channel);
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
