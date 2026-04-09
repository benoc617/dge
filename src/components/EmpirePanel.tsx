"use client";

import { useState } from "react";
import type { GameState } from "@/lib/srx-game-types";
import { EMPIRE as EMPIRE_TT, EMPIRE_UNITS } from "@/lib/ui-tooltips";
import { MIL } from "@/lib/game-constants";
import Tooltip from "@/components/Tooltip";

function StatBox({
  label,
  value,
  color,
  wide,
  tip,
}: {
  label: string;
  value: string | number;
  color?: string;
  wide?: boolean;
  tip?: string;
}) {
  const inner = (
    <div className={`border border-green-900 p-1.5 text-center cursor-help ${wide ? "col-span-2" : ""}`}>
      <div className={`text-xs font-bold leading-tight ${color ?? "text-green-300"}`}>
        {typeof value === "number" ? value.toLocaleString() : value}
      </div>
      <div className="text-[8px] text-green-700 uppercase tracking-wider leading-tight mt-0.5">{label}</div>
    </div>
  );
  if (!tip) return inner;
  return <Tooltip tip={tip}>{inner}</Tooltip>;
}

function MiniStat({ label, value, color, tip }: { label: string; value: string | number; color?: string; tip?: string }) {
  const inner = (
    <div className="border border-green-900 px-1 py-0.5 text-center cursor-help">
      <div className={`text-[10px] font-bold leading-tight ${color ?? "text-green-300"}`}>
        {typeof value === "number" ? value.toLocaleString() : value}
      </div>
      <div className="text-[7px] text-green-700 uppercase tracking-wider leading-tight">{label}</div>
    </div>
  );
  if (!tip) return inner;
  return <Tooltip tip={tip}>{inner}</Tooltip>;
}

