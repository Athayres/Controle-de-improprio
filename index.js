/**
 * Addon Stremio – Classificador de IMPROPRIO (IMDb) em PT-BR
 * Versão: 2.3.0 — adaptado do server.js (Node/Render) para Cloudflare Workers (deploy pelo GitHub)
 *
 * Variáveis (Settings > Variables and Secrets, tipo Secret):
 *   TMDB_KEY, MDBLIST_KEY            (META_URL e BLOQUEAR_SEM_CLASSIFICACAO são opcionais)
 * Opcional: binding KV chamado "KV" para guardar os aparelhos registrados de forma permanente.
 */
let TMDB_KEY = '';
let MDBLIST_KEY = '';
let META_URL = '';
let BLOQUEAR_SEM_INFO = false;
let KV = null;
const GUIA_TTL = 30 * 24 * 3600 * 1000;
const LOGO = '/logo.png'; // entregue pelo próprio Worker (PNG 256x256, no fim deste arquivo)

const NIVEIS = ['Nenhum', 'Leve', 'Moderado', 'Grave'];
const COR = ['⬜', '🟩', '🟨', '🟥'];
const CATEGORIAS = [
  { key: 'sexo', rotulo: 'Sexo e nudez', icone: '🔞', ids: ['NUDITY'], texto: /nudity|sex/i },
  { key: 'violencia', rotulo: 'Violência e sangue', icone: '🩸', ids: ['VIOLENCE'], texto: /violence|gore/i },
  { key: 'palavroes', rotulo: 'Palavrões', icone: '🤬', ids: ['PROFANITY'], texto: /profanity/i },
  { key: 'drogas', rotulo: 'Álcool, drogas e fumo', icone: '🍺', ids: ['ALCOHOL'], texto: /alcohol|drugs|smoking/i },
  { key: 'susto', rotulo: 'Cenas intensas e assustadoras', icone: '😱', ids: ['FRIGHTENING'], texto: /frightening|intense/i },
];

const CFG_PADRAO = { max: { sexo: 0, violencia: 1, palavroes: 0, drogas: 1, susto: 1 }, idade: 18 };

let cache = { guias: {}, br: {}, mdb: {}, ibr: {}, res: {} };
// Cache só em memória (o Worker não tem disco). Limita o tamanho para não crescer sem fim.
function salvar() {
  for (const k of ['guias', 'br', 'mdb', 'ibr', 'res']) {
    if (cache[k] && Object.keys(cache[k]).length > 5000) cache[k] = {};
  }
}
// Com o binding KV o cache sobrevive entre os "reinícios" do Worker (como o cache.json do Render).
async function cacheLer(tipo, id) {
  let v = cache[tipo][id];
  if (v === undefined && KV) {
    try { v = await KV.get('c:' + tipo + ':' + id, 'json'); } catch { v = null; }
    if (v) cache[tipo][id] = v;
  }
  return v || undefined;
}
async function cacheGravar(tipo, id, v, ttlMs) {
  cache[tipo][id] = v;
  salvar();
  if (KV) {
    try { await KV.put('c:' + tipo + ':' + id, JSON.stringify(v), { expirationTtl: Math.max(60, Math.ceil(ttlMs / 1000)) }); } catch {}
  }
}

function nivelDe(v) {
  switch (String(v || '').toUpperCase().replace(/VOTES$/, '')) {
    case 'NONE': return 0;
    case 'MILD': return 1;
    case 'MODERATE': return 2;
    case 'SEVERE': return 3;
    default: return null;
  }
}

function normalizarConfig(j) {
  const cfg = JSON.parse(JSON.stringify(CFG_PADRAO));
  if (!j || typeof j !== 'object') return cfg;
  for (const c of CATEGORIAS) {
    const v = Number(j.max && j.max[c.key]);
    if (Number.isInteger(v) && v >= 0 && v <= 3) cfg.max[c.key] = v;
  }
  const idade = Number(j.idade);
  if ([0, 10, 12, 14, 16, 18, 99].includes(idade)) cfg.idade = idade;
  return cfg;
}

function lerConfig(b64) {
  if (!b64) return normalizarConfig(null);
  try {
    let b = String(b64).replace(/-/g, '+').replace(/_/g, '/');
    while (b.length % 4) b += '=';
    const bytes = Uint8Array.from(atob(b), (ch) => ch.codePointAt(0));
    return normalizarConfig(JSON.parse(new TextDecoder().decode(bytes)));
  } catch { return normalizarConfig(null); }
}

// ---- Config por aparelho (registrada pelo botão da /configure) ----
// Com o binding KV os dados ficam permanentes; sem ele ficam só na memória do Worker (podem sumir).
const mem = new Map();
async function armLer(k) {
  if (KV) { try { return await KV.get(k, 'json'); } catch { return null; } }
  return mem.get(k) || null;
}
async function armGravar(k, v, ttlSeg) {
  if (KV) {
    try { await KV.put(k, JSON.stringify(v), ttlSeg ? { expirationTtl: ttlSeg } : undefined); } catch {}
    return;
  }
  if (mem.size >= 2000) mem.clear();
  mem.set(k, v);
}
async function armApagar(k) {
  if (KV) { try { await KV.delete(k); } catch {} return; }
  mem.delete(k);
}

function ipDe(request) {
  const xff = String(request.headers.get('x-forwarded-for') || '').split(',')[0].trim();
  return request.headers.get('cf-connecting-ip') || xff || '';
}

const PAREAR_TTL = 10 * 60 * 1000;
const famUA = (ua) => String(ua || '').replace(/[\d._]+/g, '#').slice(0, 200); // ignora números de versão

async function getPendente(ip) {
  const p = await armLer('pend:' + ip); // { config, t } (pareamento aguardando o aparelho abrir um título)
  if (p && Date.now() - p.t >= PAREAR_TTL) { await armApagar('pend:' + ip); return null; }
  return p || null;
}

async function aplicarPerfil(cfg, request, capturar) {
  const ip = ipDe(request);
  const chave = ip + '|' + famUA(request.headers.get('user-agent'));
  if (capturar) {
    const p = await getPendente(ip);
    if (p) {
      await armGravar('perfil:' + chave, p.config);
      await armApagar('pend:' + ip);
      console.log('Aparelho registrado:', chave);
    }
  }
  const reg = (await armLer('perfil:' + chave)) || (await armLer('perfil:' + ip));
  return reg ? normalizarConfig(reg) : cfg;
}

function limpaDescricao(desc) {
  if (!desc) return '';
  return desc.split(/(?:CONTEÚDO BLOQUEADO|LIBERADO|GUIA DOS PAIS|• Classificação|• 👨‍👩‍👧👦|• 🔞|• 🩸|• 🤬|• 🍺|• 😱)/)[0].trim();
}

