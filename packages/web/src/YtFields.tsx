// A YouTube video's fields in the forms: title, tags, translations, subtitles, thumbnail, settings.

import { LANG, tagsLength } from "@bongsu/core/formats/youtube-texts";
import { isSubtitle, SUBTITLE, THUMBNAIL } from "@bongsu/core/platforms/youtube";
import { useState } from "react";
import type { Item, YouTubeSettings, YouTubeTexts } from "./api";
import { Segmented, Switch } from "./common";
import { dateLocale, type Key, t } from "./i18n";
import { YT_DESCRIPTION_MAX, YT_TAGS_MAX, YT_TITLE_MAX } from "./youtube-form";

// ---------------------------------------------------------------- drafts and settings

export type Texts = { caption: string; comment: string; comment2: string; alt: string };

// ---------------------------------------------------------------- a YouTube video's own fields

/** What a YouTube video's form edits besides the description and comments: its texts and settings. */
export type YtState = { texts: YouTubeTexts; settings: YouTubeSettings };

/** The video's files that aren't the video, by name (the media roles): subtitles by language, the thumbnail. */
export type YtFiles = {
  subtitles: { lang: string; name: string }[];
  thumbnail: { name: string; url: string | null } | null;
};

/** YouTube's common categories (videoCategories), by the id the video stores. */
const YT_CATEGORIES = ["1", "2", "10", "15", "17", "19", "20", "22", "23", "24", "25", "26", "27", "28", "29"] as const;

const categoryName = (id: string) =>
  (YT_CATEGORIES as readonly string[]).includes(id) ? t(`yt.cat.${id}` as Key) : t("yt.categoryN", { id });

/** "Spanish (es)" in the app's locale; the bare tag where the browser doesn't know it. */
function langName(code: string): string {
  try {
    const n = new Intl.DisplayNames([dateLocale()], { type: "language" }).of(code);
    return n && n !== code ? `${n} (${code})` : code;
  } catch {
    return code;
  }
}

/** The subtitle files and thumbnail among a post's files, told apart by name as the server does (mediaRoles). */
export function ytFiles(files: { name: string; mime?: string; url?: string | null }[]): YtFiles {
  const subtitles = files
    .filter((f) => isSubtitle(f.name))
    .map((f) => ({ lang: SUBTITLE.exec(f.name)![1], name: f.name }));
  const thumb = files.find((f) => THUMBNAIL.test(f.name));
  return { subtitles, thumbnail: thumb ? { name: thumb.name, url: thumb.url ?? null } : null };
}

/** The texts as the server takes them: no empty languages or tags. */
export function ytTexts(x: YouTubeTexts): YouTubeTexts {
  const out: YouTubeTexts = { title: x.title };
  if (x.language?.trim()) out.language = x.language.trim();
  if (x.audioLanguage?.trim()) out.audioLanguage = x.audioLanguage.trim();
  if (x.tags?.length) out.tags = x.tags;
  if (x.translations && Object.keys(x.translations).length) out.translations = x.translations;
  return out;
}

export const Counter = ({ n, max }: { n: number; max: number }) => (
  <span className={`small ${n > max ? "bad-text" : "muted"}`}>
    {n} / {max}
  </span>
);

export function YtTitle({ value, onChange }: { value: YtState; onChange: (v: YtState) => void }) {
  return (
    <>
      <label>
        {t("yt.title")} <span className="muted small">{t("yt.titleHint")}</span>
        <input
          value={value.texts.title}
          onChange={(e) => onChange({ ...value, texts: { ...value.texts, title: e.target.value } })}
        />
      </label>
      <Counter n={value.texts.title.length} max={YT_TITLE_MAX} />
    </>
  );
}

/** Tags as chips: Enter, a comma or Add tag adds one; the counter counts as YouTube does (tagsLength). */
function YtTags({ tags, onChange }: { tags: string[]; onChange: (tags: string[]) => void }) {
  const [draft, setDraft] = useState("");
  const add = (raw = draft) => {
    const tag = raw.replace(/,/g, "").trim();
    if (tag && !tags.includes(tag)) onChange([...tags, tag]);
    setDraft("");
  };
  return (
    <>
      <label>
        {t("yt.tags")} <span className="muted small">{t("yt.tagsHint")}</span>
        <input
          value={draft}
          enterKeyHint="done"
          onChange={(e) => (e.target.value.endsWith(",") ? add(e.target.value) : setDraft(e.target.value))}
          onKeyDown={(e) => {
            if (e.key === "Enter") {
              e.preventDefault();
              add();
            }
          }}
          onBlur={() => draft.trim() && add()}
        />
      </label>
      <div className="chips">
        {tags.map((tag) => (
          <button
            key={tag}
            type="button"
            className="chip tag"
            aria-label={t("yt.removeTag", { tag })}
            onClick={() => onChange(tags.filter((x) => x !== tag))}
          >
            {tag} <span aria-hidden="true">×</span>
          </button>
        ))}
        {draft.trim() && (
          <button type="button" className="chip tag" onClick={() => add()}>
            {t("yt.addTag")}
          </button>
        )}
      </div>
      <Counter n={tagsLength(tags)} max={YT_TAGS_MAX} />
    </>
  );
}

