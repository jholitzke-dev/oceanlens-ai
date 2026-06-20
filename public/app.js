const $ = (selector) => document.querySelector(selector);

const places = {
  "monterey bay": { name: "Monterey Bay", lat: 36.72, lon: -122.08 },
  "great barrier reef": { name: "Great Barrier Reef", lat: -18.29, lon: 147.70 },
  "north atlantic": { name: "North Atlantic", lat: 45, lon: -35 },
  "arabian sea": { name: "Arabian Sea", lat: 15, lon: 65 },
  "southern ocean": { name: "Southern Ocean", lat: -56, lon: 70 },
  "mediterranean sea": { name: "Mediterranean Sea", lat: 35.5, lon: 18 },
  "indian ocean": { name: "Indian Ocean", lat: -15, lon: 80 },
  "south atlantic": { name: "South Atlantic", lat: -25, lon: -20 },
  "north pacific": { name: "North Pacific", lat: 30, lon: -160 }
};

const state = {
  stations: [], observations: [], globalPlatforms: [], nearbyPlatforms: [], depthProfile: null,
  center: places["monterey bay"], mapScale: 1, map: null, mapLayers: null, selectionVersion: 0,
  selectedPlatformId: null, selectedOutlierId: null, anomalyOutliers: [],
  platformFilter: "all", latestBundle: null,
  watches: JSON.parse(localStorage.getItem("oceanlens-watches") || "[]")
};

async function api(path, options) {
  const response = await fetch(path, options);
  if (!response.ok) throw new Error(`Request failed: ${response.status}`);
  return response.json();
}

function formatTime(date) {
  return new Intl.DateTimeFormat("en", { hour: "numeric", minute: "2-digit" }).format(new Date(date));
}

function platformQuality(platform) {
  const ageHours = platform.observedAt ? (Date.now() - new Date(platform.observedAt)) / 3_600_000 : Infinity;
  if (ageHours <= 24 && platform.live) return { label: `fresh · ${ageHours.toFixed(1)}h`, className: "good" };
  if (ageHours <= 24 * 7) return { label: `recent · ${(ageHours / 24).toFixed(1)}d`, className: "limited" };
  return { label: platform.observedAt ? `stale · ${(ageHours / 24).toFixed(0)}d` : "freshness unknown", className: "stale" };
}

function platformVisible(platform) {
  if (state.platformFilter === "underwater") return Boolean(platform.underwater);
  if (state.platformFilter === "surface") return !platform.underwater && platform.live;
  return true;
}

function parseLocation(value) {
  const clean = value.trim();
  const known = places[clean.toLowerCase()];
  if (known) return known;
  const match = clean.match(/^(-?\d+(?:\.\d+)?)\s*[, ]\s*(-?\d+(?:\.\d+)?)$/);
  if (!match) throw new Error("Use a listed region or enter latitude, longitude.");
  const lat = Number(match[1]), lon = Number(match[2]);
  if (lat < -90 || lat > 90 || lon < -180 || lon > 180) throw new Error("Coordinates are outside the valid range.");
  return { name: `${lat.toFixed(2)}°, ${lon.toFixed(2)}°`, lat, lon };
}

function setupCanvas(canvas) {
  const rect = canvas.getBoundingClientRect();
  const ratio = window.devicePixelRatio || 1;
  canvas.width = rect.width * ratio; canvas.height = rect.height * ratio;
  const context = canvas.getContext("2d");
  context.scale(ratio, ratio);
  return { context, width: rect.width, height: rect.height };
}

function ensureMap() {
  if (state.map) return;
  const L = window.L;
  if (!L) {
    $("#geoMap").innerHTML = '<div class="empty-coverage">The geographic map library could not load.</div>';
    return;
  }
  const street = L.tileLayer("https://tile.openstreetmap.org/{z}/{x}/{y}.png", {
    maxZoom: 18,
    attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a>'
  });
  const satellite = L.tileLayer(
    "https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}",
    { maxZoom: 18, attribution: "Imagery &copy; Esri and contributors" }
  );
  const platforms = L.layerGroup();
  const selection = L.layerGroup();
  const anomalies = L.layerGroup();
  state.map = L.map("geoMap", {
    center: [state.center.lat, state.center.lon],
    zoom: 3,
    minZoom: 2,
    maxZoom: 12,
    worldCopyJump: true,
    layers: [satellite, platforms, anomalies, selection]
  });
  state.mapLayers = { street, satellite, platforms, anomalies, selection };
  L.control.scale({ imperial: false }).addTo(state.map);
  state.map.on("mousemove", ({ latlng }) => {
    $("#coordinateReadout").textContent = `${latlng.lat.toFixed(3)}°, ${latlng.lng.toFixed(3)}°`;
  });
  state.map.on("click", ({ latlng }) => {
    state.selectedPlatformId = null;
    state.selectedOutlierId = null;
    explore({ name: `${latlng.lat.toFixed(2)}°, ${latlng.lng.toFixed(2)}°`, lat: latlng.lat, lon: latlng.lng });
  });
}

