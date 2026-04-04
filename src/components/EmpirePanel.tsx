"use client";

interface Planet {
  id: string;
  name: string;
  sector: number;
  population: number;
  ore: number;
  food: number;
  defenses: number;
}

interface Empire {
  credits: number;
  ore: number;
  food: number;
  fuel: number;
  fighters: number;
  transports: number;
  warships: number;
  turnsLeft: number;
  planets: Planet[];
}

export default function EmpirePanel({ empire }: { empire: Empire }) {
  return (
    <div className="border border-green-800 p-4">
      <h2 className="text-yellow-400 font-bold mb-3 tracking-wider">[ EMPIRE STATUS ]</h2>

      <div className="space-y-1 text-sm mb-4">
        <div className="flex justify-between">
          <span className="text-green-600">Credits:</span>
          <span className="text-yellow-300">{empire.credits.toLocaleString()}</span>
        </div>
        <div className="flex justify-between">
          <span className="text-green-600">Ore:</span>
          <span>{empire.ore.toLocaleString()}</span>
        </div>
        <div className="flex justify-between">
          <span className="text-green-600">Food:</span>
          <span>{empire.food.toLocaleString()}</span>
        </div>
        <div className="flex justify-between">
          <span className="text-green-600">Fuel:</span>
          <span>{empire.fuel.toLocaleString()}</span>
        </div>
      </div>

      <h3 className="text-green-500 text-xs mb-2 tracking-wider">FLEET</h3>
      <div className="space-y-1 text-sm mb-4">
        <div className="flex justify-between">
          <span className="text-green-600">Fighters:</span>
          <span>{empire.fighters}</span>
        </div>
        <div className="flex justify-between">
          <span className="text-green-600">Transports:</span>
          <span>{empire.transports}</span>
        </div>
        <div className="flex justify-between">
          <span className="text-green-600">Warships:</span>
          <span>{empire.warships}</span>
        </div>
      </div>

      <div className="flex justify-between text-sm mb-4 border-t border-green-900 pt-2">
        <span className="text-green-600">Turns Left:</span>
        <span className={empire.turnsLeft < 10 ? "text-red-400" : "text-green-300"}>
          {empire.turnsLeft}
        </span>
      </div>

      <h3 className="text-green-500 text-xs mb-2 tracking-wider">PLANETS ({empire.planets.length})</h3>
      <div className="space-y-2">
        {empire.planets.map((p) => (
          <div key={p.id} className="border border-green-900 p-2 text-xs">
            <div className="text-green-300 font-bold">{p.name}</div>
            <div className="text-green-700">Sector {p.sector} · Pop: {p.population.toLocaleString()}</div>
            <div className="text-green-700">Ore: {p.ore} · Food: {p.food} · Def: {p.defenses}</div>
          </div>
        ))}
      </div>
    </div>
  );
}
