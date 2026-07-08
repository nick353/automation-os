import assert from "node:assert/strict";
import { Readable } from "node:stream";
import test from "node:test";
import { apiErrorHandler, app } from "../index.js";

test("unknown /api routes return JSON 404 responses", async () => {
  const response = await request("GET", "/api/not-a-real-route");
  const body = JSON.parse(response.body) as { error: string };

  assert.equal(response.status, 404);
  assert.equal(body.error, "api_not_found");
  assert.match(String(response.headers.get("content-type") ?? ""), /application\/json/);
});

test("API error handler delegates when headers were already sent", () => {
  const error = new Error("late failure");
  let delegated: unknown;
  const res = {
    headersSent: true,
    status() {
      throw new Error("status should not be called after headers were sent");
    },
    json() {
      throw new Error("json should not be called after headers were sent");
    }
  };

  apiErrorHandler(error, {} as never, res as never, (nextError) => {
    delegated = nextError;
  });

  assert.equal(delegated, error);
});

function request(method: string, path: string) {
  return new Promise<{ status: number; body: string; headers: Map<string, unknown> }>((resolve, reject) => {
    const req = Readable.from([]) as NodeJS.ReadableStream & {
      method?: string;
      url?: string;
      headers?: Record<string, string>;
    };
    req.method = method;
    req.url = path;
    req.headers = {};

    const chunks: Buffer[] = [];
    const headers = new Map<string, unknown>();
    const res = {
      statusCode: 200,
      setHeader(name: string, value: unknown) {
        headers.set(name.toLowerCase(), value);
        return this;
      },
      getHeader(name: string) {
        return headers.get(name.toLowerCase());
      },
      removeHeader(name: string) {
        headers.delete(name.toLowerCase());
      },
      end(chunk?: string | Buffer) {
        if (chunk) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
        resolve({ status: this.statusCode, body: Buffer.concat(chunks).toString("utf8"), headers });
        return this;
      }
    };

    (app as unknown as { handle(req: unknown, res: unknown, next: (error?: unknown) => void): void }).handle(req, res, reject);
  });
}
