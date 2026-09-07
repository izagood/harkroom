import { readFileSync } from 'node:fs';
import * as path from 'node:path';
import { describe, expect, it } from 'vitest';

import { switchesAccount, withAccountFailover } from '../src/claudeAccounts.js';
import type { ClaudeAccount } from '../src/claudeAccounts.js';
import { ExecutableNotFoundError, MURMUR_ERROR_SOURCE } from '../src/policy.js';

describe('계정 전환 방아쇠', () => {
  it('사용량 한도는 계정을 바꾼다', () => {
    // policy.ts::isQuotaExhausted 주석은 "여기서 할 일은 기다리는 것뿐"이라 적었는데,
    // 계정이 여러 개면 그 말이 더는 참이 아니다 — 기다리지 않고 옮겨 탈 수 있다.
    expect(switchesAccount(new Error(
      "harness 종료 1: You've hit your session limit · resets 4:10pm (Asia/Seoul)",
    ))).toBe(true);
  });

  it('harness 자격증명 실패는 계정을 바꾼다', () => {
    // 그 계정의 로그인이 만료·부재다. 다른 계정은 멀쩡할 수 있다.
    expect(switchesAccount(new Error(
      'harness 종료 1: Failed to authenticate: OAuth session expired and could not be refreshed',
    ))).toBe(true);
  });

  it('미로그인도 계정을 바꾼다', () => {
    expect(switchesAccount(new Error('harness 종료 1: Not logged in · Please run /login')))
      .toBe(true);
  });

  it('murmur PAT 실패는 계정을 바꾸지 않는다', () => {
    // 계정과 무관하다 — 바꿔도 같은 자리에서 실패하고, 러너는 물러나야 한다(#250).
    const err = Object.assign(new Error('unauthorized'), {
      source: MURMUR_ERROR_SOURCE, status: 401,
    });
    expect(switchesAccount(err)).toBe(false);
  });

  it('실행 파일 부재는 계정을 바꾸지 않는다', () => {
    // PATH 문제다(#340). 계정을 바꿔도 같은 자리에서 실패한다.
    expect(switchesAccount(new ExecutableNotFoundError('claude', '/usr/bin'))).toBe(false);
  });

  it('실행 파일 부재는 PATH 에 자격증명 문구가 섞여 있어도 계정을 바꾸지 않는다', () => {
    // ExecutableNotFoundError 의 메시지에는 PATH 가 그대로 실린다. 그 경로에 문구가
    // 들어 있으면 아래 자격증명 판정이 문구 매칭으로 걸린다 — 배타성을 순서로 보장한다.
    expect(switchesAccount(new ExecutableNotFoundError('claude', '/opt/notloggedin/bin')))
      .toBe(false);
  });

  // #556 과의 상호작용. 세션 id 충돌은 **같은 계정의** 세션 상태 어긋남이다 — 계정을
  // 바꿔도 그 어긋남이 낫지 않고, #556 이 만든 전용 분기(재시도 없이 통지)가 받아야 한다.
  // 여기서 참을 돌려주면 계정 축이 풀을 헛돌며 그 분기를 늦춘다.
  it('세션 id 충돌은 계정을 바꾸지 않는다 — #556 의 전용 분기로 간다', () => {
    expect(switchesAccount(new Error(
      'harness 종료 1: Error: Session ID 214242d8-0000-4000-8000-000000000000 is already in use.',
    ))).toBe(false);
  });

  it('평범한 실패는 계정을 바꾸지 않는다 — 기존 재시도 회계로 간다', () => {
    expect(switchesAccount(new Error('harness 종료 1: something else went wrong'))).toBe(false);
  });
});

