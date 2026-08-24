'use client';

import { useRef, useState } from 'react';
import type { ChangeEvent, DragEvent } from 'react';

type InputMode = 'link' | 'upload' | 'text';
type AppState = 'input' | 'analyzing' | 'result';

type UploadItem = {
  file: File;
  kind: 'image' | 'video' | 'text';
  preview: string;
  fingerprint: string;
};

const modes: { id: InputMode; label: string; icon: string }[] = [
  { id: 'link', label: '作品链接', icon: '⌁' },
  { id: 'upload', label: '图片 / 视频', icon: '↑' },
  { id: 'text', label: '文字内容', icon: '文' },
];

const analysisSteps = [
  ['解析内容', '读取作品信息与媒体资源'],
  ['比对来源', '生成指纹并检索相似内容'],
  ['核验媒体', '检查生成、篡改与精修信号'],
  ['核验宣称', '提取声明并匹配可验证依据'],
];

function extractUrl(value: string) {
  return value.match(/https?:\/\/[^\s]+/i)?.[0]?.replace(/[，。；、)）\]]+$/, '') ?? value.trim();
}

function getPlatform(value: string) {
  const url = extractUrl(value).toLowerCase();
  if (/(xiaohongshu|xhslink|xhs\.cn)/.test(url)) return { name: '小红书', mark: '小', className: 'xhs' };
  if (/(douyin|iesdouyin)/.test(url)) return { name: '抖音', mark: '♪', className: 'douyin' };
  return null;
}

