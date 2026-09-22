import { ingredients as existingIngredients } from './knowledge.ts';

/** Versioned, deterministic evidence assessment. No network, LLM or safety scoring. */
export const INGREDIENT_EFFICACY_VERSION = '2026-09-22.2';
export type EfficacyGoal = 'hydration' | 'barrier' | 'wrinkles' | 'pigmentation' | 'oil_control' | 'acne' | 'exfoliation' | 'uv_protection' | 'antioxidant';
export type ProductForm = 'leave_on' | 'rinse_off' | 'oral' | 'unknown';
export type EvidenceKind = 'human_controlled' | 'human_uncontrolled' | 'animal' | 'in_vitro' | 'formulation_reference';
export type IngredientOrigin = 'label' | 'claimed' | 'mentioned' | 'negated' | 'conflicting';
export type TextReference = { source: 'text' | 'label'; quote: string; start: number; end: number };
export type IngredientStudy = {
  id: string; inci: string; title: string; url: string; year: number; reviewedAt: string;
  kind: EvidenceKind; goals: EfficacyGoal[]; population: string; design: string;
  concentrationPercent: number[]; testedForm: ProductForm; formulation: string; regimen: string;
  finding: string; limitations: string[]; provenance: string;
  nonSupportingGoals?: EfficacyGoal[];
};
export type IngredientDefinition = { id: string; cn: string; inci: string; aliases: string[]; purpose: string };
export type Concentration = TextReference & { minPercent: number; maxPercent: number; qualifier: 'exact' | 'range' | 'approximate'; basis: 'as_stated' | 'blend_claim' | 'measurement_not_comparable' };
export type IngredientOccurrence = TextReference & { origin: Exclude<IngredientOrigin, 'conflicting'>; context: string; concentration?: Concentration };
export type StudyApplicability = {
  evidenceId: string; level: 'human_ingredient_evidence' | 'preclinical_only' | 'reference_only';
  relevantGoals: EfficacyGoal[]; concentration: 'unknown' | 'matches_studied_value' | 'different_from_study' | 'not_comparable';
  nonSupportingGoals: EfficacyGoal[];
  productForm: 'unknown' | 'compatible_category' | 'different_category';
  interpretation: string; conditions: string[];
};
export type IngredientAssessment = IngredientDefinition & {
  origin: IngredientOrigin; identityStatus: 'user_reported_label' | 'content_claim' | 'not_established' | 'explicitly_negated' | 'conflicting_statements';
  occurrences: IngredientOccurrence[]; concentrations: Concentration[];
  evidence: StudyApplicability[]; evidenceStatus: 'human_ingredient_evidence' | 'preclinical_only' | 'no_indexed_evidence';
  summary: string;
};
export type EfficacyClaim = TextReference & { goal: EfficacyGoal; polarity: 'affirmative' | 'negated' | 'question' };
export type IngredientEfficacyInput = { text: string; labelText?: string; declaredProductForm?: ProductForm };
export type IngredientEfficacyReport = {
  version: string; ingredients: IngredientAssessment[]; claims: EfficacyClaim[]; sources: IngredientStudy[];
  ambiguousMentions: (TextReference & { reason: string })[];
  productAssessment: {
    status: 'ingredient_basis_only' | 'conditions_not_matched' | 'insufficient_input' | 'no_matching_evidence';
    efficacyEstablished: false; productEvidence: [];
    summary: string; supportedIngredientGoals: EfficacyGoal[]; mixedEvidenceGoals: EfficacyGoal[]; missingEvidence: string[];
  };
  productForm: { value: ProductForm; source: 'declared' | 'text' | 'unknown'; quote?: string };
  limitations: string[];
};

