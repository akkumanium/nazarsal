import { z } from "zod";
import type { Point } from "./types";

export const COMMENT_LIFETIMES = [1, 6, 24, 72, 168] as const;
export const commentInputSchema = z.object({
  poiId: z.string().regex(/^(node|way|relation)\/\d+$/).max(80),
  text: z.string().trim().min(3).max(1000),
  lifetimeHours: z.union([z.literal(1), z.literal(6), z.literal(24), z.literal(72), z.literal(168)]),
  visibility: z.enum(["public", "friends"]),
}).strict();
export type CommentInput = z.infer<typeof commentInputSchema>;
export const mapBoundsSchema = z.object({
  west: z.coerce.number().min(-180).max(180), south: z.coerce.number().min(-90).max(90),
  east: z.coerce.number().min(-180).max(180), north: z.coerce.number().min(-90).max(90),
}).refine(b => b.east > b.west && b.north > b.south && b.east - b.west <= 3 && b.north - b.south <= 2);
export type MapBounds = z.infer<typeof mapBoundsSchema>;
export type CommentPlace = { id: string; name: string; point: Point };
export type MapComment = {
  id: string; place: CommentPlace; text: string; visibility: "public" | "friends";
  author: { id: string; name: string }; createdAt: string; expiresAt: string; canDelete: boolean;
};
export type CommunityProfile = { id: string; name: string };
export const profileNameSchema = z.object({ name: z.string().trim().min(2).max(60).regex(/^[^\u0000-\u001f\u007f]+$/) }).strict();
export type ProfileSummary = { profile: CommunityProfile; activeComments: number; friendsCount: number };
export function boundsParams(bounds: MapBounds): string {
  return new URLSearchParams(Object.entries(bounds).map(([key, value]) => [key, String(value)])).toString();
}
