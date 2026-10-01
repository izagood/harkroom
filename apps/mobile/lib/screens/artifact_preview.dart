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

/// **판정은 이 함수 하나다** — 프레임워크 없이 시험으로 고정한다.
///
/// [initialLoaded] 는 우리가 띄운 문서가 한 번 다 떴는가다. 그 뒤에 같은 주소가 다시 오면 그것도 페이지가 스스로
/// 간 것이다(새로고침은 앱의 [다시 불러오기]가 새 서명 경로로 한다).
PreviewNavigation decidePreviewNavigation({
  required String requested,
  required String initial,
  required bool isMainFrame,
  required bool initialLoaded,
}) {
  if (!isMainFrame) return PreviewNavigation.block;
  if (!initialLoaded && requested == initial) return PreviewNavigation.allow;
  final uri = Uri.tryParse(requested);
  if (uri != null && (uri.scheme == 'http' || uri.scheme == 'https') && uri.host.isNotEmpty) {
    return PreviewNavigation.openOutside;
  }
  return PreviewNavigation.block;
}

/// 미리보기를 연다 — 아래에서 올라오는 전체 화면(designer ⑤).
Future<void> openArtifactPreview(BuildContext context, AttachmentRow attachment) {
  return Navigator.of(context).push(MaterialPageRoute<void>(
    fullscreenDialog: true,
    builder: (_) => ArtifactScreen(attachment: attachment),
  ));
}

/// 프레임 자리. 시험은 WebView(플랫폼 뷰) 대신 이것을 바꿔 끼운다.
typedef PreviewFrameBuilder = Widget Function(
    BuildContext context, String url, void Function(Uri outside) onOpenedOutside);

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

  @override
  void didChangeDependencies() {
    super.didChangeDependencies();
    if (_attempt == 0) _load();
  }

  /// 열 때·다시 불러올 때마다 **새 서명 경로**를 받는다 — 60초짜리라 만료는 오류가 아니라 재발급 사유다.
  Future<void> _load() async {
    final mine = ++_attempt;
    setState(() => _phase = _Phase.loading);
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
      setState(() => _phase = switch (e.status) {
            413 => _Phase.tooLarge,
            403 => _Phase.forbidden,
            404 => _Phase.gone,
            _ => _Phase.failed,
          });
    } on Object {
      if (!mounted || mine != _attempt) return;
      setState(() => _phase = _Phase.failed);
    }
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
        _Phase.ready => (widget.frameBuilder ?? _defaultFrame)(context, _url!, _openedOutside),
        _ => _StateView(phase: _phase, attachment: widget.attachment, onReload: _load),
      },
    );
  }

  Widget _defaultFrame(BuildContext context, String url, void Function(Uri) onOpenedOutside) =>
      _PreviewWebView(key: ValueKey(url), url: url, onOpenedOutside: onOpenedOutside);
}

class _StateView extends StatelessWidget {
  const _StateView({required this.phase, required this.attachment, required this.onReload});

  final _Phase phase;
  final AttachmentRow attachment;
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
  const _PreviewWebView({super.key, required this.url, required this.onOpenedOutside});

  final String url;
  final void Function(Uri outside) onOpenedOutside;

  @override
  State<_PreviewWebView> createState() => _PreviewWebViewState();
}

class _PreviewWebViewState extends State<_PreviewWebView> {
  late final WebViewController _controller;
  bool _initialLoaded = false;

  @override
  void initState() {
    super.initState();
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
              final uri = Uri.parse(request.url);
              launchUrl(uri, mode: LaunchMode.externalApplication);
              widget.onOpenedOutside(uri);
              return NavigationDecision.prevent;
            case PreviewNavigation.block:
              return NavigationDecision.prevent;
          }
        },
        onPageFinished: (_) => _initialLoaded = true,
      ))
      ..loadRequest(Uri.parse(widget.url));
  }

  @override
  Widget build(BuildContext context) => WebViewWidget(controller: _controller);
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
