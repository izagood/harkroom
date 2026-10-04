import 'package:flutter/material.dart';
import 'package:url_launcher/url_launcher.dart';
import 'package:webview_flutter/webview_flutter.dart';

import '../api/api_error.dart';
import '../api/models.dart';
import '../i18n/i18n.dart';
import '../state/app_scope.dart';

/// 미리보기(아티팩트) ⑤ — 에이전트가 `artifact.publish` 로 올린 HTML 을 앱 안 WebView 로 본다.
/// 사양: designer d8ca47be·abcc05cf, 조건: security(harkroom 스레드 31121b84).
///
/// ## 왜 사파리가 아닌가
/// 사파리는 앱 로그인을 모른다 — claude.ai 링크가 폰에서 막힌 것과 같은 벽이다. 그리고 서명 URL 이 브라우저
/// 기록에 남는다(#1069 F1 에서 데스크톱이 바로 그 길로 샐 뻔했다).
///
/// ## 격리
/// 서버가 `GET /preview/:token` 에 CSP `sandbox allow-scripts allow-popups`(allow-same-origin 없음)를 단다 —
/// WebView 최상위 문서에도 그 지시문이 걸려 불투명 origin 에서 돈다(WKWebView 실측은 실기에서 한다, 머지 조건).
/// 여기서는 **JS 채널을 하나도 붙이지 않는다** — 페이지가 앱에 말을 걸 길이 없다.
///
/// ## 이동
/// [decidePreviewNavigation] 한 곳이 정한다. 우리가 띄운 첫 로드만 받고, 페이지가 스스로 다른 http(s) 로
/// 가려 하면 막고 시스템 브라우저로 넘긴다(security ⑤ 조건). 하위 프레임은 전부 막는다 — CSP
/// `default-src 'none'` 이라 원래 뜰 수 없고, 막는 쪽이 틀리지 않는다.

/// 이동 요청 하나에 대한 판정.
enum PreviewNavigation { allow, block, openOutside }

/// 주소를 비교할 모양으로 편다 — WKWebView 가 돌려주는 `request.url` 은 앱이 넣은 문자열과 글자가 다를 수
/// 있다(호스트 대소문자, `:443` 같은 기본 포트, `//` 겹친 경로, NSURL 정규화). 글자로 견주면 첫 로드가 막히고
/// 그 서명 URL 이 밖으로 나간다(security #1072 F1). 그래서 scheme·host·port·path·query 로 견준다.
class _Target {
  _Target(this.scheme, this.host, this.port, this.path, this.query);

  final String scheme;
  final String host;
  final int port;
  final String path;
  final String query;

  static _Target? parse(String raw) {
    final u = Uri.tryParse(raw);
    if (u == null || u.host.isEmpty) return null;
    final scheme = u.scheme.toLowerCase();
    final port = u.hasPort ? u.port : (scheme == 'https' ? 443 : scheme == 'http' ? 80 : 0);
    // 끝 점(`host.`)은 같은 호스트다 — 견줄 때 지운다(security 후속).
    final host = u.host.toLowerCase().replaceFirst(RegExp(r'\.+$'), '');
    return _Target(scheme, host, port, u.path.replaceAll(RegExp('/{2,}'), '/'), u.query);
  }

  bool sameOrigin(_Target o) => scheme == o.scheme && host == o.host && port == o.port;
  bool sameAs(_Target o) => sameOrigin(o) && path == o.path && query == o.query;
}

