import http from "node:http";
import { readFile } from "node:fs/promises";
import { extname, join, normalize } from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL(".", import.meta.url));
const publicDir = join(root, "public");

const NDBC_LATEST_URL = "https://www.ndbc.noaa.gov/data/latest_obs/latest_obs.txt";
const NDBC_STATIONS_URL = "https://www.ndbc.noaa.gov/activestations.xml";
let ndbcPlatforms = [];
let ndbcSync = { status: "not-synced", lastAttemptAt: null, lastSuccessAt: null, stationCount: 0, error: null };
const ndbcHistoryCache = new Map();
let ioosPlatforms = [];
const ioosProfiles = new Map();
let ioosSync = { status: "not-synced", lastAttemptAt: null, lastSuccessAt: null, datasetCount: 0, observationCount: 0, error: null };
const ooiSync = { status: "credentials-required", directM2M: false, relay: "OOI gliders available through IOOS Glider DAC" };

const IOOS_GLIDER_DATASETS = [
  { id: "ce_1153-20260226T1945", network: "OOI", label: "OOI Endurance glider 1153" },
  { id: "cp_1155-20260429T1457", network: "OOI", label: "OOI Pioneer glider 1155" },
  { id: "cp_1161-20260429T1445", network: "OOI", label: "OOI Pioneer glider 1161" },
  { id: "ru37-20260615T1524", network: "IOOS", label: "Rutgers glider RU37" },
  { id: "osu1138-20260525T2219", network: "IOOS", label: "NANOOS glider OSU1138" },
  { id: "sbu01-20260508T1446", network: "IOOS", label: "Stony Brook glider SBU01" }
];
const sensorRecords = new Map();
const satelliteRecords = new Map();
const imageryStrategyCache = new Map();

