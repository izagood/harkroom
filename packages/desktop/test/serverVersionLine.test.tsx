// 커뮤니티 목록이 **붙어 있는 서버의 버전**을 말한다(#693).
//
// 사람의 진단: *"서버가 잘 연결된 것은 보이는데 서버가 무슨 버전인지를 알 수 없어 …
// 재배포를 해야 되는지 아닌지 알 수가 없어."* 화면이 `Connected` 하나만 말하는 동안
// 배포는 조용히 낡는다 — 실제로 머지 10분 **전**에 빌드된 이미지가 34시간을 돌았다.
//
// **이 파일이 가장 신경 쓰는 것은 다섯 사정을 뭉개지 않는 것이다**(`docs/design.md` §4):
// ① 아직 못 받았다 ② 버전을 안 싣는 옛 판이다 ③ **호환 하한보다 낮다** ④ 뒤처졌지만
// 하한은 넘는다 ⑤ 같거나 앞선다.
//
// ③·④ 를 가르는 것이 이 판본이 더한 전부다. "앱과 다르다"는 거의 **항상** 참이라
// (릴리스는 하루에도 여러 번 돌고 서버는 손으로 재배포한다) 그것만으로 경고를 켜면
// 경고가 상시로 켜지고, 상시로 켜지는 경고는 아무도 안 본다. 사람이 답해야 하는 질문은
// "다른가"가 아니라 **"이 서버에서 이 앱이 도는가"** 다.
import { describe, it, expect } from 'vitest';
import { MIN_SERVER_VERSION, type ServerVersion } from '@murmur/shared';
import { serverVersionLine } from '../src/lib/serverVersionLine';
import { translator } from '../src/i18n';

const ko = translator('ko');
/** '얼마나 전'은 화면의 일이라 주입된다 — 회귀선은 그것을 고정값으로 못 박는다. */
const ago = (): string => '3시간 전';

/**
 * 하한에서 patch 를 옮긴 버전. **버전을 손으로 적지 않기 위해서다** — `0.1.167` 같은
 * 숫자를 박아 두면 `MIN_SERVER_VERSION` 을 올리는 날 이 파일이 통째로 빨개지고, 그때
 * 사람이 보는 것은 자기가 낸 회귀가 아니라 상관없는 파일의 붉은 줄들이다.
 */
function fromFloor(delta: number): string {
  const [major, minor, patch] = MIN_SERVER_VERSION.split('.').map(Number) as [number, number, number];
  return `${major}.${minor}.${patch + delta}`;
}
/** 하한을 넘는 서버(정상). */
const ABOVE = fromFloor(5);
/** 하한 바로 아래 — **한 판만 모자라도 기능은 죽는다.** */
const BELOW = fromFloor(-1);

/**
 * 기본 서버는 **호환 하한을 넘는다**. 이 파일의 대부분은 하한과 무관한 갈래(같다·앞선다·
 * 뒤처졌다)를 재므로, 기본값이 하한 아래면 그 전부가 `too-old` 로 떨어져 아무것도 못 잰다.
 * 그래서 `MIN_SERVER_VERSION` 자신을 기본으로 쓴다 — 하한을 올려도 이 파일은 안 깨진다.
 */
const server = (over: Partial<ServerVersion> = {}): ServerVersion => ({
  version: MIN_SERVER_VERSION, commit: null, startedAt: '2026-09-10T09:00:00.000Z', ...over,
});

const line = (over: Partial<ServerVersion> | null, appVersion = MIN_SERVER_VERSION) => serverVersionLine({
  server: over === null ? null : server(over), appVersion, ago, t: ko,
});

