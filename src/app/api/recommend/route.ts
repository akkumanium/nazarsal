import { requestSchema } from "@/lib/intent";
import { recommend } from "@/server/recommend";
import { allowRecommendation,json,sameOrigin } from "@/server/http";
export const runtime="nodejs";
export const maxDuration=120;
export async function POST(request:Request){
  if(!sameOrigin(request))return json({error:"Недопустимый источник запроса."},403);
  if(Number(request.headers.get("content-length"))>32000)return json({error:"Запрос слишком большой."},413);
  let body:unknown;
  try{const text=await request.text();if(text.length>32000)return json({error:"Запрос слишком большой."},413);body=JSON.parse(text);}catch{return json({error:"Ожидается JSON."},400);}
  const parsed=requestSchema.safeParse(body);
  if(!parsed.success)return json({error:"Проверьте текст запроса, координаты и параметры прогулки."},400);
  try{
    if(process.env.OPENAI_API_KEY&&!await allowRecommendation(request))return json({error:"Слишком много запросов. Попробуйте немного позже."},429);
    const result=await recommend(parsed.data);
    return json(result,result.status==="service_unavailable"?503:200);
  }catch{return json({error:"Не удалось подключиться к базе. Проверьте конфигурацию сервера."},503);}
}