function drawMap() {
  ensureMap();
  if (!state.map) return;
  const L = window.L;
  const { platforms, selection, anomalies } = state.mapLayers;
  platforms.clearLayers();
  selection.clearLayers();
  anomalies.clearLayers();
  const nearbyIds = new Set(state.nearbyPlatforms.map((platform) => platform.id));
  let selectedMarker = null;
  state.globalPlatforms.filter(platformVisible).forEach((platform) => {
    const nearby = nearbyIds.has(platform.id);
    const selected = state.selectedPlatformId === platform.id;
    const nearbyReading = state.nearbyPlatforms.find((item) => item.id === platform.id);
    const marker = L.marker([platform.latitude, platform.longitude], {
      bubblingMouseEvents: false,
      icon: L.divIcon({
        className: "",
        html: `<div class="platform-dot ${platform.underwater ? "underwater" : ""} ${nearby ? "nearby" : ""} ${selected ? "selected" : ""}"></div>`,
        iconSize: nearby || selected ? [15, 15] : [11, 11],
        iconAnchor: nearby || selected ? [7, 7] : [5, 5]
      })
    });
    marker.bindTooltip(`<strong>${platform.name}</strong><br>${platform.type} · ${platform.provider}<br>Depth capability: ${platform.maxDepthM.toLocaleString()} m`);
    const live = platform.live && platform.measurements;
    const quality = platformQuality(platform);
    const measurementRows = live ? [
      ["Observed", new Date(platform.observedAt).toLocaleString()],
      ["Water temp", platform.measurements.waterTemperatureC == null ? null : `${platform.measurements.waterTemperatureC}°C`],
      ["Salinity", platform.measurements.salinity == null ? null : `${platform.measurements.salinity} PSU`],
      ["Dissolved oxygen", platform.measurements.dissolvedOxygen == null ? null : `${platform.measurements.dissolvedOxygen}`],
      ["Chlorophyll", platform.measurements.chlorophyll == null ? null : `${platform.measurements.chlorophyll}`],
      ["Wave height", platform.measurements.waveHeightM == null ? null : `${platform.measurements.waveHeightM} m`],
      ["Wind", platform.measurements.windSpeedMs == null ? null : `${platform.measurements.windSpeedMs} m/s`],
      ["Pressure", platform.measurements.pressureHpa == null
        ? platform.measurements.pressure == null ? null : `${platform.measurements.pressure}`
        : `${platform.measurements.pressureHpa} hPa`]
    ].filter(([, value]) => value != null) : [];
    marker.bindPopup(`
      <div class="platform-popup">
        <span class="type">${platform.type}</span>
        <h3>${platform.name}</h3>
        <dl>
          <dt>Provider</dt><dd>${platform.provider}</dd>
          <dt>Position</dt><dd>${platform.latitude.toFixed(2)}°, ${platform.longitude.toFixed(2)}°</dd>
          <dt>Depth</dt><dd>${platform.maxDepthM ? `${platform.maxDepthM.toLocaleString()} m capability` : "Surface platform"}</dd>
          <dt>Status</dt><dd>${platform.status}</dd>
          ${nearbyReading ? `<dt>Distance</dt><dd>${nearbyReading.distanceKm.toLocaleString()} km from prior search point</dd>` : ""}
        </dl>
        ${live ? `<div class="live-reading"><strong>${platform.status === "live" ? "LIVE" : "STALE"} ${platform.network || platform.provider} OBSERVATION</strong><dl>${measurementRows.map(([label, value]) => `<dt>${label}</dt><dd>${value}</dd>`).join("")}</dl></div>` : ""}
        <span class="quality-badge ${quality.className}">${quality.label}</span>
        <div class="selected-note">This platform is now the analysis location.</div>
      </div>`);
    marker.on("click", (event) => {
      if (event.originalEvent) L.DomEvent.stopPropagation(event.originalEvent);
      state.selectedPlatformId = platform.id;
      state.selectedOutlierId = null;
      explore({
        name: platform.name,
        lat: platform.latitude,
        lon: platform.longitude
      });
    });
    marker.addTo(platforms);
    if (selected) selectedMarker = marker;
  });
  state.anomalyOutliers.forEach((outlier, outlierIndex) => {
    const markerSize = outlier.severity === "extreme" ? 23 : 18;
    L.circle([outlier.latitude, outlier.longitude], {
      radius: outlier.severity === "extreme" ? 120000 : 80000,
      color: outlier.severity === "extreme" ? "#ff3b30" : "#ff9d68",
      weight: 1.5,
      fillColor: "#ff6f4d",
      fillOpacity: .12
    }).addTo(anomalies);
    const marker = L.marker([outlier.latitude, outlier.longitude], {
      bubblingMouseEvents: false,
      icon: L.divIcon({
        className: "",
        html: `<div class="anomaly-marker ${outlier.severity}"></div>`,
        iconSize: [markerSize, markerSize],
        iconAnchor: [markerSize / 2, markerSize / 2]
      })
    });
    marker.bindPopup(`
      <div class="platform-popup anomaly-popup">
        <span class="severity">${outlier.severity.toUpperCase()} REGIONAL OUTLIER</span>
        <h3>Regional ${outlier.metric.toLowerCase()} outlier detected</h3>
        <p><strong>${outlier.value} ${outlier.unit}</strong></p>
        <p>Robust anomaly score ${Math.abs(outlier.zScore).toFixed(1)}; the reading is ${outlier.direction === "high" ? "above" : "below"} the regional median of ${outlier.regionalMedian} ${outlier.unit}.</p>
        <p>${outlier.comparison}.</p>
        <div id="outlierHistory${outlierIndex}" class="outlier-history"><strong>Station history</strong><p>Loading this station's own history…</p></div>
        <p><strong>${outlier.name}</strong><br>${new Date(outlier.observedAt).toLocaleString()} · ${outlier.provider}</p>
        <p class="anomaly-caveat">This is a real surface-observation outlier, not a confirmed hazard or deep-water anomaly.</p>
      </div>`);
    marker.on("popupopen", async () => {
      const container = document.getElementById(`outlierHistory${outlierIndex}`);
      if (!container || container.dataset.loaded) return;
      try {
        const comparison = await api(`/api/oceanlens/outlier-history?outlierId=${encodeURIComponent(outlier.id)}&historyHours=${$("#historyWindow").value}`);
        const history = comparison.stationHistory;
        container.classList.toggle("agrees", Boolean(history.available && history.unusual));
        container.classList.toggle("differs", Boolean(history.available && !history.unusual));
        container.innerHTML = history.available
          ? `<strong>${history.unusual ? "Both tests agree" : "Regional outlier only"}</strong><p>${history.message}</p><p>${history.latest} ${outlier.unit} vs station average ${history.average} ${outlier.unit} · ${history.sampleCount} readings</p>`
          : `<strong>Station-history comparison unavailable</strong><p>${history.message}</p>`;
        container.dataset.loaded = "true";
      } catch {
        container.innerHTML = "<strong>Station-history comparison unavailable</strong><p>The historical feed could not be loaded.</p>";
      }
    });
    marker.on("click", (event) => {
      if (event.originalEvent) L.DomEvent.stopPropagation(event.originalEvent);
      state.selectedPlatformId = outlier.platformId;
      state.selectedOutlierId = outlier.id;
      explore({ name: outlier.name, lat: outlier.latitude, lon: outlier.longitude });
    });
    marker.addTo(anomalies);
  });
  L.circle([state.center.lat, state.center.lon], {
    radius: Number($("#radiusSelect").value) * 1000,
    color: "#5fe0cc",
    weight: 1,
    fillColor: "#5fe0cc",
    fillOpacity: .05,
    dashArray: "5 7"
  }).addTo(selection);
  L.marker([state.center.lat, state.center.lon], {
    icon: L.divIcon({ className: "", html: '<div class="search-marker"></div>', iconSize: [22,22], iconAnchor: [11,11] })
  }).bindTooltip(`<strong>${state.center.name}</strong><br>Selected analysis point`).addTo(selection);
  const radius = Number($("#radiusSelect").value);
  const zoom = radius <= 500 ? 5 : radius <= 1200 ? 4 : radius <= 2500 ? 3 : 2;
  state.map.flyTo([state.center.lat, state.center.lon], zoom, { duration: .65 });
  if (selectedMarker) {
    window.setTimeout(() => selectedMarker.openPopup(), 700);
  }
  $("#coordinateReadout").textContent = `${state.center.lat.toFixed(2)}°, ${state.center.lon.toFixed(2)}°`;
}

