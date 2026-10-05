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
const LOGO = 'https://raw.githubusercontent.com/Athayres/Controle-de-improprio/refs/heads/main/logo_family.jpg';

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
    const d = await tmdb(`/${tv ? 'tv' : 'movie'}/${r.id}`);
    const ov = {
      name: (tv ? d.name : d.title) || '',
      poster: d.poster_path ? TMDB_IMG + 'w500' + d.poster_path : '',
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

function manifest() {
  return {
    id: 'community.guiadospais.ptbr',
    version: '2.3.0',
    name: 'Controle de Impróprios',
    logo: LOGO,
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

const RESERVADOS = new Set(['configure', 'manifest.json', 'stream', 'meta', 'health', 'avaliar', 'registrar', 'registrar-status', 'diagnostico']);

export default {
  async fetch(request, env) {
    TMDB_KEY = env.TMDB_KEY || '';
    MDBLIST_KEY = env.MDBLIST_KEY || '';
    META_URL = String(env.META_URL || '').replace(/\/+$/, '');
    BLOQUEAR_SEM_INFO = env.BLOQUEAR_SEM_CLASSIFICACAO === '1';
    KV = env.KV || null;

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

      if (partes[0] === 'manifest.json') return json(manifest());

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
