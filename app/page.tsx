'use client';

import { useRef, useState } from 'react';
import type { ChangeEvent, DragEvent } from 'react';

type InputMode = 'link' | 'upload' | 'text';
type ReportTab = 'overview' | 'evidence' | 'sources';

type UploadItem = {
  file: File;
  kind: 'image' | 'video' | 'text';
  preview: string;
};

const inputTabs: { id: InputMode; label: string }[] = [
  { id: 'link', label: '链接检测' },
  { id: 'upload', label: '上传素材' },
  { id: 'text', label: '输入文字' },
];

const analysisSteps = [
  ['解析内容来源', '识别平台、作者与媒体资源'],
  ['提取可核验声明', 'OCR、语音转写与原子声明拆分'],
  ['执行视觉取证', '生成检测、拼接定位与精修分析'],
  ['检索专业证据', '比对法规、备案与功效依据'],
  ['生成鉴真报告', '融合信号并给出处置建议'],
];

const evidenceCards = [
  {
    level: 'high',
    label: '高风险声明',
    quote: '“连续使用 7 天，焕白一个色号”',
    verdict: '缺少产品级功效证据支持',
    detail: '检测到明确的时间与量化承诺。公开文案未提供人体功效试验、样本量或评价方法，不能由单一原料功效直接推导至产品效果。',
    source: '《化妆品功效宣称评价规范》第 6、13 条',
  },
  {
    level: 'medium',
    label: '视觉可疑',
    quote: '前后对比图的皮肤区域',
    verdict: '存在局部平滑与亮度重映射',
    detail: '两张对比图的人脸姿态接近，但面部曝光差异明显；右图皮肤高频纹理减少 38%，建议查看未经压缩的原始文件。',
    source: '视觉取证模型组合 · 置信度 0.81',
  },
  {
    level: 'low',
    label: '信息提示',
    quote: '“核心成分 377”',
    verdict: '成分存在不等于产品功效成立',
    detail: '可确认该表述属于原料信息，但当前内容未提供配方浓度、稳定性与产品级评价摘要，因此标记为“证据不足”而非“虚假”。',
    source: '国家药监局功效宣称公开要求',
  },
];

function extractUrl(value: string) {
  return value.match(/https?:\/\/[^\s]+/i)?.[0]?.replace(/[，。；、)）\]]+$/, '') ?? value.trim();
}

function getPlatform(value: string) {
  const url = extractUrl(value).toLowerCase();
  if (/(xiaohongshu|xhslink|xhs\.cn)/.test(url)) return { name: '小红书', className: 'xhs' };
  if (/(douyin|iesdouyin)/.test(url)) return { name: '抖音', className: 'dy' };
  return null;
}

function formatSize(bytes: number) {
  if (bytes < 1024 * 1024) return `${Math.max(1, Math.round(bytes / 1024))}KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)}MB`;
}

