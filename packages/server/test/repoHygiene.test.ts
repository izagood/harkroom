import { describe, it, expect } from 'vitest';
import { readFileSync, existsSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

const ROOT = join(import.meta.dirname, '../../..');

function getRoot(): string {
  return ROOT;
}

describe('repo hygiene', () => {
  describe('LICENSE', () => {
    it('exists at root', () => {
      const licensePath = join(getRoot(), 'LICENSE');
      expect(existsSync(licensePath), 'LICENSE file should exist at repository root').toBe(true);
    });

    it('contains Apache License 2.0', () => {
      const licensePath = join(getRoot(), 'LICENSE');
      const content = readFileSync(licensePath, 'utf-8');
      expect(content, 'LICENSE should contain "Apache License"').toContain('Apache License');
      expect(content, 'LICENSE should contain "Version 2.0"').toContain('Version 2.0');
    });

    it('contains copyright notice', () => {
      const licensePath = join(getRoot(), 'LICENSE');
      const content = readFileSync(licensePath, 'utf-8');
      expect(content, 'LICENSE should contain copyright notice').toContain('Copyright 2026 izagood');
    });
  });

  describe('HANDOFF file removal', () => {
    it('HANDOFF-issue-fixes.md does not exist', () => {
      const handoffPath = join(getRoot(), 'HANDOFF-issue-fixes.md');
      expect(existsSync(handoffPath), 'HANDOFF-issue-fixes.md should be deleted').toBe(false);
    });
  });

  describe('README', () => {
    it('headings contain no Korean', () => {
      const readmePath = join(getRoot(), 'README.md');
      const content = readFileSync(readmePath, 'utf-8');
      // /g \ub97c \ubd99\uc774\uba74 test() \uac00 lastIndex \ub97c \ub4e4\uace0 \ub2e4\ub140 \ub450 \ubc88\uc9f8 \ud55c\uae00 \uc81c\ubaa9\uc744 \ub193\uce5c\ub2e4 \u2014 \ubd99\uc774\uc9c0 \ub9c8\ub77c.
      const koreanRegex = /[\uac00-\ud7af\u1100-\u11ff\u3130-\u318f]/;
      const lines = content.split('\n');
      const headingLines = lines.filter(line => /^#{1,6}\s/.test(line));
      const koreanInHeadings = headingLines.filter(line => koreanRegex.test(line));
      expect(
        koreanInHeadings.length,
        `README headings should not contain Korean. Found in: ${koreanInHeadings.join(', ')}`
      ).toBe(0);
    });
  });

  /**
   * **실제 사람의 계정 정보가 저장소에 남지 않는다** (2026-09-08).
   *
   * 무엇이 있었나: 계정 풀 기능을 만들면서 실측 결과를 설계 문서에 적었고, 그 안에 개발
   * 머신의 **실제 이메일과 조직 이름**이 들어갔다(`docs/specs/2026-09-08-...` 두 줄).
   * PR 본문에도 같은 값이 실렸다. 사용자가 그것을 발견해 지적했다.
   *
   * 왜 회귀선이 필요한가: 그 실수는 **악의 없이, 정확히 좋은 의도에서** 났다 — "실측을
   * 적어라"는 이 저장소의 규율이 값을 그대로 붙이게 만든다. 규율은 유지하고, 값만 못
   * 들어오게 막는 자리가 여기다.
   *
   * 판정은 **도메인**으로 한다. 이름·핸들은 저장소 전체에 정당하게 등장하고(작성자, 브랜치,
   * 커밋) 그것을 금지하면 이 테스트가 자기 근거 때문에 빨개진다. 반면 이메일 도메인과
   * 조직 이름은 코드·문서에 있을 이유가 없다 — 예시가 필요하면 `example.com` 이 있다.
   *
   * 되돌려 RED: 아무 문서에 실제 이메일 한 줄을 넣으면 빨개진다.
   */
  describe('실제 계정 정보가 없다', () => {
    /** 문서·소스에 있을 이유가 없는 것들. 예시는 `example.com`·`example.org` 를 쓴다. */
    const 금지 = [
      // 실제 이메일 도메인. `@example.com`·`@personal.example` 같은 예시 도메인은 통과한다.
      /@(?:gmail|googlemail|naver|kakao|daum|outlook|hotmail|icloud|yahoo)\.com\b/i,
      /@rebellions\.ai\b/i,
      // 조직 이름(사내 네이밍이 드러난다).
      /\bRebellions-[A-Za-z]+/,
    ];

    /**
     * **이 파일 자신은 제외한다.** 금지 패턴과 자기 검사 문자열이 여기 살아 있어야 하고,
     * 그러지 않으면 이 회귀선이 자기 근거 때문에 빨개진다(첫 실행에서 실제로 그랬다).
     *
     * 파일 하나를 통째로 면제하는 것은 보통 나쁜 신호지만, 여기서는 **면제 대상이 검사기
     * 자신**이라 그 위험이 다르다: 이 파일에 실제 계정 정보를 넣는 유일한 경로는 금지
     * 패턴을 늘리는 것이고, 그 변경은 이 파일을 읽는 사람 앞에 그대로 드러난다.
     */
    const 자기자신 = join(getRoot(), 'packages/server/test/repoHygiene.test.ts');

    function 소스와문서(): string[] {
      const out: string[] = [];
      const walk = (dir: string): void => {
        if (!existsSync(dir)) return;
        for (const e of readdirSync(dir, { withFileTypes: true })) {
          const full = join(dir, e.name);
          if (e.isDirectory()) {
            if (['node_modules', 'dist', 'target', '.git'].includes(e.name)) continue;
            walk(full);
          } else if (/\.(ts|tsx|rs|md|json)$/.test(e.name)) {
            out.push(full);
          }
        }
      };
      walk(join(getRoot(), 'packages'));
      walk(join(getRoot(), 'docs'));
      out.push(join(getRoot(), 'README.md'));
      return out;
    }

    it('소스·문서에 실제 이메일 도메인이나 조직 이름이 없다', () => {
      const 걸린것: string[] = [];
      for (const file of 소스와문서()) {
        if (file === 자기자신) continue;
        const text = readFileSync(file, 'utf-8');
        for (const re of 금지) {
          const m = re.exec(text);
          if (m) 걸린것.push(`${file.slice(getRoot().length + 1)}: ${m[0]}`);
        }
      }
      expect(걸린것, `실제 계정 정보가 저장소에 있다:\n${걸린것.join('\n')}`).toEqual([]);
    });

    it('이 회귀선이 실제로 잡는다 — 예시 도메인은 통과하고 실제 도메인은 걸린다', () => {
      // 예외를 넣은 뒤 그 예외가 금지 전체를 열어 버리는 사고를 여기서 잰다.
      const 걸리나 = (s: string): boolean => 금지.some((re) => re.test(s));
      expect(걸리나('you@example.com')).toBe(false);
      expect(걸리나('me@personal.example')).toBe(false);
      expect(걸리나('someone@gmail.com')).toBe(true);
      expect(걸리나('someone@rebellions.ai')).toBe(true);
      expect(걸리나('org=Rebellions-Lychee')).toBe(true);
    });
  });

  describe('README environment variables table', () => {
    const configDir = join(getRoot(), 'packages');

    // 툴체인이 주는 변수는 README 의 murmur 설정 표에 적을 것이 아니다.
    //
    // `USER` 가 여기 있는 이유(2026-09-08): daemon 이 macOS Keychain 항목을 찾을 때
    // 계정명으로 쓴다(`claude` 가 그 이름으로 저장한다 — 실측). `HOME`·`SHELL` 과 같은
    // 부류로 **OS 가 주는 값이고 murmur 가 설정하는 값이 아니다** — 표에 적으면 사람이
    // 그것을 우리가 읽는 설정 손잡이로 읽는다.
    const TOOLCHAIN_VARS = new Set(['NODE_ENV', 'CI', 'PATH', 'HOME', 'TERM', 'SHELL', 'USER']);

    function collectSourceFiles(dir: string, out: string[]): void {
      if (!existsSync(dir)) return;
      for (const entry of readdirSync(dir, { withFileTypes: true })) {
        const full = join(dir, entry.name);
        if (entry.isDirectory()) {
          if (entry.name === 'node_modules' || entry.name === 'dist') continue;
          collectSourceFiles(full, out);
        } else if (entry.name.endsWith('.ts') || entry.name.endsWith('.tsx')) {
          out.push(full);
        }
      }
    }

    // `config.ts` 만 보면 `packages/agent/src/version.ts` 의 `AGENT_VERSION` 처럼
    // 다른 파일에서 읽는 변수가 표에서 빠져도 초록으로 지나간다. 그래서 각 패키지의
    // src 와 scripts 디렉터리 전체를 훑는다(test 디렉터리는 제외).
    function extractEnvVars(dir: string): string[] {
      const envVars = new Set<string>();
      const files: string[] = [];
      for (const entry of readdirSync(dir, { withFileTypes: true })) {
        if (!entry.isDirectory()) continue;
        collectSourceFiles(join(dir, entry.name, 'src'), files);
        collectSourceFiles(join(dir, entry.name, 'scripts'), files);
      }
      for (const file of files) {
        const content = readFileSync(file, 'utf-8');
        for (const match of content.matchAll(/\benv\.([A-Z_][A-Z0-9_]*)/g)) {
          if (match[1] && !TOOLCHAIN_VARS.has(match[1])) envVars.add(match[1]);
        }
      }
      return Array.from(envVars).sort();
    }

    it('covers every env var read anywhere under packages/*/src and packages/*/scripts', () => {
      const readmePath = join(getRoot(), 'README.md');
      const readmeContent = readFileSync(readmePath, 'utf-8');

      const configEnvVars = extractEnvVars(configDir);
      // 추출기 자체가 비면 이 회귀선은 아무것도 지키지 못한다 — 최소 개수를 못 박는다.
      expect(configEnvVars.length).toBeGreaterThan(5);

      const missing = [];
      for (const envVar of configEnvVars) {
        const pattern = new RegExp(`\`${envVar}\``);
        if (!pattern.test(readmeContent)) {
          missing.push(envVar);
        }
      }

      expect(
        missing.length,
        `README should document all env vars read from process.env. Missing: ${missing.join(', ')}`
      ).toBe(0);
    });
  });
});