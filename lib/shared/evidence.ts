export type EvidenceCheck = {
  signal: string;
  status: 'conflict' | 'needs_source' | 'context';
  conclusion: string;
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
  conclusion: string;
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

const rules: EvidenceRule[] = [
  {
    pattern: /FDA\s*(?:认证|批准|认可)|(?:通过|获得)\s*FDA/gi,
    signal: '“FDA认证/批准”化妆品表述',
    status: 'conflict',
    conclusion: 'FDA明确说明一般化妆品及其成分不经过上市前批准（着色剂除外），该表述需要重点核验。',
    source: fdaCosmetics,
  },
  {
    pattern: /(?:根治|治愈|治疗|消炎|杀菌|抗炎|药到病除|永久告别|彻底祛除)/gi,
    signal: '疾病治疗或医疗作用表达',
    status: 'conflict',
    conclusion: '非医疗、药品和医疗器械广告不得涉及疾病治疗功能，也不得使用容易与药品或医疗器械混淆的用语。',
    source: advertisingLaw,
  },
  {
    pattern: /(?:\d+\s*(?:天|日|周|次)).{0,18}(?:美白|焕白|淡斑|祛痘|修复|抗老|淡纹|提拉|紧致)|(?:一个色号|\d+\s*(?:倍|%|％)).{0,12}(?:白|提升|改善|减少)/gi,
    signal: '时限或量化功效宣称',
    status: 'needs_source',
    conclusion: '量化或明确周期的功效结论应能对应产品功效评价试验、研究数据或文献依据，不能仅由体验叙述推出。',
    source: nmpaEvaluation,
  },
  {
    pattern: /(?:美白|祛斑|防脱|祛痘|抗皱|抗老|紧致|修护|舒缓|控油|去屑|防晒)/gi,
    signal: '化妆品功效宣称',
    status: 'needs_source',
    conclusion: '化妆品功效宣称应有充分科学依据，并公开相应文献、研究数据或功效评价资料摘要。',
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
    if (!rule.pattern.test(text) || seen.has(rule.signal)) continue;
    seen.add(rule.signal);
    findings.push({
      signal: rule.signal,
      status: rule.status,
      conclusion: rule.conclusion,
      source: rule.source,
    });
    if (findings.length >= 8) break;
  }
  return findings;
}