async function updateLiveStatus(forceSync = false) {
  const button = $("#liveStatus");
  button.classList.add("syncing");
  button.innerHTML = "<i></i> Syncing NOAA…";
  try {
    if (forceSync) await api("/api/live/sync", { method: "POST" });
    const status = await api("/api/live/status");
    const noaa = status.noaaNdbc;
    const ioos = status.ioosGliders;
    const total = (noaa.freshStationCount || 0) + (ioos.datasetCount || 0);
    button.classList.toggle("offline", noaa.status === "offline" && ioos.status === "offline");
    button.title = `NOAA feed: ${noaa.status}, ${noaa.freshStationCount || 0}/${noaa.stationCount} fresh stations · IOOS: ${ioos.status}, ${ioos.datasetCount} gliders · OOI direct: ${status.ooi.status}`;
    button.innerHTML = `<i></i> ${total} live platforms`;
    $("#noaaProviderStatus").textContent = `${noaa.status} · ${noaa.freshStationCount || 0} fresh / ${noaa.stationCount} feed`;
    $("#ioosProviderStatus").textContent = `${ioos.status} · ${ioos.datasetCount} gliders`;
    $("#ooiRelayStatus").textContent = `${ioos.status} via IOOS`;
    $("#ooiDirectStatus").textContent = status.ooi.status.replaceAll("-", " ");
    if (forceSync && total) await explore(state.center);
  } catch {
    button.classList.add("offline");
    button.innerHTML = "<i></i> NOAA offline";
  } finally {
    button.classList.remove("syncing");
  }
}

function drawChart() {
  if (!state.observations.length || !state.timeSeries?.series?.length) return;
  const { context: ctx, width, height } = setupCanvas($("#chartCanvas"));
  const padding = { top: 18, right: 24, bottom: 28, left: 34 };
  const plotW = width - padding.left - padding.right, plotH = height - padding.top - padding.bottom;
  ctx.clearRect(0, 0, width, height); ctx.strokeStyle = "rgba(160,211,208,.08)";
  for (let i = 0; i <= 4; i++) {
    const y = padding.top + (plotH / 4) * i;
    ctx.beginPath(); ctx.moveTo(padding.left, y); ctx.lineTo(width - padding.right, y); ctx.stroke();
  }
  state.timeSeries.series.forEach(({ key, color }) => {
    const values = state.observations.map((row) => row[key]).filter(Number.isFinite);
    if (values.length < 2) return;
    const min = Math.min(...values), max = Math.max(...values);
    ctx.beginPath();
    let plotted = 0;
    state.observations.forEach((row, index) => {
      const value = row[key];
      if (!Number.isFinite(value)) return;
      const x = padding.left + (index / (state.observations.length - 1)) * plotW;
      const y = padding.top + plotH - ((value - min) / ((max - min) || 1)) * plotH;
      plotted++ ? ctx.lineTo(x, y) : ctx.moveTo(x, y);
    });
    ctx.strokeStyle = color; ctx.lineWidth = 1.5; ctx.stroke();
  });
}

