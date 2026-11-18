import type { Env, Page, PageVersion } from '../../types';
import type { PagePublicationStatus } from '../../contracts/publish';
import type { AuditActor } from '../../core/db/audit';
import type { EditorPublicationState } from '../publication';
import { safeParseLect, stringifyLect } from '../../core/db/lect';
import { getLiveLect, listLiveByTypes, liveMapForDraftPages } from './index';
import { draftLectProjector } from './projection';

function lectsMatch(left: string | null | undefined, right: string | null | undefined): boolean {
  if ((left ?? '') === (right ?? '')) return true;
  return stringifyLect(safeParseLect(left)) === stringifyLect(safeParseLect(right));
}

type PageScheduleFields = {
  start?: string | null;
  end?: string | null;
  timezone?: string | null;
};

type LiveStatusPage = {
  weight: number;
  lect: string | null | undefined;
} & PageScheduleFields;

function fixedOffsetMinutes(value: string): number | null {
  const match = value.trim().match(/^([+-])(\d{2})(?::?(\d{2}))?$/);
  if (!match) return null;
  const [, sign, hour, minute = '00'] = match;
  const hours = Number(hour);
  const minutes = Number(minute);
  if (hours > 23 || minutes > 59) return null;
  const offset = hours * 60 + minutes;
  return sign === '-' ? -offset : offset;
}

function dateFromParts(
  year: number,
  month: number,
  day: number,
  hour: number,
  minute: number,
  second: number,
  millisecond: number,
): Date | null {
  const date = new Date(0);
  date.setUTCFullYear(year, month - 1, day);
  date.setUTCHours(hour, minute, second, millisecond);
  if (
    Number.isNaN(date.getTime())
    || date.getUTCFullYear() !== year
    || date.getUTCMonth() !== month - 1
    || date.getUTCDate() !== day
    || date.getUTCHours() !== hour
    || date.getUTCMinutes() !== minute
    || date.getUTCSeconds() !== second
    || date.getUTCMilliseconds() !== millisecond
  ) return null;
  return date;
}

function timeZoneOffsetMinutes(date: Date, timezone: string): number | null {
  try {
    const parts = new Intl.DateTimeFormat('en-CA', {
      timeZone: timezone,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
      hourCycle: 'h23',
      hour12: false,
    }).formatToParts(date);
    const part = (type: string) => parts.find((entry) => entry.type === type)?.value;
    const displayed = dateFromParts(
      Number(part('year')),
      Number(part('month')),
      Number(part('day')),
      Number(part('hour')),
      Number(part('minute')),
      Number(part('second')),
      0,
    );
    if (!displayed) return null;
    return Math.round((displayed.getTime() - date.getTime()) / 60_000);
  } catch {
    return null;
  }
}

/** Converts a stored datetime-local value into an instant for status checks. */
function pageDate(value: string | null | undefined, timezone: string | null | undefined): Date | null {
  if (!value?.trim()) return null;
  const match = value.trim().match(
    /^(\d{4})-(\d{2})-(\d{2})(?:[T ](\d{2}):(\d{2})(?::(\d{2})(?:\.(\d{1,3}))?)?)?(?:\s*(Z|[+-]\d{2}:?\d{2}))?$/,
  );
  if (!match) return null;

  const [, year, month, day, hour = '00', minute = '00', second = '00', fraction = '', suffix] = match;
  const wallTime = dateFromParts(
    Number(year),
    Number(month),
    Number(day),
    Number(hour),
    Number(minute),
    Number(second),
    Number(fraction.padEnd(3, '0')),
  );
  if (!wallTime) return null;

  let offset = suffix === 'Z' ? 0 : suffix ? fixedOffsetMinutes(suffix) : null;
  if (suffix && offset === null) return null;
  if (offset === null) offset = fixedOffsetMinutes(timezone ?? '');
  if (offset !== null) return new Date(wallTime.getTime() - offset * 60_000);

  const zone = timezone?.trim();
  if (!zone) return wallTime;

  // Iteratively resolve a wall-clock value in an IANA zone. The first guess
  // treats the wall clock as UTC, then each pass applies the zone's actual
  // offset at that instant (including DST transitions).
  let instant = wallTime.getTime();
  for (let pass = 0; pass < 4; pass++) {
    const zoneOffset = timeZoneOffsetMinutes(new Date(instant), zone);
    if (zoneOffset === null) return wallTime;
    const next = wallTime.getTime() - zoneOffset * 60_000;
    if (next === instant) break;
    instant = next;
  }
  return new Date(instant);
}

