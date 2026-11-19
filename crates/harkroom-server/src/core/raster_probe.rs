//! GIF·WebP·AVIF 의 가로·세로·장 수를 **헤더(컨테이너 구조)만** 읽어 낸다 — TS `sharp(bytes, { animated: true }).metadata()`
//! 의 `width`·`pageHeight`·`pages` 자리. 픽셀(LZW·VP8·AV1)은 풀지 않으므로 디코더를 공격면으로 내주지 않는다.
//!
//! - GIF: 논리 화면 크기를 장 설명자의 `left+width`·`top+height` 최댓값까지 넓힌 크기(`width`·`pageHeight`)와 그림 설명자(`0x2C`) 수(`pages`). 끝 표시(`0x3B`) 전에 잘렸어도 센 장까지 인정한다.
//! - WebP: `VP8X` 캔버스(애니메이션이면 `ANMF` 수가 장 수) · `VP8 `(손실) · `VP8L`(무손실) 머리.
//! - AVIF: `meta` → `pitm`(주 그림) → `iprp/ipma` 로 주 그림에 묶인 `ispe`. 묶음을 못 찾으면 첫 `ispe`.
//!   **장 수는 1로 둔다** — libheif 는 최상위 그림 수를 세지만 아바타·첨부 AVIF 는 사실상 한 장이다(TS 와 다를 수 있는 자리).
//!
//! 구조가 깨졌으면 `None` — 호출부는 sharp 가 헤더를 못 읽은 것과 같게 `not_an_image` 로 답한다.

/// 한 장의 가로·세로와 장 수.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Probe {
    pub width: u64,
    pub height: u64,
    pub pages: u64,
}

pub fn probe(mime: &str, b: &[u8]) -> Option<Probe> {
    match mime {
        "image/gif" => gif(b),
        "image/webp" => webp(b),
        "image/avif" => avif(b),
        _ => None,
    }
}

fn u16le(b: &[u8], at: usize) -> Option<u64> {
    Some(u64::from(u16::from_le_bytes(
        b.get(at..at + 2)?.try_into().ok()?,
    )))
}

fn u24le(b: &[u8], at: usize) -> Option<u64> {
    let s = b.get(at..at + 3)?;
    Some(u64::from(s[0]) | u64::from(s[1]) << 8 | u64::from(s[2]) << 16)
}

fn u32le(b: &[u8], at: usize) -> Option<u64> {
    Some(u64::from(u32::from_le_bytes(
        b.get(at..at + 4)?.try_into().ok()?,
    )))
}

fn u32be(b: &[u8], at: usize) -> Option<u64> {
    Some(u64::from(u32::from_be_bytes(
        b.get(at..at + 4)?.try_into().ok()?,
    )))
}

fn u16be(b: &[u8], at: usize) -> Option<u64> {
    Some(u64::from(u16::from_be_bytes(
        b.get(at..at + 2)?.try_into().ok()?,
    )))
}

// ── GIF ─────────────────────────────────────────────────────────────

/// 하위 블록 줄(길이 바이트 + 내용, 0 으로 끝)을 건너뛴다. 끝을 못 찾으면 `None`.
fn skip_sub_blocks(b: &[u8], mut at: usize) -> Option<usize> {
    loop {
        let n = *b.get(at)? as usize;
        at += 1;
        if n == 0 {
            return Some(at);
        }
        at += n;
    }
}

fn gif(b: &[u8]) -> Option<Probe> {
    if !(b.starts_with(b"GIF87a") || b.starts_with(b"GIF89a")) {
        return None;
    }
    let mut width = u16le(b, 6)?;
    let mut height = u16le(b, 8)?;
    let packed = *b.get(10)?;
    let mut at = 13;
    if packed & 0x80 != 0 {
        at += 3 * (1usize << ((packed & 0x07) + 1));
    }
    let mut pages = 0u64;
    loop {
        match b.get(at).copied() {
            // 확장(그래픽 제어·주석·응용) — 라벨 뒤 하위 블록.
            Some(0x21) => match b.get(at + 2..).and(skip_sub_blocks(b, at + 2)) {
                Some(next) => at = next,
                None => break,
            },
            Some(0x2C) => {
                // 장이 화면 밖으로 나가면 디코더(libnsgif)는 화면을 키운다 — 장의 오른쪽·아래 끝까지 넓혀 잰다.
                // sharp 는 첫 장만 반영하지만 여기서는 모든 장의 최댓값을 쓴다(더 엄격한 쪽).
                width = width.max(u16le(b, at + 1)? + u16le(b, at + 5)?);
                height = height.max(u16le(b, at + 3)? + u16le(b, at + 7)?);
                let local = *b.get(at + 9)?;
                let mut p = at + 10;
                if local & 0x80 != 0 {
                    p += 3 * (1usize << ((local & 0x07) + 1));
                }
                // LZW 최소 코드 크기 한 바이트 뒤 하위 블록.
                pages += 1;
                match b.get(p).and(skip_sub_blocks(b, p + 1)) {
                    Some(next) => at = next,
                    None => break,
                }
            }
            // 끝 표시이거나 잘렸다 — 센 장까지.
            _ => break,
        }
    }
    (pages > 0).then_some(Probe {
        width,
        height,
        pages,
    })
}

