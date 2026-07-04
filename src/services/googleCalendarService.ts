const GOOGLE_IDENTITY_SCRIPT_SRC = 'https://accounts.google.com/gsi/client';
const CALENDAR_API_BASE = 'https://www.googleapis.com/calendar/v3';
const CALENDAR_CONSENT_STORAGE_KEY = 'repair_calendar_consent_v1';
const CALENDAR_SOURCE_APP = 'field-engineer-route-optimizer';

export const GOOGLE_CALENDAR_SCOPE = 'https://www.googleapis.com/auth/calendar.events';

type GoogleTokenResponse = {
  access_token?: string;
  error?: string;
  error_description?: string;
  scope?: string;
};

type GoogleTokenClient = {
  requestAccessToken: (overrideConfig?: { prompt?: string }) => void;
};

type GoogleOauthNamespace = {
  initTokenClient: (config: {
    client_id: string;
    scope: string;
    callback: (response: GoogleTokenResponse) => void;
    error_callback?: (error: { type?: string; message?: string }) => void;
  }) => GoogleTokenClient;
  hasGrantedAllScopes?: (response: GoogleTokenResponse, ...scopes: string[]) => boolean;
};

declare global {
  interface Window {
    google?: {
      accounts?: {
        oauth2?: GoogleOauthNamespace;
      };
    };
  }
}

type CalendarEventResponse = {
  id?: string;
  htmlLink?: string;
  extendedProperties?: {
    private?: Record<string, string>;
  };
};

type CalendarEventsListResponse = {
  items?: CalendarEventResponse[];
  nextPageToken?: string;
};

export type GoogleCalendarRouteEventInput = {
  summary: string;
  location: string;
  description: string;
  startDateTime: string;
  endDateTime: string;
  timeZone: string;
  metadata: {
    workDate: string;
    routePlanId: string;
    visitId: string;
    routeRunId: string;
  };
};

export type GoogleCalendarSyncResult = {
  createdCount: number;
  replacedCount: number;
};

export class GoogleCalendarAuthError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'GoogleCalendarAuthError';
  }
}

export class GoogleCalendarPartialError extends Error {
  createdCount: number;
  failedCleanupCount: number;

  constructor(message: string, createdCount: number, failedCleanupCount = 0) {
    super(message);
    this.name = 'GoogleCalendarPartialError';
    this.createdCount = createdCount;
    this.failedCleanupCount = failedCleanupCount;
  }
}

let googleIdentityScriptPromise: Promise<void> | null = null;

export function isGoogleCalendarConfigured(clientId: string): boolean {
  return Boolean(clientId.trim());
}

function loadGoogleIdentityScript(): Promise<void> {
  if (window.google?.accounts?.oauth2) return Promise.resolve();
  if (googleIdentityScriptPromise) return googleIdentityScriptPromise;

  googleIdentityScriptPromise = new Promise((resolve, reject) => {
    const existing = document.querySelector<HTMLScriptElement>(`script[src="${GOOGLE_IDENTITY_SCRIPT_SRC}"]`);
    if (existing) {
      existing.addEventListener('load', () => resolve(), { once: true });
      existing.addEventListener('error', () => reject(new GoogleCalendarAuthError('Googleログインの読み込みに失敗しました。')), { once: true });
      return;
    }

    const script = document.createElement('script');
    script.src = GOOGLE_IDENTITY_SCRIPT_SRC;
    script.async = true;
    script.defer = true;
    script.onload = () => resolve();
    script.onerror = () => reject(new GoogleCalendarAuthError('Googleログインの読み込みに失敗しました。'));
    document.head.appendChild(script);
  });

  return googleIdentityScriptPromise;
}

function hasPreviousCalendarConsent(): boolean {
  try {
    return localStorage.getItem(CALENDAR_CONSENT_STORAGE_KEY) === '1';
  } catch {
    return false;
  }
}

function rememberCalendarConsent() {
  try {
    localStorage.setItem(CALENDAR_CONSENT_STORAGE_KEY, '1');
  } catch {}
}

function forgetCalendarConsent() {
  try {
    localStorage.removeItem(CALENDAR_CONSENT_STORAGE_KEY);
  } catch {}
}

export async function requestGoogleCalendarAccessToken(clientId: string): Promise<string> {
  if (!isGoogleCalendarConfigured(clientId)) {
    throw new GoogleCalendarAuthError('Googleカレンダー連携が未設定です。');
  }

  await loadGoogleIdentityScript();
  const oauth2 = window.google?.accounts?.oauth2;
  if (!oauth2) {
    throw new GoogleCalendarAuthError('Googleログインを利用できません。');
  }

  return new Promise((resolve, reject) => {
    let settled = false;
    const finish = (fn: () => void) => {
      if (settled) return;
      settled = true;
      window.clearTimeout(timeoutId);
      fn();
    };

    const tokenClient = oauth2.initTokenClient({
      client_id: clientId,
      scope: GOOGLE_CALENDAR_SCOPE,
      callback: (response) => {
        if (response.error) {
          forgetCalendarConsent();
          finish(() => reject(new GoogleCalendarAuthError(response.error_description || 'Googleカレンダーの認証がキャンセルされました。')));
          return;
        }
        const hasScope = oauth2.hasGrantedAllScopes
          ? oauth2.hasGrantedAllScopes(response, GOOGLE_CALENDAR_SCOPE)
          : Boolean(response.access_token);
        if (!response.access_token || !hasScope) {
          forgetCalendarConsent();
          finish(() => reject(new GoogleCalendarAuthError('Googleカレンダーへの登録権限が許可されませんでした。')));
          return;
        }
        rememberCalendarConsent();
        finish(() => resolve(response.access_token || ''));
      },
      error_callback: (error) => {
        forgetCalendarConsent();
        const message = error.type === 'popup_closed'
          ? 'Googleログインがキャンセルされました。'
          : error.message || 'Googleログインに失敗しました。';
        finish(() => reject(new GoogleCalendarAuthError(message)));
      },
    });

    const timeoutId = window.setTimeout(() => {
      forgetCalendarConsent();
      finish(() => reject(new GoogleCalendarAuthError('Googleログインが完了しませんでした。再度お試しください。')));
    }, 120000);

    tokenClient.requestAccessToken({ prompt: hasPreviousCalendarConsent() ? '' : 'consent' });
  });
}

