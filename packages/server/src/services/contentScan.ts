/**
 * 에이전트 쓰기 검사(080, Hermes 자기 개선 검토 D4).
 *
 * 기억과 스킬은 에이전트가 쓴 글이 **다른 턴의 지시**가 되는 자리다 — core 는 매 턴 시스템
 * 프롬프트로, 승인된 스킬은 모든 에이전트의 스킬 디렉터리로 간다. 스레드에 섞인 남의 글이나
 * 바깥(Slack·웹) 글이 그대로 옮겨 적히면 그 글이 프롬프트가 된다. Hermes Agent 도 같은 이유로
 * 메모리 쓰기마다 패턴을 검사한다(`tools/memory_tool_store.py::_scan_memory_content`).
 *
 * **거절하지 않고 표시만 한다.** 정규식은 오탐이 난다 — 걸린 것을 거절하면 정상 기억이 조용히
 * 사라진다. 호출자는 저장하되 표시하고, 사람이 확인할 때까지 프롬프트에 싣지 않는다.
 *
 * 규칙은 좁게 잡는다. 기억에는 명령·토큰 이름·지시문 인용이 원래 많다(예: PR 레시피의
 * `GH_TOKEN=$(gh auth token ...)`). "지시를 무시하라"는 문장, 토큰 **값**, 보이지 않는 글자처럼
 * 정상 기억에 있을 까닭이 없는 것만 잡는다.
 */

export interface ScanRule {
  id: string;
  /** 사람이 읽는 이유 — 화면과 도구 응답에 그대로 실린다. */
  label: string;
  re: RegExp;
}

export const SCAN_RULES: readonly ScanRule[] = [
  {
    id: 'override-en',
    label: '앞선 지시를 무시하라는 문장(영문)',
    re: /\b(?:ignore|disregard|forget|override)\b[^\n.]{0,40}\b(?:previous|prior|above|earlier|all|any|system|your)\b[^\n.]{0,20}\b(?:instructions?|prompts?|rules?|directives?|guidelines?)\b/i,
  },
  {
    id: 'override-ko',
    label: '앞선 지시를 무시하라는 문장(한글)',
    re: /(?:이전|앞의|앞선|위의|기존|모든|시스템)\s*(?:지시|지침|명령|규칙|프롬프트)[^\n.]{0,12}(?:무시|잊어|따르지\s*마)/,
  },
  {
    id: 'role-tag',
    label: '시스템·지시 블록을 흉내 낸 태그',
    re: /<\/?\s*(?:system|system-reminder|instructions?|developer)\s*>|\[\/?(?:SYSTEM|INST)\]|<\|im_start\|>/i,
  },
  {
    id: 'secret',
    label: '비밀 토큰 값',
    re: /\bsk-ant-[A-Za-z0-9_-]{20,}|\bgh[pousr]_[A-Za-z0-9]{30,}|\bgithub_pat_[A-Za-z0-9_]{30,}|\bAKIA[0-9A-Z]{16}\b|\bxox[abprs]-[A-Za-z0-9-]{10,}|-----BEGIN [A-Z ]*PRIVATE KEY-----/,
  },
  {
    id: 'exfil',
    label: '비밀을 밖으로 보내는 명령',
    re: /\b(?:curl|wget|nc|Invoke-WebRequest)\b[^\n]{0,200}(?:\$\{?[A-Z_]*(?:TOKEN|SECRET|PASSWORD|API_KEY)\b|~?\/\.ssh\/|\$\(\s*gh auth token)/i,
  },
  {
    // 200D(ZWJ, 이모지 잇기)·200C(ZWNJ)는 정상 글에 나온다 — 뺀다.
    id: 'invisible',
    label: '보이지 않는 글자(방향 제어·태그 문자 등)',
    re: /[​‎‏‪-‮⁠-⁤⁦-⁩﻿\u{E0000}-\u{E007F}]/u,
  },
];

export interface ScanHit {
  /** 걸린 규칙들의 사람용 이유, `; ` 로 잇는다. */
  reason: string;
  rules: string[];
}

/** 걸리면 이유를, 아니면 null 을 준다. 여러 칸(본문·요약)을 한 번에 본다. */
export function scanWrite(...parts: (string | null | undefined)[]): ScanHit | null {
  const text = parts.filter((p): p is string => typeof p === 'string' && p.length > 0).join('\n');
  if (!text) return null;
  const hit = SCAN_RULES.filter((r) => r.re.test(text));
  if (!hit.length) return null;
  return { reason: hit.map((r) => r.label).join('; '), rules: hit.map((r) => r.id) };
}