// Additional identities explicitly prevent derivatives or similar names inheriting
// their parent molecule's evidence. Original 30 mappings remain unchanged.
const extraIngredients: Omit<IngredientDefinition, 'id'>[] = [
  { cn: '烟酸', inci: 'NIACIN', aliases: ['尼克酸'], purpose: '与烟酰胺不同的化学物质' },
  { cn: '视黄醛', inci: 'RETINAL', aliases: ['维生素A醛'], purpose: '皮肤调理剂' },
  { cn: '视黄醇棕榈酸酯', inci: 'RETINYL PALMITATE', aliases: ['维生素A棕榈酸酯'], purpose: '皮肤调理剂；不是视黄醇本体' },
  { cn: '视黄醇乙酸酯', inci: 'RETINYL ACETATE', aliases: ['维生素A乙酸酯'], purpose: '皮肤调理剂；不是视黄醇本体' },
  { cn: '抗坏血酸葡糖苷', inci: 'ASCORBYL GLUCOSIDE', aliases: ['抗坏血酸葡萄糖苷'], purpose: '维生素C衍生物' },
  { cn: '抗坏血酸磷酸酯钠', inci: 'SODIUM ASCORBYL PHOSPHATE', aliases: [], purpose: '维生素C衍生物' },
  { cn: '抗坏血酸磷酸酯镁', inci: 'MAGNESIUM ASCORBYL PHOSPHATE', aliases: [], purpose: '维生素C衍生物' },
  { cn: '3-O-乙基抗坏血酸', inci: '3-O-ETHYL ASCORBIC ACID', aliases: ['乙基抗坏血酸'], purpose: '维生素C衍生物' },
  { cn: '抗坏血酸四异棕榈酸酯', inci: 'ASCORBYL TETRAISOPALMITATE', aliases: [], purpose: '维生素C衍生物' },
  { cn: '水解透明质酸', inci: 'HYDROLYZED HYALURONIC ACID', aliases: [], purpose: '保湿剂；不能直接继承其他分子量研究' },
  { cn: '水解透明质酸钠', inci: 'HYDROLYZED SODIUM HYALURONATE', aliases: [], purpose: '保湿剂；不能直接继承其他分子量研究' },
  { cn: '乙酰化透明质酸钠', inci: 'SODIUM ACETYLATED HYALURONATE', aliases: [], purpose: '保湿剂' },
  { cn: '神经酰胺AP', inci: 'CERAMIDE AP', aliases: ['神经酰胺 AP'], purpose: '皮肤调理剂' },
  { cn: '神经酰胺EOP', inci: 'CERAMIDE EOP', aliases: ['神经酰胺 EOP'], purpose: '皮肤调理剂' },
  { cn: '咖啡因', inci: 'CAFFEINE', aliases: [], purpose: '皮肤调理剂' },
  { cn: '熊果苷', inci: 'ARBUTIN', aliases: [], purpose: '皮肤调理剂' },
  { cn: 'α-熊果苷', inci: 'ALPHA-ARBUTIN', aliases: ['α熊果苷', '阿尔法熊果苷'], purpose: '皮肤调理剂' },
  { cn: '积雪草提取物', inci: 'CENTELLA ASIATICA EXTRACT', aliases: [], purpose: '植物提取物；成分含量不能由植物名推算' },
  { cn: '羟基积雪草苷', inci: 'MADECASSOSIDE', aliases: [], purpose: '皮肤调理剂' },
  { cn: '甘油油酸酯', inci: 'GLYCERYL OLEATE', aliases: [], purpose: '润肤剂、乳化剂；不是甘油本体' },
  { cn: '透明质酸钠交联聚合物', inci: 'SODIUM HYALURONATE CROSSPOLYMER', aliases: ['交联透明质酸钠'], purpose: '保湿剂；交联形式不能直接继承其他透明质酸研究' },
  { cn: '羟基乙酸', inci: 'GLYCOLIC ACID', aliases: ['乙醇酸'], purpose: '皮肤调理剂、pH调节剂' },
  { cn: '壬二酸', inci: 'AZELAIC ACID', aliases: ['杜鹃花酸'], purpose: '皮肤调理剂' },
];
const preciseAliases: Record<string, string[]> = { NIACINAMIDE: ['Nicotinamide'], GLYCERIN: ['Glycerol'], RETINAL: ['Retinaldehyde'], AQUA: ['Water'], 'ASCORBIC ACID': ['L-抗坏血酸'] };
export const ingredientCatalog: IngredientDefinition[] = [
  ...existingIngredients.map(({ id, cn, inci, aliases, purpose }) => ({ id, cn, inci, aliases: [...aliases.filter(alias => alias !== '玻尿酸'), ...(preciseAliases[inci] ?? [])], purpose })),
  ...extraIngredients.map((row, index) => ({ ...row, aliases: [...row.aliases, ...(preciseAliases[row.inci] ?? [])], id: `INCI-EXT-${index + 1}` })),
];

