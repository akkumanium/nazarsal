import { Pool, type PoolClient, type QueryResultRow } from "pg";
import type { PGlite } from "@electric-sql/pglite";

type GlobalDb = typeof globalThis & { qadamPool?: Pool; qadamLocal?: Promise<PGlite>; qadamLocalLock?:string };
export type SqlClient = Pick<PoolClient, "query">;
export class ConfigurationError extends Error {
  constructor(message: string) { super(message); this.name = "ConfigurationError"; }
}
export function db(): Pool {
  if (!process.env.DATABASE_URL) throw new ConfigurationError("Подключите PostgreSQL: заполните DATABASE_URL и выполните pnpm db:migrate.");
  const globalDb = globalThis as GlobalDb;
  if (!globalDb.qadamPool) globalDb.qadamPool = new Pool({
    connectionString: process.env.DATABASE_URL,
    ssl: process.env.DATABASE_SSL === "false" ? false : { rejectUnauthorized: true },
    max: 5, connectionTimeoutMillis: 8000, idleTimeoutMillis: 20000,
    options: "-c search_path=public,extensions -c statement_timeout=30000",
    application_name: "qadam"
  });
  return globalDb.qadamPool;
}
export async function query<T extends QueryResultRow = QueryResultRow>(text: string, values: unknown[] = []): Promise<T[]> {
  if (process.env.LOCAL_DATABASE_PATH && !process.env.DATABASE_URL) return (await (await localDatabase()).query<T>(text,values)).rows;
  return (await db().query<T>(text, values)).rows;
}
export async function localDatabase(): Promise<PGlite> {
  const g=globalThis as GlobalDb;
  if(!g.qadamLocal)g.qadamLocal=(async()=>{
    // PostGIS' large WASM functions can exhaust V8's optimizing compiler on Windows.
    // This affects only the optional embedded development engine, not Supabase.
    (await import("node:v8")).setFlagsFromString("--wasm-num-compilation-tasks=1 --liftoff-only");
    const [{PGlite},{postgis},{pg_trgm},{resolve},fs]=await Promise.all([import("@electric-sql/pglite"),import("@electric-sql/pglite-postgis"),import("@electric-sql/pglite/contrib/pg_trgm"),import("node:path"),import("node:fs/promises")]);
    const directory=resolve(process.env.LOCAL_DATABASE_PATH!);
    await fs.mkdir(directory,{recursive:true});
    const lock=resolve(directory,"qadam-process.lock");
    let handle;
    try{handle=await fs.open(lock,"wx");}
    catch(error){
      if((error as NodeJS.ErrnoException).code!=="EEXIST")throw error;
      const owner=Number(await fs.readFile(lock,"utf8"));
      if(!Number.isSafeInteger(owner)||owner<=0)throw new ConfigurationError("Некорректная блокировка локальной базы.");
      try{process.kill(owner,0);throw new ConfigurationError("Локальная база открыта в другом процессе. Остановите веб-сервер перед запуском сборщика.");}
      catch(check){if((check as NodeJS.ErrnoException).code!=="ESRCH")throw check;}
      await fs.unlink(lock);handle=await fs.open(lock,"wx");
    }
    await handle.writeFile(String(process.pid));await handle.close();g.qadamLocalLock=lock;
    const database=new PGlite({dataDir:resolve(process.env.LOCAL_DATABASE_PATH!),extensions:{postgis,pg_trgm}});
    await database.waitReady;
    await database.exec("SET search_path TO public, extensions; SET timezone TO 'Asia/Almaty';");
    return database;
  })().catch(async error=>{
    if(g.qadamLocalLock){try{await(await import("node:fs/promises")).unlink(g.qadamLocalLock);}catch{}delete g.qadamLocalLock;}
    delete g.qadamLocal;throw error;
  });
  return g.qadamLocal;
}
export async function execSql(text:string):Promise<void>{
  if(process.env.LOCAL_DATABASE_PATH&&!process.env.DATABASE_URL){await (await localDatabase()).exec(text);return;}
  await db().query(text);
}
export async function transaction<T>(work: (client: SqlClient) => Promise<T>): Promise<T> {
  if(process.env.LOCAL_DATABASE_PATH&&!process.env.DATABASE_URL){
    return (await localDatabase()).transaction(async tx=>work({query:tx.query.bind(tx)} as unknown as SqlClient));
  }
  const client = await db().connect();
  try { await client.query("BEGIN"); const result = await work(client); await client.query("COMMIT"); return result; }
  catch (error) { await client.query("ROLLBACK"); throw error; }
  finally { client.release(); }
}
export async function closeDb() {
  const g = globalThis as GlobalDb;
  if (g.qadamPool) { await g.qadamPool.end(); delete g.qadamPool; }
  if (g.qadamLocal) { try{await (await g.qadamLocal).close();}catch{} delete g.qadamLocal; }
  if(g.qadamLocalLock){try{await(await import("node:fs/promises")).unlink(g.qadamLocalLock);}catch{}delete g.qadamLocalLock;}
}
