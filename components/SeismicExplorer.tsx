"use client";
import { useEffect, useRef, useState } from "react";
import esriConfig from "@arcgis/core/config";
import Map from "@arcgis/core/Map";
import SceneView from "@arcgis/core/views/SceneView";
import SceneLayer from "@arcgis/core/layers/SceneLayer";
import FeatureLayer from "@arcgis/core/layers/FeatureLayer";
import GraphicsLayer from "@arcgis/core/layers/GraphicsLayer";
import Graphic from "@arcgis/core/Graphic";
import Point from "@arcgis/core/geometry/Point";
import Legend from "@arcgis/core/widgets/Legend";
import * as reactiveUtils from "@arcgis/core/core/reactiveUtils";
import {
  suggestLocations,
  addressToLocations,
  locationToAddress,
} from "@arcgis/core/rest/locator";
import "@arcgis/core/assets/esri/themes/light/main.css";
import styles from "./SeismicExplorer.module.css";

const BUILDINGS =
  "https://services.arcgis.com/aA3snZwJfFkVyDuP/arcgis/rest/services/SBCounty_3D_Basemap_2021_WSL1/SceneServer/layers/0";
const FOOTPRINTS =
  "https://services.arcgis.com/aA3snZwJfFkVyDuP/arcgis/rest/services/2D_Building_Footprints_2021/FeatureServer/0";
const FAULTS =
  "https://services.arcgis.com/aA3snZwJfFkVyDuP/arcgis/rest/services/Alquist_Priolo_EQ_Fault_Zones/FeatureServer/0";
const GEOCODE =
  "https://geocode-api.arcgis.com/arcgis/rest/services/World/GeocodeServer";

const GITHUB = "https://github.com/Fern-Nunez/Seismic-Exposure-Explorer";

const fill = (color: string) => ({
  type: "mesh-3d",
  symbolLayers: [
    {
      type: "fill",
      material: { color },
      edges: { type: "solid", color: [50, 50, 50, 0.4], size: 0.5 },
    },
  ],
});

const heightRenderer = {
  type: "class-breaks",
  field: "Height",
  defaultSymbol: fill("#cfd8dc"),
  defaultLabel: "Unknown",
  classBreakInfos: [
    { minValue: 0, maxValue: 15, symbol: fill("#d9ed92"), label: "Under 15" },
    { minValue: 15, maxValue: 30, symbol: fill("#76c893"), label: "15 – 30" },
    { minValue: 30, maxValue: 60, symbol: fill("#34a0a4"), label: "30 – 60" },
    { minValue: 60, maxValue: 99999, symbol: fill("#1e6091"), label: "60+" },
  ],
} as any;

const pinSymbol = (color: string) =>
  ({
    type: "point-3d",
    symbolLayers: [
      {
        type: "icon",
        size: 14,
        resource: { primitive: "circle" },
        material: { color },
        outline: { color: "#ffffff", size: 2 },
      },
    ],
    verticalOffset: { screenLength: 44, maxWorldLength: 300, minWorldLength: 30 },
    callout: { type: "line", size: 1.5, color, border: { color: "#ffffff" } },
  }) as any;

const DISTANCE_STEPS = [0.25, 0.5, 1, 2, 5, 10, 25];

type Suggestion = { text: string; magicKey: string };

type Result = {
  label: string;
  height?: number;
  parcel?: string;
  inZone: boolean;
  quad?: string;
  nearestMiles?: number | null;
} | null;

