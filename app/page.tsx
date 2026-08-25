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
  { id: 'link', label: '粘贴链接', icon: '⌁' },
  { id: 'upload', label: '上传内容', icon: '↑' },
  { id: 'text', label: '粘贴文字', icon: '文' },
];

const analysisSteps = [
  '正在读取内容',
  '正在识别文字和画面',
  '正在检查可疑表述',
  '正在对照可信来源',
  '正在生成结果',
];

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

  const runAnalysis = async () => {
    const activeMode = mode;
    const activeText = text;
    const message = validate(activeMode, activeText);
    if (message) { setError(message); return; }

    setError('');
    setReport(null);
    setAppState('analyzing');
    setStep(0);
    setProgressDetail('正在读取你提交的内容');

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
        const resolved = await extractResolvedContent(resolver?.extraction);
        extraction = resolved.extraction;
        features = resolved.features;
      } else if (activeMode === 'upload') {
        const localFiles = files.map((item) => item.file);
        [features, extraction] = await Promise.all([
          Promise.all(localFiles.map((file) => analyzeFile(file))),
          extractFilesContent(localFiles),
        ]);
      } else {
        extraction = await extractFilesContent([], activeText);
      }

      const extractedText = extraction.combinedText || activeText;
      claims = analyzeClaims(extractedText);
      if (extractedText.trim().length >= 8) textHash = textSimHash(extractedText);

      setStep(2);
      setProgressDetail('正在检查夸大、绝对化和医疗化表述');
      await new Promise((resolve) => setTimeout(resolve, 120));

      setStep(3);
      setProgressDetail('正在对照公开规则和可信来源');
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
      setProgressDetail('马上就好');
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
  const contentLimited = Boolean(resolver && !resolver.resolved && !extracted?.combinedText);
  const unsupportedCount = report?.externalEvidence.filter((item) => item.status === 'needs_source').length ?? 0;
  const highRiskClaims = report?.claims.filter((item) => item.level === 'high') ?? [];
  const mediumRiskClaims = report?.claims.filter((item) => item.level === 'medium') ?? [];
  const highRiskSignals = [
    ...(report?.externalEvidence.filter((item) => item.status === 'conflict').map((item) => item.signal) ?? []),
    ...highRiskClaims.map((item) => item.rule),
  ].map((signal) => signal.includes('医疗') || signal.includes('头皮问题') ? '医疗化表述' : signal.includes('毛发生长') || signal.includes('育发') ? '毛发生长宣称' : signal.includes('永久') || signal.includes('替代') ? '永久效果承诺' : signal);
  const highRiskCount = new Set(highRiskSignals).size;
  const contextualSignals = [
    ...(report?.externalEvidence.filter((item) => item.status === 'context' && item.signal !== '化妆品功效宣称').map((item) => item.signal) ?? []),
    ...mediumRiskClaims.map((item) => item.rule),
  ].map((signal) => signal.includes('绝对化') || signal.includes('夸大') ? '夸大表述' : signal.includes('背书') ? '背书信息' : signal.includes('天然') ? '天然表述' : signal);
  const lowSignalCount = new Set(contextualSignals).size;
  const resultKind = contentLimited ? 'unknown' : highRiskCount ? 'risk' : unsupportedCount || lowSignalCount >= 2 ? 'warning' : lowSignalCount ? 'low' : 'clear';
  const resultHeadline = resultKind === 'unknown' ? '暂无法判断' : resultKind === 'risk' ? '不建议采信' : resultKind === 'warning' ? '谨慎参考' : resultKind === 'low' ? '轻微夸大' : '未发现明显问题';
  const resultDescription = resultKind === 'unknown'
    ? '平台没有提供可读取的内容，本次没有生成判断。'
    : resultKind === 'risk'
      ? `发现 ${highRiskCount} 类高风险表述，不建议据此购买或使用产品。`
      : resultKind === 'warning'
        ? unsupportedCount ? `发现 ${unsupportedCount} 项缺少依据的功效宣称，不建议完全相信。` : `发现 ${lowSignalCount} 类可疑宣传信息，建议谨慎参考。`
        : resultKind === 'low'
          ? '发现轻微夸大用语，不影响对其他内容的正常参考。'
          : '未发现明显的夸大、绝对化或违规表述。';
  const resultIssues = report ? (
    report.externalEvidence.length
      ? [...report.externalEvidence].sort((left, right) => {
          const priority = (item: EvidenceCheck) => item.status === 'conflict' ? 0 : item.status === 'needs_source' ? 1 : item.signal === '化妆品功效宣称' ? 3 : 2;
          return priority(left) - priority(right);
        }).slice(0, 2).map((item) => ({
          title: item.signal,
          detail: item.status === 'conflict' ? '与官方规则存在冲突' : item.status === 'needs_source' ? '功效依据不足' : '容易造成误解',
        }))
      : highRiskClaims.slice(0, 3).map((item) => ({ title: item.rule, detail: item.text }))
  ) : [];

  return (
    <main className="product-shell">
      <header className="product-header">
        <button className="brand-button" type="button" onClick={reset} aria-label="返回检测首页">
          <span className="brand-mark">真</span><span><strong>真妍盾</strong><small>BEAUTYPROOF</small></span>
        </button>
        <span className="header-product-label">美妆内容可信检测</span>
      </header>

      {appState === 'input' && (
        <section className="input-workspace">
          <div className="workspace-heading"><h1>这条美妆内容，可信吗？</h1><p>提交链接、图片、视频或文字，直接看结果</p></div>
          <div className="input-card">
            <div className="mode-switch" role="tablist" aria-label="输入方式">
              {modes.map((item) => <button key={item.id} type="button" role="tab" aria-selected={mode === item.id} className={mode === item.id ? 'active' : ''} onClick={() => { setMode(item.id); setError(''); }}><span>{item.icon}</span>{item.label}</button>)}
            </div>

            {mode === 'link' && <div className="mode-panel">
              <label htmlFor="work-url">粘贴作品链接</label>
              <div className={`url-field ${link && !platform ? 'invalid' : ''}`}><span className="field-icon">⌁</span><input id="work-url" value={link} onChange={(event) => { setLink(event.target.value); setError(''); }} placeholder="小红书或抖音公开作品链接" autoComplete="off" />{link && <button type="button" onClick={() => setLink('')} aria-label="清空链接">×</button>}</div>
              {platform ? <div className="parsed-source"><span className={`platform-mark ${platform.className}`}>{platform.mark}</span><div><strong>{platform.name}作品</strong><small>{truncate(linkUrl)}</small></div><span className="source-state">已识别</span></div> : <div className="supported-row"><span className="xhs-dot" />小红书 <span className="dy-dot" />抖音</div>}
            </div>}

            {mode === 'upload' && <div className="mode-panel">
              <input ref={fileInput} type="file" multiple className="visually-hidden" accept="image/jpeg,image/png,image/webp,video/mp4,video/quicktime" onChange={onFileChange} />
              <div className="upload-zone" role="button" tabIndex={0} onClick={() => fileInput.current?.click()} onKeyDown={(event) => { if (event.key === 'Enter') fileInput.current?.click(); }} onDragOver={(event) => event.preventDefault()} onDrop={onDrop}><span className="upload-symbol">↑</span><strong>选择图片或视频</strong><small>最多 4 个文件，单个不超过 200 MB</small></div>
              {files.length > 0 && <div className="upload-list">{files.map((item, index) => <div className="upload-item" key={`${item.file.name}-${index}`}>{item.kind === 'image' ? <img src={item.preview} alt="上传素材预览" /> : item.kind === 'video' ? <video src={item.preview} muted /> : <span className="file-type">TXT</span>}<div><strong>{item.file.name}</strong><small>{formatSize(item.file.size)} · 已在本机读取</small></div><button type="button" onClick={() => removeFile(index)} aria-label={`移除 ${item.file.name}`}>×</button></div>)}</div>}
            </div>}

            {mode === 'text' && <div className="mode-panel"><label htmlFor="work-text">粘贴需要检测的文字</label><div className="text-field"><textarea id="work-text" value={text} maxLength={3000} onChange={(event) => { setText(event.target.value); setError(''); }} placeholder="种草文案、功效宣称或评论区话术" /><span>{text.length}/3000</span></div></div>}

            {error && <p className="form-error" role="alert">{error}</p>}
            <button className="primary-action" type="button" onClick={() => void runAnalysis()}>立即检测 <span>→</span></button>
            <div className="card-footer"><span>仅分析公开内容和你主动提交的文件</span></div>
          </div>
        </section>
      )}

      {appState === 'analyzing' && <section className="analysis-workspace" aria-live="polite"><div className="analysis-card"><div className="scan-core"><span>真</span><i /></div><h2>正在检测</h2><p>{progressDetail || analysisSteps[step]}</p><div className="analysis-track"><i style={{ width: `${((step + 1) / analysisSteps.length) * 100}%` }} /></div></div></section>}

      {appState === 'result' && report && <section className="result-workspace">
        <div className="result-topbar"><button type="button" onClick={reset}>← 返回</button></div>
        <div className="source-strip"><span className={`platform-mark ${mode === 'link' ? platform?.className ?? 'xhs' : 'local'}`}>{mode === 'link' ? platform?.mark ?? '小' : mode === 'upload' ? '件' : '文'}</span><div><small>{resolver ? `${resolver.platform === 'douyin' ? '抖音' : '小红书'} · ${resolver.resolved ? '内容已读取' : '内容读取受限'}` : mode === 'upload' ? '本地媒体' : '文字内容'}</small><strong>{report.title}</strong></div></div>

        <section className={`consumer-result ${resultKind}`}>
          <span className="result-icon">{resultKind === 'clear' ? '✓' : resultKind === 'unknown' ? '?' : '!'}</span>
          <div className="result-copy"><small>检测结果</small><h1>{resultHeadline}</h1><p>{resultDescription}</p></div>
          {resultIssues.length > 0 && <div className="result-issues">{resultIssues.map((item) => <div key={item.title}><small>主要问题</small><strong>{item.title}</strong><span>{item.detail}</span></div>)}</div>}
          <button type="button" onClick={reset}>检测另一条</button>
        </section>
      </section>}
    </main>
  );
}
