import type { DatabaseSync } from 'node:sqlite';
import { rebuildPlaces, transaction } from './db';
import { assignForImport, type AssignOptions } from './areas';
import type { AssignStats } from '../shared/types';

// 端末の「タイムラインをエクスポート」で作られる JSON（semanticSegments / rawSignals /
// userLocationProfile を持つ形式）を DB に取り込む。

interface ImportStats {
  rangeStart: string | null;
  rangeEnd: string | null;
  visits: number;
  activities: number;
  points: number;
  trips: number;
  /** 住所を割り当てた結果（位置参照情報が入っていれば） */
  addresses?: AssignStats;
}

/** "43.063391°, 141.35112°" → [43.063391, 141.35112] */
export function parseLatLng(s: string | undefined): [number, number] | null {
  if (!s) return null;
  const [a, b] = s.replace(/°/g, '').split(',');
  const lat = Number(a);
  const lng = Number(b);
  return Number.isFinite(lat) && Number.isFinite(lng) ? [lat, lng] : null;
}

export function isTimelineExport(data: unknown): data is { semanticSegments: any[] } {
  return typeof data === 'object' && data !== null && Array.isArray((data as any).semanticSegments);
}

/**
 * エクスポートには毎回その端末にある全期間が入っているので、
 * 新しいファイルの開始時刻以降は新しいファイルの内容で置き換え、それより前は残す。
 */
export function importTimeline(
  db: DatabaseSync,
  data: { semanticSegments: any[]; userLocationProfile?: unknown },
  fileName: string,
  storedPath: string,
  assignOpts: AssignOptions,
): ImportStats {
  const segments = data.semanticSegments;
  let rangeStartMs = Infinity;
  let rangeEndMs = -Infinity;
  let rangeStart: string | null = null;
  let rangeEnd: string | null = null;
  for (const s of segments) {
    const st = Date.parse(s.startTime);
    const et = Date.parse(s.endTime);
    if (st < rangeStartMs) [rangeStartMs, rangeStart] = [st, s.startTime];
    if (et > rangeEndMs) [rangeEndMs, rangeEnd] = [et, s.endTime];
  }
  const stats: ImportStats = { rangeStart, rangeEnd, visits: 0, activities: 0, points: 0, trips: 0 };
  if (!segments.length) return stats;

  const insVisit = db.prepare(
    `INSERT INTO visits (start_ms, end_ms, start_local, end_local, local_date, utc_offset_min,
       place_id, semantic_type, lat, lng, probability, place_probability, hierarchy_level)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  );
  const insActivity = db.prepare(
    `INSERT INTO activities (start_ms, end_ms, start_local, end_local, local_date, utc_offset_min,
       type, distance_m, probability, type_probability, start_lat, start_lng, end_lat, end_lng,
       parking_lat, parking_lng, parking_ms)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  );
  const insPoint = db.prepare('INSERT OR IGNORE INTO path_points (t_ms, lat, lng) VALUES (?, ?, ?)');
  const insTrip = db.prepare(
    `INSERT INTO trips (start_ms, end_ms, start_local, end_local, distance_km, destinations)
     VALUES (?, ?, ?, ?, ?, ?)`,
  );

  transaction(db, () => {
    for (const table of ['visits', 'activities', 'trips']) {
      db.prepare(`DELETE FROM ${table} WHERE start_ms >= ?`).run(rangeStartMs);
    }
    db.prepare('DELETE FROM path_points WHERE t_ms >= ?').run(rangeStartMs);

    for (const s of segments) {
      const startMs = Date.parse(s.startTime);
      const endMs = Date.parse(s.endTime);
      const localDate = String(s.startTime).slice(0, 10);
      const offset = s.startTimeTimezoneUtcOffsetMinutes ?? null;

      if (s.visit) {
        const c = s.visit.topCandidate ?? {};
        const ll = parseLatLng(c.placeLocation?.latLng);
        if (ll && c.placeId) {
          insVisit.run(startMs, endMs, s.startTime, s.endTime, localDate, offset, c.placeId,
            c.semanticType ?? 'UNKNOWN', ll[0], ll[1], s.visit.probability ?? null,
            c.probability ?? null, s.visit.hierarchyLevel ?? 0);
          stats.visits++;
        }
      }
      if (s.activity) {
        const a = s.activity;
        const from = parseLatLng(a.start?.latLng);
        const to = parseLatLng(a.end?.latLng);
        if (from && to) {
          const parking = parseLatLng(a.parking?.location?.latLng);
          insActivity.run(startMs, endMs, s.startTime, s.endTime, localDate, offset,
            a.topCandidate?.type ?? 'UNKNOWN_ACTIVITY_TYPE', a.distanceMeters ?? 0,
            a.probability ?? null, a.topCandidate?.probability ?? null, from[0], from[1], to[0], to[1],
            parking?.[0] ?? null, parking?.[1] ?? null,
            a.parking?.startTime ? Date.parse(a.parking.startTime) : null);
          stats.activities++;
        }
      }
      if (Array.isArray(s.timelinePath)) {
        for (const p of s.timelinePath) {
          const ll = parseLatLng(p.point);
          const t = Date.parse(p.time);
          if (ll && Number.isFinite(t)) {
            insPoint.run(t, ll[0], ll[1]);
            stats.points++;
          }
        }
      }
      if (s.timelineMemory?.trip) {
        const trip = s.timelineMemory.trip;
        const dest = (trip.destinations ?? []).map((d: any) => d.identifier?.placeId).filter(Boolean);
        insTrip.run(startMs, endMs, s.startTime, s.endTime, trip.distanceFromOriginKms ?? null, JSON.stringify(dest));
        stats.trips++;
      }
    }

    rebuildPlaces(db);

    if (data.userLocationProfile) {
      db.prepare('INSERT OR REPLACE INTO kv (key, value) VALUES (?, ?)').run(
        'userLocationProfile', JSON.stringify(data.userLocationProfile));
    }
    db.prepare(
      `INSERT INTO imports (imported_at, file_name, stored_path, range_start, range_end, visits, activities, points, trips)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(new Date().toISOString(), fileName, storedPath, stats.rangeStart, stats.rangeEnd,
      stats.visits, stats.activities, stats.points, stats.trips);
  });
  // 地点に住所を割り当てる：新しい地点と、位置参照情報を入れ直したあとにまだ調べ直していない地点（位置参照情報が入っていれば）
  stats.addresses = assignForImport(db, assignOpts);
  return stats;
}
