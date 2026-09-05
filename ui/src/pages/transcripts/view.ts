import type {
  TranscriptSessionSummary,
  TranscriptsExportParams,
  TranscriptsGetResult,
  TranscriptsListResult,
} from "@openclaw/gateway-protocol";
import { normalizeNullableString } from "@openclaw/normalization-core/string-coerce";
import { html, nothing } from "lit";
import { live } from "lit/directives/live.js";
import { repeat } from "lit/directives/repeat.js";
import { pathForRoute } from "../../app-route-paths.ts";
import { renderHubTabs } from "../../components/hub-tabs.ts";
import { icons } from "../../components/icons.ts";
import { t } from "../../i18n/index.ts";
import { registerTranscriptsEnglish } from "../../i18n/locales/en-transcripts.ts";
import { formatUiError } from "../../lib/format-error.ts";
import { isArchiveAccessDeniedError } from "../../lib/gateway-errors.ts";
import { shouldHandleNavigationClick } from "../../lib/navigation-click.ts";
import { SETTINGS_SEARCH_TARGETS } from "../config/settings-targets.ts";
import {
  transcriptRouteSearch,
  TRANSCRIPT_QUERY_LIMIT,
  TRANSCRIPT_ADVANCED_FILTER_KEYS,
  TRANSCRIPT_FILTER_KEYS,
} from "./route-state.ts";

registerTranscriptsEnglish();

export type TranscriptReadState = {
  pages: TranscriptsGetResult[];
  loading: boolean;
  error: unknown;
  trimmed: boolean;
};

type TranscriptsViewProps = {
  basePath: string;
  search: string;
  drafts: Readonly<Record<string, string>>;
  onDraft: (key: string, value: string) => void;
  connected: boolean;
  allowed: boolean;
  list: TranscriptsListResult | null;
  listLoading: boolean;
  listError: unknown;
  reader: TranscriptReadState;
  readerTab: "text" | "summary";
  exportState: { kind: "idle" | "loading" | "done" | "error"; message?: string };
  onNavigate: (patch: Record<string, string | null>) => void;
  onRefresh: () => void;
  onReaderRetry: () => void;
  onReaderTab: (tab: "text" | "summary") => void;
  onLoadMore: () => void;
  onReaderStart: () => void;
  onDownload: (format: TranscriptsExportParams["format"]) => void;
};

function transcriptTime(value: string | null | undefined) {
  return value ? new Date(value).toLocaleString() : t("transcripts.unknown");
}

function renderSourceTime(value: string | undefined) {
  const label = t("transcripts.sourceTime", { time: transcriptTime(value) });
  return html`<time datetime=${value ?? nothing} title=${label} aria-label=${label}
    >${value ? new Date(value).toLocaleTimeString() : t("transcripts.unknown")}</time
  >`;
}

function transcriptSourceLabel(source: TranscriptSessionSummary["source"]) {
  return [
    source.providerId,
    source.accountId,
    source.guildId,
    source.channelId,
    source.meetingUrl,
    source.threadTs,
    source.fileId,
  ]
    .filter(Boolean)
    .join(" · ");
}

function renderReadError(error: unknown, retry: () => void) {
  const forbidden = isArchiveAccessDeniedError(error);
  return html`<div class="transcripts-notice" role="alert" tabindex="-1">
    <h2>${t(forbidden ? "transcripts.forbidden" : "transcripts.loadError")}</h2>
    <p>${forbidden ? t("transcripts.forbiddenHint") : formatUiError(error)}</p>
    <button class="btn" @click=${retry}>${t("common.retry")}</button>
  </div>`;
}

