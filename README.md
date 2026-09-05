# 真妍盾 BeautyProof

面向欧莱雅黑客松赛道二的美妆宣传核验 H5。回答“这段推荐的说法有没有依据”，不将内容分析包装为实物真假鉴定。

体验：https://beautyproof-h5.yaowen-hu.chatgpt.site/
源码：https://github.com/yaowenhu-pm/beautyproof-h5

现有站点访问权限为公开。页面访问不需要 ChatGPT 账号；分析还取决于平台可访问性、DeepSeek 服务与剩余演示额度。

## 本版流程

链接 / 文字 / 图片 / 视频 → 提取文字 → 最多4段证据检索 → DeepSeek V4 Flash → 引文与结构校验 → 简洁报告。

- 支持小红书、抖音分享文本、短链及常见作品链接，保留签名参数，限制跳转域名。
- 识别标题/摘要、正文、媒体的差异。平台拒绝读取时保留链接，并提供补充文字、截图、原视频入口。不保证所有平台链接可读，不绕过登录/验证码或风控。
- 图片在浏览器执行中英文OCR；视频保留抽帧OCR与最多前24秒Whisper转写。初次模型下载较慢、弱设备或网络可能失败。基于文字快速分析时明确不覆盖全部视频。
- 服务端一次V4 Flash生成，关闭思考，无付费自动重试、无Pro升级。无需本地大语言模型或向量模型，无需用户电脑充当网站服务器。
- 5段人工整理知识摘要，使用关键词/别名检索，首批30个常见INCI映射。当前没有向量检索和飞书全量入库。
- 报告首屏给具体结论，最多3项发现；可展开原文、理由、法规/资料链接，列出识别成分与分析范围，浏览器打印/保存PDF。
- 成分区分“内容提及”和“用户标记的标签截图”。只有匹配到的成分才展示；不根据产品名猜配方，不显示未经验证的安全评分。
- 引文必须是输入中的连续原文，引用id必须来自本次检索资料。风险判断必须含引用。本版无产品级功效资料，不输出“功效已获支持”；正常表述标记为语境说明，不当作功效认证。不保证自动验证语义蕴含完全正确，仍需人工抽查。
- 旧报告展示分支和旧规则代码保留；旧规则不再决定V2最终结论。V2未开放全网查重，旧指纹信息不参与真假定性。
- 相同输入、范围、资料版本与模型配置复用缓存。标题或URL不同不会错误复用另一条报告。
- 模型不可用或校验失败明确显示“未完成判断”，保留已提取内容及参考资料。

## 一元演示预算

本轮项目API总支出上限人民币1元，其中真实测试最多0.6元；不是每人1元，也不是每天自动重置。

生产D1中的 `api_calls` 表用单条原子SQL按预算条件插入预留，同时用主键防止相同输入并发扣费。输入按UTF-8字节数加协议余量保守估计，输出最多1200 tokens，均按高峰未命中价格预留。收到usage后按峰值输入/输出价记账；实际账单可能更低。网络超时或usage缺失时不释放预留，不自动重试。

官方价格核阅于2026-09-06：[DeepSeek价格页](https://api-docs.deepseek.com/zh-cn/quick_start/pricing/)。Flash高峰输入3元、输出9元/百万tokens；闲时更低。代码在北京时间2026-09-09 00:00后暂停新付费调用，需人工重新核价后更新版本，不会自行增加预算。

测试与公开网站共享一个生产账本；不要另建带真实密钥的本地账本，否则不能保证跨环境1元总上限。管理员 `GET /api/budget` 需私密 `x-beautyproof-test` 请求头，返回费用与调用汇总，不公开用户内容。测试请求带同一凭证才计入test分组。

## 本地开发

需要Node.js 22.13+。使用已有package-lock安装：

```sh
npm ci
npm run dev -- --port 3010
npm run test:v2
npm run test:rules
npx tsc --noEmit
npm run build
```

首次本地D1需要应用生成迁移。完成build后可执行：

```sh
npx wrangler d1 execute DB --local --config dist/server/wrangler.json --persist-to .wrangler/state --file drizzle/0000_solid_morph.sql
npx wrangler d1 execute DB --local --config dist/server/wrangler.json --persist-to .wrangler/state --file drizzle/0001_bored_boom_boom.sql
```

以上首次初始化命令不要对已应用的迁移重复执行。生产由Sites部署流程管理Drizzle迁移，不在请求处理时建表。

本地默认不启用付费生成：仍可检查页面、OCR、链接解析和失败提示。配置名见 `.env.example`。生产密钥用Sites运行时secret配置，不放网页、Git、URL或README。生产开关 `BEAUTYPROOF_PAID_ENABLED=true`，模型固定为 `deepseek-v4-flash`，官方地址固定为 `https://api.deepseek.com/chat/completions`。

## 资料、验收与限制

- [资料来源清单](docs/knowledge-sources.md)：记录版本、章节、访问缺失及使用边界。
- [验收记录](docs/acceptance.md)：免费检查、真实小样本结果和费用口径，不冒充大规模准确率评测。
- 飞书文档与附件尚未成功取得，待导出后补充。BEBD仅参考字段组织，没有复制其数据库或安全评分。
- 当前资料以法规和命名说明为主，没有逐产品备案核验、人体功效评价全文或实验室鉴定数据。
- OCR/ASR可能识别错误，用户可展开查看实际文字；弱设备表现未全面验证。视频不是全片逐帧分析。
- 截图上传只在浏览器解析，提取文字会发送至本站服务端与DeepSeek；成功报告及预算记录写入D1缓存。不要上传身份证、联系方式等隐私内容。当前无用户账户隔离或历史管理，不提供跨用户历史内容列表。
- 预算用尽会停止新生成，已有缓存仍可读取。API失败不自动重试，需要管理员核查账本，不通过删除费用记录“恢复”预算。
- 淘宝/拼多多、40条案例集、完整竞品/用户调研、200成分库、向量RAG、完整视频升级及全网查重后续完善。

## 代码组织

`app/page.tsx` 输入流程；`app/report-v2.tsx` 简洁报告；`app/api/resolve` 平台读取；`lib/server/analysis-v2.ts` 检索与V4分析；`lib/shared/report.ts` 校验；`lib/shared/knowledge.ts` 资料和成分；`lib/shared/budget.ts` 费用策略；`db/schema.ts` 与 `drizzle/` 持久化；`lib/client/extraction.ts` 浏览器OCR/ASR。

生产沿用Sites Cloudflare Workers + D1，不需要本机常驻服务。GitHub用于保存源码，GitHub Pages本身不能运行本项目的服务端检测API。
