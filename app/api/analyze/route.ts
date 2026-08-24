import { ensureSchema } from '@/lib/server/db';
import { evaluateEvidence } from '@/lib/shared/evidence';
import type { EvidenceCheck } from '@/lib/shared/evidence';

type ClaimFinding = { text: string; rule: string; level: 'high' | 'medium' | 'info' };
type FileFeature = {
  name: string;
  type: string;
  size: number;
  sha256: string;
  perceptualHash?: string;
  frameHashes?: string[];
  width?: number;
  height?: number;
  duration?: number;
  c2pa?: { present: boolean; valid?: boolean; issuer?: string; error?: string };
  metadata?: { software?: string; make?: string; model?: string; createdAt?: string };
};

type ExtractionStage = { status: 'complete' | 'partial' | 'limited' | 'not_applicable'; detail: string };
type ContentExtraction = {
  pageText: string;
  ocrText: string;
  transcript: string;
  combinedText: string;
  mediaAnalyzed: number;
  frameCount: number;
  stages: { page: ExtractionStage; ocr: ExtractionStage; asr: ExtractionStage };
  limitations: string[];
};

type AnalyzePayload = {
  sourceType: 'link' | 'upload' | 'text';
  platform?: string;
  canonicalUrl?: string;
  contentId?: string;
  title?: string;
  textHash?: string;
  files?: FileFeature[];
  claims?: ClaimFinding[];
  extraction?: ContentExtraction;
  resolver?: { resolved?: boolean; limitation?: string; author?: string; fetchedAt?: string };
};

type StoredRow = {
  id: string;
  source_type: string;
  platform: string | null;
  canonical_url: string | null;
  content_id: string | null;
  title: string;
  sha256: string | null;
  perceptual_hash: string | null;
  text_hash: string | null;
  features_json: string;
  created_at: number;
};

function hammingHex(a?: string | null, b?: string | null) {
  if (!a || !b || a.length !== b.length) return Number.POSITIVE_INFINITY;
  let distance = 0;
  for (let index = 0; index < a.length; index += 1) {
    let value = Number.parseInt(a[index], 16) ^ Number.parseInt(b[index], 16);
    while (value) { distance += value & 1; value >>= 1; }
  }
  return distance;
}

function similarityFromDistance(distance: number, bits = 64) {
  return Math.max(0, Math.round((1 - distance / bits) * 100));
}

function safeJson(value: string) {
  try { return JSON.parse(value) as { files?: FileFeature[]; resolver?: AnalyzePayload['resolver'] }; } catch { return {}; }
}

function cleanExtraction(value?: ContentExtraction): ContentExtraction {
  const fallback: ExtractionStage = { status: 'not_applicable', detail: '未执行' };
  const pageText = String(value?.pageText ?? '').slice(0, 12000);
  const ocrText = String(value?.ocrText ?? '').slice(0, 8000);
  const transcript = String(value?.transcript ?? '').slice(0, 12000);
  return {
    pageText,
    ocrText,
    transcript,
    combinedText: String(value?.combinedText || [pageText, ocrText, transcript].filter(Boolean).join('\n')).slice(0, 24000),
    mediaAnalyzed: Math.max(0, Math.min(4, Number(value?.mediaAnalyzed ?? 0))),
    frameCount: Math.max(0, Math.min(12, Number(value?.frameCount ?? 0))),
    stages: {
      page: value?.stages?.page ?? fallback,
      ocr: value?.stages?.ocr ?? fallback,
      asr: value?.stages?.asr ?? fallback,
    },
    limitations: Array.isArray(value?.limitations) ? value.limitations.map(String).slice(0, 8) : [],
  };
}