function renderTimeSeries(series) {
  state.timeSeries = series;
  state.observations = series.points || [];
  $("#seriesTitle").textContent = series.location.name;
  $("#seriesLocation").textContent = `${series.location.latitude.toFixed(2)}°, ${series.location.longitude.toFixed(2)}°`;
  $("#seriesProvenance").classList.toggle("live-anchor", series.available);
  $("#seriesProvenance").textContent = series.available
    ? `${series.source} · REAL ${series.profileMode ? "DEPTH PROFILE" : "TIME SERIES"}`
    : "NO REAL OBSERVATION SERIES SELECTED";
  $("#chartLegend").innerHTML = series.available
    ? series.series.map((item) => `<span><i style="background:${item.color}"></i> ${item.label} (${item.unit})</span>`).join("")
    : "";
  const canvas = $("#chartCanvas");
  canvas.style.display = series.available ? "block" : "none";
  let empty = $("#seriesUnavailable");
  if (!empty) {
    empty = document.createElement("div");
    empty.id = "seriesUnavailable";
    empty.className = "unavailable-state";
    canvas.before(empty);
  }
  empty.style.display = series.available ? "none" : "grid";
  empty.innerHTML = `<div><strong>No real time series available</strong>${series.message}</div>`;
  drawChart();
}

function drawDepthProfile() {
  if (!state.depthProfile?.available) return;
  const { context: ctx, width, height } = setupCanvas($("#depthCanvas"));
  const padding = { top: 24, right: 32, bottom: 30, left: 62 };
  const plotW = width - padding.left - padding.right;
  const plotH = height - padding.top - padding.bottom;
  const samples = state.depthProfile.samples;
  ctx.clearRect(0, 0, width, height);
  ctx.font = "8px DM Mono";
  for (let index = 0; index <= 5; index += 1) {
    const depth = (index / 5) * state.depthProfile.maxDepthM;
    const y = padding.top + (index / 5) * plotH;
    ctx.strokeStyle = "rgba(160,211,208,.10)";
    ctx.beginPath(); ctx.moveTo(padding.left, y); ctx.lineTo(width - padding.right, y); ctx.stroke();
    ctx.fillStyle = "#6d8c90"; ctx.fillText(`${Math.round(depth).toLocaleString()}m`, 12, y + 3);
  }
  const anomalyGradient = ctx.createLinearGradient(padding.left, 0, width - padding.right, 0);
  anomalyGradient.addColorStop(0, "rgba(255,157,104,.2)");
  anomalyGradient.addColorStop(1, "#ff9d68");
  ctx.beginPath();
  samples.forEach((sample, index) => {
    const x = padding.left + sample.anomalyScore * plotW;
    const y = padding.top + (sample.depthM / state.depthProfile.maxDepthM) * plotH;
    index ? ctx.lineTo(x, y) : ctx.moveTo(x, y);
  });
  ctx.strokeStyle = anomalyGradient; ctx.lineWidth = 2.2; ctx.stroke();
  ctx.lineTo(padding.left, padding.top + plotH); ctx.lineTo(padding.left, padding.top); ctx.closePath();
  ctx.fillStyle = "rgba(255,157,104,.08)"; ctx.fill();
  const peak = samples.reduce((best, sample) => sample.anomalyScore > best.anomalyScore ? sample : best);
  const peakX = padding.left + peak.anomalyScore * plotW;
  const peakY = padding.top + (peak.depthM / state.depthProfile.maxDepthM) * plotH;
  ctx.beginPath(); ctx.arc(peakX, peakY, 5, 0, Math.PI * 2);
  ctx.fillStyle = "#ff9d68"; ctx.shadowColor = "#ff9d68"; ctx.shadowBlur = 14; ctx.fill(); ctx.shadowBlur = 0;
  ctx.fillStyle = "#78979a"; ctx.fillText("LOW ANOMALY", padding.left, height - 9);
  ctx.fillText("HIGH ANOMALY", width - padding.right - 70, height - 9);
  state.depthPoints = samples.map((sample) => ({
    sample,
    x: padding.left + sample.anomalyScore * plotW,
    y: padding.top + (sample.depthM / state.depthProfile.maxDepthM) * plotH
  }));
}

function renderDepthProfile(profile) {
  state.depthProfile = profile;
  $("#depthTitle").textContent = profile.available ? state.center.name : `No depth feed · ${state.center.name}`;
  $("#depthLocation").textContent = `${profile.location.latitude.toFixed(2)}°, ${profile.location.longitude.toFixed(2)}°`;
  $("#depthProvenance").classList.remove("live-anchor");
  $("#depthProvenance").textContent = "NO SIMULATED DEPTH DATA · REAL OBSERVATIONS ONLY";
  const finding = $("#depthFinding");
  finding.classList.remove("skeleton");
  if (!profile.available) {
    $("#depthCanvas").style.display = "none";
    finding.innerHTML = `<div class="unavailable-state"><div><strong>No real depth profile available</strong>${profile.message}<br><br>Connect: ${profile.requiredSources.join(", ")}.</div></div>`;
    $("#methodList").innerHTML = "";
    return;
  }
  $("#depthCanvas").style.display = "block";
  finding.innerHTML = `
    <span class="depth-number">${profile.anomaly.depthM.toLocaleString()} m</span>
    <h3>${profile.anomaly.severity === "watch" ? "Within-profile departure detected" : "No strong within-profile departure"}</h3>
    <p>${profile.anomaly.plainLanguage}</p>
    <details>
      <summary>What does this mean?</summary>
      <ul>${profile.anomaly.measurements.map((item) => `<li>${item}</li>`).join("")}</ul>
      <p><strong>Possible explanations:</strong> ${profile.anomaly.possibleInterpretations.join("; ")}.</p>
      <p class="anomaly-caveat">${profile.anomaly.notConfirmed}</p>
    </details>`;
  $("#methodList").innerHTML = profile.methods.map((method) => `
    <div class="method ${method.available ? "" : "unavailable"}">
      <strong>${method.name}</strong><span>${method.range}</span><small>${method.role}</small>
    </div>`).join("");
  drawDepthProfile();
}

function setAnalysisLoading() {
  $("#primaryInsight").classList.add("skeleton");
  $("#analysisStatus").classList.add("loading");
  $("#analysisStatus").textContent = "ANALYZING";
}