function renderFilters(props: TranscriptsViewProps) {
  const params = new URLSearchParams(props.search);
  const advancedActive = TRANSCRIPT_ADVANCED_FILTER_KEYS.some((key) => params.get(key));
  const field = (key: string, label: string, type = "search") => html`<label class="field">
    <span>${label}</span
    ><input
      name=${key}
      type=${type}
      aria-label=${label}
      maxlength=${TRANSCRIPT_QUERY_LIMIT}
      .value=${live(props.drafts[key] ?? "")}
      @input=${(event: Event) =>
        // SAFETY: This native input emits the input event handled by its own binding.
        props.onDraft(key, (event.target as HTMLInputElement).value)}
    />
  </label>`;
  return html`<form
    class="transcripts-filters"
    aria-label=${t("transcripts.filters")}
    @submit=${(event: SubmitEvent) => {
      event.preventDefault();
      // SAFETY: This synchronous submit handler is bound directly to the native form above.
      const data = new FormData(event.currentTarget as HTMLFormElement);
      const patch: Record<string, string | null> = { cursor: null };
      for (const key of TRANSCRIPT_FILTER_KEYS) {
        patch[key] = normalizeNullableString(data.get(key));
      }
      props.onNavigate(patch);
    }}
  >
    ${field("query", t("transcripts.titleFilter"))}
    <details ?open=${advancedActive}>
      <summary>${t("transcripts.advancedFilters")}</summary>
      <div class="transcripts-filters__advanced">
        ${field("providerId", t("transcripts.sourceFilter"))}
        ${field("accountId", t("transcripts.accountFilter"))}
        ${field("agentId", t("transcripts.agentFilter"))}
        ${field("startedAfter", t("transcripts.afterFilter"), "date")}
        ${field("startedBefore", t("transcripts.beforeFilter"), "date")}
      </div>
      <p class="transcripts-caption">${t("transcripts.filterHint")}</p>
    </details>
    <div class="transcripts-actions">
      <button type="submit" class="btn">${icons.search}${t("transcripts.filter")}</button>
      <button
        type="button"
        class="btn"
        @click=${() =>
          props.onNavigate(
            Object.fromEntries([...TRANSCRIPT_FILTER_KEYS, "cursor"].map((key) => [key, null])),
          )}
      >
        ${t("transcripts.clearFilters")}
      </button>
    </div>
  </form>`;
}

function renderLibrary(props: TranscriptsViewProps) {
  if (props.listError) {
    return renderReadError(props.listError, props.onRefresh);
  }
  if (props.listLoading || !props.list) {
    return html`<p role="status" class="transcripts-notice">${t("common.loading")}</p>`;
  }
  const selected = new URLSearchParams(props.search).get("selected");
  return html` ${
      props.list.sessions.length
        ? html`<ol class="transcripts-list" aria-label=${t("transcripts.library")}>
            ${repeat(
              props.list.sessions,
              (entry) => entry.selector,
              (entry) => html`<li>
                <a
                  class="transcripts-list__entry"
                  aria-current=${entry.selector === selected ? "page" : nothing}
                  href=${
                    pathForRoute("transcripts", props.basePath) +
                    transcriptRouteSearch(props.search, { selected: entry.selector, find: null })
                  }
                  @click=${(event: MouseEvent) => {
                    if (!shouldHandleNavigationClick(event)) {
                      return;
                    }
                    event.preventDefault();
                    props.onNavigate({ selected: entry.selector, find: null });
                  }}
                >
                  <time datetime=${entry.startedAt}>${transcriptTime(entry.startedAt)}</time>
                  <h2>${entry.title || entry.sessionId}</h2>
                  <p>${transcriptSourceLabel(entry.source)}</p>
                  <p>
                    ${entry.agentId ?? t("transcripts.unattributed")} ·
                    ${t("transcripts.savedCount", { count: String(entry.utteranceCount) })}
                  </p>
                </a>
              </li>`,
            )}
          </ol>`
        : html`<div class="transcripts-notice" role="status">
            <h2>${t("transcripts.empty")}</h2>
            <p>${t("transcripts.emptyHint")}</p>
          </div>`
    }
    <nav class="transcripts-actions" aria-label=${t("transcripts.pagination")}>
      ${
        new URLSearchParams(props.search).has("cursor")
          ? html`<button class="btn" @click=${() => props.onNavigate({ cursor: null })}>
              ${t("transcripts.firstPage")}
            </button>`
          : nothing
      }
      ${
        props.list.nextCursor
          ? html`<button
              class="btn"
              @click=${() => props.onNavigate({ cursor: props.list?.nextCursor ?? null })}
            >
              ${t("transcripts.nextPage")}${icons.chevronRight}
            </button>`
          : nothing
      }
    </nav>`;
}

function renderSummary(page: TranscriptsGetResult) {
  const summary = page.summary;
  return html`<section class="transcripts-summary">
    <p class="transcripts-caption">${t("transcripts.summaryHint")}</p>
    ${
      summary
        ? html`<p class="transcripts-caption">
              ${t("transcripts.generatedAt", { time: transcriptTime(summary.generatedAt) })}
            </p>
            <p>${summary.overview}</p>
            ${summary.source ? html`<p class="transcripts-caption">${t(summary.source === "model" ? "transcripts.modelNotes" : "transcripts.heuristicNotes")}${summary.model ? ` · ${summary.model}` : nothing}</p>` : nothing}
            ${summary.participants.length ? html`<p>${t("transcripts.participants")}: ${summary.participants.join(", ")}</p>` : nothing}
            ${(["decisions", "actionItems", "risks"] as const).map((key) =>
              summary[key].length
                ? html`<h3>${t(`transcripts.${key}`)}</h3>
                    <ul>
                      ${summary[key].map((text) => html`<li>${text}</li>`)}
                    </ul>`
                : nothing,
            )}`
        : html`<p role="status">${t("transcripts.noSummary")}</p>`
    }
  </section>`;
}

