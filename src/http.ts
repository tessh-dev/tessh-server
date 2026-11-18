export type ErrorCode =
  | "invalid_request"
  | "bad_signature"
  | "unauthorized"
  | "invalid_credentials"
  | "not_found"
  | "email_taken"
  | "username_taken"
  | "stale_keypage"
  | "quota_exceeded"
  | "rate_limited"
  | "invalid_code"
  | "invalid_challenge"
  | "two_step_required"
  | "two_step_enabled"
  | "two_step_not_enabled"
  | "two_step_not_pending"
  | "account_suspended"
  | "device_limit"
  | "forbidden"
  | "plan_in_use"
  | "conflict"
  | "signups_closed"
  | "invite_required"
  | "locked_by_env";

export const MAX_BODY_BYTES = 1024 * 1024;

export class HttpError extends Error {
  code: ErrorCode;
  status: number;
  /** Extra top-level fields merged into the error body (e.g. `attempts_left`). */
  extra?: Record<string, unknown>;
  headers?: Record<string, string>;

  constructor(code: ErrorCode, status: number, message: string, extra?: Record<string, unknown>, headers?: Record<string, string>) {
    super(message);
    this.code = code;
    this.status = status;
    this.extra = extra;
    this.headers = headers;
  }
}

export function json(body: unknown, status = 200, headers?: ConstructorParameters<typeof Headers>[0]): Response {
  const h = new Headers(headers);
  h.set("content-type", "application/json; charset=utf-8");
  return new Response(JSON.stringify(body), { status, headers: h });
}

export function error(code: ErrorCode, status: number, message: string, extra?: Record<string, unknown>, headers?: ConstructorParameters<typeof Headers>[0]): Response {
  return json({ error: code, message, ...extra }, status, headers);
}

export const errorFrom = (e: HttpError): Response => error(e.code, e.status, e.message, e.extra, e.headers);

/** Parses the JSON body. Throws HttpError invalid_request (400) on bad JSON or a body over 1 MiB. */
export async function readJSON<T>(req: Request): Promise<T> {
  const declared = Number(req.headers.get("content-length"));
  if (Number.isFinite(declared) && declared > MAX_BODY_BYTES) {
    throw new HttpError("invalid_request", 400, "Request body too large");
  }
  const buf = await req.arrayBuffer();
  if (buf.byteLength > MAX_BODY_BYTES) {
    throw new HttpError("invalid_request", 400, "Request body too large");
  }
  try {
    return JSON.parse(new TextDecoder().decode(buf)) as T;
  } catch {
    throw new HttpError("invalid_request", 400, "Invalid JSON");
  }
}