function nullableNumber(value) {
  if (value === null || value === undefined || value === "") return null;
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function canonicalSensorRecord(input) {
  return {
    sensor_id: String(input.sensor_id),
    latitude: Number(input.latitude),
    longitude: Number(input.longitude),
    timestamp: new Date(input.timestamp).toISOString(),
    depth_meters: nullableNumber(input.depth_meters),
    temperature: nullableNumber(input.temperature),
    salinity: nullableNumber(input.salinity),
    turbidity: nullableNumber(input.turbidity),
    chlorophyll: nullableNumber(input.chlorophyll),
    dissolved_oxygen: nullableNumber(input.dissolved_oxygen),
    pH: nullableNumber(input.pH),
    blue_light_reading: nullableNumber(input.blue_light_reading),
    green_light_reading: nullableNumber(input.green_light_reading),
    red_light_reading: nullableNumber(input.red_light_reading),
    pressure: nullableNumber(input.pressure),
    current_speed: nullableNumber(input.current_speed),
    source: input.source || "unknown",
    provenance: input.provenance || "observed"
  };
}

function canonicalSatelliteRecord(input) {
  const satelliteSource = String(input.satellite_source);
  const imageDate = new Date(input.image_date).toISOString();
  return {
    record_id: input.record_id || `${satelliteSource}:${imageDate}:${Number(input.latitude).toFixed(5)}:${Number(input.longitude).toFixed(5)}`,
    satellite_source: satelliteSource,
    image_date: imageDate,
    latitude: Number(input.latitude),
    longitude: Number(input.longitude),
    cloud_cover: nullableNumber(input.cloud_cover),
    blue_band_value: nullableNumber(input.blue_band_value),
    green_band_value: nullableNumber(input.green_band_value),
    red_band_value: nullableNumber(input.red_band_value),
    nir_band_value: nullableNumber(input.nir_band_value),
    swir_band_value: nullableNumber(input.swir_band_value),
    blue_green_ratio: nullableNumber(input.blue_green_ratio),
    depth_index: nullableNumber(input.depth_index),
    turbidity_index: nullableNumber(input.turbidity_index),
    image_url: input.image_url || null,
    provenance: input.provenance || "observed"
  };
}

function upsertSensorRecord(record) {
  sensorRecords.set(`${record.sensor_id}:${record.timestamp}:${record.depth_meters ?? "na"}`, record);
  if (sensorRecords.size > 5000) {
    const oldestKey = sensorRecords.keys().next().value;
    sensorRecords.delete(oldestKey);
  }
}

function odataAttribute(product, name) {
  const attributes = product?.Attributes?.value || product?.Attributes || [];
  return attributes.find((attribute) => attribute.Name === name)?.Value ?? null;
}

async function queryCopernicusProducts(collection, latitude, longitude, days = 30, top = 8) {
  const delta = 0.05;
  const polygon = `POLYGON((${longitude - delta} ${latitude - delta},${longitude + delta} ${latitude - delta},${longitude + delta} ${latitude + delta},${longitude - delta} ${latitude + delta},${longitude - delta} ${latitude - delta}))`;
  const end = new Date();
  const start = new Date(end.getTime() - days * 86_400_000);
  const filter = [
    `Collection/Name eq '${collection}'`,
    `OData.CSC.Intersects(area=geography'SRID=4326;${polygon}')`,
    `ContentDate/Start gt ${start.toISOString()}`,
    `ContentDate/Start lt ${end.toISOString()}`
  ].join(" and ");
  const query = new URLSearchParams({
    "$filter": filter,
    "$orderby": "ContentDate/Start desc",
    "$top": String(top),
    "$expand": "Attributes"
  });
  const response = await fetch(`https://catalogue.dataspace.copernicus.eu/odata/v1/Products?${query}`, {
    headers: { "User-Agent": "OceanLens-AI/0.2 public-ocean-data-prototype" },
    signal: AbortSignal.timeout(20_000)
  });
  if (!response.ok) throw new Error(`Copernicus catalogue returned ${response.status}`);
  return (await response.json()).value || [];
}

async function buildImageryStrategy(latitude, longitude, selectedPlatform = null) {
  const cacheKey = `${latitude.toFixed(2)}:${longitude.toFixed(2)}`;
  const cached = imageryStrategyCache.get(cacheKey);
  if (cached && Date.now() - cached.cachedAt < 10 * 60_000) return cached.value;

  const [opticalResult, sarResult] = await Promise.allSettled([
    queryCopernicusProducts("SENTINEL-2", latitude, longitude),
    queryCopernicusProducts("SENTINEL-1", latitude, longitude)
  ]);
  const opticalProducts = opticalResult.status === "fulfilled"
    ? opticalResult.value.filter((product) => product.Name.includes("MSIL2A"))
    : [];
  const optical = opticalProducts
    .map((product) => ({
      id: product.Id,
      name: product.Name,
      acquired_at: product.ContentDate?.Start,
      cloud_cover: nullableNumber(odataAttribute(product, "cloudCover")),
      product_type: odataAttribute(product, "productType") || "S2MSI2A",
      source: "Copernicus Sentinel-2 L2A catalogue"
    }))
    .sort((a, b) => {
      const cloudA = Number.isFinite(a.cloud_cover) ? a.cloud_cover : 101;
      const cloudB = Number.isFinite(b.cloud_cover) ? b.cloud_cover : 101;
      return cloudA - cloudB || new Date(b.acquired_at) - new Date(a.acquired_at);
    })[0] || null;
  const sarProducts = sarResult.status === "fulfilled" ? sarResult.value : [];
  const sar = sarProducts
    .map((product) => ({
      id: product.Id,
      name: product.Name,
      acquired_at: product.ContentDate?.Start,
      product_type: product.Name.includes("_OCN_") ? "Sentinel-1 OCN" : product.Name.includes("_GRD") ? "Sentinel-1 GRD" : "Sentinel-1 SAR",
      source: "Copernicus Sentinel-1 catalogue"
    }))
    .sort((a, b) => {
      const oceanA = a.product_type.includes("OCN") ? 0 : 1;
      const oceanB = b.product_type.includes("OCN") ? 0 : 1;
      return oceanA - oceanB || new Date(b.acquired_at) - new Date(a.acquired_at);
    })[0] || null;
  const cloudThreshold = 30;
  const useOptical = optical && Number.isFinite(optical.cloud_cover) && optical.cloud_cover <= cloudThreshold;
  const selected = useOptical ? "optical" : sar ? "sar" : optical ? "optical-limited" : "none";
  const underwater = selectedPlatform && ioosProfiles.has(selectedPlatform.id)
    ? {
        available: true,
        platform_type: "underwater",
        source: selectedPlatform.provider,
        max_depth_m: selectedPlatform.maxDepthM,
        depth_profile_available: true,
        role: "Authoritative underwater temperature, salinity, oxygen, chlorophyll, and pressure where reported"
      }
    : selectedPlatform?.live
      ? {
          available: true,
          platform_type: "surface",
          source: selectedPlatform.provider,
          max_depth_m: 0,
          depth_profile_available: false,
          role: "Surface observation only; not an underwater profile"
        }
      : {
          available: false,
          platform_type: "none",
          source: null,
          max_depth_m: null,
          depth_profile_available: false,
          role: "Select an underwater glider or sensor platform for depth observations"
        };
  const value = {
    generated_at: new Date().toISOString(),
    location: { latitude, longitude },
    decision: {
      selected,
      reason: useOptical
        ? `Use Sentinel-2 optical imagery: the best recent scene has ${optical.cloud_cover.toFixed(1)}% cloud cover.`
        : sar
          ? optical
            ? `Use Sentinel-1 SAR: the best recent optical scene has ${optical.cloud_cover?.toFixed(1) ?? "unknown"}% cloud cover.`
            : "Use Sentinel-1 SAR: no recent Sentinel-2 L2A scene was found."
          : optical
            ? "Optical metadata exists, but cloud quality is poor and no recent SAR scene was found."
            : "No recent Sentinel-1 or Sentinel-2 scene was found.",
      cloud_threshold_percent: cloudThreshold
    },
    optical: {
      available: Boolean(optical),
      scene: optical,
      can_assess: ["water color", "shallow-water visibility", "turbidity", "chlorophyll", "possible shallow depth"],
      limitation: "Clouds, haze, sun glint, and water clarity limit optical measurements. Catalogue metadata does not include extracted band values."
    },
    sar: {
      available: Boolean(sar),
      scene: sar,
      can_assess: ["surface roughness", "storm structure", "wave and wind signatures", "coastline", "cloud-independent surface monitoring"],
      limitation: "SAR does not directly measure underwater temperature, salinity, oxygen, pH, or deep-water conditions."
    },
    nisar: {
      available: false,
      status: "not connected",
      role: "Future cloud-penetrating SAR surface context when an accessible NISAR product feed is configured"
    },
    underwater,
    errors: {
      optical: opticalResult.status === "rejected" ? opticalResult.reason.message : null,
      sar: sarResult.status === "rejected" ? sarResult.reason.message : null
    }
  };
  imageryStrategyCache.set(cacheKey, { cachedAt: Date.now(), value });
  return value;
}

function parseNdbcValue(value) {
  return value && value !== "MM" ? Number(value) : null;
}

function decodeXml(value = "") {
  return value
    .replaceAll("&amp;", "&")
    .replaceAll("&quot;", '"')
    .replaceAll("&apos;", "'")
    .replaceAll("&lt;", "<")
    .replaceAll("&gt;", ">");
}

function parseNdbcStationMetadata(text) {
  const stations = new Map();
  for (const tag of text.matchAll(/<station\s+([^>]+)\/>/g)) {
    const attributes = Object.fromEntries(
      [...tag[1].matchAll(/(\w+)="([^"]*)"/g)].map((match) => [match[1], decodeXml(match[2])])
    );
    if (attributes.id) stations.set(attributes.id.toUpperCase(), attributes);
  }
  return stations;
}

function ndbcDisplayType(type) {
  return {
    buoy: "buoy",
    tao: "tropical moored buoy",
    dart: "tsunami buoy",
    usv: "uncrewed surface vehicle",
    oilrig: "offshore platform",
    fixed: "fixed / shore station",
    other: "surface station"
  }[type] || "surface station";
}

function parseNdbcLatest(text, stationMetadata = new Map()) {
  return text.split(/\r?\n/)
    .filter((line) => line.trim() && !line.startsWith("#"))
    .map((line) => {
      const values = line.trim().split(/\s+/);
      if (values.length < 22) return null;
      const [id, lat, lon, year, month, day, hour, minute, windDirection, windSpeed,
        gustSpeed, waveHeight, dominantPeriod, averagePeriod, meanWaveDirection,
        pressure, pressureTendency, airTemperature, waterTemperature, dewPoint,
        visibility, tide] = values;
      const observedAt = new Date(Date.UTC(Number(year), Number(month) - 1, Number(day), Number(hour), Number(minute))).toISOString();
      const fresh = Date.now() - new Date(observedAt).getTime() <= 24 * 3_600_000;
      const metadata = stationMetadata.get(id.toUpperCase()) || {};
      const officialType = metadata.type || "unknown";
      const displayType = ndbcDisplayType(officialType);
      return {
        id: `NDBC-${id}`,
        stationId: id,
        name: metadata.name ? `${metadata.name} (${id})` : `NOAA ${displayType} ${id}`,
        type: displayType,
        officialType,
        stationCategory: officialType === "fixed" ? "fixed" : "marine",
        marine: officialType !== "fixed",
        latitude: Number(lat),
        longitude: Number(lon),
        maxDepthM: 0,
        provider: "NOAA NDBC",
        status: fresh ? "live" : "stale",
        observedAt,
        live: true,
        measurements: {
          waterTemperatureC: parseNdbcValue(waterTemperature),
          airTemperatureC: parseNdbcValue(airTemperature),
          windDirectionDeg: parseNdbcValue(windDirection),
          windSpeedMs: parseNdbcValue(windSpeed),
          gustSpeedMs: parseNdbcValue(gustSpeed),
          waveHeightM: parseNdbcValue(waveHeight),
          dominantPeriodS: parseNdbcValue(dominantPeriod),
          averagePeriodS: parseNdbcValue(averagePeriod),
          meanWaveDirectionDeg: parseNdbcValue(meanWaveDirection),
          pressureHpa: parseNdbcValue(pressure),
          pressureTendencyHpa: parseNdbcValue(pressureTendency),
          dewPointC: parseNdbcValue(dewPoint),
          visibilityNmi: parseNdbcValue(visibility),
          tideFt: parseNdbcValue(tide)
        }
      };
    })
    .filter((platform) => platform && Number.isFinite(platform.latitude) && Number.isFinite(platform.longitude));
}

async function syncNdbc() {
  ndbcSync = { ...ndbcSync, status: "syncing", lastAttemptAt: new Date().toISOString(), error: null };
  try {
    const [latestResponse, metadataResponse] = await Promise.all([
      fetch(NDBC_LATEST_URL, {
        headers: { "User-Agent": "OceanLens-AI/0.2" },
        signal: AbortSignal.timeout(15_000)
      }),
      fetch(NDBC_STATIONS_URL, {
        headers: { "User-Agent": "OceanLens-AI/0.2" },
        signal: AbortSignal.timeout(15_000)
      })
    ]);
    if (!latestResponse.ok) throw new Error(`NOAA returned ${latestResponse.status}`);
    const metadata = metadataResponse.ok
      ? parseNdbcStationMetadata(await metadataResponse.text())
      : new Map();
    const parsed = parseNdbcLatest(await latestResponse.text(), metadata);
    if (!parsed.length) throw new Error("NOAA feed contained no usable stations");
    ndbcPlatforms = parsed;
    for (const platform of parsed) {
      upsertSensorRecord(canonicalSensorRecord({
        sensor_id: platform.id,
        latitude: platform.latitude,
        longitude: platform.longitude,
        timestamp: platform.observedAt,
        depth_meters: 0,
        temperature: platform.measurements.waterTemperatureC,
        pressure: platform.measurements.pressureHpa,
        source: "NOAA NDBC latest observations",
        provenance: "live public observation"
      }));
    }
    ndbcSync = {
      status: "live",
      lastAttemptAt: ndbcSync.lastAttemptAt,
      lastSuccessAt: new Date().toISOString(),
      stationCount: parsed.length,
      freshStationCount: parsed.filter((platform) => platform.status === "live").length,
      marineStationCount: parsed.filter((platform) => platform.marine).length,
      fixedStationCount: parsed.filter((platform) => !platform.marine).length,
      error: null
    };
  } catch (error) {
    ndbcSync = { ...ndbcSync, status: ndbcPlatforms.length ? "stale" : "offline", error: error.message };
  }
  return ndbcSync;
}

function parseNdbcHistory(text) {
  return text.split(/\r?\n/)
    .filter((line) => line.trim() && !line.startsWith("#"))
    .map((line) => {
      const values = line.trim().split(/\s+/);
      if (values.length < 19) return null;
      const [year, month, day, hour, minute, windDirection, windSpeed, gustSpeed,
        waveHeight, dominantPeriod, averagePeriod, meanWaveDirection, pressure,
        airTemperature, waterTemperature, dewPoint, visibility, pressureTendency, tide] = values;
      return {
        observed_at: new Date(Date.UTC(Number(year), Number(month) - 1, Number(day), Number(hour), Number(minute))).toISOString(),
        water_temperature_c: parseNdbcValue(waterTemperature),
        air_temperature_c: parseNdbcValue(airTemperature),
        wave_height_m: parseNdbcValue(waveHeight),
        wind_speed_ms: parseNdbcValue(windSpeed),
        gust_speed_ms: parseNdbcValue(gustSpeed),
        pressure_hpa: parseNdbcValue(pressure),
        dominant_period_s: parseNdbcValue(dominantPeriod),
        wind_direction_deg: parseNdbcValue(windDirection),
        mean_wave_direction_deg: parseNdbcValue(meanWaveDirection),
        dew_point_c: parseNdbcValue(dewPoint),
        visibility_nmi: parseNdbcValue(visibility),
        pressure_tendency_hpa: parseNdbcValue(pressureTendency),
        tide_ft: parseNdbcValue(tide)
      };
    })
    .filter(Boolean)
    .reverse();
}

async function getNdbcHistory(stationId) {
  const cached = ndbcHistoryCache.get(stationId);
  if (cached && Date.now() - cached.fetchedAt < 5 * 60_000) return cached.points;
  const response = await fetch(`https://www.ndbc.noaa.gov/data/realtime2/${encodeURIComponent(stationId)}.txt`, {
    headers: { "User-Agent": "Pelagos-Intelligence/0.1 educational-prototype" },
    signal: AbortSignal.timeout(15_000)
  });
  if (!response.ok) throw new Error(`NOAA history returned ${response.status}`);
  const points = parseNdbcHistory(await response.text());
  ndbcHistoryCache.set(stationId, { fetchedAt: Date.now(), points });
  return points;
}

function firstAvailable(variables, candidates) {
  return candidates.find((candidate) => variables.has(candidate)) || null;
}

async function fetchErddapJson(url) {
  const response = await fetch(url, {
    headers: { "User-Agent": "OceanLens-AI/0.2 public-ocean-data-prototype" },
    signal: AbortSignal.timeout(20_000)
  });
  if (!response.ok) throw new Error(`ERDDAP returned ${response.status}`);
  return response.json();
}

function erddapRows(payload) {
  const names = payload?.table?.columnNames || [];
  return (payload?.table?.rows || []).map((row) => Object.fromEntries(names.map((name, index) => [name, row[index]])));
}

async function syncIoosDataset(config) {
  const info = await fetchErddapJson(`https://gliders.ioos.us/erddap/info/${encodeURIComponent(config.id)}/index.json`);
  const variables = new Set((info.table?.rows || []).filter((row) => row[0] === "variable").map((row) => row[1]));
  const aliases = {
    profile: firstAvailable(variables, ["profile_id"]),
    time: firstAvailable(variables, ["time", "precise_time"]),
    latitude: firstAvailable(variables, ["latitude", "precise_lat", "gps_latitude"]),
    longitude: firstAvailable(variables, ["longitude", "precise_lon", "gps_longitude"]),
    depth: firstAvailable(variables, ["depth", "measured_depth"]),
    temperature: firstAvailable(variables, ["temperature", "potential_temperature"]),
    salinity: firstAvailable(variables, ["salinity"]),
    oxygen: firstAvailable(variables, ["dissolved_oxygen", "oxygen_concentration"]),
    chlorophyll: firstAvailable(variables, ["chlorophyll"]),
    pressure: firstAvailable(variables, ["pressure", "measured_pressure"]),
    backscatter: firstAvailable(variables, ["backscatter", "backscatter_700"]),
    currentU: firstAvailable(variables, ["u"]),
    currentV: firstAvailable(variables, ["v"])
  };
  if (!aliases.time || !aliases.latitude || !aliases.longitude || !aliases.depth) {
    throw new Error(`${config.id} lacks required position/depth variables`);
  }
  const latestFields = [...new Set(Object.values(aliases).filter(Boolean))];
  const latestUrl = `https://gliders.ioos.us/erddap/tabledap/${encodeURIComponent(config.id)}.json?${latestFields.join(",")}&orderByMax(%22${aliases.time}%22)`;
  const latestRows = erddapRows(await fetchErddapJson(latestUrl));
  if (!latestRows.length) throw new Error(`${config.id} returned no observations`);
  const latest = latestRows.at(-1);
  let profileRows = latestRows;
  if (aliases.profile && latest[aliases.profile] !== null && latest[aliases.profile] !== undefined) {
    const profileValue = encodeURIComponent(latest[aliases.profile]);
    const profileUrl = `https://gliders.ioos.us/erddap/tabledap/${encodeURIComponent(config.id)}.json?${latestFields.join(",")}&${aliases.profile}=${profileValue}`;
    profileRows = erddapRows(await fetchErddapJson(profileUrl));
  }
  const normalized = profileRows
    .map((row) => {
      const latitude = nullableNumber(row[aliases.latitude]);
      const longitude = nullableNumber(row[aliases.longitude]);
      const depth = nullableNumber(row[aliases.depth]);
      const timestamp = row[aliases.time];
      if (!Number.isFinite(latitude) || !Number.isFinite(longitude) || !Number.isFinite(depth) || !timestamp) return null;
      const u = aliases.currentU ? nullableNumber(row[aliases.currentU]) : null;
      const v = aliases.currentV ? nullableNumber(row[aliases.currentV]) : null;
      return canonicalSensorRecord({
        sensor_id: `${config.network}-${config.id}`,
        latitude,
        longitude,
        timestamp,
        depth_meters: depth,
        temperature: aliases.temperature ? row[aliases.temperature] : null,
        salinity: aliases.salinity ? row[aliases.salinity] : null,
        chlorophyll: aliases.chlorophyll ? row[aliases.chlorophyll] : null,
        dissolved_oxygen: aliases.oxygen ? row[aliases.oxygen] : null,
        pressure: aliases.pressure ? row[aliases.pressure] : null,
        current_speed: Number.isFinite(u) && Number.isFinite(v) ? Math.sqrt(u ** 2 + v ** 2) : null,
        source: `IOOS Glider DAC · ${config.id}`,
        provenance: "public underwater observation"
      });
    })
    .filter(Boolean)
    .sort((a, b) => a.depth_meters - b.depth_meters);
  if (!normalized.length) throw new Error(`${config.id} profile contained no usable rows`);
  for (const record of normalized) upsertSensorRecord(record);
  const position = normalized.reduce((latest, record) =>
    new Date(record.timestamp) > new Date(latest.timestamp) ? record : latest
  , normalized[0]);
  const platformId = `${config.network}-${config.id}`;
  ioosProfiles.set(platformId, {
    datasetId: config.id,
    network: config.network,
    label: config.label,
    observedAt: position.timestamp,
    observations: normalized,
    variables: Object.entries(aliases).filter(([, value]) => value).map(([key]) => key)
  });
  return {
    id: platformId,
    stationId: config.id,
    name: config.label,
    type: "glider",
    latitude: position.latitude,
    longitude: position.longitude,
    maxDepthM: Math.max(...normalized.map((record) => record.depth_meters)),
    provider: config.network === "OOI" ? "OOI via IOOS Glider DAC" : "IOOS Glider DAC",
    network: config.network,
    status: "live",
    observedAt: position.timestamp,
    live: true,
    underwater: true,
    profileAvailable: true,
    stationCategory: "underwater",
    marine: true,
    measurements: {
      waterTemperatureC: position.temperature,
      salinity: position.salinity,
      dissolvedOxygen: position.dissolved_oxygen,
      chlorophyll: position.chlorophyll,
      pressure: position.pressure
    }
  };
}

async function syncIoos() {
  ioosSync = { ...ioosSync, status: "syncing", lastAttemptAt: new Date().toISOString(), error: null };
  const results = await Promise.allSettled(IOOS_GLIDER_DATASETS.map(syncIoosDataset));
  const platforms = results.filter((result) => result.status === "fulfilled").map((result) => result.value);
  const errors = results.filter((result) => result.status === "rejected").map((result) => result.reason.message);
  if (platforms.length) ioosPlatforms = platforms;
  ioosSync = {
    status: platforms.length === IOOS_GLIDER_DATASETS.length ? "live" : platforms.length ? "partial" : "offline",
    lastAttemptAt: ioosSync.lastAttemptAt,
    lastSuccessAt: platforms.length ? new Date().toISOString() : ioosSync.lastSuccessAt,
    datasetCount: platforms.length,
    observationCount: [...ioosProfiles.values()].reduce((sum, profile) => sum + profile.observations.length, 0),
    error: errors.length ? errors.join("; ") : null
  };
  return ioosSync;
}

function allPlatforms() {
  return [...ndbcPlatforms, ...ioosPlatforms];
}

function haversineKm(lat1, lon1, lat2, lon2) {
  const radians = (degrees) => degrees * Math.PI / 180;
  const dLat = radians(lat2 - lat1);
  const dLon = radians(lon2 - lon1);
  const a = Math.sin(dLat / 2) ** 2
    + Math.cos(radians(lat1)) * Math.cos(radians(lat2)) * Math.sin(dLon / 2) ** 2;
  return 6371 * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

function buildDepthProfile(latitude, longitude, requestedDepth, selectedPlatform = null) {
  const maxDepthM = Math.max(100, Math.min(6000, requestedDepth || 2000));
  const profile = selectedPlatform ? ioosProfiles.get(selectedPlatform.id) : null;
  if (profile) {
    const observations = profile.observations.filter((record) => record.depth_meters <= maxDepthM);
    if (!observations.length) {
      return {
        location: { latitude, longitude },
        selectedPlatform,
        available: false,
        provenance: { mode: "unavailable", observedDepthM: 0, supportsSelectedDepth: false },
        maxDepthM,
        samples: [],
        anomaly: null,
        message: "This profile has no observations inside the requested depth range.",
        requiredSources: ["Select a larger requested range"]
      };
    }
    const metrics = [
      ["temperature", "Temperature", "°C"],
      ["salinity", "Salinity", "PSU"],
      ["dissolved_oxygen", "Dissolved oxygen", "reported units"],
      ["chlorophyll", "Chlorophyll", "reported units"]
    ];
    const baselines = Object.fromEntries(metrics.map(([key]) => {
      const values = observations.map((record) => record[key]).filter(Number.isFinite);
      return [key, values.length >= 3 ? { mean: mean(values), deviation: standardDeviation(values) } : null];
    }));
    const samples = observations.map((record) => {
      const scores = metrics.map(([key]) => {
        const baseline = baselines[key];
        return baseline && Number.isFinite(record[key]) ? Math.abs((record[key] - baseline.mean) / baseline.deviation) : 0;
      });
      return {
        depthM: record.depth_meters,
        temperatureC: record.temperature,
        oxygenMgL: record.dissolved_oxygen,
        salinityPsu: record.salinity,
        chlorophyll: record.chlorophyll,
        anomalyScore: +Math.min(1, Math.max(...scores) / 5).toFixed(3)
      };
    });
    const peak = samples.reduce((best, sample) => sample.anomalyScore > best.anomalyScore ? sample : best, samples[0]);
    const peakRecord = observations.find((record) => record.depth_meters === peak.depthM);
    const measurements = metrics
      .filter(([key]) => Number.isFinite(peakRecord[key]) && baselines[key])
      .map(([key, label, unit]) => {
        const zScore = (peakRecord[key] - baselines[key].mean) / baselines[key].deviation;
        return `${label}: ${peakRecord[key]} ${unit} (${zScore >= 0 ? "+" : ""}${zScore.toFixed(1)}σ from this profile mean)`;
      });
    return {
      location: { latitude: peakRecord.latitude, longitude: peakRecord.longitude },
      selectedPlatform: {
        id: selectedPlatform.id,
        name: selectedPlatform.name,
        type: selectedPlatform.type,
        provider: selectedPlatform.provider,
        maxDepthM: selectedPlatform.maxDepthM,
        live: true
      },
      available: true,
      provenance: {
        mode: "observed",
        label: `${profile.network} underwater glider profile`,
        observedDepthM: Math.max(...observations.map((record) => record.depth_meters)),
        supportsSelectedDepth: Math.max(...observations.map((record) => record.depth_meters)) >= maxDepthM
      },
      maxDepthM: Math.max(10, Math.ceil(Math.max(...observations.map((record) => record.depth_meters)) / 10) * 10),
      samples,
      anomaly: {
        depthM: peak.depthM,
        score: peak.anomalyScore,
        severity: peak.anomalyScore >= 0.6 ? "watch" : "normal",
        plainLanguage: peak.anomalyScore >= 0.6
          ? `The strongest departure in this observed profile occurs near ${peak.depthM.toFixed(1)} m.`
          : "No strong within-profile departure was detected in the available variables.",
        measurements,
        possibleInterpretations: ["Water-mass boundary", "biological layer", "sensor transition or quality issue"],
        notConfirmed: "This compares measurements within one real glider profile and is not, by itself, confirmation of a hazardous event."
      },
      methods: [{
        name: `${profile.network} glider profile`,
        range: `0–${Math.max(...observations.map((record) => record.depth_meters)).toFixed(0)} m`,
        role: `Observed ${profile.variables.join(", ")}`,
        available: true
      }],
      notice: `Real public observations from ${profile.datasetId}`
    };
  }
  return {
    location: { latitude, longitude },
    selectedPlatform: selectedPlatform ? {
      id: selectedPlatform.id,
      name: selectedPlatform.name,
      type: selectedPlatform.type,
      provider: selectedPlatform.provider,
      maxDepthM: selectedPlatform.maxDepthM,
      live: Boolean(selectedPlatform.live)
    } : null,
    available: false,
    provenance: { mode: "unavailable", observedDepthM: 0, supportsSelectedDepth: false },
    maxDepthM,
    samples: [],
    anomaly: null,
    message: selectedPlatform?.live
      ? `${selectedPlatform.name} is a surface station and does not provide water-column depth profiles.`
      : "No real profiling float, glider, mooring, sonar, or hydrophone feed is connected at this point.",
    requiredSources: ["Argo profile", "Deep Argo profile", "underwater glider", "instrumented mooring", "sonar or hydrophone"]
  };
}

async function buildLocationTimeSeries(latitude, longitude, locationName, selectedPlatform = null, historyHours = 168) {
  const gliderProfile = selectedPlatform ? ioosProfiles.get(selectedPlatform.id) : null;
  if (gliderProfile) {
    const points = gliderProfile.observations.map((record) => ({
      observed_at: record.timestamp,
      depth_meters: record.depth_meters,
      temperature: record.temperature,
      salinity: record.salinity,
      dissolved_oxygen: record.dissolved_oxygen,
      chlorophyll: record.chlorophyll
    }));
    const series = [
      { key: "temperature", label: "Temperature", unit: "°C", color: "#5fe0cc" },
      { key: "salinity", label: "Salinity", unit: "PSU", color: "#88a7ff" },
      { key: "dissolved_oxygen", label: "Dissolved oxygen", unit: "reported", color: "#c7eb73" },
      { key: "chlorophyll", label: "Chlorophyll", unit: "reported", color: "#ff9d68" }
    ].filter(({ key }) => points.some((point) => Number.isFinite(point[key])));
    return {
      available: points.length > 0 && series.length > 0,
      location: { name: locationName, latitude, longitude },
      source: `${gliderProfile.network} via IOOS Glider DAC · ${gliderProfile.datasetId}`,
      series,
      points,
      profileMode: true,
      message: points.length ? null : "The selected glider profile contained no usable science variables."
    };
  }
  if (!selectedPlatform?.live || !selectedPlatform.stationId) {
    return {
      available: false,
      location: { name: locationName || `${latitude.toFixed(2)}°, ${longitude.toFixed(2)}°`, latitude, longitude },
      source: null,
      points: [],
      message: "Select a live NOAA surface station to view real observation history."
    };
  }
  const cutoff = Date.now() - historyHours * 3_600_000;
  const points = (await getNdbcHistory(selectedPlatform.stationId))
    .filter((point) => new Date(point.observed_at).getTime() >= cutoff);
  const series = [
    { key: "water_temperature_c", label: "Water temperature", unit: "°C", color: "#5fe0cc" },
    { key: "wave_height_m", label: "Wave height", unit: "m", color: "#ff9d68" },
    { key: "wind_speed_ms", label: "Wind speed", unit: "m/s", color: "#c7eb73" }
  ].filter(({ key }) => points.some((point) => Number.isFinite(point[key])));
  return {
    available: points.length > 0 && series.length > 0,
    location: {
      name: locationName || `${latitude.toFixed(2)}°, ${longitude.toFixed(2)}°`,
      latitude,
      longitude
    },
    source: `NOAA NDBC station ${selectedPlatform.stationId}`,
    series,
    points: points.slice(-500),
    message: points.length ? null : "NOAA returned no usable history for this station."
  };
}

function getRankedPlatforms(latitude, longitude) {
  return allPlatforms()
    .map((platform) => ({
      ...platform,
      distanceKm: Math.round(haversineKm(latitude, longitude, platform.latitude, platform.longitude))
    }))
    .sort((a, b) => a.distanceKm - b.distanceKm);
}

function buildExtremeSurfaceOutliers() {
  const metrics = [
    { key: "waterTemperatureC", historyKey: "water_temperature_c", label: "Water temperature", unit: "°C" },
    { key: "waveHeightM", historyKey: "wave_height_m", label: "Wave height", unit: "m" },
    { key: "windSpeedMs", historyKey: "wind_speed_ms", label: "Wind speed", unit: "m/s" },
    { key: "pressureHpa", historyKey: "pressure_hpa", label: "Pressure", unit: "hPa" }
  ];
  const maximumAgeMs = 24 * 3_600_000;
  const peerRadiusKm = 1500;
  const freshPlatforms = ndbcPlatforms.filter((platform) =>
    platform.marine
    &&
    Date.now() - new Date(platform.observedAt).getTime() <= maximumAgeMs
  );
  const outliers = [];
  for (const platform of freshPlatforms) {
    for (const metric of metrics) {
      const value = platform.measurements[metric.key];
      if (!Number.isFinite(value)) continue;
      const reporting = freshPlatforms.filter((peer) =>
        Number.isFinite(peer.measurements[metric.key])
        && haversineKm(platform.latitude, platform.longitude, peer.latitude, peer.longitude) <= peerRadiusKm
      );
      if (reporting.length < 8) continue;
      const values = reporting.map((peer) => peer.measurements[metric.key]);
      const average = mean(values);
      const deviation = standardDeviation(values);
      const sorted = [...values].sort((a, b) => a - b);
      const midpoint = Math.floor(sorted.length / 2);
      const median = sorted.length % 2 ? sorted[midpoint] : (sorted[midpoint - 1] + sorted[midpoint]) / 2;
      const absoluteDeviations = sorted.map((value) => Math.abs(value - median)).sort((a, b) => a - b);
      const madMidpoint = Math.floor(absoluteDeviations.length / 2);
      const mad = absoluteDeviations.length % 2
        ? absoluteDeviations[madMidpoint]
        : (absoluteDeviations[madMidpoint - 1] + absoluteDeviations[madMidpoint]) / 2;
      const zScore = mad > 0 ? 0.6745 * (value - median) / mad : (value - average) / deviation;
      if (Math.abs(zScore) < 4) continue;
      outliers.push({
        id: `${platform.id}:${metric.key}`,
        platformId: platform.id,
        stationId: platform.stationId,
        name: platform.name,
        latitude: platform.latitude,
        longitude: platform.longitude,
        observedAt: platform.observedAt,
        metric: metric.label,
        historyKey: metric.historyKey,
        value,
        unit: metric.unit,
        regionalAverage: +average.toFixed(2),
        regionalMedian: +median.toFixed(2),
        zScore: +zScore.toFixed(2),
        direction: zScore > 0 ? "high" : "low",
        severity: Math.abs(zScore) >= 6 ? "extreme" : "major",
        comparison: `Compared with ${reporting.length} fresh stations within ${peerRadiusKm.toLocaleString()} km`,
        provider: platform.provider
      });
    }
  }
  return outliers.sort((a, b) => Math.abs(b.zScore) - Math.abs(a.zScore)).slice(0, 100);
}

async function buildOutlierHistoryComparison(outlier, historyHours = 168) {
  const cutoff = Date.now() - historyHours * 3_600_000;
  const history = (await getNdbcHistory(outlier.stationId))
    .filter((point) => new Date(point.observed_at).getTime() >= cutoff);
  const values = history.map((point) => point[outlier.historyKey]).filter(Number.isFinite);
  if (values.length < 12) {
    return {
      available: false,
      historyHours,
      sampleCount: values.length,
      message: `Only ${values.length} usable historical readings were available; at least 12 are required.`
    };
  }
  const latest = outlier.value;
  const baseline = values.slice(0, -1);
  const average = mean(baseline);
  const deviation = standardDeviation(baseline);
  const zScore = deviation > 0 ? (latest - average) / deviation : 0;
  return {
    available: true,
    historyHours,
    sampleCount: values.length,
    latest,
    average: +average.toFixed(2),
    zScore: +zScore.toFixed(2),
    unusual: Math.abs(zScore) >= 2,
    agreement: Math.abs(zScore) >= 2 ? "regional-and-history" : "regional-only",
    message: Math.abs(zScore) >= 2
      ? `Also unusual for this station: ${Math.abs(zScore).toFixed(1)} standard deviations from its recent average.`
      : `Typical for this station: ${Math.abs(zScore).toFixed(1)} standard deviations from its recent average.`
  };
}

function findPointMatches(latitude, longitude, radiusKm = 25, hours = 72, matchRadiusKm = 10, matchHours = 24) {
  const cutoff = Date.now() - hours * 3_600_000;
  const sensors = [...sensorRecords.values()]
    .map((record) => ({ ...record, distance_km: +haversineKm(latitude, longitude, record.latitude, record.longitude).toFixed(2) }))
    .filter((record) => record.distance_km <= radiusKm && new Date(record.timestamp).getTime() >= cutoff)
    .sort((a, b) => new Date(b.timestamp) - new Date(a.timestamp));
  const satellites = [...satelliteRecords.values()]
    .map((record) => ({ ...record, distance_km: +haversineKm(latitude, longitude, record.latitude, record.longitude).toFixed(2) }))
    .filter((record) => record.distance_km <= radiusKm && new Date(record.image_date).getTime() >= cutoff)
    .sort((a, b) => new Date(b.image_date) - new Date(a.image_date));
  const matches = [];
  for (const sensor of sensors) {
    const scene = satellites
      .map((satellite) => ({
        satellite,
        time_difference_hours: Math.abs(new Date(sensor.timestamp) - new Date(satellite.image_date)) / 3_600_000,
        spatial_difference_km: haversineKm(sensor.latitude, sensor.longitude, satellite.latitude, satellite.longitude)
      }))
      .filter((candidate) => candidate.time_difference_hours <= matchHours && candidate.spatial_difference_km <= matchRadiusKm)
      .sort((a, b) => a.time_difference_hours - b.time_difference_hours || a.spatial_difference_km - b.spatial_difference_km)[0];
    if (scene) {
      matches.push({
        sensor,
        satellite: scene.satellite,
        time_difference_hours: +scene.time_difference_hours.toFixed(2),
        spatial_difference_km: +scene.spatial_difference_km.toFixed(2)
      });
    }
  }
  return { sensors, satellites, matches };
}

function linearRegression(xs, ys) {
  if (xs.length < 2 || xs.length !== ys.length) return null;
  const xMean = mean(xs);
  const yMean = mean(ys);
  const denominator = xs.reduce((sum, x) => sum + (x - xMean) ** 2, 0);
  if (!denominator) return null;
  const slope = xs.reduce((sum, x, index) => sum + (x - xMean) * (ys[index] - yMean), 0) / denominator;
  const intercept = yMean - slope * xMean;
  const predictions = xs.map((x) => intercept + slope * x);
  const residual = ys.reduce((sum, y, index) => sum + (y - predictions[index]) ** 2, 0);
  const total = ys.reduce((sum, y) => sum + (y - yMean) ** 2, 0);
  return { slope, intercept, rSquared: total ? Math.max(0, 1 - residual / total) : 0 };
}

function scoreSatelliteConfidence(satellite, match, sampleCount) {
  if (!satellite) return null;
  const factors = [];
  const cloudScore = Number.isFinite(satellite.cloud_cover)
    ? Math.max(0, 100 - satellite.cloud_cover * 1.5)
    : 45;
  factors.push({ name: "Cloud quality", score: Math.round(cloudScore), reason: Number.isFinite(satellite.cloud_cover) ? `${satellite.cloud_cover}% cloud cover` : "cloud cover not reported" });
  const ageHours = Math.abs(Date.now() - new Date(satellite.image_date)) / 3_600_000;
  const recencyScore = Math.max(0, 100 - ageHours / 3);
  factors.push({ name: "Scene recency", score: Math.round(recencyScore), reason: `${ageHours.toFixed(1)} hours old` });
  const matchScore = match
    ? Math.max(0, 100 - match.spatial_difference_km * 2 - match.time_difference_hours * 2)
    : 20;
  factors.push({ name: "Sensor match", score: Math.round(matchScore), reason: match ? `${match.spatial_difference_km} km and ${match.time_difference_hours} hours apart` : "no matched sensor record" });
  const historyScore = Math.min(100, sampleCount * 8);
  factors.push({ name: "Historical support", score: historyScore, reason: `${sampleCount} matched pairs` });
  return {
    score: Math.round(factors.reduce((sum, factor) => sum + factor.score, 0) / factors.length),
    factors
  };
}

async function buildOceanLensAi(latitude, longitude, selectedPlatform = null, historyHours = 168) {
  const evidence = findPointMatches(latitude, longitude, 50, 24 * 30, 10, 24);
  const depthPairs = evidence.matches.filter(({ sensor, satellite }) =>
    Number.isFinite(sensor.depth_meters)
    && sensor.depth_meters > 0
    && Number.isFinite(satellite.blue_green_ratio)
    && Number.isFinite(satellite.turbidity_index)
  );
  const clarityPairs = evidence.matches.filter(({ sensor, satellite }) =>
    Number.isFinite(sensor.turbidity)
    && Number.isFinite(satellite.red_band_value)
    && Number.isFinite(satellite.green_band_value)
  );
  const temperaturePairs = evidence.matches.filter(({ sensor }) =>
    Number.isFinite(sensor.temperature) && Number.isFinite(sensor.depth_meters) && sensor.depth_meters > 0
  );

  let anomaly = { available: false, message: "Select a live NOAA surface station with station history." };
  let trends = { available: false, series: [], unavailable: ["temperature", "clarity", "depth estimate", "chlorophyll", "turbidity"] };
  const gliderProfile = selectedPlatform ? ioosProfiles.get(selectedPlatform.id) : null;
  if (gliderProfile) {
    const observations = gliderProfile.observations;
    const availableKeys = [
      ["temperature", "Temperature", "°C"],
      ["salinity", "Salinity", "PSU"],
      ["dissolved_oxygen", "Dissolved oxygen", "reported"],
      ["chlorophyll", "Chlorophyll", "reported"]
    ];
    const checks = availableKeys.map(([key, label, unit]) => {
      const values = observations.map((point) => point[key]).filter(Number.isFinite);
      if (values.length < 5) return null;
      const current = values.at(-1);
      const average = mean(values);
      const zScore = (current - average) / standardDeviation(values);
      const percentDifference = average ? ((current - average) / Math.abs(average)) * 100 : 0;
      return { key, label, unit, current, average: +average.toFixed(2), zScore: +zScore.toFixed(2), percentDifference: +percentDifference.toFixed(1) };
    }).filter(Boolean);
    const flagged = checks.filter((check) => Math.abs(check.zScore) >= 2).sort((a, b) => Math.abs(b.zScore) - Math.abs(a.zScore));
    anomaly = {
      available: true,
      baseline: "Within the selected depth profile",
      alert: flagged[0] || null,
      checks,
      message: flagged.length
        ? `${flagged[0].label} at the deepest sample differs from the profile mean by ${Math.abs(flagged[0].zScore).toFixed(1)} standard deviations.`
        : "No deepest-sample value is more than two standard deviations from this observed profile mean."
    };
    trends = {
      available: true,
      series: checks.map((check) => ({ metric: check.label, current: check.current, average: check.average, unit: check.unit })),
      unavailable: ["satellite clarity", "satellite depth estimate"]
    };
  } else if (selectedPlatform?.live && selectedPlatform.stationId) {
    const cutoff = Date.now() - historyHours * 3_600_000;
    const history = (await getNdbcHistory(selectedPlatform.stationId))
      .filter((point) => new Date(point.observed_at).getTime() >= cutoff);
    const availableKeys = [
      ["water_temperature_c", "Water temperature", "°C"],
      ["wave_height_m", "Wave height", "m"],
      ["wind_speed_ms", "Wind speed", "m/s"],
      ["pressure_hpa", "Pressure", "hPa"]
    ];
    const checks = availableKeys.map(([key, label, unit]) => {
      const values = history.map((point) => point[key]).filter(Number.isFinite);
      if (values.length < 12) return null;
      const current = values.at(-1);
      const baseline = values.slice(0, -1);
      const average = mean(baseline);
      const zScore = (current - average) / standardDeviation(baseline);
      const percentDifference = average ? ((current - average) / Math.abs(average)) * 100 : 0;
      return { key, label, unit, current, average: +average.toFixed(2), zScore: +zScore.toFixed(2), percentDifference: +percentDifference.toFixed(1) };
    }).filter(Boolean);
    const flagged = checks.filter((check) => Math.abs(check.zScore) >= 2).sort((a, b) => Math.abs(b.zScore) - Math.abs(a.zScore));
    anomaly = {
      available: checks.length > 0,
      baseline: "Compared with this station's selected history window",
      alert: flagged[0] || null,
      checks,
      message: !checks.length
        ? "Not enough usable history was available to evaluate an anomaly; each variable needs at least 12 readings."
        : flagged.length
        ? `${flagged[0].label} is ${Math.abs(flagged[0].percentDifference).toFixed(1)}% ${flagged[0].percentDifference >= 0 ? "above" : "below"} its recent average.`
        : "No latest reading is more than two standard deviations from recent station history."
    };
    trends = {
      available: true,
      series: checks.map((check) => ({ metric: check.label, current: check.current, average: check.average, unit: check.unit })),
      unavailable: ["water clarity", "depth estimate", "chlorophyll", "turbidity"]
    };
  }

  const depthRegression = depthPairs.length >= 10
    ? linearRegression(depthPairs.map((pair) => pair.satellite.blue_green_ratio), depthPairs.map((pair) => pair.sensor.depth_meters))
    : null;
  const latestSatellite = evidence.satellites[0] || null;
  const depthPrediction = depthRegression
    && latestSatellite
    && Number.isFinite(latestSatellite.blue_green_ratio)
    && Number.isFinite(latestSatellite.turbidity_index)
    ? {
        available: true,
        estimated_depth_meters: +Math.max(0, depthRegression.intercept + depthRegression.slope * latestSatellite.blue_green_ratio).toFixed(2),
        r_squared: +depthRegression.rSquared.toFixed(3),
        sample_count: depthPairs.length,
        warning: "An optical estimate for shallow clear water; it is not a sonar measurement."
      }
    : {
        available: false,
        sample_count: depthPairs.length,
        required: 10,
        message: "Needs at least 10 real matches containing sensor depth, blue/green ratio, and turbidity index."
      };

  const clarityCorrelation = clarityPairs.length >= 8
    ? pearson(
        clarityPairs.map((pair) => pair.satellite.red_band_value / pair.satellite.green_band_value),
        clarityPairs.map((pair) => pair.sensor.turbidity)
      )
    : null;
  const opticalCorrelation = depthPairs.length >= 8
    ? pearson(depthPairs.map((pair) => pair.satellite.blue_green_ratio), depthPairs.map((pair) => pair.sensor.depth_meters))
    : null;
  const uniqueDepths = new Set(temperaturePairs.map((pair) => pair.sensor.depth_meters));
  const temperatureDepthCorrelation = temperaturePairs.length >= 8 && uniqueDepths.size >= 2
    ? pearson(temperaturePairs.map((pair) => pair.sensor.depth_meters), temperaturePairs.map((pair) => pair.sensor.temperature))
    : null;
  const bestMatch = evidence.matches[0] || null;

  const patternRows = [
    { name: "Blue/green ratio vs depth", available: opticalCorrelation !== null, correlation: opticalCorrelation === null ? null : +opticalCorrelation.toFixed(3), sample_count: depthPairs.length },
    { name: "Red/green ratio vs turbidity", available: clarityCorrelation !== null, correlation: clarityCorrelation === null ? null : +clarityCorrelation.toFixed(3), sample_count: clarityPairs.length },
    { name: "Depth vs temperature", available: temperatureDepthCorrelation !== null, correlation: temperatureDepthCorrelation === null ? null : +temperatureDepthCorrelation.toFixed(3), sample_count: temperaturePairs.length }
  ];
  return {
    generated_at: new Date().toISOString(),
    location: { latitude, longitude },
    pattern_finder: {
      available: patternRows.some((pattern) => pattern.available),
      matched_pair_count: evidence.matches.length,
      patterns: patternRows,
      message: patternRows.some((pattern) => pattern.available)
        ? null
        : "No supported relationship has enough real matched data. Each pattern requires at least 8 qualifying pairs."
    },
    depth_predictor: depthPrediction,
    anomaly_alerts: anomaly,
    satellite_confidence: latestSatellite
      ? { available: true, ...scoreSatelliteConfidence(latestSatellite, bestMatch, evidence.matches.length) }
      : { available: false, message: "No analytical satellite scene is available for this point." },
    trends
  };
}

async function buildLocationInsights(latitude, longitude, radiusKm, maxDepthM, locationName, selectedPlatform = null, selectedOutlier = null, historyHours = 168) {
  const ranked = getRankedPlatforms(latitude, longitude);
  const nearby = ranked.filter((platform) => platform.distanceKm <= radiusKm);
  if (selectedPlatform && ioosProfiles.has(selectedPlatform.id)) {
    const profile = buildDepthProfile(latitude, longitude, maxDepthM, selectedPlatform);
    if (!profile.available) {
      return {
        available: false,
        generatedAt: new Date().toISOString(),
        location: { name: locationName, latitude, longitude, radiusKm, maxDepthM },
        message: profile.message
      };
    }
    return {
      available: true,
      generatedAt: new Date().toISOString(),
      location: { name: locationName, latitude, longitude, radiusKm, maxDepthM },
      source: profile.notice,
      observedAt: ioosProfiles.get(selectedPlatform.id).observedAt,
      primary: {
        flagged: profile.anomaly.severity === "watch",
        severity: profile.anomaly.severity,
        baseline: "Within-profile depth comparison",
        title: profile.anomaly.severity === "watch" ? "Subsurface profile departure detected" : "No strong subsurface departure detected",
        plainLanguage: profile.anomaly.plainLanguage,
        measurements: profile.anomaly.measurements,
        notConfirmed: profile.anomaly.notConfirmed
      },
      patterns: [{
        title: "Observed underwater profile",
        description: `${profile.samples.length} real measurements span 0–${profile.provenance.observedDepthM.toFixed(0)} m.`
      }]
    };
  }
  if (!selectedPlatform?.live || !selectedPlatform.stationId) {
    return {
      available: false,
      generatedAt: new Date().toISOString(),
      location: { name: locationName, latitude, longitude, radiusKm, maxDepthM },
      message: "No real observation series is selected. Choose a live NOAA surface station to run evidence-based analysis.",
      nearbyCount: nearby.length
    };
  }
  const cutoff = Date.now() - historyHours * 3_600_000;
  const history = (await getNdbcHistory(selectedPlatform.stationId))
    .filter((point) => new Date(point.observed_at).getTime() >= cutoff);
  const checks = [
    ["water_temperature_c", "Water temperature", "°C"],
    ["wave_height_m", "Wave height", "m"],
    ["wind_speed_ms", "Wind speed", "m/s"],
    ["pressure_hpa", "Pressure", "hPa"]
  ].map(([key, label, unit]) => {
    const values = history.map((point) => point[key]).filter(Number.isFinite);
    if (values.length < 12) return null;
    const current = values.at(-1);
    const baseline = values.slice(0, -1);
    const zScore = (current - mean(baseline)) / standardDeviation(baseline);
    return { key, label, unit, current, zScore: +zScore.toFixed(2), unusual: Math.abs(zScore) >= 2 };
  }).filter(Boolean);
  const flagged = checks.filter((check) => check.unusual).sort((a, b) => Math.abs(b.zScore) - Math.abs(a.zScore));
  if (!checks.length) {
    return {
      available: false,
      generatedAt: new Date().toISOString(),
      location: { name: locationName, latitude, longitude, radiusKm, maxDepthM },
      message: `Not enough usable observations exist in the selected ${historyHours}-hour window. At least 12 readings for one variable are required.`,
      nearbyCount: nearby.length
    };
  }
  if (selectedOutlier) {
    const historicalCheck = checks.find((check) => check.label === selectedOutlier.metric);
    return {
      available: true,
      generatedAt: new Date().toISOString(),
      location: { name: locationName, latitude, longitude, radiusKm, maxDepthM },
      source: `NOAA NDBC station ${selectedPlatform.stationId}`,
      observedAt: selectedPlatform.observedAt,
      primary: {
        flagged: true,
        severity: selectedOutlier.severity,
        baseline: "Regional peer comparison",
        title: `Regional ${selectedOutlier.metric.toLowerCase()} outlier detected`,
        plainLanguage: `${selectedOutlier.value} ${selectedOutlier.unit} has a robust anomaly score of ${Math.abs(selectedOutlier.zScore).toFixed(1)} compared with fresh stations within 1,500 km.`,
        measurements: [
          `Current value: ${selectedOutlier.value} ${selectedOutlier.unit}`,
          `Regional median: ${selectedOutlier.regionalMedian} ${selectedOutlier.unit}`,
          selectedOutlier.comparison,
          historicalCheck
            ? `Against this station's own recent history: ${historicalCheck.zScore >= 0 ? "+" : ""}${historicalCheck.zScore}σ`
            : "This variable was not available in the station-history comparison"
        ],
        notConfirmed: "The regional and station-history baselines answer different questions. This marker remains flagged because it is extreme relative to peer stations."
      },
      patterns: [{
        title: "Baseline comparison",
        description: historicalCheck?.unusual
          ? "The reading is unusual against both regional peers and this station's own recent history."
          : "The reading is extreme relative to regional peers, even though it may be typical for this individual station."
      }]
    };
  }
  return {
    available: true,
    generatedAt: new Date().toISOString(),
    location: { name: locationName, latitude, longitude, radiusKm, maxDepthM },
    source: `NOAA NDBC station ${selectedPlatform.stationId}`,
    observedAt: selectedPlatform.observedAt,
    primary: flagged[0] ? {
      flagged: true,
      severity: "watch",
      baseline: "Station-history comparison",
      title: `${flagged[0].label} is unusual for this station's recent history`,
      plainLanguage: `The latest ${flagged[0].label.toLowerCase()} reading is ${flagged[0].current} ${flagged[0].unit}, ${Math.abs(flagged[0].zScore).toFixed(1)} standard deviations from the recent station average.`,
      measurements: checks.map((check) => `${check.label}: ${check.current} ${check.unit} (${check.zScore >= 0 ? "+" : ""}${check.zScore}σ)`),
      notConfirmed: "This is a statistical flag in a real surface observation series. It does not describe conditions below the buoy."
    } : {
      flagged: false,
      severity: "normal",
      baseline: "Station-history comparison",
      title: "No station-history anomaly detected",
      plainLanguage: "The latest available NOAA measurements are within two standard deviations of this station's recent history.",
      measurements: checks.map((check) => `${check.label}: ${check.current} ${check.unit} (${check.zScore >= 0 ? "+" : ""}${check.zScore}σ)`),
      notConfirmed: "This assessment covers only the variables measured by this surface station."
    },
    patterns: [{
      title: "Observed coverage",
      description: `${nearby.filter((platform) => platform.live).length} live NOAA stations are within ${radiusKm.toLocaleString()} km. This analysis uses only ${selectedPlatform.name}.`
    }]
  };
}

const json = (res, status, payload) => {
  res.writeHead(status, { "Content-Type": "application/json; charset=utf-8" });
  res.end(JSON.stringify(payload));
};

function mean(values) {
  return values.reduce((sum, value) => sum + value, 0) / values.length;
}

function standardDeviation(values) {
  const average = mean(values);
  return Math.sqrt(mean(values.map((value) => (value - average) ** 2))) || 0.001;
}

function pearson(xs, ys) {
  if (xs.length < 3 || xs.length !== ys.length) return 0;
  const mx = mean(xs);
  const my = mean(ys);
  const numerator = xs.reduce((sum, x, index) => sum + (x - mx) * (ys[index] - my), 0);
  const denominator = Math.sqrt(
    xs.reduce((sum, x) => sum + (x - mx) ** 2, 0) *
    ys.reduce((sum, y) => sum + (y - my) ** 2, 0)
  );
  return denominator ? numerator / denominator : 0;
}

function getOverview() {
  const waterTemperatures = ndbcPlatforms.map((platform) => platform.measurements.waterTemperatureC).filter(Number.isFinite);
  const waveHeights = ndbcPlatforms.map((platform) => platform.measurements.waveHeightM).filter(Number.isFinite);
  return {
    generatedAt: new Date().toISOString(),
    stationCount: ndbcPlatforms.length + ioosPlatforms.length,
    onlineCount: ndbcPlatforms.filter((platform) => platform.status === "live").length + ioosPlatforms.length,
    freshPlatformCount: ndbcPlatforms.filter((platform) => platform.status === "live").length + ioosPlatforms.length,
    surfaceStationCount: ndbcPlatforms.length,
    underwaterPlatformCount: ioosPlatforms.length,
    underwaterObservationCount: ioosSync.observationCount,
    reportingWaterTemperature: waterTemperatures.length,
    reportingWaveHeight: waveHeights.length,
    averageTemperature: waterTemperatures.length ? +mean(waterTemperatures).toFixed(1) : null,
    averageWaveHeight: waveHeights.length ? +mean(waveHeights).toFixed(1) : null,
    source: "NOAA NDBC latest observations"
  };
}

async function readBody(req) {
  let body = "";
  for await (const chunk of req) {
    body += chunk;
    if (body.length > 1_000_000) throw new Error("Payload too large");
  }
  return JSON.parse(body || "{}");
}

async function handleApi(req, res, url) {
  if (req.method === "GET" && url.pathname === "/api/health") {
    return json(res, 200, {
      status: "ok",
      service: "oceanlens-ai",
      generatedAt: new Date().toISOString(),
      feeds: {
        noaaNdbc: ndbcSync.status,
        ioosGliders: ioosSync.status
      }
    });
  }
  if (req.method === "GET" && url.pathname === "/api/overview") {
    return json(res, 200, getOverview());
  }
  if (req.method === "GET" && url.pathname === "/api/stations") {
    return json(res, 410, { error: "Retired demo endpoint. Use /api/global/platforms for live NOAA and IOOS platforms." });
  }
  if (req.method === "GET" && url.pathname === "/api/observations") {
    return json(res, 410, { error: "Retired demo endpoint. Use /api/location-timeseries with a live platformId." });
  }
  if (req.method === "GET" && url.pathname === "/api/insights") {
    return json(res, 410, { error: "Retired demo endpoint. Use /api/location-insights with a live platformId." });
  }
  if (req.method === "GET" && url.pathname === "/api/global/platforms") {
    const latitude = Math.max(-90, Math.min(90, Number(url.searchParams.get("lat")) || 0));
    const longitude = Math.max(-180, Math.min(180, Number(url.searchParams.get("lon")) || 0));
    const radiusKm = Math.max(50, Math.min(5000, Number(url.searchParams.get("radiusKm")) || 1200));
    const ranked = getRankedPlatforms(latitude, longitude);
    const nearby = ranked.filter((platform) => platform.distanceKm <= radiusKm);
    return json(res, 200, {
      query: { latitude, longitude, radiusKm },
      platforms: allPlatforms(),
      nearby,
      nearest: ranked.slice(0, 6),
      coverage: nearby.length
        ? `${nearby.length} platform${nearby.length === 1 ? "" : "s"} within ${radiusKm.toLocaleString()} km`
        : `No in-situ platforms within ${radiusKm.toLocaleString()} km`,
      catalogNotice: "Only currently connected NOAA NDBC and IOOS Glider DAC platforms are returned."
    });
  }
  if (req.method === "GET" && url.pathname === "/api/live/status") {
    return json(res, 200, {
      noaaNdbc: ndbcSync,
      ioosGliders: ioosSync,
      ooi: ooiSync,
      feed: NDBC_LATEST_URL,
      refreshIntervalMinutes: 10,
      storage: {
        mode: "ephemeral",
        persistence: false,
        message: "Live data is held in memory and overwritten or discarded when the server restarts."
      }
    });
  }
  if (req.method === "GET" && url.pathname === "/api/oceanlens/point") {
    const latitude = Math.max(-90, Math.min(90, Number(url.searchParams.get("lat")) || 0));
    const longitude = Math.max(-180, Math.min(180, Number(url.searchParams.get("lon")) || 0));
    const radiusKm = Math.max(1, Math.min(500, Number(url.searchParams.get("radiusKm")) || 25));
    const hours = Math.max(1, Math.min(24 * 30, Number(url.searchParams.get("hours")) || 72));
    const selectedPlatform = allPlatforms().find((platform) => platform.id === url.searchParams.get("platformId")) || null;
    const result = findPointMatches(latitude, longitude, radiusKm, hours, 10, 24);
    const selectedSensor = selectedPlatform
      ? result.sensors.find((record) => record.sensor_id === selectedPlatform.id) || null
      : null;
    const latestSensor = selectedSensor || result.sensors[0] || null;
    const bestMatch = latestSensor
      ? result.matches.find((match) =>
          match.sensor.sensor_id === latestSensor.sensor_id
          && match.sensor.timestamp === latestSensor.timestamp
        ) || null
      : null;
    return json(res, 200, {
      query: { latitude, longitude, radiusKm, hours, matchRadiusKm: 10, matchHours: 24 },
      selected_platform_id: selectedPlatform?.id || null,
      latest_sensor: latestSensor,
      latest_satellite: result.satellites[0] || null,
      best_match: bestMatch,
      counts: {
        sensor_records: result.sensors.length,
        satellite_records: result.satellites.length,
        matched_pairs: result.matches.length
      },
      storage: "ephemeral",
      notice: result.satellites.length
        ? "Analytical satellite records are available for this point."
        : "No analytical satellite record has been ingested for this point. Basemap imagery is not treated as measurement data."
    });
  }
  if (req.method === "GET" && url.pathname === "/api/oceanlens/anomaly-map") {
    const outliers = buildExtremeSurfaceOutliers();
    return json(res, 200, {
      generated_at: new Date().toISOString(),
      source: "NOAA NDBC latest observations",
      method: "Absolute robust z-score of at least 4 using median absolute deviation among fresh reporting stations within 1,500 km",
      count: outliers.length,
      outliers,
      warning: "Only observations no more than 24 hours old are included. These are cross-station surface outliers, not confirmed hazards or subsurface anomalies."
    });
  }
  if (req.method === "GET" && url.pathname === "/api/oceanlens/outlier-history") {
    const outlier = buildExtremeSurfaceOutliers().find((item) => item.id === url.searchParams.get("outlierId"));
    if (!outlier) return json(res, 404, { error: "Outlier not found" });
    const historyHours = Math.max(24, Math.min(720, Number(url.searchParams.get("historyHours")) || 168));
    try {
      return json(res, 200, {
        outlierId: outlier.id,
        platformId: outlier.platformId,
        metric: outlier.metric,
        regional: { unusual: true, zScore: outlier.zScore, median: outlier.regionalMedian },
        stationHistory: await buildOutlierHistoryComparison(outlier, historyHours)
      });
    } catch (error) {
      return json(res, 200, {
        outlierId: outlier.id,
        metric: outlier.metric,
        regional: { unusual: true, zScore: outlier.zScore, median: outlier.regionalMedian },
        stationHistory: { available: false, historyHours, message: `Station history is unavailable: ${error.message}` }
      });
    }
  }
  if (req.method === "GET" && url.pathname === "/api/oceanlens/layer-strategy") {
    const latitude = Math.max(-90, Math.min(90, Number(url.searchParams.get("lat")) || 0));
    const longitude = Math.max(-180, Math.min(180, Number(url.searchParams.get("lon")) || 0));
    const selectedPlatform = allPlatforms().find((platform) => platform.id === url.searchParams.get("platformId")) || null;
    try {
      return json(res, 200, await buildImageryStrategy(latitude, longitude, selectedPlatform));
    } catch (error) {
      return json(res, 200, {
        generated_at: new Date().toISOString(),
        location: { latitude, longitude },
        decision: { selected: "sensors-only", reason: `Imagery catalogues are unavailable: ${error.message}` },
        optical: { available: false },
        sar: { available: false },
        nisar: { available: false, status: "not connected" },
        underwater: selectedPlatform ? { available: true, source: selectedPlatform.provider, max_depth_m: selectedPlatform.maxDepthM } : { available: false }
      });
    }
  }
  if (req.method === "POST" && url.pathname === "/api/oceanlens/sensors") {
    try {
      const input = await readBody(req);
      if (!input.sensor_id || input.latitude === undefined || input.longitude === undefined || !input.timestamp) {
        return json(res, 400, { error: "sensor_id, latitude, longitude, and timestamp are required" });
      }
      const record = canonicalSensorRecord(input);
      upsertSensorRecord(record);
      return json(res, 201, record);
    } catch (error) {
      return json(res, 400, { error: error.message });
    }
  }
  if (req.method === "POST" && url.pathname === "/api/oceanlens/satellites") {
    try {
      const input = await readBody(req);
      if (!input.satellite_source || !input.image_date || input.latitude === undefined || input.longitude === undefined) {
        return json(res, 400, { error: "satellite_source, image_date, latitude, and longitude are required" });
      }
      const record = canonicalSatelliteRecord(input);
      satelliteRecords.set(record.record_id, record);
      if (satelliteRecords.size > 1000) satelliteRecords.delete(satelliteRecords.keys().next().value);
      return json(res, 201, record);
    } catch (error) {
      return json(res, 400, { error: error.message });
    }
  }
  if (req.method === "GET" && url.pathname === "/api/oceanlens/ai") {
    const latitude = Math.max(-90, Math.min(90, Number(url.searchParams.get("lat")) || 0));
    const longitude = Math.max(-180, Math.min(180, Number(url.searchParams.get("lon")) || 0));
    const selectedPlatform = allPlatforms().find((platform) => platform.id === url.searchParams.get("platformId")) || null;
    const historyHours = Math.max(24, Math.min(720, Number(url.searchParams.get("historyHours")) || 168));
    try {
      return json(res, 200, await buildOceanLensAi(latitude, longitude, selectedPlatform, historyHours));
    } catch (error) {
      return json(res, 200, { error: error.message, location: { latitude, longitude } });
    }
  }
  if (req.method === "POST" && url.pathname === "/api/live/sync") {
    const [noaaNdbc, ioosGliders] = await Promise.all([syncNdbc(), syncIoos()]);
    return json(res, 200, { noaaNdbc, ioosGliders, ooi: ooiSync });
  }
  if (req.method === "GET" && url.pathname === "/api/depth-profile") {
    const latitude = Math.max(-90, Math.min(90, Number(url.searchParams.get("lat")) || 0));
    const longitude = Math.max(-180, Math.min(180, Number(url.searchParams.get("lon")) || 0));
    const selectedPlatform = allPlatforms().find((platform) => platform.id === url.searchParams.get("platformId")) || null;
    return json(res, 200, buildDepthProfile(latitude, longitude, Number(url.searchParams.get("maxDepthM")), selectedPlatform));
  }
  if (req.method === "GET" && url.pathname === "/api/location-timeseries") {
    const latitude = Math.max(-90, Math.min(90, Number(url.searchParams.get("lat")) || 0));
    const longitude = Math.max(-180, Math.min(180, Number(url.searchParams.get("lon")) || 0));
    const selectedPlatform = allPlatforms().find((platform) => platform.id === url.searchParams.get("platformId")) || null;
    const historyHours = Math.max(24, Math.min(720, Number(url.searchParams.get("historyHours")) || 168));
    try {
      return json(res, 200, await buildLocationTimeSeries(latitude, longitude, url.searchParams.get("name") || "", selectedPlatform, historyHours));
    } catch (error) {
      return json(res, 200, {
        available: false,
        location: { name: url.searchParams.get("name") || "", latitude, longitude },
        points: [],
        message: `NOAA history is unavailable for this station: ${error.message}`
      });
    }
  }
  if (req.method === "GET" && url.pathname === "/api/location-insights") {
    const latitude = Math.max(-90, Math.min(90, Number(url.searchParams.get("lat")) || 0));
    const longitude = Math.max(-180, Math.min(180, Number(url.searchParams.get("lon")) || 0));
    const radiusKm = Math.max(50, Math.min(5000, Number(url.searchParams.get("radiusKm")) || 1200));
    const maxDepthM = Math.max(100, Math.min(6000, Number(url.searchParams.get("maxDepthM")) || 2000));
    const locationName = url.searchParams.get("name") || "";
    const selectedPlatform = allPlatforms().find((platform) => platform.id === url.searchParams.get("platformId")) || null;
    const selectedOutlier = buildExtremeSurfaceOutliers().find((outlier) => outlier.id === url.searchParams.get("outlierId")) || null;
    const historyHours = Math.max(24, Math.min(720, Number(url.searchParams.get("historyHours")) || 168));
    try {
      return json(res, 200, await buildLocationInsights(latitude, longitude, radiusKm, maxDepthM, locationName, selectedPlatform, selectedOutlier, historyHours));
    } catch (error) {
      return json(res, 200, {
        available: false,
        generatedAt: new Date().toISOString(),
        location: { name: locationName, latitude, longitude, radiusKm, maxDepthM },
        message: `Real NOAA history is unavailable, so no analysis was produced: ${error.message}`
      });
    }
  }
  if (req.method === "POST" && url.pathname === "/api/ingest") {
    return json(res, 410, { error: "Retired demo endpoint. Submit canonical real observations to /api/oceanlens/sensors." });
  }
  return json(res, 404, { error: "Not found" });
}

const mimeTypes = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".svg": "image/svg+xml"
};

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host || "localhost"}`);
  if (url.pathname.startsWith("/api/")) return handleApi(req, res, url);

  const requested = url.pathname === "/" ? "index.html" : url.pathname.slice(1);
  const filePath = normalize(join(publicDir, requested));
  if (!filePath.startsWith(publicDir)) {
    res.writeHead(403);
    return res.end("Forbidden");
  }
  try {
    const content = await readFile(filePath);
    res.writeHead(200, { "Content-Type": mimeTypes[extname(filePath)] || "application/octet-stream" });
    res.end(content);
  } catch {
    res.writeHead(404);
    res.end("Not found");
  }
});

const port = Number(process.env.PORT) || 3000;
const [initialNdbcStatus, initialIoosStatus] = await Promise.all([syncNdbc(), syncIoos()]);
server.listen(port, () => {
  console.log(`OceanLens AI is running at http://localhost:${port}`);
  console.log(`NOAA NDBC feed: ${initialNdbcStatus.status} (${initialNdbcStatus.stationCount} stations)`);
  console.log(`IOOS Glider feed: ${initialIoosStatus.status} (${initialIoosStatus.datasetCount} datasets, ${initialIoosStatus.observationCount} observations)`);
  console.log("OOI direct M2M: credentials required; OOI gliders are relayed through IOOS");
});

setInterval(syncNdbc, 10 * 60_000).unref();
setInterval(syncIoos, 15 * 60_000).unref();