async function tmdb(caminho, params = {}) {
  const u = new URL('https://api.themoviedb.org/3' + caminho);
  u.searchParams.set('api_key', TMDB_KEY);
  u.searchParams.set('language', 'pt-BR');
  for (const [k, v] of Object.entries(params)) u.searchParams.set(k, v);
  let erro = null;
  for (let t = 0; t < 3; t++) {
    if (t) await new Promise((ok) => setTimeout(ok, t * 400));
    try {
      const r = await fetch(u, { signal: AbortSignal.timeout(10000) });
      if (r.ok) return await r.json();
      erro = new Error('TMDB ' + r.status);
      if (r.status !== 429 && r.status < 500) break; // erro definitivo (ex.: 404): não repete
    } catch (e) {
      erro = e;
      if (e && e.name === 'TimeoutError') break; // não espera outro timeout inteiro
    }
  }
  throw erro;
}

async function resolverImdbId(id, tipo) {
  const raw = id.replace(/^gpbloq:/, '');
  const cleanId = raw.split(':')[0];
  if (/^tt\d+$/.test(cleanId)) return cleanId;
  if (raw.startsWith('aiom.collection:') || raw.startsWith('tvdbc:')) return null;

  if (!TMDB_KEY) return null;

  // IDs do TMDB de filme e série são independentes: usa só o endpoint do tipo certo
  const tv = tipo === 'series' || tipo === 'tv';
  const ext = async (kind, n) => {
    try { return (await tmdb(`/${kind}/${n}/external_ids`)).imdb_id || null; } catch { return null; }
  };

  const num = raw.split(':')[1] || '';
  if ((raw.startsWith('tmdb:') || raw.startsWith('tvdb:')) && !/^\d+$/.test(num)) return null;

  try {
    if (raw.startsWith('tmdb:')) {
      return await ext(tv ? 'tv' : 'movie', num);
    }

    if (raw.startsWith('tvdb:')) {
      const f = await tmdb(`/find/${num}`, { external_source: 'tvdb_id' });
      const r = ((tv ? f.tv_results : f.movie_results) || [])[0];
      return r && r.id ? await ext(tv ? 'tv' : 'movie', r.id) : null;
    }
  } catch (e) {
    console.error('Erro ao resolver ID externo:', e.message);
  }
  return null;
}

const findCache = new Map();
async function acharTMDB(imdbId) {
  if (findCache.has(imdbId)) return findCache.get(imdbId);
  const f = await tmdb(`/find/${imdbId}`, { external_source: 'imdb_id' });
  if (findCache.size >= 2000) findCache.clear();
  findCache.set(imdbId, f);
  return f;
}

// Retorna o texto em PT-BR, null (o TMDB não tem sinopse em PT-BR) ou undefined (o TMDB falhou: não guarda).
async function resumoPtBR(imdbId) {
  if (!TMDB_KEY) return null;
  const c = await cacheLer('res', imdbId);
  if (c && Date.now() - c.t < (c.v ? GUIA_TTL : NULO_TTL)) return c.v;
  try {
    const f = await acharTMDB(imdbId);
    const movie = (f.movie_results || [])[0];
    const tv = (f.tv_results || [])[0];

    let v = null;
    if (movie) {
      const detalhe = await tmdb(`/movie/${movie.id}`);
      if (detalhe && detalhe.overview) v = detalhe.overview;
    }
    if (!v && tv) {
      const detalhe = await tmdb(`/tv/${tv.id}`);
      if (detalhe && detalhe.overview) v = detalhe.overview;
    }
    if (!v) v = (movie && movie.overview) || (tv && tv.overview) || null;
    await cacheGravar('res', imdbId, { t: Date.now(), v }, v ? GUIA_TTL : NULO_TTL);
    return v;
  } catch { return undefined; }
}

async function classificacaoTMDB(imdbId) {
  if (!TMDB_KEY) return null;
  const c = await cacheLer('br', imdbId);
  if (typeof c === 'string') return c; // formato antigo (valor direto)
  if (c && typeof c === 'object' && Date.now() - c.t < (c.v ? GUIA_TTL : NULO_TTL)) return c.v;
  try {
    const f = await acharTMDB(imdbId);
    let br = null;
    if (f.movie_results && f.movie_results[0]) {
      const d = await tmdb(`/movie/${f.movie_results[0].id}/release_dates`);
      const p = d.results.find((x) => x.iso_3166_1 === 'BR');
      const rel = p && p.release_dates.find((x) => x.certification);
      br = rel ? rel.certification : null;
    } else if (f.tv_results && f.tv_results[0]) {
      const d = await tmdb(`/tv/${f.tv_results[0].id}/content_ratings`);
      const p = d.results.find((x) => x.iso_3166_1 === 'BR');
      br = p ? p.rating || null : null;
    }
    await cacheGravar('br', imdbId, { t: Date.now(), v: br }, br ? GUIA_TTL : NULO_TTL);
    return br;
  } catch { return null; }
}

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0.0.0 Safari/537.36';
const NULO_TTL = 12 * 3600 * 1000;

async function baixarPaginaIMDb(imdbId) {
  try {
    const r = await fetch(`https://www.imdb.com/title/${imdbId}/parentalguide/`, {
      headers: { 'User-Agent': UA, 'Accept-Language': 'en-US,en;q=0.9', Accept: 'text/html,application/xhtml+xml' },
      signal: AbortSignal.timeout(6000),
    });
    return { status: r.status, html: await r.text() };
  } catch (e) { return { status: 0, html: '', erro: String((e && e.message) || e) }; }
}

const GQL_QUERY = 'query($id: ID!){ title(id:$id){ parentsGuide{ categories{ category{ id text } severity{ id text votedFor } totalSeverityVotes } } } }';
async function baixarGraphQL(imdbId) {
  try {
    const r = await fetch('https://api.graphql.imdb.com/', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json', 'User-Agent': UA, Origin: 'https://www.imdb.com', Referer: 'https://www.imdb.com/' },
      body: JSON.stringify({ query: GQL_QUERY, variables: { id: imdbId } }),
      signal: AbortSignal.timeout(6000),
    });
    const texto = await r.text();
    let json = null;
    try { json = JSON.parse(texto); } catch {}
    return { status: r.status, json, texto };
  } catch (e) { return { status: 0, json: null, texto: '', erro: String((e && e.message) || e) }; }
}

function nivelDoItem(el) {
  const s = el.severity ?? el.severitySummary;
  if (s != null) {
    const candidatos = typeof s === 'object' ? [s.text, s.id, s.value, s.label] : [s];
    for (const c of candidatos) {
      const n = nivelDe(c);
      if (n !== null) return n;
    }
  }
  const votos = [0, 0, 0, 0];
  let tem = false;
  if (el.votes && typeof el.votes === 'object') {
    [['noneVotes', 0], ['mildVotes', 1], ['moderateVotes', 2], ['severeVotes', 3]].forEach(([k, i]) => {
      const n = Number(el.votes[k]);
      if (n > 0) { votos[i] += n; tem = true; }
    });
  }
  const lista = el.severityBreakdown || el.severityVotes;
  if (Array.isArray(lista)) {
    for (const v of lista) {
      const i = [v.voteType, v.id, v.text].map(nivelDe).find((x) => x !== null) ?? null;
      const n = Number(v.votedFor ?? v.votes ?? v.count);
      if (i !== null && n > 0) { votos[i] += n; tem = true; }
    }
  }
  if (!tem) return null;
  const total = votos.reduce((a, b) => a + b, 0);
  let acum = 0;
  for (let i = 0; i < 4; i++) { acum += votos[i]; if (acum >= total / 2) return i; }
  return null;
}