export function publicationStatusForPage(
  page: PageScheduleFields,
  isPublished: boolean,
  now = new Date(),
): PagePublicationStatus {
  if (!isPublished) return 'draft';
  const end = pageDate(page.end, page.timezone);
  if (end && end.getTime() <= now.getTime()) return 'ended';
  const start = pageDate(page.start, page.timezone);
  if (start && start.getTime() > now.getTime()) return 'scheduled';
  return 'live';
}

export function withLiveStatus<T extends { uuid: string; weight: number; lect: string | null | undefined } & PageScheduleFields>(
  pages: T[],
  liveMap: ReadonlyMap<string, LiveStatusPage>,
  // Publish-time lect projection. The live copy is
  // projected, so the draft must be projected the same way before diffing or
  // projected types would show permanent lect drift.
  projectDraftLect: (page: T) => string | null | undefined = (page) => page.lect,
  now = new Date(),
) {
  return pages.map((page) => {
    const livePage = liveMap.get(page.uuid);
    const liveHasSchedule = !!livePage && (
      livePage.start !== undefined
      || livePage.end !== undefined
      || livePage.timezone !== undefined
    );
    const schedulePage = liveHasSchedule ? livePage : page;
    return {
      ...page,
      isPublished: !!livePage,
      publicationStatus: publicationStatusForPage(schedulePage, !!livePage, now),
      liveWeight: livePage?.weight,
      hasLiveWeightDrift: !!livePage && livePage.weight !== page.weight,
      hasLiveLectDrift: !!livePage && !lectsMatch(livePage.lect, projectDraftLect(page)),
    };
  });
}

/** Compare only the drafts on the current results page. */
export async function annotateDraftPages(env: Env, pages: Page[], now = new Date()) {
  const [liveMap, projectDraft] = await Promise.all([
    liveMapForDraftPages(env, pages),
    draftLectProjector(env),
  ]);
  return withLiveStatus(pages, liveMap, projectDraft, now);
}

export async function editorPublicationState(
  env: Env,
  page: Page,
  versions: PromiseLike<{ results: PageVersion[] }>,
): Promise<EditorPublicationState> {
  const [liveLect, projectDraft, history] = await Promise.all([
    getLiveLect(env, page.uuid),
    draftLectProjector(env),
    versions,
  ]);
  const isPublished = liveLect !== null;
  // Both current and historical drafts need the same projection as the live copy.
  return {
    isPublished,
    publicationStatus: publicationStatusForPage(page, isPublished),
    liveVersionId: isPublished ? history.results.find(
      candidate => lectsMatch(projectDraft({ page_type: page.page_type, lect: candidate.lect }), liveLect),
    )?.id : undefined,
    isLiveSynced: isPublished && lectsMatch(projectDraft(page), liveLect),
  };
}

/** Filter the draft selection against the current live status. */
export async function filterDraftIdsByStatus(
  env: Env,
  pages: Page[],
  pageTypes: string[],
  status: PagePublicationStatus,
  actor?: AuditActor,
): Promise<number[]> {
  const livePages = await listLiveByTypes(env, pageTypes, actor);
  const liveMap = new Map(livePages.map(page => [page.uuid, page]));
  return pages.filter(page => {
    const live = liveMap.get(page.uuid);
    return publicationStatusForPage(live ?? page, !!live) === status;
  }).map(page => page.id);
}
