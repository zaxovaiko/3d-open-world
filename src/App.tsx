import { useState } from "react";
import type { LatLon } from "./types";
import { StartScreen } from "./ui/start-screen";
import { Scene } from "./game/scene";

export default function App() {
  const [origin, setOrigin] = useState<LatLon | null>(null);
  if (!origin) return <StartScreen onStart={setOrigin} />;
  return <Scene origin={origin} />;
}
