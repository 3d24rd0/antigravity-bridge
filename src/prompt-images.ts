// The stream-json engine cannot carry pixels: agy's turn input is text. Pi can
// still hand the model an image, so the bridge writes it to disk and points the
// model at it, where the bridge's own read tool (which does return images)
// picks it up.
//
// Files are per-turn, 0600 and removed when the turn settles.

import fs from "node:fs";
import os from "node:os";
import path from "node:path";

export interface PromptImage {
	data: string;
	mimeType: string;
}

const EXTENSIONS: Record<string, string> = {
	"image/png": "png",
	"image/jpeg": "jpg",
	"image/webp": "webp",
	"image/gif": "gif",
};

export interface StagedImages {
	dir: string;
	paths: string[];
	/** Prompt addendum telling the model where the pixels are. */
	note: string;
	cleanup: () => void;
}

/**
 * Write each image to its own file and describe them to the model.
 *
 * Throws when a file cannot be written; the caller degrades to an explicit
 * "could not be delivered" note rather than dropping the image silently. The
 * caller owns `cleanup()`.
 */
export function stagePromptImages(images: PromptImage[], opts: { dir?: string } = {}): StagedImages {
	if (images.length === 0) throw new Error("stagePromptImages called with no images");
	const dir = opts.dir ?? fs.mkdtempSync(path.join(os.tmpdir(), "pi-bridge-images-"));
	const paths: string[] = [];
	for (const [i, image] of images.entries()) {
		const ext = EXTENSIONS[image.mimeType] ?? "bin";
		const file = path.join(dir, `image-${i + 1}.${ext}`);
		fs.writeFileSync(file, Buffer.from(image.data, "base64"), { mode: 0o600 });
		paths.push(file);
	}
	const note = [
		`The user attached ${paths.length === 1 ? "an image" : `${paths.length} images`}. This engine's turn input is text-only, so the pixels were written to disk:`,
		...paths.map((p) => `- ${p}`),
		"Read them with the bridge's read tool before answering. Do not guess at their contents.",
	].join("\n");
	return {
		dir,
		paths,
		note,
		cleanup: () => {
			try {
				fs.rmSync(dir, { recursive: true, force: true });
			} catch {
				// A leftover temp dir is better than failing a settled turn.
			}
		},
	};
}

/** Prompt addendum when an image genuinely could not be staged. */
export function imagesUnavailableNote(count: number): string {
	return `The user attached ${count === 1 ? "an image" : `${count} images`}, but this engine could not write them to disk for reading. Say so plainly instead of guessing at their contents.`;
}