describe('serverVersionLine', () => {
  it('아직 못 받았으면 "확인 중"이지 "버전 없음"이 아니다', () => {
    const l = line(null);
    expect(l.testid).toBe('server-version-unknown');
    expect(l.text).toBe('서버 버전 확인 중');
    expect(l.tone).toBe('muted');
    // 못 받은 것에는 기동 시각도 커밋도 없다 — 지어내지 않는다.
    expect(l.started).toBeNull();
    expect(l.commit).toBeNull();
  });

  // 버전을 안 싣는 서버는 **그 사실이 곧 답이다.** 그래서 '모른다'와 다른 사정이고,
  // 유일하게 '아직 모르는 것'인데도 눈에 띄는 색을 받는다.
  it('버전을 안 싣는 옛 서버는 재배포하라고 말한다', () => {
    const l = line({ version: null });
    expect(l.testid).toBe('server-version-legacy');
    expect(l.tone).toBe('warning');
    expect(l.detail).toContain('재배포');
    // 옛 서버라도 기동 시각은 온다 — 그것만으로도 얼마나 낡았는지 짐작이 된다.
    expect(l.started).toBe('3시간 전');
  });

  it('앱과 같으면 숫자만 적고 색을 주지 않는다', () => {
    const l = line({ version: ABOVE }, ABOVE);
    expect(l.testid).toBe('server-version-same');
    expect(l.text).toBe(`서버 v${ABOVE}`);
    expect(l.tone).toBe('muted');
    expect(l.detail).toBeNull();
  });

  /**
   * **이 갈래가 이 판본의 요지다.** 앞 판본은 "앱과 다르다"만 봤고 그것은 거의 항상 참이라
   * 경고가 상시로 켜졌다. 하한을 넘는 서버는 **뒤처졌어도 돌아간다** — 사람이 지금 할 일이
   * 없으므로 문구도 "재배포해라"가 아니라 무엇을 확인했는지를 적는다.
   */
  it('뒤처졌지만 하한은 넘으면 주의색이고, 재배포하라고 하지 않는다', () => {
    const l = line({ version: ABOVE }, fromFloor(9));
    expect(l.testid).toBe('server-version-behind');
    expect(l.tone).toBe('warning');
    expect(l.detail).toBe(`이 앱(v${fromFloor(9)})보다 뒤처졌지만, 요구 버전(v${MIN_SERVER_VERSION})은 넘는다.`);
    expect(l.detail).not.toContain('재배포');
  });

  /**
   * **하한보다 낮으면 고장이다.** 한 판만 모자라도 그렇다 — 하한은 "이 아래에서는 기능이
   * 죽는다"는 선이지 취향이 아니다. 색이 `warning` 이 아니라 `danger` 여야 하는 이유:
   * 고장과 주의가 같은 색이면 둘 다 안 보인다.
   */
  it('하한보다 낮으면 고장색이고, 요구 버전을 말한다', () => {
    const l = line({ version: BELOW }, fromFloor(9));
    expect(l.testid).toBe('server-version-incompatible');
    expect(l.tone).toBe('danger');
    // 숫자가 문구 안에 남는다 — 이 줄이 `community.version.value` 자리를 대신하므로,
    // 여기 없으면 화면에서 서버 버전이 통째로 사라진다.
    expect(l.text).toContain(BELOW);
    expect(l.detail).toBe(`이 앱은 서버 v${MIN_SERVER_VERSION} 이상이 필요하다. 재배포하기 전까지 일부 기능이 동작하지 않는다.`);
  });

  // 서버를 먼저 배포하는 것은 흔한 일이고 사람이 할 일이 없다 — 사실만 적는다.
  it('앞서면 사실만 적고 색을 주지 않는다', () => {
    const l = line({ version: fromFloor(9) }, ABOVE);
    expect(l.testid).toBe('server-version-ahead');
    expect(l.tone).toBe('muted');
    expect(l.detail).toBe(`이 앱(v${ABOVE})보다 앞선다.`);
  });

  // 견줄 수 없는 모양(자체 빌드·포크)을 '같다'고도 '뒤처졌다'고도, **'고장'이라고도**
  // 말하지 않는다. 모르는 것을 고장이라 부르면 자체 빌드마다 붉은 줄이 선다.
  it('견줄 수 없는 버전은 숫자만 적는다 — 고장이라 부르지 않는다', () => {
    const l = line({ version: 'dev' }, ABOVE);
    expect(l.text).toBe('서버 vdev');
    expect(l.tone).toBe('muted');
    expect(l.detail).toBeNull();
  });

  // 못 받은 기동 시각을 `Date.now()` 로 채우면 "방금 뜬 서버"라는 **거짓**이 된다.
  it('기동 시각이 없거나 깨졌으면 감춘다', () => {
    expect(line({ startedAt: '' }).started).toBeNull();
    expect(line({ startedAt: 'not-a-date' }).started).toBeNull();
  });

  it('빌드 커밋은 있으면 그대로 싣는다', () => {
    expect(line({ commit: 'bd06243' }).commit).toBe('bd06243');
    expect(line({ commit: null }).commit).toBeNull();
  });
});
