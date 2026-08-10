/**
 * MCP JSON-RPC 2.0 framing.
 *
 * Pure, import-free, unit-testable. No external dependencies.
 * Implements the JSON-RPC 2.0 envelope shapes used by the Model Context Protocol.
 */

/* --------------------------------------------------------- wire types ---- */

export interface RpcRequest {
  jsonrpc: "2.0";
  id: string | number;
  method: string;
  params?: unknown;
}

export interface RpcNotification {
  jsonrpc: "2.0";
  method: string;
  params?: unknown;
  // Explicitly no `id` field — that is what makes it a notification.
}

export interface RpcSuccess {
  jsonrpc: "2.0";
  id: string | number;
  result: unknown;
}

export interface RpcError {
  jsonrpc: "2.0";
  id: string | number | null;
  error: {
    code: number;
    message: string;
    data?: unknown;
  };
}

export type RpcResponse = RpcSuccess | RpcError;

export type RpcMessage = RpcRequest | RpcNotification | RpcResponse;

/* ---------------------------------------------------- standard codes ---- */

export const RPC_PARSE_ERROR = -32700;
export const RPC_INVALID_REQUEST = -32600;
export const RPC_METHOD_NOT_FOUND = -32601;
export const RPC_INVALID_PARAMS = -32602;
export const RPC_INTERNAL_ERROR = -32603;

/* ---------------------------------------------------- constructors ---- */

/** Build a JSON-RPC 2.0 request object. */
export function rpcRequest(
  id: string | number,
  method: string,
  params?: unknown,
): RpcRequest {
  const req: RpcRequest = { jsonrpc: "2.0", id, method };
  if (params !== undefined) req.params = params;
  return req;
}

/** Build a JSON-RPC 2.0 notification (no id, no response expected). */
export function rpcNotification(
  method: string,
  params?: unknown,
): RpcNotification {
  const notif: RpcNotification = { jsonrpc: "2.0", method };
  if (params !== undefined) notif.params = params;
  return notif;
}

/** Build a successful JSON-RPC 2.0 response. */
export function rpcSuccess(id: string | number, result: unknown): RpcSuccess {
  return { jsonrpc: "2.0", id, result };
}

/** Build a JSON-RPC 2.0 error response. */
export function rpcErrorResponse(
  id: string | number | null,
  code: number,
  message: string,
  data?: unknown,
): RpcError {
  const resp: RpcError = { jsonrpc: "2.0", id, error: { code, message } };
  if (data !== undefined) resp.error.data = data;
  return resp;
}

/* ---------------------------------------------------- parsing ---- */

export type ParseResult =
  | { ok: true; message: RpcMessage }
  | { ok: false; error: string };

/**
 * Parse a raw JSON string into a typed RPC message.
 *
 * Returns a discriminated union so callers never throw on malformed input.
 */
export function parseRpcMessage(raw: string): ParseResult {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return { ok: false, error: `JSON parse error: ${raw.slice(0, 120)}` };
  }

  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    return { ok: false, error: "RPC message must be a JSON object" };
  }

  const obj = parsed as Record<string, unknown>;

  if (obj["jsonrpc"] !== "2.0") {
    return { ok: false, error: 'Missing or invalid "jsonrpc" field (expected "2.0")' };
  }

  if (typeof obj["method"] !== "string") {
    // Must be a response (success or error)
    if ("result" in obj) {
      if (obj["id"] === undefined || obj["id"] === null) {
        return { ok: false, error: "Response must have an id" };
      }
      return {
        ok: true,
        message: {
          jsonrpc: "2.0",
          id: obj["id"] as string | number,
          result: obj["result"],
        } satisfies RpcSuccess,
      };
    }
    if ("error" in obj) {
      const err = obj["error"];
      if (
        typeof err !== "object" ||
        err === null ||
        typeof (err as Record<string, unknown>)["code"] !== "number" ||
        typeof (err as Record<string, unknown>)["message"] !== "string"
      ) {
        return { ok: false, error: "Malformed error object in RPC error response" };
      }
      const errObj = err as { code: number; message: string; data?: unknown };
      const id =
        obj["id"] === undefined
          ? null
          : (obj["id"] as string | number | null);
      return {
        ok: true,
        message: {
          jsonrpc: "2.0",
          id,
          error: { code: errObj.code, message: errObj.message, data: errObj.data },
        } satisfies RpcError,
      };
    }
    return { ok: false, error: "Cannot determine message type (no method, result, or error)" };
  }

  // Has a method — request or notification
  if ("id" in obj && obj["id"] !== null && obj["id"] !== undefined) {
    return {
      ok: true,
      message: {
        jsonrpc: "2.0",
        id: obj["id"] as string | number,
        method: obj["method"] as string,
        params: obj["params"],
      } satisfies RpcRequest,
    };
  }

  return {
    ok: true,
    message: {
      jsonrpc: "2.0",
      method: obj["method"] as string,
      params: obj["params"],
    } satisfies RpcNotification,
  };
}

/* ---------------------------------------------------- type guards ---- */

export function isRequest(msg: RpcMessage): msg is RpcRequest {
  return "id" in msg && "method" in msg;
}

export function isNotification(msg: RpcMessage): msg is RpcNotification {
  return !("id" in msg) && "method" in msg;
}

export function isSuccess(msg: RpcMessage): msg is RpcSuccess {
  return "id" in msg && "result" in msg && !("method" in msg);
}

export function isRpcError(msg: RpcMessage): msg is RpcError {
  return "error" in msg && !("method" in msg);
}