export default function SeismicExplorer() {
  const mapRef = useRef<HTMLDivElement>(null);
  const viewRef = useRef<SceneView | null>(null);
  const faultsRef = useRef<FeatureLayer | null>(null);
  const footprintsRef = useRef<FeatureLayer | null>(null);
  const pinsRef = useRef<GraphicsLayer | null>(null);
  const justPickedRef = useRef(false);

  const [result, setResult] = useState<Result>(null);
  const [showFaults, setShowFaults] = useState(true);
  const [busy, setBusy] = useState(false);
  const [query, setQuery] = useState("");
  const [suggestions, setSuggestions] = useState<Suggestion[]>([]);
  const [focused, setFocused] = useState(false);
  const [ready, setReady] = useState(false);
  const [locating, setLocating] = useState(false);
  const [locationError, setLocationError] = useState<string | null>(null);

  useEffect(() => {
    if (!mapRef.current) return;

    const apiKey = process.env.NEXT_PUBLIC_ARCGIS_API_KEY;
    if (apiKey) esriConfig.apiKey = apiKey;

    const buildings = new SceneLayer({
      url: BUILDINGS,
      renderer: heightRenderer,
      outFields: ["Height", "ParcelNumb"],
      popupEnabled: false,
    });

    const faults = new FeatureLayer({
      url: FAULTS,
      outFields: ["QUAD_NAME"],
      opacity: 0.45,
      elevationInfo: { mode: "on-the-ground" },
      renderer: {
        type: "simple",
        symbol: {
          type: "simple-fill",
          color: [214, 40, 40, 0.35],
          outline: { color: [214, 40, 40, 0.9], width: 1.5 },
        },
      } as any,
    });
    faultsRef.current = faults;

    // Query-only, never added to the map. Gives us the real building outline so
    // a footprint straddling a zone boundary is judged by the whole polygon
    // rather than the single point the click ray happened to hit.
    const footprints = new FeatureLayer({ url: FOOTPRINTS });
    footprintsRef.current = footprints;

    const pins = new GraphicsLayer({ elevationInfo: { mode: "relative-to-scene" } });
    pinsRef.current = pins;

    const view = new SceneView({
      container: mapRef.current,
      map: new Map({
        basemap: apiKey ? "arcgis/topographic" : "osm",
        ground: apiKey ? "world-elevation" : undefined,
        layers: [faults, buildings, pins],
      }),
      camera: {
        position: { longitude: -117.29, latitude: 34.06, z: 4000 },
        tilt: 62,
        heading: 20,
      },
      constraints: { altitude: { min: 250 } },
    });
    viewRef.current = view;

    if (window.innerWidth > 640) {
      view.ui.add(new Legend({ view }), "bottom-right");
    }

    // Hide the loading overlay once the buildings have actually finished drawing
    view
      .when(() => view.whenLayerView(buildings))
      .then((layerView) => reactiveUtils.whenOnce(() => !layerView.updating))
      .then(() => setReady(true))
      .catch(() => setReady(true));

    view.on("click", async (event) => {
      const hit = await view.hitTest(event, { include: [buildings] });
      const hitResult = hit.results.find((r: any) => r.graphic?.layer === buildings) as any;
      const graphic = hitResult?.graphic;
      if (!graphic) return;

      // Fetch the clicked building's outline; fall back to the click point
      let outline: any;
      try {
        const fp = await footprints.queryFeatures({
          geometry: event.mapPoint,
          spatialRelationship: "intersects",
          returnGeometry: true,
          outFields: ["ParcelNumb", "Height"],
        });
        outline = fp.features[0]?.geometry;
      } catch {
        outline = undefined;
      }

      await evaluate(
        event.mapPoint,
        "Selected building",
        {
          height: graphic.attributes.Height,
          parcel: graphic.attributes.ParcelNumb,
        },
        false,
        outline
      );
    });

    return () => {
      view.destroy();
      viewRef.current = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    if (faultsRef.current) faultsRef.current.visible = showFaults;
  }, [showFaults]);

  // Debounced address suggestions
  useEffect(() => {
    if (justPickedRef.current) {
      justPickedRef.current = false;
      setSuggestions([]);
      return;
    }
    if (query.trim().length < 3) {
      setSuggestions([]);
      return;
    }
    const timer = setTimeout(async () => {
      try {
        const res = await suggestLocations(GEOCODE, {
          text: query,
          location: viewRef.current?.center,
          maxSuggestions: 6,
        } as any);
        setSuggestions(res.map((s: any) => ({ text: s.text, magicKey: s.magicKey })));
      } catch {
        setSuggestions([]);
      }
    }, 250);
    return () => clearTimeout(timer);
  }, [query]);

  async function nearestZoneMiles(geometry: any) {
    const faults = faultsRef.current!;
    for (const miles of DISTANCE_STEPS) {
      const res = await faults.queryFeatures({
        geometry,
        distance: miles,
        units: "miles",
        spatialRelationship: "intersects",
        returnGeometry: false,
        outFields: ["QUAD_NAME"],
      });
      if (res.features.length > 0) return miles;
    }
    return null;
  }

  async function evaluate(
    point: any,
    label: string,
    extra: Partial<NonNullable<Result>> = {},
    pin = false,
    queryGeometry?: any
  ) {
    setBusy(true);
    const faults = faultsRef.current!;

    // An address is genuinely a point; a building is judged by its whole outline
    const target = queryGeometry ?? point;

    const zones = await faults.queryFeatures({
      geometry: target,
      spatialRelationship: "intersects",
      outFields: ["QUAD_NAME"],
      returnGeometry: false,
    });
    const inZone = zones.features.length > 0;
    const nearestMiles = inZone ? null : await nearestZoneMiles(target);

    if (pin && pinsRef.current) {
      pinsRef.current.removeAll();
      pinsRef.current.add(
        new Graphic({ geometry: point, symbol: pinSymbol(inZone ? "#d62828" : "#1b5e20") })
      );
    }

    setResult({
      label,
      inZone,
      quad: zones.features[0]?.attributes.QUAD_NAME,
      nearestMiles,
      ...extra,
    });
    setBusy(false);
  }

  async function pickSuggestion(s: Suggestion) {
    justPickedRef.current = true;
    setQuery(s.text);
    setSuggestions([]);
    setFocused(false);

    const candidates = await addressToLocations(GEOCODE, {
      address: { SingleLine: s.text },
      magicKey: s.magicKey,
      maxLocations: 1,
      outFields: ["*"],
    } as any);
    const point = candidates[0]?.location;
    if (!point) return;

    viewRef.current?.goTo({ target: point, zoom: 16, tilt: 55, heading: 30 }, { duration: 2000 });
    await evaluate(point, s.text, {}, true);
  }

  function useMyLocation() {
    setLocationError(null);

    if (!navigator.geolocation) {
      setLocationError("Location isn't available in this browser.");
      return;
    }

    setLocating(true);
    navigator.geolocation.getCurrentPosition(
      async (position) => {
        const point = new Point({
          longitude: position.coords.longitude,
          latitude: position.coords.latitude,
        });

        setFocused(false);
        setSuggestions([]);
        viewRef.current?.goTo(
          { target: point, zoom: 16, tilt: 55, heading: 30 },
          { duration: 2000 }
        );

        let label = "Your location";
        try {
          const address = await locationToAddress(GEOCODE, { location: point } as any);
          if (address?.address) {
            label = address.address;
            justPickedRef.current = true;
            setQuery(address.address);
          }
        } catch {
          // Reverse geocoding is a nicety — carry on without it
        }

        await evaluate(point, label, {}, true);
        setLocating(false);
      },
      () => {
        setLocationError("Couldn't get your location. Check browser permissions.");
        setLocating(false);
      },
      { enableHighAccuracy: true, timeout: 10000 }
    );
  }

  function clearSearch() {
    justPickedRef.current = true;
    setQuery("");
    setSuggestions([]);
    setResult(null);
    setLocationError(null);
    pinsRef.current?.removeAll();
  }

  const dropdownOpen = focused || suggestions.length > 0;

  return (
    <div className={styles.root}>
      <div ref={mapRef} className={styles.map} />

      {!ready && (
        <div className={styles.loading}>
          <div className={styles.loadingInner}>
            <div className={styles.spinner} />
            <p className={styles.loadingTitle}>Seismic Exposure Explorer</p>
          </div>
        </div>
      )}

      <div className={styles.search}>
        <div className={styles.searchBar}>
          <input
            className={styles.searchInput}
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            onFocus={() => setFocused(true)}
            onBlur={() => setTimeout(() => setFocused(false), 150)}
            placeholder="Search an address in San Bernardino County"
            aria-label="Search an address"
          />
          {query && (
            <button className={styles.clearButton} onClick={clearSearch} aria-label="Clear">
              ×
            </button>
          )}
        </div>

        {dropdownOpen && (
          <div className={styles.dropdown}>
            <button
              className={styles.locationButton}
              onMouseDown={(e) => e.preventDefault()}
              onClick={useMyLocation}
              disabled={locating}
            >
              <span className={styles.locationIcon}>◎</span>
              {locating ? "Finding your location…" : "Use my current location"}
            </button>

            {locationError && <p className={styles.locationError}>{locationError}</p>}

            {suggestions.length > 0 && (
              <ul className={styles.suggestions}>
                {suggestions.map((s) => (
                  <li key={s.magicKey}>
                    <button
                      className={styles.suggestion}
                      onMouseDown={(e) => e.preventDefault()}
                      onClick={() => pickSuggestion(s)}
                    >
                      {s.text}
                    </button>
                  </li>
                ))}
              </ul>
            )}
          </div>
        )}
      </div>

      <aside className={styles.panel}>
        <h1 className={styles.title}>Seismic Exposure Explorer</h1>
        <p className={styles.subtitle}>
          San Bernardino County buildings and Alquist-Priolo earthquake fault zones. Search an
          address or click a building.
        </p>

        <label className={styles.toggle}>
          <input
            type="checkbox"
            checked={showFaults}
            onChange={(e) => setShowFaults(e.target.checked)}
          />
          Show fault zones
        </label>

        {busy && <p className={styles.busy}>Checking…</p>}

        {result && !busy && (
          <div className={styles.result}>
            <p className={styles.resultLabel}>{result.label}</p>

            <div className={`${styles.verdict} ${result.inZone ? styles.inZone : styles.outZone}`}>
              {result.inZone ? "In an earthquake fault zone" : "Not in a fault zone"}
            </div>

            <dl className={styles.facts}>
              {result.quad && (
                <>
                  <dt>Zone</dt>
                  <dd>{result.quad}</dd>
                </>
              )}
              {!result.inZone && (
                <>
                  <dt>Nearest zone</dt>
                  <dd>
                    {result.nearestMiles == null
                      ? "More than 25 miles"
                      : `Within ${result.nearestMiles} mi`}
                  </dd>
                </>
              )}
              {result.height != null && (
                <>
                  <dt>Height</dt>
                  <dd>{Math.round(result.height)}</dd>
                </>
              )}
              {result.parcel && (
                <>
                  <dt>Parcel</dt>
                  <dd>{result.parcel}</dd>
                </>
              )}
            </dl>
          </div>
        )}

        <p className={styles.credit}>
          Prototype — not for official use. Data: San Bernardino County · California Geological
          Survey.
          <br />
          Built by Fernando Nuñez ·{" "}
          <a href={GITHUB} target="_blank" rel="noreferrer">
            Source
          </a>
        </p>
      </aside>
    </div>
  );
}