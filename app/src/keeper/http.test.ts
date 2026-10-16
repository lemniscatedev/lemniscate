import { expect, test } from "bun:test";
import { fetchTextWithTimeout } from "./http";

type FetchImplementation = (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;

async function withFetch<T>(fetcher: FetchImplementation, run: () => Promise<T>): Promise<T> {
  const previous = globalThis.fetch;
  globalThis.fetch = fetcher as typeof fetch;
  try {
    return await run();
  } finally {
    globalThis.fetch = previous;
  }
}

test("text fetch errors never include the query string, including a failed body read", async () => {
  const url = "https://www.alphavantage.co/query?apikey=secret-provider-key";
  const response = new Response("csv");
  Object.defineProperty(response, "text", {
    value: async () => { throw new Error(`failed to read ${url}`); },
  });

  await withFetch(async () => response, async () => {
    let message = "";
    try {
      await fetchTextWithTimeout(url);
    } catch (error) {
      message = error instanceof Error ? error.message : String(error);
    }
    expect(message).toBe("www.alphavantage.co response body read failed");
    expect(message).not.toContain("secret-provider-key");
    expect(message).not.toContain("apikey=");
  });
});