function coletarCategorias(no, saida = [], prof = 0) {
  if (!no || typeof no !== 'object' || prof > 16) return saida;
  if (Array.isArray(no) && no.some((e) => e && typeof e === 'object' && e.category && (typeof e.category === 'string' || e.category.id || e.category.text))) saida.push(no);
  for (const v of Object.values(no)) coletarCategorias(v, saida, prof + 1);
  return saida;
}

function guiaDeJson(dados) {
  const guia = {};
  let achou = false;
  for (const arr of coletarCategorias(dados)) {
    for (const el of arr) {
      if (!el || !el.category) continue;
      const cat = el.category;
      const id = String(typeof cat === 'string' ? cat : cat.id || '').toUpperCase();
      const txt = typeof cat === 'string' ? cat : String(cat.text || '');
      const alvo = CATEGORIAS.find((x) => x.ids.includes(id) || x.texto.test(txt) || x.texto.test(id));
      if (!alvo) continue;
      const nivel = nivelDoItem(el);
      if (guia[alvo.key] == null) guia[alvo.key] = nivel;
      if (nivel !== null) achou = true;
    }
  }
  return achou ? guia : null;
}

function guiaDeHtml(html) {
  const slugs = { sexo: 'nudity', violencia: 'violence', palavroes: 'profanity', drogas: 'alcohol', susto: 'frightening' };
  const guia = {};
  let achou = false;
  for (const [key, slug] of Object.entries(slugs)) {
    const i = html.search(new RegExp(`advisory-${slug}`, 'i'));
    if (i < 0) continue;
    const trecho = html.slice(i, i + 1500).replace(/<[^>]+>/g, ' ');
    const m = trecho.match(/\b(None|Mild|Moderate|Severe)\b/);
    if (m) { guia[key] = nivelDe(m[1]); achou = true; }
  }
  return achou ? guia : null;
}

function extrairGuia(html) {
  const m = html.match(/<script id="__NEXT_DATA__"[^>]*>([\s\S]*?)<\/script>/);
  if (m) {
    try { const g = guiaDeJson(JSON.parse(m[1])); if (g) return g; } catch {}
  }
  return guiaDeHtml(html);
}

async function consultarIMDb(imdbId) {
  const gq = await baixarGraphQL(imdbId);
  if (gq.json) {
    const g = guiaDeJson(gq.json);
    if (g) return { guia: g };
    if (gq.json.data && gq.json.data.title && !gq.json.errors) return { guia: null };
  }
  const p = await baixarPaginaIMDb(imdbId);
  const g = p.html ? extrairGuia(p.html) : null;
  // página 200 sem __NEXT_DATA__ nem seções advisory (captcha/bloqueio) = falha, não "sem guia"
  const paginaValida = p.status === 200 && (p.html.includes('__NEXT_DATA__') || /advisory-/i.test(p.html));
  return { guia: g, falhou: !g && !paginaValida };
}

const guiasFalhas = new Map();
const FALHA_TTL = 2 * 60 * 1000;

async function buscarGuia(imdbId) {
  const c = await cacheLer('guias', imdbId);
  if (c && Date.now() - c.t < (c.g ? GUIA_TTL : NULO_TTL)) return c.g;
  if ((guiasFalhas.get(imdbId) || 0) > Date.now()) return undefined;
  const r = await consultarIMDb(imdbId);
  if (r.falhou) {
    if (guiasFalhas.size >= 2000) guiasFalhas.clear();
    guiasFalhas.set(imdbId, Date.now() + FALHA_TTL);
    return undefined;
  }
  await cacheGravar('guias', imdbId, { t: Date.now(), g: r.guia }, r.guia ? GUIA_TTL : NULO_TTL);
  return r.guia;
}

function rotuloClassificacao(br) {
  const t = String(br).trim();
  if (/^(l|livre)$/i.test(t)) return 'Livre';
  if (/^\d+$/.test(t)) return `${t} anos`;
  return t;
}

function textoGuia(guia, br) {
  const linhas = [];
  if (br) linhas.push(`Classificação indicativa: ${rotuloClassificacao(br)}`);

  if (guia === undefined) {
    linhas.push('Guia dos Pais do IMDb indisponível no momento');
  } else if (guia === null) {
    linhas.push('Este título não possui Guia dos Pais no IMDb');
  } else {
    for (const c of CATEGORIAS) {
      const n = guia[c.key];
      if (n != null) {
        linhas.push(`${c.icone} ${c.rotulo}: ${COR[n]} ${NIVEIS[n]}`);
      }
    }
  }

  return linhas.map((l) => '• ' + l).join('\n');
}

const MDB_NULO_TTL = 3 * 24 * 3600 * 1000;
let mdbPausaAte = 0;

async function baixarMDBList(imdbId, tipo) {
  try {
    const t = tipo === 'series' ? 'show' : 'movie';
    const r = await fetch(`https://api.mdblist.com/imdb/${t}/${imdbId}/?apikey=${encodeURIComponent(MDBLIST_KEY)}`, { signal: AbortSignal.timeout(10000) });
    let json = null;
    try { json = await r.json(); } catch {}
    return { status: r.status, json };
  } catch (e) { return { status: 0, json: null, erro: String((e && e.message) || e) }; }
}

function faixaDeIdade(n) {
  if (!Number.isFinite(n) || n <= 0) return null;
  if (n <= 7) return 'L';
  if (n <= 10) return '10';
  if (n <= 12) return '12';
  if (n <= 14) return '14';
  if (n <= 16) return '16';
  return '18';
}

const CERT_PARA_BR = {
  G: 'L', 'TV-G': 'L', 'TV-Y': 'L', 'TV-Y7': 'L', 'TV-Y7-FV': 'L',
  PG: '10', 'TV-PG': '10',
  'PG-13': '14', 'TV-14': '14',
  R: '16',
  'NC-17': '18', 'TV-MA': '18', X: '18',
};

function faixaDoMDBList(d) {
  if (!d || typeof d !== 'object') return null;
  const porIdade = faixaDeIdade(Number(d.age_rating));
  if (porIdade) return porIdade;
  return CERT_PARA_BR[String(d.certification || '').toUpperCase().trim()] || null;
}

