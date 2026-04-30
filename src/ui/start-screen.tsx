import { useState } from "react";
import type { LatLon } from "../types";

type Props = { onStart: (origin: LatLon) => void };

const PRESETS: Array<{ name: string; lat: number; lon: number }> = [
  { name: "Warsaw", lat: 52.2297, lon: 21.0122 },
  { name: "Wrocław", lat: 51.1079, lon: 17.0385 },
  { name: "Manhattan", lat: 40.758, lon: -73.9855 },
  { name: "Paris", lat: 48.8566, lon: 2.3522 },
  { name: "Tokyo", lat: 35.6762, lon: 139.6503 },
];

export function StartScreen({ onStart }: Props) {
  const [lat, setLat] = useState("52.2297");
  const [lon, setLon] = useState("21.0122");
  const [err, setErr] = useState<string | null>(null);

  const submit = () => {
    const la = parseFloat(lat);
    const lo = parseFloat(lon);
    if (!Number.isFinite(la) || la < -90 || la > 90) return setErr("Bad latitude (-90..90)");
    if (!Number.isFinite(lo) || lo < -180 || lo > 180) return setErr("Bad longitude (-180..180)");
    setErr(null);
    onStart({ lat: la, lon: lo });
  };

  return (
    <div className="start">
      <div className="card">
        <h1>3D Map Ride</h1>
        <p>Drive a car through a 3D world built live from OpenStreetMap.</p>
        <div className="row">
          <label>
            Latitude
            <input value={lat} onChange={(e) => setLat(e.target.value)} />
          </label>
          <label>
            Longitude
            <input value={lon} onChange={(e) => setLon(e.target.value)} />
          </label>
        </div>
        <div className="presets">
          {PRESETS.map((p) => (
            <button
              key={p.name}
              type="button"
              onClick={() => {
                setLat(String(p.lat));
                setLon(String(p.lon));
              }}
            >
              {p.name}
            </button>
          ))}
        </div>
        {err && <div className="err">{err}</div>}
        <button className="primary" onClick={submit}>
          Start driving
        </button>
        <p className="tip">
          Tip: pick any place from{" "}
          <a href="https://openstreetmap.org" target="_blank" rel="noreferrer">
            openstreetmap.org
          </a>{" "}
          and copy its lat/lon.
        </p>
      </div>
    </div>
  );
}
