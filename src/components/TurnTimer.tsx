"use client";

import { useState, useEffect } from "react";

interface TurnTimerProps {
  deadline: string;
  isYourTurn: boolean;
}

export function TurnTimer({ deadline, isYourTurn }: TurnTimerProps) {
  const [remaining, setRemaining] = useState("");
  const [urgent, setUrgent] = useState(false);

  useEffect(() => {
    function tick() {
      const ms = new Date(deadline).getTime() - Date.now();
      if (ms <= 0) {
        setRemaining("0:00:00");
        setUrgent(true);
        return;
      }
      const h = Math.floor(ms / 3600000);
      const m = Math.floor((ms % 3600000) / 60000);
      const s = Math.floor((ms % 60000) / 1000);
      setRemaining(`${h}:${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}`);
      setUrgent(ms < 3600000);
    }
    tick();
    const id = setInterval(tick, 1000);
    return () => clearInterval(id);
  }, [deadline]);

  const color = urgent ? "text-red-400" : isYourTurn ? "text-yellow-400" : "text-green-700";

  return (
    <span className={`${color} text-xs tabular-nums`} title={isYourTurn ? "Time remaining for your turn" : "Time remaining for current player"}>
      ⏱ {remaining}
    </span>
  );
}
