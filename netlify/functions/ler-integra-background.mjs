/* Leitura da íntegra dos autos (aba Ações Judiciais) — função em SEGUNDO PLANO.
   O app sobe o PDF no Storage (bucket "documentos", pasta judicial/integras/) e chama esta função com:
     POST (content-type text/plain, para não disparar CORS preflight)
     corpo JSON: { jobId, path, token, anon, proc: { titulo, numero, cliente, polo, classe, juizo, status, ultimaMov, conferido, ultimoHist } }
   A função responde 202 na hora (Netlify) e, em segundo plano:
     1) confere que o token é de um usuário logado do sistema;
     2) baixa o PDF do Storage com o próprio token do usuário;
     3) pede à API da Anthropic a leitura estruturada dos autos;
     4) grava o resultado em documentos/jud-leituras/<jobId>.json (o app fica consultando).
   Nada é gravado no processo aqui: o app mostra a leitura e só aplica o que o usuário confirmar.
   Variáveis: ANTHROPIC_API_KEY (segredo), ANTHROPIC_MODEL (opcional), SUPABASE_SERVICE_KEY (opcional). */

const SB_URL = 'https://qbomgbjcwatlruavvnvk.supabase.co';
const BUCKET = 'documentos';
const MODEL = process.env.ANTHROPIC_MODEL || 'claude-sonnet-5';

const INSTRUCOES = `Você lê a íntegra de autos judiciais ou administrativos brasileiros (PDF exportado do e-SAJ, eproc, PJe ou similar) para atualizar a carteira de processos de um escritório.
Responda SOMENTE com um objeto JSON válido, sem texto antes ou depois, sem cercas de código, com este formato:
{
 "numero": "número do processo como consta nos autos",
 "classe": "", "juizo": "vara/órgão", "juiz": "nome do(a) magistrado(a), se constar",
 "segredo": true | false,
 "ultima_movimentacao": {"data": "DD/MM/AAAA", "texto": "o último ato relevante dos autos, em uma ou duas frases"},
 "movimentos": [{"data": "DD/MM/AAAA", "texto": "ato relevante, objetivo"}],
 "status": "situação atual do processo em uma frase",
 "prazos": [{"data_limite": "AAAA-MM-DD ou vazio", "descricao": "o que precisa ser feito", "origem": "intimação/publicação que abriu o prazo, com data"}],
 "fatos": ["fatos relevantes que constam dos autos"],
 "pendencias": ["o que está pendente de decisão, cumprimento ou providência"],
 "juntados": ["documentos relevantes já juntados (para não pedir de novo)"],
 "observacoes": "páginas ilegíveis, trechos cortados, dúvidas"
}
Regras:
- "movimentos": do mais recente para o mais antigo, no máximo 25, só atos que importam para a condução (decisões, sentenças, intimações, petições relevantes, audiências, perícias, pagamentos). Priorize os posteriores à data de referência informada.
- Prazos: conte em dias úteis quando for prazo processual civil; se não houver como calcular com segurança, deixe "data_limite" vazio e explique em "origem".
- Não invente: se algo não constar dos autos, deixe vazio. Linguagem objetiva, sem juridiquês desnecessário.`;

async function usuario(token, anon) {
  const r = await fetch(SB_URL + '/auth/v1/user', { headers: { apikey: anon, Authorization: 'Bearer ' + token } });
  return r.ok ? r.json() : null;
}

async function gravar(token, anon, jobId, obj) {
  const url = `${SB_URL}/storage/v1/object/${BUCKET}/jud-leituras/${encodeURIComponent(jobId)}.json`;
  const sk = process.env.SUPABASE_SERVICE_KEY || '';
  const h = sk ? (sk.startsWith('sb_secret_') ? { apikey: sk } : { apikey: sk, Authorization: 'Bearer ' + sk })
               : { apikey: anon, Authorization: 'Bearer ' + token };
  const r = await fetch(url, { method: 'POST', headers: Object.assign({ 'content-type': 'application/json', 'x-upsert': 'true' }, h), body: JSON.stringify(obj) });
  if (!r.ok) console.error('[ler-integra] falha ao gravar resultado', r.status, await r.text());
}

