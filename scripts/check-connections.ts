import "./env";
import OpenAI from "openai";
import { closeDb,query } from "../src/server/db";

async function main(){
  try{const rows=await query("SELECT PostGIS_Version() postgis,current_database() database");console.log("PostgreSQL/PostGIS: OK",rows[0].postgis);}catch{console.log("PostgreSQL/PostGIS: не подключён или не выполнена миграция");}
  if(process.env.OPENAI_API_KEY){try{await new OpenAI({apiKey:process.env.OPENAI_API_KEY,timeout:15000}).models.retrieve(process.env.OPENAI_MODEL||"gpt-6-luna");console.log("OpenAI: модель доступна");}catch{console.log("OpenAI: не удалось проверить доступ к модели");}}else console.log("OpenAI: отсутствует OPENAI_API_KEY");
  if(process.env.ORS_API_KEY){try{const r=await fetch("https://api.openrouteservice.org/v2/matrix/foot-walking",{method:"POST",headers:{Authorization:process.env.ORS_API_KEY,"Content-Type":"application/json"},body:JSON.stringify({locations:[[71.4304,51.1282],[71.433,51.129]],metrics:["duration","distance"]}),signal:AbortSignal.timeout(15000)});console.log(r.ok?"openrouteservice: OK":"openrouteservice: ключ или сервис недоступен");}catch{console.log("openrouteservice: сеть недоступна");}}else console.log("openrouteservice: отсутствует ORS_API_KEY");
}
main().finally(closeDb);
