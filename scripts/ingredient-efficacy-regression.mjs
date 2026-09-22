import assert from 'node:assert/strict';
import { ingredients as legacyIngredients } from '../lib/shared/knowledge.ts';
import { assessIngredientEfficacy, findIngredientOccurrences, ingredientCatalog, ingredientStudies, validateIngredientStudies } from '../lib/shared/ingredient-efficacy.ts';

let checks = 0;
const test = (name, run) => { run(); checks++; console.log(`PASS ${name}`); };
const assess = (text, extra = {}) => assessIngredientEfficacy({ text, ...extra });
const ingredient = (report, inci) => report.ingredients.find(item => item.inci === inci);
const source = (id) => ingredientStudies.find(item => item.id === `PMID-${id}`);
const clonedStudies = () => structuredClone(ingredientStudies);

test('existing 30 identities are preserved and extended without collisions', () => {
  assert.equal(legacyIngredients.length, 30);
  for (const row of legacyIngredients) assert.ok(ingredientCatalog.some(item => item.id === row.id && item.inci === row.inci));
  assert.equal(new Set(ingredientCatalog.map(item => item.inci)).size, ingredientCatalog.length);
});
test('all nine reviewed primary studies satisfy the evidence schema', () => {
  validateIngredientStudies(ingredientStudies);
  assert.equal(ingredientStudies.length, 9);
  assert.equal(new Set(ingredientStudies.map(item => item.inci)).size, 7);
});
test('study URLs are primary PubMed records with matching identifiers', () => {
  for (const study of ingredientStudies) assert.equal(new URL(study.url).pathname, `/${study.id.replace('PMID-', '')}/`);
});
test('real niacinamide study fixture retains concentration and trial duration', () => {
  assert.deepEqual(source('16029679').concentrationPercent, [5]);
  assert.match(source('16029679').regimen, /12 周/);
  assert.match(source('16029679').limitations.join(''), /宝洁/);
});
test('real retinol fixture retains elderly upper-arm study limitations', () => {
  assert.deepEqual(source('17515510').concentrationPercent, [0.4]);
  assert.match(source('17515510').population, /87.*手臂/);
  assert.match(source('17515510').limitations.join(''), /7 天|7天/);
});
test('real glycerin fixtures retain negative endpoints and mixed trials', () => {
  assert.deepEqual(source('18498456').goals, ['hydration']);
  assert.deepEqual(source('18498456').nonSupportingGoals, ['barrier']);
  assert.deepEqual(source('11737814').goals, []);
  assert.ok(source('11737814').nonSupportingGoals.includes('hydration'));
});
test('HA molecular weight dependence and panthenol unknown concentration are retained', () => {
  assert.match(source('22052267').finding, /50.*130/);
  assert.deepEqual(source('10965426').concentrationPercent, []);
  assert.match(source('10965426').population, /未披露样本量/);
});
test('animal absorption research never becomes human efficacy', () => {
  const report = assess('这款精华含20%抗坏血酸，宣传美白抗皱。');
  assert.equal(ingredient(report, 'ASCORBIC ACID').evidence[0].level, 'preclinical_only');
  assert.equal(report.productAssessment.status, 'no_matching_evidence');
  assert.deepEqual(report.productAssessment.supportedIngredientGoals, []);
});
test('source matching keeps precise original text and UTF-16 offsets', () => {
  const text = '🙂 这款面霜含 烟 酰 胺 及甘 油，可以保湿。';
  const report = assess(text);
  assert.equal(ingredient(report, 'NIACINAMIDE').occurrences[0].quote, '烟 酰 胺');
  for (const row of report.ingredients) for (const occurrence of row.occurrences) assert.equal(text.slice(occurrence.start, occurrence.end), occurrence.quote);
});
test('all occurrences retained so conflicting statements cannot be hidden', () => {
  const report = assess('这款含烟酰胺，可提亮。另一张图说这款不含烟酰胺。');
  assert.equal(ingredient(report, 'NIACINAMIDE').occurrences.length, 2);
  assert.equal(ingredient(report, 'NIACINAMIDE').origin, 'conflicting');
  assert.equal(report.productAssessment.status, 'insufficient_input');
});
test('casual mention is not a product composition claim', () => {
  const report = assess('今天科普烟酰胺和视黄醇，也聊聊抗皱。');
  assert.ok(report.ingredients.every(row => row.origin === 'mentioned'));
  assert.equal(report.productAssessment.status, 'insufficient_input');
});
test('question or hypothetical ingredient presence is not an affirmative composition', () => {
  for (const text of ['这款是否含烟酰胺？美白吗？', '这款有没有烟酰胺？', '这款含烟酰胺吗。', '如果这款含烟酰胺，可能提亮。', '听说这款含烟酰胺，但还未确认。']) {
    assert.equal(ingredient(assess(text), 'NIACINAMIDE').origin, 'mentioned');
  }
});
test('explicit non-presence cannot support product claims', () => {
  const report = assess('这款面霜不含烟酰胺，但宣称提亮。');
  assert.equal(ingredient(report, 'NIACINAMIDE').origin, 'negated');
  assert.deepEqual(report.productAssessment.supportedIngredientGoals, []);
});
test('label source is explicitly user reported, never independently verified', () => {
  const labelText = '成分：水、烟酰胺、甘油';
  const report = assess('这款面霜宣称保湿、提亮。', { labelText });
  assert.equal(ingredient(report, 'NIACINAMIDE').origin, 'label');
  assert.equal(ingredient(report, 'NIACINAMIDE').identityStatus, 'user_reported_label');
  assert.equal(report.productAssessment.efficacyEstablished, false);
  for (const row of report.ingredients) for (const occurrence of row.occurrences) assert.equal(labelText.slice(occurrence.start, occurrence.end), occurrence.quote);
});
test('plain ingredient list wording is a content claim, not authenticated label', () => {
  const report = assess('成分表：烟酰胺。宣称提亮。');
  assert.equal(ingredient(report, 'NIACINAMIDE').origin, 'claimed');
  assert.equal(ingredient(report, 'NIACINAMIDE').identityStatus, 'content_claim');
});
test('5 percent niacinamide has a positive limited ingredient conclusion', () => {
  const report = assess('这款精华含5%烟酰胺，可提亮、淡纹。');
  const row = ingredient(report, 'NIACINAMIDE');
  assert.equal(row.evidence[0].concentration, 'matches_studied_value');
  assert.equal(row.evidence[0].productForm, 'compatible_category');
  assert.equal(report.productAssessment.status, 'ingredient_basis_only');
  assert.deepEqual(new Set(report.productAssessment.supportedIngredientGoals), new Set(['pigmentation', 'wrinkles']));
  assert.match(row.summary, /改善/);
  assert.equal(report.productAssessment.efficacyEstablished, false);
  assert.deepEqual(report.productAssessment.productEvidence, []);
});
test('unknown concentration stays unknown instead of being inferred from order', () => {
  const report = assess('这款面霜可以提亮。', { labelText: '水、烟酰胺、甘油' });
  assert.equal(ingredient(report, 'NIACINAMIDE').concentrations.length, 0);
  assert.equal(ingredient(report, 'NIACINAMIDE').evidence[0].concentration, 'unknown');
  assert.match(report.productAssessment.missingEvidence.join(''), /不能根据成分排列顺序/);
});
test('adjacent concentration has exact original quotation', () => {
  const text = '这款乳液含视黄醇（浓度为0.4%），主打抗皱。';
  const report = assess(text), concentration = ingredient(report, 'RETINOL').concentrations[0];
  assert.equal(concentration.minPercent, 0.4);
  assert.equal(text.slice(concentration.start, concentration.end), concentration.quote);
});
test('effect percentage cannot be mistaken for ingredient concentration', () => {
  const row = ingredient(assess('这款含烟酰胺，提亮效果提升50%。'), 'NIACINAMIDE');
  assert.equal(row.concentrations.length, 0);
});
test('different concentration is unproven applicability, never ineffective verdict', () => {
  const report = assess('这款面霜含2%烟酰胺，可提亮。');
  assert.equal(report.productAssessment.status, 'conditions_not_matched');
  assert.equal(ingredient(report, 'NIACINAMIDE').evidence[0].concentration, 'different_from_study');
  assert.match(ingredient(report, 'NIACINAMIDE').evidence[0].conditions.join(''), /不能因此判定无效/);
});
test('ranges, approximate values and blend proportions do not equal study active concentration', () => {
  for (const text of ['这款含2%-5%烟酰胺，可提亮。', '这款含2–5%烟酰胺，可提亮。', '这款含约5%烟酰胺，可提亮。', '这款含至少5%烟酰胺，可提亮。', '这款含<5%烟酰胺，可提亮。', '这款含5%烟酰胺复合物，可提亮。']) {
    assert.equal(ingredient(assess(text), 'NIACINAMIDE').evidence[0].concentration, 'not_comparable');
  }
});
test('contradictory concentrations do not silently choose a favorable value', () => {
  const report = assess('这款精华含5%烟酰胺。包装说含2%烟酰胺，可以提亮。');
  assert.equal(ingredient(report, 'NIACINAMIDE').evidence[0].concentration, 'not_comparable');
});
test('rinse-off does not inherit leave-on study applicability', () => {
  const report = assess('这款洗面奶含5%烟酰胺，宣称提亮。');
  assert.equal(report.productForm.value, 'rinse_off');
  assert.equal(report.productAssessment.status, 'conditions_not_matched');
  assert.equal(ingredient(report, 'NIACINAMIDE').evidence[0].productForm, 'different_category');
});
test('oral product never inherits topical clinical results', () => {
  const report = assess('这款口服产品含5%烟酰胺，宣称提亮。');
  assert.equal(report.productForm.value, 'oral');
  assert.equal(report.productAssessment.status, 'conditions_not_matched');
});
test('niacin is not niacinamide and cannot inherit its clinical evidence', () => {
  const report = assess('这款含Niacin（烟酸），主打美白。');
  assert.ok(ingredient(report, 'NIACIN'));
  assert.equal(ingredient(report, 'NIACINAMIDE'), undefined);
  assert.equal(report.sources.length, 0);
});
test('recognized precise English aliases still match chemical identity', () => {
  assert.ok(ingredient(assess('Nicotinamide and Glycerol'), 'NIACINAMIDE'));
  assert.ok(ingredient(assess('Retinaldehyde'), 'RETINAL'));
});
test('English composition and exclusion wording retain their different meaning', () => {
  assert.equal(ingredient(assess('This product contains 5% Niacinamide.'), 'NIACINAMIDE').origin, 'claimed');
  assert.equal(ingredient(assess('This product is free of Niacinamide.'), 'NIACINAMIDE').origin, 'negated');
});
test('retinol ester, retinal and parent are not merged', () => {
  const report = assess('这款含视黄醇棕榈酸酯、视黄醛，可抗皱。');
  assert.equal(ingredient(report, 'RETINOL'), undefined);
  assert.ok(ingredient(report, 'RETINYL PALMITATE'));
  assert.ok(ingredient(report, 'RETINAL'));
  assert.equal(report.sources.length, 0);
});
test('vitamin C derivatives never inherit L-ascorbic acid absorption experiments', () => {
  const report = assess('这款含3-O-乙基抗坏血酸、抗坏血酸葡糖苷，可美白。');
  assert.equal(ingredient(report, 'ASCORBIC ACID'), undefined);
  assert.equal(report.sources.length, 0);
});
test('HA salt, crosslinked form, hydrolysate and parent remain distinct', () => {
  const report = assess('这款含透明质酸钠交联聚合物、水解透明质酸钠、透明质酸钠，主打保湿。');
  assert.equal(ingredient(report, 'HYALURONIC ACID'), undefined);
  assert.equal(report.ingredients.length, 3);
  assert.equal(report.sources.length, 0);
});
test('marketing family names remain ambiguous instead of inheriting precise evidence', () => {
  const report = assess('这款含玻尿酸和维C，主打保湿提亮。');
  assert.equal(ingredient(report, 'HYALURONIC ACID'), undefined);
  assert.equal(ingredient(report, 'ASCORBIC ACID'), undefined);
  assert.equal(report.ambiguousMentions.length, 2);
});
test('nicotinamide riboside is not silently treated as niacinamide', () => {
  assert.equal(ingredient(assess('这款含烟酰胺核糖，可提亮。'), 'NIACINAMIDE'), undefined);
});
test('water inside hydration words is not an ingredient', () => {
  assert.equal(ingredient(assess('补水保湿'), 'AQUA'), undefined);
  assert.ok(ingredient(assess('成分：水、甘油'), 'AQUA'));
});
test('negated efficacy goals do not become affirmative product promises', () => {
  const report = assess('这款含5%烟酰胺，但不代表能美白。');
  assert.equal(report.claims.find(row => row.goal === 'pigmentation').polarity, 'negated');
  assert.deepEqual(report.productAssessment.supportedIngredientGoals, []);
});
test('glycerin efficacy summary keeps mixed evidence instead of cherry-picking', () => {
  const report = assess('这款面霜含20%甘油，主打保湿和屏障修护。');
  assert.equal(report.sources.length, 3);
  assert.ok(report.productAssessment.mixedEvidenceGoals.includes('hydration'));
  assert.ok(report.productAssessment.mixedEvidenceGoals.includes('barrier'));
  assert.match(report.productAssessment.summary, /不完全一致/);
});
test('common ingredient without reviewed efficacy is unknown, not ineffective', () => {
  const row = ingredient(assess('这款面霜含角鲨烷，主打保湿。'), 'SQUALANE');
  assert.equal(row.evidenceStatus, 'no_indexed_evidence');
  assert.match(row.summary, /不等于.*无效/);
});
test('urea named in a glycerin comparison never becomes its own independent study', () => {
  const report = assess('这款含4%尿素，保湿。');
  assert.ok(report.sources.every(row => row.inci === 'UREA'));
  assert.ok(!report.sources.some(row => row.id === 'PMID-11737814'));
});
test('input and evidence boundaries reject wrong types and malicious URLs', () => {
  assert.throws(() => assessIngredientEfficacy({ text: null }), /invalid_ingredient_text/);
  assert.throws(() => assessIngredientEfficacy({ text: 'x', labelText: [] }), /invalid_label_text/);
  assert.throws(() => assessIngredientEfficacy({ text: 'x', declaredProductForm: 'injection' }), /invalid_product_form/);
  const rows = clonedStudies(); rows[0].url = 'javascript:alert(1)';
  assert.throws(() => validateIngredientStudies(rows), /invalid_evidence_url/);
});
test('unknown or invented study data rejected instead of tolerated silently', () => {
  const duplicate = clonedStudies(); duplicate.push(duplicate[0]);
  assert.throws(() => validateIngredientStudies(duplicate), /duplicate_evidence_id/);
  const badConcentration = clonedStudies(); badConcentration[0].concentrationPercent = [NaN];
  assert.throws(() => validateIngredientStudies(badConcentration), /invalid_evidence_concentration/);
  const noLimits = clonedStudies(); noLimits[0].limitations = [];
  assert.throws(() => validateIngredientStudies(noLimits), /missing_evidence_limitations/);
});
test('reported studies cannot mutate the curated source on subsequent calls', () => {
  const first = assess('这款含5%烟酰胺，提亮。');
  first.sources[0].goals.length = 0;
  first.sources[0].limitations.length = 0;
  const second = assess('这款含5%烟酰胺，提亮。');
  assert.ok(second.sources[0].goals.length);
  assert.ok(second.sources[0].limitations.length);
});
test('empty content still yields an honest structured result', () => {
  const report = assess('');
  assert.equal(report.ingredients.length, 0);
  assert.equal(report.productAssessment.status, 'insufficient_input');
  assert.equal(report.productAssessment.efficacyEstablished, false);
});
test('outputs use only curated references and each original quote is locatable', () => {
  const text = '这款乳液含0.4%视黄醇，可以改善细纹。', labelText = '成分：水、甘油、视黄醇';
  const report = assess(text, { labelText });
  for (const row of report.ingredients) {
    for (const reference of [...row.occurrences, ...row.concentrations]) assert.equal((reference.source === 'text' ? text : labelText).slice(reference.start, reference.end), reference.quote);
    for (const evidence of row.evidence) assert.ok(report.sources.some(study => study.id === evidence.evidenceId));
  }
  for (const claim of report.claims) assert.equal(text.slice(claim.start, claim.end), claim.quote);
});

