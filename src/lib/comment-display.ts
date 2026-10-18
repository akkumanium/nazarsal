"use client";

import { useSyncExternalStore } from "react";

const STORAGE_KEY = "nazarsal-show-comments";
const CHANGE_EVENT = "nazarsal:comment-display-changed";
let fallback = true;

function snapshot() {
  try {
    const saved = localStorage.getItem(STORAGE_KEY);
    return saved === null ? fallback : saved !== "false";
  } catch { return fallback; }
}
function subscribe(changed: () => void) {
  const storage = (event: StorageEvent) => { if (event.key === STORAGE_KEY || event.key === null) changed(); };
  window.addEventListener(CHANGE_EVENT, changed);
  window.addEventListener("storage", storage);
  return () => { window.removeEventListener(CHANGE_EVENT, changed); window.removeEventListener("storage", storage); };
}
function setVisible(visible: boolean) {
  fallback = visible;
  try { localStorage.setItem(STORAGE_KEY, String(visible)); } catch { /* Keep this visit's choice when storage is disabled. */ }
  window.dispatchEvent(new Event(CHANGE_EVENT));
}
export function useCommentDisplay() {
  const showComments = useSyncExternalStore(subscribe, snapshot, () => true);
  return { showComments, setShowComments: setVisible };
}
