// The stream-json engine has no image channel, so images are staged on disk and
// the model is pointed at them. Losing them silently is what this replaces.
//
// Run: npm test

import { test } from "vitest";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { imagesUnavailableNote, stagePromptImages } from "../src/prompt-images.js";

const PNG = Buffer.from("fake-png-bytes").toString("base64");

test("each image is written with an extension taken from its mime type", () => {
	const staged = stagePromptImages(
		[
			{ data: PNG, mimeType: "image/png" },
			{ data: PNG, mimeType: "image/jpeg" },
			{ data: PNG, mimeType: "image/webp" },
			{ data: PNG, mimeType: "image/gif" },
			{ data: PNG, mimeType: "application/octet-stream" },
		],
		{ dir: fs.mkdtempSync(path.join(os.tmpdir(), "pi-img-test-")) },
	);
	assert.deepEqual(
		staged.paths.map((p) => path.basename(p)),
		["image-1.png", "image-2.jpg", "image-3.webp", "image-4.gif", "image-5.bin"],
	);
	assert.equal(fs.readFileSync(staged.paths[0]).toString(), "fake-png-bytes");
	staged.cleanup();
});

test("the note names every path and points at the read tool", () => {
	const staged = stagePromptImages([{ data: PNG, mimeType: "image/png" }, { data: PNG, mimeType: "image/png" }]);
	assert.match(staged.note, /attached 2 images/);
	for (const p of staged.paths) assert.ok(staged.note.includes(p), `note must name ${p}`);
	assert.match(staged.note, /read tool/);
	staged.cleanup();
});

test("cleanup removes the staging directory", () => {
	const staged = stagePromptImages([{ data: PNG, mimeType: "image/png" }]);
	assert.ok(fs.existsSync(staged.dir));
	staged.cleanup();
	assert.equal(fs.existsSync(staged.dir), false);
});

test("an unwritable staging directory throws, so the caller can say so", () => {
	assert.throws(() => stagePromptImages([{ data: PNG, mimeType: "image/png" }], { dir: "/nonexistent-root/x/y" }));
});

test("the failure note is explicit about not guessing", () => {
	assert.match(imagesUnavailableNote(1), /attached an image/);
	assert.match(imagesUnavailableNote(3), /3 images/);
	assert.match(imagesUnavailableNote(1), /instead of guessing/);
});
