import { useI18n } from "../i18n/useI18n";
import { useInstall } from "../hooks/useInstall";
import { useModProfiles } from "../hooks/useMods";
import { PixelIcon } from "../components/PixelIcon";
import { VersionActions } from "../components/VersionActions";
import { getLocale } from "../i18n";
import { REFRESH_ICON } from "../components/icons";
import { ErrorText } from "../components/ErrorText";
import type { Shown } from "../i18n/errors";

interface Release {
  tag: string;
  name: string;
  published_at: string;
  body: string;
  prerelease: boolean;
  asset: {
    name: string;
    url: string;
    size: number;
    sha256: string | null;
  };
  from_cache: boolean;
}

interface VersionsPageProps {
  releases: Release[];
  loading: boolean;
  error: Shown | null;
  fromCache: boolean;
  onRefresh: (forceRefresh?: boolean) => void;
  newTag: string | null;
  onFixMods?: (tag: string) => void;
}

export function VersionsPage({
  releases,
  loading,
  error,
  fromCache,
  onRefresh,
  newTag,
  onFixMods,
}: VersionsPageProps) {
  const { t, tn, formatSize: fmtSize } = useI18n();
  const { installedVersions } = useInstall();
  const { profile } = useModProfiles();

  const installedMap = new Map(installedVersions.map((v) => [v.tag, v]));

  const sortedReleases = [...releases].sort((a, b) =>
    new Date(b.published_at).getTime() - new Date(a.published_at).getTime()
  );

  return (
    <main className="page versions-page">
      <header className="page-header clear">
        <h1>{t("tabVersions")}</h1>
        <div className="header-actions">
          {/* Not while loading: at every start the cache shows for a moment before the refresh. */}
          {fromCache && !loading && (
            <span className="cache-banner" role="status">{t("cacheBanner")}</span>
          )}
          {error && <ErrorText error={error} className="error-banner" />}
          <button
            className="btn-refresh"
            onClick={() => onRefresh(true)}
            disabled={loading}
            title={t("refreshButton")}
            aria-label={t("refreshButton")}
          >
            {/* The pixel size of the page title beside it. */}
            <PixelIcon rows={REFRESH_ICON} scale={4} />
          </button>
        </div>
      </header>

      {sortedReleases.length === 0 ? (
        <div className="empty-state">{loading ? t("loading") : t("emptyState")}</div>
      ) : (
        <div className="versions-list clear" role="list">
          {sortedReleases.map((release) => {
            const installedVersion = installedMap.get(release.tag) ?? null;
            const asset = release.asset;
            const isNew = release.tag === newTag;

            return (
              <article
                key={release.tag}
                className={`version-entry${installedVersion ? " in-use" : ""}${isNew ? " is-new" : ""}`}
                role="listitem"
                data-focus-scope
              >
                <div className="version-header">
                  <div className="version-main">
                    <span className="version-tag">{release.tag}</span>
                    {isNew && <span className="new-badge">{t("newBadge")}</span>}
                    {release.prerelease && (
                      <span className="prerelease-badge">{t("prereleaseBadge")}</span>
                    )}
                  </div>
                  <div className="version-meta">
                    <span className="version-date">
                      {new Date(release.published_at).toLocaleDateString(getLocale())}
                    </span>
                    <span className="version-size">
                      {fmtSize(asset.size)}
                    </span>
                    {installedVersion && profile(release.tag) && (
                      <span className="version-mods">{tn("versionModCount", profile(release.tag)!.mods.length)}</span>
                    )}
                  </div>
                </div>

                <VersionActions
                  release={{
                    tag: release.tag,
                    asset: {
                      name: asset.name,
                      url: asset.url,
                      size: asset.size,
                      sha256: asset.sha256,
                    },
                  }}
                  installedVersion={installedVersion}
                  onFixMods={onFixMods}
                />
              </article>
            );
          })}
        </div>
      )}
    </main>
  );
}