async function classificacaoMDBList(imdbId, tipo) {
  if (!MDBLIST_KEY || Date.now() < mdbPausaAte) return null;
  const c = await cacheLer('mdb', imdbId);
  if (c && Date.now() - c.t < (c.v ? GUIA_TTL : MDB_NULO_TTL)) return c.v;
  const r = await baixarMDBList(imdbId, tipo);
  if (r.status === 429 || (r.json && r.json.response === false && /limit/i.test(String(r.json.error || '')))) {
    mdbPausaAte = Date.now() + 3600 * 1000;
    return null;
  }
  if (r.status !== 200 || !r.json) return null;
  const v = faixaDoMDBList(r.json);
  await cacheGravar('mdb', imdbId, { t: Date.now(), v }, v ? GUIA_TTL : MDB_NULO_TTL);
  return v;
}

// 1ª fonte: classificação do Brasil cadastrada no próprio IMDb
const IBR_QUERY = 'query($id: ID!){ title(id:$id){ certificates(first: 250){ edges{ node{ rating country{ id } } } } } }';

function faixaBRdoIMDb(rating) {
  const t = String(rating || '').trim();
  if (/^(l|livre)$/i.test(t)) return 'L';
  const m = t.match(/^(\d{1,2})\b/);
  return m && [10, 12, 14, 16, 18].includes(Number(m[1])) ? m[1] : null;
}

let ibrPausaAte = 0;
async function classificacaoIMDb(imdbId) {
  const c = await cacheLer('ibr', imdbId);
  if (c && Date.now() - c.t < (c.v ? GUIA_TTL : NULO_TTL)) return c.v;
  if (Date.now() < ibrPausaAte) return null; // IMDb falhou há pouco: vai direto para o TMDB
  try {
    const r = await fetch('https://api.graphql.imdb.com/', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json', 'User-Agent': UA, Origin: 'https://www.imdb.com', Referer: 'https://www.imdb.com/' },
      body: JSON.stringify({ query: IBR_QUERY, variables: { id: imdbId } }),
      signal: AbortSignal.timeout(6000),
    });
    const j = await r.json();
    const edges = j && j.data && j.data.title && j.data.title.certificates && j.data.title.certificates.edges;
    if (!Array.isArray(edges)) { ibrPausaAte = Date.now() + 5 * 60 * 1000; return null; } // erro/bloqueio: não guarda, segue para o TMDB
    const num = (f) => (f === 'L' ? 0 : Number(f));
    let melhor = null;
    for (const e of edges) {
      const n = e && e.node;
      if (!n || !n.country || String(n.country.id).toUpperCase() !== 'BR') continue;
      const f = faixaBRdoIMDb(n.rating);
      if (f !== null && (melhor === null || num(f) > num(melhor))) melhor = f; // se houver mais de uma, vale a mais restrita
    }
    await cacheGravar('ibr', imdbId, { t: Date.now(), v: melhor }, melhor ? GUIA_TTL : NULO_TTL);
    return melhor;
  } catch { return null; }
}

// ordem: 1) IMDb  2) TMDB  3) MDBList
async function classificacaoBR(imdbId, tipo) {
  const im = await classificacaoIMDb(imdbId);
  if (im) return im;
  const tm = await classificacaoTMDB(imdbId);
  if (tm) return tm;
  return classificacaoMDBList(imdbId, tipo);
}

function idadeDeBR(br) {
  if (br == null) return null;
  const t = String(br).trim();
  if (/^(l|livre)$/i.test(t)) return 0;
  const n = parseInt(t.replace(/\D/g, ''), 10);
  return Number.isFinite(n) ? n : null;
}

function motivosBloqueio(cfg, br, guia) {
  const motivos = [];
  if (cfg.idade === 18) return motivos;

  let liberadoPorIdade = false;

  if (cfg.idade < 18) {
    const limite = cfg.idade === 0 ? 1 : cfg.idade;
    const idade = idadeDeBR(br);
    if (idade === null) {
      if (BLOQUEAR_SEM_INFO) motivos.push('Sem classificação indicativa conhecida');
    } else if (idade < limite) {
      liberadoPorIdade = true;
    } else {
      motivos.push(`Classificação ${idade === 0 ? 'Livre' : idade + ' anos'} (bloqueado a partir de ${cfg.idade === 0 ? 'qualquer faixa acima de Livre' : cfg.idade + ' anos'})`);
    }
  }

  const restrito = !liberadoPorIdade && CATEGORIAS.some((c) => cfg.max[c.key] < 3);
  if (restrito) {
    if (guia && typeof guia === 'object') {
      for (const c of CATEGORIAS) {
        const n = guia[c.key];
        if (n != null && n > cfg.max[c.key]) {
          motivos.push(`${c.rotulo}: ${NIVEIS[n]} (limite: ${NIVEIS[cfg.max[c.key]]})`);
        }
      }
    } else if (guia === null && BLOQUEAR_SEM_INFO) {
      motivos.push('Título sem Guia dos Pais no IMDb');
    }
  }
  return motivos;
}

// ---- Meta em PT-BR direto do TMDB (nome, capa, fundo, gêneros e episódios) ----
const TMDB_IMG = 'https://image.tmdb.org/t/p/';
async function tmdbOverlay(imdb, tipo) {
  if (!TMDB_KEY) return null;
  try {
    const tv = tipo === 'series';
    const f = await acharTMDB(imdb);
    const r = ((tv ? f.tv_results : f.movie_results) || [])[0];
    if (!r || !r.id) return null;
    const d = await tmdb(`/${tv ? 'tv' : 'movie'}/${r.id}`, { append_to_response: 'images', include_image_language: 'pt,null' });
    // só imagem em português do Brasil; sem ela, null (fica a original)
    const emPt = (lista) => (Array.isArray(lista) ? lista : []).find((x) => x && x.iso_639_1 === 'pt' && x.iso_3166_1 === 'BR' && x.file_path) || null;
    const imgs = d.images || {};
    const posterPt = emPt(imgs.posters);
    const logoPt = emPt(imgs.logos);
    const ov = {
      name: (tv ? d.name : d.title) || '',
      logo: logoPt ? TMDB_IMG + 'w500' + logoPt.file_path : '',
      poster: posterPt ? TMDB_IMG + 'w500' + posterPt.file_path : (d.poster_path ? TMDB_IMG + 'w500' + d.poster_path : ''),
      background: d.backdrop_path ? TMDB_IMG + 'w1280' + d.backdrop_path : '',
      genres: Array.isArray(d.genres) ? d.genres.map((g) => g.name).filter(Boolean) : [],
      eps: null,
    };
    if (tv && Array.isArray(d.seasons)) {
      const temps = d.seasons.map((x) => x.season_number).filter((n) => n > 0);
      const lotes = [];
      for (let i = 0; i < temps.length; i += 20) lotes.push(temps.slice(i, i + 20));
      const rs = await Promise.all(lotes.map((l) =>
        tmdb(`/tv/${r.id}`, { append_to_response: l.map((n) => 'season/' + n).join(',') }).catch(() => null)));
      ov.eps = {};
      for (const resp of rs) {
        if (!resp) continue;
        for (const [k, v] of Object.entries(resp)) {
          if (!k.startsWith('season/') || !v || !Array.isArray(v.episodes)) continue;
          for (const e of v.episodes) {
            ov.eps[`${e.season_number}:${e.episode_number}`] = {
              name: e.name || '',
              overview: e.overview || '',
              still: e.still_path ? TMDB_IMG + 'w300' + e.still_path : '',
            };
          }
        }
      }
    }
    return ov;
  } catch { return null; }
}

