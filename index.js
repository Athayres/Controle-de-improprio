const SELF_ID = 'community.guiadospais.ptbr';
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

const cacheGuias = new Map();
const cacheBr = new Map();
const cacheMdb = new Map();
const cachePerfis = new Map();
const findCache = new Map();
const baseCache = new Map();
const pendentes = new Map();

const GUIA_TTL = 30 * 24 * 3600 * 1000;
const NULO_TTL = 12 * 3600 * 1000;
const MDB_NULO_TTL = 3 * 24 * 3600 * 1000;
const PAREAR_TTL = 10 * 60 * 1000;
let mdbPausaAte = 0;

const HEADERS = {
    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0.0.0 Safari/537.36',
    'Accept': 'application/json'
};

const corsHeaders = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': '*',
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
    'Content-Type': 'application/json; charset=utf-8'
};

function nivelDe(v) {
  switch (String(v || '').toUpperCase().replace(/VOTES$/, '')) {
    case 'NONE': return 0;
    case 'MILD': return 1;
    case 'MODERATE': return 2;
    case 'SEVERE': return 3;
    default: return null;
  }
}

function lerConfig(b64) {
  const cfg = JSON.parse(JSON.stringify(CFG_PADRAO));
  if (!b64) return cfg;
  try {
    let b = b64.replace(/-/g, '+').replace(/_/g, '/');
    while (b.length % 4) b += '=';
    const binString = atob(b);
    const bytes = Uint8Array.from(binString, (m) => m.codePointAt(0));
    const jsonStr = new TextDecoder().decode(bytes);
    const j = JSON.parse(jsonStr);
    for (const c of CATEGORIAS) {
      const v = Number(j.max && j.max[c.key]);
      if (Number.isInteger(v) && v >= 0 && v <= 3) cfg.max[c.key] = v;
    }
    const idade = Number(j.idade);
    if ([0, 10, 12, 14, 16, 18, 99].includes(idade)) cfg.idade = idade;
  } catch (e) {
    console.error('Erro lerConfig:', e);
  }
  return cfg;
}

function ipDe(request) {
  return request.headers.get('cf-connecting-ip') || request.headers.get('x-forwarded-for') || '127.0.0.1';
}

const famUA = (ua) => String(ua || '').replace(/[\d._]+/g, '#').slice(0, 200);

function pareamentoAtivo(ip) {
  const p = pendentes.get(ip);
  if (p && Date.now() - p.t >= PAREAR_TTL) pendentes.delete(ip);
  return pendentes.has(ip);
}

function aplicarPerfil(cfg, request, capturar) {
  const ip = ipDe(request);
  const chave = ip + '|' + famUA(request.headers.get('user-agent'));
  if (capturar && pareamentoAtivo(ip)) {
    cachePerfis.set(chave, pendentes.get(ip).config);
    pendentes.delete(ip);
  }
  const reg = cachePerfis.get(chave) || cachePerfis.get(ip);
  return reg ? lerConfig(btoa(JSON.stringify(reg)).replace(/=/g, '')) : cfg;
}

function limpaDescricao(desc) {
  if (!desc) return '';
  return desc.split(/(?:CONTEÚDO BLOQUEADO|LIBERADO|GUIA DOS PAIS|• Classificação|• 👨‍👩‍👧👦|• 🔞|• 🩸|• 🤬|• 🍺|• 😱)/)[0].trim();
}

async function tmdb(caminho, params = {}, env) {
  const tmdbKey = env.TMDB_KEY || '';
  const u = new URL('https://api.themoviedb.org/3' + caminho);
  u.searchParams.set('api_key', tmdbKey);
  u.searchParams.set('language', 'pt-BR');
  for (const [k, v] of Object.entries(params)) u.searchParams.set(k, v);
  const r = await fetch(u, { signal: AbortSignal.timeout(10000), headers: HEADERS });
  if (!r.ok) throw new Error('TMDB ' + r.status);
  return r.json();
}

