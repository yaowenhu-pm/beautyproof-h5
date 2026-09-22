package com.beautyproof.trial;

import android.app.Activity;
import android.content.ActivityNotFoundException;
import android.content.ClipData;
import android.content.Intent;
import android.content.res.AssetFileDescriptor;
import android.graphics.Color;
import android.graphics.Bitmap;
import android.net.Uri;
import android.net.http.SslError;
import android.os.Bundle;
import android.view.View;
import android.webkit.CookieManager;
import android.webkit.PermissionRequest;
import android.webkit.SslErrorHandler;
import android.webkit.ValueCallback;
import android.webkit.WebChromeClient;
import android.webkit.WebResourceError;
import android.webkit.WebResourceRequest;
import android.webkit.WebResourceResponse;
import android.webkit.WebSettings;
import android.webkit.WebView;
import android.webkit.WebViewClient;
import android.widget.Button;
import android.widget.LinearLayout;
import android.widget.ProgressBar;
import android.widget.TextView;
import android.widget.Toast;
import java.util.ArrayList;
import java.util.Arrays;
import java.util.Collections;
import java.util.HashSet;
import java.util.Set;
import java.io.ByteArrayInputStream;
import java.nio.charset.StandardCharsets;

/** Online trial shell. It never stores platform credentials or adds a JS bridge. */
public final class MainActivity extends Activity {
    private static final int PICK_MEDIA = 41;
    private static final long MAX_BYTES = 200L * 1024L * 1024L;
    private static final String[] MEDIA_TYPES = {"image/jpeg", "image/png", "image/webp", "video/mp4", "video/quicktime"};
    private final Set<String> permittedTypes = new HashSet<>(Arrays.asList(MEDIA_TYPES));
    private WebView web;
    private ProgressBar progress;
    private LinearLayout errorPanel;
    private TextView errorMessage;
    private ValueCallback<Uri[]> pendingFiles;

