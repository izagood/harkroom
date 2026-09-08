/**
 * **시간 표기 한 벌**(`#619` 후속). 이 앱이 시간을 말하는 자리는 전부 여기를 지난다.
 *
 * ## 왜 사전이 아니라 여기인가 — 후보 셋을 실측으로 갈랐다
 *
 * `#619`(i18n 뼈대)가 이것을 **먼저 정하라**고 남겼다: 시간 문구를 사전에 넣으면
 * 언어마다 `{n}분 전`·`{n} minutes ago` 조합을 다시 쓰게 되고, `Intl` 로 가면 사전에서
 * 빠진다. 아홉 화면이 각자 다르게 처리하기 전에 답이 있어야 했다.
 *
 * 지금 네 함수가 내던 문구를 **전부 나열해 `Intl` 에 실제로 돌려 봤다**
 * (2026-09-08, Node 24 · jsdom · JavaScriptCore 셋에서 같은 결과).
 *
 * | 지금 문구 | `Intl` 이 내는 것 | 같나 |
 * |---|---|---|
 * | `11분 전` | `RelativeTimeFormat.format(-11, 'minute')` → `11분 전` | O |
 * | `1시간 전` | `format(-1, 'hour')` → `1시간 전` | O |
 * | `1일 전` | `format(-1, 'day')` (`numeric: 'always'`) → `1일 전` | O |
 * | `42초` | `DurationFormat.format({seconds: 42})` → `42초` | O |
 * | `4분 12초` | `format({minutes: 4, seconds: 12})` → `4분 12초` | O |
 * | `4시간 12분` | `format({hours: 4, minutes: 12})` → `4시간 12분` | O |
 * | `2일 5시간` | `format({days: 2, hours: 5})` → `2일 5시간` | O |
 * | `오늘` | `format(0, 'day')` (`numeric: 'auto'`) → `오늘` | O |
 * | `어제` | `format(-1, 'day')` (`numeric: 'auto'`) → `어제` | O |
 * | **`방금`** | 가장 가까운 것이 `format(-0, 'second')` → **`지금`** | **X** |
 * | **`3분째`** | `DurationFormat` → **`3분`** (`째` 를 낼 방법이 없다) | **X** |
 * | **`없음`** | 시간이 아니다 — 잴 값 자체가 `null` 이다 | **X** |
 *
 * 그래서 **C(섞는다)** 다. 갈라지는 자리가 우연이 아니라 **종류가 다르기 때문**이라는
 * 것이 이 표가 말하는 것이다:
 *
 * - `Intl` 이 내는 것은 전부 **수량**이다(얼마나 지났나 · 얼마나 걸렸나). 수량의 복수형과
 *   어순과 단위 이름은 언어의 문법이고, 그것은 플랫폼이 우리보다 잘 안다.
 * - `Intl` 이 못 내는 셋은 전부 **수량이 아니다**. `방금` 은 "숫자를 말하지 않기로 한
 *   결정"이고, `째` 는 "아직 도는 중"이라는 **상[aspect]** 이고, `없음` 은 "잴 것이
 *   없다"는 사실이다. 셋 다 우리가 정한 뜻이라 **사전의 것**이다.
 *
 * A(전부 `Intl`)를 버린 이유가 그 셋이다 — `방금`·`3분째`·`없음` 을 `Intl` 이 못 낸다.
 * B(전부 사전)를 버린 이유는 표의 O 아홉 줄이다: 그 아홉을 사전에 넣으면 세 번째 언어가
 * `{n}분 전`·`{n}시간 전`·`{n}일 전`·`{n}분 {n}초`… 를 전부 다시 쓰고, 러시아어처럼
 * 복수형이 네 갈래인 언어에서는 그 곱만큼 늘어난다. 플랫폼이 이미 아는 것을 사전에
 * 옮겨 적는 것이 곧 그 언어들의 부채다.
 *
 * **경계가 한 줄로 말해진다: 숫자는 `Intl` 이, 뜻은 사전이.**
 *
 * ## `Intl.DurationFormat` 을 써도 되나 — 셋에서 실측했다
 *
 * `RelativeTimeFormat` 만으로는 `4분 12초` 를 못 낸다(그것은 "언제"가 아니라 "얼마나
 * 오래"다 — 단위가 둘이다). `DurationFormat` 이 그 자리를 정확히 채우는데 비교적 새
 * API 라 있는지를 **실제 실행 환경에서 확인했다**(2026-09-08):
 *
 * | 환경 | `Intl.DurationFormat` |
 * |---|---|
 * | JavaScriptCore(macOS 26.5) — **배포본이 도는 엔진** | 있다 |
 * | Node 24 | 있다 |
 * | jsdom(회귀선) | 있다 |
 *
 * 배포 대상이 macOS 뿐이고(`tauri.conf.json` 의 `targets: ["app", "dmg"]`) 그 WebView 가
 * WKWebView = JavaScriptCore 이므로, **화면이 도는 그 엔진에서 직접 확인한 것**이 근거다.
 * `typeof` 로 막지 않는다 — 없는 환경이 배포 대상에 없는데 대비 코드를 두면 그 코드는
 * 영원히 안 도는 채로 남고, 아무도 그것이 맞는지 모른다.
 *
 * 타입은 `lib: ["ES2023"]` 이라 아직 없다. 그래서 아래에 최소 선언을 둔다 —
 * `lib` 를 올리면 그때 지운다.
 */