function addDaysToDateInput(dateValue: string, days: number): string {
  const [year, month, day] = dateValue.split('-').map(Number);
  const date = new Date(Date.UTC(year, month - 1, day + days));
  const yyyy = date.getUTCFullYear();
  const mm = String(date.getUTCMonth() + 1).padStart(2, '0');
  const dd = String(date.getUTCDate()).padStart(2, '0');
  return `${yyyy}-${mm}-${dd}`;
}

async function calendarFetch<T>(accessToken: string, path: string, init: RequestInit = {}): Promise<T> {
  const headers = new Headers(init.headers);
  headers.set('Authorization', `Bearer ${accessToken}`);
  if (init.body) headers.set('Content-Type', 'application/json');

  const response = await fetch(`${CALENDAR_API_BASE}${path}`, {
    ...init,
    headers,
  });

  if (!response.ok) {
    let detail = '';
    try {
      const body = await response.json();
      detail = body?.error?.message || '';
    } catch {}
    throw new Error(detail || `Google Calendar API error: ${response.status}`);
  }

  if (response.status === 204) return {} as T;
  return response.json() as Promise<T>;
}

async function listExistingAppEvents(accessToken: string, workDate: string): Promise<CalendarEventResponse[]> {
  const items: CalendarEventResponse[] = [];
  let pageToken = '';

  do {
    const params = new URLSearchParams({
      singleEvents: 'true',
      maxResults: '2500',
      timeMin: `${workDate}T00:00:00+09:00`,
      timeMax: `${addDaysToDateInput(workDate, 1)}T00:00:00+09:00`,
    });
    params.append('privateExtendedProperty', `sourceApp=${CALENDAR_SOURCE_APP}`);
    if (pageToken) params.set('pageToken', pageToken);

    const data = await calendarFetch<CalendarEventsListResponse>(
      accessToken,
      `/calendars/primary/events?${params.toString()}`
    );
    items.push(...(data.items || []).filter(event =>
      event.id &&
      event.extendedProperties?.private?.sourceApp === CALENDAR_SOURCE_APP &&
      event.extendedProperties.private.workDate === workDate
    ));
    pageToken = data.nextPageToken || '';
  } while (pageToken);

  return items;
}

async function createCalendarEvent(
  accessToken: string,
  event: GoogleCalendarRouteEventInput
): Promise<CalendarEventResponse> {
  return calendarFetch<CalendarEventResponse>(
    accessToken,
    '/calendars/primary/events?sendUpdates=none',
    {
      method: 'POST',
      body: JSON.stringify({
        summary: event.summary,
        location: event.location,
        description: event.description,
        start: {
          dateTime: event.startDateTime,
          timeZone: event.timeZone,
        },
        end: {
          dateTime: event.endDateTime,
          timeZone: event.timeZone,
        },
        extendedProperties: {
          private: {
            sourceApp: CALENDAR_SOURCE_APP,
            workDate: event.metadata.workDate,
            routePlanId: event.metadata.routePlanId,
            visitId: event.metadata.visitId,
            routeRunId: event.metadata.routeRunId,
          },
        },
      }),
    }
  );
}

async function deleteCalendarEvent(accessToken: string, eventId: string): Promise<void> {
  await calendarFetch<Record<string, never>>(
    accessToken,
    `/calendars/primary/events/${encodeURIComponent(eventId)}?sendUpdates=none`,
    { method: 'DELETE' }
  );
}

export async function syncRouteEventsToPrimaryCalendar({
  accessToken,
  workDate,
  events,
}: {
  accessToken: string;
  workDate: string;
  events: GoogleCalendarRouteEventInput[];
}): Promise<GoogleCalendarSyncResult> {
  const existingEvents = await listExistingAppEvents(accessToken, workDate);
  const createdEvents: CalendarEventResponse[] = [];

  try {
    for (const event of events) {
      createdEvents.push(await createCalendarEvent(accessToken, event));
    }
  } catch (error) {
    throw new GoogleCalendarPartialError(
      error instanceof Error ? error.message : 'Googleカレンダーへの登録に失敗しました。',
      createdEvents.length
    );
  }

  const deleteFailures: string[] = [];
  for (const event of existingEvents) {
    if (!event.id) continue;
    try {
      await deleteCalendarEvent(accessToken, event.id);
    } catch {
      deleteFailures.push(event.id);
    }
  }

  if (deleteFailures.length > 0) {
    throw new GoogleCalendarPartialError(
      '新しい予定は登録しましたが、前回の予定の削除に失敗しました。',
      createdEvents.length,
      deleteFailures.length
    );
  }

  return {
    createdCount: createdEvents.length,
    replacedCount: existingEvents.length,
  };
}
