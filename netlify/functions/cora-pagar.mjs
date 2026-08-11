/* Pagamento de saída (Cora / mTLS) — INICIA o pagamento; a APROVAÇÃO final
   é feita pela pessoa no app da Cora ("dar o ok"). Formato moderno (V2).
   POST JSON:
     { conta:'trust|rotta|buffet', tipo:'ted'|'boleto', ... }
     ted:    { valor, nomeFav, docFav, banco, agencia, conta_fav, contaTipo, descricao, data? }
     boleto: { linha, data? }
   Usa as mesmas credenciais por conta das outras funções. */
import https from 'node:https';
import crypto from 'node:crypto';

const HOSTS = {
  stage: 'matls-clients.api.stage.cora.com.br',
  prod:  'matls-clients.api.cora.com.br',
};

function pem(v) {
  if (!v) return v;
  v = String(v).trim().replace(/\\n/g, '\n');
  if (v.indexOf('BEGIN') === -1) { try { return Buffer.from(v, 'base64').toString('utf8'); } catch (e) { return v; } }
  const m = v.match(/-----BEGIN ([A-Za-z0-9 ]+)-----([\s\S]*?)-----END \1-----/);
  if (!m) return v;
  const body = m[2].replace(/[^A-Za-z0-9+/=]/g, '');
  const lines = body.match(/.{1,64}/g) || [];
  return '-----BEGIN ' + m[1].trim() + '-----\n' + lines.join('\n') + '\n-----END ' + m[1].trim() + '-----\n';
}
function credenciais(conta) {
  conta = String(conta || 'trust').toLowerCase();
  const UP = conta.toUpperCase();
  const env = String(process.env['CORA_' + UP + '_ENV'] || process.env.CORA_ENV || 'stage').toLowerCase();
  const g = (suf) => process.env['CORA_' + UP + '_' + suf] || (conta === 'trust' ? process.env['CORA_' + suf] : undefined);
  return { conta, env, cid: g('CLIENT_ID'), cert: pem(g('CERT')), key: pem(g('KEY')) };
}
function httpReq(opts, body) {
  return new Promise((resolve, reject) => {
    const r = https.request(opts, (res) => { let d = ''; res.on('data', c => d += c); res.on('end', () => resolve({ status: res.statusCode, body: d })); });
    r.on('error', reject); if (body) r.write(body); r.end();
  });
}
function so(o) { return Object.keys(o).reduce((a, k) => { if (o[k] !== undefined && o[k] !== '') a[k] = o[k]; return a; }, {}); }

export default async (request) => {
  const headers = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'authorization, content-type',
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    'content-type': 'application/json',
  };
  if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers });
  if (request.method !== 'POST') return new Response(JSON.stringify({ ok: false, erro: 'Use POST.' }), { status: 405, headers });

  try {
    const b = await request.json().catch(() => ({}));
    const { conta, env, cid, cert, key } = credenciais(b.conta);
    const host = HOSTS[env] || HOSTS.stage;
    if (!cid || !cert || !key) return new Response(JSON.stringify({ ok: false, erro: 'Faltam credenciais da conta "' + conta + '".' }), { status: 500, headers });

    // token
    const form = 'grant_type=client_credentials&client_id=' + encodeURIComponent(cid);
    const tok = await httpReq({ host, port: 443, path: '/token', method: 'POST', cert, key, headers: { 'content-type': 'application/x-www-form-urlencoded', 'content-length': Buffer.byteLength(form) } }, form);
    if (tok.status !== 200) return new Response(JSON.stringify({ ok: false, etapa: 'token', status: tok.status, resposta: tok.body }), { status: 502, headers });
    const access = JSON.parse(tok.body).access_token;

    let path, payload;
    if (b.tipo === 'boleto') {
      path = '/payments/initiate';
      payload = so({ digitable_line: b.linha, scheduled_at: b.data });
    } else if (b.tipo === 'ted') {
      path = '/transfers/initiate';
      payload = so({
        amount: Math.round(Number(b.valor) * 100),
        description: b.descricao,
        scheduled: b.data,
        destination: so({
          bank_code: b.banco,
          branch_number: b.agencia,
          account_number: b.conta_fav,
          account_type: b.contaTipo || 'CHECKING',
          holder: so({ name: b.nomeFav, document: (String(b.docFav||'').replace(/\D/g,'').length ? {identity:String(b.docFav||'').replace(/\D/g,''), type:(String(b.docFav||'').replace(/\D/g,'').length>11?'CNPJ':'CPF')} : undefined) }),
        }),
      });
    } else {
      return new Response(JSON.stringify({ ok: false, erro: 'tipo inválido (use "ted" ou "boleto").' }), { status: 400, headers });
    }

    const bodyStr = JSON.stringify(payload);
    const res = await httpReq({
      host, port: 443, path, method: 'POST', cert, key,
      headers: { authorization: 'Bearer ' + access, 'content-type': 'application/json', 'Idempotency-Key': crypto.randomUUID(), 'content-length': Buffer.byteLength(bodyStr) },
    }, bodyStr);
    // devolve o que a Cora respondeu (status + corpo) para o sistema exibir
    return new Response(res.body || JSON.stringify({ ok: res.status < 300, status: res.status }), { status: res.status, headers });
  } catch (e) {
    return new Response(JSON.stringify({ ok: false, erro: String((e && e.message) || e) }), { status: 500, headers });
  }
};