/// **판정은 이 함수 하나다** — 프레임워크 없이 시험으로 고정한다.
///
/// - 우리가 띄운 **첫 로드만** 받는다(정규화해 견준다).
/// - **미리보기 경로(같은 서버의 `/preview/…`)는 어떤 경우에도 밖으로 넘기지 않는다** — 첫 로드로 허용되지
///   않았으면 막기만 한다. 서명 URL 이 사파리 기록에 남는 길을 닫는다(security F1).
/// - 하위 프레임은 전부 막는다(CSP `default-src 'none'` 이라 원래 뜰 수 없다).
/// - 그 밖의 http(s) 는 막고, 사람이 확인하면 시스템 브라우저로 넘긴다([OutsideNavigationGate]).
/// - http(s) 가 아닌 것은 막기만 한다.
///
/// [initialLoaded] 는 우리가 띄운 문서가 한 번 다 떴는가다. 그 뒤에 같은 주소가 다시 오면 그것도 페이지가
/// 스스로 간 것이다(새로고침은 앱의 [다시 불러오기]가 새 서명 경로로 한다).
PreviewNavigation decidePreviewNavigation({
  required String requested,
  required String initial,
  required bool isMainFrame,
  required bool initialLoaded,
}) {
  final req = _Target.parse(requested);
  final first = _Target.parse(initial);
  if (req == null || (req.scheme != 'http' && req.scheme != 'https')) return PreviewNavigation.block;
  // **우리 서버 호스트면 경로와 상관없이** 밖으로 넘기지 않는다(security 후속). 경로를 글자로 견주면
  // `/%70review/…` 같은 표기를 놓친다. 이 화면에서 우리 서버의 다른 경로로 갈 일도 없다. scheme·port 도 보지
  // 않는다 — 페이지는 자기 주소(토큰 포함)를 읽을 수 있으므로 `http://` 로 바꾼 같은 경로도 막아야 한다.
  final ourServer = first != null && req.host == first.host;
  if (ourServer) {
    return isMainFrame && !initialLoaded && req.sameAs(first) ? PreviewNavigation.allow : PreviewNavigation.block;
  }
  if (!isMainFrame) return PreviewNavigation.block;
  return PreviewNavigation.openOutside;
}

/// 밖으로 넘기기 전에 **사람에게 묻는다**(security F2). 모바일은 데스크톱과 달리 목적지를 읽을 수 있으므로,
/// 호스트를 보이고 [브라우저로 열기]를 눌렀을 때만 연다. 물음이 떠 있는 동안 들어오는 이동은 조용히 버린다 —
/// 에이전트 페이지가 이동을 되풀이해도 사파리가 연달아 뜨지 않는다.
class OutsideNavigationGate {
  OutsideNavigationGate({required this.confirm, required this.launch});

  final Future<bool> Function(Uri uri) confirm;
  final Future<void> Function(Uri uri) launch;
  bool _asking = false;

  /// 물음을 띄웠으면 true, 이미 떠 있어 버렸으면 false.
  Future<bool> handle(Uri uri) async {
    if (_asking) return false;
    _asking = true;
    try {
      if (await confirm(uri)) await launch(uri);
    } finally {
      _asking = false;
    }
    return true;
  }
}

/// `{host}` 자리를 굵게 채운 글.
TextSpan _withBoldHost(String template, String host) {
  final at = template.indexOf('{host}');
  if (at < 0) return TextSpan(text: template);
  return TextSpan(children: [
    TextSpan(text: template.substring(0, at)),
    TextSpan(text: host, style: const TextStyle(fontWeight: FontWeight.w600)),
    TextSpan(text: template.substring(at + '{host}'.length)),
  ]);
}

/// 묻는 창. 호스트만 크게 보인다 — 경로·쿼리는 페이지가 지은 값이라 사람이 판단할 재료가 아니다.
Future<bool> confirmLeavePreview(BuildContext context, Uri uri) async {
  final t = context.t;
  final ok = await showDialog<bool>(
    context: context,
    builder: (context) => AlertDialog(
      key: const Key('artifact-leave-dialog'),
      title: Text(t.artifactLeaveTitle),
      // 사람이 판단할 근거는 호스트 한 낱말이다 — 굵게(designer c).
      content: Text.rich(_withBoldHost(t.artifactLeaveBody, uri.host), key: const Key('artifact-leave-body')),
      actions: [
        TextButton(
          key: const Key('artifact-leave-cancel'),
          onPressed: () => Navigator.of(context).pop(false),
          child: Text(t.artifactLeaveCancel),
        ),
        TextButton(
          key: const Key('artifact-leave-open'),
          onPressed: () => Navigator.of(context).pop(true),
          child: Text(t.artifactLeaveOpen),
        ),
      ],
    ),
  );
  return ok ?? false;
}