export async function POST(request: Request) {
  try {
    const payload = await request.json() as AnalyzePayload;
    if (!['link', 'upload', 'text'].includes(payload.sourceType)) return Response.json({ error: '不支持的内容类型' }, { status: 400 });
    const title = String(payload.title || '未命名内容').slice(0, 180);
    const files = Array.isArray(payload.files) ? payload.files.slice(0, 4) : [];
    const primary = files[0];
    const db = await ensureSchema();
    const history = await db.prepare(`SELECT id, source_type, platform, canonical_url, content_id, title, sha256, perceptual_hash, text_hash, features_json, created_at
      FROM analyses ORDER BY created_at DESC LIMIT 300`).all<StoredRow>();

    const matches: { id: string; title: string; kind: string; similarity: number; createdAt: number }[] = [];
    for (const row of history.results ?? []) {
      let kind = '';
      let similarity = 0;
      if (primary?.sha256 && row.sha256 === primary.sha256) { kind = '字节级完全一致'; similarity = 100; }
      else if (payload.canonicalUrl && row.canonical_url === payload.canonicalUrl) { kind = '同一作品链接'; similarity = 100; }
      else if (payload.contentId && row.content_id === payload.contentId && row.platform === payload.platform) { kind = '同一平台作品'; similarity = 100; }
      else if (primary?.perceptualHash && row.perceptual_hash) {
        const distance = hammingHex(primary.perceptualHash, row.perceptual_hash);
        if (distance <= 12) { kind = '图片感知指纹近似'; similarity = similarityFromDistance(distance); }
      } else if (payload.textHash && row.text_hash) {
        const distance = hammingHex(payload.textHash, row.text_hash);
        if (distance <= 14) { kind = '文字内容近似'; similarity = similarityFromDistance(distance); }
      }

      if (!kind && primary?.frameHashes?.length) {
        const stored = safeJson(row.features_json).files?.[0]?.frameHashes ?? [];
        const distances = primary.frameHashes.flatMap((hash) => stored.map((other) => hammingHex(hash, other))).filter(Number.isFinite);
        const best = distances.length ? Math.min(...distances) : Number.POSITIVE_INFINITY;
        if (best <= 10) { kind = '视频关键帧近似'; similarity = similarityFromDistance(best); }
      }
      if (kind) matches.push({ id: row.id, title: row.title, kind, similarity, createdAt: row.created_at });
    }
    matches.sort((a, b) => b.similarity - a.similarity);

    const claims = Array.isArray(payload.claims) ? payload.claims.slice(0, 12) : [];
    const extraction = cleanExtraction(payload.extraction);
    const externalEvidence: EvidenceCheck[] = evaluateEvidence(extraction.combinedText);
    const editSoftware = files.map((file) => file.metadata?.software).find(Boolean);
    const hasC2pa = files.some((file) => file.c2pa?.present);
    const riskSignals = Array.from(new Set([
      ...(matches.length ? [`发现 ${matches.length} 条库内近似记录`] : []),
      ...(claims.filter((item) => item.level === 'high').map((item) => item.rule)),
      ...externalEvidence.filter((item) => item.status === 'conflict').map((item) => `官方规则冲突：${item.signal}`),
      ...externalEvidence.filter((item) => item.status === 'needs_source').slice(0, 2).map((item) => `需要功效依据：${item.signal}`),
      ...(editSoftware ? [`元数据记录编辑软件：${editSoftware}`] : []),
    ])).slice(0, 10);
    const coverage = [
      payload.sourceType === 'link' ? (payload.resolver?.resolved ? '平台页面解析成功' : '平台访问受限，仅校验链接') : '本地内容已读取',
      extraction.pageText ? `${extraction.pageText.length} 字正文/标题` : null,
      extraction.ocrText ? `${extraction.frameCount} 个画面 OCR` : null,
      extraction.transcript ? `Whisper 口播转写` : null,
      primary?.sha256 ? 'SHA-256 文件指纹' : null,
      primary?.perceptualHash ? '图片感知指纹' : null,
      primary?.frameHashes?.length ? `${primary.frameHashes.length} 个视频关键帧指纹` : null,
      hasC2pa ? 'C2PA 内容凭证' : files.length ? '未发现 C2PA 凭证' : null,
      claims.length ? `${claims.length} 条宣称规则命中` : payload.sourceType === 'text' ? '未命中高风险宣称规则' : null,
      externalEvidence.length ? `${externalEvidence.length} 条官方证据映射` : null,
    ].filter(Boolean);

    const id = crypto.randomUUID();
    const createdAt = Date.now();
    const featuresJson = JSON.stringify({ files, claims, extraction, externalEvidence, resolver: payload.resolver, coverage });
    await db.prepare(`INSERT INTO analyses
      (id, source_type, platform, canonical_url, content_id, title, sha256, perceptual_hash, text_hash, features_json, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .bind(id, payload.sourceType, payload.platform ?? null, payload.canonicalUrl ?? null, payload.contentId ?? null, title, primary?.sha256 ?? null, primary?.perceptualHash ?? null, payload.textHash ?? null, featuresJson, createdAt)
      .run();

    return Response.json({
      id,
      createdAt,
      title,
      matches: matches.slice(0, 5),
      claims,
      files,
      extraction,
      externalEvidence,
      resolver: payload.resolver,
      coverage,
      riskSignals,
      verdict: riskSignals.length ? '发现需要复核的证据信号' : '未发现明确风险信号',
      confidence: extraction.combinedText.length > 80 && externalEvidence.length && coverage.length >= 4 ? '较高' : coverage.length >= 3 ? '中' : '有限',
      limitations: [
        '查重范围仅包含本系统已经检测的内容',
        '缺少内容凭证不等于内容伪造',
        ...(extraction.limitations.length ? extraction.limitations : []),
        ...(payload.sourceType === 'link' && !extraction.combinedText ? ['平台未开放正文或媒体时，只能完成作品标识和重复检测'] : []),
        '官方规则映射用于指出核验方向，不等于监管机关作出的违法认定',
      ],
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : '分析失败';
    return Response.json({ error: message }, { status: 500 });
  }
}
