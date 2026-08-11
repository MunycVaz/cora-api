/* Conexão Cora (Integração Direta / mTLS) — leitura de extrato.
   Lê as credenciais das variáveis de ambiente do Netlify:
     CORA_CLIENT_ID  -> o Client-id da credencial
     CORA_CERT       -> conteúdo do certificate.pem (texto todo)
     CORA_KEY        -> conteúdo do private-key.key (texto todo)
     CORA_ENV        -> "stage" (teste) ou "prod" (produção). Padrão: stage
   Nenhum dado secreto fica no código; tudo vem das variáveis do Netlify. */
const https = require('https');

const HOSTS = {
  stage: 'matls-clients.api.stage.cora.com.br',
  prod:  'matls-clients.api.cora.com.br',
};

function pem(v) {
  if (!v) return v;
  v = v.trim();
  if (v.indexOf('BEGIN') !== -1) return v.replace(/\\n/g, '\n');
  try { return Buffer.from(v, 'base64').toString('utf8'); } catch (e) { return v; }
}

function httpReq(opts, body) {
  return new Promise((resolve, reject) => {
    const r = https.request(opts, (res) => {
      let d = '';
      res.on('data', (c) => (d += c));
      res.on('end', () => resolve({ status: res.statusCode, body: d }));
    });
    r.on('error', reject);
    if (body) r.write(body);
    r.end();
  });
}

function ymd(d) { return d.toISOString().slice(0, 10); }

exports.handler = async (event) => {
  const cors = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'authorization, content-type',
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
  };
  if (event.httpMethod === 'OPTIONS') return { statusCode: 204, headers: cors, body: '' };

  try {
    const CID  = process.env.CORA_CLIENT_ID;
    const CERT = pem(process.env.CORA_CERT);
    const KEY  = pem(process.env.CORA_KEY);
    const host = HOSTS[process.env.CORA_ENV || 'stage'] || HOSTS.stage;

    if (!CID || !CERT || !KEY) {
      return { statusCode: 500, headers: { ...cors, 'content-type': 'application/json' },
        body: JSON.stringify({ ok: false, erro: 'Faltam variáveis: CORA_CLIENT_ID, CORA_CERT e/ou CORA_KEY.' }) };
    }

    const form = 'grant_type=client_credentials&client_id=' + encodeURIComponent(CID);
    const tok = await httpReq({
      host, port: 443, path: '/token', method: 'POST', cert: CERT, key: KEY,
      headers: { 'content-type': 'application/x-www-form-urlencoded', 'content-length': Buffer.byteLength(form) },
    }, form);
    if (tok.status !== 200) {
      return { statusCode: 502, headers: { ...cors, 'content-type': 'application/json' },
        body: JSON.stringify({ ok: false, etapa: 'token', status: tok.status, resposta: tok.body }) };
    }
    const access = JSON.parse(tok.body).access_token;

    const q = (event.queryStringParameters) || {};
    const hoje = new Date();
    const seteDiasAtras = new Date(hoje.getTime() - 7 * 864e5);
    const start = q.start || ymd(seteDiasAtras);
    const end   = q.end   || ymd(hoje);
    const qs = new URLSearchParams({ start, end, perPage: '100' });
    if (q.type) qs.set('type', q.type);

    const ext = await httpReq({
      host, port: 443, path: '/bank-statement/statement?' + qs.toString(), method: 'GET', cert: CERT, key: KEY,
      headers: { authorization: 'Bearer ' + access },
    });
    return { statusCode: ext.status, headers: { ...cors, 'content-type': 'application/json' }, body: ext.body };
  } catch (e) {
    return { statusCode: 500, headers: { ...cors, 'content-type': 'application/json' },
      body: JSON.stringify({ ok: false, erro: String((e && e.message) || e) }) };
  }
};
