import { useI18n } from "../i18n/useI18n";
import { NoteBody } from "../components/NoteBody";
import { formatDate } from "../utils/date";

interface Release {
  tag: string;
  name: string;
  published_at: string;
  body: string;
  prerelease: boolean;
}

interface NotesPageProps {
  releases: Release[];
  loading: boolean;
}

export function NotesPage({ releases, loading }: NotesPageProps) {
  const { t, locale } = useI18n();

  const sorted = [...releases].sort((a, b) =>
    new Date(b.published_at).getTime() - new Date(a.published_at).getTime()
  );

  return (
    <main className="page notes-page">
      <header className="page-header clear">
        <h1>{t("tabNotes")}</h1>
      </header>
      {sorted.length === 0 ? (
        <p className="empty-state">{loading ? t("loading") : t("emptyState")}</p>
      ) : (
        <div className="notes-list clear">
          {sorted.map((release) => (
            <article key={release.tag} className="note-entry">
              <header className="note-header">
                <span className="note-tag">{release.tag}</span>
                <span className="note-date">{formatDate(release.published_at, locale, true)}</span>
                {release.prerelease && <span className="prerelease-badge">{t("prereleaseBadge")}</span>}
              </header>
              <div className="note-body">
                {release.body ? <NoteBody text={release.body} /> : <p>{t("noChangelog")}</p>}
              </div>
            </article>
          ))}
        </div>
      )}
    </main>
  );
}
