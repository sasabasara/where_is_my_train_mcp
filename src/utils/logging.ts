import type { Response } from 'express';

/** Keep rider GPS coordinates out of both HTTP and tool-call logs. */
export function redactToolArgs(tool: unknown, args: unknown): Record<string, unknown> | null {
  if (!args || typeof args !== 'object' || Array.isArray(args)) return null;
  const safe = { ...args } as Record<string, unknown>;
  if (tool === 'nearest_station') {
    delete safe.lat;
    delete safe.lon;
  }
  return safe;
}

/** The MCP SDK writes directly to the response, bypassing Express's res.json. */
export function captureResponseOutcome(res: Response) {
  const chunks: Buffer[] = [];
  let size = 0;
  const capture = (chunk: unknown, encoding?: unknown) => {
    if (chunk === undefined || chunk === null || typeof chunk === 'function') return;
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as string, typeof encoding === 'string' ? encoding as BufferEncoding : undefined);
    size += buffer.length;
    if (size <= 128 * 1024) chunks.push(buffer);
    else chunks.length = 0;
  };
  const write = res.write.bind(res);
  const end = res.end.bind(res);
  res.write = ((...args: any[]) => { capture(args[0], args[1]); return (write as any)(...args); }) as typeof res.write;
  res.end = ((...args: any[]) => { capture(args[0], args[1]); return (end as any)(...args); }) as typeof res.end;
  return () => {
    let body: any;
    try { body = JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch { /* SSE or empty body */ }
    const toolError = body?.result?.isError === true;
    return {
      isError: Boolean(body?.error) || toolError,
      errorCode: body?.error?.code ?? null,
      // Tool results can contain user input. Record a generic outcome without copying it to logs.
      errorMessage: body?.error ? 'JSON-RPC request failed' : toolError ? 'Tool returned an error' : null
    };
  };
}
