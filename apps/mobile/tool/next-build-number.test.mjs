// node --test apps/mobile/tool/next-build-number.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildNumberFloor, nextBuildNumber } from './next-build-number.mjs';

const ci = (run, attempt = '1') => ({ BUILD_NUMBER_FROM_RUN: '1', GITHUB_RUN_NUMBER: run, GITHUB_RUN_ATTEMPT: attempt });

test('ASC 최대값 + 1 (문자열 정렬 함정: "10" > "9")', () => {
  assert.equal(nextBuildNumber(['9', '10', '2']), 11);
  assert.equal(nextBuildNumber([]), 1);
});

test('방금 올린 9 가 ASC 에 아직 안 보여도 CI 바닥값이 같은 번호를 피한다 (2026-10-02 #12·#13)', () => {
  // #11 이 9 를 올렸고 ASC 목록에는 8 까지만 보이는 상태.
  assert.equal(nextBuildNumber(['8'], ci('12')), 121);
  assert.equal(nextBuildNumber(['8'], ci('13')), 131);
});

test('다시 돌리기(attempt)도 번호를 올린다', () => {
  assert.ok(nextBuildNumber(['8'], ci('13', '2')) > nextBuildNumber(['8'], ci('13', '1')));
});

test('ASC 가 바닥값보다 크면 ASC 를 따른다 (로컬 릴리스가 앞서 간 경우)', () => {
  assert.equal(nextBuildNumber(['500'], ci('13')), 501);
});

test('로컬(플래그 없음)·값이 이상하면 바닥 없음', () => {
  assert.equal(buildNumberFloor({ GITHUB_RUN_NUMBER: '13' }), 0);
  assert.equal(buildNumberFloor(ci('abc')), 0);
  assert.equal(buildNumberFloor(ci('13', '10')), 0);
  assert.equal(nextBuildNumber(['8'], { GITHUB_RUN_NUMBER: '13' }), 9);
});