// ── WebP ────────────────────────────────────────────────────────────

fn webp(b: &[u8]) -> Option<Probe> {
    if b.get(0..4)? != b"RIFF" || b.get(8..12)? != b"WEBP" {
        return None;
    }
    let mut at = 12;
    let mut canvas: Option<(u64, u64, bool)> = None;
    let mut frames = 0u64;
    while let (Some(tag), Some(len)) = (b.get(at..at + 4), u32le(b, at + 4)) {
        let data = at + 8;
        let len = len as usize;
        match tag {
            b"VP8X" => {
                let flags = *b.get(data)?;
                let w = u24le(b, data + 4)? + 1;
                let h = u24le(b, data + 7)? + 1;
                canvas = Some((w, h, flags & 0x02 != 0));
            }
            b"ANMF" => frames += 1,
            b"VP8 " if canvas.is_none() => {
                if b.get(data + 3..data + 6)? != [0x9d, 0x01, 0x2a] {
                    return None;
                }
                let w = u16le(b, data + 6)? & 0x3fff;
                let h = u16le(b, data + 8)? & 0x3fff;
                return Some(Probe {
                    width: w,
                    height: h,
                    pages: 1,
                });
            }
            b"VP8L" if canvas.is_none() => {
                if *b.get(data)? != 0x2f {
                    return None;
                }
                let bits = u32le(b, data + 1)?;
                return Some(Probe {
                    width: (bits & 0x3fff) + 1,
                    height: ((bits >> 14) & 0x3fff) + 1,
                    pages: 1,
                });
            }
            _ => {}
        }
        at = data.checked_add(len + (len & 1))?;
    }
    let (width, height, animated) = canvas?;
    Some(Probe {
        width,
        height,
        pages: if animated { frames.max(1) } else { 1 },
    })
}

// ── AVIF (ISOBMFF) ──────────────────────────────────────────────────

/// `[start, end)` 안의 상자들 — (형, 내용 시작, 상자 끝). 하나씩 읽어 찾으면 거기서 멈춘다.
fn boxes(b: &[u8], start: usize, end: usize) -> impl Iterator<Item = ([u8; 4], usize, usize)> + '_ {
    let mut at = start;
    std::iter::from_fn(move || {
        if at + 8 > end {
            return None;
        }
        let size = u32be(b, at)?;
        let kind: [u8; 4] = b.get(at + 4..at + 8)?.try_into().ok()?;
        let (head, size) = match size {
            0 => (8, (end - at) as u64),
            1 => (
                16,
                u64::from_be_bytes(b.get(at + 8..at + 16)?.try_into().ok()?),
            ),
            n => (8, n),
        };
        let box_end = usize::try_from(size).ok().and_then(|s| at.checked_add(s))?;
        if size < head as u64 || box_end > end {
            return None;
        }
        let item = (kind, at + head, box_end);
        at = box_end;
        Some(item)
    })
}

fn find(
    mut list: impl Iterator<Item = ([u8; 4], usize, usize)>,
    kind: &[u8; 4],
) -> Option<(usize, usize)> {
    list.find(|x| &x.0 == kind).map(|x| (x.1, x.2))
}

