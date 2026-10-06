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
    version: '2.3.2',
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

const LOGO_B64 = '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';
