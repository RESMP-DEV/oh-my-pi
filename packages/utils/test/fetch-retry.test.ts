import { describe, expect, it } from "bun:test";
import { fetchWithRetry } from "@oh-my-pi/pi-utils/fetch-retry";

describe("fetchWithRetry", () => {
	it("routes requests through the `fetch` override when provided", async () => {
		const calls: Array<{ input: string | URL | Request; init: RequestInit | undefined }> = [];
		const customFetch = async (input: string | URL | Request, init?: RequestInit) => {
			calls.push({ input, init });
			return new Response("ok", { status: 200 });
		};

		const response = await fetchWithRetry("https://example.invalid/x", {
			method: "POST",
			body: "hi",
			fetch: customFetch,
		});

		expect(response.status).toBe(200);
		expect(await response.text()).toBe("ok");
		expect(calls).toHaveLength(1);
		expect(calls[0]?.input).toBe("https://example.invalid/x");
		expect(calls[0]?.init).toMatchObject({ method: "POST", body: "hi" });
	});

	it("retries through the override on transient failures", async () => {
		let attempt = 0;
		const customFetch = async () => {
			attempt += 1;
			if (attempt === 1) return new Response("", { status: 503 });
			return new Response("done", { status: 200 });
		};

		const response = await fetchWithRetry("https://example.invalid/y", {
			fetch: customFetch,
			defaultDelayMs: 1,
			maxAttempts: 3,
		});

		expect(response.status).toBe(200);
		expect(await response.text()).toBe("done");
		expect(attempt).toBe(2);
	});

	it("lets callers stop retries for deterministic response bodies", async () => {
		let attempt = 0;
		const customFetch = async () => {
			attempt += 1;
			return new Response("deterministic provider failure", { status: 500 });
		};

		const response = await fetchWithRetry("https://example.invalid/z", {
			fetch: customFetch,
			defaultDelayMs: 1,
			maxAttempts: 3,
			shouldRetryResponse: (_response, bodyText) => !bodyText.includes("deterministic"),
		});

		expect(response.status).toBe(500);
		expect(await response.text()).toBe("deterministic provider failure");
		expect(attempt).toBe(1);
	});

	it("returns retryable responses immediately when retry hints exceed the delay cap", async () => {
		let attempt = 0;
		const customFetch = async () => {
			attempt += 1;
			return new Response("slow down", { status: 429, headers: { "Retry-After": "3600" } });
		};

		const response = await fetchWithRetry("https://example.invalid/rate-limit", {
			fetch: customFetch,
			defaultDelayMs: 1,
			maxAttempts: 3,
			maxDelayMs: 10,
		});

		expect(response.status).toBe(429);
		expect(await response.text()).toBe("slow down");
		expect(attempt).toBe(1);
	});
	it("forwards `verbose: true` to the underlying fetch init when set on options", async () => {
		const inits: Array<RequestInit | undefined> = [];
		const stubFetch = async (_input: string | URL | Request, init?: RequestInit) => {
			inits.push(init);
			return new Response("ok", { status: 200 });
		};

		const response = await fetchWithRetry("https://example.invalid/verbose-on", {
			verbose: true,
			fetch: stubFetch,
		});

		expect(response.status).toBe(200);
		expect(inits).toHaveLength(1);
		const init = inits[0] as unknown as Record<string, unknown> | undefined;
		expect(init).toBeDefined();
		expect(init?.verbose).toBe(true);
	});

	it("omits `verbose` (and `timeout`) from init when neither option nor env flag is set", async () => {
		const prior = Bun.env.PI_FETCH_VERBOSE;
		delete Bun.env.PI_FETCH_VERBOSE;
		try {
			const inits: Array<RequestInit | undefined> = [];
			const stubFetch = async (_input: string | URL | Request, init?: RequestInit) => {
				inits.push(init);
				return new Response("ok", { status: 200 });
			};

			const response = await fetchWithRetry("https://example.invalid/quiet", {
				method: "POST",
				body: "hi",
				fetch: stubFetch,
			});

			expect(response.status).toBe(200);
			expect(inits).toHaveLength(1);
			const init = inits[0] as unknown as Record<string, unknown>;
			expect("verbose" in init).toBe(false);
			expect("timeout" in init).toBe(false);
			expect(init.method).toBe("POST");
			expect(init.body).toBe("hi");
		} finally {
			if (prior === undefined) delete Bun.env.PI_FETCH_VERBOSE;
			else Bun.env.PI_FETCH_VERBOSE = prior;
		}
	});

	it("carries `verbose: true` through `prepareInit` into the merged fetch init", async () => {
		const inits: Array<RequestInit | undefined> = [];
		const stubFetch = async (_input: string | URL | Request, init?: RequestInit) => {
			inits.push(init);
			return new Response("ok", { status: 200 });
		};

		const response = await fetchWithRetry("https://example.invalid/prepare-verbose", {
			verbose: true,
			prepareInit: attempt => ({ headers: { "x-attempt": String(attempt) } }),
			fetch: stubFetch,
		});

		expect(response.status).toBe(200);
		expect(inits).toHaveLength(1);
		const init = inits[0] as unknown as Record<string, unknown>;
		expect(init.verbose).toBe(true);
		const headers = init.headers as Headers;
		expect(headers.get("x-attempt")).toBe("0");
	});
});

