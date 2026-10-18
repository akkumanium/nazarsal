import "./env";
import OpenAI from "openai";
import { closeDb,query } from "../src/server/db";
import { routingConfig } from "../src/server/routing-config";
import { walkingDirections,walkingMatrix } from "../src/server/routing";

async function main(){
  try{const rows=await query("SELECT PostGIS_Version() postgis,current_database() database");console.log("PostgreSQL/PostGIS: OK",rows[0].postgis);}catch{console.log("PostgreSQL/PostGIS: не подключён или не выполнена миграция");}
  if(process.env.OPENAI_API_KEY){try{await new OpenAI({apiKey:process.env.OPENAI_API_KEY,timeout:15000}).models.retrieve(process.env.OPENAI_MODEL||"gpt-6-luna");console.log("OpenAI: модель доступна");}catch{console.log("OpenAI: не удалось проверить доступ к модели");}}else console.log("OpenAI: отсутствует OPENAI_API_KEY");
  try{
    const {name}=routingConfig();
    const points=[{lon:71.4304,lat:51.1282},{lon:71.433,lat:51.129}];
    await walkingMatrix(points[0],[points[1]],["connection-check"],"connection-check");
    console.log(`${name}: матрица OK`);
    await walkingDirections(points);
    console.log(`${name}: маршрут OK`);
  }catch(error){console.log("Маршрутизация:",error instanceof Error?error.message:"не удалось проверить подключение");}
}
main().finally(closeDb);
