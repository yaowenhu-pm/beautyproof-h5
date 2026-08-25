export type EvidenceCheck = {
  signal: string;
  excerpt: string;
  status: 'conflict' | 'needs_source' | 'context';
  kind: '法规依据' | '人体研究' | '动物研究' | '核验提示';
  strength: '明确' | '中等' | '有限';
  conclusion: string;
  scope: string;
  source: {
    title: string;
    organization: string;
    url: string;
  };
};

type EvidenceRule = {
  pattern: RegExp;
  signal: string;
  status: EvidenceCheck['status'];
  kind?: EvidenceCheck['kind'];
  strength?: EvidenceCheck['strength'];
  conclusion: string;
  scope?: string;
  source: EvidenceCheck['source'];
};

const nmpaEvaluation = {
  title: '《化妆品功效宣称评价规范》（2021年第50号）',
  organization: '国家药品监督管理部门',
  url: 'https://zwfw.nmpa.gov.cn/web/taskview/11100000MB0341032Y100017214900101',
};

const cosmeticsRegulation = {
  title: '《化妆品监督管理条例》第二十二条',
  organization: '国家市场监督管理总局',
  url: 'https://www.samr.gov.cn/zw/zfxxgk/fdzdgknr/bgt/art/2023/art_9f8b70e79a2242df96c6c290a0ac425b.html',
};

const advertisingLaw = {
  title: '《中华人民共和国广告法》第十七条',
  organization: '国家市场监督管理总局',
  url: 'https://www.samr.gov.cn/zt/ndzt/2019n/bjspjsqjxcjwljxyjsckpxc/zcfg/art/2023/art_f383fbf8c106420b8951ba8d9508d32d.html',
};

const fdaCosmetics = {
  title: 'Cosmetics Labeling Regulations',
  organization: 'U.S. Food and Drug Administration',
  url: 'https://www.fda.gov/cosmetics/cosmetics-labeling/cosmetics-labeling-regulations',
};

const forbiddenIngredients = {
  title: '《化妆品安全技术规范（2026年版）》禁用原料目录',
  organization: '国家药品监督管理局',
  url: 'https://www.nmpa.gov.cn/directory/web/nmpa/images/1773890896545014230.pdf',
};

const usmaAnimalStudy = {
  title: '《乌斯玛草对脱毛小鼠模型毛发生长的影响》',
  organization: '《职业与健康》2025年第41卷第9期',
  url: 'https://www.zyyjk.com.cn/CN/Y2025/V41/I9/1173',
};

const bimatoprostTrial = {
  title: 'Bimatoprost for Eyelash Growth in Japanese Subjects: Two Multicenter Controlled Studies',
  organization: 'PubMed Central',
  url: 'https://pmc.ncbi.nlm.nih.gov/articles/PMC4003339/',
};

