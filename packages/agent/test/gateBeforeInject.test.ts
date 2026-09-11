// **모르는 화면에는 아무것도 치지 않는다** — 주입 직전 관문 재확인(2026-09-11).
//
// ## 이 파일이 고정하는 사고
//
// codex 를 TUI 로 올린 뒤(#774) 첫 실물 테스트에서 러너가 프롬프트를 못 넣었다. 화면을
// 찍어 보니 codex 가 부팅 직후 **업데이트 선택 화면**을 띄웠고, 우리는 0.2초에 본
// `Ask … to do anything`(모달이 덮기 **전**의 자리표시자)을 근거로 붙여넣고 `\r` 를 쳤다.
// 그 Enter 가 기본 선택지 **"Update now (runs `curl … | sh`)"** 를 눌러 설치를 실행했다
// (codex-cli 0.153.0 → 0.154.0). 프롬프트는 끝내 제출되지 않았다.
//
// 두 결함이 겹쳤다:
//   1. 관문 패턴이 `❯` 만 알고 codex 의 `›` 를 몰랐다 → 그 화면이 관문으로 안 보였다
//   2. 판정 시점이 **준비를 본 때**였고 **쓰기 직전**이 아니었다 → 그 사이에 모달이 떴다
//
// ## fixture 에 대해
//
// `codex-tui-update-prompt.txt` 는 다른 fixture 들과 달리 **원시 PTY 캡처가 아니라 그때
// 찍힌 화면을 옮겨 적은 것**이다(캡처 원본을 남기지 못했다). 사고의 성질을 그대로 갖도록
// 순서를 지켰다 — 준비 자리표시자가 **먼저** 오고 모달이 그 뒤를 덮는다. 그 순서가 곧
// "준비를 봤다고 넣으면 안 되는" 이유다.
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

import { looksLikeGate, looksReadyForPrompt, runPtyTurn } from '../src/pty.js';

/** 가짜 하네스. `pty.test.ts` 가 쓰는 것과 같은 파일이다. */
const fake = new URL('./helpers/fake-harness.mjs', import.meta.url).pathname;

const screen = (name: string) => readFileSync(new URL(`./fixtures/${name}`, import.meta.url), 'utf8');

describe('codex 업데이트 선택 화면', () => {
  const update = screen('codex-tui-update-prompt.txt');

  it('관문으로 보인다 — `›` 와 "Press enter to continue" 를 읽는다', () => {
    // 고치기 전에는 거짓이었다. `❯` 만 보던 패턴이 codex 의 `›` 를 못 읽었다.
    expect(looksLikeGate(update)).toBe(true);
  });

  it('준비 표시가 **앞서** 있어도 관문이 이긴다 — 마지막에 그려진 쪽이 지금 화면이다', () => {
    // 이것이 사고의 핵심이다: 준비 판정만 보면 참이다(자리표시자가 화면에 남아 있다).
    expect(looksReadyForPrompt(update)).toBe(true);
    // 그런데 그 뒤에 모달이 덮였으므로 **지금 화면은 물음**이고, 거기에 쓰면 안 된다.
    expect(looksLikeGate(update)).toBe(true);
  });

  it('정상 입력창은 관문이 아니다 — 그물이 너무 넓으면 모든 턴이 사람을 부른다', () => {
    for (const name of ['codex-tui-ready.txt', 'claude-tui-ready-real.txt']) {
      expect(looksLikeGate(screen(name))).toBe(false);
    }
  });

  it('claude 의 관문들은 그대로 잡힌다 — 넓힌 패턴이 기존 판정을 안 깬다', () => {
    for (const name of ['claude-tui-trust-modal.txt', 'claude-tui-login-menu.txt']) {
      // 이 둘은 준비로도 안 보여야 한다(기존 회귀선과 같은 사실).
      expect(looksReadyForPrompt(screen(name))).toBe(false);
    }
  });
});

// ── 여기부터는 **행동**이다. 위 정규식 테스트는 필요조건일 뿐이고, 정작 지켜야 하는 것은
// "그 화면에 아무것도 쓰지 않았다" 이다 — 사고의 피해가 바로 그 쓰기에서 났다.
describe('관문이 덮인 화면에는 쓰지 않는다 (PTY 행동)', () => {
  const gatePlan = () =>
    ({ command: process.execPath, args: [fake], env: { FAKE_MODE: 'gate-covers-ready' }, stdinFile: null });

  it('부를 사람이 있으면 — 붙여넣지 않고 부르며, PTY 는 살려 둔다', async () => {
    const chunks: Buffer[] = [];
    const called: { kind: string; screen: string }[] = [];

    // **거절하지 않는 것이 옳다.** 사람을 부를 수 있으면 화면을 살려 둬야 그 사람이 관문을
    // 지날 수 있다 — 여기서 죽이면 부른 의미가 없다(`readyTimer` 의 기존 규율).
    // 그래서 이 턴은 가짜 하네스의 안전망(8초, 종료 코드 22)으로 끝난다.
    const result = await runPtyTurn(gatePlan(), {
      cwd: process.cwd(),
      timeoutMs: 20_000,
      onData: (c) => chunks.push(c),
      injectPrompt: {
        text: 'NEVER_SEND_THIS',
        readyTimeoutMs: 1_000,
        readyQuietMs: 400,
        onAttention: (screen, kind) => called.push({ kind, screen }),
      },
    });

    const seen = Buffer.concat(chunks).toString('utf8');
    // **핵심 단언**: 붙여넣기가 나가지 않았다. PTY 는 쓴 것을 에코하므로(같은 방법으로
    // `pty.test.ts` 의 `ready-then-echo` 가 '있음'을 잰다), 없다는 것은 안 썼다는 뜻이다.
    expect(seen).not.toContain('[200~');
    expect(seen).not.toContain('NEVER_SEND_THIS');
    // 그리고 사람을 불렀다 — 부팅 관문이므로 계정 단위('startup')다.
    expect(called.some((c) => c.kind === 'startup')).toBe(true);
    expect(result.exitCode).toBe(22);
  }, 20_000);

  it('부를 사람이 없으면 — 상한에서 실패로 접는다 (조용히 서 있지 않는다)', async () => {
    // `onAttention` 이 없으면 기다려 봐야 아무도 안 지난다. 그때는 실패가 옳다.
    //
    // **이 경로가 막혀 있었다**: 준비를 본 뒤에는 상한 시계가 "남의 일"이라며 물러나는데,
    // 관문에 막힌 턴은 정적 대기가 주입으로 끝나지 않아 **아무도 이 턴을 끝내지 않았다.**
    // `gateBlocked` 가 그 자리를 연다.
    const chunks: Buffer[] = [];
    await expect(runPtyTurn(gatePlan(), {
      cwd: process.cwd(),
      timeoutMs: 20_000,
      onData: (c) => chunks.push(c),
      injectPrompt: { text: 'NEVER_SEND_THIS', readyTimeoutMs: 1_200, readyQuietMs: 100 },
    })).rejects.toThrow(/준비 신호/);
    expect(Buffer.concat(chunks).toString('utf8')).not.toContain('[200~');
  }, 20_000);
});
