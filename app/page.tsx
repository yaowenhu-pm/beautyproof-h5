'use client';

import { useRef, useState } from 'react';
import type { ChangeEvent, DragEvent } from 'react';
import { analyzeClaims, analyzeFile, textSimHash } from '@/lib/client/analysis';
import type { ClaimFinding, FileFeature } from '@/lib/client/analysis';
import { extractFilesContent, extractResolvedContent } from '@/lib/client/extraction';
import type { ContentExtraction, ResolvedContent } from '@/lib/client/extraction';
import type { EvidenceCheck } from '@/lib/shared/evidence';

type InputMode = 'link' | 'upload' | 'text';
type AppState = 'input' | 'analyzing' | 'result';

type UploadItem = {
  file: File;
  kind: 'image' | 'video' | 'text';
  preview: string;
};

type ResolveResult = {
  resolved: boolean;
  platform: 'xiaohongshu' | 'douyin';
  canonicalUrl: string;
  contentId: string;
  title: string;
  description?: string;
  author?: string;
  thumbnail?: string;
  limitation?: string;
  fetchedAt: string;
  extraction?: ResolvedContent;
};

type Match = { id: string; title: string; kind: string; similarity: number; createdAt: number };

type AnalysisReport = {
  id: string;
  createdAt: number;
  title: string;
  matches: Match[];
  claims: ClaimFinding[];
  files: FileFeature[];
  extraction: ContentExtraction;
  externalEvidence: EvidenceCheck[];
  resolver?: ResolveResult;
  coverage: string[];
  riskSignals: string[];
  verdict: string;
  confidence: '较高' | '中' | '有限';
  limitations: string[];
};

const modes: { id: InputMode; label: string; icon: string }[] = [
  { id: 'link', label: '作品链接', icon: '⌁' },
  { id: 'upload', label: '图片 / 视频', icon: '↑' },
  { id: 'text', label: '文字内容', icon: '文' },
];

const analysisSteps = [
  ['解析作品', '读取平台页面、正文和公开媒体'],
  ['抽取内容', 'ASR 口播转写、OCR 画面文字'],
  ['比对重复', '生成仅用于查重的内容特征'],
  ['核验证据', '映射官方规则并比对内容库'],
  ['生成报告', '汇总来源、媒体、宣称与证据'],
];

const stageLabels: Record<ContentExtraction['stages'][keyof ContentExtraction['stages']]['status'], string> = {
  complete: '已完成',
  partial: '部分读取',
  limited: '受限',
  not_applicable: '不适用',
};

const testText = '连续使用 7 天，焕白一个色号，100% 有效且零副作用。核心成分与医美同款，所以可以彻底祛斑。';

function extractUrl(value: string) {
  return value.match(/https?:\/\/[^\s]+/i)?.[0]?.replace(/[，。；、)）\]]+$/, '') ?? value.trim();
}

function getPlatform(value: string) {
  const url = extractUrl(value).toLowerCase();
  if (/(xiaohongshu|xhslink|xhs\.cn)/.test(url)) return { id: 'xiaohongshu', name: '小红书', mark: '小', className: 'xhs' } as const;
  if (/(douyin|iesdouyin)/.test(url)) return { id: 'douyin', name: '抖音', mark: '♪', className: 'douyin' } as const;
  return null;
}