export default function Home() {
  const [mode, setMode] = useState<InputMode>('link');
  const [link, setLink] = useState('');
  const [text, setText] = useState('');
  const [files, setFiles] = useState<UploadItem[]>([]);
  const [error, setError] = useState('');
  const [running, setRunning] = useState(false);
  const [step, setStep] = useState(0);
  const [showReport, setShowReport] = useState(false);
  const [reportTab, setReportTab] = useState<ReportTab>('overview');
  const [sourceLabel, setSourceLabel] = useState('小红书图文');
  const fileInput = useRef<HTMLInputElement>(null);
  const reportRef = useRef<HTMLElement>(null);

  const platform = getPlatform(link);

  const addFiles = (incoming: FileList | File[]) => {
    setError('');
    const next: UploadItem[] = [];
    for (const file of Array.from(incoming)) {
      if (file.size > 200 * 1024 * 1024) {
        setError(`${file.name} 超过 200MB，请压缩后重试。`);
        continue;
      }
      const kind = file.type.startsWith('image/') ? 'image' : file.type.startsWith('video/') ? 'video' : 'text';
      next.push({ file, kind, preview: kind === 'text' ? '' : URL.createObjectURL(file) });
    }
    setFiles((current) => [...current, ...next].slice(0, 8));
  };

  const onFileChange = (event: ChangeEvent<HTMLInputElement>) => {
    if (event.target.files) addFiles(event.target.files);
    event.target.value = '';
  };

  const onDrop = (event: DragEvent<HTMLDivElement>) => {
    event.preventDefault();
    addFiles(event.dataTransfer.files);
  };

  const validate = () => {
    if (mode === 'link' && !platform) return '请输入有效的小红书或抖音公开作品链接。';
    if (mode === 'upload' && files.length === 0) return '请先上传至少一张图片、一个视频或文本文件。';
    if (mode === 'text' && text.trim().length < 8) return '请至少输入 8 个字，方便拆分可核验声明。';
    return '';
  };

  const runAnalysis = async (sample = false) => {
    const validationError = sample ? '' : validate();
    if (validationError) {
      setError(validationError);
      return;
    }
    setError('');
    setRunning(true);
    setShowReport(false);
    setStep(0);
    setSourceLabel(sample ? '小红书图文 · 示例' : mode === 'link' ? `${platform?.name}公开作品` : mode === 'upload' ? `${files.length} 个本地素材` : '用户输入文案');
    for (let index = 0; index < analysisSteps.length; index += 1) {
      setStep(index);
      await new Promise((resolve) => setTimeout(resolve, index === 0 ? 520 : 460));
    }
    setRunning(false);
    setShowReport(true);
    setReportTab('overview');
    setTimeout(() => reportRef.current?.scrollIntoView({ behavior: 'smooth', block: 'start' }), 80);
  };

  const removeFile = (index: number) => {
    setFiles((current) => {
      const item = current[index];
      if (item.preview) URL.revokeObjectURL(item.preview);
      return current.filter((_, itemIndex) => itemIndex !== index);
    });
  };

  return (
    <main className="site-shell">
      <header className="topbar">
        <a className="brand" href="#top" aria-label="真妍盾首页">
          <span className="brand-mark">真</span>
          <span><strong>真妍盾</strong><small>BEAUTYPROOF</small></span>
        </a>
        <nav aria-label="主导航">
          <a className="nav-active" href="#detect">内容检测</a>
          <a href="#method">技术原理</a>
          <a href="#creator">创作者保护</a>
        </nav>
        <a className="ghost-button" href="#demo-report">示例报告</a>
      </header>

      <section className="hero" id="detect">
        <div className="hero-copy">
          <span className="eyebrow"><i /> 欧莱雅 AI 内容鉴真方案</span>
          <h1>每一份真实，<br /><em>都值得被看见。</em></h1>
          <p>粘贴小红书、抖音链接，或上传图文与视频。我们从来源、篡改、宣称与合规四个维度，为美妆内容生成可解释的证据报告。</p>
          <div className="trust-row" aria-label="产品特点"><span>来源可追溯</span><b>·</b><span>风险有依据</span><b>·</b><span>结论可复核</span></div>
        </div>

        <div className="detect-card">
          <div className="card-heading">
            <div><span>内容鉴真工作台</span><small>Beta · 预计 20–40 秒完成</small></div>
            <span className="live-dot">服务正常</span>
          </div>
          <div className="tabs" role="tablist" aria-label="输入方式">
            {inputTabs.map((tab) => (
              <button key={tab.id} className={mode === tab.id ? 'tab-active' : ''} onClick={() => { setMode(tab.id); setError(''); }} role="tab" aria-selected={mode === tab.id} type="button">{tab.label}</button>
            ))}
          </div>

          {mode === 'link' && (
            <div className="link-panel input-panel">
              <label htmlFor="content-url">作品链接或分享口令</label>
              <div className={`link-input ${link && !platform ? 'input-warn' : ''}`}>
                <span>⌁</span>
                <input id="content-url" value={link} onChange={(event) => { setLink(event.target.value); setError(''); }} placeholder="粘贴小红书或抖音作品链接" />
                <button type="button" onClick={() => runAnalysis()}>开始检测</button>
              </div>
              <div className="platforms">
                <span className="xhs">小红书</span><span className="dy">♪ 抖音</span>
                {platform ? <small className="recognized">✓ 已识别为{platform.name}</small> : <small>公开作品 · 图文/视频</small>}
              </div>
            </div>
          )}

          {mode === 'upload' && (
            <div className="input-panel">
              <input ref={fileInput} className="visually-hidden" type="file" multiple accept="image/jpeg,image/png,image/webp,video/mp4,video/quicktime,text/plain" onChange={onFileChange} />
              <div className="dropzone" onDragOver={(event) => event.preventDefault()} onDrop={onDrop} onClick={() => fileInput.current?.click()} role="button" tabIndex={0} onKeyDown={(event) => { if (event.key === 'Enter') fileInput.current?.click(); }}>
                <span className="upload-icon">＋</span><strong>上传图片、视频或文本</strong><span>点击选择或拖拽到这里 · 单文件不超过 200MB</span>
              </div>
              {files.length > 0 && <div className="file-list">{files.map((item, index) => (
                <div className="file-chip" key={`${item.file.name}-${index}`}>
                  {item.kind === 'image' ? <img src={item.preview} alt="上传预览" /> : item.kind === 'video' ? <video src={item.preview} muted /> : <span className="text-file">文</span>}
                  <span><strong>{item.file.name}</strong><small>{formatSize(item.file.size)}</small></span>
                  <button type="button" aria-label={`移除 ${item.file.name}`} onClick={() => removeFile(index)}>×</button>
                </div>
              ))}</div>}
              {files.length > 0 && <button className="wide-action" type="button" onClick={() => runAnalysis()}>分析 {files.length} 个素材</button>}
            </div>
          )}

          {mode === 'text' && (
            <div className="text-panel input-panel">
              <label htmlFor="claim-text">需要核验的文案</label>
              <textarea id="claim-text" value={text} onChange={(event) => { setText(event.target.value); setError(''); }} placeholder="粘贴种草文案、商品宣称或评论区话术…" />
              <div className="text-meta"><span>{text.length}/3000</span><span>自动拆分功效、时限与量化声明</span></div>
              <button type="button" onClick={() => runAnalysis()}>分析这段文字</button>
            </div>
          )}

          {error && <p className="form-error" role="alert">{error}</p>}
          <button className="sample-link" type="button" onClick={() => runAnalysis(true)}>没有素材？查看「7天焕白」示例报告 <span>→</span></button>
          <p className="privacy-note">上传内容仅用于本次检测，不会用于模型训练</p>

          {running && (
            <div className="analysis-overlay" role="status" aria-live="polite">
              <div className="scanner-orbit"><span>{step + 1}</span></div>
              <strong>{analysisSteps[step][0]}</strong><p>{analysisSteps[step][1]}</p>
              <div className="progress-track"><i style={{ width: `${((step + 1) / analysisSteps.length) * 100}%` }} /></div>
              <div className="mini-steps">{analysisSteps.map((item, index) => <span className={index <= step ? 'done' : ''} key={item[0]}>{index < step ? '✓' : index + 1}</span>)}</div>
            </div>
          )}
        </div>
      </section>

      <section className="signal-strip" aria-label="检测维度">
        <article><span>01</span><div><strong>来源凭证</strong><small>原创指纹 · C2PA · 元数据</small></div><b>可追溯</b></article>
        <article><span>02</span><div><strong>视觉取证</strong><small>AI 生成 · 拼接 · 人脸精修</small></div><b>多模型</b></article>
        <article><span>03</span><div><strong>宣称核验</strong><small>功效依据 · 成分逻辑 · 法规</small></div><b>有引用</b></article>
        <article><span>04</span><div><strong>行动建议</strong><small>风险分级 · 申诉 · 举报路径</small></div><b>可导出</b></article>
      </section>

      {showReport && (
        <section className="report-section" id="demo-report" ref={reportRef}>
          <div className="section-kicker">ANALYSIS REPORT</div>
          <div className="report-header">
            <div><h2>内容鉴真报告</h2><p>{sourceLabel} · 报告编号 BP-2026-0824-017</p></div>
            <div className="report-actions"><button type="button" onClick={() => window.print()}>导出报告</button><button type="button" onClick={() => navigator.clipboard?.writeText(window.location.href)}>复制链接</button></div>
          </div>

          <div className="report-summary">
            <div className="risk-ring"><span>72</span><small>综合风险</small></div>
            <div className="summary-copy"><span className="risk-pill">建议谨慎采信</span><h3>内容存在两项关键风险，暂不足以支持其功效结论</h3><p>发现量化时限承诺缺少产品级证据，同时前后对比图存在影响视觉判断的后期处理。未发现明确的全图 AI 生成证据。</p></div>
            <div className="confidence"><small>证据置信度</small><strong>高</strong><span>3 个独立信号一致</span></div>
          </div>

          <div className="score-grid">
            <article><div><span>来源可信度</span><b className="warn">待核验</b></div><strong>42<small>/100</small></strong><i><em style={{ width: '42%' }} /></i><p>未发现可验证的原创凭证</p></article>
            <article><div><span>视觉完整性</span><b className="warn">存疑</b></div><strong>58<small>/100</small></strong><i><em style={{ width: '58%' }} /></i><p>局部平滑与曝光差异明显</p></article>
            <article><div><span>宣称证据度</span><b className="danger">不足</b></div><strong>28<small>/100</small></strong><i><em style={{ width: '28%' }} /></i><p>1 项关键声明缺少依据</p></article>
            <article><div><span>合规安全度</span><b className="ok">一般</b></div><strong>67<small>/100</small></strong><i><em style={{ width: '67%' }} /></i><p>未发现医疗化用语</p></article>
          </div>

          <div className="report-tabs" role="tablist" aria-label="报告内容">
            {([['overview', '关键结论'], ['evidence', '全部证据 3'], ['sources', '参考来源 5']] as [ReportTab, string][]).map(([id, label]) => <button key={id} type="button" role="tab" aria-selected={reportTab === id} onClick={() => setReportTab(id)} className={reportTab === id ? 'active' : ''}>{label}</button>)}
          </div>

          {reportTab === 'overview' && (
            <div className="report-body">
              <div className="evidence-list">
                {evidenceCards.map((card, index) => <article className={`evidence-card ${card.level}`} key={card.quote}>
                  <div className="evidence-index">0{index + 1}</div>
                  <div><span className="evidence-label">{card.label}</span><blockquote>{card.quote}</blockquote><h4>{card.verdict}</h4><p>{card.detail}</p><a href="#sources">依据：{card.source} <span>↗</span></a></div>
                </article>)}
              </div>
              <aside className="visual-panel">
                <div className="visual-title"><div><strong>视觉取证图</strong><small>疑似处理区域热力图</small></div><span>置信度 81%</span></div>
                <div className="forensic-visual"><div className="face-silhouette"><i /><b /><em /></div><div className="heat heat-one" /><div className="heat heat-two" /><div className="scan-lines" /><span className="area-label label-one">皮肤平滑 +38%</span><span className="area-label label-two">亮度差异 +21%</span></div>
                <div className="legend"><span><i className="safe" />原始纹理</span><span><i className="suspicious" />疑似处理</span></div>
                <div className="agent-note"><span>✦</span><div><strong>Agent 判断</strong><p>检测信号不能单独证明造假，建议调取原图或创作者凭证后复核。</p></div></div>
              </aside>
            </div>
          )}

          {reportTab === 'evidence' && (
            <div className="evidence-table">
              <div className="table-row table-head"><span>对象</span><span>检测器</span><span>结果</span><span>置信度</span></div>
              <div className="table-row"><span>完整图片</span><span>AI 生成检测</span><span className="ok-text">未发现明确生成痕迹</span><strong>0.24</strong></div>
              <div className="table-row"><span>面部皮肤区域</span><span>局部篡改定位</span><span className="danger-text">疑似精修</span><strong>0.81</strong></div>
              <div className="table-row"><span>“7天焕白”</span><span>声明—证据检索</span><span className="danger-text">证据不足</span><strong>0.89</strong></div>
              <div className="table-row"><span>“核心成分377”</span><span>成分逻辑核验</span><span>无法推出产品功效</span><strong>0.76</strong></div>
            </div>
          )}

          {reportTab === 'sources' && (
            <div className="source-list" id="sources">
              <a href="https://www.samr.gov.cn/zw/zfxxgk/fdzdgknr/bgt/art/2023/art_9f8b70e79a2242df96c6c290a0ac425b.html" target="_blank" rel="noreferrer"><span>官方法规</span><strong>《化妆品监督管理条例》</strong><small>国家市场监督管理总局 · 第 22、43 条</small><b>↗</b></a>
              <a href="https://english.nmpa.gov.cn/2021-04/09/c_654820.htm" target="_blank" rel="noreferrer"><span>官方规范</span><strong>《化妆品功效宣称评价规范》</strong><small>国家药品监督管理局</small><b>↗</b></a>
              <a href="https://spec.c2pa.org/specifications/" target="_blank" rel="noreferrer"><span>技术标准</span><strong>C2PA Content Credentials 2.4</strong><small>内容来源与编辑历史验证</small><b>↗</b></a>
              <a href="https://openaccess.thecvf.com/content/CVPR2023/html/Guillaro_TruFor_Leveraging_All-Round_Clues_for_Trustworthy_Image_Forgery_Detection_and_CVPR_2023_paper.html" target="_blank" rel="noreferrer"><span>研究论文</span><strong>TruFor 图像篡改检测与定位</strong><small>CVPR 2023 · 研究参考</small><b>↗</b></a>
            </div>
          )}

          <div className="action-plan">
            <div><span>下一步建议</span><h3>先找原始凭证，再判断是否采信功效结论</h3></div>
            <ol><li><b>1</b>向发布者索取未经平台压缩的前后对比原图</li><li><b>2</b>查询产品备案与功效宣称评价摘要</li><li><b>3</b>避免仅依据单一成分与达人体验作购买决定</li></ol>
          </div>
        </section>
      )}

      <section className="creator-section" id="creator">
        <div className="section-kicker">FOR CREATORS</div>
        <div className="split-heading"><div><h2>不只识别假内容，<br />更要保护真创作。</h2></div><p>创作者上传原始内容后，系统生成内容指纹与可验证凭证。即使作品被裁剪、压缩或改写，也能找回来源并生成维权证据包。</p></div>
        <div className="creator-flow">
          <article><span>01</span><div className="flow-icon">原</div><h3>登记原创</h3><p>保存文件指纹、感知哈希、发布时间与原创声明。</p></article>
          <i>→</i><article><span>02</span><div className="flow-icon">纹</div><h3>生成凭证</h3><p>写入 C2PA 内容凭证，并建立可抗压缩的软绑定。</p></article>
          <i>→</i><article><span>03</span><div className="flow-icon">比</div><h3>发现篡改</h3><p>定位改图、换字、裁剪及跨平台搬运的差异。</p></article>
          <i>→</i><article><span>04</span><div className="flow-icon">证</div><h3>导出证据</h3><p>一键生成原始版本、差异标注与时间线报告。</p></article>
        </div>
        <button type="button" className="creator-cta" onClick={() => { setMode('upload'); document.querySelector('#detect')?.scrollIntoView({ behavior: 'smooth' }); }}>登记我的原创内容 <span>→</span></button>
      </section>

      <section className="method-section" id="method">
        <div className="section-kicker">EVIDENCE, NOT GUESSING</div>
        <div className="split-heading"><h2>四条证据线，<br />共同回答“凭什么”。</h2><p>系统不会因为“检测到 AI”就判定造假，也不会让大模型凭感觉打分。每个结论都必须回到可复核的来源、模型信号或官方依据。</p></div>
        <div className="method-grid">
          <article><span>PROVENANCE</span><h3>来源与历史</h3><p>C2PA、EXIF、文件哈希与感知指纹，确认内容从哪里来、经历过什么。</p><small>C2PA SDK · pHash</small></article>
          <article><span>FORENSICS</span><h3>视觉取证</h3><p>融合全图生成检测与局部篡改定位，输出热力图与不确定性。</p><small>CO-SPY 思路 · TruFor 研究参考</small></article>
          <article><span>CLAIMS</span><h3>声明核验</h3><p>OCR 与语音转写后拆分原子声明，再检索法规、备案与产品级证据。</p><small>PaddleOCR · Evidence RAG</small></article>
          <article><span>DECISION</span><h3>Agent 裁决</h3><p>使用确定性规则融合证据，保留“证据不足”，不给无依据的二元判决。</p><small>可审计状态机 · 人工复核</small></article>
        </div>
      </section>

      <footer><a className="brand" href="#top"><span className="brand-mark">真</span><span><strong>真妍盾</strong><small>BEAUTYPROOF</small></span></a><p>让每一份真实，都有证据。</p><span>原型演示 · 结论不替代专业鉴定或监管认定</span></footer>
    </main>
  );
}