/// 미리보기를 연다 — 아래에서 올라오는 전체 화면(designer ⑤).
Future<void> openArtifactPreview(BuildContext context, AttachmentRow attachment) {
  return Navigator.of(context).push(MaterialPageRoute<void>(
    fullscreenDialog: true,
    builder: (_) => ArtifactScreen(attachment: attachment),
  ));
}

/// 프레임 자리. 시험은 WebView(플랫폼 뷰) 대신 이것을 바꿔 끼운다.
///
/// [onLoadFailed] 는 첫 문서를 못 받았을 때 부른다 — 흰 화면으로 두지 않고 사유를 보이게 한다.
typedef PreviewFrameBuilder = Widget Function(BuildContext context, String url,
    void Function(Uri outside) onOpenedOutside, void Function(PreviewLoadFailure failure) onLoadFailed);

/// WebView 가 첫 문서를 못 받은 사유. [status] 는 HTTP 상태(받았으면), [description] 은 네트워크 오류 글.
class PreviewLoadFailure {
  const PreviewLoadFailure({this.status, this.description});
  final int? status;
  final String? description;

  /// 사람에게 보일 짧은 사유 — 원인을 가르는 단서다(앱이 흰 화면만 보이면 신고로는 원인을 못 정한다).
  String get reason => status != null ? 'HTTP $status' : (description == null || description!.isEmpty ? '?' : description!);
}

enum _Phase { loading, ready, tooLarge, forbidden, gone, failed }

class ArtifactScreen extends StatefulWidget {
  const ArtifactScreen({super.key, required this.attachment, this.frameBuilder});

  final AttachmentRow attachment;
  final PreviewFrameBuilder? frameBuilder;

  @override
  State<ArtifactScreen> createState() => _ArtifactScreenState();
}

class _ArtifactScreenState extends State<ArtifactScreen> {
  _Phase _phase = _Phase.loading;
  String? _url;
  String? _title;
  int _attempt = 0;

  /// 실패 사유 한 줄(HTTP 상태·네트워크 오류). 문구 아래에 작게 보인다.
  String? _detail;

  @override
  void didChangeDependencies() {
    super.didChangeDependencies();
    if (_attempt == 0) _load();
  }

  /// 열 때·다시 불러올 때마다 **새 서명 경로**를 받는다 — 60초짜리라 만료는 오류가 아니라 재발급 사유다.
  Future<void> _load() async {
    final mine = ++_attempt;
    setState(() {
      _phase = _Phase.loading;
      _detail = null;
    });
    final api = context.app.api;
    if (api == null) {
      setState(() => _phase = _Phase.failed);
      return;
    }
    try {
      final ticket = await api.issuePreview(widget.attachment.id);
      if (!mounted || mine != _attempt) return;
      setState(() {
        _url = api.previewUrl(ticket.path);
        _title = ticket.title.isEmpty ? null : ticket.title;
        _phase = _Phase.ready;
      });
    } on ApiError catch (e) {
      if (!mounted || mine != _attempt) return;
      setState(() {
        _phase = switch (e.status) {
          413 => _Phase.tooLarge,
          403 => _Phase.forbidden,
          404 => _Phase.gone,
          _ => _Phase.failed,
        };
        _detail = _phase == _Phase.failed ? 'HTTP ${e.status}' : null;
      });
    } on Object catch (e) {
      if (!mounted || mine != _attempt) return;
      setState(() {
        _phase = _Phase.failed;
        _detail = e.runtimeType.toString();
      });
    }
  }

