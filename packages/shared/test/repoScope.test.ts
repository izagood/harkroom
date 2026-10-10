import { describe, expect, it } from 'vitest';
import { isOrgRepoScope, orgScopeOf, repoGrantScope, repoScope } from '../src/permissions.js';

// 머지 권한의 조직 와일드카드(jaebin 10-09): `owner/*` 는 grant 를 주고·거두는 자리에만 오고, 머지 판정의 실제 저장소 자리에는 못 온다.
describe('repo scope — owner/* 조직 와일드카드', () => {
  it('repoGrantScope 는 정확한 이름과 owner/* 만 받고 소문자로 정규화한다', () => {
    expect(repoGrantScope('izagood/harkroom')).toBe('repo:izagood/harkroom');
    expect(repoGrantScope(' Acme-Org/* ')).toBe('repo:acme-org/*');
  });

  it('* 하나·*/*·owner 자리의 *·부분 패턴·빈 이름은 거절한다', () => {
    for (const bad of ['*', '*/*', '*/harkroom', 'acme-org/ab*', 'acme-org/*x', 'acme-org/**', 'reb*/x', 'acme-org/', '/*', '']) {
      expect(repoGrantScope(bad), bad).toBeNull();
    }
  });

  it('repoScope(실제 저장소)는 owner/* 를 받지 않는다 — 판정 자리에서 grant 문자열과 정확 일치하는 길을 막는다', () => {
    expect(repoScope('acme-org/*')).toBeNull();
    expect(repoScope('acme-org/npu')).toBe('repo:acme-org/npu');
  });

  it('orgScopeOf 는 같은 owner 의 조직 scope 를 준다 — 다른 owner 는 덮지 않는다', () => {
    expect(orgScopeOf('repo:acme-org/npu')).toBe('repo:acme-org/*');
    expect(orgScopeOf('repo:izagood/harkroom')).not.toBe('repo:acme-org/*');
    expect(orgScopeOf('repo:acme-org/*')).toBeNull();
    expect(isOrgRepoScope('repo:acme-org/*')).toBe(true);
    expect(isOrgRepoScope('repo:acme-org/npu')).toBe(false);
  });
});
