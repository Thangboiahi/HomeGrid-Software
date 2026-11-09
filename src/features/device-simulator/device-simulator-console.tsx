"use client";

import { useEffect, useMemo, useState } from "react";
import { SignOutButton } from "@/features/authentication/sign-out-button";

type Device = {
  id: string;
  kind: "simulated";
  state: "unassigned" | "assigned" | "retired";
  productDefinitionId: string;
  householdId?: string;
  installationId?: string;
};
type Product = { id: string; productCode?: string; displayName?: string; state?: string };

async function api<T>(url: string, init?: RequestInit): Promise<T> {
  const response = await fetch(url, {
    ...init,
    credentials: "same-origin",
    headers: { ...(init?.body ? { "content-type": "application/json" } : {}), ...init?.headers },
  });
  const body = await response.json().catch(() => ({})) as T & { error?: string };
  if (!response.ok) throw new Error(body.error ?? `Request failed (${response.status}).`);
  return body;
}

export function DeviceSimulatorConsole() {
  const [devices, setDevices] = useState<Device[]>([]);
  const [products, setProducts] = useState<Product[]>([]);
  const [productId, setProductId] = useState("");
  const [householdId, setHouseholdId] = useState("");
  const [installationId, setInstallationId] = useState("");
  const [search, setSearch] = useState("");
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");

  useEffect(() => {
    let cancelled = false;
    void Promise.all([api<Device[]>("/api/dev/simulator/devices"), api<Product[]>("/api/admin/products")])
      .then(([records, catalogue]) => {
        if (!cancelled) {
          setDevices(records.filter((record) => record.kind === "simulated"));
          setProducts(catalogue);
          setProductId(catalogue.find((product) => product.state === "active")?.id ?? "");
        }
      })
      .catch((cause) => { if (!cancelled) setError(cause instanceof Error ? cause.message : "Simulator is unavailable."); })
      .finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, []);

  const activeProducts = products.filter((product) => product.state === "active");
  const visibleDevices = useMemo(() => devices.filter((device) =>
    `${device.id} ${device.productDefinitionId} ${device.householdId ?? ""} ${device.installationId ?? ""}`
      .toLowerCase().includes(search.toLowerCase())), [devices, search]);

  async function reload() {
    const records = await api<Device[]>("/api/dev/simulator/devices");
    setDevices(records.filter((record) => record.kind === "simulated"));
  }

  async function create(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault(); setError(""); setNotice("");
    const body = {
      productDefinitionId: productId,
      ...(householdId.trim() ? { householdId: householdId.trim() } : {}),
      ...(installationId.trim() ? { installationId: installationId.trim() } : {}),
    };
    try {
      const device = await api<Device>("/api/dev/simulator/devices", { method: "POST", body: JSON.stringify(body) });
      setNotice(`Simulated record ${device.id} created.`);
      await reload();
    } catch (cause) { setError(cause instanceof Error ? cause.message : "Could not create simulated device."); }
  }

  async function associate(event: React.FormEvent<HTMLFormElement>, device: Device) {
    event.preventDefault(); setError(""); setNotice("");
    if (!window.confirm("Save these simulated-device associations? Household conflicts will be rejected.")) return;
    const values = new FormData(event.currentTarget);
    const household = String(values.get("householdId") ?? "").trim();
    const installation = String(values.get("installationId") ?? "").trim();
    const body = { ...(household ? { householdId: household } : {}), ...(installation ? { installationId: installation } : {}) };
    try {
      await api(`/api/dev/simulator/devices/${encodeURIComponent(device.id)}/assignment`, { method: "POST", body: JSON.stringify(body) });
      setNotice(`Associations updated for ${device.id}.`);
      await reload();
    } catch (cause) { setError(cause instanceof Error ? cause.message : "Association update failed."); }
  }

  async function changeProduct(event: React.FormEvent<HTMLFormElement>, device: Device) {
    event.preventDefault(); setError(""); setNotice("");
    if (!window.confirm("Change this simulated record’s product definition?")) return;
    const values = new FormData(event.currentTarget);
    try {
      await api(`/api/dev/simulator/devices/${encodeURIComponent(device.id)}/product`, {
        method: "PATCH", body: JSON.stringify({ productDefinitionId: values.get("productDefinitionId") }),
      });
      setNotice(`Product association updated for ${device.id}.`);
      await reload();
    } catch (cause) { setError(cause instanceof Error ? cause.message : "Product association update failed."); }
  }

  return <main className="min-h-screen bg-[var(--surface)]">
    <header className="border-b border-[var(--line)] bg-white"><div className="mx-auto flex max-w-6xl items-center justify-between gap-4 px-5 py-5 sm:px-8">
      <p className="text-sm font-bold text-[var(--brand-dark)]">HomeGrid <span className="ml-2 font-normal text-[var(--muted)]">Development simulator</span></p><SignOutButton />
    </div></header>
    <section className="mx-auto max-w-6xl px-5 py-8 sm:px-8 sm:py-12">
      <p className="text-xs font-semibold uppercase tracking-[0.16em] text-[var(--brand)]">Local emulator only</p>
      <h1 className="mt-3 text-3xl font-semibold tracking-tight">Simulated device records</h1>
      <p className="mt-3 max-w-3xl text-sm leading-6 text-[var(--muted)]">Create and manage software registry records classified as simulated. This screen does not represent connectivity, telemetry, appliance state, or device control.</p>

      <section className="mt-8 rounded-2xl border border-[var(--line)] bg-white p-5 sm:p-6" aria-labelledby="simulator-create-heading">
        <h2 id="simulator-create-heading" className="text-lg font-semibold">Create simulated record</h2>
        <form onSubmit={create} className="mt-4 grid gap-4 md:grid-cols-2">
          <label className="grid gap-1.5 text-sm font-medium">Active product definition
            <select className={inputClass} value={productId} onChange={(event) => setProductId(event.target.value)} required>
              <option value="">Select a product</option>{activeProducts.map((product) => <option key={product.id} value={product.id}>{product.displayName ?? product.productCode ?? product.id}</option>)}
            </select>
          </label>
          <label className="grid gap-1.5 text-sm font-medium">Household ID (optional)
            <input className={inputClass} value={householdId} onChange={(event) => setHouseholdId(event.target.value)} />
          </label>
          <label className="grid gap-1.5 text-sm font-medium">Installation ID (optional)
            <input className={inputClass} value={installationId} onChange={(event) => setInstallationId(event.target.value)} />
          </label>
          <div className="flex items-end"><button className={buttonClass} type="submit" disabled={!activeProducts.length}>Create simulated device</button></div>
        </form>
        <p className="mt-3 text-xs text-[var(--muted)]">The server always sets `kind: simulated`. If both associations are supplied, the installation must reference the same household.</p>
      </section>

      <section className="mt-8" aria-labelledby="simulator-list-heading">
        <div className="mb-4 flex flex-col gap-3 sm:flex-row sm:items-end sm:justify-between">
          <div><h2 id="simulator-list-heading" className="text-lg font-semibold">Simulator records</h2><p className="text-sm text-[var(--muted)]">{devices.length} simulated records</p></div>
          <label className="grid gap-1.5 text-sm font-medium">Search IDs and associations
            <input className={inputClass} value={search} onChange={(event) => setSearch(event.target.value)} type="search" />
          </label>
        </div>
        {loading ? <p role="status">Loading simulator records…</p> : visibleDevices.length === 0 ? <p className="rounded-2xl border border-dashed border-[var(--line)] bg-white p-8 text-sm text-[var(--muted)]">{devices.length ? "No records match this search." : "No simulated records are registered in this emulator."}</p> :
          <div className="grid gap-4">{visibleDevices.map((device) => <article key={device.id} className="rounded-2xl border border-[var(--line)] bg-white p-5">
            <div className="flex flex-wrap items-start justify-between gap-3">
              <div><h3 className="font-semibold">{products.find((product) => product.id === device.productDefinitionId)?.displayName ?? "Simulated device"}</h3><p className="mt-1 break-all text-xs text-[var(--muted)]">Record ID: {device.id}</p></div>
              <span className="rounded-full bg-[#edf4f0] px-3 py-1 text-xs font-semibold">SIMULATED · {device.state}</span>
            </div>
            <p className="mt-3 break-all text-sm">Product reference: {device.productDefinitionId}</p>
            <div className="mt-5 grid gap-5 border-t border-[var(--line)] pt-5 lg:grid-cols-2">
              {device.state !== "retired" && <>
                <form onSubmit={(event) => associate(event, device)} className="grid gap-3" aria-label={`Associate simulated device ${device.id}`}>
                  <h4 className="font-semibold">Household and installation</h4>
                  <label className="grid gap-1 text-sm">Household ID<input name="householdId" className={inputClass} defaultValue={device.householdId ?? ""} /></label>
                  <label className="grid gap-1 text-sm">Installation ID<input name="installationId" className={inputClass} defaultValue={device.installationId ?? ""} /></label>
                  <button type="submit" className={buttonClass}>Save associations</button>
                </form>
                <form onSubmit={(event) => changeProduct(event, device)} className="grid content-start gap-3" aria-label={`Change simulated device product ${device.id}`}>
                  <h4 className="font-semibold">Product association</h4>
                  <label className="grid gap-1 text-sm">Active product definition
                    <select className={inputClass} name="productDefinitionId" defaultValue={device.productDefinitionId} required>
                      {activeProducts.map((product) => <option key={product.id} value={product.id}>{product.displayName ?? product.productCode ?? product.id}</option>)}
                    </select>
                  </label>
                  <button type="submit" className={buttonClass} disabled={!activeProducts.length}>Update product</button>
                </form>
              </>}
            </div>
          </article>)}</div>}
      </section>
      {error && <p role="alert" className="mt-4 text-sm text-red-700">{error}</p>}
      {notice && <p role="status" className="mt-4 text-sm text-[var(--brand-dark)]">{notice}</p>}
    </section>
  </main>;
}

const inputClass = "min-h-11 rounded-xl border border-[var(--line)] bg-white px-3 py-2 text-sm outline-none focus:border-[var(--brand)] focus:ring-2 focus:ring-[#18765f33]";
const buttonClass = "min-h-11 rounded-xl bg-[var(--brand)] px-4 py-2 text-sm font-semibold text-white hover:bg-[var(--brand-dark)] focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--brand)] disabled:cursor-not-allowed disabled:opacity-50";