// 계정 축을 **별 함수로 뺀 이유**: main.ts 의 멘션 루프는 유예·종료요청·한도 분기에서
// continue·break 를 쓴다. 계정 루프를 그 안에 인라인으로 넣으면 그 제어문이 계정 루프를
// 향하게 되어 조용히 멘션 루프를 못 벗어난다. 함수 경계로 끊고, 그 덕에 루프 없이 검증된다.
describe('withAccountFailover', () => {
  const acct = (name: string): ClaudeAccount => ({ name, configDir: `/pool/${name}` });
  const QUOTA = () => new Error("harness 종료 1: You've hit your session limit · resets 4:10pm");
  const OTHER = () => new Error('harness 종료 1: unrelated failure');

  it('첫 계정이 성공하면 나머지를 시도하지 않는다', async () => {
    const seen: (string | null)[] = [];
    const result = await withAccountFailover([acct('lime'), acct('plum')], async (a) => {
      seen.push(a?.name ?? null);
      return 'ok';
    });
    expect(result).toBe('ok');
    expect(seen).toEqual(['lime']);
  });

  it('한도를 만나면 다음 계정으로 같은 일을 다시 시도한다', async () => {
    const seen: (string | null)[] = [];
    const result = await withAccountFailover([acct('lime'), acct('plum')], async (a) => {
      seen.push(a?.name ?? null);
      if (a?.name === 'lime') throw QUOTA();
      return 'ok';
    });
    expect(result).toBe('ok');
    expect(seen).toEqual(['lime', 'plum']);
  });

  it('계정을 바꿔서 나을 실패가 아니면 즉시 그 오류를 던진다 — 축을 헛돌지 않는다', async () => {
    const seen: (string | null)[] = [];
    await expect(withAccountFailover([acct('lime'), acct('plum')], async (a) => {
      seen.push(a?.name ?? null);
      throw OTHER();
    })).rejects.toThrow(/unrelated failure/);
    // 두 번째 계정을 건드리지 않았다 — 평범한 실패는 기존 재시도 회계의 몫이다.
    expect(seen).toEqual(['lime']);
  });

  it('모든 계정이 한도면 마지막 오류를 던진다', async () => {
    const seen: (string | null)[] = [];
    await expect(withAccountFailover([acct('lime'), acct('plum')], async (a) => {
      seen.push(a?.name ?? null);
      throw QUOTA();
    })).rejects.toThrow(/session limit/);
    expect(seen).toEqual(['lime', 'plum']);
  });

  it('전환할 때만 onSwitch 를 부른다 — 첫 시도에는 부르지 않는다', async () => {
    const switches: string[] = [];
    await withAccountFailover([acct('lime'), acct('plum')], async (a) => {
      if (a?.name === 'lime') throw QUOTA();
      return 'ok';
    }, (from, to) => switches.push(`${from?.name ?? '(기본)'}→${to?.name ?? '(기본)'}`));
    expect(switches).toEqual(['lime→plum']);
  });

  it('풀이 비어 [null] 이면 한 번만 돌고 기존 동작과 같다', async () => {
    // 계정 풀을 안 만든 러너의 경로다. 한도를 만나도 넘어갈 곳이 없으니 그대로 던진다 —
    // 호출자의 기존 한도 분기(통지 후 읽음 처리)가 그것을 받는다.
    const seen: (string | null)[] = [];
    await expect(withAccountFailover([null], async (a) => {
      seen.push(a?.name ?? null);
      throw QUOTA();
    })).rejects.toThrow(/session limit/);
    expect(seen).toEqual([null]);
  });

  it('빈 배열은 호출자 결함이다 — 조용히 성공하지 않는다', async () => {
    // 조용히 undefined 를 돌려주면 답하지 않은 멘션이 답한 것으로 처리된다.
    await expect(withAccountFailover([], async () => 'ok')).rejects.toThrow(/계정 축/);
  });
});

// main.ts 는 top-level await 로 서버에 붙으므로 테스트가 import 할 수 없다. 판정 자체는
// `claudeAccounts.test.ts` 가 실물로 확인하고, 여기서는 **배선이 그 자리에 있는지**만 본다 —
// `mainCredentialSites.test.ts` 와 같은 종류의 약한 검사이고, 같은 이유로 필요하다:
// 이 기능이 깨지는 방식이 정확히 "함수는 있는데 기동부가 안 부른다"다.
describe('main.ts 의 풀 배선', () => {
  const source = readFileSync(path.resolve(__dirname, '../src/main.ts'), 'utf8');

  it('풀 해석 함수를 쓴다 — 평평한 목록 함수를 기동부에서 직접 부르지 않는다', () => {
    expect(source).toContain('loadClaudeAccountLane(');
    // 기동부에서 평평한 목록을 직접 부르면 풀 축이 통째로 빠진다.
    expect(source).not.toContain('await loadClaudeAccounts(');
  });

  it('풀 결정 키가 me.id 다 — handle 이 아니다', () => {
    // handle 은 바뀔 수 있고 서로 다른 서버의 같은 handle 은 다른 계정이다.
    expect(source).toContain('agentId: me.id');
  });

  it('강제 지정과 순서를 env 에서 읽는다', () => {
    expect(source).toContain('MURMUR_CLAUDE_POOL');
    expect(source).toContain('MURMUR_CLAUDE_ACCOUNTS');
  });

  it('기동 로그에 풀 이름이 실린다 — 어느 풀로 도는지 운영자가 알아야 한다', () => {
    expect(source).toContain('풀:');
  });
});
