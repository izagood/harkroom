// 화면으로 차례 끝 읽기(2026-10-25, 스레드 db4ab174) — 다섯 하네스 실측 화면(fixture)으로 판정을 고정한다.
// fixture 는 가짜 모델 서버(첫 토큰 전 30초 침묵 → 셸 `sleep 20` → 최종 답)로 띄운 실물 TUI 의 PTY 바이트를 headless
// 터미널(120×40)에 그린 화면이다 — `*-tui-busy.txt` 는 셸이 도는 중, `*-tui-ended.txt` 는 최종 답 뒤. 작업 폴더 경로는 가렸다.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { screenIdleFactsFor } from '../src/adapters/index.js';
import { AGENT_CALL_NO_ANSWER, silentTurnNotice } from '../src/prompt.js';
import { classifyScreen, SCREEN_IDLE_END_MS, ScreenIdleWatch, screenAnswerLines } from '../src/screenIdle.js';

const fx = (name: string): string => readFileSync(join(import.meta.dirname, 'fixtures', name), 'utf8');
/** 화면을 통째로 지우고 그 글을 그리는 바이트. */
const paint = (text: string): string => `\x1b[2J\x1b[H${text.replace(/\n/g, '\r\n')}`;
const HARNESSES = ['codex', 'opencode', 'kilo', 'pi', 'omp'] as const;

describe('표 답을 화면에서 옮긴다(3회차 시험: 14줄 표가 첫 줄만 남았다)', () => {
  const rows = Array.from({ length: 14 }, (_, i) => `  2026-01-01 10:${String(i).padStart(2, '0')}    #${100 + i}    제목 ${i}`);
  const busy = fx('codex-tui-busy.txt');
  const ended = ['총 14건이다.', '', '  머지 시각         PR      제목', '  ─────────  ───────  ──────────', ...rows, '', '  총 14건.', '', '  › Ask Codex to do anything'].join('\n');

  it('표 줄을 빠짐없이 순서대로 집고, 테두리 줄은 뺀다', () => {
    const said = screenAnswerLines(ended, screenIdleFactsFor('codex')!, busy);
    expect(said).toEqual(['총 14건이다.', '머지 시각         PR      제목', ...rows.map((r) => r.trim()), '총 14건.']);
  });

  it('차례 끝 요약 줄(모드 · 모델 · 걸린 시간)은 답이 아니다', () => {
    const facts = screenIdleFactsFor('opencode')!;
    const said = screenAnswerLines(fx('opencode-tui-ended.txt'), facts, fx('opencode-tui-busy.txt'));
    expect(said).toContain('PROBE-FINAL answer text');
    expect(said.join('\n')).not.toContain('lane-model');
  });

  it('대리 글에도 줄이 살아 있다', () => {
    const said = screenAnswerLines(ended, screenIdleFactsFor('codex')!, busy).join('\n');
    const n = silentTurnNotice({ caller: 'human', lastSaid: said, offAnchor: null, pat: 'hrkp_secretpat', screenAnswer: said });
    expect(n.kind).toBe('post');
    const body = (n as { body: string }).body;
    for (const r of rows) expect(body).toContain(`> ${r.trim().replace(/\s+/g, ' ')}\n`);
  });
});

