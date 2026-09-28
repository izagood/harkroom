import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import * as path from 'node:path';
import {
  BASELINE_ZOOM,
  DEFAULT_ZOOM,
  ZOOM_STEPS,
  createZoomer,
  normalizeZoom,
  stepZoom,
  zoomFactor,
} from '../src/lib/zoom';

describe('배율 눈금', () => {
  it('눈금 100% 는 웹뷰 배율 **정확히 1.0** 이다', () => {
    // 이 한 줄이 이 파일의 정본이다. 한때 원점이 90 이어서 기본값 100% 가 배율 1.111 을
    // 걸었고, 그 배율에서 앱 레이아웃이 보이는 높이보다 ~11% 길어져 **입력창이 화면 밖으로
    // 나갔다**(2026-09-10 실측). 화면을 키우는 일은 배율이 아니라 앱의 척도가 한다.
    expect(BASELINE_ZOOM).toBe(100);
    expect(zoomFactor(100)).toBe(1);
  });

  it('기본 상태에서는 배율을 쓰지 않는다 — 부작용을 전원이 안고 가지 않는다', () => {
    expect(DEFAULT_ZOOM).toBe(100);
    expect(zoomFactor(DEFAULT_ZOOM)).toBe(1);
  });

  it('사람이 고른 칸만 1 이 아니다 — 눈금은 그대로 아홉 칸이다', () => {
    expect(zoomFactor(90)).toBeCloseTo(0.9, 5);
    expect(zoomFactor(150)).toBeCloseTo(1.5, 5);
  });

  it('표 밖의 값은 가장 가까운 칸으로 붙는다 — 기본값으로 되돌리지 않는다', () => {
    // 150% 를 쓰던 사람이 표를 고치는 판 하나에 100% 로 떨어지면, 고른 뜻이 사라진다.
    expect(normalizeZoom(148)).toBe(150);
    expect(normalizeZoom(1000)).toBe(200);
    expect(normalizeZoom(1)).toBe(70);
  });

  it('숫자가 아닌 저장본은 기본값이다', () => {
    expect(normalizeZoom(undefined)).toBe(DEFAULT_ZOOM);
    expect(normalizeZoom('120')).toBe(DEFAULT_ZOOM);
    expect(normalizeZoom(NaN)).toBe(DEFAULT_ZOOM);
  });

  it('한 칸씩 옮기고 양 끝에서는 제자리다 — 감싸 돌면 누른 뜻과 정반대가 된다', () => {
    expect(stepZoom(100, 1)).toBe(110);
    expect(stepZoom(100, -1)).toBe(90);
    expect(stepZoom(200, 1)).toBe(200);
    expect(stepZoom(70, -1)).toBe(70);
  });

  it('칸은 오름차순이라 한 칸 옮기기가 화면에서 본 순서와 같다', () => {
    expect([...ZOOM_STEPS]).toEqual([...ZOOM_STEPS].sort((a, b) => a - b));
  });
});

describe('웹뷰에 거는 쪽', () => {
  const internals = () => (globalThis as Record<string, unknown>).__TAURI_INTERNALS__;

  beforeEach(() => {
    delete (globalThis as Record<string, unknown>).__TAURI_INTERNALS__;
  });
  afterEach(() => {
    delete (globalThis as Record<string, unknown>).__TAURI_INTERNALS__;
  });

  it('Tauri 가 없으면 조용히 넘어간다 — 브라우저 dev·테스트가 여기다', async () => {
    await expect(createZoomer().apply(150)).resolves.toBeUndefined();
    expect(internals()).toBeUndefined();
  });

  it('눈금이 아니라 배율을 보낸다', async () => {
    const invoke = vi.fn().mockResolvedValue(undefined);
    (globalThis as Record<string, unknown>).__TAURI_INTERNALS__ = {
      invoke,
      metadata: { currentWindow: { label: 'main' } },
    };
    await createZoomer().apply(180);
    expect(invoke).toHaveBeenCalledWith('plugin:webview|set_webview_zoom', {
      label: 'main',
      // 180 은 표에 없다 — 가장 가까운 175 로 붙은 뒤 배율로 옮겨진다.
      value: zoomFactor(175),
    });
  });

  it('같은 값을 두 번 걸지 않는다 — 스토어 구독이라 무관한 변화에도 깨어난다', async () => {
    const invoke = vi.fn().mockResolvedValue(undefined);
    (globalThis as Record<string, unknown>).__TAURI_INTERNALS__ = { invoke };
    const zoomer = createZoomer();
    await zoomer.apply(125);
    await zoomer.apply(125);
    expect(invoke).toHaveBeenCalledTimes(1);
    await zoomer.apply(150);
    expect(invoke).toHaveBeenCalledTimes(2);
  });

  it('실패하면 다음 변화에서 다시 시도한다 — macOS 10 은 이 커맨드가 없다', async () => {
    const invoke = vi.fn().mockRejectedValue(new Error('unsupported'));
    (globalThis as Record<string, unknown>).__TAURI_INTERNALS__ = { invoke };
    const zoomer = createZoomer();
    await zoomer.apply(125);
    await zoomer.apply(125);
    expect(invoke).toHaveBeenCalledTimes(2);
  });
});

/**
 * 권한이 빠지면 **아무 소리 없이** 배율이 안 걸린다 — `createZoomer` 는 실패를 삼키도록
 * 되어 있고(앱을 막지 않으려고), 그래서 capabilities 에서 이 줄이 사라지는 날 화면은
 * 그냥 "설정이 저장되지 않는" 것처럼 보인다. `invokeCommands.test.ts` 가 커스텀 command
 * 에 세운 것과 같은 회귀선을 플러그인 command 쪽에 세운다.
 */
describe('Tauri 권한', () => {
  it('capabilities 가 배율 권한을 열어 둔다', () => {
    const file = path.resolve(__dirname, '..', 'src-tauri', 'capabilities', 'default.json');
    const capabilities = JSON.parse(readFileSync(file, 'utf8')) as { permissions: string[] };
    expect(capabilities.permissions).toContain('core:webview:allow-set-webview-zoom');
  });
});