function renderReader(props: TranscriptsViewProps) {
  const params = new URLSearchParams(props.search);
  const selected = params.get("selected");
  if (!selected) {
    return html`<div class="transcripts-notice transcripts-reader__placeholder">
      <h2>${t("transcripts.choose")}</h2>
      <p>${t("transcripts.chooseHint")}</p>
    </div>`;
  }
  const page = props.reader.pages.at(-1);
  return html`<article
    class="transcripts-reader"
    aria-label=${t("transcripts.reader")}
    aria-busy=${props.reader.loading}
  >
    <a
      class="transcripts-back"
      href=${
        pathForRoute("transcripts", props.basePath) +
        transcriptRouteSearch(props.search, { selected: null, find: null })
      }
      @click=${(event: MouseEvent) => {
        if (!shouldHandleNavigationClick(event)) {
          return;
        }
        event.preventDefault();
        props.onNavigate({ selected: null, find: null });
      }}
      >${icons.arrowLeft}${t("transcripts.back")}</a
    >
    ${props.reader.error ? renderReadError(props.reader.error, props.onReaderRetry) : nothing}
    ${
      page
        ? html`
            <header class="transcripts-reader__header">
              <p class="transcripts-caption">
                <time datetime=${page.session.startedAt}
                  >${transcriptTime(page.session.startedAt)}</time
                >
              </p>
              <h1 tabindex="-1">${page.session.title || page.session.sessionId}</h1>
              <p class="transcripts-caption">${transcriptSourceLabel(page.session.source)}</p>
              <p class="transcripts-caption">
                ${page.session.agentId ?? t("transcripts.unattributed")} ·
                ${t("transcripts.savedCount", { count: String(page.session.utteranceCount) })}
              </p>
              <p class="transcripts-caption">
                ${t("transcripts.lastUtterance", {
                  time: transcriptTime(page.session.lastUtteranceAt),
                })}
              </p>
              <p class="transcripts-caption">
                ${t(
                  page.session.activeSubscription
                    ? "transcripts.armedHint"
                    : "transcripts.inactiveHint",
                )}
              </p>
              <div class="transcripts-actions">
                ${(["markdown", "jsonl"] as const).map(
                  (format) =>
                    html`<button
                      class="btn"
                      ?disabled=${props.exportState.kind === "loading"}
                      @click=${() => props.onDownload(format)}
                    >
                      ${icons.download}${t(`transcripts.download.${format}`)}
                    </button>`,
                )}
              </div>
              ${
                props.exportState.kind === "error"
                  ? html`<p role="alert">
                      ${t("transcripts.exportError")} ${props.exportState.message}
                    </p>`
                  : nothing
              }
              ${
                props.exportState.kind === "loading" || props.exportState.kind === "done"
                  ? html`<p role="status">
                      ${t(
                        props.exportState.kind === "loading"
                          ? "transcripts.exporting"
                          : "transcripts.downloadStarted",
                      )}
                    </p>`
                  : nothing
              }
            </header>
            ${renderHubTabs({
              id: "transcript-reader",
              active: props.readerTab,
              tabs: [
                { value: "text", label: t("transcripts.text") },
                { value: "summary", label: t("transcripts.summary") },
              ],
              ariaLabel: t("transcripts.reader"),
              panelId: "transcript-reader-panel",
              variant: "sub",
              onSelect: props.onReaderTab,
            })}
            <div
              id="transcript-reader-panel"
              role="tabpanel"
              aria-labelledby=${`transcript-reader-tab-${props.readerTab}`}
            >
              ${
                props.readerTab === "summary"
                  ? renderSummary(page)
                  : html`
                      <form
                        class="transcripts-search"
                        role="search"
                        @submit=${(event: SubmitEvent) => {
                          event.preventDefault();
                          const query = normalizeNullableString(
                            // SAFETY: This synchronous submit handler is bound to the native search form.
                            new FormData(event.currentTarget as HTMLFormElement).get("find"),
                          );
                          props.onNavigate({ find: query });
                        }}
                      >
                        <label class="field">
                          <input
                            type="search"
                            name="find"
                            aria-label=${t("transcripts.searchWithin")}
                            placeholder=${t("transcripts.searchWithin")}
                            maxlength=${TRANSCRIPT_QUERY_LIMIT}
                            .value=${live(props.drafts.find ?? "")}
                            @input=${(event: Event) =>
                              // SAFETY: This native input emits the input event handled by its own binding.
                              props.onDraft("find", (event.target as HTMLInputElement).value)}
                          />
                        </label>
                        <button class="btn" type="submit">
                          ${icons.search}${t("transcripts.search")}
                        </button>
                        ${
                          params.get("find")
                            ? html`<button
                                class="btn"
                                type="button"
                                @click=${() => props.onNavigate({ find: null })}
                              >
                                ${t("transcripts.clearSearch")}
                              </button>`
                            : nothing
                        }
                      </form>
                      ${
                        params.get("find")
                          ? html`<p class="transcripts-caption" role="status">
                              ${t("transcripts.searchResults", { query: params.get("find") ?? "" })}
                            </p>`
                          : nothing
                      }
                      ${
                        props.reader.trimmed
                          ? html`<p class="transcripts-caption">
                              ${t("transcripts.windowHint")}
                              <button class="btn btn--xs" @click=${props.onReaderStart}>
                                ${t("transcripts.readerStart")}
                              </button>
                            </p>`
                          : nothing
                      }
                      <ol class="transcripts-utterances">
                        ${props.reader.pages
                          .flatMap((result) => result.utterances ?? [])
                          .map(
                            (utterance) => html`<li>
                              <div class="transcripts-utterance__byline">
                                <strong
                                  >${
                                    utterance.speakerLabel ??
                                    utterance.speakerId ??
                                    t("transcripts.unknownSpeaker")
                                  }</strong
                                >
                                ${renderSourceTime(utterance.startedAt ?? utterance.endedAt)}
                              </div>
                              <p>${utterance.text}</p>
                            </li>`,
                          )}
                      </ol>
                      ${
                        !props.reader.pages.some((result) => result.utterances?.length)
                          ? html`<p role="status">
                              ${t(
                                params.get("find")
                                  ? "transcripts.noMatches"
                                  : "transcripts.noUtterances",
                              )}
                            </p>`
                          : nothing
                      }
                      ${
                        page.nextCursor
                          ? html`<button
                              class="btn"
                              ?disabled=${props.reader.loading}
                              @click=${props.onLoadMore}
                            >
                              ${t("transcripts.loadMore")}
                            </button>`
                          : nothing
                      }
                    `
              }
            </div>
          `
        : nothing
    }
    ${props.reader.loading ? html`<p role="status">${t("common.loading")}</p>` : nothing}
  </article>`;
}

