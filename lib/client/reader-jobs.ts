// Each submission creates one fresh server-side read. Polls never resubmit it.
export async function readAnonymousXhs<T>(url: string, progress?: (message: string) => void, signal?: AbortSignal): Promise<T | null> {
  const withTimeout = (ms: number) => signal ? AbortSignal.any([signal, AbortSignal.timeout(ms)]) : AbortSignal.timeout(ms);
  let create: Response;
  try {
    create = await fetch('/api/reader-jobs', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ url }), signal: withTimeout(15000) });
  } catch {
    signal?.throwIfAborted();
    throw new Error('读取服务连接中断或超时，本次未自动重试。请保留原链接，稍后再试。');
  }
  const job = await create.json() as { jobId?: string; accessToken?: string; expiresAt?: number; code?: string; error?: string };
  if (job.code === 'reader_disabled') return null;
  if (!create.ok) throw new Error(job.error || '云端读取暂时不可用，请保留链接。');
  if (!job.jobId || !job.accessToken) throw new Error('读取服务未返回有效任务，请稍后再试。');
  const started = Date.now(), deadline = Math.min(Number(job.expiresAt) || started + 480000, started + 480000);
  while (Date.now() < deadline) {
    signal?.throwIfAborted();
    await new Promise<void>((resolve, reject) => {
      const cancel = () => { clearTimeout(timer); reject(signal?.reason); };
      const timer = setTimeout(() => { signal?.removeEventListener('abort', cancel); resolve(); }, 2000);
      signal?.addEventListener('abort', cancel, { once: true });
    });
    signal?.throwIfAborted();
    let response: Response;
    try { response = await fetch(`/api/reader-jobs/${encodeURIComponent(job.jobId)}`, { headers: { Authorization: `Bearer ${job.accessToken}` }, cache: 'no-store', signal: withTimeout(12000) }); }
    catch { signal?.throwIfAborted(); throw new Error('查询读取进度时连接中断；本次没有重复提交链接。请保留原链接，稍后重试。'); }
    const state = await response.json() as { status?: string; result?: T; error?: string | { message?: string } };
    const error = typeof state.error === 'string' ? state.error : state.error?.message;
    if (!response.ok) throw new Error(error || '无法查询读取任务，请保留原链接。');
    if (state.status === 'complete' && state.result) return state.result;
    if (state.status === 'failed') throw new Error(error || '平台未返回完整正文和图片，请补充原文或截图。');
    const seconds = Math.floor((Date.now() - started) / 1000);
    progress?.(state.status === 'queued' ? `已排队，等待读取 · ${seconds} 秒` : `正在读取正文并逐张核对图片 · ${seconds} 秒。多图内容可能需要几分钟。`);
  }
  throw new Error('这次读取超过等待时限，未自动重试。请保留链接，稍后再试。');
}