// Primary-study metadata was checked against the original PubMed abstracts.
// Counts, dosing and results below belong only to each tested study formulation.
export const ingredientStudies: IngredientStudy[] = [
  {
    id: 'PMID-16029679', inci: 'NIACINAMIDE', title: 'Niacinamide: A B vitamin that improves aging facial skin appearance',
    url: 'https://pubmed.ncbi.nlm.nih.gov/16029679/', year: 2005, reviewedAt: '2026-09-22', kind: 'human_controlled',
    goals: ['wrinkles', 'pigmentation'], population: '50 名有面部光老化表现的白人女性',
    design: '双盲、随机、半脸载体对照', concentrationPercent: [5], testedForm: 'leave_on', formulation: '含 5% 烟酰胺的试验用外用配方及其载体对照',
    regimen: '每日两次，持续 12 周', finding: '该研究配方在细纹、色素沉着等面部外观指标上较载体有改善。',
    limitations: ['这是特定 5% 外用配方及人群的研究，不证明任意含烟酰胺成品有效。', '作者有宝洁公司所属关系，应结合独立重复研究审视证据。', '不能直接外推其他浓度、洗去型产品、其他人群或更短使用周期。'],
    provenance: '原始论文摘要；本轮通过 Europe PMC / PubMed 记录核对。',
  },
  {
    id: 'PMID-17515510', inci: 'RETINOL', title: 'Improvement of naturally aged skin with vitamin A (retinol)',
    url: 'https://pubmed.ncbi.nlm.nih.gov/17515510/', year: 2007, reviewedAt: '2026-09-22', kind: 'human_controlled',
    goals: ['wrinkles'], population: '36 名老年受试者，平均年龄 87 岁；观察手臂自然老化皮肤',
    design: '随机、双盲、左右手臂载体对照', concentrationPercent: [0.4], testedForm: 'leave_on', formulation: '含 0.4% 视黄醇的乳液',
    regimen: '每周至多三次，持续 24 周', finding: '在研究中的手臂皮肤，细纹等指标相较载体改善。',
    limitations: ['研究部位为老年人手臂，不是年轻人的面部。', '不能把 24 周结果说成 7 天见效，也不能迁移给视黄醛或视黄醇酯。', '没有提供当前成品的浓度、稳定性、耐受性和完整功效评价。'],
    provenance: '原始论文摘要；本轮通过 Europe PMC / PubMed 记录核对。',
  },
  {
    id: 'PMID-11207686', inci: 'ASCORBIC ACID', title: 'Topical L-ascorbic acid: percutaneous absorption studies',
    url: 'https://pubmed.ncbi.nlm.nih.gov/11207686/', year: 2001, reviewedAt: '2026-09-22', kind: 'animal',
    goals: [], population: '猪皮经皮吸收实验', design: '配方条件与经皮吸收实验，不是人体功效试验',
    concentrationPercent: [], testedForm: 'leave_on', formulation: 'L-抗坏血酸外用配方；吸收与 pH 等配方条件有关',
    regimen: '摘要中的吸收实验，不能换算成人体见效周期', finding: '研究提示抗坏血酸经皮吸收依赖配方条件；该实验不提供人体美白或抗皱效果证明。',
    limitations: ['动物吸收实验不是人体功效评价。', '不能将抗坏血酸结论转移给抗坏血酸葡糖苷等衍生物。', '不能由成分表确认实际产品的 pH、稳定性和可利用浓度。'],
    provenance: '原始论文摘要；本轮通过 Europe PMC / PubMed 记录核对。',
  },
  {
    id: 'PMID-18498456', inci: 'GLYCERIN', title: 'The influence of a cream containing 20% glycerin and its vehicle on skin barrier properties.',
    url: 'https://pubmed.ncbi.nlm.nih.gov/18498456/', year: 2001, reviewedAt: '2026-09-22', kind: 'human_controlled',
    goals: ['hydration'], nonSupportingGoals: ['barrier'], population: '17 名健康志愿者，正常皮肤',
    design: '双盲、载体对照', concentrationPercent: [20], testedForm: 'leave_on', formulation: '含 20% 甘油的乳霜',
    regimen: '10 天；摘要未披露使用频率', finding: '受试甘油乳霜提高角质层含水量，但未证实相对载体改善经皮水分流失或 SLS 刺激敏感性。',
    limitations: ['这项保湿结果不能改写为已证明屏障修复或抗炎。', '20% 是研究条件，不是所有甘油产品的有效浓度门槛；不能据此判定其他浓度无效。'],
    provenance: '原始论文摘要；Europe PMC / PubMed ID 已核对，未完成全文评审。',
  },
  {
    id: 'PMID-18025807', inci: 'GLYCERIN', title: 'Placebo-controlled, double-blind, randomized, prospective study of a glycerol-based emollient on eczematous skin in atopic dermatitis: biophysical and clinical evaluation.',
    url: 'https://pubmed.ncbi.nlm.nih.gov/18025807/', year: 2008, reviewedAt: '2026-09-22', kind: 'human_controlled',
    goals: ['hydration', 'barrier'], population: '24 名特应性皮炎患者的湿疹皮肤',
    design: '随机、双盲、载体对照', concentrationPercent: [20], testedForm: 'leave_on', formulation: '含 20% 甘油的润肤乳霜',
    regimen: '每日两次，28 天', finding: '受试配方改善含水量及屏障指标；红斑、SCORAD 和局部严重度未见显著组间差异。',
    limitations: ['疾病人群研究不能作为普通化妆品治疗湿疹的证据。', '与健康皮肤研究的终点结果不完全一致，不能只挑积极结果。'],
    provenance: '原始论文摘要；Europe PMC / PubMed ID 已核对，未完成全文评审。',
  },
  {
    id: 'PMID-11737814', inci: 'GLYCERIN', title: 'Instrumental and dermatologist evaluation of the effect of glycerine and urea on dry skin in atopic dermatitis.',
    url: 'https://pubmed.ncbi.nlm.nih.gov/11737814/', year: 2001, reviewedAt: '2026-09-22', kind: 'human_controlled',
    goals: [], nonSupportingGoals: ['hydration', 'barrier'], population: '109 名特应性皮炎患者',
    design: '随机、平行、双盲；甘油配方、载体与尿素复方比较', concentrationPercent: [20], testedForm: 'leave_on',
    formulation: '20% 甘油霜与其载体及 4% 尿素加 4% 氯化钠霜比较', regimen: '30 天；摘要未披露使用频率',
    finding: '甘油与其载体在经皮水分流失和皮肤电容未见差异；尿素复方在部分干燥/屏障指标优于甘油配方。',
    limitations: ['复方之间的差异不能全部归因于单一尿素。', '保留这项未见差异的结果；不能改写为所有甘油产品无效。'],
    provenance: '原始论文摘要；Europe PMC / PubMed ID 已核对，未完成全文评审。',
  },
  {
    id: 'PMID-35361325', inci: 'UREA', title: 'Comparison of Urea-Based Compounding Moisturizers and Similar Commercial Products on Skin Barrier Function: A Randomized Biometric Study.',
    url: 'https://pubmed.ncbi.nlm.nih.gov/35361325/', year: 2021, reviewedAt: '2026-09-22', kind: 'human_controlled',
    goals: ['hydration', 'barrier'], population: '30 名 21–56 岁的干燥皮肤志愿者，研究前臂皮肤',
    design: '随机生物物理指标比较', concentrationPercent: [5, 10], testedForm: 'leave_on',
    formulation: '含尿素的亲水性凡士林配方与类似市售配方', regimen: '每日两次，7 天；另有单次涂抹时点',
    finding: '受试配方改善部分保湿和屏障指标；市售配方在部分单次时点优于配制产品。',
    limitations: ['载体与辅料影响结果；5% 和 10% 是受试浓度，不是通用有效性阈值。', '不是当前待测成品、长期效果或治疗疾病的证据。'],
    provenance: '原始论文摘要；Europe PMC / PubMed ID 已核对，未完成全文评审。',
  },
  {
    id: 'PMID-22052267', inci: 'HYALURONIC ACID', title: 'Efficacy of cream-based novel formulations of hyaluronic acid of different molecular weights in anti-wrinkle treatment.',
    url: 'https://pubmed.ncbi.nlm.nih.gov/22052267/', year: 2011, reviewedAt: '2026-09-22', kind: 'human_controlled',
    goals: ['hydration', 'wrinkles'], population: '76 名 30–60 岁、眼周有皱纹的女性；对侧眼周用载体',
    design: '随机、载体对照', concentrationPercent: [0.1], testedForm: 'leave_on',
    formulation: '0.1% 透明质酸乳霜；分子量 50 / 130 / 300 / 800 / 2000 kDa', regimen: '每日两次，60 天',
    finding: '各受试分子量配方改善保湿和弹性；皱纹深度改善主要出现在 50 和 130 kDa 组。',
    limitations: ['抗皱结果具有分子量条件，不能给所有透明质酸配方同样的抗皱结论。', '未标明分子量时保留未知；透明质酸钠、交联形式等不能自动视为同一受试材料。'],
    provenance: '原始论文摘要；Europe PMC / PubMed ID 已核对，未完成全文评审。',
  },
  {
    id: 'PMID-10965426', inci: 'PANTHENOL', title: 'Effect of topically applied dexpanthenol on epidermal barrier function and stratum corneum hydration. Results of a human in vivo study.',
    url: 'https://pubmed.ncbi.nlm.nih.gov/10965426/', year: 2000, reviewedAt: '2026-09-22', kind: 'human_controlled',
    goals: ['hydration', 'barrier'], population: '人体研究；摘要未披露样本量及部位',
    design: '随机、双盲、安慰剂/载体对照', concentrationPercent: [], testedForm: 'leave_on',
    formulation: '两种亲脂性载体中的右泛醇（dexpanthenol）；摘要未披露浓度', regimen: '7 天；摘要未披露使用频率',
    finding: '两种受试右泛醇配方相较各自载体提高角质层含水量并降低经皮水分流失。',
    limitations: ['摘要未披露浓度、样本量和频率，不能补写数字。', '标签仅写泛醇时，立体异构体和完整配方是否与研究一致仍未确认。'],
    provenance: '原始论文摘要；Europe PMC / PubMed ID 已核对，未完成全文评审。',
  },
];

