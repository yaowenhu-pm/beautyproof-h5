'use client';
import { useEffect } from 'react';
import type { ReportV2 } from '@/lib/shared/report';
import Icon from './ui-icon';
import IngredientEfficacy from './ingredient-efficacy';

const labels = { supported: '有相关依据', risk: '宣传风险', insufficient: '证据不足', context: '语境说明' };
export default function EvidenceReport({ report, text, onReset, onEdit }: { report: ReportV2; text: string; onReset: () => void; onEdit?: () => void }) {
  useEffect(() => {
    let closed: HTMLDetailsElement[] = [];
    const before = () => { closed = Array.from(document.querySelectorAll<HTMLDetailsElement>('.report-v2 details:not([open])')); closed.forEach(el => el.open = true); };
    const after = () => { closed.forEach(el => el.open = false); closed = []; };
    window.addEventListener('beforeprint', before); window.addEventListener('afterprint', after);
    return () => { window.removeEventListener('beforeprint', before); window.removeEventListener('afterprint', after); after(); };
  }, []);
  const tone = report.status !== 'complete' ? 'unknown' : report.findings.some(f => f.judgment === 'risk') ? 'risk' : report.findings.some(f => f.judgment === 'insufficient') ? 'warning' : 'clear';
  const ingredientReady = Boolean(report.ingredientEfficacy?.ingredients.length);
  const ingredientCount = report.ingredientEfficacy?.ingredients.length ?? report.ingredients.length;
  const sourceIds = [...new Set(report.findings.flatMap(f => f.citations))];
  const researchCount = report.ingredientEfficacy?.sources.length ?? 0;
  const mediaScope = report.scope.filter((item) => /^(平台|用户补充|用户上传)(图片|视频)共/u.test(item));
  const headline = report.status !== 'complete' && ingredientReady ? '成分资料已对照。' : report.summary;
  const statusText = report.status === 'complete' ? '内容核验完成' : ingredientReady ? '部分分析完成' : '本次依据不足';
  return <div className="report-v2">
    <section className={'report-overview ' + tone} aria-labelledby="report-title">
      <div className="overview-topline"><span className="eyebrow">YOUR BEAUTY BRIEF</span><span className={'report-status ' + tone}>{statusText}</span></div>
      <h1 id="report-title">{headline}</h1>
      <p className="overview-summary">{report.status === 'complete' ? '从实际取得的内容出发，对照宣传与成分依据。' : (ingredientReady ? '宣传判断尚未完成。' : '') + report.summary}{report.cached ? ' 当前显示已保存的报告。' : ''}</p>
      <div className="report-metrics"><div><strong>{ingredientCount}<span>项</span></strong><span>识别到的成分</span></div><div><strong>{researchCount}<span>篇</span></strong><span>相关原料研究</span></div><div><strong>{report.findings.length}<span>处</span></strong><span>宣传表述核对</span></div></div>
      <div className="report-toolbar"><div>{onEdit && <button type="button" className="report-edit" onClick={onEdit}>修改 / 补充内容 <Icon name="arrow"/></button>}<button type="button" onClick={onReset}>检测另一条</button></div><button type="button" onClick={() => window.print()}><Icon name="print"/>保存报告</button></div>
    </section>
    <div className="report-body-layout">
      <nav className="report-index" aria-label="报告目录"><span className="eyebrow">IN THIS REPORT</span><a href="#ingredient-review">01 <span>成分与功效</span></a><a href="#claim-review">02 <span>宣传与依据</span></a><a href="#original-review" onClick={() => { const section = document.getElementById('original-review'); if (section instanceof HTMLDetailsElement) section.open = true; }}>03 <span>原文与范围</span></a><p>分析范围<br/>{report.scope.slice(0, 3).join('；')}</p><div className="index-note"><Icon name="shield"/><span>原料有研究，<br/>不等于成品已有效。</span></div></nav>
      <div className="report-body">
        {mediaScope.length > 0 && <section className="report-empty" aria-labelledby="media-coverage-heading" style={{ marginBottom: 24 }}><Icon name="info"/><div><strong id="media-coverage-heading">本次媒体识别范围</strong>{mediaScope.map((item, index) => <p key={index}>{item}</p>)}<p>完成 OCR 只表示读取了画面文字；实际纳入判断的文字与截断情况见下方“读取原文与完整分析范围”。</p></div></section>}
        <div id="ingredient-review" className="report-anchor">
          {report.ingredientEfficacy ? <IngredientEfficacy report={report.ingredientEfficacy}/> : <section className="report-ingredients"><div className="report-section-heading"><h2>成分与功效</h2><span>{ingredientCount} 项成分</span></div><p>通用用途不等于成品效果或安全评级。</p>{report.ingredients.length ? <div className="ingredient-table"><table><thead><tr><th>成分 / INCI</th><th>常见用途</th><th>识别来源</th></tr></thead><tbody>{report.ingredients.map(item => <tr key={item.id}><td><strong>{item.cn}</strong><small>{item.inci}</small></td><td>{item.purpose}</td><td>{item.origin === 'label' ? '用户标记的标签' : '内容提及'}<small>“{item.quote}”</small></td></tr>)}</tbody></table><a href={report.ingredients[0].source.url} target="_blank" rel="noreferrer">查看成分命名来源 ↗</a></div> : <p>未识别到已收录成分，不代表产品没有其他成分。</p>}</section>}
        </div>
        <section id="claim-review" className="report-findings report-anchor" aria-label="宣传与依据"><div className="report-section-heading"><div><span className="eyebrow">CLAIM REVIEW</span><h2>宣传与依据</h2></div><span>{report.findings.length} 处表述 · {sourceIds.length} 项引用</span></div>
          {report.findings.length ? report.findings.map((finding, index) => <article key={index}><div className="finding-topline"><span className="finding-number">{String(index + 1).padStart(2, '0')}</span><span className={'finding-label ' + finding.judgment}>{labels[finding.judgment]}</span></div><blockquote>“{finding.quote}”</blockquote><p>{finding.reason}</p><details><summary>这项判断的依据{finding.citations.length ? ' · ' + finding.citations.length : ''}</summary>{finding.citations.length ? finding.citations.map(id => { const source = report.sources.find(s => s.id === id); return source ? <div className="source-detail" key={id}><a href={source.url} target="_blank" rel="noreferrer">{source.title} · {source.section} ↗</a><p>{source.text}</p><small>{source.jurisdiction} · {source.version}</small><p className="source-boundary">{source.limitation ?? '通用资料，不是该产品的检测证明。'}</p></div> : null; }) : <p>当前资料不足以核实这项具体宣称。</p>}</details></article>) : <div className="report-empty"><Icon name="info"/><div><strong>{report.status === 'complete' ? '本次没有可单列的宣传发现' : '宣传判断尚未形成'}</strong><p>{report.status === 'complete' ? '这不代表产品功效已被证实，可结合成分资料继续查看。' : report.summary}</p></div></div>}
        </section>
        <details id="original-review" className="report-scope report-anchor"><summary>读取原文与完整分析范围</summary><ul>{report.scope.map((scope, index) => <li key={index}>{scope}</li>)}</ul><pre>{text || '尚未取得正文、画面文字或口播。'}</pre>{report.status !== 'complete' && report.sources.length > 0 && <><h3>已检索到的参考资料</h3><p>以下资料尚未形成宣传结论。</p>{report.sources.map(source => <p key={source.id}><a href={source.url} target="_blank" rel="noreferrer">{source.title} · {source.section} ↗</a></p>)}</>}</details>
        <footer className="report-footer"><p>{report.note}</p><small>报告 v{report.version} · 知识库 {report.kbVersion}{report.model ? ' · ' + report.model : ''}{report.generatedAt ? ' · ' + new Date(report.generatedAt).toLocaleString('zh-CN') : ''}</small></footer>
      </div>
    </div>
  </div>;
}
