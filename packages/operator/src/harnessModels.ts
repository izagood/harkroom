/**
 * 하네스가 받는 모델 목록 — 에이전트 설정의 모델 고르개가 여기서 나온다.
 *
 * 전에는 모델 칸이 자유 입력이었다. 하네스마다 이름 규칙이 달라(`opus` · `gpt-5.5` ·
 * `rro/openai/gpt-oss-120b`) 한 글자만 틀려도 턴이 시작하자마자 죽는데, 사람은 무엇을 넣어야
 * 하는지 알 길이 없었다. 그래서 **하네스에게 직접 묻는다** — 이 머신에서 그 하네스가 받는다고
 * 스스로 밝힌 것만 고를 수 있게 한다.
 *
 * 묻는 수단(2026-09-28 실측):
 * - codex: `codex debug models` — 카탈로그 JSON. `visibility: 'list'` 인 것만 사람이 고르는
 *   목록이다(`hide` 는 codex 자신의 `/model` 고르개에도 안 나온다). `priority` 순.
 * - opencode: `opencode models` — 한 줄에 `provider/model` 하나. 제공자 설정을 따라간다.
 * - claude-code: **목록 명령이 없다.** `--model` 도움말이 밝힌 별칭(최신 모델로 풀린다)만
 *   적는다 — 지어낸 전체 이름을 늘어놓지 않는다. 그 밖의 이름은 화면의 직접 입력으로 넣는다.
 *
 * 실패는 `undefined`(모른다)다. 빈 배열(없다)과 구별한다 — 화면은 모를 때 직접 입력으로
 * 물러서고, 없다고 거짓말하지 않는다.
 */
import { execFile } from 'node:child_process';
import { join } from 'node:path';
import { harnessFallbackBinDirs, type HarnessModel } from '@harkroom/shared';
import { HARNESS_BINARIES } from './harnesses.js';

type Harness = keyof typeof HARNESS_BINARIES;

/** `claude --help` 의 `--model` 설명이 예로 드는 별칭(claude 2.1.283). */
export const CLAUDE_MODEL_ALIASES: HarnessModel[] = [
  { id: 'fable', label: 'Fable (latest)' },
  { id: 'opus', label: 'Opus (latest)' },
  { id: 'sonnet', label: 'Sonnet (latest)' },
  { id: 'haiku', label: 'Haiku (latest)' },
];

/** `codex debug models` 의 출력 → 사람이 고르는 목록. 모양이 다르면 `undefined`. */
export function parseCodexModels(stdout: string): HarnessModel[] | undefined {
  let doc: unknown;
  try { doc = JSON.parse(stdout); } catch { return undefined; }
  const models = (doc as { models?: unknown } | null)?.models;
  if (!Array.isArray(models)) return undefined;
  return models
    .filter((m): m is { slug: string; display_name?: unknown; visibility?: unknown; priority?: unknown } =>
      typeof m === 'object' && m !== null && typeof (m as { slug?: unknown }).slug === 'string')
    .filter((m) => m.visibility === undefined || m.visibility === 'list')
    .sort((a, b) => (typeof a.priority === 'number' ? a.priority : Infinity) - (typeof b.priority === 'number' ? b.priority : Infinity))
    .map((m) => ({ id: m.slug, ...(typeof m.display_name === 'string' && m.display_name ? { label: m.display_name } : {}) }));
}

/** `opencode models` 의 출력 → 목록. `provider/model` 모양이 아닌 줄(경고 등)은 버린다. */
export function parseOpencodeModels(stdout: string): HarnessModel[] {
  const seen = new Set<string>();
  const out: HarnessModel[] = [];
  for (const raw of stdout.split('\n')) {
    const line = raw.trim();
    if (!/^[^\s/]+\/\S+$/.test(line) || seen.has(line)) continue;
    seen.add(line);
    out.push({ id: line });
  }
  return out;
}

export interface ListModelsDeps {
  /** 로그인 셸 PATH(`loginPath.ts`). 러너와 같은 PATH 로 부른다. */
  path: string | null;
  home: string;
  env: NodeJS.ProcessEnv;
  /** 테스트가 바꿔 끼운다. 실패는 reject. */
  exec?: (file: string, args: string[], opts: { env: NodeJS.ProcessEnv; timeoutMs: number }) => Promise<string>;
}

/** 한 번의 조회가 기다리는 상한. codex 는 카탈로그를 네트워크로 새로 받으므로 넉넉히 둔다. */
const LIST_TIMEOUT_MS = 20_000;

const defaultExec: NonNullable<ListModelsDeps['exec']> = (file, args, opts) =>
  new Promise((resolve, reject) => {
    execFile(file, args, { env: opts.env, timeout: opts.timeoutMs, maxBuffer: 8 * 1024 * 1024 }, (err, stdout) => {
      if (err) reject(err); else resolve(String(stdout));
    });
  });

/**
 * 그 하네스의 모델 목록. PATH 는 러너와 **같은 규칙**이다 — 로그인 셸 PATH 뒤에 설치 관례
 * 자리(`harnessFallbackBinDirs`)를 붙인다. 여기서 다른 PATH 로 부르면 "고를 수 있다" 와
 * "러너가 실행할 수 있다" 가 갈린다(`harnesses.ts` 머리 주석의 그 사고).
 */
export async function listHarnessModels(harness: Harness, deps: ListModelsDeps): Promise<HarnessModel[] | undefined> {
  if (harness === 'claude-code') return CLAUDE_MODEL_ALIASES;
  const fallback = harnessFallbackBinDirs(harness).map((d) => join(deps.home, ...d.split('/')));
  const PATH = [...(deps.path ? [deps.path] : []), ...fallback].join(':');
  const env = { ...deps.env, PATH };
  const exec = deps.exec ?? defaultExec;
  try {
    if (harness === 'codex') {
      return parseCodexModels(await exec(HARNESS_BINARIES.codex, ['debug', 'models'], { env, timeoutMs: LIST_TIMEOUT_MS }));
    }
    return parseOpencodeModels(await exec(HARNESS_BINARIES.opencode, ['models'], { env, timeoutMs: LIST_TIMEOUT_MS }));
  } catch {
    return undefined;
  }
}