const goalDefinitions: { goal: EfficacyGoal; label: string; aliases: string[] }[] = [
  { goal: 'hydration', label: '保湿', aliases: ['保湿', '补水', '改善干燥'] },
  { goal: 'barrier', label: '皮肤屏障', aliases: ['屏障', '修护', '修复'] },
  { goal: 'wrinkles', label: '细纹与皱纹', aliases: ['抗皱', '淡纹', '细纹', '皱纹', '抗老'] },
  { goal: 'pigmentation', label: '色素沉着', aliases: ['美白', '淡斑', '提亮', '色素沉着', '色斑'] },
  { goal: 'oil_control', label: '油脂', aliases: ['控油', '出油', '皮脂'] },
  { goal: 'acne', label: '痘痘', aliases: ['祛痘', '去痘', '痤疮', '粉刺'] },
  { goal: 'exfoliation', label: '角质', aliases: ['去角质', '焕肤'] },
  { goal: 'uv_protection', label: '紫外线防护', aliases: ['防晒', 'SPF', '紫外线防护'] },
  { goal: 'antioxidant', label: '抗氧化', aliases: ['抗氧化'] },
];
export const efficacyGoalLabel = (goal: EfficacyGoal) => goalDefinitions.find(row => row.goal === goal)?.label ?? goal;
const escapeRegExp = (value: string) => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const aliasPattern = (alias: string) => /[\u4e00-\u9fff]/.test(alias)
  ? Array.from(alias).map(escapeRegExp).join('[ \\t]*')
  : escapeRegExp(alias).replace(/ /g, '[ \\t]+');
const validNumber = (value: unknown): value is number => typeof value === 'number' && Number.isFinite(value) && value >= 0 && value <= 100;

/** Reject incomplete records at the data boundary instead of inventing study fields. */
export function validateIngredientStudies(value: unknown): asserts value is IngredientStudy[] {
  if (!Array.isArray(value)) throw new TypeError('evidence_not_array');
  const ids = new Set<string>();
  const goals = new Set(goalDefinitions.map(row => row.goal));
  const kinds = new Set(['human_controlled', 'human_uncontrolled', 'animal', 'in_vitro', 'formulation_reference']);
  for (const row of value) {
    if (!row || typeof row !== 'object' || Array.isArray(row)) throw new TypeError('invalid_evidence');
    for (const field of ['id', 'inci', 'title', 'url', 'reviewedAt', 'population', 'design', 'formulation', 'regimen', 'finding', 'provenance']) {
      if (typeof row[field] !== 'string' || !row[field].trim()) throw new TypeError(`evidence_missing_${field}`);
    }
    if (ids.has(row.id)) throw new TypeError('duplicate_evidence_id');
    ids.add(row.id);
    const url = new URL(row.url);
    if (url.protocol !== 'https:' || url.username || url.password) throw new TypeError('invalid_evidence_url');
    if (!Number.isInteger(row.year) || row.year < 1900 || row.year > 2100 || !/^\d{4}-\d{2}-\d{2}$/.test(row.reviewedAt)) throw new TypeError('invalid_evidence_date');
    if (!kinds.has(row.kind) || !['leave_on', 'rinse_off', 'oral', 'unknown'].includes(row.testedForm)) throw new TypeError('invalid_evidence_type');
    if (!Array.isArray(row.goals) || row.goals.some((goal: unknown) => !goals.has(goal as EfficacyGoal))) throw new TypeError('invalid_evidence_goal');
    if (row.nonSupportingGoals !== undefined && (!Array.isArray(row.nonSupportingGoals) || row.nonSupportingGoals.some((goal: unknown) => !goals.has(goal as EfficacyGoal)))) throw new TypeError('invalid_evidence_goal');
    if (!Array.isArray(row.concentrationPercent) || !row.concentrationPercent.every(validNumber)) throw new TypeError('invalid_evidence_concentration');
    if (!Array.isArray(row.limitations) || !row.limitations.length || row.limitations.some((item: unknown) => typeof item !== 'string' || !item.trim())) throw new TypeError('missing_evidence_limitations');
    if (!ingredientCatalog.some(item => item.inci === row.inci)) throw new TypeError('unknown_evidence_ingredient');
  }
}
validateIngredientStudies(ingredientStudies);

function checkedInput(input: IngredientEfficacyInput) {
  if (!input || typeof input !== 'object' || typeof input.text !== 'string' || input.text.length > 100000) throw new TypeError('invalid_ingredient_text');
  if (input.labelText !== undefined && (typeof input.labelText !== 'string' || input.labelText.length > 100000)) throw new TypeError('invalid_label_text');
  if (input.declaredProductForm !== undefined && !['leave_on', 'rinse_off', 'oral', 'unknown'].includes(input.declaredProductForm)) throw new TypeError('invalid_product_form');
}

