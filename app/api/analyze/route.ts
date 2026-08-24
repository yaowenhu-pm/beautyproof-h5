import { ensureSchema } from '@/lib/server/db';

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

type AnalyzePayload = {
  sourceType: 'link' | 'upload' | 'text';
  platform?: string;
  canonicalUrl?: string;
  contentId?: string;
  title?: string;
  textHash?: string;
  files?: FileFeature[];
  claims?: ClaimFinding[];
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
    const editSoftware = files.map((file) => file.metadata?.software).find(Boolean);
    const hasC2pa = files.some((file) => file.c2pa?.present);
    const riskSignals = [
      ...(matches.length ? [`发现 ${matches.length} 条库内近似记录`] : []),
      ...(claims.filter((item) => item.level === 'high').map((item) => item.rule)),
      ...(editSoftware ? [`元数据记录编辑软件：${editSoftware}`] : []),
    ];
    const coverage = [
      payload.sourceType === 'link' ? (payload.resolver?.resolved ? '平台页面解析成功' : '平台访问受限，仅校验链接') : '本地内容已读取',
      primary?.sha256 ? 'SHA-256 文件指纹' : null,
      primary?.perceptualHash ? '图片感知指纹' : null,
      primary?.frameHashes?.length ? `${primary.frameHashes.length} 个视频关键帧指纹` : null,
      hasC2pa ? 'C2PA 内容凭证' : files.length ? '未发现 C2PA 凭证' : null,
      claims.length ? `${claims.length} 条宣称规则命中` : payload.sourceType === 'text' ? '未命中高风险宣称规则' : null,
    ].filter(Boolean);

    const id = crypto.randomUUID();
    const createdAt = Date.now();
    const featuresJson = JSON.stringify({ files, claims, resolver: payload.resolver, coverage });
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
      resolver: payload.resolver,
      coverage,
      riskSignals,
      verdict: riskSignals.length ? '发现需要复核的证据信号' : '未发现明确风险信号',
      confidence: coverage.length >= 3 ? '中' : '有限',
      limitations: [
        '查重范围仅包含本系统已经检测的内容',
        '缺少内容凭证不等于内容伪造',
        '当前版本未接入深度伪造或 AI 生成分类模型',
      ],
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : '分析失败';
    return Response.json({ error: message }, { status: 500 });
  }
}