import type { Translate } from '../i18n';

/**
 * `Intl.DurationFormat` 의 최소 선언. TypeScript `lib` 가 ES2023 이라 아직 표준 선언에
 * 없다(`tsconfig.json`). **`any` 로 우회하지 않는 이유**: 이 파일이 넘기는 인자가
 * 틀리면 화면에 이상한 시간이 뜨고, 그것을 컴파일이 잡아 주는 편이 낫다.
 *
 * `declare global` 안에서 **기존 `Intl` 에 합친다**(interface merging). 파일 안에
 * `declare namespace Intl` 을 쓰면 그것이 전역 `Intl` 을 **가려서** 같은 파일의
 * `Intl.RelativeTimeFormat` 이 안 보이게 된다(실측으로 잡았다, 2026-09-08).
 * `lib` 를 올려 표준 선언이 들어오면 이 블록을 지운다.
 */
declare global {
  namespace Intl {
    interface DurationInput {
      days?: number;
      hours?: number;
      minutes?: number;
      seconds?: number;
    }
    interface DurationFormatOptions {
      style?: 'long' | 'short' | 'narrow' | 'digital';
      /** `'always'` 면 0 초도 적는다 — `durationLabel` 이 0 을 말하는 자리에만 쓴다. */
      secondsDisplay?: 'auto' | 'always';
    }
    interface DurationFormat {
      format(duration: DurationInput): string;
    }
    const DurationFormat: {
      new (locale: string, options?: DurationFormatOptions): DurationFormat;
    };
  }
}

/**
 * 서식기를 만들 때마다 새로 만들지 않는다. `Intl` 생성자는 로캘 자료를 훑으므로 목록을
 * 그리는 자리(카드 수십 개)에서 렌더마다 만들면 그것이 그대로 비용이다.
 *
 * 키에 로캘이 들어가므로 **언어를 바꾸면 다른 서식기가 나온다** — 캐시가 옛 언어를 붙들지
 * 않는다는 뜻이고, 그것이 이 화면에서 언어 전환이 즉시 먹는 이유다.
 */
const relativeCache = new Map<string, Intl.RelativeTimeFormat>();
const durationCache = new Map<string, Intl.DurationFormat>();
const zeroCache = new Map<string, Intl.DurationFormat>();

function relative(locale: string, numeric: 'auto' | 'always'): Intl.RelativeTimeFormat {
  const key = `${locale}:${numeric}`;
  let f = relativeCache.get(key);
  if (f === undefined) {
    f = new Intl.RelativeTimeFormat(locale, { numeric });
    relativeCache.set(key, f);
  }
  return f;
}