fn avif(b: &[u8]) -> Option<Probe> {
    let (fs, _) = find(boxes(b, 0, b.len()), b"ftyp")?;
    if !matches!(b.get(fs..fs + 4)?, b"avif" | b"avis") {
        return None;
    }
    // `meta` 는 FullBox — 판·깃발 4바이트 뒤가 자식이다.
    let (ms, me) = find(boxes(b, 0, b.len()), b"meta")?;
    let meta = || boxes(b, ms + 4, me);
    let primary = find(meta(), b"pitm").and_then(|(s, _)| match b.get(s)? {
        0 => u16be(b, s + 4),
        _ => u32be(b, s + 4),
    });
    let (ps, pe) = find(meta(), b"iprp")?;
    let iprp = || boxes(b, ps, pe);
    let (cs, ce) = find(iprp(), b"ipco")?;
    // 속성은 번호로 가리키므로 ipco 자식만 모은다.
    let props: Vec<_> = boxes(b, cs, ce).collect();
    let ispe = |i: usize| -> Option<(u64, u64)> {
        let (kind, s, _) = props.get(i)?;
        (kind == b"ispe").then_some(())?;
        Some((u32be(b, s + 4)?, u32be(b, s + 8)?))
    };
    let chosen = primary
        .zip(find(iprp(), b"ipma"))
        // 상자 끝에서 잘라 넘긴다 — 다음 상자를 ipma 로 읽지 않게.
        .and_then(|(item, (s, e))| ipma_props(&b[..e], s, item))
        .and_then(|idx| idx.into_iter().find_map(&ispe));
    let (width, height) = chosen.or_else(|| (0..props.len()).find_map(&ispe))?;
    Some(Probe {
        width,
        height,
        pages: 1,
    })
}

/// `ipma` 에서 `item` 에 묶인 속성 번호들(0 부터).
fn ipma_props(b: &[u8], s: usize, item: u64) -> Option<Vec<usize>> {
    let version = *b.get(s)?;
    let flags = u24be(b, s + 1)?;
    let count = u32be(b, s + 4)?;
    let mut at = s + 8;
    for _ in 0..count {
        let id = if version < 1 {
            let v = u16be(b, at)?;
            at += 2;
            v
        } else {
            let v = u32be(b, at)?;
            at += 4;
            v
        };
        let n = *b.get(at)? as usize;
        at += 1;
        let mut idx = Vec::with_capacity(n);
        for _ in 0..n {
            let raw = if flags & 1 != 0 {
                let v = u16be(b, at)?;
                at += 2;
                v & 0x7fff
            } else {
                let v = u64::from(*b.get(at)?);
                at += 1;
                v & 0x7f
            };
            if raw > 0 {
                idx.push(raw as usize - 1);
            }
        }
        if id == item {
            return Some(idx);
        }
    }
    None
}

