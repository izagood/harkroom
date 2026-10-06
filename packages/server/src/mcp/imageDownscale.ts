import sharp from 'sharp';

/**
 * `attachment.fetch` 가 인라인 한도(3MiB)를 넘는 그림을 **줄여서** 싣는다.
 *
 * ## 왜 필요한가
 *
 * 폰 스크린샷 하나가 4~6MB 다(IMG_4957.png 4,612,118B 실측). 줄이지 않으면 에이전트는
 * "too large to inline" 과 셸 다운로드 안내만 받는데, 그 다운로드는 PAT 가 필요해 auto mode
 * 에서 막힌다 — 결국 사람이 붙인 그림을 **못 본다.** 모델이 그림을 읽는 해상도는 긴 변
 * 2000px 안팎이 상한이라, 원본 해상도를 그대로 넘겨도 얻는 것이 없다.
 *
 * **원본은 건드리지 않는다.** 저장소의 바이트·REST 다운로드는 그대로이고, 이 도구 응답만
 * 줄인 사본을 싣는다.
 *
 * ## 신뢰하지 않는 입력이다
 *
 * 올린 사람이 아무 바이트나 `image/png` 라고 보낼 수 있다. 그래서:
 * - 디코딩 전에 **픽셀 수 상한**(`limitInputPixels`)을 건다 — 압축 폭탄(작은 파일, 거대한
 *   캔버스)이 서버 메모리를 먹지 못하게. 48MP 폰 카메라는 들어오고 그 이상은 거절한다.
 * - 읽어 들일 원본 바이트에도 상한(`DOWNSCALE_READ_MAX_BYTES`)을 둔다 — 호출부가 지킨다.
 * - 메타데이터(EXIF·GPS 등)는 출력에 싣지 않는다(sharp 기본값). 방향만 `rotate()` 로
 *   픽셀에 반영한다 — 안 그러면 세로 사진이 눕는다.
 * - 움직이는 GIF·WebP 는 **첫 프레임**만 쓴다(sharp 기본값). 응답에 그 사실을 적는다.
 * - sharp 는 contentType 이 아니라 **바이트 내용**으로 디코더를 고른다. `image/png` 라고 올린
 *   SVG·TIFF·HEIF 도 libvips 가 푼다 — 그래서 헤더로 읽은 형식을 `DECODABLE_FORMATS` 로 묶고,
 *   밖이면 디코딩 전에 거절한다. 잘 안 쓰는 디코더를 공격면으로 내주지 않는다.
 * - 동시에 기다릴 수 있는 수를 `DOWNSCALE_MAX_PENDING` 으로 묶는다. 호출부는 원본(최대 32MiB)을
 *   읽기 **전에** 자리를 잡는다(`tryAcquireDownscaleSlot`) — 기다리는 호출마다 원본을 쥐고
 *   있으니, 자리 없이 줄을 세우면 메모리가 줄 길이만큼 쌓인다.
 */

/** 줄여 볼 원본의 최대 바이트. 이보다 큰 것은 메모리에 올리지 않고 지금처럼 안내만 한다. */
export const DOWNSCALE_READ_MAX_BYTES = 32 * 1024 * 1024;

/**
 * 디코딩할 최대 픽셀 수. 50M 이면 48MP(8064×6048) 폰 사진까지 들어오고, RGBA 로 풀어도
 * 200MB 안쪽이다. sharp 의 기본값(268M px ≈ 1GB)은 서버 하나가 감당하기에 너무 크다.
 */
export const DOWNSCALE_MAX_INPUT_PIXELS = 50_000_000;

/**
 * 시도할 (긴 변, JPEG 품질) 순서. 첫 단계가 거의 늘 한도 안에 든다 — 2000px JPEG 는
 * 보통 0.3~1MB 다. 뒤 단계는 사진처럼 압축이 안 되는 그림을 위한 안전판이다.
 */
/**
 * 디코딩을 허락하는 형식(sharp `metadata().format` 값). `attachment.fetch` 가 그림으로 싣는
 * `IMAGE_TYPES`(png·jpeg·gif·webp)와 같은 집합이다 — 그 밖의 것은 애초에 그림으로 다루지 않는다.
 */
const DECODABLE_FORMATS: ReadonlySet<string> = new Set(['png', 'jpeg', 'gif', 'webp']);

/** 동시에 잡을 수 있는 축소 자리(도는 것 하나 + 기다리는 것). 넘치면 `busy` 로 돌려보낸다. */
export const DOWNSCALE_MAX_PENDING = 4;

let pending = 0;

/**
 * 축소 자리 하나를 잡는다. 자리가 없으면 `null` — 호출부는 원본을 읽지 말고 이유를 말한다.
 * 받은 함수를 **꼭 한 번** 불러 자리를 돌려준다(`finally`). 두 번 불러도 한 번만 센다.
 */