export function renderTranscripts(props: TranscriptsViewProps) {
  const selected = new URLSearchParams(props.search).has("selected");
  const captureTarget = SETTINGS_SEARCH_TARGETS.meetingCapture;
  return html`<section class="transcripts-workspace">
    <header class="content-header">
      <div>
        <h1 class="page-title">${t("tabs.transcripts")}</h1>
        <p class="page-sub">${t("subtitles.transcripts")}</p>
      </div>
      <div class="transcripts-actions">
        <a
          class="btn"
          href=${
            pathForRoute(captureTarget.routeId, props.basePath) +
            captureTarget.search +
            captureTarget.hash
          }
          >${icons.settings}${t("meetingCapture.title")}</a
        >
        <button
          class="btn"
          ?disabled=${!props.connected || !props.allowed || props.listLoading}
          @click=${props.onRefresh}
        >
          ${icons.refresh}${t("common.refresh")}
        </button>
      </div>
    </header>
    ${
      !props.connected
        ? html`<div class="transcripts-notice" role="status">${t("transcripts.disconnected")}</div>`
        : !props.allowed
          ? html`<div class="transcripts-notice" role="alert">
              <h2>${t("transcripts.forbidden")}</h2>
              <p>${t("transcripts.forbiddenHint")}</p>
            </div>`
          : html`<div class="transcripts-layout ${selected ? "transcripts-layout--selected" : ""}">
              <section class="transcripts-library" aria-label=${t("transcripts.library")}>
                ${renderFilters(props)}${renderLibrary(props)}
              </section>
              ${renderReader(props)}
            </div>`
    }
  </section>`;
}
