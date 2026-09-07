/**
 * claude 로그인 프로세스의 수명.
 *
 * **프로세스를 주입한다.** 실제 `claude auth login` 은 브라우저 OAuth 를 시작하고 사람을
 * 기다린다 — 테스트가 그것을 띄우면 계정 상태를 건드리고 끝나지도 않는다. 우리가 재는 것은
 * **URL 을 어떻게 뽑고, 코드를 어디로 보내고, 어떻게 회수하는가**이고 그 셋은 상대가 진짜
 * `claude` 인지와 무관하다.
 *
 * `runners.test.ts` 가 실물과 가짜를 나눈 것과 같은 판단이다: 프로세스 그룹·생사는 실물로
 * 재고(그 파일), 프로토콜·파싱은 가짜로 잰다(이 파일).
 */
import { EventEmitter } from 'node:events';
import { mkdtempSync } from 'node:fs';
import { stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';

import {
  createClaudeAccountsPort,
  type ClaudeLoginChild,
  type ClaudeLoginEvent,
} from '../src/claudeAccounts.js';

/**
 * 2026-09-07 실측 바이트(claude 2.1.263). **OSC 8 하이퍼링크로 감싸여 URL 이 두 번** 나온다.
 * 프론트가 이 파싱을 하면 하이퍼링크 규격을 프론트가 알아야 한다 — 한 곳에서 한다.
 */
const URL_ONCE = 'https://claude.com/cai/oauth/authorize?code=true&client_id=X&state=Y';
// OSC 8 은 `ESC ] 8 ; ; <uri> BEL <text> ESC ] 8 ; ; BEL` 다. 터미널에 찍힌 모양(`]8;;` 로
// 시작하고 URL 이 두 번 보인다)에서 ESC 와 BEL 은 눈에 안 보였을 뿐 실제로는 있다 —
// **그 제어 바이트가 URL 의 끝을 알려 준다.** 픽스처에서 빼면 두 URL 이 경계 없이 이어
// 붙어 원리적으로 하나만 뽑을 수 없고, 그러면 이 테스트가 구현을 잘못된 방향으로 끌고 간다.
const REAL_OUTPUT =
  'Opening browser to sign in…\r\n' +
  `If the browser didn't open, visit: \u001b]8;;${URL_ONCE}\u0007${URL_ONCE}\u001b]8;;\u0007\r\n` +
  'Paste code here if prompted > ';

/** 가짜 자식. `stdin.write` 를 기록하고 `kill` 로 받은 시그널을 남긴다. */
class FakeChild extends EventEmitter {
  stdout = new EventEmitter();
  stderr = new EventEmitter();
  written: string[] = [];
  signals: string[] = [];
  killed = false;
  stdin = { write: (s: string) => { this.written.push(s); return true; } };
  kill(sig?: string): boolean {
    this.signals.push(sig ?? 'SIGTERM');
    this.killed = true;
    return true;
  }
  /** 실측 출력을 흘린다. 청크를 나눠 보내 경계에서도 URL 이 잡히는지 함께 잰다. */
  emitRealOutput(): void {
    const mid = Math.floor(REAL_OUTPUT.length / 2);
    this.stdout.emit('data', Buffer.from(REAL_OUTPUT.slice(0, mid)));
    this.stdout.emit('data', Buffer.from(REAL_OUTPUT.slice(mid)));
  }
}

function harness(status: unknown = { loggedIn: true }) {
  const root = mkdtempSync(join(tmpdir(), 'd-login-'));
  const children: FakeChild[] = [];
  const spawned: string[] = [];
  const events: ClaudeLoginEvent[] = [];
  const port = createClaudeAccountsPort({
    root,
    runStatus: vi.fn(async () => status),
    spawnLogin: vi.fn((configDir: string): ClaudeLoginChild => {
      spawned.push(configDir);
      const c = new FakeChild();
      children.push(c);
      return c as unknown as ClaudeLoginChild;
    }),
    // 회수 유예를 0 으로 줄여 SIGKILL 승격을 시간 없이 잰다.
    killGraceMs: 0,
  });
  port.onLoginEvent((e) => events.push(e));
  return { root, port, children, events, spawned };
}

describe('loginStart', () => {
  it('실측 출력에서 URL 을 한 번만 뽑는다 — OSC 8 로 두 번 나온다', async () => {
    const h = harness();
    const { loginId } = await h.port.loginStart('work', 'lime');
    h.children[0]!.emitRealOutput();

    const urls = h.events.filter((e) => e.url !== undefined);
    expect(urls).toHaveLength(1);
    expect(urls[0]!.url).toBe(URL_ONCE);
    expect(urls[0]!.loginId).toBe(loginId);
  });

  it('계정 디렉터리를 먼저 만든다 — 없으면 claude 가 어디에 로그인할지 모른다', async () => {
    const h = harness();
    await h.port.loginStart('work', 'lime');
    // 파일시스템을 직접 본다. `list()` 로 재면 안 된다 — 이 픽스처는 flat 모드(pools.json
    // 없음)라 뿌리의 하위(`work`)가 계정으로 세어지고 `lime` 은 그 판정에 안 나온다.
    expect((await stat(join(h.root, 'work', 'lime'))).isDirectory()).toBe(true);
  });

  it('그 디렉터리를 spawnLogin 에 넘긴다 — CLAUDE_CONFIG_DIR 이 될 값이다', async () => {
    const h = harness();
    await h.port.loginStart('work', 'lime');
    expect(h.spawned).toEqual([join(h.root, 'work', 'lime')]);
  });

  it('이름 문법을 잰다', async () => {
    const h = harness();
    await expect(h.port.loginStart('..', 'lime')).rejects.toThrow();
    await expect(h.port.loginStart('work', '..')).rejects.toThrow();
  });

  it('같은 계정에 로그인이 이미 돌고 있으면 거절한다', async () => {
    // 둘이 같은 디렉터리를 밟는다 — 어느 쪽 자격증명이 남는지 알 수 없다.
    const h = harness();
    await h.port.loginStart('work', 'lime');
    await expect(h.port.loginStart('work', 'lime')).rejects.toThrow();
    // 다른 계정은 괜찮다.
    await expect(h.port.loginStart('work', 'plum')).resolves.toBeTruthy();
  });
});

describe('loginSubmit', () => {
  it('코드를 stdin 에 한 줄로 쓴다', async () => {
    const h = harness();
    const { loginId } = await h.port.loginStart('work', 'lime');
    await h.port.loginSubmit(loginId, 'the-code');
    expect(h.children[0]!.written).toEqual(['the-code\n']);
  });

  it('모르는 loginId 는 거절한다 — 조용히 무시하지 않는다', async () => {
    // 조용히 무시하면 UI 가 "코드를 보냈다"를 그리고 사람은 영원히 기다린다.
    const h = harness();
    await expect(h.port.loginSubmit('nope', 'code')).rejects.toThrow();
  });

  it('개행이 든 코드를 첫 줄만 보낸다 — 붙여 넣기에 개행이 섞인다', async () => {
    const h = harness();
    const { loginId } = await h.port.loginStart('work', 'lime');
    await h.port.loginSubmit(loginId, 'the-code\nextra');
    expect(h.children[0]!.written).toEqual(['the-code\n']);
  });
});

describe('loginCancel', () => {
  it('SIGTERM 뒤 유예가 지나면 SIGKILL 로 승격한다', async () => {
    // 러너 회수와 같은 규율이다 — 하네스가 정리할 기회를 먼저 준다.
    const h = harness();
    const { loginId } = await h.port.loginStart('work', 'lime');
    await h.port.loginCancel(loginId);
    expect(h.children[0]!.signals[0]).toBe('SIGTERM');
    await new Promise((r) => setTimeout(r, 10));
    expect(h.children[0]!.signals).toContain('SIGKILL');
  });

  it('이미 끝난 로그인을 취소해도 던지지 않는다', async () => {
    // 사람이 브라우저를 닫는 것과 취소를 누르는 것이 경합한다.
    const h = harness();
    const { loginId } = await h.port.loginStart('work', 'lime');
    h.children[0]!.emit('exit', 0, null);
    await expect(h.port.loginCancel(loginId)).resolves.toBeUndefined();
  });
});

describe('종료 통지', () => {
  it('성공하면 done 과 상태를 함께 낸다', async () => {
    const h = harness({ loggedIn: true, email: 'a@b.c' });
    const { loginId } = await h.port.loginStart('work', 'lime');
    h.children[0]!.emit('exit', 0, null);
    await new Promise((r) => setTimeout(r, 10));

    const done = h.events.filter((e) => e.done === true);
    expect(done).toHaveLength(1);
    expect(done[0]!.loginId).toBe(loginId);
    expect(done[0]!.status?.loggedIn).toBe(true);
  });

  it('실패해도 done 을 낸다 — 무음으로 끝나지 않는다', async () => {
    // 통지가 없으면 UI 가 영원히 "로그인 중"을 그린다.
    const h = harness({ loggedIn: false });
    await h.port.loginStart('work', 'lime');
    h.children[0]!.emit('exit', 1, null);
    await new Promise((r) => setTimeout(r, 10));

    const done = h.events.filter((e) => e.done === true);
    expect(done).toHaveLength(1);
    expect(done[0]!.status?.loggedIn).toBe(false);
    expect(done[0]!.error).toBeTruthy();
  });

  it('끝난 뒤에는 같은 계정에 다시 로그인할 수 있다', async () => {
    const h = harness();
    await h.port.loginStart('work', 'lime');
    h.children[0]!.emit('exit', 0, null);
    await new Promise((r) => setTimeout(r, 10));
    await expect(h.port.loginStart('work', 'lime')).resolves.toBeTruthy();
  });
});

describe('shutdownLogins', () => {
  it('진행 중인 로그인을 전부 회수한다', async () => {
    // 러너와 달리 살려 두지 않는다 — 사람이 브라우저에서 완료해도 코드를 받을 프로세스가 없다.
    const h = harness();
    await h.port.loginStart('work', 'lime');
    await h.port.loginStart('work', 'plum');
    await h.port.shutdownLogins();
    expect(h.children[0]!.killed).toBe(true);
    expect(h.children[1]!.killed).toBe(true);
  });
});
