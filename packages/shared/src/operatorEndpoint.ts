/**
 * 오퍼레이터의 **로컬** 엔드포인트(앱·러너가 붙는 unix 소켓)는 개명 전 `daemonEndpoint` 가
 * 그대로 맡는다 — 파일명만 `operator/operator-v1.*` 로 바뀌었다(스펙 2026-09-20 §3). 이 모듈은
 * 그것을 다시 내고, 서버 ↔ 오퍼레이터 **채널**(`/operator` WS)의 프로토콜 버전을 하나 더 낸다.
 *
 * 두 버전은 다른 것이다: `DAEMON_PROTOCOL_VERSION` 은 같은 머신 안의 소켓 세대(파일명에
 * 박힌다), `OPERATOR_PROTOCOL_VERSION` 은 네트워크 너머 서버와의 프레임 세대(`hello.protocol`
 * 에 실린다). 한쪽이 바뀐다고 다른 쪽이 바뀌지 않는다.
 */
export * from './daemonEndpoint.js';

/** 서버 ↔ 오퍼레이터 채널의 프레임 세대. `hello.protocol` 에 실리고 서버가 거절할 근거다. */
export const OPERATOR_PROTOCOL_VERSION = 1 as const;