function contexto(p) {
  p = p || {};
  return [
    'Processo cadastrado na carteira:',
    'Ação: ' + (p.titulo || '—'), 'Número: ' + (p.numero || '—'), 'Cliente: ' + (p.cliente || '—'),
    'Posição do cliente: ' + (p.polo || '—'), 'Classe: ' + (p.classe || '—'), 'Juízo: ' + (p.juizo || '—'),
    'Status registrado: ' + (p.status || '—'),
    'Última movimentação registrada: ' + String(p.ultimaMov || '—').replace(/<[^>]+>/g, ' ').slice(0, 600),
    'Data de referência (última conferência): ' + (p.conferido || p.ultimoHist || 'nenhuma'),
    '', 'Leia a íntegra anexa e devolva o JSON.'
  ].join('\n');
}

export default async (request) => {
  if (request.method !== 'POST') return;
  let jobId = 'sem-id', token = '', anon = '';
  try {
    const body = JSON.parse(await request.text());
    jobId = String(body.jobId || '').replace(/[^A-Za-z0-9_-]/g, '').slice(0, 80) || 'sem-id';
    token = String(body.token || '');
    anon = String(body.anon || '');
    const u = token && anon ? await usuario(token, anon) : null;
    if (!u) { console.error('[ler-integra] sessão inválida'); return; }

    if (!process.env.ANTHROPIC_API_KEY) throw new Error('ANTHROPIC_API_KEY não configurada no Netlify.');
    const path = String(body.path || '');
    if (!path || path.includes('..') || !path.startsWith('judicial/integras/')) throw new Error('Caminho do PDF inválido.');
    const pr = await fetch(`${SB_URL}/storage/v1/object/authenticated/${BUCKET}/${path.split('/').map(encodeURIComponent).join('/')}`,
      { headers: { apikey: anon, Authorization: 'Bearer ' + token } });
    if (!pr.ok) throw new Error('Não consegui baixar o PDF do Storage (' + pr.status + ').');
    const buf = Buffer.from(await pr.arrayBuffer());
    if (buf.length > 32 * 1024 * 1024) throw new Error('PDF acima de 32 MB. Exporte só as peças a partir da última conferência e suba de novo.');
    const b64 = buf.toString('base64');

    const ar = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: { 'x-api-key': process.env.ANTHROPIC_API_KEY, 'anthropic-version': '2023-06-01', 'content-type': 'application/json' },
      body: JSON.stringify({
        model: MODEL, max_tokens: 8000, system: INSTRUCOES,
        messages: [{ role: 'user', content: [
          { type: 'document', source: { type: 'base64', media_type: 'application/pdf', data: b64 } },
          { type: 'text', text: contexto(body.proc) } ] }],
      }),
    });
    const aj = await ar.json();
    if (!ar.ok) {
      const m = (aj.error && aj.error.message) || String(ar.status);
      if (/page|pages|too large|too long|prompt is too long/i.test(m))
        throw new Error('Íntegra longa demais para uma leitura só. Exporte só as peças a partir da última conferência (ou divida o PDF) e suba de novo. Detalhe: ' + m);
      throw new Error('API Anthropic: ' + m);
    }
    const txt = (aj.content || []).filter(c => c.type === 'text').map(c => c.text).join('').replace(/```json|```/g, '').trim();
    const ini = txt.indexOf('{'), fim = txt.lastIndexOf('}');
    const leitura = JSON.parse(txt.slice(ini, fim + 1));
    await gravar(token, anon, jobId, { estado: 'pronto', fim: new Date().toISOString(), modelo: MODEL, leitura,
      uso: aj.usage || null, por: u.email || u.id });
  } catch (e) {
    console.error('[ler-integra]', e);
    if (token && anon) await gravar(token, anon, jobId, { estado: 'erro', erro: String(e && e.message || e) });
  }
};