test('unlisted Chinese substitutions and derivatives never inherit a parent molecule', () => {
  const examples = [
    ['甘油硬脂酸酯', 'GLYCERIN'], ['甘油月桂酸酯', 'GLYCERIN'], ['聚甘油', 'GLYCERIN'],
    ['双咪唑烷基尿素', 'UREA'], ['咪唑烷基尿素', 'UREA'], ['羟乙基尿素', 'UREA'], ['尿素甲醛缩合物', 'UREA'],
    ['视黄醇丙酸酯', 'RETINOL'], ['视黄醇亚油酸酯', 'RETINOL'], ['泛醇三乙酸酯', 'PANTHENOL'],
    ['透明质酸钾', 'HYALURONIC ACID'], ['透明质酸锌', 'HYALURONIC ACID'], ['烟酰胺核糖', 'NIACINAMIDE'],
    ['视黄醇复合衍生物', 'RETINOL'], ['甘油混合酯', 'GLYCERIN'], ['烟酰胺的衍生物', 'NIACINAMIDE'],
  ];
  for (const [name, parent] of examples) {
    const report = assess(`这款面霜含${name}，主打保湿、抗皱、美白。`);
    assert.equal(ingredient(report, parent), undefined, name);
    assert.ok(!report.sources.some(study => study.inci === parent), name);
  }
});
test('OCR spacing does not create false chemical boundaries', () => {
  for (const text of ['成分：双 咪 唑 烷 基 尿素', '成分：甘油 硬脂酸酯', '这款含透明质酸 钾']) {
    assert.equal(assess(text).sources.length, 0, text);
  }
});
test('unknown English multiword derivatives cannot inherit the final or first word', () => {
  for (const text of ['HYDROXYETHYL UREA', 'RETINOL PROPIONATE', 'PANTHENOL TRIACETATE', 'HYDROLYZED UREA']) {
    assert.equal(assess(text).sources.length, 0, text);
  }
});
test('prose next to a precise parent ingredient still works after boundary hardening', () => {
  for (const text of ['这款含烟酰胺，可美白', '烟酰胺的作用', '甘油保湿', '关于尿素的研究', '成分：透明质酸、甘油、视黄醇']) {
    assert.ok(assess(text).ingredients.length > 0, text);
  }
});
test('direct negative efficacy wording cannot turn into affirmative goals', () => {
  for (const suffix of ['但不美白', '不是美白产品', '别指望美白', '没有美白效果', '美白不明显']) {
    const report = assess(`这款面霜含5%烟酰胺，${suffix}。`);
    assert.ok(report.claims.filter(claim => claim.goal === 'pigmentation').every(claim => claim.polarity === 'negated'), suffix);
    assert.deepEqual(report.productAssessment.supportedIngredientGoals, [], suffix);
  }
});
test('未含有 and 没加 are negative ingredient statements, not substring 含 claims', () => {
  for (const word of ['未含有', '未含', '没加']) {
    const row = ingredient(assess(`这款面霜${word}烟酰胺，宣传美白。`), 'NIACINAMIDE');
    assert.equal(row.origin, 'negated', word);
  }
});
test('unverified claim and reported non-detection remain conflicting statements', () => {
  const report = assess('商家声称这款含5%烟酰胺，但检测结果是烟酰胺未检出。产品主打美白。');
  assert.equal(ingredient(report, 'NIACINAMIDE').origin, 'conflicting');
  assert.deepEqual(report.productAssessment.supportedIngredientGoals, []);
});
test('decimal .5 percent is 0.5 and cannot accidentally equal five percent', () => {
  const row = ingredient(assess('这款精华含.5%烟酰胺，可美白。'), 'NIACINAMIDE');
  assert.equal(row.concentrations[0].minPercent, 0.5);
  assert.equal(row.evidence[0].concentration, 'different_from_study');
});
test('invalid and thousand-separated quantities are never truncated to a favorable number', () => {
  for (const number of ['1005%', '-5%', '- 5%', '1,005%', '5‰']) {
    const row = ingredient(assess(`这款精华含${number}烟酰胺，可美白。`), 'NIACINAMIDE');
    assert.ok(row.concentrations.length === 0 || row.evidence[0].concentration !== 'matches_studied_value', number);
  }
});
test('ingredient solution strengths and input blending ratios are not final active concentrations', () => {
  for (const text of ['这款精华含烟酰胺5%溶液，添加量1%，可美白。', '这款精华含5%的烟酰胺溶液，原料活性含量10%，可美白。', '这款精华含5%复合烟酰胺，可美白。']) {
    const row = ingredient(assess(text), 'NIACINAMIDE');
    assert.equal(row.evidence[0].concentration, 'not_comparable', text);
    assert.equal(row.concentrations[0].basis, 'blend_claim', text);
  }
});
test('volume or w/v concentrations do not silently equal an unspecified study percent basis', () => {
  for (const text of ['这款精华含体积分数5%烟酰胺，可美白。', '这款精华含5%（w/v）烟酰胺，可美白。']) {
    const row = ingredient(assess(text), 'NIACINAMIDE');
    assert.equal(row.evidence[0].concentration, 'not_comparable');
    assert.equal(row.concentrations[0].basis, 'measurement_not_comparable');
  }
});
test('ingredients in another product or study formulation do not transfer to target product', () => {
  for (const text of ['A精华含5%烟酰胺。我要测的是B精华，成分未知，宣传美白。', '受试配方含5%烟酰胺，使用12周改善细纹。我要测的是B面霜，成分表未公开，宣传抗皱。', 'A面霜含5%烟酰胺，仅用于日常护理。B面霜宣传美白，成分未知。']) {
    assert.deepEqual(assess(text).productAssessment.supportedIngredientGoals, [], text);
  }
  assert.deepEqual(assess('本品成分未知，宣传美白。', { labelText: '以下是竞品成分：烟酰胺' }).productAssessment.supportedIngredientGoals, []);
});
test('uncertain OCR statements are mentions, not asserted composition', () => {
  assert.equal(ingredient(assess('成分表可能是烟酰胺，但看不清。宣传提亮。'), 'NIACINAMIDE').origin, 'mentioned');
});
test('explicit rinse instructions override marketing form words', () => {
  const report = assess('这款洁面精华含5%烟酰胺，使用后洗去，宣传美白。');
  assert.equal(report.productForm.value, 'rinse_off');
  assert.equal(report.productAssessment.status, 'conditions_not_matched');
});
test('免冲洗 is leave-on and another product mentioned in a side clause does not set form', () => {
  assert.equal(assess('这款面霜含5%烟酰胺，免冲洗，可美白。').productForm.value, 'leave_on');
  assert.equal(assess('这款含5%烟酰胺的面霜可提亮，对洗面奶没要求。').productForm.value, 'leave_on');
});
test('English rinse-off and oral use stay incompatible with topical leave-on studies', () => {
  for (const text of ['This product is a rinse-off cleanser and contains 5% Niacinamide. 宣传美白。', 'This is an oral supplement with 5% Niacinamide. 宣传美白。']) {
    const row = ingredient(assess(text), 'NIACINAMIDE');
    assert.equal(row.evidence[0].productForm, 'different_category', text);
  }
});

console.log(`${checks} ingredient-efficacy checks passed. Real study metadata fixtures plus constructed input counterexamples; no network/LLM calls, not a clinical or model accuracy evaluation.`);