fn u24be(b: &[u8], at: usize) -> Option<u64> {
    let s = b.get(at..at + 3)?;
    Some(u64::from(s[0]) << 16 | u64::from(s[1]) << 8 | u64::from(s[2]))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn gif_bytes(w: u16, h: u16, frames: usize, trailer: bool) -> Vec<u8> {
        let mut v = b"GIF89a".to_vec();
        v.extend(w.to_le_bytes());
        v.extend(h.to_le_bytes());
        v.extend([0x80, 0, 0]); // 전역 색표 2색
        v.extend([0; 6]);
        v.extend([0x21, 0xFF, 3, b'a', b'b', b'c', 0]); // 응용 확장
        for _ in 0..frames {
            v.extend([0x21, 0xF9, 4, 0, 0, 0, 0, 0]);
            v.push(0x2C);
            v.extend([0, 0, 0, 0]);
            v.extend(w.to_le_bytes());
            v.extend(h.to_le_bytes());
            v.push(0);
            v.extend([2, 2, 0x4C, 0x01, 0]);
        }
        if trailer {
            v.push(0x3B);
        }
        v
    }

    #[test]
    fn gif_counts_frames() {
        assert_eq!(
            probe("image/gif", &gif_bytes(10, 20, 3, true)),
            Some(Probe {
                width: 10,
                height: 20,
                pages: 3
            })
        );
        // 끝 표시가 없어도 센 장까지.
        assert_eq!(
            probe("image/gif", &gif_bytes(10, 20, 2, false)).map(|p| p.pages),
            Some(2)
        );
        // 장이 화면 밖으로 나가면 화면을 넓혀 잰다(libnsgif 와 같게, 모든 장의 최댓값).
        let mut wide = gif_bytes(1, 1, 1, true);
        let d = wide.iter().position(|&x| x == 0x2C).unwrap();
        wide[d + 1..d + 9].copy_from_slice(&[0x88, 0x13, 0x88, 0x13, 10, 0, 10, 0]);
        assert_eq!(
            probe("image/gif", &wide).map(|p| (p.width, p.height)),
            Some((5010, 5010))
        );
        // 장이 하나도 없으면 깨진 파일.
        assert_eq!(probe("image/gif", &gif_bytes(10, 20, 0, true)), None);
        assert_eq!(probe("image/gif", b"GIF89a"), None);
    }

    fn riff(chunks: &[(&[u8; 4], Vec<u8>)]) -> Vec<u8> {
        let mut body = b"WEBP".to_vec();
        for (tag, data) in chunks {
            body.extend(*tag);
            body.extend((data.len() as u32).to_le_bytes());
            body.extend(data);
            if data.len() % 2 == 1 {
                body.push(0);
            }
        }
        let mut v = b"RIFF".to_vec();
        v.extend((body.len() as u32).to_le_bytes());
        v.extend(body);
        v
    }

    #[test]
    fn webp_variants() {
        let mut vp8 = vec![0, 0, 0, 0x9d, 0x01, 0x2a];
        vp8.extend(640u16.to_le_bytes());
        vp8.extend(480u16.to_le_bytes());
        assert_eq!(
            probe("image/webp", &riff(&[(b"VP8 ", vp8)])),
            Some(Probe {
                width: 640,
                height: 480,
                pages: 1
            })
        );
        let bits: u32 = 99 | (49 << 14);
        let mut vp8l = vec![0x2f];
        vp8l.extend(bits.to_le_bytes());
        assert_eq!(
            probe("image/webp", &riff(&[(b"VP8L", vp8l)])),
            Some(Probe {
                width: 100,
                height: 50,
                pages: 1
            })
        );
        let vp8x = |flags: u8| vec![flags, 0, 0, 0, 199, 0, 0, 99, 0, 0];
        let anim = riff(&[
            (b"VP8X", vp8x(0x02)),
            (b"ANIM", vec![0; 6]),
            (b"ANMF", vec![0; 16]),
            (b"ANMF", vec![0; 16]),
        ]);
        assert_eq!(
            probe("image/webp", &anim),
            Some(Probe {
                width: 200,
                height: 100,
                pages: 2
            })
        );
        let still = riff(&[(b"VP8X", vp8x(0x10))]);
        assert_eq!(probe("image/webp", &still).map(|p| p.pages), Some(1));
        assert_eq!(probe("image/webp", b"RIFF\0\0\0\0WEBP"), None);
    }

    fn bx(kind: &[u8; 4], body: &[u8]) -> Vec<u8> {
        let mut v = ((body.len() + 8) as u32).to_be_bytes().to_vec();
        v.extend(kind);
        v.extend(body);
        v
    }

    fn ispe(w: u32, h: u32) -> Vec<u8> {
        let mut b = vec![0; 4];
        b.extend(w.to_be_bytes());
        b.extend(h.to_be_bytes());
        bx(b"ispe", &b)
    }

    #[test]
    fn avif_primary_ispe() {
        // 속성 1 = 작은 ispe(알파 등), 속성 2 = 주 그림 ispe. 주 그림(item 1)은 2 에 묶인다.
        let ipco = bx(b"ipco", &[ispe(64, 64), ispe(1920, 1080)].concat());
        let ipma = bx(
            b"ipma",
            &[
                vec![0, 0, 0, 0, 0, 0, 0, 2],
                vec![0, 2, 1, 0x81],
                vec![0, 1, 1, 0x82],
            ]
            .concat(),
        );
        let iprp = bx(b"iprp", &[ipco, ipma].concat());
        let pitm = bx(b"pitm", &[0, 0, 0, 0, 0, 1]);
        let meta = bx(b"meta", &[vec![0; 4], pitm, iprp].concat());
        let ftyp = bx(b"ftyp", b"avif\0\0\0\0mif1");
        let file = [ftyp.clone(), meta.clone()].concat();
        assert_eq!(
            probe("image/avif", &file),
            Some(Probe {
                width: 1920,
                height: 1080,
                pages: 1
            })
        );
        // 묶음이 없으면 첫 ispe.
        let bare = [
            ftyp,
            bx(
                b"meta",
                &[vec![0; 4], bx(b"iprp", &bx(b"ipco", &ispe(5, 6)))].concat(),
            ),
        ]
        .concat();
        assert_eq!(
            probe("image/avif", &bare),
            Some(Probe {
                width: 5,
                height: 6,
                pages: 1
            })
        );
        assert_eq!(probe("image/avif", &bx(b"ftyp", b"heic")), None);
    }
}