function contextAt(text: string, start: number, end: number) {
  const before = text.slice(0, start), after = text.slice(end);
  const left = Math.max(before.lastIndexOf('。'), before.lastIndexOf('！'), before.lastIndexOf('？'), before.lastIndexOf('\n')) + 1;
  const next = after.search(/[。！？\n]/);
  const right = next < 0 ? text.length : end + next + 1;
  return { before: text.slice(Math.max(left, start - 60), start), after: text.slice(end, Math.min(right, end + 60)), full: text.slice(left, right).slice(0, 500) };
}

function originAt(text: string, start: number, end: number, source: 'text' | 'label'): Exclude<IngredientOrigin, 'conflicting'> {
  const context = contextAt(text, start, end);
  const localBefore = context.before.split(/[，,；;]/).pop() ?? '';
  if (/(?:竞品|另一款|其他产品|别的产品|受试配方|试验配方|对照配方)/.test(context.before)) return 'mentioned';
  if (source === 'text' && (/[?？]|(?:吗|么)(?:[。！？!?]|$)/.test(context.after) || /(?:是否|有没有|会不会|如果|假如|假设|比如|例如|研究|论文|科普|听说|据说|讨论|不确定|未确认|可能是|看不清)/.test(context.before + context.after.slice(0, 20)))) return 'mentioned';
  if (/(?:不含(?:有)?|未含(?:有)?|没有(?:添加|使用)?|没加|未添加|未使用|无添加|不添加|不使用)\s*(?:任何|这个|该|此|\d+(?:\.\d+)?\s*[%％])?[^，,；;。！？\n]{0,12}$/.test(localBefore) || /^\s*(?:并未添加|不在(?:成分表|配方)中|未添加|未检出|没有检出)/.test(context.after)) return 'negated';
  if (/(?:without|free of|does not contain|no added)\s*(?:\d+(?:\.\d+)?\s*[%％])?\s*$/i.test(localBefore)) return 'negated';
  if (source === 'label') return 'label';
  if (/(?:含有|含|添加了?|采用了?|加入了?|用到|配方[为是]|成分(?:表)?[为是：:])[^，,；;。！？\n]{0,24}$/.test(localBefore)) return 'claimed';
  if (/(?:contains?|with|ingredients?\s*:)\s*(?:\d+(?:\.\d+)?\s*[%％])?\s*$/i.test(localBefore)) return 'claimed';
  // A concentration attached to a name alone is still not proof of a product's composition.
  return 'mentioned';
}

function concentrationAt(text: string, occurrence: TextReference): Concentration | undefined {
  // Consume the entire numeric token, never the "5" suffix of .5, 1005 or -5.
  const number = '(?:\\d+(?:\\.\\d+)?|\\.\\d+)';
  const quantity = `(${number})(?:\\s*[%％]?\\s*[-–—~～至到]\\s*(${number}))?\\s*[%％]`;
  const qualifier = '(?:约|大约|大概|不低于|不高于|不少于|不多于|低于|高于|不足|超过|至少|至多|≤|≥|<|>)?';
  const before = text.slice(Math.max(0, occurrence.start - 35), occurrence.start);
  const after = text.slice(occurrence.end, occurrence.end + 45);
  const preceding = new RegExp(`(?<![\\d.,，+\\-−])${qualifier}\\s*${quantity}\\s*(?:[（(](?:w/v|v/v|w/w)[)）])?\\s*(?:的)?\\s*(?:复合)?\\s*$`, 'i').exec(before);
  const following = new RegExp(`^\\s*[（(]?\\s*(?:(?:浓度|含量)\\s*(?:为|是|[:：=])?\\s*)?(?:为|是|[:：=])?\\s*${qualifier}\\s*${quantity}`).exec(after);
  const match = preceding ?? following;
  if (!match) return undefined;
  const min = Number(match[1]), max = match[2] === undefined ? min : Number(match[2]);
  if (!validNumber(min) || !validNumber(max) || min > max) return undefined;
  if (preceding && /[\d.,，+\-−]\s*$/.test(before.slice(0, preceding.index))) return undefined;
  const start = preceding ? occurrence.start - before.length + preceding.index : occurrence.end + match.index;
  const end = start + match[0].length;
  const tail = following ? after.slice(following[0].length).replace(/^[)）\s]+/, '') : after;
  const measurementChanged = /体积分数|体积百分|w\s*\/\s*v|v\s*\/\s*v|干物质|干重|摩尔/i.test(before + after.slice(0, 30));
  const blend = /^\s*(?:复合(?:物)?|混合(?:物)?|原料液|溶液)/.test(tail) || /(?:复合(?:物)?|混合物|原料液)/.test(before) || /原料活性含量|原料浓度/.test(after);
  return {
    source: occurrence.source, quote: text.slice(start, end), start, end,
    minPercent: min, maxPercent: max, qualifier: min !== max ? 'range' : /约|大概|低于|高于|不少于|不多于|不足|超过|至少|至多|[≤≥<>]/.test(match[0]) ? 'approximate' : 'exact',
    basis: measurementChanged ? 'measurement_not_comparable' : blend ? 'blend_claim' : 'as_stated',
  };
}

/** A name must be a complete chemical term, not merely a substring of an
 * unknown salt, ester, substituted compound or polymer. Chinese has no spaces
 * between prose words, so only explicit narrative boundaries are accepted.
 * Unrecognized continuations stay unrecognized instead of inheriting evidence. */
