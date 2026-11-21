// @effect-diagnostics nodeBuiltinImport:off -- process identity and pidfds are local OS facts.
import * as NodeChildProcess from "node:child_process";
import * as NodeFSP from "node:fs/promises";
import * as NodeUtil from "node:util";

const exec = NodeUtil.promisify(NodeChildProcess.execFile);

export interface ManagedProcessIdentity {
  readonly start: string;
  readonly image: string;
}

type ProcessEvidence =
  | { readonly state: "alive"; readonly identity: ManagedProcessIdentity }
  | { readonly state: "gone"; readonly start?: string }
  | { readonly state: "unknown" };

export const isMissing = (error: unknown) =>
  error instanceof Error && "code" in error && error.code === "ENOENT";

export async function observeManagedProcess(
  platform: NodeJS.Platform,
  pid: number,
): Promise<ProcessEvidence> {
  if (platform !== "linux") {
    try {
      process.kill(pid, 0);
    } catch (error) {
      if (error instanceof Error && "code" in error && error.code === "ESRCH")
        return { state: "gone" };
    }
    return { state: "unknown" };
  }
  const base = `/proc/${pid}`;
  const read = async () => {
    const stat = await NodeFSP.readFile(`${base}/stat`, "utf8");
    const fields = stat.slice(stat.lastIndexOf(")") + 2).split(" ");
    return { state: fields[0], start: fields[19] };
  };
  try {
    const { state, start } = await read();
    if (!start || !/^\d+$/.test(start)) return { state: "unknown" };
    if (state === "Z" || state === "X") return { state: "gone", start };
    const exe = await NodeFSP.stat(`${base}/exe`, { bigint: true });
    const after = await read();
    if (after.start !== start) return { state: "unknown" };
    if (after.state === "Z" || after.state === "X") return { state: "gone", start };
    return { state: "alive", identity: { start, image: `${exe.dev}:${exe.ino}` } };
  } catch (error) {
    if (isMissing(error)) {
      // exe may disappear independently of the process (e.g. during exit). Do not
      // count that alone as death, nor turn permission or read errors into death.
      try {
        const { state, start } = await read();
        if (state === "Z" || state === "X")
          return start ? { state: "gone", start } : { state: "gone" };
      } catch (cause) {
        if (isMissing(cause)) return { state: "gone" };
      }
    }
    return { state: "unknown" };
  }
}

// Opening the pidfd *before* revalidating /proc prevents signaling a replacement
// PID if the verified owner dies while the signal is being dispatched. On hosts
// without Linux pidfds or the OS Python runtime this action fails closed.
const signalVerified = `
import os, signal, sys
pid, start, image = sys.argv[1:]
fd = os.pidfd_open(int(pid))
with open('/proc/' + pid + '/stat') as f:
    fields = f.read().rsplit(')', 1)[1].split()
exe = os.stat('/proc/' + pid + '/exe')
if fields[19] != start or fields[0] in ('Z', 'X') or f'{exe.st_dev}:{exe.st_ino}' != image:
    sys.exit(42)
signal.pidfd_send_signal(fd, signal.SIGKILL)
`;

export const killManagedProcess = (
  pid: number,
  identity: ManagedProcessIdentity,
  signal: AbortSignal,
) =>
  exec(
    "/usr/bin/python3",
    ["-I", "-S", "-c", signalVerified, String(pid), identity.start, identity.image],
    {
      signal,
      timeout: 3000,
      maxBuffer: 65536,
    },
  );
