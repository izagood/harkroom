// 화면으로 「차례가 끝났다」를 읽는다(2026-10-25, 스레드 db4ab174).
//
// claude 말고는 하네스 기록을 해석하지 않는다(어댑터 `transcript.parsed`). 그래서 모델이 MCP 로 말하지 않고
// 끝낸 턴은 끝난 줄 몰라 10분 정지 시계가 찰 때까지 섰다 — digest(codex lane)가 12초 만에 답을 화면에만
// 쓰고 끝냈는데 10분 뒤 「물음이 서 있을 수 있다」로 접혔다. MCP 에는 말없이 끝난 흔적이 남지 않으므로,
// 하네스 기록이 아니라 **어댑터 화면 계약**(입력창 `ready` · 일하는 중 `busy` · 물음 `gate`)으로 읽는다.
//
// 왜 원 바이트가 아니라 그린 화면인가: codex·opencode·kilo 는 바뀐 칸만 다시 그린다. 초시계 숫자만 고쳐
// 쓰고 `esc to interrupt` 글자는 다시 보내지 않으므로, 바이트 흐름에서 표지를 찾으면 일하는 내내 안 보인다
// (실측 청크 기록: 세 하네스 모두 주입 뒤 표지 등장 0회). 그래서 headless 터미널에 그려 화면 글로 본다.
import xtermHeadless from '@xterm/headless';

const { Terminal } = xtermHeadless as unknown as typeof import('@xterm/headless');

/**
 * **끝났다고 보려면 이만큼 이어져야 한다**(ms). 실측(2026-10-25, 다섯 하네스 · 첫 토큰 전 30초 침묵 ·
 * 셸 20초): 일하는 중 표지는 Enter 뒤 ~0.6초부터 최종 답까지 내내 보였고, 꺼진 것은 omp 의 도구 끝 한
 * 프레임(0ms)뿐이었다. 화면이 가장 오래 멈춘 것도 1초 미만이었다. 1.5초는 그 위의 여유다.
 */
export const SCREEN_IDLE_END_MS = 1_500;

export interface ScreenFacts {
  readonly ready: RegExp;
  readonly busy: RegExp;
  readonly gate: RegExp;
}

/** 지금 화면이 말하는 것. `idle` = 입력창이 보이고 일하는 중 표지가 없다. */
export type ScreenState = 'gate' | 'busy' | 'idle' | 'unknown';

export function classifyScreen(text: string, facts: Pick<ScreenFacts, 'ready' | 'gate'> & { busy?: RegExp }): ScreenState {
  if (facts.gate.test(text)) return 'gate';
  if (facts.busy?.test(text)) return 'busy';
  if (facts.ready.test(text)) return 'idle';
  return 'unknown';
}

/**
 * PTY 바이트를 받아 화면을 그리고, 「일하는 중을 한 번 본 뒤 idle 이 이어진 시각」을 잰다.
 *
 * **일하는 중을 한 번은 봐야 끝을 말한다.** 프롬프트를 넣기 전의 첫 화면도 입력창만 있는 idle 이다 —
 * 그때를 끝으로 읽으면 일을 시작하기도 전에 턴을 거둔다.
 */
export class ScreenIdleWatch {
  private readonly term: InstanceType<typeof Terminal>;
  private sawBusy = false;
  private idleSinceMs: number | null = null;
  private state: ScreenState = 'unknown';
  private lastBusyText: string | null = null;

  constructor(private readonly facts: ScreenFacts, size: { cols: number; rows: number } = { cols: 120, rows: 40 }) {
    this.term = new Terminal({ cols: size.cols, rows: size.rows, allowProposedApi: true });
  }

  /** 청크를 그리고 상태를 다시 잰다. `write` 는 비동기라 그린 뒤에 잰다. */
  feed(chunk: string, nowMs: number): Promise<void> {
    return new Promise((done) => {
      this.term.write(chunk, () => {
        this.observe(nowMs);
        done();
      });
    });
  }

  resize(cols: number, rows: number): void {
    this.term.resize(cols, rows);
  }

  /** 보이는 화면 글(줄 끝 공백 걷음). */
  text(): string {
    const b = this.term.buffer.active;
    const out: string[] = [];
    for (let i = 0; i < this.term.rows; i++) out.push(b.getLine(b.viewportY + i)?.translateToString(true) ?? '');
    return out.join('\n');
  }

  /** 마지막으로 본 일하는 중 화면(`screenAnswerLines` 의 비교 기준). */
  busyText(): string | null {
    return this.lastBusyText;
  }

  current(): ScreenState {
    return this.state;
  }

  /** 일하는 중을 본 뒤 idle 이 `SCREEN_IDLE_END_MS` 넘게 이어졌는가. */
  ended(nowMs: number, holdMs = SCREEN_IDLE_END_MS): boolean {
    return this.sawBusy && this.state === 'idle' && this.idleSinceMs !== null && nowMs - this.idleSinceMs >= holdMs;
  }

  private observe(nowMs: number): void {
    const next = classifyScreen(this.text(), this.facts);
    if (next === 'busy') { this.sawBusy = true; this.lastBusyText = this.text(); }
    if (next === 'idle') {
      if (this.state !== 'idle') this.idleSinceMs = nowMs;
    } else {
      this.idleSinceMs = null;
    }
    this.state = next;
  }
}

/** 테두리·구분선 문자가 글자의 절반을 넘는 줄(상태줄·박스). */
const CHROME = /[─━│┃╭╮╰╯┌┐└┘├┤┬┴┼═║╔╗╚╝▔▁▀▄█╹╻▶◀⬝]/g;
/** 경로·URL 처럼 보이는 조각(줄 어디에 있든) — 작업 폴더가 통지에 실리지 않게 그 줄은 버린다. */
const PATHLIKE = /(~?\/|…\/|\.\.?\/|[a-z]+:\/\/)\S/;

/**
 * 끝난 화면에서 모델이 쓴 답으로 보이는 줄을 뽑는다(「답 없이 끝났다」 통지에 싣는다). 하네스마다 화면 모양이 달라 경계를
 * 모르므로 **마지막으로 본 일하는 중 화면에 없던 줄**만 집고, 입력창·일하는 중 표지·테두리·경로 줄은 뺀다(위에서 `max` 줄).
 */
export function screenAnswerLines(text: string, facts: Pick<ScreenFacts, 'ready'> & { busy?: RegExp }, before: string | null, max = 3): string[] {
  const seen = new Set((before ?? '').split('\n').map((l) => l.trim()));
  const picked: string[] = [];
  for (const raw of text.split('\n')) {
    const l = raw.trim();
    if (!l || seen.has(l) || facts.ready.test(l) || facts.busy?.test(l) || PATHLIKE.test(l)) continue;
    const chrome = (l.match(CHROME) ?? []).length;
    if (chrome * 2 > l.replace(/\s/g, '').length) continue;
    picked.push(l.replace(/^[•●⏺◦▣]\s*/, ''));
    if (picked.length >= max) break;
  }
  return picked;
}
