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

  describe('README environment variables table', () => {
    const configDir = join(getRoot(), 'packages');

    // 툴체인이 주는 변수는 README 의 murmur 설정 표에 적을 것이 아니다.
    const TOOLCHAIN_VARS = new Set(['NODE_ENV', 'CI', 'PATH', 'HOME', 'TERM', 'SHELL']);

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