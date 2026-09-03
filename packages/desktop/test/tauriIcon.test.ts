import { describe, it, expect } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';

const SRC_TAURI_DIR = path.resolve(__dirname, '../src-tauri');
const TAURI_CONF_PATH = path.join(SRC_TAURI_DIR, 'tauri.conf.json');
const ICONS_DIR = path.join(SRC_TAURI_DIR, 'icons');

describe('tauriIcon', () => {
  it('bundle.icon이 비어 있지 않은 배열이다', () => {
    const tauriConf = JSON.parse(fs.readFileSync(TAURI_CONF_PATH, 'utf-8'));
    expect(tauriConf.bundle).toBeDefined();
    expect(tauriConf.bundle.icon).toBeDefined();
    expect(Array.isArray(tauriConf.bundle.icon)).toBe(true);
    expect(tauriConf.bundle.icon.length).toBeGreaterThan(0);
  });

  it('bundle.icon에 명시된 파일이 실제로 존재한다', () => {
    const tauriConf = JSON.parse(fs.readFileSync(TAURI_CONF_PATH, 'utf-8'));
    const iconPaths = tauriConf.bundle.icon;

    for (const iconPath of iconPaths) {
      const fullPath = path.join(SRC_TAURI_DIR, iconPath);
      expect(fs.existsSync(fullPath), `${iconPath} 파일이 존재해야 한다`).toBe(true);
    }
  });

  it('파일들이 자리표시자가 아니다 - 주요 파일 1KB 이상이고 icon.icns가 포함된다', () => {
    const tauriConf = JSON.parse(fs.readFileSync(TAURI_CONF_PATH, 'utf-8'));
    const iconPaths = tauriConf.bundle.icon;

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

  it('source.svg가 존재하고 viewBox가 정사각이다', () => {
    const sourceSvgPath = path.join(ICONS_DIR, 'source.svg');
    expect(fs.existsSync(sourceSvgPath), 'source.svg가 존재해야 한다').toBe(true);

    const svgContent = fs.readFileSync(sourceSvgPath, 'utf-8');
    const viewBoxMatch = svgContent.match(/viewBox="(\d+)\s+(\d+)\s+(\d+)\s+(\d+)"/);
    expect(viewBoxMatch, 'viewBox 속성이 있어야 한다').not.toBeNull();

    const [, , , width, height] = viewBoxMatch!.map(Number);
    expect(width, 'viewBox 너비가 정사각이어야 한다').toBe(height);
  });
});