describe('rearm — 재촉을 넣은 뒤', () => {
  it('일하는 중을 다시 본 뒤에야 끝을 말한다', async () => {
    const w = new ScreenIdleWatch(screenIdleFactsFor('codex')!);
    await w.feed(paint(fx('codex-tui-busy.txt')), 0);
    await w.feed(paint(fx('codex-tui-ended.txt')), 10);
    expect(w.ended(10 + SCREEN_IDLE_END_MS)).toBe(true);
    w.rearm();
    expect(w.ended(10_000)).toBe(false);
    await w.feed(paint(fx('codex-tui-busy.txt')), 20_000);
    await w.feed(paint(fx('codex-tui-ended.txt')), 20_010);
    expect(w.ended(20_010 + SCREEN_IDLE_END_MS)).toBe(true);
  });
});

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

  it('잘린 작업 폴더 조각이 든 바닥줄은 답이 아니다(2026-10-30 opencode 대리 게시 「…-<폴더 꼬리> commands」)', () => {
    const facts = screenIdleFactsFor('opencode')!;
    const cwd = '/home/example/.harkroom-agent/00000000-aaaa-4bbb-8ccc-000000000001/workspaces/harkroom-00000000-aaaa-4bbb-8ccc-000000000001-0f0f0f0f';
    // 실측 모양: 모델이 화면에 새로 쓴 것은 없고(일하는 중 화면 그대로), 바닥줄만 폴더 꼬리(잘려서 `/` 가 없다)로 바뀌었다.
    const busy = fx('opencode-tui-busy.txt');
    const ended = busy.replace(/^.*esc interrupt.*$/m, '   aaaa-4bbb-8ccc-000000000001-0f0f0f0f       commands');
    expect(screenAnswerLines(ended, facts, busy, cwd)).toEqual([]);
    // 폴더를 모르면(옛 호출) 그 줄이 답으로 집힌다 — 이 줄이 고침의 이빨이다.
    expect(screenAnswerLines(ended, facts, busy).join(' ')).toContain('0f0f0f0f');
  });

  describe('생각 요약 줄은 답이 아니다(2026-10-31 opencode 대리 게시 「> + Thought: 1.5s」)', () => {
    const facts = screenIdleFactsFor('opencode')!;
    const busy = fx('opencode-tui-busy.txt');
    /** 끝난 화면 = 일하는 중 화면의 일하는 중 바닥줄 자리에 `lines` 를 그린 것(입력창 위 새 줄만 바뀐 실측 모양). */
    const endedWith = (...lines: string[]): string => busy.replace(/^.*esc interrupt.*$/m, lines.map((l) => `     ${l}`).join('\n'));

    it('새 줄이 opencode 의 생각 요약뿐이면 답 줄이 없다 → 「답 없음」 통지로 물러난다', () => {
      for (const line of ['+ Thought: 1.5s', 'Thought: 12s', '+ Thought: 1m 5s', '+ Thought: 350ms', '+ Thinking...', 'Thinking…']) {
        expect(screenAnswerLines(endedWith(line), facts, busy), line).toEqual([]);
      }
      // 호출자(mentionTurn)가 하는 그대로 이어 붙인다 — 빈 답은 null 이고, 에이전트가 부른 턴은 「답 없음」 글이 된다.
      const screenAnswer = screenAnswerLines(endedWith('+ Thought: 1.5s'), facts, busy).join(' ') || null;
      expect(screenAnswer).toBeNull();
      expect(silentTurnNotice({ caller: 'agent', lastSaid: null, offAnchor: null, pat: 'hk_test', screenEnded: true, screenAnswer }))
        .toEqual({ kind: 'post', body: AGENT_CALL_NO_ANSWER });
    });

    it('진짜 답 줄과 생각 요약 줄이 같이 있으면 답 줄만 남는다', () => {
      expect(screenAnswerLines(endedWith('+ Thought: 7.4s', '준비됐습니다.', '+ Thought: 1.9s'), facts, busy)).toEqual(['준비됐습니다.']);
    });

    it('「Thought」 로 시작하는 산문은 지우지 않는다', () => {
      for (const line of ['Thought about it: yes', 'Thinking about the retry path first.', 'Thought: the cache key is stale']) {
        expect(screenAnswerLines(endedWith(line), facts, busy), line).toEqual([line]);
      }
    });
  });

  it('claude 는 화면으로 끝을 읽지 않는다(기록 end_turn 경로 그대로)', () => {
    expect(screenIdleFactsFor('claude-code')).toBeNull();
  });
});
