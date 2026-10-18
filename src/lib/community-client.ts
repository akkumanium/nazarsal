"use client";

import type { CommunityProfile } from "./comments";

export const COMMUNITY_UPDATED_EVENT = "nazarsal:community-updated";
export function notifyCommunityUpdate() { window.dispatchEvent(new Event(COMMUNITY_UPDATED_EVENT)); }

export async function communityApi<T>(url: string, method = "GET", body?: unknown, signal?: AbortSignal): Promise<T> {
  const response = await fetch(url, {
    method, cache: "no-store", credentials: "same-origin", signal,
    ...(body === undefined ? {} : { headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) }),
  });
  const data = await response.json();
  if (!response.ok) throw new Error(data.error ?? "Не удалось выполнить действие.");
  return data as T;
}

let sessionRequest: Promise<CommunityProfile> | null = null;
export function ensureCommunitySession(): Promise<CommunityProfile> {
  if (!sessionRequest) sessionRequest = communityApi<{ profile: CommunityProfile }>("/api/community/session", "POST")
    .then(data => data.profile).finally(() => { sessionRequest = null; });
  return sessionRequest;
}
