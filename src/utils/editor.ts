import { platform } from "node:os";
import { $ } from "bun";
import type { BacklogConfig } from "../types/index.ts";

/**
 * Get the default editor based on the operating system
 */
function getPlatformDefaultEditor(): string {
	const os = platform();
	switch (os) {
		case "win32":
			return "notepad";
		case "darwin":
			// macOS typically has nano available
			return "nano";
		case "linux":
			return "nano";
		default:
			// Fallback to vi which is available on most unix systems
			return "vi";
	}
}

/**
 * Resolve the editor command based on configuration, environment, and platform defaults
 * Priority: EDITOR env var -> config.defaultEditor -> platform default
 */
export function resolveEditor(config?: BacklogConfig | null): string {
	// First check environment variable
	const editorEnv = process.env.EDITOR;
	if (editorEnv) {
		return editorEnv;
	}

	// Then check config
	if (config?.defaultEditor) {
		return config.defaultEditor;
	}

	// Finally use platform default
	return getPlatformDefaultEditor();
}

/**
 * Check if an editor command is available on the system
 */
export async function isEditorAvailable(editor: string): Promise<boolean> {
	try {
		// Try to run the editor with --version or --help to check if it exists
		// Split the editor command in case it has arguments
		const parts = editor.split(" ");
		const command = parts[0] ?? editor;

		// For Windows, just check if the command exists
		if (platform() === "win32") {
			try {
				await $`where ${command}`.quiet();
				return true;
			} catch {
				return false;
			}
		}

		// For Unix-like systems, use which
		try {
			await $`which ${command}`.quiet();
			return true;
		} catch {
			return false;
		}
	} catch {
		return false;
	}
}

/**
 * Open a file in the editor
 *
 * When attached to a real terminal, the editor is spawned with a pseudo-terminal
 * (Bun's `terminal` option) and stdin is forwarded in raw mode. This avoids the
 * input lag and dropped keystrokes that occur when interactive editors are run
 * with `stdin: "inherit"` under Bun (the parent keeps polling the shared TTY).
 * In non-interactive contexts (no TTY) it falls back to inherited stdio.
 */
export async function openInEditor(filePath: string, config?: BacklogConfig | null): Promise<boolean> {
	const editor = resolveEditor(config);

	// Split the editor command in case it has arguments
	const parts = editor.split(" ");
	const command = parts[0] ?? editor;
	const args = [...parts.slice(1), filePath];

	const stdin = process.stdin;
	const stdout = process.stdout;
	const interactive = Boolean(stdout.isTTY && stdin.isTTY && typeof stdin.setRawMode === "function");

	// Non-interactive fallback (piped/headless): inherited stdio is fine here and
	// avoids setRawMode on a non-TTY, which would throw.
	if (!interactive) {
		try {
			const subprocess = Bun.spawn([command, ...args], {
				stdin: "inherit",
				stdout: "inherit",
				stderr: "inherit",
			});
			return (await subprocess.exited) === 0;
		} catch (error) {
			console.error(`Failed to open editor: ${error}`);
			return false;
		}
	}

	try {
		const proc = Bun.spawn([command, ...args], {
			terminal: {
				cols: stdout.columns ?? 80,
				rows: stdout.rows ?? 24,
				data(_term: unknown, data: Uint8Array) {
					stdout.write(data);
				},
			},
		});

		const term = (proc as unknown as { terminal?: { write(d: Uint8Array): void; resize(c: number, r: number): void } })
			.terminal;

		const onResize = () => term?.resize(stdout.columns ?? 80, stdout.rows ?? 24);
		const onData = (chunk: Uint8Array) => term?.write(chunk);

		const wasRaw = Boolean(stdin.isRaw);
		stdin.setRawMode(true);
		stdin.resume();
		stdin.on("data", onData);
		stdout.on("resize", onResize);

		try {
			return (await proc.exited) === 0;
		} finally {
			stdin.off("data", onData);
			stdout.off("resize", onResize);
			if (!wasRaw) stdin.setRawMode(false);
			stdin.pause();
		}
	} catch (error) {
		console.error(`Failed to open editor: ${error}`);
		return false;
	}
}
