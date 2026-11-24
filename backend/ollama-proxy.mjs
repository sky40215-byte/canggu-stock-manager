import http from 'node:http';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { timingSafeEqual } from 'node:crypto';

const configPath = process.env.CANGGU_CONFIG_PATH ||
  resolve(process.env.LOCALAPPDATA || process.cwd(), 'Canggu', 'config.env');

try {
  const config = await readFile(configPath, 'utf8');
  for (const line of config.split(/\r?\n/)) {
    const match = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)\s*$/);
    if (match && process.env[match[1]] === undefined) {
      process.env[match[1]] = match[2].replace(/^(['"])(.*)\1$/, '$2');
    }
  }
} catch {}

const token = process.env.OLLAMA_PROXY_TOKEN || '';
const model = process.env.OLLAMA_MODEL || 'gemma4:e2b';
if (token.length < 32) {
  console.error('請先在本機 config.env 設定至少 32 字元的 OLLAMA_PROXY_TOKEN。');
  process.exit(1);
}

let requestCount = 0;
let windowStart = Date.now();
let busy = false;

function send(res, status, body) {
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store'
  });
  res.end(JSON.stringify(body));
}

const server = http.createServer(async (req, res) => {
  if (req.method !== 'POST' || req.url !== '/api/chat') {
    return send(res, 404, { error: 'Not found' });
  }

  const expected = Buffer.from(`Bearer ${token}`);
  const supplied = Buffer.from(req.headers.authorization || '');
  if (supplied.length !== expected.length || !timingSafeEqual(supplied, expected)) {
    return send(res, 401, { error: 'Unauthorized' });
  }

  if (Date.now() - windowStart >= 60 * 60 * 1000) {
    requestCount = 0;
    windowStart = Date.now();
  }
  if (requestCount >= 20 || busy) {
    return send(res, 429, { error: 'Request limit reached' });
  }

  try {
    const chunks = [];
    let size = 0;
    for await (const chunk of req) {
      size += chunk.length;
      if (size > 64 * 1024) return send(res, 413, { error: 'Request too large' });
      chunks.push(chunk);
    }

    const body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    const messageChars = Array.isArray(body.messages)
      ? body.messages.reduce((total, message) => total + (typeof message?.content === 'string' ? message.content.length : 0), 0)
      : Infinity;
    if (!Array.isArray(body.messages) || body.messages.length > 11 || messageChars > 48000 ||
        body.messages.some((m) =>
          !['system', 'user', 'assistant'].includes(m?.role) ||
          typeof m?.content !== 'string' || m.content.length > 24000
        )) {
      return send(res, 400, { error: 'Invalid messages' });
    }

    requestCount++;
    busy = true;
    const modelName = typeof body.model === 'string' && /^[A-Za-z0-9._:-]{1,100}$/.test(body.model)
      ? body.model : model;
    const format = body.format === 'json' ? 'json' : undefined;
    const rawOptions = body.options && typeof body.options === 'object' ? body.options : {};
    const options = {
      temperature: Number.isFinite(Number(rawOptions.temperature))
        ? Math.max(0, Math.min(1, Number(rawOptions.temperature))) : 0.25,
      num_predict: Number.isFinite(Number(rawOptions.num_predict))
        ? Math.max(128, Math.min(2048, Math.floor(Number(rawOptions.num_predict)))) : 700
    };
    const response = await fetch('http://127.0.0.1:11434/api/chat', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ model: modelName, ...(format ? { format } : {}), messages: body.messages, stream: false, options }),
      signal: AbortSignal.timeout(180000)
    });
    const result = await response.json().catch(() => ({}));
    return send(res, response.ok ? 200 : 502, result);
  } catch (error) {
    const timedOut = error?.name === 'TimeoutError' || error?.name === 'AbortError';
    return send(res, timedOut ? 504 : 502, { error: timedOut ? 'Local Ollama timed out while generating a response' : 'Local Ollama request failed' });
  } finally {
    busy = false;
  }
});

server.listen(11435, '127.0.0.1', () => {
  console.log('Ollama 驗證轉接層已啟動：http://127.0.0.1:11435');
});
