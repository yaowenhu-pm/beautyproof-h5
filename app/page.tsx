'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import type { ChangeEvent, DragEvent } from 'react';
import { analyzeClaims, analyzeFile, textSimHash } from '@/lib/client/analysis';
import type { ClaimFinding, FileFeature } from '@/lib/client/analysis';
import { extractFilesContent, extractResolvedContent } from '@/lib/client/extraction';
import type { ContentExtraction, ExtractionStage, ResolvedContent } from '@/lib/client/extraction';
import type { EvidenceCheck } from '@/lib/shared/evidence';
import { contentIdFor, extractShareUrl, platformFor } from '@/lib/shared/links';
import { resolutionCacheTtl } from '@/lib/shared/resolution-cache';
import { readAnonymousXhs } from '@/lib/client/reader-jobs';
import type { ReportV2 } from '@/lib/shared/report';
import EvidenceReport from './report-v2';
import Icon from './ui-icon';
import type { IconName } from './ui-icon';

type InputMode = 'link' | 'upload' | 'text';
type AppState = 'input' | 'analyzing' | 'result';

type UploadItem = {
  file: File;
  kind: 'image' | 'video' | 'text';
  preview: string;
};

type ResolveResult = {
  resolved: boolean;
  contentStatus?: 'body' | 'title_only' | 'media_only' | 'unavailable';
  reasonCode?: string;
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

type LinkResolutionState = { url: string; value: ResolveResult; noUsableText?: boolean };

type Match = { id: string; title: string; kind: string; similarity: number; createdAt: number };

type AnalysisReport = {
  reportV2?: ReportV2;
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

type ChatCitation = { id: string; title: string; url: string; kind: string; excerpt: string };
type ChatReply = { answer: string; citations: ChatCitation[]; scope: string; model: string; cached?: boolean };
type ChatTurn = { id: string; role: 'user' | 'assistant'; text: string; citations?: ChatCitation[]; scope?: string };
type ChatSeedDetails = { supplement: string; fileNames: string[]; question: string };

const modes: { id: InputMode; label: string; icon: IconName }[] = [
  { id: 'link', label: '粘贴链接', icon: 'link' },
  { id: 'upload', label: '上传内容', icon: 'upload' },
  { id: 'text', label: '粘贴文字', icon: 'text' },
];

const analysisSteps = [
  '正在读取内容',
  '正在识别文字和画面',
  '正在检查可疑表述',
  '正在对照可信来源',
  '正在生成结果',
];

function extractUrl(value: string) {
  return extractShareUrl(value);
}

function getPlatform(value: string) {
  const url = extractUrl(value);
  const kind = url ? platformFor(new URL(url)) : null;
  if (kind==='xiaohongshu') return { id: 'xiaohongshu', name: '小红书', mark: '小', className: 'xhs' } as const;
  if (kind==='douyin') return { id: 'douyin', name: '抖音', mark: '♪', className: 'douyin' } as const;
  return null;
}

function sharePreview(value: string) {
  const url = extractUrl(value);
  const platform = getPlatform(value);
  if (!url || !platform) return null;
  const parsed = new URL(url);
  const contentId = contentIdFor(platform.id, parsed);
  const shortCode = parsed.pathname.split('/').filter(Boolean).at(-1) ?? '';
  return { url, name: platform.name, detail: contentId ? `作品 ${truncate(contentId, 32)}` : `短链 ${truncate(shortCode, 32)}` };
}

function questionBesideLink(value: string) {
  const remaining = value.replace(/https?:\/\/[^\s<>"“”「」【】\[\]()\u4e00-\u9fff]+/i, '')
    .replace(/^[\s，。,:：;；()[\]]+|[\s，。,:：;；()[\]]+$/g, '').trim();
  // Share titles often contain a question mark; only an explicit user-directed
  // request should start an additional model turn after the link analysis.
  if (/[【】]|复制打开|小红书分享|抖音分享|发布了一篇|快来看/.test(remaining)) return '';
  return remaining.length >= 2
    && /^(?:请问|帮我|麻烦帮我|你能|你觉得|这篇(?:作品|笔记|链接|提到的)|这条(?:作品|笔记|链接)|这个链接|链接里)/.test(remaining)
    && /[?？]|看看|分析|判断|如何|怎么|是否|有没有|能否|有效|有用|靠谱|值得|什么|为什么/.test(remaining)
    ? remaining : '';
}

type LinkPlatform = NonNullable<ReturnType<typeof getPlatform>>;

function failedLinkResolution(url: string, platform: LinkPlatform, reason: unknown): ResolveResult {
  const knownMessage = reason instanceof Error ? reason.message : '';
  const timedOut = reason instanceof DOMException && reason.name === 'TimeoutError'
    || ['检测服务响应超时，请重新检测。', '这次读取超过等待时限，未自动重试。请保留链接，稍后再试。'].includes(knownMessage);
  const disconnected = reason instanceof TypeError
    || ['检测服务连接中断，请重新检测。', '读取服务连接中断或超时，本次未自动重试。请保留原链接，稍后再试。', '查询读取进度时连接中断；本次没有重复提交链接。请保留原链接，稍后重试。'].includes(knownMessage);
  const reasonCode = timedOut ? 'timeout' : disconnected ? 'network_error' : 'service_error';
  const lead = timedOut ? '读取服务响应超时' : disconnected ? '读取服务连接失败' : '读取服务未完成本次请求';
  return {
    resolved: false,
    contentStatus: 'unavailable',
    reasonCode,
    platform: platform.id,
    canonicalUrl: url,
    contentId: '',
    title: `${platform.name}作品`,
    fetchedAt: new Date().toISOString(),
    limitation: `${lead}，未取得原作品正文。可打开原作品，或补充文字、截图继续。`,
  };
}

function resolutionState(value?: ResolveResult) {
  if (!value) return '链接格式已识别';
  if (value.resolved && value.contentStatus === 'body') return '正文已读取';
  if (value.resolved && value.contentStatus === 'title_only') return '仅标题 / 摘要';
  if (value.resolved && value.contentStatus === 'media_only') return '仅取得媒体地址';
  if (['app_only', 'captcha', 'login_required', 'browser_required', 'access_denied', 'rate_limited'].includes(value.reasonCode ?? '')) return '平台读取受限';
  if (['network_error', 'timeout'].includes(value.reasonCode ?? '')) return '网络读取失败';
  if (value.reasonCode === 'service_error') return '读取服务未完成';
  return '正文不可用';
}

function shouldOfferLinkRecovery(mode: InputMode, url: string, last: LinkResolutionState | null, error: string) {
  return mode === 'link' && Boolean(last && last.url === url
    && (!last.value.resolved || last.value.contentStatus !== 'body' || error));
}

function shouldUseSupplementOnly(last: LinkResolutionState | null, url: string, hasSupplement: boolean) {
  return Boolean(hasSupplement && last && last.url === url && (!last.value.resolved || last.noUsableText));
}

function containsPlatformMediaText(extraction: ContentExtraction) {
  return Boolean(extraction.ocrText.trim() || extraction.transcript.trim());
}

function combineExtractionStages(linkStages: ContentExtraction['stages'], extraStages: ContentExtraction['stages']): ContentExtraction['stages'] {
  const combine = (link: ExtractionStage, extra: ExtractionStage): ExtractionStage => {
    const statuses = [link.status, extra.status].filter(status => status !== 'not_applicable');
    const status = !statuses.length ? 'not_applicable'
      : statuses.every(value => value === 'complete') ? 'complete'
        : statuses.every(value => value === 'limited') ? 'limited' : 'partial';
    return { status, detail: `原链接：${link.detail}；补充内容：${extra.detail}` };
  };
  return {
    page: combine(linkStages.page, extraStages.page),
    ocr: combine(linkStages.ocr, extraStages.ocr),
    asr: combine(linkStages.asr, extraStages.asr),
  };
}

function formatSize(bytes: number) {
  if (bytes < 1024 * 1024) return `${Math.max(1, Math.round(bytes / 1024))} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

function truncate(value: string, length = 54) {
  return value.length > length ? `${value.slice(0, length)}…` : value;
}

async function apiJson<T>(url: string, body: unknown, signal?: AbortSignal): Promise<T> {
  for (let attempt = 0; attempt < 1; attempt += 1) {
    const controller = new AbortController();
    const timer = window.setTimeout(() => controller.abort(), ['/api/analyze', '/api/chat-turn'].includes(url)?65000:45000);
    try {
      const response = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
        signal: signal ? AbortSignal.any([signal, controller.signal]) : controller.signal,
      });
      let result: T & { error?: string };
      try { result = await response.json() as T & { error?: string }; }
      catch { throw new Error('服务暂时不可用，请稍后再试。'); }
      if (!response.ok) throw new Error(result.error || '检测服务暂时不可用，请稍后重试。');
      return result;
    } catch (reason) {
      signal?.throwIfAborted();
      const isNetworkFailure = reason instanceof TypeError || (reason instanceof DOMException && reason.name === 'AbortError');
      if (!isNetworkFailure) throw reason;
      if (reason instanceof DOMException && reason.name === 'AbortError') {
        throw new Error('检测服务响应超时，请重新检测。');
      }
      throw new Error('检测服务连接中断，请重新检测。');
    } finally {
      window.clearTimeout(timer);
    }
  }
  throw new Error('检测服务暂时不可用，请稍后重试。');
}

const resolveCache = new Map<string, { value: ResolveResult; cachedAt: number }>();

async function resolvePublicLink(url: string, progress?: (message:string)=>void, signal?: AbortSignal) {
  if (platformFor(new URL(url)) === 'xiaohongshu') {
    const fresh = await readAnonymousXhs<ResolveResult>(url, progress, signal);
    if (fresh) return fresh;
  }
  const cached = resolveCache.get(url);
  if (cached && Date.now() - cached.cachedAt < resolutionCacheTtl(cached.value)) return cached.value;
  resolveCache.delete(url);
  const value = await apiJson<ResolveResult>('/api/resolve', { url }, signal);
  if (value.resolved) {
    if (resolveCache.size >= 20) resolveCache.delete(resolveCache.keys().next().value ?? '');
    resolveCache.set(url, { value, cachedAt: Date.now() });
  }
  return value;
}

export default function Home() {
  const [mode, setMode] = useState<InputMode>('link');
  const [appState, setAppState] = useState<AppState>('input');
  const [link, setLink] = useState('');
  const [ingredientLabel,setIngredientLabel]=useState(false);
  const [text, setText] = useState('');
  const [files, setFiles] = useState<UploadItem[]>([]);
  const [error, setError] = useState('');
  const [lastResolution, setLastResolution] = useState<LinkResolutionState | null>(null);
  const [step, setStep] = useState(0);
  const [report, setReport] = useState<AnalysisReport | null>(null);
  const [progressDetail, setProgressDetail] = useState('');
  const [chatDraft, setChatDraft] = useState('');
  const [chatTurns, setChatTurns] = useState<ChatTurn[]>([]);
  const [chatSeed, setChatSeed] = useState('');
  const [chatSeedDetails, setChatSeedDetails] = useState<ChatSeedDetails | null>(null);
  const [chatBusy, setChatBusy] = useState(false);
  const [chatError, setChatError] = useState('');
  const [advancedOpen, setAdvancedOpen] = useState(false);
  const fileInput = useRef<HTMLInputElement>(null);
  const fileItems = useRef<UploadItem[]>([]);
  const activeRead = useRef<AbortController | null>(null);
  const activeChat = useRef<AbortController | null>(null);
  const pendingLinkQuestion = useRef<{ url: string; text: string } | null>(null);
  const messageScroll = useRef<HTMLDivElement>(null);

  // Inputs belong to one content item. Never carry hidden supplements into a new draft.
  const clearContent = useCallback(() => {
    activeRead.current?.abort();
    activeRead.current = null;
    activeChat.current?.abort();
    activeChat.current = null;
    fileItems.current.forEach(item => { if (item.preview) URL.revokeObjectURL(item.preview); });
    fileItems.current = [];
    setFiles([]);
    setText('');
    setIngredientLabel(false);
    setLastResolution(null);
    setReport(null);
    setError('');
    setStep(0);
    setProgressDetail('');
    setChatDraft('');
    setChatTurns([]);
    setChatSeed('');
    setChatSeedDetails(null);
    pendingLinkQuestion.current = null;
    setChatBusy(false);
    setChatError('');
    setAdvancedOpen(false);
    setAppState('input');
  }, []);
  const reset = useCallback(() => {
    clearContent();
    setLink('');
    setMode('link');
  }, [clearContent]);
  useEffect(() => {
    const leavePage = () => { activeRead.current?.abort(); activeRead.current = null; activeChat.current?.abort(); activeChat.current = null; };
    const restorePage = (event: PageTransitionEvent) => { if (event.persisted) reset(); };
    window.addEventListener('pagehide', leavePage);
    window.addEventListener('pageshow', restorePage);
    return () => {
      leavePage();
      window.removeEventListener('pagehide', leavePage);
      window.removeEventListener('pageshow', restorePage);
    };
  }, [reset]);

  const changeMode = (next: InputMode) => {
    if (next === mode) return;
    clearContent();
    setLink('');
    setMode(next);
    setAdvancedOpen(true);
  };
  const changeLink = (next: string) => {
    if (next !== link) { clearContent(); setAdvancedOpen(true); }
    setLink(next);
    setError('');
  };
  const fillExample = (value: string) => {
    clearContent();
    setLink('');
    setMode('text');
    setText(value);
    setAdvancedOpen(true);
    requestAnimationFrame(() => document.getElementById('work-text')?.focus());
  };
  const editContent = () => { setReport(null); setChatTurns([]); setAppState('input'); setAdvancedOpen(true); };
  const openSupplement = () => {
    setAdvancedOpen(true);
    requestAnimationFrame(() => {
      const details = document.getElementById('link-supplement') as HTMLDetailsElement | null;
      if (details) {
        details.open = true;
        details.scrollIntoView({ behavior: 'smooth', block: 'center' });
        details.querySelector('textarea')?.focus({ preventScroll: true });
      }
    });
  };
  useEffect(() => {
    const area = messageScroll.current;
    if (area) area.scrollTo({ top: area.scrollHeight, behavior: 'smooth' });
  }, [chatTurns.length, chatBusy, chatSeed, error]);
  useEffect(() => {
    const area = messageScroll.current;
    const result = area?.querySelector<HTMLElement>('.result-message');
    if (!area || !result || !report) return;
    const top = result.getBoundingClientRect().top - area.getBoundingClientRect().top + area.scrollTop - 12;
    area.scrollTo({ top, behavior: 'smooth' });
  }, [report]);
  const [service,setService]=useState<{available:boolean;message:string}|null>(null);
  useEffect(()=>{const controller=new AbortController();fetch('/api/status',{signal:controller.signal}).then(r=>{if(!r.ok)throw new Error();return r.json();}).then(value=>{const s=value as {available:boolean;message:string};if(typeof s.available==='boolean'&&typeof s.message==='string')setService(s);}).catch(()=>{});return ()=>controller.abort();},[]);

  const platform = getPlatform(link);
  const linkUrl = extractUrl(link);
  const showLinkRecovery = shouldOfferLinkRecovery(mode, linkUrl, lastResolution, error);

  const addFiles = (incoming: FileList | File[]) => {
    setError('');
    const slots = 4 - fileItems.current.length;
    if (slots <= 0) { setError('最多添加 4 个文件；请先移除不需要的文件。'); return; }
    const selected = Array.from(incoming).slice(0, slots);
    const next = selected.map((file) => {
      if (file.size > 200 * 1024 * 1024) {
        setError(`${file.name} 超过 200 MB，请压缩后重试。`);
        return null;
      }
      const kind = file.type.startsWith('image/') ? 'image' : file.type.startsWith('video/') ? 'video' : 'text';
      return { file, kind, preview: kind === 'text' ? '' : URL.createObjectURL(file) } as UploadItem;
    });
    fileItems.current = [...fileItems.current, ...next.filter((item): item is UploadItem => item !== null)];
    setFiles(fileItems.current);
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
    const target = fileItems.current[index];
    if (!target) return;
    if (target.preview) URL.revokeObjectURL(target.preview);
    fileItems.current = fileItems.current.filter((_, itemIndex) => itemIndex !== index);
    setFiles(fileItems.current);
  };

  const validate = (activeMode = mode, activeText = text, activeLink = link) => {
    if (activeMode === 'link' && !getPlatform(activeLink)) return '请一次粘贴一条完整的小红书或抖音作品分享链接。';
    if (activeMode === 'upload' && files.length === 0) return '请先选择需要检测的图片或视频。';
    if (activeMode === 'text' && activeText.trim().length < 8) return '请至少输入 8 个字。';
    return '';
  };

  const answerQuestion = async (prompt: string, currentReport: AnalysisReport | null, freshConversation = false) => {
    if (activeChat.current) return;
    const previousTurns = freshConversation ? [] : chatTurns;
    if (previousTurns.filter(turn => turn.role === 'user').length >= 6) {
      setChatError('本次会话已达到 6 轮追问，请开启新对话。');
      return;
    }
    const controller = new AbortController();
    activeChat.current = controller;
    const isCurrent = () => activeChat.current === controller && !controller.signal.aborted;
    const previous = previousTurns.slice(-6).map(turn => ({ role: turn.role, text: turn.text.slice(0, 700) }));
    const userTurn: ChatTurn = { id: crypto.randomUUID(), role: 'user', text: prompt };
    const context = currentReport ? {
      title: currentReport.title.slice(0, 140),
      text: currentReport.extraction.combinedText.slice(0, 4000),
      reportSummary: (currentReport.reportV2?.summary ?? currentReport.verdict).slice(0, 500),
      scope: currentReport.reportV2?.scope.slice(0, 8).map(item => item.slice(0, 260)),
    } : mode === 'link' && chatSeed && error ? {
      title: '未读取的公开作品', text: '',
      reportSummary: '原作品正文尚未读取。只能作通用解释，不能判断该作品或产品。',
      scope: ['原作品正文未读取'],
    } : undefined;
    setChatDraft('');
    setChatError('');
    setChatBusy(true);
    setChatTurns(current => [...current, userTurn]);
    try {
      const answer = await apiJson<ChatReply>('/api/chat-turn', { question: prompt, history: previous, context }, controller.signal);
      if (!isCurrent()) return;
      setChatTurns(current => [...current, { id: crypto.randomUUID(), role: 'assistant', text: answer.answer, citations: answer.citations, scope: answer.scope }]);
    } catch (reason) {
      if (!isCurrent()) return;
      setChatTurns(current => current.filter(turn => turn.id !== userTurn.id));
      setChatDraft(prompt);
      setChatError(reason instanceof Error ? reason.message : '这一轮未能完成，请稍后再试。');
    } finally {
      if (activeChat.current === controller) { activeChat.current = null; setChatBusy(false); }
    }
  };

  const runAnalysis = async (input?: { mode: InputMode; link: string; text: string; ingredientLabel?: boolean; question?: string }) => {
    if (activeRead.current || activeChat.current) return;
    const activeMode = input?.mode ?? mode;
    const activeText = input?.text ?? text;
    const activeLink = input?.link ?? link;
    const activeIngredientLabel = input?.ingredientLabel ?? ingredientLabel;
    const activeFiles = input ? [] : files;
    const activeLinkUrl = extractUrl(activeLink);
    const activePlatform = getPlatform(activeLink);
    const message = validate(activeMode, activeText, activeLink);
    if (message || (activeMode === 'link' && !activePlatform)) { setError(message || '请提供可识别的作品链接。'); return; }
    if (activeMode === 'link' && input?.question) pendingLinkQuestion.current = { url: activeLinkUrl, text: input.question };
    const attachedQuestion = activeMode === 'link' && pendingLinkQuestion.current?.url === activeLinkUrl
      ? pendingLinkQuestion.current.text : '';

    const controller = new AbortController();
    activeRead.current = controller;
    const isCurrent = () => activeRead.current === controller && !controller.signal.aborted;
    const progress = (value: string) => { if (isCurrent()) setProgressDetail(value); };

    setError('');
    setReport(null);
    setAppState('analyzing');
    setStep(0);
    setProgressDetail('正在读取你提交的内容');
    if (activeMode !== 'link' || activeLinkUrl !== lastResolution?.url) setChatTurns([]);
    setChatSeed(activeMode === 'link' ? activeLinkUrl : activeMode === 'upload' ? activeFiles.map(item => item.file.name).join('、') : truncate(activeText, 180));
    setChatSeedDetails(activeMode === 'link' ? {
      supplement: truncate(activeText.trim(), 160), fileNames: activeFiles.map(item => item.file.name), question: attachedQuestion,
    } : null);

    let readyReport: AnalysisReport | null = null;

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
      let supplementOnly = false;
      let platformMediaTextPresent = false;

      if (activeMode === 'link') {
        // A prior read with no usable text must not delay user-supplied text or screenshots.
        supplementOnly = shouldUseSupplementOnly(lastResolution, activeLinkUrl, Boolean(activeText.trim() || activeFiles.length));
        try { resolver = supplementOnly ? lastResolution!.value : await resolvePublicLink(activeLinkUrl, progress, controller.signal); }
        catch(reason) {
          if (!isCurrent()) return;
          resolver = failedLinkResolution(activeLinkUrl, activePlatform!, reason);
        }
        if (!isCurrent()) return;
        setLastResolution({ url: activeLinkUrl, value: resolver, noUsableText: supplementOnly && lastResolution?.noUsableText });
        title = resolver.title;
        canonicalUrl = resolver.canonicalUrl;
        contentId = resolver.contentId;
        platformId = resolver.platform;
      } else if (activeMode === 'upload') {
        title = activeFiles[0]?.file.name ?? '本地素材';
      } else {
        title = truncate(activeText.trim(), 52);
      }

      setStep(1);
      if (activeMode === 'link') {
        const resolved = await extractResolvedContent(supplementOnly ? undefined : resolver?.extraction, progress);
        if (!isCurrent()) return;
        extraction = resolved.extraction;
        platformMediaTextPresent = containsPlatformMediaText(extraction);
        if (resolver?.limitation) extraction.limitations = [...new Set([...extraction.limitations, resolver.limitation])];
        features = resolved.features;
        if (activeText.trim() || activeFiles.length) {
          const extra = await extractFilesContent(activeFiles.map(item => item.file), activeText, progress, { source: 'supplement' });
          extraction = {
            ...extra,
            pageText: [extraction.pageText, extra.pageText].filter(Boolean).join('\n'),
            ocrText: [extraction.ocrText, extra.ocrText].filter(Boolean).join('\n'),
            transcript: [extraction.transcript, extra.transcript].filter(Boolean).join('\n'),
            combinedText: [extraction.combinedText, extra.combinedText].filter(Boolean).join('\n'),
            mediaAnalyzed: extraction.mediaAnalyzed + extra.mediaAnalyzed,
            frameCount: extraction.frameCount + extra.frameCount,
            mediaCoverage: [...extraction.mediaCoverage, ...extra.mediaCoverage],
            stages: combineExtractionStages(extraction.stages, extra.stages),
            limitations: [...extraction.limitations, ...extra.limitations, '包含用户补充内容，未确认与原链接完全一致'],
          };
        }
        if(!extraction.combinedText.trim()){
          setLastResolution(current => current?.url === activeLinkUrl ? { ...current, noUsableText: true } : current);
          throw new Error(resolver?.resolved ? '已取得作品媒体地址，但未提取到可分析的文字或口播。请补充原文、清晰截图或原视频。' : resolver?.limitation || '未能读取正文，请补充文字或截图。原链接已保留。');
        }
      } else if (activeMode === 'upload') {
        const localFiles = activeFiles.map((item) => item.file);
        [features, extraction] = await Promise.all([
          Promise.all(localFiles.map((file) => analyzeFile(file))),
          extractFilesContent(localFiles, activeText, progress),
        ]);
      } else {
        extraction = await extractFilesContent([], activeText);
      }

      if (!isCurrent()) return;
      const extractedText = extraction.combinedText || activeText;
      claims = analyzeClaims(extractedText);
      if (extractedText.trim().length >= 8) textHash = textSimHash(extractedText);

      setStep(2);
      setProgressDetail('正在区分宣传、引用与辟谣语境');

      setStep(3);
      setProgressDetail('正在对照公开规则和可信来源');
      const result = await apiJson<AnalysisReport>('/api/analyze', {
        sourceType: activeMode,
        ingredientLabel: activeIngredientLabel,
        platform: platformId,
        canonicalUrl,
        contentId,
        title,
        textHash,
        files: features,
        claims,
        extraction,
        resolver: resolver ? { resolved: resolver.resolved, contentStatus: resolver.contentStatus, platformMediaTextPresent, limitation: resolver.limitation, author: resolver.author, fetchedAt: resolver.fetchedAt } : undefined,
      }, controller.signal);

      if (!isCurrent()) return;
      setStep(4);
      setProgressDetail('马上就好');
      readyReport = { ...result, resolver };
      setReport(readyReport);
      setAppState('result');
    } catch (reason) {
      if (!isCurrent()) return;
      setError(reason instanceof Error ? reason.message : '检测失败，请稍后重试。');
      setAdvancedOpen(true);
      setAppState('input');
    } finally {
      if (activeRead.current === controller) {
        activeRead.current = null;
        if (readyReport && attachedQuestion) {
          pendingLinkQuestion.current = null;
          void answerQuestion(attachedQuestion, readyReport, true);
        }
      }
    }
  };

  const sendChat = async (suggestion?: string) => {
    const prompt = (suggestion ?? chatDraft).trim();
    if (!prompt || activeRead.current || activeChat.current) return;
    const suppliedUrl = extractUrl(prompt);
    if (!suppliedUrl && /https?:\/\/\S+/i.test(prompt)) { setChatError('目前只能读取小红书或抖音的公开作品链接；无法凭其他链接猜测页面内容。'); return; }
    if (suppliedUrl) {
      if (!getPlatform(prompt)) { setChatError('目前支持小红书和抖音公开作品链接；也可以直接提问。'); return; }
      const attachedQuestion = questionBesideLink(prompt);
      if (attachedQuestion.length > 500) { setChatError('链接附带的问题最多 500 字，请缩短后再发送。'); return; }
      clearContent();
      setMode('link');
      setLink(prompt);
      setChatDraft('');
      void runAnalysis({ mode: 'link', link: prompt, text: '', ingredientLabel: false, question: attachedQuestion });
      return;
    }
    if (prompt.length < 2 || prompt.length > 500) { setChatError('提问请控制在 2–500 字；较长的文案可使用“核验文案”。'); return; }
    await answerQuestion(prompt, report);
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
  const hasHairGrowthClaim = highRiskSignals.some((signal) => signal.includes('毛发生长'));
  const hasMedicalClaim = highRiskSignals.some((signal) => signal.includes('医疗'));
  const contextualSignals = [
    ...(report?.externalEvidence.filter((item) => item.status === 'context' && item.signal !== '化妆品功效宣称').map((item) => item.signal) ?? []),
    ...mediumRiskClaims.map((item) => item.rule),
  ].map((signal) => signal.includes('绝对化') || signal.includes('夸大') ? '夸大表述' : signal.includes('背书') ? '背书信息' : signal.includes('天然') ? '天然表述' : signal);
  const lowSignalCount = new Set(contextualSignals).size;
  const resultKind = contentLimited ? 'unknown' : highRiskCount ? 'risk' : unsupportedCount || lowSignalCount >= 2 ? 'warning' : lowSignalCount ? 'low' : 'clear';
  const resultHeadline = resultKind === 'unknown'
    ? '证据不足，暂无法判断'
    : resultKind === 'risk'
      ? hasHairGrowthClaim ? '“增长睫毛”暂缺可信依据' : hasMedicalClaim ? '不应按治疗作用理解' : '该核心宣称不建议采信'
      : resultKind === 'warning' ? '存在未经证实的宣传信息' : resultKind === 'low' ? '存在轻微夸大' : '未发现明显问题';
  const resultDescription = resultKind === 'unknown'
    ? '没有取得足够正文、画面或产品信息，本次不作确定性判断。'
    : resultKind === 'risk'
      ? hasHairGrowthClaim
        ? '内容宣称能够促进睫毛或毛发生长，但未提供可核验的人体功效评价、产品备案信息或完整成分依据。'
        : `发现 ${highRiskCount} 类高风险表述；结论针对宣传内容，不等同于认定商品是假货。`
      : resultKind === 'warning'
        ? unsupportedCount ? `发现 ${unsupportedCount} 项缺少可核验依据的功效宣称。` : `发现 ${lowSignalCount} 类需要进一步核验的宣传信息。`
        : resultKind === 'low'
          ? '发现轻微夸大用语，不影响对其他内容的正常参考。'
          : '未发现明显的夸大、绝对化或违规表述。';
  const professionalEvidence = report ? [...report.externalEvidence].sort((left, right) => {
    const priority = (item: EvidenceCheck) => item.signal.includes('乌斯玛') ? 0 : item.kind === '法规依据' && item.status !== 'context' ? 1 : item.kind === '人体研究' ? 2 : item.kind === '法规依据' ? 3 : 4;
    return priority(left) - priority(right);
  }).slice(0, 4) : [];
  const evidenceExcerpts = Array.from(new Set(professionalEvidence.map((item) => item.excerpt).filter(Boolean))).slice(0, 2);
  const evidenceSources = Array.from(new Map(professionalEvidence.map((item) => [item.source.url, item.source])).values());
  const assessmentBoundary = hasHairGrowthClaim
    ? '本次只能判断“睫毛增长”宣传的证据是否充分。没有取得产品全成分、注册备案编号或实验室检测结果，不能判断产品是否含违禁成分，也不能把宣传风险等同于假货。'
    : '本报告判断的是公开内容中的宣传证据，不替代产品注册备案核验、成分检测、皮肤科诊断或监管机关认定。';

  const seedSource = mode === 'link' ? sharePreview(chatSeed) : null;
  const showAttachedQuestion = Boolean(chatSeedDetails?.question && !chatTurns.some(turn => turn.role === 'user' && turn.text === chatSeedDetails.question));
  const hasSupplement = Boolean(chatSeedDetails?.supplement || chatSeedDetails?.fileNames.length);
  const resultSource = report?.reportV2?.scope[0]
    ?? (mode === 'link' ? hasSupplement ? '含用户补充内容 · 分析范围见报告' : '分析范围见报告'
      : mode === 'upload' ? '依据上传的素材' : '依据粘贴的文字');
  const chatLimitReached = chatTurns.filter(turn => turn.role === 'user').length >= 6;

  const conversation = <section className="conversation" aria-label="美妆核验对话">
    <div className="conversation-heading"><span className="conversation-heading-caption">和美有关的疑问，从这里聊起。</span>{chatSeed || chatTurns.length ? <button className="conversation-new" type="button" onClick={reset}>{appState === 'analyzing' ? '取消核验' : '新对话'}</button> : null}</div>
    <div className="conversation-messages" aria-live="polite" ref={messageScroll}>
      <div className="conversation-message assistant"><span className="visually-hidden">助手回复：</span><p>你好，把公开作品链接发给我，我们可以一起看它说了什么、证据是否充分。你也可以直接问成分和护肤问题。</p></div>
      {chatSeed && <div className="conversation-message user"><span className="visually-hidden">你的消息：</span>{seedSource ? <div className="conversation-share"><span>{seedSource.name} · 作品链接</span><strong>{seedSource.detail}</strong><a href={seedSource.url} target="_blank" rel="noopener noreferrer" title={seedSource.url}>打开原作品 ↗</a>{chatSeedDetails?.supplement && <p className="conversation-share-extra"><b>补充文字</b>{chatSeedDetails.supplement}</p>}{chatSeedDetails && chatSeedDetails.fileNames.length > 0 && <p className="conversation-share-extra"><b>补充文件</b>{chatSeedDetails.fileNames.length} 个 · {truncate(chatSeedDetails.fileNames.join('、'), 50)}</p>}{showAttachedQuestion && <p className="conversation-share-extra"><b>还想问</b>{chatSeedDetails?.question}</p>}</div> : <p>{chatSeed}</p>}</div>}
      {appState === 'analyzing' && <div className="conversation-message assistant pending" role="status"><span className="visually-hidden">助手回复：</span><p>{progressDetail || analysisSteps[step]}</p><small>我会把实际读到的内容和判断依据放在这段对话里。</small></div>}
      {report && <div className="conversation-message assistant result-message"><span className="visually-hidden">核验结果：</span><span className="result-message-source">{resultSource}</span><p className="result-message-lead">{report.reportV2?.summary ?? report.verdict}</p>{report.reportV2?.findings.slice(0, 2).map((finding, index) => <div className="result-message-finding" key={`${index}:${finding.quote}`}><span className="result-message-label">原文</span><blockquote>“{truncate(finding.quote, 100)}”</blockquote><span className="result-message-label">判断</span><p>{truncate(finding.reason, 230)}</p></div>)}<small>{report.reportV2?.scope[0] ?? '分析范围见完整报告'}{(report.reportV2?.findings.length ?? 0) > 2 ? '；其余判断见完整报告' : ''}</small><button className="report-link" type="button" onClick={() => { const details = document.getElementById('conversation-report') as HTMLDetailsElement | null; if (details) { details.open = true; details.scrollIntoView({ behavior: 'smooth', block: 'start' }); } }}>查看完整依据与报告 ↓</button></div>}
      {appState === 'input' && chatSeed && error && <div className="conversation-message assistant recovery"><span className="visually-hidden">助手回复：</span><p>{error}</p>{mode === 'link' && <><small>未取得原文时，继续提问只能得到通用解释，不能判断这条作品。{chatSeedDetails?.question ? '你附带的问题已保留，补充材料核验后会接着回答。' : ''}</small><button type="button" onClick={openSupplement}>补充原文或截图</button></>}</div>}
      {chatTurns.map(turn => <div className={`conversation-message ${turn.role}`} key={turn.id}><span className="visually-hidden">{turn.role === 'user' ? '你的消息：' : '助手回复：'}</span><p>{turn.text}</p>{turn.scope && <small>{turn.scope}</small>}{turn.citations && turn.citations.length > 0 && <div className="conversation-citations"><span>参考资料</span>{turn.citations.map(item => <a key={item.id} href={item.url} target="_blank" rel="noopener noreferrer" title={item.excerpt}>{item.title} ↗</a>)}</div>}</div>)}
      {chatBusy && <div className="conversation-message assistant pending" role="status"><span className="visually-hidden">助手回复：</span><p>正在整理回答和可核对的依据…</p></div>}
    </div>
    <div className="conversation-compose"><label htmlFor="chat-draft" className="visually-hidden">发送链接或提问</label><textarea id="chat-draft" value={chatDraft} maxLength={3000} onChange={event => { setChatDraft(event.target.value); setChatError(''); }} onKeyDown={event => { if (event.key === 'Enter' && !event.shiftKey && !event.nativeEvent.isComposing) { event.preventDefault(); void sendChat(); } }} placeholder={appState === 'analyzing' ? '正在核验这条内容…' : chatLimitReached ? '本轮追问已满，请开启新对话' : report ? '继续问这条内容：成分、证据、没覆盖的部分…' : '发一条公开作品链接，或问我一个美妆问题…'} rows={2} disabled={chatBusy || appState === 'analyzing' || chatLimitReached}/><button type="button" onClick={() => void sendChat()} disabled={chatBusy || appState === 'analyzing' || chatLimitReached || !chatDraft.trim()} aria-label="发送消息"><Icon name="arrow"/></button></div>
    {chatError && <p className="conversation-error" role="alert">{chatError}</p>}
    {chatLimitReached && <p className="conversation-limit">本轮已问满 6 次。<button type="button" onClick={reset}>开启新对话</button></p>}
    {appState !== 'analyzing' && !chatLimitReached && <div className="conversation-suggestions"><span>{report ? '接着问' : '试试这样问'}</span>{(report ? ['这款产品真的有效吗？', '哪些成分有研究？', '这份报告有哪些没覆盖？'] : ['烟酰胺有什么用？', '怎样判断美妆宣传有没有依据？']).map(item => <button key={item} type="button" onClick={() => void sendChat(item)} disabled={chatBusy}>{item}</button>)}</div>}
    <p className="conversation-disclosure">问题和当前材料会发送至 DeepSeek；请勿提交隐私信息。回答有范围限制，具体产品效果以完整证据为准。</p>
  </section>;

  return (
    <main className="product-shell">
      <a className="skip-link" href="#workspace">跳到检测区</a>
      <header className="product-header">
        <button className="brand-button" type="button" onClick={reset} aria-label="返回检测首页">
          <span className="brand-mark"><Icon name="shield"/></span><span><strong>真妍盾</strong><small>BEAUTYPROOF</small></span>
        </button>
        <div className="header-product-label"><span className="header-caption">美妆，值得有据可依。</span><a href="#how-it-works" onClick={()=>{const help=document.querySelector<HTMLDetailsElement>('#how-it-works');if(help)help.open=true;}}>核验说明 <Icon name="info"/></a></div>
      </header>

      <section className="input-workspace" id="workspace">
          <div className="workspace-heading"><span className="eyebrow">THE BEAUTY OF KNOWING</span><h1>关于美，<span>我们聊得更明白。</span></h1><p>发链接，问成分，追问证据。每一步都说明实际看到了什么。</p></div>
          {conversation}
          {appState === 'input' && <>
          <div className="advanced-entry"><button type="button" aria-expanded={advancedOpen} onClick={() => setAdvancedOpen(value => !value)}>{advancedOpen ? '收起更多输入方式' : '核验文案 / 上传截图或视频'} <Icon name="arrow"/></button><span>需要补充原文或成分标签？在这里继续。</span></div>
          {advancedOpen && <div className="input-layout advanced-input-layout">
          <div className="input-card">
            <div className="input-card-heading"><span className="eyebrow">YOUR BEAUTY CHECK</span><h2>开启你的美妆核验</h2></div>
            <input ref={fileInput} type="file" multiple className="visually-hidden" tabIndex={-1} aria-label="选择图片或视频" accept="image/jpeg,image/png,image/webp,video/mp4,video/quicktime" onChange={onFileChange} />
            <div className="mode-switch" role="tablist" aria-label="输入方式">
              {modes.map((item,index) => <button key={item.id} id={`tab-${item.id}`} aria-controls={`panel-${item.id}`} tabIndex={mode===item.id?0:-1} type="button" role="tab" aria-selected={mode === item.id} className={mode === item.id ? 'active' : ''} onKeyDown={event=>{const next=event.key==='ArrowRight'?(index+1)%modes.length:event.key==='ArrowLeft'?(index+modes.length-1)%modes.length:event.key==='Home'?0:event.key==='End'?modes.length-1:null;if(next!==null){event.preventDefault();changeMode(modes[next].id);document.getElementById(`tab-${modes[next].id}`)?.focus();}}} onClick={() => changeMode(item.id)}><Icon name={item.icon}/>{item.label}</button>)}
            </div>

            {mode === 'link' && <div className="mode-panel" id="panel-link" role="tabpanel" aria-labelledby="tab-link">
              <label htmlFor="work-url">粘贴作品链接</label>
              <div className={`url-field ${link && !platform ? 'invalid' : ''}`}><Icon name="link" className="field-icon"/><input id="work-url" value={link} onChange={(event) => changeLink(event.target.value)} placeholder="粘贴链接，或整段分享文案" autoComplete="off" aria-invalid={Boolean(link&&!platform)} />{link && <button type="button" onClick={() => changeLink('')} aria-label="清空链接"><Icon name="close"/></button>}</div>
              {platform ? <div className="parsed-source"><span className={`platform-mark ${platform.className}`}>{platform.mark}</span><div><strong>{platform.name}作品</strong><small>{truncate(linkUrl)}</small></div><span className="source-state">{resolutionState(lastResolution?.url === linkUrl ? lastResolution.value : undefined)}</span></div> : <div className="supported-row"><span className="platform-word xhs-word">小红书</span><span className="platform-word">抖音</span><span>支持公开作品链接</span></div>}
              {error && showLinkRecovery && <p className="form-error" role="alert" tabIndex={-1}>{error}</p>}
              {showLinkRecovery && <p className="link-recovery"><a href={linkUrl} target="_blank" rel="noopener noreferrer">打开原作品 ↗</a><span>原链接已保留；若读取内容不足，可补充文字或截图。</span></p>}
              <details className="supplement" id="link-supplement" open={Boolean(error || (showLinkRecovery && (text || files.length)))}><summary>补充文字或截图 <span>选填</span></summary><p>未取得原作品正文时，可以直接分析你补充的内容。</p><textarea aria-label="补充文字" value={text} maxLength={3000} onChange={e=>setText(e.target.value)} placeholder="粘贴作品原文，可保留链接一起分析"/><button type="button" onClick={()=>fileInput.current?.click()}>添加截图或原视频</button>{files.map((f,i)=><div className="supplement-file" key={i}>{f.file.name} <button type="button" onClick={()=>removeFile(i)}>移除</button></div>)}</details>
            </div>}

            {mode === 'upload' && <div className="mode-panel" id="panel-upload" role="tabpanel" aria-labelledby="tab-upload">
              <div className="upload-zone" role="button" tabIndex={0} onClick={() => fileInput.current?.click()} onKeyDown={(event) => { if (event.key === 'Enter'||event.key===' ') {event.preventDefault();fileInput.current?.click();} }} onDragOver={(event) => event.preventDefault()} onDrop={onDrop}><span className="upload-symbol"><Icon name="upload"/></span><strong>拖入素材，或点击上传</strong><span>作品截图、成分标签或原视频</span><small>最多 4 个文件 · 单个不超过 200 MB</small></div>
              {files.length > 0 && <div className="upload-list">{files.map((item, index) => <div className="upload-item" key={`${item.file.name}-${index}`}>{item.kind === 'image' ? <img src={item.preview} alt="上传素材预览" /> : item.kind === 'video' ? <video src={item.preview} muted /> : <span className="file-type">TXT</span>}<div><strong>{item.file.name}</strong><small>{formatSize(item.file.size)} · 已在本机读取</small></div><button type="button" onClick={() => removeFile(index)} aria-label={`移除 ${item.file.name}`}>×</button></div>)}</div>}
            </div>}

            {mode === 'text' && <div className="mode-panel" id="panel-text" role="tabpanel" aria-labelledby="tab-text"><label htmlFor="work-text">想核验哪段内容？</label><div className="text-field"><textarea id="work-text" value={text} maxLength={3000} onChange={(event) => { setText(event.target.value); setError(''); }} placeholder="粘贴种草文案、功效宣称或评论区话术…" /><span>{text.length} / 3000</span></div></div>}

            {files.length>0&&<label className="label-confirm"><input type="checkbox" checked={ingredientLabel} onChange={e=>setIngredientLabel(e.target.checked)}/> 上传的截图是产品成分标签（否则按内容提及处理）</label>}
            {error && !showLinkRecovery && <p className="form-error" role="alert" tabIndex={-1}>{error}</p>}
            {service&&!service.available&&<p className="service-notice" role="status">{service.message} 成分资料对照仍可使用。</p>}
            <button className="primary-action" type="button" onClick={() => void runAnalysis()} disabled={chatBusy}>开始核验 <Icon name="arrow"/></button>
            <div className="card-footer"><Icon name="shield"/><span>提取的文字将发送至 DeepSeek 分析，请勿提交隐私信息。</span></div>
          </div>
          <aside className="editorial-panel"><div className="editorial-image"><img src="/beauty-luxe-editorial.png" alt="暖金光线下的玫瑰色精华瓶、乳霜与酒红缎面" width="1122" height="1402" fetchPriority="high"/></div><div className="editorial-note"><span className="eyebrow">BEYOND THE BEAUTIFUL</span><h2>心动之外，<br/>多一份笃定。</h2><p>欣赏美，也了解美。</p></div></aside>
          </div>}
          {advancedOpen && <div className="example-prompts"><span>没有现成内容？试着填入</span><button type="button" onClick={()=>fillExample('这款润肤乳含尿素，帮助皮肤屏障。')}>保湿与屏障 <Icon name="arrow"/></button><button type="button" onClick={()=>fillExample('这款精华含烟酰胺，主打提亮肤色。')}>烟酰胺与提亮 <Icon name="arrow"/></button></div>}
          <div className="analysis-principles"><div><span>01</span><p><strong>看原文</strong>保留实际读到的内容</p></div><div><span>02</span><p><strong>查成分</strong>对照研究与适用条件</p></div><div><span>03</span><p><strong>找依据</strong>让每一项判断可追溯</p></div></div>
          </>}
      </section>

      {appState === 'result' && report && <div className="result-workspace">
        <details className="conversation-report" id="conversation-report"><summary>完整核验报告 <span>成分 · 宣传 · 原文与范围</span></summary>
        <div className="result-topbar"><button type="button" onClick={editContent}>← 返回修改</button><span>BEAUTYPROOF / REPORT</span></div>
        <div className="source-strip"><span className={`platform-mark ${mode === 'link' ? platform?.className ?? 'xhs' : 'local'}`}>{mode === 'link' ? platform?.mark ?? '小' : mode === 'upload' ? '件' : '文'}</span><div><small>{resolver ? `${resolver.platform === 'douyin' ? '抖音' : '小红书'} · ${resolver.resolved ? resolutionState(resolver) : `仅分析补充内容 · ${resolutionState(resolver)}`}` : mode === 'upload' ? '本地媒体' : '文字内容'}</small><strong>{report.title}</strong>{mode === 'link' && linkUrl && <small><a href={linkUrl} target="_blank" rel="noopener noreferrer">打开原作品 ↗</a></small>}</div></div>

        {resolver?.extraction?.media?.some(item=>item.type==='image')&&<details className="source-media"><summary>查看读取到的图片 · {resolver.extraction.media.filter(item=>item.type==='image').length} 张</summary><p>按原文顺序展示。图片取得与画面文字识别是两个步骤，实际分析范围见报告。</p><div className="source-media-grid">{resolver.extraction.media.filter(item=>item.type==='image').map((item,index)=><figure key={`${index}:${item.url}`}><a href={`/api/media?url=${encodeURIComponent(item.url)}${item.sha256?`&sha256=${item.sha256}`:''}`} target="_blank" rel="noreferrer"><img src={`/api/media?url=${encodeURIComponent(item.url)}${item.sha256?`&sha256=${item.sha256}`:''}`} alt={`原文图片 ${index+1}`} loading="lazy"/></a><figcaption>原文图片 {index+1}</figcaption></figure>)}</div></details>}
        {report.reportV2 ? <EvidenceReport report={report.reportV2} text={report.extraction.combinedText} onReset={reset} onEdit={editContent}/> : <><section className={`consumer-result ${resultKind}`}>
          <span className="result-icon">{resultKind === 'clear' ? '✓' : resultKind === 'unknown' ? '?' : '!'}</span>
          <div className="result-copy"><small>检测结果</small><h1>{resultHeadline}</h1><p>{resultDescription}</p></div>
          <button type="button" onClick={reset}>检测另一条</button>
        </section>
        {professionalEvidence.length > 0 && <section className="professional-basis" aria-labelledby="basis-title">
          <div className="basis-heading"><div><small>专业依据</small><h2 id="basis-title">为什么得出这个结论</h2></div><span>{professionalEvidence.length} 项可追溯依据</span></div>
          {evidenceExcerpts.length > 0 && <div className="content-evidence"><small>本次实际读到的表述</small>{evidenceExcerpts.map((excerpt) => <blockquote key={excerpt}>“{excerpt}”</blockquote>)}</div>}
          <div className="basis-grid">{professionalEvidence.map((item) => <article key={item.signal}>
            <div className="basis-meta"><span>{item.kind}</span><b className={item.strength === '明确' ? 'strong' : item.strength === '中等' ? 'moderate' : 'limited'}>证据强度：{item.strength}</b></div>
            <h3>{item.signal}</h3>
            <p>{item.conclusion}</p>
          </article>)}</div>
          {evidenceSources.length > 0 && <div className="basis-sources"><span>依据来源</span>{evidenceSources.map((source) => <a key={source.url} href={source.url} target="_blank" rel="noreferrer">{source.organization} ↗</a>)}</div>}
        </section>}
        <aside className="assessment-boundary"><span>专业边界</span><p>{assessmentBoundary}</p></aside></>}
        </details>
      </div>}
      <details className="how-it-works" id="how-it-works"><summary>我们如何核验一条美妆内容？</summary><div><p><strong>从你提供的内容出发。</strong>读取公开链接，或提取上传图片、视频中的文字。平台读取受限时，可补充原文继续分析。</p><p><strong>分别查看宣传与成分依据。</strong>对照公开规则与已收录研究，展示来源、人群、浓度和使用条件；资料不足时明确说明。</p><p><strong>把判断的边界留在报告里。</strong>原料研究不能直接证明成品有效，核验也不等于实物鉴定或医疗建议。</p></div></details>
      <footer className="site-footer"><span>真妍盾 <span className="footer-divider">/</span> BEAUTYPROOF</span><span>让判断回到证据。</span></footer>
    </main>
  );
}
