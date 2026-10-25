// 화면으로 차례 끝 읽기(2026-10-25, 스레드 db4ab174) — 다섯 하네스 실측 화면(fixture)으로 판정을 고정한다.
// fixture 는 가짜 모델 서버(첫 토큰 전 30초 침묵 → 셸 `sleep 20` → 최종 답)로 띄운 실물 TUI 의 PTY 바이트를 headless
// 터미널(120×40)에 그린 화면이다 — `*-tui-busy.txt` 는 셸이 도는 중, `*-tui-ended.txt` 는 최종 답 뒤. 작업 폴더 경로는 가렸다.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { screenIdleFactsFor } from '../src/adapters/index.js';
import { classifyScreen, SCREEN_IDLE_END_MS, ScreenIdleWatch, screenAnswerLines } from '../src/screenIdle.js';

const fx = (name: string): string => readFileSync(join(import.meta.dirname, 'fixtures', name), 'utf8');
/** 화면을 통째로 지우고 그 글을 그리는 바이트. */
const paint = (text: string): string => `\x1b[2J\x1b[H${text.replace(/\n/g, '\r\n')}`;
const HARNESSES = ['codex', 'opencode', 'kilo', 'pi', 'omp'] as const;

describe('screen.busy — 실측 화면', () => {
  for (const h of HARNESSES) {
    it(`${h}: 일하는 중 화면은 busy, 끝난 화면은 idle`, () => {
      const facts = screenIdleFactsFor(h)!;
      expect(facts).not.toBeNull();
      expect(classifyScreen(fx(`${h}-tui-busy.txt`), facts)).toBe('busy');
      expect(classifyScreen(fx(`${h}-tui-ended.txt`), facts)).toBe('idle');
    });

    it(`${h}: 끝난 화면에서 모델의 답 줄을 뽑고, 작업 폴더 경로 줄은 안 뽑는다`, () => {
      const facts = screenIdleFactsFor(h)!;
      const said = screenAnswerLines(fx(`${h}-tui-ended.txt`), facts, fx(`${h}-tui-busy.txt`)).join(' ');
      expect(said).toContain('PROBE-FINAL');
      expect(said).not.toContain('/tmp/ws');
    });

    it(`${h}: 일한 뒤 idle 이 ${SCREEN_IDLE_END_MS}ms 이어져야 끝이다`, async () => {
      const w = new ScreenIdleWatch(screenIdleFactsFor(h)!);
      // 프롬프트 전 첫 화면도 idle 꼴이다 — 일하는 중을 한 번도 안 봤으면 끝이 아니다.
      await w.feed(paint(fx(`${h}-tui-ended.txt`)), 0);
      expect(w.ended(60_000)).toBe(false);
      await w.feed(paint(fx(`${h}-tui-busy.txt`)), 1_000);
      expect(w.ended(60_000)).toBe(false);
      await w.feed(paint(fx(`${h}-tui-ended.txt`)), 2_000);
      expect(w.ended(2_000 + SCREEN_IDLE_END_MS - 1)).toBe(false);
      expect(w.ended(2_000 + SCREEN_IDLE_END_MS)).toBe(true);
    });
  }

  it('한 프레임 꺼짐(omp 도구 끝)은 끝이 아니다 — 다시 busy 가 오면 시계가 처음부터', async () => {
    const w = new ScreenIdleWatch(screenIdleFactsFor('omp')!);
    await w.feed(paint(fx('omp-tui-busy.txt')), 0);
    await w.feed(paint(fx('omp-tui-ended.txt')), 1_000);
    await w.feed(paint(fx('omp-tui-busy.txt')), 1_000);
    expect(w.ended(1_000 + SCREEN_IDLE_END_MS * 10)).toBe(false);
  });

  it('claude 는 화면으로 끝을 읽지 않는다(기록 end_turn 경로 그대로)', () => {
    expect(screenIdleFactsFor('claude-code')).toBeNull();
  });
});