describe("fetchWithRetry — stale pooled-socket bypass", () => {
	it("adds `Connection: close` to the retry after a 'socket connection was closed unexpectedly' failure", async () => {
		const inits: Array<RequestInit | undefined> = [];
		const stubFetch = async (_input: string | URL | Request, init?: RequestInit) => {
			inits.push(init);
			if (inits.length === 1) {
				throw new Error(
					"The socket connection was closed unexpectedly. For more information, pass verbose: true...",
				);
			}
			return new Response("ok", { status: 200 });
		};

		const response = await fetchWithRetry("https://example.invalid/socket-close", {
			fetch: stubFetch,
			defaultDelayMs: 1,
			maxAttempts: 3,
		});

		expect(response.status).toBe(200);
		expect(await response.text()).toBe("ok");
		expect(inits).toHaveLength(2);
		// Attempt 0: bypass not yet armed; no connection header.
		expect(new Headers(inits[0]?.headers).get("connection")).toBeNull();
		// Attempt 1: bypass armed; connection: close is sent to escape the keep-alive pool.
		expect(new Headers(inits[1]?.headers).get("connection")).toBe("close");
	});

	it("adds `Connection: close` after an ECONNRESET code (without a socket-close message)", async () => {
		const inits: Array<RequestInit | undefined> = [];
		const stubFetch = async (_input: string | URL | Request, init?: RequestInit) => {
			inits.push(init);
			if (inits.length === 1) {
				const err = Object.assign(new Error("read ECONNRESET"), { code: "ECONNRESET" });
				throw err;
			}
			return new Response("ok", { status: 200 });
		};

		const response = await fetchWithRetry("https://example.invalid/econnreset", {
			fetch: stubFetch,
			defaultDelayMs: 1,
			maxAttempts: 3,
		});

		expect(response.status).toBe(200);
		expect(inits).toHaveLength(2);
		expect(new Headers(inits[0]?.headers).get("connection")).toBeNull();
		expect(new Headers(inits[1]?.headers).get("connection")).toBe("close");
	});

	it("adds `Connection: close` after a 'fetch failed' wrapper whose cause carries the socket-close message", async () => {
		const inits: Array<RequestInit | undefined> = [];
		const stubFetch = async (_input: string | URL | Request, init?: RequestInit) => {
			inits.push(init);
			if (inits.length === 1) {
				throw new Error("fetch failed", {
					cause: new Error("The socket connection was closed unexpectedly"),
				});
			}
			return new Response("ok", { status: 200 });
		};

		const response = await fetchWithRetry("https://example.invalid/fetch-failed-cause", {
			fetch: stubFetch,
			defaultDelayMs: 1,
			maxAttempts: 3,
		});

		expect(response.status).toBe(200);
		expect(inits).toHaveLength(2);
		expect(new Headers(inits[0]?.headers).get("connection")).toBeNull();
		expect(new Headers(inits[1]?.headers).get("connection")).toBe("close");
	});

	it("does NOT add `Connection: close` when the failure is a plain non-stale error", async () => {
		const inits: Array<RequestInit | undefined> = [];
		const stubFetch = async (_input: string | URL | Request, init?: RequestInit) => {
			inits.push(init);
			if (inits.length === 1) {
				throw new Error("boom");
			}
			return new Response("ok", { status: 200 });
		};

		const response = await fetchWithRetry("https://example.invalid/plain-error", {
			fetch: stubFetch,
			defaultDelayMs: 1,
			maxAttempts: 3,
		});

		expect(response.status).toBe(200);
		expect(inits).toHaveLength(2);
		// Neither attempt should carry the bypass header: there was no stale
		// pooled-socket signature to arm it.
		expect(new Headers(inits[0]?.headers).get("connection")).toBeNull();
		expect(new Headers(inits[1]?.headers).get("connection")).toBeNull();
	});

	it("keeps `Connection: close` on every attempt after the initial stale failure (even across intervening non-stale failures)", async () => {
		const inits: Array<RequestInit | undefined> = [];
		const stubFetch = async (_input: string | URL | Request, init?: RequestInit) => {
			inits.push(init);
			switch (inits.length) {
				case 1:
					throw new Error("The socket connection was closed unexpectedly");
				case 2:
					throw new Error("plain network blip");
				default:
					return new Response("ok", { status: 200 });
			}
		};

		const response = await fetchWithRetry("https://example.invalid/persistent-bypass", {
			fetch: stubFetch,
			defaultDelayMs: 1,
			maxAttempts: 5,
		});

		expect(response.status).toBe(200);
		expect(inits).toHaveLength(3);
		// Attempt 0: bypass not yet armed.
		expect(new Headers(inits[0]?.headers).get("connection")).toBeNull();
		// Attempt 1 and 2: bypass armed by attempt 0's stale failure, kept across
		// the non-stale failure on attempt 1.
		expect(new Headers(inits[1]?.headers).get("connection")).toBe("close");
		expect(new Headers(inits[2]?.headers).get("connection")).toBe("close");
	});

	it("composes `Connection: close` with `prepareInit` overlay headers on the retry", async () => {
		const prior = Bun.env.PI_FETCH_VERBOSE;
		delete Bun.env.PI_FETCH_VERBOSE;
		try {
			const inits: Array<RequestInit | undefined> = [];
			const stubFetch = async (_input: string | URL | Request, init?: RequestInit) => {
				inits.push(init);
				if (inits.length === 1) {
					throw new Error("The socket connection was closed unexpectedly");
				}
				return new Response("ok", { status: 200 });
			};

			const response = await fetchWithRetry("https://example.invalid/prepare-bypass", {
				prepareInit: attempt => ({ headers: { "x-attempt": String(attempt) } }),
				fetch: stubFetch,
				defaultDelayMs: 1,
				maxAttempts: 3,
			});

			expect(response.status).toBe(200);
			expect(inits).toHaveLength(2);
			// Attempt 1 carries BOTH the prepareInit overlay (x-attempt) and the
			// bypass header (connection: close); the overlay does not displace it.
			const retryHeaders = new Headers(inits[1]?.headers);
			expect(retryHeaders.get("x-attempt")).toBe("1");
			expect(retryHeaders.get("connection")).toBe("close");
		} finally {
			if (prior === undefined) delete Bun.env.PI_FETCH_VERBOSE;
			else Bun.env.PI_FETCH_VERBOSE = prior;
		}
	});

	it("respects maxAttempts while still bypassing the socket pool on every retry after the first stale failure", async () => {
		const inits: Array<RequestInit | undefined> = [];
		const stubFetch = async (_input: string | URL | Request, init?: RequestInit) => {
			inits.push(init);
			throw new Error("The socket connection was closed unexpectedly");
		};

		await expect(
			fetchWithRetry("https://example.invalid/budget-bypass", {
				fetch: stubFetch,
				defaultDelayMs: 1,
				maxAttempts: 3,
			}),
		).rejects.toThrow(/socket connection was closed unexpectedly/);

		expect(inits).toHaveLength(3);
		// Attempt 0: bypass not yet armed.
		expect(new Headers(inits[0]?.headers).get("connection")).toBeNull();
		// Attempts 1 and 2: bypass armed, sent on every retry.
		expect(new Headers(inits[1]?.headers).get("connection")).toBe("close");
		expect(new Headers(inits[2]?.headers).get("connection")).toBe("close");
	});
});
