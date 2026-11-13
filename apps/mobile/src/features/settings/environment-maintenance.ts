import {
  AuthEnvironmentMaintainScope,
  sessionGrantsScope,
  type AuthSessionState,
  type ExecutionEnvironmentCapabilities,
} from "@t3tools/contracts";
import {
  CLI_RELEASE_CHECKSUMS_FILE,
  CLI_RELEASES_PAGE_URL,
  cliReleaseAssetUrl,
  cliReleaseChannelOf,
  cliReleaseIndexPageUrl,
  newestCliReleaseVersion,
  parseChecksums,
  type CliReleaseChannel,
} from "@t3tools/shared/cliRelease";
import { compareSemverVersions } from "@t3tools/shared/semver";
import * as Schema from "effect/Schema";

export function canMaintainEnvironment(session: AuthSessionState | null, connected: boolean) {
  return (
    connected &&
    session?.authenticated === true &&
    sessionGrantsScope(session, AuthEnvironmentMaintainScope)
  );
}

export function supportsEnvironmentUpdate(
  capabilities: Pick<ExecutionEnvironmentCapabilities, "serverSelfUpdate" | "desktopAppUpdate">,
) {
  return (
    capabilities.serverSelfUpdate !== undefined &&
    (capabilities.serverSelfUpdate !== "desktop-managed" || capabilities.desktopAppUpdate === true)
  );
}

const Release = Schema.Struct({
  tag_name: Schema.String,
  draft: Schema.optionalKey(Schema.Boolean),
  assets: Schema.optionalKey(Schema.Array(Schema.Struct({ name: Schema.String }))),
});
const decodeRelease = Schema.decodeUnknownSync(Release);
const decodeReleases = Schema.decodeUnknownSync(Schema.Array(Release));

async function fetchReleases(url: string, accept: string, signal: AbortSignal) {
  const response = await fetch(url, { signal, headers: { Accept: accept } });
  if (!response.ok) throw new Error(`Could not check releases (${response.status}). Try again.`);
  return response;
}

async function fetchReleaseAsset(url: string, signal: AbortSignal, method = "GET") {
  const response = await fetch(url, { signal, method });
  if (response.status === 404) return undefined;
  if (!response.ok) throw new Error(`Could not check releases (${response.status}). Try again.`);
  return response;
}

async function newestPublishedReleaseVersion(
  releases: ReadonlyArray<typeof Release.Type>,
  channel: CliReleaseChannel,
  signal: AbortSignal,
) {
  for (const release of releases) {
    if (release.draft || !release.tag_name.startsWith("v")) continue;
    const version = release.tag_name.slice(1);
    if (cliReleaseChannelOf(version) !== channel) continue;
    if (release.assets !== undefined) {
      const candidate = newestCliReleaseVersion([{ ...release, assets: release.assets }], channel);
      if (candidate !== undefined) return candidate;
      continue;
    }

    // The public feed omits assets; its checksum index and archive must both be downloadable.
    const response = await fetchReleaseAsset(
      cliReleaseAssetUrl(version, CLI_RELEASE_CHECKSUMS_FILE),
      signal,
    );
    if (response === undefined) continue;
    for (const name of parseChecksums(await response.text()).keys()) {
      const candidate = newestCliReleaseVersion(
        [{ ...release, assets: [{ name: CLI_RELEASE_CHECKSUMS_FILE }, { name }] }],
        channel,
      );
      if (candidate === undefined) continue;
      const archive = await fetchReleaseAsset(cliReleaseAssetUrl(version, name), signal, "HEAD");
      if (archive !== undefined) return candidate;
    }
  }
  return undefined;
}

export async function findEnvironmentUpdate(currentVersion: string, signal: AbortSignal) {
  const channel = cliReleaseChannelOf(currentVersion);
  // Public release pages avoid the anonymous API quota shared by devices on the same network.
  const response = await fetchReleases(
    channel === "stable" ? `${CLI_RELEASES_PAGE_URL}/latest` : `${CLI_RELEASES_PAGE_URL}.atom`,
    channel === "stable" ? "application/json" : "application/atom+xml",
    signal,
  );
  const releases =
    channel === "stable"
      ? [decodeRelease(await response.json())]
      : Array.from(
          (await response.text()).matchAll(
            /<id>tag:github\.com,2008:Repository\/\d+\/([^<]+)<\/id>/g,
          ),
          ([, tag_name = ""]) => ({ tag_name }),
        );
  let version = await newestPublishedReleaseVersion(releases, channel, signal);

  // The feed only includes ten releases, so later nightlies can displace a published preview.
  for (let page = 1; version === undefined; page++) {
    const response = await fetchReleases(
      cliReleaseIndexPageUrl(page),
      "application/vnd.github+json",
      signal,
    );
    const releases = decodeReleases(await response.json());
    version = await newestPublishedReleaseVersion(releases, channel, signal);
    if (releases.length < 100) break;
  }

  if (version === undefined) throw new Error(`No ${channel} release was found.`);
  return compareSemverVersions(version, currentVersion) > 0 ? version : null;
}
