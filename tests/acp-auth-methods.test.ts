// The ACP server advertises its sign-in methods on initialize. Hardcoding
// oauth-personal excluded enterprise, Vertex and API-key accounts, so the
// list drives the choice now. Payload copied from a live agy_acp_server 1.4.1.

import assert from "node:assert/strict";
import { test } from "vitest";
import {
	authMethodLabel,
	isBrowserMethod,
	parseAuthMethods,
	resolveAuthMethod,
	type AgyAuthMethod,
} from "../src/acp/auth-methods.js";

const LIVE = {
	authMethods: [
		{ id: "oauth-personal", name: "Log in with Google", description: "Log in with your Google account" },
		{ id: "oauth-business", name: "Log in with Gemini Enterprise", description: "Log in with your Gemini Enterprise account" },
		{ id: "gemini-api-key", name: "Gemini API key", description: "Use an API key with Gemini Developer API" },
		{
			id: "agent-platform",
			name: "Gemini Enterprise Agent Platform",
			description: "Use Gemini Enterprise Agent Platform (formerly Vertex AI) with Application Default Credentials or an API key",
		},
	],
};

test("parseAuthMethods: reads the four methods the real server publishes", () => {
	const methods = parseAuthMethods(LIVE);
	assert.deepEqual(
		methods.map((m) => m.id),
		["oauth-personal", "oauth-business", "gemini-api-key", "agent-platform"],
	);
	assert.equal(methods[1]?.name, "Log in with Gemini Enterprise");
	assert.match(methods[3]?.description ?? "", /Vertex AI/);
});

test("parseAuthMethods: skips malformed entries and never throws", () => {
	for (const bad of [null, undefined, {}, { authMethods: null }, { authMethods: "x" }, { authMethods: [null, 1, {}] }]) {
		assert.deepEqual(parseAuthMethods(bad), [], JSON.stringify(bad));
	}
	assert.deepEqual(
		parseAuthMethods({ authMethods: [{ id: "  oauth-personal  " }, { name: "no id" }, "x"] }),
		[{ id: "oauth-personal", name: "oauth-personal" }],
		"a missing name falls back to the id",
	);
});

test("isBrowserMethod: oauth methods open a page, credential methods do not", () => {
	assert.equal(isBrowserMethod("oauth-personal"), true);
	assert.equal(isBrowserMethod("oauth-business"), true);
	assert.equal(isBrowserMethod("gemini-api-key"), false);
	assert.equal(isBrowserMethod("agent-platform"), false);
});

test("resolveAuthMethod: the requested method wins when the server offers it", () => {
	assert.equal(resolveAuthMethod(parseAuthMethods(LIVE), "oauth-business")?.id, "oauth-business");
	assert.equal(resolveAuthMethod(parseAuthMethods(LIVE), "agent-platform")?.id, "agent-platform");
});

test("resolveAuthMethod: unknown or missing request falls back to the first browser method", () => {
	const methods: AgyAuthMethod[] = [
		{ id: "gemini-api-key", name: "Gemini API key" },
		{ id: "oauth-business", name: "Enterprise" },
	];
	assert.equal(resolveAuthMethod(methods, "nope")?.id, "oauth-business");
	assert.equal(resolveAuthMethod(methods)?.id, "oauth-business");
	assert.equal(resolveAuthMethod([{ id: "gemini-api-key", name: "Key" }])?.id, "gemini-api-key");
});

test("resolveAuthMethod: a silent server resolves to null so the caller keeps its default", () => {
	assert.equal(resolveAuthMethod([], "oauth-personal"), null);
});

test("authMethodLabel: uses the server's own words", () => {
	assert.equal(authMethodLabel({ id: "x", name: "Log in with Google" }), "Log in with Google");
	assert.equal(
		authMethodLabel({ id: "x", name: "Gemini API key", description: "Use an API key" }),
		"Gemini API key - Use an API key",
	);
});
