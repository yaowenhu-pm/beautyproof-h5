'use client';

import { analyzeFile } from '@/lib/client/analysis';
import type { FileFeature } from '@/lib/client/analysis';

export type ExtractionStage = {
  status: 'complete' | 'partial' | 'limited' | 'not_applicable';
  detail: string;
};

export type ContentExtraction = {
  pageText: string;
  ocrText: string;
  transcript: string;
  combinedText: string;
  mediaAnalyzed: number;
  frameCount: number;
  stages: {
    page: ExtractionStage;
    ocr: ExtractionStage;
    asr: ExtractionStage;
  };
  limitations: string[];
};

export type ResolvedMedia = {
  type: 'image' | 'video';
  url: string;
};

export type ResolvedContent = {
  pageText?: string;
  textStatus?: 'full' | 'partial' | 'limited';
  media?: ResolvedMedia[];
};

type Progress = (message: string) => void;

let ocrWorkerPromise: Promise<{
  recognize(input: Blob): Promise<{ data: { text: string } }>;
  terminate(): Promise<unknown>;
}> | null = null;

let transcriberPromise: Promise<(audio: Float32Array, options: Record<string, unknown>) => Promise<unknown>> | null = null;

function normalizeText(value: string) {
  return value.replace(/[\t ]+/g, ' ').replace(/\n{3,}/g, '\n\n').trim();
}

function withTimeout<T>(promise: Promise<T>, timeoutMs: number, message: string) {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(message)), timeoutMs);
  });
  return Promise.race([promise, timeout]).finally(() => { if (timer) clearTimeout(timer); });
}

function waitForMedia(target: HTMLMediaElement, event: string) {
  return new Promise<void>((resolve, reject) => {
    const onReady = () => { cleanup(); resolve(); };
    const onError = () => { cleanup(); reject(new Error('媒体文件无法读取')); };
    const cleanup = () => { target.removeEventListener(event, onReady); target.removeEventListener('error', onError); };
    target.addEventListener(event, onReady, { once: true });
    target.addEventListener('error', onError, { once: true });
  });
}

function canvasBlob(source: CanvasImageSource, width: number, height: number) {
  const scale = Math.min(1, 1280 / Math.max(width, height));
  const canvas = document.createElement('canvas');
  canvas.width = Math.max(1, Math.round(width * scale));
  canvas.height = Math.max(1, Math.round(height * scale));
  const context = canvas.getContext('2d');
  if (!context) throw new Error('浏览器无法读取画面');
  context.drawImage(source, 0, 0, canvas.width, canvas.height);
  return new Promise<Blob>((resolve, reject) => canvas.toBlob((blob) => blob ? resolve(blob) : reject(new Error('画面转换失败')), 'image/jpeg', .86));
}

async function imageForOcr(file: File) {
  const bitmap = await createImageBitmap(file);
  try {
    return await canvasBlob(bitmap, bitmap.width, bitmap.height);
  } finally {
    bitmap.close();
  }
}

async function videoFrames(file: File) {
  const url = URL.createObjectURL(file);
  const video = document.createElement('video');
  video.muted = true;
  video.preload = 'metadata';
  video.src = url;
  try {
    await waitForMedia(video, 'loadedmetadata');
    const duration = Number.isFinite(video.duration) ? video.duration : 0;
    const ratios = duration > 4 ? [.08, .28, .5, .72, .92] : [.15, .5, .85];
    const frames: Blob[] = [];
    for (const ratio of ratios) {
      video.currentTime = Math.max(0, Math.min(duration * ratio, Math.max(0, duration - .05)));
      await waitForMedia(video, 'seeked');
      frames.push(await canvasBlob(video, video.videoWidth, video.videoHeight));
    }
    return frames;
  } finally {
    URL.revokeObjectURL(url);
    video.removeAttribute('src');
    video.load();
  }
}

async function getOcrWorker() {
  if (!ocrWorkerPromise) {
    ocrWorkerPromise = import('tesseract.js').then(async ({ createWorker }) => {
      const worker = await createWorker(['chi_sim', 'eng'], 1, { logger: () => undefined });
      return worker as unknown as Awaited<typeof ocrWorkerPromise>;
    });
  }
  return ocrWorkerPromise;
}

