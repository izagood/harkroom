import { describe, it, expect } from 'vitest';
import sharp from 'sharp';
import { downscaleImage, DOWNSCALE_MAX_INPUT_PIXELS, DOWNSCALE_MAX_PENDING, tryAcquireDownscaleSlot } from '../src/mcp/imageDownscale.js';

/**
 * `attachment.fetch` 의 그림 축소. 입력은 **신뢰하지 않는 바이트**라 실패 모양까지 잰다 —
 * 던지면 도구 호출 전체가 500 이 되고, 에이전트는 이유를 모른다.
 */
describe('downscaleImage', () => {
  it('keeps the long edge at 2000px and honours EXIF orientation', async () => {
    // 3000x1000 으로 저장했지만 orientation 6(90° 회전) — 보이는 모양은 1000x3000 세로다.
    const input = await sharp({ create: { width: 3000, height: 1000, channels: 3, background: '#336699' } })
      .jpeg().withMetadata({ orientation: 6 }).toBuffer();
    const r = await downscaleImage(input, 3 * 1024 * 1024);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.original).toEqual({ width: 1000, height: 3000 });
    expect(r.resized).toMatchObject({ width: 667, height: 2000 });
    const out = await sharp(r.data).metadata();
    expect([out.width, out.height]).toEqual([667, 2000]);
    // 메타데이터는 싣지 않는다(EXIF·GPS) — 방향은 픽셀에 반영됐으니 필요 없다.
    expect(out.exif).toBeUndefined();
  });

  it('flattens transparency onto white', async () => {
    const input = await sharp({ create: { width: 10, height: 10, channels: 4, background: { r: 0, g: 0, b: 0, alpha: 0 } } })
      .png().toBuffer();
    const r = await downscaleImage(input, 1024 * 1024);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const { data } = await sharp(r.data).raw().toBuffer({ resolveWithObject: true });
    expect(data[0]).toBeGreaterThan(240);
  });

  it('refuses a decompression bomb before decoding it', async () => {
    // 한 색이라 파일은 작지만 캔버스는 상한보다 크다.
    const side = Math.ceil(Math.sqrt(DOWNSCALE_MAX_INPUT_PIXELS)) + 100;
    const input = await sharp({ create: { width: side, height: side, channels: 3, background: '#000' } })
      .png({ compressionLevel: 9 }).toBuffer();
    const r = await downscaleImage(input, 3 * 1024 * 1024);
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.reason).toMatch(/pixel/);
  });

  it('reports undecodable bytes instead of throwing', async () => {
    const r = await downscaleImage(Buffer.from('not an image at all'), 1024);
    expect(r).toMatchObject({ ok: false });
    if (r.ok) return;
    expect(r.reason).toContain('could not decode');
  });

  it('gives up with a reason when even the smallest step is over the limit', async () => {
    const input = await sharp({ create: { width: 100, height: 100, channels: 3, background: '#fff' } }).png().toBuffer();
    const r = await downscaleImage(input, 10);
    expect(r).toMatchObject({ ok: false });
    if (r.ok) return;
    expect(r.reason).toContain('still over');
  });

  it('refuses formats outside png/jpeg/gif/webp before decoding (SVG uploaded as image/png)', async () => {
    // sharp 는 contentType 을 보지 않고 바이트로 디코더를 고른다 — PNG 라고 붙여도 SVG 로 풀린다.
    const svg = Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" width="4000" height="3000"><rect width="4000" height="3000" fill="red"/></svg>');
    const r = await downscaleImage(svg, 3 * 1024 * 1024);
    expect(r).toMatchObject({ ok: false });
    if (r.ok) return;
    expect(r.reason).toContain('unsupported image format (svg)');
  });

  it('refuses TIFF too', async () => {
    const tiff = await sharp({ create: { width: 50, height: 50, channels: 3, background: '#123456' } }).tiff().toBuffer();
    const r = await downscaleImage(tiff, 3 * 1024 * 1024);
    expect(r).toMatchObject({ ok: false });
    if (r.ok) return;
    expect(r.reason).toContain('unsupported image format (tiff)');
  });
});

describe('tryAcquireDownscaleSlot', () => {
  it('hands out at most DOWNSCALE_MAX_PENDING slots and frees them on release', () => {
    const held = Array.from({ length: DOWNSCALE_MAX_PENDING }, () => tryAcquireDownscaleSlot());
    expect(held.every((r) => r !== null)).toBe(true);
    expect(tryAcquireDownscaleSlot()).toBeNull();
    held[0]!();
    held[0]!(); // 두 번 불러도 한 자리만 돌아온다
    const again = tryAcquireDownscaleSlot();
    expect(again).not.toBeNull();
    expect(tryAcquireDownscaleSlot()).toBeNull();
    again!();
    for (const r of held.slice(1)) r!();
  });
});
