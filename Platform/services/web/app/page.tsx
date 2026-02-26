// Dashboard — currently uses hardcoded demo data.
// TODO: Replace `devices` and `stats` with fetch() calls to the backend API.

type DeviceStatus = "critical" | "high" | "medium" | "clean" | "scanning";

interface Device {
  id: number;
  name: string;
  type: string;
  lastScanned: string;
  status: DeviceStatus;
  vulnerabilities: number | null;
}

const devices: Device[] = [
  {
    id: 1,
    name: "Philips IntelliVue MX800",
    type: "Patient Monitor",
    lastScanned: "2026-02-24",
    status: "high",
    vulnerabilities: 3,
  },
  {
    id: 2,
    name: "Medtronic MiniMed 770G",
    type: "Insulin Pump",
    lastScanned: "2026-02-24",
    status: "medium",
    vulnerabilities: 2,
  },
  {
    id: 3,
    name: "GE CARESCAPE R860",
    type: "Ventilator",
    lastScanned: "2026-02-23",
    status: "clean",
    vulnerabilities: 0,
  },
  {
    id: 4,
    name: "BD Alaris 8015 PC Unit",
    type: "Infusion Pump",
    lastScanned: "2026-02-22",
    status: "critical",
    vulnerabilities: 7,
  },
  {
    id: 5,
    name: "Baxter Sigma Spectrum",
    type: "Infusion Pump",
    lastScanned: "—",
    status: "scanning",
    vulnerabilities: null,
  },
  {
    id: 6,
    name: "Masimo Root",
    type: "Patient Monitor",
    lastScanned: "2026-02-21",
    status: "clean",
    vulnerabilities: 0,
  },
];

const stats = [
  { label: "Total Devices", value: "6" },
  { label: "Scans Complete", value: "4" },
  { label: "Vulnerabilities Found", value: "12" },
  { label: "Active Scans", value: "1" },
];

const statusStyles: Record<DeviceStatus, string> = {
  critical: "bg-red-100 text-red-700",
  high: "bg-orange-100 text-orange-700",
  medium: "bg-yellow-100 text-yellow-700",
  clean: "bg-green-100 text-green-700",
  scanning: "bg-blue-100 text-blue-700",
};

const statusLabel: Record<DeviceStatus, string> = {
  critical: "Critical",
  high: "High Risk",
  medium: "Medium Risk",
  clean: "Clean",
  scanning: "Scanning...",
};

export default function DashboardPage() {
  return (
    <div>
      <div className="mb-8 flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold text-slate-800">Dashboard</h1>
          <p className="text-slate-500 mt-1">
            Device vulnerability analysis overview
          </p>
        </div>
        {/* TODO: wire up to S3 upload endpoint */}
        <button className="bg-blue-600 hover:bg-blue-700 text-white px-4 py-2 rounded-lg text-sm font-medium transition-colors">
          + Upload Device
        </button>
      </div>

      {/* Stats row */}
      <div className="grid grid-cols-2 md:grid-cols-4 gap-4 mb-8">
        {stats.map((stat) => (
          <div
            key={stat.label}
            className="bg-white rounded-xl border border-slate-200 p-5"
          >
            <p className="text-sm text-slate-500">{stat.label}</p>
            <p className="text-3xl font-bold text-slate-800 mt-1">
              {stat.value}
            </p>
          </div>
        ))}
      </div>

      {/* Device table */}
      <div className="bg-white rounded-xl border border-slate-200 overflow-hidden">
        <div className="px-6 py-4 border-b border-slate-100">
          <h2 className="font-semibold text-slate-700">Devices</h2>
        </div>
        <table className="w-full text-sm">
          <thead>
            <tr className="text-left text-slate-400 bg-slate-50 border-b border-slate-100">
              <th className="px-6 py-3 font-medium">Device</th>
              <th className="px-6 py-3 font-medium">Type</th>
              <th className="px-6 py-3 font-medium">Last Scanned</th>
              <th className="px-6 py-3 font-medium">Status</th>
              <th className="px-6 py-3 font-medium">Vulnerabilities</th>
            </tr>
          </thead>
          <tbody>
            {devices.map((device) => (
              <tr
                key={device.id}
                className="border-b border-slate-50 hover:bg-slate-50 transition-colors"
              >
                <td className="px-6 py-4 font-medium text-slate-800">
                  {device.name}
                </td>
                <td className="px-6 py-4 text-slate-500">{device.type}</td>
                <td className="px-6 py-4 text-slate-500">
                  {device.lastScanned}
                </td>
                <td className="px-6 py-4">
                  <span
                    className={`px-2.5 py-1 rounded-full text-xs font-medium ${statusStyles[device.status]}`}
                  >
                    {statusLabel[device.status]}
                  </span>
                </td>
                <td className="px-6 py-4 text-slate-700">
                  {device.vulnerabilities === null
                    ? "—"
                    : device.vulnerabilities}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
