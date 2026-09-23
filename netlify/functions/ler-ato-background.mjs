/* Leitura de ato societário assinado (aba JUCESP) — função em SEGUNDO PLANO.
   O app sobe o PDF no Storage (bucket "documentos") e chama esta função com:
     POST (content-type text/plain, sem cabeçalhos extras, para não disparar CORS preflight)
     corpo JSON: { jobId, path, token: <token da sessão>, anon: <anon key do app> }
   A função responde 202 na hora (Netlify) e, em segundo plano:
     1) confere que o token é de um usuário logado do sistema;
     2) baixa o PDF do Storage com o próprio token do usuário;
     3) pede à API da Anthropic a leitura estruturada do ato;
     4) aplica as REGRAS FIXAS (Viabilidade/DBE/sistema VRE) — não depende da IA para isso;
     5) grava o resultado em documentos/jucesp-leituras/<jobId>.json (o app fica consultando).
   Variáveis: ANTHROPIC_API_KEY (segredo), ANTHROPIC_MODEL (opcional). */

const SB_URL = 'https://qbomgbjcwatlruavvnvk.supabase.co';
const BUCKET = 'documentos';
const MODEL = process.env.ANTHROPIC_MODEL || 'claude-sonnet-5';

/* ---------- regras (fonte: JUCESP, página "Empresas": Viabilidade → DBE → Registro) ---------- */
const ATOS = {
  constituicao:               { rot: 'Constituição',                         viab: true,  dbe: true  },
  alteracao_endereco:         { rot: 'Alteração de endereço',                viab: true,  dbe: true  },
  alteracao_nome:             { rot: 'Alteração de nome empresarial',        viab: true,  dbe: true  },
  alteracao_atividades:       { rot: 'Alteração de atividades econômicas',   viab: true,  dbe: true  },
  alteracao_natureza_juridica:{ rot: 'Alteração de natureza jurídica',       viab: true,  dbe: true  },
  alteracao_tipo_unidade:     { rot: 'Alteração de tipo de unidade / forma de atuação', viab: true, dbe: true },
  abertura_filial:            { rot: 'Abertura de filial',                   viab: true,  dbe: true  },
  encerramento_filial:        { rot: 'Encerramento de filial',               viab: false, dbe: true  },
  entrada_socio:              { rot: 'Entrada de sócio',                     viab: false, dbe: true  },
  saida_socio:                { rot: 'Saída de sócio',                       viab: false, dbe: true  },
  cessao_quotas:              { rot: 'Cessão / transferência de quotas',     viab: false, dbe: true  },
  alteracao_administrador:    { rot: 'Alteração de administrador',           viab: false, dbe: true  },
  aumento_capital:            { rot: 'Aumento de capital',                   viab: false, dbe: true  },
  reducao_capital:            { rot: 'Redução de capital',                   viab: false, dbe: true  },
  extincao:                   { rot: 'Extinção / distrato',                  viab: false, dbe: true  },
  consolidacao:               { rot: 'Consolidação do contrato',             viab: false, dbe: false },
  sem_reflexo:                { rot: 'Deliberação sem reflexo em Prefeitura/Receita', viab: false, dbe: false },
  outro:                      { rot: 'Outro (conferir)',                     viab: null,  dbe: null  },
};

function decidir(r) {
  const dels = Array.isArray(r.deliberacoes) ? r.deliberacoes : [];
  let viab = false, dbe = false, duvida = false;
  const motivosV = [], motivosD = [];
  dels.forEach((d, i) => {
    const a = ATOS[d.ato] || ATOS.outro;
    d.ato_rotulo = a.rot;
    d.exige_viabilidade = a.viab; d.exige_dbe = a.dbe;
    if (a.viab === null || (d.confianca || '') === 'baixa') { d.conferir = true; duvida = true; }
    if (a.viab) { viab = true; motivosV.push(i + 1); }
    if (a.dbe) { dbe = true; motivosD.push(i + 1); }
  });
  const nat = String(r.natureza_juridica || '').toLowerCase();
  const mun = String((r.empresa && r.empresa.municipio) || '').toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '');
  const ehConst = dels.some(d => d.ato === 'constituicao') || r.tipo_ato === 'constituicao';
  const ltdaOuEi = /limitada|ltda|empresario|empresária|empresaria|unipessoal/.test(nat);
  const capital = /^sao paulo\b/.test(mun);
  let sistema = 'VRE';
  let sistemaMotivo = 'Alteração, ou constituição fora do caso do VRE|Digital.';
  if (ehConst && ltdaOuEi && capital) { sistema = 'VRE Digital'; sistemaMotivo = 'Constituição de LTDA/Empresário Individual no Município de São Paulo.'; }
  else if (ehConst && ltdaOuEi && !mun) { sistema = 'VRE ou VRE Digital (conferir município)'; sistemaMotivo = 'Município não identificado no ato.'; duvida = true; }
  const ordem = viab && dbe ? ['Viabilidade', 'DBE (Coletor Nacional)', 'Registro (VRE)']
             : dbe ? ['DBE (Coletor Nacional)', 'Registro (VRE)'] : ['Registro (VRE)'];
  return { viabilidade: viab, dbe, motivos_viabilidade: motivosV, motivos_dbe: motivosD,
           sistema, sistema_motivo: sistemaMotivo, ordem, tem_duvida: duvida,
           fonte_regra: 'JUCESP — institucional, página "Empresas" (Viabilidade → Coletor Nacional (DBE) → Registro)' };
}

