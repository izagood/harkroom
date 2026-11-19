//! `attachment.fetch` 가 인라인 한도(3MiB)를 넘는 그림을 **줄여서** 싣는다 — TS `mcp/imageDownscale.ts` 를 옮긴다.
//!
//! - 원본은 건드리지 않는다. 이 도구 응답만 줄인 JPEG 사본을 싣는다.
//! - 신뢰하지 않는 입력이다: 헤더로 읽은 형식이 png·jpeg·gif·webp 밖이면 풀기 전에 거절하고(`DECODABLE_FORMATS`),
//!   보이는 가로×세로가 [`MAX_INPUT_PIXELS`] 를 넘으면 풀지 않는다. 디코더에도 같은 상한(`Limits`)을 건다.
//! - EXIF 방향은 픽셀에 반영하고 메타데이터는 싣지 않는다. 투명한 곳은 흰색. 움직이는 GIF·WebP 는 첫 장만(`firstFrameOnly`).
//! - 동시에 기다릴 수 있는 수는 [`MAX_PENDING`](도는 것 하나 + 기다리는 것), 도는 것은 한 번에 하나다.
//!
//! **TS 와 다른 점**(크기·형식 규약은 같다): 인코더가 mozjpeg 이 아니라 `image` 크레이트 JPEG 이고 리샘플러 구현이 달라
//! **바이트·바이트 수는 같지 않다**. 단계(긴 변 2000/1600/1200/800 · 품질 82/75/70/60)·`fit: inside`·확대 안 함·
//! 3MiB 이하·응답 모양(`downscaled` 칸)·실패 문장 틀은 같다. 디코더 오류 문장(`could not decode image (…)`의 괄호 안)은
//! libvips 것이 아니라 `image` 크레이트 것이다.
use image::{DynamicImage, ImageDecoder, ImageFormat, ImageReader, Limits};
use std::io::Cursor;
use std::sync::atomic::{AtomicUsize, Ordering};

/// TS `DOWNSCALE_MAX_INPUT_PIXELS`.
pub const MAX_INPUT_PIXELS: u64 = 50_000_000;
/// TS `DOWNSCALE_MAX_PENDING`.
pub const MAX_PENDING: usize = 4;
/// TS `STEPS` — (긴 변, JPEG 품질).
const STEPS: [(u32, u8); 4] = [(2000, 82), (1600, 75), (1200, 70), (800, 60)];

static PENDING: AtomicUsize = AtomicUsize::new(0);
static RUN: tokio::sync::Semaphore = tokio::sync::Semaphore::const_new(1);

/// 축소 자리 하나(TS `tryAcquireDownscaleSlot`). 놓으면(drop) 돌려준다.
pub struct Slot(());

impl Drop for Slot {
    fn drop(&mut self) {
        PENDING.fetch_sub(1, Ordering::AcqRel);
    }
}

/// 자리가 없으면 `None` — 호출부는 원본을 읽지 말고 `busy` 로 답한다.
pub fn try_slot() -> Option<Slot> {
    PENDING
        .fetch_update(Ordering::AcqRel, Ordering::Acquire, |n| {
            (n < MAX_PENDING).then_some(n + 1)
        })
        .ok()
        .map(|_| Slot(()))
}

#[derive(Debug)]
pub struct Downscaled {
    pub data: Vec<u8>,
    pub original: (u32, u32),
    pub resized: (u32, u32),
    pub first_frame_only: bool,
}

/// TS `downscaleImage` — 한 번에 하나만 돈다(블로킹 스레드). 실패는 이유 문장으로.
pub async fn downscale(input: Vec<u8>, limit_bytes: usize) -> Result<Downscaled, String> {
    let _run = RUN.acquire().await.map_err(|e| e.to_string())?;
    tokio::task::spawn_blocking(move || downscale_now(&input, limit_bytes))
        .await
        .map_err(|e| format!("could not decode image ({e})"))?
}

/// sharp `metadata().format` 이름.
fn format_name(f: ImageFormat) -> &'static str {
    match f {
        ImageFormat::Png => "png",
        ImageFormat::Jpeg => "jpeg",
        ImageFormat::Gif => "gif",
        ImageFormat::WebP => "webp",
        ImageFormat::Tiff => "tiff",
        ImageFormat::Avif => "heif",
        ImageFormat::Bmp => "bmp",
        ImageFormat::Ico => "ico",
        _ => "unknown",
    }
}

fn one_line(e: impl std::fmt::Display) -> String {
    let s = e.to_string();
    let first = s.lines().next().unwrap_or("");
    first.chars().take(200).collect()
}

fn limits() -> Limits {
    let mut l = Limits::default();
    // RGBA 8비트로 풀었을 때 상한 + 여유(디코더 내부 버퍼).
    l.max_alloc = Some(MAX_INPUT_PIXELS * 4 + 64 * 1024 * 1024);
    l
}

fn animated(format: ImageFormat, input: &[u8]) -> bool {
    match format {
        ImageFormat::Gif => {
            crate::core::raster_probe::probe("image/gif", input).is_some_and(|p| p.pages > 1)
        }
        ImageFormat::WebP => {
            crate::core::raster_probe::probe("image/webp", input).is_some_and(|p| p.pages > 1)
        }
        _ => false,
    }
}