function formatSize(bytes: number) {
  if (bytes < 1024 * 1024) return `${Math.max(1, Math.round(bytes / 1024))} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

function truncate(value: string, length = 54) {
  return value.length > length ? `${value.slice(0, length)}…` : value;
}

function formatDate(timestamp: number) {
  return new Intl.DateTimeFormat('zh-CN', { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' }).format(new Date(timestamp));
}

async function apiJson<T>(url: string, body: unknown): Promise<T> {
  const response = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  const result = await response.json() as T & { error?: string };
  if (!response.ok) throw new Error(result.error || '服务暂时不可用');
  return result;
}

export default function Home() {
  const [mode, setMode] = useState<InputMode>('link');
  const [appState, setAppState] = useState<AppState>('input');
  const [link, setLink] = useState('');
  const [text, setText] = useState('');
  const [files, setFiles] = useState<UploadItem[]>([]);
  const [error, setError] = useState('');
  const [step, setStep] = useState(0);
  const [showHelp, setShowHelp] = useState(false);
  const [report, setReport] = useState<AnalysisReport | null>(null);
  const [progressDetail, setProgressDetail] = useState('');
  const fileInput = useRef<HTMLInputElement>(null);

  const platform = getPlatform(link);
  const linkUrl = extractUrl(link);

  const addFiles = async (incoming: FileList | File[]) => {
    setError('');
    const selected = Array.from(incoming).slice(0, 4);
    const next = await Promise.all(selected.map(async (file) => {
      if (file.size > 200 * 1024 * 1024) {
        setError(`${file.name} 超过 200 MB，请压缩后重试。`);
        return null;
      }
      const kind = file.type.startsWith('image/') ? 'image' : file.type.startsWith('video/') ? 'video' : 'text';
      return { file, kind, preview: kind === 'text' ? '' : URL.createObjectURL(file) } as UploadItem;
    }));
    setFiles((current) => [...current, ...next.filter((item): item is UploadItem => item !== null)].slice(0, 4));
  };

  const onFileChange = (event: ChangeEvent<HTMLInputElement>) => {
    if (event.target.files) void addFiles(event.target.files);
    event.target.value = '';
  };

  const onDrop = (event: DragEvent<HTMLDivElement>) => {
    event.preventDefault();
    void addFiles(event.dataTransfer.files);
  };

  const removeFile = (index: number) => {
    setFiles((current) => {
      const target = current[index];
      if (target.preview) URL.revokeObjectURL(target.preview);
      return current.filter((_, itemIndex) => itemIndex !== index);
    });
  };

  const validate = (activeMode = mode, activeText = text) => {
    if (activeMode === 'link' && !platform) return '请输入有效的小红书或抖音公开作品链接。';
    if (activeMode === 'upload' && files.length === 0) return '请先选择需要检测的图片或视频。';
    if (activeMode === 'text' && activeText.trim().length < 8) return '请至少输入 8 个字。';
    return '';
  };

  const runAnalysis = async (useTestText = false) => {
    const activeMode: InputMode = useTestText ? 'text' : mode;
    const activeText = useTestText ? testText : text;
    const message = validate(activeMode, activeText);
    if (message) { setError(message); return; }

    if (useTestText) { setMode('text'); setText(testText); }
    setError('');
    setReport(null);
    setAppState('analyzing');
    setStep(0);
    setProgressDetail('正在建立内容解析任务');

    try {
      let resolver: ResolveResult | undefined;
      let features: FileFeature[] = [];
      let claims: ClaimFinding[] = [];
      let textHash: string | undefined;
      let extraction: ContentExtraction | undefined;
      let title = '未命名内容';
      let canonicalUrl: string | undefined;
      let contentId: string | undefined;
      let platformId: string | undefined;

      if (activeMode === 'link') {
        resolver = await apiJson<ResolveResult>('/api/resolve', { url: linkUrl });
        title = resolver.title;
        canonicalUrl = resolver.canonicalUrl;
        contentId = resolver.contentId;
        platformId = resolver.platform;
      } else if (activeMode === 'upload') {
        title = files[0]?.file.name ?? '本地素材';
      } else {
        title = truncate(activeText.trim(), 52);
      }

      setStep(1);
      if (activeMode === 'link') {
        const resolved = await extractResolvedContent(resolver?.extraction, setProgressDetail);
        extraction = resolved.extraction;
        features = resolved.features;
      } else if (activeMode === 'upload') {
        const localFiles = files.map((item) => item.file);
        [features, extraction] = await Promise.all([
          Promise.all(localFiles.map((file) => analyzeFile(file))),
          extractFilesContent(localFiles, '', setProgressDetail),
        ]);
      } else {
        extraction = await extractFilesContent([], activeText);
      }

      const extractedText = extraction.combinedText || activeText;
      claims = analyzeClaims(extractedText);
      if (extractedText.trim().length >= 8) textHash = textSimHash(extractedText);

      setStep(2);
      setProgressDetail('正在比对是否出现过相同或近似内容');
      await new Promise((resolve) => setTimeout(resolve, 120));

      setStep(3);
      setProgressDetail('正在匹配官方规则和历史内容');
      const result = await apiJson<AnalysisReport>('/api/analyze', {
        sourceType: activeMode,
        platform: platformId,
        canonicalUrl,
        contentId,
        title,
        textHash,
        files: features,
        claims,
        extraction,
        resolver: resolver ? { resolved: resolver.resolved, limitation: resolver.limitation, author: resolver.author, fetchedAt: resolver.fetchedAt } : undefined,
      });

      setStep(4);
      setProgressDetail('正在整理可复核的证据报告');
      await new Promise((resolve) => setTimeout(resolve, 180));
      setReport({ ...result, resolver });
      setAppState('result');
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : '检测失败，请稍后重试。');
      setAppState('input');
    }
  };

  const reset = () => {
    setFiles((current) => {
      current.forEach((item) => { if (item.preview) URL.revokeObjectURL(item.preview); });
      return [];
    });
    setLink('');
    setText('');
    setAppState('input');
    setError('');
    setReport(null);
  };

  const resolver = report?.resolver;
  const extracted = report?.extraction;
  const extractionParts = [
    extracted?.pageText ? `${extracted.pageText.length} 字正文` : '',
    extracted?.ocrText ? `${extracted.frameCount} 个画面文字` : '',
    extracted?.transcript ? `${extracted.transcript.length} 字口播` : '',
  ].filter(Boolean);
  const contentLimited = Boolean(resolver && !resolver.resolved && !extracted?.combinedText);
  const needsReview = Boolean(report?.riskSignals.length);
  const resultHeadline = contentLimited ? '暂时无法完成内容核验' : needsReview ? '有内容需要进一步核对' : '暂未发现明显问题';
  const resultDescription = contentLimited
    ? '平台只返回了作品标识，没有开放正文或媒体。上传原视频后才能分析口播、画面和宣称。'
    : needsReview
      ? '系统找到了需要确认的表述或重复记录。它们不是“造假判定”，但值得查看依据。'
      : '本次可读取的内容中没有发现明显风险；这不代表内容一定真实或功效一定成立。';
  const userFindings = report ? [
    {
      tone: contentLimited ? 'limited' : 'ok',
      icon: contentLimited ? '!' : '✓',
      title: '内容读取',
      detail: contentLimited ? '只识别到作品链接，未取得正文和媒体' : extractionParts.length ? `已读取 ${extractionParts.join('、')}` : '已读取本次输入内容',
    },
    {
      tone: report.externalEvidence.length ? 'attention' : 'ok',
      icon: report.externalEvidence.length ? '!' : '✓',
      title: '宣称核验',
      detail: report.externalEvidence.length ? `有 ${report.externalEvidence.length} 项表述需要查看依据` : '未触发当前宣称风险规则',
    },
    {
      tone: report.matches.length ? 'attention' : 'ok',
      icon: report.matches.length ? '↗' : '✓',
      title: '重复情况',
      detail: report.matches.length ? `发现 ${report.matches.length} 条系统内相同或近似记录` : '系统历史记录中暂未发现重复',
    },
  ] : [];
  const actionAdvice = contentLimited
    ? '下载或保存原视频后上传，再进行完整分析。'
    : report?.externalEvidence.some((item) => item.status === 'conflict')
      ? '优先打开官方依据，核对存在冲突的表述，并要求发布者提供原始证明。'
      : report?.externalEvidence.length
        ? '向发布者索要与该产品对应的功效评价资料，不要只接受原料或体验描述。'
        : report?.matches.length
          ? '对比匹配记录的发布时间和发布者，确认是否为转载、重复发布或本人作品。'
          : '如需更高把握，可补充原文件、产品备案或功效评价材料后再次核验。';

  return (
    <main className="product-shell">
      <header className="product-header">
        <button className="brand-button" type="button" onClick={reset} aria-label="返回检测首页">
          <span className="brand-mark">真</span><span><strong>真妍盾</strong><small>BEAUTYPROOF</small></span>
        </button>
        <div className="header-actions">
          <span className="demo-badge real-mode"><i /> REAL MVP</span>
          <button type="button" className="quiet-button" onClick={() => setShowHelp(true)}>能力说明</button>
          <button type="button" className="icon-button" aria-label="查看能力说明" onClick={() => setShowHelp(true)}>?</button>
        </div>
      </header>

      {showHelp && (
        <div className="modal-backdrop" role="presentation" onMouseDown={() => setShowHelp(false)}>
          <section className="help-modal" role="dialog" aria-modal="true" aria-labelledby="help-title" onMouseDown={(event) => event.stopPropagation()}>
            <button className="modal-close" type="button" aria-label="关闭" onClick={() => setShowHelp(false)}>×</button>
            <span className="step-label">CURRENT CAPABILITY</span><h2 id="help-title">当前真实能力</h2>
            <div className="capability-list">
              <div><b className="live">已实现</b><span>小红书公开正文与媒体读取；上传内容进行 OCR、Whisper 口播转写和关键帧分析。</span></div>
              <div><b className="live">已实现</b><span>SHA-256 与感知指纹库内查重，并把宣称映射到监管规则和官方资料。</span></div>
              <div><b className="next">边界</b><span>抖音网页受平台访问策略影响时需上传原视频；系统不提供法律结论或绝对真假标签。</span></div>
            </div>
            <button className="modal-action" type="button" onClick={() => setShowHelp(false)}>我知道了</button>
          </section>
        </div>
      )}

      {appState === 'input' && (
        <section className="input-workspace">
          <div className="workspace-heading"><span className="step-label">新建检测</span><h1>检测一条内容</h1><p>读取正文、口播与画面文字，再核对内容指纹和宣称依据。</p></div>
          <div className="input-card">
            <div className="mode-switch" role="tablist" aria-label="输入方式">
              {modes.map((item) => <button key={item.id} type="button" role="tab" aria-selected={mode === item.id} className={mode === item.id ? 'active' : ''} onClick={() => { setMode(item.id); setError(''); }}><span>{item.icon}</span>{item.label}</button>)}
            </div>

            {mode === 'link' && <div className="mode-panel">
              <label htmlFor="work-url">作品链接或分享口令</label>
              <div className={`url-field ${link && !platform ? 'invalid' : ''}`}><span className="field-icon">⌁</span><input id="work-url" value={link} onChange={(event) => { setLink(event.target.value); setError(''); }} placeholder="粘贴小红书或抖音公开作品链接" autoComplete="off" />{link && <button type="button" onClick={() => setLink('')} aria-label="清空链接">×</button>}</div>
              {platform ? <div className="parsed-source"><span className={`platform-mark ${platform.className}`}>{platform.mark}</span><div><strong>已识别为{platform.name}作品</strong><small>{truncate(linkUrl)}</small></div><span className="source-state">可检测</span></div> : <div className="supported-row"><span className="xhs-dot" />小红书 <span className="dy-dot" />抖音 <small>仅支持公开作品</small></div>}
            </div>}

            {mode === 'upload' && <div className="mode-panel">
              <input ref={fileInput} type="file" multiple className="visually-hidden" accept="image/jpeg,image/png,image/webp,video/mp4,video/quicktime" onChange={onFileChange} />
              <div className="upload-zone" role="button" tabIndex={0} onClick={() => fileInput.current?.click()} onKeyDown={(event) => { if (event.key === 'Enter') fileInput.current?.click(); }} onDragOver={(event) => event.preventDefault()} onDrop={onDrop}><span className="upload-symbol">↑</span><strong>选择或拖入图片、视频</strong><small>文件在本机提取特征，不上传原始内容</small></div>
              {files.length > 0 && <div className="upload-list">{files.map((item, index) => <div className="upload-item" key={`${item.file.name}-${index}`}>{item.kind === 'image' ? <img src={item.preview} alt="上传素材预览" /> : item.kind === 'video' ? <video src={item.preview} muted /> : <span className="file-type">TXT</span>}<div><strong>{item.file.name}</strong><small>{formatSize(item.file.size)} · 已在本机读取</small></div><button type="button" onClick={() => removeFile(index)} aria-label={`移除 ${item.file.name}`}>×</button></div>)}</div>}
            </div>}

            {mode === 'text' && <div className="mode-panel"><label htmlFor="work-text">需要核验的内容</label><div className="text-field"><textarea id="work-text" value={text} maxLength={3000} onChange={(event) => { setText(event.target.value); setError(''); }} placeholder="粘贴种草文案、功效宣称或评论区话术…" /><span>{text.length}/3000</span></div></div>}

            {error && <p className="form-error" role="alert">{error}</p>}
            <button className="primary-action" type="button" onClick={() => void runAnalysis(false)}>开始真实检测 <span>→</span></button>
            <div className="card-footer"><span>原始文件不离开本机，只保存特征与结果</span><button type="button" onClick={() => void runAnalysis(true)}>使用测试文案 <b>→</b></button></div>
          </div>
          <div className="capability-note"><span>i</span><p><strong>当前检测范围</strong>小红书公开内容可直接读取；抖音若未开放媒体访问，请上传视频以完成口播、画面和关键帧分析。</p></div>
        </section>
      )}

      {appState === 'analyzing' && <section className="analysis-workspace" aria-live="polite"><div className="analysis-card"><div className="scan-core"><span>{step + 1}</span><i /></div><span className="step-label">正在执行 · {step + 1}/{analysisSteps.length}</span><h2>{analysisSteps[step][0]}</h2><p>{progressDetail || analysisSteps[step][1]}</p><div className="analysis-track"><i style={{ width: `${((step + 1) / analysisSteps.length) * 100}%` }} /></div><div className="analysis-steps">{analysisSteps.map((item, index) => <div className={index <= step ? 'done' : ''} key={item[0]}><span>{index < step ? '✓' : index + 1}</span><small>{item[0]}</small></div>)}</div></div></section>}

      {appState === 'result' && report && <section className="result-workspace">
        <div className="result-topbar"><button type="button" onClick={reset}>← 新建检测</button><div><span className="demo-badge real-mode"><i /> 真实检测报告</span><button type="button" onClick={() => window.print()}>导出</button></div></div>
        <div className="source-strip"><span className={`platform-mark ${mode === 'link' ? platform?.className ?? 'xhs' : 'local'}`}>{mode === 'link' ? platform?.mark ?? '小' : mode === 'upload' ? '件' : '文'}</span><div><small>{resolver ? `${resolver.platform === 'douyin' ? '抖音' : '小红书'} · ${resolver.resolved ? '内容已读取' : '内容读取受限'}` : mode === 'upload' ? '本地媒体' : '文字内容'}</small><strong>{report.title}</strong></div></div>

        <div className={`verdict-simple ${needsReview || contentLimited ? 'needs-attention' : 'looks-clear'}`}><span className="verdict-symbol">{contentLimited ? '…' : needsReview ? '!' : '✓'}</span><div><small>{contentLimited ? '证据不足' : needsReview ? '建议复核' : '初步结果'}</small><h1>{resultHeadline}</h1><p>{resultDescription}</p></div><div className="evidence-level"><span>证据完整度</span><strong>{report.confidence}</strong></div></div>

        <section className="key-findings"><div className="section-heading"><span>一眼看懂</span><h2>这次发现了什么</h2></div><div className="finding-grid">{userFindings.map((finding) => <article className={`finding-card ${finding.tone}`} key={finding.title}><span>{finding.icon}</span><div><strong>{finding.title}</strong><p>{finding.detail}</p></div></article>)}</div></section>

        <section className="user-action-card"><span>建议下一步</span><div><h2>{actionAdvice}</h2><p>报告只指出需要核对的地方，不会用单一分数直接给内容贴“真”或“假”的标签。</p></div><button type="button" onClick={reset}>检测另一条</button></section>

        <details className="technical-details"><summary><div><strong>查看技术详情</strong><span>适合需要核验证据的用户</span></div><p>内容指纹只用于判断文件是否相同或近似，不代表风险高低。</p><b>＋</b></summary><div className="technical-content">
          <section className="technical-block"><h3>内容是怎么读取的</h3>{resolver && <div className="fact-grid"><div><span>平台状态</span><strong>{resolver.resolved ? '内容已读取' : '内容读取受限'}</strong></div><div><span>作品 ID</span><strong>{resolver.contentId || '未提取'}</strong></div><div><span>作者</span><strong>{resolver.author || '页面未公开'}</strong></div><div><span>访问时间</span><strong>{new Date(resolver.fetchedAt).toLocaleString('zh-CN')}</strong></div>{resolver.limitation && <p>{resolver.limitation}</p>}</div>}{extracted && <div className="extraction-grid">{([['页面正文', extracted.stages.page], ['画面文字', extracted.stages.ocr], ['口播转写', extracted.stages.asr]] as const).map(([label, stage]) => <div className={`extraction-stage ${stage.status}`} key={label}><span>{label}</span><b>{stageLabels[stage.status]}</b><p>{stage.detail}</p></div>)}</div>}{extracted?.pageText && <div className="extracted-copy"><span>正文节选</span><p>{truncate(extracted.pageText, 420)}</p></div>}{extracted?.ocrText && <div className="extracted-copy"><span>画面文字节选</span><p>{truncate(extracted.ocrText, 420)}</p></div>}{extracted?.transcript && <div className="extracted-copy"><span>口播转写节选</span><p>{truncate(extracted.transcript, 520)}</p></div>}</section>

          <section className="technical-block"><h3>重复内容与文件依据</h3>{report.matches.length ? report.matches.map((match) => <div className="match-row" key={match.id}><span className="match-thumb second">比</span><div><strong>{match.title}</strong><small>{match.kind} · {formatDate(match.createdAt)}</small></div><em className="similarity">{match.similarity}% 相似</em></div>) : <div className="empty-evidence"><span>✓</span><div><strong>系统历史中暂未发现重复</strong><p>仅覆盖本系统已检测内容，不代表全网无重复。</p></div></div>}{report.files.map((file) => <div className="file-evidence" key={file.sha256}><div className="file-evidence-title"><strong>{file.name}</strong><span>{file.width && file.height ? `${file.width}×${file.height}` : file.type} {file.duration ? `· ${file.duration.toFixed(1)}s` : ''}</span></div><div className="fact-grid compact"><div><span>文件指纹</span><strong>{file.sha256.slice(0, 20)}…</strong></div><div><span>近似指纹</span><strong>{file.perceptualHash ?? '不适用'}</strong></div><div><span>视频关键帧</span><strong>{file.frameHashes?.length ?? 0} 个</strong></div><div><span>内容凭证</span><strong>{file.c2pa?.present ? `已发现${file.c2pa.issuer ? ` · ${file.c2pa.issuer}` : ''}` : '未发现'}</strong></div></div></div>)}</section>

          <section className="technical-block"><h3>宣称与官方依据</h3>{report.externalEvidence.length > 0 ? <div className="evidence-checks">{report.externalEvidence.map((item, index) => <div className={`evidence-check ${item.status}`} key={`${item.signal}-${index}`}><div><strong>{item.signal}</strong><b>{item.status === 'conflict' ? '存在冲突' : item.status === 'needs_source' ? '需要依据' : '需结合上下文'}</b></div><p>{item.conclusion}</p><a href={item.source.url} target="_blank" rel="noreferrer">查看 {item.source.organization} 官方依据 ↗</a></div>)}</div> : <div className="empty-evidence"><span>✓</span><div><strong>未触发当前宣称核验规则</strong><p>没有命中不等于功效已被证实。</p></div></div>}</section>

          <section className="technical-block boundary-block"><h3>这份报告不能说明什么</h3><ul>{report.limitations.map((item) => <li key={item}>{item}</li>)}</ul></section>
        </div></details>
        <p className="report-disclaimer">检测结果是可复核的技术信号，不构成专业鉴定、法律判断或监管结论。</p>
      </section>}
    </main>
  );
}
