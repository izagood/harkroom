// 스펙 §10 의 "수용(acceptance)" 층. 단위 테스트가 argv 의 **모양**만 단언하면(배열에 이
// 플래그가 있다) CLI 가 그 조합을 거부해도 전부 초록이다. 이 저장소가 실제로 세 번 물렸다:
//   - `codex exec resume <id> -s workspace-write` → `unexpected argument '-s'` (관련 테스트 21개 통과)
//   - `--skip-git-repo-check` 가 `codex exec`·`codex exec resume` 에는 있고 `codex resume` 에는 없다(#89)
//   - `--ignore-user-config` 도 같은 비대칭(#86)
// 셋 다 사람이 `--help` 를 눌러서 찾았다. 그 확인을 코드로 옮긴다.
//
// **CLI 를 실행하지 않는다.** 조립한 argv 로 프로세스를 띄우면 claude 는 모델을 호출하고
// codex 는 실제로 명령을 실행한다(sandbox_mode=workspace-write). 그래서 대신 그
// 서브커맨드의 `--help` 가 열거하는 옵션 목록과 argv 의 플래그를 **정적으로 대조**한다.
// 이 방법이 위 세 결함을 정확히 잡는 이유: 셋 다 "이 서브커맨드에 그 플래그가 없다"였다.
//
// ⚠️ `--help` 를 조립한 argv **뒤에 붙이는** 방법은 쓸 수 없다 — 실측으로 확인했다:
//   codex exec resume <uuid> --skip-git-repo-check --help  → 도움말을 내고 통과
//   codex exec resume <uuid> --skip-git-repo-check          → unexpected argument 로 죽는다
// 즉 `--help` 는 나머지 인자 검증을 건너뛰므로 그 방법은 이 결함을 못 잡는다.
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { describe, expect, it } from 'vitest';
import type { AgentHarness } from '@murmur/shared';
import { buildTurnCommand, writeMcpConfigOnce, writeSystemPromptFile, type TurnPlan } from '../src/turn.js';

const run = promisify(execFile);

/** 그 실행 파일이 PATH 에 있는가. 없으면 이 층을 건너뛴다(CI·VM 에는 CLI 가 없다). */
async function hasCli(command: string): Promise<boolean> {
  try {
    await run('which', [command]);
    return true;
  } catch {
    return false;
  }
}

/**
 * `<command> <subcommand...> --help` 가 열거하는 옵션 이름 집합.
 *
 * 서브커맨드 체인은 argv 앞쪽의 **플래그가 아닌 토큰**들에서 얻는다. 그런데 그중 일부는
 * 서브커맨드가 아니라 위치인자다(`codex exec resume <SESSION_ID>`). 어느 것이 어느 것인지
 * CLI 마다 다르므로, **가장 긴 접두부터 하나씩 줄여** 가며 도움말이 나오는 지점을 찾는다 —
 * 위치인자가 섞여 있어도 도움말은 나오므로(실측) 이 방법이 안전하다.
 */
async function helpFlags(command: string, args: string[]): Promise<Set<string>> {
  const leading: string[] = [];
  for (const a of args) {
    if (a.startsWith('-')) break;
    leading.push(a);
  }
  for (let n = leading.length; n >= 0; n -= 1) {
    try {
      const { stdout } = await run(command, [...leading.slice(0, n), '--help'], { timeout: 20_000 });
      if (!stdout.includes('Usage:') && !stdout.includes('사용')) continue;
      return new Set(stdout.match(/--[a-z0-9][a-z0-9-]*/gi) ?? []);
    } catch {
      // 이 접두는 도움말을 못 냈다 — 한 토큰 줄여 다시 시도한다.
    }
  }
  throw new Error(`도움말을 얻지 못했다: ${command} ${leading.join(' ')}`);
}

/** argv 에서 롱 플래그만 뽑는다. 값(`-c key=value` 의 value)은 `-` 로 시작하지 않는다. */
const longFlagsOf = (args: string[]): string[] => args.filter((a) => a.startsWith('--'));

/**
 * `--help` 에 없는 플래그가 **정말 없는지** 확인한다.
 *
 * 왜 필요한가: 실측으로 확인했다 — `claude --append-system-prompt-file` 은 **존재하지만
 * `--help` 의 옵션 목록에 없다**(숨은 플래그). commander 가 `option '--append-system-prompt-file
 * <file>' argument missing` 으로 답하고, 없는 옵션이면 `unknown option` 으로 답한다. 그래서
 * 도움말 대조만 하면 이 플래그가 오탐으로 잡힌다.
 *
 * 프로브는 그 플래그를 **값 없이 마지막에** 붙여 파서를 세운다. 값을 받는 플래그면
 * "argument missing" 으로 즉시 죽고, 불리언 플래그면 CLI 가 뜨기 시작하므로 짧은 타임아웃으로
 * 끊는다 — 어느 쪽이든 **파싱은 통과했다**는 뜻이다. 모델을 호출하는 조합(`-p` + 프롬프트)은
 * 여기 오지 않는다: 프로브는 서브커맨드 + 그 플래그 하나뿐이다.
 */