const rules: EvidenceRule[] = [
  {
    pattern: /FDA\s*(?:认证|批准|认可)|(?:通过|获得)\s*FDA/gi,
    signal: '“FDA认证/批准”化妆品表述',
    status: 'conflict',
    conclusion: 'FDA明确说明一般化妆品及其成分不经过上市前批准（着色剂除外），该表述需要重点核验。',
    source: fdaCosmetics,
  },
  {
    pattern: /(?:根治|治愈|治好|治疗|治脱发|消炎|杀菌|抗炎|药到病除|永久告别|彻底祛除|催熟.{0,6}(?:脓包|疙瘩))|(?:头皮屑|脱发).{0,16}(?:治好|整好|好了|解决(?:了|掉)|消失)/gi,
    signal: '疾病治疗或医疗作用表达',
    status: 'conflict',
    conclusion: '非医疗、药品和医疗器械广告不得涉及疾病治疗功能，也不得使用容易与药品或医疗器械混淆的用语。',
    source: advertisingLaw,
  },
  {
    pattern: /(?:乌斯玛草|奥斯曼草).{0,40}(?:睫毛|眉毛|毛发|生长|增长|浓密)|(?:睫毛|眉毛|毛发).{0,40}(?:乌斯玛草|奥斯曼草)/gi,
    signal: '乌斯玛草的人体功效证据不足',
    status: 'needs_source',
    kind: '动物研究',
    strength: '有限',
    conclusion: '检索到的直接研究为脱毛小鼠模型，不能替代眼睑部位的人体对照试验，也不足以证明具体产品能让睫毛明显增长。',
    scope: '只能说明存在早期动物研究线索，不能证明人体有效、起效时间或长期效果。',
    source: usmaAnimalStudy,
  },
  {
    pattern: /(?:睫毛|眉毛|发际线).{0,16}(?:生长|增长|长长|变长|浓密)|(?:生发|育发|养头发|长睫毛)/gi,
    signal: '毛发生长或育发功效宣称',
    status: 'needs_source',
    kind: '法规依据',
    strength: '明确',
    conclusion: '毛发生长属于需要实证支持的强功效宣称；仅凭个人体验、前后照片或标题话术不能证明产品具有该效果。',
    scope: '支持对“宣称依据是否充分”的判断，不直接认定商品是假货或产品一定无效。',
    source: cosmeticsRegulation,
  },
  {
    pattern: /(?:睫毛增长液|睫毛生长液|长睫毛液)/gi,
    signal: '有效药物证据不能外推到普通产品',
    status: 'context',
    kind: '人体研究',
    strength: '中等',
    conclusion: '比马前列素0.03%具有随机对照人体研究支持的睫毛增长作用，但该证据仅适用于特定药物、浓度和用法，不能外推到名称相似的普通睫毛精华。',
    scope: '不能据此推定当前产品含比马前列素，也不能证明当前产品有效。',
    source: bimatoprostTrial,
  },
  {
    pattern: /(?:睫毛增长液|睫毛生长液|长睫毛液|比马前列素|拉坦前列素|他氟前列素|曲伏前列素)/gi,
    signal: '前列腺素类似物需要核对成分',
    status: 'context',
    kind: '法规依据',
    strength: '明确',
    conclusion: '现行化妆品禁用原料目录列有比马前列素、拉坦前列素、他氟前列素和曲伏前列素等成分。判断产品是否违规必须核对成分表或检测结果。',
    scope: '只提示核验方向；没有成分表或实验室检测时，不得声称该产品实际添加了违禁成分。',
    source: forbiddenIngredients,
  },
  {
    pattern: /(?:停用|不用).{0,12}(?:不会|不再|无需).{0,12}(?:变回|恢复|种睫毛)|永久.{0,12}(?:生长|浓密|改变|保持)/gi,
    signal: '永久效果或替代美容手段承诺',
    status: 'needs_source',
    conclusion: '永久性改变或替代美容手段属于强效果承诺，需要与产品注册备案资料及功效评价依据相符。',
    source: cosmeticsRegulation,
  },
  {
    pattern: /(?:\d+\s*(?:天|日|周|次)).{0,18}(?:美白|焕白|淡斑|祛痘|修复|抗老|淡纹|提拉|紧致)|(?:一个色号|\d+\s*(?:倍|%|％)).{0,12}(?:白|提升|改善|减少)/gi,
    signal: '时限或量化功效宣称',
    status: 'needs_source',
    conclusion: '量化或明确周期的功效结论应能对应产品功效评价试验、研究数据或文献依据，不能仅由体验叙述推出。',
    source: nmpaEvaluation,
  },
  {
    pattern: /(?:美白|祛斑|防脱|祛痘|抗皱|抗老|紧致|修护|舒缓|控油|去屑|防晒|去黑头|去粉刺|去角质)/gi,
    signal: '化妆品功效宣称',
    status: 'context',
    conclusion: '化妆品功效宣称应有充分科学依据，并公开相应文献、研究数据或功效评价资料摘要。',
    source: cosmeticsRegulation,
  },
  {
    pattern: /(?:最有效|神器|橡皮擦|彻底清除|彻底去除|一擦就没|清零)/gi,
    signal: '绝对化或夸大效果表述',
    status: 'context',
    conclusion: '该表述容易放大消费者对实际效果的预期，应与产品能够达到的真实效果保持一致。',
    source: advertisingLaw,
  },
  {
    pattern: /(?:晚晚同款|明星同款|日本很流行|京都艺妓|IKKO|美容师.{0,8}(?:推荐|介绍))/gi,
    signal: '人物或境外背书信息',
    status: 'context',
    conclusion: '“同款”、人物推荐或境外流行信息需要能够核实，不能以无法验证的背书误导消费者。',
    source: advertisingLaw,
  },
  {
    pattern: /(?:天然美容|天然的?蛋白质|纯天然|全天然)/gi,
    signal: '“天然”来源或成分表述',
    status: 'context',
    conclusion: '“天然”本身并非当然违法，但相关原料来源和成分描述应当真实、准确且可验证。',
    source: advertisingLaw,
  },
  {
    pattern: /(?:毛孔深处|深层).{0,12}(?:污垢|清洁|带走)/gi,
    signal: '深层清洁效果表述',
    status: 'context',
    conclusion: '物理清洁产品的效果描述不应超出其实际作用，也应结合使用频率和皮肤耐受情况。',
    source: cosmeticsRegulation,
  },
  {
    pattern: /(?:100%|百分之百|零副作用|绝对安全|保证有效|人人适用|所有肤质)/gi,
    signal: '绝对化安全或效果保证',
    status: 'needs_source',
    conclusion: '绝对化效果或安全保证超出一般体验证据能够支持的范围，应核对评价条件、样本和适用人群。',
    source: nmpaEvaluation,
  },
  {
    pattern: /(?:核心成分|专利成分|同款成分|原料).{0,24}(?:所以|因此|等于|实现|证明|能够)/gi,
    signal: '由原料功效推导产品功效',
    status: 'context',
    conclusion: '原料研究不能自动替代成品在正常使用条件下的功效评价，需核对配方浓度、剂型和产品试验。',
    source: nmpaEvaluation,
  },
];

