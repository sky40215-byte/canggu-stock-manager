const clean = (value, limit) => typeof value === 'string' ? value.trim().slice(0, limit) : '';
const normalized = (value) => String(value || '').normalize('NFKC').replace(/臺/g, '台').replace(/\s+/gu, ' ').trim();
const escapedRegExp = (value) => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const permittedImpacts = new Set(['可能受惠', '可能承壓', '雙向影響']);
const ambiguousShortNames = new Set([
  '世界', '全球', '聯合', '遠東', '工業', '台灣', '中央', '新興', '中華', '大成', '大同',
  '大量', '南亞', '亞太', '大中', '東方', '大洋', '國際', '中美', '中日', '台北',
  '三星', '光罩', '晶片', '統一'
]);

export function companyProfiles(payload, market) {
  if (!Array.isArray(payload)) return [];
  return payload.flatMap((item) => {
    const code = normalized(item['公司代號'] ?? item.SecuritiesCompanyCode);
    const name = normalized(item['公司簡稱'] ?? item.CompanyAbbreviation);
    if (!/^[1-9]\d{3}$/.test(code) || !name) return [];
    const legalName = normalized(item['公司名稱'] ?? item.CompanyName);
    return [{
      code, name, market, industryCode: normalized(item['產業別'] ?? item.SecuritiesIndustryCode).padStart(2, '0'),
      aliases: [legalName, legalName.replace(/股份有限公司$/u, ''), item['英文簡稱'] ?? item.Symbol].map(normalized).filter(Boolean)
    }];
  });
}

function aliasMatcher(value, code) {
  if (ambiguousShortNames.has(value)) {
    const labeled = new RegExp(`${escapedRegExp(value)}\\s*\\(${code}\\)`, 'u');
    return (text) => labeled.test(text);
  }
  if (/^[\p{L}\d* -]+$/u.test(value) && /\p{Script=Han}/u.test(value) && value.length >= 2) {
    return (text) => text.includes(value);
  }
  if (!/^[a-zA-Z][a-zA-Z0-9 .&-]{2,54}$/.test(value)) return null;
  const pattern = new RegExp(`(?<![a-zA-Z0-9])${escapedRegExp(value)}(?![a-zA-Z0-9])`, /^[A-Z0-9]{3,}$/.test(value) ? '' : 'i');
  return (text) => pattern.test(text);
}

export function findCompanyMentions(headlines, companies) {
  const aliases = new Map();
  for (const company of companies) {
    for (const value of [company.name, ...(company.aliases || [])]) {
      const alias = normalized(value).replace(/[-‐]KY$/i, '');
      const key = alias.toUpperCase();
      if (aliases.has(key) && aliases.get(key)?.company.code !== company.code) {
        aliases.set(key, null);
      } else if (!aliases.has(key)) {
        const matches = aliasMatcher(alias, company.code);
        if (matches) aliases.set(key, { company, matches });
      }
    }
  }
  const evidence = new Map();
  for (const [index, item] of headlines.entries()) {
    const text = normalized(item.title);
    const suffix = ' - ' + normalized(item.source);
    const title = item.source && text.endsWith(suffix) ? text.slice(0, -suffix.length) : text;
    const matched = new Set();
    for (const entry of aliases.values()) {
      if (entry?.matches(title)) matched.add(entry.company.code);
    }
    for (const code of matched) {
      const mentions = evidence.get(code) || [];
      mentions.push(`N${index + 1}`);
      evidence.set(code, mentions);
    }
  }
  return new Map([...evidence].sort(([, a], [, b]) => b.length - a.length));
}

export function researchModelContext(query, sources, eventSourceIds, companies, provider) {
  const compact = provider === 'ollama';
  const availableSources = compact ? sources.slice(0, 14).map((item) => ({
    id: item.id, type: item.type, title: clean(item.title, 130), date: clean(item.date, 60),
    summary: clean(item.summary, 160), source: clean(item.source, 45),
    ...(item.type === 'financial' && { value: item.value, unit: clean(item.unit, 20) })
  })) : sources;
  const sourceIds = new Set(availableSources.filter((item) => eventSourceIds.has(item.id)).map((item) => item.id));
  const context = {
    ...query, sources: availableSources, eventCitationIds: [...sourceIds],
    availableTaiwanStocks: companies.slice(0, compact ? 140 : 250).map(({ code, name }) => ({ code, name: clean(name, 48) }))
  };
  let contents = JSON.stringify(context);
  if (compact) {
    while ((contents.length > 17000 || Buffer.byteLength(contents, 'utf8') > 33000) && context.availableTaiwanStocks.length) {
      context.availableTaiwanStocks.splice(-20);
      contents = JSON.stringify(context);
    }
  }
  return { contents, sourceIds, codes: new Set(context.availableTaiwanStocks.map(({ code }) => code)) };
}

export function eventCandidates({ modelStocks = [], modelCodes = new Set(), eventSourceIds, modelSourceIds = eventSourceIds, mentions, headlines, companies, limit = 8 }) {
  const candidates = new Map();
  for (const item of Array.isArray(modelStocks) ? modelStocks : []) {
    const code = String(item?.code || '').trim();
    if (!modelCodes.has(code) || !companies.has(code) || candidates.has(code)) continue;
    const evidence = [...new Set((Array.isArray(item.evidence) ? item.evidence : []).map(String).filter((id) => modelSourceIds.has(id)))].slice(0, 4);
    const reason = clean(item.reason, 500);
    const explicitlyNamed = (mentions.get(code) || []).some((id) => evidence.includes(id));
    const mechanism = clean(item.mechanism, 240);
    if (!evidence.length || !reason || (!explicitlyNamed && !mechanism)) continue;
    candidates.set(code, {
      code, evidence, connection: explicitlyNamed ? 'mention' : 'inference', reason,
      industry: clean(item.industry, 100), fact: clean(item.fact, 240), mechanism,
      uncertainty: clean(item.uncertainty, 220), impact: permittedImpacts.has(item.impact) ? item.impact : '方向未定',
      horizon: ['短期','中期','長期'].includes(item.horizon) ? item.horizon : ''
    });
  }
  const direct = [];
  for (const [code, rows] of mentions) {
    const refs = rows.filter((id) => eventSourceIds.has(id)).slice(0, 4);
    if (!refs.length || !companies.has(code)) continue;
    const existing = candidates.get(code);
    if (existing?.connection === 'mention') direct.push(existing);
    else {
      const source = headlines[Number(refs[0].slice(1)) - 1];
      direct.push({
        code, connection: 'mention', evidence: [...new Set([...refs, ...(existing?.evidence || [])])].slice(0, 4), impact: existing?.impact || '方向未定',
        fact: clean(source?.title, 240), reason: existing?.reason || '本次搜尋到的報導提及這家公司，可由原文核對是否涉及供應、客戶或競爭關係。',
        mechanism: existing?.mechanism || '', uncertainty: existing?.uncertainty || '新聞提及本身無法確認對營收或股價的影響。',
        industry: existing?.industry || '', horizon: existing?.horizon || ''
      });
    }
  }
  return [...direct, ...[...candidates.values()].filter((item) => !mentions.has(item.code))].slice(0, limit);
}