function duration(locale: string): Intl.DurationFormat {
  let f = durationCache.get(locale);
  if (f === undefined) {
    // `narrow` 를 고른 이유: 한국어는 셋(`long`·`short`·`narrow`)이 전부 `4분 12초` 로
    // 같고, 영어만 갈린다(`4 minutes, 12 seconds` / `4 min, 12 sec` / `4m 12s`).
    // 이 값이 서는 자리는 카드의 좁은 칸과 상세의 값 칸이라 **줄을 넘기면 안 된다** —
    // `long` 의 `4 minutes, 12 seconds` 는 그 칸에서 두 줄이 된다(`daemonFacts.ts` 의
    // `stamp()` 가 초를 뗀 것과 같은 사정).
    f = new Intl.DurationFormat(locale, { style: 'narrow' });
    durationCache.set(locale, f);
  }
  return f;
}

/**
 * 0 만을 위한 서식기 — `secondsDisplay: 'always'` 라 `0초`·`0s` 를 낸다.
 * 왜 따로 두는지는 `durationLabel` 안의 주석에 있다.
 */
function zeroDuration(locale: string): Intl.DurationFormat {
  let f = zeroCache.get(locale);
  if (f === undefined) {
    f = new Intl.DurationFormat(locale, { style: 'narrow', secondsDisplay: 'always' });
    zeroCache.set(locale, f);
  }
  return f;
}

/**
 * 길이를 어느 해상도까지 말할 것인가. **부르는 쪽이 고른다.**
 *
 * - `'fine'` — 아랫단위까지(`4분 12초`). 종료 요청 뒤의 기다림처럼 **초가 뜻을 갖는**
 *   자리다(롱폴링 한 바퀴가 기본 25초다).
 * - `'coarse'` — 큰 단위 하나만(`4분`). 진행 줄처럼 **자라는 숫자를 곁눈으로 읽는**
 *   자리다 — 거기서 초까지 적으면 매 초 글자가 바뀌어 옆의 이름과 상태를 읽기 어렵다.
 *
 * 이 축을 `durationLabel` 안의 판단으로 못 만든다: 같은 4분 12초를 상세는 초까지
 * 읽어야 하고 진행 줄은 읽으면 안 된다. **정책이지 서식이 아니다.**
 */
export type Grain = 'fine' | 'coarse';

/**
 * 밀리초를 **어떤 단위로 말할지** 고른다. 한 단계만 내려간다 — `2일 5시간 3분 12초` 는
 * 사람이 읽는 말이 아니라 계산 결과다.
 *
 * 반환이 `Intl.DurationInput` 인 이유: 단위 선택은 우리 판단이고(무엇을 말할지),
 * 그것을 **글자로 만드는 것**은 `Intl` 의 일이다. 둘을 안 섞는다.
 *
 * **아랫단위가 `0` 이면 빼고 준다.** `{minutes: 1, seconds: 0}` 을 그대로 넘기면
 * `Intl` 이 `1분 0초` 를 내는데, 옛 `daemonFacts.elapsedLabel` 도 그것을 피해 있었다.
 * `0` 은 정보가 아니라 자리를 차지하는 잡음이다(규칙 06).
 */
function pickUnits(ms: number, grain: Grain): Intl.DurationInput {
  const secs = Math.floor(ms / 1_000);
  if (secs < 60) return { seconds: secs };
  const drop = (big: Intl.DurationInput, small: Intl.DurationInput): Intl.DurationInput =>
    (grain === 'coarse' || Object.values(small)[0] === 0) ? big : { ...big, ...small };
  const mins = Math.floor(secs / 60);
  if (mins < 60) return drop({ minutes: mins }, { seconds: secs % 60 });
  const hours = Math.floor(mins / 60);
  if (hours < 24) return drop({ hours }, { minutes: mins % 60 });
  return drop({ days: Math.floor(hours / 24) }, { hours: hours % 24 });
}