const INSTRUCOES = `Você lê atos societários brasileiros assinados (contrato social, alteração contratual, ata de reunião/assembleia de sócios, AGE/AGO, distrato) para preparar o registro na JUCESP.
Responda SOMENTE com um objeto JSON válido, sem texto antes ou depois, sem cercas de código, com este formato:
{
 "tipo_ato": "constituicao" | "alteracao_contratual" | "ata_reuniao_socios" | "ata_assembleia" | "distrato" | "outro",
 "tipo_ato_texto": "como o documento se intitula",
 "natureza_juridica": "ex.: Sociedade Limitada, Sociedade Anônima Fechada, Empresário Individual",
 "empresa": {"razao_social":"", "cnpj":"só dígitos ou vazio", "nire":"só dígitos ou vazio", "endereco":"", "municipio":"", "uf":""},
 "estabelecimento": "matriz" | "filial",
 "data_ato": "DD/MM/AAAA ou vazio",
 "deliberacoes": [{"texto":"resumo objetivo da deliberação", "trecho":"trecho literal curto (até 25 palavras) que a sustenta", "ato":"<código>", "confianca":"alta"|"media"|"baixa"}],
 "signatarios": [{"nome":"", "cargo":"administrador | sócio | presidente | secretário | diretor | outro"}],
 "administradores": [{"nome":"", "cargo":""}],
 "observacoes": "pontos que merecem conferência humana (ilegibilidade, ambiguidade, divergência de dados)"
}
Códigos permitidos em "ato": constituicao, alteracao_endereco, alteracao_nome, alteracao_atividades, alteracao_natureza_juridica, alteracao_tipo_unidade, abertura_filial, encerramento_filial, entrada_socio, saida_socio, cessao_quotas, alteracao_administrador, aumento_capital, reducao_capital, extincao, consolidacao, sem_reflexo, outro.
Regras: uma deliberação por mudança efetiva (ex.: cessão de quotas que admite novo sócio = duas deliberações: cessao_quotas e entrada_socio). Aprovação de contas, eleição que apenas reconduz o mesmo administrador e consolidação sem mudança = sem_reflexo ou consolidacao. Não invente dados: campo ausente fica vazio. Se ficar em dúvida, use confianca "baixa" e explique em observacoes.`;

async function usuario(token, anon) {
  const r = await fetch(SB_URL + '/auth/v1/user', { headers: { apikey: anon, Authorization: 'Bearer ' + token } });
  return r.ok ? r.json() : null;
}

async function gravar(token, anon, jobId, obj) {
  const url = `${SB_URL}/storage/v1/object/${BUCKET}/jucesp-leituras/${encodeURIComponent(jobId)}.json`;
  const r = await fetch(url, { method: 'POST', headers: { apikey: anon, Authorization: 'Bearer ' + token, 'content-type': 'application/json', 'x-upsert': 'true' }, body: JSON.stringify(obj) });
  if (!r.ok) console.error('[ler-ato] falha ao gravar resultado', r.status, await r.text());
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
    if (!u) { console.error('[ler-ato] sessão inválida'); return; }
    await gravar(token, anon, jobId, { estado: 'lendo', inicio: new Date().toISOString() });

    if (!process.env.ANTHROPIC_API_KEY) throw new Error('ANTHROPIC_API_KEY não configurada no Netlify.');
    const path = String(body.path || '');
    if (!path || path.includes('..')) throw new Error('Caminho do PDF inválido.');
    const pr = await fetch(`${SB_URL}/storage/v1/object/authenticated/${BUCKET}/${path.split('/').map(encodeURIComponent).join('/')}`,
      { headers: { apikey: anon, Authorization: 'Bearer ' + token } });
    if (!pr.ok) throw new Error('Não consegui baixar o PDF do Storage (' + pr.status + ').');
    const b64 = Buffer.from(await pr.arrayBuffer()).toString('base64');

    const ar = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: { 'x-api-key': process.env.ANTHROPIC_API_KEY, 'anthropic-version': '2023-06-01', 'content-type': 'application/json' },
      body: JSON.stringify({
        model: MODEL, max_tokens: 4000, system: INSTRUCOES,
        messages: [{ role: 'user', content: [
          { type: 'document', source: { type: 'base64', media_type: 'application/pdf', data: b64 } },
          { type: 'text', text: 'Leia este ato e devolva o JSON.' } ] }],
      }),
    });
    const aj = await ar.json();
    if (!ar.ok) throw new Error('API Anthropic: ' + (aj.error && aj.error.message || ar.status));
    const txt = (aj.content || []).filter(c => c.type === 'text').map(c => c.text).join('').replace(/```json|```/g, '').trim();
    const ini = txt.indexOf('{'), fim = txt.lastIndexOf('}');
    const leitura = JSON.parse(txt.slice(ini, fim + 1));
    if (leitura.empresa) {
      leitura.empresa.nire = String(leitura.empresa.nire || '').replace(/\D/g, '');
      leitura.empresa.cnpj = String(leitura.empresa.cnpj || '').replace(/\D/g, '');
    }
    const decisao = decidir(leitura);
    await gravar(token, anon, jobId, { estado: 'pronto', fim: new Date().toISOString(), modelo: MODEL, leitura, decisao,
      uso: aj.usage || null, por: u.email || u.id });
  } catch (e) {
    console.error('[ler-ato]', e);
    if (token && anon) await gravar(token, anon, jobId, { estado: 'erro', erro: String(e && e.message || e) });
  }
};