function renderLocationInsights(insights) {
  const primary = $("#primaryInsight");
  primary.classList.remove("skeleton");
  $("#analysisStatus").classList.remove("loading");
  $("#analysisStatus").textContent = new Intl.DateTimeFormat("en", {
    hour: "numeric", minute: "2-digit", second: "2-digit"
  }).format(new Date(insights.generatedAt));
  $("#analysisTitle").textContent = insights.location.name;
  if (!insights.available) {
    primary.innerHTML = `<div class="unavailable-state"><div><strong>No evidence-based analysis available</strong>${insights.message}</div></div>`;
    $("#patternList").innerHTML = "";
    return;
  }
  primary.innerHTML = `
    <div class="alert-row">
      <span class="severity">${insights.primary.severity.toUpperCase()}</span>
      <span class="zscore">OBSERVED</span>
    </div>
    <h3>${insights.primary.title}</h3>
    <p class="baseline-label">${insights.primary.baseline || "Observation comparison"}</p>
    <p>${insights.primary.plainLanguage}</p>
    <div class="anomaly-explainer">
      <h4>${insights.primary.flagged ? "WHY IT WAS FLAGGED" : "CURRENT OBSERVATIONS"}</h4>
      <ul>${insights.primary.measurements.map((item) => `<li>${item}</li>`).join("")}</ul>
      <p class="anomaly-caveat">${insights.primary.notConfirmed}</p>
    </div>`;
  $("#patternList").innerHTML = insights.patterns.map((pattern) => `
    <div class="pattern">
      <div class="pattern-top"><span>${pattern.title}</span></div>
      <p>${pattern.description}</p>
    </div>`).join("");
}

function renderPlatforms(result) {
  state.nearbyPlatforms = result.nearby;
  $("#coverageBadge").textContent = result.coverage;
  const filteredNearby = result.nearby.filter(platformVisible);
  const filteredNearest = result.nearest.filter(platformVisible);
  const shown = filteredNearby.length ? filteredNearby.slice(0, 5) : filteredNearest.slice(0, 3);
  const gap = filteredNearby.length
    ? ""
    : `<div class="empty-coverage">${result.nearby.length ? "No nearby platforms match this filter." : "Coverage gap detected."} Showing the nearest matching platforms.</div>`;
  $("#stationList").innerHTML = gap + shown.map((platform) => {
    const quality = platformQuality(platform);
    return `
    <button class="station platform" type="button" data-platform-id="${platform.id}">
      <span class="platform-icon">${platform.type === "argo" ? "↕" : platform.type === "glider" ? "➤" : "●"}</span>
      <strong>${platform.name}</strong><span class="station-status">${platform.type}</span>
      <small>${platform.provider} · ${platform.distanceKm.toLocaleString()} km away${platform.maxDepthM ? ` · ${platform.maxDepthM}m` : ""}<br><span class="quality-badge ${quality.className}">${quality.label}</span></small>
    </button>`;
  }).join("");
}

function recordFields(record, fields) {
  if (!record) return '<p class="missing">No real record available.</p>';
  return `<dl>${fields.map(([key, label, formatter]) => {
    const value = record[key];
    const display = value === null || value === undefined
      ? '<span class="missing">not reported</span>'
      : formatter ? formatter(value) : String(value);
    return `<dt>${label}</dt><dd>${display}</dd>`;
  }).join("")}</dl>`;
}

function renderPointData(data) {
  $("#dataTitle").textContent = `${data.query.latitude.toFixed(2)}°, ${data.query.longitude.toFixed(2)}°`;
  $("#matchStatus").textContent = data.best_match ? "VALID MATCH" : "NO VALID MATCH";
  $("#sensorRecord").innerHTML = recordFields(data.latest_sensor, [
    ["sensor_id", "Sensor ID"],
    ["timestamp", "Timestamp", (value) => new Date(value).toLocaleString()],
    ["depth_meters", "Depth", (value) => `${value} m`],
    ["temperature", "Temperature", (value) => `${value}°C`],
    ["salinity", "Salinity"],
    ["turbidity", "Turbidity"],
    ["chlorophyll", "Chlorophyll"],
    ["dissolved_oxygen", "Dissolved oxygen"],
    ["pH", "pH"],
    ["blue_light_reading", "Blue light"],
    ["green_light_reading", "Green light"],
    ["red_light_reading", "Red light"],
    ["pressure", "Pressure", (value) => `${value} hPa`],
    ["current_speed", "Current speed"],
    ["source", "Source"]
  ]);
  $("#satelliteRecord").innerHTML = recordFields(data.latest_satellite, [
    ["satellite_source", "Source"],
    ["image_date", "Image date", (value) => new Date(value).toLocaleString()],
    ["cloud_cover", "Cloud cover"],
    ["blue_band_value", "Blue band"],
    ["green_band_value", "Green band"],
    ["red_band_value", "Red band"],
    ["nir_band_value", "NIR band"],
    ["swir_band_value", "SWIR band"],
    ["blue_green_ratio", "Blue/green ratio"],
    ["depth_index", "Depth index"],
    ["turbidity_index", "Turbidity index"],
    ["image_url", "Image URL"]
  ]);
  $("#matchRecord").innerHTML = data.best_match
    ? recordFields(data.best_match, [
        ["time_difference_hours", "Time difference", (value) => `${value} hours`],
        ["spatial_difference_km", "Spatial difference", (value) => `${value} km`]
      ])
    : `<p class="missing">${data.notice}</p><p>${data.counts.sensor_records} sensor records and ${data.counts.satellite_records} analytical scenes in the search window.</p><p>A valid pair must be within ${data.query.matchRadiusKm} km and ${data.query.matchHours} hours.</p>`;
}

function unavailableFeature(message) {
  return `<p class="feature-missing">${message}</p>`;
}

