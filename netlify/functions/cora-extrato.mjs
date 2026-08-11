/* Conexão Cora (Integração Direta / mTLS) — leitura de extrato.
   Formato MODERNO da Netlify (V2, Web API) — sem o limite de 4KB de
   variáveis do modo Lambda, então cabem várias contas (certificados grandes).
   Suporta ?conta=trust|rotta (padrão: trust).
   Variáveis de ambiente no Netlify (por conta):
     TRUST -> CORA_TRUST_CLIENT_ID / CORA_TRUST_CERT / CORA_TRUST_KEY
              (compat: se não existirem, usa CORA_CLIENT_ID / CORA_CERT / CORA_KEY)
     ROTTA -> CORA_ROTTA_CLIENT_ID / CORA_ROTTA_CERT / CORA_ROTTA_KEY
     Geral -> CORA_ENV = "stage" (teste) ou "prod" (produção). Padrão: stage */
import https from 'node:https';

const HOSTS = {
  stage: 'matls-clients.api.stage.cora.com.br',
  prod:  'matls-clients.api.cora.com.br',
};

function pem(v) {
  if (!v) return v;
  v = String(v).trim().replace(/\\n/g, '\n');
  if (v.indexOf('BEGIN') === -1) {
    try { return Buffer.from(v, 'base64').toString('utf8'); } catch (e) { return v; }
  }
  const m = v.match(/-----BEGIN ([A-Za-z0-9 ]+)-----([\s\S]*?)-----END \1-----/);
  if (!m) return v;
  const label = m[1].trim();
  const body = m[2].replace(/[^A-Za-z0-9+/=]/g, '');
  const lines = body.match(/.{1,64}/g) || [];
  return '-----BEGIN ' + label + '-----\n' + lines.join('\n') + '\n-----END ' + label + '-----\n';
}

function credenciais(conta) {
  conta = String(conta || 'trust').toLowerCase();
  const UP = conta.toUpperCase();
  const g = (suf) => process.env['CORA_' + UP + '_' + suf]
    || (conta === 'trust' ? process.env['CORA_' + suf] : undefined);
  return { conta, cid: g('CLIENT_ID'), cert: pem(g('CERT')), key: pem(g('KEY')) };
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

export default async (request) => {
  const headers = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'authorization, content-type',
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
    'content-type': 'application/json',
  };
  if (request.method === 'OPTIONS') return new Response('', { status: 204, headers });

  try {
    const url = new URL(request.url);
    const { conta, cid, cert, key } = credenciais(url.searchParams.get('conta'));
    const host = HOSTS[process.env.CORA_ENV || 'stage'] || HOSTS.stage;

    if (!cid || !cert || !key) {
      return new Response(JSON.stringify({ ok: false, erro: 'Faltam credenciais da conta "' + conta + '" (CLIENT_ID/CERT/KEY).' }), { status: 500, headers });
    }

    const form = 'grant_type=client_credentials&client_id=' + encodeURIComponent(cid);
    const tok = await httpReq({
      host, port: 443, path: '/token', method: 'POST', cert, key,
      headers: { 'content-type': 'application/x-www-form-urlencoded', 'content-length': Buffer.byteLength(form) },
    }, form);
    if (tok.status !== 200) {
      return new Response(JSON.stringify({ ok: false, conta, etapa: 'token', status: tok.status, resposta: tok.body }), { status: 502, headers });
    }
    const access = JSON.parse(tok.body).access_token;

    const start = url.searchParams.get('start') || ymd(new Date(Date.now() - 7 * 864e5));
    const end   = url.searchParams.get('end')   || ymd(new Date());
    const qs = new URLSearchParams({ start, end, perPage: '100' });
    const type = url.searchParams.get('type'); if (type) qs.set('type', type);

    const ext = await httpReq({
      host, port: 443, path: '/bank-statement/statement?' + qs.toString(), method: 'GET', cert, key,
      headers: { authorization: 'Bearer ' + access },
    });
    return new Response(ext.body, { status: ext.status, headers });
  } catch (e) {
    return new Response(JSON.stringify({ ok: false, erro: String((e && e.message) || e) }), { status: 500, headers });
  }
};
