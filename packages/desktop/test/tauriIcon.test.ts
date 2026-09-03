import { describe, it, expect } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';

const SRC_TAURI_DIR = path.resolve(__dirname, '../src-tauri');
const TAURI_CONF_PATH = path.join(SRC_TAURI_DIR, 'tauri.conf.json');
const ICONS_DIR = path.join(SRC_TAURI_DIR, 'icons');

function readTauriConf(): { bundle?: { icon?: string[] } } {
  return JSON.parse(fs.readFileSync(TAURI_CONF_PATH, 'utf-8'));
}

/**
 * PNG 헤더(IHDR)에서 실제 픽셀 크기를 읽는다.
 *
 * 파일 크기(바이트)만 재면 "1KB 넘는 아무 PNG"도 통과한다. 아이콘에서 중요한 건
 * 실제 해상도라서 헤더를 직접 뜯는다. PNG 는 8바이트 시그니처 뒤에 곧바로 IHDR
 * 청크가 오고(길이 4 + 타입 4), 그 안 첫 8바이트가 너비·높이(빅엔디언 u32)다.
 */
function readPngSize(filePath: string): { width: number; height: number } {
  const buf = fs.readFileSync(filePath);
  const signature = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  expect(
    buf.subarray(0, 8).equals(signature),
    `${path.basename(filePath)} 이(가) PNG 시그니처로 시작해야 한다`
  ).toBe(true);
  expect(
    buf.subarray(12, 16).toString('ascii'),
    `${path.basename(filePath)} 의 첫 청크가 IHDR 이어야 한다`
  ).toBe('IHDR');
  return { width: buf.readUInt32BE(16), height: buf.readUInt32BE(20) };
}