function renderAiSuite(ai) {
  if (ai.error || !ai.pattern_finder) {
    const message = ai.error || "AI evidence could not be evaluated.";
    ["patternFinder", "depthPredictor", "anomalyAlerts", "satelliteConfidence", "trendDashboard"]
      .forEach((id) => $(`#${id}`).innerHTML = unavailableFeature(message));
    return;
  }
  $("#aiSuiteLocation").textContent = `${ai.location.latitude.toFixed(2)}°, ${ai.location.longitude.toFixed(2)}°`;
  $("#patternFinder").innerHTML = ai.pattern_finder.available
    ? `<strong>${ai.pattern_finder.matched_pair_count} matched pairs</strong><ul class="feature-list">${ai.pattern_finder.patterns.map((pattern) => `<li>${pattern.name}: ${pattern.available ? `r = ${pattern.correlation} (${pattern.sample_count} samples)` : "insufficient evidence"}</li>`).join("")}</ul>`
    : unavailableFeature(ai.pattern_finder.message);
  $("#depthPredictor").innerHTML = ai.depth_predictor.available
    ? `<span class="score">${ai.depth_predictor.estimated_depth_meters} m</span><p>R² ${ai.depth_predictor.r_squared} from ${ai.depth_predictor.sample_count} real matches.</p><p>${ai.depth_predictor.warning}</p>`
    : unavailableFeature(`${ai.depth_predictor.message} Current evidence: ${ai.depth_predictor.sample_count}/${ai.depth_predictor.required}.`);
  $("#anomalyAlerts").innerHTML = ai.anomaly_alerts.available
    ? `<strong>${ai.anomaly_alerts.alert ? "Statistical alert detected" : "No statistical alert"}</strong><p class="baseline-label">${ai.anomaly_alerts.baseline}</p><p>${ai.anomaly_alerts.message}</p>`
    : unavailableFeature(ai.anomaly_alerts.message);
  $("#satelliteConfidence").innerHTML = ai.satellite_confidence.available
    ? `<span class="score">${ai.satellite_confidence.score}%</span><ul class="feature-list">${ai.satellite_confidence.factors.map((factor) => `<li>${factor.name}: ${factor.score}% — ${factor.reason}</li>`).join("")}</ul>`
    : unavailableFeature(ai.satellite_confidence.message);
  $("#trendDashboard").innerHTML = ai.trends.available
    ? `${ai.trends.series.map((trend) => `<div class="trend-row"><span>${trend.metric}</span><strong>${trend.current} ${trend.unit}</strong><span>recent avg ${trend.average}</span></div>`).join("")}<p class="feature-missing">Unavailable: ${ai.trends.unavailable.join(", ")}.</p>`
    : unavailableFeature("Select a live station with real historical observations.");
}

function sceneSummary(layer) {
  if (!layer.available || !layer.scene) return unavailableFeature("No recent scene found.");
  const scene = layer.scene;
  return `<strong>${scene.product_type}</strong>
    <p>${new Date(scene.acquired_at).toLocaleString()}${Number.isFinite(scene.cloud_cover) ? ` · ${scene.cloud_cover.toFixed(1)}% cloud` : ""}</p>
    <p class="baseline-label">Potential uses after imagery processing</p>
    <ul class="capability-list">${layer.can_assess.map((item) => `<li>${item}</li>`).join("")}</ul>
    <p class="feature-missing">${layer.limitation}</p>`;
}

function renderLayerStrategy(strategy) {
  const selected = strategy.decision.selected;
  $("#strategyDecision").textContent = selected.toUpperCase();
  $("#strategySummary").innerHTML = `<span class="strategy-choice">${selected}</span><p>${strategy.decision.reason}</p><p class="feature-missing">Catalogue recommendation only; satellite pixels and spectral bands have not been analyzed.</p><p>Underwater sensors remain authoritative below the surface.</p>`;
  $("#opticalStrategy").innerHTML = sceneSummary(strategy.optical);
  $("#sarStrategy").innerHTML = sceneSummary(strategy.sar);
  const sensorLayer = strategy.underwater;
  $("#sensorLayerLabel").textContent = sensorLayer.platform_type === "surface"
    ? "BUOY / SURFACE STATION"
    : sensorLayer.platform_type === "underwater"
      ? "UNDERWATER SENSOR"
      : "SENSOR PLATFORM";
  $("#underwaterStrategy").innerHTML = sensorLayer.available
    ? `<strong>Source: ${sensorLayer.source}</strong>
       <p>Depth profile: ${sensorLayer.depth_profile_available ? `available to ${sensorLayer.max_depth_m.toFixed(1)} m` : "unavailable"}</p>
       <p>${sensorLayer.role}</p>`
    : unavailableFeature(sensorLayer.role);
}

async function loadAnomalyMap() {
  const data = await api("/api/oceanlens/anomaly-map");
  state.anomalyOutliers = data.outliers;
  $("#anomalyCount").textContent = data.count;
  updateWatchStatus();
  if (state.map) drawMap();
}

