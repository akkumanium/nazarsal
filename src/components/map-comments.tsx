"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import L from "leaflet";
import { createPortal } from "react-dom";
import { Check, Clock3, Globe, LoaderCircle, MapPin, MessageCircle, Plus, Send, Trash2, Users, X } from "lucide-react";
import { boundsParams, COMMENT_LIFETIMES, mapBoundsSchema, type CommentPlace, type CommunityProfile, type MapComment } from "@/lib/comments";
import { useLanguage } from "./language-provider";
import { FriendsTools } from "./friends-tools";
import { communityApi as api, ensureCommunitySession, COMMUNITY_UPDATED_EVENT, notifyCommunityUpdate } from "@/lib/community-client";
import { useCommentDisplay } from "@/lib/comment-display";

const commentSvg = '<svg width="40" height="44" viewBox="0 0 40 44" aria-hidden="true"><path d="M10 3h20a7 7 0 0 1 7 7v17a7 7 0 0 1-7 7H19L9 41v-7a7 7 0 0 1-6-7V10a7 7 0 0 1 7-7Z" fill="currentColor" stroke="white" stroke-width="2" stroke-linejoin="round"/><path d="M12 14h16M12 21h11" stroke="white" stroke-width="2.4" stroke-linecap="round"/></svg>';
const addCommentSvg = '<svg width="30" height="34" viewBox="0 0 30 34" aria-hidden="true"><path d="M8 3h14a5 5 0 0 1 5 5v13a5 5 0 0 1-5 5h-8l-7 5v-5a5 5 0 0 1-4-5V8a5 5 0 0 1 5-5Z" fill="white" stroke="currentColor" stroke-width="2" stroke-linejoin="round"/><path d="M15 10v10M10 15h10" stroke="currentColor" stroke-width="2" stroke-linecap="round"/></svg>';

