import { PROJECTION_UNCONFIGURED_DETAIL, PROJECTION_UNCONFIGURED_HEADLINE } from '@murmur/shared';
import type { ProjectionStatus } from '@murmur/shared';

/**
 * 투영이 **정상이 아니라고 말하는 한 줄**(#488 A3-a).
 *
 * ## 왜 판정을 밖으로 뽑았나
 *
 * 이 판정을 읽는 자리가 **둘**이 됐다: 화면 위쪽 띠(`ProjectionBanner`)와, 목록 위에
 * 남는 `LeasePanel` 의 경고. 문서가 오류를 사이드바에서 띠로 옮기라고 했지만
 * `LeasePanel` 자신도 이 사실을 알아야 하기 때문이다 — 투영이 멈춘 동안 남아 있던
 * 리스는 **지금 벌어지는 일이 아닐 수 있고**, 그것을 말없이 '활성 작업'으로 보여 주면
 * 화면이 오래된 사실을 지금 사실로 주장한다.
 *
 * 두 자리가 각자 판정하면 반드시 갈라진다. 슬라이스 1 의 `decide()` 와 같은 이유로
 * 함수 하나를 공유한다.
 *
 * ## 네 사정을 뭉개지 않는다 (`docs/design.md` §4)
 *
 * 빈 목록 하나가 네 가지를 뭉갤 수 있다: ① 투영이 꺼져 있다 ② 멈췄다 ③ 상태를 못
 * 읽었다 ④ 정말로 잡힌 작업이 없다. 넷을 한 문구로 그리면 도그푸딩 중에 투영이 끊긴
 * 것을 **아무도 모른다** — 화면이 평소와 똑같기 때문이다.
 *
 * **순서가 뜻을 정한다: 못 읽은 것이 먼저다.** 마지막으로 성공한 상태가 남아 있어도
 * 그것은 지금의 사실이 아니므로, 지금 못 읽고 있다는 것을 먼저 말한다.
 */
export interface ProjectionBanner {
  /** 회귀선이 사정을 구별해 물을 수 있도록 사정마다 다른 값이다. */
  testid: string;
  /**
   * **급한 일과 고장은 다른 색이다**(문서: "급한 일과 고장이 같은 색이면 둘 다 안
   * 보인다"). 강조색(accent)은 나를 막는 말에만 쓰이므로 고장에는 주의색을 준다.
   * '아직 모른다'는 고장이 아니라서 색을 받지 않는다.
   */
  tone: 'warning' | 'danger' | 'muted';
  text: string;
  detail: string | null;
  /**
   * 이 사정을 **띠로 세울 것인가**. '확인하는 중'은 세우지 않는다 — 앱을 켤 때마다
   * 잠깐 뜨는 띠는 정보가 아니라 깜빡임이고, 그 사이 화면이 한 줄 밀린다.
   */
  strip: boolean;
  /**
   * **리스 목록 옆에 설 짧은 말**(#489 후속). 띠가 "고장났다"를 말하는 동안 이 줄은
   * **그 고장이 이 목록에 뜻하는 것**을 말한다 — 같은 문구를 두 자리에 세우면 중복이고,
   * 사용자가 화면에서 그것을 먼저 발견했다(실측 2026-09-07).
   *
   * **사정마다 다른 말이어야 한다.** `#267` 이 그것을 회귀선으로 못 박았다: 꺼진 것과
   * 멈춘 것과 정상+빈 목록이 같은 문구면 화면이 셋을 구별하지 못한다.
   */
  listNote: string;
}

export function projectionBanner(input: {
  status: ProjectionStatus | null;
  error: string | null;
  /**
   * '멈춘 지 얼마나'를 사람 말로 바꾸는 것은 화면의 일이라 주입받는다.
   * `lastPolledAt` 은 **epoch 밀리초**다(ISO 문자열이 아니다).
   */
  minutesAgo: (timestamp: number) => string;
}): ProjectionBanner | null {
  const { status, error, minutesAgo } = input;

  if (error !== null) {
    return {
      testid: 'projection-unreadable',
      tone: 'danger',
      text: '투영 상태를 읽지 못했다',
      detail: error,
      strip: true,
      listNote: '지금 상태를 못 읽어 이 목록을 믿을 수 없다',
    };
  }

  // 아직 첫 응답이 오지 않았다. "없다"가 아니라 **"아직 모른다"** 다.
  if (status === null) {
    return {
      testid: 'projection-unknown',
      tone: 'muted',
      text: '투영 상태를 확인하는 중…',
      detail: null,
      strip: false,
      // 띠가 안 서는 유일한 사정이라 이 줄이 그 사정을 말하는 **유일한 자리**다.
      listNote: '투영 상태를 확인하는 중…',
    };
  }

  if (status.state === 'unconfigured') {
    return {
      testid: 'projection-unconfigured',
      tone: 'warning',
      text: PROJECTION_UNCONFIGURED_HEADLINE,
      detail: PROJECTION_UNCONFIGURED_DETAIL,
      strip: true,
      listNote: '투영이 꺼져 있어 이 목록은 채워지지 않는다',
    };
  }

  if (status.state === 'stalled') {
    // 폴링을 한 번도 못 했으면 "N분 전"이라고 말할 수 없다 — 모르는 것을 숫자로
    // 꾸미지 않는다.
    const since = status.lastPolledAt === null
      ? '언제부터인지 알 수 없지만'
      : `${minutesAgo(status.lastPolledAt)}부터`;
    return {
      testid: 'projection-stalled',
      tone: 'warning',
      text: `투영이 ${since} 멈춰 있다`,
      detail: status.lastError,
      strip: true,
      listNote: `투영이 ${since} 멈춰 이 목록은 지금 사실이 아닐 수 있다`,
    };
  }

  return null;
}

/** 톤을 실제 글자색으로. 띠와 패널이 같은 표를 쓴다. */
export const BANNER_TEXT_TONE: Record<ProjectionBanner['tone'], string> = {
  warning: 'text-warning',
  danger: 'text-danger',
  muted: 'text-fg-subtle',
};
