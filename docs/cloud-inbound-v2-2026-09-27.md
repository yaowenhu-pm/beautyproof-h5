# 小红书匿名读取：Sites → ECS v2 入站备用路径

状态（2026-09-27）：代码和本机真实 HTTP 契约已完成，**生产默认关闭，公网端到端未通过**。这条路径用于解决 ECS 主动回调 Sites Worker 时先被 Cloudflare 返回 403 的连接问题；它没有证明小红书任意链接可匿名读取，也没有解决备案。

## 数据路径

浏览器向本站 `/api/reader-jobs` 提交公开作品链接。Sites Worker 用专用 Ed25519 私钥签名 HTTPS 请求，向 ECS `/v2/xhs/jobs` 提交及轮询。本站 D1 只向浏览器发独立任务令牌，ECS 任务令牌留在服务端。结果须再次通过作品 ID、正文、图片数量与顺序校验。图片由 ECS 的任务媒体接口返回原始字节，本站重新计算 SHA-256 后才给浏览器；CDN 地址或签名变化不能代替字节核验。

环境开关 `BEAUTYPROOF_XHS_INBOUND_ENABLED` 默认 `false`。开启后还必须同时配置准确的 `BEAUTYPROOF_XHS_INBOUND_URL`（HTTPS，路径为 `/v2/xhs/jobs`）及专用 `BEAUTYPROOF_XHS_INBOUND_PRIVATE_KEY`。不要把私钥放在 Git、网页或 URL 中。D1 需先应用 `0005_anonymous_inbound_reader.sql`。旧出站桥接路径未删除，默认行为不变。

## 已验与未验

- 本机 `job-server.mjs` HTTP 回环契约通过：签名认证、任务令牌隔离、13 张图片顺序与跨批次入库、错误身份/媒体路径拒绝、篡改字节拒绝。旧匿名队列与 v2 服务端/桥接测试通过；TypeScript、Lint 和构建通过。
- 2026-09-26 ECS 内部测试曾两次读到固定公开样本 `6a8e60620000000025019b8d` 的正文与 3 张图片；另一条样本不可访问。此结果不等于网站端到端可用，也不代表广泛链接成功率。
- 尚未配置 `reader.yaowenhu.cn` 的 DNS、有效 TLS、Nginx v2 路由及成对密钥；Sites 尚未向真实 ECS HTTPS 入口提交 v2 作业。ECS 1 Mbps 出口下的多图延迟与失败率仍需测量。
- `yaowenhu.cn` 的 ICP 备案仍在审核；四川个人备案与实际接入服务商的关系需按阿里云和 Sites 的实际部署拓扑确认。备案通过、DNS/证书可用，也仍需单独做国内访问、站点→ECS 回源、正文和完整图片逐张核对。

启用前的验收应固定样本、保留失败和跳过，逐条核对作品 ID、正文、源图张数/顺序与字节哈希。遇到平台登录、验证码或不可访问页面即记录限制，不使用个人账号、浏览器 Cookie、旧正文缓存或付费 API 冒充匿名读取。