async function explore(location) {
  const selectionVersion = ++state.selectionVersion;
  state.center = location;
  $("#locationTitle").textContent = location.name; $("#locationInput").value = location.name;
  $("#coverageBadge").textContent = "Searching…";
  $("#seriesLocation").textContent = "LOADING…";
  $("#depthLocation").textContent = "LOADING…";
  $("#depthFinding").classList.add("skeleton");
  setAnalysisLoading();
  const query = new URLSearchParams({
    lat: location.lat,
    lon: location.lon,
    radiusKm: $("#radiusSelect").value,
    maxDepthM: $("#depthSelect").value,
    historyHours: $("#historyWindow").value,
    name: location.name,
    ...(state.selectedPlatformId ? { platformId: state.selectedPlatformId } : {}),
    ...(state.selectedOutlierId ? { outlierId: state.selectedOutlierId } : {})
  });
  const [platforms, profile, insights, series, pointData, oceanLensAi, layerStrategy] = await Promise.all([
    api(`/api/global/platforms?${query}`),
    api(`/api/depth-profile?${query}`),
    api(`/api/location-insights?${query}`),
    api(`/api/location-timeseries?${query}`),
    api(`/api/oceanlens/point?lat=${location.lat}&lon=${location.lon}&radiusKm=25&hours=72${state.selectedPlatformId ? `&platformId=${encodeURIComponent(state.selectedPlatformId)}` : ""}`),
    api(`/api/oceanlens/ai?lat=${location.lat}&lon=${location.lon}&historyHours=${$("#historyWindow").value}${state.selectedPlatformId ? `&platformId=${encodeURIComponent(state.selectedPlatformId)}` : ""}`),
    api(`/api/oceanlens/layer-strategy?lat=${location.lat}&lon=${location.lon}${state.selectedPlatformId ? `&platformId=${encodeURIComponent(state.selectedPlatformId)}` : ""}`)
  ]);
  if (selectionVersion !== state.selectionVersion) return;
  state.globalPlatforms = platforms.platforms;
  renderPlatforms(platforms);
  renderDepthProfile(profile);
  renderLocationInsights(insights);
  renderTimeSeries(series);
  renderPointData(pointData);
  renderAiSuite(oceanLensAi);
  renderLayerStrategy(layerStrategy);
  state.latestBundle = { location, platforms, profile, insights, series, pointData, oceanLensAi, layerStrategy };
  updateWatchStatus();
  drawMap();
}

function nearestUnderwaterPlatform() {
  return state.globalPlatforms
    .filter((platform) => platform.underwater && platform.profileAvailable)
    .map((platform) => ({
      platform,
      distance: 2 * 6371 * Math.asin(Math.sqrt(
        Math.sin((platform.latitude - state.center.lat) * Math.PI / 360) ** 2
        + Math.cos(state.center.lat * Math.PI / 180)
        * Math.cos(platform.latitude * Math.PI / 180)
        * Math.sin((platform.longitude - state.center.lon) * Math.PI / 360) ** 2
      ))
    }))
    .sort((a, b) => a.distance - b.distance)[0]?.platform || null;
}

function downloadFile(name, content, type) {
  const blob = new Blob([content], { type });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = name;
  anchor.click();
  URL.revokeObjectURL(url);
}

function csvEscape(value) {
  if (value === null || value === undefined) return "";
  const text = typeof value === "object" ? JSON.stringify(value) : String(value);
  return `"${text.replaceAll('"', '""')}"`;
}

function exportCurrent(format) {
  if (!state.latestBundle) return;
  const stamp = new Date().toISOString().replaceAll(":", "-");
  if (format === "json") {
    downloadFile(`oceanlens-${stamp}.json`, JSON.stringify(state.latestBundle, null, 2), "application/json");
    return;
  }
  const records = state.latestBundle.series?.points || [];
  if (!records.length) {
    downloadFile(`oceanlens-observations-${stamp}.csv`, "message\nNo observation series available", "text/csv");
    return;
  }
  const keys = [...new Set(records.flatMap((record) => Object.keys(record)))];
  const csv = [keys.map(csvEscape).join(","), ...records.map((record) => keys.map((key) => csvEscape(record[key])).join(","))].join("\n");
  downloadFile(`oceanlens-observations-${stamp}.csv`, csv, "text/csv");
}

function watchKey() {
  return state.selectedPlatformId || `${state.center.lat.toFixed(3)},${state.center.lon.toFixed(3)}`;
}

function updateWatchStatus() {
  const active = state.watches.some((watch) => watch.key === watchKey());
  $("#watchPoint").classList.toggle("active", active);
  $("#watchPoint").textContent = active ? "Watching selected point" : "Watch selected point";
  const triggered = state.watches.filter((watch) =>
    state.anomalyOutliers.some((outlier) => outlier.platformId === watch.platformId && ["major", "extreme"].includes(outlier.severity))
  ).length;
  $("#watchStatus").textContent = `${state.watches.length} local watches${triggered ? ` · ${triggered} triggered` : ""}`;
}

function toggleWatch() {
  const key = watchKey();
  const index = state.watches.findIndex((watch) => watch.key === key);
  if (index >= 0) state.watches.splice(index, 1);
  else state.watches.push({
    key,
    platformId: state.selectedPlatformId,
    name: state.center.name,
    latitude: state.center.lat,
    longitude: state.center.lon,
    threshold: "major-or-extreme",
    createdAt: new Date().toISOString()
  });
  localStorage.setItem("oceanlens-watches", JSON.stringify(state.watches));
  updateWatchStatus();
}

async function init() {
  try {
    const overview = await api("/api/overview");
    $("#stationCount").textContent = overview.freshPlatformCount.toLocaleString();
    $("#onlineCount").textContent = "NOAA + IOOS + OOI";
    $("#readings24h").textContent = overview.underwaterPlatformCount.toLocaleString();
    $("#avgTemperature").textContent = overview.underwaterObservationCount.toLocaleString();
    $("#avgOxygen").textContent = overview.surfaceStationCount.toLocaleString();
    $("#syncTime").textContent = formatTime(overview.generatedAt);
    await Promise.all([explore(state.center), loadAnomalyMap()]);
    await updateLiveStatus();
  } catch (error) {
    console.error(error); $("#primaryInsight").innerHTML = `<h3>Unable to load data</h3><p>${error.message}</p>`;
  }
}

