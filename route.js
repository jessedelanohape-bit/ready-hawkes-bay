/* Zone geometry and nearest-safe-point routing.
   Pure functions plus thin fetch wrappers, so the logic can be tested without a network. */
(function (root) {
  const ZONE_LAYER = 'https://services1.arcgis.com/hWByVnSkh6ElzHkf/arcgis/rest/services/HawkesBay_Tsunami_Evacuation_Zones_View/FeatureServer/1';
  const OSRM_FOOT = 'https://routing.openstreetmap.de/routed-foot';
  const NOMINATIM = 'https://nominatim.openstreetmap.org/search';

  /* ---------- geometry ---------- */
  // polygons: array of polygons, each an array of rings, each ring an array of [lon, lat]
  function polygonsFromGeoJSON(fc) {
    const out = [];
    for (const f of (fc && fc.features) || []) {
      const g = f.geometry; if (!g) continue;
      if (g.type === 'Polygon') out.push(g.coordinates);
      else if (g.type === 'MultiPolygon') g.coordinates.forEach(p => out.push(p));
    }
    return out;
  }
  function inRing(pt, ring) {
    const x = pt[0], y = pt[1]; let inside = false;
    for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
      const xi = ring[i][0], yi = ring[i][1], xj = ring[j][0], yj = ring[j][1];
      if (((yi > y) !== (yj > y)) && (x < (xj - xi) * (y - yi) / (yj - yi) + xi)) inside = !inside;
    }
    return inside;
  }
  function inPolygon(pt, poly) {
    if (!inRing(pt, poly[0])) return false;
    for (let h = 1; h < poly.length; h++) if (inRing(pt, poly[h])) return false;
    return true;
  }
  function inZone(pt, polys) {
    for (const p of polys) if (inPolygon(pt, p)) return true;
    return false;
  }
  function metres(a, b) {
    const R = 6371000, toR = Math.PI / 180;
    const dLat = (b[1] - a[1]) * toR, dLon = (b[0] - a[0]) * toR;
    const s = Math.sin(dLat / 2) ** 2 + Math.cos(a[1] * toR) * Math.cos(b[1] * toR) * Math.sin(dLon / 2) ** 2;
    return 2 * R * Math.asin(Math.sqrt(s));
  }
  function offset(pt, east, north) {
    const lat = pt[1] * Math.PI / 180;
    return [pt[0] + east / (111320 * Math.cos(lat)), pt[1] + north / 110540];
  }

  // Points just outside the zone, closest first, spread out so they lead to different streets.
  function safeCandidates(start, polys, opts) {
    const o = Object.assign({ max: 20, spacing: 150, step: 40, scan: 4000 }, opts);
    const verts = [];
    for (const p of polys) for (const ring of p) for (const v of ring) verts.push(v);
    verts.sort((a, b) => metres(start, a) - metres(start, b));
    const dirs = [];
    for (let k = 0; k < 8; k++) { const a = k * Math.PI / 4; dirs.push([Math.cos(a), Math.sin(a)]); }
    const picked = [];
    for (let i = 0; i < verts.length && i < o.scan && picked.length < o.max; i++) {
      const v = verts[i];
      if (picked.some(c => metres(c, v) < o.spacing)) continue;
      // try the direction pointing away from the start first, then the rest
      const away = [v[0] - start[0], v[1] - start[1]];
      const order = dirs.slice().sort((d1, d2) => (d2[0] * away[0] + d2[1] * away[1]) - (d1[0] * away[0] + d1[1] * away[1]));
      for (const d of order) {
        const c = offset(v, d[0] * o.step, d[1] * o.step);
        if (!inZone(c, polys)) { picked.push(c); break; }
      }
    }
    return picked;
  }

  /* ---------- network ---------- */
  async function getJSON(url, fetchImpl) {
    const r = await (fetchImpl || fetch)(url);
    if (!r.ok) throw new Error('HTTP ' + r.status + ' from ' + new URL(url).host);
    return r.json();
  }
  async function loadZone(fetchImpl) {
    const features = [];
    for (let offsetN = 0; offsetN < 20000; offsetN += 1000) {
      const q = new URLSearchParams({ where: '1=1', outFields: '*', outSR: '4326', f: 'geojson', geometryPrecision: '6',
        maxAllowableOffset: '0.00003', resultOffset: String(offsetN), resultRecordCount: '1000' });
      const fc = await getJSON(ZONE_LAYER + '/query?' + q, fetchImpl);
      features.push(...(fc.features || []));
      const more = fc.exceededTransferLimit || (fc.properties && fc.properties.exceededTransferLimit);
      if (!more || !(fc.features || []).length) break;
    }
    return { type: 'FeatureCollection', features };
  }
  async function geocode(text, fetchImpl) {
    const q = new URLSearchParams({ format: 'jsonv2', q: text, countrycodes: 'nz', viewbox: '175.9,-38.6,178.7,-40.6',
      bounded: '1', addressdetails: '1', limit: '5' });
    const res = await getJSON(NOMINATIM + '?' + q, fetchImpl);
    return res.map(r => ({ label: r.display_name, lon: Number(r.lon), lat: Number(r.lat), address: r.address || {} }));
  }
  const ll = p => p[0].toFixed(6) + ',' + p[1].toFixed(6);

  // Walk times from start to each candidate; drops candidates that snap back into the zone.
  async function rankCandidates(start, cands, polys, fetchImpl) {
    try {
      const url = OSRM_FOOT + '/table/v1/driving/' + [start].concat(cands).map(ll).join(';') + '?sources=0&annotations=duration,distance';
      const t = await getJSON(url, fetchImpl);
      if (t.code !== 'Ok') throw new Error(t.code);
      return cands.map((c, i) => ({ point: t.destinations[i + 1].location, duration: t.durations[0][i + 1], distance: t.distances ? t.distances[0][i + 1] : null }))
        .filter(r => r.duration != null && !inZone(r.point, polys))
        .sort((a, b) => a.duration - b.duration);
    } catch (e) {
      // table service unavailable: fall back to routing the five nearest one by one
      const out = [];
      for (const c of cands.slice(0, 5)) {
        try { const r = await route(start, c, fetchImpl); if (!inZone(r.end, polys)) out.push({ point: r.end, duration: r.duration, distance: r.distance, route: r }); } catch (_) {}
      }
      return out.sort((a, b) => a.duration - b.duration);
    }
  }
  async function route(start, end, fetchImpl) {
    const url = OSRM_FOOT + '/route/v1/driving/' + ll(start) + ';' + ll(end) + '?overview=full&geometries=geojson&steps=true';
    const r = await getJSON(url, fetchImpl);
    if (r.code !== 'Ok' || !r.routes.length) throw new Error('No walking route found');
    const best = r.routes[0];
    return { geometry: best.geometry, duration: best.duration, distance: best.distance, end: r.waypoints[1].location,
      steps: (best.legs[0].steps || []).map(s => ({ text: describe(s), distance: s.distance })).filter(s => s.text) };
  }
  function describe(s) {
    const m = s.maneuver || {}; const name = s.name ? ' onto ' + s.name : '';
    if (m.type === 'depart') return 'Head ' + (m.modifier ? m.modifier + ' ' : '') + (s.name ? 'along ' + s.name : 'off');
    if (m.type === 'arrive') return 'Arrive at the safe point, then keep moving away from the coast';
    if (m.type === 'turn' || m.type === 'end of road' || m.type === 'fork') return 'Turn ' + (m.modifier || '') + name;
    if (m.type === 'roundabout' || m.type === 'rotary') return 'At the roundabout, take exit ' + (m.exit || '') + name;
    if (m.type === 'continue' || m.type === 'new name') return s.name ? 'Continue along ' + s.name : '';
    return '';
  }

  // Full pipeline: returns { inside, best?, candidates }
  async function nearestSafeRoute(start, polys, fetchImpl) {
    if (!inZone(start, polys)) return { inside: false };
    const cands = safeCandidates(start, polys);
    if (!cands.length) throw new Error('Could not find a point outside the zone nearby');
    const ranked = await rankCandidates(start, cands, polys, fetchImpl);
    if (!ranked.length) throw new Error('No walking route out of the zone was found');
    const top = ranked[0];
    const r = top.route || await route(start, top.point, fetchImpl);
    return { inside: true, best: r, candidates: ranked.length };
  }

  const api = { polygonsFromGeoJSON, inZone, metres, safeCandidates, loadZone, geocode, nearestSafeRoute, route, ZONE_LAYER };
  if (typeof module !== 'undefined') module.exports = api; else root.SafeRoute = api;
})(typeof window !== 'undefined' ? window : globalThis);