/** A language's subtitle file among the post's files, or how to add one. */
const SubtitleLine = ({ lang, files }: { lang: string; files: YtFiles }) => {
  const f = files.subtitles.find((s) => s.lang === lang);
  return (
    <p className="muted small">
      {f ? t("yt.subtitleFile", { name: f.name }) : t("yt.noSubtitleFile", { name: `${lang}.srt` })}
    </p>
  );
};

/** Settings, languages (with each translation and its subtitle file) and the thumbnail. */
export function YtExtras({
  value,
  onChange,
  files,
}: {
  value: YtState;
  onChange: (v: YtState) => void;
  files: YtFiles;
}) {
  const x = value.texts;
  const setTexts = (texts: YouTubeTexts) => onChange({ ...value, texts });
  const setSettings = (s: Partial<YouTubeSettings>) => onChange({ ...value, settings: { ...value.settings, ...s } });
  const translations = x.translations ?? {};
  const [code, setCode] = useState("");
  const [codeErr, setCodeErr] = useState<string | null>(null);
  const addLanguage = () => {
    const c = code.trim();
    if (!LANG.test(c)) return setCodeErr(t("yt.badLanguage", { code: c }));
    if (c in translations || c === x.language) return setCodeErr(t("yt.haveLanguage", { code: c }));
    setTexts({ ...x, translations: { ...translations, [c]: { title: "", description: "" } } });
    setCode("");
    setCodeErr(null);
  };
  const setTranslation = (c: string, field: "title" | "description", v: string) =>
    setTexts({ ...x, translations: { ...translations, [c]: { ...translations[c], [field]: v } } });
  const known = new Set([...(x.language ? [x.language] : []), ...Object.keys(translations)]);
  const others = files.subtitles.filter((s) => !known.has(s.lang));
  const langField = (field: "language" | "audioLanguage", label: string) => {
    const v = x[field] ?? "";
    return (
      <label>
        {label} <span className="muted small">{t("yt.langHint")}</span>
        <input
          value={v}
          autoCapitalize="none"
          spellCheck={false}
          list="yt-languages"
          onChange={(e) => setTexts({ ...x, [field]: e.target.value })}
        />
        {v.trim() && !LANG.test(v.trim()) && (
          <span className="small bad-text">{t("yt.badLanguage", { code: v.trim() })}</span>
        )}
      </label>
    );
  };
  return (
    <>
      <h3>{t("yt.settings")}</h3>
      <Switch
        on={value.settings.madeForKids}
        label={t("yt.madeForKids")}
        onChange={(on) => setSettings({ madeForKids: on })}
      />
      <span className="label-text">{t("yt.visibility")}</span>
      <Segmented
        label={t("yt.visibility")}
        value={value.settings.privacy}
        options={[
          { value: "public", text: t("yt.public") },
          { value: "unlisted", text: t("yt.unlisted") },
        ]}
        onChange={(privacy) => setSettings({ privacy })}
      />
      <YtTags tags={x.tags ?? []} onChange={(tags) => setTexts({ ...x, tags })} />
      <label>
        {t("yt.category")}
        <select value={value.settings.category} onChange={(e) => setSettings({ category: e.target.value })}>
          {[
            ...((YT_CATEGORIES as readonly string[]).includes(value.settings.category)
              ? []
              : [value.settings.category]),
            ...YT_CATEGORIES,
          ].map((id) => (
            <option key={id} value={id}>
              {categoryName(id)}
            </option>
          ))}
        </select>
      </label>

      <h3>{t("yt.languages")}</h3>
      {langField("language", t("yt.language"))}
      {Object.keys(translations).length > 0 && !x.language?.trim() && (
        <span className="small bad-text">{t("yt.languageNeeded")}</span>
      )}
      {x.language && LANG.test(x.language) && <SubtitleLine lang={x.language} files={files} />}
      {langField("audioLanguage", t("yt.audioLanguage"))}
      <datalist id="yt-languages">
        {["en", "es", "ko", "pt-BR", "fr", "de", "ja"].map((c) => (
          <option key={c} value={c}>
            {langName(c)}
          </option>
        ))}
      </datalist>
      {Object.entries(translations).map(([c, tr]) => (
        <div key={c} className="lang-block">
          <div className="row lang-head">
            <strong>{langName(c)}</strong>
            {/* not a danger button: nothing is lost until the form is saved, and Cancel brings it back */}
            <button
              type="button"
              onClick={() => {
                const { [c]: _gone, ...rest } = translations;
                setTexts({ ...x, translations: rest });
              }}
            >
              {t("yt.removeLanguage", { lang: c })}
            </button>
          </div>
          <label>
            {t("yt.translationTitle", { lang: c })}
            <input value={tr.title} onChange={(e) => setTranslation(c, "title", e.target.value)} />
          </label>
          {!tr.title.trim() ? (
            <span className="small bad-text">{t("yt.translationNeedsTitle", { lang: langName(c) })}</span>
          ) : (
            <Counter n={tr.title.length} max={YT_TITLE_MAX} />
          )}
          <label>
            {t("yt.translationDescription", { lang: c })}
            <textarea
              rows={4}
              value={tr.description}
              onChange={(e) => setTranslation(c, "description", e.target.value)}
            />
          </label>
          <Counter n={tr.description.length} max={YT_DESCRIPTION_MAX} />
          <SubtitleLine lang={c} files={files} />
        </div>
      ))}
      <div className="row add-lang">
        <label>
          {t("yt.newLanguage")}
          <input
            value={code}
            autoCapitalize="none"
            spellCheck={false}
            list="yt-languages"
            placeholder="es"
            onChange={(e) => {
              setCode(e.target.value);
              setCodeErr(null);
            }}
            onKeyDown={(e) => {
              if (e.key === "Enter") {
                e.preventDefault();
                addLanguage();
              }
            }}
          />
        </label>
        <button type="button" onClick={addLanguage} disabled={!code.trim()}>
          {t("yt.addLanguage")}
        </button>
      </div>
      {codeErr && <p className="small bad-text">{codeErr}</p>}
      {others.length > 0 && (
        <p className="muted small">{t("yt.otherSubtitles", { names: others.map((s) => s.name).join(", ") })}</p>
      )}

      <h3>{t("yt.thumbnail")}</h3>
      <YtThumbnail files={files} />
    </>
  );
}

