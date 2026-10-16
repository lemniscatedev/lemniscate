interface FetchInit {
  timeoutMs?: number;
  headers?: Record<string, string>;
}

const USER_AGENT = "lemniscate-keeper/1.0";

function hostOf(url: string): string {
  try {
    return new URL(url).host;
  } catch {
    return "external source";
  }
}

async function request(url: string, init: FetchInit, accept: string): Promise<Response> {
  const host = hostOf(url);
  let response: Response;
  try {
    response = await fetch(url, {
      headers: { "User-Agent": USER_AGENT, Accept: accept, ...init.headers },
      signal: AbortSignal.timeout(init.timeoutMs ?? 10_000),
    });
  } catch {
    throw new Error(`${host} request failed`);
  }
  if (!response.ok) throw new Error(`${host} returned HTTP ${response.status}`);
  return response;
}

export async function fetchJsonWithTimeout(
  url: string,
  init: FetchInit = {},
): Promise<unknown> {
  const response = await request(url, init, "application/json");
  try {
    return await response.json();
  } catch {
    throw new Error(`${hostOf(url)} response body read failed`);
  }
}

export async function fetchTextWithTimeout(
  url: string,
  init: FetchInit = {},
): Promise<string> {
  const response = await request(url, init, "text/csv, text/plain, */*");
  try {
    return await response.text();
  } catch {
    throw new Error(`${hostOf(url)} response body read failed`);
  }
}