async function flagRejected(command: string, sub: string[], flag: string): Promise<boolean> {
  try {
    await run(command, [...sub, flag], { timeout: 4_000 });
    return false; // 파싱도 실행도 문제없이 끝났다 — 존재한다.
  } catch (e) {
    const err = e as { stderr?: string; killed?: boolean };
    const stderr = err.stderr ?? '';
    if (/unknown option|unexpected argument|unrecognized/i.test(stderr)) return true;
    // "argument missing", 타임아웃으로 죽인 경우, 그 밖의 실행 단계 오류 — 전부 파싱은 통과했다.
    return false;
  }
}

interface Combo {
  harness: AgentHarness;
  mode: 'mention' | 'interactive';
  isFirstTurn: boolean;
  sessionId: string | null;
  label: string;
}

/**
 * `assertValidSession` 이 허용하는 조합만 둔다. claude 는 sessionId 를 사전 발급하므로 null 이
 * 올 수 없고, codex 는 첫 멘션 턴에서만 null 이다(turn.ts 의 `allowsNullSessionOnFirstMention`).
 */
const COMBOS: Combo[] = [
  { harness: 'claude-code', mode: 'mention', isFirstTurn: true, sessionId: '11111111-1111-4111-8111-111111111111', label: '첫 멘션 턴' },
  { harness: 'claude-code', mode: 'mention', isFirstTurn: false, sessionId: '22222222-2222-4222-8222-222222222222', label: 'resume 멘션 턴' },
  { harness: 'claude-code', mode: 'interactive', isFirstTurn: false, sessionId: '33333333-3333-4333-8333-333333333333', label: '인터랙티브 턴' },
  { harness: 'codex', mode: 'mention', isFirstTurn: true, sessionId: null, label: '첫 멘션 턴 (id 사전 발급 없음)' },
  { harness: 'codex', mode: 'mention', isFirstTurn: false, sessionId: '44444444-4444-4444-8444-444444444444', label: 'resume 멘션 턴' },
  { harness: 'codex', mode: 'interactive', isFirstTurn: false, sessionId: '55555555-5555-4555-8555-555555555555', label: '인터랙티브 턴' },
];

/**
 * 프로덕션이 주는 모양으로 plan 을 만든다 — fixture 를 손으로 만들면 이 저장소가 네 번
 * 물린 함정(테스트가 프로덕션 생성자를 우회한다)을 그대로 반복한다. mcp 설정과 지시문
 * 파일은 실제 writer 로 쓴다.
 */
async function planFor(combo: Combo, dir: string): Promise<TurnPlan> {
  const mcpConfigPath = await writeMcpConfigOnce(join(dir, 'mcp'), 'http://localhost:3401');
  const systemPromptFile = await writeSystemPromptFile(dir, '지시문');
  return buildTurnCommand({
    harness: combo.harness,
    mode: combo.mode,
    sessionId: combo.sessionId,
    isFirstTurn: combo.isFirstTurn,
    systemPrompt: '지시문',
    systemPromptFile,
    promptCtx: '사람이 쓴 메시지',
    model: null,
    effort: null,
    mentionPermission: 'auto',
    mcpConfigPath,
    pat: 'murp_fake_never_sent',
    murmurUrl: 'http://localhost:3401',
  });
}

describe('수용 — 조립한 argv 의 플래그가 그 서브커맨드에 실제로 존재하는가 (spec §10)', () => {
  for (const combo of COMBOS) {
    it(`[${combo.harness}] ${combo.label}`, async () => {
      const dir = await mkdtemp(join(tmpdir(), 'murmur-acceptance-'));
      try {
        const plan = await planFor(combo, dir);
        if (!(await hasCli(plan.command))) {
          // 조용히 통과하면 이 층이 있다는 사실 자체가 잊힌다 — 왜 건너뛰는지 남긴다.
          console.warn(
            `[수용] '${plan.command}' 가 PATH 에 없어 건너뛴다 — 이 층은 CLI 가 있는 개발 머신에서만 돈다(spec §10). ` +
            '§4 의 플래그 표를 고쳤다면 그 머신에서 반드시 한 번 돌려라.',
          );
          return;
        }
        const sub: string[] = [];
        for (const a of plan.args) { if (a.startsWith('-')) break; sub.push(a); }

        const allowed = await helpFlags(plan.command, plan.args);
        const used = longFlagsOf(plan.args);
        // 플래그가 하나도 없는 조합도 있다(codex 인터랙티브는 `-c` 숏 플래그만 쓴다) —
        // 그때 확인할 것이 없는 것은 정상이므로 개수를 단언하지 않는다.
        const notInHelp = used.filter((f) => !allowed.has(f));
        const rejected: string[] = [];
        for (const f of notInHelp) {
          if (await flagRejected(plan.command, sub, f)) rejected.push(f);
        }
        expect(
          rejected,
          `이 서브커맨드가 받지 않는 플래그: ${rejected.join(', ')} (argv: ${plan.args.join(' ')})`,
        ).toEqual([]);
      } finally {
        await rm(dir, { recursive: true, force: true });
      }
    }, 60_000);
  }
});