function aplicarTmdb(m, ov) {
  // Logo e capa: pt-BR quando existir; senão ficam as originais.
  if (ov.logo) m.logo = ov.logo;
  if (ov.name) m.name = ov.name;
  if (ov.poster) m.poster = ov.poster;
  if (ov.background) m.background = ov.background;
  if (ov.genres.length) m.genres = ov.genres;
  if (ov.eps && Array.isArray(m.videos)) {
    for (const v of m.videos) {
      const e = v && ov.eps[`${v.season}:${v.episode != null ? v.episode : v.number}`];
      if (!e) continue;
      if (e.name && !(v.name && /^Epis[óo]dio\s*\d+$/i.test(e.name))) { v.name = e.name; if (v.title != null) v.title = e.name; }
      if (e.overview) { v.overview = e.overview; if (v.description != null) v.description = e.overview; }
      if (e.still && !v.thumbnail) v.thumbnail = e.still;
    }
  }
}

async function avaliar(imdb, tipo, cfg) {
  const [guia, br] = await Promise.all([
    buscarGuia(imdb).catch(() => undefined),
    classificacaoBR(imdb, tipo).catch(() => null),
  ]);
  return { guia, br, motivos: motivosBloqueio(cfg, br, guia) };
}

const baseCache = new Map();
const BASE_TTL = 6 * 3600 * 1000;
const BASE_TIMEOUT = 5000;

async function meta(tipo, id, cfg, userAgent = '') {
  const imdb = await resolverImdbId(id, tipo);
  if (!imdb || !/^tt\d+$/.test(imdb)) return null;

  let baseFraca = false;
  const buscarBase = async () => {
    const chave = `${tipo}|${id}|${imdb}`;
    const c = baseCache.get(chave);
    if (c && Date.now() - c.t < BASE_TTL) return structuredClone(c.m);

    const pegar = async (url) => {
      for (let t = 0; t < 2; t++) { // repete uma vez se falhar rápido
        try {
          const r = await fetch(url, { signal: AbortSignal.timeout(BASE_TIMEOUT) });
          if (r.ok) { const m = (await r.json()).meta; if (m) return m; }
          if (r.status !== 429 && r.status < 500) break;
        } catch (e) {
          if (e && e.name === 'TimeoutError') break;
        }
      }
      return null;
    };
    // TMDB (PT-BR) e Cinemeta saem em paralelo; o AIOMetadata só entra se o TMDB não responder
    const usaTmdb = !!TMDB_KEY && id === imdb;
    const tm = usaTmdb ? tmdbOverlay(imdb, tipo) : Promise.resolve(null);
    const cinemeta = pegar(`https://v3-cinemeta.strem.io/meta/${tipo}/${imdb}.json`);
    let m = null;
    const ov = await tm;
    if (ov) m = await cinemeta;
    if (!m && META_URL) {
      const ids = [id, imdb].filter((v, i, a) => a.indexOf(v) === i);
      const rs = await Promise.all(ids.map((cid) => pegar(`${META_URL}/meta/${tipo}/${cid}.json`)));
      m = rs.find(Boolean) || null;
    }
    if (!m) m = await cinemeta;
    const completa = !!m;
    if (!m && ov) m = { id: imdb, type: tipo };
    if (m && ov) aplicarTmdb(m, ov);
    if (!completa || (usaTmdb && !ov)) baseFraca = true;
    if (m && completa && !(usaTmdb && !ov)) {
      if (baseCache.size >= 500) baseCache.clear();
      baseCache.set(chave, { t: Date.now(), m: structuredClone(m) });
    }
    return m;
  };

  const [baseMeta, { guia, br, motivos }, resumo] = await Promise.all([
    buscarBase(),
    avaliar(imdb, tipo, cfg),
    resumoPtBR(imdb).catch(() => null),
  ]);
  
  if (!baseMeta) baseFraca = true;
  const base = baseMeta || { id: id, type: tipo, name: imdb, description: '', genres: [] };
  const bloqueado = motivos.length > 0;

  let classificacaoFinal = br;
  if (!classificacaoFinal && base.certification && /^(l|livre|\d{1,2})$/i.test(String(base.certification).trim())) {
    classificacaoFinal = String(base.certification).trim();
  }

  base.genres = Array.isArray(base.genres) ? base.genres : [];
  if (classificacaoFinal) {
    const rotuloBr = rotuloClassificacao(classificacaoFinal);

    base.genres = base.genres.filter(g => !/^(L|Livre|\d+\s*anos?)$/i.test(g));
    base.genres.unshift(rotuloBr);
  }

  const isApp = /stremio/i.test(userAgent);
  const original = limpaDescricao(resumo || base.description || '');

  if (isApp) {
    const textoGuiaPais = textoGuia(guia, classificacaoFinal);
    if (original && textoGuiaPais) {
      // Sinopse primeiro; classificação e guia dos pais logo abaixo
      base.description = `${original}\n\n${textoGuiaPais}`;
    } else {
      base.description = original || textoGuiaPais;
    }
  } else {
    base.description = original;
    const novasTags = [];
    if (classificacaoFinal) novasTags.push(`👨‍👩‍👧‍👦 ${rotuloClassificacao(classificacaoFinal)}`);
    if (guia && typeof guia === 'object') {
      for (const c of CATEGORIAS) {
        const n = guia[c.key];
        if (n != null) novasTags.push(`${c.icone} ${c.rotulo}: ${NIVEIS[n]}`);
      }
    }
    if (novasTags.length > 0) {
      base.links = Array.isArray(base.links) ? base.links : [];
      base.links = base.links.filter((l) => !(l && l.category === 'Classificação'));
      base.links.push(...novasTags.map((tag) => ({
        name: tag,
        category: 'Classificação',
        url: `https://www.imdb.com/title/${imdb}/parentalguide/`,
      })));
    }
  }

  if (bloqueado) {
    if (Array.isArray(base.videos) && base.videos.length) {
      base.videos = base.videos.map((v) => (v && v.id && !String(v.id).startsWith('gpbloq:') ? { ...v, id: `gpbloq:${v.id}` } : v));
    } else if (tipo === 'movie') {
      base.id = id.startsWith('gpbloq:') ? id : `gpbloq:${id}`;
    }
  }

  return { meta: base, bloqueado, motivos, incompleto: guia === undefined || baseFraca || resumo === undefined };
}

