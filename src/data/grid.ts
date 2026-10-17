import proj4 from "proj4";
export const ASTANA_UTM="+proj=utm +zone=42 +datum=WGS84 +units=m +no_defs";
export type Tile={id:string;parentId:string|null;depth:number;minX:number;minY:number;maxX:number;maxY:number};
export function tileBBox(tile:Tile):[number,number,number,number]{
  const corners=[[tile.minX,tile.minY],[tile.minX,tile.maxY],[tile.maxX,tile.minY],[tile.maxX,tile.maxY]].map(c=>proj4(ASTANA_UTM,"EPSG:4326",c));
  return [Math.min(...corners.map(c=>c[1])),Math.min(...corners.map(c=>c[0])),Math.max(...corners.map(c=>c[1])),Math.max(...corners.map(c=>c[0]))];
}
export function splitTile(tile:Tile):Tile[]{
  const x=(tile.minX+tile.maxX)/2,y=(tile.minY+tile.maxY)/2;
  return [[tile.minX,tile.minY,x,y],[x,tile.minY,tile.maxX,y],[tile.minX,y,x,tile.maxY],[x,y,tile.maxX,tile.maxY]].map((a,i)=>({id:`${tile.id}.${i}`,parentId:tile.id,depth:tile.depth+1,minX:a[0],minY:a[1],maxX:a[2],maxY:a[3]}));
}