export function tryAcquireDownscaleSlot(): (() => void) | null {
  if (pending >= DOWNSCALE_MAX_PENDING) return null;
  pending++;
  let released = false;
  return () => {
    if (released) return;
    released = true;
    pending--;
  };
}

const STEPS: ReadonlyArray<{ maxEdge: number; quality: number }> = [
  { maxEdge: 2000, quality: 82 },
  { maxEdge: 1600, quality: 75 },
  { maxEdge: 1200, quality: 70 },
  { maxEdge: 800, quality: 60 },
];

export type DownscaleResult =
  | {
    ok: true;
    data: Buffer;
    mimeType: 'image/jpeg';
    original: { width: number; height: number };
    resized: { width: number; height: number; quality: number };
    /** 움직이는 그림이었으면 첫 프레임만 실었다. */
    firstFrameOnly: boolean;
  }
  | { ok: false; reason: string };

/**
 * `input` 을 `limitBytes` 아래의 JPEG 로 줄인다. 투명한 곳은 흰색으로 채운다(JPEG 에는
 * 알파가 없고, 스크린샷의 투명 영역은 거의 없거나 배경이다).
 *
 * 실패를 던지지 않는다 — 이유를 담아 돌려준다. 호출부는 그 이유를 에이전트에게 그대로
 * 말한다(지금의 "too large" 와 같은 자리).
 */
export function downscaleImage(input: Buffer, limitBytes: number): Promise<DownscaleResult> {
  // 한 번에 하나만 돈다. 한 장이 풀리면 수백 MB 이고 libvips 는 코어를 다 쓴다 — 여러 에이전트가
  // 동시에 큰 그림을 열어도 서버 메모리는 한 장 몫으로 묶인다. 드문 호출이라 기다림은 짧다.
  const run = queue.then(() => downscaleNow(input, limitBytes));
  queue = run.then(() => undefined, () => undefined);
  return run;
}

let queue: Promise<void> = Promise.resolve();

async function downscaleNow(input: Buffer, limitBytes: number): Promise<DownscaleResult> {
  let width: number;
  let height: number;
  let pages: number;
  try {
    const meta = await sharp(input, { limitInputPixels: DOWNSCALE_MAX_INPUT_PIXELS }).metadata();
    // 디코딩 전에 형식부터 — metadata() 는 헤더만 읽는다.
    if (!meta.format || !DECODABLE_FORMATS.has(meta.format)) {
      return { ok: false, reason: `unsupported image format (${meta.format ?? 'unknown'}); only png, jpeg, gif and webp are downscaled` };
    }
    if (!meta.width || !meta.height) return { ok: false, reason: 'could not read image dimensions' };
    // EXIF 방향이 5~8 이면 가로·세로가 바뀐 채 저장돼 있다 — 보고하는 해상도는 보이는 모양으로.
    const swapped = (meta.orientation ?? 1) >= 5;
    width = swapped ? meta.height : meta.width;
    height = swapped ? meta.width : meta.height;
    pages = meta.pages ?? 1;
    if (width * height > DOWNSCALE_MAX_INPUT_PIXELS) {
      return { ok: false, reason: `image is ${width}x${height}, over the ${DOWNSCALE_MAX_INPUT_PIXELS} pixel decode limit` };
    }
  } catch (err) {
    return { ok: false, reason: `could not decode image (${errMessage(err)})` };
  }

  for (const step of STEPS) {
    try {
      const { data, info } = await sharp(input, { limitInputPixels: DOWNSCALE_MAX_INPUT_PIXELS })
        .rotate()
        .resize({ width: step.maxEdge, height: step.maxEdge, fit: 'inside', withoutEnlargement: true })
        .flatten({ background: '#ffffff' })
        .jpeg({ quality: step.quality, mozjpeg: true })
        .toBuffer({ resolveWithObject: true });
      if (data.length <= limitBytes) {
        return {
          ok: true,
          data,
          mimeType: 'image/jpeg',
          original: { width, height },
          resized: { width: info.width, height: info.height, quality: step.quality },
          firstFrameOnly: pages > 1,
        };
      }
    } catch (err) {
      return { ok: false, reason: `could not re-encode image (${errMessage(err)})` };
    }
  }
  return { ok: false, reason: `still over ${limitBytes}B after downscaling to ${STEPS.at(-1)!.maxEdge}px` };
}

function errMessage(err: unknown): string {
  // sharp 의 오류 문장은 libvips 것이라 길 수 있다 — 한 줄만, 짧게.
  const msg = err instanceof Error ? err.message : String(err);
  return msg.split('\n', 1)[0]!.slice(0, 200);
}