export default function EmpirePanel({ state }: { state: GameState }) {
  const { empire, army, planets, planetSummary } = state;
  const [planetsExpanded, setPlanetsExpanded] = useState(false);

  const civilColors: Record<number, string> = {
    0: "text-green-400", 1: "text-green-300", 2: "text-yellow-400", 3: "text-yellow-500",
    4: "text-orange-400", 5: "text-orange-500", 6: "text-red-400", 7: "text-red-500",
  };

  const planetBadges = Object.entries(planetSummary).map(([type, count]) => {
    const abbrev: Record<string, string> = {
      FOOD: "F", ORE: "O", TOURISM: "T", PETROLEUM: "P", URBAN: "U",
      EDUCATION: "Ed", GOVERNMENT: "G", SUPPLY: "S", RESEARCH: "R", ANTI_POLLUTION: "AP",
    };
    return { type, abbr: abbrev[type] ?? type[0], count };
  });

  return (
    <div className="border border-green-800 p-2 space-y-2">
      <Tooltip tip="Your empire at a glance — resources, population, military, and planets.">
        <h2 className="text-yellow-400 font-bold tracking-wider text-xs cursor-help">[ EMPIRE STATUS ]</h2>
      </Tooltip>

      {/* Net Worth + Civil Status */}
      <div className="grid grid-cols-2 gap-1">
        <Tooltip tip={EMPIRE_TT.netWorth}>
          <div className="border border-yellow-900 p-1.5 text-center cursor-help">
            <div className="text-sm font-bold text-yellow-400 leading-tight">{empire.netWorth.toLocaleString()}</div>
            <div className="text-[8px] text-yellow-700 uppercase tracking-wider">Net Worth</div>
          </div>
        </Tooltip>
        <Tooltip tip={EMPIRE_TT.civilStatus}>
          <div className="border border-green-900 p-1.5 text-center cursor-help">
            <div className={`text-xs font-bold leading-tight ${civilColors[empire.civilStatus]}`}>
              {empire.civilStatusName}
            </div>
            <div className="text-[8px] text-green-700 uppercase tracking-wider">Civil Status</div>
          </div>
        </Tooltip>
      </div>

      {/* Resources 2x2 */}
      <div className="grid grid-cols-4 gap-1">
        <StatBox label="Credits" value={empire.credits} color="text-yellow-300" tip={EMPIRE_TT.credits} />
        <StatBox
          label="Food"
          value={empire.food}
          color={empire.food < 100 ? "text-red-400" : "text-green-300"}
          tip={EMPIRE_TT.food}
        />
        <StatBox label="Ore" value={empire.ore} tip={EMPIRE_TT.ore} />
        <StatBox label="Fuel" value={empire.fuel} tip={EMPIRE_TT.fuel} />
      </div>

      {/* Population + Tax */}
      <div className="grid grid-cols-2 gap-1">
        <StatBox label="Population" value={empire.population} color="text-cyan-300" tip={EMPIRE_TT.population} />
        <StatBox label="Tax Rate" value={`${empire.taxRate}%`} color="text-green-300" tip={EMPIRE_TT.taxRate} />
      </div>

      {/* Sell Rates — compact inline */}
      <Tooltip tip={EMPIRE_TT.sellRates}>
        <div className="border border-green-900 px-2 py-1 text-[10px] cursor-help">
          <span className="text-green-700">SELL: </span>
          <span className="text-green-500">F:</span><span className="text-green-300">{empire.foodSellRate}% </span>
          <span className="text-green-500">O:</span><span className="text-green-300">{empire.oreSellRate}% </span>
          <span className="text-green-500">P:</span><span className="text-green-300">{empire.petroleumSellRate}%</span>
        </div>
      </Tooltip>

      {/* Military */}
      {army && (
        <div>
          <Tooltip tip={EMPIRE_TT.militaryHeading}>
            <h3 className="text-green-600 text-[10px] tracking-wider mb-1 cursor-help">MILITARY</h3>
          </Tooltip>
          <div className="grid grid-cols-4 gap-0.5">
            <MiniStat label="Sol" value={army.soldiers} tip={EMPIRE_UNITS.Sol} />
            <MiniStat label="Gen" value={army.generals} tip={EMPIRE_UNITS.Gen} />
            <MiniStat label="Ftr" value={army.fighters} tip={EMPIRE_UNITS.Ftr} />
            <MiniStat label="Stn" value={army.defenseStations} tip={EMPIRE_UNITS.Stn} />
            <MiniStat label="LC" value={army.lightCruisers} tip={EMPIRE_UNITS.LC} />
            <MiniStat label="HC" value={army.heavyCruisers} tip={EMPIRE_UNITS.HC} />
            <MiniStat label="Car" value={army.carriers} tip={EMPIRE_UNITS.Car} />
            <MiniStat label="Cov" value={army.covertAgents} tip={EMPIRE_UNITS.Cov} />
          </div>
          {army.commandShipStrength > 0 && (
            <Tooltip tip={EMPIRE_TT.commandShip}>
              <div className="border border-yellow-900 px-2 py-0.5 mt-0.5 text-[10px] text-center cursor-help">
                <span className="text-yellow-400">Command Ship: {army.commandShipStrength}%</span>
              </div>
            </Tooltip>
          )}
          <div className="flex gap-1 mt-1">
            <Tooltip tip={EMPIRE_TT.effectiveness} className="flex-1 min-w-0">
              <div className="w-full border border-green-900 px-1.5 py-0.5 text-[10px] text-center cursor-help">
                <span className="text-green-700">Eff: </span>
                <span className={army.effectiveness < 50 ? "text-red-400" : "text-green-300"}>{army.effectiveness}%</span>
              </div>
            </Tooltip>
            <Tooltip tip={EMPIRE_TT.covertPts} className="flex-1 min-w-0">
              <div className="w-full border border-green-900 px-1.5 py-0.5 text-[10px] text-center cursor-help">
                <span className="text-green-700">Cov: </span>
                <span className="text-green-300">
                  {army.covertPoints}/{MIL.MAX_COVERT_POINTS}
                </span>
              </div>
            </Tooltip>
          </div>
        </div>
      )}

      {/* Planets — compact badges */}
      <div>
        <h3 className="text-green-600 text-[10px] tracking-wider mb-1">PLANETS ({planets.length})</h3>
        <div className="flex flex-wrap gap-0.5">
          {planetBadges.map((b) => (
            <span
              key={b.type}
              className="border border-green-900 px-1 py-0.5 text-[10px] text-green-300"
              title={b.type}
            >
              {b.count}{b.abbr}
            </span>
          ))}
        </div>
      </div>

      {/* Planet Details — collapsible */}
      <div>
        <button
          onClick={() => setPlanetsExpanded(!planetsExpanded)}
          className="w-full flex justify-between items-center text-green-600 text-[10px] tracking-wider mb-1 hover:text-green-400"
        >
          <span>PLANET DETAILS</span>
          <span className="text-green-700">{planetsExpanded ? "▼" : `▶ (${planets.length})`}</span>
        </button>
        {planetsExpanded && (
          <div className="space-y-1">
            {planets.map((p) => (
              <div
                key={p.id}
                className={`border p-1 text-[10px] ${p.isRadiated ? "border-red-800 bg-red-950/20" : "border-green-900"}`}
              >
                <div className="flex justify-between">
                  <span className="text-green-300 font-bold">{p.name}</span>
                  <span className="text-green-700">{p.typeLabel}</span>
                </div>
                <div className="text-green-700">
                  S{p.sector} · {p.shortTermProduction}%
                  {p.shortTermProduction !== p.longTermProduction && ` → ${p.longTermProduction}%`}
                  {p.isRadiated && <span className="text-red-500 ml-1">[RAD]</span>}
                </div>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