async function resolverImdbId(id, tipo, env) {
  const raw = id.replace(/^gpbloq:/, '');
  const cleanId = raw.split(':')[0];
  if (/^tt\d+$/.test(cleanId)) return cleanId;
  if (raw.startsWith('aiom.collection:') || raw.startsWith('tvdbc:')) return null;

  const tmdbKey = env.TMDB_KEY || '';
  if (!tmdbKey) return null;

  const tv = tipo === 'series' || tipo === 'tv';
  const ext = async (kind, n) => {
    try { return (await tmdb(`/${kind}/${n}/external_ids`, {}, env)).imdb_id || null; } catch { return null; }
  };

  const num = raw.split(':')[1] || '';
  if ((raw.startsWith('tmdb:') || raw.startsWith('tvdb:')) && !/^\d+$/.test(num)) return null;

  try {
    if (raw.startsWith('tmdb:')) return await ext(tv ? 'tv' : 'movie', num);
    if (raw.startsWith('tvdb:')) {
      const f = await tmdb(`/find/${num}`, { external_source: 'tvdb_id' }, env);
      const r = ((tv ? f.tv_results : f.movie_results) || [])[0];
      return r && r.id ? await ext(tv ? 'tv' : 'movie', r.id) : null;
    }
  } catch {}
  return null;
}

async function acharTMDB(imdbId, env) {
  if (findCache.has(imdbId)) return findCache.get(imdbId);
  const f = await tmdb(`/find/${imdbId}`, { external_source: 'imdb_id' }, env);
  if (findCache.size >= 2000) findCache.clear();
  findCache.set(imdbId, f);
  return f;
}

async function resumoPtBR(imdbId, env) {
  if (!env.TMDB_KEY) return null;
  try {
    const f = await acharTMDB(imdbId, env);
    const movie = (f.movie_results || [])[0];
    const tv = (f.tv_results || [])[0];
    if (movie) {
      const detalhe = await tmdb(`/movie/${movie.id}`, {}, env);
      if (detalhe && detalhe.overview) return detalhe.overview;
    }
    if (tv) {
      const detalhe = await tmdb(`/tv/${tv.id}`, {}, env);
      if (detalhe && detalhe.overview) return detalhe.overview;
    }
    return (movie && movie.overview) || (tv && tv.overview) || null;
  } catch { return null; }
}

async function classificacaoTMDB(imdbId, env) {
  if (!env.TMDB_KEY) return null;
  const c = cacheBr.get(imdbId);
  if (c && Date.now() - c.t < (c.v ? GUIA_TTL : NULO_TTL)) return c.v;
  try {
    const f = await acharTMDB(imdbId, env);
    let br = null;
    if (f.movie_results && f.movie_results[0]) {
      const d = await tmdb(`/movie/${f.movie_results[0].id}/release_dates`, {}, env);
      const p = d.results.find((x) => x.iso_3166_1 === 'BR');
      const rel = p && p.release_dates.find((x) => x.certification);
      br = rel ? rel.certification : null;
    } else if (f.tv_results && f.tv_results[0]) {
      const d = await tmdb(`/tv/${f.tv_results[0].id}/content_ratings`, {}, env);
      const p = d.results.find((x) => x.iso_3166_1 === 'BR');
      br = p ? p.rating || null : null;
    }
    cacheBr.set(imdbId, { t: Date.now(), v: br });
    return br;
  } catch { return null; }
}

async function baixarPaginaIMDb(imdbId) {
  try {
    const r = await fetch(`https://www.imdb.com/title/${imdbId}/parentalguide/`, {
      headers: { 'User-Agent': HEADERS['User-Agent'], 'Accept-Language': 'en-US,en;q=0.9', Accept: 'text/html,application/xhtml+xml' },
      signal: AbortSignal.timeout(6000),
    });
    return { status: r.status, html: await r.text() };
  } catch { return { status: 0, html: '' }; }
}

