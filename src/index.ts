import { ManagerAgent } from "./agents/ManagerAgent.js";

async function main() {
  const manager = new ManagerAgent();

  await manager.run(
    "TypeScript ile iki sayıyı toplayan bir fonksiyon yaz. " +
    "Fonksiyonun adı addNumbers olsun. " +
    "5 ve 10 değerleriyle test et."
  );
}

main().catch((error) => {
  console.error("Program hatası:", error);
  process.exitCode = 1;
});
