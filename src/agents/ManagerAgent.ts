
import { DeveloperAgent } from "./DeveloperAgent.js";
import { ReviewerAgent } from "./ReviewerAgent.js";
import { execFileSync } from "node:child_process";
import { DockerRunner } from "../utils/DockerRunner.js";
import {
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";

interface ValidationResult {
  valid: boolean;
  errors: string;
}

export class ManagerAgent {
  private readonly dockerRunner = new DockerRunner();
  private readonly developer = new DeveloperAgent();
  private readonly reviewer = new ReviewerAgent();
  private readonly maxAttempts = 3;

  private extractCode(output: string): { code?: string; error?: string } {
    const matches = [
      ...output.matchAll(/```(?:typescript|ts)\s*\n?([\s\S]*?)```/gi),
    ];

    if (matches.length !== 1) {
      return {
        error: matches.length === 0
          ? "Developer çıktısında TypeScript kod bloğu bulunamadı."
          : `Tek kod bloğu bekleniyordu, ${matches.length} kod bloğu bulundu.`,
      };
    }

    const code = matches[0]?.[1]?.trim();

    if (!code) {
      return { error: "TypeScript kod bloğu boş." };
    }

    return { code };
  }

  private validateCode(code: string): ValidationResult {
    const projectRoot = process.cwd();
    const compiler = join(
      projectRoot,
      "node_modules",
      "typescript",
      "bin",
      "tsc",
    );
    const tempDir = mkdtempSync(
      join(projectRoot, ".agent-validation-"),
    );
    const tempFile = join(tempDir, "generated.ts");

    try {
      writeFileSync(tempFile, code, "utf8");

      execFileSync(
        process.execPath,
        [
          compiler,
          "--ignoreConfig",
          tempFile,
          "--noEmit",
          "--strict",
          "--target", "ES2022",
          "--module", "NodeNext",
          "--moduleResolution", "NodeNext",
          "--skipLibCheck",
        ],
        {
          cwd: projectRoot,
          encoding: "utf8",
          stdio: "pipe",
          timeout: 30_000,
        },
      );

      return {
        valid: true,
        errors: "TypeScript derleme kontrolü başarılı.",
      };
    } catch (error) {
      const result = error as {
        stdout?: string;
        stderr?: string;
        message?: string;
      };

      return {
        valid: false,
        errors: [result.stdout, result.stderr, result.message]
          .filter(Boolean)
          .join("\n"),
      };
    } finally {
      rmSync(tempDir, { recursive: true, force: true });
    }
  }

  private transpileCode(code: string): string {
    const projectRoot = process.cwd();
    const compiler = join(
      projectRoot,
      "node_modules",
      "typescript",
      "bin",
      "tsc",
    );
    const tempDir = mkdtempSync(
      join(projectRoot, ".agent-transpile-"),
    );
    const tempFile = join(tempDir, "generated.ts");

    try {
      writeFileSync(tempFile, code, "utf8");

      execFileSync(
        process.execPath,
        [
          compiler,
          "--ignoreConfig",
          tempFile,
          "--target", "ES2022",
          "--module", "NodeNext",
          "--moduleResolution", "NodeNext",
          "--skipLibCheck",
          "--outDir", tempDir,
        ],
        {
          cwd: projectRoot,
          encoding: "utf8",
          stdio: "pipe",
          timeout: 30_000,
        },
      );

      return readFileSync(
        join(tempDir, "generated.js"),
        "utf8",
      );
    } finally {
      rmSync(tempDir, { recursive: true, force: true });
    }
  }

  async run(task: string): Promise<void> {
    console.log("\n[Manager Agent] Görev alındı.");

    let currentTask = task;

    for (
      let attempt = 1;
      attempt <= this.maxAttempts;
      attempt += 1
    ) {
      console.log(
        `\n[Manager Agent] Deneme: ${attempt}/${this.maxAttempts}`,
      );

      try {
        const developerOutput = await this.developer.run(currentTask);

        console.log("\n--- DEVELOPER ÇIKTISI ---\n");
        console.log(developerOutput);

        const extracted = this.extractCode(developerOutput);

        const validation = extracted.code
          ? this.validateCode(extracted.code)
          : {
              valid: false,
              errors: extracted.error ?? "Kod ayrıştırılamadı.",
            };

        let execution = {
          success: false,
          output: "",
          error: "Kod çıkarılamadığı için çalıştırılamadı.",
        };

        if (extracted.code && validation.valid) {
          try {
            const javascript = this.transpileCode(extracted.code);
            execution = this.dockerRunner.run(javascript);
          } catch (error) {
            execution.error = error instanceof Error
              ? error.message
              : String(error);
          }
        }

        console.log("\n--- TYPESCRIPT VALIDATION ---\n");
        console.log(validation.errors);

        console.log("\n--- DOCKER EXECUTION ---\n");
        console.log("Başarılı:", execution.success);
        console.log("Çıktı:", execution.output);
        console.log("Hata:", execution.error);
        const testPassed =
          execution.success &&
          execution.output.includes("TEST PASSED");

        console.log("\n--- AUTOMATED TEST RESULT ---\n");
        console.log("Test başarılı:", testPassed);

        const review = await this.reviewer.run(
          `ORİJİNAL GÖREV:\n${task}\n\n` +
          `DEVELOPER ÇIKTISI:\n${developerOutput}\n\n` +
          `TYPESCRIPT KONTROLÜ:\n${validation.errors}\n\n` +
          `DOCKER ÇALIŞTIRMA SONUCU:\n` +
          `Başarılı: ${execution.success}\n` +
          `Çıktı: ${execution.output}\n` +
          `Hata: ${execution.error}\n\n` +
          `TEST SONUCU: ${testPassed ? "BAŞARILI" : "BAŞARISIZ"}\n\n` +
          "Görevin karşılanıp karşılanmadığını değerlendir. " +
          "TypeScript veya Docker kontrolü başarısızsa NEEDS_CHANGES ver. " +
          "Sonuç satırını istenen biçimde yaz.",
        );

        console.log("\n--- REVIEWER ÇIKTISI ---\n");
        console.log(review);

        const approvalMatch = review.match(
          /^\s*Sonuç:\s*(APPROVED|NEEDS_CHANGES)\s*$/im,
        );

        const reviewerApproved =
          approvalMatch?.[1] === "APPROVED";

        if (
          reviewerApproved &&
          validation.valid &&
          execution.success &&
          testPassed
        ) {
          console.log(
            "\n[Manager Agent] Reviewer, TypeScript ve Docker kontrolleri onayladı.",
          );
          console.log(
            "[Manager Agent] Görev başarıyla tamamlandı.",
          );
          return;
        }

        currentTask =
          `Orijinal görev:\n${task}\n\n` +
          `Önceki Developer çıktısı:\n${developerOutput}\n\n` +
          `Reviewer geri bildirimi:\n${review}\n\n` +
          `TypeScript kontrolü:\n${validation.errors}\n\n` +
          `Docker çalıştırma sonucu:\n${execution.success}\n` +
          `Çıktı: ${execution.output}\n` +
          `Hata: ${execution.error}\n\n` +
          "Sorunları düzelt. İstenen kapsamı koru. " +
          "Yalnızca bir TypeScript kod bloğu üret.";
      } catch (error) {
        const message = error instanceof Error
          ? error.message
          : String(error);

        console.error(
          `\n[Manager Agent] Deneme başarısız: ${message}`,
        );

        if (attempt === this.maxAttempts) {
          throw error;
        }

        currentTask =
          `${task}\n\n` +
          `Önceki denemede oluşan hata: ${message}\n` +
          "Bu hatayı dikkate alarak görevi yeniden dene.";
      }
    }

    console.log(
      "\n[Manager Agent] Maksimum deneme sayısına ulaşıldı; görev onaylanmadı.",
    );
  }
}
