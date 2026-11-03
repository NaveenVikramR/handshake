// Browser-side calls through this app's route handlers. Same origin, cookies only.
import { startAuthentication, startRegistration } from "@simplewebauthn/browser";

export class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
  ) {
    super(code);
  }
}

async function call<T>(base: "c" | "m", path: string, body?: unknown): Promise<T> {
  const res = await fetch(`/api/${base}/${path}`, {
    method: body === undefined ? "GET" : "POST",
    headers: body === undefined ? {} : { "content-type": "application/json" },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    cache: "no-store",
  });
  const json = (await res.json().catch(() => ({}))) as { error?: string };
  if (!res.ok) throw new ApiError(res.status, json.error ?? "INTERNAL");
  return json as T;
}

export const wallet = <T>(path: string, body?: unknown) => call<T>("c", path, body);
export const merchant = <T>(path: string, body?: unknown) => call<T>("m", path, body);

const USER_KEY = "hs_user";
export const savedUserId = () => {
  try {
    return localStorage.getItem(USER_KEY);
  } catch {
    return null;
  }
};
const rememberUser = (id: string) => {
  try {
    localStorage.setItem(USER_KEY, id);
  } catch {
    // private mode: the user signs in by id next time
  }
};

/** Passkey ceremony over options the server built (challenge = hash of the payload being approved). */
export async function assert(options: unknown) {
  return startAuthentication({ optionsJSON: options as Parameters<typeof startAuthentication>[0]["optionsJSON"] });
}

export async function register(displayName: string): Promise<string> {
  const { userId, options } = await wallet<{ userId: string; options: unknown }>("passkeys/register/options", {
    displayName,
  });
  const response = await startRegistration({
    optionsJSON: options as Parameters<typeof startRegistration>[0]["optionsJSON"],
  });
  await wallet("passkeys/register/verify", { userId, response });
  rememberUser(userId);
  return userId;
}

export async function signIn(userId: string): Promise<void> {
  const { loginId, options } = await wallet<{ loginId: string; options: unknown }>("passkeys/login/options", {
    userId,
  });
  const response = await assert(options);
  await wallet("passkeys/login/verify", { loginId, response });
  rememberUser(userId);
}

/** Reads a server-sent-event stream from a fetch body, calling `on` per event. */
export async function readSSE(res: Response, on: (event: string, data: unknown) => void): Promise<void> {
  if (!res.body) return;
  const reader = res.body.getReader();
  const dec = new TextDecoder();
  let buf = "";
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    buf += dec.decode(value, { stream: true });
    let i;
    while ((i = buf.indexOf("\n\n")) >= 0) {
      const block = buf.slice(0, i);
      buf = buf.slice(i + 2);
      const ev = /^event: (.+)$/m.exec(block)?.[1] ?? "message";
      const data = /^data: (.+)$/m.exec(block)?.[1];
      if (data) on(ev, JSON.parse(data));
    }
  }
}