const GQL_QUERY = 'query($id: ID!){ title(id:$id){ parentsGuide{ categories{ category{ id text } severity{ id text votedFor } totalSeverityVotes } } } }';
async function baixarGraphQL(imdbId) {
  try {
    const r = await fetch('https://api.graphql.imdb.com/', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json', 'User-Agent': HEADERS['User-Agent'], Origin: 'https://www.imdb.com', Referer: 'https://www.imdb.com/' },
      body: JSON.stringify({ query: GQL_QUERY, variables: { id: imdbId } }),
      signal: AbortSignal.timeout(6000),
    });
    const texto = await r.text();
    let json = null;
    try { json = JSON.parse(texto); } catch {}
    return { status: r.status, json };
  } catch { return { status: 0, json: null }; }
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
  const paginaValida = p.status === 200 && (p.html.includes('__NEXT_DATA__') || /advisory-/i.test(p.html));
  return { guia: g, falhou: !g && !paginaValida };
}

const guiasFalhas = new Map();
const FALHA_TTL = 2 * 60 * 1000;

async function buscarGuia(imdbId) {
  const c = cacheGuias.get(imdbId);
  if (c && Date.now() - c.t < (c.g ? GUIA_TTL : NULO_TTL)) return c.g;
  if ((guiasFalhas.get(imdbId) || 0) > Date.now()) return undefined;

  try {
    const r = await consultarIMDb(imdbId);
    if (r.falhou) {
      guiasFalhas.set(imdbId, Date.now() + FALHA_TTL);
      return undefined;
    }
    cacheGuias.set(imdbId, { t: Date.now(), g: r.guia });
    return r.guia;
  } catch {
    return undefined;
  }
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

async function baixarMDBList(imdbId, tipo, env) {
  const mdbKey = env.MDBLIST_KEY || '';
  if (!mdbKey) return { status: 0, json: null };
  try {
    const t = tipo === 'series' ? 'show' : 'movie';
    const r = await fetch(`https://api.mdblist.com/imdb/${t}/${imdbId}/?apikey=${encodeURIComponent(mdbKey)}`, { signal: AbortSignal.timeout(10000) });
    let json = null;
    try { json = await r.json(); } catch {}
    return { status: r.status, json };
  } catch { return { status: 0, json: null }; }
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

async function classificacaoMDBList(imdbId, tipo, env) {
  if (!env.MDBLIST_KEY || Date.now() < mdbPausaAte) return null;
  const c = cacheMdb.get(imdbId);
  if (c && Date.now() - c.t < (c.v ? GUIA_TTL : MDB_NULO_TTL)) return c.v;
  const r = await baixarMDBList(imdbId, tipo, env);
  if (r.status === 429) {
    mdbPausaAte = Date.now() + 3600 * 1000;
    return null;
  }
  if (r.status !== 200 || !r.json) return null;
  const v = faixaDoMDBList(r.json);
  cacheMdb.set(imdbId, { t: Date.now(), v });
  return v;
}

async function classificacaoBR(imdbId, tipo, env) {
  const tm = await classificacaoTMDB(imdbId, env);
  if (tm) return tm;
  return classificacaoMDBList(imdbId, tipo, env);
}

function idadeDeBR(br) {
  if (br == null) return null;
  const t = String(br).trim();
  if (/^(l|livre)$/i.test(t)) return 0;
  const n = parseInt(t.replace(/\D/g, ''), 10);
  return Number.isFinite(n) ? n : null;
}

function motivosBloqueio(cfg, br, guia, env) {
  const bloquearSemInfo = env.BLOQUEAR_SEM_CLASSIFICACAO === '1';
  const motivos = [];
  if (cfg.idade === 18) return motivos;

  let liberadoPorIdade = false;

  if (cfg.idade < 18) {
    const limite = cfg.idade === 0 ? 1 : cfg.idade;
    const idade = idadeDeBR(br);
    if (idade === null) {
      if (bloquearSemInfo) motivos.push('Sem classificação indicativa conhecida');
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
    } else if (guia === null && bloquearSemInfo) {
      motivos.push('Título sem Guia dos Pais no IMDb');
    }
  }
  return motivos;
}

const TMDB_IMG = 'https://image.tmdb.org/t/p/';
async function tmdbOverlay(imdb, tipo, env) {
  const tmdbKey = env.TMDB_KEY || '';
  if (!tmdbKey) return null;
  try {
    const tv = tipo === 'series';
    const f = await acharTMDB(imdb, env);
    const r = ((tv ? f.tv_results : f.movie_results) || [])[0];
    if (!r || !r.id) return null;
    const d = await tmdb(`/${tv ? 'tv' : 'movie'}/${r.id}`, {}, env);
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
        tmdb(`/tv/${r.id}`, { append_to_response: l.map((n) => 'season/' + n).join(',') }, env).catch(() => null)));
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

async function avaliar(imdb, tipo, cfg, env) {
  const [guia, br] = await Promise.all([
    buscarGuia(imdb).catch(() => undefined),
    classificacaoBR(imdb, tipo, env).catch(() => null),
  ]);
  return { guia, br, motivos: motivosBloqueio(cfg, br, guia, env) };
}

const BASE_TTL = 6 * 3600 * 1000;
const BASE_TIMEOUT = 5000;

async function meta(tipo, id, cfg, userAgent, env) {
  const imdb = await resolverImdbId(id, tipo, env);
  if (!imdb || !/^tt\d+$/.test(imdb)) return null;

  const buscarBase = async () => {
    const chave = `${tipo}|${id}|${imdb}`;
    const c = baseCache.get(chave);
    if (c && Date.now() - c.t < BASE_TTL) return structuredClone(c.m);

    const pegar = async (url) => {
      try {
        const r = await fetch(url, { signal: AbortSignal.timeout(BASE_TIMEOUT) });
        if (r.ok) { const m = (await r.json()).meta; if (m) return m; }
      } catch {}
      return null;
    };

    const tmdbKey = env.TMDB_KEY || '';
    const usaTmdb = !!tmdbKey && id === imdb;
    const ov = usaTmdb ? await tmdbOverlay(imdb, tipo, env) : null;
    let m = await pegar(`https://v3-cinemeta.strem.io/meta/${tipo}/${imdb}.json`);
    
    if (!m && env.META_URL) {
      const metaUrl = env.META_URL.replace(/\/+$/, '');
      const ids = [id, imdb].filter((v, i, a) => a.indexOf(v) === i);
      const rs = await Promise.all(ids.map((cid) => pegar(`${metaUrl}/meta/${tipo}/${cid}.json`)));
      m = rs.find(Boolean) || null;
    }
    if (!m && ov) m = { id: imdb, type: tipo };
    if (m && ov) aplicarTmdb(m, ov);
    if (m) {
      if (baseCache.size >= 500) baseCache.clear();
      baseCache.set(chave, { t: Date.now(), m: structuredClone(m) });
    }
    return m;
  };

  const [baseMeta, { guia, br }, resumo] = await Promise.all([
    buscarBase(),
    avaliar(imdb, tipo, cfg, env),
    resumoPtBR(imdb, env).catch(() => null),
  ]);
  
  const base = baseMeta || { id: id, type: tipo, name: imdb, description: '', genres: [] };
  const { motivos } = motivosBloqueio(cfg, br, guia, env);
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
      base.description = `${original}\n\n${textoGuiaPais}`;
    } else {
      base.description = original || textoGuiaPais;
    }
  } else {
    base.description = original;
    const novasTags = [];
    if (classificacaoFinal) novasTags.push(`👨‍‍👩‍👧‍👦 ${rotuloClassificacao(classificacaoFinal)}`);
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

  return { meta: base, bloqueado, motivos, incompleto: guia === undefined };
}

function manifest() {
  return {
    id: SELF_ID,
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

function paginaConfig(cfg, host, protocol) {
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
    var proto = '${protocol}:';
    var host = '${host}';
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
      m.textContent = 'Agora abra um título no Stremio no aparelho que quer registrar.';
      var t0 = Date.now();
      pollReg = setInterval(function(){
        fetch('/registrar-status').then(function(r){ return r.json(); }).then(function(st){
          if (!st.pendente) { clearInterval(pollReg); m.textContent = 'Registrado com sucesso!'; }
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
      ...corsHeaders,
      'Cache-Control': maxAge ? `public, max-age=${maxAge}` : 'no-cache, no-store, must-revalidate',
    }
  });
}

const TIPOS_OK = new Set(['movie', 'series']);
function paramsOk(tipo, id) { return TIPOS_OK.has(tipo) && /^[A-Za-z0-9_.:-]{1,100}$/.test(id); }
const RESERVADOS = new Set(['configure', 'manifest.json', 'stream', 'meta', 'health', 'avaliar', 'registrar', 'registrar-status']);

export default {
  async fetch(request, env, ctx) {
    try {
      if (request.method === 'OPTIONS') {
        return new Response(null, { status: 204, headers: corsHeaders });
      }

      const url = new URL(request.url);
      const pathname = url.pathname;
      const partes = pathname.split('/').filter(Boolean);
      const host = url.host;
      const protocol = url.protocol.replace(':', '');

      if (!partes.length) {
        return Response.redirect(`${url.origin}/configure`, 302);
      }
      if (partes[0] === 'health') return json({ ok: true });

      const cfgB64 = RESERVADOS.has(partes[0]) ? '' : partes.shift();
      const cfg = aplicarPerfil(lerConfig(cfgB64), request, partes[0] === 'meta' || partes[0] === 'stream');
      const dec = (s) => decodeURIComponent((s || '').replace(/\.json$/, ''));

      if (partes[0] === 'configure') {
        return new Response(paginaConfig(cfg, host, protocol), { headers: { 'Content-Type': 'text/html; charset=utf-8' } });
      }
      if (partes[0] === 'registrar') {
        const ip = ipDe(request);
        const c = lerConfig(dec(partes[1]));
        pendentes.set(ip, { config: c, t: Date.now() });
        return json({ ok: true, ip, config: c });
      }
      if (partes[0] === 'registrar-status') return json({ pendente: pareamentoAtivo(ipDe(request)) });

      if (partes[0] === 'manifest.json') return json(manifest());

      if (partes[0] === 'meta') {
        const tipo = dec(partes[1]);
        const id = dec(partes[2]);
        if (!paramsOk(tipo, id)) return json({ meta: null });
        const userAgent = request.headers.get('user-agent') || '';
        const r = await meta(tipo, id, cfg, userAgent, env);
        if (!r) return json({ meta: null });
        return json({ meta: r.meta }, r.incompleto ? 0 : 300);
      }

      if (partes[0] === 'avaliar') {
        const tipo = dec(partes[1]);
        const rawId = dec(partes[2]);
        if (!paramsOk(tipo, rawId)) return json({ erro: 'parâmetros inválidos' }, 0, 400);
        const imdb = await resolverImdbId(rawId, tipo, env);
        if (!imdb || !/^tt\d+$/.test(imdb)) return json({ erro: 'ID inválido' }, 0, 400);
        const r = await avaliar(imdb, tipo, cfg, env);
        return json({ imdb, ip: ipDe(request), config: cfg, classificacaoBR: r.br, guia: r.guia, bloqueado: r.motivos.length > 0, motivos: r.motivos });
      }

      if (partes[0] === 'stream') {
        const tipo = dec(partes[1]);
        const rawId = dec(partes[2]);
        if (!paramsOk(tipo, rawId)) return json({ streams: [] });
        const imdb = await resolverImdbId(rawId, tipo, env);
        if (!imdb || !/^tt\d+$/.test(imdb)) return json({ streams: [] });
        
        const { motivos } = await avaliar(imdb, tipo, cfg, env);
        const streams = [];

        if (motivos.length > 0) {
          streams.push({
            name: '🔒 BLOQUEADO',
            description: motivos[0].replace(/\s*\(.*\)\s*$/, ''),
            externalUrl: `https://www.imdb.com/title/${imdb}/parentalguide/`,
          });
        }

        return json({ streams });
      }

      return json({ erro: 'não encontrado' }, 0, 404);
    } catch (err) {
      return new Response(JSON.stringify({ error: err.message, stack: err.stack }), {
        status: 500,
        headers: corsHeaders
      });
    }
  }
};