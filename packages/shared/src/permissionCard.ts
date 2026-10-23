/**
 * 권한 카드 계약(W4b) — 서버가 카드 meta `permissionRequest` 에 적는 위임장·줄 칸과 선택지 id.
 * 화면(데스크톱·모바일)은 이 칸으로 「이 위임장에 줄 하나 더하기」 카드를 그린다. 값은 언제나 서버가 쓴다.
 */

/** 선택지 id. 옛 id(`approve`=7일, `approve_hour`)도 서버가 계속 받는다. */
export const PERMISSION_CARD_OPTION = {
  /** [이 위임장 동안] — 위임장에 줄을 더한다(기한은 같은 결정의 grant 기한). tool·merge 의 주 버튼. */
  approveMandate: 'approve_mandate',
  /** [이번 한 번] — merge: 거절된 이 PR·이 head 1회 / command: 그 명령 1회. */
  approveOnce: 'approve_once',
  /** [이 턴만] — tool. 지금은 서버가 턴 단위로 셀 수 없어 카드에 싣지 않는다(예약 id). */
  approveTurn: 'approve_turn',
  /** [이 스레드로 위임장 만들고 더하기] — 위임 없는 턴의 요청. */
  approveNewMandate: 'approve_new_mandate',
  deny: 'deny',
  /** 옛 id — 7일 승인. 위임이 있으면 `approve_mandate` 와 같다. */
  approveLegacy: 'approve',
  /** 옛 id — command 의 이 스레드 1시간. */
  approveHour: 'approve_hour',
} as const;

export type PermissionCardOptionId = (typeof PERMISSION_CARD_OPTION)[keyof typeof PERMISSION_CARD_OPTION];

export type PermissionCardCap = 'tool' | 'merge' | 'command' | 'bypass';

/** 위임장 칩 — 이름은 그 스레드의 작업 항목 제목, 없으면 소유자 첫 글 앞부분(멘션 뺀 40자). */
export interface PermissionCardMandate { id: string; name: string }

/** 선택지 하나가 더할 줄의 한도(미리 보기). 실제 기한은 정할 때 서버가 정한다. */
export interface PermissionCardLineLimits {
  /** 줄이 끝나는 때까지의 길이(ms) — approve_mandate 는 grant 기한(7일), command 는 1시간. */
  untilMs?: number;
  uses?: number;
  pr?: number;
  head?: string;
  ciOverride?: boolean;
}

/** 카드가 더할 줄. `limits` 는 선택지 id 마다. */
export interface PermissionCardLine {
  cap: PermissionCardCap;
  scope: string;
  limits: Partial<Record<PermissionCardOptionId, PermissionCardLineLimits>>;
}

/**
 * 권한 카드 거울의 서버 전용 칸(meta `permissionMirror`, W4-2). 원본을 볼 수 있는 거울에만 원본의 once·line·mandate 를 싣는다.
 * 중립 거울(원본 채널을 못 보는 사람이 있을 수 있음)은 링크(`rootId`)만. gh 계정 고르기는 원본에서만 한다.
 */
export interface PermissionMirrorMeta {
  rootId: string;
  neutral: boolean;
  kind?: 'tool' | 'merge' | 'command';
  once?: { number: number; headSha: string; reason: string; failedChecks?: string[] };
  line?: PermissionCardLine;
  mandate?: PermissionCardMandate;
}
