/* Consulta de processo na API Pública do DataJud (CNJ) — sob demanda, para o app.
   POST (JSON) { numero, token, anon }  → { ok, tribunal, processo: {classe, orgao, grau, dataAjuizamento, atualizado}, movimentos:[{data, nome, complementos}] }
   Só atende usuário logado no sistema (token da sessão Supabase).
   Variável: DATAJUD_API_KEY (chave pública do CNJ — publicada na wiki do DataJud). */

const SB_URL = 'https://qbomgbjcwatlruavvnvk.supabase.co';
const UF = {'01':'ac','02':'al','03':'ap','04':'am','05':'ba','06':'ce','07':'dft','08':'es','09':'go','10':'ma','11':'mt','12':'ms','13':'mg','14':'pa','15':'pb','16':'pr','17':'pe','18':'pi','19':'rj','20':'rn','21':'rs','22':'ro','23':'rr','24':'sc','25':'se','26':'sp','27':'to'};

export function aliasTribunal(numero) {
  const d = String(numero || '').replace(/\D/g, '');
  if (d.length !== 20) return null;
  const j = d[13], tr = d.slice(14, 16);
  if (j === '8') return UF[tr] ? 'api_publica_tj' + UF[tr] : null;
  if (j === '4') return 'api_publica_trf' + String(Number(tr));
  if (j === '5') return 'api_publica_trt' + String(Number(tr));
  if (j === '3') return 'api_publica_stj';
  return null;
}

export async function consultaDataJud(numero) {
  const alias = aliasTribunal(numero);
  if (!alias) return { ok: false, erro: 'Número fora do padrão CNJ ou tribunal não mapeado.' };
  const key = process.env.DATAJUD_API_KEY;
  if (!key) return { ok: false, erro: 'DATAJUD_API_KEY não configurada.' };
  const r = await fetch(`https://api-publica.datajud.cnj.jus.br/${alias}/_search`, {
    method: 'POST',
    headers: { Authorization: 'APIKey ' + key, 'content-type': 'application/json' },
    body: JSON.stringify({ query: { match: { numeroProcesso: String(numero).replace(/\D/g, '') } }, size: 5 }),
  });
  if (r.status === 401 || r.status === 403) return { ok: false, erro: 'Chave do DataJud recusada — o CNJ pode ter trocado a chave pública.' };
  if (!r.ok) return { ok: false, erro: 'DataJud respondeu ' + r.status };
  const j = await r.json();
  const hits = (j.hits && j.hits.hits) || [];
  if (!hits.length) return { ok: true, tribunal: alias, encontrado: false, movimentos: [] };
  const movs = [];
  let proc = null;
  hits.forEach(h => {
    const s = h._source || {};
    if (!proc || String(s.dataHoraUltimaAtualizacao || '') > String(proc.atualizado || '')) {
      proc = { classe: s.classe && s.classe.nome, orgao: s.orgaoJulgador && s.orgaoJulgador.nome, grau: s.grau,
               dataAjuizamento: s.dataAjuizamento, atualizado: s.dataHoraUltimaAtualizacao, sistema: s.sistema && s.sistema.nome };
    }
    (s.movimentos || []).forEach(m => movs.push({
      data: m.dataHora, nome: m.nome, codigo: m.codigo, grau: s.grau,
      complementos: (m.complementosTabelados || []).map(c => [c.nome, c.valor, c.descricao].filter(Boolean).join(': ')).join('; '),
    }));
  });
  const vistos = new Set();
  const unicos = movs.filter(m => { const k = m.data + '|' + m.codigo + '|' + m.grau; if (vistos.has(k)) return false; vistos.add(k); return true; })
    .sort((a, b) => String(b.data).localeCompare(String(a.data)));
  return { ok: true, tribunal: alias, encontrado: true, processo: proc, movimentos: unicos };
}

const CORS = { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Headers': 'content-type', 'Access-Control-Allow-Methods': 'POST, OPTIONS', 'content-type': 'application/json' };

export default async (request) => {
  if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: CORS });
  try {
    const b = await request.json();
    const u = await fetch(SB_URL + '/auth/v1/user', { headers: { apikey: String(b.anon || ''), Authorization: 'Bearer ' + String(b.token || '') } });
    if (!u.ok) return new Response(JSON.stringify({ ok: false, erro: 'Sessão inválida.' }), { status: 401, headers: CORS });
    const res = await consultaDataJud(b.numero);
    return new Response(JSON.stringify(res), { status: 200, headers: CORS });
  } catch (e) {
    return new Response(JSON.stringify({ ok: false, erro: String(e && e.message || e) }), { status: 500, headers: CORS });
  }
};
