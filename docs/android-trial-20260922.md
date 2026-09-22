# Android 试装工程与验证记录

日期：2026-09-22。对应 9/19 会议提出的 Android 试装需求。

已经完成独立的轻量 WebView 工程，入口为现有 HTTPS 产品 `https://beautyproof-h5.yaowen-hu.chatgpt.site/`。**本机缺少 Android SDK / Build Tools，因此尚未生成 APK，也没有手机安装或真机验收。** 下面的源码检查和纯 Java 测试不能替代 Android 编译、安装和业务验证。

## 选择与范围

- 用平台原生 Java / WebView，不增加 React Native、Capacitor、第三方原生依赖或另一份业务实现。
- Android 最低 API 26（Android 8），compile/target SDK 35；固定 AGP 8.9.2、Gradle 8.11.1。没有宣称这是应用商店当前上架配置。
- 网页更新后壳内显示新版本，不把网站变成本地离线应用。网站的云读取、模型额度、内容限制继续适用。
- 包名 `com.beautyproof.trial.debug`；debug 证书只在 `android/build/debug.keystore` 本地生成，标识 `BeautyProof Local Debug`。不使用用户/公司正式签名，不上传应用商店。
- 不接入个人小红书账号，不复制浏览器 Cookie，也不将 Android 设备作为读取服务器。

## 本机实查

| 项目 | 结果 |
| --- | --- |
| Java / Javac | 22.0.1，可运行；实际安装位置 `C:\Program Files\Java\jdk-22` |
| keytool | JDK 内有工具，未加入 PATH；构建脚本可由 `java.home` 自动定位，无需改全局 PATH |
| Android SDK | 环境变量、标准目录、既有工作目录及 Unity 安装目录均未发现所需平台文件 |
| Build Tools 35.0.0 | 没有 `aapt2.exe`、`apksigner.bat`、`zipalign.exe` |
| Gradle | 未安装；已随工程提供官方 wrapper，尚未下载 8.11.1 的完整发行包 |
| ADB | 已有，可执行；`adb devices -l` 本次返回空设备列表 |
| APK / 安装 | 都未完成，不应发送一个不存在的 APK 下载链接 |

没有安装 SDK/模拟器，没有修改全局配置，也没有进行任何设备安装。只下载了约 55 KB 的官方 Gradle wrapper 文件，并核对其官方 SHA-256。

## 代码与控制

- `android/app/src/main/java/com/beautyproof/trial/MainActivity.java`：固定首屏、进度、连接错误与重新加载、返回键、系统文件选择器。
- `UrlPolicy.java`：WebView 内只允许产品精确 HTTPS 域名和默认 443 端口；拒绝用户信息段、伪造后缀、HTTP、私有 scheme。
- PubMed、PMC、DOI、EU 及中国政府网站证据链接只在用户点击后通过系统浏览器打开。其他域名不在壳内执行；自动跨域跳转被阻止。
- TLS 错误一律 `handler.cancel()`；仅系统证书信任、禁用明文流量、禁用混合内容，不存在 SSL 忽略开关。
- 无 `addJavascriptInterface`，禁止 `file://` 访问与通用文件访问；不打开相机/麦克风权限。
- 文件选择由系统 `ACTION_OPEN_DOCUMENT` 触发，允许 JPEG / PNG / WebP / MP4 / QuickTime，最多 4 项、已知长度每项最多 200 MB，与现有网页入口一致；仅接受用户授权的 `content://` URI。没有申请整个存储空间权限或长期保留 URI 授权。文件内容仍需由网页解析器验证。
- `setAllowContentAccess(true)` 用于用户选择的媒体读取，不允许 `content://` 页面导航。`file://` 相关访问均关闭。
- 原始上传文件仍按网页流程在客户端处理；提取文字传给网站。没有额外添加原生采集或上传服务。

## 本次已运行的检查

```powershell
.\android\check-policy.ps1
node android/verify-project.mjs
.\android\build-debug.ps1 -CheckOnly
```

- `UrlPolicy` 使用真实 `javac --release 17` 编译，并通过 27 个纯 Java 断言，覆盖域名伪装、scheme、端口、用户名、官方证据域名。
- 16 个工程静态断言通过：权限、TLS、桥接、文件选择、版本、POST 主页面拦截和 wrapper 完整性等。
- AndroidManifest 和三份 XML 资源均通过 XML 解析。
- 构建预检明确返回 `toolchain_missing`，结果在 `android/build/preflight.json`。没有把预检失败算成构建成功。
- 官方 wrapper JAR SHA-256：`2db75c40782f5e8ba1fc278a5574bab070adccb2d21ca5a6e5ed840888448046`。其来源、文件大小及完整发行包校验值保存在 `android/gradle/wrapper/provenance.json`。

## 有 SDK 后的可执行构建步骤

提供已安装、已接受相应许可的 SDK，其中包含 `platforms;android-35` 和 `build-tools;35.0.0`，然后执行：

```powershell
.\android\build-debug.ps1 -SdkPath '已有 SDK 的绝对目录'
```

脚本只在当前进程设置环境并于结束还原，将 Gradle 缓存、debug 密钥和产物保存在 `android/` 内。首次构建会由官方 wrapper 下载固定 Gradle 8.11.1 和构建依赖；不会自动安装 SDK或接受许可。成功后执行 `apksigner verify`、`zipalign -c`，记录 APK 的 SHA-256。

预期产物：`android/app/build/outputs/apk/debug/app-debug.apk`。此路径目前没有产物。

## 仍需真实设备验证

至少要验证：启动及后退、网址加载、文字分析、粘贴新小红书分享链接、图片/视频选择与取消、OCR 模型下载、上传大文件拒绝、引用在外部浏览器打开、断网重试、证书拒绝和系统字体缩放。网页的 `window.print()` / 保存 PDF 在 WebView 上尚未做原生适配，不声称支持。设备断网时没有离线分析；弱设备 OCR/视频性能仍未知。

## 在线添加到桌面入口

新增 `public/manifest.webmanifest` 和本地 SVG 图标 `public/icons/beautyproof.svg`。现已在 `app/layout.tsx` 的 metadata 关联 `manifest: '/manifest.webmanifest'`；网页能够发现该安装描述。

这只是在线网页的安装描述，不含 service worker，也没有真机确认浏览器会显示安装按钮。不能用“可添加桌面图标”代替“已生成并安装 APK”。

## 官方依据

- [Android Gradle Plugin 8.9 兼容性](https://developer.android.com/build/releases/agp-8-9-0-release-notes)：固定本工程 AGP/Gradle/Build Tools 组合。
- [Android 命令行构建](https://developer.android.com/build/building-cmdline)：debug APK 构建、签名和安装的区别。
- [WebView 文件访问与文件选择安全](https://developer.android.com/privacy-and-security/risks/webview-unsafe-file-inclusion)：本壳关闭文件 URL 和混合内容，限制用户媒体选择。
- [WebViewClient](https://developer.android.com/reference/android/webkit/WebViewClient)：连接和证书错误处理。

上述资料于 2026-09-22 核阅；本工程未发布，也未宣称已通过真机验收。