function manifest(origem) {
  return {
    id: 'community.guiadospais.ptbr',
    version: '2.3.1',
    name: 'Controle de Impróprios',
    logo: origem + LOGO,
    description: 'Exibe a classificação indicativa brasileira e o guia do IMDb diretamente no Stremio.',
    resources: ['meta', 'stream'],
    types: ['movie', 'series'],
    idPrefixes: ['tt', 'gpbloq:', 'tvdb:', 'tmdb:', 'tvdbc:', 'aiom.collection:'],
    catalogs: [],
    behaviorHints: { configurable: true },
  };
}

function paginaConfig(cfg) {
  const linhas = CATEGORIAS.map((c) => `
      <label>${c.icone} ${c.rotulo}
        <select data-cat="${c.key}">
          ${NIVEIS.map((n, i) => `<option value="${i}">${i === 3 ? 'Permitir até Grave' : 'Permitir até: ' + n}</option>`).join('')}
        </select>
      </label>`).join('');

  return `<!doctype html>
<html lang="pt-BR"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Controle de Impróprios – Configurar</title>
<link rel="icon" href="${LOGO}">
<style>
  :root{color-scheme:light dark;--bg:#f6f5fb;--fg:#1b1b26;--card:#fff;--bd:#d9d7e6;--ac:#6b4cff;--sec:#8b5cf6}
  @media(prefers-color-scheme:dark){:root{--bg:#14141c;--fg:#ececf5;--card:#1e1e2a;--bd:#34344a}}
  body{margin:0;font-family:system-ui,-apple-system,Segoe UI,Roboto,sans-serif;background:var(--bg);color:var(--fg)}
  main{max-width:520px;margin:0 auto;padding:24px 16px}
  h1{font-size:1.4rem;margin:0 0 4px;display:flex;align-items:center;gap:10px} h1 img{width:44px;height:44px;border-radius:10px} p{opacity:.75;margin:0 0 20px}
  .card{background:var(--card);border:1px solid var(--bd);border-radius:14px;padding:16px;display:grid;gap:14px}
  label{display:grid;gap:6px;font-weight:600}
  select,input{font:inherit;padding:10px;border-radius:10px;border:1px solid var(--bd);background:transparent;color:inherit}
  .btn-group{display:grid;grid-template-columns:1fr 1fr;gap:10px}
  @media(max-width:480px){.btn-group{grid-template-columns:1fr}}
  a.btn{font:inherit;font-weight:700;border:0;border-radius:10px;padding:12px;background:var(--ac);color:#fff;text-align:center;text-decoration:none;cursor:pointer}
  a.btn-web{background:var(--sec)}
  button.sec{font:inherit;font-weight:600;background:transparent;color:var(--fg);border:1px solid var(--bd);border-radius:10px;padding:10px;cursor:pointer}
  button.reset{font:inherit;font-weight:600;background:#22c55e;color:#fff;border:0;border-radius:10px;padding:10px;cursor:pointer}
  small{opacity:.75;line-height:1.4}
</style></head><body><main>
  <h1><img src="${LOGO}" alt="">Controle de Impróprios</h1>
  <p>Informativo da classificação indicativa diretamente no Stremio.</p>
  <div class="card">
    <button class="reset" id="btnLiberarTudo" type="button">🔓 Liberar Tudo (Sem limites)</button>
    <label>🇧🇷 Modos de Bloqueio por Idade
      <select id="idade">
        <option value="18">Sem limite (Apenas aviso na descrição, não bloqueia nada)</option>
        <option value="99">Sem bloqueio por idade (vale só o limite por categoria)</option>
        <option value="16">Bloquear 16 anos ou mais (16 e 18 anos)</option>
        <option value="14">Bloquear 14 anos ou mais (14, 16 e 18 anos)</option>
        <option value="12">Bloquear 12 anos ou mais (12, 14, 16 e 18 anos)</option>
        <option value="10">Bloquear 10 anos ou mais (10, 12, 14, 16 e 18 anos)</option>
        <option value="0">Bloquear tudo exceto Livre</option>
      </select>
    </label>
    ${linhas}
    <div class="btn-group">
      <a class="btn" id="instalarApp" href="#">Instalar no App</a>
      <a class="btn btn-web" id="instalarWeb" target="_blank" href="#">Instalar no Web</a>
    </div>
    <input id="url" readonly>
    <button class="sec" id="copiar" type="button">Copiar link do addon</button>
    <button class="sec" id="registrar" type="button">Registrar um aparelho com esta configuração</button>
    <small id="regMsg"></small>
  </div>
</main>
<script>
  var CFG = ${JSON.stringify(cfg)};
  var sels = document.querySelectorAll('select[data-cat]');
  sels.forEach(function(s){ s.value = CFG.max[s.dataset.cat]; s.onchange = atualizar; });
  var id = document.getElementById('idade'); if (id) { id.value = CFG.idade; id.onchange = atualizar; }
  
  document.getElementById('btnLiberarTudo').onclick = function() {
    if (id) id.value = '18';
    sels.forEach(function(s){ s.value = '3'; });
    atualizar();
  };

  function atualizar(){
    var c = { max:{}, idade: id ? Number(id.value) : CFG.idade };
    sels.forEach(function(s){ c.max[s.dataset.cat] = Number(s.value); });
    var b64 = btoa(JSON.stringify(c)).replace(/\\+/g,'-').replace(/\\//g,'_').replace(/=+$/,'');
    
    window._b64 = b64;
    var proto = location.protocol;
    var host = location.host;
    var manifestUrl = proto + '//' + host + '/' + b64 + '/manifest.json';
    var webUrl = 'https://web.stremio.com/#/addons?addon=' + encodeURIComponent(manifestUrl);
    var appUrl = 'stremio://' + host + '/' + b64 + '/manifest.json';
    
    document.getElementById('url').value = manifestUrl;
    document.getElementById('instalarApp').href = appUrl;
    document.getElementById('instalarWeb').href = webUrl;
  }
  
  document.getElementById('copiar').onclick = function(){
    var i = document.getElementById('url'); i.select();
    (navigator.clipboard ? navigator.clipboard.writeText(i.value) : Promise.resolve(document.execCommand('copy'))).then(function(){ document.getElementById('copiar').textContent = 'Copiado!'; });
  };
  var pollReg = null;
  document.getElementById('registrar').onclick = function(){
    var m = document.getElementById('regMsg');
    clearInterval(pollReg);
    fetch('/registrar/' + window._b64).then(function(r){ return r.json(); }).then(function(j){
      if (!j.ok) { m.textContent = 'Não foi possível iniciar.'; return; }
      m.textContent = 'Agora abra um título no Stremio, no aparelho que você quer registrar (em até 10 minutos). Use só esse aparelho até aparecer Registrado.';
      var t0 = Date.now();
      pollReg = setInterval(function(){
        fetch('/registrar-status').then(function(r){ return r.json(); }).then(function(st){
          if (!st.pendente) { clearInterval(pollReg); m.textContent = (Date.now() - t0 > 590000) ? 'Tempo esgotado. Clique de novo.' : 'Registrado! Esse aparelho agora usa esta configuração.'; }
        }).catch(function(){});
      }, 3000);
    }).catch(function(){ m.textContent = 'Não foi possível iniciar.'; });
  };
  atualizar();
</script></body></html>`;
}

