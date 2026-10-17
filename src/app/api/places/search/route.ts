import { searchPlaces } from "@/server/repository";
import { json } from "@/server/http";
export const runtime="nodejs";
export async function GET(request:Request){
  const term=new URL(request.url).searchParams.get("q")?.trim()??"";
  if(term.length<2||term.length>200)return json({places:[]});
  try{return json({places:await searchPlaces(term)});}catch{return json({places:[],error:"Поиск ориентиров пока недоступен."},503);}
}
