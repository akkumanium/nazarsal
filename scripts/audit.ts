import "./env";
import { mkdir,writeFile } from "node:fs/promises";
import { auditData } from "../src/data/coverage";
import { closeDb } from "../src/server/db";
async function main(){
  const report=await auditData(process.argv.find(a=>a.startsWith("--run="))?.slice(6));
  await mkdir("data",{recursive:true});
  await writeFile("data/audit.json",JSON.stringify(report,null,2));
  console.log(JSON.stringify(report,null,2));
  if(!report.passed)process.exitCode=1;
}
main().catch((e:Error)=>{console.error("Проверка не выполнена:",e.message);process.exitCode=1;}).finally(closeDb);