function completeChemicalName(text: string, start: number, end: number, alias: string) {
  const left = text.slice(Math.max(0, start - 60), start).replace(/[ \t]+$/g, '');
  const right = text.slice(end, end + 60).replace(/^[ \t]+/g, '');
  const compactLeft = left.replace(/[ \t]/g, '');
  const compactRight = right.replace(/[ \t]/g, '');
  if (/^(?:的)?(?:衍生物|衍生品|类似物|前体)/.test(compactRight)) return false;
  const composite = /^(?:复合(?:物)?|混合(?:物)?)(.*)$/.exec(compactRight);
  if (composite?.[1] && !/^(?:[，,、。；;：:（()）%％\d]|的|和|及|与|或|可|能|有|是|不|但|用于|浓度|含量|添加量)/.test(composite[1])) return false;
  if (/[\u4e00-\u9fff]/.test(alias)) {
    if (/[\u4e00-\u9fff]$/.test(compactLeft) && !/(?:含有?|含有的|添加了?|添加的|采用了?|加入了?|使用了?|用到|配方|成分|为|是|的|和|及|与|或|无|加|关于|讨论|科普|介绍|提到|说|认为|微量|少量|大量|复合|不含有?|未含有?|没有|其他|纯|例如|比如)$/.test(compactLeft)) return false;
    if (/[A-Za-zαβγ]-?$/.test(compactLeft)) return false;
    if (/^[\u4e00-\u9fff]/.test(compactRight) && !/^(?:的|和|及|与|或|等|可|能|有|是|在|对|不|未|没有|并|但|被|这种|属于|通过|通常|主要|浓度|含量|添加量|纯度|成分|复合物?|混合物?|原料液|溶液|保湿|补水|修护|修复|抗皱|抗老|淡纹|美白|提亮|淡斑|控油|防晒|作用|功效|研究|论文|吗|呢|么)/.test(compactRight)) return false;
  } else {
    // Spaces within English chemical names are not true boundaries either:
    // HYDROXYETHYL UREA must not become UREA, and RETINOL PROPIONATE is not RETINOL.
    const beforeWord = /([A-Za-z]+)[ \t]+$/.exec(text.slice(Math.max(0, start - 40), start));
    const afterWord = /^[ \t]+([A-Za-z]+)/.exec(text.slice(end, end + 40));
    if (beforeWord && !/^(?:contains?|with|without|of|and|or|is|ingredient|ingredients|about|discuss|added|adding|no|the)$/i.test(beforeWord[1])) return false;
    if (afterWord && !/^(?:and|or|is|for|can|may|has|in|at|to|with|helps?|supports?|does|was|not)$/i.test(afterWord[1])) return false;
  }
  return true;
}

export function findIngredientOccurrences(text: string, source: 'text' | 'label' = 'text'): { definition: IngredientDefinition; occurrence: IngredientOccurrence }[] {
  if (typeof text !== 'string' || text.length > 100000 || !['text', 'label'].includes(source)) throw new TypeError('invalid_ingredient_text');
  const matches: { definition: IngredientDefinition; occurrence: IngredientOccurrence }[] = [];
  for (const definition of ingredientCatalog) for (const alias of [definition.cn, definition.inci, ...definition.aliases]) {
    const regex = new RegExp(aliasPattern(alias), 'gi');
    for (const found of text.matchAll(regex)) {
      const start = found.index!, end = start + found[0].length;
      if (/^[A-Za-z0-9 -]+$/.test(alias) && (/[A-Za-z]/.test(text[start - 1] ?? '') || /[A-Za-z]/.test(text[end] ?? ''))) continue;
      if (!completeChemicalName(text, start, end, alias)) continue;
      if (alias === '水' && (!/(?:^|[，,、：:\s])$/.test(text.slice(Math.max(0, start - 1), start)) || !/^(?:[，,、。\s]|$)/.test(text.slice(end, end + 1)))) continue;
      if (definition.inci === 'NIACINAMIDE' && /^\s*(?:核糖|单核苷酸)/.test(text.slice(end))) continue;
      const reference: TextReference = { source, quote: found[0], start, end };
      matches.push({ definition, occurrence: { ...reference, origin: originAt(text, start, end, source), context: contextAt(text, start, end).full, concentration: concentrationAt(text, reference) } });
    }
  }
  const accepted: typeof matches = [];
  for (const match of matches.sort((a, b) => a.occurrence.start - b.occurrence.start || b.occurrence.end - a.occurrence.end)) {
    if (!accepted.length || match.occurrence.start >= accepted[accepted.length - 1].occurrence.end) accepted.push(match);
  }
  return accepted.sort((a, b) => a.occurrence.start - b.occurrence.start);
}

function extractClaims(text: string): EfficacyClaim[] {
  const claims: EfficacyClaim[] = [];
  for (const definition of goalDefinitions) for (const alias of definition.aliases) for (const match of text.matchAll(new RegExp(escapeRegExp(alias), 'gi'))) {
    const start = match.index!, end = start + match[0].length, context = contextAt(text, start, end);
    if (claims.some(row => row.goal === definition.goal && start < row.end && end > row.start)) continue;
    const localBefore = context.before.split(/[，,；;]|但是|不过/).pop() ?? '';
    const polarity = /(?:不能|不会|并不|无法|不可能|不代表|没有|并无|不是|别指望|不要指望|未见|未证明|不(?!仅|但|只))[^，,。！？\n]{0,10}$/.test(localBefore) || /^\s*(?:效果)?(?:不明显|无效|没效果|未获证实|是假的)/.test(context.after) ? 'negated'
      : /[?？]/.test(context.after) || /能否|是否|可否/.test(context.before) ? 'question' : 'affirmative';
    claims.push({ source: 'text', quote: match[0], start, end, goal: definition.goal, polarity });
  }
  return claims.sort((a, b) => a.start - b.start);
}