async function recognizeFrames(frames: Blob[], progress?: Progress) {
  if (!frames.length) return '';
  progress?.('正在读取画面文字');
  const worker = await withTimeout(getOcrWorker(), 15000, 'OCR 初始化超时');
  const texts: string[] = [];
  for (const frame of frames.slice(0, 5)) {
    let result: { data: { text: string } };
    try {
      result = await withTimeout(worker.recognize(frame), 15000, 'OCR 识别超时');
    } catch (error) {
      const pendingWorker = ocrWorkerPromise;
      ocrWorkerPromise = null;
      void pendingWorker?.then((current) => current.terminate()).catch(() => undefined);
      throw error;
    }
    const value = normalizeText(result.data.text);
    if (value.length >= 2 && !texts.includes(value)) texts.push(value);
  }
  return normalizeText(texts.join('\n'));
}

async function decodeAudio(file: File) {
  const AudioContextClass = window.AudioContext || (window as typeof window & { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
  if (!AudioContextClass) throw new Error('当前浏览器不支持音频解码');
  const context = new AudioContextClass({ sampleRate: 16000 });
  try {
    const buffer = await context.decodeAudioData(await file.arrayBuffer());
    const length = Math.min(buffer.length, buffer.sampleRate * 60);
    const mono = new Float32Array(length);
    for (let channel = 0; channel < buffer.numberOfChannels; channel += 1) {
      const data = buffer.getChannelData(channel);
      for (let index = 0; index < length; index += 1) mono[index] += data[index] / buffer.numberOfChannels;
    }
    return mono;
  } finally {
    await context.close();
  }
}

async function getTranscriber() {
  if (!transcriberPromise) {
    transcriberPromise = import('@huggingface/transformers').then(async ({ env, pipeline }) => {
      env.allowLocalModels = false;
      const device = (navigator as Navigator & { gpu?: unknown }).gpu ? 'webgpu' : 'wasm';
      const model = await pipeline('automatic-speech-recognition', 'onnx-community/whisper-tiny', {
        device,
        dtype: 'q4',
      });
      return model as unknown as (audio: Float32Array, options: Record<string, unknown>) => Promise<unknown>;
    });
  }
  return transcriberPromise;
}

async function transcribeVideo(file: File, progress?: Progress) {
  progress?.('正在解码视频口播');
  const audio = await decodeAudio(file);
  if (audio.length < 8000) return '';
  progress?.('正在运行本地 Whisper 转写');
  const transcriber = await getTranscriber();
  const result = await transcriber(audio, {
    task: 'transcribe',
    chunk_length_s: 20,
    stride_length_s: 3,
    return_timestamps: true,
  }) as { text?: string } | string;
  return normalizeText(typeof result === 'string' ? result : result.text ?? '');
}

function transcriptQuality(value: string) {
  const compact = Array.from(value.replace(/[\s\p{P}\p{S}]/gu, ''));
  if (compact.length < 4) return { usable: false, reason: '识别文字过短，无法形成可靠口播' };
  const counts = new Map<string, number>();
  compact.forEach((character) => counts.set(character, (counts.get(character) ?? 0) + 1));
  const maxShare = Math.max(...counts.values()) / compact.length;
  const uniqueRatio = counts.size / compact.length;
  if (maxShare > .38 || (compact.length > 40 && uniqueRatio < .09) || /(.)\1{7,}/u.test(compact.join(''))) {
    return { usable: false, reason: '识别结果重复度过高，已作为低质量转写丢弃' };
  }
  return { usable: true, reason: '' };
}

export async function extractFilesContent(files: File[], pageText = '', progress?: Progress) {
  const ocr: string[] = [];
  const transcripts: string[] = [];
  const limitations: string[] = [];
  let frameCount = 0;
  let ocrAttempted = false;
  let asrAttempted = false;

  for (const file of files.slice(0, 3)) {
    if (file.type.startsWith('image/')) {
      ocrAttempted = true;
      try {
        const frame = await imageForOcr(file);
        frameCount += 1;
        const value = await recognizeFrames([frame], progress);
        if (value) ocr.push(value);
      } catch (error) {
        limitations.push(`图片 OCR：${error instanceof Error ? error.message : '读取失败'}`);
      }
    }
    if (file.type.startsWith('video/')) {
      ocrAttempted = true;
      try {
        const frames = await videoFrames(file);
        frameCount += frames.length;
        const value = await recognizeFrames(frames, progress);
        if (value) ocr.push(value);
      } catch (error) {
        limitations.push(`视频 OCR：${error instanceof Error ? error.message : '读取失败'}`);
      }
      asrAttempted = true;
      try {
        const value = await transcribeVideo(file, progress);
        const quality = transcriptQuality(value);
        if (value && quality.usable) transcripts.push(value);
        else limitations.push(`ASR：${quality.reason || '未识别到清晰口播'}`);
      } catch (error) {
        limitations.push(`ASR：${error instanceof Error ? error.message : '转写失败'}`);
      }
    }
  }

  const cleanPage = normalizeText(pageText);
  const ocrText = normalizeText(ocr.join('\n'));
  const transcript = normalizeText(transcripts.join('\n'));
  return {
    pageText: cleanPage,
    ocrText,
    transcript,
    combinedText: normalizeText([cleanPage, ocrText, transcript].filter(Boolean).join('\n')),
    mediaAnalyzed: files.length,
    frameCount,
    stages: {
      page: cleanPage ? { status: 'complete', detail: `已读取 ${cleanPage.length} 字平台正文或输入文字` } : { status: 'not_applicable', detail: '没有可用页面正文' },
      ocr: !ocrAttempted ? { status: 'not_applicable', detail: '没有图片或视频画面' } : ocrText ? { status: 'complete', detail: `从 ${frameCount} 个画面提取 ${ocrText.length} 字` } : { status: 'limited', detail: '已读取画面，但未识别到清晰文字' },
      asr: !asrAttempted ? { status: 'not_applicable', detail: '输入中没有视频口播' } : transcript ? { status: 'complete', detail: `Whisper 转写 ${transcript.length} 字` } : { status: 'limited', detail: limitations.find((item) => item.startsWith('ASR')) ?? '未取得口播文字' },
    },
    limitations,
  } satisfies ContentExtraction;
}

async function fetchResolvedMedia(item: ResolvedMedia, index: number) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 15000);
  try {
    const response = await fetch(`/api/media?url=${encodeURIComponent(item.url)}`, { signal: controller.signal });
    if (!response.ok) throw new Error(`媒体读取失败（HTTP ${response.status}）`);
    const blob = await response.blob();
    const extension = item.type === 'video' ? 'mp4' : 'jpg';
    return new File([blob], `平台媒体-${index + 1}.${extension}`, { type: blob.type || (item.type === 'video' ? 'video/mp4' : 'image/jpeg') });
  } catch (error) {
    if (controller.signal.aborted) throw new Error('媒体读取超时');
    throw error;
  } finally {
    clearTimeout(timer);
  }
}

