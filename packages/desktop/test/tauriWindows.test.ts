import { describe, it, expect } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';

const SRC_TAURI_DIR = path.resolve(__dirname, '../src-tauri');

type Json = unknown;

function readConf(name: string): Json {
  return JSON.parse(fs.readFileSync(path.join(SRC_TAURI_DIR, name), 'utf-8'));
}

/**
 * Tauri 가 플랫폼 설정(`tauri.<os>.conf.json`)을 얹는 방식 — JSON Merge Patch(RFC 7396).
 * 객체는 키별로 합치고, **배열을 포함한 그 밖의 값은 통째로 갈아 끼운다.** 그래서 플랫폼
 * 설정에 `app.windows` 가 있으면 base 의 창 선언은 한 키도 남지 않는다.
 */
function mergePatch(target: Json, patch: Json): Json {
  if (patch === null || typeof patch !== 'object' || Array.isArray(patch)) return patch;
  const base =
    target !== null && typeof target === 'object' && !Array.isArray(target)
      ? { ...(target as Record<string, Json>) }
      : {};
  for (const [k, v] of Object.entries(patch as Record<string, Json>)) {
    if (v === null) delete base[k];
    else base[k] = mergePatch(base[k], v);
  }
  return base;
}

const PLATFORM_CONFS = fs
  .readdirSync(SRC_TAURI_DIR)
  .filter((f) => /^tauri\.[a-z]+\.conf\.json$/.test(f));

describe('tauriWindows', () => {
  // 메인 창은 setup 훅(`app_windows::build_main`)이 직접 세운다. 합친 설정에서 `main` 이
  // `create: false` 가 아니면 Tauri 가 먼저 같은 라벨로 창을 만들고, 훅이
  // "a webview with label `main` already exists" 로 실패해 앱이 기동 즉시 abort 한다.
  it.each(['tauri.conf.json', ...PLATFORM_CONFS])(
    '%s 를 합친 설정에서 main 창은 create: false 다',
    (name) => {
      const base = readConf('tauri.conf.json');
      const merged =
        name === 'tauri.conf.json' ? base : mergePatch(base, readConf(name));
      const windows = (merged as { app: { windows: Record<string, Json>[] } }).app.windows;
      // label 을 빼면 Tauri 기본값이 "main" 이다.
      const main = windows.filter((w) => (w.label ?? 'main') === 'main');
      expect(main).toHaveLength(1);
      expect(main[0].create).toBe(false);
    }
  );
});
