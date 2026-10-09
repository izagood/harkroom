import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

// 설정 폭 PR 4 — 나머지 카드형 화면을 꼴(layout)로 옮기고 칸을 나눈다(시안 v1 cards).
const SRC = join(__dirname, '../src/components/settings');
const read = (f: string) => readFileSync(join(SRC, f), 'utf8');

describe('카드형 화면이 꼴을 쓴다', () => {
  it.each([
    ['UpdatesSettings.tsx', 'layout="cards"', 'updates-columns'],
    ['AgentDefaultsSettings.tsx', 'layout="cards"', 'agent-defaults-columns'],
    ['ThisOperatorSettings.tsx', 'layout="form"', 'layout="form"'],
    ['ProviderAccountsSettings.tsx', 'layout="list"', 'provider-accounts-grid'],
    ['HandleGroupsSettings.tsx', '@container/settings', 'group-detail-columns'],
  ])('%s', (file, layout, marker) => {
    const s = read(file);
    expect(s).toContain(layout);
    expect(s).toContain(marker);
  });

  it('제공업체 계정은 옛 wide 갈래를 쓰지 않는다', () => {
    expect(read('ProviderAccountsSettings.tsx')).not.toContain('width="wide"');
  });

  it('핸들 그룹 상세의 672px 상한이 걷혔다', () => {
    expect(read('HandleGroupsSettings.tsx')).not.toContain('max-w-2xl');
  });

  it('AI configuration 두 단추는 12px(text-meta)이다', () => {
    const s = read('AgentsSettings.tsx');
    expect(s.match(/flex-1 rounded-row px-3 py-2 text-meta \$\{customized/g)?.length).toBe(2);
  });
});
