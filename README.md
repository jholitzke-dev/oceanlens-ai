# OceanLens AI

A dependency-light MVP for collecting NOAA, IOOS, and OOI ocean observations, matching optional satellite records, and surfacing evidence-based anomalies.

## Run it

Requires Node.js 22.5 or newer.

```powershell
npm start
```

Open `http://localhost:3000`.

The app uses an in-memory runtime store. Data resets whenever the server restarts.

## What is included

- A responsive marine-operations dashboard
- A searchable global ocean map accepting named regions or exact coordinates
- Esri World Imagery basemap for visual context only
- Live NOAA NDBC buoy and IOOS Glider DAC discovery with coverage-gap reporting
- A surface-to-6,000 m depth anomaly explorer that distinguishes satellite, profiling, Deep Argo, and sonar evidence
- Automatic synchronization of NOAA NDBC's free public latest-observations feed every 10 minutes
- Real underwater glider profiles from the public IOOS Glider DAC
- OOI Endurance and Pioneer glider observations relayed through IOOS
- Ephemeral storage with no long-term database retention
- Real NOAA NDBC station observations and station history
- Time-series views for the variables actually reported by a selected NOAA station
- Evidence-based statistical flags computed only from real station history
- A JSON ingestion endpoint for real devices or data pipelines

## Ingest a reading

```powershell
Invoke-RestMethod -Method Post -Uri http://localhost:3000/api/oceanlens/sensors `
  -ContentType "application/json" `
  -Body '{
    "sensor_id": "your-real-sensor-id",
    "latitude": 36.72,
    "longitude": -122.08,
    "timestamp": "2026-06-20T12:00:00Z",
    "depth_meters": 20,
    "temperature": 12.4,
    "salinity": 33.7,
    "dissolved_oxygen": 7.9,
    "chlorophyll": 1.8,
    "turbidity": 1.2,
    "source": "your instrument or provider",
    "provenance": "observed"
  }'
```

## Production path

1. Add MQTT/LoRaWAN or vendor webhooks for deployed instruments.
2. Add a satellite pipeline for Sentinel-2/3, Landsat, or a commercial provider.
3. Move SQLite to PostgreSQL + PostGIS and store imagery in object storage.
4. Add calibration, quality flags, lineage, units, and device health tables.
5. Train spatial-temporal models after enough labeled field data exists.
6. Add authentication, organizations, alert routing, and audit logging.

The app does not generate simulated environmental readings. Unsupported points and depths display an unavailable state.

## Global explorer status

The satellite basemap is requested from Esri and is visual context only; it is never treated as measurement data. The operational platform map contains only currently connected NOAA NDBC and IOOS Glider DAC feeds. Additional Argo, OOI, and regional ERDDAP connectors can be added later.

Depth results appear only when a selected platform provides a real profile; surface buoys and unsupported points remain unavailable.

Public IOOS and OOI glider profiles activate real depth views when selected. Direct OOI M2M access for fixed and cabled arrays requires OOI API credentials.

NOAA NDBC stations and their latest reported water temperature, air temperature, wind, waves, and pressure are live public observations. Click the live-status pill to request an immediate refresh.

## Data retention

- NOAA snapshots overwrite the previous in-memory feed cache.
- Device ingestion retains at most 500 readings per station and source while the server is running.
- Restarting the server clears all runtime observations.
- No production database or historical archive is required in this mode.
