/* Zone geometry and nearest-safe-point routing.
   Pure functions plus thin fetch wrappers, so the logic can be tested without a network. */
(function (root) {
  const ZONE_LAYER = 'https://services1.arcgis.com/hWByVnSkh6ElzHkf/arcgis/rest/services/HawkesBay_Tsunami_Evacuation_Zones_View/FeatureServer/1';
  const OSRM_FOOT = 'https://routing.openstreetmap.de/routed-foot';
  const NOMINATIM = 'https://nominatim.openstreetmap.org/search';
  const PHOTON = 'https://photon.komoot.io/api/';

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
    const o = Object.assign({ max: 20, spacing: 150, step: 40, scan: 20000 }, opts);
    // boundary points every ~60 m, so long straight edges still offer exits along their length
    const verts = [];
    for (const p of polys) for (const ring of p) for (let i = 0; i < ring.length; i++) {
      const v = ring[i]; verts.push(v);
      const w = ring[i + 1]; if (!w) continue;
      const parts = Math.min(200, Math.floor(metres(v, w) / 60));
      for (let k = 1; k < parts; k++) verts.push([v[0] + (w[0] - v[0]) * k / parts, v[1] + (w[1] - v[1]) * k / parts]);
    }
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
        if (!inZone(c, polys) && (!o.clear || edgeDistance(c, polys) >= o.clear)) { picked.push(c); break; }
      }
    }
    return picked;
  }

  // Metres from a point to the nearest zone edge (flat-earth approximation, fine at this scale).
  function edgeDistance(pt, polys) {
    const kx = 111320 * Math.cos(pt[1] * Math.PI / 180), ky = 110540;
    let best = Infinity;
    for (const p of polys) for (const ring of p) for (let i = 1; i < ring.length; i++) {
      const ax = (ring[i - 1][0] - pt[0]) * kx, ay = (ring[i - 1][1] - pt[1]) * ky;
      const bx = (ring[i][0] - pt[0]) * kx, by = (ring[i][1] - pt[1]) * ky;
      const dx = bx - ax, dy = by - ay, len = dx * dx + dy * dy;
      const t = len ? Math.max(0, Math.min(1, -(ax * dx + ay * dy) / len)) : 0;
      const d = Math.hypot(ax + t * dx, ay + t * dy);
      if (d < best) best = d;
    }
    return best;
  }

  /* ---------- network ---------- */
  // Asks the council's map service directly whether a point is in the zone, using the full-detail shapes.
  // Resolves true, false, or null when the service could not answer.
  async function serverInZone(pt, fetchImpl) {
    try {
      const q = new URLSearchParams({ geometry: pt[0] + ',' + pt[1], geometryType: 'esriGeometryPoint', inSR: '4326',
        spatialRel: 'esriSpatialRelIntersects', returnCountOnly: 'true', f: 'json' });
      const r = await getJSON(ZONE_LAYER + '/query?' + q, fetchImpl);
      return typeof r.count === 'number' ? r.count > 0 : null;
    } catch (e) { return null; }
  }
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
  // precision: 2 = the house itself, 1 = the street, 0 = a suburb or wider area
  async function geocodeNominatim(text, fetchImpl) {
    const q = new URLSearchParams({ format: 'jsonv2', q: text, countrycodes: 'nz', viewbox: '175.9,-38.6,178.7,-40.6',
      bounded: '1', addressdetails: '1', limit: '5' });
    const res = await getJSON(NOMINATIM + '?' + q, fetchImpl);
    return res.map(r => {
      const a = r.address || {};
      const precision = a.house_number || r.addresstype === 'building' || r.addresstype === 'house' ? 2 : (r.category === 'highway' || r.class === 'highway' || r.addresstype === 'road') ? 1 : 0;
      return { label: r.display_name, lon: Number(r.lon), lat: Number(r.lat), precision };
    });
  }
  async function geocodePhoton(text, fetchImpl) {
    const q = new URLSearchParams({ q: text, limit: '5', lat: '-39.5', lon: '176.9', bbox: '175.9,-40.6,178.7,-38.6' });
    const fc = await getJSON(PHOTON + '?' + q, fetchImpl);
    return (fc.features || []).filter(f => (f.properties || {}).countrycode === 'NZ').map(f => {
      const p = f.properties; const c = f.geometry.coordinates;
      const street = p.street || (p.osm_key === 'highway' ? p.name : '');
      const first = p.housenumber ? p.housenumber + ' ' + street : (p.name || street);
      const label = [first, p.district || p.locality, p.city, p.county].filter(Boolean).filter((v, i, arr) => arr.indexOf(v) === i).join(', ');
      return { label, lon: c[0], lat: c[1], precision: p.housenumber ? 2 : (p.osm_key === 'highway' || p.type === 'street') ? 1 : 0 };
    });
  }
  // Asks two OpenStreetMap search services and keeps the most exact matches first.
  async function geocode(text, fetchImpl) {
    const settled = await Promise.allSettled([geocodeNominatim(text, fetchImpl), geocodePhoton(text, fetchImpl)]);
    if (settled.every(r => r.status === 'rejected')) throw settled[0].reason;
    const all = [];
    for (const r of settled) if (r.status === 'fulfilled') for (const h of r.value) {
      if (!all.some(o => metres([o.lon, o.lat], [h.lon, h.lat]) < 40)) all.push(h);
    }
    return all.sort((a, b) => b.precision - a.precision).slice(0, 5);
  }
  const ll = p => p[0].toFixed(6) + ',' + p[1].toFixed(6);

  // Walk times from start to each candidate; drops candidates that snap back into the zone.
  async function rankCandidates(start, cands, polys, fetchImpl, clear) {
    const safe = p => !inZone(p, polys) && (!clear || edgeDistance(p, polys) >= clear / 2);
    try {
      const url = OSRM_FOOT + '/table/v1/driving/' + [start].concat(cands).map(ll).join(';') + '?sources=0&annotations=duration,distance';
      const t = await getJSON(url, fetchImpl);
      if (t.code !== 'Ok') throw new Error(t.code);
      return cands.map((c, i) => ({ point: t.destinations[i + 1].location, duration: t.durations[0][i + 1], distance: t.distances ? t.distances[0][i + 1] : null }))
        .filter(r => r.duration != null && safe(r.point))
        .sort((a, b) => a.duration - b.duration);
    } catch (e) {
      // table service unavailable: fall back to routing the five nearest one by one
      const out = [];
      for (const c of cands.slice(0, 5)) {
        try { const r = await route(start, c, fetchImpl); if (safe(r.end)) out.push({ point: r.end, duration: r.duration, distance: r.distance, route: r }); } catch (_) {}
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

  function bearing(a, b) {
    const toR = Math.PI / 180, y = Math.sin((b[0] - a[0]) * toR) * Math.cos(b[1] * toR);
    const x = Math.cos(a[1] * toR) * Math.sin(b[1] * toR) - Math.sin(a[1] * toR) * Math.cos(b[1] * toR) * Math.cos((b[0] - a[0]) * toR);
    return (Math.atan2(y, x) / toR + 360) % 360;
  }
  const angleGap = (x, y) => { const d = Math.abs(x - y) % 360; return d > 180 ? 360 - d : d; };

  // Up to n walking routes to different safe points, heading in clearly different directions, quickest first.
  // force: route even when the local shapes say outside (the council service said inside)
  // opts.step: how far past the zone edge each safe point sits; opts.clear: minimum metres from the edge
  async function safeRoutes(start, polys, fetchImpl, force, n, opts) {
    n = n || 3; opts = opts || {};
    if (!force && !inZone(start, polys)) return { inside: false, routes: [] };
    const cands = safeCandidates(start, polys, { max: 24, step: opts.step || 40, clear: opts.clear || 0 });
    if (!cands.length) throw new Error('Could not find a point outside the zone nearby');
    const ranked = await rankCandidates(start, cands, polys, fetchImpl, opts.clear || 0);
    if (!ranked.length) throw new Error('No walking route out of the zone was found');
    const chosen = [];
    for (const c of ranked) {
      if (chosen.length >= n) break;
      const b = bearing(start, c.point);
      if (chosen.some(o => angleGap(o.bearing, b) < 50 || metres(o.point, c.point) < 300)) continue;
      chosen.push(Object.assign({ bearing: b }, c));
    }
    const routes = [];
    for (const c of chosen) {
      try { const r = c.route || await route(start, c.point, fetchImpl); r.bearing = c.bearing; routes.push(r); } catch (_) {}
    }
    if (!routes.length) throw new Error('No walking route out of the zone was found');
    routes.sort((a, b) => a.duration - b.duration);
    return { inside: true, routes };
  }
  async function nearestSafeRoute(start, polys, fetchImpl, force) {
    const res = await safeRoutes(start, polys, fetchImpl, force, 1);
    return { inside: res.inside, best: res.routes[0] };
  }
  const compass = deg => ['north', 'north-east', 'east', 'south-east', 'south', 'south-west', 'west', 'north-west'][Math.round(deg / 45) % 8];

  const api = { polygonsFromGeoJSON, inZone, edgeDistance, serverInZone, metres, safeCandidates, loadZone, geocode, nearestSafeRoute, safeRoutes, compass, route, ZONE_LAYER };
  if (typeof module !== 'undefined') module.exports = api; else root.SafeRoute = api;
})(typeof window !== 'undefined' ? window : globalThis);
