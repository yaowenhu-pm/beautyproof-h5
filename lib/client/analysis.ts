export type ClaimFinding = { text: string; rule: string; level: 'high' | 'medium' | 'info' };

export type FileFeature = {
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

let c2paPromise: Promise<Awaited<ReturnType<typeof import('@contentauth/c2pa-web/inline')['createC2pa']>>> | null = null;

export async function sha256(file: Blob) {
  const digest = await crypto.subtle.digest('SHA-256', await file.arrayBuffer());
  return Array.from(new Uint8Array(digest)).map((value) => value.toString(16).padStart(2, '0')).join('');
}

function pixelsToDHash(data: Uint8ClampedArray) {
  let bits = '';
  for (let y = 0; y < 8; y += 1) {
    for (let x = 0; x < 8; x += 1) {
      const left = (y * 9 + x) * 4;
      const right = left + 4;
      const leftGray = data[left] * .299 + data[left + 1] * .587 + data[left + 2] * .114;
      const rightGray = data[right] * .299 + data[right + 1] * .587 + data[right + 2] * .114;
      bits += leftGray > rightGray ? '1' : '0';
    }
  }
  return Array.from({ length: 16 }, (_, index) => Number.parseInt(bits.slice(index * 4, index * 4 + 4), 2).toString(16)).join('');
}

function hashDrawable(source: CanvasImageSource) {
  const canvas = document.createElement('canvas');
  canvas.width = 9;
  canvas.height = 8;
  const context = canvas.getContext('2d', { willReadFrequently: true });
  if (!context) throw new Error('浏览器无法读取图像像素');
  context.drawImage(source, 0, 0, 9, 8);
  return pixelsToDHash(context.getImageData(0, 0, 9, 8).data);
}

async function inspectC2pa(file: File) {
  if (!/^(image|video)\//.test(file.type)) return { present: false };
  try {
    c2paPromise ??= import('@contentauth/c2pa-web/inline').then(({ createC2pa }) => createC2pa());
    const c2pa = await c2paPromise;
    const reader = await c2pa.reader.fromBlob(file.type || 'application/octet-stream', file);
    if (!reader) return { present: false };
    try {
      const manifest = await reader.activeManifest() as unknown as Record<string, unknown>;
      const info = Array.isArray(manifest.claim_generator_info) ? manifest.claim_generator_info[0] as Record<string, unknown> : null;
      return {
        present: true,
        issuer: typeof info?.name === 'string' ? info.name : undefined,
      };
    } finally {
      await reader.free();
    }
  } catch (error) {
    return { present: false, error: error instanceof Error ? error.message.slice(0, 180) : 'C2PA 读取失败' };
  }
}

async function inspectMetadata(file: File) {
  if (!file.type.startsWith('image/')) return {};
  try {
    const exifr = await import('exifr');
    const data = await exifr.parse(file, { gps: false, tiff: true, xmp: true, iptc: true }) as Record<string, unknown> | undefined;
    const date = data?.DateTimeOriginal ?? data?.CreateDate ?? data?.DateTime;
    return {
      software: typeof data?.Software === 'string' ? data.Software.slice(0, 100) : undefined,
      make: typeof data?.Make === 'string' ? data.Make.slice(0, 80) : undefined,
      model: typeof data?.Model === 'string' ? data.Model.slice(0, 80) : undefined,
      createdAt: date instanceof Date ? date.toISOString() : typeof date === 'string' ? date.slice(0, 80) : undefined,
    };
  } catch {
    return {};
  }
}

async function analyzeImage(file: File): Promise<FileFeature> {
  const bitmap = await createImageBitmap(file);
  try {
    const [digest, c2pa, metadata] = await Promise.all([sha256(file), inspectC2pa(file), inspectMetadata(file)]);
    return {
      name: file.name,
      type: file.type,
      size: file.size,
      sha256: digest,
      perceptualHash: hashDrawable(bitmap),
      width: bitmap.width,
      height: bitmap.height,
      c2pa,
      metadata,
    };
  } finally {
    bitmap.close();
  }
}

function waitForMedia(target: HTMLMediaElement, event: string) {
  return new Promise<void>((resolve, reject) => {
    const onReady = () => { cleanup(); resolve(); };
    const onError = () => { cleanup(); reject(new Error('视频文件无法读取')); };
    const cleanup = () => { target.removeEventListener(event, onReady); target.removeEventListener('error', onError); };
    target.addEventListener(event, onReady, { once: true });
    target.addEventListener('error', onError, { once: true });
  });
}

async function analyzeVideo(file: File): Promise<FileFeature> {
  const url = URL.createObjectURL(file);
  const video = document.createElement('video');
  video.muted = true;
  video.preload = 'metadata';
  video.src = url;
  try {
    await waitForMedia(video, 'loadedmetadata');
    const duration = Number.isFinite(video.duration) ? video.duration : 0;
    const frameHashes: string[] = [];
    for (const ratio of [0.1, 0.5, 0.9]) {
      video.currentTime = Math.max(0, Math.min(duration * ratio, Math.max(0, duration - .05)));
      await waitForMedia(video, 'seeked');
      frameHashes.push(hashDrawable(video));
    }
    const [digest, c2pa] = await Promise.all([sha256(file), inspectC2pa(file)]);
    return {
      name: file.name,
      type: file.type,
      size: file.size,
      sha256: digest,
      frameHashes,
      perceptualHash: frameHashes[1],
      width: video.videoWidth,
      height: video.videoHeight,
      duration,
      c2pa,
    };
  } finally {
    URL.revokeObjectURL(url);
    video.removeAttribute('src');
    video.load();
  }
}

export async function analyzeFile(file: File): Promise<FileFeature> {
  if (file.type.startsWith('image/')) return analyzeImage(file);
  if (file.type.startsWith('video/')) return analyzeVideo(file);
  return { name: file.name, type: file.type, size: file.size, sha256: await sha256(file) };
}

function fnv64(value: string) {
  let hash = 0xcbf29ce484222325n;
  for (const character of value) {
    hash ^= BigInt(character.codePointAt(0) ?? 0);
    hash = BigInt.asUintN(64, hash * 0x100000001b3n);
  }
  return hash;
}

export function textSimHash(value: string) {
  const normalized = value.toLowerCase().replace(/\s+/g, ' ').trim();
  const chinese = Array.from(normalized.replace(/[\x00-\xff]/g, ''));
  const tokens = [
    ...normalized.match(/[a-z0-9]+/g) ?? [],
    ...chinese.slice(0, -1).map((char, index) => `${char}${chinese[index + 1]}`),
  ];
  const weights = Array<number>(64).fill(0);
  for (const token of tokens.length ? tokens : [normalized]) {
    const hash = fnv64(token);
    for (let bit = 0; bit < 64; bit += 1) weights[bit] += (hash & (1n << BigInt(bit))) ? 1 : -1;
  }
  let output = 0n;
  weights.forEach((weight, bit) => { if (weight >= 0) output |= 1n << BigInt(bit); });
  return output.toString(16).padStart(16, '0');
}

const claimRules: { pattern: RegExp; rule: string; level: ClaimFinding['level'] }[] = [
  { pattern: /(?:睫毛|眉毛|发际线).{0,16}(?:生长|增长|长长|变长|浓密)|(?:生发|育发|养头发|长睫毛)/gi, rule: '毛发生长或育发功效宣称', level: 'high' },
  { pattern: /(?:停用|不用).{0,12}(?:不会|不再|无需).{0,12}(?:变回|恢复|种睫毛)|永久.{0,12}(?:生长|浓密|改变|保持)/gi, rule: '永久效果或替代性承诺', level: 'high' },
  { pattern: /(?:头皮屑|脱发).{0,16}(?:治好|整好|好了|解决(?:了|掉)|消失)/gi, rule: '头皮问题医疗化结果宣称', level: 'high' },
  { pattern: /(?:\d+\s*(?:天|日|周|次)).{0,12}(?:美白|焕白|淡斑|祛痘|修复|年轻|色号)/gi, rule: '明确时限功效承诺', level: 'high' },
  { pattern: /(?:一个色号|\d+\s*(?:倍|%|％)).{0,8}(?:白|提升|改善|减少)/gi, rule: '量化功效承诺', level: 'high' },
  { pattern: /(?:根治|治愈|永久|彻底消除|药到病除|零副作用)/gi, rule: '绝对化或医疗化表述', level: 'high' },
  { pattern: /(?:100%|百分之百|绝对|保证|立刻|瞬间|全网第一|最有效|顶级|神器|橡皮擦|彻底清除)/gi, rule: '绝对化或夸大宣传用语', level: 'medium' },
  { pattern: /(?:晚晚同款|明星同款|日本很流行|京都艺妓|IKKO|美容师.{0,8}(?:推荐|介绍))/gi, rule: '人物或境外背书信息', level: 'medium' },
  { pattern: /(?:天然美容|天然的?蛋白质|纯天然|全天然)/gi, rule: '“天然”来源或成分表述', level: 'medium' },
  { pattern: /(?:医美级|药妆|处方级|医学级)/gi, rule: '容易引发医疗属性联想', level: 'medium' },
  { pattern: /(?:核心成分|专利成分|同款成分).{0,18}(?:所以|因此|等于|实现)/gi, rule: '原料功效向产品功效推导', level: 'info' },
];

export function analyzeClaims(value: string) {
  const findings: ClaimFinding[] = [];
  for (const rule of claimRules) {
    for (const match of value.matchAll(rule.pattern)) {
      findings.push({ text: match[0].slice(0, 80), rule: rule.rule, level: rule.level });
      if (findings.length >= 12) return findings;
    }
  }
  return findings;
}