/**
 * **"얼마나 전"** — 지난 시각 하나를 사람이 읽는 말로(`11분 전` · `11 minutes ago`).
 *
 * 하한이 `time.justNow` 인 것은 **사전의 판단**이다: `0분 전` 은 사람이 쓰지 않는 말이고
 * (`minutesAgo.ts` 가 처음 적어 둔 근거), `Intl` 이 그 자리에 내는 `지금`/`now` 는
 * 이 앱이 고른 말이 아니다. 숫자를 말하지 않기로 한 결정이므로 사전이 들고 있는다.
 *
 * **음수를 지어내지 않는다.** 시계 보정이나 왕복 지연으로 미래 시각이 올 수 있는데,
 * 그때 `11분 후` 라고 적으면 사람은 앱이 고장 났다고 읽는다(`lastTurn.ts` 가 세운 규율).
 * `Math.max(0, …)` 로 뭉개면 곧 `time.justNow` 로 떨어진다.
 *
 * `numeric: 'always'` 다 — 하루 전을 `어제` 라고 하지 않는다. 이 값이 서는 자리는
 * "마지막 활동이 얼마나 됐나"이고 그 답은 **길이**여야 한다(`어제` 는 달력의 말이라
 * 25시간 전과 47시간 전을 같은 말로 만든다). 달력을 말하는 자리는 `dayLabel` 이고,
 * 그쪽은 `numeric: 'auto'` 를 쓴다 — 같은 API 를 **다른 뜻으로** 부르는 것이다.
 *
 * ## 합치면서 `minutesAgo` 쪽 화면이 바뀐다 — 그것이 이 합침의 요점이다
 *
 * 옛 `minutesAgo` 는 **분에서 멈춰 있었다**: 한 시간 전이 `60분 전`, 하루 전이
 * `1440분 전`, 한 달 전이 `41760분 전` 이었다. 옛 `lastTurnAgo` 는 같은 물음에
 * `1시간 전`·`1일 전` 이라고 답했다 — **같은 뜻을 두 함수가 다르게 말하고 있었다.**
 *
 * 둘을 합치면 하나로 수렴할 수밖에 없고, 수렴할 쪽은 `lastTurnAgo` 다. 이유가
 * `lastTurn.ts` 에 이미 적혀 있다 — *"운영자가 알고 싶은 것은 '얼마나 됐나'이고, 그것을
 * 사람이 시계와 뺄셈으로 계산하게 만들 이유가 없다."* `41760분 전` 은 그 문장이 막으려던
 * 바로 그것이다: 사람이 나눗셈을 해야 뜻이 나온다.
 *
 * 바뀌는 자리는 투영 띠와 리스 목록 둘이고(`projectionBanner` 가 이 함수를 받는다),
 * 그 화면이 말하는 것은 *"투영이 얼마나 오래 멈춰 있나"* 다. 하루 넘게 멈춘 투영을
 * `1440분 전부터` 라고 적는 것보다 `1일 전부터` 가 그 사실을 더 곧게 말한다.
 */
export function agoLabel(fromMs: number, now: number, locale: string, t: Translate): string {
  const ms = Math.max(0, now - fromMs);
  if (!Number.isFinite(ms) || ms < 60_000) return t('time.justNow');
  const mins = Math.floor(ms / 60_000);
  const f = relative(locale, 'always');
  if (mins < 60) return f.format(-mins, 'minute');
  const hours = Math.floor(mins / 60);
  if (hours < 24) return f.format(-hours, 'hour');
  return f.format(-Math.floor(hours / 24), 'day');
}

/**
 * **"얼마나 오래"** — 두 시각의 차이를 길이로(`4분 12초` · `4m 12s`).
 *
 * ## 두 벌이던 `elapsedLabel` 을 여기 하나로 합쳤다
 *
 * `progressGroup.ts` 와 `daemonFacts.ts` 에 같은 이름의 함수가 시그니처만 다르게 있었다
 * (`(startedAt: string, now)` 와 `(fromMs: number, now)`). 이 저장소가 반복 결함으로
 * 지목한 *"같은 판정이 두 벌"* 의 모양이라 **합칠 수 있는지부터 봤다.**
 *
 * 각 주석이 적어 둔 차이는 셋이었고, 재 보니 **셋 다 서식의 차이가 아니었다**:
 *
 * | 차이 | 어느 쪽 판단인가 |
 * |---|---|
 * | 한쪽은 초까지, 한쪽은 분까지 | **부르는 쪽**이다 → `grain` 인자로 남았다(위 `Grain`) |
 * | 한쪽은 1분 미만에 `null`, 한쪽은 `방금` | **부르는 쪽**이다. 진행 줄은 `0분째` 를 안 그리려고 자리를 비우고(`progressGroup.elapsedMs`), 상세는 행이 서야 하므로 말을 한다(`daemonFacts.elapsedLabel`) |
 * | 한쪽은 `째`, 한쪽은 안 붙음 | **문구**다. 아래 `runningLabel`·`tookLabel` 이 그 자리다 |
 *
 * 남는 공통은 **"ms 를 단위로 갈라 그 언어의 말로 적는다"** 하나이고 그것이 이 함수다.
 * `grain` 을 인자로 받는 것이 정책을 도로 끌고 들어온 것 아니냐는 물음에 답을 적어 둔다:
 * **아니다 — 정책은 값을 고르는 쪽에 있고 여기 있는 것은 그 값을 받는 손잡이다.** 셋째
 * 갈래(`null` 이냐 `방금` 이냐)를 여기 넣지 않은 것이 그 선의 증거다. 그것은 문구를
 * 고르는 판단이라 부르는 쪽에 남았다.
 *
 * **음수는 `0` 으로 뭉갠다** — `agoLabel` 과 같은 규율이고, 회귀선이 그것을 잰다.
 */
