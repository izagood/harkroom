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
      const koreanRegex = /[\uac00-\ud7af\u1100-\u11ff\u3130-\u318f]/g;
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

    function extractEnvVarsFromConfig(dir: string): string[] {
      const envVars = new Set<string>();
      const entries = readdirSync(dir, { withFileTypes: true });
      for (const entry of entries) {
        if (entry.isDirectory()) {
          const srcDir = join(dir, entry.name, 'src');
          if (existsSync(srcDir)) {
            const files = readdirSync(srcDir);
            for (const file of files) {
              if (file === 'config.ts') {
                const content = readFileSync(join(srcDir, file), 'utf-8');
                const backtickMatches = content.matchAll(/`([A-Z_][A-Z0-9_]*)`/g);
                for (const match of backtickMatches) {
                  if (match[1]) envVars.add(match[1]);
                }
                const envDotMatches = content.matchAll(/env\.([A-Z_][A-Z0-9_]*)/g);
                for (const match of envDotMatches) {
                  if (match[1]) envVars.add(match[1]);
                }
                const processEnvMatches = content.matchAll(/process\.env\.([A-Z_][A-Z0-9_]*)/g);
                for (const match of processEnvMatches) {
                  if (match[1]) envVars.add(match[1]);
                }
              }
            }
          }
        }
      }
      return Array.from(envVars).sort();
    }

    it('covers all env.X from config.ts files', () => {
      const readmePath = join(getRoot(), 'README.md');
      const readmeContent = readFileSync(readmePath, 'utf-8');

      const configEnvVars = extractEnvVarsFromConfig(configDir);
      const missing = [];

      for (const envVar of configEnvVars) {
        const pattern = new RegExp(`\\\`${envVar}\\\``);
        if (!pattern.test(readmeContent)) {
          missing.push(envVar);
        }
      }

      expect(
        missing.length,
        `README should document all env vars from config.ts. Missing: ${missing.join(', ')}`
      ).toBe(0);
    });
  });
});