function detectProductForm(input: IngredientEfficacyInput): IngredientEfficacyReport['productForm'] {
  if (input.declaredProductForm && input.declaredProductForm !== 'unknown') return { value: input.declaredProductForm, source: 'declared' };
  const text = input.text;
  // Only local explicit product/use wording is used; research discussion is not a product label.
  const contexts = text.split(/[。！？\n，,；;]/).filter(sentence => /(?:这款|本品|这支|这瓶|产品|使用方法|用法|用后|使用后|免冲洗|无需冲洗|this (?:product|is)|rinse-off|oral supplement)/i.test(sentence));
  const seen: { value: ProductForm; quote: string }[] = [];
  for (const sentence of contexts) {
    const oral = /口服|吞服|食用|oral|supplement/i.exec(sentence);
    const noRinse = /免冲洗|无需冲洗|不用冲洗|免洗|leave-on/i.exec(sentence);
    const rinse = /洗面奶|洁面|洗去|冲洗|沐浴露|洗发水|洗发露|rinse-off|cleanser/i.exec(sentence.replace(/免冲洗|无需冲洗|不用冲洗/g, ''));
    const leave = /面霜|乳霜|乳液|精华(?:液|露)?|留敷|cream|lotion|serum/i.exec(sentence);
    const selected = oral ? { value: 'oral' as const, quote: oral[0] } : rinse && !noRinse ? { value: 'rinse_off' as const, quote: rinse[0] } : noRinse || leave ? { value: 'leave_on' as const, quote: (noRinse ?? leave)![0] } : undefined;
    if (selected) seen.push(selected);
  }
  const values = [...new Set(seen.map(row => row.value))];
  // Explicit rinsing instruction overrides a marketing phrase such as 洁面精华.
  if (/使用后\s*(?:需要|应|要)?\s*(?:洗去|冲洗)/.test(text) && values.includes('rinse_off')) return { value: 'rinse_off', source: 'text', quote: '使用后冲洗' };
  return values.length === 1 ? { value: values[0], source: 'text', quote: seen[0].quote } : { value: 'unknown', source: 'unknown' };
}

function summarizeOrigin(occurrences: IngredientOccurrence[]): IngredientOrigin {
  const positive = occurrences.some(row => row.origin === 'label' || row.origin === 'claimed');
  if (positive && occurrences.some(row => row.origin === 'negated')) return 'conflicting';
  if (occurrences.some(row => row.origin === 'label')) return 'label';
  if (occurrences.some(row => row.origin === 'claimed')) return 'claimed';
  if (occurrences.some(row => row.origin === 'negated')) return 'negated';
  return 'mentioned';
}

function applicableStudy(study: IngredientStudy, concentrations: Concentration[], form: ProductForm, goals: EfficacyGoal[]): StudyApplicability {
  const human = study.kind === 'human_controlled' || study.kind === 'human_uncontrolled';
  const level = human ? 'human_ingredient_evidence' : study.kind === 'formulation_reference' ? 'reference_only' : 'preclinical_only';
  const useful = concentrations.filter(row => row.basis === 'as_stated');
  const concentration = !concentrations.length || !study.concentrationPercent.length ? 'unknown'
    : useful.length !== concentrations.length || useful.some(row => row.qualifier !== 'exact') || new Set(useful.map(row => row.minPercent)).size > 1 ? 'not_comparable'
    : study.concentrationPercent.some(value => Math.abs(value - useful[0].minPercent) < 0.000001) ? 'matches_studied_value' : 'different_from_study';
  const productForm = form === 'unknown' || study.testedForm === 'unknown' ? 'unknown' : form === study.testedForm ? 'compatible_category' : 'different_category';
  const relevantGoals = study.goals.filter(goal => goals.includes(goal));
  const conditions: string[] = [study.population, study.formulation, study.regimen];
  if (concentration === 'unknown') conditions.push('当前内容没有可与该研究直接比较的明确活性浓度。');
  if (concentration === 'different_from_study') conditions.push('内容声称的浓度与该研究不同；不能因此判定无效，也不能直接套用研究效果。');
  if (concentration === 'not_comparable') conditions.push('浓度为范围、近似值、混合原料比例、不同计量基准或存在冲突，不能作为相同活性浓度。');
  if (productForm === 'different_category') conditions.push('当前剂型/使用方式与研究不同，不能直接外推。');
  if (productForm === 'unknown') conditions.push('尚未确认当前产品剂型和接触方式。');
  if (productForm === 'compatible_category') conditions.push('仅使用方式大类一致，未核实研究所用完整载体、pH、稳定性等配方条件。');
  return { evidenceId: study.id, level, relevantGoals, concentration, productForm, nonSupportingGoals: [...(study.nonSupportingGoals ?? [])],
    interpretation: human ? '存在该成分在特定研究配方和条件下的人体依据；不是当前成品已有效的证明。'
      : level === 'reference_only' ? '原料或配方参考资料，不是人体功效试验。' : '仅有本库收录的前临床/吸收等证据，不能当成人体功效成立。',
    conditions: [...conditions, ...study.limitations] };
}

