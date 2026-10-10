import type {
  AssignStats,
  CalendarResponse,
  ClientConfig,
  DayResponse,
  ImportRecord,
  ListEntriesResponse,
  ListSummary,
  MeResponse,
  PlaceDetailResponse,
  PlaceNote,
  PlacesExtentResponse,
  PlacesResponse,
  SearchResponse,
  TripDetailResponse,
  TripsResponse,
  SummaryResponse,
  TakeoutImportResult,
} from '../shared/types';

export class ApiError extends Error {
  constructor(public status: number, message: string) {
    super(message);
  }
}

/** ログイン切れを画面全体に知らせるためのフック */
export let onUnauthorized: () => void = () => {};
export function setUnauthorizedHandler(fn: () => void): void {
  onUnauthorized = fn;
}

async function request<T>(method: string, path: string, body?: unknown): Promise<T> {
  const res = await fetch(path, {
    method,
    headers: body === undefined ? {} : { 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
    credentials: 'same-origin',
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    if (res.status === 401 && path !== '/api/login') onUnauthorized();
    throw new ApiError(res.status, data.error ?? `エラー (${res.status})`);
  }
  return data as T;
}

export const api = {
  me: () => request<MeResponse>('GET', '/api/me'),
  login: (user: string, password: string) => request<MeResponse>('POST', '/api/login', { user, password }),
  logout: () => request<MeResponse>('POST', '/api/logout'),
  config: () => request<ClientConfig>('GET', '/api/config'),
  summary: () => request<SummaryResponse>('GET', '/api/summary'),
  imports: () => request<ImportRecord[]>('GET', '/api/imports'),
  day: (date: string) => request<DayResponse>('GET', `/api/day?date=${date}`),
  calendar: (year: number) => request<CalendarResponse>('GET', `/api/calendar?year=${year}`),
  /** 条件は URLSearchParams の形で渡す（q, kind, from, to, bbox, sort, limit, offset） */
  places: (query: URLSearchParams) => request<PlacesResponse>('GET', `/api/places?${query}`),
  placesExtent: () => request<PlacesExtentResponse>('GET', '/api/places/extent'),
  place: (placeId: string) => request<PlaceDetailResponse>('GET', `/api/places/${encodeURIComponent(placeId)}`),
  search: (query: URLSearchParams) => request<SearchResponse>('GET', `/api/search?${query}`),
  trips: (query: URLSearchParams) => request<TripsResponse>('GET', `/api/trips?${query}`),
  trip: (startMs: number) => request<TripDetailResponse>('GET', `/api/trips/${startMs}`),
  /** 住所の割り当てを今すぐ行う（取り込みのときと同じ処理） */
  assignAreas: () => request<AssignStats>('POST', '/api/areas/assign'),
  /** まとめてタグを付ける・外す。実際に変わった場所の placeId が返る */
  bulkTags: (body: { placeIds: string[]; add?: string[]; remove?: string[] }) =>
    request<{ changed: string[] }>('POST', '/api/places/tags', body),
  /** Takeout の保存リスト */
  lists: () => request<ListSummary[]>('GET', '/api/lists'),
  listEntries: (list: string) => request<ListEntriesResponse>('GET', `/api/lists/entries?list=${encodeURIComponent(list)}`),
  saveNote: (placeId: string, note: PlaceNote) =>
    request<PlaceNote>('PUT', `/api/places/${encodeURIComponent(placeId)}/note`, note),
};

export interface ImportResult {
  ok: true;
  rangeStart: string | null;
  rangeEnd: string | null;
  visits: number;
  activities: number;
  points: number;
  trips: number;
  addresses?: AssignStats;
}

export type UploadStage = 'compress' | 'upload' | 'process';

/** エクスポートしたファイルを gzip で圧縮してから送る（.gz ならそのまま送る） */
export async function uploadExport(
  file: Blob,
  fileName: string,
  onProgress: (stage: UploadStage, ratio: number) => void,
): Promise<ImportResult> {
  let body: Blob = file;
  const head = new Uint8Array(await file.slice(0, 2).arrayBuffer());
  const gzipped = head[0] === 0x1f && head[1] === 0x8b;
  if (!gzipped && typeof CompressionStream !== 'undefined') {
    onProgress('compress', 0);
    body = await new Response(file.stream().pipeThrough(new CompressionStream('gzip'))).blob();
  }
  return sendWithProgress<ImportResult>('/api/import', body, { 'Content-Type': 'application/octet-stream', 'X-File-Name': encodeURIComponent(fileName) }, onProgress);
}

/** XHR で送り、送信の進み具合を知らせる（fetch では送信の進み具合が取れないため） */
function sendWithProgress<T>(url: string, body: XMLHttpRequestBodyInit, headers: Record<string, string>, onProgress: (stage: UploadStage, ratio: number) => void): Promise<T> {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open('POST', url);
    for (const [k, v] of Object.entries(headers)) xhr.setRequestHeader(k, v);
    xhr.upload.onprogress = (e) => {
      if (e.lengthComputable) onProgress('upload', e.loaded / e.total);
    };
    xhr.upload.onload = () => onProgress('process', 0);
    xhr.onload = () => {
      let data: any = {};
      try {
        data = JSON.parse(xhr.responseText);
      } catch {
        /* JSON でない応答（Web サーバーのエラーページなど） */
      }
      if (xhr.status === 200) resolve(data);
      else {
        if (xhr.status === 401) onUnauthorized();
        reject(new ApiError(xhr.status, data.error ?? `送信に失敗しました (${xhr.status})`));
      }
    };
    xhr.onerror = () => reject(new ApiError(0, '通信に失敗しました'));
    xhr.send(body);
  });
}

/** Google Takeout の zip を送る（書き出しが複数の zip に分かれているときは、まとめて送る） */
export function uploadTakeout(files: Blob[], names: string[], onProgress: (stage: UploadStage, ratio: number) => void): Promise<TakeoutImportResult> {
  const form = new FormData();
  files.forEach((f, i) => form.append('file', f, names[i]));
  onProgress('upload', 0);
  return sendWithProgress<TakeoutImportResult>('/api/takeout', form, {}, onProgress);
}