export function MapComments({ map, knownPlaces }: { map: L.Map; knownPlaces: CommentPlace[] }) {
  const { t, language } = useLanguage();
  const { showComments } = useCommentDisplay();
  const [stage, setStage] = useState<"idle" | "pick" | "compose" | "read">("idle");
  const [comments, setComments] = useState<MapComment[]>([]), [places, setPlaces] = useState<CommentPlace[]>([]);
  const [selected, setSelected] = useState<CommentPlace | null>(null), [profile, setProfile] = useState<CommunityProfile | null>(null);
  const [text, setText] = useState(""), [lifetime, setLifetime] = useState("");
  const [visibility, setVisibility] = useState<"public" | "friends">("public");
  const [loading, setLoading] = useState(false), [saving, setSaving] = useState(false), [error, setError] = useState("");
  const [loadError, setLoadError] = useState("");
  const [notice, setNotice] = useState(""), [truncated, setTruncated] = useState(false), [revision, setRevision] = useState(0), [now, setNow] = useState(Date.now());
  const sessionRequest = useRef<Promise<CommunityProfile> | null>(null);
  const button = useRef<HTMLButtonElement>(null), input = useRef<HTMLTextAreaElement>(null);
  const selecting = stage === "pick";
  const refresh = useCallback(() => setRevision(value => value + 1), []);
  const live = useMemo(() => comments.filter(comment => Date.parse(comment.expiresAt) > now), [comments, now]);
  const selectedComments = live.filter(comment => comment.place.id === selected?.id);
  const selectable = useMemo(() => [...new Map([...knownPlaces, ...places].map(place => [place.id, place])).values()], [places, knownPlaces]);

  const ensureProfile = useCallback(async () => {
    if (profile) return profile;
    if (!sessionRequest.current) sessionRequest.current = ensureCommunitySession()
      .then(next => { setProfile(next); refresh(); return next; }).catch(cause => { sessionRequest.current = null; throw cause; });
    return sessionRequest.current;
  }, [profile, refresh]);
  function close() { setStage("idle"); setSelected(null); setError(""); button.current?.focus({ preventScroll: true }); }
  function compose(place: CommentPlace) {
    setSelected(place); setText(""); setLifetime(""); setVisibility("public"); setError(""); setNotice(""); setStage("compose");
    void ensureProfile().catch(cause => setError(cause.message));
  }
  function start() {
    setStage("pick"); setSelected(null); setError(""); setNotice("");
    map.getContainer().scrollIntoView({ behavior: "smooth", block: "center" });
    map.getContainer().focus({ preventScroll: true });
    void ensureProfile().catch(cause => setError(cause.message));
  }
  useEffect(() => {
    if (!showComments) setStage(current => current === "read" ? "idle" : current);
  }, [showComments]);
  useEffect(() => {
    const changed = () => {
      refresh();
      if (profile) void ensureCommunitySession().then(setProfile).catch(() => {});
    };
    window.addEventListener(COMMUNITY_UPDATED_EVENT, changed);
    return () => window.removeEventListener(COMMUNITY_UPDATED_EVENT, changed);
  }, [profile, refresh]);
  useEffect(() => {
    map.getContainer().dataset.commentSelecting = selecting ? "true" : "false";
    return () => { delete map.getContainer().dataset.commentSelecting; };
  }, [map, selecting]);
  useEffect(() => {
    if (stage === "compose") input.current?.focus({ preventScroll: true });
    if (stage === "idle") return;
    const escape = (event: KeyboardEvent) => { if (event.key === "Escape" && !saving) close(); };
    window.addEventListener("keydown", escape); return () => window.removeEventListener("keydown", escape);
  }, [stage, saving]);
  useEffect(() => {
    if (!comments.length) return;
    const next = Math.min(...comments.map(comment => Date.parse(comment.expiresAt)).filter(expiry => expiry > Date.now()));
    if (!Number.isFinite(next)) return;
    const timer = window.setTimeout(() => setNow(Date.now()), Math.max(0, next - Date.now()) + 10);
    return () => window.clearTimeout(timer);
  }, [comments, now]);
  useEffect(() => {
    let controller: AbortController | null = null, debounce: ReturnType<typeof setTimeout>;
    async function load() {
      controller?.abort(); controller = new AbortController(); const signal = controller.signal;
      const bounds = map.getBounds();
      const parsed = mapBoundsSchema.safeParse({ west: bounds.getWest(), south: bounds.getSouth(), east: bounds.getEast(), north: bounds.getNorth() });
      if (!parsed.success) { setComments([]); setPlaces([]); setLoading(false); setLoadError("Приблизьте карту, чтобы выбрать место."); return; }
      setLoading(true);
      try {
        const params = boundsParams(parsed.data);
        const [data, candidates] = await Promise.all([
          api<{ comments: MapComment[] }>(`/api/comments?${params}`, "GET", undefined, signal),
          selecting ? api<{ places: CommentPlace[]; truncated: boolean }>(`/api/comments/places?${params}`, "GET", undefined, signal) : Promise.resolve(null),
        ]);
        if (signal.aborted) return;
        setComments(data.comments); setNow(Date.now());
        if (candidates) { setPlaces(candidates.places); setTruncated(candidates.truncated); }
        setLoadError("");
      } catch (cause) { if (!signal.aborted) setLoadError(cause instanceof Error ? cause.message : "Не удалось загрузить комментарии."); }
      finally { if (!signal.aborted) setLoading(false); }
    }
    const move = () => { clearTimeout(debounce); debounce = setTimeout(() => void load(), 250); };
    map.on("moveend", move); void load();
    const poll = window.setInterval(() => { if (document.visibilityState === "visible") void load(); }, 30000);
    return () => { controller?.abort(); clearTimeout(debounce); window.clearInterval(poll); map.off("moveend", move); };
  }, [map, selecting, revision]);
  useEffect(() => {
    const layer = L.layerGroup().addTo(map);
    const occupied: L.Point[] = [];
    if (selecting) for (const place of selectable) {
      const pixel = map.latLngToLayerPoint([place.point.lat, place.point.lon]);
      if (occupied.some(other => other.distanceTo(pixel) < 36)) continue;
      occupied.push(pixel);
      const icon = L.divIcon({ className: "comment-place-marker", html: addCommentSvg, iconSize: [36, 40], iconAnchor: [15, 32] });
      const labelText = `${t("Оставить комментарий")}: ${place.name}`;
      const marker = L.marker([place.point.lat, place.point.lon], { icon, title: labelText, alt: labelText, bubblingMouseEvents: false, zIndexOffset: 600 }).addTo(layer);
      const label = document.createElement("span"); label.textContent = place.name; marker.bindTooltip(label);
      marker.on("click", () => compose(place));
    }
    const grouped = new Map<string, MapComment[]>();
    if (showComments) for (const comment of live) { const group = grouped.get(comment.place.id) ?? []; group.push(comment); grouped.set(comment.place.id, group); }
    for (const group of grouped.values()) {
      const place = group[0].place, privateOnly = group.every(comment => comment.visibility === "friends");
      const icon = L.divIcon({ className: `comment-pin${privateOnly ? " comment-pin-private" : ""}`, html: `${commentSvg}<b>${group.length}</b>`, iconSize: [40, 44], iconAnchor: [9, 41] });
      const marker = L.marker([place.point.lat, place.point.lon], { icon, title: `${t("Комментарии")}: ${place.name}`, alt: `${t("Комментарии")}: ${place.name}`, bubblingMouseEvents: false, zIndexOffset: 1000 }).addTo(layer);
      const label = document.createElement("span"); label.textContent = `${place.name} · ${group.length}`; marker.bindTooltip(label);
      marker.on("click", () => {
        if (selecting) compose(place);
        else { setSelected(place); setStage("read"); setError(""); void ensureProfile().catch(cause => setError(cause.message)); }
      });
    }
    return () => { layer.remove(); };
  }, [map, live, selectable, selecting, t, ensureProfile, showComments]);

  async function publish(event: React.FormEvent) {
    event.preventDefault(); if (!selected || saving || !lifetime) return;
    setSaving(true); setError("");
    try {
      await ensureProfile();
      await api("/api/comments", "POST", { poiId: selected.id, text: text.trim(), lifetimeHours: Number(lifetime), visibility });
      setStage("read"); setText(""); setNotice("Комментарий опубликован."); refresh();
    } catch (cause) { setError(cause instanceof Error ? cause.message : "Не удалось опубликовать комментарий."); }
    finally { setSaving(false); }
  }
  async function remove(id: string) {
    setSaving(true); setError("");
    try { await api("/api/comments", "DELETE", { id }); setComments(items => items.filter(comment => comment.id !== id)); refresh(); }
    catch (cause) { setError(cause instanceof Error ? cause.message : "Не удалось выполнить действие."); }
    finally { setSaving(false); }
  }
  const date = (value: string) => new Intl.DateTimeFormat(language, { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" }).format(new Date(value));
  const durations: Record<number, string> = { 1: "1 час", 6: "6 часов", 24: "1 день", 72: "3 дня", 168: "7 дней" };

  return <>
    {createPortal(<button ref={button} type="button" className={`comments-fab${selecting || stage === "compose" ? " active" : ""}`} aria-label={t("Оставить комментарий на карте")} aria-pressed={stage !== "idle"} onClick={() => stage === "pick" || stage === "compose" ? close() : start()} disabled={saving}>
      {selecting || stage === "compose" ? <X size={22}/> : <MessageCircle size={22}/>}<span>{t("Комментарии")}</span>
    </button>, document.body)}
    {selecting && <div className="comment-pick-hint" role="status"><MapPin size={21}/><div><strong>{t("Выберите место для комментария")}</strong><small>{t("Нажмите на отмеченное место на карте.")}{truncated ? ` ${t("Приблизьте карту, чтобы увидеть больше мест.")}` : ""}</small></div>{loading && <LoaderCircle size={17} className="spin"/>}<button type="button" onClick={close} aria-label={t("Отмена")}><X size={17}/></button></div>}
    {selecting && (error || loadError) && <div className="comment-map-error" role="alert">{t(error || loadError)}<button type="button" onClick={refresh}>{t("Повторить")}</button></div>}
    {(stage === "compose" || stage === "read") && selected && <section className="comment-sheet" role="dialog" aria-label={t(stage === "compose" ? "Новый комментарий" : "Комментарии к месту")}>
      <header className="comment-sheet-header"><span className="comment-sheet-icon"><MessageCircle size={20}/></span><div><small>{t(stage === "compose" ? "Новый комментарий" : "Комментарии к месту")}</small><h2>{selected.name}</h2></div><button type="button" className="icon-button" onClick={close} aria-label={t("Закрыть")} disabled={saving}><X size={18}/></button></header>
      {notice && <p className="comment-success" role="status"><Check size={15}/>{t(notice)}</p>}
      {stage === "compose" ? <form className="comment-form" onSubmit={event => void publish(event)}>
        <label htmlFor="map-comment-text">{t("Ваш комментарий")}</label>
        <textarea ref={input} id="map-comment-text" value={text} onChange={event => setText(event.target.value)} minLength={3} maxLength={1000} rows={4} required placeholder={t("Что стоит знать об этом месте?")} disabled={saving}/>
        <div className="comment-text-counter">{text.length}/1000</div>
        <label htmlFor="map-comment-lifetime"><Clock3 size={15}/>{t("Сколько показывать комментарий")}</label>
        <select id="map-comment-lifetime" value={lifetime} required onChange={event => setLifetime(event.target.value)} disabled={saving}><option value="" disabled>{t("Выберите срок")}</option>{COMMENT_LIFETIMES.map(hours => <option key={hours} value={hours}>{t(durations[hours])}</option>)}</select>
        <small className="comment-form-help">{t("После этого срока комментарий автоматически исчезнет с карты.")}</small>
        <fieldset className="comment-visibility" disabled={saving}><legend>{t("Кому видно")}</legend><label><input type="radio" name="comment-visibility" checked={visibility === "public"} onChange={() => setVisibility("public")}/><Globe size={16}/>{t("Всем")}</label><label><input type="radio" name="comment-visibility" checked={visibility === "friends"} onChange={() => setVisibility("friends")}/><Users size={16}/>{t("Только друзьям")}</label></fieldset>
        {visibility === "friends" && <small className="comment-form-help">{t("Видно вам и пользователям из вашего списка друзей.")}</small>}
        {profile && <div className="comment-profile">{t("Автор")}: {profile.name}</div>}
        <button type="submit" className="primary-button" disabled={saving || text.trim().length < 3 || !lifetime}>{saving ? <LoaderCircle size={17} className="spin"/> : <Send size={17}/>} {t("Опубликовать")}</button>
      </form> : <div className="comment-list">
        {loading && <div className="comment-loading" role="status"><LoaderCircle size={16} className="spin"/>{t("Обновляем комментарии…")}</div>}
        {selectedComments.map(comment => <article key={comment.id} className="map-comment-card"><header><strong>{comment.author.name}</strong><span>{comment.visibility === "friends" ? <Users size={13}/> : <Globe size={13}/>} {t(comment.visibility === "friends" ? "Только друзьям" : "Всем")}</span></header><p>{comment.text}</p><footer><time dateTime={comment.createdAt}>{date(comment.createdAt)}</time>{comment.canDelete && <button type="button" onClick={() => void remove(comment.id)} disabled={saving} aria-label={t("Удалить комментарий")}><Trash2 size={14}/></button>}</footer><small><Clock3 size={12}/>{t("Виден до")} <time dateTime={comment.expiresAt}>{date(comment.expiresAt)}</time></small></article>)}
        {!selectedComments.length && !loading && <p className="comment-empty">{t("У этого места пока нет актуальных комментариев.")}</p>}
        <button type="button" className="comment-secondary" onClick={() => compose(selected)}><Plus size={16}/>{t("Оставить комментарий")}</button>
      </div>}
      {(error || loadError) && <p className="error-message" role="alert">{t(error || loadError)}<button type="button" className="text-button" onClick={refresh}>{t("Повторить")}</button></p>}
      {profile && <FriendsTools onChanged={notifyCommunityUpdate}/>}
    </section>}
  </>;
}
