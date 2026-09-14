export const KB_VERSION = '2026-09-14.1';
export type Evidence = { id: string; title: string; section: string; url: string; version: string; text: string; terms: string[]; kind?: 'regulation'|'regulatory-guidance'|'ingredient-reference'; jurisdiction?:string; limitation?:string; reviewedAt?:string };
export const evidence: Evidence[] = [
  { id: 'CN-43', title: '化妆品监督管理条例', section: '第43条', version: '2021-01-01施行；2026-09-06核阅', url: 'https://www.miit.gov.cn/threestrategy/zcgh/zcfg/art/2020/art_3b697f6533524bb0af6c79588bcc3875.html', text: '化妆品广告应真实合法，不得明示或暗示医疗作用，亦不得欺骗或误导消费者。本条用于审视宣传，不是商品真伪或化学成分检测结论。', terms: ['治疗','治好','脱发','脓包','杀菌','药','硫磺','湿疹','医疗'] },
  { id: 'CN-EFFICACY', title: '化妆品功效宣称评价规范', section: '第3、7条及功效评价要求', version: '2021年第50号；2026-09-06核阅', url: 'https://mpa.yn.gov.cn/zfxxgk/zcwj/qtwj/gjwj/202112/t20211222_1224866.html', text: '功效评价可以包含文献资料、研究数据及评价试验。仅通过清洁等感官直接识别的效果，以及明确标示仅物理作用的去角质、去黑头，可适用摘要公布豁免。未在推荐帖附研究，不等同于产品无效或造假；原料用途不等于成品功效证据。', terms: ['保湿','清洁','黑头','蚕茧','角质','睫毛','生长','乌斯玛','修护','美白','永久','三周','3周','功效','甘油','烟酰胺'] },
  { id: 'CN-CONTEXT', title: '广告绝对化用语执法指南答记者问', section: '结合广告内容与具体语境判断', version: '2023；2026-09-06核阅', url: 'https://www.samr.gov.cn/zw/zfxxgk/fdzdgknr/xwxcs/art/2023/art_c1ecaa66e3fa48beaed113e1627cd463.html', text: '监管判断需结合广告内容、具体语境与事实，不能只匹配词语。分析时区分推荐者肯定宣称、否定、辟谣、引述和评论者问题；仅出现天然、神器、同款等词，不足以认定虚假或违法。', terms: ['天然','神器','最好','最有效','最','不是','不能','不可能','辟谣','不要','骗局','同款'] },
  { id: 'CN-AD11', title: '中华人民共和国广告法', section: '第11、17条', version: '2021修正；2026-09-06核阅', url: 'https://www.samr.gov.cn/zw/zfxxgk/fdzdgknr/fgs/art/2023/art_5474cf75173c45d6a0379730fb4e8d97.html', text: '广告中使用数据、统计、文摘、引用语等，应真实准确并注明出处。医疗、药品、医疗器械以外的广告不得涉及疾病治疗。普通香皂等日用品的治疗宣称也应根据广告法判断，不可未经确认把产品类别当作化妆品。仅见同款、名人姓名或外国地名不能证明虚假背书；应核对确切引述及来源。', terms: ['同款','日本','艺妓','IKKO','晚晚','权威','临床','%','百分','数据','专家','治疗','香皂','硫磺皂','药膏','脱发','湿疹','治好'] },
  { id: 'EU-COSING', title: '欧盟委员会 CosIng 数据库说明', section: '数据库性质与使用边界', version: '2026-09-06核阅', url: 'https://single-market-economy.ec.europa.eu/sectors/cosmetics/cosmetic-ingredient-database_en', text: 'CosIng提供化妆品原料命名等信息，信息用途不等于对某成分使用的批准。不能把成分被收录、单一原料用途或天然来源，当作成品安全、有效或适合所有人的证明。完整配方、浓度、使用方式和产品评价仍然重要。', terms: ['成分','INCI','安全','天然','敏感','配方','浓度','硅油','烟酰胺','甘油','玻尿酸'] },
];
evidence.push(
 {id:'CN-LASH',title:'警惕宣称“促进睫毛生长”的睫毛液',section:'国家药监局科普：物理修饰与生长功效',version:'2021-09-16发布；2026-09-14核阅',url:'https://yjj.sh.gov.cn/yzaq/20210916/2686844fa55f477e828b732ad3763e27.html',text:'该监管科普区分成膜、着色带来的纤长浓密外观，与促进睫毛生长。文中按发布当时的分类和审批情况提示生长宣称风险。不能据此推断某产品含药、未备案或为假货，也不能把2021年的审批状况说成今天已查询的结果。',terms:['睫毛','乌斯玛','增长液','比马前列素'],kind:'regulatory-guidance',jurisdiction:'中国',reviewedAt:'2026-09-14',limitation:'历史监管科普；不是当前产品审批查询或成分检测。'},
 {id:'CN-LABEL',title:'化妆品标签管理办法',section:'第12条：全成分与微量成分标注',version:'2021年第77号；2022-05-01施行；2026-09-14核阅',url:'https://amr.hainan.gov.cn/himpa/HICDME/zcfg/hzp/202406/t20240603_3673883.html',text:'在中国境内生产经营的化妆品，标签应以标准中文名称列全成分并按含量降序排列；不超过0.1%的成分以其他微量成分另列，可不按含量降序。不能由成分排序推算准确浓度，也不能把一张局部截图当作完整标签。',terms:['成分','配方','浓度','排序','微量','含量','0.1','标签','百分'],kind:'regulation',jurisdiction:'中国',reviewedAt:'2026-09-14',limitation:'标签规范不提供成品含量实测结果。'},
 {id:'CN-RAW-EFFICACY',title:'化妆品功效宣称评价规范',section:'第9、11条：量化指标和原料功效关联',version:'2021年第50号；2026-09-14核阅',url:'https://mpa.yn.gov.cn/zfxxgk/zcwj/qtwj/gjwj/202112/t20211222_1224866.html',text:'涉及具体量化指标（时间、统计数据等）的功效宣称，应按规范开展评价试验。以原料功效宣称产品功效，需要证实原料具有相应功效，且与产品宣称有充分关联。推荐帖未展示试验不等于试验不存在；不能仅靠某成分存在就确认成品的量化效果。',terms:['天','周','小时','%','百分','永久','修护','美白','烟酰胺','原料','玻尿酸'],kind:'regulation',jurisdiction:'中国',reviewedAt:'2026-09-14',limitation:'评价要求，不是任何具体产品的试验报告。'}
);
for(const item of evidence){item.kind??=item.id==='EU-COSING'?'ingredient-reference':item.id==='CN-CONTEXT'?'regulatory-guidance':'regulation';item.jurisdiction??=item.id==='EU-COSING'?'欧盟（仅作原料信息参考）':'中国';item.reviewedAt??='2026-09-06';item.limitation??='通用资料；不证明当前产品真伪、成品功效或具体批次安全。';}
export const ingredientSource = { title: '欧盟化妆品成分命名词汇表（2025/1175）', url: 'https://eur-lex.europa.eu/eli/dec_impl/2025/1175/oj/eng', version: '2025/1175' };
// General formulation roles are manually curated, not safety scores or proof of product efficacy.
const rows = [
  ['水','AQUA','溶剂','纯水'], ['甘油','GLYCERIN','保湿剂','丙三醇'],
  ['丁二醇','BUTYLENE GLYCOL','保湿剂、溶剂',''], ['丙二醇','PROPYLENE GLYCOL','保湿剂、溶剂',''],
  ['1,3-丙二醇','PROPANEDIOL','保湿剂、溶剂',''], ['透明质酸钠','SODIUM HYALURONATE','保湿剂','玻尿酸钠'],
  ['透明质酸','HYALURONIC ACID','保湿剂','玻尿酸'], ['烟酰胺','NIACINAMIDE','皮肤调理剂','尼克酰胺'],
  ['泛醇','PANTHENOL','皮肤/毛发调理剂','维生素原B5'], ['尿囊素','ALLANTOIN','皮肤调理剂',''],
  ['甜菜碱','BETAINE','保湿剂',''], ['尿素','UREA','保湿剂',''], ['角鲨烷','SQUALANE','润肤剂',''],
  ['聚二甲基硅氧烷','DIMETHICONE','润肤剂、皮肤保护剂','二甲基硅油'], ['环五聚二甲基硅氧烷','CYCLOPENTASILOXANE','润肤剂、溶剂','D5'],
  ['神经酰胺NP','CERAMIDE NP','皮肤调理剂','神经酰胺 NP'], ['胆甾醇','CHOLESTEROL','皮肤调理剂、乳化辅助剂','胆固醇'],
  ['生育酚','TOCOPHEROL','抗氧化剂','维生素E'], ['生育酚乙酸酯','TOCOPHERYL ACETATE','皮肤调理剂','醋酸维生素E'],
  ['抗坏血酸','ASCORBIC ACID','抗氧化剂','维生素C'], ['视黄醇','RETINOL','皮肤调理剂','维生素A醇'],
  ['水杨酸','SALICYLIC ACID','皮肤调理剂',''], ['乳酸','LACTIC ACID','pH调节剂、保湿剂',''], ['柠檬酸','CITRIC ACID','pH调节剂',''],
  ['苯氧乙醇','PHENOXYETHANOL','防腐剂',''], ['乙基己基甘油','ETHYLHEXYLGLYCERIN','皮肤调理剂',''],
  ['卡波姆','CARBOMER','增稠剂',''], ['黄原胶','XANTHAN GUM','增稠剂、稳定剂',''],
  ['氧化锌','ZINC OXIDE','着色剂；符合适用条件时可作紫外线吸收剂',''], ['二氧化钛','TITANIUM DIOXIDE','着色剂；符合适用条件时可作紫外线吸收剂','钛白粉'],
];
export const ingredients = rows.map(([cn, inci, purpose, aliases], i) => ({ id: `INCI-${i+1}`, cn, inci, purpose, aliases: aliases ? aliases.split('|') : [], source: ingredientSource }));
export function findIngredients(text: string) {
  const matches: {start:number;end:number;item:typeof ingredients[number];quote:string}[]=[];
  for(const item of ingredients)for(const alias of [item.cn,item.inci,...item.aliases]){
    if(alias==='水')continue;
    const escape=(s:string)=>s.replace(/[.*+?^${}()|[\]\\]/g,'\\$&');
    const pattern=/[\u4e00-\u9fff]/.test(alias)?Array.from(alias).map(escape).join('[ \\t]*'):escape(alias).replace(/ /g,'[ \\t]+');
    const match=new RegExp(pattern,'i').exec(text);if(!match)continue;
    const start=match.index,end=start+match[0].length;
    if(/^[a-z0-9 ]+$/i.test(alias)&&(/[a-z]/i.test(text[start-1]??'')||/[a-z]/i.test(text[end]??'')))continue;
    matches.push({start,end,item,quote:match[0]});
  }
  const water=/(?:^|[，,：:\s])水(?=[，,。\s]|$)/.exec(text);
  if(water){const start=water.index+water[0].length-1;matches.push({start,end:start+1,item:ingredients[0],quote:'水'});}
  const accepted:typeof matches=[];
  for(const m of matches.sort((a,b)=>(b.end-b.start)-(a.end-a.start)))if(!accepted.some(x=>x.item.id===m.item.id||m.start<x.end&&m.end>x.start))accepted.push(m);
  return accepted.sort((a,b)=>a.start-b.start).map(({item,quote})=>({...item,quote}));
}
export function evidenceScore(item:Evidence,text:string){const q=text.toLowerCase().replace(/[ \t]/g,'');return item.terms.reduce((n,t)=>n+(q.includes(t.toLowerCase())?Math.min(t.length,5):0),0);}
export function retrieve(text:string):Evidence[]{
 const ranked=evidence.map(item=>({item,score:evidenceScore(item,text)})).filter(x=>x.score>0).sort((a,b)=>b.score-a.score);
 const chosen:Evidence[]=[];
 const add=(id:string)=>{const hit=ranked.find(x=>x.item.id===id);if(hit&&!chosen.some(x=>x.id===id)&&chosen.length<4)chosen.push(hit.item);};
 // Reserve evidence for distinct high-consequence questions before general popularity ranking.
 if(/治疗|治好|脱发|湿疹|药膏/.test(text))add('CN-AD11');
 if(/睫毛|乌斯玛|增长液/.test(text))add('CN-LASH');
 if(/辟谣|不要相信|并不能|不代表|不能治疗|天然|神器|同款/.test(text))add('CN-CONTEXT');
 if(/成分|微量|浓度|排序|标签/.test(text))add('CN-LABEL');
 for(const sentence of text.split(/[。！？\n]/).filter(s=>s.trim().length>4).slice(0,20)){
  const best=ranked.map(x=>({...x,local:evidenceScore(x.item,sentence)})).sort((a,b)=>b.local-a.local)[0];if(best?.local)add(best.item.id);
 }
 for(const row of ranked)add(row.item.id);
 return chosen;
}
