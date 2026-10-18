"use client";

import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { Check, ChevronDown, LoaderCircle, MessageCircle, Settings2, ShieldCheck, UserRound, Users, X } from "lucide-react";
import type { CommunityProfile, ProfileSummary } from "@/lib/comments";
import { COMMUNITY_UPDATED_EVENT, communityApi, ensureCommunitySession, notifyCommunityUpdate } from "@/lib/community-client";
import { FriendsTools } from "./friends-tools";
import { useLanguage } from "./language-provider";
import { useCommentDisplay } from "@/lib/comment-display";

export function ProfileButton() {
  const { t, language } = useLanguage();
  const { showComments, setShowComments } = useCommentDisplay();
  const [open, setOpen] = useState(false), [loading, setLoading] = useState(false), [saving, setSaving] = useState(false);
  const [summary, setSummary] = useState<ProfileSummary | null>(null), [name, setName] = useState("");
  const [error, setError] = useState(""), [saved, setSaved] = useState(false), [revision, setRevision] = useState(0);
  const trigger = useRef<HTMLButtonElement>(null), panel = useRef<HTMLElement>(null);

  useEffect(() => {
    if (!open) return;
    const controller = new AbortController();
    setLoading(true); setError("");
    void ensureCommunitySession().then(() => {
      if (controller.signal.aborted) return null;
      return communityApi<ProfileSummary>("/api/community/profile", "GET", undefined, controller.signal);
    }).then(data => {
      if (!data || controller.signal.aborted) return;
      setSummary(data); setName(data.profile.name);
    }).catch(cause => { if (!controller.signal.aborted) setError(cause instanceof Error ? cause.message : "Не удалось выполнить действие."); })
      .finally(() => { if (!controller.signal.aborted) setLoading(false); });
    return () => controller.abort();
  }, [open, revision]);

  useEffect(() => {
    if (!open) return;
    const changed = () => setRevision(value => value + 1);
    window.addEventListener(COMMUNITY_UPDATED_EVENT, changed);
    return () => window.removeEventListener(COMMUNITY_UPDATED_EVENT, changed);
  }, [open]);

  useEffect(() => {
    if (!open) return;
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    panel.current?.focus({ preventScroll: true });
    const keyboard = (event: KeyboardEvent) => {
      if (event.key === "Escape") { event.preventDefault(); event.stopPropagation(); setOpen(false); return; }
      if (event.key !== "Tab") return;
      const controls = Array.from(panel.current?.querySelectorAll<HTMLElement>('button:not(:disabled),input:not(:disabled),select:not(:disabled),summary,a[href],[tabindex="0"]') ?? [])
        .filter(element => element.getClientRects().length > 0);
      const first = controls[0], last = controls.at(-1);
      if (!first) { event.preventDefault(); return; }
      if (event.shiftKey && (document.activeElement === first || document.activeElement === panel.current)) { event.preventDefault(); last?.focus(); }
      else if (!event.shiftKey && (document.activeElement === last || document.activeElement === panel.current)) { event.preventDefault(); first.focus(); }
    };
    document.addEventListener("keydown", keyboard, true);
    return () => {
      document.body.style.overflow = previousOverflow;
      document.removeEventListener("keydown", keyboard, true);
      trigger.current?.focus({ preventScroll: true });
    };
  }, [open]);

  async function save(event: React.FormEvent) {
    event.preventDefault(); if (saving || !summary) return;
    setSaving(true); setError(""); setSaved(false);
    try {
      const data = await communityApi<{ profile: CommunityProfile }>("/api/community/profile", "PATCH", { name: name.trim() });
      setSummary(current => current ? { ...current, profile: data.profile } : current); setName(data.profile.name); setSaved(true);
      notifyCommunityUpdate();
    } catch (cause) { setError(cause instanceof Error ? cause.message : "Не удалось выполнить действие."); }
    finally { setSaving(false); }
  }
  const initials = (summary?.profile.name ?? "").split(/\s+/).slice(0, 2).map(word => Array.from(word)[0] ?? "").join("").toLocaleUpperCase(language);

  return <>
    <button ref={trigger} type="button" className={`profile-trigger${open ? " active" : ""}`} aria-label={t("Открыть профиль")} title={t("Мой профиль")} aria-haspopup="dialog" aria-expanded={open} aria-controls="user-profile" onClick={() => { setOpen(true); setSaved(false); }}><UserRound size={21}/></button>
    {open && createPortal(<div className="modal-backdrop profile-backdrop" onClick={event => { if (event.target === event.currentTarget) setOpen(false); }}>
      <section ref={panel} id="user-profile" className="profile-modal" role="dialog" aria-modal="true" aria-labelledby="profile-title" tabIndex={-1}>
        <header className="profile-cover"><span className="profile-eyebrow">NazarSal</span><h2 id="profile-title">{t("Мой профиль")}</h2><p>{t("Ваши открытия в одном месте.")}</p><button type="button" className="profile-close" onClick={() => setOpen(false)} aria-label={t("Закрыть профиль")}><X size={20}/></button></header>
        <div className="profile-body">
          <div className="profile-identity"><div className="profile-avatar" aria-hidden="true">{initials || <UserRound size={32}/>}</div><div><strong>{summary?.profile.name ?? t("Ваш профиль")}</strong><span><ShieldCheck size={13}/>{t("Гостевой профиль")}</span></div></div>
          {loading && <div className="profile-loading" role="status"><LoaderCircle size={15} className="spin"/>{t("Загружаем профиль…")}</div>}
          {summary && <>
            <div className="profile-stats"><div><MessageCircle size={19}/><strong>{summary.activeComments}</strong><span>{t("Активные комментарии")}</span></div><div><Users size={19}/><strong>{summary.friendsCount}</strong><span>{t("Друзья")}</span></div></div>
            <form className="profile-name-form" onSubmit={event => void save(event)}><label htmlFor="profile-name">{t("Имя в профиле")}</label><div><input id="profile-name" name="displayName" value={name} minLength={2} maxLength={60} required autoComplete="nickname" disabled={saving} onChange={event => { setName(event.target.value); setSaved(false); }}/><button type="submit" disabled={saving || name.trim().length < 2 || name.trim() === summary.profile.name}>{saving ? <LoaderCircle size={16} className="spin"/> : t("Сохранить")}</button></div><small>{t("Это имя отображается рядом с вашими комментариями.")}</small>{saved && <p className="profile-saved" role="status"><Check size={14}/>{t("Имя сохранено")}</p>}</form>
            <FriendsTools initiallyOpen onChanged={notifyCommunityUpdate}/>
          </>}
          {error && <p className="error-message" role="alert">{t(error)}<button type="button" className="text-button" onClick={() => setRevision(value => value + 1)}>{t("Повторить")}</button></p>}
          <details className="profile-settings">
            <summary><span className="profile-settings-icon"><Settings2 size={19}/></span><span><strong>{t("Настройки")}</strong><small>{t("Отображение комментариев")}</small></span><ChevronDown size={17}/></summary>
            <div className="profile-settings-content"><label className="comment-display-setting"><span><strong>{t("Показывать комментарии на карте")}</strong><small>{t("Влияет только на вашу карту.")}</small></span><input type="checkbox" role="switch" aria-label={t("Показывать комментарии на карте")} checked={showComments} onChange={event => setShowComments(event.target.checked)}/><span className="comment-display-track" aria-hidden="true"/></label></div>
          </details>
          <div className="profile-footer"><p><ShieldCheck size={15}/>{t("Профиль сохраняется в этом браузере.")}</p></div>
        </div>
      </section>
    </div>, document.body)}
  </>;
}
