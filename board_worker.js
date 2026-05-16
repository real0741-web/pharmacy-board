// =====================================================
//  약품 공유 게시판 · Cloudflare Worker
//  역할: AI 약품 분석 + 식약처 DB + 네이버 검색 + 페이지 스크래핑
//
//  환경변수 (Worker Settings → Variables and Secrets):
//    CLAUDE_API_KEY      : Anthropic Claude API 키  (Secret) ← 필수
//    GROQ_API_KEY        : Groq API 키 (선택, Claude 폴백)   (Secret)
//    MFDS_API_KEY        : 식약처 공공데이터 API 키           (Secret) ← 강력 추천
//    NAVER_CLIENT_ID     : 네이버 검색 API Client ID          (Secret)
//    NAVER_CLIENT_SECRET : 네이버 검색 API Client Secret      (Secret)
//
//  바인딩 (선택):
//    AI (Workers AI) : 변수명 "AI" — 최후 AI 폴백용
//
//  배포 후:
//    배포된 URL을 index.html 의 WORKER_URL 상수에 입력하세요
// =====================================================

const CF_GW = 'https://gateway.ai.cloudflare.com/v1/15d3707140adc61d105c690ee0b432ee/pharmacy-gateway';

const corsHeaders = {
  'Access-Control-Allow-Origin':  '*',
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type',
};

// ── 텍스트 정리 헬퍼 ─────────────────────────────────────────
const strip = s => (s||'').replace(/<[^>]+>/g,'').replace(/&amp;/g,'&').replace(/&lt;/g,'<').replace(/&gt;/g,'>').replace(/&quot;/g,'"').trim();

function stripDrugSuffix(name) {
  return name.replace(/\s+/g,'').toLowerCase()
    .replace(/(정제|연질캡슐|경질캡슐|캡슐|연질|과립|시럽|액|크림|겔|패치|좌제|산|정)$/g,'')
    .replace(/\d+(mg|ml|g|mcg|iu)$/gi,'').trim();
}

function nameMatchScore(searched, found) {
  if (!searched || !found) return 0;
  const a = searched.toLowerCase().replace(/\s+/g,'');
  const b = found.toLowerCase().replace(/\s+/g,'');
  if (a === b) return 1.0;
  if (b.includes(a) || a.includes(b)) return 0.9;
  const as = stripDrugSuffix(a), bs = stripDrugSuffix(b);
  if (as && bs) {
    if (as === bs) return 0.95;
    if (bs.includes(as) || as.includes(bs)) return 0.85;
  }
  const core = as || a;
  const pl = Math.min(4, Math.floor(core.length * 0.6));
  if (pl >= 2 && (bs||b).startsWith(core.slice(0,pl))) return 0.7;
  return 0;
}

// ── AI 호출 헬퍼 (Claude → Groq → Workers AI 폴백) ──────────
async function callAI(ai, messages, maxTokens, env) {
  maxTokens = maxTokens || 600;
  const anthropicKey = env && (env.CLAUDE_API_KEY || env.ANTHROPIC_API_KEY);
  if (anthropicKey) {
    try {
      const res = await fetch(CF_GW + '/anthropic/v1/messages', {
        method: 'POST',
        headers: { 'x-api-key': anthropicKey, 'anthropic-version': '2023-06-01', 'content-type': 'application/json' },
        body: JSON.stringify({ model: 'claude-haiku-4-5-20251001', max_tokens: maxTokens, messages }),
        signal: AbortSignal.timeout(25000),
      });
      if (!res.ok) throw new Error('Anthropic ' + res.status);
      const data = await res.json();
      const text = data && data.content && data.content[0] && data.content[0].text && data.content[0].text.trim();
      if (text) return text;
    } catch(e) { console.error('Claude 실패:', e.message); }
  }

  const groqKey = env && env.GROQ_API_KEY;
  if (groqKey) {
    try {
      const res = await fetch(CF_GW + '/groq/openai/v1/chat/completions', {
        method: 'POST',
        headers: { 'Authorization': 'Bearer ' + groqKey, 'Content-Type': 'application/json' },
        body: JSON.stringify({ model: 'llama-3.3-70b-versatile', max_tokens: maxTokens, messages, temperature: 0.4 }),
        signal: AbortSignal.timeout(20000),
      });
      if (!res.ok) throw new Error('Groq ' + res.status);
      const data = await res.json();
      const text = data && data.choices && data.choices[0] && data.choices[0].message && data.choices[0].message.content && data.choices[0].message.content.trim();
      if (text) return text;
    } catch(e) { console.error('Groq 실패:', e.message); }
  }

  if (!ai) throw new Error('AI 불가. CLAUDE_API_KEY를 설정해주세요.');
  const res = await ai.run('@cf/meta/llama-3.3-70b-instruct-fp8-fast', { messages, max_tokens: maxTokens });
  const text = (res && res.response || '').trim();
  if (text) return text;
  throw new Error('AI 응답 없음');
}