/** labelText is explicitly user-marked label OCR, never a verified product identity. */
export function assessIngredientEfficacy(input: IngredientEfficacyInput): IngredientEfficacyReport {
  checkedInput(input);
  const claims = extractClaims(input.text), goals = [...new Set(claims.filter(row => row.polarity === 'affirmative').map(row => row.goal))];
  const productForm = detectProductForm(input);
  const found = [...findIngredientOccurrences(input.text), ...findIngredientOccurrences(input.labelText ?? '', 'label')];
  const groups = new Map<string, { definition: IngredientDefinition; occurrences: IngredientOccurrence[] }>();
  for (const match of found) {
    const group = groups.get(match.definition.id) ?? { definition: match.definition, occurrences: [] };
    group.occurrences.push(match.occurrence); groups.set(match.definition.id, group);
  }
  const ingredients: IngredientAssessment[] = [...groups.values()].map(({ definition, occurrences }) => {
    const origin = summarizeOrigin(occurrences);
    const concentrations = occurrences.filter(row => row.origin === 'label' || row.origin === 'claimed').flatMap(row => row.concentration ? [row.concentration] : []);
    const studies = ingredientStudies.filter(row => row.inci === definition.inci);
    const evidence = studies.map(study => applicableStudy(study, concentrations, productForm.value, goals));
    const evidenceStatus = evidence.some(row => row.level === 'human_ingredient_evidence') ? 'human_ingredient_evidence' : evidence.length ? 'preclinical_only' : 'no_indexed_evidence';
    const identityStatus = origin === 'label' ? 'user_reported_label' : origin === 'claimed' ? 'content_claim' : origin === 'negated' ? 'explicitly_negated' : origin === 'conflicting' ? 'conflicting_statements' : 'not_established';
    const prefix = origin === 'label' ? '用户标记的标签文字列出此成分；尚未独立核实标签与当前产品。'
      : origin === 'claimed' ? '内容声称产品含此成分；不是配方检测结果。'
      : origin === 'negated' ? '内容明确否定含有此成分，不能据此给当前产品添加功效依据。'
      : origin === 'conflicting' ? '输入对是否含有此成分存在冲突，先核对产品和来源。'
      : '内容提及此成分，尚不能确认当前产品确实含有。';
    const positiveStudies = studies.filter(study => study.goals.length && ['human_controlled', 'human_uncontrolled'].includes(study.kind));
    const suffix = evidenceStatus === 'human_ingredient_evidence' ? (positiveStudies[0]?.finding ?? '本库有人体研究；本次研究未证明所有考察终点改善。')
      : evidenceStatus === 'preclinical_only' ? '本库仅有前临床或配方资料，不能证明人体效果。' : '本库尚未收录匹配功效研究；这不等于该成分无效。';
    return { ...definition, aliases: [...definition.aliases], origin, identityStatus, occurrences, concentrations, evidence, evidenceStatus, summary: prefix + suffix };
  });
  const namedProducts = [...input.text.matchAll(/([A-Z甲乙丙丁])(?:款|产品|精华|面霜|乳液|洁面)/g)].map(match => match[1]);
  const differentProducts = new Set(namedProducts).size > 1 || /竞品|另一款|其他产品|别的产品|多款产品|两款产品/.test(input.labelText ?? '');
  const eligible = differentProducts ? [] : ingredients.filter(row => row.origin === 'label' || row.origin === 'claimed');
  const humanRelevant = eligible.flatMap(row => row.evidence).filter(row => row.level === 'human_ingredient_evidence' && row.relevantGoals.length);
  const compatible = humanRelevant.filter(row => row.productForm !== 'different_category' && row.concentration !== 'different_from_study' && row.concentration !== 'not_comparable');
  const supportedIngredientGoals = [...new Set(compatible.flatMap(row => row.relevantGoals))];
  const mixedEvidenceGoals = [...new Set(eligible.flatMap(row => row.evidence.flatMap(study => study.nonSupportingGoals)).filter(goal => supportedIngredientGoals.includes(goal)))];
  const status = !eligible.length || !goals.length ? 'insufficient_input' : compatible.length ? 'ingredient_basis_only' : humanRelevant.length ? 'conditions_not_matched' : 'no_matching_evidence';
  const summary = differentProducts ? '输入涉及不同产品，尚未确认成分与目标产品的归属；逐成分研究不能转移给另一款产品。'
    : !eligible.length ? '目前只有成分讨论或否定/冲突表述，尚不能确认该产品的配方与效果。'
    : !goals.length ? '已识别到声称的成分，但未提取到明确功效目标；可查看逐成分研究条件。'
    : status === 'ingredient_basis_only' ? `${supportedIngredientGoals.map(efficacyGoalLabel).join('、')}有相关原料人体研究${mixedEvidenceGoals.length ? '，部分试验结果不完全一致' : ''}；当前成品效果仍未被这份内容证实。`
    : status === 'conditions_not_matched' ? '有相关原料研究，但浓度或使用方式与研究条件不符或无法比较，暂不能推定成品效果。'
    : '本库未找到足以匹配当前宣称的成分人体证据；无法据此认定有效，也不等于无效。';
  const missingEvidence = ['当前成品与本条功效目标对应的直接评价资料。', '产品身份、完整配方及标签来源的独立核实。'];
  if (eligible.some(row => !row.concentrations.length)) missingEvidence.push('部分成分的明确活性浓度；不能根据成分排列顺序猜测。');
  if (productForm.value === 'unknown') missingEvidence.push('实际剂型、留敷/冲洗方式与使用方法。');
  missingEvidence.push('完整配方载体、稳定性及与研究人群/部位/周期的适配。');
  const sourceIds = new Set(ingredients.flatMap(row => row.evidence.map(study => study.evidenceId)));
  const ambiguousMentions = [...input.text.matchAll(/玻尿酸(?!钠)|维C|A醇类|神经酰胺(?![ \t]*(?:NP|AP|EOP))/gi)]
    .filter(match => !found.some(row => row.occurrence.source === 'text' && match.index! >= row.occurrence.start && match.index! < row.occurrence.end))
    .map(match => ({ source: 'text' as const, quote: match[0], start: match.index!, end: match.index! + match[0].length, reason: '此处是原料家族或营销名称，未确定精确化学形态，未自动继承具体分子的功效研究。' }));
  return {
    version: INGREDIENT_EFFICACY_VERSION, ingredients, claims, ambiguousMentions,
    sources: ingredientStudies.filter(row => sourceIds.has(row.id)).map(row => ({ ...row, goals: [...row.goals], nonSupportingGoals: [...(row.nonSupportingGoals ?? [])], concentrationPercent: [...row.concentrationPercent], limitations: [...row.limitations] })),
    productAssessment: { status, efficacyEstablished: false, productEvidence: [], summary, supportedIngredientGoals, mixedEvidenceGoals, missingEvidence }, productForm,
    limitations: ['分析的是输入中的成分表述和已收录研究，不是实物检测。', '本轮为少量原始研究摘要的审阅结果，未完成全文偏倚审查或系统综述。', '原料研究与成品直接证据分开；相同成分或相同浓度不能自动证明成品有效。', '证据库未收录不代表研究不存在；没有证据不等于无效。', '多个产品或引用研究混在同一段时，无法自动确认每个成分属于哪一款产品。'],
  };
}
