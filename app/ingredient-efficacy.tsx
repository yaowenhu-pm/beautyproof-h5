import type { IngredientEfficacyReport } from '@/lib/shared/ingredient-efficacy';
import { efficacyGoalLabel } from '@/lib/shared/ingredient-efficacy';

const originLabels = { label: '用户提供的标签', claimed: '原文声称含有', mentioned: '原文提及，未确认含有', negated: '原文明确否认含有', conflicting: '原文说法存在冲突' };
const evidenceLabels = { human_ingredient_evidence: '有人体研究', preclinical_only: '仅有前临床研究', no_indexed_evidence: '当前资料未覆盖' };

export default function IngredientEfficacy({ report }: { report: IngredientEfficacyReport }) {
  const assessment = report.productAssessment;
  return <section className="efficacy-section" aria-labelledby="efficacy-heading">
    <div className="report-section-heading"><div><span className="eyebrow">INGREDIENT REVIEW</span><h2 id="efficacy-heading">这些成分，能支持什么效果？</h2></div><span>{report.ingredients.length} 项成分 · {report.sources.length} 篇研究</span></div>
    <div className="efficacy-conclusion"><span className="eyebrow">成分研究与产品效果</span><h3>{assessment.summary}</h3>
      {assessment.supportedIngredientGoals.length > 0 && <p>相关研究涉及：{assessment.supportedIngredientGoals.map(efficacyGoalLabel).join('、')}。</p>}
      {assessment.mixedEvidenceGoals.length > 0 && <p>研究结果不完全一致：{assessment.mixedEvidenceGoals.map(efficacyGoalLabel).join('、')}。下方同时保留积极结果与未见差异的结果。</p>}
      <p>当前产品的实际效果尚未确认。需要把完整配方、使用条件和对应成品的功效评价一并核对。</p>
    </div>
    {report.ingredients.map(item => <article className="efficacy-card" key={item.id}>
      <div className="efficacy-card-heading"><div><h3>{item.cn}</h3><small>{item.inci} · {originLabels[item.origin]}</small></div><span className={`evidence-tag ${item.evidenceStatus}`}>{evidenceLabels[item.evidenceStatus]}</span></div>
      <p>{item.summary}</p>
      <div className="efficacy-quotes">{item.occurrences.slice(0, 3).map((occurrence, index) => <small key={index}>原文：“{occurrence.quote}”{occurrence.source === 'label' ? '（用户标记的标签）' : ''}</small>)}</div>
      <p className="concentration-note">原文浓度：{item.concentrations.length ? item.concentrations.map(c => `${c.quote}${c.basis === 'blend_claim' ? '（原料或复合物比例，不能视为成品中纯成分浓度）' : c.basis === 'measurement_not_comparable' ? '（计量基准不同，不能直接对照研究浓度）' : ''}`).join('；') : '未提供，不能从成分表顺序推算'}</p>
      {item.evidence.map(match => {
        const study = report.sources.find(source => source.id === match.evidenceId);
        return study ? <details className="efficacy-study" key={study.id}><summary>{study.year} · {study.finding}</summary>
          <p>{match.interpretation}</p>
          <dl><div><dt>研究设计</dt><dd>{study.design}</dd></div><div><dt>受试人群</dt><dd>{study.population}</dd></div><div><dt>配方条件</dt><dd>{study.formulation}</dd></div><div><dt>使用周期</dt><dd>{study.regimen}</dd></div></dl>
          <ul>{[...new Set([...match.conditions, ...study.limitations])].map((line, i) => <li key={i}>{line}</li>)}</ul>
          <a href={study.url} target="_blank" rel="noreferrer">{study.title} ↗</a><small>{study.provenance} · 核对日期 {study.reviewedAt}</small>
        </details> : null;
      })}
    </article>)}
    {report.ambiguousMentions.length > 0 && <div className="efficacy-unmatched"><h3>这些名称还需要确认</h3>{report.ambiguousMentions.map((item, i) => <p key={i}>“{item.quote}”：{item.reason}</p>)}</div>}
    <details className="efficacy-missing"><summary>要判断这款产品，还缺什么？</summary><ul>{assessment.missingEvidence.map((line, i) => <li key={i}>{line}</li>)}</ul>{report.limitations.map((line, i) => <p key={i}>{line}</p>)}<small>成分资料版本 {report.version}。未收录不等于没有研究，也不等于无效。</small></details>
  </section>;
}