    @Override public void onCreate(Bundle state) {
        super.onCreate(state);
        LinearLayout root = new LinearLayout(this);
        root.setOrientation(LinearLayout.VERTICAL);
        root.setBackgroundColor(Color.rgb(248, 250, 255));
        root.setOnApplyWindowInsetsListener((view, insets) -> {
            view.setPadding(insets.getSystemWindowInsetLeft(), insets.getSystemWindowInsetTop(),
                    insets.getSystemWindowInsetRight(), insets.getSystemWindowInsetBottom());
            return insets;
        });
        progress = new ProgressBar(this, null, android.R.attr.progressBarStyleHorizontal);
        root.addView(progress, new LinearLayout.LayoutParams(-1, 6));
        errorPanel = new LinearLayout(this);
        errorPanel.setOrientation(LinearLayout.VERTICAL);
        errorPanel.setPadding(32, 32, 32, 32);
        errorMessage = new TextView(this);
        errorMessage.setTextSize(16);
        errorPanel.addView(errorMessage);
        Button retry = new Button(this);
        retry.setText("重新打开真妍盾");
        retry.setOnClickListener(view -> loadHome());
        errorPanel.addView(retry);
        errorPanel.setVisibility(View.GONE);
        root.addView(errorPanel);
        web = new WebView(this);
        root.addView(web, new LinearLayout.LayoutParams(-1, 0, 1));
        setContentView(root);

        WebSettings settings = web.getSettings();
        settings.setJavaScriptEnabled(true); // Required by the first-party React application.
        settings.setDomStorageEnabled(true);
        settings.setAllowFileAccess(false);
        settings.setAllowFileAccessFromFileURLs(false);
        settings.setAllowUniversalAccessFromFileURLs(false);
        // SAF content URIs are returned only after an explicit user selection.
        // content:// is never permitted as a navigation target.
        settings.setAllowContentAccess(true);
        settings.setMixedContentMode(WebSettings.MIXED_CONTENT_NEVER_ALLOW);
        settings.setSafeBrowsingEnabled(true);
        settings.setJavaScriptCanOpenWindowsAutomatically(false);
        settings.setSupportMultipleWindows(false);
        settings.setMediaPlaybackRequiresUserGesture(true);
        CookieManager.getInstance().setAcceptThirdPartyCookies(web, false);
        WebView.setWebContentsDebuggingEnabled(false);

        web.setWebViewClient(new WebViewClient() {
            @Override public WebResourceResponse shouldInterceptRequest(WebView view, WebResourceRequest request) {
                // shouldOverrideUrlLoading is not invoked for all POST navigations.
                if (request.isForMainFrame() && !UrlPolicy.isInternal(request.getUrl().toString())) {
                    return new WebResourceResponse("text/plain", "UTF-8", 403, "Blocked", Collections.emptyMap(),
                            new ByteArrayInputStream("Navigation blocked".getBytes(StandardCharsets.UTF_8)));
                }
                return null;
            }
            @Override public void onPageStarted(WebView view, String url, Bitmap favicon) {
                if (!UrlPolicy.isInternal(url)) { view.stopLoading(); showError("页面跳转超出试用版范围，已停止加载。"); }
            }
            @Override public boolean shouldOverrideUrlLoading(WebView view, WebResourceRequest request) {
                String value = request.getUrl().toString();
                if (UrlPolicy.isInternal(value)) return false;
                if (request.isForMainFrame() && request.hasGesture() && UrlPolicy.isEvidenceLink(value)) openEvidence(request.getUrl());
                else if (request.isForMainFrame()) toast("该地址不在试用版允许的页面范围内。");
                return true;
            }
            @Override public void onPageFinished(WebView view, String url) {
                if (!UrlPolicy.isInternal(url)) { view.stopLoading(); loadHome(); }
            }
            @Override public void onReceivedSslError(WebView view, SslErrorHandler handler, SslError error) {
                handler.cancel();
                showError("连接证书校验失败，已停止加载。请检查网络后重试。");
            }
            @Override public void onReceivedError(WebView view, WebResourceRequest request, WebResourceError error) {
                if (request.isForMainFrame()) showError("暂时无法连接真妍盾。请检查网络后重试。");
            }
            @Override public void onReceivedHttpError(WebView view, WebResourceRequest request, WebResourceResponse response) {
                if (request.isForMainFrame()) showError("服务暂时不可用（HTTP " + response.getStatusCode() + "），请稍后重试。");
            }
        });
        web.setWebChromeClient(new WebChromeClient() {
            @Override public void onProgressChanged(WebView view, int value) {
                progress.setProgress(value);
                progress.setVisibility(value >= 100 ? View.GONE : View.VISIBLE);
            }
            @Override public void onPermissionRequest(PermissionRequest request) { request.deny(); }
            @Override public boolean onShowFileChooser(WebView view, ValueCallback<Uri[]> callback, FileChooserParams params) {
                cancelFiles();
                if (!UrlPolicy.isInternal(view.getUrl())) { callback.onReceiveValue(null); return true; }
                pendingFiles = callback;
                Intent picker = new Intent(Intent.ACTION_OPEN_DOCUMENT);
                picker.addCategory(Intent.CATEGORY_OPENABLE);
                picker.setType("*/*");
                picker.putExtra(Intent.EXTRA_MIME_TYPES, MEDIA_TYPES);
                picker.putExtra(Intent.EXTRA_ALLOW_MULTIPLE, params.getMode() == FileChooserParams.MODE_OPEN_MULTIPLE);
                picker.addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION);
                try { startActivityForResult(picker, PICK_MEDIA); }
                catch (ActivityNotFoundException error) { cancelFiles(); toast("设备没有可用的文件选择器。"); }
                return true;
            }
        });
        // No saved browsing state is restored; old or external pages cannot re-enter.
        loadHome();
    }

    private void loadHome() {
        errorPanel.setVisibility(View.GONE);
        web.setVisibility(View.VISIBLE);
        web.loadUrl(UrlPolicy.HOME);
    }
    private void showError(String value) {
        errorMessage.setText(value);
        errorPanel.setVisibility(View.VISIBLE);
        web.setVisibility(View.GONE);
        progress.setVisibility(View.GONE);
    }
    private void toast(String value) { Toast.makeText(this, value, Toast.LENGTH_LONG).show(); }
    private void openEvidence(Uri uri) {
        try { startActivity(new Intent(Intent.ACTION_VIEW, uri).addCategory(Intent.CATEGORY_BROWSABLE)); }
        catch (ActivityNotFoundException error) { toast("设备没有可用浏览器。"); }
    }
    private void cancelFiles() {
        if (pendingFiles != null) { pendingFiles.onReceiveValue(null); pendingFiles = null; }
    }

    private boolean usableMedia(Uri uri) {
        if (uri == null || !"content".equals(uri.getScheme()) || uri.getAuthority() == null
                || uri.getAuthority().startsWith(getPackageName())) return false;
        try {
            if (!permittedTypes.contains(getContentResolver().getType(uri))) return false;
            try (AssetFileDescriptor file = getContentResolver().openAssetFileDescriptor(uri, "r")) {
                return file != null && (file.getLength() == AssetFileDescriptor.UNKNOWN_LENGTH || file.getLength() <= MAX_BYTES);
            }
        } catch (Exception error) { return false; }
    }

    @Override protected void onActivityResult(int requestCode, int resultCode, Intent data) {
        super.onActivityResult(requestCode, resultCode, data);
        if (requestCode != PICK_MEDIA || pendingFiles == null) return;
        ValueCallback<Uri[]> callback = pendingFiles;
        pendingFiles = null;
        if (resultCode != RESULT_OK || data == null || !UrlPolicy.isInternal(web.getUrl())) { callback.onReceiveValue(null); return; }
        ArrayList<Uri> selected = new ArrayList<>();
        ClipData clip = data.getClipData();
        if (clip != null) {
            if (clip.getItemCount() > 4) { callback.onReceiveValue(null); toast("一次最多选择 4 个图片或视频。"); return; }
            for (int index = 0; index < clip.getItemCount(); index++) selected.add(clip.getItemAt(index).getUri());
        } else if (data.getData() != null) selected.add(data.getData());
        for (Uri uri : selected) if (!usableMedia(uri)) { callback.onReceiveValue(null); toast("请选择支持的图片或视频，每个文件不超过 200 MB。"); return; }
        callback.onReceiveValue(selected.isEmpty() ? null : selected.toArray(new Uri[0]));
    }

    @Override public void onBackPressed() {
        if (web.canGoBack()) web.goBack(); else super.onBackPressed();
    }
    @Override protected void onPause() { if (web != null) web.onPause(); super.onPause(); }
    @Override protected void onResume() { super.onResume(); if (web != null) web.onResume(); }
    @Override protected void onDestroy() {
        cancelFiles();
        if (web != null) { web.stopLoading(); web.destroy(); }
        super.onDestroy();
    }
}