  /// 서명 경로는 받았는데 WebView 가 문서를 못 받았다. `GET /preview/:token` 은 만료·권한·삭제를 전부 같은 404 로
  /// 답하므로(서버가 일부러 가르지 않는다) 여기서는 사유를 "열지 못했다"로 묶고 상태만 곁들인다. [다시 불러오기]는
  /// 새 서명 경로를 받으므로 만료라면 그것으로 풀린다.
  void _loadFailed(PreviewLoadFailure failure) {
    if (!mounted || _phase != _Phase.ready) return;
    setState(() {
      _phase = _Phase.failed;
      _detail = failure.reason;
    });
  }

  void _openedOutside(Uri uri) {
    ScaffoldMessenger.maybeOf(context)?.showSnackBar(SnackBar(content: Text(context.t.artifactOpenedOutside)));
  }

  @override
  Widget build(BuildContext context) {
    final t = context.t;
    final ref = widget.attachment.artifact;
    final title = _title ?? ref?.title ?? widget.attachment.filename;
    // 머리줄은 **WebView 밖에서 앱이 그린다** — 페이지가 앱 화면을 흉내 내도 이 줄은 진짜다.
    return Scaffold(
      appBar: AppBar(
        leading: IconButton(
          key: const Key('artifact-close'),
          icon: const Icon(Icons.close),
          tooltip: t.artifactClose,
          onPressed: () => Navigator.of(context).maybePop(),
        ),
        title: Column(
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            Text(title, key: const Key('artifact-title'), overflow: TextOverflow.ellipsis),
            Text(
              '${t.artifactMadeBy}${ref == null ? '' : ' · ${t.artifactVersion.replaceAll('{v}', '${ref.version}')}'}',
              style: Theme.of(context).textTheme.bodySmall,
            ),
          ],
        ),
        actions: [
          IconButton(
            key: const Key('artifact-reload'),
            icon: const Icon(Icons.refresh),
            tooltip: t.artifactReload,
            onPressed: _load,
          ),
        ],
      ),
      body: switch (_phase) {
        _Phase.ready => (widget.frameBuilder ?? _defaultFrame)(context, _url!, _openedOutside, _loadFailed),
        _ => _StateView(phase: _phase, attachment: widget.attachment, detail: _detail, onReload: _load),
      },
    );
  }

  Widget _defaultFrame(BuildContext context, String url, void Function(Uri) onOpenedOutside,
          void Function(PreviewLoadFailure) onLoadFailed) =>
      _PreviewWebView(key: ValueKey(url), url: url, onOpenedOutside: onOpenedOutside, onLoadFailed: onLoadFailed);
}

class _StateView extends StatelessWidget {
  const _StateView({required this.phase, required this.attachment, required this.onReload, this.detail});

  final _Phase phase;
  final AttachmentRow attachment;
  final String? detail;
  final VoidCallback onReload;

  @override
  Widget build(BuildContext context) {
    final t = context.t;
    final text = switch (phase) {
      _Phase.loading => t.artifactLoading,
      _Phase.tooLarge => t.artifactTooLarge.replaceAll('{size}', formatBytes(attachment.byteSize)),
      _Phase.forbidden => t.artifactForbidden,
      _Phase.gone => t.artifactGone,
      _ => t.artifactFailed,
    };
    return Center(
      child: Padding(
        padding: const EdgeInsets.all(24),
        child: Column(
          mainAxisSize: MainAxisSize.min,
          children: [
            Text(text, key: Key('artifact-state-${phase.name}'), textAlign: TextAlign.center),
            if (detail != null) ...[
              const SizedBox(height: 4),
              Text(detail!,
                  key: const Key('artifact-state-detail'),
                  textAlign: TextAlign.center,
                  style: Theme.of(context).textTheme.bodySmall),
            ],
            if (phase == _Phase.failed) ...[
              const SizedBox(height: 12),
              OutlinedButton(onPressed: onReload, child: Text(t.artifactReload)),
            ],
          ],
        ),
      ),
    );
  }
}

/// 실제 WebView. JS 는 켠다(시안은 대개 스크립트로 움직인다). **JS 채널은 붙이지 않는다.**
class _PreviewWebView extends StatefulWidget {
  const _PreviewWebView(
      {super.key, required this.url, required this.onOpenedOutside, required this.onLoadFailed});