function json(obj, maxAge = 0, status = 200) {
  return new Response(JSON.stringify(obj), {
    status,
    headers: {
      'Content-Type': 'application/json; charset=utf-8',
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Headers': '*',
      'Vary': 'X-Forwarded-For',
      'Cache-Control': maxAge ? `public, max-age=${maxAge}` : 'no-cache, no-store, must-revalidate',
    },
  });
}

const TIPOS_OK = new Set(['movie', 'series']);
function paramsOk(tipo, id) { return TIPOS_OK.has(tipo) && /^[A-Za-z0-9_.:-]{1,100}$/.test(id); }

const RESERVADOS = new Set(['configure', 'manifest.json', 'stream', 'meta', 'health', 'avaliar', 'registrar', 'registrar-status', 'diagnostico', 'logo.png']);

export default {
  async fetch(request, env) {
    TMDB_KEY = String(env.TMDB_KEY || '').trim();
    MDBLIST_KEY = String(env.MDBLIST_KEY || '').trim();
    META_URL = String(env.META_URL || '').replace(/\/+$/, '');
    BLOQUEAR_SEM_INFO = env.BLOQUEAR_SEM_CLASSIFICACAO === '1';
    KV = env.KV || null;
    if (KV && (!TMDB_KEY || !MDBLIST_KEY)) { // alternativa: chaves guardadas no próprio KV (entradas TMDB_KEY / MDBLIST_KEY)
      try {
        if (!TMDB_KEY) TMDB_KEY = String((await KV.get('TMDB_KEY', { cacheTtl: 300 })) || '').trim();
        if (!MDBLIST_KEY) MDBLIST_KEY = String((await KV.get('MDBLIST_KEY', { cacheTtl: 300 })) || '').trim();
      } catch {}
    }

    try {
      if (request.method === 'OPTIONS') {
        return new Response(null, {
          status: 204,
          headers: {
            'Access-Control-Allow-Origin': '*',
            'Access-Control-Allow-Headers': '*',
            'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
          },
        });
      }
      const url = new URL(request.url);
      const partes = url.pathname.split('/').filter(Boolean);
      if (!partes.length) return Response.redirect(`${url.origin}/configure`, 302);
      if (partes[0] === 'health') return json({ ok: true });

      if (partes[0] === 'diagnostico') { // mostra se as chaves/KV foram lidas (nunca mostra as chaves)
        let tmdbTeste = 'TMDB_KEY não definida';
        let sinopseTeste = null;
        if (TMDB_KEY) {
          try { await tmdb('/configuration'); tmdbTeste = 'ok'; } catch (e) { tmdbTeste = 'falhou: ' + String((e && e.message) || e); }
          if (tmdbTeste === 'ok') {
            try { sinopseTeste = String((await resumoPtBR('tt0111161')) || '').slice(0, 80) || null; } catch {}
          }
        }
        return json({ tmdb_key_definida: !!TMDB_KEY, tmdb_teste: tmdbTeste, sinopse_teste_pt: sinopseTeste, mdblist_key_definida: !!MDBLIST_KEY, kv_ligado: !!KV }, 0);
      }

      const cfgB64 = RESERVADOS.has(partes[0]) ? '' : partes.shift();
      const cfg = await aplicarPerfil(lerConfig(cfgB64), request, partes[0] === 'meta' || partes[0] === 'stream');
      const dec = (x) => decodeURIComponent((x || '').replace(/\.json$/, ''));

      if (partes[0] === 'configure') {
        return new Response(paginaConfig(cfg), { headers: { 'Content-Type': 'text/html; charset=utf-8' } });
      }
      if (partes[0] === 'registrar') {
        const ip = ipDe(request);
        const c = lerConfig(dec(partes[1]));
        await armGravar('pend:' + ip, { config: c, t: Date.now() }, 600);
        return json({ ok: true, ip, config: c }, 0);
      }
      if (partes[0] === 'registrar-status') return json({ pendente: !!(await getPendente(ipDe(request))) }, 0);

      if (partes[0] === 'manifest.json') return json(manifest(url.origin));
      if (partes[0] === 'logo.png') {
        return new Response(Uint8Array.from(atob(LOGO_B64), (c) => c.charCodeAt(0)), {
          headers: { 'Content-Type': 'image/png', 'Cache-Control': 'public, max-age=86400', 'Access-Control-Allow-Origin': '*' },
        });
      }

      if (partes[0] === 'meta') {
        const tipo = dec(partes[1]);
        const id = dec(partes[2]);
        if (!paramsOk(tipo, id)) return json({ meta: null }, 0);
        const userAgent = request.headers.get('user-agent') || '';
        const r = await meta(tipo, id, cfg, userAgent);
        if (!r) return json({ meta: null }, 0);
        return json({ meta: r.meta }, r.incompleto ? 0 : 300);
      }

      if (partes[0] === 'avaliar') {
        const tipo = dec(partes[1]);
        const rawId = dec(partes[2]);
        if (!paramsOk(tipo, rawId)) return json({ erro: 'parâmetros inválidos' }, 0, 400);
        const imdb = await resolverImdbId(rawId, tipo);
        if (!imdb || !/^tt\d+$/.test(imdb)) return json({ erro: 'ID inválido ou não resolvido para IMDb' }, 0, 400);
        const r = await avaliar(imdb, tipo, cfg);
        return json({ imdb, ip: ipDe(request), config: cfg, classificacaoBR: r.br, guia: r.guia, bloqueado: r.motivos.length > 0, motivos: r.motivos }, 0);
      }

      if (partes[0] === 'stream') {
        const tipo = dec(partes[1]);
        const rawId = dec(partes[2]);
        if (!paramsOk(tipo, rawId)) return json({ streams: [] }, 0);
        const imdb = await resolverImdbId(rawId, tipo);
        if (!imdb || !/^tt\d+$/.test(imdb)) return json({ streams: [] }, 0);

        const { motivos } = await avaliar(imdb, tipo, cfg);
        console.log('stream', rawId, '| ip', ipDe(request), '| link', cfgB64.slice(0, 8) || '(sem config)', '| idade', cfg.idade, '| bloqueado', motivos.length > 0);
        const streams = [];

        if (motivos.length > 0) {
          streams.push({
            name: '🔒 BLOQUEADO',
            description: motivos[0].replace(/\s*\(.*\)\s*$/, ''),
            externalUrl: `https://www.imdb.com/title/${imdb}/parentalguide/`,
          });
        }

        return json({ streams }, 0);
      }

      return json({ erro: 'não encontrado' }, 0, 404);
    } catch (e) {
      console.error(e);
      return json({ metas: [], streams: [] }, 0, 500);
    }
  },
};