export function durationLabel(ms: number, locale: string, grain: Grain = 'fine'): string {
  const safe = Math.max(0, Number.isFinite(ms) ? ms : 0);
  /**
   * **`Intl.DurationFormat` 은 0 을 빈 문자열로 낸다**(실측 2026-09-08 — `{seconds: 0}`
   * 도, `{minutes: 0, seconds: 0}` 도 `""` 다). 그것을 그대로 화면에 내면 값 칸이 비고,
   * 빈 칸은 "짧다"가 아니라 **"못 읽었다"** 로 읽힌다(`daemonFacts.ts` 규율 1 의 거울상).
   * 옛 `formatDuration` 은 `0초` 라고 말했고, 그 판단을 지킨다.
   *
   * `secondsDisplay: 'always'` 로 서식기 전체를 바꾸지 않는다 — 그러면 `4시간 12분` 이
   * `4시간 12분 0초` 가 되어, 0 하나를 살리려고 모든 자리에 0 을 붙이는 셈이다.
   */
  if (safe < 1_000) return zeroDuration(locale).format({ seconds: 0 });
  return duration(locale).format(pickUnits(safe, grain));
}

/**
 * **"얼마나 오래, 아직 도는 중"** — `3분째` · `running 3m`.
 *
 * `durationLabel` 과 갈라 두는 이유가 이 PR 에서 가장 중요한 자리다. `째` 는 길이가
 * 아니라 **상[aspect]** 이다 — "3분이 걸렸다"와 "3분째 돌고 있다"는 다른 사실이고,
 * `Intl` 은 후자를 낼 방법이 없다(`DurationFormat` 은 `3분` 까지다).
 *
 * 그리고 이것을 **사전 항목으로 둬야만** 하는 이유가 따로 있다: 이전 코드는
 * `ProgressRow` 에서 `elapsed.replace(/째$/, '')` 로 끝난 묶음의 `째` 를 떼고 있었다.
 * 한국어 어미를 정규식으로 자르는 것이라 **다른 언어에서는 아무것도 안 잘린다** —
 * 영어 화면이 "끝난 진행"과 "도는 진행"을 같은 글자로 말하게 된다. 두 상태를 사전
 * 항목 둘로 두면 각 언어가 제 방식으로 가른다(영어는 `running 3m` / `took 3m`).
 */
export function runningLabel(ms: number, locale: string, t: Translate): string {
  // **`coarse` 다.** 이 줄은 곁눈으로 읽는 자리라 초까지 적으면 매 초 글자가 바뀌어
  // 옆의 이름과 상태를 읽기 어렵다 — 옛 `progressGroup.elapsedLabel` 이 분·시간만 낸
  // 것이 그 판단이었고, 합치면서 잃지 않는다.
  return t('time.running', { duration: durationLabel(ms, locale, 'coarse') });
}

/** `runningLabel` 의 짝 — **끝난** 진행의 길이(`3분` · `took 3m`). 위 주석이 근거다. */
export function tookLabel(ms: number, locale: string, t: Translate): string {
  return t('time.took', { duration: durationLabel(ms, locale, 'coarse') });
}
