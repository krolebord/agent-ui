import spawn from "nano-spawn";

export type HookRuntime = "bun" | "node";

export async function detectHookRuntime(): Promise<HookRuntime> {
  try {
    await spawn("bun", ["--version"], { timeout: 3000 });
    return "bun";
  } catch {
    return "node";
  }
}