// ── 식약처 3종 DB 검색 (e약은요 + 허가정보 + 건강기능식품) ──
async function searchMFDS(drugName, mfdsKey) {
  if (!mfdsKey || !drugName) return null;
  let key = mfdsKey;
  try { key = decodeURIComponent(mfdsKey); } catch(_) {}
  const enc = encodeURIComponent;

  const simpleName = drugName.replace(/\s*(정|캡슐|mg|ml|g)\b.*/i,'').trim();
  const names = [drugName];
  if (simpleName && simpleName !== drugName && simpleName.length >= 2) names.push(simpleName);

  for (const name of names) {
    const [r1, r2, r3] = await Promise.allSettled([
      fetch('https://apis.data.go.kr/1471000/DrbEasyDrugInfoService/getDrbEasyDrugList?serviceKey=' + enc(key) + '&itemName=' + enc(name) + '&type=json&numOfRows=5', { signal: AbortSignal.timeout(7000) }).then(r => r.json()),
      fetch('https://apis.data.go.kr/1471000/DrugPrdtPrmsnInfoService05/getDrugPrdtPrmsnDtlInq05?serviceKey=' + enc(key) + '&type=json&numOfRows=5&ITEM_NAME=' + enc(name), { signal: AbortSignal.timeout(7000) }).then(r => r.json()),
      fetch('https://apis.data.go.kr/1471000/HtfsInfoService01/getHtfsItem01?serviceKey=' + enc(key) + '&PRDLST_NM=' + enc(name) + '&type=json&numOfRows=5', { signal: AbortSignal.timeout(7000) }).then(r => r.json()),
    ]);

    const easy = r1.status === 'fulfilled' ? (r1.value && r1.value.body && r1.value.body.items || []) : [];
    const full = r2.status === 'fulfilled' ? (r2.value && r2.value.body && r2.value.body.items || []) : [];
    const htfs = r3.status === 'fulfilled' ? (r3.value && r3.value.body && r3.value.body.items || []) : [];

    const be = easy.find(i => nameMatchScore(drugName, i.itemName||'') >= 0.85);
    if (be) return { name: be.itemName||drugName, efcy: strip(be.efcyQesitm||'').slice(0,500), use: strip(be.useMethodQesitm||'').slice(0,400), warn: strip(be.atpnQesitm||be.atpnWarnQesitm||'').slice(0,300), ingr: strip(be.nbIngredQesitm||'').slice(0,200), image: be.itemImage||'', dbType: 'e약은요' };

    const bf = full.find(i => nameMatchScore(drugName, i.ITEM_NAME||'') >= 0.85);
    if (bf) return { name: bf.ITEM_NAME||drugName, efcy: strip(bf.EE_DOC_DATA||'').slice(0,500), use: strip(bf.UD_DOC_DATA||'').slice(0,400), warn: strip(bf.NB_DOC_DATA||'').slice(0,300), ingr: strip(bf.MAIN_INGR||'').slice(0,200), image: bf.BIG_PRDT_IMG_URL||'', dbType: '허가정보' };

    const bh = htfs.find(i => nameMatchScore(drugName, i.PRDLST_NM||'') >= 0.85);
    if (bh) return { name: bh.PRDLST_NM||drugName, efcy: strip(bh.IFTKN_ATNT_MATR_CN||'').slice(0,500), use: strip(bh.TAKE_METHOD_CN||'').slice(0,400), warn: strip(bh.CAUTION_CN||'').slice(0,300), ingr: strip(bh.NTR_MTRAL_CNTNT||'').slice(0,200), image: '', dbType: '건강기능식품' };
  }
  return null;
}

// ── 네이버 블로그 검색 ────────────────────────────────────────
async function searchNaver(drugName, clientId, clientSecret) {
  if (!clientId || !clientSecret || !drugName) return '';
  const hdrs = { 'X-Naver-Client-Id': clientId, 'X-Naver-Client-Secret': clientSecret };
  try {
    const [r1, r2] = await Promise.allSettled([
      fetch('https://openapi.naver.com/v1/search/blog.json?query=' + encodeURIComponent(drugName + ' 약사') + '&display=4&sort=sim', { headers: hdrs, signal: AbortSignal.timeout(5000) }).then(r => r.json()),
      fetch('https://openapi.naver.com/v1/search/blog.json?query=' + encodeURIComponent(drugName + ' 약국') + '&display=3&sort=sim', { headers: hdrs, signal: AbortSignal.timeout(5000) }).then(r => r.json()),
    ]);
    const items = [
      ...(r1.status === 'fulfilled' && r1.value.items || []),
      ...(r2.status === 'fulfilled' && r2.value.items || []),
    ].slice(0,5);
    return items.map(i => strip(i.title) + ': ' + strip(i.description)).filter(Boolean).join('\n').slice(0,600);
  } catch(_) { return ''; }
}