export async function extractResolvedContent(content: ResolvedContent | undefined, progress?: Progress) {
  const candidates = content?.media ?? [];
  const selected = candidates.some((item) => item.type === 'video')
    ? [candidates.find((item) => item.type === 'video')!]
    : candidates.slice(0, 1);
  const files: File[] = [];
  const downloadLimitations: string[] = [];
  for (let index = 0; index < selected.length; index += 1) {
    try {
      progress?.(`正在读取平台${selected[index].type === 'video' ? '视频' : '图片'}`);
      files.push(await fetchResolvedMedia(selected[index], index));
    } catch (error) {
      downloadLimitations.push(error instanceof Error ? error.message : '平台媒体无法读取');
    }
  }
  const extraction = await extractFilesContent(files, content?.pageText ?? '', progress);
  extraction.limitations.push(...downloadLimitations);
  if (!content?.pageText && !files.length) {
    extraction.stages.page = { status: 'limited', detail: '平台仅返回作品标识，未开放正文和媒体' };
  } else if (content?.textStatus === 'partial') {
    extraction.stages.page = { status: 'partial', detail: '仅取得平台公开标题或摘要' };
  }
  const features: FileFeature[] = [];
  for (const file of files) {
    try { features.push(await analyzeFile(file)); } catch { /* extraction still remains useful */ }
  }
  return { extraction, features };
}
