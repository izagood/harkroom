// harkroom.com 소개 페이지의 스크립트 전부다. 외부 요청·추적 없음.
//
// 1) 첫 방문만 브라우저 언어로 보낸다: `/`(영어)에 처음 온 한국어 브라우저를 `/ko/` 로.
//    한 번 정해지면(자동이든 언어 링크를 눌렀든) localStorage 에 남기고 다시는 옮기지 않는다.
//    저장소를 못 쓰는 브라우저에서는 옮기지 않는다 — 옮기면 매번 옮겨져 영어 판에 닿을 수 없다.
//    head 에서 동기로 불러야 영어 판이 한 번 그려졌다가 바뀌는 깜빡임이 없다.
(function () {
  var KEY = 'harkroom-lang';
  var here = document.documentElement.lang === 'ko' ? 'ko' : 'en';
  var saved;
  try { saved = localStorage.getItem(KEY); } catch (e) { return; }
  if (saved) return;
  var first = ((navigator.languages && navigator.languages[0]) || navigator.language || '').toLowerCase();
  var want = first.indexOf('ko') === 0 ? 'ko' : 'en';
  try { localStorage.setItem(KEY, want); } catch (e) { return; }
  if (here === 'en' && want === 'ko') location.replace('/ko/' + location.hash);
})();

document.addEventListener('DOMContentLoaded', function () {
  // 2) 언어 링크를 누르면 그 선택을 기억한다(다음 방문에 자동으로 옮겨지지 않게).
  document.querySelectorAll('[data-lang]').forEach(function (a) {
    a.addEventListener('click', function () {
      try { localStorage.setItem('harkroom-lang', a.getAttribute('data-lang')); } catch (e) { /* 기억만 못 한다 */ }
    });
  });

  // 3) 설치 명령 복사. 클립보드가 막혀 있으면 명령을 선택해 둔다(사람이 ⌘C 하면 된다).
  document.querySelectorAll('[data-copy]').forEach(function (btn) {
    var box = btn.parentElement;
    var cmd = box.querySelector('code');
    var label = btn.textContent;
    btn.addEventListener('click', function () {
      var text = cmd.textContent.replace(/^\$ /gm, '').trim();
      var done = function () {
        btn.textContent = btn.getAttribute('data-copied');
        setTimeout(function () { btn.textContent = label; }, 1600);
      };
      var select = function () {
        var r = document.createRange();
        r.selectNodeContents(cmd);
        var s = getSelection();
        s.removeAllRanges();
        s.addRange(r);
      };
      if (navigator.clipboard && navigator.clipboard.writeText) navigator.clipboard.writeText(text).then(done, select);
      else select();
    });
  });
});