// ── 메인 핸들러 ───────────────────────────────────────────────
export default {
  async fetch(request, env) {
    if (request.method === 'OPTIONS') return new Response(null, { headers: corsHeaders });

    const url    = new URL(request.url);
    const action = url.searchParams.get('action') || '';

    // 헬스체크
    if (action === 'health') {
      return new Response(JSON.stringify({
        ok: true,
        apis: {
          claude:  !!(env.CLAUDE_API_KEY || env.ANTHROPIC_API_KEY),
          groq:    !!env.GROQ_API_KEY,
          mfds:    !!env.MFDS_API_KEY,
          naver:   !!(env.NAVER_CLIENT_ID && env.NAVER_CLIENT_SECRET),
          workersAI: !!env.AI,
        }
      }), { headers: { ...corsHeaders, 'Content-Type': 'application/json' } });
    }

    // ── 1. 약품명으로 AI 분석 ─────────────────────────────────
    if (action === 'analyzeDrugBoard' && request.method === 'POST') {
      try {
        const body = await request.json();
        const drugName = body.drugName;
        const imageUrl = body.imageUrl || '';
        if (!drugName) throw new Error('약품명이 없습니다.');

        // 식약처 DB 검색
        let dbInfo = null;
        try { dbInfo = await searchMFDS(drugName, env.MFDS_API_KEY); } catch(_) {}

        // 네이버 보조 검색 (DB 없을 때)
        let naverSnippets = '';
        if (!dbInfo) {
          try { naverSnippets = await searchNaver(drugName, env.NAVER_CLIENT_ID, env.NAVER_CLIENT_SECRET); } catch(_) {}
        }

        // 프롬프트 구성
        let dataSection = '';
        let sourceTag = 'AI';
        if (dbInfo) {
          sourceTag = '식약처 ' + dbInfo.dbType;
          dataSection = '\n[식약처 공식 DB]\n효능: ' + dbInfo.efcy.slice(0,400) + '\n용법: ' + dbInfo.use.slice(0,300) + '\n성분: ' + dbInfo.ingr + '\n주의: ' + dbInfo.warn.slice(0,200) + '\n';
        } else if (naverSnippets) {
          sourceTag = 'AI+네이버';
          dataSection = '\n[네이버 참고]\n' + naverSnippets.slice(0,400) + '\n';
        }
        if (imageUrl) dataSection += '\n참고 이미지: ' + imageUrl + '\n';

        const prompt = '당신은 한국 약사 커뮤니티 약품 DB 작성 전문가입니다.\n약품명: "' + drugName + '"' + dataSection + '\n다음 JSON만 출력(설명 없이):\n{"efficacy":"효능효과 50~100자","dosage":"용법용량 40~70자","pharmacistNote":"약사한마디 1~2문장 해요체. 실용적팁. 제품명금지. 뻔한말금지.","funcTags":["태그1","태그2"],"category":"소화기|통증·감기|눈·피부|비타민·영양제|상비약|기타","emoji":"💊"}';

        const raw = await callAI(env.AI, [{ role: 'user', content: prompt }], 700, env);
        let result = {};
        try { const m = raw.match(/\{[\s\S]*\}/); if (m) result = JSON.parse(m[0]); } catch(_) {}

        return new Response(JSON.stringify({
          efficacy:       result.efficacy       || '',
          dosage:         result.dosage         || '',
          pharmacistNote: result.pharmacistNote || '',
          emoji:          result.emoji          || '💊',
          funcTags:       Array.isArray(result.funcTags) ? result.funcTags : [],
          category:       result.category       || '기타',
          dbImageUrl:     dbInfo && dbInfo.image || '',
          dbType:         dbInfo && dbInfo.dbType || '',
          _source:        sourceTag,
        }), { headers: { ...corsHeaders, 'Content-Type': 'application/json; charset=utf-8' } });

      } catch(err) {
        return new Response(JSON.stringify({ error: err.message || '분석 실패' }), { status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json; charset=utf-8' } });
      }
    }

    // ── 2. 제약사 제품 페이지 스크래핑 ────────────────────────
    if (action === 'scrapePharmaSite' && request.method === 'POST') {
      try {
        const body = await request.json();
        const pageUrl = body.pageUrl;
        if (!pageUrl) throw new Error('URL이 없습니다.');
        if (!pageUrl.startsWith('http')) throw new Error('http(s)://로 시작하는 URL을 입력해주세요.');

        const pageRes = await fetch(pageUrl, {
          headers: {
            'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
            'Accept': 'text/html,application/xhtml+xml;q=0.9,*/*;q=0.8',
            'Accept-Language': 'ko-KR,ko;q=0.9,en;q=0.8',
          },
          signal: AbortSignal.timeout(15000),
          redirect: 'follow',
        });
        if (!pageRes.ok) throw new Error('페이지 접근 실패 (' + pageRes.status + ')');
        const html = await pageRes.text();

        // 이미지 추출 (og:image 우선)
        let imageUrl = '';
        const ogImg = html.match(/<meta[^>]+property=["']og:image["'][^>]+content=["']([^"']+)["']/i)
                   || html.match(/<meta[^>]+content=["']([^"']+)["'][^>]+property=["']og:image["']/i);
        if (ogImg) {
          imageUrl = ogImg[1];
        } else {
          const imgMatches = Array.from(html.matchAll(/<img[^>]+src=["']([^"']+)["'][^>]*>/gi));
          for (const m of imgMatches) {
            const src = m[1];
            if (src && !src.includes('icon') && !src.includes('logo') && !src.includes('banner') && src.match(/\.(jpg|jpeg|png|webp)/i)) {
              imageUrl = src; break;
            }
          }
        }
        if (imageUrl && !imageUrl.startsWith('http')) {
          try { imageUrl = new URL(imageUrl, pageUrl).href; } catch(_) {}
        }

        // HTML → 텍스트
        const cleanText = html
          .replace(/<script[^>]*>[\s\S]*?<\/script>/gi,' ')
          .replace(/<style[^>]*>[\s\S]*?<\/style>/gi,' ')
          .replace(/<[^>]+>/g,' ')
          .replace(/&nbsp;/g,' ').replace(/&amp;/g,'&').replace(/&lt;/g,'<').replace(/&gt;/g,'>').replace(/&quot;/g,'"')
          .replace(/\s{2,}/g,' ').trim().slice(0,3500);

        const pageTitle = (html.match(/<title[^>]*>([^<]*)<\/title>/i)||[])[1] || '';

        const scrapePrompt = '아래는 제약사 제품 페이지 텍스트입니다. 약품 정보를 추출해 JSON으로 반환하세요.\n\nURL: ' + pageUrl + '\n텍스트:\n' + cleanText + '\n\n다음 JSON만 출력:\n{"drugName":"공식약품명","efficacy":"효능효과 50~100자","dosage":"용법용량 40~70자","pharmacistNote":"약사한마디 1~2문장 해요체","emoji":"💊","funcTags":["태그1","태그2"],"category":"소화기|통증·감기|눈·피부|비타민·영양제|상비약|기타","manufacturer":"동아제약|한미약품|종근당|유한양행|보령제약|광동제약|한국얀센|GSK|기타"}';

        const raw = await callAI(env.AI, [{ role: 'user', content: scrapePrompt }], 700, env);
        let result = {};
        try { const m = raw.match(/\{[\s\S]*\}/); if (m) result = JSON.parse(m[0]); } catch(_) {}

        // 추출된 약품명으로 식약처 추가 검색
        let dbInfo = null;
        const extractedName = result.drugName || pageTitle;
        if (extractedName && env.MFDS_API_KEY) {
          try { dbInfo = await searchMFDS(extractedName, env.MFDS_API_KEY); } catch(_) {}
        }
        if (dbInfo) {
          if (dbInfo.efcy && !result.efficacy) result.efficacy = dbInfo.efcy.slice(0,100);
          if (dbInfo.use  && !result.dosage)   result.dosage   = dbInfo.use.slice(0,70);
        }

        return new Response(JSON.stringify({
          drugName:       result.drugName       || pageTitle.trim(),
          efficacy:       result.efficacy       || '',
          dosage:         result.dosage         || '',
          pharmacistNote: result.pharmacistNote || '',
          emoji:          result.emoji          || '💊',
          funcTags:       Array.isArray(result.funcTags) ? result.funcTags : [],
          category:       result.category       || '기타',
          manufacturer:   result.manufacturer   || '기타',
          imageUrl,
          dbType:         dbInfo && dbInfo.dbType || '',
          _source:        'scrape+ai' + (dbInfo ? '+식약처' : ''),
        }), { headers: { ...corsHeaders, 'Content-Type': 'application/json; charset=utf-8' } });

      } catch(err) {
        return new Response(JSON.stringify({ error: err.message || '스크래핑 실패' }), { status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json; charset=utf-8' } });
      }
    }

    return new Response(JSON.stringify({ error: '알 수 없는 액션: ' + action }), {
      status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json; charset=utf-8' },
    });
  },
};
