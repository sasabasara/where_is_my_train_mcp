import { beforeAll, afterAll, describe, it, expect, vi } from 'vitest';
import { once } from 'node:events';
import type { Server } from 'node:http';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';

vi.mock('./services/gtfsManager.js', () => ({ GTFSManager: {
  getGTFSData: async () => ({ stops: [{ stop_id: '635', stop_name: '14 St-Union Sq', location_type: '1', stop_lat: '40.7359', stop_lon: '-73.9906' }], transfers: [], routes: [] })
} }));
vi.mock('./services/stationInfoService.js', async importOriginal => ({
  ...await importOriginal<typeof import('./services/stationInfoService.js')>(),
  ensureStationInfoLoaded: async () => {}
}));

const { createApp } = await import('./app.js');
let service: ReturnType<typeof createApp>;
let http: Server;
let base: string;
const log = vi.spyOn(console, 'log').mockImplementation(() => {});

beforeAll(async () => {
  service = createApp();
  http = service.app.listen(0, '127.0.0.1');
  await once(http, 'listening');
  base = `http://127.0.0.1:${(http.address() as { port: number }).port}`;
});
afterAll(async () => {
  await service?.close();
  if (http?.listening) await new Promise<void>((resolve, reject) => http.close(e => e ? reject(e) : resolve()));
  log.mockRestore();
});

const headers = { 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream' };
const post = (body: unknown, session?: string) => fetch(`${base}/mcp`, {
  method: 'POST', headers: { ...headers, ...(session ? { 'mcp-session-id': session } : {}) }, body: JSON.stringify(body)
});
async function initialize() {
  const r = await post({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-03-26', capabilities: {}, clientInfo: { name: 'audit-test', version: '1' } } });
  expect(r.status).toBe(200);
  await r.json();
  return r.headers.get('mcp-session-id')!;
}
const requestEvents = () => log.mock.calls.flatMap(([line]) => {
  try { const data = JSON.parse(String(line)); return data.requestId ? [data] : []; } catch { return []; }
});

describe('HTTP and MCP integration', () => {
  it('returns JSON-RPC and logs malformed JSON', async () => {
    const r = await fetch(`${base}/mcp`, { method: 'POST', headers, body: '{broken' });
    expect(r.status).toBe(400);
    expect(await r.json()).toMatchObject({ error: { code: -32700 } });
    expect(requestEvents().at(-1)).toMatchObject({ success: false, statusCode: 400, errorCode: -32700 });
  });

  it('returns JSON-RPC for an oversized body', async () => {
    const r = await post({ text: 'x'.repeat(110_000) });
    expect(r.status).toBe(413);
    expect(await r.json()).toMatchObject({ error: { code: -32600 } });
  });

  it.each(['constructor', '__proto__', 'toString'])('rejects inherited-object session key %s without crashing', async session => {
    for (const method of ['POST', 'GET', 'DELETE']) {
      const r = await fetch(`${base}/mcp`, { method, headers: { ...headers, 'mcp-session-id': session }, ...(method === 'POST' ? { body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' }) } : {}) });
      expect(r.status).toBe(404);
      expect(await r.json()).toMatchObject({ error: { code: -32001 } });
    }
    expect((await fetch(base)).status).toBe(200);
  });

  it('supports initialization, tools/list, and session deletion', async () => {
    const session = await initialize();
    const list = await post({ jsonrpc: '2.0', id: 2, method: 'tools/list' }, session);
    const tools = (await list.json()).result.tools;
    expect(tools).toHaveLength(8);
    expect(tools.find((t: any) => t.name === 'station_transfers').inputSchema.properties.stop_id).toBeDefined();
    const deleted = await fetch(`${base}/mcp`, { method: 'DELETE', headers: { ...headers, 'mcp-session-id': session } });
    expect(deleted.status).toBe(200);
    expect((await post({ jsonrpc: '2.0', id: 3, method: 'tools/list' }, session)).status).toBe(404);
  });

  it('forwards asynchronous transport errors to JSON-RPC error middleware', async () => {
    const session = await initialize();
    const handle = vi.spyOn(StreamableHTTPServerTransport.prototype, 'handleRequest').mockRejectedValueOnce(new Error('private stack details'));
    try {
      const r = await post({ jsonrpc: '2.0', id: 2, method: 'tools/list' }, session);
      expect(r.status).toBe(500);
      expect(await r.json()).toMatchObject({ error: { code: -32603, message: 'Internal error' } });
    } finally { handle.mockRestore(); }
  });

  it('records a tool failure despite HTTP 200, preserving request id zero', async () => {
    const session = await initialize();
    const r = await post({ jsonrpc: '2.0', id: 0, method: 'tools/call', params: { name: 'find_station', arguments: { query: '' } } }, session);
    expect(r.status).toBe(200);
    expect((await r.json()).result.isError).toBe(true);
    expect(requestEvents().at(-1)).toMatchObject({ mcpId: 0, success: false, errorMessage: 'Tool returned an error' });
  });

  it('accepts a transfer stop_id through the actual MCP input and output schemas', async () => {
    const session = await initialize();
    const r = await post({ jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'station_transfers', arguments: { stop_id: '635N' } } }, session);
    const body = await r.json();
    expect(body.error).toBeUndefined();
    expect(body.result.isError).not.toBe(true);
    expect(body.result.structuredContent.data.connections).toMatchObject([{ stopId: '635' }]);
  });

  it('records SDK validation failures instead of success', async () => {
    const session = await initialize();
    const r = await post({ jsonrpc: '2.0', id: 4, method: 'tools/call', params: { name: 'nearest_station', arguments: { lat: 400, lon: -74 } } }, session);
    const body = await r.json();
    expect(Boolean(body.error || body.result?.isError)).toBe(true);
    expect(requestEvents().at(-1)?.success).toBe(false);
  });

  it('redacts GPS coordinates from both request and tool logs', async () => {
    const session = await initialize();
    log.mockClear();
    const r = await post({ jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'nearest_station', arguments: { lat: 40.735912345, lon: -73.990612345 } } }, session);
    expect((await r.json()).result.isError).not.toBe(true);
    const output = JSON.stringify(log.mock.calls);
    expect(output).not.toContain('40.735912345');
    expect(output).not.toContain('-73.990612345');
    expect(requestEvents().at(-1)?.toolArgs).toEqual({});
  });

  it('allows newer browser MCP headers', async () => {
    const r = await fetch(`${base}/mcp`, { method: 'OPTIONS', headers: { 'Access-Control-Request-Headers': 'mcp-protocol-version,x-client-feature' } });
    expect(r.status).toBe(200);
    expect(r.headers.get('access-control-allow-headers')).toContain('x-client-feature');
  });
});