pub fn downscale_now(input: &[u8], limit_bytes: usize) -> Result<Downscaled, String> {
    let reader = ImageReader::new(Cursor::new(input))
        .with_guessed_format()
        .map_err(|e| format!("could not decode image ({})", one_line(e)))?;
    let format = match reader.format() {
        Some(f @ (ImageFormat::Png | ImageFormat::Jpeg | ImageFormat::Gif | ImageFormat::WebP)) => {
            f
        }
        other => {
            return Err(format!(
                "unsupported image format ({}); only png, jpeg, gif and webp are downscaled",
                other.map_or("unknown", format_name)
            ));
        }
    };
    let mut reader = reader;
    reader.limits(limits());
    let mut decoder = reader
        .into_decoder()
        .map_err(|e| format!("could not decode image ({})", one_line(e)))?;
    let (w, h) = decoder.dimensions();
    if w == 0 || h == 0 {
        return Err("could not read image dimensions".into());
    }
    let orientation = decoder
        .orientation()
        .unwrap_or(image::metadata::Orientation::NoTransforms);
    // 방향 5~8 은 가로·세로가 바뀐 채 저장돼 있다 — 보고하는 해상도는 보이는 모양으로.
    use image::metadata::Orientation as O;
    let swapped = matches!(
        orientation,
        O::Rotate90 | O::Rotate270 | O::Rotate90FlipH | O::Rotate270FlipH
    );
    let (width, height) = if swapped { (h, w) } else { (w, h) };
    if u64::from(width) * u64::from(height) > MAX_INPUT_PIXELS {
        return Err(format!(
            "image is {width}x{height}, over the {MAX_INPUT_PIXELS} pixel decode limit"
        ));
    }
    let mut img = DynamicImage::from_decoder(decoder)
        .map_err(|e| format!("could not decode image ({})", one_line(e)))?;
    img.apply_orientation(orientation);
    let rgb = flatten_white(img);
    let first_frame_only = animated(format, input);

    for (edge, quality) in STEPS {
        let resized = if rgb.width() > edge || rgb.height() > edge {
            DynamicImage::ImageRgb8(rgb.clone())
                .resize(edge, edge, image::imageops::FilterType::Lanczos3)
                .to_rgb8()
        } else {
            rgb.clone()
        };
        let mut data = Vec::new();
        image::codecs::jpeg::JpegEncoder::new_with_quality(&mut data, quality)
            .encode_image(&resized)
            .map_err(|e| format!("could not re-encode image ({})", one_line(e)))?;
        if data.len() <= limit_bytes {
            return Ok(Downscaled {
                data,
                original: (width, height),
                resized: (resized.width(), resized.height()),
                first_frame_only,
            });
        }
    }
    Err(format!(
        "still over {limit_bytes}B after downscaling to {}px",
        STEPS[STEPS.len() - 1].0
    ))
}

/// sharp `.flatten({ background: '#ffffff' })` — 알파를 흰 바탕에 섞는다.
fn flatten_white(img: DynamicImage) -> image::RgbImage {
    if !img.color().has_alpha() {
        return img.to_rgb8();
    }
    let rgba = img.to_rgba8();
    let (w, h) = rgba.dimensions();
    let mut out = image::RgbImage::new(w, h);
    for (o, p) in out.pixels_mut().zip(rgba.pixels()) {
        let a = u32::from(p[3]);
        for c in 0..3 {
            o[c] = ((u32::from(p[c]) * a + 255 * (255 - a) + 127) / 255) as u8;
        }
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    fn png(w: u32, h: u32, alpha: bool) -> Vec<u8> {
        let mut out = Vec::new();
        let img = if alpha {
            DynamicImage::ImageRgba8(image::RgbaImage::from_fn(w, h, |x, y| {
                image::Rgba([
                    (x % 251) as u8,
                    (y % 241) as u8,
                    ((x * y) % 239) as u8,
                    (x % 256) as u8,
                ])
            }))
        } else {
            DynamicImage::ImageRgb8(image::RgbImage::from_fn(w, h, |x, y| {
                image::Rgb([(x % 251) as u8, (y % 241) as u8, ((x ^ y) % 239) as u8])
            }))
        };
        img.write_to(&mut Cursor::new(&mut out), ImageFormat::Png)
            .unwrap();
        out
    }

    #[test]
    fn shrinks_inside_longest_edge_to_jpeg() {
        let r = downscale_now(&png(3000, 1500, true), 3 * 1024 * 1024).unwrap();
        assert_eq!(r.original, (3000, 1500));
        assert_eq!(r.resized, (2000, 1000));
        assert!(r.data.starts_with(&[0xff, 0xd8, 0xff]));
        assert!(r.data.len() <= 3 * 1024 * 1024);
        assert!(!r.first_frame_only);
    }

    #[test]
    fn does_not_enlarge_and_steps_down_when_over() {
        let r = downscale_now(&png(300, 200, false), 3 * 1024 * 1024).unwrap();
        assert_eq!(r.resized, (300, 200));
        // 아주 작은 한도 — 마지막 단계까지 가도 넘으면 이유 문장.
        let e = downscale_now(&png(3000, 3000, false), 1000).unwrap_err();
        assert_eq!(e, "still over 1000B after downscaling to 800px");
    }

    #[test]
    fn refuses_unknown_formats_before_decoding() {
        let e = downscale_now(b"II*\0garbage-tiff", 100).unwrap_err();
        assert_eq!(
            e,
            "unsupported image format (tiff); only png, jpeg, gif and webp are downscaled"
        );
        let e = downscale_now(b"not an image at all", 100).unwrap_err();
        assert!(e.starts_with("unsupported image format (unknown)"), "{e}");
    }

    #[test]
    fn slots_cap_pending() {
        let held: Vec<_> = (0..MAX_PENDING).map_while(|_| try_slot()).collect();
        assert_eq!(held.len(), MAX_PENDING);
        assert!(try_slot().is_none());
        drop(held);
        assert!(try_slot().is_some());
    }
}
