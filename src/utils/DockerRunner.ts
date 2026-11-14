
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

export interface ExecutionResult {
  success: boolean;
  output: string;
  error: string;
}

export class DockerRunner {
  run(code: string): ExecutionResult {
    const tempDir = mkdtempSync(join(tmpdir(), "local-agent-team-"));
    const jsFile = join(tempDir, "generated.js");

    try {
      writeFileSync(jsFile, code, "utf8");

      const output = execFileSync(
        "docker",
        [
          "run",
          "--rm",
          "--network", "none",
          "--memory=128m",
          "--cpus=0.5",
          "--pids-limit=64",
          "--read-only",
          "--tmpfs", "/tmp:rw,noexec,nosuid,size=16m",
          "--cap-drop=ALL",
          "--security-opt=no-new-privileges",
          "--mount",
          `type=bind,source=${tempDir},target=/workspace,readonly`,
          "--workdir", "/workspace",
          "node:22-alpine",
          "node",
          "--max-old-space-size=64",
          "/workspace/generated.js",
        ],
        {
          encoding: "utf8",
          timeout: 15_000,
          maxBuffer: 1024 * 1024,
        },
      );

      return {
        success: true,
        output,
        error: "",
      };
    } catch (error) {
      const result = error as {
        stdout?: string;
        stderr?: string;
        message?: string;
      };

      return {
        success: false,
        output: result.stdout ?? "",
        error: result.stderr || result.message || "Kod çalıştırılamadı.",
      };
    } finally {
      rmSync(tempDir, { recursive: true, force: true });
    }
  }
}