function formatSize(bytes: number) {
  if (bytes < 1024 * 1024) return `${Math.max(1, Math.round(bytes / 1024))} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

async function makeFingerprint(file: File) {
  try {
    const digest = await crypto.subtle.digest('SHA-256', await file.arrayBuffer());
    return Array.from(new Uint8Array(digest)).slice(0, 8).map((value) => value.toString(16).padStart(2, '0')).join('');
  } catch {
    return '暂不可用';
  }
}

function truncate(value: string, length = 54) {
  return value.length > length ? `${value.slice(0, length)}…` : value;
}

export default function Home() {
  const [mode, setMode] = useState<InputMode>('link');
  const [appState, setAppState] = useState<AppState>('input');
  const [link, setLink] = useState('');
  const [text, setText] = useState('');
  const [files, setFiles] = useState<UploadItem[]>([]);
  const [error, setError] = useState('');
  const [step, setStep] = useState(0);
  const [isSample, setIsSample] = useState(false);
  const [openEvidence, setOpenEvidence] = useState<string | null>('source');
  const [showHelp, setShowHelp] = useState(false);
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
      return {
        file,
        kind,
        preview: kind === 'text' ? '' : URL.createObjectURL(file),
        fingerprint: await makeFingerprint(file),
      } as UploadItem;
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

  const validate = () => {
    if (mode === 'link' && !platform) return '请输入有效的小红书或抖音公开作品链接。';
    if (mode === 'upload' && files.length === 0) return '请先选择需要检测的图片或视频。';
    if (mode === 'text' && text.trim().length < 8) return '请至少输入 8 个字。';
    return '';
  };

  const runAnalysis = async (sample = false) => {
    const message = sample ? '' : validate();
    if (message) {
      setError(message);
      return;
    }

    if (sample) {
      setMode('link');
      setLink('https://www.xiaohongshu.com/explore/beautyproof-demo');
    }

    setError('');
    setIsSample(sample);
    setAppState('analyzing');
    setStep(0);
    for (let index = 0; index < analysisSteps.length; index += 1) {
      setStep(index);
      await new Promise((resolve) => setTimeout(resolve, 620));
    }
    setAppState('result');
    setOpenEvidence('source');
  };

  const reset = () => {
    setAppState('input');
    setError('');
    setIsSample(false);
  };

  const sourceTitle = isSample
    ? '“7 天焕白一个色号？”真实体验分享'
    : mode === 'link'
      ? `${platform?.name ?? '平台'}公开作品`
      : mode === 'upload'
        ? files[0]?.file.name ?? '本地素材'
        : truncate(text.trim(), 30);

  const candidateClaim = isSample
    ? '连续使用 7 天，焕白一个色号'
    : mode === 'text'
      ? truncate(text.trim(), 36)
      : '暂未运行真实 OCR / 语音转写';

  return (
    <main className="product-shell">
      <header className="product-header">
        <button className="brand-button" type="button" onClick={reset} aria-label="返回检测首页">
          <span className="brand-mark">真</span>
          <span><strong>真妍盾</strong><small>BEAUTYPROOF</small></span>
        </button>
        <div className="header-actions">
          <span className="demo-badge"><i /> 演示模式</span>
          <button type="button" className="quiet-button" onClick={() => setShowHelp(true)}>能力说明</button>
          <button type="button" className="icon-button" aria-label="查看能力说明" onClick={() => setShowHelp(true)}>?</button>
        </div>
      </header>

      {showHelp && (
        <div className="modal-backdrop" role="presentation" onMouseDown={() => setShowHelp(false)}>
          <section className="help-modal" role="dialog" aria-modal="true" aria-labelledby="help-title" onMouseDown={(event) => event.stopPropagation()}>
            <button className="modal-close" type="button" aria-label="关闭" onClick={() => setShowHelp(false)}>×</button>
            <span className="step-label">DEMO CAPABILITY</span>
            <h2 id="help-title">当前能力说明</h2>
            <div className="capability-list">
              <div><b className="live">已实现</b><span>平台链接识别、文件上传和本地 SHA-256 指纹。</span></div>
              <div><b className="demo">示例</b><span>查重匹配、视觉取证和宣称核验使用演示数据。</span></div>
              <div><b className="next">待接入</b><span>平台解析、内容索引、取证模型与专业证据库。</span></div>
            </div>
            <button className="modal-action" type="button" onClick={() => setShowHelp(false)}>我知道了</button>
          </section>
        </div>
      )}

      {appState === 'input' && (
        <section className="input-workspace">
          <div className="workspace-heading">
            <span className="step-label">新建检测</span>
            <h1>检测一条内容</h1>
            <p>提交作品链接、媒体文件或文字，查看来源、媒体与宣称证据。</p>
          </div>

          <div className="input-card">
            <div className="mode-switch" role="tablist" aria-label="输入方式">
              {modes.map((item) => (
                <button
                  key={item.id}
                  type="button"
                  role="tab"
                  aria-selected={mode === item.id}
                  className={mode === item.id ? 'active' : ''}
                  onClick={() => { setMode(item.id); setError(''); }}
                >
                  <span>{item.icon}</span>{item.label}
                </button>
              ))}
            </div>

            {mode === 'link' && (
              <div className="mode-panel">
                <label htmlFor="work-url">作品链接或分享口令</label>
                <div className={`url-field ${link && !platform ? 'invalid' : ''}`}>
                  <span className="field-icon">⌁</span>
                  <input
                    id="work-url"
                    value={link}
                    onChange={(event) => { setLink(event.target.value); setError(''); }}
                    placeholder="粘贴小红书或抖音公开作品链接"
                    autoComplete="off"
                  />
                  {link && <button type="button" onClick={() => setLink('')} aria-label="清空链接">×</button>}
                </div>
                {platform ? (
                  <div className="parsed-source">
                    <span className={`platform-mark ${platform.className}`}>{platform.mark}</span>
                    <div><strong>已识别为{platform.name}作品</strong><small>{truncate(linkUrl)}</small></div>
                    <span className="source-state">待检测</span>
                  </div>
                ) : (
                  <div className="supported-row"><span className="xhs-dot" />小红书 <span className="dy-dot" />抖音 <small>仅支持公开作品</small></div>
                )}
              </div>
            )}

            {mode === 'upload' && (
              <div className="mode-panel">
                <input ref={fileInput} type="file" multiple className="visually-hidden" accept="image/jpeg,image/png,image/webp,video/mp4,video/quicktime,text/plain" onChange={onFileChange} />
                <div className="upload-zone" role="button" tabIndex={0} onClick={() => fileInput.current?.click()} onKeyDown={(event) => { if (event.key === 'Enter') fileInput.current?.click(); }} onDragOver={(event) => event.preventDefault()} onDrop={onDrop}>
                  <span className="upload-symbol">↑</span>
                  <strong>选择或拖入图片、视频</strong>
                  <small>JPG、PNG、WEBP、MP4 · 最多 4 个文件</small>
                </div>
                {files.length > 0 && <div className="upload-list">{files.map((item, index) => (
                  <div className="upload-item" key={`${item.file.name}-${index}`}>
                    {item.kind === 'image' ? <img src={item.preview} alt="上传素材预览" /> : item.kind === 'video' ? <video src={item.preview} muted /> : <span className="file-type">TXT</span>}
                    <div><strong>{item.file.name}</strong><small>{formatSize(item.file.size)} · 指纹 {item.fingerprint}</small></div>
                    <button type="button" onClick={() => removeFile(index)} aria-label={`移除 ${item.file.name}`}>×</button>
                  </div>
                ))}</div>}
              </div>
            )}

            {mode === 'text' && (
              <div className="mode-panel">
                <label htmlFor="work-text">需要核验的内容</label>
                <div className="text-field">
                  <textarea id="work-text" value={text} maxLength={3000} onChange={(event) => { setText(event.target.value); setError(''); }} placeholder="粘贴种草文案、功效宣称或评论区话术…" />
                  <span>{text.length}/3000</span>
                </div>
              </div>
            )}

            {error && <p className="form-error" role="alert">{error}</p>}

            <button className="primary-action" type="button" onClick={() => void runAnalysis(false)}>
              开始检测 <span>→</span>
            </button>
            <div className="card-footer">
              <span>提交内容仅用于本次演示</span>
              <button type="button" onClick={() => void runAnalysis(true)}>加载完整示例 <b>→</b></button>
            </div>
          </div>

          <div className="capability-note">
            <span>i</span>
            <p><strong>当前为交互 Demo</strong>真实平台解析、全库查重与鉴真模型尚未接入；上传文件会在本机生成真实 SHA-256 指纹。</p>
          </div>
        </section>
      )}

      {appState === 'analyzing' && (
        <section className="analysis-workspace" aria-live="polite">
          <div className="analysis-card">
            <div className="scan-core"><span>{step + 1}</span><i /></div>
            <span className="step-label">正在检测 · {step + 1}/4</span>
            <h2>{analysisSteps[step][0]}</h2>
            <p>{analysisSteps[step][1]}</p>
            <div className="analysis-track"><i style={{ width: `${((step + 1) / analysisSteps.length) * 100}%` }} /></div>
            <div className="analysis-steps">
              {analysisSteps.map((item, index) => (
                <div className={index <= step ? 'done' : ''} key={item[0]}><span>{index < step ? '✓' : index + 1}</span><small>{item[0]}</small></div>
              ))}
            </div>
          </div>
        </section>
      )}

      {appState === 'result' && (
        <section className="result-workspace">
          <div className="result-topbar">
            <button type="button" onClick={reset}>← 新建检测</button>
            <div><span className="demo-badge"><i /> {isSample ? '示例报告' : '演示报告'}</span><button type="button" onClick={() => window.print()}>导出</button></div>
          </div>

          <div className="source-strip">
            <span className={`platform-mark ${mode === 'link' ? platform?.className ?? 'xhs' : 'local'}`}>{mode === 'link' ? platform?.mark ?? '小' : mode === 'upload' ? '件' : '文'}</span>
            <div><small>{mode === 'link' ? platform?.name ?? '小红书' : mode === 'upload' ? '本地文件' : '文字内容'}</small><strong>{sourceTitle}</strong></div>
            <span className="report-id">BP-0824-017</span>
          </div>

          <div className={`verdict-card ${isSample ? 'sample-verdict' : 'pending-verdict'}`}>
            <div className="verdict-score"><strong>{isSample ? '72' : '—'}</strong><small>{isSample ? '风险分' : '未实测'}</small></div>
            <div className="verdict-copy">
              <span>{isSample ? '建议复核' : '等待真实检测服务'}</span>
              <h1>{isSample ? '发现两项需要核实的关键证据' : '内容已接收，当前仅展示产品流程'}</h1>
              <p>{isSample ? '量化功效宣称缺少产品级证据，前后对比图存在影响判断的处理信号。' : '这一结果不会冒充真实鉴定。接入平台解析、内容索引和取证模型后，将在此生成内容专属结论。'}</p>
            </div>
            <div className="confidence-block"><small>报告置信度</small><strong>{isSample ? '高' : '—'}</strong><span>{isSample ? '3 个信号一致' : '尚无模型输出'}</span></div>
          </div>

          <div className="evidence-summary">
            <article><span className="evidence-icon">⌁</span><div><small>来源与查重</small><strong>{isSample ? '发现 2 条近似内容' : '尚未连接检索库'}</strong></div><b className={isSample ? 'risk' : 'neutral'}>{isSample ? '存疑' : '待接入'}</b></article>
            <article><span className="evidence-icon">◫</span><div><small>媒体完整性</small><strong>{isSample ? '局部处理信号明显' : mode === 'upload' ? '已生成文件指纹' : '尚未运行取证模型'}</strong></div><b className={isSample ? 'warn' : 'neutral'}>{isSample ? '需复核' : '待接入'}</b></article>
            <article><span className="evidence-icon">文</span><div><small>宣称证据</small><strong>{isSample ? '1 项关键证据不足' : '尚未检索专业依据'}</strong></div><b className={isSample ? 'risk' : 'neutral'}>{isSample ? '不足' : '待接入'}</b></article>
          </div>

          <div className="report-layout">
            <div className="evidence-panels">
              <article className="evidence-panel">
                <button type="button" className="panel-heading" onClick={() => setOpenEvidence(openEvidence === 'source' ? null : 'source')} aria-expanded={openEvidence === 'source'}>
                  <span className="panel-number">01</span><div><small>PROVENANCE</small><strong>来源与查重</strong></div><b>{openEvidence === 'source' ? '−' : '+'}</b>
                </button>
                {openEvidence === 'source' && <div className="panel-content">
                  {isSample ? <>
                    <div className="match-row"><span className="match-thumb first">原</span><div><strong>疑似最早发布版本</strong><small>品牌官方账号 · 2026-06-18 09:42</small></div><em>基准</em></div>
                    <div className="match-row"><span className="match-thumb second">改</span><div><strong>当前作品与原版本高度近似</strong><small>裁剪画面并替换标题文字</small></div><em className="similarity">91% 相似</em></div>
                    <p className="evidence-caption">示例数据展示未来接入跨平台指纹索引后的结果形态。</p>
                  </> : <div className="empty-evidence"><span>⌁</span><div><strong>尚未连接内容查重索引</strong><p>目前只完成平台识别或本地文件指纹生成，不能据此判断是否搬运。</p></div></div>}
                </div>}
              </article>

              <article className="evidence-panel">
                <button type="button" className="panel-heading" onClick={() => setOpenEvidence(openEvidence === 'media' ? null : 'media')} aria-expanded={openEvidence === 'media'}>
                  <span className="panel-number">02</span><div><small>FORENSICS</small><strong>媒体完整性</strong></div><b>{openEvidence === 'media' ? '−' : '+'}</b>
                </button>
                {openEvidence === 'media' && <div className="panel-content">
                  {isSample ? <div className="forensic-grid"><div className="heatmap"><span className="face-shape" /><i className="hot-one" /><i className="hot-two" /><b>疑似处理区域</b></div><div className="metric-list"><div><span>局部平滑</span><strong>0.81</strong></div><div><span>曝光重映射</span><strong>0.68</strong></div><div><span>全图 AI 生成</span><strong className="safe-score">0.24</strong></div><p>单一信号不能证明造假，建议调取未经压缩的原始文件复核。</p></div></div> : <div className="empty-evidence"><span>◫</span><div><strong>{mode === 'upload' ? '文件指纹已生成' : '尚未取得可检测媒体'}</strong><p>{mode === 'upload' ? `本地指纹：${files[0]?.fingerprint ?? '—'}。仍需连接生成检测与篡改定位模型。` : '链接解析服务接入后，将自动提取原图或视频关键帧。'}</p></div></div>}
                </div>}
              </article>

              <article className="evidence-panel">
                <button type="button" className="panel-heading" onClick={() => setOpenEvidence(openEvidence === 'claim' ? null : 'claim')} aria-expanded={openEvidence === 'claim'}>
                  <span className="panel-number">03</span><div><small>CLAIMS</small><strong>宣称证据</strong></div><b>{openEvidence === 'claim' ? '−' : '+'}</b>
                </button>
                {openEvidence === 'claim' && <div className="panel-content">
                  <div className="claim-card"><span>提取的声明</span><blockquote>“{candidateClaim}”</blockquote><div><strong>{isSample ? '缺少产品级功效证据支持' : '尚未执行证据检索'}</strong><b className={isSample ? 'risk' : 'neutral'}>{isSample ? '证据不足' : '待接入'}</b></div><p>{isSample ? '明确的时间和量化承诺需要人体功效评价等产品级依据，不能由单一原料功效直接推导。' : '接入法规、备案与功效评价摘要知识库后，系统将逐条显示支持、反驳或证据不足。'}</p></div>
                </div>}
              </article>
            </div>

            <aside className="next-action-card">
              <span>建议下一步</span>
              <h3>{isSample ? '先查原始凭证，再采信结论' : '接入真实能力后再作判断'}</h3>
              <ol>
                <li><b>1</b>{isSample ? '索取未经压缩的原图或原视频' : '连接平台作品解析服务'}</li>
                <li><b>2</b>{isSample ? '查看产品功效评价摘要' : '建立可检索的内容指纹库'}</li>
                <li><b>3</b>{isSample ? '必要时提交人工复核' : '接入视觉取证和宣称核验模型'}</li>
              </ol>
              <button type="button" onClick={reset}>检测新内容</button>
            </aside>
          </div>

          <p className="report-disclaimer">演示报告不构成专业鉴定、法律判断或监管结论。</p>
        </section>
      )}
    </main>
  );
}
