/**
 * 업데이트 채널 — **Stable / Ludicrous**.
 *
 * - Stable(기본): `promote.yml` 이 고른 판만 받는다.
 * - Ludicrous: main 머지마다 나오는 가장 최신 판을 받는다(지금까지의 자동 업데이트).
 *
 * 엔드포인트는 여기서 정하지 않는다 — 화면은 **이름만** 넘기고, URL 은 Rust 의
 * `update_channel.rs` 상수가 정한다(웹뷰가 아무 매니페스트나 가리키지 못하게).
 *
 * ## 값은 기기 로컬이다
 *
 * 어느 판을 받을지는 그 기기에 깔린 앱의 속성이다(`design.md`: 설정은 기기의 속성만 담는다).
 * 기본은 Stable — 이미 깔린 앱도 채널을 아는 판을 처음 받으면 Stable 로 시작한다(설계 결정 4).
 *
 * ## `installedChannel` — 지금 판을 **어느 채널에서** 받았나
 *
 * 설치에 성공하면 그때의 채널을 적는다. Ludicrous 에서 받은 판을 쓰다가 Stable 로 돌아오면
 * 낮은 판으로 내려가지 않으므로(업데이터 기본 비교기), 화면이 "Stable 이 이 판을 넘으면
 * 이어서 받는다"를 알려야 한다 — 그 안내가 서는 조건이 이 값이다(시안 v1 #5).
 */

export type UpdateChannel = 'stable' | 'ludicrous';

export const DEFAULT_UPDATE_CHANNEL: UpdateChannel = 'stable';

const CHANNEL_KEY = 'harkroom.updateChannel';
const INSTALLED_CHANNEL_KEY = 'harkroom.updateInstalledChannel';

/** 저장본은 우리가 쓴 값이 아닐 수 있다 — 모르는 값은 기본(Stable)으로 읽는다. */
function parse(raw: string | null): UpdateChannel | null {
  return raw === 'stable' || raw === 'ludicrous' ? raw : null;
}

export const updateChannelStorage = {
  load(): UpdateChannel {
    try {
      return parse(localStorage.getItem(CHANNEL_KEY)) ?? DEFAULT_UPDATE_CHANNEL;
    } catch {
      return DEFAULT_UPDATE_CHANNEL;
    }
  },
  save(channel: UpdateChannel): void {
    try {
      localStorage.setItem(CHANNEL_KEY, channel);
    } catch { /* 저장 불가 환경 허용 */ }
  },
  /** 지금 판을 받은 채널. 채널을 아는 판으로 한 번도 설치하지 않았으면 null. */
  loadInstalled(): UpdateChannel | null {
    try {
      return parse(localStorage.getItem(INSTALLED_CHANNEL_KEY));
    } catch {
      return null;
    }
  },
  saveInstalled(channel: UpdateChannel): void {
    try {
      localStorage.setItem(INSTALLED_CHANNEL_KEY, channel);
    } catch { /* 저장 불가 환경 허용 */ }
  },
};