export function evaluateEvidence(value: string) {
  const text = value.slice(0, 24000);
  const findings: EvidenceCheck[] = [];
  const seen = new Set<string>();
  for (const rule of rules) {
    rule.pattern.lastIndex = 0;
    const match = rule.pattern.exec(text);
    if (!match || seen.has(rule.signal)) continue;
    seen.add(rule.signal);
    const lineStart = Math.max(0, text.lastIndexOf('\n', match.index) + 1);
    const nextLine = text.indexOf('\n', match.index + match[0].length);
    const lineEnd = nextLine < 0 ? text.length : nextLine;
    const rawLine = text.slice(lineStart, lineEnd).replace(/\s+/g, ' ').trim();
    const excerptOffset = Math.max(0, match.index - lineStart - 34);
    const rawExcerpt = rawLine.length <= 120 ? rawLine : rawLine.slice(excerptOffset, excerptOffset + 116);
    const cleanedExcerpt = rawExcerpt
      .replace(/#?([^#\n]{1,50})\[话题\]#/g, '$1 ')
      .replace(/\[[^\]]{1,10}R\]/g, '')
      .replace(/#+/g, ' ')
      .replace(/\s+/g, ' ')
      .trim();
    const excerpt = `${cleanedExcerpt}${rawLine.length > 120 ? '…' : ''}`;
    findings.push({
      signal: rule.signal,
      excerpt,
      status: rule.status,
      kind: rule.kind ?? (rule.status === 'conflict' ? '法规依据' : '核验提示'),
      strength: rule.strength ?? (rule.status === 'conflict' ? '明确' : rule.status === 'needs_source' ? '中等' : '有限'),
      conclusion: rule.conclusion,
      scope: rule.scope ?? '用于说明该宣传需要进一步核验，不单独构成产品真伪、违法或安全性的最终认定。',
      source: rule.source,
    });
    if (findings.length >= 8) break;
  }
  return findings;
}