$("#locationForm").addEventListener("submit", async (event) => {
  event.preventDefault();
  try {
    state.selectedPlatformId = null;
    state.selectedOutlierId = null;
    await explore(parseLocation($("#locationInput").value));
    $("#locationInput").setCustomValidity("");
  }
  catch (error) { $("#locationInput").setCustomValidity(error.message); $("#locationInput").reportValidity(); }
});
$("#liveStatus").addEventListener("click", () => updateLiveStatus(true));
$("#quickLocations").addEventListener("click", (event) => {
  if (event.target.dataset.location) {
    state.selectedPlatformId = null;
    state.selectedOutlierId = null;
    explore(parseLocation(event.target.dataset.location));
  }
});
$("#radiusSelect").addEventListener("change", () => explore(state.center));
$("#depthSelect").addEventListener("change", () => explore(state.center));
$("#historyWindow").addEventListener("change", () => explore(state.center));
$("#platformFilter").addEventListener("change", (event) => {
  state.platformFilter = event.target.value;
  if (state.latestBundle) renderPlatforms(state.latestBundle.platforms);
  drawMap();
});
$("#stationList").addEventListener("click", (event) => {
  const item = event.target.closest("[data-platform-id]");
  if (!item) return;
  const platform = state.globalPlatforms.find((candidate) => candidate.id === item.dataset.platformId);
  if (!platform) return;
  state.selectedPlatformId = platform.id;
  state.selectedOutlierId = null;
  explore({ name: platform.name, lat: platform.latitude, lon: platform.longitude });
});
$("#nearestUnderwater").addEventListener("click", () => {
  const platform = nearestUnderwaterPlatform();
  if (!platform) return;
  state.selectedPlatformId = platform.id;
  state.selectedOutlierId = null;
  explore({ name: platform.name, lat: platform.latitude, lon: platform.longitude });
});
$("#watchPoint").addEventListener("click", toggleWatch);
$("#exportJson").addEventListener("click", () => exportCurrent("json"));
$("#exportCsv").addEventListener("click", () => exportCurrent("csv"));
$("#measurementGuide").addEventListener("click", () => $("#guideDialog").showModal());
$("#closeGuide").addEventListener("click", () => $("#guideDialog").close());
const navItems = [...document.querySelectorAll(".nav-item[data-target]")];
function setActiveNavigation(targetId) {
  navItems.forEach((item) => {
    const active = item.dataset.target === targetId;
    item.classList.toggle("active", active);
    if (active) item.setAttribute("aria-current", "page");
    else item.removeAttribute("aria-current");
  });
}
function navigateToSection(targetId) {
  const target = document.getElementById(targetId);
  if (!target) return;
  setActiveNavigation(targetId);
  target.scrollIntoView({ behavior: "smooth", block: "start" });
  target.classList.remove("nav-arrival");
  requestAnimationFrame(() => target.classList.add("nav-arrival"));
  window.setTimeout(() => target.classList.remove("nav-arrival"), 1050);
}
navItems.forEach((item) => item.addEventListener("click", () => navigateToSection(item.dataset.target)));
$(".brand").addEventListener("click", (event) => {
  event.preventDefault();
  navigateToSection("globalExplorer");
});
const navigationObserver = new IntersectionObserver((entries) => {
  const visible = entries
    .filter((entry) => entry.isIntersecting)
    .sort((a, b) => b.intersectionRatio - a.intersectionRatio)[0];
  if (visible) setActiveNavigation(visible.target.id);
}, { rootMargin: "-15% 0px -65% 0px", threshold: [0, .1, .25] });
["globalExplorer", "liveNetwork", "observations", "aiInsights"]
  .map((id) => document.getElementById(id))
  .filter(Boolean)
  .forEach((section) => navigationObserver.observe(section));
$(".basemap-switch").addEventListener("click", (event) => {
  const button = event.target.closest("[data-basemap]");
  if (!button || !state.map) return;
  const { satellite, street } = state.mapLayers;
  document.querySelectorAll("[data-basemap]").forEach((item) => item.classList.toggle("active", item === button));
  if (button.dataset.basemap === "satellite") {
    state.map.removeLayer(street);
    satellite.addTo(state.map);
  } else {
    state.map.removeLayer(satellite);
    street.addTo(state.map);
  }
});
$("#anomalyToggle").addEventListener("change", (event) => {
  if (!state.map) return;
  const layer = state.mapLayers.anomalies;
  if (event.target.checked) layer.addTo(state.map);
  else state.map.removeLayer(layer);
});
$("#depthCanvas").addEventListener("mousemove", (event) => {
  const rect = event.target.getBoundingClientRect();
  const x = event.clientX - rect.left, y = event.clientY - rect.top;
  const nearest = state.depthPoints?.reduce((best, point) => Math.abs(point.y - y) < Math.abs(best.y - y) ? point : best);
  const tooltip = $("#depthTooltip");
  if (!nearest || Math.abs(nearest.y - y) > 10) return tooltip.style.display = "none";
  tooltip.style.display = "block";
  tooltip.style.left = `${Math.min(x + 12, rect.width - 165)}px`;
  tooltip.style.top = `${Math.max(5, y - 24)}px`;
  const temperature = Number.isFinite(nearest.sample.temperatureC) ? `${nearest.sample.temperatureC}°C` : "not reported";
  const oxygen = Number.isFinite(nearest.sample.oxygenMgL) ? `${nearest.sample.oxygenMgL}` : "not reported";
  tooltip.innerHTML = `<strong>${nearest.sample.depthM.toLocaleString()} m</strong><br>Temperature ${temperature} · Oxygen ${oxygen}<br>Departure score ${Math.round(nearest.sample.anomalyScore * 100)}%`;
});
$("#depthCanvas").addEventListener("mouseleave", () => $("#depthTooltip").style.display = "none");
window.addEventListener("resize", () => {
  state.map?.invalidateSize();
  drawChart();
  drawDepthProfile();
});

init();
