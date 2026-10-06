/**
 * 「내 글 따라가기」의 "내"는 **이 기기의 작성칸에서 보낸 글**이다(`lib/ownSends.ts`, #1191 후속 d3).
 */
import { describe, it, expect } from 'vitest';
import { appendedFromHere, beginSend, endSend, markOwnSend, OWN_SEND_IDS_CAP, type OwnSendMarks } from '../src/lib/ownSends';
import { msg } from './helpers/fakeApi';

const none: OwnSendMarks = { ownSendIds: {}, sendsInFlight: {} };
const mine = msg('m9', 'c1', 9, '내 글', 'u1');

describe('appendedFromHere', () => {
  it('내 이름이어도 이 기기에서 보낸 표식이 없으면 따라가지 않는다(자동화·다른 기기)', () => {
    expect(appendedFromHere(mine, 'm8', 'u1', 'c1', none)).toBe(false);
  });
  it('응답이 준 id 가 적혀 있으면 따라간다', () => {
    expect(appendedFromHere(mine, 'm8', 'u1', 'c1', markOwnSend(none, 'm9'))).toBe(true);
  });
  it('응답보다 먼저 온 소켓 줄도 그 자리에서 보내는 중이면 내 것이다 — 다른 자리는 아니다', () => {
    const inFlight = beginSend(none, 'c1');
    expect(appendedFromHere(mine, 'm8', 'u1', 'c1', inFlight)).toBe(true);
    expect(appendedFromHere(mine, 'm8', 'u1', 'root-x', inFlight)).toBe(false);
    expect(appendedFromHere(mine, 'm8', 'u1', 'c1', endSend(inFlight, 'c1'))).toBe(false);
  });
  it('앞붙임(마지막 줄 id 그대로)·남의 글·빈 목록은 표식이 있어도 거짓', () => {
    const marks = markOwnSend(beginSend(none, 'c1'), 'm9');
    expect(appendedFromHere(mine, 'm9', 'u1', 'c1', marks)).toBe(false);
    expect(appendedFromHere({ ...mine, authorId: 'u2' }, 'm8', 'u1', 'c1', marks)).toBe(false);
    expect(appendedFromHere(undefined, null, 'u1', 'c1', marks)).toBe(false);
  });
  it('보내는 중 수는 겹쳐도 세고, 0 이 되면 열쇠가 사라진다', () => {
    const two = beginSend(beginSend(none, 'c1'), 'c1');
    expect(two.sendsInFlight.c1).toBe(2);
    expect(endSend(two, 'c1').sendsInFlight.c1).toBe(1);
    expect('c1' in endSend(endSend(two, 'c1'), 'c1').sendsInFlight).toBe(false);
  });
  it('적어 둔 id 는 상한에서 오래된 것부터 버린다', () => {
    let m = none;
    for (let i = 0; i < OWN_SEND_IDS_CAP + 10; i++) m = markOwnSend(m, `id${i}`);
    expect(Object.keys(m.ownSendIds)).toHaveLength(OWN_SEND_IDS_CAP);
    expect(m.ownSendIds.id0).toBeUndefined();
    expect(m.ownSendIds[`id${OWN_SEND_IDS_CAP + 9}`]).toBe(true);
  });
});