const LOGO_B64 = 'iVBORw0KGgoAAAANSUhEUgAAAQAAAAEACAYAAABccqhmAAAWfmNhQlgAABZ+anVtYgAAAB5qdW1kYzJwYQARABCAAACqADibcQNjMnBhAAAAFlhqdW1iAAAAR2p1bWRjMm1hABEAEIAAAKoAOJtxA3VybjpjMnBhOjk4OTJhNzFlLTQwNzUtNDFjNC1iYzViLTNmOGZhZmNiNGEwZgAAAAOTanVtYgAAAClqdW1kYzJhcwARABCAAACqADibcQNjMnBhLmFzc2VydGlvbnMAAAAAuGp1bWIAAABEanVtZGNib3IAEQAQgAAAqgA4m3ETYzJwYS5pbmdyZWRpZW50LnYzAAAAABhjMnNotKv4M0/6L7a7L94mOZFn/AAAAGxjYm9yo2lkYzpmb3JtYXRpaW1hZ2UvcG5namluc3RhbmNlSUR4LHhtcDppaWQ6ODkyNDVkM2ItZTE1Ny00YmJmLTlhODEtMWE3NzJiZmI4YzNlbHJlbGF0aW9uc2hpcGhwYXJlbnRPZgAAAeJqdW1iAAAAQWp1bWRjYm9yABEAEIAAAKoAOJtxE2MycGEuYWN0aW9ucy52MgAAAAAYYzJzaFk08v/TxSAb8p1KuiCcQ+8AAAGZY2JvcqJnYWN0aW9uc4KiZmFjdGlvbmtjMnBhLm9wZW5lZGpwYXJhbWV0ZXJzoWtpbmdyZWRpZW50c4GiY3VybHgtc2VsZiNqdW1iZj1jMnBhLmFzc2VydGlvbnMvYzJwYS5pbmdyZWRpZW50LnYzZGhhc2hYILaLMPLSXmJ4zEaq5Z+ZhLllb4wKSS7teDiie/O+ujARpGZhY3Rpb254HWNvbS5hbnRocm9waWMuY2xhdWRlLnByb3ZpZGVkanBhcmFtZXRlcnOheB9jb20uYW50aHJvcGljLm9yaWdpbi1jb25maWRlbmNlZ3Vua25vd25rZGVzY3JpcHRpb254ZkNsYXVkZSBwcm92aWRlZCB0aGlzIGZpbGUgYXQgdGhlIHJlcXVlc3Qgb2YgYSB1c2VyIGFuZCBtYXkgaGF2ZSBjcmVhdGVkIG9yIG1vZGlmaWVkIHRoZSBmaWxlIGNvbnRlbnRzLm1zb2Z0d2FyZUFnZW50oWRuYW1lZkNsYXVkZXJhbGxBY3Rpb25zSW5jbHVkZWT1AAAAyGp1bWIAAABAanVtZGNib3IAEQAQgAAAqgA4m3ETYzJwYS5oYXNoLmRhdGEAAAAAGGMyc2gDJ9OKJZ74RKug/BCPnXIeAAAAgGNib3KlY2FsZ2ZzaGEyNTZjcGFkTQAAAAAAAAAAAAAAAABkaGFzaFgg2evyxSPbc92R9oiENNdRI1HvOQbC130bTtn572j3JYVkbmFtZW5qdW1iZiBtYW5pZmVzdGpleGNsdXNpb25zgaJlc3RhcnQYIWZsZW5ndGgZFooAAAI+anVtYgAAACdqdW1kYzJjbAARABCAAACqADibcQNjMnBhLmNsYWltLnYyAAAAAg9jYm9ypWNhbGdmc2hhMjU2aXNpZ25hdHVyZXhNc2VsZiNqdW1iZj0vYzJwYS91cm46YzJwYTo5ODkyYTcxZS00MDc1LTQxYzQtYmM1Yi0zZjhmYWZjYjRhMGYvYzJwYS5zaWduYXR1cmVqaW5zdGFuY2VJRHgseG1wOmlpZDoxNWNkOTYzMi03NjJmLTRjNzctYjUxNi04MjkxMGU4OTFmMmVyY3JlYXRlZF9hc3NlcnRpb25zg6JjdXJseC1zZWxmI2p1bWJmPWMycGEuYXNzZXJ0aW9ucy9jMnBhLmluZ3JlZGllbnQudjNkaGFzaFggtosw8tJeYnjMRqrln5mEuWVvjApJLu14OKJ78766MBGiY3VybHgqc2VsZiNqdW1iZj1jMnBhLmFzc2VydGlvbnMvYzJwYS5hY3Rpb25zLnYyZGhhc2hYILWx/h7jJGXWikvthMti5vGh6s7oLBTD6PAk9mC3iPyuomN1cmx4KXNlbGYjanVtYmY9YzJwYS5hc3NlcnRpb25zL2MycGEuaGFzaC5kYXRhZGhhc2hYIL4UJ2+km7RrLSVgLQFEOs9gcFVk0Uu1eG8yW7bC8+sgdGNsYWltX2dlbmVyYXRvcl9pbmZvo2RuYW1lb0FudGhyb3BpYyBGaWxlc2d2ZXJzaW9uZTEuMC4wa3NwZWNWZXJzaW9uZTIuNC4wAAAQOGp1bWIAAAAoanVtZGMyY3MAEQAQgAAAqgA4m3EDYzJwYS5zaWduYXR1cmUAAAAQCGNib3LShFkCEqIBJhghWQIKMIICBjCCAY2gAwIBAgIUQOWgCu7COdC+uIP6BkIFPWdVEwAwCgYIKoZIzj0EAwMwSTEXMBUGA1UEChMOQW50aHJvcGljLCBQQkMxLjAsBgNVBAMTJUFudGhyb3BpYyBDb250ZW50IENyZWRlbnRpYWxzIFJvb3QgQ0EwHhcNMjYwODA3MTg0MzU2WhcNMjgwODA2MTk0MzU2WjBEMRcwFQYDVQQKEw5BbnRocm9waWMsIFBCQzEpMCcGA1UEAxMgQW50aHJvcGljIENsYXVkZSBDb250ZW50IFNpZ25pbmcwWTATBgcqhkjOPQIBBggqhkjOPQMBBwNCAASYegpry1AYBRTVNL1CpTlbROnY3dey+UrsF9C3phYrATN3ZHf93Mo8RQN0KOUuOn19P4oWNFWe5n2/She9N7eTo1gwVjAOBgNVHQ8BAf8EBAMCB4AwFQYDVR0lBA4wDAYKKwYBBAGD6F4CATAMBgNVHRMBAf8EAjAAMB8GA1UdIwQYMBaAFM5R4gSBTmRbI/jjxM+aPpzB11zCMAoGCCqGSM49BAMDA2cAMGQCMDFzHRSeAXrSy1WOzkbhPZ6Km2wGTmZ/2gK18k8BQGXyqz88Rdrz6CTX9flAnYNVxgIwcF9c3fVhqmJKpi+UhasNUMko69cyX6STPfta3Q8EjyzDjzoyrol46FP6VFHhvUcJoWNwYWRZDZ4AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA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';
