"use client";

export default function EventLog({ events }: { events: string[] }) {
  return (
    <div className="border border-green-800 p-4 h-full">
      <h2 className="text-yellow-400 font-bold mb-3 tracking-wider">[ COMM CHANNEL ]</h2>
      <div className="space-y-1 max-h-96 overflow-y-auto">
        {events.length === 0 && (
          <p className="text-green-800 text-sm italic">Awaiting transmissions...</p>
        )}
        {events.map((e, i) => (
          <p key={i} className="text-green-400 text-xs border-b border-green-900/30 pb-1">
            {e}
          </p>
        ))}
      </div>
    </div>
  );
}
