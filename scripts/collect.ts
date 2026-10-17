import "./env";
import { collect } from "../src/data/collector";
import { closeDb } from "../src/server/db";
collect(process.argv.includes("--new")).catch((error:Error)=>{
  console.error("Импорт остановлен:",error.message);
  console.error("Предыдущая опубликованная версия сохранена. Повторите pnpm data:collect для продолжения.");
  process.exitCode=1;
}).finally(closeDb);