describe('tauriIcon', () => {
  it('bundle.icon이 비어 있지 않은 배열이다', () => {
    const tauriConf = readTauriConf();
    expect(tauriConf.bundle).toBeDefined();
    expect(tauriConf.bundle!.icon).toBeDefined();
    expect(Array.isArray(tauriConf.bundle!.icon)).toBe(true);
    expect(tauriConf.bundle!.icon!.length).toBeGreaterThan(0);
  });

  it('bundle.icon에 명시된 파일이 실제로 존재한다', () => {
    const iconPaths = readTauriConf().bundle!.icon!;

    for (const iconPath of iconPaths) {
      const fullPath = path.join(SRC_TAURI_DIR, iconPath);
      expect(fs.existsSync(fullPath), `${iconPath} 파일이 존재해야 한다`).toBe(true);
    }
  });

  it('파일들이 자리표시자가 아니다 - 주요 파일 1KB 이상이고 icon.icns가 포함된다', () => {
    const iconPaths = readTauriConf().bundle!.icon!;

    const hasIcns = iconPaths.some((p: string) => p.includes('icon.icns'));
    expect(hasIcns, 'icon.icns가 포함되어야 한다').toBe(true);

    const largeIconPaths = iconPaths.filter(
      (p: string) => p.includes('icon.') || p.includes('128x128')
    );
    for (const iconPath of largeIconPaths) {
      const fullPath = path.join(SRC_TAURI_DIR, iconPath);
      const stats = fs.statSync(fullPath);
      expect(stats.size, `${iconPath} 크기가 1KB 이상이어야 한다`).toBeGreaterThan(1024);
    }
  });

  // bundle.icon 의 PNG 는 파일명이 크기를 약속한다. 바이트 수만 보면 엉뚱한 그림을
  // 그 이름으로 복사해 넣어도 통과하므로 헤더의 실제 해상도까지 확인한다.
  it('bundle.icon의 PNG가 파일명이 약속한 해상도를 실제로 갖는다', () => {
    const iconPaths = readTauriConf().bundle!.icon!;
    const pngPaths = iconPaths.filter((p: string) => p.endsWith('.png'));
    expect(pngPaths.length, 'bundle.icon 에 PNG 가 하나는 있어야 한다').toBeGreaterThan(0);

    for (const iconPath of pngPaths) {
      const name = path.basename(iconPath, '.png');
      // "128x128" 또는 "128x128@2x" 형태에서 기본 변을 뽑고 @2x 배율을 반영한다.
      const nameMatch = name.match(/^(\d+)x(\d+)(?:@(\d+)x)?$/);
      if (!nameMatch) continue;
      const scale = nameMatch[3] ? Number(nameMatch[3]) : 1;
      const expected = { width: Number(nameMatch[1]) * scale, height: Number(nameMatch[2]) * scale };
      expect(readPngSize(path.join(SRC_TAURI_DIR, iconPath)), `${iconPath} 해상도`).toEqual(expected);
    }
  });

  // icon.png 는 tauri icon 이 만드는 512px 마스터다. bundle.icon 에는 들어가지
  // 않지만(Tauri 기본 배열을 그대로 둔다) icns·ico 가 여기서 파생되므로, 이 파일이
  // 자리표시자로 남아 있으면 아이콘 세트 전체가 낡았다는 뜻이다.
  it('icon.png 마스터가 512x512 실물이다', () => {
    const masterPath = path.join(ICONS_DIR, 'icon.png');
    expect(fs.existsSync(masterPath), 'icons/icon.png 이 존재해야 한다').toBe(true);
    expect(fs.statSync(masterPath).size, 'icon.png 이 자리표시자가 아니어야 한다').toBeGreaterThan(
      1024
    );
    expect(readPngSize(masterPath)).toEqual({ width: 512, height: 512 });
  });

  it('생성물에 android/ ios/ 가 섞여 있지 않다', () => {
    // tauri icon 은 모바일 아이콘까지 만든다. 이 저장소는 데스크탑만 배포하므로
    // 생성 뒤 지워야 하고, 지우는 걸 잊은 채 커밋되는 걸 막는다.
    for (const dir of ['android', 'ios']) {
      expect(fs.existsSync(path.join(ICONS_DIR, dir)), `icons/${dir} 는 없어야 한다`).toBe(false);
    }
  });

  it('source.svg가 존재하고 viewBox가 정사각이다', () => {
    const sourceSvgPath = path.join(ICONS_DIR, 'source.svg');
    expect(fs.existsSync(sourceSvgPath), 'source.svg가 존재해야 한다').toBe(true);

    const svgContent = fs.readFileSync(sourceSvgPath, 'utf-8');
    const viewBoxMatch = svgContent.match(/viewBox="(\d+)\s+(\d+)\s+(\d+)\s+(\d+)"/);
    expect(viewBoxMatch, 'viewBox 속성이 있어야 한다').not.toBeNull();

    const [, , , width, height] = viewBoxMatch!.map(Number);
    expect(width, 'viewBox 너비가 정사각이어야 한다').toBe(height);
  });

  // 캔버스는 정사각이고 글리프도 정사각 뷰박스라, 중앙에 놓였다는 건 곧
  // translate 의 x 와 y 가 같다는 뜻이다. 한쪽만 틀리면 Dock 에서 로고가
  // 위나 아래로 치우쳐 보이는데 눈으로만 잡기 쉬운 결함이라 수치로 못 박는다.
  it('source.svg의 글리프가 캔버스 정중앙에 있다', () => {
    const svgContent = fs.readFileSync(path.join(ICONS_DIR, 'source.svg'), 'utf-8');

    const transformMatch = svgContent.match(
      /transform="translate\(\s*([\d.]+)\s*,\s*([\d.]+)\s*\)\s*scale\(\s*([\d.]+)\s*\)"/
    );
    expect(transformMatch, '글리프 그룹에 translate+scale transform 이 있어야 한다').not.toBeNull();
    const [translateX, translateY, scale] = transformMatch!.slice(1).map(Number) as [
      number,
      number,
      number,
    ];

    const viewBox = Number(svgContent.match(/viewBox="0\s+0\s+(\d+)\s+\d+"/)![1]);
    // logo.svg 의 뷰박스는 128 이고 이 파일은 그걸 scale 배로 키워 얹는다.
    const glyphSize = 128 * scale;
    const centeredOffset = (viewBox - glyphSize) / 2;

    expect(translateY, '글리프가 수직 중앙에 놓여야 한다').toBeCloseTo(centeredOffset, 5);
    expect(translateX, '글리프가 수평 중앙에 놓여야 한다').toBeCloseTo(centeredOffset, 5);
  });

  // 획이 currentColor 라서 color 를 적지 않으면 래스터라이저 기본값(순수 검정)으로
  // 굳는다. 브랜드 잉크색을 잃지 않도록 source.svg 가 색을 못 박게 강제한다.
  it('source.svg가 currentColor용 color를 못 박아 둔다', () => {
    const svgContent = fs.readFileSync(path.join(ICONS_DIR, 'source.svg'), 'utf-8');
    expect(svgContent, '획이 currentColor 를 쓰는지').toContain('stroke="currentColor"');

    const svgTag = svgContent.match(/<svg\b[^>]*>/)![0];
    expect(svgTag, '루트 svg 에 color 속성이 있어야 한다').toMatch(/\bcolor="#[0-9A-Fa-f]{6}"/);
  });
});
