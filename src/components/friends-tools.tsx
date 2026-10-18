"use client";

import { useEffect, useState } from "react";
import { Check, Copy, UserPlus, Users, X } from "lucide-react";
import type { CommunityProfile } from "@/lib/comments";
import { communityApi as api } from "@/lib/community-client";
import { useLanguage } from "./language-provider";

export function FriendsTools({ onChanged, initiallyOpen = false }: { onChanged: () => void; initiallyOpen?: boolean }) {
  const { t } = useLanguage();
  const [friends, setFriends] = useState<CommunityProfile[]>([]);
  const [code, setCode] = useState(""), [invite, setInvite] = useState("");
  const [busy, setBusy] = useState(false), [error, setError] = useState(""), [copied, setCopied] = useState(false);
  const [open, setOpen] = useState(initiallyOpen);
  useEffect(() => {
    if (!open) return;
    const controller = new AbortController();
    void api<{ friends: CommunityProfile[] }>("/api/community/friends", "GET", undefined, controller.signal)
      .then(data => setFriends(data.friends)).catch(cause => { if (!controller.signal.aborted) setError(cause.message); });
    return () => controller.abort();
  }, [open]);
  async function act(work: () => Promise<void>) {
    setBusy(true); setError("");
    try { await work(); } catch (cause) { setError(cause instanceof Error ? cause.message : "Не удалось выполнить действие."); }
    finally { setBusy(false); }
  }
  return <details className="comment-friends" open={open} onToggle={event => setOpen(event.currentTarget.open)}>
    <summary><Users size={15}/>{t("Друзья и приглашения")}</summary>
    <p>{t("Профиль сохраняется в этом браузере. Для добавления друга обменяйтесь одноразовым кодом.")}</p>
    <button type="button" className="comment-secondary" disabled={busy} onClick={() => void act(async () => {
      const data = await api<{ code: string }>("/api/community/invites", "POST"); setInvite(data.code); setCopied(false);
    })}><UserPlus size={15}/>{t("Создать код приглашения")}</button>
    {invite && <div className="friend-invite"><input aria-label={t("Ваш код приглашения")} value={invite} readOnly onFocus={event => event.target.select()}/><button type="button" aria-label={t("Скопировать код")} onClick={() => void act(async () => { await navigator.clipboard.writeText(invite); setCopied(true); })}>{copied ? <Check size={16}/> : <Copy size={16}/>}</button><small>{t("Код действует 24 часа и используется один раз. Новый код отменяет предыдущий.")}</small></div>}
    <form onSubmit={event => { event.preventDefault(); void act(async () => {
      const data = await api<{ friends: CommunityProfile[] }>("/api/community/friends", "POST", { code: code.trim() });
      setFriends(data.friends); setCode(""); onChanged();
    }); }}><label htmlFor="friend-code">{t("Код друга")}</label><div className="friend-code-input"><input id="friend-code" value={code} onChange={event => setCode(event.target.value)} maxLength={32} autoComplete="off" spellCheck={false}/><button type="submit" disabled={busy || code.trim().length !== 32}>{t("Добавить")}</button></div></form>
    <ul>{friends.map(friend => <li key={friend.id}><span>{friend.name}</span><button type="button" disabled={busy} aria-label={t("Удалить из друзей")} onClick={() => void act(async () => {
      const data = await api<{ friends: CommunityProfile[] }>("/api/community/friends", "DELETE", { friendId: friend.id }); setFriends(data.friends); onChanged();
    })}><X size={14}/></button></li>)}</ul>
    {error && <p className="error-message" role="alert">{t(error)}</p>}
  </details>;
}