const YtThumbnail = ({ files }: { files: YtFiles }) =>
  files.thumbnail ? (
    files.thumbnail.url ? (
      <div className="media">
        <img src={files.thumbnail.url} alt={t("yt.thumbnailAlt", { name: files.thumbnail.name })} loading="lazy" />
      </div>
    ) : (
      <p className="small">{files.thumbnail.name}</p>
    )
  ) : (
    <p className="muted small">{t("yt.noThumbnail")}</p>
  );

/** What approving a YouTube video covers besides its description and comments, listed before the passkey. */
export function YtSummary({ yt, files }: { yt: NonNullable<Item["youtube"]>; files: YtFiles }) {
  const x = yt.texts;
  const translations = Object.entries(x?.translations ?? {});
  return (
    <>
      <h2>{t("yt.settings")}</h2>
      <ul className="small facts">
        <li>
          {t("yt.visibility")}:{" "}
          <strong>{yt.settings.privacy === "unlisted" ? t("yt.unlisted") : t("yt.public")}</strong>
        </li>
        <li>
          <strong>{yt.settings.madeForKids ? t("yt.madeForKids") : t("yt.notForKids")}</strong>
        </li>
        <li>
          {t("yt.category")}: <strong>{categoryName(yt.settings.category)}</strong>
        </li>
        <li>
          {t("yt.tags")}: {x?.tags?.length ? <strong>{x.tags.join(", ")}</strong> : t("yt.noTags")}
        </li>
        <li>
          {t("yt.language")}: {x?.language ? <strong>{langName(x.language)}</strong> : t("yt.notSet")}
        </li>
        <li>
          {t("yt.audioLanguage")}: {x?.audioLanguage ? <strong>{langName(x.audioLanguage)}</strong> : t("yt.notSet")}
        </li>
      </ul>
      <h2>{t("yt.translations")}</h2>
      {translations.length ? (
        translations.map(([c, tr]) => (
          <div key={c} className="lang-block">
            <h3>{langName(c)}</h3>
            <pre className="text">{tr.title}</pre>
            {tr.description && <pre className="text">{tr.description}</pre>}
          </div>
        ))
      ) : (
        <p className="muted small">{t("yt.noTranslations")}</p>
      )}
      <h2>{t("yt.subtitles")}</h2>
      {yt.subtitles.length ? (
        <ul className="small facts">
          {yt.subtitles.map((s) => (
            <li key={s.lang}>
              {langName(s.lang)}: <strong>{s.name}</strong>
            </li>
          ))}
        </ul>
      ) : (
        <p className="muted small">{t("yt.noSubtitles")}</p>
      )}
      <h2>{t("yt.thumbnail")}</h2>
      <YtThumbnail files={files} />
    </>
  );
}
