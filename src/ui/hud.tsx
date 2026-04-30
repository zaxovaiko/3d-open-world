import { forwardRef } from "react";

export type HudHandle = {
  setSpeed: (kmh: number) => void;
};

export const Hud = forwardRef<HTMLDivElement>(function Hud(_, ref) {
  return (
    <div className="hud">
      <div className="speed" ref={ref}>0 km/h</div>
      <div className="help">
        WASD / arrows · drive&nbsp;&nbsp;Space · brake&nbsp;&nbsp;R · reset
      </div>
    </div>
  );
});
