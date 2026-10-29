// The only way the CLI starts another process: node:child_process execFile with a FIXED executable
// name and a FIXED argument array (never user input), no shell, a timeout and a 1 MB output cap
// (PLAN.md M4 acceptance 2). There is no `exec` and no `shell: true` anywhere in cli/.
import { execFile } from "node:child_process";

export interface ExecOptions {
  timeout: number;
  maxBuffer: number;
  windowsHide: true;
  shell: false;
  encoding: "utf8";
}

export interface ExecResult {
  stdout: string;
}

export type ExecFileLike = (file: string, args: readonly string[], options: ExecOptions) => Promise<ExecResult>;

export const PROBE_TIMEOUT_MS = 5000;
export const PROBE_MAX_BUFFER = 1_048_576;

export const PROBE_EXEC_OPTIONS: ExecOptions = Object.freeze({
  timeout: PROBE_TIMEOUT_MS,
  maxBuffer: PROBE_MAX_BUFFER,
  windowsHide: true,
  shell: false,
  encoding: "utf8",
});

/** Real execFile; rejects on spawn failure, non-zero exit, timeout or output over maxBuffer. */
export function nodeExecFile(): ExecFileLike {
  return (file, args, options) =>
    new Promise<ExecResult>((resolve, reject) => {
      execFile(
        file,
        [...args],
        {
          timeout: options.timeout,
          maxBuffer: options.maxBuffer,
          windowsHide: options.windowsHide,
          shell: false,
          encoding: "utf8",
        },
        (error, stdout) => {
          if (error !== null) reject(error);
          else resolve({ stdout: String(stdout) });
        },
      );
    });
}
