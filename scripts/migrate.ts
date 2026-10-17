import "./env";
import { readdir,readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { closeDb,execSql,query } from "../src/server/db";

async function migrate(){
  await execSql("CREATE TABLE IF NOT EXISTS qadam_migrations(name text PRIMARY KEY,applied_at timestamptz NOT NULL DEFAULT now())");
  for(const file of (await readdir(resolve("db/migrations"))).filter(f=>f.endsWith(".sql")).sort()){
    const exists=await query("SELECT name FROM qadam_migrations WHERE name=$1",[file]);
    if(exists.length)continue;
    const sql=await readFile(resolve("db/migrations",file),"utf8");
    // A failed migration must not be recorded or partially committed.
    await execSql(`BEGIN;\n${sql}\nINSERT INTO qadam_migrations(name) VALUES('${file.replaceAll("'","''")}');\nCOMMIT;`);
    console.log(`Применена миграция ${file}`);
  }
  console.log("Схема PostgreSQL/PostGIS готова.");
}
migrate().catch((error:Error)=>{console.error("Миграция не выполнена:",error.message);process.exitCode=1;}).finally(closeDb);