  final String url;
  final void Function(Uri outside) onOpenedOutside;
  final void Function(PreviewLoadFailure failure) onLoadFailed;

  @override
  State<_PreviewWebView> createState() => _PreviewWebViewState();
}

class _PreviewWebViewState extends State<_PreviewWebView> {
  late final WebViewController _controller;
  late final OutsideNavigationGate _gate;
  bool _initialLoaded = false;

  @override
  void initState() {
    super.initState();
    _gate = OutsideNavigationGate(
      confirm: (uri) => mounted ? confirmLeavePreview(context, uri) : Future.value(false),
      launch: (uri) async {
        await launchUrl(uri, mode: LaunchMode.externalApplication);
        widget.onOpenedOutside(uri);
      },
    );
    _controller = WebViewController()
      ..setJavaScriptMode(JavaScriptMode.unrestricted)
      ..setNavigationDelegate(NavigationDelegate(
        onNavigationRequest: (request) {
          final verdict = decidePreviewNavigation(
            requested: request.url,
            initial: widget.url,
            isMainFrame: request.isMainFrame,
            initialLoaded: _initialLoaded,
          );
          switch (verdict) {
            case PreviewNavigation.allow:
              return NavigationDecision.navigate;
            case PreviewNavigation.openOutside:
              // 이동은 막는다. 넘길지는 사람이 정한다(F2) — 확인 전에는 launchUrl 을 부르지 않는다.
              _gate.handle(Uri.parse(request.url));
              return NavigationDecision.prevent;
            case PreviewNavigation.block:
              return NavigationDecision.prevent;
          }
        },
        // 첫 문서를 못 받으면 흰 화면에 막대만 남는다 — 사유를 화면으로 올린다. 하위 리소스(글꼴·그림)의 실패는
        // 페이지가 그려지는 데 지장이 없으니 무시하고, 첫 로드가 끝난 뒤의 실패도 무시한다(페이지는 이미 보인다).
        onWebResourceError: (error) {
          if (_initialLoaded || error.isForMainFrame == false) return;
          // 우리가 막은 이동(prevent)도 iOS 에서는 "취소됨" 오류로 온다 — 그건 실패가 아니다.
          if (error.errorCode == -999 /* NSURLErrorCancelled */) return;
          widget.onLoadFailed(PreviewLoadFailure(description: error.description));
        },
        onHttpError: (error) {
          if (_initialLoaded) return;
          final status = error.response?.statusCode;
          if (status == null || status < 400) return;
          final failedUrl = error.request?.uri.toString();
          if (failedUrl != null && failedUrl != widget.url &&
              decidePreviewNavigation(requested: failedUrl, initial: widget.url, isMainFrame: true, initialLoaded: false) !=
                  PreviewNavigation.allow) {
            return;
          }
          widget.onLoadFailed(PreviewLoadFailure(status: status));
        },
        onPageFinished: (_) {
          _initialLoaded = true;
          if (mounted) setState(() => _painting = false);
        },
      ))
      ..loadRequest(Uri.parse(widget.url));
  }

  /// 첫 그림 전 흰 화면에 머리줄 아래 얇은 막대를 둔다(designer b). 첫 로드가 끝나면 내린다.
  bool _painting = true;

  @override
  Widget build(BuildContext context) => Stack(children: [
        WebViewWidget(controller: _controller),
        if (_painting)
          const Positioned(
            left: 0, right: 0, top: 0,
            child: LinearProgressIndicator(key: Key('artifact-painting'), minHeight: 2),
          ),
      ]);
}

/// 사람이 읽는 크기(데스크톱 `formatSize` 와 같은 셈).
String formatBytes(int bytes) {
  if (bytes < 1024) return '$bytes B';
  const units = ['KB', 'MB', 'GB'];
  var value = bytes / 1024;
  var unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit += 1;
  }
  return '${value >= 10 ? value.round() : value.toStringAsFixed(1)} ${units[unit]}';
}
