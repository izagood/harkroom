// 번들러가 이것을 ESM 산출물 안으로 끌어들일 때, 이 `require` 가 살아남아야 한다.
// `ws` 가 로드 시점에 하는 것과 **같은 모양**이다(events·net·tls·stream·crypto).
const { EventEmitter } = require('events');
module.exports = { ok: typeof EventEmitter === 'function' };
